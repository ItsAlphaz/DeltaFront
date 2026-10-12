import { UnitType } from "@openfront/engine-api/game/GameTypes";
import {
  AIR_INDEX_COMPLETE,
  AIR_INDEX_INTERCEPT,
  AIR_INDEX_LAUNCH,
  AIR_INDEX_LEVELS_DESTROYED,
  AIR_INDEX_SHOT_DOWN,
  AIR_INDEX_STRUCTURES_DESTROYED,
  AIR_INDEX_TROOPS_KILLED,
  airUnits,
  ArchivedPlayerStatsSchema,
  otherUnits,
  PlayerStatsSchema,
  unitTypeToAirUnit,
  unitTypeToOtherUnit,
} from "@openfront/engine-api/StatsSchemas";
import { constructionExecution } from "../util/utils";
import {
  buildAirport,
  conquerRect,
  conquerSquare,
  makeWorld,
  placeDefender,
  run,
  startStrike,
  SureHitConfig,
} from "./helpers";

describe("airstrike stats: schema compatibility", () => {
  test("a record without airstrike data still parses (strict and archived readers)", () => {
    const old = {
      attacks: [1n, 2n],
      units: { city: [3n], fact: [1n, 1n] },
      bombs: { abomb: [2n, 1n, 1n] },
      spawnTile: 12,
    };
    expect(PlayerStatsSchema.parse(old)).toMatchObject(old);
    expect(ArchivedPlayerStatsSchema.parse(old)).toMatchObject(old);
  });

  test("JSON-style (string) records parse and keep the new fields", () => {
    const record = {
      units: { airp: ["2", "1"] },
      air: { bomb: ["3", "2", "1", "0", "50000", "4", "1"] },
    };
    const parsed = PlayerStatsSchema.parse(record)!;
    expect(parsed.units?.airp).toEqual([2n, 1n]);
    expect(parsed.air?.bomb).toEqual([3n, 2n, 1n, 0n, 50000n, 4n, 1n]);
    expect(ArchivedPlayerStatsSchema.parse(record)).toEqual(parsed);
  });

  test("the new keys are appended: existing positions are unchanged", () => {
    expect(otherUnits.slice(0, 7)).toEqual([
      "city",
      "defp",
      "port",
      "wshp",
      "silo",
      "saml",
      "fact",
    ]);
    expect(otherUnits[7]).toBe("airp");
    expect(airUnits).toEqual(["bomb", "rckt", "strf"]);
    expect(unitTypeToAirUnit[UnitType.BombingRun]).toBe("bomb");
    expect(unitTypeToOtherUnit[UnitType.Airport]).toBe("airp");
    expect([
      AIR_INDEX_LAUNCH,
      AIR_INDEX_COMPLETE,
      AIR_INDEX_SHOT_DOWN,
      AIR_INDEX_INTERCEPT,
      AIR_INDEX_TROOPS_KILLED,
      AIR_INDEX_LEVELS_DESTROYED,
      AIR_INDEX_STRUCTURES_DESTROYED,
    ]).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  test("an unknown airstrike key is rejected", () => {
    expect(() => PlayerStatsSchema.parse({ air: { nuke: [1n] } })).toThrow();
  });
});

describe("airport stats", () => {
  test("built, destroyed, captured and lost are counted", async () => {
    const { game, attacker, defender } = await makeWorld({
      extra: ["third_id"],
    });
    const third = game.player("third_id");
    conquerSquare(game, attacker, 20, 100, 5);
    conquerSquare(game, third, 20, 140, 5);
    conquerSquare(game, defender, 20, 60, 5);
    const first = buildAirport(game, attacker, 20, 100);
    const second = buildAirport(game, third, 20, 140);
    // built
    expect(game.stats().getPlayerStats(attacker)?.units?.airp?.[0]).toBe(1n);
    // destroyed by the defender: they get the kill, the owner records the loss
    first.delete(true, defender);
    expect(game.stats().getPlayerStats(defender)?.units?.airp?.[1]).toBe(1n);
    expect(game.stats().getPlayerStats(attacker)?.units?.airp?.[3]).toBe(1n);
    // captured by the defender
    defender.captureUnit(second);
    expect(game.stats().getPlayerStats(defender)?.units?.airp?.[2]).toBe(1n);
    expect(game.stats().getPlayerStats(third)?.units?.airp?.[3]).toBe(1n);
  });
});

describe("airstrike stats: counters", () => {
  test("a bombing run that lands counts launch, completion, troops and structure damage", async () => {
    const { game, attacker, defender } = await makeWorld();
    conquerSquare(game, attacker, 20, 100, 5);
    buildAirport(game, attacker, 20, 100);
    placeDefender(game, defender, 100, 100, 5, 100_000);
    defender.buildUnit(UnitType.City, game.ref(100, 100), {});
    const upgraded = defender.buildUnit(
      UnitType.Factory,
      game.ref(104, 100),
      {},
    );
    upgraded.increaseLevel();
    startStrike(game, attacker, UnitType.BombingRun, 100, 100);
    run(game, 45);
    const air = game.stats().getPlayerStats(attacker)?.air?.bomb;
    expect(air?.[AIR_INDEX_LAUNCH]).toBe(1n);
    expect(air?.[AIR_INDEX_COMPLETE]).toBe(1n);
    expect(air?.[AIR_INDEX_SHOT_DOWN] ?? 0n).toBe(0n);
    expect(air?.[AIR_INDEX_TROOPS_KILLED]).toBe(25_000n);
    // City destroyed (1 level), factory L2 -> L1 (1 level).
    expect(air?.[AIR_INDEX_LEVELS_DESTROYED]).toBe(2n);
    expect(air?.[AIR_INDEX_STRUCTURES_DESTROYED]).toBe(1n);
    // Nothing leaks into the other strike types or the nuke stats.
    expect(game.stats().getPlayerStats(attacker)?.air?.rckt).toBeUndefined();
    expect(game.stats().getPlayerStats(attacker)?.bombs).toBeUndefined();
  });

  test("each strike type is counted under its own key", async () => {
    const { game, attacker, defender } = await makeWorld();
    conquerSquare(game, attacker, 20, 100, 5);
    conquerSquare(game, attacker, 20, 140, 5);
    buildAirport(game, attacker, 20, 100);
    buildAirport(game, attacker, 20, 140);
    conquerRect(game, defender, 60, 95, 140, 145);
    defender.setTroops(1_000_000);
    startStrike(game, attacker, UnitType.RocketStrike, 100, 100);
    startStrike(game, attacker, UnitType.StrafingRun, 100, 140);
    run(game, 70);
    const air = game.stats().getPlayerStats(attacker)?.air;
    expect(air?.rckt?.[AIR_INDEX_LAUNCH]).toBe(1n);
    expect(air?.strf?.[AIR_INDEX_LAUNCH]).toBe(1n);
    expect(air?.rckt?.[AIR_INDEX_COMPLETE]).toBe(1n);
    expect(air?.strf?.[AIR_INDEX_COMPLETE]).toBe(1n);
    expect(air?.bomb).toBeUndefined();
  });

  test("a shot-down aircraft is counted lost for its owner and an interception for the SAM owner", async () => {
    const { game, attacker, defender } = await makeWorld({
      configClass: SureHitConfig,
    });
    conquerSquare(game, attacker, 20, 100, 5);
    buildAirport(game, attacker, 20, 100);
    placeDefender(game, defender, 100, 100, 5, 100_000);
    conquerSquare(game, defender, 60, 106, 1);
    constructionExecution(game, defender, 60, 106, UnitType.SAMLauncher);
    startStrike(game, attacker, UnitType.StrafingRun, 100, 100);
    run(game, 70);
    const a = game.stats().getPlayerStats(attacker)?.air?.strf;
    const d = game.stats().getPlayerStats(defender)?.air?.strf;
    expect(a?.[AIR_INDEX_LAUNCH]).toBe(1n);
    expect(a?.[AIR_INDEX_SHOT_DOWN]).toBe(1n);
    expect(a?.[AIR_INDEX_COMPLETE] ?? 0n).toBe(0n);
    expect(d?.[AIR_INDEX_INTERCEPT]).toBe(1n);
  });

  test("nuke interception statistics are untouched by aircraft interceptions", async () => {
    const { game, attacker, defender } = await makeWorld({
      configClass: SureHitConfig,
    });
    conquerSquare(game, attacker, 20, 100, 5);
    buildAirport(game, attacker, 20, 100);
    placeDefender(game, defender, 100, 100, 5, 100_000);
    conquerSquare(game, defender, 60, 106, 1);
    constructionExecution(game, defender, 60, 106, UnitType.SAMLauncher);
    startStrike(game, attacker, UnitType.BombingRun, 100, 100);
    run(game, 70);
    expect(game.stats().getPlayerStats(defender)?.bombs).toBeUndefined();
  });
});
