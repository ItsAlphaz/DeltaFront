import type { PlayerLeaderboardResponse } from "@openfront/shared/ApiSchemas";
import { staffRoleOf, type StaffRole } from "@openfront/shared/Permissions";
import { progressState } from "@openfront/shared/ProgressionRules";
import express, {
  type NextFunction,
  type Request,
  type Response,
  type Router,
} from "express";
import { ACCOUNT_RULES } from "../domain/constants";
import { clientIp } from "../http";
import {
  isLeaderboardPeriod,
  LISTABLE_USER,
  type LeaderboardPeriod,
} from "../jobs/leaderboard";
import type { AppDeps } from "./common";

/**
 * GET /leaderboard/players?page=N&period=all|30d: the basic (non-ranked)
 * player leaderboard, as a page of the precomputed table. See
 * jobs/leaderboard.ts for who is listed and in what order.
 *
 * The only inputs are a page number and a period from a fixed list; both are
 * validated before any query, and nothing from the request is ever put into
 * SQL text. A page past the end answers the 400 that the client's ranked
 * leaderboard already treats as "no more pages".
 */
/** The level badge fields of a board row. */
function levelOf(runXp: string, prestige: number) {
  const state = progressState({
    runXp: Number(runXp),
    lifetimeXp: 0,
    prestige,
  });
  return { level: state.level, prestige, legend: state.legend };
}

export function leaderboardRouter(deps: AppDeps): Router {
  const { pool, limiters } = deps;
  const router = express.Router();

  const limited = (req: Request, res: Response, next: NextFunction): void => {
    const verdict = limiters.publicRead.hit(clientIp(req));
    if (!verdict.allowed) {
      res.setHeader("Retry-After", String(verdict.retryAfterSeconds));
      res.status(429).json({ message: "Too many requests" });
      return;
    }
    next();
  };

  const bounds = (lastPage: number) => ({
    message: `Page must be between 1 and ${lastPage}`,
  });

  router.get("/leaderboard/players", limited, async (req, res) => {
    const rawPage = req.query.page ?? "1";
    const rawPeriod = req.query.period ?? "all";
    if (typeof rawPage !== "string" || !/^\d{1,6}$/.test(rawPage)) {
      res.status(400).json({ message: "Invalid page" });
      return;
    }
    if (!isLeaderboardPeriod(rawPeriod)) {
      res.status(400).json({ message: "Invalid period" });
      return;
    }
    const page = Number(rawPage);
    const period: LeaderboardPeriod = rawPeriod;
    if (page < 1 || page > ACCOUNT_RULES.leaderboardMaxPages) {
      res.status(400).json(bounds(ACCOUNT_RULES.leaderboardMaxPages));
      return;
    }
    const size = ACCOUNT_RULES.leaderboardPageSize;
    const { rows } = await pool.query<{
      rank: number;
      public_id: string;
      username: string | null;
      verified: boolean;
      role: string | null;
      games: number;
      wins: number;
      losses: number;
      win_rate: number;
      run_xp: string | null;
      prestige: number | null;
    }>(
      `SELECT l.rank, u.public_id,
              CASE WHEN u.username_base IS NULL THEN NULL
                   WHEN u.username_discriminator IS NULL THEN u.username_base::text
                   ELSE u.username_base::text || '.' || u.username_discriminator END AS username,
              u.verified, u.role, l.games, l.wins, l.losses, l.win_rate::float8 AS win_rate,
              up.run_xp::text AS run_xp, up.prestige
         FROM leaderboard_players l
         JOIN users u ON u.id = l.user_id
         LEFT JOIN user_progress up ON up.user_id = u.id
        WHERE l.period = $1 AND ${LISTABLE_USER}
        ORDER BY l.rank_pos
        LIMIT $2 OFFSET $3`,
      [period, size, (page - 1) * size],
    );
    if (rows.length === 0 && page > 1) {
      // Past the last row: say where the pages end.
      const total = await pool.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM leaderboard_players l JOIN users u ON u.id = l.user_id
          WHERE l.period = $1 AND ${LISTABLE_USER}`,
        [period],
      );
      const lastPage = Math.min(
        ACCOUNT_RULES.leaderboardMaxPages,
        Math.max(1, Math.ceil(total.rows[0].n / size)),
      );
      res.status(400).json(bounds(lastPage));
      return;
    }
    const body: PlayerLeaderboardResponse = {
      players: rows.map((r) => ({
        rank: r.rank,
        playerId: r.public_id,
        accountUsername: r.username,
        verified: r.verified,
        ...(staffRoleOf(r.role) === null
          ? {}
          : { staffRole: staffRoleOf(r.role) as StaffRole }),
        games: r.games,
        wins: r.wins,
        losses: r.losses,
        winRate: r.win_rate,
        ...(deps.config.features.progression && r.run_xp !== null
          ? levelOf(r.run_xp, r.prestige ?? 0)
          : {}),
      })),
    };
    res.setHeader(
      "Cache-Control",
      `public, max-age=${ACCOUNT_RULES.leaderboardCacheSeconds}`,
    );
    res.json(body);
  });

  return router;
}
