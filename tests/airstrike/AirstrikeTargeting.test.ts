import {
  AirstrikeUnitType,
  UnitType,
} from "@openfront/engine-api/game/GameTypes";
import { GameUpdateType } from "@openfront/engine-api/game/GameUpdates";
import { ConstructionExecution } from "@openfront/engine/execution/ConstructionExecution";
import { Game, Unit } from "@openfront/engine/game/Game";
import { loadTestMaps } from "../util/Snapshot";
import { TestConfig } from "../util/TestConfig";
import { constructionExecution } from "../util/utils";
import {
  airportsOf,
  buildAirport,
  collect,
  conquerSquare,
  findLongRow,
  makeWorld,
  orderStrike,
  run,
  ShortRangeConfig,
  STRIKES,
} from "./helpers";

describe("airport placement", () => {
  test("builds on own land and cannot be upgraded", async () => {
    const { game, attacker } = await makeWorld();
    conquerSquare(game, attacker, 20, 20, 5);
    expect(attacker.canBuild(UnitType.Airport, game.ref(20, 20))).not.toBe(
      false,
    );
    const airport = buildAirport(game, attacker, 20, 20);
    expect(airport.isUnderConstruction()).toBe(false);
    expect(game.config().unitInfo(UnitType.Airport).upgradable).toBeFalsy();
  });

  test("cannot be built on enemy or unowned land", async () => {
    const { game, attacker, defender } = await makeWorld();
    conquerSquare(game, attacker, 20, 20, 5);
    conquerSquare(game, defender, 100, 100, 5);
    expect(attacker.canBuild(UnitType.Airport, game.ref(100, 100))).toBe(false);
    expect(attacker.canBuild(UnitType.Airport, game.ref(150, 20))).toBe(false);
  });

  test("takes 100 ticks (10 s) to build when not instant", async () => {
    const { game, attacker } = await makeWorld({
      config: { instantBuild: false },
    });
    conquerSquare(game, attacker, 20, 20, 5);
    expect(game.config().unitInfo(UnitType.Airport).constructionDuration).toBe(
      100,
    );
    orderStrike(game, attacker, UnitType.Airport, 20, 20, 3);
    const airport = airportsOf(attacker)[0];
    expect(airport.isUnderConstruction()).toBe(true);
    // Unusable while under construction.
    const { defender } = { defender: game.player("defender_id") };
    conquerSquare(game, defender, 60, 20, 3);
    expect(attacker.canBuild(UnitType.BombingRun, game.ref(60, 20))).toBe(
      false,
    );
    run(game, 100);
    expect(airport.isUnderConstruction()).toBe(false);
    expect(attacker.canBuild(UnitType.BombingRun, game.ref(60, 20))).toBe(
      airport.tile(),
    );
  });
});

describe("airstrike targeting", () => {
  test("without an airport nothing can be launched", async () => {
    const { game, attacker, defender } = await makeWorld();
    conquerSquare(game, attacker, 20, 20, 5);
    conquerSquare(game, defender, 60, 20, 5);
    for (const type of [UnitType.Airstrike, ...STRIKES]) {
      expect(attacker.canBuild(type, game.ref(60, 20))).toBe(false);
    }
    orderStrike(game, attacker, UnitType.BombingRun, 60, 20);
    expect(attacker.units(UnitType.BombingRun)).toHaveLength(0);
  });

  test("a hostile in-range target launches from the airport, for every type", async () => {
    const { game, attacker, defender } = await makeWorld();
    conquerSquare(game, attacker, 20, 20, 5);
    conquerSquare(game, defender, 100, 20, 5);
    const airport = buildAirport(game, attacker, 20, 20);
    for (const type of [UnitType.Airstrike, ...STRIKES]) {
      expect(attacker.canBuild(type, game.ref(100, 20))).toBe(airport.tile());
    }
  });

  test("all three strike types share one validity rule", async () => {
    const { game, attacker, defender } = await makeWorld();
    conquerSquare(game, attacker, 20, 20, 5);
    conquerSquare(game, defender, 100, 20, 5);
    buildAirport(game, attacker, 20, 20);
    const tiles = [game.ref(100, 20), game.ref(20, 20), game.ref(150, 150)];
    for (const t of tiles) {
      const answers = STRIKES.map((s) => attacker.canBuild(s, t) !== false);
      expect(new Set(answers).size).toBe(1);
    }
  });

  test("own, unowned and allied land are not targets", async () => {
    const { game, attacker, defender } = await makeWorld();
    conquerSquare(game, attacker, 20, 20, 5);
    conquerSquare(game, defender, 100, 20, 5);
    buildAirport(game, attacker, 20, 20);
    expect(attacker.canBuild(UnitType.Airstrike, game.ref(20, 20))).toBe(false);
    expect(attacker.canBuild(UnitType.Airstrike, game.ref(150, 150))).toBe(
      false,
    );
    attacker.createAllianceRequest(defender)!.accept();
    expect(attacker.canBuild(UnitType.Airstrike, game.ref(100, 20))).toBe(
      false,
    );
  });

  test("a disconnected ally's land is not a target either", async () => {
    const { game, attacker, defender } = await makeWorld();
    conquerSquare(game, attacker, 20, 20, 5);
    conquerSquare(game, defender, 100, 20, 5);
    buildAirport(game, attacker, 20, 20);
    attacker.createAllianceRequest(defender)!.accept();
    defender.markDisconnected(true);
    expect(attacker.canBuild(UnitType.Airstrike, game.ref(100, 20))).toBe(
      false,
    );
  });

  test("spawn protection blocks strikes", async () => {
    const { game, attacker, defender } = await makeWorld();
    conquerSquare(game, attacker, 20, 20, 5);
    conquerSquare(game, defender, 100, 20, 5);
    buildAirport(game, attacker, 20, 20);
    expect(attacker.canBuild(UnitType.Airstrike, game.ref(100, 20))).not.toBe(
      false,
    );
    (game.config() as TestConfig).setSpawnImmunityDuration(10_000);
    expect(attacker.canBuild(UnitType.Airstrike, game.ref(100, 20))).toBe(
      false,
    );
    expect(attacker.airstrikeAirport(game.ref(100, 20)).reason).toBe(
      "spawn_immunity",
    );
  });

  test("the reason is reported for each failure", async () => {
    const { game, attacker, defender } = await makeWorld();
    conquerSquare(game, attacker, 20, 20, 5);
    conquerSquare(game, defender, 100, 20, 5);
    expect(attacker.airstrikeAirport(game.ref(100, 20)).reason).toBe(
      "no_airport",
    );
    buildAirport(game, attacker, 20, 20);
    expect(attacker.airstrikeAirport(game.ref(20, 20)).reason).toBe(
      "not_hostile",
    );
    expect(attacker.airstrikeAirport(game.ref(150, 150)).reason).toBe(
      "not_hostile",
    );
    expect(attacker.airstrikeAirport(game.ref(100, 20)).reason).toBeNull();
  });

  test("the Airstrike selector is never built: its intent does nothing and costs nothing", async () => {
    const { game, attacker, defender } = await makeWorld({
      config: { infiniteGold: false },
    });
    conquerSquare(game, attacker, 20, 20, 5);
    conquerSquare(game, defender, 100, 20, 5);
    attacker.addGold(10_000_000n);
    constructionExecution(game, attacker, 20, 20, UnitType.Airport);
    const gold = attacker.gold();
    orderStrike(game, attacker, UnitType.Airstrike, 100, 20, 4);
    for (const type of STRIKES) {
      expect(attacker.units(type)).toHaveLength(0);
    }
    expect(attacker.units(UnitType.Airstrike)).toHaveLength(0);
    expect(attacker.gold()).toBeGreaterThanOrEqual(gold);
  });

  test("the strike is paid at launch, once", async () => {
    const { game, attacker, defender } = await makeWorld({
      config: { infiniteGold: false },
    });
    conquerSquare(game, attacker, 20, 20, 5);
    conquerSquare(game, defender, 100, 20, 5);
    attacker.addGold(10_000_000n);
    buildAirport(game, attacker, 20, 20);
    const before = attacker.gold();
    orderStrike(game, attacker, UnitType.RocketStrike, 100, 20);
    expect(before - attacker.gold()).toBeGreaterThanOrEqual(350_000n);
    expect(before - attacker.gold()).toBeLessThan(400_000n);
  });

  test("a strike you cannot afford is not launched", async () => {
    const { game, attacker, defender } = await makeWorld({
      config: { infiniteGold: false },
    });
    conquerSquare(game, attacker, 20, 20, 5);
    conquerSquare(game, defender, 100, 20, 5);
    attacker.addGold(10_000_000n);
    buildAirport(game, attacker, 20, 20);
    attacker.removeGold(attacker.gold());
    attacker.addGold(100_000n);
    expect(attacker.canBuild(UnitType.BombingRun, game.ref(100, 20))).toBe(
      false,
    );
    orderStrike(game, attacker, UnitType.BombingRun, 100, 20);
    expect(attacker.units(UnitType.BombingRun)).toHaveLength(0);
  });

  test("the nearest ready airport launches; a rearming one is skipped", async () => {
    const { game, attacker, defender } = await makeWorld();
    conquerSquare(game, attacker, 20, 20, 5);
    conquerSquare(game, attacker, 60, 20, 5);
    conquerSquare(game, defender, 120, 20, 5);
    const far = buildAirport(game, attacker, 20, 20);
    const near = buildAirport(game, attacker, 60, 20);
    expect(attacker.canBuild(UnitType.Airstrike, game.ref(120, 20))).toBe(
      near.tile(),
    );
    orderStrike(game, attacker, UnitType.BombingRun, 120, 20);
    expect(near.isInCooldown()).toBe(true);
    expect(attacker.canBuild(UnitType.Airstrike, game.ref(120, 20))).toBe(
      far.tile(),
    );
  });
});

describe("airport range", () => {
  test("exactly at the range edge a target is valid, one tile further it is not (range 100)", async () => {
    const { game, attacker, defender } = await makeWorld({
      configClass: ShortRangeConfig,
    });
    conquerSquare(game, attacker, 20, 100, 5);
    buildAirport(game, attacker, 20, 100);
    conquerSquare(game, defender, 120, 100, 0);
    conquerSquare(game, defender, 121, 100, 0);
    expect(game.config().airportRange()).toBe(100);
    expect(attacker.canBuild(UnitType.Airstrike, game.ref(120, 100))).not.toBe(
      false,
    );
    expect(attacker.canBuild(UnitType.Airstrike, game.ref(121, 100))).toBe(
      false,
    );
    expect(attacker.airstrikeAirport(game.ref(121, 100)).reason).toBe(
      "out_of_range",
    );
  });

  test("the real range is 400: 399 and 400 tiles away are valid, 401 is not", async () => {
    const maps = await loadTestMaps("world");
    const { x, y } = findLongRow(maps.gameMap, 400);
    const { game, attacker, defender } = await makeWorld({ map: "world" });
    conquerSquare(game, attacker, x, y, 0);
    for (const d of [399, 400, 401]) conquerSquare(game, defender, x + d, y, 0);
    buildAirport(game, attacker, x, y);
    expect(game.config().airportRange()).toBe(400);
    expect(
      attacker.canBuild(UnitType.Airstrike, game.ref(x + 399, y)),
    ).not.toBe(false);
    expect(
      attacker.canBuild(UnitType.Airstrike, game.ref(x + 400, y)),
    ).not.toBe(false);
    expect(attacker.canBuild(UnitType.Airstrike, game.ref(x + 401, y))).toBe(
      false,
    );
  });
});

/** Steps until the airport has just rearmed; asserts it was in cooldown the whole time. */
function stepToRearm(game: Game, airport: Unit, launchTick: number): void {
  while (game.ticks() < launchTick + 200) {
    expect(airport.isInCooldown()).toBe(true);
    game.executeNextTick();
  }
  // About to execute tick launch + 200, the one that reloads.
  expect(airport.isInCooldown()).toBe(true);
  game.executeNextTick();
  expect(airport.isInCooldown()).toBe(false);
}

describe("airport rearm", () => {
  test("after a strike the airport rearms 200 ticks after launch", async () => {
    const { game, attacker, defender } = await makeWorld();
    conquerSquare(game, attacker, 20, 20, 5);
    conquerSquare(game, defender, 100, 20, 5);
    const airport = buildAirport(game, attacker, 20, 20);
    orderStrike(game, attacker, UnitType.BombingRun, 100, 20);
    expect(airport.isInCooldown()).toBe(true);
    const launchTick = airport.missileTimerQueue()[0];
    expect(attacker.canBuild(UnitType.BombingRun, game.ref(100, 20))).toBe(
      false,
    );
    expect(attacker.airstrikeAirport(game.ref(100, 20)).reason).toBe(
      "airport_rearming",
    );
    stepToRearm(game, airport, launchTick);
    expect(attacker.canBuild(UnitType.BombingRun, game.ref(100, 20))).toBe(
      airport.tile(),
    );
  });

  test("the rearm is the same whichever strike was flown", async () => {
    for (const type of STRIKES) {
      const { game, attacker, defender } = await makeWorld();
      conquerSquare(game, attacker, 20, 20, 5);
      conquerSquare(game, defender, 100, 20, 5);
      const airport = buildAirport(game, attacker, 20, 20);
      orderStrike(game, attacker, type as AirstrikeUnitType, 100, 20);
      stepToRearm(game, airport, airport.missileTimerQueue()[0]);
    }
  });
});

describe("inbound warning", () => {
  test("the defender is warned with a translation key and params", async () => {
    const { game, attacker, defender } = await makeWorld();
    conquerSquare(game, attacker, 20, 20, 5);
    conquerSquare(game, defender, 100, 20, 5);
    buildAirport(game, attacker, 20, 20);
    game.addExecution(
      new ConstructionExecution(
        attacker,
        UnitType.StrafingRun,
        game.ref(100, 20),
      ),
    );
    const incoming = collect(game, GameUpdateType.UnitIncoming, 4);
    expect(incoming).toHaveLength(1);
    expect(incoming[0].message).toBe("events_display.airstrike_inbound");
    expect(incoming[0].params).toEqual({
      name: attacker.displayName(),
      unit: "unit_type.strafing_run",
    });
    expect(incoming[0].playerID).toBe(defender.smallID());
  });
});
