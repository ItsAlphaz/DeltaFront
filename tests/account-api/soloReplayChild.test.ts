// @vitest-environment node
import {
  Difficulty,
  GameMapSize,
  GameMapType,
  GameMode,
  GameType,
} from "@openfront/engine-api/game/GameTypes";
import { GameUpdateType } from "@openfront/engine-api/game/GameUpdates";
import type {
  GameConfig,
  GameStartInfo,
  Turn,
} from "@openfront/engine-api/Schemas";
import { createGameRunner } from "@openfront/engine/GameRunner";
import {
  loadMapFiles,
  type GameMapLoader,
  type MapData,
} from "@openfront/shared/GameMapLoader";
import fsp from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { replaySoloInChild } from "../../src/account-api/soloReplay";

// The real thing, with no stand-ins: a solo match played on the real engine and
// a real map, then replayed by the account API's own subprocess (its map files
// read from resources/maps, the way the API deploys). What the subprocess reports
// is what the XP rules are built on.

const HUMAN = "child001";
const MAPS = path.resolve("resources/maps");

class RealMaps implements GameMapLoader {
  getMapData(map: GameMapType): MapData {
    const key = (
      Object.keys(GameMapType) as Array<keyof typeof GameMapType>
    ).find((k) => GameMapType[k] === map)!;
    const dir = path.join(MAPS, key.toLowerCase());
    const bin = (n: string) => async () =>
      new Uint8Array(await fsp.readFile(path.join(dir, n)));
    return {
      mapBin: bin("map.bin"),
      map4xBin: bin("map4x.bin"),
      map16xBin: bin("map16x.bin"),
      manifest: async () =>
        JSON.parse(await fsp.readFile(path.join(dir, "manifest.json"), "utf8")),
      webpPath: "",
      layerPng: async () => {
        throw new Error("no layers");
      },
    };
  }
}

function startInfo(over: Partial<GameConfig> = {}): GameStartInfo {
  return {
    gameID: "childt01",
    lobbyCreatedAt: 0,
    config: {
      gameMap: GameMapType.World,
      gameMapSize: GameMapSize.Compact,
      gameType: GameType.Singleplayer,
      gameMode: GameMode.FFA,
      difficulty: Difficulty.Hard,
      donateGold: false,
      donateTroops: false,
      nations: "default",
      bots: 35,
      infiniteGold: false,
      infiniteTroops: false,
      instantBuild: false,
      randomSpawn: false,
      ...over,
    } as GameConfig,
    players: [{ clientID: HUMAN, username: "Child", clanTag: null }],
  };
}

/** Plays 400 ticks live (spawn, then attacks), with the hashes LocalServer stores. */
async function play(start: GameStartInfo): Promise<Turn[]> {
  const hashes = new Map<number, number>();
  const runner = await createGameRunner(
    start,
    undefined,
    await loadMapFiles(
      new RealMaps(),
      start.config.gameMap,
      start.config.gameMapSize,
    ),
    (gu) => {
      if ("errMsg" in gu) throw new Error(gu.errMsg);
      for (const h of gu.updates[GameUpdateType.Hash]) {
        hashes.set(h.tick, h.hash);
      }
    },
  );
  const game = runner.game;
  const turns: Turn[] = [];
  for (let tick = 0; tick < 400; tick++) {
    const intents: unknown[] = [];
    if (tick === 5) {
      let spot: number | null = null;
      for (let r = 0; r < 80 && spot === null; r++) {
        for (let dx = -r; dx <= r && spot === null; dx++) {
          for (let dy = -r; dy <= r && spot === null; dy++) {
            const x = 500 + dx;
            const y = 160 + dy;
            if (!game.isValidCoord(x, y)) continue;
            const t = game.ref(x, y);
            if (game.isLand(t) && !game.isImpassable(t) && !game.hasOwner(t)) {
              spot = t;
            }
          }
        }
      }
      intents.push({ type: "spawn", tile: spot, clientID: HUMAN });
    } else if (tick > 60 && tick % 40 === 0) {
      intents.push({
        type: "attack",
        targetID: null,
        troops: null,
        clientID: HUMAN,
      });
    }
    const turn = { turnNumber: tick, intents } as Turn;
    turns.push(turn);
    runner.addTurn(turn);
    if (!runner.executeNextTick()) throw new Error("tick failed");
  }
  for (const [tick, hash] of hashes) {
    if (tick % 100 === 0 && turns[tick] !== undefined) turns[tick].hash = hash;
  }
  return turns;
}

describe("the account API's replay subprocess", () => {
  it("replays a real match on a real map and reports what the simulation found", async () => {
    const start = startInfo({ bots: 35 });
    const turns = await play(start);
    const replay = await replaySoloInChild(start, turns);
    expect(replay.ok, replay.ok ? "" : replay.error).toBe(true);
    if (!replay.ok) return;
    const r = replay.result;
    expect(r.hashes.checked).toBeGreaterThanOrEqual(3);
    expect(r.hashes.mismatched).toBe(0);
    expect(r.tribes).toBe(35);
    // "default" nations: the simulation resolved the map's own
    expect(r.nations).toBeGreaterThan(30);
    expect(r.difficulty).toBe("Hard");
    expect(r.cheats).toEqual({
      instantBuild: false,
      infiniteGold: false,
      infiniteTroops: false,
    });
    expect(r.ticks).toBe(400);
    expect(r.humans).toEqual([{ clientID: HUMAN, spawned: true, alive: true }]);
  }, 60_000);

  it("does not reproduce a record played under another setup", async () => {
    const played = startInfo({ bots: 35 });
    const turns = await play(played);
    // the same turns, claimed to have been played with fewer tribes
    const claimed = startInfo({ bots: 5 });
    const replay = await replaySoloInChild(claimed, turns);
    expect(replay.ok).toBe(true);
    if (!replay.ok) return;
    expect(replay.result.hashes.mismatched).toBeGreaterThan(0);
  }, 60_000);

  it("reports a failure instead of hanging or throwing when the game cannot be replayed", async () => {
    const start = startInfo();
    // a map the files do not exist for would throw in the subprocess; here, an
    // impossible start: turns that make the engine fail
    const replay = await replaySoloInChild(
      { ...start, config: { ...start.config, gameMap: "Nowhere" as never } },
      [],
    );
    expect(replay.ok).toBe(false);
    if (replay.ok) return;
    expect(replay.error.length).toBeGreaterThan(0);
  }, 60_000);
});
