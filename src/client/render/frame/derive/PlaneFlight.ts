import { UnitType } from "@openfront/engine-api/game/GameTypes";
import {
  airstrikeFlightPath,
  type FlightGrid,
} from "@openfront/engine-lib/airstrike/AirstrikeGeometry";
import type { AirstrikeSpec } from "@openfront/engine-lib/configuration/Config";

/**
 * Where an airstrike plane is drawn, and which way it points.
 *
 * The simulation moves a plane one tile per tick along a straight line from
 * its airport, but a unit's position is a whole tile: every step is that line
 * rounded to the grid. At 2 tiles a tick the rounded steps alternate, say
 * (2,1) (2,0) (2,1), so drawing the plane between them and pointing it along
 * each one made it zigzag and flick its nose from side to side.
 *
 * Instead the plane is drawn on the line itself. Its path is rebuilt with the
 * engine's own geometry (`airstrikeFlightPath`) from the airport it left and
 * the target it was given, so step `k` of the path is exactly the tile the
 * simulation has it on at that point. The plane sits at `k / steps` of the way
 * from the airport to the end of the path, eases between steps over the tick,
 * and always faces from the airport to the end: one heading for the whole
 * flight, which is the direction it really travels. Presentation only:
 * nothing here feeds back into the simulation.
 */
export interface PlaneFlight {
  /** The airport the plane left. */
  ox: number;
  oy: number;
  /** The end of the flight (over the target, short of it, or past it). */
  ex: number;
  ey: number;
  /** Path steps from the airport to the end. */
  steps: number;
  /** Path index of each tile the plane passes, the airport at 0. */
  index: ReadonlyMap<number, number>;
}

/** A tile grid of the given width and height, in the engine's tile refs. */
export function flightGrid(width: number, height: number): FlightGrid {
  return {
    width: () => width,
    height: () => height,
    x: (ref) => ref % width,
    y: (ref) => Math.floor(ref / width),
    ref: (x, y) => y * width + x,
  };
}

/**
 * The flight that has a plane on `pos` (and on `lastPos`, the tile it came
 * from), among the airports it could have left: the first whose path holds
 * them, in that order. Null if none does (its airport is gone and it was never
 * seen there). A plane seen at its airport (every strike is, at launch) is
 * matched there for certain; one first seen in mid-flight, near its target,
 * could in rare cases match a nearly parallel line from another airport.
 */
export function resolvePlaneFlight(
  grid: FlightGrid,
  unitType: UnitType,
  target: number,
  pos: number,
  lastPos: number,
  origins: Iterable<number>,
  spec: AirstrikeSpec,
  speed: number,
): PlaneFlight | null {
  for (const origin of origins) {
    const path = airstrikeFlightPath(
      grid,
      origin,
      target,
      unitType,
      spec,
      speed,
    );
    const index = new Map<number, number>([[origin, 0]]);
    path.forEach((tile, i) => index.set(tile, i + 1));
    // The plane must be on this path and have come one step (or none) along
    // it: a line from another airport can cross the same tiles, even running
    // the other way, but not in this order.
    const at = index.get(pos);
    const from = index.get(lastPos);
    if (at === undefined || from === undefined) continue;
    if (at < from || at > from + 1) continue;
    const end = path.length > 0 ? path[path.length - 1] : origin;
    return {
      ox: grid.x(origin),
      oy: grid.y(origin),
      ex: grid.x(end),
      ey: grid.y(end),
      steps: path.length,
      index,
    };
  }
  return null;
}

/** The point `step` steps along the flight (fractions allowed). */
export function flightPoint(
  flight: PlaneFlight,
  step: number,
): { x: number; y: number } {
  if (flight.steps === 0) return { x: flight.ox, y: flight.oy };
  const t = Math.min(1, Math.max(0, step / flight.steps));
  return {
    x: flight.ox + (flight.ex - flight.ox) * t,
    y: flight.oy + (flight.ey - flight.oy) * t,
  };
}

/** The path step a tile is at, or null if the plane is not on this flight. */
export function flightStep(flight: PlaneFlight, tile: number): number | null {
  return flight.index.get(tile) ?? null;
}
