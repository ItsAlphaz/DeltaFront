import { GameType } from "@openfront/engine-api/game/GameTypes";
import type { XpBreakdown } from "@openfront/shared/ApiSchemas";
import { rankForLevel, type RankKey } from "@openfront/shared/ProgressionRules";

// Pure helpers behind the level / XP UI. No DOM, no fetches — so the rules the
// components follow are unit-testable on their own.

// The badge art is cut for a 100-level track with 10 prestige ranks (see
// levelBand, prestigeTier), so the caps stay client constants: raising either
// on the server needs new art, not only a new number. A rank past
// MAX_PRESTIGE still shows its own number, drawn with the last rank's art.
export const MAX_LEVEL = 100;
export const MAX_PRESTIGE = 10;

/**
 * The level band a badge frame is drawn from: 0 for levels 1–9, 1 for 10–19,
 * … 9 for 90–99, and 10 for level 100 alone. Out-of-range input is clamped so
 * a surprising server value still draws a frame.
 */
export function levelBand(level: number): number {
  if (!Number.isFinite(level)) return 0;
  const clamped = Math.min(MAX_LEVEL, Math.max(1, Math.floor(level)));
  if (clamped >= MAX_LEVEL) return 10;
  return Math.floor(clamped / 10);
}

/**
 * The prestige rank to show: whole and never negative, but not capped at
 * MAX_PRESTIGE, so a badge agrees with a server that has more ranks.
 */
export function clampPrestige(prestige: number): number {
  if (!Number.isFinite(prestige)) return 0;
  return Math.max(0, Math.floor(prestige));
}

/**
 * The prestige emblem drawn around a badge. Each tier is a different SHAPE,
 * not just a colour (colour-blind players): a ring, a double ring, a
 * sunburst, and a denser glowing burst for the last rank.
 */
export type PrestigeTier = "none" | "ring" | "double" | "sunburst" | "radiant";

export function prestigeTier(prestige: number): PrestigeTier {
  const p = clampPrestige(prestige);
  if (p === 0) return "none";
  if (p <= 3) return "ring";
  if (p <= 6) return "double";
  if (p <= 9) return "sunburst";
  return "radiant";
}

// Levels called out when reached: the end-of-game XP panel gives one reached
// this game its own "new milestone" card (100 is the Legend card at the last
// prestige). Must match the server's milestone list, which dates them on the
// profile.
export const MILESTONE_LEVELS: readonly number[] = [5, 10, 25, 50, 75, 100];

export function isMilestoneLevel(level: number): boolean {
  return MILESTONE_LEVELS.includes(level);
}

interface LevelReachedLike {
  prestige: number;
  level: number;
}

/**
 * The levels one game crossed, for the level-up celebration. A game never
 * changes prestige (that is an opt-in reset, done from the profile), so an
 * entry at another prestige is dropped rather than celebrated as a level-up.
 */
export function levelsReachedInGame(data: {
  before: { prestige: number };
  levelsReached: readonly LevelReachedLike[];
}): LevelReachedLike[] {
  return data.levelsReached.filter((l) => l.prestige === data.before.prestige);
}

/** True when this game is the one that made the player a Legend. */
export function reachedLegendThisGame(data: {
  before: { prestige: number };
  after: { legend: boolean };
  levelsReached: readonly LevelReachedLike[];
}): boolean {
  return (
    data.after.legend &&
    levelsReachedInGame(data).some((l) => l.level === MAX_LEVEL)
  );
}

/**
 * How far through the current level, 0..1. A level with nothing left to earn
 * (level 100, `xpForNext` 0) reads as full.
 */
export function levelFraction(xpInLevel: number, xpForNext: number): number {
  if (!(xpForNext > 0)) return 1;
  const fraction = xpInLevel / xpForNext;
  if (!Number.isFinite(fraction)) return 0;
  return Math.min(1, Math.max(0, fraction));
}

export type SubscriberTier = "sovereign" | "warlord" | "vanguard";

// The subscription tiers' XP boosts, highest first, in their Discord role
// colours (a gradient, from → to). The game is told only the multiplier, so
// the tier is recognised by it: these must match the multipliers set on the
// tiers in the admin panel. A multiplier not listed here still shows, as a
// plain subscriber bonus.
export const SUBSCRIBER_TIERS: readonly {
  tier: SubscriberTier;
  permille: number;
  colors: readonly [string, string];
}[] = [
  { tier: "sovereign", permille: 2000, colors: ["#ffc713", "#ffde90"] },
  { tier: "warlord", permille: 1500, colors: ["#4cadd0", "#b2f9ff"] },
  { tier: "vanguard", permille: 1250, colors: ["#369876", "#71ff9e"] },
];

/** The subscription tier a subscriber multiplier belongs to, if it's one. */
export function subscriberTierOf(permille: number) {
  return SUBSCRIBER_TIERS.find((t) => t.permille === permille) ?? null;
}

/** A permille multiplier as a percentage change: 1200 → 20, 500 → -50. */
export function multiplierPercent(permille: number): number {
  return Math.round(permille - 1000) / 10;
}

type XpSourceKey =
  | "played"
  | "time"
  | "placement"
  | "win"
  | "eliminations"
  | "firstGame"
  | "firstWin"
  | "feats";

// "other" is XP in the subtotal that no known source accounts for: a source
// this client doesn't know, or one stored under an older name.
export type XpLineKey = XpSourceKey | "other";

export const XP_LINE_KEYS: readonly XpSourceKey[] = [
  "played",
  "time",
  "placement",
  "win",
  "eliminations",
  "firstGame",
  "firstWin",
  "feats",
];

// Each breakdown line's label.
export const XP_LINE_LABEL_KEYS: Record<XpLineKey, string> = {
  played: "progression.line_played",
  time: "progression.line_time",
  placement: "progression.line_placement",
  win: "progression.line_win",
  eliminations: "progression.line_eliminations",
  firstGame: "progression.line_first_game",
  firstWin: "progression.line_first_win",
  feats: "progression.line_feats",
  other: "progression.line_other",
};

/**
 * The breakdown lines worth showing: the non-zero ones, in a fixed order, then
 * whatever of the subtotal they leave unaccounted for, so the lines add up to
 * the subtotal and no line is credited with XP another source earned.
 */
export function visibleXpLines(
  breakdown: XpBreakdown,
): { key: XpLineKey; amount: number }[] {
  const lines: { key: XpLineKey; amount: number }[] = XP_LINE_KEYS.map(
    (key) => ({ key, amount: breakdown[key] }),
  ).filter((line) => line.amount !== 0);
  const other = breakdown.subtotal - lines.reduce((a, l) => a + l.amount, 0);
  if (other > 0) lines.push({ key: "other", amount: other });
  return lines;
}

export type XpMultiplierKey = "game" | "subscriber" | "repeat";

/**
 * The multipliers worth showing: anything other than 1x. "game" is the
 * player-count multiplier, "repeat" the repeated-opponents one.
 */
export function visibleMultipliers(
  breakdown: XpBreakdown,
): { key: XpMultiplierKey; permille: number }[] {
  const out: { key: XpMultiplierKey; permille: number }[] = [];
  if (breakdown.gamePermille !== 1000) {
    out.push({ key: "game", permille: breakdown.gamePermille });
  }
  if (breakdown.repeatPermille !== 1000) {
    out.push({ key: "repeat", permille: breakdown.repeatPermille });
  }
  if (breakdown.subscriberPermille !== 1000) {
    out.push({ key: "subscriber", permille: breakdown.subscriberPermille });
  }
  return out;
}

/**
 * The multipliers worth showing, each with the XP it added (negative for a
 * cut), so that the sources and these lines add up to the total — or null
 * where that can't be known.
 *
 * The API applies both multipliers in one step and rounds once:
 * total = round(subtotal × game × subscriber). With one multiplier in play,
 * what it added is exactly total − subtotal. With both, how much each added
 * depends on which is applied first, and the breakdown doesn't say — so
 * neither line gets an amount rather than one that might be wrong.
 */
export function multiplierAmounts(
  breakdown: XpBreakdown,
): { key: XpMultiplierKey; permille: number; amount: number | null }[] {
  const multipliers = visibleMultipliers(breakdown);
  // A cap changes the total beyond what the multiplier did, so no line is
  // credited with an amount that would not add up.
  const exact =
    multipliers.length === 1 && !breakdown.capped && !breakdown.softCapped;
  return multipliers.map((m) => ({
    ...m,
    amount: exact ? breakdown.total - breakdown.subtotal : null,
  }));
}

/**
 * Splits `total` across `amounts` in proportion, as whole numbers that add up
 * to exactly `total` (largest remainder). It is how the breakdown shows each
 * source's share of a multiplied award without the cards disagreeing with the
 * total.
 */
export function apportionXp(
  amounts: readonly number[],
  total: number,
): number[] {
  const sum = amounts.reduce((a, b) => a + Math.max(0, b), 0);
  if (sum <= 0 || total <= 0) return amounts.map(() => 0);
  const raw = amounts.map((a) => (Math.max(0, a) * total) / sum);
  const out = raw.map((r) => Math.floor(r));
  let left = total - out.reduce((a, b) => a + b, 0);
  const order = raw
    .map((r, i) => ({ i, frac: r - out[i] }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (const { i } of order) {
    if (left <= 0) break;
    out[i]++;
    left--;
  }
  return out;
}

// The ineligibility reason for a game played before player levels existed.
export const BEFORE_PROGRESSION = "before_progression";

// Ineligibility reasons with their own copy. Anything else — including reasons
// the API adds later — gets the generic line. Keys spelled out in full so the
// translation checks can see them.
const INELIGIBLE_REASON_KEYS: Record<string, string> = {
  not_spawned: "progression.ineligible_not_spawned",
  too_short: "progression.ineligible_too_short",
  no_action: "progression.ineligible_no_action",
  custom_settings: "progression.ineligible_custom_settings",
  too_few_humans: "progression.ineligible_too_few_humans",
  daily_cap: "progression.ineligible_daily_cap",
  private_game: "progression.ineligible_private_game",
  ranked: "progression.ineligible_ranked",
  admin_modified: "progression.ineligible_admin_modified",
  left_early: "progression.ineligible_left_early",
  eliminated_early: "progression.ineligible_eliminated_early",
  no_winner: "progression.ineligible_no_winner",
  admin_actor: "progression.ineligible_admin_actor",
  guest: "progression.ineligible_guest",
  duplicate: "progression.ineligible_generic",
  // The game's stats were not agreed on by the players' votes.
  unverified: "progression.ineligible_unverified",
  // Played before player levels launched: never scored.
  [BEFORE_PROGRESSION]: "progression.xp_before_levels",
};

// A singleplayer game never carries the end-of-game vote, so the server
// always marks it unverified: callers that know the game's type pass it, and
// it gets its own line instead.
export function ineligibleReasonKey(
  reason: string,
  gameType?: GameType | null,
): string {
  if (reason === "unverified" && gameType === GameType.Singleplayer) {
    return "progression.ineligible_singleplayer";
  }
  return Object.prototype.hasOwnProperty.call(INELIGIBLE_REASON_KEYS, reason)
    ? INELIGIBLE_REASON_KEYS[reason]
    : "progression.ineligible_generic";
}

// Reward reasons the progression system grants (RewardSchema.reason).
const LEVEL_REWARD_REASON_KEYS: Record<string, string> = {
  level_up: "account_modal.reward_level_up",
  level_milestone: "account_modal.reward_level_milestone",
  prestige: "account_modal.reward_prestige",
  season_track: "account_modal.reward_season_track",
  challenge: "account_modal.reward_challenge",
};

export function levelRewardReasonKey(reason: string): string | undefined {
  return Object.prototype.hasOwnProperty.call(LEVEL_REWARD_REASON_KEYS, reason)
    ? LEVEL_REWARD_REASON_KEYS[reason]
    : undefined;
}

// Military ranks (display only). The key is the shared rule's; the label is
// translated here.
const RANK_LABEL_KEYS: Record<RankKey, string> = {
  recruit: "progression.rank_recruit",
  private: "progression.rank_private",
  corporal: "progression.rank_corporal",
  sergeant: "progression.rank_sergeant",
  lieutenant: "progression.rank_lieutenant",
  captain: "progression.rank_captain",
  major: "progression.rank_major",
  colonel: "progression.rank_colonel",
  general: "progression.rank_general",
  supreme_commander: "progression.rank_supreme_commander",
};

export function rankLabelKey(level: number): string {
  return RANK_LABEL_KEYS[rankForLevel(level)];
}

/**
 * The rank change a game caused: the ranks before and after and the level the
 * new one starts at, or null if the rank is the same. A rank only ever goes up
 * within one prestige run.
 */
export function promotionInGame(data: {
  before: { level: number };
  after: { level: number };
  levelsReached: readonly { level: number }[];
}): { from: RankKey; to: RankKey; atLevel: number } | null {
  const from = rankForLevel(data.before.level);
  const to = rankForLevel(data.after.level);
  if (from === to) return null;
  const crossed = data.levelsReached
    .map((l) => l.level)
    .find((level) => rankForLevel(level) === to);
  return { from, to, atLevel: crossed ?? data.after.level };
}

// Title ids -> translation (a title is a collectible, separate from the rank).
// Keys are spelled out in full so the translation checks can see them.
const TITLE_KEYS: Record<string, string> = {
  veteran: "progression.title_veteran",
  elite: "progression.title_elite",
  supreme_commander: "progression.title_supreme_commander",
  conqueror: "progression.title_conqueror",
  legend: "progression.title_legend",
};

/** A title id as text: "Veteran", "Prestige III", "Season 2 Elite". Unknown ids read as their raw name. */
export function titleText(
  id: string,
  translate: (key: string, params?: Record<string, string | number>) => string,
): string {
  if (Object.prototype.hasOwnProperty.call(TITLE_KEYS, id)) {
    return translate(TITLE_KEYS[id]);
  }
  const prestige = /^prestige:(\d+)$/.exec(id);
  if (prestige !== null) {
    return translate("progression.title_prestige", { rank: prestige[1] });
  }
  const season = /^season_(veteran|elite):(\d+)$/.exec(id);
  if (season !== null) {
    return translate(
      season[1] === "veteran"
        ? "progression.title_season_veteran"
        : "progression.title_season_elite",
      { season: season[2] },
    );
  }
  return id;
}

// Challenge ids -> translation keys, spelled out so the scanner sees them.
const CHALLENGE_KEYS: Record<string, string> = {
  d_games_2: "progression.challenge_d_games_2",
  d_games_3: "progression.challenge_d_games_3",
  d_top_half_2: "progression.challenge_d_top_half_2",
  d_top_quarter_1: "progression.challenge_d_top_quarter_1",
  d_win_1: "progression.challenge_d_win_1",
  d_elim_1: "progression.challenge_d_elim_1",
  d_survive_15m: "progression.challenge_d_survive_15m",
  d_build_10: "progression.challenge_d_build_10",
  d_gold_500k: "progression.challenge_d_gold_500k",
  w_games_15: "progression.challenge_w_games_15",
  w_games_10: "progression.challenge_w_games_10",
  w_wins_5: "progression.challenge_w_wins_5",
  w_top_quarter_10: "progression.challenge_w_top_quarter_10",
  w_top_half_15: "progression.challenge_w_top_half_15",
  w_elim_10: "progression.challenge_w_elim_10",
  w_maps_5: "progression.challenge_w_maps_5",
  w_alliances_10: "progression.challenge_w_alliances_10",
};

export function challengeLabelKey(id: string): string {
  return Object.prototype.hasOwnProperty.call(CHALLENGE_KEYS, id)
    ? CHALLENGE_KEYS[id]
    : "progression.challenge_generic";
}
