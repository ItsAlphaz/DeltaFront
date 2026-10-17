import {
  GameUpdateType,
  InsurgencyRegionStatus,
} from "@openfront/engine-api/game/GameUpdates";
import { EngineConfig } from "@openfront/engine/configuration/EngineConfig";
import { AttackExecution } from "@openfront/engine/execution/AttackExecution";
import type { Game, Player } from "@openfront/engine/game/Game";
import {
  SPEC,
  captureCapital,
  insurgentWorld,
  makeRestless,
  occupyRegion0,
  rect,
  regionOf,
  resistance,
  run,
  runToUpdate,
} from "./helpers";

async function occupied(
  config: Parameters<typeof insurgentWorld>[0] = {},
  configClass?: Parameters<typeof insurgentWorld>[1],
) {
  const w = await insurgentWorld(config, configClass);
  captureCapital(w);
  occupyRegion0(w);
  return w;
}

const inRegion0 = (game: Game, p: Player) => {
  let n = 0;
  for (let y = 0; y < 32; y++)
    for (let x = 0; x < 32; x++) if (game.owner(game.ref(x, y)) === p) n++;
  return n;
};

describe("an uprising", () => {
  test("is paid for, takes its troops out of the reserve, and starts an ordinary attack", async () => {
    const w = await occupied();
    const ins = resistance(w.game, w.alice);
    const sys = w.game.insurgency()!;
    const funds = ins.funds;
    const reserve = ins.available;
    expect(regionOf(w.game, w.alice).unrest).toBeGreaterThanOrEqual(
      SPEC.uprisingMinUnrest,
    );
    expect(sys.uprising(w.alice, 0, 20_000)).toBeNull();
    expect(ins.funds).toBe(funds - SPEC.uprisingCost);
    expect(ins.available).toBe(reserve - 20_000);
    expect(ins.ops).toHaveLength(1);
    run(w.game, 2);
    const attack = w.alice.outgoingAttacks()[0];
    expect(attack.isResistance()).toBe(true);
    expect(attack.target()).toBe(w.bob);
    expect(ins.ops[0].attackId).toBe(attack.id());
    // The army was not touched: the troops are the resistance's own.
    expect(w.alice.troops()).toBe(900_000);
  });

  test("never flips a tile by being ordered: the seed is won in combat, tile by tile", async () => {
    const w = await occupied();
    const aliceBefore = w.alice.numTilesOwned();
    const bobBefore = w.bob.numTilesOwned();
    expect(w.game.insurgency()!.uprising(w.alice, 0, 20_000)).toBeNull();
    // The order alone moves nothing.
    expect(w.alice.numTilesOwned()).toBe(aliceBefore);
    expect(w.bob.numTilesOwned()).toBe(bobBefore);
    // And it is won a tile a tick, not all at once.
    const counts: number[] = [];
    for (let i = 0; i < 6; i++) {
      w.game.executeNextTick();
      counts.push(w.alice.numTilesOwned() - aliceBefore);
    }
    expect(counts[counts.length - 1]).toBeGreaterThan(0);
    expect(counts[counts.length - 1]).toBeLessThan(10);
  });

  test("wins its region back, and not a tile outside it", async () => {
    const w = await occupied();
    const ins = resistance(w.game, w.alice);
    // Bob's land outside region 0 must stay his.
    const bobOutside = () => w.bob.numTilesOwned() - inRegion0(w.game, w.bob);
    const outsideBefore = bobOutside();
    expect(w.game.insurgency()!.uprising(w.alice, 0, 30_000)).toBeNull();
    run(w.game, 900);
    expect(ins.ops).toHaveLength(0);
    expect(inRegion0(w.game, w.bob)).toBe(0);
    // The whole region is hers again, her old capital's tile with it, and
    // nothing of bob's outside it was touched.
    expect(inRegion0(w.game, w.alice)).toBe(1024);
    expect(bobOutside()).toBe(outsideBefore);
  });

  test("brings the survivors home: the pool loses what the fight cost, and nothing else", async () => {
    const w = await occupied();
    const ins = resistance(w.game, w.alice);
    const sys = w.game.insurgency()!;
    const reserve = ins.available;
    expect(sys.uprising(w.alice, 0, 30_000)).toBeNull();
    run(w.game, 900);
    // Flat test combat: one troop a tile. Survivors = sent - tiles won.
    const won = inRegion0(w.game, w.alice) - 320 - 1; // she held 320 + the capital
    expect(ins.available).toBeLessThanOrEqual(reserve);
    expect(ins.available).toBeGreaterThan(reserve - 30_000);
    expect(reserve - ins.available).toBeLessThan(2_000);
    expect(sys.totalTroops(ins)).toBeLessThanOrEqual(ins.capacity);
    expect(won).toBeGreaterThan(0);
    // Nothing went into her army.
    expect(w.alice.troops()).toBe(900_000);
  });

  test("pays once for a region won, extends the time once, and marks it", async () => {
    const w = await occupied();
    const ins = resistance(w.game, w.alice);
    const deadline = ins.deadline;
    const funds = ins.funds;
    w.game.insurgency()!.uprising(w.alice, 0, 30_000);
    run(w.game, 900);
    runToUpdate(w.game, 2);
    const region = regionOf(w.game, w.alice);
    expect(region.status).toBe(InsurgencyRegionStatus.Held);
    expect(region.flips).toBe(1);
    expect(region.rewarded).toBe(true);
    expect(ins.reclaimed).toBe(1);
    expect(ins.deadline).toBe(deadline + SPEC.survivalExtensionTicks);
    // the cost, then the reward
    expect(ins.funds).toBe(funds - SPEC.uprisingCost + SPEC.reclaimFunds);
    expect(ins.funds - funds).toBe(SPEC.reclaimFunds - SPEC.uprisingCost);
    expect(region.unrest).toBe(0);
  });

  test("the region cools down afterwards", async () => {
    const w = await occupied();
    const sys = w.game.insurgency()!;
    sys.uprising(w.alice, 0, 30_000);
    run(w.game, 900);
    const region = regionOf(w.game, w.alice);
    expect(region.cooldownUntil).toBeGreaterThan(w.game.ticks());
    // Bob takes it back, so it is occupied again and restless: still cooling.
    rect(w.game, w.bob, 0, 0, 31, 21);
    runToUpdate(w.game);
    region.unrest = 100;
    expect(sys.uprising(w.alice, 0, 20_000)).toBe("cooldown");
    run(w.game, SPEC.regionCooldownTicks);
    region.unrest = 100; // (the climb itself is tested in Unrest.test.ts)
    expect(sys.uprising(w.alice, 0, 20_000)).toBeNull();
  });

  test("a hopeless uprising loses its troops and wins next to nothing (real combat)", async () => {
    // The real attack rules (not the flat ones of the test config), against an
    // occupier whose army is huge.
    const w = await occupied({}, EngineConfig);
    expect(w.game.config().constructor).toBe(EngineConfig);
    w.bob.setTroops(500_000_000);
    const ins = resistance(w.game, w.alice);
    const reserve = ins.available;
    w.game.insurgency()!.uprising(w.alice, 0, 5_000);
    run(w.game, 400);
    expect(ins.ops).toHaveLength(0);
    // The troops are gone, not refunded: it lost.
    expect(ins.available).toBe(reserve - 5_000);
    expect(inRegion0(w.game, w.alice)).toBeLessThan(320 + 30);
  });

  test("is refused when it should be, and nothing is charged", async () => {
    const w = await occupied();
    const ins = resistance(w.game, w.alice);
    const sys = w.game.insurgency()!;
    const funds = ins.funds;
    const reserve = ins.available;
    const region = regionOf(w.game, w.alice);

    region.unrest = SPEC.uprisingMinUnrest - 1;
    expect(sys.uprising(w.alice, 0, 20_000)).toBe("unrest");
    region.unrest = 80;
    expect(sys.uprising(w.alice, 0, SPEC.uprisingMinTroops - 1)).toBe("troops");
    expect(sys.uprising(w.alice, 0, reserve + 1)).toBe("troops");
    expect(sys.uprising(w.alice, 0, 5_000.5)).toBe("troops");
    expect(sys.uprising(w.alice, 5, 20_000)).toBe("region");
    expect(sys.uprising(w.alice, -1, 20_000)).toBe("region");
    expect(sys.uprising(w.carol, 0, 20_000)).toBe("inactive");
    ins.funds = SPEC.uprisingCost - 1n;
    expect(sys.uprising(w.alice, 0, 20_000)).toBe("funds");
    ins.funds = funds;
    // Not occupied: a held region
    region.status = InsurgencyRegionStatus.Held;
    expect(sys.uprising(w.alice, 0, 20_000)).toBe("not_occupied");

    expect(ins.funds).toBe(funds);
    expect(ins.available).toBe(reserve);
    expect(ins.ops).toHaveLength(0);
  });

  test("one at a time to a region, and only a few at once", async () => {
    const w = await occupied();
    const sys = w.game.insurgency()!;
    expect(sys.uprising(w.alice, 0, 10_000)).toBeNull();
    expect(sys.uprising(w.alice, 0, 10_000)).toBe("busy");
    expect(resistance(w.game, w.alice).ops).toHaveLength(1);
  });

  test("never merges with an ordinary attack, and the two keep their own troops", async () => {
    const w = await occupied();
    const ins = resistance(w.game, w.alice);
    w.game.insurgency()!.uprising(w.alice, 0, 20_000);
    run(w.game, 2);
    const resistanceAttack = w.alice.outgoingAttacks()[0];
    // An ordinary attack on bob, as the player would send it.
    w.game.addExecution(new AttackExecution(10_000, w.alice, w.bob.id(), null));
    run(w.game, 3);
    const attacks = w.alice.outgoingAttacks();
    expect(attacks).toHaveLength(2);
    expect(attacks.filter((a) => a.isResistance())).toEqual([resistanceAttack]);
    expect(resistanceAttack.isActive()).toBe(true);
    expect(ins.ops[0].attackId).toBe(resistanceAttack.id());
    // The army paid for the ordinary one only.
    expect(w.alice.troops()).toBeLessThan(900_000);
    expect(w.alice.troops()).toBeGreaterThanOrEqual(900_000 - 10_000 - 5_000);
  });

  test("an uprising can be called off, and the survivors come home", async () => {
    const w = await occupied();
    const ins = resistance(w.game, w.alice);
    w.game.insurgency()!.uprising(w.alice, 0, 30_000);
    run(w.game, 40);
    const attack = w.alice.outgoingAttacks()[0];
    w.alice.orderRetreat(attack.id());
    w.alice.executeRetreat(attack.id());
    run(w.game, 3);
    expect(ins.ops).toHaveLength(0);
    // The usual retreat penalty applies (a quarter of what is left); the rest is home.
    expect(ins.available).toBeGreaterThan(100_000 - 30_000 + 15_000);
    expect(ins.available).toBeLessThan(100_000);
    expect(w.alice.troops()).toBe(900_000);
  });
});

describe("an uprising that does not begin", () => {
  test("gives back the troops and the price, and says so", async () => {
    const w = await occupied();
    const ins = resistance(w.game, w.alice);
    const spec = SPEC;
    makeRestless(w.game, w.alice, 80);
    // An operation the game has no attack for (as when its attack was lost
    // before it began): set up as the order leaves it.
    const funds = ins.funds - spec.uprisingCost;
    const available = ins.available - 10_000;
    ins.funds = funds;
    ins.available = available;
    ins.ops.push({
      id: 77,
      region: 0,
      seed: w.game.ref(5, 5),
      committed: 10_000,
      startTick: w.game.ticks(),
      attackId: null,
      startOwn: 0,
    });
    const updates = run(w.game, 8);
    expect(ins.ops).toHaveLength(0);
    expect(ins.available).toBe(available + 10_000);
    // The price is refunded too (and only the income the purse was owed since).
    expect(ins.funds).toBeGreaterThanOrEqual(funds + spec.uprisingCost);
    const told = updates
      .flatMap((u) => u[GameUpdateType.DisplayEvent])
      .filter((m) => m.playerID === w.alice.smallID())
      .map((m) => m.message);
    expect(told).toContain("events_display.insurgency_uprising_void");
    // No cooldown on the region: nothing was fought.
    expect(regionOf(w.game, w.alice).cooldownUntil).toBe(0);
  });
});
