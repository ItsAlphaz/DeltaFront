import type {
  ChallengeStatus,
  Progress,
  Reward,
} from "@openfront/shared/ApiSchemas";
import { staffRoleOf, type StaffRole } from "@openfront/shared/Permissions";
import {
  earnedTitles,
  LEVEL_MILESTONES,
  progressState,
  rankForLevel,
  SEASON_MAX_LEVEL,
  SEASON_TRACK,
  SEASON_XP_PER_LEVEL,
  seasonLevel,
  type LevelMilestone,
} from "@openfront/shared/ProgressionRules";
import {
  challengesFor,
  dailyKey,
  dailyResetsAt,
  weeklyKey,
  weeklyResetsAt,
  type ChallengePeriod,
} from "../domain/challenges";
import { PROGRESSION } from "../domain/constants";
import {
  SEASON_COLUMNS,
  toSeason,
  type ProgressRow,
  type SeasonRow,
} from "../domain/progression";
import type { Db } from "./users";

/**
 * Reading progression: the account's state, titles, challenges, the season and
 * its track, recent XP, and the leaderboards. Writes are in
 * domain/progression.ts and domain/progressionOps.ts.
 */

export interface ProgressRowWithTitle extends ProgressRow {
  displayTitle: string | null;
}

/** An account that has not earned XP yet reads as level 1 with nothing. */
export async function progressRowOf(
  db: Db,
  userId: string,
): Promise<ProgressRowWithTitle> {
  const { rows } = await db.query<{
    lifetime: string;
    run: string;
    prestige: number;
    title: string | null;
  }>(
    `SELECT lifetime_xp::text AS lifetime, run_xp::text AS run, prestige,
            display_title AS title
       FROM user_progress WHERE user_id = $1`,
    [userId],
  );
  if (rows.length === 0) {
    return { lifetimeXp: 0, runXp: 0, prestige: 0, displayTitle: null };
  }
  return {
    lifetimeXp: Number(rows[0].lifetime),
    runXp: Number(rows[0].run),
    prestige: rows[0].prestige,
    displayTitle: rows[0].title,
  };
}

/** The titles the account holds right now. */
export async function earnedTitlesOf(
  db: Db,
  userId: string,
  row: ProgressRow,
): Promise<string[]> {
  const state = progressState(row);
  const [wins, seasons] = await Promise.all([
    db.query<{ n: number }>(
      `SELECT count(*)::int AS n
         FROM game_players p JOIN games g ON g.id = p.game_id
        WHERE p.user_id = $1 AND p.result = 'victory'
          AND g.counts_for_stats AND g.type = 'Public'`,
      [userId],
    ),
    db.query<{ number: number; xp: string }>(
      `SELECT s.number, p.xp::text AS xp
         FROM user_season_progress p JOIN seasons s ON s.id = p.season_id
        WHERE p.user_id = $1 ORDER BY s.number`,
      [userId],
    ),
  ]);
  return earnedTitles({
    prestige: row.prestige,
    level: state.level,
    countedWins: wins.rows[0].n,
    seasons: seasons.rows.map((r) => ({ number: r.number, xp: Number(r.xp) })),
  });
}

/** The title the account chose, if it still holds it. */
export function chosenTitle(
  row: ProgressRowWithTitle,
  earned: readonly string[],
): string | null {
  return row.displayTitle !== null && earned.includes(row.displayTitle)
    ? row.displayTitle
    : null;
}

/** The progress fields `/users/@me` and the profile share. */
export function progressWire(
  row: ProgressRowWithTitle,
  title: string | null,
): Progress {
  const state = progressState(row);
  return { ...state, rank: rankForLevel(state.level), title };
}

/** The season running now (any time in its window, archived or not). */
export async function currentSeason(
  db: Db,
  at: Date = new Date(),
): Promise<SeasonRow | null> {
  const { rows } = await db.query<Parameters<typeof toSeason>[0]>(
    `SELECT ${SEASON_COLUMNS} FROM seasons
      WHERE starts_at <= $1 AND ends_at > $1 AND archived_at IS NULL
      ORDER BY starts_at DESC LIMIT 1`,
    [at],
  );
  return rows.length === 0 ? null : toSeason(rows[0]);
}

export async function seasonXpOf(
  db: Db,
  seasonId: string,
  userId: string,
): Promise<number> {
  const { rows } = await db.query<{ xp: string }>(
    "SELECT xp::text AS xp FROM user_season_progress WHERE season_id = $1 AND user_id = $2",
    [seasonId, userId],
  );
  return rows.length === 0 ? 0 : Number(rows[0].xp);
}

/** Level milestones: the next one above `level`. */
export function nextMilestone(level: number): LevelMilestone | null {
  return LEVEL_MILESTONES.find((m) => m.level > level) ?? null;
}

// ---------------------------------------------------------------- rewards

/** The account's unclaimed rewards, in the shape the existing rewards UI reads. */
export async function unclaimedRewards(
  db: Db,
  userId: string,
): Promise<Reward[]> {
  const { rows } = await db.query<{
    id: string;
    credits: string;
    kind: string;
  }>(
    `SELECT id::text AS id, credits::text AS credits, kind
       FROM progression_rewards
      WHERE user_id = $1 AND claimed_at IS NULL AND credits > 0
      ORDER BY id`,
    [userId],
  );
  return rows.map((r) => ({
    id: r.id,
    currencyType: "soft" as const,
    amount: r.credits,
    reason: r.kind,
    note: null,
  }));
}

// ------------------------------------------------------------- challenges

interface ProgressByKey {
  progress: number;
  completed: boolean;
}

export async function challengeStatuses(
  db: Db,
  userId: string,
  period: ChallengePeriod,
  now: Date,
): Promise<{ periodKey: string; resetsAt: string; items: ChallengeStatus[] }> {
  const periodKey = period === "daily" ? dailyKey(now) : weeklyKey(now);
  const resetsAt = (
    period === "daily" ? dailyResetsAt(now) : weeklyResetsAt(now)
  ).toISOString();
  const { rows } = await db.query<{
    challenge_id: string;
    progress: string;
    completed_at: Date | null;
  }>(
    `SELECT challenge_id, progress::text AS progress, completed_at
       FROM challenge_progress WHERE user_id = $1 AND period_key = $2`,
    [userId, periodKey],
  );
  const byId = new Map<string, ProgressByKey>(
    rows.map((r) => [
      r.challenge_id,
      { progress: Number(r.progress), completed: r.completed_at !== null },
    ]),
  );
  const items = challengesFor(userId, period, periodKey).map((def) => {
    const row = byId.get(def.id);
    return {
      id: def.id,
      period,
      slot: def.slot,
      metric: def.metric,
      target: def.target,
      progress: row?.progress ?? 0,
      xp: def.xp,
      credits: def.credits,
      completed: row?.completed ?? false,
    };
  });
  return { periodKey, resetsAt, items };
}

// ---------------------------------------------------------------- history

export interface XpHistoryRow {
  amount: number;
  source: string;
  detail: string | null;
  /** A singleplayer match's setup, for the line's small print. */
  solo?: {
    difficulty: string;
    tribes: number;
    nations: number;
    multiplierPermille: number;
  };
  at: string;
}

export async function recentXp(
  db: Db,
  userId: string,
  limit: number = PROGRESSION.historyRows,
): Promise<XpHistoryRow[]> {
  const { rows } = await db.query<{
    delta: string;
    source: string;
    reason: string | null;
    created_at: Date;
    solo: {
      difficulty?: unknown;
      tribes?: unknown;
      nations?: unknown;
      multiplierPermille?: unknown;
    } | null;
  }>(
    // A solo match's setup is in the breakdown stored with its game.
    `SELECT l.delta::text AS delta, l.source, l.reason, l.created_at,
            CASE WHEN l.source = 'match' AND l.reason = 'solo'
                 THEN p.xp_result -> 'breakdown' -> 'solo' END AS solo
       FROM xp_ledger l
       LEFT JOIN games g ON l.source = 'match' AND l.reason = 'solo' AND g.game_code = l.ref_id
       LEFT JOIN game_players p ON p.game_id = g.id AND p.user_id = l.user_id
      WHERE l.user_id = $1 ORDER BY l.created_at DESC, l.id DESC LIMIT $2`,
    [userId, limit],
  );
  return rows.map((r) => {
    const solo = r.solo;
    return {
      amount: Number(r.delta),
      source: r.source,
      // Only a match carries one (why it was reduced, or "solo"); a staff
      // change's reason is staff's own note and is not shown to the player.
      detail: r.source === "match" ? r.reason : null,
      ...(solo !== null &&
      typeof solo.difficulty === "string" &&
      typeof solo.tribes === "number" &&
      typeof solo.nations === "number" &&
      typeof solo.multiplierPermille === "number"
        ? {
            solo: {
              difficulty: solo.difficulty,
              tribes: solo.tribes,
              nations: solo.nations,
              multiplierPermille: solo.multiplierPermille,
            },
          }
        : {}),
      at: r.created_at.toISOString(),
    };
  });
}

// ----------------------------------------------------------- season track

/** The free track for a season with what the account has unlocked and claimed. */
export async function seasonTrackFor(
  db: Db,
  userId: string,
  season: SeasonRow,
  seasonXp: number,
) {
  const { rows } = await db.query<{
    key: string;
    id: string;
    claimed: boolean;
    credits: string;
  }>(
    `SELECT key, id::text AS id, (claimed_at IS NOT NULL) AS claimed, credits::text AS credits
       FROM progression_rewards
      WHERE user_id = $1 AND season_id = $2 AND kind = 'season_track'`,
    [userId, season.id],
  );
  const byKey = new Map(rows.map((r) => [r.key, r]));
  const level = seasonLevel(seasonXp);
  return SEASON_TRACK.map((reward) => {
    const row = byKey.get(`season:${season.id}:level:${reward.level}`);
    return {
      level: reward.level,
      credits: reward.credits,
      title: reward.title,
      flare: reward.cosmetic
        ? (season.rewardFlares[String(reward.level)] ?? null)
        : null,
      unlocked: level >= reward.level,
      claimed: row?.claimed ?? false,
      rewardId: row !== undefined && !row.claimed ? row.id : null,
    };
  });
}

export function seasonSummary(season: SeasonRow, xp: number) {
  return {
    number: season.number,
    name: season.name,
    startsAt: season.startsAt.toISOString(),
    endsAt: season.endsAt.toISOString(),
    xp,
    level: seasonLevel(xp),
    maxLevel: SEASON_MAX_LEVEL,
    xpPerLevel: SEASON_XP_PER_LEVEL,
  };
}

// ---------------------------------------------------------- leaderboards

/** The accounts that may appear on a board (see jobs/leaderboard.ts LISTABLE_USER). */
export const LISTABLE = `
  u.deleted_at IS NULL AND u.deletion_requested_at IS NULL
  AND u.role IS DISTINCT FROM 'flagged'
  AND NOT EXISTS (
    SELECT 1 FROM bans b
     WHERE b.user_id = u.id AND b.revoked_at IS NULL
       AND (b.expires_at IS NULL OR b.expires_at > now()))`;

export interface XpBoardRow {
  rank: number;
  publicId: string;
  username: string | null;
  verified: boolean;
  staffRole?: StaffRole;
  prestige: number;
  level: number;
  legend: boolean;
  xp: number;
}

interface RawBoardRow {
  rank: string;
  public_id: string;
  username: string | null;
  verified: boolean;
  role: string | null;
  prestige: number;
  run_xp: string;
  xp: string;
}

const USERNAME_SQL = `CASE WHEN u.username_base IS NULL THEN NULL
                          WHEN u.username_discriminator IS NULL THEN u.username_base::text
                          ELSE u.username_base::text || '.' || u.username_discriminator END`;

function toBoardRow(r: RawBoardRow): XpBoardRow {
  const state = progressState({
    runXp: Number(r.run_xp),
    lifetimeXp: Number(r.xp),
    prestige: r.prestige,
  });
  const role = staffRoleOf(r.role);
  return {
    rank: Number(r.rank),
    publicId: r.public_id,
    username: r.username,
    verified: r.verified,
    ...(role === null ? {} : { staffRole: role }),
    prestige: r.prestige,
    level: state.level,
    legend: state.legend,
    xp: Number(r.xp),
  };
}

/** Lifetime XP, highest first. Registered accounts that have earned XP. */
export async function lifetimeBoard(
  db: Db,
  offset: number,
  limit: number,
  window: number,
): Promise<XpBoardRow[]> {
  const { rows } = await db.query<RawBoardRow>(
    `WITH ranked AS (
       SELECT p.user_id, p.lifetime_xp, p.run_xp, p.prestige, u.public_id, u.verified, u.role,
              ${USERNAME_SQL} AS username,
              rank() OVER (ORDER BY p.lifetime_xp DESC) AS rank,
              row_number() OVER (ORDER BY p.lifetime_xp DESC, u.public_id COLLATE "C") AS pos
         FROM (SELECT * FROM user_progress WHERE lifetime_xp > 0) p
         JOIN users u ON u.id = p.user_id
        WHERE u.kind = 'registered' AND ${LISTABLE})
     SELECT rank::text, public_id, username, verified, role, prestige,
            run_xp::text AS run_xp, lifetime_xp::text AS xp
       FROM ranked WHERE pos <= $3 ORDER BY pos OFFSET $1 LIMIT $2`,
    [offset, limit, window],
  );
  return rows.map(toBoardRow);
}

/** A season's XP board: live for a running season, the stored final ranks for an archived one. */
export async function seasonBoard(
  db: Db,
  season: SeasonRow,
  offset: number,
  limit: number,
  window: number,
): Promise<XpBoardRow[]> {
  const archived = season.archivedAt !== null;
  const { rows } = await db.query<RawBoardRow>(
    `WITH ranked AS (
       SELECT s.user_id, s.xp, p.run_xp, COALESCE(p.prestige, 0) AS prestige, u.public_id, u.verified, u.role,
              ${USERNAME_SQL} AS username,
              ${
                archived
                  ? "s.final_rank::bigint AS rank, s.final_rank AS pos"
                  : `rank() OVER (ORDER BY s.xp DESC) AS rank,
              row_number() OVER (ORDER BY s.xp DESC, s.updated_at, u.public_id COLLATE "C") AS pos`
              }
         FROM user_season_progress s
         JOIN users u ON u.id = s.user_id
         LEFT JOIN user_progress p ON p.user_id = s.user_id
        WHERE s.season_id = $4 AND s.xp > 0 AND u.kind = 'registered'
          ${archived ? "AND s.final_rank IS NOT NULL" : ""}
          AND ${LISTABLE})
     SELECT rank::text, public_id, username, verified, role, prestige,
            COALESCE(run_xp, 0)::text AS run_xp, xp::text AS xp
       FROM ranked WHERE pos <= $3 ORDER BY pos OFFSET $1 LIMIT $2`,
    [offset, limit, window, season.id],
  );
  return rows.map(toBoardRow);
}

export async function allSeasons(
  db: Db,
): Promise<Array<SeasonRow & { current: boolean }>> {
  const { rows } = await db.query<Parameters<typeof toSeason>[0]>(
    `SELECT ${SEASON_COLUMNS} FROM seasons ORDER BY number DESC`,
  );
  const now = Date.now();
  return rows.map((r) => {
    const s = toSeason(r);
    return {
      ...s,
      current:
        s.archivedAt === null &&
        s.startsAt.getTime() <= now &&
        s.endsAt.getTime() > now,
    };
  });
}

export async function seasonByNumber(
  db: Db,
  number: number,
): Promise<SeasonRow | null> {
  const { rows } = await db.query<Parameters<typeof toSeason>[0]>(
    `SELECT ${SEASON_COLUMNS} FROM seasons WHERE number = $1`,
    [number],
  );
  return rows.length === 0 ? null : toSeason(rows[0]);
}
