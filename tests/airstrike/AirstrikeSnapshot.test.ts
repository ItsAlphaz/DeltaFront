import {
  AirstrikeUnitType,
  GameMode,
  UnitType,
} from "@openfront/engine-api/game/GameTypes";
import { readVersioned } from "@openfront/engine-lib/snapshot/SnapshotType";
import {
  AirstrikeExecution,
  AirstrikeExecutionSnapshot,
} from "@openfront/engine/execution/AirstrikeExecution";
import { SAMMissileExecutionSnapshot } from "@openfront/engine/execution/SAMMissileExecution";
import { Game } from "@openfront/engine/game/Game";
import { snapshotGame } from "@openfront/engine/snapshot/GameSnapshot";
import { diffSnapshots, roundTrip } from "../util/Snapshot";
import { constructionExecution } from "../util/utils";
import {
  buildAirport,
  conquerRect,
  conquerSquare,
  makeWorld,
  NeverHitConfig,
  run,
  startStrike,
  STRIKES,
  SureHitConfig,
  World,
} from "./helpers";

const MAP = "big_plains";
const START = 1_000_000;

async function arena(
  opts: Parameters<typeof makeWorld>[0] = {},
): Promise<World> {
  const w = await makeWorld(opts);
  conquerSquare(w.game, w.attacker, 20, 100, 5);
  buildAirport(w.game, w.attacker, 20, 100);
  conquerRect(w.game, w.defender, 60, 95, 140, 105);
  w.defender.setTroops(START);
  w.defender.buildUnit(UnitType.City, w.game.ref(100, 100), {});
  return w;
}

/** Restores `game` from a snapshot, checks the round trip is exact, then that both play on identically. */
async function expectIdenticalAfter(game: Game, ticks: number): Promise<Game> {
  const { bytes, restored, again } = await roundTrip(game, MAP);
  expect(diffSnapshots(again, bytes)).toEqual([]);
  for (let i = 0; i < ticks; i++) {
    game.executeNextTick();
    restored.executeNextTick();
    expect(diffSnapshots(snapshotGame(restored), snapshotGame(game))).toEqual(
      [],
    );
  }
  return restored;
}

describe("airstrike snapshots", () => {
  test.each(STRIKES)(
    "a %s mid-flight restores and plays on identically",
    async (type) => {
      const w = await arena();
      startStrike(w.game, w.attacker, type as AirstrikeUnitType, 100, 100);
      run(w.game, 12);
      const restored = await expectIdenticalAfter(w.game, 60);
      expect(restored.player("defender_id").troops()).toBe(w.defender.troops());
      expect(w.defender.troops()).toBeLessThan(START);
    },
  );

  test("a strafing run mid-pass (after two bursts) restores with its progress", async () => {
    const w = await arena();
    startStrike(w.game, w.attacker, UnitType.StrafingRun, 100, 100);
    run(w.game, 42);
    const troops = w.defender.troops();
    expect(troops).toBeLessThan(START);
    const restored = await expectIdenticalAfter(w.game, 25);
    // The two bursts already delivered are not delivered twice, and the other two still come.
    expect(restored.player("defender_id").troops()).toBe(w.defender.troops());
    expect(w.defender.troops()).toBeLessThan(troops);
  });

  test("a rocket strike in the 'rockets in the air' phase restores and still lands", async () => {
    const w = await arena();
    startStrike(w.game, w.attacker, UnitType.RocketStrike, 100, 100);
    run(w.game, 36); // released at tick 35, impact at 38
    expect(w.attacker.units(UnitType.RocketStrike)).toHaveLength(0);
    expect(w.defender.troops()).toBe(START);
    const restored = await expectIdenticalAfter(w.game, 6);
    expect(restored.player("defender_id").troops()).toBeLessThan(START);
    expect(restored.player("defender_id").troops()).toBe(w.defender.troops());
  });

  test("a strike that has not launched yet restores and launches", async () => {
    const w = await arena();
    constructionExecution(w.game, w.attacker, 100, 100, UnitType.BombingRun, 1);
    await expectIdenticalAfter(w.game, 50);
    expect(w.defender.troops()).toBeLessThan(START);
  });

  test.each([
    ["a SAM missile that will hit", SureHitConfig],
    ["a SAM missile that will miss", NeverHitConfig],
  ] as const)(
    "%s, in flight at the moment of the snapshot",
    async (label, configClass) => {
      const w = await arena({ configClass });
      conquerSquare(w.game, w.defender, 60, 106, 1);
      constructionExecution(w.game, w.defender, 60, 106, UnitType.SAMLauncher);
      startStrike(w.game, w.attacker, UnitType.BombingRun, 100, 100);
      let guard = 0;
      while (w.game.unitCount(UnitType.SAMMissile) === 0 && guard++ < 80) {
        w.game.executeNextTick();
      }
      expect(w.game.unitCount(UnitType.SAMMissile)).toBe(1);
      const restored = await expectIdenticalAfter(w.game, 40);
      const wasHit =
        w.attacker.units(UnitType.BombingRun).length === 0 &&
        w.defender.troops() === START;
      expect(restored.player("defender_id").troops()).toBe(w.defender.troops());
      expect(wasHit).toBe(configClass === SureHitConfig);
    },
  );
});

describe("airstrike determinism across games", () => {
  async function play(config: Parameters<typeof makeWorld>[0]) {
    const w = await arena(config);
    startStrike(w.game, w.attacker, UnitType.BombingRun, 100, 100);
    run(w.game, 60);
    return snapshotGame(w.game);
  }

  test("two independent games with the same inputs end identical (FFA, real SAM rolls)", async () => {
    const config = {};
    const withSam = async () => {
      const w = await arena(config);
      conquerSquare(w.game, w.defender, 60, 106, 1);
      constructionExecution(w.game, w.defender, 60, 106, UnitType.SAMLauncher);
      // A second airport: the first is rearming after the first strike.
      conquerSquare(w.game, w.attacker, 20, 140, 5);
      buildAirport(w.game, w.attacker, 20, 140);
      startStrike(w.game, w.attacker, UnitType.StrafingRun, 100, 100);
      startStrike(w.game, w.attacker, UnitType.BombingRun, 100, 100);
      run(w.game, 90);
      return snapshotGame(w.game);
    };
    expect(diffSnapshots(await withSam(), await withSam())).toEqual([]);
    expect(diffSnapshots(await play(config), await play(config))).toEqual([]);
  });

  test("team mode: teammates are never hurt, and two runs end identical", async () => {
    const config = {
      config: { gameMode: GameMode.Team, playerTeams: 2 },
      extra: ["b_id", "c_id"],
    };
    const scenario = async () => {
      const w = await makeWorld(config);
      const others = ["defender_id", "b_id", "c_id"].map((id) =>
        w.game.player(id),
      );
      const mate = others.find((p) => p.isOnSameTeam(w.attacker))!;
      const enemies = others.filter((p) => !p.isOnSameTeam(w.attacker));
      expect(mate).toBeDefined();
      expect(enemies.length).toBeGreaterThan(0);
      conquerSquare(w.game, w.attacker, 20, 100, 5);
      buildAirport(w.game, w.attacker, 20, 100);
      // Teammate and enemy land side by side under a strafing corridor.
      conquerRect(w.game, mate, 80, 95, 100, 105);
      conquerRect(w.game, enemies[0], 101, 95, 125, 105);
      mate.setTroops(START);
      enemies[0].setTroops(START);
      const bomb = startStrike(
        w.game,
        w.attacker,
        UnitType.StrafingRun,
        105,
        100,
      );
      expect(bomb.isActive()).toBe(true);
      run(w.game, 70);
      expect(mate.troops()).toBe(START);
      expect(enemies[0].troops()).toBeLessThan(START);
      return snapshotGame(w.game);
    };
    expect(diffSnapshots(await scenario(), await scenario())).toEqual([]);
  });

  test("an alliance formed mid-flight behaves the same after a restore", async () => {
    const w = await arena();
    startStrike(w.game, w.attacker, UnitType.StrafingRun, 100, 100);
    run(w.game, 30);
    w.attacker.createAllianceRequest(w.defender)!.accept();
    const restored = await expectIdenticalAfter(w.game, 40);
    expect(restored.player("defender_id").troops()).toBe(START);
    expect(w.defender.troops()).toBe(START);
  });

  test("a long mixed simulation stays identical after restoring in the middle", async () => {
    const w = await arena({ configClass: SureHitConfig });
    conquerSquare(w.game, w.defender, 60, 106, 1);
    constructionExecution(w.game, w.defender, 60, 106, UnitType.SAMLauncher);
    conquerSquare(w.game, w.attacker, 20, 140, 5);
    buildAirport(w.game, w.attacker, 20, 140);
    startStrike(w.game, w.attacker, UnitType.RocketStrike, 100, 100);
    run(w.game, 100);
    startStrike(w.game, w.attacker, UnitType.BombingRun, 120, 100);
    await expectIdenticalAfter(w.game, 150);
  });
});

describe("snapshot migrations", () => {
  test("a v1 Airstrike record (single-type, bomb-only) migrates to a bombing run", () => {
    const v1 = {
      active: true,
      initialized: true,
      plane: 7,
      player: 1,
      dst: 5,
      src: 3,
      step: 4,
    };
    const migrated = readVersioned(AirstrikeExecutionSnapshot, { v: 1, d: v1 });
    expect(migrated).toMatchObject({
      active: true,
      phase: "flying",
      strikeType: UnitType.BombingRun,
      plane: 7,
      step: 4,
      burstsApplied: 0,
      impactTick: null,
      releaseTile: null,
      totals: [],
      destroyed: 0,
    });
    expect(
      readVersioned(AirstrikeExecutionSnapshot, {
        v: 1,
        d: { ...v1, plane: null, src: null, step: 0 },
      }).phase,
    ).toBe("pending");
    expect(
      readVersioned(AirstrikeExecutionSnapshot, {
        v: 1,
        d: { ...v1, active: false },
      }).phase,
    ).toBe("done");
  });

  test("a v1 SAMMissile record migrates to a certain hit", () => {
    const v1 = {
      active: true,
      pathFinder: null,
      missile: null,
      speed: 12,
      spawn: 1,
      owner: 1,
      ownerUnit: 2,
      target: 3,
      targetTile: 4,
    };
    const migrated = readVersioned(SAMMissileExecutionSnapshot, {
      v: 1,
      d: v1,
    });
    expect(migrated.willHit).toBe(true);
    expect(migrated.target).toBe(3);
  });

  test("records newer than this build are refused, not misread", () => {
    expect(() =>
      readVersioned(AirstrikeExecutionSnapshot, { v: 3, d: {} }),
    ).toThrow(/newer/);
  });

  test("a leftover plane of the v1 airstrike is retired quietly", async () => {
    const w = await arena();
    const v1Plane = w.attacker.buildUnit(
      UnitType.Airstrike,
      w.game.ref(20, 100),
      {},
    );
    const exec = new AirstrikeExecution(
      w.attacker,
      w.game.ref(100, 100),
      UnitType.BombingRun,
    );
    w.game.addExecution(exec);
    Object.assign(exec as unknown as Record<string, unknown>, {
      plane: v1Plane,
      phase: "flying",
      src: w.game.ref(20, 100),
    });
    run(w.game, 2);
    expect(v1Plane.isActive()).toBe(false);
    expect(exec.isActive()).toBe(false);
    expect(w.defender.troops()).toBe(START);
  });
});
