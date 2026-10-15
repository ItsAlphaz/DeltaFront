import {
  GameRecordSchema,
  type GameRecord,
} from "@openfront/shared/WireSchemas";
import { randomUUID } from "node:crypto";
import { createSession, hashIp } from "../../../src/account-api/repo/sessions";
import { createUser } from "../../../src/account-api/repo/users";
import { call, CookieJar, type Harness } from "./harness";

/** An account in the test database with a live session, as a signed-in browser would have. */
export interface TestUser {
  id: string;
  publicId: string;
  jwt: string;
  jar: CookieJar;
}

export async function makeUser(
  h: Harness,
  kind: "guest" | "registered" = "registered",
): Promise<TestUser> {
  const user = await createUser(h.db.pool, kind);
  const session = await createSession(h.db.pool, user.id, {
    userAgent: "test-browser/1.0",
    ipHash: hashIp("127.0.0.1"),
  });
  const { jwt } = await h.tokens.issue({
    userId: user.id,
    role: null,
    provider: kind === "guest" ? "guest" : "discord",
    sid: session.familyId,
  });
  const jar = new CookieJar();
  jar.set("df_refresh", session.token);
  return { id: user.id, publicId: user.publicId, jwt, jar };
}

export interface PlayerSpec {
  /** The account that played; null is a player without one. */
  user: TestUser | null;
  /** Default: survives with land. Or `{ killedAt }`, or "never-spawned" (neither). */
  fate?: "survives" | "never-spawned" | { killedAt: number };
  clientID?: string;
  username?: string;
  stats?: Record<string, unknown>;
  /** Took a gameplay action (an attack). Default: the game's `allAct`. */
  acts?: boolean;
  clanTag?: string | null;
  /**
   * The server turn this player's connection was last lost at, and never
   * restored (PlayerRecord.leftTurn). Only meaningful with the game's
   * `resultTurn`: a player without it was connected when the record was written.
   */
  leftTurn?: number;
}

export interface GameSpec {
  players: PlayerSpec[];
  /** Default: the first player wins. null: the game ended without a winner. */
  winner?: string[] | null;
  type?: "Public" | "Private" | "Singleplayer";
  /** Whether a private lobby was publicly listed (info.listed). */
  listed?: boolean;
  mode?: "Free For All" | "Team";
  difficulty?: "Easy" | "Medium" | "Hard" | "Impossible";
  playerTeams?: string;
  durationSeconds?: number;
  /** When the game ended, in ms since the epoch. */
  endMs?: number;
  lastTurn?: number;
  /** Every player took a gameplay action unless their spec says otherwise. */
  allAct?: boolean;
  /** Extra stamped intents, placed in turn 2 (e.g. admin commands). */
  extraIntents?: unknown[];
  /** The server's record of staff commands (info.adminActions). */
  adminActions?: unknown[];
  /**
   * The turn the result was determined at (info.resultTurn). Setting it makes
   * this a record from the current game server, whose roster says who stayed
   * (`leftTurn`); without it the record is judged by its heartbeat intents only.
   */
  resultTurn?: number;
  disconnects?: Array<{
    clientID: string;
    turn: number;
    isDisconnected: boolean;
  }>;
}

export const clientIdOf = (index: number): string => `pl00000${index + 1}`;

/** Where games end in the tests unless a test says otherwise: noon UTC, 14 Nov 2023. */
export const DEFAULT_END_MS = Date.UTC(2023, 10, 14, 12, 0, 0);

/** A finished game as the game server archives it, checked against the real GameRecordSchema. */
export function buildRecord(gameID: string, spec: GameSpec): GameRecord {
  const duration = spec.durationSeconds ?? 600;
  const end = spec.endMs ?? DEFAULT_END_MS;
  const lastTurn = spec.lastTurn ?? duration * 10;
  const players = spec.players.map((p, i) => {
    const clientID = p.clientID ?? clientIdOf(i);
    const fate = p.fate ?? "survives";
    const stats: Record<string, unknown> = { attacks: ["100", "40", "0"] };
    if (fate === "survives") stats.finalTiles = "500";
    else if (fate !== "never-spawned") stats.killedAt = String(fate.killedAt);
    Object.assign(stats, p.stats);
    return {
      clientID,
      username: p.username ?? `Player${i + 1}`,
      clanTag: p.clanTag ?? null,
      persistentID: p.user?.id ?? randomUUID(),
      stats,
      ...(p.leftTurn === undefined ? {} : { leftTurn: p.leftTurn }),
    };
  });
  const winner =
    spec.winner === null
      ? undefined
      : (spec.winner ?? ["player", players[0].clientID]);

  const intents = new Map<number, unknown[]>([
    [0, []],
    [lastTurn, []],
  ]);
  const acting = players.filter(
    (_, i) => spec.players[i].acts ?? spec.allAct ?? false,
  );
  if (acting.length > 0 || (spec.extraIntents ?? []).length > 0) {
    intents.set(1, [
      ...acting.map((p) => ({
        type: "attack",
        targetID: null,
        troops: null,
        clientID: p.clientID,
      })),
    ]);
    if ((spec.extraIntents ?? []).length > 0) {
      intents.set(2, [...(spec.extraIntents ?? [])]);
    }
  }
  for (const d of spec.disconnects ?? []) {
    const list = intents.get(d.turn) ?? [];
    list.push({
      type: "mark_disconnected",
      isDisconnected: d.isDisconnected,
      clientID: d.clientID,
    });
    intents.set(d.turn, list);
  }
  const turns = [...intents.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([turnNumber, list]) => ({ turnNumber, intents: list }));

  const record = {
    version: "v0.0.2",
    gitCommit: "0123456789abcdef0123456789abcdef01234567",
    domain: "localhost",
    subdomain: "a",
    info: {
      gameID,
      lobbyCreatedAt: end - duration * 1000 - 60_000,
      visibleAt: end - duration * 1000 - 60_000,
      lobbyFillTime: 1000,
      start: end - duration * 1000,
      end,
      duration,
      num_turns: lastTurn + 1,
      ...(winner === undefined ? {} : { winner }),
      publicGameType: "ffa",
      reports: [],
      ...(spec.listed === undefined ? {} : { listed: spec.listed }),
      ...(spec.resultTurn === undefined ? {} : { resultTurn: spec.resultTurn }),
      ...(spec.adminActions === undefined
        ? {}
        : { adminActions: spec.adminActions }),
      config: {
        gameMap: "Africa",
        difficulty: spec.difficulty ?? "Medium",
        donateGold: true,
        donateTroops: true,
        gameType: spec.type ?? "Public",
        gameMode: spec.mode ?? "Free For All",
        ...(spec.playerTeams === undefined
          ? {}
          : { playerTeams: spec.playerTeams }),
        gameMapSize: "Normal",
        nations: "default",
        bots: 100,
        infiniteGold: false,
        infiniteTroops: false,
        instantBuild: false,
        randomSpawn: false,
      },
      players,
    },
    turns,
  };
  const parsed = GameRecordSchema.safeParse(record);
  if (!parsed.success)
    throw new Error(
      `fixture is not a valid GameRecord: ${parsed.error.message}`,
    );
  return record as unknown as GameRecord;
}

/** A game server submitting a record (no Origin, a server key), the way Archive.ts does. */
export function submitGame(
  h: Harness,
  key: string | undefined,
  record: unknown,
  gameID: string = (record as GameRecord).info.gameID,
): Promise<Response> {
  return call(h, `/game/${gameID}`, {
    method: "POST",
    json: record,
    origin: null,
    headers: key === undefined ? {} : { "x-api-key": key },
  });
}

export async function creditsOf(h: Harness, user: TestUser): Promise<number> {
  const { rows } = await h.db.pool.query<{ credits: string }>(
    "SELECT credits::text AS credits FROM wallets WHERE user_id = $1",
    [user.id],
  );
  return Number(rows[0].credits);
}

/** What /users/@me says for this user. */
export async function userMe(h: Harness, user: TestUser) {
  const res = await call(h, "/users/@me", { bearer: user.jwt, origin: null });
  return { status: res.status, body: await res.json() };
}
