import { UnitType } from "@openfront/engine-api/game/GameTypes";
import {
  corridorTiles,
  discTiles,
  strafingCorridor,
} from "@openfront/engine-lib/airstrike/AirstrikeGeometry";
import { Config } from "@openfront/engine-lib/configuration/Config";
import { makeWorld, STRIKES } from "./helpers";

/**
 * The line airstrikes must stay on: a cheaper, smaller, weaker tactical tool
 * than either nuclear weapon, so each weapon keeps its own job.
 */
describe("airstrikes against nuclear weapons", () => {
  test("every strike costs well under an atom bomb, which is under a hydrogen bomb", async () => {
    const { game, attacker } = await makeWorld({
      config: { infiniteGold: false },
    });
    const cost = (t: UnitType) =>
      game.config().unitInfo(t).cost(game, attacker);
    const atom = cost(UnitType.AtomBomb);
    expect(atom).toBe(750_000n);
    expect(cost(UnitType.HydrogenBomb)).toBe(5_000_000n);
    for (const t of STRIKES) {
      // At most 40% of an atom bomb.
      expect(cost(t) * 10n).toBeLessThanOrEqual(atom * 4n);
    }
    // Each type has its own price.
    expect(new Set(STRIKES.map((t) => cost(t))).size).toBe(3);
  });

  test("every strike's area is smaller than an atom bomb's inner blast", async () => {
    const { game } = await makeWorld();
    const c = game.config();
    // The real magnitudes (the test config shrinks nukes to 1 tile).
    const atom = Config.prototype.nukeMagnitudes.call(c, UnitType.AtomBomb);
    const hydro = Config.prototype.nukeMagnitudes.call(
      c,
      UnitType.HydrogenBomb,
    );
    const center = game.ref(100, 100);
    const atomInner = discTiles(game, center, atom.inner).length;
    for (const t of [UnitType.BombingRun, UnitType.RocketStrike]) {
      const s = c.airstrikeSpec(t);
      expect(s.radius).toBeLessThan(atom.inner);
      expect(s.radius).toBeLessThan(hydro.inner);
      expect(discTiles(game, center, s.radius).length).toBeLessThan(atomInner);
    }
    const strafe = c.airstrikeSpec(UnitType.StrafingRun);
    const corridor = corridorTiles(
      game,
      strafingCorridor(game, game.ref(20, 100), center, strafe),
    );
    expect(corridor.length).toBeLessThan(atomInner);
  });

  test("no strike can take more than 45% of a garrison or 35% of an army in one application", async () => {
    const { game } = await makeWorld();
    for (const t of STRIKES) {
      const s = game.config().airstrikeSpec(t);
      expect(s.troopCapBps).toBeLessThanOrEqual(3_000);
      expect(s.cityCapBps).toBeLessThanOrEqual(4_500);
      expect(s.armyCapBps).toBeLessThanOrEqual(3_500);
      // Nothing about a strike destroys land, as a nuke does.
    }
  });
});
