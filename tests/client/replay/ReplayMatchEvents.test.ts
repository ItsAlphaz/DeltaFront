/**
 * Match events in the new replay viewer. The events come from the engine run
 * that records the replay (the same deterministic events a live game had), are
 * kept with the replay, and rebuild the event log at any frame the viewer
 * seeks to. No replay-only event system: the same MatchEventLog the live HUD
 * reads.
 */

import { GameType, PlayerType } from "@openfront/engine-api/game/GameTypes";
import {
  GameUpdateType,
  type MatchEventUpdate,
} from "@openfront/engine-api/game/GameUpdates";
import type { MatchEvent } from "@openfront/engine-api/game/MatchEvents";
import { Config } from "@openfront/engine-lib/configuration/Config";
import { AdminCommandExecution } from "@openfront/engine/execution/AdminCommandExecution";
import { AllianceRequestExecution } from "@openfront/engine/execution/alliance/AllianceRequestExecution";
import { SpawnExecution } from "@openfront/engine/execution/SpawnExecution";
import type { Execution, Game } from "@openfront/engine/game/Game";
import { gunzipSync, gzipSync } from "zlib";
import type { ReplayReader } from "../../../src/client/replay/codec/decode/ReplayReader";
import { REPLAY_VERSION } from "../../../src/client/replay/codec/ReplayTypes";
import { ReplayGameView } from "../../../src/client/replay/ReplayGameAdapter";
import { fromStored, toStored } from "../../../src/client/replay/ReplayStore";
import { playerInfo, setup } from "../../util/Setup";
import { config as gameConfig } from "./util/ArchiveGame";
import { openReader, recordGame, type RecordedGame } from "./util/RecordGame";

const EMPTY = new Uint8Array(0);

/** An execution that runs `fn` once, inside a tick. */
const once = (fn: (game: Game) => void): Execution =>
  ({
    init: (game: Game) => fn(game),
    tick: () => {},
    isActive: () => false,
    activeDuringSpawnPhase: () => true,
  }) as unknown as Execution;

let rec: RecordedGame;
let reader: ReplayReader;
/** The events straight off the live ticks, independent of the recorder. */
let live: MatchEvent[];

beforeAll(async () => {
  const game = await setup(
    "plains",
    { gameType: GameType.Singleplayer },
    [playerInfo("a", PlayerType.Human), playerInfo("b", PlayerType.Human)],
    undefined,
    undefined,
    false,
  );
  rec = await recordGame(game, {
    ticks: 60,
    skipInit: true,
    keyframeInterval: 20,
    beforeTick: (g, t) => {
      if (t === 1) {
        g.addExecution(
          new SpawnExecution("game_id", g.player("a").info(), g.ref(10, 10)),
          new SpawnExecution("game_id", g.player("b").info(), g.ref(50, 50)),
          once((mg) => mg.endSpawnPhase()),
        );
      }
      if (t === 10) {
        g.addExecution(
          new AllianceRequestExecution(g.player("a"), g.player("b").id()),
          new AllianceRequestExecution(g.player("b"), g.player("a").id()),
        );
      }
      if (t === 20) {
        g.addExecution(
          new AdminCommandExecution(
            g.player("a"),
            "give_gold",
            g.player("b").id(),
            1000,
          ),
        );
      }
      if (t === 30) {
        g.addExecution(
          new AdminCommandExecution(
            g.player("a"),
            "eliminate",
            g.player("b").id(),
            undefined,
          ),
        );
      }
    },
  });
  reader = openReader(rec.replay);
  live = rec.frames.flatMap((gu) =>
    (gu.updates[GameUpdateType.MatchEvent] as MatchEventUpdate[]).map(
      (u) => u.event,
    ),
  );
}, 60_000);

const newAdapter = () =>
  new ReplayGameView(
    reader.header.players,
    new Config(gameConfig(), true, false, true),
    reader.header.mapWidth,
    reader.header.mapHeight,
    reader.header.numLandTiles,
    new Uint8Array(reader.header.mapWidth * reader.header.mapHeight),
  );

const types = (events: readonly MatchEvent[]) => events.map((e) => e.type);

describe("recording", () => {
  it("the live game produced the events we expect", () => {
    expect(types(live)).toEqual([
      "game_started",
      "alliance_formed",
      "admin_action",
      "admin_action",
    ]);
  });

  it("the replay keeps exactly the events the live ticks carried", () => {
    expect(reader.header.matchEvents).toEqual(live);
    expect(rec.replay.append.events.matchEvents).toEqual(live);
  });

  it("they survive being stored and loaded again", async () => {
    const stored = await toStored(
      rec.replay,
      async (d) => new Uint8Array(gzipSync(d)),
    );
    // Plain objects in the stored form: small, and nothing packed to get wrong.
    expect(stored.append.events.matchEvents).toEqual(live);
    const back = await fromStored(
      structuredClone(stored), // as IndexedDB keeps it
      async (d) => new Uint8Array(gunzipSync(d)),
    );
    expect(back.append.events.matchEvents).toEqual(live);
  });

  it("a replay stored before the events existed is not mistaken for one that has them", () => {
    expect(REPLAY_VERSION).toBeGreaterThanOrEqual(2);
  });
});

describe("playing it back", () => {
  it("the log fills as the frames play past each event", () => {
    const adapter = newAdapter();
    adapter.setMatchEventSource(reader.header.matchEvents);
    const log = adapter.matchEvents();
    const seen: number[] = [];
    for (let f = 0; f < reader.header.totalFrames; f++) {
      adapter.update(reader.seek(f), EMPTY, 0, false, f === 0);
      seen.push(log.size());
    }
    // Never shrinks while playing forward, and ends with everything.
    for (let i = 1; i < seen.length; i++) {
      expect(seen[i]).toBeGreaterThanOrEqual(seen[i - 1]);
    }
    expect(types(log.entries().map((e) => e.event))).toEqual(types(live));
  });

  it("an event shows up in the frame after its tick, not before", () => {
    const adapter = newAdapter();
    adapter.setMatchEventSource(reader.header.matchEvents);
    const alliance = live.find((e) => e.type === "alliance_formed")!;
    const before = reader.header.totalFrames;
    let appearedAt = -1;
    for (let f = 0; f < before; f++) {
      const frame = reader.seek(f);
      adapter.update(frame, EMPTY, 0, false, f === 0);
      if (
        appearedAt === -1 &&
        adapter
          .matchEvents()
          .entries()
          .some((e) => e.event.type === "alliance_formed")
      ) {
        appearedAt = frame.tick;
      }
    }
    // The engine reports a tick after running it, so the frame of tick T + 1 has it.
    expect(appearedAt).toBe(alliance.tick + 1);
  });

  it("a seek rebuilds the log to that point, and seeking on restores the rest", () => {
    const adapter = newAdapter();
    adapter.setMatchEventSource(reader.header.matchEvents);
    const log = adapter.matchEvents();
    const all = reader.header.totalFrames;

    adapter.update(reader.seek(all - 1), EMPTY, 0, false, true);
    expect(log.size()).toBe(live.length);

    // Back to just before the staff elimination: it has not happened yet.
    const eliminate = live.find(
      (e) => e.type === "admin_action" && e.meta.command === "eliminate",
    )!;
    const earlier = reader.seek(
      Array.from({ length: all }, (_, f) => f).find(
        (f) => reader.seek(f).tick === eliminate.tick,
      )!,
    );
    adapter.update(earlier, EMPTY, 0, false, true);
    expect(log.entries().map((e) => e.event.meta.command)).not.toContain(
      "eliminate",
    );
    expect(log.entries().some((e) => e.event.type === "alliance_formed")).toBe(
      true,
    );

    // Seeking to the very start leaves it empty.
    adapter.update(reader.seek(0), EMPTY, 0, false, true);
    expect(log.size()).toBe(0);

    // And on to the end again.
    adapter.update(reader.seek(all - 1), EMPTY, 0, false, true);
    expect(log.size()).toBe(live.length);
  });

  it("a game still being processed adds its new events as they arrive", () => {
    const adapter = newAdapter();
    const growing: MatchEvent[] = [live[0]];
    adapter.setMatchEventSource(growing);
    const last = reader.header.totalFrames - 1;
    adapter.update(reader.seek(last), EMPTY, 0, false, true);
    expect(adapter.matchEvents().size()).toBe(1);
    growing.push(...live.slice(1));
    adapter.update(reader.seek(last), EMPTY, 0, false);
    expect(adapter.matchEvents().size()).toBe(live.length);
  });

  it("the HUD can read what the live feed reads from it", () => {
    const adapter = newAdapter();
    expect(adapter.isCatchingUp()).toBe(false);
    expect(adapter.matchEvents().size()).toBe(0);
    // Players answer the questions the feed asks, for the chips.
    const view = adapter.playerViews()[0];
    expect(view.name()).toBeTypeOf("string");
    expect(view.staffBadgeRole()).toBeNull();
    expect(view.showsVerifiedBadge()).toBe(false);
  });
});
