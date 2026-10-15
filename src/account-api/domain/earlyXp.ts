import type { Pool } from "pg";
import { withTransaction } from "../db/tx";
import type { Logger } from "../logger";
import { assess, liveXpStore, type LiveXpStore } from "./liveXp";
import { lockProgress, payReducedXp, type RewardEnv } from "./progression";

/**
 * The reduced award for a death, paid when the game server reports it.
 *
 * A player who is eliminated has their reduced XP (lifetime only: a completed
 * match and their valid eliminations at a quarter) secured at that moment. They
 * need not stay, spectate or wait for the match to end, and nothing the rest of
 * the match does can take it back: the stored game adopts this payment for their
 * `game_players` row instead of working one out (see `awardPlayerXp`).
 *
 * It is not a second award path. It reads the very assessment the live preview
 * reads (`assess`) and pays through the very function the stored game pays a
 * reduced award with (`payReducedXp`), so there is one set of rules. Exactly once
 * per player and game:
 *   - the player's progress row is locked, so a report and the stored game for
 *     the same player run one at a time;
 *   - a prior payment is found in `early_xp` and adopted, not repeated;
 *   - the ledger's unique key on (user, game) refuses a second payment whatever
 *     else happens (a restarted API, two reports at once, the stored game);
 *   - a game that is already stored is left alone.
 *
 * Nothing but the death is paid early: victory, placement, the first-win bonus,
 * season XP, challenges and clan XP all wait for the stored game, and a reduced
 * award has none of them anyway.
 */

/**
 * Pays every eliminated account in the reported game their reduced award, once.
 * Returns the accounts paid by this call. Best effort per player: one that fails
 * is tried again with the next report, and never holds up the others.
 */
export async function settleEliminations(
  pool: Pool,
  gameCode: string,
  env: RewardEnv,
  options: {
    store?: LiveXpStore;
    now?: number;
    log?: Pick<Logger, "error">;
  } = {},
): Promise<string[]> {
  const store = options.store ?? liveXpStore;
  const now = options.now ?? Date.now();
  const game = store.get(gameCode, now);
  if (game === undefined) return [];
  const paid: string[] = [];
  for (const player of game.progress.players) {
    if (!player.eliminated || player.persistentID === null) continue;
    const userId = player.persistentID.toLowerCase();
    if (game.finalized.has(userId)) continue;
    const assessment = assess(game, userId);
    if (assessment === null || assessment.kind !== "eliminated") continue;
    try {
      const settled = await withTransaction(pool, async (tx) => {
        await lockProgress(tx, userId);
        // The stored game has the player's award: nothing to pay early.
        const stored = await tx.query(
          "SELECT 1 FROM games WHERE game_code = $1",
          [gameCode],
        );
        if (stored.rows.length > 0) return "stored" as const;
        const outcome = await payReducedXp(tx, {
          userId,
          gameCode,
          at: new Date(now),
          reason: assessment.reason,
          eliminations: assessment.eliminations,
          flags: ["eliminated", "early"],
          env,
        });
        if (!outcome.result.eligible) return "refused" as const;
        const inserted = await tx.query(
          `INSERT INTO early_xp (user_id, game_code, xp_awarded, result)
           VALUES ($1, $2, $3, $4::jsonb)
           ON CONFLICT (user_id, game_code) DO NOTHING`,
          [userId, gameCode, outcome.xpAwarded, JSON.stringify(outcome.result)],
        );
        return (inserted.rowCount ?? 0) > 0
          ? ("paid" as const)
          : ("already" as const);
      });
      // Paid now, paid before, or the stored game has it: not attempted again.
      game.finalized.add(userId);
      if (settled === "paid") paid.push(userId);
    } catch (error) {
      options.log?.error("death award failed", {
        gameCode,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return paid;
}
