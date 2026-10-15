import {
  Difficulty,
  GameMapSize,
  GameType,
  UnitType,
} from "@openfront/engine-api/game/GameTypes";
import {
  GameUpdateType,
  WinUpdate,
} from "@openfront/engine-api/game/GameUpdates";
import { GameStartInfo, Intent, Turn } from "@openfront/engine-api/Schemas";
import { createGameRunner } from "@openfront/engine/GameRunner";
import { replaySolo } from "@openfront/engine/WinnerReplay";
import { loadMapFiles } from "@openfront/shared/GameMapLoader";
import { describe, expect, it } from "vitest";
import { scriptedGameStart, TestDataMapLoader } from "../util/ScriptedGame";

// What the account API's solo check relies on: replaying a singleplayer record
// reports what the simulation itself found (the tribes and nations it
// contained, the settings it ran with, who won), and says whether it reproduced
// the hashes the browser recorded. A record whose setup or turns were changed
// no longer reproduces them.

const HUMAN = "SOLOHUM1";

function soloStart(over: Partial<GameStartInfo["config"]> = {}): GameStartInfo {
  const start = scriptedGameStart({
    gameType: GameType.Singleplayer,
    gameMapSize: GameMapSize.Normal,
    difficulty: Difficulty.Hard,
    nations: "disabled",
    bots: 5,
    infiniteGold: false,
    infiniteTroops: false,
    instantBuild: false,
    doomsdayClock: { enabled: false, speed: "veryfast" },
    ...over,
  });
  return {
    ...start,
    gameID: "SOLOTEST",
    players: [
      {
        clientID: HUMAN,
        username: "solo",
        clanTag: null,
        isLobbyCreator: false,
      },
    ],
  };
}

// plains has no nations; world has 61, and runs at the compact size
const mapFiles = (start: GameStartInfo, map = "plains") =>
  loadMapFiles(
    new TestDataMapLoader(map),
    start.config.gameMap,
    start.config.gameMapSize,
  );

/**
 * Plays a solo game live, the way a browser does: one human, intents chosen
 * from the state, and the hash of every hundredth tick stored on its turn (what
 * LocalServer does).
 */
async function playLive(
  start: GameStartInfo,
  ticks: number,
  opts: { build?: boolean; spawn?: boolean; map?: string } = {},
): Promise<{ turns: Turn[]; win: WinUpdate | null }> {
  const { build = true, spawn = true, map = "plains" } = opts;
  let win: WinUpdate | null = null;
  const hashes = new Map<number, number>();
  const runner = await createGameRunner(
    start,
    undefined,
    await mapFiles(start, map),
    (gu) => {
      if ("errMsg" in gu) throw new Error(gu.errMsg);
      win ??= gu.updates[GameUpdateType.Win][0] ?? null;
      for (const h of gu.updates[GameUpdateType.Hash]) {
        hashes.set(h.tick, h.hash);
      }
    },
  );
  const game = runner.game;
  const turns: Turn[] = [];
  let built = false;
  for (let tick = 0; tick < ticks && win === null; tick++) {
    const intents: Turn["intents"] = [];
    if (spawn && tick === 5) {
      intents.push({
        type: "spawn",
        tile: game.ref(20, 20),
        clientID: HUMAN,
      } as Intent & { clientID: string });
    }
    const me = game.playerByClientID(HUMAN);
    if (build && !built && tick >= 80 && me !== null && me.isAlive()) {
      for (const tile of me.tiles()) {
        if (me.canBuild(UnitType.City, tile) !== false) {
          intents.push({
            type: "build_unit",
            unit: UnitType.City,
            tile,
            clientID: HUMAN,
          } as Intent & { clientID: string });
          built = true;
          break;
        }
      }
    }
    const turn: Turn = { turnNumber: tick, intents } as Turn;
    turns.push(turn);
    runner.addTurn(turn);
    if (!runner.executeNextTick()) throw new Error(`tick ${tick} failed`);
  }
  // The hash the simulation reaches at tick N is stored on turn N (what
  // LocalServer does, every hundredth tick), a turn that is played after it.
  for (const [tick, hash] of hashes) {
    if (tick % 100 === 0 && turns[tick] !== undefined) turns[tick].hash = hash;
  }
  return { turns, win };
}

describe("replaySolo: what the simulation found", () => {
  it("reproduces an honest game and reports its setup", async () => {
    const start = soloStart({ bots: 5 });
    const { turns } = await playLive(start, 420);
    expect(turns.filter((t) => t.hash !== undefined).length).toBeGreaterThan(2);

    const replayed = await replaySolo(start, turns, await mapFiles(start));

    expect(replayed.hashes.checked).toBeGreaterThan(2);
    expect(replayed.hashes.mismatched).toBe(0);
    expect(replayed.tribes).toBe(5);
    expect(replayed.nations).toBe(0);
    expect(replayed.cheats).toEqual({
      instantBuild: false,
      infiniteGold: false,
      infiniteTroops: false,
    });
    expect(replayed.difficulty).toBe(Difficulty.Hard);
    expect(replayed.ticks).toBe(420);
    expect(replayed.humans).toEqual([
      { clientID: HUMAN, spawned: true, alive: true },
    ]);
  });

  it("counts the tribes that took part, and the nations the setup resolves to", async () => {
    const custom = soloStart({
      bots: 9,
      nations: 7,
      gameMapSize: GameMapSize.Compact,
    });
    const played = await playLive(custom, 120, { build: false, map: "world" });
    const replayed = await replaySolo(
      custom,
      played.turns,
      await mapFiles(custom, "world"),
    );
    expect(replayed.tribes).toBe(9);
    expect(replayed.nations).toBe(7);
    // "default" is the map's own nations: the simulation resolves it, not the label
    const standard = soloStart({
      bots: 2,
      nations: "default",
      gameMapSize: GameMapSize.Compact,
    });
    const again = await playLive(standard, 120, { build: false, map: "world" });
    const all = await replaySolo(
      standard,
      again.turns,
      await mapFiles(standard, "world"),
    );
    expect(all.nations).toBe(61);
  });

  it("reads the switches from the engine's own configuration", async () => {
    const start = soloStart({
      instantBuild: true,
      infiniteGold: true,
      infiniteTroops: true,
      difficulty: Difficulty.Easy,
    });
    const { turns } = await playLive(start, 150);
    const replayed = await replaySolo(start, turns, await mapFiles(start));
    expect(replayed.cheats).toEqual({
      instantBuild: true,
      infiniteGold: true,
      infiniteTroops: true,
    });
    expect(replayed.difficulty).toBe(Difficulty.Easy);
    expect(replayed.hashes.mismatched).toBe(0);
  });

  it("finds a host cheat even when the plain switch says off", async () => {
    // infiniteGold: false in the config, but the lobby creator has it as a cheat
    const start = soloStart({
      hostCheats: { infiniteGold: true, infiniteTroops: true },
    });
    start.players[0].isLobbyCreator = true;
    const { turns } = await playLive(start, 150);
    const replayed = await replaySolo(start, turns, await mapFiles(start));
    expect(start.config.infiniteGold).toBe(false);
    expect(replayed.cheats.infiniteGold).toBe(true);
    expect(replayed.cheats.infiniteTroops).toBe(true);
  });

  it("stops at the result and reports the winner the simulation declared", async () => {
    // alone in the game with a one-minute timer: the timer ends it and the
    // largest empire (the only one) wins
    const start = soloStart({ bots: 0, maxTimerValue: 1 });
    const { turns, win } = await playLive(start, 3000, { build: false });
    expect(win?.winner).toEqual(["player", HUMAN]);
    const replayed = await replaySolo(start, turns, await mapFiles(start));
    expect(replayed.winner).toEqual(["player", HUMAN]);
    expect(replayed.tick).not.toBeNull();
    expect(replayed.ticks).toBe(replayed.tick);
    expect(replayed.allPlayersStats[HUMAN]).toBeDefined();
  });

  it("reports a player who never spawned as not having taken part", async () => {
    const start = soloStart();
    const { turns } = await playLive(start, 60, { spawn: false, build: false });
    const replayed = await replaySolo(start, turns, await mapFiles(start));
    expect(replayed.humans).toEqual([
      { clientID: HUMAN, spawned: false, alive: false },
    ]);
  });
});

describe("replaySolo: a changed record no longer reproduces", () => {
  it("claiming gold was not infinite when it was", async () => {
    const played = soloStart({ infiniteGold: true });
    const { turns } = await playLive(played, 420);
    // the honest claim reproduces
    const honest = await replaySolo(played, turns, await mapFiles(played));
    expect(honest.hashes.mismatched).toBe(0);
    // the same turns under a setup that did not give the money: they diverge
    const claimed = soloStart({ infiniteGold: false });
    const replayed = await replaySolo(claimed, turns, await mapFiles(claimed));
    expect(replayed.hashes.checked).toBeGreaterThan(0);
    expect(replayed.hashes.mismatched).toBeGreaterThan(0);
    // ...and the replay says so, in what it ran with: no infinite gold
    expect(replayed.cheats.infiniteGold).toBe(false);
  });

  it("removing what the player did", async () => {
    const start = soloStart({ infiniteGold: true });
    const { turns } = await playLive(start, 420);
    const edited = turns.map((t) => ({
      ...t,
      intents: t.intents.filter((i) => i.type !== "build_unit"),
    }));
    const replayed = await replaySolo(start, edited, await mapFiles(start));
    expect(replayed.hashes.mismatched).toBeGreaterThan(0);
  });

  it("a different number of tribes", async () => {
    const played = soloStart({ bots: 5 });
    const { turns } = await playLive(played, 420);
    const claimed = soloStart({ bots: 40 });
    const replayed = await replaySolo(claimed, turns, await mapFiles(claimed));
    expect(replayed.hashes.mismatched).toBeGreaterThan(0);
  });

  it("a record with no hashes proves nothing, and says so", async () => {
    const start = soloStart();
    const { turns } = await playLive(start, 250);
    const bare = turns.map(({ turnNumber, intents }) => ({
      turnNumber,
      intents,
    }));
    const replayed = await replaySolo(start, bare, await mapFiles(start));
    expect(replayed.hashes.checked).toBe(0);
  });
});
