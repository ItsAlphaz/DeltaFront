import {
  AirstrikeUnitType,
  GameUpdates,
  MessageType,
  UnitType,
} from "@openfront/engine-api/game/GameTypes";
import { GameUpdateType } from "@openfront/engine-api/game/GameUpdates";
import { PseudoRandom } from "@openfront/engine-lib/PseudoRandom";
import { SAMTargetingSystem } from "@openfront/engine/execution/SAMLauncherExecution";
import { Game, Unit } from "@openfront/engine/game/Game";
import { constructionExecution } from "../util/utils";
import {
  buildAirport,
  conquerRect,
  conquerSquare,
  makeWorld,
  NeverHitConfig,
  placeDefender,
  planeOf,
  run,
  startStrike,
  STRIKES,
  SureHitConfig,
  World,
} from "./helpers";

/** Attacker airport (20, 100), defender SAM at (60, 100) on the flight line to (100, 100). */
async function arena(
  opts: Parameters<typeof makeWorld>[0] = {},
  samCount = 1,
): Promise<World & { sams: Unit[] }> {
  const w = await makeWorld(opts);
  // Without infinite gold, the airport and SAMs still have to be paid for.
  w.attacker.addGold(20_000_000n);
  w.defender.addGold(20_000_000n);
  conquerSquare(w.game, w.attacker, 20, 100, 5);
  buildAirport(w.game, w.attacker, 20, 100);
  placeDefender(w.game, w.defender, 100, 100, 5, 1_000_000);
  const sams: Unit[] = [];
  for (let i = 0; i < samCount; i++) {
    const x = 60 + i * 20; // structures need 15 tiles of room
    conquerSquare(w.game, w.defender, x, 106, 1);
    constructionExecution(w.game, w.defender, x, 106, UnitType.SAMLauncher);
    sams.push(
      w.defender
        .units(UnitType.SAMLauncher)
        .find((s) => s.tile() === w.game.ref(x, 106))!,
    );
  }
  return { ...w, sams };
}

function messages(updates: GameUpdates[]) {
  return updates.flatMap((u) => u[GameUpdateType.DisplayEvent]);
}

describe("SAM vs airstrike aircraft", () => {
  test.each(STRIKES)("a SAM engages and shoots down a %s", async (type) => {
    const { game, attacker, defender, sams } = await arena({
      configClass: SureHitConfig,
    });
    const plane = startStrike(
      game,
      attacker,
      type as AirstrikeUnitType,
      100,
      100,
    );
    let engaged = false;
    for (let i = 0; i < 70; i++) {
      game.executeNextTick();
      if (plane.isActive() && plane.targetedBySAM()) engaged = true;
    }
    expect(engaged).toBe(true);
    expect(plane.isActive()).toBe(false);
    expect(plane.reachedTarget()).toBe(false);
    expect(sams[0].isInCooldown()).toBe(true);
    // Shot down on the way in: nothing was delivered.
    expect(defender.troops()).toBe(1_000_000);
  });

  test("a hit tells the attacker, the SAM owner, and updates the stats", async () => {
    const { game, attacker, defender } = await arena({
      configClass: SureHitConfig,
    });
    startStrike(game, attacker, UnitType.BombingRun, 100, 100);
    const all = messages(run(game, 70));
    const down = all.find(
      (m) => m.message === "events_display.aircraft_shot_down",
    )!;
    expect(down.playerID).toBe(attacker.smallID());
    expect(down.messageType).toBe(MessageType.UNIT_DESTROYED);
    expect(down.params).toEqual({ unit: "unit_type.bombing_run" });
    const hit = all.find(
      (m) => m.message === "events_display.missile_intercepted",
    )!;
    expect(hit.playerID).toBe(defender.smallID());
    expect(hit.messageType).toBe(MessageType.SAM_HIT);
    expect(hit.params).toEqual({ unit: "unit_type.bombing_run" });
    const a = game.stats().getPlayerStats(attacker)?.air?.bomb;
    const d = game.stats().getPlayerStats(defender)?.air?.bomb;
    expect(a?.[0]).toBe(1n); // launched
    expect(a?.[1] ?? 0n).toBe(0n); // never completed
    expect(a?.[2]).toBe(1n); // shot down
    expect(d?.[3]).toBe(1n); // intercepted
    // Not counted as a nuke interception.
    expect(game.stats().getPlayerStats(defender)?.bombs).toBeUndefined();
  });

  test("a miss is reported and the aircraft flies on and completes its strike", async () => {
    const { game, attacker, defender } = await arena({
      configClass: NeverHitConfig,
    });
    const plane = startStrike(game, attacker, UnitType.BombingRun, 100, 100);
    const all = messages(run(game, 70));
    const miss = all.find((m) => m.message === "events_display.sam_missed")!;
    expect(miss.playerID).toBe(defender.smallID());
    expect(miss.messageType).toBe(MessageType.SAM_MISS);
    expect(plane.reachedTarget()).toBe(true);
    expect(defender.troops()).toBeLessThan(1_000_000);
    expect(
      all.some((m) => m.message === "events_display.aircraft_shot_down"),
    ).toBe(false);
  });

  test("a miss frees the aircraft so a second SAM can engage it", async () => {
    const { game, attacker, sams } = await arena(
      { configClass: NeverHitConfig },
      2,
    );
    const plane = startStrike(game, attacker, UnitType.BombingRun, 100, 100);
    let maxMissilesAtOnce = 0;
    for (let i = 0; i < 70; i++) {
      game.executeNextTick();
      const aimed = game
        .units(UnitType.SAMMissile)
        .filter((m) => m.targetUnit() === plane).length;
      maxMissilesAtOnce = Math.max(maxMissilesAtOnce, aimed);
    }
    // One missile per aircraft at a time, but both SAMs got a shot in turn.
    expect(maxMissilesAtOnce).toBe(1);
    expect(
      sams[0].isInCooldown() || sams[0].missileTimerQueue().length > 0,
    ).toBe(true);
    expect(
      sams[1].isInCooldown() || sams[1].missileTimerQueue().length > 0,
    ).toBe(true);
  });

  test("a strafing run shot down mid-pass keeps the bursts it already delivered", async () => {
    // SAM near the end of the corridor, sure to hit.
    const w = await makeWorld({ configClass: SureHitConfig });
    conquerSquare(w.game, w.attacker, 20, 100, 5);
    buildAirport(w.game, w.attacker, 20, 100);
    conquerRect(w.game, w.defender, 60, 95, 140, 110);
    w.defender.setTroops(1_000_000);
    constructionExecution(w.game, w.defender, 125, 108, UnitType.SAMLauncher);
    const plane = startStrike(
      w.game,
      w.attacker,
      UnitType.StrafingRun,
      100,
      100,
    );
    run(w.game, 70);
    expect(plane.isActive()).toBe(false);
    expect(plane.reachedTarget()).toBe(false);
    const stats = w.game.stats().getPlayerStats(w.attacker)?.air?.strf;
    expect(stats?.[2]).toBe(1n); // shot down
    expect(stats?.[1] ?? 0n).toBe(0n); // not completed
    // Whatever bursts landed first stay landed, and the victim is told.
    expect(w.defender.troops()).toBeLessThan(1_000_000);
    expect(stats?.[4]).toBeGreaterThan(0n);
  });

  test("the strike is not refunded when the aircraft is intercepted, and the airport still rearms normally", async () => {
    const { game, attacker, defender } = await arena({
      configClass: SureHitConfig,
      config: { infiniteGold: false },
    });
    attacker.addGold(10_000_000n);
    const airport = attacker.units(UnitType.Airport)[0];
    expect(airport.isInCooldown()).toBe(false);
    const before = attacker.gold();
    startStrike(game, attacker, UnitType.RocketStrike, 100, 100);
    const afterLaunch = attacker.gold();
    expect(before - afterLaunch).toBe(350_000n);
    const launchTick = airport.missileTimerQueue()[0];
    run(game, 70);
    expect(planeOf(attacker, UnitType.RocketStrike)).toBeUndefined();
    expect(attacker.gold()).toBe(afterLaunch);
    // Rearm is untouched by the interception: still cooling, then ready at +200.
    while (game.ticks() < launchTick + 200) {
      expect(airport.isInCooldown()).toBe(true);
      game.executeNextTick();
    }
    game.executeNextTick();
    expect(airport.isInCooldown()).toBe(false);
    expect(defender.troops()).toBe(1_000_000);
  });

  test("a plane destroyed by any other cause (a nuke blast, say) is reported as lost", async () => {
    const { game, attacker, defender } = await arena();
    const plane = startStrike(game, attacker, UnitType.BombingRun, 100, 100);
    run(game, 8);
    plane.delete(true, defender);
    const all = messages(run(game, 3));
    expect(
      all.some((m) => m.message === "events_display.aircraft_shot_down"),
    ).toBe(true);
    expect(game.stats().getPlayerStats(attacker)?.air?.bomb?.[2]).toBe(1n);
  });
});

describe("SAM targeting", () => {
  const line = (game: Game, x0: number, n: number) =>
    Array.from({ length: n }, (_, i) => ({
      tile: game.ref(x0 + i, 100),
      targetable: true,
    }));

  async function targeting() {
    const w = await makeWorld();
    conquerSquare(w.game, w.defender, 60, 100, 3);
    const sam = w.defender.buildUnit(
      UnitType.SAMLauncher,
      w.game.ref(60, 100),
      {},
    );
    return { ...w, sam, system: new SAMTargetingSystem(w.game, sam) };
  }

  test("an aircraft is a valid target", async () => {
    const { game, attacker, system } = await targeting();
    const plane = attacker.buildUnit(UnitType.BombingRun, game.ref(40, 100), {
      targetTile: game.ref(69, 100),
      trajectory: line(game, 40, 30),
    });
    const targets = system.getValidTargets(game.ticks());
    expect(targets.map((t) => t.unit)).toEqual([plane]);
  });

  test("a nuke due at the same time is shot before the aircraft", async () => {
    const { game, attacker, system } = await targeting();
    const plane = attacker.buildUnit(UnitType.BombingRun, game.ref(40, 100), {
      targetTile: game.ref(69, 100),
      trajectory: line(game, 40, 30),
    });
    const nuke = attacker.buildUnit(UnitType.AtomBomb, game.ref(40, 100), {
      targetTile: game.ref(69, 100),
      trajectory: line(game, 40, 30),
    });
    const targets = system.getValidTargets(game.ticks());
    expect(targets.map((t) => t.unit)).toEqual([nuke, plane]);
  });

  test("the owner's own aircraft and an ally's are never targeted", async () => {
    const { game, attacker, defender, system } = await targeting();
    defender.buildUnit(UnitType.BombingRun, game.ref(40, 100), {
      targetTile: game.ref(69, 100),
      trajectory: line(game, 40, 30),
    });
    attacker.createAllianceRequest(defender)!.accept();
    attacker.buildUnit(UnitType.RocketStrike, game.ref(40, 100), {
      targetTile: game.ref(69, 100),
      trajectory: line(game, 40, 30),
    });
    expect(system.getValidTargets(game.ticks())).toEqual([]);
  });
});

describe("SAM hit rolls", () => {
  /** One game: a strike through a lone SAM whose id (hence RNG seed) is varied by extra units. */
  async function engage(type: AirstrikeUnitType, variant: number) {
    const w = await makeWorld(); // real configuration: 65 / 50 / 60 %
    conquerSquare(w.game, w.attacker, 20, 100, 5);
    buildAirport(w.game, w.attacker, 20, 100);
    placeDefender(w.game, w.defender, 100, 100, 5, 1_000_000);
    conquerSquare(w.game, w.defender, 60, 106, 1);
    for (let i = 0; i < variant; i++) {
      w.defender.buildUnit(UnitType.DefensePost, w.game.ref(100, 100), {});
    }
    constructionExecution(w.game, w.defender, 60, 106, UnitType.SAMLauncher);
    const sam = w.defender.units(UnitType.SAMLauncher)[0];
    const plane = startStrike(w.game, w.attacker, type, 100, 100);
    const all = messages(run(w.game, 70));
    const hit = all.some(
      (m) => m.message === "events_display.missile_intercepted",
    );
    const miss = all.some((m) => m.message === "events_display.sam_missed");
    return { sam, plane, firstShotHit: hit ? true : miss ? false : null };
  }

  test.each([
    [UnitType.BombingRun, 65],
    [UnitType.RocketStrike, 50],
    [UnitType.StrafingRun, 60],
  ] as const)(
    "%s: the first shot follows the SAM's own seeded roll (%i%%)",
    async (type, percent) => {
      let hits = 0;
      const runs = 40;
      for (let variant = 0; variant < runs; variant++) {
        const r = await engage(type, variant);
        expect(r.firstShotHit).not.toBeNull();
        // The roll is the SAM's first draw from PseudoRandom(sam id): predictable, and the same on every client.
        const predicted =
          new PseudoRandom(r.sam.id()).nextInt(0, 100) < percent;
        expect(r.firstShotHit).toBe(predicted);
        if (predicted) hits++;
      }
      // And the rolls honour the configured chance (deterministic, so this never flakes).
      expect(hits / runs).toBeGreaterThan(percent / 100 - 0.2);
      expect(hits / runs).toBeLessThan(percent / 100 + 0.2);
    },
  );
});

describe("nuke interception is unchanged", () => {
  test("a SAM shooting a nuke never draws from its random generator", async () => {
    const w = await makeWorld();
    conquerSquare(w.game, w.attacker, 5, 5, 3);
    conquerSquare(w.game, w.defender, 60, 100, 3);
    const spy = vi.spyOn(PseudoRandom.prototype, "nextInt");
    try {
      constructionExecution(w.game, w.defender, 60, 100, UnitType.SAMLauncher);
      w.attacker.buildUnit(UnitType.AtomBomb, w.game.ref(60, 100), {
        targetTile: w.game.ref(63, 100),
        trajectory: [60, 61, 62, 63].map((x) => ({
          tile: w.game.ref(x, 100),
          targetable: true,
        })),
      });
      run(w.game, 5);
      expect(w.attacker.units(UnitType.AtomBomb)).toHaveLength(0);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});
