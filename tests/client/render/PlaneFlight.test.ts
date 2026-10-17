/**
 * Airstrike planes fly one straight line (regression: they zigzagged).
 *
 * A plane's position in the simulation is a whole tile: each step is its
 * straight line rounded to the grid, so at 2 tiles a tick the steps alternate,
 * e.g. (2,1) (2,0) (2,1). The renderer used to draw the plane between those
 * rounded tiles and point it along each step, so it zigzagged and flicked its
 * nose. It now rebuilds the exact line (PlaneFlight.ts) and draws the plane on
 * it, nose along the line.
 */

import { UnitType } from "@openfront/engine-api/game/GameTypes";
import { airstrikeFlightPath } from "@openfront/engine-lib/airstrike/AirstrikeGeometry";
import {
  AIRSTRIKE_PLANE_SPEED,
  Config,
} from "@openfront/engine-lib/configuration/Config";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  flightGrid,
  flightPoint,
  flightStep,
  resolvePlaneFlight,
} from "../../../src/client/render/frame/derive/PlaneFlight";
import {
  planeHeadingByte,
  UnitPass,
} from "../../../src/client/render/gl/passes/UnitPass";
import type { UnitState } from "../../../src/client/render/types";

const W = 400;
const H = 300;
const grid = flightGrid(W, H);
const ref = (x: number, y: number) => y * W + x;
const spec = (t: UnitType) => Config.prototype.airstrikeSpec.call(undefined, t);
const STRIKES = [
  UnitType.BombingRun,
  UnitType.RocketStrike,
  UnitType.StrafingRun,
] as const;

const enginePath = (t: UnitType, src: number, dst: number) =>
  airstrikeFlightPath(grid, src, dst, t, spec(t), AIRSTRIKE_PLANE_SPEED);

/** Origins in 16 directions around (200, 150), at several distances, short ones too. */
function routes(): { src: number; dst: number }[] {
  const out: { src: number; dst: number }[] = [];
  const dst = ref(200, 150);
  const offsets = [
    [1, 0],
    [3, 1],
    [37, 11],
    [80, 0],
    [0, 80],
    [-80, 0],
    [0, -80],
    [60, 60],
    [-60, 60],
    [60, -60],
    [-60, -60],
    [97, -13],
    [-41, 89],
    [5, -120],
    [-120, -7],
    [2, 2],
  ];
  for (const [dx, dy] of offsets)
    out.push({ src: ref(200 - dx, 150 - dy), dst });
  return out;
}

describe("the exact flight line", () => {
  it("passes through every tile the simulation puts the plane on, within half a tile", () => {
    for (const type of STRIKES) {
      for (const { src, dst } of routes()) {
        const path = enginePath(type, src, dst);
        const last = path.length > 0 ? path[path.length - 1] : src;
        const flight = resolvePlaneFlight(
          grid,
          type,
          dst,
          last,
          last,
          [src],
          spec(type),
          AIRSTRIKE_PLANE_SPEED,
        )!;
        expect(flight).not.toBeNull();
        [src, ...path].forEach((tile, k) => {
          const p = flightPoint(flight, k);
          expect(Math.abs(p.x - grid.x(tile))).toBeLessThanOrEqual(0.5);
          expect(Math.abs(p.y - grid.y(tile))).toBeLessThanOrEqual(0.5);
          expect(flightStep(flight, tile)).toBe(k);
        });
        // It ends exactly where the strike resolves.
        const end = flightPoint(flight, flight.steps);
        expect(end).toEqual({ x: grid.x(last), y: grid.y(last) });
      }
    }
  });

  it("moves forward the same distance every step: no stalls, no jumps", () => {
    const { src, dst } = { src: ref(163, 139), dst: ref(200, 150) };
    const flight = resolvePlaneFlight(
      grid,
      UnitType.BombingRun,
      dst,
      dst,
      dst,
      [src],
      spec(UnitType.BombingRun),
      AIRSTRIKE_PLANE_SPEED,
    )!;
    const step = (k: number) => {
      const a = flightPoint(flight, k);
      const b = flightPoint(flight, k + 1);
      return Math.hypot(b.x - a.x, b.y - a.y);
    };
    for (let k = 0; k < flight.steps; k++) {
      expect(step(k)).toBeCloseTo(step(0), 9);
    }
  });

  it("the rounded steps the old renderer pointed along really do alternate", () => {
    // Documents the cause: a (37, 11) course is (2,1) and (2,0) steps.
    const src = ref(163, 139);
    const path = enginePath(UnitType.BombingRun, src, ref(200, 150));
    const headings = new Set<number>();
    let prev = src;
    for (const tile of path) {
      headings.add(
        planeHeadingByte(
          grid.x(tile) - grid.x(prev),
          grid.y(tile) - grid.y(prev),
        ),
      );
      prev = tile;
    }
    expect(headings.size).toBeGreaterThan(1);
  });

  it("finds the airport the plane left among several, mid-flight too", () => {
    const dst = ref(200, 150);
    const real = ref(120, 150);
    // Airports in other directions, one dead ahead (a line the other way along
    // the same row), and none closer than structures may be (15 tiles).
    const decoys = [ref(200, 60), ref(280, 230), ref(300, 150), ref(200, 240)];
    const path = enginePath(UnitType.StrafingRun, real, dst);
    for (let k = 1; k < path.length; k++) {
      const flight = resolvePlaneFlight(
        grid,
        UnitType.StrafingRun,
        dst,
        path[k],
        path[k - 1],
        [...decoys, real],
        spec(UnitType.StrafingRun),
        AIRSTRIKE_PLANE_SPEED,
      );
      expect(flight).not.toBeNull();
      expect({ x: flight!.ox, y: flight!.oy }).toEqual({ x: 120, y: 150 });
    }
  });

  it("locks onto its own airport at launch and keeps it, whatever lines cross it", () => {
    const dst = ref(200, 150);
    const real = ref(120, 150);
    const nearlyParallel = ref(120, 166);
    const path = [real, ...enginePath(UnitType.StrafingRun, real, dst)];
    // Seen at launch (on the airport) the real one is the only match.
    const flight = resolvePlaneFlight(
      grid,
      UnitType.StrafingRun,
      dst,
      real,
      real,
      [nearlyParallel, real],
      spec(UnitType.StrafingRun),
      AIRSTRIKE_PLANE_SPEED,
    )!;
    expect({ x: flight.ox, y: flight.oy }).toEqual({ x: 120, y: 150 });
    // ...and every later tile of the flight is on it, in order.
    path.forEach((tile, k) => expect(flightStep(flight, tile)).toBe(k));
  });

  it("is null when no candidate airport flies through the plane's tile", () => {
    expect(
      resolvePlaneFlight(
        grid,
        UnitType.BombingRun,
        ref(200, 150),
        ref(10, 10),
        ref(10, 10),
        [ref(120, 150)],
        spec(UnitType.BombingRun),
        AIRSTRIKE_PLANE_SPEED,
      ),
    ).toBeNull();
  });

  it("a strafing run clipped at the map edge still flies one line to its end", () => {
    // Approaching the right edge: the run's exit is clipped at x = W - 1.
    const src = ref(W - 60, 150);
    const dst = ref(W - 10, 150);
    const path = enginePath(UnitType.StrafingRun, src, dst);
    expect(grid.x(path[path.length - 1])).toBe(W - 1);
    const flight = resolvePlaneFlight(
      grid,
      UnitType.StrafingRun,
      dst,
      path[path.length - 1],
      path[path.length - 2],
      [src],
      spec(UnitType.StrafingRun),
      AIRSTRIKE_PLANE_SPEED,
    )!;
    expect(flight.ey).toBe(150);
    expect(flight.ex).toBe(W - 1);
  });
});

// ── The unit pass draws planes on that line ─────────────────────────────────

interface Harness {
  pass: UnitPass;
  f32: Float32Array;
  u8: Uint8Array;
  smoothSegs: number[];
}

function harness(structures: UnitState[]): Harness {
  const f32 = new Float32Array(64);
  const u8 = new Uint8Array(f32.buffer);
  const smoothSegs: number[] = [];
  const pass = Object.create(UnitPass.prototype) as UnitPass;
  Object.assign(pass, {
    mapW: W,
    grid,
    config: Config.prototype,
    planeFlights: new Map(),
    seenPlanes: new Set(),
    structures: new Map(structures.map((s) => [s.id, s])),
    smoothSegs,
    missileCount: 0,
    missileBuf: { float32: f32, uint8: u8, ensureCapacity: () => {} },
  });
  return { pass, f32, u8, smoothSegs };
}

const unit = (over: Partial<UnitState>): UnitState =>
  ({
    id: 7,
    unitType: UnitType.BombingRun,
    ownerID: 3,
    pos: 0,
    lastPos: 0,
    targetTile: null,
    isActive: true,
    ...over,
  }) as UnitState;

afterEach(() => vi.restoreAllMocks());

describe("UnitPass draws airstrike planes on their line", () => {
  it("every tick: on the line, easing from the last step, nose one way", () => {
    const src = ref(163, 139);
    const dst = ref(200, 150);
    const airport = unit({
      id: 1,
      unitType: "Airport",
      ownerID: 3,
      pos: src,
      lastPos: src,
    });
    const h = harness([airport]);
    const path = [src, ...enginePath(UnitType.BombingRun, src, dst)];
    const headings = new Set<number>();
    for (let k = 1; k < path.length; k++) {
      h.smoothSegs.length = 0;
      (h.pass as unknown as { missileCount: number }).missileCount = 0;
      const ok = (
        h.pass as unknown as {
          emitPlane(u: UnitState, a: number, f: number): boolean;
        }
      ).emitPlane(
        unit({ pos: path[k], lastPos: path[k - 1], targetTile: dst }),
        12,
        0,
      );
      expect(ok).toBe(true);
      // Drawn on the exact line, eased from the previous exact point.
      const t = k / (path.length - 1);
      expect(h.f32[0]).toBeCloseTo(163 + 37 * t, 3);
      expect(h.f32[1]).toBeCloseTo(139 + 11 * t, 3);
      const t0 = (k - 1) / (path.length - 1);
      const seg = h.smoothSegs.slice(1);
      [163 + 37 * t0, 139 + 11 * t0, 163 + 37 * t, 139 + 11 * t].forEach(
        (v, i) => expect(seg[i]).toBeCloseTo(v, 9),
      );
      headings.add(h.u8[15]);
    }
    expect([...headings]).toEqual([planeHeadingByte(37, 11)]);
  });

  it("works from any direction, including straight down and from map edges", () => {
    for (const [sx, sy] of [
      [200, 10],
      [5, 150],
      [W - 5, 290],
      [390, 5],
    ]) {
      const src = ref(sx, sy);
      const dst = ref(200, 150);
      const h = harness([
        unit({ id: 1, unitType: "Airport", pos: src, lastPos: src }),
      ]);
      const path = [src, ...enginePath(UnitType.RocketStrike, src, dst)];
      const k = Math.floor(path.length / 2);
      (
        h.pass as unknown as {
          emitPlane(u: UnitState, a: number, f: number): boolean;
        }
      ).emitPlane(
        unit({
          unitType: UnitType.RocketStrike,
          pos: path[k],
          lastPos: path[k - 1],
          targetTile: dst,
        }),
        12,
        0,
      );
      const end = path[path.length - 1];
      expect(h.u8[15]).toBe(
        planeHeadingByte(grid.x(end) - sx, grid.y(end) - sy),
      );
    }
  });

  it("finds its line from where it was first seen when its airport is gone", () => {
    const src = ref(100, 100);
    const dst = ref(200, 150);
    const path = [src, ...enginePath(UnitType.BombingRun, src, dst)];
    const h = harness([]);
    const emit = (k: number) =>
      (
        h.pass as unknown as {
          emitPlane(u: UnitState, a: number, f: number): boolean;
        }
      ).emitPlane(
        unit({
          pos: path[k],
          lastPos: path[Math.max(0, k - 1)],
          targetTile: dst,
        }),
        12,
        0,
      );
    expect(emit(0)).toBe(true); // first seen at the airport tile
    expect(emit(5)).toBe(true);
    expect(h.u8[15]).toBe(planeHeadingByte(100, 50));
  });
});
