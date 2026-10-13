import type { Pool, PoolClient } from "pg";
import type { Offer } from "../catalog/offer";
import { withTransaction } from "../db/tx";
import { grantFlare } from "../repo/inventory";
import { ACCOUNT_RULES, ECONOMY } from "./constants";

/**
 * Every change to a wallet lives in this file (docs/DeltaFrontAccountsPlan.md
 * sections 9.4, 9.5 and 14.4, decision D1):
 *  - game rewards, from game ingestion with a trusted game server's record
 *    (milestone M2);
 *  - purchases, which only debit (M5);
 *  - the admin's grants and deductions (M5).
 * No amount ever comes from a browser.
 */

/** What a player's result is worth before the daily cap: nothing unless the game was completed. */
export function gameReward(completed: boolean, won: boolean): number {
  if (!completed) return 0;
  return ECONOMY.completedGameReward + (won ? ECONOMY.winBonus : 0);
}

/** The most that may still be granted today, given what gameplay has already paid. */
export function remainingToday(earnedToday: number): number {
  return Math.max(0, ECONOMY.dailyGameplayCap - Math.max(0, earnedToday));
}

/** The amount actually granted: `earned` clamped to what is left of the day's cap. Never negative. */
export function clampToCap(earned: number, earnedToday: number): number {
  if (!Number.isFinite(earned) || earned <= 0) return 0;
  return Math.min(Math.floor(earned), remainingToday(earnedToday));
}

/**
 * Pays `amount` Credits for one game, inside the caller's transaction, and
 * returns what was actually granted (0 when the daily cap is used up, the
 * amount is 0, or this game has already paid this user).
 *
 *  1. The wallet row is locked first, so two games ending for the same player
 *     at once are paid one after the other and cannot together pass the cap.
 *  2. The day is the UTC day the game ended on (not when it was submitted), and
 *     the cap is what gameplay rewards already booked on that day add up to.
 *  3. The ledger row is unique per (user, game): a repeat of the same game
 *     inserts nothing and so pays nothing, whatever else goes wrong.
 *  4. The balance only ever goes up, by exactly the ledger amount, and never
 *     past ACCOUNT_RULES.maxWalletCredits.
 */
export async function applyGameReward(
  tx: PoolClient,
  userId: string,
  gameCode: string,
  endedAt: Date,
  amount: number,
): Promise<number> {
  await tx.query(
    "INSERT INTO wallets (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING",
    [userId],
  );
  const wallet = await tx.query<{ credits: string; day: string }>(
    `SELECT credits::text AS credits,
            to_char(($2::timestamptz AT TIME ZONE 'UTC')::date, 'YYYY-MM-DD') AS day
       FROM wallets WHERE user_id = $1 FOR UPDATE`,
    [userId, endedAt],
  );
  if (wallet.rows.length === 0) return 0;
  const balance = Number(wallet.rows[0].credits);
  const day = wallet.rows[0].day;
  const today = await tx.query<{ earned: string }>(
    `SELECT COALESCE(SUM(delta), 0)::text AS earned FROM currency_ledger
      WHERE user_id = $1 AND reason = 'game_reward' AND reward_day = $2::date`,
    [userId, day],
  );
  let grant = clampToCap(amount, Number(today.rows[0].earned));
  grant = Math.min(
    grant,
    Math.max(0, ACCOUNT_RULES.maxWalletCredits - balance),
  );
  if (grant <= 0) return 0;
  const ledger = await tx.query(
    `INSERT INTO currency_ledger (user_id, delta, balance_after, reason, ref_type, ref_id, reward_day)
     VALUES ($1, $2, $3, 'game_reward', 'game', $4, $5::date)
     ON CONFLICT (user_id, ref_type, ref_id) WHERE reason = 'game_reward' DO NOTHING
     RETURNING id`,
    [userId, grant, balance + grant, gameCode, day],
  );
  if (ledger.rows.length === 0) return 0;
  await tx.query(
    "UPDATE wallets SET credits = credits + $2, updated_at = now() WHERE user_id = $1",
    [userId, grant],
  );
  return grant;
}

export type PurchaseOutcome =
  | { kind: "purchased"; balance: number; purchaseId: string }
  /** The account already holds the item (or it is a free default). Nothing changed. */
  | { kind: "owned" }
  /** Not enough Credits. Nothing changed. */
  | { kind: "insufficient"; balance: number };

/**
 * Buys `offer` for the account, in one transaction (plan section 9.4):
 *
 *  1. the wallet row is locked, so everything below runs one purchase at a time
 *     per account: two clicks, or two tabs, cannot both pass the checks;
 *  2. owned (or a free default) answers "owned" without touching anything;
 *  3. too few Credits answers "insufficient" without touching anything;
 *  4. otherwise the price is debited, the purchase and its ledger row are
 *     written, and the flare is granted. A failure at any step rolls all of it
 *     back: the account is never charged without the item, nor given it free.
 *
 * The offer's price came from the server's catalog (catalog/offer.ts), never
 * from the request. `catalogVersion` is recorded with the purchase.
 */
export async function purchaseOffer(
  pool: Pick<Pool, "connect">,
  userId: string,
  offer: Offer,
  options: { catalogVersion: string; defaultFlares: readonly string[] },
): Promise<PurchaseOutcome> {
  return withTransaction(pool, async (tx) => {
    await tx.query(
      "INSERT INTO wallets (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING",
      [userId],
    );
    const wallet = await tx.query<{ credits: string }>(
      "SELECT credits::text AS credits FROM wallets WHERE user_id = $1 FOR UPDATE",
      [userId],
    );
    const balance = Number(wallet.rows[0].credits);

    if (options.defaultFlares.includes(offer.flare)) return { kind: "owned" };
    const held = await tx.query(
      "SELECT 1 FROM user_flares WHERE user_id = $1 AND flare = $2 AND revoked_at IS NULL",
      [userId, offer.flare],
    );
    if (held.rows.length > 0) return { kind: "owned" };
    if (balance < offer.price) return { kind: "insufficient", balance };

    const after = balance - offer.price;
    await tx.query(
      "UPDATE wallets SET credits = $2, updated_at = now() WHERE user_id = $1",
      [userId, after],
    );
    const purchase = await tx.query<{ id: string }>(
      `INSERT INTO purchases (user_id, kind, item_key, flares, price_credits, catalog_version)
       VALUES ($1, 'cosmetic', $2, ARRAY[$2]::text[], $3, $4) RETURNING id::text AS id`,
      [userId, offer.flare, offer.price, options.catalogVersion],
    );
    const purchaseId = purchase.rows[0].id;
    await tx.query(
      `INSERT INTO currency_ledger (user_id, delta, balance_after, reason, ref_type, ref_id)
       VALUES ($1, $2, $3, 'purchase', 'purchase', $4)`,
      [userId, -offer.price, after, purchaseId],
    );
    await grantFlare(tx, userId, offer.flare, {
      source: "purchase",
      purchaseId,
    });
    return { kind: "purchased", balance: after, purchaseId };
  });
}

export type AdjustOutcome =
  | { kind: "adjusted"; before: number; after: number; ledgerId: string }
  | { kind: "insufficient"; balance: number }
  | { kind: "too_much"; balance: number };

/**
 * An admin's grant (`delta > 0`) or deduction (`delta < 0`) of Credits, inside
 * the caller's transaction (the admin command wraps it with its audit row,
 * whose id is `auditId`). The wallet is locked; a deduction larger than the
 * balance is refused rather than clamped, and a grant cannot pass the wallet
 * maximum, so the balance can never leave 0..maxWalletCredits.
 */
export async function adjustWallet(
  tx: PoolClient,
  userId: string,
  delta: number,
  auditId: string,
): Promise<AdjustOutcome> {
  await tx.query(
    "INSERT INTO wallets (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING",
    [userId],
  );
  const wallet = await tx.query<{ credits: string }>(
    "SELECT credits::text AS credits FROM wallets WHERE user_id = $1 FOR UPDATE",
    [userId],
  );
  const before = Number(wallet.rows[0].credits);
  const after = before + delta;
  if (after < 0) return { kind: "insufficient", balance: before };
  if (after > ACCOUNT_RULES.maxWalletCredits) {
    return { kind: "too_much", balance: before };
  }
  await tx.query(
    "UPDATE wallets SET credits = $2, updated_at = now() WHERE user_id = $1",
    [userId, after],
  );
  const ledger = await tx.query<{ id: string }>(
    `INSERT INTO currency_ledger (user_id, delta, balance_after, reason, ref_type, ref_id)
     VALUES ($1, $2, $3, $4, 'admin', $5) RETURNING id::text AS id`,
    [userId, delta, after, delta > 0 ? "admin_grant" : "admin_revoke", auditId],
  );
  return { kind: "adjusted", before, after, ledgerId: ledger.rows[0].id };
}
