import { GameMap, TileRef } from "@openfront/engine-api/game/GameMap";
import { UnitType } from "@openfront/engine-api/game/GameTypes";
import type { AirstrikeSpec } from "../configuration/Config";

/**
 * Flight paths and corridors of airstrikes. Shared by the simulation, the
 * nation AI and the client's strike preview, so what a player sees is exactly
 * what the engine simulates. Only + - * / sqrt round floor ceil are used, all
 * exact under IEEE 754, so every client computes the same tiles.
 */

const DEFAULT_DIRECTION = { ux: 0, uy: -1 };

interface Line {
  sx: number;
  sy: number;
  ux: number;
  uy: number;
  dist: number;
}

function lineBetween(map: GameMap, src: TileRef, dst: TileRef): Line {
  const sx = map.x(src);
  const sy = map.y(src);
  const dx = map.x(dst) - sx;
  const dy = map.y(dst) - sy;
  const dist = Math.sqrt(dx * dx + dy * dy);
  if (dist === 0) {
    return { sx, sy, ...DEFAULT_DIRECTION, dist: 0 };
  }
  return { sx, sy, ux: dx / dist, uy: dy / dist, dist };
}

function clampedRef(map: GameMap, x: number, y: number): TileRef {
  const cx = Math.min(map.width() - 1, Math.max(0, Math.round(x)));
  const cy = Math.min(map.height() - 1, Math.max(0, Math.round(y)));
  return map.ref(cx, cy);
}

/**
 * Tiles a plane passes through flying `speed` tiles per tick from src to dst,
 * one per tick, ending exactly on dst. `src` itself is not included.
 */
export function straightPath(
  map: GameMap,
  src: TileRef,
  dst: TileRef,
  speed: number,
): TileRef[] {
  const sx = map.x(src);
  const sy = map.y(src);
  const dx = map.x(dst) - sx;
  const dy = map.y(dst) - sy;
  const steps = Math.max(
    1,
    Math.ceil(Math.sqrt(dx * dx + dy * dy) / Math.max(1, speed)),
  );
  const path: TileRef[] = [];
  for (let i = 1; i <= steps; i++) {
    path.push(
      map.ref(
        sx + Math.round((dx * i) / steps),
        sy + Math.round((dy * i) / steps),
      ),
    );
  }
  return path;
}

/**
 * Where the aircraft's flight ends.
 *  - Bombing run: over the target.
 *  - Rocket strike: `standoff` tiles short of the target (the airport itself
 *    when it is already that close), where the rockets are released.
 *  - Strafing run: past the far end of the corridor, `exitTail` tiles beyond
 *    it, clipped to the map edge.
 */
export function airstrikeEndPoint(
  map: GameMap,
  src: TileRef,
  dst: TileRef,
  type: UnitType,
  spec: AirstrikeSpec,
): TileRef {
  if (type === UnitType.RocketStrike) {
    const line = lineBetween(map, src, dst);
    if (line.dist <= spec.standoff) return src;
    const t = line.dist - spec.standoff;
    return clampedRef(map, line.sx + line.ux * t, line.sy + line.uy * t);
  }
  if (type === UnitType.StrafingRun) {
    const line = lineBetween(map, src, dst);
    let t = line.dist + spec.corridorLength / 2 + spec.exitTail;
    // Clip to the map: the largest t that stays inside on both axes.
    if (line.ux > 0) t = Math.min(t, (map.width() - 1 - line.sx) / line.ux);
    if (line.ux < 0) t = Math.min(t, (0 - line.sx) / line.ux);
    if (line.uy > 0) t = Math.min(t, (map.height() - 1 - line.sy) / line.uy);
    if (line.uy < 0) t = Math.min(t, (0 - line.sy) / line.uy);
    return clampedRef(map, line.sx + line.ux * t, line.sy + line.uy * t);
  }
  return dst;
}

/** The tiles the aircraft flies through (src excluded; empty if it starts at its end point). */
export function airstrikeFlightPath(
  map: GameMap,
  src: TileRef,
  dst: TileRef,
  type: UnitType,
  spec: AirstrikeSpec,
  speed: number,
): TileRef[] {
  const end = airstrikeEndPoint(map, src, dst, type, spec);
  if (end === src) return [];
  return straightPath(map, src, end, speed);
}

/** A strafing run's damage corridor: a rectangle along the flight line. */
export interface Corridor {
  /** Origin (the airport) and unit direction of the flight line. */
  sx: number;
  sy: number;
  ux: number;
  uy: number;
  /** Along-track window covered, in tiles from the origin. */
  sStart: number;
  sEnd: number;
  halfWidth: number;
  bursts: number;
}

/**
 * The corridor of a strafing run from `src` through `dst`: `corridorLength`
 * tiles centred on the target (clamped so it never starts behind the airport),
 * `2 * radius + 1` tiles wide, split into `corridorBursts` equal segments.
 */
export function strafingCorridor(
  map: GameMap,
  src: TileRef,
  dst: TileRef,
  spec: AirstrikeSpec,
): Corridor {
  const line = lineBetween(map, src, dst);
  return {
    sx: line.sx,
    sy: line.sy,
    ux: line.ux,
    uy: line.uy,
    sStart: Math.max(0, line.dist - spec.corridorLength / 2),
    sEnd: line.dist + spec.corridorLength / 2,
    halfWidth: spec.radius,
    bursts: spec.corridorBursts,
  };
}

/** Along-track distance from the corridor origin to the tile. */
export function alongTrack(map: GameMap, c: Corridor, tile: TileRef): number {
  return (map.x(tile) - c.sx) * c.ux + (map.y(tile) - c.sy) * c.uy;
}

/** Distance of the tile from the corridor's centreline. */
export function crossTrack(map: GameMap, c: Corridor, tile: TileRef): number {
  return Math.abs((map.x(tile) - c.sx) * c.uy - (map.y(tile) - c.sy) * c.ux);
}

/** Along-track edge `i` of the segments (`i` in 0..bursts). */
export function corridorEdge(c: Corridor, i: number): number {
  return i >= c.bursts
    ? c.sEnd
    : c.sStart + (i * (c.sEnd - c.sStart)) / c.bursts;
}

export function corridorBounds(
  map: GameMap,
  c: Corridor,
): { x0: number; y0: number; x1: number; y1: number } {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const s of [c.sStart, c.sEnd]) {
    for (const w of [-c.halfWidth, c.halfWidth]) {
      const x = c.sx + s * c.ux + w * c.uy;
      const y = c.sy + s * c.uy - w * c.ux;
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
    }
  }
  return {
    x0: Math.max(0, Math.floor(minX)),
    y0: Math.max(0, Math.floor(minY)),
    x1: Math.min(map.width() - 1, Math.ceil(maxX)),
    y1: Math.min(map.height() - 1, Math.ceil(maxY)),
  };
}

/** Tiles of segment `burst` (or of every segment when `burst` is null), scan order y then x. */
function scanCorridor(
  map: GameMap,
  c: Corridor,
  burst: number | null,
): TileRef[] {
  const lo = burst === null ? c.sStart : corridorEdge(c, burst);
  const hi = burst === null ? c.sEnd : corridorEdge(c, burst + 1);
  const isLast = burst === null || burst === c.bursts - 1;
  const b = corridorBounds(map, c);
  const tiles: TileRef[] = [];
  for (let y = b.y0; y <= b.y1; y++) {
    for (let x = b.x0; x <= b.x1; x++) {
      const px = x - c.sx;
      const py = y - c.sy;
      const s = px * c.ux + py * c.uy;
      if (s < lo || (isLast ? s > hi : s >= hi)) continue;
      if (Math.abs(px * c.uy - py * c.ux) > c.halfWidth) continue;
      tiles.push(map.ref(x, y));
    }
  }
  return tiles;
}

export function corridorBurstTiles(
  map: GameMap,
  c: Corridor,
  burst: number,
): TileRef[] {
  return scanCorridor(map, c, burst);
}

export function corridorTiles(map: GameMap, c: Corridor): TileRef[] {
  return scanCorridor(map, c, null);
}

/**
 * For each burst, the index in `path` of the first tile where the plane has
 * flown through that burst's segment (its along-track position reaches the
 * segment's far edge); the last tile if it never does (clipped at the map edge).
 */
export function burstTriggerSteps(
  map: GameMap,
  path: readonly TileRef[],
  c: Corridor,
): number[] {
  const last = Math.max(0, path.length - 1);
  const steps: number[] = [];
  for (let k = 0; k < c.bursts; k++) {
    const edge = corridorEdge(c, k + 1);
    let found = last;
    for (let i = 0; i < path.length; i++) {
      if (alongTrack(map, c, path[i]) >= edge) {
        found = i;
        break;
      }
    }
    steps.push(found);
  }
  return steps;
}

/** Tiles within `radius` of `center` (euclidean), scan order y then x, clamped to the map. */
export function discTiles(
  map: GameMap,
  center: TileRef,
  radius: number,
): TileRef[] {
  const cx = map.x(center);
  const cy = map.y(center);
  const r2 = radius * radius;
  const x0 = Math.max(0, Math.floor(cx - radius));
  const x1 = Math.min(map.width() - 1, Math.ceil(cx + radius));
  const y0 = Math.max(0, Math.floor(cy - radius));
  const y1 = Math.min(map.height() - 1, Math.ceil(cy + radius));
  const tiles: TileRef[] = [];
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const dx = x - cx;
      const dy = y - cy;
      if (dx * dx + dy * dy <= r2) tiles.push(map.ref(x, y));
    }
  }
  return tiles;
}
