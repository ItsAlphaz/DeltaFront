import type { PoolClient } from "pg";
import { ACCOUNT_RULES, ECONOMY } from "./constants";

/**
 * Credits from gameplay (docs/DeltaFrontAccountsPlan.md section 9.5, decision
 * D1). The only code that credits a wallet in milestone M2, and it runs only
 * from game ingestion, with a trusted game server's record.
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
