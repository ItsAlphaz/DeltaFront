import { TileRef } from "@openfront/engine-api/game/GameMap";
import {
  GameUpdates,
  PlayerInfo,
  PlayerType,
} from "@openfront/engine-api/game/GameTypes";
import { GameUpdateType } from "@openfront/engine-api/game/GameUpdates";
import { GameConfig } from "@openfront/engine-api/Schemas";
import { CAPITAL_SPEC } from "@openfront/engine-lib/capital/CapitalRules";
import { EngineConfig } from "@openfront/engine/configuration/EngineConfig";
import { PlayerExecution } from "@openfront/engine/execution/PlayerExecution";
import { Game, Player } from "@openfront/engine/game/Game";
import { setup } from "../util/Setup";
import { TestConfig } from "../util/TestConfig";

export function human(id: string): PlayerInfo {
  // A client id, so the stats system records this player.
  return new PlayerInfo(id, PlayerType.Human, id, id);
}

/**
 * A config whose capitals give all their bonuses at once. The insurgency tests
 * measure the occupier's army against its maximum, which a ramping capital
 * would move under them.
 */
export class FullStrengthConfig extends TestConfig {
  capitalSpec() {
    return { ...CAPITAL_SPEC, rampTicks: 1 };
  }
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
 * right, side by side) and a capital already bought for each: a land of
 * `half * 2 + 1` tiles each, the spawn tile at its centre. Gold is as it was
 * before the purchase (the starting grant), so tests keep exact figures.
 */
export async function capitalWorld(
  opts: {
    config?: Partial<GameConfig>;
    configClass?: typeof EngineConfig;
    half?: number;
    ids?: string[];
    /** Leave everyone without a capital (the test buys them itself). */
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
  if (!opts.skipFirstTick) {
    game.executeNextTick();
    if (game.capitals() !== null) {
      for (const p of Object.values(players)) buyCapital(game, p);
    }
  }
  return { game, alice: players[ids[0]], bob: players[ids[1]], players };
}

/**
 * Buys `player` a capital at its spawn tile (or `tile`) without changing its
 * gold: the price is added first and spent by the purchase.
 */
export function buyCapital(game: Game, player: Player, tile?: TileRef): void {
  const where = tile ?? player.spawnTile()!;
  player.addGold(CAPITAL_SPEC.cost);
  if (!game.capitals()!.found(player, where)) {
    throw new Error(
      `${player.name()} could not buy a capital: ${game.capitals()!.foundBlock(player, where)}`,
    );
  }
  // With the game's own build time the capital stands only when it is built.
  const build = game.capitals()!.buildingOf(player);
  if (build !== null) {
    while (game.ticks() < build.endTick) game.executeNextTick();
  }
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
