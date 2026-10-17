import { GameMap, TileRef } from "@openfront/engine-api/game/GameMap";
import {
  AIRSTRIKE_CITY_MAX_LEVEL,
  type AirstrikeSpec,
} from "../configuration/Config";

/**
 * Why an airstrike cannot be launched at a target. Shared by the engine (which
 * only needs "can I?") and the client (which shows the reason to the player).
 */
export type AirstrikeBlockReason =
  | "disabled"
  | "spawn_immunity"
  | "invalid_terrain"
  | "not_hostile"
  | "no_airport"
  | "airport_building"
  | "airport_rearming"
  | "out_of_range"
  | "not_enough_gold";

export interface AirportInfo {
  tile: TileRef;
  active: boolean;
  underConstruction: boolean;
  inCooldown: boolean;
}

/**
 * The airport that launches a strike at `target`: the nearest one within
 * `range` that is finished and rearmed — or, if there is none, why.
 */
export function pickAirstrikeAirport(
  map: GameMap,
  target: TileRef,
  airports: readonly AirportInfo[],
  range: number,
):
  | { airport: TileRef; reason: null }
  | { airport: null; reason: AirstrikeBlockReason } {
  const active = airports.filter((a) => a.active);
  if (active.length === 0) {
    return { airport: null, reason: "no_airport" };
  }
  const range2 = range * range;
  const inRange = active.filter(
    (a) => map.euclideanDistSquared(a.tile, target) <= range2,
  );
  if (inRange.length === 0) {
    return { airport: null, reason: "out_of_range" };
  }
  let best: AirportInfo | null = null;
  let bestDist = Infinity;
  for (const a of inRange) {
    if (a.underConstruction || a.inCooldown) continue;
    const d = map.euclideanDistSquared(a.tile, target);
    if (d < bestDist) {
      best = a;
      bestDist = d;
    }
  }
  if (best !== null) {
    return { airport: best.tile, reason: null };
  }
  return {
    airport: null,
    reason: inRange.every((a) => a.underConstruction)
      ? "airport_building"
      : "airport_rearming",
  };
}

/**
 * The garrison-loss multiplier (basis points, 10_000 = x1) next to a city of
 * `cityLevel`; x1 with no city (level 0). Levels past the cap add nothing.
 */
export function airstrikeCityMultiplierBps(
  spec: AirstrikeSpec,
  cityLevel: number,
): number {
  if (cityLevel <= 0) return 10_000;
  const level = Math.min(AIRSTRIKE_CITY_MAX_LEVEL, Math.floor(cityLevel));
  return spec.cityBonusBps + (level - 1) * spec.cityBonusPerLevelBps;
}

/**
 * Garrison troops an airstrike application kills from a player that owns
 * `owned` tiles of which `hit` lie in the area: a share-proportional loss,
 * capped. Next to one of their cities (`cityLevel` > 0) the loss is multiplied
 * by the city bonus and capped at `cityCapBps` instead. Integer basis-point
 * arithmetic keeps it deterministic.
 */
export function airstrikeTroopLoss(
  spec: AirstrikeSpec,
  troops: number,
  hit: number,
  owned: number,
  cityLevel = 0,
): number {
  if (troops <= 0 || hit <= 0) return 0;
  const base = Math.floor((spec.troopFactorBps * hit) / Math.max(1, owned));
  const bps =
    cityLevel > 0
      ? Math.min(
          spec.cityCapBps,
          Math.floor(
            (base * airstrikeCityMultiplierBps(spec, cityLevel)) / 10_000,
          ),
        )
      : Math.min(spec.troopCapBps, base);
  return Math.floor((troops * bps) / 10_000);
}

/**
 * Troops an attack loses when `hitFront` of the `frontSize` tiles it is
 * fighting over lie in the strike area: concentrated troops on a short front
 * lose much more than the same troops spread along a long one. Capped.
 */
export function airstrikeArmyLoss(
  spec: AirstrikeSpec,
  troops: number,
  hitFront: number,
  frontSize: number,
): number {
  if (troops <= 0 || hitFront <= 0) return 0;
  const bps = Math.min(
    spec.armyCapBps,
    Math.floor((spec.armyFactorBps * hitFront) / Math.max(1, frontSize)),
  );
  return Math.floor((troops * bps) / 10_000);
}
