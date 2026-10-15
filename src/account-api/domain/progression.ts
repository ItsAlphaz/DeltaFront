import {
  LEVEL_MILESTONES,
  levelsBetween,
  MAX_RUN_XP,
  progressState,
  runProgress,
  seasonLevel,
  trackRewardsBetween,
  type ProgressState,
} from "@openfront/shared/ProgressionRules";
import type { GameRecord } from "@openfront/shared/WireSchemas";
import type { PoolClient } from "pg";
import { grantFlare } from "../repo/inventory";
import {
  advance,
  challengesFor,
  dailyKey,
  weeklyKey,
  weekRange,
  type ChallengeDef,
  type ChallengePeriod,
  type GameMetrics,
} from "./challenges";
import { PERMILLE, PROGRESSION } from "./constants";
import { computeSoloXp } from "./solo";
import type { SoloVerified } from "./soloVerify";
import {
  isCompletedOutcome,
  leftWhileAlive,
  playerProgressionOutcome,
  resultFor,
  type PlayerProgressionOutcome,
} from "./stats";
import {
  alliancesFormed,
  computeMatchXp,
  computeReducedXp,
  eliminatedBeforeMinimum,
  goldEarned,
  playerStanding,
  reducedReasonFor,
  repeatPermille,
  secondsSurvived,
  structuresBuilt,
  validEliminations,
  type PlacementTable,
  type PlayerIneligibleReason,
  type ProgressionEligibility,
  type ProgressionReason,
} from "./xp";

/**
 * Writing progression: the XP ledger, the per-account state, rewards, seasons'
 * XP and what a finished game awards. Everything runs on the caller's
 * transaction (game ingestion, or an admin command).
 *
 * Lock order, everywhere: wallet (if Credits move), then `user_progress`.
 * `user_progress` is locked first thing for an account, so every award, admin
 * change and prestige for it runs one at a time and two games ending together
 * cannot both read the same daily total.
 */

// ---------------------------------------------------------------- state

export interface ProgressRow {
  lifetimeXp: number;
  runXp: number;
  prestige: number;
}

/** What rewards need from the rest of the server: the cosmetics that can really be granted. */
export interface RewardEnv {
  /** Catalog flares; null while no catalog is loaded (cosmetics are then not granted). */
  validFlares: ReadonlySet<string> | null;
}

export interface SeasonRow {
  id: string;
  number: number;
  name: string;
  startsAt: Date;
  endsAt: Date;
  /** Level -> catalog flare, the season's own cosmetic on the free track. */
  rewardFlares: Record<string, string>;
  archivedAt: Date | null;
}

export type XpSource =
  | "match"
  | "daily_challenge"
  | "weekly_challenge"
  | "admin_grant"
  | "admin_revoke"
  | "admin_set";

export interface LevelUp {
  prestige: number;
  level: number;
}

/** Locks the account's progress row (creating it empty), returning its state. */
export async function lockProgress(
  tx: PoolClient,
  userId: string,
): Promise<ProgressRow> {
  await tx.query(
    "INSERT INTO user_progress (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING",
    [userId],
  );
  const { rows } = await tx.query<{
    lifetime: string;
    run: string;
    prestige: number;
  }>(
    `SELECT lifetime_xp::text AS lifetime, run_xp::text AS run, prestige
       FROM user_progress WHERE user_id = $1 FOR UPDATE`,
    [userId],
  );
  return {
    lifetimeXp: Number(rows[0].lifetime),
    runXp: Number(rows[0].run),
    prestige: rows[0].prestige,
  };
}

export function stateOf(row: ProgressRow): ProgressState {
  return progressState(row);
}

function position(row: ProgressRow) {
  const p = runProgress(row.runXp);
  return {
    prestige: row.prestige,
    level: p.level,
    xpInLevel: p.xpInLevel,
    xpForNext: p.xpForNext,
  };
}

const SEASON_COLUMNS = `id::text AS id, number, name, starts_at, ends_at, reward_flares, archived_at`;

interface RawSeason {
  id: string;
  number: number;
  name: string;
  starts_at: Date;
  ends_at: Date;
  reward_flares: Record<string, string>;
  archived_at: Date | null;
}

export function toSeason(row: RawSeason): SeasonRow {
  return {
    id: row.id,
    number: row.number,
    name: row.name,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    rewardFlares: row.reward_flares ?? {},
    archivedAt: row.archived_at,
  };
}

export { SEASON_COLUMNS };

/** The season a game ending at `at` counts for: its window holds `at` and it is not archived yet. */
export async function seasonAt(
  db: Pick<PoolClient, "query">,
  at: Date,
): Promise<SeasonRow | null> {
  const { rows } = await db.query<RawSeason>(
    `SELECT ${SEASON_COLUMNS} FROM seasons
      WHERE starts_at <= $1 AND ends_at > $1 AND archived_at IS NULL
      ORDER BY starts_at DESC LIMIT 1`,
    [at],
  );
  return rows.length === 0 ? null : toSeason(rows[0]);
}

// -------------------------------------------------------------- rewards

export interface NewReward {
  key: string;
  kind: "level_milestone" | "prestige" | "season_track" | "challenge";
  credits: number;
  flare: string | null;
  seasonId?: string | null;
}

/**
 * Records a reward for the account (once per key) and grants its cosmetic at
 * once. Credits wait for a claim; a reward with no Credits is claimed on
 * creation. Returns the new reward's id, or null if the key already existed.
 */
export async function unlockReward(
  tx: PoolClient,
  userId: string,
  reward: NewReward,
  env: RewardEnv,
): Promise<string | null> {
  const { rows } = await tx.query<{ id: string }>(
    `INSERT INTO progression_rewards (user_id, key, kind, credits, flare, season_id, claimed_at)
     VALUES ($1, $2, $3, $4, $5, $6, CASE WHEN $4::bigint = 0 THEN now() END)
     ON CONFLICT (user_id, key) DO NOTHING
     RETURNING id::text AS id`,
    [
      userId,
      reward.key,
      reward.kind,
      reward.credits,
      reward.flare,
      reward.seasonId ?? null,
    ],
  );
  if (rows.length === 0) return null;
  if (
    reward.flare !== null &&
    env.validFlares !== null &&
    env.validFlares.has(reward.flare)
  ) {
    await grantFlare(tx, userId, reward.flare, { source: "reward" });
  }
  return rows[0].id;
}

// -------------------------------------------------------------- applying XP

export interface ApplyXpInput {
  source: XpSource;
  refType: string | null;
  refId: string | null;
  rewardDay: string | null;
  /** The season the XP also counts for, and how much of it. */
  season?: SeasonRow | null;
  seasonDelta?: number;
  actor?: string | null;
  reason?: string | null;
}

export interface ApplyXpResult {
  /** False when the ledger already had this award: nothing changed. */
  applied: boolean;
  after: ProgressRow;
  /** Levels crossed upwards, in order. */
  levels: LevelUp[];
  /** Season XP before and after, when season XP was added. */
  season: { before: number; after: number } | null;
}

/**
 * Changes an account's XP by `delta` (negative only for an admin revoke or
 * set): the ledger row, the progress row, season XP and the rewards the new
 * levels unlock. `state` is the locked row as it is now. Awards from games and
 * challenges are unique in the ledger, so the same one cannot apply twice.
 */
export async function applyXp(
  tx: PoolClient,
  userId: string,
  state: ProgressRow,
  delta: number,
  input: ApplyXpInput,
  env: RewardEnv,
): Promise<ApplyXpResult> {
  const nothing: ApplyXpResult = {
    applied: false,
    after: state,
    levels: [],
    season: null,
  };
  if (delta === 0) return nothing;
  const runXp =
    delta > 0
      ? Math.min(MAX_RUN_XP, state.runXp + delta)
      : Math.max(0, state.runXp + delta);
  const after: ProgressRow = {
    lifetimeXp: Math.max(0, state.lifetimeXp + delta),
    runXp,
    prestige: state.prestige,
  };
  const season = input.season ?? null;
  const seasonDelta = season === null ? 0 : (input.seasonDelta ?? 0);
  const ledger = await tx.query(
    `INSERT INTO xp_ledger
       (user_id, delta, lifetime_after, run_after, prestige, source, ref_type, ref_id,
        season_id, season_delta, reward_day, actor, reason)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::date, $12, $13)
     ON CONFLICT DO NOTHING
     RETURNING id`,
    [
      userId,
      after.lifetimeXp - state.lifetimeXp,
      after.lifetimeXp,
      after.runXp,
      after.prestige,
      input.source,
      input.refType,
      input.refId,
      season?.id ?? null,
      seasonDelta,
      input.rewardDay,
      input.actor ?? null,
      input.reason ?? null,
    ],
  );
  if (ledger.rows.length === 0) return nothing;
  await tx.query(
    `UPDATE user_progress SET lifetime_xp = $2, run_xp = $3, updated_at = now()
      WHERE user_id = $1`,
    [userId, after.lifetimeXp, after.runXp],
  );

  const levels: LevelUp[] = [];
  if (delta > 0) {
    for (const level of levelsBetween(state.runXp, after.runXp)) {
      levels.push({ prestige: state.prestige, level });
      const milestone = LEVEL_MILESTONES.find((m) => m.level === level);
      if (milestone !== undefined) {
        await unlockReward(
          tx,
          userId,
          {
            key: `level:p${state.prestige}:${level}`,
            kind: "level_milestone",
            credits: milestone.credits,
            flare: milestone.flare,
          },
          env,
        );
      }
    }
  }

  let seasonResult: ApplyXpResult["season"] = null;
  if (season !== null && seasonDelta !== 0) {
    const { rows } = await tx.query<{ xp: string }>(
      `INSERT INTO user_season_progress (season_id, user_id, xp)
       VALUES ($1, $2, GREATEST($3::bigint, 0))
       ON CONFLICT (season_id, user_id) DO UPDATE
          SET xp = GREATEST(user_season_progress.xp + $3::bigint, 0), updated_at = now()
       RETURNING xp::text AS xp`,
      [season.id, userId, seasonDelta],
    );
    const seasonAfter = Number(rows[0].xp);
    const seasonBefore = Math.max(0, seasonAfter - seasonDelta);
    seasonResult = { before: seasonBefore, after: seasonAfter };
    if (seasonDelta > 0) {
      for (const reward of trackRewardsBetween(seasonBefore, seasonAfter)) {
        await unlockReward(
          tx,
          userId,
          {
            key: `season:${season.id}:level:${reward.level}`,
            kind: "season_track",
            credits: reward.credits,
            flare: reward.cosmetic
              ? (season.rewardFlares[String(reward.level)] ?? null)
              : null,
            seasonId: season.id,
          },
          env,
        );
      }
    }
  }
  return { applied: true, after, levels, season: seasonResult };
}

// --------------------------------------------------- awarding a finished game

/** A player of the game whose account was found. */
export interface GamePlayer {
  userId: string;
  clientID: string;
  kind: "guest" | "registered";
  /** The clan they were in at game start, when they were. */
  clanId: string | null;
}

/** Facts about the finished game that every player's award reads. */
export interface GameXpContext {
  record: GameRecord;
  gameCode: string;
  endedAt: Date;
  /** How far this game advances progression (see progressionEligibility). */
  eligibility: ProgressionEligibility;
  isFfa: boolean;
  placement: PlacementTable;
  acted: ReadonlySet<string>;
  adminSenders: ReadonlySet<string>;
  /** clientID -> what the game came to for them (see playerProgressionOutcome), for the account holders. */
  outcomes: ReadonlyMap<string, PlayerProgressionOutcome>;
  /** clientID -> completed (a completing outcome), for the account holders. */
  completed: ReadonlyMap<string, boolean>;
  /** Eligible humans: account holders who acted and stayed to the result, or were eliminated after the minimum (see countsAsParticipant). */
  eligible: ReadonlyArray<{ userId: string; clientID: string }>;
  map: string | null;
  season: SeasonRow | null;
  env: RewardEnv;
}

export interface CompletedChallenge {
  id: string;
  period: ChallengePeriod;
  xp: number;
  credits: number;
}

export type StoredXpResult =
  | { eligible: false; reason: string }
  | {
      eligible: true;
      /** "reduced" and "solo": lifetime XP only (see progressionEligibility). */
      mode: "full" | "reduced" | "solo";
      breakdown: ReturnType<typeof computeMatchXp>["breakdown"] & {
        leftEarly: false;
        time: 0;
        feats: 0;
        subscriberPermille: 1000;
      };
      before: {
        prestige: number;
        level: number;
        xpInLevel: number;
        xpForNext: number;
      };
      after: ProgressState;
      levelsReached: LevelUp[];
      challenges: CompletedChallenge[];
      season: {
        number: number;
        name: string;
        xp: number;
        level: number;
        added: number;
      } | null;
      flags: string[];
    };

export interface PlayerXpOutcome {
  /** Match XP paid. */
  xpAwarded: number;
  clanXp: number;
  result: StoredXpResult;
}

const ineligible = (reason: string): PlayerXpOutcome => ({
  xpAwarded: 0,
  clanXp: 0,
  result: { eligible: false, reason },
});

/**
 * Why a player earned nothing from a game that pays, or null if they are
 * eligible. Leaving while still in the game is the disqualifier. A player who
 * was eliminated is not held to the rest of the game: their reduced award does
 * not depend on staying, on the game's length or on its ending with a winner.
 */
export function playerIneligibleReason(
  ctx: GameXpContext,
  player: GamePlayer,
): PlayerIneligibleReason | null {
  if (player.kind === "guest") return "guest";
  const standing = playerStanding(ctx.record, player.clientID);
  if (standing === "not_spawned") return "not_spawned";
  if (standing === "survived" && ctx.completed.get(player.clientID) !== true) {
    // Still in the game and either no result or gone before it.
    return ctx.outcomes.get(player.clientID) === "no_winner"
      ? "no_winner"
      : "left_early";
  }
  // Abandoning the game while still alive is leaving, even if they were
  // eliminated after: only a death with the player there to see it is secured.
  if (
    standing === "eliminated" &&
    leftWhileAlive(ctx.record, player.clientID)
  ) {
    return "left_early";
  }
  if (!ctx.acted.has(player.clientID)) return "no_action";
  return null;
}

/**
 * Whether the player counts as a human of the game for the player-count
 * multiplier: they acted and either were eliminated after the minimum (and had
 * not abandoned the game before) or stayed to the result. A player who left a
 * dead seat is still a player the game had; one eliminated within the first two
 * minutes is not (a free kill must not inflate the game's population).
 */
export function countsAsParticipant(
  record: Pick<GameRecord, "info" | "turns">,
  completed: boolean,
  acted: boolean,
  clientID: string,
): boolean {
  if (!acted) return false;
  switch (playerStanding(record, clientID)) {
    case "not_spawned":
      return false;
    case "eliminated":
      return (
        !eliminatedBeforeMinimum(record, clientID) &&
        !leftWhileAlive(record, clientID)
      );
    case "survived":
      return completed;
  }
}

/** Per-game contributions to the challenge metrics, for one player. */
function gameMetrics(
  ctx: GameXpContext,
  player: GamePlayer,
  victory: boolean,
  place: number | null,
  eliminations: number,
): GameMetrics {
  const record = ctx.record;
  const me = record.info.players.find((p) => p.clientID === player.clientID);
  const humans = ctx.placement.humans;
  return {
    games: 1,
    top_half: place !== null && place <= Math.ceil(humans / 2) ? 1 : 0,
    top_quarter: place !== null && place <= Math.ceil(humans / 4) ? 1 : 0,
    wins: victory ? 1 : 0,
    eliminations,
    survive_seconds: me === undefined ? 0 : secondsSurvived(record, me),
    structures: structuresBuilt(me?.stats),
    gold_single_game: goldEarned(me?.stats),
    alliances: alliancesFormed(me?.stats),
  };
}

const utcDay = (at: Date) => at.toISOString().slice(0, 10);

/**
 * How many counted games `userId` completed with each of `others` in the day
 * before `endedAt`, other than game `excludeGameId` (the repeated-opponents check).
 */
export async function priorGamesWith(
  db: Pick<PoolClient, "query">,
  userId: string,
  others: readonly string[],
  endedAt: Date,
  excludeGameId: string,
): Promise<number[]> {
  if (others.length === 0 || others.length > PROGRESSION.repeat.maxOthers) {
    return [];
  }
  const from = new Date(
    endedAt.getTime() - PROGRESSION.repeat.windowHours * 3_600_000,
  );
  const { rows } = await db.query<{ other: string; n: number }>(
    `SELECT b.user_id AS other, count(*)::int AS n
       FROM game_players a
       JOIN game_players b ON b.game_id = a.game_id AND b.user_id <> a.user_id
       JOIN games g ON g.id = a.game_id
      WHERE a.user_id = $1 AND b.user_id = ANY($2::uuid[])
        AND a.completed AND b.completed AND g.counts_for_stats
        AND g.id <> $3 AND g.ended_at >= $4 AND g.ended_at <= $5
      GROUP BY b.user_id`,
    [userId, others, excludeGameId, from, endedAt],
  );
  const byOther = new Map(rows.map((r) => [r.other, r.n]));
  return others.map((id) => byOther.get(id) ?? 0);
}

/** The other eligible players' shared prior games with this one, for the repeated-opponents check. */
async function sharedPriorGames(
  tx: PoolClient,
  ctx: GameXpContext,
  gameId: string,
  player: GamePlayer,
): Promise<number[]> {
  const others = ctx.eligible
    .map((e) => e.userId)
    .filter((id) => id !== player.userId);
  return priorGamesWith(tx, player.userId, others, ctx.endedAt, gameId);
}

async function distinctMapsInWeek(
  tx: PoolClient,
  userId: string,
  periodKey: string,
  gameId: string,
  currentMap: string | null,
): Promise<number> {
  const range = weekRange(periodKey);
  if (range === null) return 0;
  const { rows } = await tx.query<{ map: string }>(
    `SELECT DISTINCT g.map
       FROM game_players p JOIN games g ON g.id = p.game_id
      WHERE p.user_id = $1 AND (p.xp_result ->> 'eligible') = 'true'
        AND g.ended_at >= $2 AND g.ended_at < $3 AND g.id <> $4 AND g.map IS NOT NULL`,
    [userId, range.from, range.to, gameId],
  );
  const maps = new Set(rows.map((r) => r.map));
  if (currentMap !== null) maps.add(currentMap);
  return maps.size;
}

interface ChallengeRow {
  challenge_id: string;
  progress: string;
  completed_at: Date | null;
}

/**
 * Moves the player's daily and weekly challenges on for this game and pays the
 * XP of any that complete. Returns the ones completed.
 */
async function progressChallenges(
  tx: PoolClient,
  ctx: GameXpContext,
  gameId: string,
  player: GamePlayer,
  metrics: GameMetrics,
  state: { progress: ProgressRow; levels: LevelUp[]; seasonXp: number },
): Promise<CompletedChallenge[]> {
  const completedNow: CompletedChallenge[] = [];
  const periods: Array<[ChallengePeriod, string]> = [
    ["daily", dailyKey(ctx.endedAt)],
    ["weekly", weeklyKey(ctx.endedAt)],
  ];
  for (const [period, periodKey] of periods) {
    const defs: ChallengeDef[] = challengesFor(
      player.userId,
      period,
      periodKey,
    );
    const { rows } = await tx.query<ChallengeRow>(
      `SELECT challenge_id, progress::text AS progress, completed_at
         FROM challenge_progress WHERE user_id = $1 AND period_key = $2`,
      [player.userId, periodKey],
    );
    const existing = new Map(rows.map((r) => [r.challenge_id, r]));
    for (const def of defs) {
      const row = existing.get(def.id);
      if (row?.completed_at) continue;
      const current = row === undefined ? 0 : Number(row.progress);
      const distinct =
        def.metric === "distinct_maps"
          ? await distinctMapsInWeek(
              tx,
              player.userId,
              periodKey,
              gameId,
              ctx.map,
            )
          : 0;
      const next = advance(def, current, metrics, distinct);
      if (next === current) continue;
      const done = next >= def.target;
      await tx.query(
        `INSERT INTO challenge_progress (user_id, period_key, challenge_id, progress, target, completed_at, reward_xp)
         VALUES ($1, $2, $3, $4, $5, CASE WHEN $6::boolean THEN now() END, CASE WHEN $6::boolean THEN $7::int ELSE 0 END)
         ON CONFLICT (user_id, period_key, challenge_id) DO UPDATE
            SET progress = $4, completed_at = CASE WHEN $6::boolean THEN now() END,
                reward_xp = CASE WHEN $6::boolean THEN $7::int ELSE 0 END, updated_at = now()`,
        [player.userId, periodKey, def.id, next, def.target, done, def.xp],
      );
      if (!done) continue;
      const applied = await applyXp(
        tx,
        player.userId,
        state.progress,
        def.xp,
        {
          source: period === "daily" ? "daily_challenge" : "weekly_challenge",
          refType: "challenge",
          refId: `${periodKey}:${def.id}`,
          rewardDay: utcDay(ctx.endedAt),
          season: ctx.season,
          seasonDelta: def.xp,
        },
        ctx.env,
      );
      if (applied.applied) {
        state.progress = applied.after;
        state.levels.push(...applied.levels);
        if (applied.season !== null) state.seasonXp = applied.season.after;
      }
      if (def.credits > 0) {
        await unlockReward(
          tx,
          player.userId,
          {
            key: `challenge:${periodKey}:${def.id}`,
            kind: "challenge",
            credits: def.credits,
            flare: null,
          },
          ctx.env,
        );
      }
      completedNow.push({
        id: def.id,
        period,
        xp: def.xp,
        credits: def.credits,
      });
    }
  }
  return completedNow;
}

/** A reduced award that was paid before its game was stored (see earlyXp.ts). */
export interface EarlyAward {
  xpAwarded: number;
  result: Extract<StoredXpResult, { eligible: true }>;
}

/** The reduced award the player was paid when they were eliminated, if they were. */
export async function earlyAwardOf(
  db: Pick<PoolClient, "query">,
  userId: string,
  gameCode: string,
): Promise<EarlyAward | null> {
  const { rows } = await db.query<{ xp_awarded: string; result: unknown }>(
    `SELECT xp_awarded::text AS xp_awarded, result
       FROM early_xp WHERE user_id = $1 AND game_code = $2`,
    [userId, gameCode],
  );
  if (rows.length === 0) return null;
  return {
    xpAwarded: Number(rows[0].xp_awarded),
    result: rows[0].result as EarlyAward["result"],
  };
}

const adopted = (early: EarlyAward): PlayerXpOutcome => ({
  xpAwarded: early.xpAwarded,
  clanXp: 0,
  result: early.result,
});

export interface ReducedAwardInput {
  userId: string;
  gameCode: string;
  /** The UTC day the XP counts towards (the soft cap's day). */
  at: Date;
  reason: ProgressionReason;
  /** Counted eliminations, before the per-game limit. */
  eliminations: number;
  flags?: readonly string[];
  env: RewardEnv;
}

/**
 * Pays a reduced award: completed match and valid eliminations at a quarter, to
 * lifetime XP ONLY. It is not an exception inside the full path: nothing here
 * touches the season, the challenges, clan XP or the daily first-game and
 * first-win bonuses. The one place a reduced award is worked out and written,
 * for a game being stored and for a death paid while the game is still on.
 *
 * Exactly once per player and game: the progress row is locked first, a prior
 * early award is adopted instead of paid again, and the ledger's unique key on
 * (user, game) refuses a second payment whatever else happens.
 */
export async function payReducedXp(
  tx: PoolClient,
  input: ReducedAwardInput,
): Promise<PlayerXpOutcome> {
  const startRow = await lockProgress(tx, input.userId);
  const early = await earlyAwardOf(tx, input.userId, input.gameCode);
  if (early !== null) return adopted(early);
  const before = position(startRow);
  const day = utcDay(input.at);
  await tx.query(
    `INSERT INTO xp_daily (user_id, day) VALUES ($1, $2::date) ON CONFLICT DO NOTHING`,
    [input.userId, day],
  );
  const daily = await tx.query<{ match_xp: string }>(
    `SELECT match_xp::text AS match_xp FROM xp_daily
      WHERE user_id = $1 AND day = $2::date FOR UPDATE`,
    [input.userId, day],
  );
  const reduced = computeReducedXp({
    reason: input.reason,
    eliminations: input.eliminations,
    earnedToday: Number(daily.rows[0].match_xp),
  });
  const paid = reduced.breakdown.total;
  let progress = startRow;
  const levels: LevelUp[] = [];
  if (paid > 0) {
    const applied = await applyXp(
      tx,
      input.userId,
      progress,
      paid,
      {
        source: "match",
        refType: "game",
        refId: input.gameCode,
        rewardDay: day,
        // No season: reduced XP is lifetime XP only. The ledger remembers why.
        season: null,
        seasonDelta: 0,
        reason: input.reason,
      },
      input.env,
    );
    if (!applied.applied) return ineligible("duplicate");
    progress = applied.after;
    levels.push(...applied.levels);
  }
  // Counts towards the day's soft cap, but spends no daily bonus.
  await tx.query(
    `UPDATE xp_daily SET match_xp = match_xp + $3 WHERE user_id = $1 AND day = $2::date`,
    [input.userId, day, paid],
  );
  return {
    xpAwarded: paid,
    clanXp: 0,
    result: {
      eligible: true,
      mode: "reduced",
      breakdown: {
        ...reduced.breakdown,
        leftEarly: false,
        time: 0,
        feats: 0,
        subscriberPermille: PERMILLE,
      },
      before,
      after: stateOf(progress),
      levelsReached: levels,
      challenges: [],
      season: null,
      flags: [...reduced.flags, ...(input.flags ?? [])],
    },
  };
}

export interface SoloAwardInput {
  userId: string;
  gameCode: string;
  /** When the match was received: the UTC day it counts towards (the soft cap's day). Never a time the browser gave. */
  at: Date;
  verified: SoloVerified;
  env: RewardEnv;
}

/**
 * Pays a verified solo match: the completed-match and victory lines, scaled by
 * the setup multiplier, to lifetime XP ONLY. Nothing here touches the season,
 * the challenges, clan XP or the daily first-game and first-win bonuses; it still
 * counts towards the per-match cap and the daily soft cap. Exactly once per game:
 * the progress row is locked first and the ledger's unique key on (user, game)
 * refuses a second payment whatever else happens.
 */
export async function awardSoloXp(
  tx: PoolClient,
  input: SoloAwardInput,
): Promise<PlayerXpOutcome> {
  const startRow = await lockProgress(tx, input.userId);
  const before = position(startRow);
  const day = utcDay(input.at);
  await tx.query(
    `INSERT INTO xp_daily (user_id, day) VALUES ($1, $2::date) ON CONFLICT DO NOTHING`,
    [input.userId, day],
  );
  const daily = await tx.query<{ match_xp: string }>(
    `SELECT match_xp::text AS match_xp FROM xp_daily
      WHERE user_id = $1 AND day = $2::date FOR UPDATE`,
    [input.userId, day],
  );
  const solo = computeSoloXp({
    outcome: input.verified.outcome,
    short: input.verified.short,
    setup: input.verified.setup,
    earnedToday: Number(daily.rows[0].match_xp),
  });
  const paid = solo.breakdown.total;
  let progress = startRow;
  const levels: LevelUp[] = [];
  if (paid > 0) {
    const applied = await applyXp(
      tx,
      input.userId,
      progress,
      paid,
      {
        source: "match",
        refType: "game",
        refId: input.gameCode,
        rewardDay: day,
        // No season: solo XP is lifetime XP only. The ledger remembers why.
        season: null,
        seasonDelta: 0,
        reason: "solo",
      },
      input.env,
    );
    if (!applied.applied) return ineligible("duplicate");
    progress = applied.after;
    levels.push(...applied.levels);
  }
  // Counts towards the day's soft cap, but spends no daily bonus.
  await tx.query(
    `UPDATE xp_daily SET match_xp = match_xp + $3 WHERE user_id = $1 AND day = $2::date`,
    [input.userId, day, paid],
  );
  return {
    xpAwarded: paid,
    clanXp: 0,
    result: {
      eligible: true,
      mode: "solo",
      breakdown: {
        ...solo.breakdown,
        leftEarly: false,
        time: 0,
        feats: 0,
        subscriberPermille: PERMILLE,
      },
      before,
      after: stateOf(progress),
      levelsReached: levels,
      challenges: [],
      season: null,
      flags: solo.flags,
    },
  };
}

/** A stored game's reduced award for one player (see payReducedXp). */
async function awardReducedXp(
  tx: PoolClient,
  ctx: GameXpContext,
  player: GamePlayer,
  reason: ProgressionReason,
): Promise<PlayerXpOutcome> {
  const flags: string[] = [];
  if (ctx.adminSenders.size > 0) flags.push("admin_counted");
  if (reason === "eliminated") flags.push("eliminated");
  return payReducedXp(tx, {
    userId: player.userId,
    gameCode: ctx.gameCode,
    at: ctx.endedAt,
    reason,
    eliminations: validEliminations(ctx.record, player.clientID),
    flags,
    env: ctx.env,
  });
}

/**
 * What one player's part in a finished game is worth, written on the caller's
 * transaction. Returns what to store on their `game_players` row. A game that
 * does not count, or a player who does not qualify, gets a stored reason and
 * no XP.
 */
export async function awardPlayerXp(
  tx: PoolClient,
  ctx: GameXpContext,
  gameId: string,
  player: GamePlayer,
): Promise<PlayerXpOutcome> {
  // A solo match is paid by awardSoloXp, from the verified intake only.
  if (ctx.eligibility.mode === "none" || ctx.eligibility.mode === "solo") {
    return ineligible(ctx.eligibility.reason);
  }
  // A reduced award paid when the player was eliminated (earlyXp.ts) is their
  // award for this game: told here, never paid again.
  if (player.kind !== "guest") {
    const early = await earlyAwardOf(tx, player.userId, ctx.gameCode);
    if (early !== null) return adopted(early);
  }
  const reason = playerIneligibleReason(ctx, player);
  if (reason !== null) return ineligible(reason);
  // A reduced game, and a death in any game: lifetime XP only, secured at the
  // death, whatever happened to the rest of the match.
  const eliminated =
    playerStanding(ctx.record, player.clientID) === "eliminated";
  if (ctx.eligibility.mode === "reduced" || eliminated) {
    return awardReducedXp(tx, ctx, player, reducedReasonFor(ctx.eligibility));
  }

  const startRow = await lockProgress(tx, player.userId);
  const before = position(startRow);
  const day = utcDay(ctx.endedAt);

  await tx.query(
    `INSERT INTO xp_daily (user_id, day) VALUES ($1, $2::date) ON CONFLICT DO NOTHING`,
    [player.userId, day],
  );
  const daily = await tx.query<{
    match_xp: string;
    first_game_ref: string | null;
    first_win_ref: string | null;
  }>(
    `SELECT match_xp::text AS match_xp, first_game_ref, first_win_ref
       FROM xp_daily WHERE user_id = $1 AND day = $2::date FOR UPDATE`,
    [player.userId, day],
  );

  const victory =
    resultFor(player.clientID, ctx.record.info.winner) === "victory";
  const place = ctx.placement.placeOf?.get(player.clientID) ?? null;
  const eliminations = validEliminations(ctx.record, player.clientID);
  const shared = await sharedPriorGames(tx, ctx, gameId, player);

  const match = computeMatchXp({
    victory,
    place,
    humans: ctx.placement.humans,
    eliminations,
    eligibleHumans: ctx.eligible.length,
    repeatPermille: repeatPermille(shared),
    firstGameAvailable: daily.rows[0].first_game_ref === null,
    firstWinAvailable: daily.rows[0].first_win_ref === null,
    earnedToday: Number(daily.rows[0].match_xp),
  });
  const flags = [...match.flags];
  if (ctx.adminSenders.size > 0) flags.push("admin_counted");

  const state = { progress: startRow, levels: [] as LevelUp[], seasonXp: 0 };
  let seasonAdded = 0;
  const paid = match.breakdown.total;
  if (paid > 0) {
    const applied = await applyXp(
      tx,
      player.userId,
      state.progress,
      paid,
      {
        source: "match",
        refType: "game",
        refId: ctx.gameCode,
        rewardDay: day,
        season: ctx.season,
        seasonDelta: paid,
      },
      ctx.env,
    );
    if (!applied.applied) return ineligible("duplicate");
    state.progress = applied.after;
    state.levels.push(...applied.levels);
    if (applied.season !== null) {
      state.seasonXp = applied.season.after;
      seasonAdded = paid;
    }
  }
  await tx.query(
    `UPDATE xp_daily
        SET match_xp = match_xp + $3,
            first_game_ref = CASE WHEN $4::boolean THEN $6 ELSE first_game_ref END,
            first_win_ref = CASE WHEN $5::boolean THEN $6 ELSE first_win_ref END
      WHERE user_id = $1 AND day = $2::date`,
    [
      player.userId,
      day,
      paid,
      match.usedFirstGame,
      match.usedFirstWin,
      ctx.gameCode,
    ],
  );

  const challenges = await progressChallenges(
    tx,
    ctx,
    gameId,
    player,
    gameMetrics(ctx, player, victory, place, eliminations),
    state,
  );
  const challengeXp = challenges.reduce((sum, c) => sum + c.xp, 0);
  if (ctx.season !== null && state.seasonXp === 0) {
    // No XP reached the season row this game (0 paid, no challenge): read it for the summary.
    const { rows } = await tx.query<{ xp: string }>(
      "SELECT xp::text AS xp FROM user_season_progress WHERE season_id = $1 AND user_id = $2",
      [ctx.season.id, player.userId],
    );
    state.seasonXp = rows.length === 0 ? 0 : Number(rows[0].xp);
  }

  return {
    xpAwarded: paid,
    clanXp:
      player.clanId === null
        ? 0
        : Math.floor((paid * PROGRESSION.clanXpPermille) / PERMILLE),
    result: {
      eligible: true,
      mode: "full",
      breakdown: {
        ...match.breakdown,
        leftEarly: false,
        time: 0,
        feats: 0,
        subscriberPermille: PERMILLE,
      },
      before,
      after: stateOf(state.progress),
      levelsReached: state.levels,
      challenges,
      season:
        ctx.season === null
          ? null
          : {
              number: ctx.season.number,
              name: ctx.season.name,
              xp: state.seasonXp,
              level: seasonLevel(state.seasonXp),
              added: seasonAdded + challengeXp,
            },
      flags,
    },
  };
}

/** What the game came to for each account holder in a record (the one rule Credits, the clan threshold and XP share). */
export function outcomesByClient(
  record: Pick<GameRecord, "info" | "turns">,
  clientIds: readonly string[],
  counted: boolean,
): Map<string, PlayerProgressionOutcome> {
  return new Map(
    clientIds.map(
      (id) => [id, playerProgressionOutcome(record, id, counted)] as const,
    ),
  );
}

/** Whether each account holder in a record completed the game. */
export function completedByClient(
  outcomes: ReadonlyMap<string, PlayerProgressionOutcome>,
): Map<string, boolean> {
  return new Map(
    [...outcomes].map(([id, outcome]) => [id, isCompletedOutcome(outcome)]),
  );
}
