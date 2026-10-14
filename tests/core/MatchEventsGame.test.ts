/**
 * The match feed through the real engine runner, the way clients and a replay
 * run a game: the same turns in, the same events out. The events are the
 * engine's own (nobody can submit one), carried on the tick updates, and a
 * replay that re-runs the record gets exactly the ones the live game had.
 */

import { GameMapType } from "@openfront/engine-api/game/GameTypes";
import {
  GameUpdateType,
  type MatchEventUpdate,
} from "@openfront/engine-api/game/GameUpdates";
import type { MatchEvent } from "@openfront/engine-api/game/MatchEvents";
import { StampedIntentSchema, type Turn } from "@openfront/engine-api/Schemas";
import {
  createGameRunner,
  type GameRunner,
} from "@openfront/engine/GameRunner";
import { loadMapFiles } from "@openfront/shared/GameMapLoader";
import { toWireGameStartInfo } from "@openfront/shared/SharedUtil";
import {
  config,
  human,
  mapLoader,
  spawnOnLand,
} from "../client/replay/util/ArchiveGame";

type Intents = Parameters<GameRunner["addTurn"]>[0]["intents"];

async function newRunner(sink: MatchEvent[]): Promise<GameRunner> {
  const start = toWireGameStartInfo({
    gameID: "matchev01",
    lobbyCreatedAt: 1_700_000_000_000,
    config: config({ gameMap: GameMapType.Onion, bots: 0 }),
    players: [human(1), human(2)],
  });
  const map = await loadMapFiles(
    mapLoader,
    start.config.gameMap,
    start.config.gameMapSize,
  );
  return createGameRunner(start, undefined, map, (gu) => {
    if ("errMsg" in gu) throw new Error(gu.errMsg);
    for (const u of gu.updates[
      GameUpdateType.MatchEvent
    ] as MatchEventUpdate[]) {
      sink.push(u.event);
    }
  });
}

/** Plays the turns on a fresh runner; returns the events it reported. */
async function playTurns(
  turns: (game: GameRunner["game"], n: number) => Intents,
  count: number,
): Promise<{ events: MatchEvent[]; runner: GameRunner; played: Turn[] }> {
  const events: MatchEvent[] = [];
  const runner = await newRunner(events);
  const played: Turn[] = [];
  for (let n = 0; n < count; n++) {
    const turn: Turn = { turnNumber: n, intents: turns(runner.game, n) };
    played.push(turn);
    runner.addTurn(turn);
    expect(runner.executeNextTick()).toBe(true);
  }
  return { events, runner, played };
}

const SPAWN_TURNS = 401;

/** Both spawn, the spawn phase runs out, then a scripted stretch of play. */
function script(game: GameRunner["game"], n: number): Intents {
  if (n === 0) {
    return [
      spawnOnLand(game, "client001", 1000),
      spawnOnLand(game, "client002", 90_000),
    ];
  }
  const a = game.playerByClientID("client001");
  const b = game.playerByClientID("client002");
  if (a === null || b === null || n < SPAWN_TURNS) return [];
  switch (n - SPAWN_TURNS) {
    case 1:
      return [
        { type: "allianceRequest", recipient: b.id(), clientID: "client001" },
      ];
    case 3:
      return [
        { type: "allianceRequest", recipient: a.id(), clientID: "client002" },
      ];
    case 8:
      return [
        { type: "breakAlliance", recipient: a.id(), clientID: "client002" },
      ];
    case 12:
      return [
        {
          type: "admin_command",
          command: "give_gold",
          target: b.id(),
          amount: 1000,
          clientID: "client001",
        },
      ];
    case 14:
      return [
        {
          type: "admin_command",
          command: "eliminate",
          target: b.id(),
          clientID: "client001",
        },
      ];
    case 20:
      return [
        {
          type: "admin_command",
          command: "force_win",
          target: a.id(),
          clientID: "client001",
        },
      ];
    default:
      return [];
  }
}

const TURNS = SPAWN_TURNS + 30;

test("a game's real transitions produce its events, in order, on the right ticks", async () => {
  const { events, runner } = await playTurns(script, TURNS);
  // A public game: the owner's staff action is announced there too.
  expect(runner.game.config().gameConfig().gameType).toBe("Public");
  const a = runner.game.playerByClientID("client001")!.smallID();
  const b = runner.game.playerByClientID("client002")!.smallID();
  const summary = events.map((e) => [
    e.type,
    e.actor,
    e.target,
    e.meta.command ?? e.meta.cause ?? null,
    e.severity,
  ]);
  expect(summary).toEqual([
    ["game_started", null, null, null, "normal"],
    ["alliance_formed", a, b, null, "normal"],
    ["alliance_broken", b, a, "broken", "major"],
    ["admin_action", a, b, "give_gold", "major"],
    ["admin_action", a, b, "eliminate", "major"],
    ["admin_action", a, a, "force_win", "critical"],
    ["game_ending", a, null, null, "critical"],
  ]);
  // Numbered 0, 1, 2... and on non-decreasing ticks.
  events.forEach((e, i) => {
    expect(e.seq).toBe(i);
    if (i > 0) expect(e.tick).toBeGreaterThanOrEqual(events[i - 1].tick);
  });
  // The staff elimination is one line, not also an anonymous "was eliminated".
  expect(events.filter((e) => e.type === "player_eliminated")).toEqual([]);
}, 120_000);

test("a replay that re-runs the record gets the same events on the same ticks", async () => {
  const live = await playTurns(script, TURNS);
  expect(live.events.length).toBeGreaterThan(0);

  const replayed: MatchEvent[] = [];
  const replay = await newRunner(replayed);
  for (const turn of live.played) {
    replay.addTurn(turn);
    expect(replay.executeNextTick()).toBe(true);
  }
  expect(replayed).toEqual(live.events);
}, 120_000);

test("a client cannot dress an intent up as someone else or carry an event with it", async () => {
  // What the game server does with whatever a client sends: parse it against
  // the intent schema, then stamp the sender's own clientID on it.
  const forged = StampedIntentSchema.parse({
    type: "admin_command",
    command: "give_gold",
    target: "targetpl1",
    amount: 5,
    clientID: "client002",
    actor: 1,
    issuer: "client001",
    event: { type: "player_eliminated", actor: 1, target: 2 },
    matchEvent: { type: "game_ending" },
  }) as Record<string, unknown>;
  expect(Object.keys(forged).sort()).toEqual(
    ["amount", "clientID", "command", "target", "type"].sort(),
  );
  expect(forged).not.toHaveProperty("event");
  expect(forged).not.toHaveProperty("actor");

  // And the actor of an event is whoever the turn says sent the intent.
  const { events, runner } = await playTurns((game, n) => {
    if (n === 0) {
      return [
        spawnOnLand(game, "client001", 1000),
        spawnOnLand(game, "client002", 90_000),
      ];
    }
    const a = game.playerByClientID("client001");
    if (n === SPAWN_TURNS && a !== null) {
      return [
        {
          type: "admin_command",
          command: "give_gold",
          target: a.id(),
          amount: 5,
          clientID: "client002",
        },
      ];
    }
    return [];
  }, SPAWN_TURNS + 3);
  const sender = runner.game.playerByClientID("client002")!.smallID();
  const action = events.find((e) => e.type === "admin_action")!;
  expect(action.actor).toBe(sender);
}, 120_000);
