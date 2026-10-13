import type { Pool } from "pg";
import { withTransaction } from "../db/tx";
import type { Logger } from "../logger";
import { removeAccountFromClans } from "./clanOps";
import { ACCOUNT_RULES } from "./constants";

/**
 * The two background jobs of the account lifecycle (docs plan sections 7.3
 * and 21): carrying out account deletions after their delay, and removing
 * guest accounts nobody uses. Both are idempotent and safe to run on any
 * schedule or from several instances at once.
 */

/** Rows handled per batch, so one run never holds a long transaction. */
const BATCH = 200;

/**
 * Carries out account deletions whose delay has passed. The user row stays
 * (as a tombstone, so ids in old records and the ledger keep a meaning) but
 * everything personal goes: sign-in identities, sessions, username, stats and
 * the link from game history. Credits records are left as they are.
 * Returns how many accounts were deleted.
 */
export async function runDeletions(
  pool: Pool,
  now: Date = new Date(),
): Promise<number> {
  const due = new Date(
    now.getTime() - ACCOUNT_RULES.deletionDelayHours * 3_600_000,
  );
  let deleted = 0;
  for (;;) {
    const { rows } = await pool.query<{ id: string }>(
      `SELECT id FROM users
        WHERE deletion_requested_at IS NOT NULL AND deletion_requested_at <= $1
          AND deleted_at IS NULL
        ORDER BY deletion_requested_at LIMIT $2`,
      [due, BATCH],
    );
    if (rows.length === 0) return deleted;
    for (const { id } of rows) {
      await withTransaction(pool, async (tx) => {
        const lock = await tx.query(
          // NO KEY UPDATE: the clan code locks a clan row and then inserts
          // rows that name this user, which a plain FOR UPDATE would block.
          `SELECT 1 FROM users WHERE id = $1 AND deleted_at IS NULL FOR NO KEY UPDATE`,
          [id],
        );
        if (lock.rows.length === 0) return;
        await removeAccountFromClans(tx, id);
        await tx.query("DELETE FROM auth_identities WHERE user_id = $1", [id]);
        await tx.query("DELETE FROM refresh_sessions WHERE user_id = $1", [id]);
        await tx.query(
          "DELETE FROM player_stat_aggregates WHERE user_id = $1",
          [id],
        );
        await tx.query(
          "UPDATE game_players SET user_id = NULL, clan_id = NULL WHERE user_id = $1",
          [id],
        );
        await tx.query(
          `UPDATE users
              SET deleted_at = $2, username_base = NULL, username_discriminator = NULL,
                  next_username_change_at = NULL, role = NULL
            WHERE id = $1`,
          [id, now],
        );
      });
      deleted += 1;
    }
  }
}

/**
 * Removes guest accounts that were never used for anything that lasts: not
 * seen for ACCOUNT_RULES.guestIdleDays and with no games, no Credits history,
 * no purchases and no clan. Their sessions and (empty) wallet go with them.
 * Returns how many were removed.
 */
export async function runGuestCleanup(
  pool: Pool,
  now: Date = new Date(),
): Promise<number> {
  const cutoff = new Date(
    now.getTime() - ACCOUNT_RULES.guestIdleDays * 86_400_000,
  );
  let removed = 0;
  for (;;) {
    const { rowCount } = await pool.query(
      `DELETE FROM users WHERE id IN (
         SELECT u.id FROM users u
          WHERE u.kind = 'guest' AND u.deleted_at IS NULL AND u.last_seen_at < $1
            AND NOT EXISTS (SELECT 1 FROM game_players p WHERE p.user_id = u.id)
            AND NOT EXISTS (SELECT 1 FROM currency_ledger l WHERE l.user_id = u.id)
            AND NOT EXISTS (SELECT 1 FROM purchases pu WHERE pu.user_id = u.id)
            AND NOT EXISTS (SELECT 1 FROM clan_members m WHERE m.user_id = u.id)
            AND NOT EXISTS (SELECT 1 FROM user_flares f WHERE f.user_id = u.id)
          LIMIT $2)`,
      [cutoff, BATCH],
    );
    removed += rowCount ?? 0;
    if ((rowCount ?? 0) < BATCH) return removed;
  }
}

/** One pass of both jobs; errors are logged, never thrown, so a scheduler keeps ticking. */
export async function runMaintenance(
  pool: Pool,
  log: Pick<Logger, "info" | "error">,
  now: Date = new Date(),
): Promise<void> {
  try {
    const deleted = await runDeletions(pool, now);
    const removed = await runGuestCleanup(pool, now);
    if (deleted > 0 || removed > 0)
      log.info("account maintenance", { deleted, guestsRemoved: removed });
  } catch (error) {
    log.error("account maintenance failed", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
