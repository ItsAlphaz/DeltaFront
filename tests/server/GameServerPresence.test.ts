import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GameType } from "@openfront/engine-api/game/GameTypes";
import {
  ClientMessage,
  PartialGameRecord,
} from "@openfront/shared/WireSchemas";
import {
  cid,
  makeClient,
  makeGame,
  makeMockWs,
  mockWsOf,
  startGame,
} from "../util/GameServerHarness";

// What the game server stamps into the archived record so the account API can
// tell who stayed to the result: each player still gone when it was written
// (`leftTurn`, the server turn their connection was lost at, cleared when they
// come back) and the turn the result was determined (`resultTurn`). Both come
// from the server's own roster and clock, never from a client message.

const archive = vi.fn(async (_record: PartialGameRecord) => {});
const T0 = 1_700_000_000_000;
const TURN_MS = 100;

const HOST = cid("host");
const P2 = cid("p2");
const P3 = cid("p3");
const P4 = cid("p4");
const WATCH = cid("watch");

function boot(
  extra: { replayWinner?: any } = {},
  config: Record<string, unknown> = {},
) {
  const game = makeGame({
    id: cid("presence"),
    creatorPersistentID: "host-pid",
    config: { gameType: GameType.Private, maxPlayers: 4, ...config },
    deps: { archive, ...extra },
  });
  const host = makeClient({
    clientID: HOST,
    persistentID: "host-pid",
    ip: "1.1.1.1",
    publicId: "host-pub",
  });
  const p2 = makeClient({
    clientID: P2,
    persistentID: "p2-pid",
    ip: "2.2.2.2",
    publicId: "p2-pub",
  });
  const p3 = makeClient({
    clientID: P3,
    persistentID: "p3-pid",
    ip: "3.3.3.3",
    publicId: "p3-pub",
  });
  const p4 = makeClient({
    clientID: P4,
    persistentID: "p4-pid",
    ip: "4.4.4.4",
    publicId: "p4-pub",
  });
  const watcher = makeClient({
    clientID: WATCH,
    persistentID: "watch-pid",
    ip: "5.5.5.5",
    spectator: true,
  });
  for (const c of [host, p2, p3, p4, watcher]) game.joinClient(c);
  startGame(game);
  return { game, host, p2, p3, p4, watcher };
}

const turnsOf = (game: unknown) => (game as { turns: unknown[] }).turns.length;
const play = (turns: number) => vi.advanceTimersByTime(turns * TURN_MS);
const winnerFor = (clientID: string): ClientMessage => ({
  type: "winner",
  winner: ["player", clientID],
  allPlayersStats: {},
});
const archived = () => archive.mock.calls[0][0];
const playerRecord = (clientID: string) =>
  archived().info.players.find((p) => p.clientID === clientID)!;

describe("the archived record says who stayed", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    archive.mockReset();
  });
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("stamps the turn a player's connection was lost at", async () => {
    const { game, host, p2, p3, p4 } = boot();
    play(20);
    const turnAtLeave = turnsOf(game);
    await mockWsOf(p3).trigger("close");
    play(30);
    for (const c of [host, p2]) await mockWsOf(c).emit(winnerFor(HOST));
    await mockWsOf(p4).emit(winnerFor(HOST));

    expect(archive).toHaveBeenCalledOnce();
    expect(playerRecord(P3).leftTurn).toBe(turnAtLeave);
    // the others were connected when it was written
    for (const id of [HOST, P2, P4]) {
      expect(playerRecord(id).leftTurn).toBeUndefined();
    }
  });

  it("does not stamp a player who dropped and came back", async () => {
    const { game, host, p2, p3, p4 } = boot();
    play(20);
    const p3Ws = mockWsOf(p3);
    await p3Ws.trigger("close");
    play(10);
    expect(game.rejoinClient(makeMockWs() as any, "p3-pid", 5)).toBe(true);
    play(10);
    for (const c of [host, p2, p4]) await mockWsOf(c).emit(winnerFor(HOST));

    expect(playerRecord(P3).leftTurn).toBeUndefined();
  });

  it("a second drop, after coming back, is stamped at the second drop", async () => {
    const { game, host, p2, p3, p4 } = boot();
    play(10);
    await mockWsOf(p3).trigger("close");
    play(10);
    const again = makeMockWs();
    expect(game.rejoinClient(again as any, "p3-pid", 5)).toBe(true);
    play(10);
    const secondDrop = turnsOf(game);
    await again.trigger("close");
    play(10);
    for (const c of [host, p2, p4]) await mockWsOf(c).emit(winnerFor(HOST));

    expect(playerRecord(P3).leftTurn).toBe(secondDrop);
  });

  it("remembers the first drop, not the roster pruning the same player later", async () => {
    const { game, host, p2, p3, p4 } = boot();
    play(10);
    const turnAtLeave = turnsOf(game);
    await mockWsOf(p3).trigger("close");
    play(50);
    // a closed player is already off the roster, so pruning finds nobody new
    game.pruneStaleClients();
    for (const c of [host, p2, p4]) await mockWsOf(c).emit(winnerFor(HOST));

    expect(playerRecord(P3).leftTurn).toBe(turnAtLeave);
  });

  it("stamps a player cut off by a stale heartbeat", async () => {
    const { game, host, p2, p4 } = boot();
    play(10);
    const turnAtPrune = turnsOf(game);
    // everyone but p3 keeps pinging; p3 goes silent for over a minute
    vi.advanceTimersByTime(61_000);
    for (const c of [host, p2, p4]) c.lastPing = Date.now();
    game.pruneStaleClients();
    for (const c of [host, p2, p4]) await mockWsOf(c).emit(winnerFor(HOST));

    expect(playerRecord(P3).leftTurn).toBeGreaterThanOrEqual(turnAtPrune);
    expect(playerRecord(HOST).leftTurn).toBeUndefined();
  });

  it("stamps a kicked player", async () => {
    const { game, host, p2, p4 } = boot();
    play(25);
    const turnAtKick = turnsOf(game);
    game.kickClient(P3, "kick_reason.admin");
    play(10);
    for (const c of [host, p2, p4]) await mockWsOf(c).emit(winnerFor(HOST));

    expect(playerRecord(P3).leftTurn).toBe(turnAtKick);
  });

  it("never stamps a spectator, who has no result to leave", async () => {
    const { game, host, p2, p3, p4, watcher } = boot();
    play(10);
    await mockWsOf(watcher).trigger("close");
    play(10);
    for (const c of [host, p2, p3, p4]) {
      await mockWsOf(c).emit(winnerFor(HOST));
    }

    expect(archived().info.players.map((p) => p.clientID)).not.toContain(WATCH);
    expect(archived().info.players.every((p) => p.leftTurn === undefined)).toBe(
      true,
    );
    // and the server does not even keep a departure for them
    expect(
      (game as unknown as { leftAtTurn: Map<string, number> }).leftAtTurn.has(
        WATCH,
      ),
    ).toBe(false);
  });

  it("a client's own message cannot stamp anyone: only the roster does", async () => {
    const { host, p2, p3, p4 } = boot();
    play(10);
    // a spoofed vote carrying a fake field is just a vote
    const spoof = {
      ...winnerFor(HOST),
      leftTurn: 0,
      resultTurn: 0,
    } as unknown as ClientMessage;
    for (const c of [host, p2, p3]) await mockWsOf(c).emit(spoof);

    expect(archive).toHaveBeenCalledOnce();
    expect(archived().info.players.every((p) => p.leftTurn === undefined)).toBe(
      true,
    );
    expect(archived().info.resultTurn).toBeGreaterThan(0);
    void p4;
  });
});

describe("the turn the result was determined", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    archive.mockReset();
  });
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("is when the first vote for the settled winner arrived, not when it was settled", async () => {
    const { game, host, p2, p3, p4 } = boot();
    play(30);
    await mockWsOf(host).emit(winnerFor(HOST));
    const firstVote = turnsOf(game);
    play(7);
    await mockWsOf(p2).emit(winnerFor(HOST));
    play(3);
    await mockWsOf(p3).emit(winnerFor(HOST));

    expect(archive).toHaveBeenCalledOnce();
    expect(archived().info.resultTurn).toBe(firstVote);
    // the record itself runs to the settlement, ten turns later
    expect(archived().info.num_turns).toBe(firstVote + 10);
    void p4;
  });

  it("lets a player who left between the first vote and the settlement have left after the result", async () => {
    const { game, host, p2, p3, p4 } = boot();
    play(30);
    await mockWsOf(host).emit(winnerFor(HOST));
    play(4);
    // the winner sees "You won" and exits before the others' votes arrive
    const leftAt = turnsOf(game);
    await mockWsOf(host).trigger("close");
    play(4);
    await mockWsOf(p2).emit(winnerFor(HOST));
    await mockWsOf(p3).emit(winnerFor(HOST));

    expect(archive).toHaveBeenCalledOnce();
    expect(playerRecord(HOST).leftTurn).toBe(leftAt);
    expect(playerRecord(HOST).leftTurn!).toBeGreaterThanOrEqual(
      archived().info.resultTurn!,
    );
    void p4;
  });

  it("a player who left before the first vote left before the result", async () => {
    const { game, host, p2, p3, p4 } = boot();
    play(20);
    await mockWsOf(p4).trigger("close");
    const leftAt = turnsOf(game);
    play(20);
    for (const c of [host, p2, p3]) await mockWsOf(c).emit(winnerFor(HOST));

    expect(playerRecord(P4).leftTurn).toBe(leftAt);
    expect(playerRecord(P4).leftTurn!).toBeLessThan(
      archived().info.resultTurn!,
    );
  });

  it("is the tick of the server's own replay when it had to settle a dispute", async () => {
    const replayWinner = vi.fn(async () => ({
      winner: ["player", HOST] as ["player", string],
      allPlayersStats: {},
      tick: 42,
    }));
    const { host, p2, p3, p4 } = boot({ replayWinner });
    play(60);
    // one dissenter, then a majority for another winner: the server replays
    await mockWsOf(p2).emit(winnerFor(P2));
    await mockWsOf(host).emit(winnerFor(HOST));
    await mockWsOf(p3).emit(winnerFor(HOST));
    await mockWsOf(p4).emit(winnerFor(HOST));
    await vi.waitFor(() => expect(archive).toHaveBeenCalledOnce());

    expect(replayWinner).toHaveBeenCalledOnce();
    expect(archived().info.resultTurn).toBe(42);
  });

  it("is absent for a game with no winner", async () => {
    const { game } = boot();
    play(20);
    await game.end();

    // ended with nobody voting: nothing to settle but no winner either
    for (const call of archive.mock.calls) {
      expect(call[0].info.resultTurn).toBeUndefined();
    }
  });
});
