import { GameUpdates, UnitType } from "@openfront/engine-api/game/GameTypes";
import {
  AirstrikeImpactPhase,
  GameUpdateType,
} from "@openfront/engine-api/game/GameUpdates";
import { constructionExecution } from "../util/utils";
import {
  buildAirport,
  conquerSquare,
  flightLength,
  levelOf,
  makeWorld,
  NeverHitConfig,
  placeDefender,
  planeOf,
  run,
  startStrike,
  World,
} from "./helpers";

const T = UnitType.RocketStrike;

async function arena(
  opts: Parameters<typeof makeWorld>[0] = {},
): Promise<World> {
  const w = await makeWorld(opts);
  conquerSquare(w.game, w.attacker, 20, 100, 5);
  buildAirport(w.game, w.attacker, 20, 100);
  return w;
}

/** Index (1-based tick count after `from`) of the update of this phase. */
function tickOfPhase(
  updates: GameUpdates[],
  phase: AirstrikeImpactPhase,
): number | null {
  const i = updates.findIndex((u) =>
    u[GameUpdateType.AirstrikeImpact].some((e) => e.phase === phase),
  );
  return i === -1 ? null : i + 1;
}

describe("Rocket Strike", () => {
  test("the plane flies at 2 tiles per tick and stops 10 tiles short of the target", async () => {
    const { game, attacker, defender } = await arena();
    placeDefender(game, defender, 100, 100, 3, 100_000);
    const src = game.ref(20, 100);
    const dst = game.ref(100, 100);
    // 70 tiles to the release point at 2 tiles/tick.
    expect(flightLength(game, src, dst, T)).toBe(35);
    const plane = startStrike(game, attacker, T, 100, 100);
    run(game, 34);
    expect(plane.isActive()).toBe(true);
    expect(game.x(plane.tile())).toBe(88);
    const updates = run(game, 1);
    expect(plane.isActive()).toBe(false);
    const release = updates[0][GameUpdateType.AirstrikeImpact][0];
    expect(release.phase).toBe(AirstrikeImpactPhase.RocketRelease);
    expect(release.from).toBe(game.ref(90, 100));
    expect(release.to).toBe(dst);
  });

  test("the rockets hit exactly 3 ticks after release, not before", async () => {
    const { game, attacker, defender } = await arena();
    placeDefender(game, defender, 100, 100, 2, 100_000);
    startStrike(game, attacker, T, 100, 100);
    const updates = run(game, 45);
    const released = tickOfPhase(updates, AirstrikeImpactPhase.RocketRelease)!;
    const impact = tickOfPhase(updates, AirstrikeImpactPhase.RocketImpact)!;
    expect(released).toBe(35);
    expect(impact - released).toBe(3);

    // No damage until the impact tick.
    const w = await arena();
    placeDefender(w.game, w.defender, 100, 100, 2, 100_000);
    startStrike(w.game, w.attacker, T, 100, 100);
    run(w.game, released + 2);
    expect(w.defender.troops()).toBe(100_000);
    run(w.game, 1);
    expect(w.defender.troops()).toBeLessThan(100_000);
  });

  test("only land within 4 tiles of the target is hit, capped at 10%", async () => {
    const { game, attacker, defender } = await makeWorld({
      extra: ["bystander_id"],
    });
    const bystander = game.player("bystander_id");
    conquerSquare(game, attacker, 20, 100, 5);
    buildAirport(game, attacker, 20, 100);
    placeDefender(game, defender, 100, 100, 2, 100_000);
    placeDefender(game, bystander, 108, 100, 1, 100_000);
    startStrike(game, attacker, T, 100, 100);
    run(game, 45);
    expect(defender.troops()).toBe(90_000);
    expect(bystander.troops()).toBe(100_000);
  });

  test("a small share of a big territory is hit proportionally (factor 4.0)", async () => {
    const { game, attacker, defender } = await arena();
    placeDefender(game, defender, 100, 100, 60, 1_000_000);
    startStrike(game, attacker, T, 100, 100);
    run(game, 45);
    const hit = 49; // the r = 4 disc
    const bps = Math.min(
      1000,
      Math.floor((40_000 * hit) / defender.numTilesOwned()),
    );
    expect(defender.troops()).toBe(
      1_000_000 - Math.floor((1_000_000 * bps) / 10_000),
    );
  });

  test("hits the nearest hostile structure within 6 tiles for 2 levels", async () => {
    const { game, attacker, defender } = await arena();
    placeDefender(game, defender, 100, 100, 8, 100_000);
    const city = defender.buildUnit(UnitType.City, game.ref(102, 100), {});
    city.increaseLevel();
    city.increaseLevel();
    const second = defender.buildUnit(UnitType.Factory, game.ref(100, 105), {});
    startStrike(game, attacker, T, 100, 100);
    run(game, 45);
    expect(levelOf(city)).toBe(1);
    // Only one structure per rocket strike.
    expect(second.isActive()).toBe(true);
  });

  test("destroys a level-1 SAM, silo and airport outright", async () => {
    for (const type of [
      UnitType.SAMLauncher,
      UnitType.MissileSilo,
      UnitType.Airport,
    ]) {
      const { game, attacker, defender } = await arena();
      placeDefender(game, defender, 100, 100, 6, 100_000);
      const target = defender.buildUnit(type, game.ref(101, 100), {});
      startStrike(game, attacker, T, 100, 100);
      run(game, 45);
      expect(target.isActive()).toBe(false);
    }
  });

  test("a structure just out of the lock radius is not hit", async () => {
    const { game, attacker, defender } = await arena();
    placeDefender(game, defender, 100, 100, 8, 100_000);
    const near = defender.buildUnit(UnitType.City, game.ref(106, 100), {});
    const far = defender.buildUnit(UnitType.Factory, game.ref(107, 100), {});
    startStrike(game, attacker, T, 100, 100);
    run(game, 45);
    expect(near.isActive()).toBe(false);
    expect(far.isActive()).toBe(true);
  });

  test("skips friendly structures and hits the nearest valid hostile one", async () => {
    const { game, attacker, defender } = await makeWorld({
      extra: ["ally_id"],
    });
    const ally = game.player("ally_id");
    conquerSquare(game, attacker, 20, 100, 5);
    buildAirport(game, attacker, 20, 100);
    placeDefender(game, defender, 100, 100, 6, 100_000);
    placeDefender(game, ally, 102, 98, 0, 100_000);
    conquerSquare(game, attacker, 104, 100, 0);
    attacker.createAllianceRequest(ally)!.accept();
    const allied = ally.buildUnit(UnitType.City, game.ref(102, 98), {});
    const own = attacker.buildUnit(UnitType.City, game.ref(104, 100), {});
    const hostile = defender.buildUnit(
      UnitType.SAMLauncher,
      game.ref(95, 100),
      {},
    );
    startStrike(game, attacker, T, 100, 100);
    run(game, 45);
    expect(allied.isActive()).toBe(true);
    expect(own.isActive()).toBe(true);
    expect(hostile.isActive()).toBe(false);
  });

  test("with only friendly structures nearby, nothing is destroyed", async () => {
    const { game, attacker, defender } = await arena();
    placeDefender(game, defender, 100, 100, 2, 100_000);
    conquerSquare(game, attacker, 103, 100, 0);
    const own = attacker.buildUnit(UnitType.City, game.ref(103, 100), {});
    startStrike(game, attacker, T, 100, 100);
    run(game, 45);
    expect(own.isActive()).toBe(true);
    expect(defender.troops()).toBeLessThan(100_000);
  });

  test("allies formed after release are spared on impact", async () => {
    const { game, attacker, defender } = await arena();
    placeDefender(game, defender, 100, 100, 3, 100_000);
    const city = defender.buildUnit(UnitType.City, game.ref(101, 100), {});
    startStrike(game, attacker, T, 100, 100);
    run(game, 36); // released, rockets in the air
    attacker.createAllianceRequest(defender)!.accept();
    run(game, 5);
    expect(defender.troops()).toBe(100_000);
    expect(city.isActive()).toBe(true);
  });

  test("a plane destroyed before release drops no rockets", async () => {
    const { game, attacker, defender } = await arena();
    placeDefender(game, defender, 100, 100, 3, 100_000);
    const city = defender.buildUnit(UnitType.City, game.ref(101, 100), {});
    const plane = startStrike(game, attacker, T, 100, 100);
    run(game, 10);
    plane.delete(true, defender);
    const updates = run(game, 40);
    expect(tickOfPhase(updates, AirstrikeImpactPhase.RocketRelease)).toBeNull();
    expect(tickOfPhase(updates, AirstrikeImpactPhase.RocketImpact)).toBeNull();
    expect(defender.troops()).toBe(100_000);
    expect(city.isActive()).toBe(true);
  });

  test("once released, the rockets land even if a SAM misses the plane", async () => {
    const { game, attacker, defender } = await arena({
      configClass: NeverHitConfig,
    });
    placeDefender(game, defender, 100, 100, 3, 100_000);
    conquerSquare(game, defender, 90, 104, 0);
    // A real SAM (with its execution) that never hits.
    constructionExecution(game, defender, 90, 104, UnitType.SAMLauncher);
    const city = defender.buildUnit(UnitType.City, game.ref(101, 100), {});
    startStrike(game, attacker, T, 100, 100);
    let samFired = false;
    for (let i = 0; i < 45; i++) {
      game.executeNextTick();
      if (game.unitCount(UnitType.SAMMissile) > 0) samFired = true;
    }
    expect(samFired).toBe(true);
    expect(city.isActive()).toBe(false);
    expect(planeOf(attacker, T)).toBeUndefined();
  });

  test("a rocket strike from inside the standoff releases immediately", async () => {
    const { game, attacker, defender } = await makeWorld();
    conquerSquare(game, attacker, 90, 100, 3);
    buildAirport(game, attacker, 90, 100);
    placeDefender(game, defender, 100, 100, 2, 100_000);
    startStrike(game, attacker, T, 100, 100);
    const updates = run(game, 6);
    expect(
      tickOfPhase(updates, AirstrikeImpactPhase.RocketRelease),
    ).not.toBeNull();
    expect(defender.troops()).toBe(90_000);
  });
});
