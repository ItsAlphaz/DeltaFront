import { UnitType } from "@openfront/engine-api/game/GameTypes";
import { GameUpdateType } from "@openfront/engine-api/game/GameUpdates";
import { discTiles } from "@openfront/engine-lib/airstrike/AirstrikeGeometry";
import {
  airstrikeArmyLoss,
  airstrikeCityMultiplierBps,
  airstrikeTroopLoss,
} from "@openfront/engine-lib/airstrike/AirstrikeRules";
import {
  AIRSTRIKE_CITY_AREA_RADIUS,
  Config,
} from "@openfront/engine-lib/configuration/Config";
import {
  applyTroopDamage,
  DamageTotal,
  planTroopDamage,
  victimCityLevels,
} from "@openfront/engine/execution/airstrike/AirstrikeDamage";
import { AttackExecution } from "@openfront/engine/execution/AttackExecution";
import { Game, Player } from "@openfront/engine/game/Game";
import {
  afterLoss,
  buildAirport,
  collect,
  conquerRect,
  conquerSquare,
  makeWorld,
  placeDefender,
  run,
  startStrike,
  STRIKES,
} from "./helpers";

const spec = (t: UnitType) => Config.prototype.airstrikeSpec.call(undefined, t);

/** A city of `level` for `owner` at (x, y), finished. */
function city(game: Game, owner: Player, x: number, y: number, level = 1) {
  const c = owner.buildUnit(UnitType.City, game.ref(x, y), {});
  while (c.level() < level) c.increaseLevel();
  return c;
}

describe("airstrike rules: city bonus and army damage", () => {
  test("the city multiplier grows with the city's level and stops at level 5", () => {
    const s = spec(UnitType.BombingRun);
    expect(airstrikeCityMultiplierBps(s, 0)).toBe(10_000);
    expect(airstrikeCityMultiplierBps(s, 1)).toBe(15_000);
    expect(airstrikeCityMultiplierBps(s, 3)).toBe(17_500);
    expect(airstrikeCityMultiplierBps(s, 5)).toBe(20_000);
    expect(airstrikeCityMultiplierBps(s, 9)).toBe(20_000);
  });

  test("every strike's city bonus is stronger than no city, rockets the strongest", () => {
    for (const t of STRIKES) {
      expect(airstrikeCityMultiplierBps(spec(t), 1)).toBeGreaterThan(10_000);
      expect(spec(t).cityCapBps).toBeGreaterThan(spec(t).troopCapBps);
    }
    const at5 = (t: UnitType) => airstrikeCityMultiplierBps(spec(t), 5);
    expect(at5(UnitType.RocketStrike)).toBeGreaterThan(
      at5(UnitType.BombingRun),
    );
    expect(at5(UnitType.BombingRun)).toBeGreaterThan(at5(UnitType.StrafingRun));
  });

  test("next to a city the garrison loss is multiplied, then capped at the city cap", () => {
    const s = spec(UnitType.BombingRun);
    // 30 of 10,000 tiles: 6.0 x 0.3% = 180 bps; x1.5 next to a level-1 city.
    expect(airstrikeTroopLoss(s, 100_000, 30, 10_000)).toBe(1_800);
    expect(airstrikeTroopLoss(s, 100_000, 30, 10_000, 1)).toBe(2_700);
    // Full coverage: the plain cap is 30%, the city cap 45%.
    expect(airstrikeTroopLoss(s, 100_000, 100, 100)).toBe(30_000);
    expect(airstrikeTroopLoss(s, 100_000, 100, 100, 5)).toBe(45_000);
  });

  test("an army loses in proportion to the share of its front hit: concentration matters", () => {
    const s = spec(UnitType.StrafingRun);
    // The same 100k troops with 10 front tiles hit.
    const short = airstrikeArmyLoss(s, 100_000, 10, 50); // 8.0 x 20% -> cap 20%
    const long = airstrikeArmyLoss(s, 100_000, 10, 1_000); // 8.0 x 1% = 8%
    expect(short).toBe(20_000);
    expect(long).toBe(8_000);
    expect(airstrikeArmyLoss(s, 100_000, 0, 50)).toBe(0);
    expect(airstrikeArmyLoss(s, 0, 10, 50)).toBe(0);
  });
});

describe("airstrike damage in the game: cities", () => {
  async function bigDefender() {
    const w = await makeWorld();
    // A big territory, so the plain loss is far below every cap.
    placeDefender(w.game, w.defender, 100, 100, 60, 1_000_000);
    return w;
  }
  const blast = (game: Game) => discTiles(game, game.ref(100, 100), 10);

  test("a garrison next to one of its cities loses more, by the city's level", async () => {
    const plain = await bigDefender();
    const hit = blast(plain.game).length;
    const owned = plain.defender.numTilesOwned();
    const base = Math.floor((60_000 * hit) / owned);
    const expect1 = Math.floor((base * 15_000) / 10_000);
    const expect4 = Math.floor((base * 18_750) / 10_000);

    let totals: DamageTotal[] = [];
    applyTroopDamage(
      plain.game,
      plain.attacker,
      blast(plain.game),
      spec(UnitType.BombingRun),
      totals,
    );
    expect(plain.defender.troops()).toBe(afterLoss(1_000_000, base));

    const l1 = await bigDefender();
    city(l1.game, l1.defender, 100, 100, 1);
    totals = [];
    const r1 = applyTroopDamage(
      l1.game,
      l1.attacker,
      blast(l1.game),
      spec(UnitType.BombingRun),
      totals,
    );
    expect(l1.defender.troops()).toBe(afterLoss(1_000_000, expect1));
    expect(r1.cityLevel).toBe(1);

    const l4 = await bigDefender();
    city(l4.game, l4.defender, 100, 100, 4);
    const r4 = applyTroopDamage(
      l4.game,
      l4.attacker,
      blast(l4.game),
      spec(UnitType.BombingRun),
      [],
    );
    expect(l4.defender.troops()).toBe(afterLoss(1_000_000, expect4));
    expect(r4.cityLevel).toBe(4);
    expect(r4.killed).toBe(1_000_000 - l4.defender.troops());
  });

  test("several cities in reach give one bonus (the highest level), never one each", async () => {
    const one = await bigDefender();
    city(one.game, one.defender, 100, 100, 2);
    applyTroopDamage(
      one.game,
      one.attacker,
      blast(one.game),
      spec(UnitType.BombingRun),
      [],
    );

    const many = await bigDefender();
    city(many.game, many.defender, 100, 100, 2);
    city(many.game, many.defender, 92, 100, 1);
    city(many.game, many.defender, 108, 100, 2);
    city(many.game, many.defender, 100, 108, 1);
    applyTroopDamage(
      many.game,
      many.attacker,
      blast(many.game),
      spec(UnitType.BombingRun),
      [],
    );
    expect(many.defender.troops()).toBe(one.defender.troops());
  });

  test("a city out of reach, under construction, or someone else's gives no bonus", async () => {
    const reach = 10 + AIRSTRIKE_CITY_AREA_RADIUS;
    const w = await bigDefender();
    const g = w.game;
    city(g, w.defender, 100 + reach + 1, 100, 5);
    expect(victimCityLevels(g, w.attacker, blast(g)).size).toBe(0);
    city(g, w.defender, 100 + reach, 100, 3);
    expect(victimCityLevels(g, w.attacker, blast(g)).get(w.defender)).toBe(3);

    const building = await bigDefender();
    const site = building.defender.buildUnit(
      UnitType.City,
      building.game.ref(100, 100),
      {},
    );
    site.setUnderConstruction(true);
    expect(
      victimCityLevels(building.game, building.attacker, blast(building.game))
        .size,
    ).toBe(0);

    // The attacker's own city next to the target does not raise the victim's loss.
    const own = await bigDefender();
    conquerSquare(own.game, own.attacker, 100, 100, 0);
    city(own.game, own.attacker, 100, 100, 5);
    expect(victimCityLevels(own.game, own.attacker, blast(own.game)).size).toBe(
      0,
    );
  });

  test("a full-coverage city garrison loses the city cap, never everything", async () => {
    for (const t of STRIKES) {
      const w = await makeWorld();
      placeDefender(w.game, w.defender, 100, 100, 1, 100_000);
      city(w.game, w.defender, 100, 100, 5);
      applyTroopDamage(
        w.game,
        w.attacker,
        discTiles(w.game, w.game.ref(100, 100), 3),
        spec(t),
        [],
      );
      expect(w.defender.troops()).toBe(afterLoss(100_000, spec(t).cityCapBps));
      expect(w.defender.troops()).toBeGreaterThan(50_000);
    }
  });

  test("a bombing run on a city reports the casualties it really caused, and the city", async () => {
    const w = await makeWorld();
    conquerSquare(w.game, w.attacker, 20, 100, 5);
    buildAirport(w.game, w.attacker, 20, 100);
    placeDefender(w.game, w.defender, 100, 100, 40, 500_000);
    city(w.game, w.defender, 103, 100, 3);
    startStrike(w.game, w.attacker, UnitType.BombingRun, 100, 100);
    const before = w.defender.troops();
    const impacts = collect(w.game, GameUpdateType.AirstrikeImpact, 45);
    expect(impacts).toHaveLength(1);
    // Troop growth between launch and impact is not counted: only the strike.
    expect(impacts[0].killed).toBeGreaterThan(0);
    expect(impacts[0].cityLevel).toBe(3);
    expect(impacts[0].levels).toBe(1);
    expect(w.defender.troops()).toBeLessThan(before);
  });
});

describe("airstrike damage in the game: armies", () => {
  /** Defender attacks a third player across the line x = 120; returns the attack. */
  async function attackingDefender(troops = 200_000) {
    const w = await makeWorld({ extra: ["third_id"] });
    const third = w.game.player("third_id");
    conquerRect(w.game, w.defender, 60, 60, 119, 140);
    conquerRect(w.game, third, 120, 60, 180, 140);
    w.defender.setTroops(1_000_000);
    third.setTroops(1_000_000);
    w.game.addExecution(new AttackExecution(troops, w.defender, third.id()));
    run(w.game, 2);
    const attack = w.defender.outgoingAttacks()[0];
    if (attack === undefined) throw new Error("no attack");
    return { ...w, third, attack };
  }

  test("a strike on the front kills attacking troops; one away from it does not", async () => {
    const w = await attackingDefender();
    const front = w.attack.borderTiles();
    const frontX = Math.min(...[...front].map((t) => w.game.x(t)));
    const before = w.attack.troops();
    const plan = planTroopDamage(
      w.game,
      w.attacker,
      discTiles(w.game, w.game.ref(70, 100), 10),
      spec(UnitType.BombingRun),
    );
    expect(plan.attacks).toHaveLength(0);

    const tiles = discTiles(w.game, w.game.ref(frontX - 1, 100), 10);
    const hitFront = tiles.filter((t) => front.has(t)).length;
    expect(hitFront).toBeGreaterThan(0);
    const expected = airstrikeArmyLoss(
      spec(UnitType.BombingRun),
      before,
      hitFront,
      front.size,
    );
    const result = applyTroopDamage(
      w.game,
      w.attacker,
      tiles,
      spec(UnitType.BombingRun),
      [],
    );
    expect(w.attack.troops()).toBe(before - expected);
    expect(result.killed).toBeGreaterThanOrEqual(expected);
  });

  test("the third player being attacked is not hurt by a strike on someone else's army", async () => {
    const w = await attackingDefender();
    const before = w.third.troops();
    const front = [...w.attack.borderTiles()];
    const x = Math.min(...front.map((t) => w.game.x(t))) - 3;
    // Only the defender's land in the area: the third player's tiles stay out.
    const tiles = discTiles(w.game, w.game.ref(x, 100), 2).filter(
      (t) => w.game.owner(t) === w.defender,
    );
    applyTroopDamage(w.game, w.attacker, tiles, spec(UnitType.StrafingRun), []);
    expect(w.third.troops()).toBe(before);
  });

  test("every strike type stays bounded: an army is never wiped out by one application", async () => {
    for (const t of STRIKES) {
      const w = await attackingDefender(300_000);
      const before = w.attack.troops();
      applyTroopDamage(
        w.game,
        w.attacker,
        [...w.attack.borderTiles()],
        spec(t),
        [],
      );
      expect(w.attack.troops()).toBe(afterLoss(before, spec(t).armyCapBps));
      expect(w.attack.troops()).toBeGreaterThan(before / 2);
    }
  });
});
