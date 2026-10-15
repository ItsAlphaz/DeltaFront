import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GameType } from "@openfront/engine-api/game/GameTypes";
import { ACCOUNT_FEATURES } from "@openfront/shared/AccountFeatures";
import type { LiveProgress } from "@openfront/shared/LiveProgress";
import {
  ClientMessage,
  LiveStats,
  PartialGameRecord,
  PlayerLiveStats,
} from "@openfront/shared/WireSchemas";
import { buildProgress, ProgressTracker } from "../../src/server/ProgressFeed";
import {
  cid,
  makeClient,
  makeGame,
  makeMockWs,
  mockWsOf,
  startGame,
} from "../util/GameServerHarness";

// What the game server reports to the account API about a running game, from its
// own state: the majority-voted live stats, its roster and clock, the intents it
// stamps. Nothing a single client says is taken on trust, and a report is only
// data: it never awards anything.

const T0 = 1_700_000_000_000;
const TURN_MS = 100;
const HOST = cid("host");
const P2 = cid("p2");
const P3 = cid("p3");
const P4 = cid("p4");
const WATCH = cid("watch");

const report = vi.fn(async (_p: LiveProgress) => {});
const archive = vi.fn(async (_r: PartialGameRecord) => {});

function boot(config: Record<string, unknown> = {}) {
  const game = makeGame({
    id: cid("progress"),
    creatorPersistentID: "host-pid",
    config: { gameType: GameType.Private, maxPlayers: 4, ...config },
    deps: { archive, reportProgress: report },
  });
  const clients = [
    makeClient({
      clientID: HOST,
      persistentID: "host-pid",
      ip: "1.1.1.1",
      publicId: "host-pub",
    }),
    makeClient({
      clientID: P2,
      persistentID: "p2-pid",
      ip: "2.2.2.2",
      publicId: "p2-pub",
    }),
    makeClient({
      clientID: P3,
      persistentID: "p3-pid",
      ip: "3.3.3.3",
      publicId: "p3-pub",
    }),
    makeClient({
      clientID: P4,
      persistentID: "p4-pid",
      ip: "4.4.4.4",
      publicId: "p4-pub",
    }),
    makeClient({
      clientID: WATCH,
      persistentID: "watch-pid",
      ip: "5.5.5.5",
      spectator: true,
    }),
  ];
  for (const c of clients) game.joinClient(c);
  startGame(game);
  const [host, p2, p3, p4, watcher] = clients;
  return { game, host, p2, p3, p4, watcher, all: clients };
}

const play = (turns: number) => vi.advanceTimersByTime(turns * TURN_MS);
const turnsOf = (game: unknown) => (game as { turns: unknown[] }).turns.length;

const stat = (
  clientID: string,
  over: Partial<PlayerLiveStats> = {},
): PlayerLiveStats => ({
  clientID,
  tilesOwned: 100,
  troops: 1000,
  gold: "0",
  isAlive: true,
  team: null,
  killedBy: null,
  deathPosition: null,
  ...over,
});

const snapshot = (
  turn: number,
  dead: Record<string, string | null> = {},
): LiveStats => ({
  turn,
  players: [HOST, P2, P3, P4].map((id) =>
    id in dead
      ? stat(id, { isAlive: false, killedBy: dead[id], deathPosition: 4 })
      : stat(id),
  ),
});

/** Three of the four IPs agree on a snapshot: a majority, so the server takes it. */
async function agree(clients: ReturnType<typeof boot>, stats: LiveStats) {
  const msg: ClientMessage = { type: "live_stats", stats };
  for (const c of [clients.host, clients.p2, clients.p3]) {
    await mockWsOf(c).emit(msg);
  }
}

const last = () => report.mock.calls[report.mock.calls.length - 1][0];
const winnerFor = (clientID: string): ClientMessage => ({
  type: "winner",
  winner: ["player", clientID],
  allPlayersStats: {},
});

describe("the progress feed", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    report.mockReset().mockResolvedValue(undefined);
    archive.mockReset();
  });
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  describe("what clients are asked to send", () => {
    it("every game's clients are told to report the live stats it votes on, with progression on", () => {
      const { game } = boot();
      const config = (
        game as unknown as {
          gameStartInfo: { config: { liveStatsEnabled?: boolean } };
        }
      ).gameStartInfo.config;
      expect(config.liveStatsEnabled).toBe(true);
    });

    it("and not with progression off: nothing then reports, nothing is asked for", async () => {
      ACCOUNT_FEATURES.progression = false;
      const g = boot();
      const config = (
        g.game as unknown as {
          gameStartInfo: { config: { liveStatsEnabled?: boolean } };
        }
      ).gameStartInfo.config;
      expect(config.liveStatsEnabled).toBeUndefined();
      await agree(g, snapshot(100));
      play(30);
      expect(report).not.toHaveBeenCalled();
    });
  });

  describe("what it reports", () => {
    it("nothing until a majority has agreed on a snapshot", async () => {
      const g = boot();
      play(30);
      expect(report).not.toHaveBeenCalled();
      // one client's word is not a majority
      await mockWsOf(g.host).emit({
        type: "live_stats",
        stats: snapshot(100, { [P2]: HOST }),
      });
      play(30);
      expect(report).not.toHaveBeenCalled();
    });

    it("a client cannot make the server report what a majority did not agree on", async () => {
      const g = boot();
      await agree(g, snapshot(100));
      play(10);
      expect(report).toHaveBeenCalledTimes(1);
      // p4 alone says p2 was eliminated by p4: no majority, no change
      await mockWsOf(g.p4).emit({
        type: "live_stats",
        stats: snapshot(200, { [P2]: P4 }),
      });
      play(20);
      for (const [p] of report.mock.calls) {
        expect(p.players.find((x) => x.clientID === P2)!.alive).toBe(true);
        expect(p.players.find((x) => x.clientID === P2)!.killedBy).toBeNull();
      }
    });

    it("who is alive and who eliminated whom, as the majority agreed", async () => {
      const g = boot();
      await agree(g, snapshot(100));
      play(10);
      await agree(g, snapshot(200, { [P2]: HOST }));
      play(10);
      const p = last();
      const by = (id: string) => p.players.find((x) => x.clientID === id)!;
      expect(by(HOST)).toMatchObject({ alive: true, killedBy: null });
      expect(by(P2)).toMatchObject({ alive: false, killedBy: HOST });
      // an elimination falls between two agreed snapshots
      expect(by(P2).aliveAtTurn).toBe(100);
      expect(by(P2).deadAtTurn).toBe(200);
      expect(by(HOST)).toMatchObject({ aliveAtTurn: 200, deadAtTurn: null });
    });

    it("only the players: a spectator is never in it", async () => {
      const g = boot();
      await agree(g, snapshot(100));
      play(10);
      expect(
        last()
          .players.map((p) => p.clientID)
          .sort(),
      ).toEqual([HOST, P2, P3, P4].sort());
    });

    it("the account each connection belongs to, and who is connected", async () => {
      const g = boot();
      await agree(g, snapshot(100));
      play(10);
      expect(last().players.find((p) => p.clientID === P2)).toMatchObject({
        persistentID: "p2-pid",
        connected: true,
        leftTurn: null,
      });
    });

    it("the game's kind, mode and listing, and how long it has run", async () => {
      const g = boot();
      await agree(g, snapshot(100));
      play(10);
      const p = last();
      expect(p.config).toMatchObject({
        gameType: "Private",
        gameMode: "Free For All",
        rankedType: null,
      });
      expect(p.gameID).toBe(cid("progress"));
      expect(p.turn).toBe(turnsOf(g.game));
      expect(p.elapsedSeconds).toBeGreaterThan(0);
      expect(p.result).toBeNull();
    });

    it("who acted: attacks and builds count, spawning and chat do not", async () => {
      const g = boot();
      await mockWsOf(g.p2).emit({
        type: "intent",
        intent: { type: "spawn", tile: 1 },
      });
      await mockWsOf(g.p3).emit({
        type: "intent",
        intent: { type: "attack", targetID: null, troops: null },
      });
      play(2);
      await agree(g, snapshot(100));
      play(10);
      const acted = (id: string) =>
        last().players.find((p) => p.clientID === id)!.acted;
      expect(acted(P3)).toBe(true);
      expect(acted(P2)).toBe(false);
      expect(acted(HOST)).toBe(false);
    });

    it("who ran staff commands, and the staff commands themselves", async () => {
      const g = boot();
      (g.game as unknown as { addIntent(i: unknown): void }).addIntent({
        type: "admin_command",
        command: "give_gold",
        target: P2,
        amount: 1,
        clientID: P4,
      });
      await agree(g, snapshot(100));
      play(10);
      expect(last().adminSenders).toEqual([P4]);
    });
  });

  describe("when it reports", () => {
    it("on each new agreed snapshot, not again for the same one", async () => {
      const g = boot();
      await agree(g, snapshot(100));
      play(10);
      expect(report).toHaveBeenCalledTimes(1);
      play(40);
      expect(report).toHaveBeenCalledTimes(1);
      await agree(g, snapshot(200));
      play(10);
      expect(report).toHaveBeenCalledTimes(2);
    });

    it("when someone leaves, at the next second, and again when they come back", async () => {
      const g = boot();
      await agree(g, snapshot(100));
      play(10);
      const before = report.mock.calls.length;
      play(5);
      const atLeave = turnsOf(g.game);
      await mockWsOf(g.p4).trigger("close");
      play(10);
      expect(report.mock.calls.length).toBe(before + 1);
      expect(last().players.find((p) => p.clientID === P4)).toMatchObject({
        connected: false,
        leftTurn: atLeave,
      });
      // back on a new connection
      expect(g.game.rejoinClient(makeMockWs() as never, "p4-pid", 5)).toBe(
        true,
      );
      play(10);
      expect(report.mock.calls.length).toBe(before + 2);
      expect(last().players.find((p) => p.clientID === P4)).toMatchObject({
        connected: true,
        leftTurn: null,
      });
    });

    it("is fire and forget: a failing report never touches the game", async () => {
      report.mockReset().mockRejectedValue(new Error("api down"));
      const g = boot();
      await agree(g, snapshot(100));
      play(10);
      play(40);
      expect(turnsOf(g.game)).toBeGreaterThan(40);
    });
  });

  describe("when the result is settled", () => {
    async function settle(g: ReturnType<typeof boot>) {
      await agree(g, snapshot(100));
      play(10);
      for (const c of [g.host, g.p2, g.p3])
        await mockWsOf(c).emit(winnerFor(HOST));
    }

    it("tells the API the result before the record goes up", async () => {
      const g = boot();
      await settle(g);
      expect(archive).toHaveBeenCalledOnce();
      const settled = report.mock.calls
        .map(([p]) => p)
        .find((p) => p.result !== null)!;
      expect(settled.result).toEqual({
        winner: ["player", HOST],
        resultTurn: archive.mock.calls[0][0].info.resultTurn,
      });
      // the first thing sent, before the (larger) record was handed on
      const reportAt =
        report.mock.invocationCallOrder[
          report.mock.calls.findIndex(([p]) => p.result !== null)
        ];
      expect(reportAt).toBeLessThan(archive.mock.invocationCallOrder[0]);
    });

    it("the winner leaving between the result and the stored game is on the record", async () => {
      const g = boot();
      await agree(g, snapshot(100));
      play(10);
      await mockWsOf(g.host).emit(winnerFor(HOST));
      play(4);
      await mockWsOf(g.host).trigger("close");
      play(2);
      await mockWsOf(g.p2).emit(winnerFor(HOST));
      await mockWsOf(g.p3).emit(winnerFor(HOST));
      const settled = report.mock.calls
        .map(([p]) => p)
        .find((p) => p.result !== null)!;
      const host = settled.players.find((p) => p.clientID === HOST)!;
      expect(host.connected).toBe(false);
      // left at or after the result: the API reads that as leaving after it
      expect(host.leftTurn!).toBeGreaterThanOrEqual(settled.result!.resultTurn);
    });

    it("stops there: nothing more is reported once the game is archived", async () => {
      const g = boot();
      await settle(g);
      const sent = report.mock.calls.length;
      await agree(g, snapshot(300));
      play(60);
      expect(report.mock.calls.length).toBe(sent);
    });

    it("a game cancelled without a winner has no result to report", async () => {
      const g = boot();
      await agree(g, snapshot(100));
      play(10);
      await g.game.end();
      for (const [p] of report.mock.calls) expect(p.result).toBeNull();
    });
  });
});

describe("ProgressTracker", () => {
  it("is alive until first seen dead, and remembers the last turn it was alive at", () => {
    const t = new ProgressTracker();
    t.observe(snapshot(100));
    t.observe(snapshot(200));
    t.observe(snapshot(300, { [P2]: HOST }));
    t.observe(snapshot(400, { [P2]: HOST }));
    expect(t.window(P2)).toEqual({ aliveAtTurn: 200, deadAtTurn: 300 });
    expect(t.window(HOST)).toEqual({ aliveAtTurn: 400, deadAtTurn: null });
    expect(t.window("nobody01")).toEqual({
      aliveAtTurn: null,
      deadAtTurn: null,
    });
  });

  it("reads each snapshot once, and never goes back", () => {
    const t = new ProgressTracker();
    t.observe(snapshot(300, { [P2]: HOST }));
    t.observe(snapshot(200));
    t.observe(snapshot(300));
    expect(t.turn).toBe(300);
    expect(t.window(P2).aliveAtTurn).toBeNull();
    expect(t.window(P2).deadAtTurn).toBe(300);
  });

  it("a player seen dead is not revived by a later snapshot", () => {
    const t = new ProgressTracker();
    t.observe(snapshot(100, { [P2]: HOST }));
    t.observe(snapshot(200, { [P2]: HOST }));
    expect(t.window(P2).deadAtTurn).toBe(100);
  });

  it("counts gameplay as acting, nothing else, and notes who sent staff commands", () => {
    const t = new ProgressTracker();
    for (const type of [
      "spawn",
      "emoji",
      "quick_chat",
      "toggle_pause",
      "mark_disconnected",
    ]) {
      t.noteIntent({ type, clientID: HOST });
    }
    expect(t.hasActed(HOST)).toBe(false);
    for (const type of [
      "attack",
      "boat",
      "build_unit",
      "allianceRequest",
      "donate_gold",
    ]) {
      t.noteIntent({ type, clientID: P2 });
    }
    expect(t.hasActed(P2)).toBe(true);
    t.noteIntent({ type: "admin_command", clientID: P3 });
    expect(t.senders()).toEqual([P3]);
    // an intent that names nobody is ignored
    t.noteIntent({ type: "attack" });
    expect(t.hasActed("undefined")).toBe(false);
  });

  it("builds a report before any snapshot with everyone alive", () => {
    const t = new ProgressTracker();
    const p = buildProgress(t, {
      gameID: "gABC12345",
      turn: 5,
      elapsedSeconds: 1,
      config: {
        gameType: "Public",
        gameMode: "Free For All",
        rankedType: null,
        listed: null,
      },
      adminActions: [],
      result: null,
      live: null,
      roster: [
        { clientID: HOST, persistentID: "u1", connected: true, leftTurn: null },
      ],
    });
    expect(p.players).toEqual([
      {
        clientID: HOST,
        persistentID: "u1",
        alive: true,
        killedBy: null,
        aliveAtTurn: null,
        deadAtTurn: null,
        connected: true,
        leftTurn: null,
        acted: false,
      },
    ]);
  });

  it("a player the live stats do not list stays alive and unobserved", () => {
    const t = new ProgressTracker();
    const p = buildProgress(t, {
      gameID: "gABC12345",
      turn: 5,
      elapsedSeconds: 1,
      config: {
        gameType: "Public",
        gameMode: "Free For All",
        rankedType: null,
        listed: null,
      },
      adminActions: [],
      result: null,
      live: { turn: 100, players: [stat(HOST)] },
      roster: [
        { clientID: HOST, persistentID: "u1", connected: true, leftTurn: null },
        { clientID: P2, persistentID: null, connected: false, leftTurn: 40 },
      ],
    });
    expect(p.players[1]).toMatchObject({
      alive: true,
      aliveAtTurn: null,
      persistentID: null,
      connected: false,
      leftTurn: 40,
    });
  });
});
