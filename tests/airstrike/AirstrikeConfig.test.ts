import {
  AirstrikeTypes,
  Difficulty,
  PlayerInfo,
  PlayerType,
  UnitType,
} from "@openfront/engine-api/game/GameTypes";
import {
  AIRPORT_RANGE_TILES,
  AIRPORT_REARM_TICKS,
  AIRSTRIKE_PLANE_SPEED,
} from "@openfront/engine-lib/configuration/Config";
import { setup } from "../util/Setup";
import { TestConfig } from "../util/TestConfig";
import { conquerSquare, makeWorld } from "./helpers";

describe("airstrike configuration", () => {
  test("airport range is exactly 400 tiles, rearm 200 ticks, planes fly 2 tiles/tick", async () => {
    const { game } = await makeWorld();
    const config = game.config();
    expect(AIRPORT_RANGE_TILES).toBe(400);
    expect(config.airportRange()).toBe(400);
    expect(AIRPORT_REARM_TICKS).toBe(200);
    expect(config.AirportCooldown()).toBe(200);
    expect(config.launcherCooldown(UnitType.Airport)).toBe(200);
    expect(config.launcherCooldown(UnitType.MissileSilo)).toBe(
      config.SiloCooldown(),
    );
    expect(AIRSTRIKE_PLANE_SPEED).toBe(2);
    expect(config.airstrikePlaneSpeed()).toBe(2);
  });

  test("every strike type flies at the same speed (speed is not part of a spec)", async () => {
    const { game } = await makeWorld();
    for (const type of AirstrikeTypes.types) {
      expect(game.config().airstrikeSpec(type)).not.toHaveProperty("speed");
    }
  });

  test("specs carry the planned balance values", async () => {
    const { game } = await makeWorld();
    const c = game.config();
    expect(c.airstrikeSpec(UnitType.BombingRun)).toMatchObject({
      radius: 10,
      troopFactorBps: 30_000,
      troopCapBps: 2_500,
      structureRadius: 10,
      structureLevels: 1,
      samHitPercent: 65,
      telegraphRadius: 10,
    });
    expect(c.airstrikeSpec(UnitType.RocketStrike)).toMatchObject({
      radius: 4,
      troopFactorBps: 40_000,
      troopCapBps: 1_000,
      structureRadius: 6,
      structureLevels: 2,
      maxStructures: 1,
      samHitPercent: 50,
      standoff: 10,
      rocketFlightTicks: 3,
      telegraphRadius: 4,
    });
    expect(c.airstrikeSpec(UnitType.StrafingRun)).toMatchObject({
      radius: 2,
      troopFactorBps: 30_000,
      troopCapBps: 500,
      structureRadius: 1.5,
      structureLevels: 1,
      maxStructures: 1,
      samHitPercent: 60,
      corridorLength: 40,
      corridorBursts: 4,
      exitTail: 8,
      telegraphRadius: 0,
    });
  });

  test("airstrikeSpec rejects non-strike unit types", async () => {
    const { game } = await makeWorld();
    expect(() => game.config().airstrikeSpec(UnitType.City)).toThrow();
    expect(() => game.config().airstrikeSpec(UnitType.Airstrike)).toThrow();
  });

  test("the Airstrike toggle disables all three strike types", async () => {
    const { game } = await makeWorld({
      config: { disabledUnits: [UnitType.Airstrike] },
    });
    expect(game.config().isUnitDisabled(UnitType.Airstrike)).toBe(true);
    for (const type of AirstrikeTypes.types) {
      expect(game.config().isUnitDisabled(type)).toBe(true);
    }
    expect(game.config().isUnitDisabled(UnitType.Airport)).toBe(false);
  });

  test("with nothing disabled no strike type is disabled", async () => {
    const { game } = await makeWorld();
    for (const type of [UnitType.Airstrike, ...AirstrikeTypes.types]) {
      expect(game.config().isUnitDisabled(type)).toBe(false);
    }
  });

  test("strike units have no construction time and are not upgradable", async () => {
    const { game } = await makeWorld();
    for (const type of AirstrikeTypes.types) {
      const info = game.config().unitInfo(type);
      expect(info.constructionDuration).toBeUndefined();
      expect(info.upgradable).toBeFalsy();
    }
  });
});

describe("airstrike costs", () => {
  test("strike prices", async () => {
    const { game, attacker } = await makeWorld({
      config: { infiniteGold: false },
    });
    const cost = (t: UnitType) =>
      game.config().unitInfo(t).cost(game, attacker);
    expect(cost(UnitType.BombingRun)).toBe(400_000n);
    expect(cost(UnitType.RocketStrike)).toBe(350_000n);
    expect(cost(UnitType.StrafingRun)).toBe(250_000n);
  });

  test("airport price: 1M, +500k each, capped at 2M", async () => {
    const { game, attacker } = await makeWorld({
      config: { infiniteGold: false },
    });
    conquerSquare(game, attacker, 50, 50, 40);
    const cost = () =>
      game.config().unitInfo(UnitType.Airport).cost(game, attacker);
    const expected = [1_000_000n, 1_500_000n, 2_000_000n, 2_000_000n];
    for (let i = 0; i < expected.length; i++) {
      expect(cost()).toBe(expected[i]);
      attacker.buildUnit(UnitType.Airport, game.ref(20 + i * 20, 50), {});
    }
  });

  test("the selector costs the cheapest enabled strike", async () => {
    const { game, attacker } = await makeWorld({
      config: { infiniteGold: false },
    });
    const selector = () =>
      game.config().unitInfo(UnitType.Airstrike).cost(game, attacker);
    expect(selector()).toBe(250_000n);

    const noStrafe = await makeWorld({
      config: { infiniteGold: false, disabledUnits: [UnitType.StrafingRun] },
    });
    expect(
      noStrafe.game
        .config()
        .unitInfo(UnitType.Airstrike)
        .cost(noStrafe.game, noStrafe.attacker),
    ).toBe(350_000n);
  });

  test("an infinite-gold human pays nothing", async () => {
    const { game, attacker } = await makeWorld();
    for (const type of [
      UnitType.Airport,
      UnitType.Airstrike,
      ...AirstrikeTypes.types,
    ]) {
      expect(game.config().unitInfo(type).cost(game, attacker)).toBe(0n);
    }
  });

  test("bots and nations are not special-cased", async () => {
    const game = await setup(
      "big_plains",
      { infiniteGold: false, difficulty: Difficulty.Hard },
      [new PlayerInfo("nation", PlayerType.Nation, null, "nation_id")],
      undefined,
      TestConfig,
    );
    expect(
      game
        .config()
        .unitInfo(UnitType.RocketStrike)
        .cost(game, game.player("nation_id")),
    ).toBe(350_000n);
  });
});
