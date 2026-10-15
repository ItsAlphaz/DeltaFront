import { PlayerType } from "@openfront/engine-api/game/GameTypes";
import {
  ErrorUpdate,
  GameUpdateType,
  WinUpdate,
} from "@openfront/engine-api/game/GameUpdates";
import { MapFiles } from "@openfront/engine-api/game/MapFiles";
import {
  AllPlayersStats,
  GameStartInfo,
  Turn,
  Winner,
} from "@openfront/engine-api/Schemas";
import { createGameRunner } from "./GameRunner";

export interface ReplayedWinner {
  // undefined when the turns run out before anyone wins, or the match was
  // cancelled (a winnerless Win update).
  winner: Winner;
  allPlayersStats: AllPlayersStats;
  // The tick the simulation declared the result on; null if it never did.
  tick: number | null;
}

/**
 * Re-runs a game from its start info, turn log and map files and reports the
 * first result the simulation reaches — the same Win update every in-sync client
 * votes on. The server's own check on a disputed winner vote; it runs in a
 * subprocess (src/server/WinnerReplayChild.ts), the one place the server
 * loads the engine.
 */
export async function replayWinner(
  gameStart: GameStartInfo,
  turns: Turn[],
  map: MapFiles,
): Promise<ReplayedWinner> {
  let win: WinUpdate | null = null;
  let error: ErrorUpdate | null = null;
  const runner = await createGameRunner(gameStart, undefined, map, (gu) => {
    if ("errMsg" in gu) {
      error = gu;
      return;
    }
    win ??= gu.updates[GameUpdateType.Win][0] ?? null;
  });
  for (const turn of turns) {
    runner.addTurn(turn);
    if (!runner.executeNextTick()) {
      const err = error as ErrorUpdate | null;
      throw new Error(
        `replay failed at turn ${turn.turnNumber}: ${err?.errMsg}\n${err?.stack}`,
      );
    }
    if (win !== null) {
      const w = win as WinUpdate;
      return {
        winner: w.winner,
        allPlayersStats: w.allPlayersStats,
        tick: runner.game.ticks(),
      };
    }
  }
  return {
    winner: undefined,
    allPlayersStats: runner.game.stats().stats(),
    tick: null,
  };
}

/** One human of a replayed game, as the simulation left them. */
export interface ReplayedHuman {
  clientID: string;
  /** Whether they ever owned land (a player who never spawned took no part). */
  spawned: boolean;
  /** Whether they still own land: false for a player eliminated, and for one who never spawned. */
  alive: boolean;
}

/** What replaying a singleplayer match established. See replaySolo. */
export interface ReplayedSolo extends ReplayedWinner {
  /** Ticks simulated: the game's own clock, ten to a second. */
  ticks: number;
  /**
   * The recorded state hashes the replay compared with its own. The turns of a
   * singleplayer record carry the hash its player's simulation reached at every
   * hundredth tick, so a replay that disagrees with one is not the game that was
   * recorded: the turns, or the setup they were played under, were changed.
   */
  hashes: { checked: number; mismatched: number };
  /** The tribes (bots) that really took part: those the simulation created. */
  tribes: number;
  /** The nations in the game, as the simulation resolved the setup and the map. */
  nations: number;
  /**
   * The switches the simulation ran with, read from its own configuration (not
   * from a label): instant build, and infinite gold and troops, whether set for
   * everyone or as a host cheat.
   */
  cheats: {
    instantBuild: boolean;
    infiniteGold: boolean;
    infiniteTroops: boolean;
  };
  difficulty: string;
  humans: ReplayedHuman[];
}

/**
 * Replays a singleplayer match from its start info, its turn log and its map
 * files, up to the result (or the end of the turns), and reports what the
 * simulation itself found: who won, what the game contained, the settings it ran
 * with and whether it reproduced the recorded state hashes. The account API's
 * check on a match that only a browser played (src/account-api/soloReplayChild.ts):
 * nothing in the answer is read from the submission except the turns the
 * simulation was driven by.
 */
export async function replaySolo(
  gameStart: GameStartInfo,
  turns: Turn[],
  map: MapFiles,
): Promise<ReplayedSolo> {
  let win: WinUpdate | null = null;
  let error: ErrorUpdate | null = null;
  const recorded = new Map<number, number>();
  for (const turn of turns) {
    if (typeof turn.hash === "number") recorded.set(turn.turnNumber, turn.hash);
  }
  const hashes = { checked: 0, mismatched: 0 };
  const runner = await createGameRunner(gameStart, undefined, map, (gu) => {
    if ("errMsg" in gu) {
      error = gu;
      return;
    }
    win ??= gu.updates[GameUpdateType.Win][0] ?? null;
    for (const update of gu.updates[GameUpdateType.Hash]) {
      const want = recorded.get(update.tick);
      if (want === undefined) continue;
      hashes.checked++;
      if (want !== update.hash) hashes.mismatched++;
    }
  });
  for (const turn of turns) {
    runner.addTurn(turn);
    if (!runner.executeNextTick()) {
      const err = error as ErrorUpdate | null;
      throw new Error(
        `replay failed at turn ${turn.turnNumber}: ${err?.errMsg}\n${err?.stack}`,
      );
    }
    // A diverged replay says nothing more worth running to the end for.
    if (hashes.mismatched > 0) break;
    if (win !== null) break;
  }
  const game = runner.game;
  const config = game.config();
  const hostCheats = config.gameConfig().hostCheats;
  const everyone = game.allPlayers();
  const result = win as WinUpdate | null;
  return {
    winner: result?.winner,
    allPlayersStats: result?.allPlayersStats ?? game.stats().stats(),
    tick: result === null ? null : game.ticks(),
    ticks: game.ticks(),
    hashes,
    tribes: everyone.filter((p) => p.type() === PlayerType.Bot).length,
    nations: game.nations().length,
    cheats: {
      instantBuild: config.instantBuild(),
      infiniteGold:
        config.infiniteGold() || (hostCheats?.infiniteGold ?? false),
      infiniteTroops:
        config.infiniteTroops() || (hostCheats?.infiniteTroops ?? false),
    },
    difficulty: config.gameConfig().difficulty,
    humans: everyone
      .filter((p) => p.type() === PlayerType.Human)
      .map((p) => ({
        clientID: p.clientID() ?? "",
        spawned: p.hasSpawned(),
        alive: p.isAlive(),
      })),
  };
}
