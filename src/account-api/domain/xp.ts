import { GameMode, GameType } from "@openfront/engine-api/game/GameTypes";
import {
  ALLIANCE_INDEX_FORMED,
  OTHER_INDEX_BUILT,
} from "@openfront/engine-api/StatsSchemas";
import { GAMEPLAY_INTENTS } from "@openfront/shared/LiveProgress";
import type { GameRecord } from "@openfront/shared/WireSchemas";
import { ECONOMY, PERMILLE, PROGRESSION } from "./constants";
import type { SoloBreakdown } from "./solo";
import { countedVerdict, winnerClientIds, type CountedFacts } from "./stats";

/**
 * Match XP: the pure rules that turn one player's part in a counted game into
 * XP (docs/Progression.md). No database, no clock. Game-level eligibility is
 * NOT decided here: it is `countedVerdict` in stats.ts, the same rule that
 * decides stats, Credits and the leaderboards.
 *
 * Calculation, in whole numbers:
 *   subtotal = completed + placement (FFA) + victory + eliminations
 *              + first-game bonus + first-win bonus
 *   base     = floor(subtotal x playerCount x repeatedOpponents / 10^6)
 *   capped   = min(base, matchXpCap)
 *   paid     = capped, with what passes the daily soft cap at the soft rate
 */

// ------------------------------------------------- how much a game progresses

/**
 * How far a finished game advances progression, decided by the server and
 * nowhere else:
 *  - "full": a qualifying public game (the same rule as stats and Credits):
 *    every XP line, season XP, challenges, clan XP.
 *  - "reduced": completed-match and elimination XP at a quarter, to lifetime XP
 *    only (no placement, victory or daily bonus, no season, challenge or clan).
 *    A private or unlisted game, a public one with too few humans or one that
 *    was short, a game staff commands changed, and every player who was
 *    eliminated, whatever the game: a death is a reduced award, secured the
 *    moment it is known (earlyXp.ts).
 *  - "solo": a singleplayer match the account API verified by replaying it
 *    (soloEligibility): the match lines scaled by how demanding its setup was
 *    (solo.ts), to lifetime XP only, exactly like a reduced award. Never a season,
 *    a challenge or a clan.
 *  - "none": ranked, and (per player) leaving while still in the game, a guest,
 *    someone who never played. A singleplayer game that was not verified.
 */
export type ProgressionMode = "full" | "reduced" | "solo" | "none";

export type ProgressionReason =
  | "normal_public"
  | "public_too_few_humans"
  | "private_game"
  | "unlisted_game"
  // A game that ended inside the stats minimum (ACCOUNT_RULES.countedGameMinSeconds).
  | "short_game"
  // Staff commands changed the game (see isAdminModified): the competitive
  // parts do not apply, the player's own XP still does.
  | "admin_modified"
  // The player was eliminated: the reduced award for a death.
  | "eliminated"
  // A verified singleplayer match (see solo.ts).
  | "solo"
  | "singleplayer"
  | "ranked";

export interface ProgressionEligibility {
  mode: ProgressionMode;
  reason: ProgressionReason;
}

/**
 * The game-level progression answer. Built on `countedVerdict`, so "full" is
 * "counts for stats" (the same public, listed, populated game), except that
 * staff commands and a short game no longer take the XP away: they make the
 * game "reduced", lifetime XP only. Only a game that cannot pay at all is
 * "none": singleplayer and ranked.
 *
 * `adminModified` is the verdict of `isAdminModified`: it is true only when a
 * command made the game a test. The owner's commands in a public or listed game
 * do not, so that game stays "full"; every other staff command makes it
 * "reduced" (for everyone in it, the staff member too).
 *
 * A singleplayer game is "solo" when it arrived through the verified solo intake
 * (`source: "singleplayer"`), and "none" from anywhere else.
 */
export function progressionEligibility(
  facts: CountedFacts & { listed?: boolean | null },
): ProgressionEligibility {
  const none = (reason: ProgressionReason): ProgressionEligibility => ({
    mode: "none",
    reason,
  });
  const reduced = (reason: ProgressionReason): ProgressionEligibility => ({
    mode: "reduced",
    reason,
  });
  if (facts.type === GameType.Singleplayer) {
    // Only the account API's own verified intake says "singleplayer": a game
    // server never submits one, and a record that claims to be is not paid.
    return facts.source === "singleplayer"
      ? { mode: "solo", reason: "solo" }
      : none("singleplayer");
  }
  // Staff commands are judged below; they must not hide why the game is what it is.
  const verdict = countedVerdict({ ...facts, adminModified: false });
  if (verdict.counted) {
    return facts.adminModified === true
      ? reduced("admin_modified")
      : { mode: "full", reason: "normal_public" };
  }
  switch (verdict.reason) {
    case "not_server":
      return none("singleplayer");
    case "ranked":
      return none("ranked");
    case "private_game":
      return reduced(facts.listed === false ? "unlisted_game" : "private_game");
    case "too_few_humans":
      return reduced("public_too_few_humans");
    default:
      return reduced("short_game");
  }
}

/** The reason on a reduced award: the game's own when it was reduced anyway, else the death. */
export function reducedReasonFor(
  eligibility: ProgressionEligibility,
): ProgressionReason {
  return eligibility.mode === "reduced" ? eligibility.reason : "eliminated";
}

/** Why a player earned nothing from a game that otherwise counted. */
export type PlayerIneligibleReason =
  | "guest"
  | "not_spawned"
  | "left_early"
  | "no_winner"
  | "no_action";

/**
 * Where a player stood when the game was recorded: eliminated (a death, at the
 * tick `killedAt`), still in it, or never in it at all (never owned land).
 */
export type PlayerStanding = "eliminated" | "survived" | "not_spawned";

export function playerStanding(
  record: Pick<GameRecord, "info">,
  clientID: string,
): PlayerStanding {
  const player = record.info.players.find((p) => p.clientID === clientID);
  if (player === undefined) return "not_spawned";
  if (player.stats?.killedAt !== undefined) return "eliminated";
  const finalTiles = player.stats?.finalTiles;
  return finalTiles !== undefined && finalTiles > 0n
    ? "survived"
    : "not_spawned";
}

/** Whether the player was eliminated before the elimination minimum (a free kill, not a game played). */
export function eliminatedBeforeMinimum(
  record: Pick<GameRecord, "info">,
  clientID: string,
): boolean {
  const killedAt = record.info.players.find((p) => p.clientID === clientID)
    ?.stats?.killedAt;
  return (
    killedAt !== undefined && killedAt < BigInt(ECONOMY.minEliminationTick)
  );
}

/** The clients that took at least one gameplay action. Intents are stamped by the server. */
export function clientsWhoActed(turns: GameRecord["turns"]): Set<string> {
  const acted = new Set<string>();
  for (const turn of turns) {
    for (const intent of turn.intents) {
      if (GAMEPLAY_INTENTS.has(intent.type)) acted.add(intent.clientID);
    }
  }
  return acted;
}

/** The clients that sent a staff `admin_command` in this game. */
export function adminCommandSenders(turns: GameRecord["turns"]): Set<string> {
  const senders = new Set<string>();
  for (const turn of turns) {
    for (const intent of turn.intents) {
      if (intent.type === "admin_command") senders.add(intent.clientID);
    }
  }
  return senders;
}

type RecordPlayer = GameRecord["info"]["players"][number];

export interface PlacementTable {
  /** Players ranked; null for a game with no placement (team and Humans-vs-Nations). */
  placeOf: ReadonlyMap<string, number> | null;
  /** Humans in the game. */
  humans: number;
}

/** Winner first, then survivors by land, then the eliminated by who lasted longest, then those who never spawned. */
function placementKey(
  player: RecordPlayer,
  winners: ReadonlySet<string>,
): [number, bigint] {
  if (winners.has(player.clientID)) return [0, 0n];
  const killedAt = player.stats?.killedAt;
  const finalTiles = player.stats?.finalTiles;
  if (killedAt === undefined && finalTiles !== undefined && finalTiles > 0n) {
    return [1, -finalTiles];
  }
  if (killedAt !== undefined) return [2, -killedAt];
  return [3, 0n];
}

function keyBefore(a: [number, bigint], b: [number, bigint]): boolean {
  return a[0] !== b[0] ? a[0] < b[0] : a[1] < b[1];
}

/** Free-for-all placements; ties share the better place. Team games have none. */
export function placements(
  record: Pick<GameRecord, "info">,
  isFfa: boolean,
): PlacementTable {
  const players = record.info.players;
  if (!isFfa || record.info.winner === undefined) {
    return { placeOf: null, humans: players.length };
  }
  const winners = winnerClientIds(record.info.winner);
  const keys = players.map((p) => ({
    clientID: p.clientID,
    key: placementKey(p, winners),
  }));
  const placeOf = new Map<string, number>();
  for (const a of keys) {
    let better = 0;
    for (const b of keys) {
      if (keyBefore(b.key, a.key)) better++;
    }
    placeOf.set(a.clientID, better + 1);
  }
  return { placeOf, humans: players.length };
}

/** Whether the game is a free-for-all (the only mode with placement XP). */
export function isFreeForAll(
  config: Record<string, unknown> | undefined,
): boolean {
  return (config?.gameMode ?? GameMode.FFA) === GameMode.FFA;
}

/** Placement XP for finishing `place` among `humans`: the highest tier only. */
export function placementXp(place: number, humans: number): number {
  if (!(place >= 1) || humans < 1) return 0;
  if (place <= Math.ceil(humans / 10)) return PROGRESSION.placementTopTenth;
  if (place <= Math.ceil(humans / 4)) return PROGRESSION.placementTopQuarter;
  if (place <= Math.ceil(humans / 2)) return PROGRESSION.placementTopHalf;
  return 0;
}

/**
 * The humans this player eliminated that count: each victim once, never
 * themselves, never someone who lasted less than two minutes (a fresh spawn
 * taking a free kill). Bots and nations are not in `kills` at all.
 */
export function validEliminations(
  record: Pick<GameRecord, "info">,
  clientID: string,
): number {
  const me = record.info.players.find((p) => p.clientID === clientID);
  const kills = me?.stats?.kills ?? [];
  const victims = new Set<string>();
  for (const kill of kills) {
    if (kill.victim === clientID || victims.has(kill.victim)) continue;
    const victim = record.info.players.find((p) => p.clientID === kill.victim);
    const killedAt = victim?.stats?.killedAt;
    if (killedAt === undefined || killedAt < BigInt(ECONOMY.minEliminationTick))
      continue;
    victims.add(kill.victim);
  }
  return victims.size;
}

/** The player-count multiplier (permille) for `eligible` eligible humans. */
export function playerCountPermille(eligible: number): number {
  for (const band of PROGRESSION.playerCountBands) {
    if (eligible <= band.upTo) return band.permille;
  }
  return PROGRESSION.playerCountBands[PROGRESSION.playerCountBands.length - 1]
    .permille;
}

/**
 * The repeated-opponents multiplier. `sharedPriorGames` holds, for each OTHER
 * eligible player, how many counted games they and this player both completed
 * in the preceding day. Only small groups are looked at; when more than half
 * the others are familiar the award is halved, and quartered when they are very
 * familiar.
 */
export function repeatPermille(sharedPriorGames: readonly number[]): number {
  const rule = PROGRESSION.repeat;
  const others = sharedPriorGames.length;
  if (others === 0 || others > rule.maxOthers) return PERMILLE;
  const familiar = sharedPriorGames.filter((n) => n >= rule.sharedLow).length;
  const veryFamiliar = sharedPriorGames.filter(
    (n) => n >= rule.sharedHigh,
  ).length;
  if (veryFamiliar * 2 > others) return rule.highPermille;
  if (familiar * 2 > others) return rule.lowPermille;
  return PERMILLE;
}

export interface SoftCapResult {
  paid: number;
  softCapped: boolean;
}

/** Pays `amount` given `earnedToday` match XP already paid: full rate up to the daily limit, the soft rate above it. */
export function applySoftCap(
  amount: number,
  earnedToday: number,
): SoftCapResult {
  const room = Math.max(0, PROGRESSION.dailySoftCap - Math.max(0, earnedToday));
  const full = Math.min(amount, room);
  const over = amount - full;
  if (over <= 0) return { paid: full, softCapped: false };
  return {
    paid:
      full + Math.floor((over * PROGRESSION.softCapRatePermille) / PERMILLE),
    softCapped: true,
  };
}

export interface MatchXpInput {
  victory: boolean;
  /** FFA finishing place, or null (no placement in team games). */
  place: number | null;
  /** Humans in the game (placement tiers read it). */
  humans: number;
  /** Counted eliminations (validEliminations), before the per-game limit. */
  eliminations: number;
  /** Eligible humans: completed the game and acted (the player-count multiplier). */
  eligibleHumans: number;
  repeatPermille: number;
  /** Whether this player has not used the day's first-game / first-win bonus yet. */
  firstGameAvailable: boolean;
  firstWinAvailable: boolean;
  /** Match XP already paid today (the soft cap). */
  earnedToday: number;
}

export interface MatchXpBreakdown {
  played: number;
  placement: number;
  win: number;
  eliminations: number;
  eliminationCount: number;
  firstGame: number;
  firstWin: number;
  subtotal: number;
  gamePermille: number;
  repeatPermille: number;
  playerCount: number;
  capped: boolean;
  softCapped: boolean;
  /** Set on a reduced award: why (private_game, unlisted_game, public_too_few_humans, short_game, admin_modified, eliminated). */
  reducedReason?: ProgressionReason;
  /** A solo award: the setup multiplier (permille) it was scaled by, and what it was scored on. */
  soloPermille?: number;
  solo?: SoloBreakdown;
  /** Match XP actually paid. */
  total: number;
}

export interface MatchXpResult {
  breakdown: MatchXpBreakdown;
  usedFirstGame: boolean;
  usedFirstWin: boolean;
  /** Review markers: soft_cap, cap_hit, repeat_group, tiny_win. */
  flags: string[];
}

export function computeMatchXp(input: MatchXpInput): MatchXpResult {
  const gamePermille = playerCountPermille(input.eligibleHumans);
  const dailyBonusOk = gamePermille >= PROGRESSION.dailyBonusMinPermille;
  const usedFirstGame = input.firstGameAvailable && dailyBonusOk;
  const usedFirstWin = input.victory && input.firstWinAvailable && dailyBonusOk;

  const played = PROGRESSION.completedMatch;
  const placement =
    input.place === null ? 0 : placementXp(input.place, input.humans);
  const win = input.victory ? PROGRESSION.victory : 0;
  const eliminationCount = Math.min(
    Math.max(0, input.eliminations),
    PROGRESSION.maxEliminations,
  );
  const eliminations = eliminationCount * PROGRESSION.eliminationXp;
  const firstGame = usedFirstGame ? PROGRESSION.firstGameBonus : 0;
  const firstWin = usedFirstWin ? PROGRESSION.firstWinBonus : 0;
  const subtotal =
    played + placement + win + eliminations + firstGame + firstWin;

  const base = Math.floor(
    (subtotal * gamePermille * input.repeatPermille) / (PERMILLE * PERMILLE),
  );
  const cappedAmount = Math.min(base, PROGRESSION.matchXpCap);
  const capHit = base > PROGRESSION.matchXpCap;
  const soft = applySoftCap(cappedAmount, input.earnedToday);

  const flags: string[] = [];
  if (capHit) flags.push("cap_hit");
  if (soft.softCapped) flags.push("soft_cap");
  if (input.repeatPermille < PERMILLE) flags.push("repeat_group");
  if (input.victory && input.eligibleHumans <= 2) flags.push("tiny_win");

  return {
    breakdown: {
      played,
      placement,
      win,
      eliminations,
      eliminationCount,
      firstGame,
      firstWin,
      subtotal,
      gamePermille,
      repeatPermille: input.repeatPermille,
      playerCount: input.eligibleHumans,
      capped: capHit,
      softCapped: soft.softCapped,
      total: soft.paid,
    },
    usedFirstGame,
    usedFirstWin,
    flags,
  };
}

export interface ReducedXpInput {
  reason: ProgressionReason;
  /** Counted eliminations (validEliminations), before the per-game limit. */
  eliminations: number;
  /** Match XP already paid today (the soft cap still applies to lifetime XP). */
  earnedToday: number;
}

/**
 * A reduced award: completed match plus valid eliminations, times the
 * reduced multiplier, in whole numbers (100 + 25 = 125 → 31). No placement,
 * victory, daily bonus, player-count or repeated-opponent factor, and it does not
 * use up the day's first-game or first-win bonus.
 */
export function computeReducedXp(input: ReducedXpInput): MatchXpResult {
  const played = PROGRESSION.completedMatch;
  const eliminationCount = Math.min(
    Math.max(0, input.eliminations),
    PROGRESSION.maxEliminations,
  );
  const eliminations = eliminationCount * PROGRESSION.eliminationXp;
  const subtotal = played + eliminations;
  const base = Math.floor((subtotal * PROGRESSION.reducedPermille) / PERMILLE);
  const cappedAmount = Math.min(base, PROGRESSION.matchXpCap);
  const soft = applySoftCap(cappedAmount, input.earnedToday);
  const flags = ["reduced"];
  if (base > PROGRESSION.matchXpCap) flags.push("cap_hit");
  if (soft.softCapped) flags.push("soft_cap");
  return {
    breakdown: {
      played,
      placement: 0,
      win: 0,
      eliminations,
      eliminationCount,
      firstGame: 0,
      firstWin: 0,
      subtotal,
      gamePermille: PROGRESSION.reducedPermille,
      repeatPermille: PERMILLE,
      playerCount: 0,
      capped: base > PROGRESSION.matchXpCap,
      softCapped: soft.softCapped,
      reducedReason: input.reason,
      total: soft.paid,
    },
    usedFirstGame: false,
    usedFirstWin: false,
    flags,
  };
}

// ---------------------------------------------- per-game statistics

type PlayerStatsLike = NonNullable<RecordPlayer["stats"]>;

const sum = (values: readonly bigint[] | undefined, from = 0, to?: number) => {
  let total = 0n;
  (values ?? []).slice(from, to).forEach((v) => (total += v));
  return total;
};

/** Structures (not warships) the player built in one game. */
export function structuresBuilt(stats: PlayerStatsLike | undefined): number {
  let built = 0n;
  for (const [unit, counts] of Object.entries(stats?.units ?? {})) {
    if (unit === "wshp" || counts === undefined) continue;
    built += counts[OTHER_INDEX_BUILT] ?? 0n;
  }
  return Number(built);
}

/** Gold the player earned in one game from work, war and trade (donations excluded). */
export function goldEarned(stats: PlayerStatsLike | undefined): number {
  return Number(sum(stats?.gold, 0, 6));
}

/** Alliances the player formed in one game. */
export function alliancesFormed(stats: PlayerStatsLike | undefined): number {
  return Number(stats?.alliances?.[ALLIANCE_INDEX_FORMED] ?? 0n);
}

/** Seconds the player was in the game: until eliminated, or the whole game for a survivor (10 ticks a second). */
export function secondsSurvived(
  record: Pick<GameRecord, "info">,
  player: RecordPlayer,
): number {
  const killedAt = player.stats?.killedAt;
  if (killedAt !== undefined) return Math.floor(Number(killedAt) / 10);
  return Math.max(0, Math.floor(record.info.duration));
}
