import { createHash } from "node:crypto";

/**
 * Daily and weekly challenges. Nothing about an assignment is stored: which
 * challenge a player has in a slot is a pure function of (user, period, slot,
 * POOL_VERSION), so there are no rows until there is progress to record.
 *
 * Periods are UTC: a day is `d:YYYY-MM-DD`, a week is the ISO week starting
 * Monday 00:00 UTC, `w:YYYY-Www`. A game counts for the period its END falls in.
 *
 * Every metric is achievable on every map and mode (no water-only or clan
 * challenges), and only games that earned XP progress a challenge.
 */

export type ChallengePeriod = "daily" | "weekly";

export type ChallengeMetric =
  /** Games finished (eligible games). */
  | "games"
  /** FFA finishes in the top half / top quarter. */
  | "top_half"
  | "top_quarter"
  | "wins"
  | "eliminations"
  /** The longest time in one game, in seconds. */
  | "survive_seconds"
  | "structures"
  /** The most gold earned in one game. */
  | "gold_single_game"
  | "alliances"
  /** Different maps played in the period (counted from stored games). */
  | "distinct_maps";

export interface ChallengeDef {
  id: string;
  period: ChallengePeriod;
  slot: 0 | 1 | 2;
  metric: ChallengeMetric;
  target: number;
  xp: number;
  /** Credits paid when completed (weekly only); claimed through the rewards UI. */
  credits: number;
}

/** Bump together with a change to any pool, between periods, so assignments never shift mid-period. */
export const POOL_VERSION = 1;

const d = (
  id: string,
  slot: 0 | 1 | 2,
  metric: ChallengeMetric,
  target: number,
  xp: number,
): ChallengeDef => ({
  id,
  period: "daily",
  slot,
  metric,
  target,
  xp,
  credits: 0,
});

const w = (
  id: string,
  slot: 0 | 1 | 2,
  metric: ChallengeMetric,
  target: number,
  xp: number,
  credits: number,
): ChallengeDef => ({
  id,
  period: "weekly",
  slot,
  metric,
  target,
  xp,
  credits,
});

export const DAILY_POOLS: readonly (readonly ChallengeDef[])[] = [
  [d("d_games_2", 0, "games", 2, 200), d("d_games_3", 0, "games", 3, 300)],
  [
    d("d_top_half_2", 1, "top_half", 2, 250),
    d("d_top_quarter_1", 1, "top_quarter", 1, 250),
    d("d_win_1", 1, "wins", 1, 400),
  ],
  [
    d("d_elim_1", 2, "eliminations", 1, 250),
    d("d_survive_15m", 2, "survive_seconds", 900, 200),
    d("d_build_10", 2, "structures", 10, 200),
    d("d_gold_500k", 2, "gold_single_game", 500_000, 200),
  ],
];

export const WEEKLY_POOLS: readonly (readonly ChallengeDef[])[] = [
  [
    w("w_games_15", 0, "games", 15, 1_500, 100),
    w("w_games_10", 0, "games", 10, 1_000, 75),
  ],
  [
    w("w_wins_5", 1, "wins", 5, 2_000, 150),
    w("w_top_quarter_10", 1, "top_quarter", 10, 1_500, 100),
    w("w_top_half_15", 1, "top_half", 15, 1_500, 100),
  ],
  [
    w("w_elim_10", 2, "eliminations", 10, 1_500, 100),
    w("w_maps_5", 2, "distinct_maps", 5, 1_200, 75),
    w("w_alliances_10", 2, "alliances", 10, 1_200, 75),
  ],
];

const ALL: ReadonlyMap<string, ChallengeDef> = new Map(
  [...DAILY_POOLS, ...WEEKLY_POOLS].flat().map((c) => [c.id, c]),
);

export function challengeById(id: string): ChallengeDef | null {
  return ALL.get(id) ?? null;
}

/** Whether progress is the best single value (true) or a running total (false). */
export function isBestOf(metric: ChallengeMetric): boolean {
  return metric === "survive_seconds" || metric === "gold_single_game";
}

// ------------------------------------------------------------------ periods

const pad = (n: number, width = 2) => String(n).padStart(width, "0");

/** `d:YYYY-MM-DD` for the UTC day containing `at`. */
export function dailyKey(at: Date): string {
  return `d:${at.getUTCFullYear()}-${pad(at.getUTCMonth() + 1)}-${pad(at.getUTCDate())}`;
}

/** The ISO week (year and number) containing `at`, in UTC. */
function isoWeek(at: Date): { year: number; week: number } {
  const day = new Date(
    Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()),
  );
  // The Thursday of this week decides the ISO year.
  const weekday = day.getUTCDay() === 0 ? 7 : day.getUTCDay();
  day.setUTCDate(day.getUTCDate() + 4 - weekday);
  const yearStart = Date.UTC(day.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((day.getTime() - yearStart) / 86_400_000 + 1) / 7);
  return { year: day.getUTCFullYear(), week };
}

/** `w:YYYY-Www` for the ISO week containing `at`. */
export function weeklyKey(at: Date): string {
  const { year, week } = isoWeek(at);
  return `w:${year}-W${pad(week)}`;
}

/** The first instant after the UTC day containing `at`. */
export function dailyResetsAt(at: Date): Date {
  return new Date(
    Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate() + 1),
  );
}

/** The first instant after the ISO week containing `at` (the next Monday 00:00 UTC). */
export function weeklyResetsAt(at: Date): Date {
  const weekday = at.getUTCDay() === 0 ? 7 : at.getUTCDay();
  return new Date(
    Date.UTC(
      at.getUTCFullYear(),
      at.getUTCMonth(),
      at.getUTCDate() + (8 - weekday),
    ),
  );
}

/** The UTC start and end of the ISO week named by a `w:` key. */
export function weekRange(key: string): { from: Date; to: Date } | null {
  const m = /^w:(\d{4})-W(\d{2})$/.exec(key);
  if (m === null) return null;
  const year = Number(m[1]);
  const week = Number(m[2]);
  // January 4th is always in week 1.
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const weekday = jan4.getUTCDay() === 0 ? 7 : jan4.getUTCDay();
  const from = new Date(Date.UTC(year, 0, 4 - (weekday - 1) + (week - 1) * 7));
  return { from, to: new Date(from.getTime() + 7 * 86_400_000) };
}

// --------------------------------------------------------------- assignment

/** The challenge a player has in `slot` for a period: a pure function of the arguments. */
export function assignedChallenge(
  userId: string,
  periodKey: string,
  pool: readonly ChallengeDef[],
  slot: number,
): ChallengeDef {
  const hash = createHash("sha256")
    .update(`${userId}|${periodKey}|${slot}|${POOL_VERSION}`)
    .digest();
  return pool[hash.readUInt32BE(0) % pool.length];
}

/** The three challenges a player has for a period. */
export function challengesFor(
  userId: string,
  period: ChallengePeriod,
  periodKey: string,
): ChallengeDef[] {
  const pools = period === "daily" ? DAILY_POOLS : WEEKLY_POOLS;
  return pools.map((pool, slot) =>
    assignedChallenge(userId, periodKey, pool, slot),
  );
}

// ------------------------------------------------------------ progress maths

/** What one game adds to each metric (distinct_maps is counted from stored games instead). */
export type GameMetrics = Record<
  Exclude<ChallengeMetric, "distinct_maps">,
  number
>;

/** The new progress for a challenge after a game: capped at the target, never going down. */
export function advance(
  def: ChallengeDef,
  current: number,
  metrics: GameMetrics,
  distinctMaps: number,
): number {
  let next: number;
  if (def.metric === "distinct_maps") next = distinctMaps;
  else if (isBestOf(def.metric)) next = Math.max(current, metrics[def.metric]);
  else next = current + metrics[def.metric];
  return Math.min(def.target, Math.max(current, next));
}
