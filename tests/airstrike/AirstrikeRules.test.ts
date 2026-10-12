import { GameMap } from "@openfront/engine-api/game/GameMap";
import { UnitType } from "@openfront/engine-api/game/GameTypes";
import {
  AirportInfo,
  airstrikeTroopLoss,
  pickAirstrikeAirport,
} from "@openfront/engine-lib/airstrike/AirstrikeRules";
import { Config } from "@openfront/engine-lib/configuration/Config";
import { loadTestMaps } from "../util/Snapshot";

let map: GameMap;
beforeAll(async () => {
  map = (await loadTestMaps("big_plains")).gameMap;
});

const airport = (
  map: GameMap,
  x: number,
  y: number,
  over: Partial<AirportInfo> = {},
): AirportInfo => ({
  tile: map.ref(x, y),
  active: true,
  underConstruction: false,
  inCooldown: false,
  ...over,
});

describe("pickAirstrikeAirport", () => {
  test("no airports -> no_airport", () => {
    expect(pickAirstrikeAirport(map, map.ref(100, 100), [], 400)).toEqual({
      airport: null,
      reason: "no_airport",
    });
  });

  test("inactive airports do not count", () => {
    const r = pickAirstrikeAirport(
      map,
      map.ref(100, 100),
      [airport(map, 50, 50, { active: false })],
      400,
    );
    expect(r.reason).toBe("no_airport");
  });

  test("out of range", () => {
    const r = pickAirstrikeAirport(
      map,
      map.ref(190, 190),
      [airport(map, 10, 10)],
      100,
    );
    expect(r).toEqual({ airport: null, reason: "out_of_range" });
  });

  test("range edge: exactly in range is valid, one tile further is not", () => {
    const a = airport(map, 10, 100);
    expect(
      pickAirstrikeAirport(map, map.ref(110, 100), [a], 100).reason,
    ).toBeNull();
    expect(pickAirstrikeAirport(map, map.ref(111, 100), [a], 100).reason).toBe(
      "out_of_range",
    );
  });

  test("airport still under construction", () => {
    const r = pickAirstrikeAirport(
      map,
      map.ref(100, 100),
      [airport(map, 50, 50, { underConstruction: true })],
      400,
    );
    expect(r.reason).toBe("airport_building");
  });

  test("airport rearming", () => {
    const r = pickAirstrikeAirport(
      map,
      map.ref(100, 100),
      [airport(map, 50, 50, { inCooldown: true })],
      400,
    );
    expect(r.reason).toBe("airport_rearming");
  });

  test("a rearming airport beats a building one in the reported reason", () => {
    const r = pickAirstrikeAirport(
      map,
      map.ref(100, 100),
      [
        airport(map, 50, 50, { underConstruction: true }),
        airport(map, 60, 60, { inCooldown: true }),
      ],
      400,
    );
    expect(r.reason).toBe("airport_rearming");
  });

  test("the nearest ready airport launches", () => {
    const near = airport(map, 90, 100);
    const far = airport(map, 20, 100);
    const r = pickAirstrikeAirport(map, map.ref(110, 100), [far, near], 400);
    expect(r).toEqual({ airport: near.tile, reason: null });
  });

  test("a rearming nearer airport is skipped for a ready farther one", () => {
    const near = airport(map, 90, 100, { inCooldown: true });
    const far = airport(map, 20, 100);
    expect(
      pickAirstrikeAirport(map, map.ref(110, 100), [near, far], 400).airport,
    ).toBe(far.tile);
  });

  test("ties go to the first airport in the list", () => {
    const a = airport(map, 90, 100);
    const b = airport(map, 130, 100);
    expect(
      pickAirstrikeAirport(map, map.ref(110, 100), [a, b], 400).airport,
    ).toBe(a.tile);
    expect(
      pickAirstrikeAirport(map, map.ref(110, 100), [b, a], 400).airport,
    ).toBe(b.tile);
  });
});

describe("airstrikeTroopLoss", () => {
  const cfg = (t: UnitType) =>
    Config.prototype.airstrikeSpec.call(undefined, t);

  test("zero troops or zero hit tiles kill nothing", () => {
    expect(airstrikeTroopLoss(cfg(UnitType.BombingRun), 0, 10, 100)).toBe(0);
    expect(airstrikeTroopLoss(cfg(UnitType.BombingRun), 1000, 0, 100)).toBe(0);
  });

  test("loss is proportional to the share of land hit", () => {
    // 5 of 1000 tiles: 3.0 x 0.5% = 1.5% of 10,000.
    expect(airstrikeTroopLoss(cfg(UnitType.BombingRun), 10_000, 5, 1000)).toBe(
      150,
    );
  });

  test("each strike type caps its loss", () => {
    expect(airstrikeTroopLoss(cfg(UnitType.BombingRun), 10_000, 400, 400)).toBe(
      2500,
    );
    expect(
      airstrikeTroopLoss(cfg(UnitType.RocketStrike), 10_000, 400, 400),
    ).toBe(1000);
    expect(
      airstrikeTroopLoss(cfg(UnitType.StrafingRun), 10_000, 400, 400),
    ).toBe(500);
  });

  test("results are integers", () => {
    const loss = airstrikeTroopLoss(cfg(UnitType.BombingRun), 12_345, 7, 333);
    expect(Number.isInteger(loss)).toBe(true);
  });

  test("a player with no land owned does not divide by zero", () => {
    expect(
      Number.isFinite(
        airstrikeTroopLoss(cfg(UnitType.RocketStrike), 1000, 1, 0),
      ),
    ).toBe(true);
  });
});
