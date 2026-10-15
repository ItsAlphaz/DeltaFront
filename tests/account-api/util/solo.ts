import type { ReplayedSolo } from "@openfront/engine/WinnerReplay";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import type { SoloReplayer } from "../../../src/account-api/soloReplay";
import type { TestUser } from "./games";
import { call, type Harness } from "./harness";

/** The human of every solo fixture. */
export const SOLO_CLIENT = "solo0001";

export interface SoloRecordSpec {
  gameID?: string;
  /** What the record CLAIMS (a browser's word): the replay decides what is true. */
  claims?: Partial<{
    difficulty: string;
    bots: number;
    nations: number | "default" | "disabled";
    infiniteGold: boolean;
    infiniteTroops: boolean;
    instantBuild: boolean;
    gameType: string;
  }>;
  /** What the record says about the winner. */
  winner?: string[] | null;
  turns?: number;
  /** Extra intents, in turn 2. */
  extraIntents?: unknown[];
  /** A player with no gameplay action. */
  idle?: boolean;
  players?: number;
  /** The persistentID the record names (ignored by the server). */
  persistentID?: string | null;
  /** When the record CLAIMS the match ended, ms since the epoch (ignored by the server). */
  endMs?: number;
}

let counter = 0;
/** A fresh eight-character solo game id. */
export const soloId = (): string => `so${String(++counter).padStart(6, "0")}`;

/** A singleplayer record the way LocalServer uploads it. */
export function soloRecord(spec: SoloRecordSpec = {}): Record<string, unknown> {
  const gameID = spec.gameID ?? soloId();
  const turnsCount = spec.turns ?? 6000;
  const end = spec.endMs ?? Date.now() - 1000;
  const claims = spec.claims ?? {};
  const winner =
    spec.winner === null ? undefined : (spec.winner ?? ["player", SOLO_CLIENT]);
  const turns: Array<{
    turnNumber: number;
    intents: unknown[];
    hash?: number;
  }> = [
    { turnNumber: 0, intents: [] },
    {
      turnNumber: 1,
      intents: spec.idle
        ? []
        : [
            {
              type: "attack",
              targetID: null,
              troops: null,
              clientID: SOLO_CLIENT,
            },
          ],
    },
  ];
  if (spec.extraIntents !== undefined) {
    turns.push({ turnNumber: 2, intents: spec.extraIntents });
  }
  turns.push({ turnNumber: 100, intents: [], hash: 12345 });
  return {
    version: "v0.0.2",
    gitCommit: "DEV",
    info: {
      gameID,
      lobbyCreatedAt: end - turnsCount * 100,
      lobbyFillTime: 0,
      start: end - turnsCount * 100,
      end,
      duration: Math.floor(turnsCount / 10),
      num_turns: turnsCount,
      ...(winner === undefined ? {} : { winner }),
      config: {
        gameMap: "Africa",
        difficulty: claims.difficulty ?? "Hard",
        donateGold: false,
        donateTroops: false,
        gameType: claims.gameType ?? "Singleplayer",
        gameMode: "Free For All",
        gameMapSize: "Normal",
        nations: claims.nations ?? "default",
        bots: claims.bots ?? 40,
        infiniteGold: claims.infiniteGold ?? false,
        infiniteTroops: claims.infiniteTroops ?? false,
        instantBuild: claims.instantBuild ?? false,
        randomSpawn: false,
      },
      players: Array.from({ length: spec.players ?? 1 }, (_, i) => ({
        clientID: i === 0 ? SOLO_CLIENT : `solo000${i + 1}`,
        username: `Solo${i + 1}`,
        clanTag: null,
        persistentID: spec.persistentID ?? null,
        stats: { attacks: ["100", "40", "0"], finalTiles: "500" },
      })),
    },
    turns,
  };
}

export const gzipRecord = (record: unknown): Buffer =>
  gzipSync(Buffer.from(JSON.stringify(record), "utf8"));

/** POSTs a solo upload the way LocalServer does. */
export function submitSolo(
  h: Harness,
  who: TestUser | null,
  body: Buffer | string,
): Promise<Response> {
  return fetch(`${h.baseUrl}/archive_singleplayer_game`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Content-Encoding": "gzip",
      "User-Agent": "test-browser/1.0",
      ...(who === null ? {} : { Authorization: `Bearer ${who.jwt}` }),
    },
    body: typeof body === "string" ? Buffer.from(body) : new Uint8Array(body),
  });
}

/** What the engine's replay finds for a clean, full win: the setup that earns 1.00x. */
export function replayed(over: Partial<ReplayedSolo> = {}): ReplayedSolo {
  return {
    winner: ["player", SOLO_CLIENT],
    allPlayersStats: {
      [SOLO_CLIENT]: { attacks: [100n, 40n, 0n], finalTiles: 500n },
    } as ReplayedSolo["allPlayersStats"],
    tick: 6000,
    ticks: 6000,
    hashes: { checked: 5, mismatched: 0 },
    tribes: 40,
    nations: 40,
    cheats: { instantBuild: false, infiniteGold: false, infiniteTroops: false },
    difficulty: "Hard",
    humans: [{ clientID: SOLO_CLIENT, spawned: true, alive: true }],
    ...over,
  };
}

/** A replayer that answers with a fixed result (or failure), and counts its calls. */
export function stubReplayer(
  answer: ReplayedSolo | ((gameID: string) => ReplayedSolo | Error),
): SoloReplayer & { calls: string[] } {
  const calls: string[] = [];
  const replayer: SoloReplayer = async (gameStart) => {
    calls.push(gameStart.gameID);
    const result =
      typeof answer === "function" ? answer(gameStart.gameID) : answer;
    return result instanceof Error
      ? { ok: false, error: result.message }
      : { ok: true, result };
  };
  return Object.assign(replayer, { calls });
}

/** Waits until a submission is decided (paid or refused), and says which. */
export async function waitDecided(
  h: Harness,
  gameID: string,
  timeoutMs = 10_000,
): Promise<{ status: string; reason: string | null }> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { rows } = await h.db.pool.query<{
      status: string;
      reason: string | null;
    }>("SELECT status, reason FROM solo_submissions WHERE game_code = $1", [
      gameID,
    ]);
    if (rows.length > 0 && ["paid", "rejected"].includes(rows[0].status)) {
      return rows[0];
    }
    if (Date.now() > deadline) {
      throw new Error(`solo ${gameID} not decided: ${JSON.stringify(rows)}`);
    }
    await new Promise((r) => setTimeout(r, 25));
  }
}

export const hashOf = (s: string) =>
  createHash("sha256").update(s).digest("hex").slice(0, 8);

/** GET /users/@me/xp/:gameId */
export const xpOf = (h: Harness, who: TestUser, gameID: string) =>
  call(h, `/users/@me/xp/${gameID}`, { bearer: who.jwt, origin: null });
