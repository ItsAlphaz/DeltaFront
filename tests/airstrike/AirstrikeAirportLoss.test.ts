import {
  AirstrikeUnitType,
  UnitType,
} from "@openfront/engine-api/game/GameTypes";
import {
  buildAirport,
  conquerRect,
  conquerSquare,
  makeWorld,
  planeOf,
  run,
  startStrike,
  STRIKES,
  World,
} from "./helpers";

const START = 1_000_000;

async function arena(): Promise<World> {
  const w = await makeWorld();
  conquerSquare(w.game, w.attacker, 20, 100, 5);
  conquerRect(w.game, w.defender, 60, 95, 140, 105);
  w.defender.setTroops(START);
  return w;
}

describe("destroying the launching airport mid-flight", () => {
  test.each(STRIKES)(
    "a %s already in the air continues and resolves normally",
    async (type) => {
      const { game, attacker, defender } = await arena();
      const airport = buildAirport(game, attacker, 20, 100);
      const plane = startStrike(
        game,
        attacker,
        type as AirstrikeUnitType,
        100,
        100,
      );
      run(game, 3);
      // The enemy destroys the airport while the plane is in flight.
      airport.delete(true, defender);
      expect(airport.isActive()).toBe(false);
      expect(plane.isActive()).toBe(true);
      run(game, 70);
      expect(plane.reachedTarget()).toBe(true);
      expect(defender.troops()).toBeLessThan(START);
      expect(planeOf(attacker, type as AirstrikeUnitType)).toBeUndefined();
      // Completed in full: no loss recorded.
      const stats = game.stats().getPlayerStats(attacker)?.air;
      const key = {
        [UnitType.BombingRun]: "bomb",
        [UnitType.RocketStrike]: "rckt",
        [UnitType.StrafingRun]: "strf",
      }[type as string] as "bomb";
      expect(stats?.[key]?.[1]).toBe(1n);
      expect(stats?.[key]?.[2] ?? 0n).toBe(0n);
    },
  );

  test("a destroyed airport can launch nothing more", async () => {
    const { game, attacker, defender } = await arena();
    const airport = buildAirport(game, attacker, 20, 100);
    expect(attacker.canBuild(UnitType.BombingRun, game.ref(100, 100))).toBe(
      airport.tile(),
    );
    airport.delete(true, defender);
    for (const type of [UnitType.Airstrike, ...STRIKES]) {
      expect(attacker.canBuild(type, game.ref(100, 100))).toBe(false);
    }
    expect(attacker.airstrikeAirport(game.ref(100, 100)).reason).toBe(
      "no_airport",
    );
  });

  test("a second airport can still launch after the first is destroyed", async () => {
    const { game, attacker, defender } = await arena();
    conquerSquare(game, attacker, 20, 140, 5);
    const first = buildAirport(game, attacker, 20, 100);
    const second = buildAirport(game, attacker, 20, 140);
    first.delete(true, defender);
    expect(attacker.canBuild(UnitType.BombingRun, game.ref(100, 100))).toBe(
      second.tile(),
    );
  });

  test("capturing the airport mid-flight does not stop the plane either", async () => {
    const { game, attacker, defender } = await arena();
    const airport = buildAirport(game, attacker, 20, 100);
    const plane = startStrike(game, attacker, UnitType.BombingRun, 100, 100);
    run(game, 3);
    defender.captureUnit(airport);
    expect(airport.owner()).toBe(defender);
    // The old owner can no longer launch from it.
    expect(attacker.units(UnitType.Airport)).toHaveLength(0);
    expect(plane.isActive()).toBe(true);
    run(game, 60);
    expect(plane.reachedTarget()).toBe(true);
    expect(defender.troops()).toBeLessThan(START);
  });

  test("a rocket strike still lands when its airport is destroyed the instant it takes off", async () => {
    const { game, attacker, defender } = await arena();
    const airport = buildAirport(game, attacker, 20, 100);
    const plane = startStrike(game, attacker, UnitType.RocketStrike, 100, 100);
    airport.delete(true, defender);
    run(game, 60);
    expect(plane.reachedTarget()).toBe(true);
    expect(defender.troops()).toBeLessThan(START);
  });
});
