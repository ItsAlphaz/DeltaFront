import { ID } from "@openfront/engine-api/Schemas";
import type {
  ClaimAllRewardsResponse,
  ClaimRewardResponse,
  GameXpResponse,
  ProgressionConfig,
  ProgressionMe,
  PublicProgress,
  XpLeaderboardResponse,
} from "@openfront/shared/ApiSchemas";
import {
  LEVEL_MILESTONES,
  MAX_LEVEL,
  MAX_PRESTIGE,
  PRESTIGE_CREDITS,
  RANKS,
  SEASON_MAX_LEVEL,
  SEASON_TRACK,
  SEASON_XP_PER_LEVEL,
  progressState,
  rankForLevel,
  xpForLevel,
  xpToNext,
} from "@openfront/shared/ProgressionRules";
import express, {
  type NextFunction,
  type Request,
  type Response,
  type Router,
} from "express";
import { withTransaction } from "../db/tx";
import { ACCOUNT_RULES } from "../domain/constants";
import { claimProgressionRewards } from "../domain/economy";
import { prestigeAccount, setDisplayTitle } from "../domain/progressionOps";
import { clientIp } from "../http";
import {
  allSeasons,
  challengeStatuses,
  chosenTitle,
  currentSeason,
  earnedTitlesOf,
  lifetimeBoard,
  nextMilestone,
  progressRowOf,
  progressWire,
  recentXp,
  seasonBoard,
  seasonByNumber,
  seasonSummary,
  seasonTrackFor,
  seasonXpOf,
} from "../repo/progression";
import { activeBan, getUser, getUserByPublicId } from "../repo/users";
import { authenticate, jsonBody, type AppDeps } from "./common";

const PUBLIC_ID = /^[A-Za-z0-9]{6,32}$/;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{8,100}$/;
const REWARD_ID = /^\d{1,18}$/;

/**
 * Progression: the XP of a finished game, prestige, the account page's
 * summary, the public level, the config, titles, reward claims and the XP
 * leaderboards. Every amount here was stored by the server when it was earned;
 * nothing in a request chooses one.
 */
export function progressionRouter(deps: AppDeps): Router {
  const { pool, limiters, catalog } = deps;
  const router = express.Router();
  const env = { validFlares: catalog?.validFlares ?? null };

  const publicLimited = (
    req: Request,
    res: Response,
    next: NextFunction,
  ): void => {
    const verdict = limiters.publicRead.hit(clientIp(req));
    if (!verdict.allowed) {
      res.setHeader("Retry-After", String(verdict.retryAfterSeconds));
      res.status(429).json({ error: "rate_limited" });
      return;
    }
    next();
  };

  /** The signed-in, registered, not banned account behind a request, or null (the response is sent). */
  async function account(req: Request, res: Response, writes = false) {
    res.setHeader("Cache-Control", "no-store");
    const claims = await authenticate(req, deps);
    const user = claims === null ? null : await getUser(pool, claims.userId);
    if (user === null || user.deletedAt !== null) {
      res.status(401).json({ error: "unauthorized" });
      return null;
    }
    if (writes) {
      const verdict = limiters.progressionWrite.hit(user.id);
      if (!verdict.allowed) {
        res.setHeader("Retry-After", String(verdict.retryAfterSeconds));
        res.status(429).json({ error: "rate_limited" });
        return null;
      }
    }
    return user;
  }

  // -- the XP one finished game earned --------------------------------------

  router.get("/users/@me/xp/:gameId", async (req, res) => {
    const user = await account(req, res);
    if (user === null) return;
    const id = ID.safeParse(req.params.gameId);
    if (!id.success) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const { rows } = await pool.query<{
      xp_result: Record<string, unknown> | null;
    }>(
      `SELECT p.xp_result FROM game_players p JOIN games g ON g.id = p.game_id
        WHERE g.game_code = $1 AND p.user_id = $2`,
      [id.data, user.id],
    );
    // Not stored yet, or not the caller's game: indistinguishable on purpose.
    if (rows.length === 0) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const stored = rows[0].xp_result;
    let body: GameXpResponse;
    if (stored === null) {
      body = { gameId: id.data, eligible: false, reason: "before_progression" };
    } else if (stored.eligible === true) {
      const after = stored.after as ReturnType<typeof progressState>;
      body = {
        ...(stored as object),
        gameId: id.data,
        after: { ...after, rank: rankForLevel(after.level) },
      } as unknown as GameXpResponse;
    } else {
      body = {
        gameId: id.data,
        eligible: false,
        reason: String(stored.reason ?? "unknown"),
      };
    }
    res.json(body);
  });

  // -- prestige --------------------------------------------------------------

  router.post("/users/@me/prestige", async (req, res) => {
    const user = await account(req, res, true);
    if (user === null) return;
    const key = req.headers["idempotency-key"];
    if (typeof key !== "string" || !IDEMPOTENCY_KEY.test(key)) {
      res.status(400).json({ error: "idempotency_key_required" });
      return;
    }
    if (user.kind !== "registered") {
      res.status(409).json({ error: "not_eligible" });
      return;
    }
    if ((await activeBan(pool, user.id)) !== null) {
      res.status(403).json({ error: "banned" });
      return;
    }
    const outcome = await prestigeAccount(pool, user.id, key, env);
    if (outcome.kind === "refused") {
      res.status(409).json({ error: "not_eligible" });
      return;
    }
    res.json(outcome.response);
  });

  // -- the account page --------------------------------------------------------

  router.get("/progression/me", async (req, res) => {
    const user = await account(req, res);
    if (user === null) return;
    const now = new Date();
    const row = await progressRowOf(pool, user.id);
    const [titles, season, daily, weekly, history] = await Promise.all([
      earnedTitlesOf(pool, user.id, row),
      currentSeason(pool, now),
      challengeStatuses(pool, user.id, "daily", now),
      challengeStatuses(pool, user.id, "weekly", now),
      recentXp(pool, user.id),
    ]);
    const title = chosenTitle(row, titles);
    const progress = progressWire(row, title);
    const seasonXp =
      season === null ? 0 : await seasonXpOf(pool, season.id, user.id);
    const milestone = nextMilestone(progress.level);
    const levelHidden = (
      await pool.query<{ level_hidden: boolean }>(
        "SELECT level_hidden FROM users WHERE id = $1",
        [user.id],
      )
    ).rows[0].level_hidden;
    const body: ProgressionMe = {
      progress,
      rank: rankForLevel(progress.level),
      nextMilestone: milestone,
      season: season === null ? null : seasonSummary(season, seasonXp),
      seasonTrack:
        season === null
          ? []
          : await seasonTrackFor(pool, user.id, season, seasonXp),
      challenges: { daily, weekly },
      titles,
      selectedTitle: title,
      history,
      levelHidden,
    };
    res.json(body);
  });

  router.put("/users/@me/title", jsonBody("1kb"), async (req, res) => {
    const user = await account(req, res, true);
    if (user === null) return;
    const title = (req.body as { title?: unknown } | undefined)?.title;
    if (title !== null && typeof title !== "string") {
      res.status(400).json({ error: "invalid_title" });
      return;
    }
    if (!(await setDisplayTitle(pool, user.id, title))) {
      res.status(400).json({ error: "title_not_earned" });
      return;
    }
    res.json({ title });
  });

  // -- reward claims -----------------------------------------------------------

  router.post("/rewards/claim-all", async (req, res) => {
    const user = await account(req, res, true);
    if (user === null) return;
    const result = await withTransaction(pool, (tx) =>
      claimProgressionRewards(tx, user.id, null),
    );
    const body: ClaimAllRewardsResponse = {
      claimed: result.claimed.map((id) => ({ id })),
      currency: { soft: result.balance, hard: 0 },
    };
    res.json(body);
  });

  router.post("/rewards/:rewardId/claim", async (req, res) => {
    const user = await account(req, res, true);
    if (user === null) return;
    const rewardId = String(req.params.rewardId);
    if (!REWARD_ID.test(rewardId)) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const result = await withTransaction(pool, (tx) =>
      claimProgressionRewards(tx, user.id, rewardId),
    );
    if (result.claimed.length === 0) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const body: ClaimRewardResponse = {
      currency: { soft: result.balance, hard: 0 },
    };
    res.json(body);
  });

  // -- public ------------------------------------------------------------------

  router.get(
    "/public/player/:publicId/progress",
    publicLimited,
    async (req, res) => {
      const publicId = String(req.params.publicId);
      const user = PUBLIC_ID.test(publicId)
        ? await getUserByPublicId(pool, publicId)
        : null;
      if (
        user === null ||
        user.kind !== "registered" ||
        user.deletedAt !== null ||
        user.deletionRequestedAt !== null
      ) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      const hidden = await pool.query<{ level_hidden: boolean }>(
        "SELECT level_hidden FROM users WHERE id = $1",
        [user.id],
      );
      if (hidden.rows[0].level_hidden) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      const row = await progressRowOf(pool, user.id);
      const [titles, season] = await Promise.all([
        earnedTitlesOf(pool, user.id, row),
        currentSeason(pool),
      ]);
      const state = progressState(row);
      const seasonXp =
        season === null ? 0 : await seasonXpOf(pool, season.id, user.id);
      const body: PublicProgress = {
        prestige: state.prestige,
        level: state.level,
        lifetimeXp: state.lifetimeXp,
        legend: state.legend,
        xpInLevel: state.xpInLevel,
        xpForNext: state.xpForNext,
        rank: rankForLevel(state.level),
        title: chosenTitle(row, titles),
        season:
          season === null
            ? null
            : {
                number: season.number,
                name: season.name,
                level: seasonSummary(season, seasonXp).level,
                xp: seasonXp,
              },
      };
      res.setHeader("Cache-Control", "public, max-age=30");
      res.json(body);
    },
  );

  router.get("/public/progression/config", publicLimited, async (_req, res) => {
    const season = await currentSeason(pool);
    const levels = Array.from({ length: MAX_LEVEL }, (_, i) => {
      const level = i + 1;
      const milestone = LEVEL_MILESTONES.find((m) => m.level === level);
      return {
        level,
        xpToNext: xpToNext(level),
        cumulativeXp: xpForLevel(level),
        ...(milestone === undefined ? {} : { caps: milestone.credits }),
      };
    });
    const flares: ProgressionConfig["flares"] = LEVEL_MILESTONES.flatMap((m) =>
      m.flare === null
        ? []
        : [
            {
              kind: "level",
              level: m.level,
              prestige: null,
              flareName: m.flare,
              cosmetic: cosmeticOf(m.flare),
            },
          ],
    );
    const body = {
      version: 1,
      maxLevel: MAX_LEVEL,
      maxPrestige: MAX_PRESTIGE,
      levels,
      prestige: { caps: PRESTIGE_CREDITS },
      ranks: RANKS.map((r) => ({ key: r.key, fromLevel: r.fromLevel })),
      milestones: LEVEL_MILESTONES.map((m) => ({ ...m })),
      flares,
      season:
        season === null
          ? null
          : {
              number: season.number,
              name: season.name,
              startsAt: season.startsAt.toISOString(),
              endsAt: season.endsAt.toISOString(),
              xpPerLevel: SEASON_XP_PER_LEVEL,
              maxLevel: SEASON_MAX_LEVEL,
              rewards: SEASON_TRACK.map((r) => ({
                level: r.level,
                credits: r.credits,
                title: r.title,
                flare: r.cosmetic
                  ? (season.rewardFlares[String(r.level)] ?? null)
                  : null,
              })),
            },
    };
    res.setHeader("Cache-Control", "public, max-age=60");
    res.json(body);
  });

  // -- leaderboards -------------------------------------------------------------

  function page(req: Request, res: Response): number | null {
    const raw = req.query.page ?? "1";
    if (typeof raw !== "string" || !/^\d{1,6}$/.test(raw)) {
      res.status(400).json({ message: "Invalid page" });
      return null;
    }
    const n = Number(raw);
    if (n < 1 || n > ACCOUNT_RULES.leaderboardMaxPages) {
      res.status(400).json({
        message: `Page must be between 1 and ${ACCOUNT_RULES.leaderboardMaxPages}`,
      });
      return null;
    }
    return n;
  }

  const entry = (r: Awaited<ReturnType<typeof lifetimeBoard>>[number]) => ({
    rank: r.rank,
    playerId: r.publicId,
    accountUsername: r.username,
    verified: r.verified,
    ...(r.staffRole === undefined ? {} : { staffRole: r.staffRole }),
    prestige: r.prestige,
    level: r.level,
    legend: r.legend,
    xp: r.xp,
  });
  const WINDOW =
    ACCOUNT_RULES.leaderboardPageSize * ACCOUNT_RULES.leaderboardMaxPages;

  router.get("/leaderboard/xp", publicLimited, async (req, res) => {
    const n = page(req, res);
    if (n === null) return;
    const size = ACCOUNT_RULES.leaderboardPageSize;
    const rows = await lifetimeBoard(pool, (n - 1) * size, size, WINDOW);
    if (rows.length === 0 && n > 1) {
      res.status(400).json({
        message: `Page must be between 1 and ${Math.max(1, n - 1)}`,
      });
      return;
    }
    const body: XpLeaderboardResponse = { players: rows.map(entry) };
    res.setHeader(
      "Cache-Control",
      `public, max-age=${ACCOUNT_RULES.leaderboardCacheSeconds}`,
    );
    res.json(body);
  });

  router.get("/leaderboard/season", publicLimited, async (req, res) => {
    const n = page(req, res);
    if (n === null) return;
    const seasons = await allSeasons(pool);
    const wanted = req.query.season;
    let season = null;
    if (wanted === undefined) {
      season = await currentSeason(pool);
      // Between seasons the board shows the latest one that ended.
      season ??= seasons.find((s) => s.archivedAt !== null) ?? null;
    } else if (typeof wanted === "string" && /^\d{1,6}$/.test(wanted)) {
      season = await seasonByNumber(pool, Number(wanted));
    }
    const list = seasons
      .filter((s) => s.archivedAt !== null || s.current)
      .map((s) => ({ number: s.number, name: s.name }));
    if (season === null) {
      if (wanted !== undefined) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      res.json({ players: [], seasons: list } satisfies XpLeaderboardResponse);
      return;
    }
    const size = ACCOUNT_RULES.leaderboardPageSize;
    const rows = await seasonBoard(pool, season, (n - 1) * size, size, WINDOW);
    const body: XpLeaderboardResponse = {
      players: rows.map(entry),
      season: {
        number: season.number,
        name: season.name,
        archived: season.archivedAt !== null,
      },
      seasons: list,
    };
    res.setHeader(
      "Cache-Control",
      `public, max-age=${ACCOUNT_RULES.leaderboardCacheSeconds}`,
    );
    res.json(body);
  });

  return router;
}

/** `{type, name}` for a cosmetic flare ("flag:x", "pattern:x:palette", "effect:x"). */
function cosmeticOf(flare: string): { type: string; name: string } | null {
  const [type, name] = flare.split(":");
  return type && name ? { type, name } : null;
}
