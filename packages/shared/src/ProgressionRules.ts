/**
 * DeltaFront progression: the rules both the account API and the client rely
 * on, in one pure module (no I/O, no dates, whole-number arithmetic only).
 *
 *  - Lifetime XP never resets. Run XP is the XP of the current prestige run:
 *    it resets to 0 on prestige. Level and rank are DERIVED from run XP and
 *    never stored.
 *  - Levels are 1..100, prestige is 0..10, and level 100 at prestige 10 is
 *    "Legend" (no further prestige).
 *  - Ranks are display only. Nothing here gives any gameplay power.
 *
 * The numbers that tune how XP is EARNED (match lines, multipliers, caps)
 * live in the account API's constants, not here: the client never computes XP.
 */

export const MAX_LEVEL = 100;
export const MAX_PRESTIGE = 10;

/** XP needed to go from `level` to `level + 1` (0 at the last level). */
export function xpToNext(level: number): number {
  if (!Number.isInteger(level) || level < 1 || level >= MAX_LEVEL) return 0;
  const n = level - 1;
  // round((10000 + 1500n + 7n²) / 200) * 10, with the rounding done on integers
  return Math.floor((10_000 + 1_500 * n + 7 * n * n + 100) / 200) * 10;
}

/** CUMULATIVE[level] = run XP at which `level` is reached (index 0 unused). */
const CUMULATIVE: readonly number[] = (() => {
  const out = [0, 0];
  for (let level = 1; level < MAX_LEVEL; level++) {
    out.push(out[level] + xpToNext(level));
  }
  return out;
})();

/** Run XP needed to reach `level` (level 1 is 0). */
export function xpForLevel(level: number): number {
  const clamped = Math.min(MAX_LEVEL, Math.max(1, Math.floor(level)));
  return CUMULATIVE[clamped];
}

/** Run XP at level 100: a run never holds more. */
export const MAX_RUN_XP = CUMULATIVE[MAX_LEVEL];

/** Run XP clamped to what a run can hold. */
export function clampRunXp(runXp: number): number {
  if (!Number.isFinite(runXp) || runXp < 0) return 0;
  return Math.min(MAX_RUN_XP, Math.floor(runXp));
}

/** The level a run XP total is at (1..100). */
export function levelFromRunXp(runXp: number): number {
  const xp = clampRunXp(runXp);
  // Binary search over the cumulative table: the highest level whose threshold <= xp.
  let lo = 1;
  let hi = MAX_LEVEL;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (CUMULATIVE[mid] <= xp) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

export interface RunProgress {
  level: number;
  /** XP into the current level; 0 at level 100. */
  xpInLevel: number;
  /** XP needed for the next level; 0 at level 100. */
  xpForNext: number;
}

export function runProgress(runXp: number): RunProgress {
  const xp = clampRunXp(runXp);
  const level = levelFromRunXp(xp);
  if (level >= MAX_LEVEL) return { level, xpInLevel: 0, xpForNext: 0 };
  return {
    level,
    xpInLevel: xp - CUMULATIVE[level],
    xpForNext: xpToNext(level),
  };
}

/** The levels crossed going from one run XP total to a higher one, in order. */
export function levelsBetween(fromRunXp: number, toRunXp: number): number[] {
  const from = levelFromRunXp(fromRunXp);
  const to = levelFromRunXp(toRunXp);
  const out: number[] = [];
  for (let level = from + 1; level <= to; level++) out.push(level);
  return out;
}

/** Everything the account/profile surfaces need about one player's progression. */
export interface ProgressState {
  prestige: number;
  level: number;
  xpInLevel: number;
  xpForNext: number;
  lifetimeXp: number;
  legend: boolean;
  canPrestige: boolean;
}

export function isLegend(prestige: number, level: number): boolean {
  return prestige >= MAX_PRESTIGE && level >= MAX_LEVEL;
}

export function canPrestige(prestige: number, level: number): boolean {
  return level >= MAX_LEVEL && prestige < MAX_PRESTIGE;
}

export function progressState(input: {
  runXp: number;
  lifetimeXp: number;
  prestige: number;
}): ProgressState {
  const run = runProgress(input.runXp);
  return {
    prestige: input.prestige,
    level: run.level,
    xpInLevel: run.xpInLevel,
    xpForNext: run.xpForNext,
    lifetimeXp: input.lifetimeXp,
    legend: isLegend(input.prestige, run.level),
    canPrestige: canPrestige(input.prestige, run.level),
  };
}

// ---------------------------------------------------------------- ranks

export const RANK_KEYS = [
  "recruit",
  "private",
  "corporal",
  "sergeant",
  "lieutenant",
  "captain",
  "major",
  "colonel",
  "general",
  "supreme_commander",
] as const;
export type RankKey = (typeof RANK_KEYS)[number];

/** The first level of each rank, in order. */
export const RANKS: ReadonlyArray<{ key: RankKey; fromLevel: number }> = [
  { key: "recruit", fromLevel: 1 },
  { key: "private", fromLevel: 10 },
  { key: "corporal", fromLevel: 20 },
  { key: "sergeant", fromLevel: 30 },
  { key: "lieutenant", fromLevel: 40 },
  { key: "captain", fromLevel: 50 },
  { key: "major", fromLevel: 60 },
  { key: "colonel", fromLevel: 75 },
  { key: "general", fromLevel: 90 },
  { key: "supreme_commander", fromLevel: 100 },
];

/** The military rank of a level. Display only. */
export function rankForLevel(level: number): RankKey {
  const clamped = Math.min(MAX_LEVEL, Math.max(1, Math.floor(level) || 1));
  let key: RankKey = RANKS[0].key;
  for (const rank of RANKS) {
    if (clamped >= rank.fromLevel) key = rank.key;
  }
  return key;
}

// ------------------------------------------------------------ milestones

/** A reward for reaching a level in a prestige run. Credits repeat every run; the cosmetic and the title are given once. */
export interface LevelMilestone {
  level: number;
  credits: number;
  /** A catalog flare (never sold), or null. */
  flare: string | null;
  /** A title this milestone makes available, or null. */
  title: string | null;
}

export const LEVEL_MILESTONES: readonly LevelMilestone[] = [
  { level: 5, credits: 250, flare: null, title: null },
  { level: 10, credits: 500, flare: "flag:recruit_banner", title: null },
  { level: 25, credits: 750, flare: null, title: "veteran" },
  {
    level: 50,
    credits: 1_000,
    flare: "pattern:officer_chevrons:ash",
    title: "elite",
  },
  { level: 75, credits: 1_500, flare: "effect:colonel_wake", title: null },
  { level: 100, credits: 2_500, flare: null, title: "supreme_commander" },
];

export const MILESTONE_LEVELS: readonly number[] = LEVEL_MILESTONES.map(
  (m) => m.level,
);

export function milestoneAt(level: number): LevelMilestone | null {
  return LEVEL_MILESTONES.find((m) => m.level === level) ?? null;
}

/** Credits for entering a new prestige rank. */
export const PRESTIGE_CREDITS = 1_000;

// ---------------------------------------------------------------- seasons

export const SEASON_MAX_LEVEL = 50;
export const SEASON_XP_PER_LEVEL = 2_000;

/** The season level (1..50) a season XP total is at. XP past level 50 only ranks. */
export function seasonLevel(seasonXp: number): number {
  const xp = Number.isFinite(seasonXp) ? Math.max(0, Math.floor(seasonXp)) : 0;
  return Math.min(SEASON_MAX_LEVEL, 1 + Math.floor(xp / SEASON_XP_PER_LEVEL));
}

/** Season XP needed to reach `level`. */
export function seasonXpForLevel(level: number): number {
  const clamped = Math.min(SEASON_MAX_LEVEL, Math.max(1, Math.floor(level)));
  return (clamped - 1) * SEASON_XP_PER_LEVEL;
}

export interface SeasonTrackReward {
  level: number;
  credits: number;
  /** A title id fragment ("veteran" / "elite") given with this level, or null. */
  title: "veteran" | "elite" | null;
  /** Whether the season's own cosmetic (Season.rewardFlares[level]) is given here. */
  cosmetic: boolean;
}

/** The free track, the same every season apart from the season's own cosmetic. */
export const SEASON_TRACK: readonly SeasonTrackReward[] = [
  { level: 5, credits: 100, title: null, cosmetic: false },
  { level: 10, credits: 150, title: null, cosmetic: false },
  { level: 15, credits: 150, title: null, cosmetic: false },
  { level: 20, credits: 200, title: null, cosmetic: false },
  { level: 25, credits: 250, title: "veteran", cosmetic: false },
  { level: 30, credits: 250, title: null, cosmetic: false },
  { level: 35, credits: 300, title: null, cosmetic: false },
  { level: 40, credits: 300, title: null, cosmetic: true },
  { level: 45, credits: 400, title: null, cosmetic: false },
  { level: 50, credits: 500, title: "elite", cosmetic: false },
];

/** The track rewards crossed going from one season XP total to a higher one. */
export function trackRewardsBetween(
  fromXp: number,
  toXp: number,
): SeasonTrackReward[] {
  const from = seasonLevel(fromXp);
  const to = seasonLevel(toXp);
  return SEASON_TRACK.filter((r) => r.level > from && r.level <= to);
}

// ----------------------------------------------------------------- titles

/**
 * Title ids. A title is a collectible, separate from the military rank:
 *   veteran | elite | supreme_commander | conqueror | legend
 *   prestige:<1..10>
 *   season_veteran:<season number> | season_elite:<season number>
 */
export const SIMPLE_TITLES = [
  "veteran",
  "elite",
  "supreme_commander",
  "conqueror",
  "legend",
] as const;

/** Counted public wins that earn "Conqueror". */
export const CONQUEROR_WINS = 100;

const TITLE_PATTERN =
  /^(?:veteran|elite|supreme_commander|conqueror|legend|prestige:(?:[1-9]|10)|season_(?:veteran|elite):[1-9]\d{0,5})$/;

export function isTitleId(value: unknown): value is string {
  return typeof value === "string" && TITLE_PATTERN.test(value);
}

/**
 * Titles a player holds, from facts the API already has. Computed, never
 * stored, so an admin XP correction can take a title away again.
 */
export function earnedTitles(input: {
  prestige: number;
  level: number;
  countedWins: number;
  seasons: ReadonlyArray<{ number: number; xp: number }>;
}): string[] {
  const out: string[] = [];
  // Having prestiged means level 100 was reached.
  const reached = input.prestige > 0 ? MAX_LEVEL : input.level;
  if (reached >= 25) out.push("veteran");
  if (reached >= 50) out.push("elite");
  if (reached >= MAX_LEVEL) out.push("supreme_commander");
  if (input.countedWins >= CONQUEROR_WINS) out.push("conqueror");
  for (let p = 1; p <= Math.min(MAX_PRESTIGE, input.prestige); p++) {
    out.push(`prestige:${p}`);
  }
  if (isLegend(input.prestige, input.level)) out.push("legend");
  for (const season of input.seasons) {
    const level = seasonLevel(season.xp);
    if (level >= 25) out.push(`season_veteran:${season.number}`);
    if (level >= 50) out.push(`season_elite:${season.number}`);
  }
  return out;
}
