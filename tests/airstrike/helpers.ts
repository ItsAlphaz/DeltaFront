import { GameMap, TileRef } from "@openfront/engine-api/game/GameMap";
import {
  AirstrikeUnitType,
  GameMode,
  GameUpdates,
  PlayerInfo,
  PlayerType,
  UnitType,
} from "@openfront/engine-api/game/GameTypes";
import { GameUpdateType } from "@openfront/engine-api/game/GameUpdates";
import { GameConfig } from "@openfront/engine-api/Schemas";
import { airstrikeFlightPath } from "@openfront/engine-lib/airstrike/AirstrikeGeometry";
import { AirstrikeSpec } from "@openfront/engine-lib/configuration/Config";
import { EngineConfig } from "@openfront/engine/configuration/EngineConfig";
import { ConstructionExecution } from "@openfront/engine/execution/ConstructionExecution";
import { Game, Player, Unit } from "@openfront/engine/game/Game";
import { setup } from "../util/Setup";
import { TestConfig } from "../util/TestConfig";
import { constructionExecution } from "../util/utils";

export const STRIKES: readonly AirstrikeUnitType[] = [
  UnitType.BombingRun,
  UnitType.RocketStrike,
  UnitType.StrafingRun,
];

/** Test config with a short airport range (the 200x200 test map is smaller than the real 400). */
export class ShortRangeConfig extends TestConfig {
  airportRange(): number {
    return 100;
  }
}

/** SAMs always hit aircraft. */
export class SureHitConfig extends TestConfig {
  airstrikeSpec(type: UnitType): AirstrikeSpec {
    return { ...super.airstrikeSpec(type), samHitPercent: 100 };
  }
}

/** SAMs never hit aircraft. */
export class NeverHitConfig extends TestConfig {
  airstrikeSpec(type: UnitType): AirstrikeSpec {
    return { ...super.airstrikeSpec(type), samHitPercent: 0 };
  }
}

export interface World {
  game: Game;
  attacker: Player;
  defender: Player;
}

export interface WorldOptions {
  map?: string;
  config?: Partial<GameConfig>;
  configClass?: typeof EngineConfig;
  /** Extra human players, by id. */
  extra?: string[];
}

export function human(id: string): PlayerInfo {
  // A client id, so the stats system records this player.
  return new PlayerInfo(id, PlayerType.Human, id, id);
}

/** A game with an attacker and a defender (and any extra humans), no land yet. */
export async function makeWorld(opts: WorldOptions = {}): Promise<World> {
  const ids = ["attacker_id", "defender_id", ...(opts.extra ?? [])];
  const game = await setup(
    opts.map ?? "big_plains",
    { infiniteGold: true, instantBuild: true, ...opts.config },
    ids.map(human),
    undefined,
    opts.configClass ?? TestConfig,
  );
  return {
    game,
    attacker: game.player("attacker_id"),
    defender: game.player("defender_id"),
  };
}

/** Gives `player` the square of land centred on (cx, cy). */
export function conquerSquare(
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

export function airportsOf(player: Player): Unit[] {
  return player.units(UnitType.Airport);
}

/** Builds a finished airport (with its rearm execution) on land the player owns. */
export function buildAirport(game: Game, player: Player, x: number, y: number) {
  constructionExecution(game, player, x, y, UnitType.Airport);
  const airport = airportsOf(player).find((a) => a.tile() === game.ref(x, y));
  if (airport === undefined) throw new Error("airport was not built");
  return airport;
}

/** Orders a strike through the real intent path (construction -> execution) and runs it to launch. */
export function orderStrike(
  game: Game,
  player: Player,
  type: UnitType,
  x: number,
  y: number,
  ticks = 3,
): void {
  constructionExecution(game, player, x, y, type, ticks);
}

export function run(game: Game, ticks: number): GameUpdates[] {
  const all: GameUpdates[] = [];
  for (let i = 0; i < ticks; i++) all.push(game.executeNextTick());
  return all;
}

export function flightLength(
  game: Game,
  src: TileRef,
  dst: TileRef,
  type: AirstrikeUnitType,
): number {
  return airstrikeFlightPath(
    game,
    src,
    dst,
    type,
    game.config().airstrikeSpec(type),
    game.config().airstrikePlaneSpeed(),
  ).length;
}

/** The aircraft of `player`'s strike of this type currently in the air, if any. */
export function planeOf(
  player: Player,
  type: AirstrikeUnitType,
): Unit | undefined {
  return player.units(type)[0];
}

/** Every update of one kind produced while running `ticks`. */
export function collect<T extends GameUpdateType>(
  game: Game,
  type: T,
  ticks: number,
): GameUpdates[T] {
  const out: GameUpdates[T] = [];
  for (const updates of run(game, ticks)) out.push(...updates[type]);
  return out;
}

/** Finds a row of the map with land at both x and x + span, to test long distances. */
export function findLongRow(
  map: GameMap,
  span: number,
): { x: number; y: number } {
  for (let y = 100; y < map.height() - 100; y += 7) {
    for (let x = 10; x + span + 20 < map.width(); x += 11) {
      if (
        [0, span - 1, span, span + 1].every((d) =>
          map.isLand(map.ref(x + d, y)),
        )
      ) {
        return { x, y };
      }
    }
  }
  throw new Error(`no land row spanning ${span} tiles`);
}

export { GameMode };

/** Orders a strike and steps until its aircraft is in the air (launch tick executed). */
export function startStrike(
  game: Game,
  player: Player,
  type: AirstrikeUnitType,
  x: number,
  y: number,
): Unit {
  game.addExecution(new ConstructionExecution(player, type, game.ref(x, y)));
  for (let i = 0; i < 6; i++) {
    game.executeNextTick();
    const plane = planeOf(player, type);
    if (plane !== undefined) return plane;
  }
  throw new Error(`${type} did not launch`);
}

/** A hostile defender: troops set, a square of land. */
export function placeDefender(
  game: Game,
  player: Player,
  cx: number,
  cy: number,
  half: number,
  troops: number,
): void {
  conquerSquare(game, player, cx, cy, half);
  player.setTroops(troops);
}

/** `floor(troops * bps / 10000)`: the troops a strike application leaves. */
export function afterLoss(troops: number, bps: number): number {
  return troops - Math.floor((troops * bps) / 10_000);
}

export function levelOf(unit: Unit): number {
  return unit.isActive() ? unit.level() : 0;
}

/** Gives `player` every tile of the inclusive rectangle. */
export function conquerRect(
  game: Game,
  player: Player,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): void {
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) player.conquer(game.ref(x, y));
  }
}
