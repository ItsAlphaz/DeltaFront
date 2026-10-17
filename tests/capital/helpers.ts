import { TileRef } from "@openfront/engine-api/game/GameMap";
import {
  GameUpdates,
  PlayerInfo,
  PlayerType,
} from "@openfront/engine-api/game/GameTypes";
import { GameUpdateType } from "@openfront/engine-api/game/GameUpdates";
import { GameConfig } from "@openfront/engine-api/Schemas";
import { EngineConfig } from "@openfront/engine/configuration/EngineConfig";
import { PlayerExecution } from "@openfront/engine/execution/PlayerExecution";
import { Game, Player } from "@openfront/engine/game/Game";
import { setup } from "../util/Setup";

export function human(id: string): PlayerInfo {
  // A client id, so the stats system records this player.
  return new PlayerInfo(id, PlayerType.Human, id, id);
}

export interface CapitalWorld {
  game: Game;
  alice: Player;
  bob: Player;
  /** Everyone, by id. */
  players: Record<string, Player>;
}

/**
 * A game with the Capital System on, two humans (alice at the left, bob at the
 * right, side by side) and the founding capitals already placed: a land of
 * `half * 2 + 1` tiles each, the spawn tile at its centre.
 */
export async function capitalWorld(
  opts: {
    config?: Partial<GameConfig>;
    configClass?: typeof EngineConfig;
    half?: number;
    ids?: string[];
    /** Do not found the capitals (leave the first tick to the test). */
    skipFirstTick?: boolean;
  } = {},
): Promise<CapitalWorld> {
  const ids = opts.ids ?? ["alice", "bob"];
  const game = await setup(
    "big_plains",
    {
      capitalSystem: { enabled: true },
      ...opts.config,
    },
    ids.map(human),
    undefined,
    opts.configClass,
  );
  const half = opts.half ?? 6;
  const players: Record<string, Player> = {};
  ids.forEach((id, i) => {
    const p = game.player(id);
    players[id] = p;
    // Side by side with no gap, so they border and can attack each other.
    land(game, p, 20 + i * (half * 2 + 1), 20, half);
    p.setSpawnTile(game.ref(20 + i * (half * 2 + 1), 20));
  });
  if (!opts.skipFirstTick) game.executeNextTick();
  return { game, alice: players[ids[0]], bob: players[ids[1]], players };
}

/** Gives `player` the square of land centred on (cx, cy). */
export function land(
  game: Game,
  player: Player,
  cx: number,
  cy: number,
  half: number,
): void {
  for (let y = cy - half; y <= cy + half; y++) {
    for (let x = cx - half; x <= cx + half; x++) {
      player.conquer(game.ref(x, y));
    }
  }
}

/** Runs `ticks` ticks, returning every tick's updates. */
export function run(game: Game, ticks: number): GameUpdates[] {
  const all: GameUpdates[] = [];
  for (let i = 0; i < ticks; i++) all.push(game.executeNextTick());
  return all;
}

/** Every CapitalEvent of the given ticks' updates. */
export function capitalEvents(updates: GameUpdates[]) {
  return updates.flatMap((u) => u[GameUpdateType.CapitalEvent]);
}

/** Every match event of one type. */
export function matchEvents(updates: GameUpdates[], type: string) {
  return updates
    .flatMap((u) => u[GameUpdateType.MatchEvent])
    .map((u) => u.event)
    .filter((e) => e.type === type);
}

/** Starts the per-tick economy for `player` (a game built without spawns has none). */
export function startEconomy(game: Game, player: Player): void {
  game.addExecution(new PlayerExecution(player));
}

export function tileOf(game: Game, x: number, y: number): TileRef {
  return game.ref(x, y);
}
