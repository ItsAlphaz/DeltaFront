import type { Pool } from "pg";
import { pruneMagicLinks } from "../auth/magicLink";
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
          -- A ban outlives a deletion request: erasing the sign-in identities
          -- would let the player walk back in as a new account. The deletion
          -- waits until the ban is lifted or expires.
          AND NOT EXISTS (
            SELECT 1 FROM bans b
             WHERE b.user_id = users.id AND b.revoked_at IS NULL
               AND (b.expires_at IS NULL OR b.expires_at > $3))
        ORDER BY deletion_requested_at LIMIT $2`,
      [due, BATCH, now],
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
        // Pending sign-in links that would add an address to this account.
        await tx.query(
          "DELETE FROM magic_link_tokens WHERE link_user_id = $1",
          [id],
        );
        await tx.query(
          "DELETE FROM player_stat_aggregates WHERE user_id = $1",
          [id],
        );
        // The game rows stay for the other players' history, but no longer say
        // who played: the account link, the display name and the clan tag go.
        await tx.query(
          `UPDATE game_players
              SET user_id = NULL, clan_id = NULL, clan_tag = NULL, username = $2
            WHERE user_id = $1`,
          [id, ACCOUNT_RULES.deletedPlayerName],
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

/**
 * Data that is only kept for a while: stored game records past their
 * retention (the rows in `games` and `game_players` stay, only the replay
 * data goes), refresh-session rows that can no longer matter and used or
 * expired email sign-in links (M8). Returns the
 * counts. Idempotent, batched.
 */
export async function runRetention(
  pool: Pool,
  now: Date = new Date(),
): Promise<{ records: number; sessions: number; magicLinks: number }> {
  const recordCutoff = new Date(
    now.getTime() - ACCOUNT_RULES.gameRecordRetentionDays * 86_400_000,
  );
  const sessionCutoff = new Date(
    now.getTime() - ACCOUNT_RULES.deadSessionRetentionDays * 86_400_000,
  );
  let records = 0;
  for (;;) {
    const { rowCount } = await pool.query(
      `DELETE FROM game_records WHERE game_id IN (
         SELECT r.game_id FROM game_records r JOIN games g ON g.id = r.game_id
          WHERE r.expires_at < $1 OR (r.expires_at IS NULL AND g.ended_at < $2)
          LIMIT $3)`,
      [now, recordCutoff, BATCH],
    );
    records += rowCount ?? 0;
    if ((rowCount ?? 0) < BATCH) break;
  }
  let sessions = 0;
  for (;;) {
    const { rowCount } = await pool.query(
      `DELETE FROM refresh_sessions WHERE id IN (
         SELECT id FROM refresh_sessions
          WHERE expires_at < $1 OR revoked_at < $1
          LIMIT $2)`,
      [sessionCutoff, BATCH * 5],
    );
    sessions += rowCount ?? 0;
    if ((rowCount ?? 0) < BATCH * 5) break;
  }
  return { records, sessions, magicLinks: await pruneMagicLinks(pool, now) };
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
    const pruned = await runRetention(pool, now);
    if (
      deleted > 0 ||
      removed > 0 ||
      pruned.records > 0 ||
      pruned.sessions > 0 ||
      pruned.magicLinks > 0
    )
      log.info("account maintenance", {
        deleted,
        guestsRemoved: removed,
        recordsPruned: pruned.records,
        sessionsPruned: pruned.sessions,
        magicLinksPruned: pruned.magicLinks,
      });
  } catch (error) {
    log.error("account maintenance failed", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
