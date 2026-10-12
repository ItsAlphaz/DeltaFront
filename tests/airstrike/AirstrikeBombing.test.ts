import { UnitType } from "@openfront/engine-api/game/GameTypes";
import {
  AirstrikeImpactPhase,
  GameUpdateType,
} from "@openfront/engine-api/game/GameUpdates";
import { discTiles } from "@openfront/engine-lib/airstrike/AirstrikeGeometry";
import {
  buildAirport,
  collect,
  conquerSquare,
  flightLength,
  levelOf,
  makeWorld,
  placeDefender,
  planeOf,
  run,
  startStrike,
  World,
} from "./helpers";

const T = UnitType.BombingRun;

/** Attacker with an airport at (20, 100); the strike target is (100, 100). */
async function arena(
  opts: Parameters<typeof makeWorld>[0] = {},
): Promise<World> {
  const w = await makeWorld(opts);
  conquerSquare(w.game, w.attacker, 20, 100, 5);
  buildAirport(w.game, w.attacker, 20, 100);
  return w;
}

describe("Bombing Run", () => {
  test("a full-coverage small player loses exactly the 25% cap", async () => {
    const { game, attacker, defender } = await arena();
    placeDefender(game, defender, 100, 100, 5, 100_000);
    startStrike(game, attacker, T, 100, 100);
    run(game, 45);
    expect(defender.troops()).toBe(75_000);
    expect(planeOf(attacker, T)).toBeUndefined();
  });

  test("a big player loses troops in proportion to the land hit", async () => {
    const { game, attacker, defender } = await arena();
    placeDefender(game, defender, 100, 100, 60, 1_000_000);
    const hit = discTiles(game, game.ref(100, 100), 10).length;
    const owned = defender.numTilesOwned();
    const bps = Math.min(2500, Math.floor((30_000 * hit) / owned));
    expect(bps).toBeLessThan(2500);
    startStrike(game, attacker, T, 100, 100);
    run(game, 45);
    expect(defender.troops()).toBe(
      1_000_000 - Math.floor((1_000_000 * bps) / 10_000),
    );
  });

  test("the plane flies at 2 tiles per tick and the bombs fall when it arrives", async () => {
    const { game, attacker, defender } = await arena();
    placeDefender(game, defender, 100, 100, 5, 100_000);
    const src = game.ref(20, 100);
    const dst = game.ref(100, 100);
    expect(flightLength(game, src, dst, T)).toBe(40);
    const plane = startStrike(game, attacker, T, 100, 100);
    expect(plane.tile()).toBe(src);
    run(game, 39);
    expect(plane.isActive()).toBe(true);
    expect(game.x(plane.tile())).toBe(98);
    expect(defender.troops()).toBe(100_000);
    run(game, 1);
    expect(plane.isActive()).toBe(false);
    expect(plane.reachedTarget()).toBe(true);
    expect(defender.troops()).toBe(75_000);
  });

  test("a hostile structure in the blast loses a level; a level-1 one is destroyed", async () => {
    const { game, attacker, defender } = await arena();
    placeDefender(game, defender, 100, 100, 8, 100_000);
    const city = defender.buildUnit(UnitType.City, game.ref(100, 100), {});
    const factory = defender.buildUnit(
      UnitType.Factory,
      game.ref(106, 100),
      {},
    );
    const far = defender.buildUnit(UnitType.Port, game.ref(100, 111), {});
    conquerSquare(game, defender, 100, 111, 0);
    city.increaseLevel();
    city.increaseLevel();
    expect(city.level()).toBe(3);
    startStrike(game, attacker, T, 100, 100);
    run(game, 45);
    expect(levelOf(city)).toBe(2);
    expect(city.isActive()).toBe(true);
    expect(factory.isActive()).toBe(false);
    // 11 tiles away: outside the 10-tile blast.
    expect(levelOf(far)).toBe(1);
    // The destruction goes through the normal path: stats record it.
    const attackerUnits = game.stats().getPlayerStats(attacker)?.units;
    const defenderUnits = game.stats().getPlayerStats(defender)?.units;
    expect(attackerUnits?.fact?.[1]).toBe(1n);
    expect(defenderUnits?.fact?.[3]).toBe(1n);
  });

  test("never destroys land", async () => {
    const { game, attacker, defender } = await arena();
    placeDefender(game, defender, 100, 100, 8, 100_000);
    const tiles = defender.numTilesOwned();
    const land = discTiles(game, game.ref(100, 100), 10).filter((t) =>
      game.isLand(t),
    ).length;
    startStrike(game, attacker, T, 100, 100);
    run(game, 45);
    expect(defender.numTilesOwned()).toBe(tiles);
    expect(
      discTiles(game, game.ref(100, 100), 10).filter((t) => game.isLand(t)),
    ).toHaveLength(land);
    expect(game.hasFallout(game.ref(100, 100))).toBe(false);
  });

  test("own and allied troops and structures are untouched", async () => {
    const { game, attacker, defender } = await makeWorld({
      extra: ["ally_id"],
    });
    const ally = game.player("ally_id");
    conquerSquare(game, attacker, 20, 100, 5);
    buildAirport(game, attacker, 20, 100);
    placeDefender(game, defender, 100, 100, 3, 100_000);
    placeDefender(game, ally, 106, 100, 2, 100_000);
    attacker.createAllianceRequest(ally)!.accept();
    // The attacker's own land inside the blast, with a structure.
    conquerSquare(game, attacker, 100, 106, 1);
    attacker.setTroops(100_000);
    const own = attacker.buildUnit(UnitType.City, game.ref(100, 106), {});
    const allied = ally.buildUnit(UnitType.City, game.ref(106, 100), {});
    const enemy = defender.buildUnit(UnitType.City, game.ref(100, 100), {});
    startStrike(game, attacker, T, 100, 100);
    run(game, 45);
    expect(enemy.isActive()).toBe(false);
    expect(defender.troops()).toBeLessThan(100_000);
    expect(own.isActive()).toBe(true);
    expect(allied.isActive()).toBe(true);
    expect(ally.troops()).toBe(100_000);
    expect(attacker.troops()).toBe(100_000);
  });

  test("an alliance formed while the plane is in the air spares the new ally", async () => {
    const { game, attacker, defender } = await arena();
    placeDefender(game, defender, 100, 100, 5, 100_000);
    const city = defender.buildUnit(UnitType.City, game.ref(100, 100), {});
    startStrike(game, attacker, T, 100, 100);
    run(game, 20);
    attacker.createAllianceRequest(defender)!.accept();
    run(game, 30);
    expect(defender.troops()).toBe(100_000);
    expect(city.isActive()).toBe(true);
  });

  test("a disconnected ally's troops and structures are spared (AFK counts as friendly)", async () => {
    const { game, attacker, defender } = await arena();
    placeDefender(game, defender, 100, 100, 5, 100_000);
    const city = defender.buildUnit(UnitType.City, game.ref(100, 100), {});
    startStrike(game, attacker, T, 100, 100);
    run(game, 10);
    attacker.createAllianceRequest(defender)!.accept();
    defender.markDisconnected(true);
    expect(attacker.isFriendly(defender)).toBe(false);
    expect(attacker.isFriendly(defender, true)).toBe(true);
    run(game, 40);
    expect(defender.troops()).toBe(100_000);
    expect(city.isActive()).toBe(true);
  });

  test("unowned land is hit by nothing and the strike still completes", async () => {
    const { game, attacker, defender } = await arena();
    placeDefender(game, defender, 100, 100, 1, 100_000);
    startStrike(game, attacker, T, 100, 100);
    // The target's owner loses the land before the bombs fall.
    defender.relinquish(game.ref(100, 100));
    run(game, 45);
    expect(planeOf(attacker, T)).toBeUndefined();
  });

  test("the impact is announced once, over the target", async () => {
    const { game, attacker, defender } = await arena();
    placeDefender(game, defender, 100, 100, 5, 100_000);
    startStrike(game, attacker, T, 100, 100);
    const impacts = collect(game, GameUpdateType.AirstrikeImpact, 45);
    expect(impacts).toHaveLength(1);
    expect(impacts[0]).toMatchObject({
      strikeType: T,
      phase: AirstrikeImpactPhase.BombImpact,
      from: game.ref(100, 100),
      to: game.ref(100, 100),
      radius: 10,
      attackerID: attacker.smallID(),
      affected: [defender.smallID()],
    });
  });

  test("the victim and the attacker are told what happened", async () => {
    const { game, attacker, defender } = await arena();
    placeDefender(game, defender, 100, 100, 5, 100_000);
    startStrike(game, attacker, T, 100, 100);
    const messages = collect(game, GameUpdateType.DisplayEvent, 45);
    const keys = messages.map((m) => m.message);
    expect(keys).toContain("events_display.airstrike_hit");
    expect(keys).toContain("events_display.airstrike_result");
    const hit = messages.find(
      (m) => m.message === "events_display.airstrike_hit",
    )!;
    expect(hit.playerID).toBe(defender.smallID());
    expect(hit.params).toMatchObject({ unit: "unit_type.bombing_run" });
  });
});
