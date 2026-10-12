import { GameMap } from "@openfront/engine-api/game/GameMap";
import { UnitType } from "@openfront/engine-api/game/GameTypes";
import {
  airstrikeEndPoint,
  airstrikeFlightPath,
  alongTrack,
  burstTriggerSteps,
  corridorBurstTiles,
  corridorTiles,
  discTiles,
  strafingCorridor,
  straightPath,
} from "@openfront/engine-lib/airstrike/AirstrikeGeometry";
import {
  AIRSTRIKE_PLANE_SPEED,
  Config,
} from "@openfront/engine-lib/configuration/Config";
import { loadTestMaps } from "../util/Snapshot";

// 200x200 land. Specs are plain data, so any Config instance serves them.
const spec = (type: UnitType) =>
  Config.prototype.airstrikeSpec.call(undefined, type);

let map: GameMap;
beforeAll(async () => {
  map = (await loadTestMaps("big_plains")).gameMap;
});

describe("straightPath", () => {
  test("ends exactly on the target, one tile per tick at 2 tiles/tick", () => {
    const src = map.ref(10, 10);
    const dst = map.ref(60, 10);
    const path = straightPath(map, src, dst, AIRSTRIKE_PLANE_SPEED);
    expect(path).toHaveLength(Math.ceil(50 / AIRSTRIKE_PLANE_SPEED));
    expect(path[path.length - 1]).toBe(dst);
    expect(path).not.toContain(src);
  });

  test("diagonal path has ceil(dist / 2) steps and ends on the target", () => {
    const src = map.ref(10, 10);
    const dst = map.ref(40, 50);
    const path = straightPath(map, src, dst, 2);
    expect(path).toHaveLength(Math.ceil(Math.sqrt(30 * 30 + 40 * 40) / 2));
    expect(path[path.length - 1]).toBe(dst);
  });
});

describe("airstrikeEndPoint / airstrikeFlightPath", () => {
  test("bombing run ends over the target", () => {
    const s = map.ref(10, 100);
    const d = map.ref(100, 100);
    expect(
      airstrikeEndPoint(
        map,
        s,
        d,
        UnitType.BombingRun,
        spec(UnitType.BombingRun),
      ),
    ).toBe(d);
  });

  test("rocket strike is released 10 tiles short of the target", () => {
    const s = map.ref(10, 100);
    const d = map.ref(100, 100);
    const end = airstrikeEndPoint(
      map,
      s,
      d,
      UnitType.RocketStrike,
      spec(UnitType.RocketStrike),
    );
    expect(end).toBe(map.ref(90, 100));
  });

  test("rocket strike from within 10 tiles releases at the airport", () => {
    const s = map.ref(10, 100);
    const d = map.ref(18, 100);
    const rocket = spec(UnitType.RocketStrike);
    expect(airstrikeEndPoint(map, s, d, UnitType.RocketStrike, rocket)).toBe(s);
    expect(
      airstrikeFlightPath(map, s, d, UnitType.RocketStrike, rocket, 2),
    ).toEqual([]);
  });

  test("strafing run flies D + 20 + 8 tiles along the line", () => {
    const s = map.ref(10, 100);
    const d = map.ref(100, 100);
    const end = airstrikeEndPoint(
      map,
      s,
      d,
      UnitType.StrafingRun,
      spec(UnitType.StrafingRun),
    );
    expect(end).toBe(map.ref(10 + 90 + 20 + 8, 100));
  });

  test("strafing exit is clipped at the map edge", () => {
    const s = map.ref(10, 100);
    const d = map.ref(185, 100);
    const end = airstrikeEndPoint(
      map,
      s,
      d,
      UnitType.StrafingRun,
      spec(UnitType.StrafingRun),
    );
    expect(map.x(end)).toBe(199);
    expect(map.y(end)).toBe(100);
    const path = airstrikeFlightPath(
      map,
      s,
      d,
      UnitType.StrafingRun,
      spec(UnitType.StrafingRun),
      2,
    );
    expect(path[path.length - 1]).toBe(end);
  });

  test("diagonal strafing exit stays on the map", () => {
    const s = map.ref(5, 5);
    const d = map.ref(190, 190);
    const end = airstrikeEndPoint(
      map,
      s,
      d,
      UnitType.StrafingRun,
      spec(UnitType.StrafingRun),
    );
    expect(map.isValidRef(end)).toBe(true);
  });
});

describe("strafing corridor", () => {
  const strafe = () => spec(UnitType.StrafingRun);

  test("a horizontal approach covers exactly 41 x 5 tiles centred on the target", () => {
    const s = map.ref(10, 100);
    const d = map.ref(100, 100);
    const c = strafingCorridor(map, s, d, strafe());
    const tiles = corridorTiles(map, c);
    expect(tiles).toHaveLength(41 * 5);
    const xs = tiles.map((t) => map.x(t));
    const ys = tiles.map((t) => map.y(t));
    expect(Math.min(...xs)).toBe(80);
    expect(Math.max(...xs)).toBe(120);
    expect(Math.min(...ys)).toBe(98);
    expect(Math.max(...ys)).toBe(102);
  });

  test("the direction is airport -> target (vertical approach)", () => {
    const s = map.ref(100, 150);
    const d = map.ref(100, 60);
    const c = strafingCorridor(map, s, d, strafe());
    expect(c.ux).toBeCloseTo(0, 12);
    expect(c.uy).toBeCloseTo(-1, 12);
    const tiles = corridorTiles(map, c);
    expect(Math.min(...tiles.map((t) => map.y(t)))).toBe(40);
    expect(Math.max(...tiles.map((t) => map.y(t)))).toBe(80);
  });

  test("the four bursts partition the corridor", () => {
    const s = map.ref(10, 100);
    const d = map.ref(100, 100);
    const c = strafingCorridor(map, s, d, strafe());
    const all = corridorTiles(map, c);
    const parts = [0, 1, 2, 3].map((k) => corridorBurstTiles(map, c, k));
    const flat = parts.flat();
    expect(flat).toHaveLength(all.length);
    expect(new Set(flat).size).toBe(flat.length);
    expect(new Set(flat)).toEqual(new Set(all));
    // Bursts are consecutive along the flight line.
    const maxAlong = parts.map((p) =>
      Math.max(...p.map((t) => alongTrack(map, c, t))),
    );
    expect([...maxAlong].sort((a, b) => a - b)).toEqual(maxAlong);
  });

  test("a corridor never starts behind the airport", () => {
    const s = map.ref(100, 100);
    const d = map.ref(110, 100);
    const c = strafingCorridor(map, s, d, strafe());
    expect(c.sStart).toBe(0);
    for (const t of corridorTiles(map, c)) {
      expect(alongTrack(map, c, t)).toBeGreaterThanOrEqual(0);
    }
  });

  test("burst trigger steps are non-decreasing and inside the path", () => {
    const s = map.ref(10, 100);
    const d = map.ref(100, 100);
    const sp = strafe();
    const c = strafingCorridor(map, s, d, sp);
    const path = airstrikeFlightPath(map, s, d, UnitType.StrafingRun, sp, 2);
    const steps = burstTriggerSteps(map, path, c);
    expect(steps).toHaveLength(4);
    for (let i = 1; i < steps.length; i++) {
      expect(steps[i]).toBeGreaterThanOrEqual(steps[i - 1]);
    }
    expect(steps[steps.length - 1]).toBeLessThanOrEqual(path.length - 1);
    // The final burst fires when the plane clears the corridor, not at its end.
    expect(steps[3]).toBeLessThan(path.length - 1);
  });

  test("results are identical when computed twice", () => {
    const s = map.ref(33, 77);
    const d = map.ref(150, 120);
    const a = corridorTiles(map, strafingCorridor(map, s, d, strafe()));
    const b = corridorTiles(map, strafingCorridor(map, s, d, strafe()));
    expect(a).toEqual(b);
  });
});

describe("discTiles", () => {
  test("is the euclidean disc, scan order y then x", () => {
    const tiles = discTiles(map, map.ref(100, 100), 4);
    for (const t of tiles) {
      const dx = map.x(t) - 100;
      const dy = map.y(t) - 100;
      expect(dx * dx + dy * dy).toBeLessThanOrEqual(16);
    }
    expect(tiles).toHaveLength(49);
    const ys = tiles.map((t) => map.y(t));
    expect([...ys].sort((a, b) => a - b)).toEqual(ys);
  });

  test("is clamped to the map", () => {
    const tiles = discTiles(map, map.ref(0, 0), 10);
    for (const t of tiles) expect(map.isValidRef(t)).toBe(true);
    expect(tiles.length).toBeLessThan(Math.PI * 100);
  });
});
