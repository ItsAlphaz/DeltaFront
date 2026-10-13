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
}

/**
 * Whether a game feeds the Public stats, Credits and (later) leaderboards and
 * the clan threshold: submitted by a game server, Public, not ranked, with at
 * least two account holders, and lasting at least two minutes.
 */
export function countsForStats(facts: CountedFacts): boolean {
  return (
    facts.source === "server" &&
    facts.type === GameType.Public &&
    (facts.rankedType === undefined ||
      facts.rankedType === null ||
      facts.rankedType === "") &&
    facts.accountHolders >= ACCOUNT_RULES.countedGameMinAccountHolders &&
    facts.durationSeconds >= ACCOUNT_RULES.countedGameMinSeconds
  );
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
 * A completed game, for Credits and the clan threshold. All of:
 *  1. the game counts (`counted`, from countsForStats);
 *  2. it ended with a winner;
 *  3. the player survived to the end (`finalTiles` set, owning land) or was
 *     eliminated (`killedAt`) at or after ECONOMY.minEliminationTick;
 *  4. the player was connected at that moment (the end for a survivor, the
 *     elimination for the eliminated).
 */
export function isCompleted(
  record: Pick<GameRecord, "info" | "turns">,
  clientID: string,
  counted: boolean,
): boolean {
  if (!counted) return false;
  if (record.info.winner === undefined) return false;
  const player = record.info.players.find((p) => p.clientID === clientID);
  if (player === undefined) return false;
  const killedAt = player.stats?.killedAt;
  const finalTiles = player.stats?.finalTiles;
  let moment: number;
  if (killedAt !== undefined) {
    if (killedAt < BigInt(ECONOMY.minEliminationTick)) return false;
    moment = Number(killedAt);
  } else if (finalTiles !== undefined && finalTiles > 0n) {
    moment = endTurn(record);
  } else {
    return false;
  }
  return wasConnectedAt(record.turns, clientID, moment);
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
