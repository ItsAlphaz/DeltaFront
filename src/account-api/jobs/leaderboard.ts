import type { Pool } from "pg";
import { ACCOUNT_RULES } from "../domain/constants";
import type { Logger } from "../logger";

/**
 * The basic player leaderboard (docs/DeltaFrontAccountsPlan.md 11.2), rebuilt
 * from the stored games every few minutes.
 *
 * Who is listed: players with at least ACCOUNT_RULES.leaderboardMinGames
 * counted Public games in the period, who are not deleted, queued for
 * deletion, flagged or banned (and not guests, if the rules say so).
 *
 * The order is wins, then win rate, then games, then public id, so no two
 * players ever share a position. The displayed rank is competition ranking
 * (1, 2, 2, 4) on (wins, win rate): players level on both share a rank.
 *
 * Only counted games are read, and counted games come only from a game
 * server's record (domain/ingest.ts); nothing a browser sends reaches this.
 */

export const LEADERBOARD_PERIODS = ["all", "30d"] as const;
export type LeaderboardPeriod = (typeof LEADERBOARD_PERIODS)[number];

export function isLeaderboardPeriod(
  value: unknown,
): value is LeaderboardPeriod {
  return (
    typeof value === "string" &&
    (LEADERBOARD_PERIODS as readonly string[]).includes(value)
  );
}

/** Arbitrary but fixed: the advisory lock that lets only one instance rebuild at a time. */
const REBUILD_LOCK_KEY = "7374410003";

/** The accounts that may appear on a board, as a SQL condition on users `u`. */
export const LISTABLE_USER = `
  u.deleted_at IS NULL AND u.deletion_requested_at IS NULL
  AND u.role IS DISTINCT FROM 'flagged'
  AND NOT EXISTS (
    SELECT 1 FROM bans b
     WHERE b.user_id = u.id AND b.revoked_at IS NULL
       AND (b.expires_at IS NULL OR b.expires_at > now()))`;

export interface RebuildOptions {
  now?: Date;
  includeGuests?: boolean;
  minGames?: number;
}

/**
 * Replaces every period's rows in one transaction, so readers see either the
 * old board or the new one. Returns false (and does nothing) when another
 * instance is already rebuilding.
 */
export async function rebuildLeaderboard(
  pool: Pool,
  options: RebuildOptions = {},
): Promise<boolean> {
  const now = options.now ?? new Date();
  const includeGuests =
    options.includeGuests ?? ACCOUNT_RULES.leaderboardIncludesGuests;
  const minGames = options.minGames ?? ACCOUNT_RULES.leaderboardMinGames;
  const recentFrom = new Date(
    now.getTime() - ACCOUNT_RULES.leaderboardRecentDays * 86_400_000,
  );
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const lock = await client.query<{ locked: boolean }>(
      "SELECT pg_try_advisory_xact_lock($1::bigint) AS locked",
      [REBUILD_LOCK_KEY],
    );
    if (!lock.rows[0].locked) {
      await client.query("ROLLBACK");
      return false;
    }
    await client.query("DELETE FROM leaderboard_players");
    for (const [period, from] of [
      ["all", null],
      ["30d", recentFrom],
    ] as const) {
      await client.query(
        `INSERT INTO leaderboard_players (period, user_id, rank_pos, rank, games, wins, losses, win_rate)
         SELECT $1, t.user_id,
                row_number() OVER (ORDER BY t.wins DESC, t.win_rate DESC, t.games DESC, t.public_id COLLATE "C" ASC),
                rank() OVER (ORDER BY t.wins DESC, t.win_rate DESC),
                t.games, t.wins, t.losses, t.win_rate
           FROM (
             SELECT u.id AS user_id, u.public_id,
                    count(*)::int AS games,
                    (count(*) FILTER (WHERE p.result = 'victory'))::int AS wins,
                    (count(*) FILTER (WHERE p.result = 'defeat'))::int AS losses,
                    (count(*) FILTER (WHERE p.result = 'victory'))::numeric / count(*) AS win_rate
               FROM game_players p
               JOIN games g ON g.id = p.game_id AND g.counts_for_stats AND g.type = 'Public'
               JOIN users u ON u.id = p.user_id
              WHERE ${LISTABLE_USER}
                AND ($3::boolean OR u.kind <> 'guest')
                AND ($2::timestamptz IS NULL OR g.ended_at >= $2::timestamptz)
              GROUP BY u.id, u.public_id
             HAVING count(*) >= $4
           ) t`,
        [period, from, includeGuests, minGames],
      );
    }
    await client.query("COMMIT");
    return true;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/** Rebuilds now and then every ACCOUNT_RULES.leaderboardRebuildMs; errors are logged, never thrown. Returns a stop function. */
export function startLeaderboardJob(
  pool: Pool,
  log: Pick<Logger, "info" | "error">,
): () => void {
  const run = async () => {
    try {
      await rebuildLeaderboard(pool);
    } catch (error) {
      log.error("leaderboard rebuild failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };
  void run();
  const timer = setInterval(
    () => void run(),
    ACCOUNT_RULES.leaderboardRebuildMs,
  );
  timer.unref();
  return () => clearInterval(timer);
}
