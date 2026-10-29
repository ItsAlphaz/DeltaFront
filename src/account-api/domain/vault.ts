import type {
  VaultCard,
  VaultPackResult,
  VaultSpinResult,
} from "@openfront/shared/VaultSchemas";
import type { Pool, PoolClient } from "pg";
import { withTransaction } from "../db/tx";
import { grantFlare } from "../repo/inventory";
import {
  drawPack,
  nextUtcMidnight,
  pickItem,
  secureRng,
  spinWheel,
  utcDay,
  type DrawItem,
  type Pity,
  type ResolvedVault,
  type Rng,
} from "./vaultDraw";

/**
 * The Vault's spins and packs, each in one locked transaction (docs/Vault.md),
 * in the manner of domain/economy.ts's purchases:
 *
 *  1. the wallet row is locked first, so an account's draws happen one at a
 *     time and two clicks cannot both pass the checks;
 *  2. the client's request id is looked up: a request seen before answers with
 *     the stored result and changes nothing, so a retry never charges twice;
 *  3. the checks (the pack exists and is in season, the day's limit, the daily
 *     spin not yet taken, enough Credits) answer without touching anything;
 *  4. otherwise the cost is debited, the cards are drawn with secure
 *     randomness, the items are granted (a duplicate pays Credits instead), the
 *     draw and its ledger rows are written. A failure anywhere rolls all of it
 *     back.
 *
 * Nothing the client sends is a price, a card or a chance: it names which pack
 * or the wheel, and a request id.
 */

export type DrawRequest =
  | { kind: "pack"; pack: string }
  | { kind: "spin" }
  | { kind: "daily" };

export type VaultOutcome =
  | {
      kind: "ok";
      result: VaultSpinResult | VaultPackResult;
      balance: number;
      /** The same request was answered before: this is that answer again. */
      replay: boolean;
    }
  | { kind: "insufficient"; balance: number }
  | { kind: "not_found" }
  /** The day's most for this kind of draw is reached. */
  | { kind: "limit" }
  /** The free daily spin is taken today; it is back at `nextAt`. */
  | { kind: "daily_used"; nextAt: Date };

export interface DrawOptions {
  vault: ResolvedVault;
  /** Free items every account owns: a card of one pays like a duplicate. */
  defaultFlares: readonly string[];
  rng?: Rng;
  now?: Date;
}

interface Drawn {
  card: VaultCard;
  flare: string;
}

/** Whether a pack may be opened now. */
export function packInSeason(
  pack: { startsAt?: string | undefined; endsAt?: string | undefined },
  now: Date,
): boolean {
  if (pack.startsAt !== undefined && now < new Date(pack.startsAt))
    return false;
  if (pack.endsAt !== undefined && now >= new Date(pack.endsAt)) return false;
  return true;
}

export async function drawFromVault(
  pool: Pick<Pool, "connect">,
  userId: string,
  request: DrawRequest,
  requestId: string,
  options: DrawOptions,
): Promise<VaultOutcome> {
  const { vault } = options;
  const rng = options.rng ?? secureRng;
  const now = options.now ?? new Date();
  const day = utcDay(now);
  const limits = vault.source.limits;

  return withTransaction(pool, async (tx): Promise<VaultOutcome> => {
    await tx.query(
      "INSERT INTO wallets (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING",
      [userId],
    );
    const wallet = await tx.query<{ credits: string }>(
      "SELECT credits::text AS credits FROM wallets WHERE user_id = $1 FOR UPDATE",
      [userId],
    );
    const balance = Number(wallet.rows[0].credits);

    const seen = await tx.query<{
      result: VaultSpinResult | VaultPackResult;
    }>(
      "SELECT result FROM vault_draws WHERE user_id = $1 AND request_id = $2",
      [userId, requestId],
    );
    if (seen.rows.length > 0) {
      return { kind: "ok", result: seen.rows[0].result, balance, replay: true };
    }

    // ---- what it costs, and whether it may happen
    let cost = 0;
    let itemKey = "wheel";
    if (request.kind === "pack") {
      const pack = vault.packs.get(request.pack);
      if (pack === undefined || !packInSeason(pack.source, now)) {
        return { kind: "not_found" };
      }
      cost = pack.source.priceSoft;
      itemKey = request.pack;
      if ((await countToday(tx, userId, day, "pack")) >= limits.packsPerDay) {
        return { kind: "limit" };
      }
    } else if (request.kind === "spin") {
      cost = vault.source.wheel.spinPrice;
      if (
        (await countToday(tx, userId, day, "spin")) >= limits.paidSpinsPerDay
      ) {
        return { kind: "limit" };
      }
    } else if ((await countToday(tx, userId, day, "daily")) > 0) {
      return { kind: "daily_used", nextAt: nextUtcMidnight(now) };
    }
    if (balance < cost) return { kind: "insufficient", balance };

    // ---- what is owned, and the draw
    const owned = new Set<string>(options.defaultFlares);
    const held = await tx.query<{ flare: string }>(
      "SELECT flare FROM user_flares WHERE user_id = $1 AND revoked_at IS NULL",
      [userId],
    );
    for (const row of held.rows) owned.add(row.flare);

    const dupePays = vault.source.dupeCredits;
    const toCard = (item: DrawItem): Drawn => {
      const dupe = owned.has(item.flare);
      owned.add(item.flare);
      return {
        flare: item.flare,
        card: {
          type: item.ref.type,
          name: item.ref.name,
          ...(item.ref.colorPalette === undefined
            ? {}
            : { colorPalette: item.ref.colorPalette }),
          rarity: item.rarity,
          dupe,
          credits: dupe ? (dupePays[item.rarity] ?? 0) : 0,
        },
      };
    };
    const openPack = async (
      name: string,
    ): Promise<VaultPackResult & { drawn: Drawn[] }> => {
      const pack = vault.packs.get(name)!;
      const pity = await readPity(tx, userId, name);
      const out = drawPack(pack, pity, rng);
      await writePity(tx, userId, name, out.pity);
      const drawn = out.cards.map(toCard);
      return { pack: name, cards: drawn.map((d) => d.card), drawn };
    };

    let result: VaultSpinResult | VaultPackResult;
    let allDrawn: Drawn[] = [];
    let creditsPrize = 0;
    if (request.kind === "pack") {
      const opened = await openPack(request.pack);
      allDrawn = opened.drawn;
      result = { pack: opened.pack, cards: opened.cards };
    } else {
      const index = spinWheel(vault, rng);
      const segment = vault.source.wheel.segments[index];
      let card: VaultCard | undefined;
      let pack: VaultPackResult | undefined;
      if (segment.prize.kind === "credits") {
        creditsPrize = segment.prize.amount;
      } else if (segment.prize.kind === "item") {
        const drawn = toCard(
          pickItem(vault.wheelItems, segment.prize.rarity, rng),
        );
        allDrawn = [drawn];
        card = drawn.card;
      } else {
        const opened = await openPack(segment.prize.pack);
        allDrawn = opened.drawn;
        pack = { pack: opened.pack, cards: opened.cards };
      }
      const refunds = allDrawn.reduce((sum, d) => sum + d.card.credits, 0);
      result = {
        segment: index,
        segmentId: segment.id,
        prize: segment.prize,
        ...(card === undefined ? {} : { card }),
        ...(pack === undefined ? {} : { pack }),
        creditsWon: creditsPrize + refunds,
        cost,
        daily: request.kind === "daily",
      };
    }

    // ---- the writes
    const payout =
      creditsPrize + allDrawn.reduce((sum, d) => sum + d.card.credits, 0);
    const after = balance - cost + payout;
    const draw = await tx.query<{ id: string }>(
      `INSERT INTO vault_draws (user_id, kind, item_key, cost, result, day, request_id)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6::date, $7) RETURNING id::text AS id`,
      [
        userId,
        request.kind,
        itemKey,
        cost,
        JSON.stringify(result),
        day,
        requestId,
      ],
    );
    const drawId = draw.rows[0].id;
    if (cost > 0) {
      await tx.query(
        `INSERT INTO currency_ledger (user_id, delta, balance_after, reason, ref_type, ref_id)
         VALUES ($1, $2, $3, 'vault_spend', 'vault_draw', $4)`,
        [userId, -cost, balance - cost, drawId],
      );
    }
    if (payout > 0) {
      await tx.query(
        `INSERT INTO currency_ledger (user_id, delta, balance_after, reason, ref_type, ref_id)
         VALUES ($1, $2, $3, 'vault_payout', 'vault_draw', $4)`,
        [userId, payout, after, drawId],
      );
    }
    await tx.query(
      "UPDATE wallets SET credits = $2, updated_at = now() WHERE user_id = $1",
      [userId, after],
    );
    for (const drawn of allDrawn) {
      if (!drawn.card.dupe) {
        await grantFlare(tx, userId, drawn.flare, { source: "vault" });
      }
    }
    return { kind: "ok", result, balance: after, replay: false };
  });
}

async function countToday(
  tx: PoolClient,
  userId: string,
  day: string,
  kind: "pack" | "spin" | "daily",
): Promise<number> {
  const { rows } = await tx.query<{ n: string }>(
    "SELECT count(*)::text AS n FROM vault_draws WHERE user_id = $1 AND day = $2::date AND kind = $3",
    [userId, day, kind],
  );
  return Number(rows[0].n);
}

async function readPity(
  tx: PoolClient,
  userId: string,
  pack: string,
): Promise<Pity> {
  const { rows } = await tx.query<{ since_rare: number; since_epic: number }>(
    "SELECT since_rare, since_epic FROM vault_pity WHERE user_id = $1 AND pack = $2",
    [userId, pack],
  );
  return rows.length === 0
    ? { sinceRare: 0, sinceEpic: 0 }
    : { sinceRare: rows[0].since_rare, sinceEpic: rows[0].since_epic };
}

async function writePity(
  tx: PoolClient,
  userId: string,
  pack: string,
  pity: Pity,
): Promise<void> {
  await tx.query(
    `INSERT INTO vault_pity (user_id, pack, since_rare, since_epic) VALUES ($1, $2, $3, $4)
     ON CONFLICT (user_id, pack) DO UPDATE SET since_rare = $3, since_epic = $4`,
    [userId, pack, pity.sinceRare, pity.sinceEpic],
  );
}

/** What the page needs about the account: pity counters, today's use, and the daily spin. */
export async function vaultStateOf(
  pool: Pick<Pool, "query">,
  userId: string,
  now: Date = new Date(),
): Promise<{
  pity: Record<string, Pity>;
  today: { packs: number; spins: number };
  daily: { available: boolean; nextAt: string };
  balance: number;
}> {
  const day = utcDay(now);
  const [pity, counts, wallet] = await Promise.all([
    pool.query<{ pack: string; since_rare: number; since_epic: number }>(
      "SELECT pack, since_rare, since_epic FROM vault_pity WHERE user_id = $1",
      [userId],
    ),
    pool.query<{ kind: string; n: string }>(
      "SELECT kind, count(*)::text AS n FROM vault_draws WHERE user_id = $1 AND day = $2::date GROUP BY kind",
      [userId, day],
    ),
    pool.query<{ credits: string }>(
      "SELECT credits::text AS credits FROM wallets WHERE user_id = $1",
      [userId],
    ),
  ]);
  const count = (kind: string) =>
    Number(counts.rows.find((r) => r.kind === kind)?.n ?? 0);
  return {
    pity: Object.fromEntries(
      pity.rows.map((r) => [
        r.pack,
        { sinceRare: r.since_rare, sinceEpic: r.since_epic },
      ]),
    ),
    today: { packs: count("pack"), spins: count("spin") },
    daily: {
      available: count("daily") === 0,
      nextAt: nextUtcMidnight(now).toISOString(),
    },
    balance: Number(wallet.rows[0]?.credits ?? 0),
  };
}
