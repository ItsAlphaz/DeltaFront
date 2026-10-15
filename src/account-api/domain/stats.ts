import {
  Difficulty,
  GameMode,
  GameType,
  HumansVsNations,
} from "@openfront/engine-api/game/GameTypes";
import { ATTACK_INDEX_MAX_RECV } from "@openfront/engine-api/StatsSchemas";
import {
  PlayerStatsGameModes,
  type PlayerStatsTreeSchema,
} from "@openfront/shared/ApiSchemas";
import type { GameRecord } from "@openfront/shared/WireSchemas";
import type { z } from "zod";
import { ACCOUNT_RULES, ECONOMY } from "./constants";

/**
 * The rules that turn a game record into stats, and the stats into a profile.
 * Pure functions, no database: the single definition of "counts for stats"
 * and "completed" (docs/DeltaFrontAccountsPlan.md sections 8.3 and 9.5), used
 * by ingestion for Credits, aggregates and (from M6) the clan threshold.
 */

export type GameResult = "victory" | "defeat" | "incomplete";

type Winner = GameRecord["info"]["winner"];

/** The clientIDs on the winning side: `["player", id…]`, `["team", name, id…]`, `["nation", name, id…]`. */
export function winnerClientIds(winner: Winner): ReadonlySet<string> {
  if (winner === undefined) return new Set();
  const skip = winner[0] === "player" ? 1 : 2;
  return new Set(winner.slice(skip) as string[]);
}

/** `victory` if the client is on the winning side, `defeat` if there was a winner and it is not, `incomplete` without a winner. */
export function resultFor(clientID: string, winner: Winner): GameResult {
  if (winner === undefined) return "incomplete";
  return winnerClientIds(winner).has(clientID) ? "victory" : "defeat";
}

export interface CountedFacts {
  /** Where the record came from: only the game server's records count. */
  source: "server" | "singleplayer";
  type: string | undefined;
  /** Ranked games are a separate bucket that does not exist yet. */
  rankedType: string | null | undefined;
  durationSeconds: number;
  /** Distinct, live accounts among the players. */
  accountHolders: number;
  /** Staff commands made this a test (isAdminModified in ingest.ts). */
  adminModified?: boolean;
}

/** Why a game does not count, in the order the rules are checked. */
export type NotCountedReason =
  | "not_server"
  | "private_game"
  | "ranked"
  | "admin_modified"
  | "too_few_humans"
  | "too_short";

export interface CountedVerdict {
  counted: boolean;
  /** Null when the game counts. */
  reason: NotCountedReason | null;
}

/**
 * Whether a game feeds the Public stats, Credits, the leaderboards, the clan
 * threshold AND progression (XP): submitted by a game server, Public, not
 * ranked, not a staff test, with at least two account holders, and lasting at
 * least two minutes. The ONE game-level eligibility rule: nothing else decides
 * whether a game counts, and the reason is what the player is told.
 */
export function countedVerdict(facts: CountedFacts): CountedVerdict {
  const no = (reason: NotCountedReason): CountedVerdict => ({
    counted: false,
    reason,
  });
  if (facts.source !== "server") return no("not_server");
  if (facts.type !== GameType.Public) return no("private_game");
  if (
    !(
      facts.rankedType === undefined ||
      facts.rankedType === null ||
      facts.rankedType === ""
    )
  )
    return no("ranked");
  if (facts.adminModified === true) return no("admin_modified");
  if (facts.accountHolders < ACCOUNT_RULES.countedGameMinAccountHolders)
    return no("too_few_humans");
  if (facts.durationSeconds < ACCOUNT_RULES.countedGameMinSeconds)
    return no("too_short");
  return { counted: true, reason: null };
}

/** `countedVerdict(...).counted`. */
export function countsForStats(facts: CountedFacts): boolean {
  return countedVerdict(facts).counted;
}

/**
 * The last turn the game played. `num_turns` counts every turn, while the
 * record's `turns` list may leave out turns without intents, so the list's
 * last entry is only the fallback for a record that lacks the count.
 */
function endTurn(record: Pick<GameRecord, "info" | "turns">): number {
  if (record.info.num_turns > 0) return record.info.num_turns - 1;
  let last = 0;
  for (const turn of record.turns) last = Math.max(last, turn.turnNumber);
  return last;
}

/**
 * Whether the client was connected at `moment`: the latest `mark_disconnected`
 * intent for it up to that turn is absent or says it is connected again. Within
 * a turn the later intent wins.
 */
export function wasConnectedAt(
  turns: GameRecord["turns"],
  clientID: string,
  moment: number,
): boolean {
  let latestTurn = -1;
  let disconnected = false;
  for (const turn of turns) {
    if (turn.turnNumber > moment) continue;
    for (const intent of turn.intents) {
      if (intent.type !== "mark_disconnected" || intent.clientID !== clientID)
        continue;
      if (turn.turnNumber >= latestTurn) {
        latestTurn = turn.turnNumber;
        disconnected = intent.isDisconnected;
      }
    }
  }
  return !disconnected;
}

/**
 * What a player's game came to, for Credits, the clan threshold and XP: one
 * answer from the record alone, never from what a client said. The first three
 * are completed; the rest are not.
 */
export type PlayerProgressionOutcome =
  /** Alive when the result was determined, and stayed to it. */
  | "completed_alive"
  /** Eliminated (after the minimum) and stayed to the result. */
  | "completed_eliminated"
  /** On the winning side and left only after the result was determined. */
  | "won_and_left_after_result"
  /** Left (the server lost their connection and they did not come back) before the result. */
  | "left_early"
  /** Gone from the heartbeat's point of view, on a record that does not say when they left. */
  | "disconnected_early"
  /** Eliminated before the minimum: a fresh spawn taking a free kill is not a game played. */
  | "eliminated_early"
  /** Never owned land. */
  | "not_spawned"
  /** The game ended without a settled winner. */
  | "no_winner"
  /** The game itself does not count (see countedVerdict). */
  | "not_counted";

const COMPLETING: ReadonlySet<PlayerProgressionOutcome> = new Set([
  "completed_alive",
  "completed_eliminated",
  "won_and_left_after_result",
]);

/** Whether the outcome is a completed game. */
export function isCompletedOutcome(outcome: PlayerProgressionOutcome): boolean {
  return COMPLETING.has(outcome);
}

/**
 * How many turns before the result a departure still counts as after it: the
 * result reaches the server a moment after the clients' simulations reach it,
 * and a connection is only noticed gone a moment after it closes (turns are a
 * tenth of a second each).
 */
export const RESULT_GRACE_TURNS = 5;

/** Where a player stood at the result: with the game, or gone, and since when. */
type Presence =
  | { kind: "present" }
  | { kind: "left_after_result" }
  | { kind: "gone"; recorded: boolean };

/**
 * Whether the player stayed to the result.
 *
 * A record the game server wrote with a `resultTurn` carries the server's own
 * roster: a player without a `leftTurn` was connected when it was written (they
 * may have dropped and come back on the way: that is not leaving), one with it
 * was gone, and since that turn. Gone at or after the result is leaving after
 * the game was decided; gone before it is leaving early.
 *
 * An older record has only the heartbeat's `mark_disconnected` intents: the
 * player is present unless their latest state, as of the last turn, is
 * disconnected, and then they are gone since that intent.
 */
function presenceAtResult(
  record: Pick<GameRecord, "info" | "turns">,
  player: GameRecord["info"]["players"][number],
): Presence {
  const resultTurn = record.info.resultTurn;
  if (resultTurn !== undefined) {
    if (player.leftTurn === undefined) return { kind: "present" };
    return player.leftTurn + RESULT_GRACE_TURNS >= resultTurn
      ? { kind: "left_after_result" }
      : { kind: "gone", recorded: true };
  }
  const end = endTurn(record);
  if (wasConnectedAt(record.turns, player.clientID, end)) {
    return { kind: "present" };
  }
  return disconnectedSince(record.turns, player.clientID, end) +
    RESULT_GRACE_TURNS >=
    end
    ? { kind: "left_after_result" }
    : { kind: "gone", recorded: false };
}

/** The turn of the client's latest `mark_disconnected` up to `moment`, 0 if there is none. */
function disconnectedSince(
  turns: GameRecord["turns"],
  clientID: string,
  moment: number,
): number {
  let since = 0;
  for (const turn of turns) {
    if (turn.turnNumber > moment) continue;
    for (const intent of turn.intents) {
      if (
        intent.type === "mark_disconnected" &&
        intent.clientID === clientID &&
        intent.isDisconnected
      ) {
        since = Math.max(since, turn.turnNumber);
      }
    }
  }
  return since;
}

/**
 * The player's outcome. A player completes a game if the game counts, it ended
 * with a settled winner, they owned land (or were eliminated at or after
 * ECONOMY.minEliminationTick), and they stayed to the result: alive, or
 * eliminated and still there, or gone only after the result was determined.
 * Being eliminated is a placement, not a reason to lose anything; leaving
 * before the result is. A temporary disconnect that came back is not leaving.
 */
export function playerProgressionOutcome(
  record: Pick<GameRecord, "info" | "turns">,
  clientID: string,
  counted: boolean,
): PlayerProgressionOutcome {
  if (!counted) return "not_counted";
  if (record.info.winner === undefined) return "no_winner";
  const player = record.info.players.find((p) => p.clientID === clientID);
  if (player === undefined) return "not_spawned";
  const killedAt = player.stats?.killedAt;
  const finalTiles = player.stats?.finalTiles;
  const eliminated = killedAt !== undefined;
  if (!eliminated && !(finalTiles !== undefined && finalTiles > 0n)) {
    return "not_spawned";
  }
  if (eliminated && killedAt < BigInt(ECONOMY.minEliminationTick)) {
    return "eliminated_early";
  }
  const presence = presenceAtResult(record, player);
  if (presence.kind === "gone") {
    return presence.recorded ? "left_early" : "disconnected_early";
  }
  if (eliminated) return "completed_eliminated";
  return presence.kind === "left_after_result" &&
    resultFor(clientID, record.info.winner) === "victory"
    ? "won_and_left_after_result"
    : "completed_alive";
}

/**
 * A completed game, for Credits, the clan threshold and XP: the outcome is one
 * of the completing ones (see playerProgressionOutcome).
 */
export function isCompleted(
  record: Pick<GameRecord, "info" | "turns">,
  clientID: string,
  counted: boolean,
): boolean {
  return isCompletedOutcome(
    playerProgressionOutcome(record, clientID, counted),
  );
}

// ------------------------------------------------------------------ stats

/** A PlayerStats object as JSON: every bigint a decimal string. */
export type StatsJson = Record<string, unknown>;

const MAX_STAT = BigInt(ACCOUNT_RULES.maxStatValue);
/** Aggregates are PostgreSQL-safe and stay below 2^63. */
const MAX_AGGREGATE = 9_223_372_036_854_775_807n;

/**
 * A record's stats as JSON for storage. A statistic outside 0..maxStatValue
 * is not believable and is stored as 0 (so a negative `killedAt` fails the
 * completed-game rule rather than passing it).
 */
export function statsToJson(stats: unknown): StatsJson {
  const walk = (value: unknown): unknown => {
    if (typeof value === "bigint")
      return value < 0n || value > MAX_STAT ? "0" : value.toString();
    if (Array.isArray(value)) return value.map(walk);
    if (value !== null && typeof value === "object")
      return Object.fromEntries(
        Object.entries(value)
          .filter(([, v]) => v !== undefined)
          .map(([k, v]) => [k, walk(v)]),
      );
    return value;
  };
  if (stats === undefined || stats === null) return {};
  return walk(stats) as StatsJson;
}

/** The statistics that add up across games; per-game values (killedAt, finalTiles, peaks, spawn) are not. */
const ARRAY_FIELDS = ["attacks", "conquests", "gold", "donations"] as const;
const RECORD_FIELDS = ["boats", "bombs", "units", "air"] as const;
/** Positions inside an array that hold a running maximum, not a sum. */
const MAX_INDEXES: Record<string, ReadonlySet<number>> = {
  attacks: new Set([ATTACK_INDEX_MAX_RECV]),
};

function big(value: unknown): bigint {
  try {
    if (typeof value === "bigint") return value < 0n ? 0n : value;
    if (typeof value === "number" && Number.isFinite(value))
      return value < 0 ? 0n : BigInt(Math.trunc(value));
    if (typeof value === "string" && /^\d+$/.test(value)) return BigInt(value);
  } catch {
    // fall through
  }
  return 0n;
}

function sumArrays(
  a: unknown,
  b: unknown,
  maxIndexes: ReadonlySet<number> = new Set(),
): string[] | undefined {
  const x = Array.isArray(a) ? a : [];
  const y = Array.isArray(b) ? b : [];
  if (x.length === 0 && y.length === 0) return undefined;
  const out: string[] = [];
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const left = big(x[i]);
    const right = big(y[i]);
    let value = maxIndexes.has(i)
      ? left > right
        ? left
        : right
      : left + right;
    if (value > MAX_AGGREGATE) value = MAX_AGGREGATE;
    out.push(value.toString());
  }
  return out;
}

/**
 * Element-wise sum of two players' stats (JSON form), padding the shorter
 * array with zeros. Only the statistics that accumulate are kept: the rest
 * (when a player died, how many tiles they ended with) describe one game.
 * Sums saturate at 2^63-1.
 */
export function sumPlayerStats(
  a: StatsJson | undefined,
  b: StatsJson | undefined,
): StatsJson {
  const left = a ?? {};
  const right = b ?? {};
  const out: StatsJson = {};
  for (const field of ARRAY_FIELDS) {
    const summed = sumArrays(left[field], right[field], MAX_INDEXES[field]);
    if (summed !== undefined) out[field] = summed;
  }
  if (left.betrayals !== undefined || right.betrayals !== undefined) {
    const total = big(left.betrayals) + big(right.betrayals);
    out.betrayals = (total > MAX_AGGREGATE ? MAX_AGGREGATE : total).toString();
  }
  for (const field of RECORD_FIELDS) {
    const l = (left[field] ?? {}) as Record<string, unknown>;
    const r = (right[field] ?? {}) as Record<string, unknown>;
    const merged: Record<string, string[]> = {};
    for (const key of new Set([...Object.keys(l), ...Object.keys(r)])) {
      const summed = sumArrays(l[key], r[key]);
      if (summed !== undefined) merged[key] = summed;
    }
    if (Object.keys(merged).length > 0) out[field] = merged;
  }
  return out;
}

// ------------------------------------------------------------------- tree

type StatsTreeWire = z.input<typeof PlayerStatsTreeSchema>;

export interface AggregateRow {
  gameType: string;
  mode: string;
  difficulty: string;
  wins: string;
  losses: string;
  total: string;
  stats: StatsJson;
}

/** One finished game of a player, newest first, for the "recent" windows. */
export interface RecentRow {
  gameType: string;
  mode: string;
  difficulty: string;
  won: boolean;
}

/** The stats-tree mode of a game: Humans Vs Nations is a team-count preset, shown as its own mode. */
export function modeBucket(
  gameMode: string | null | undefined,
  playerTeams: string | null | undefined,
): string {
  if (playerTeams === HumansVsNations) return HumansVsNations;
  return gameMode ?? GameMode.FFA;
}

const TYPES: readonly string[] = [
  GameType.Singleplayer,
  GameType.Public,
  GameType.Private,
];
const MODES: readonly string[] = PlayerStatsGameModes;
const DIFFICULTIES: readonly string[] = Object.values(Difficulty);

function windowOf(rows: readonly RecentRow[]) {
  const window = rows.slice(0, ACCOUNT_RULES.recentWindowGames);
  return { games: window.length, wins: window.filter((r) => r.won).length };
}

function recentByDifficulty(rows: readonly RecentRow[]) {
  const out: Record<string, { games: number; wins: number }> = {
    all: windowOf(rows),
  };
  for (const difficulty of DIFFICULTIES) {
    const subset = rows.filter((r) => r.difficulty === difficulty);
    if (subset.length > 0) out[difficulty] = windowOf(subset);
  }
  return out;
}

/** Win/loss counts over the newest games of each selection the stats UI offers. */
export function buildRecentTree(rows: readonly RecentRow[]) {
  const tree: Record<string, unknown> = { all: windowOf(rows) };
  for (const gameType of TYPES) {
    const ofType = rows.filter((r) => r.gameType === gameType);
    if (ofType.length === 0) continue;
    const entry: Record<string, unknown> = recentByDifficulty(ofType);
    for (const mode of MODES) {
      const ofMode = ofType.filter((r) => r.mode === mode);
      if (ofMode.length > 0) entry[mode] = recentByDifficulty(ofMode);
    }
    tree[gameType] = entry;
  }
  return tree;
}

/**
 * The profile's stats tree, `{ Public: { [mode]: { [difficulty]: leaf } }, … }`,
 * from a player's aggregate rows. A row whose type, mode or difficulty the
 * client does not know is left out rather than failing the whole profile.
 */
export function buildStatsTree(
  aggregates: readonly AggregateRow[],
  recent: readonly RecentRow[],
): StatsTreeWire {
  const tree: Record<string, Record<string, Record<string, unknown>>> = {};
  for (const row of aggregates) {
    if (
      !TYPES.includes(row.gameType) ||
      !MODES.includes(row.mode) ||
      !DIFFICULTIES.includes(row.difficulty)
    )
      continue;
    ((tree[row.gameType] ??= {})[row.mode] ??= {})[row.difficulty] = {
      wins: row.wins,
      losses: row.losses,
      total: row.total,
      stats: row.stats,
    };
  }
  return { ...tree, recent: buildRecentTree(recent) } as StatsTreeWire;
}
