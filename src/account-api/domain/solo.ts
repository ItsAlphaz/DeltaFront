import { Difficulty } from "@openfront/engine-api/game/GameTypes";
import { PERMILLE, PROGRESSION, SOLO } from "./constants";
import { applySoftCap, type ProgressionReason } from "./xp";

/**
 * Singleplayer XP: the pure rules (docs/Progression.md, "Singleplayer"). No
 * database, no clock, and nothing here reads a client: the setup it scores is
 * what a server-side replay of the match found (domain/soloVerify.ts).
 *
 * A solo match earns the normal match lines (a completed match, and the victory),
 * multiplied by how demanding its setup was. Six criteria, each met or missed:
 *
 *   more than 30 tribes      more than 30 nations     no instant build
 *   no infinite gold         no infinite troops       difficulty above Medium
 *
 * All met is 1.00x. Each one missed takes 0.20 off, and the multiplier never goes
 * below 0.10x, so a valid solo match always earns something. It is not binary.
 *
 *   paid = floor(subtotal x reducedPermille x soloPermille / 10^6), then the per-match
 *          cap, then the daily soft cap (the same ones multiplayer XP has)
 */

export type SoloCriterionKey =
  | "tribes"
  | "nations"
  | "instant_build"
  | "infinite_gold"
  | "infinite_troops"
  | "difficulty";

/** The order the criteria are listed and shown in. */
export const SOLO_CRITERIA: readonly SoloCriterionKey[] = [
  "tribes",
  "nations",
  "instant_build",
  "infinite_gold",
  "infinite_troops",
  "difficulty",
];

/**
 * A solo match's setup, as the replay found it: the tribes and nations that were
 * really in the game, and the switches the engine really ran with.
 */
export interface SoloSetup {
  tribes: number;
  nations: number;
  instantBuild: boolean;
  infiniteGold: boolean;
  infiniteTroops: boolean;
  /** The engine's own difficulty value (never a translated label). */
  difficulty: string;
}

export interface SoloCriterionResult {
  key: SoloCriterionKey;
  met: boolean;
}

export interface SoloMultiplier {
  /** The multiplier in permille after the floor. */
  permille: number;
  /** How many criteria were missed. */
  failed: number;
  criteria: SoloCriterionResult[];
}

/** Easiest to hardest: "above Medium" is whatever comes after it. */
const DIFFICULTY_ORDER: readonly string[] = [
  Difficulty.Easy,
  Difficulty.Medium,
  Difficulty.Hard,
  Difficulty.Impossible,
];

/** Whether a difficulty is above Medium. An unknown value is not. */
export function difficultyAboveMedium(difficulty: string): boolean {
  const rank = DIFFICULTY_ORDER.indexOf(difficulty);
  return rank > DIFFICULTY_ORDER.indexOf(Difficulty.Medium);
}

/** Which of the six criteria a setup meets. */
export function soloCriteria(setup: SoloSetup): SoloCriterionResult[] {
  const met: Record<SoloCriterionKey, boolean> = {
    // "More than": exactly the minimum fails.
    tribes: setup.tribes > SOLO.minTribes,
    nations: setup.nations > SOLO.minNations,
    instant_build: !setup.instantBuild,
    infinite_gold: !setup.infiniteGold,
    infinite_troops: !setup.infiniteTroops,
    difficulty: difficultyAboveMedium(setup.difficulty),
  };
  return SOLO_CRITERIA.map((key) => ({ key, met: met[key] }));
}

/** 1.00x less 0.20x for every criterion missed, never below 0.10x. */
export function soloMultiplier(setup: SoloSetup): SoloMultiplier {
  const criteria = soloCriteria(setup);
  const failed = criteria.filter((c) => !c.met).length;
  const permille = Math.max(
    SOLO.floorPermille,
    PERMILLE - failed * SOLO.penaltyPermille,
  );
  return { permille, failed, criteria };
}

/** What a solo award stores about the setup it was scored on (it rides on the breakdown). */
export interface SoloBreakdown {
  /** The multiplier applied, in permille. */
  multiplierPermille: number;
  failed: number;
  difficulty: string;
  tribes: number;
  nations: number;
  criteria: SoloCriterionResult[];
}

export function soloBreakdown(
  setup: SoloSetup,
  multiplier: SoloMultiplier = soloMultiplier(setup),
): SoloBreakdown {
  return {
    multiplierPermille: multiplier.permille,
    failed: multiplier.failed,
    difficulty: setup.difficulty,
    tribes: setup.tribes,
    nations: setup.nations,
    criteria: multiplier.criteria,
  };
}

/**
 * How a solo match ended for the player, as the replay found it:
 *  - victory: they won;
 *  - defeat: the match was decided and they were still in it, but not the winner;
 *  - eliminated: they lost their last tile (whether or not the match went on).
 * A match with no result for a player still in it earns nothing: it is not here.
 */
export type SoloOutcome = "victory" | "defeat" | "eliminated";

export interface SoloXpInput {
  outcome: SoloOutcome;
  /** The match lasted less than the stats minimum (two minutes of game time). */
  short: boolean;
  setup: SoloSetup;
  /** Match XP already paid today (the soft cap). */
  earnedToday: number;
}

export interface SoloXpBreakdown {
  played: number;
  placement: 0;
  win: number;
  eliminations: 0;
  eliminationCount: 0;
  firstGame: 0;
  firstWin: 0;
  subtotal: number;
  /** The reduced multiplier of a short match or an elimination (1x otherwise). */
  gamePermille: number;
  repeatPermille: number;
  playerCount: 0;
  /** The solo setup multiplier. */
  soloPermille: number;
  solo: SoloBreakdown;
  capped: boolean;
  softCapped: boolean;
  /** Set when the match was reduced: why (`eliminated`, `short_game`). */
  reducedReason?: ProgressionReason;
  total: number;
}

export interface SoloXpResult {
  breakdown: SoloXpBreakdown;
  /** Review markers: solo, reduced, soft_cap, cap_hit, solo_floor. */
  flags: string[];
}

/**
 * The XP for a valid solo match. The lines are the multiplayer ones that make
 * sense with one human among tribes and nations: a completed match, and the
 * victory. There is no placement (one human), no elimination XP (only humans
 * count, and there is one), no first-game or first-win bonus and no player-count
 * or repeated-opponent factor: the setup multiplier takes the place of those.
 *
 * A match that is short, or in which the player was eliminated, is reduced the way
 * a multiplayer one is: the completed-match line only, at a quarter, no victory.
 */
export function computeSoloXp(input: SoloXpInput): SoloXpResult {
  const reducedReason: ProgressionReason | undefined = input.short
    ? "short_game"
    : input.outcome === "eliminated"
      ? "eliminated"
      : undefined;
  const played = PROGRESSION.completedMatch;
  const win =
    input.outcome === "victory" && reducedReason === undefined
      ? PROGRESSION.victory
      : 0;
  const subtotal = played + win;
  const gamePermille =
    reducedReason === undefined ? PERMILLE : PROGRESSION.reducedPermille;
  const multiplier = soloMultiplier(input.setup);
  const base = Math.floor(
    (subtotal * gamePermille * multiplier.permille) / (PERMILLE * PERMILLE),
  );
  const cappedAmount = Math.min(base, PROGRESSION.matchXpCap);
  const soft = applySoftCap(cappedAmount, input.earnedToday);

  const flags = ["solo"];
  if (reducedReason !== undefined) flags.push("reduced");
  if (base > PROGRESSION.matchXpCap) flags.push("cap_hit");
  if (soft.softCapped) flags.push("soft_cap");
  if (multiplier.failed * SOLO.penaltyPermille >= PERMILLE) {
    flags.push("solo_floor");
  }
  return {
    breakdown: {
      played,
      placement: 0,
      win,
      eliminations: 0,
      eliminationCount: 0,
      firstGame: 0,
      firstWin: 0,
      subtotal,
      gamePermille,
      repeatPermille: PERMILLE,
      playerCount: 0,
      soloPermille: multiplier.permille,
      solo: soloBreakdown(input.setup, multiplier),
      capped: base > PROGRESSION.matchXpCap,
      softCapped: soft.softCapped,
      ...(reducedReason === undefined ? {} : { reducedReason }),
      total: soft.paid,
    },
    flags,
  };
}
