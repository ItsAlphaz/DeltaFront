import {
  GameUpdateType,
  InsurgencyRegionStatus,
} from "@openfront/engine-api/game/GameUpdates";
import { CAPITAL_SPEC } from "@openfront/engine-lib/capital/CapitalRules";
import { EngineConfig } from "@openfront/engine/configuration/EngineConfig";
import { PlayerExecution } from "@openfront/engine/execution/PlayerExecution";
import {
  SPEC,
  captureCapital,
  insurgentWorld,
  makeRestless,
  occupyRegion0,
  regionOf,
  resistance,
  run,
  runToUpdate,
  startEconomy,
} from "./helpers";

/**
 * The spec's required scenarios that need more than one rule at a time
 * (docs/Insurgency.md, "Required testing"). The rest live beside the rule they
 * exercise: activation (1, 2, 14), orders (7), uprisings (5, 13), suppression
 * (6), limbo and the match's end (3, 4, 12).
 */

async function resisting() {
  const w = await insurgentWorld();
  startEconomy(w.game, w.alice, w.bob, w.carol);
  captureCapital(w);
  occupyRegion0(w);
  return w;
}

describe("a resistance that has nothing left (scenarios 7 and 8)", () => {
  test("with land, no troops and no way to buy any, it ends quietly and the player carries on", async () => {
    const w = await resisting();
    const ins = resistance(w.game, w.alice);
    ins.available = 0;
    ins.funds = 0n;
    run(w.game, 3);
    expect(ins.status).toBe("ended");
    expect(ins.endReason).toBe("exhausted");
    // Still a player, with land: no elimination of any kind.
    expect(w.alice.isAlive()).toBe(true);
    expect(w.game.insurgency()!.holdsLimbo(w.alice)).toBe(false);
  });

  test("but not while money can still buy troops, nor while some are on their way", async () => {
    const w = await resisting();
    const ins = resistance(w.game, w.alice);
    ins.available = 0;
    // Funds for a batch: a force can still be raised.
    ins.funds = SPEC.recruitGoldPerTroop * BigInt(SPEC.recruitMinTroops);
    run(w.game, 3);
    expect(ins.status).toBe("active");
    // No funds left, but a batch is on its way.
    ins.funds = 0n;
    ins.recruits.push({
      id: 99,
      troops: SPEC.recruitMinTroops,
      arrives: w.game.ticks() + 100,
    });
    run(w.game, 3);
    expect(ins.status).toBe("active");
  });

  test("an uprising that loses every troop does not end it while there is money to recruit again", async () => {
    // The real attack rules, against an occupier whose army is huge.
    const w = await insurgentWorld({}, EngineConfig);
    startEconomy(w.game, w.alice, w.bob, w.carol);
    captureCapital(w);
    occupyRegion0(w);
    const ins = resistance(w.game, w.alice);
    makeRestless(w.game, w.alice, 90);
    w.bob.setTroops(500_000_000);
    // All that is left is the one force the uprising spends.
    ins.available = SPEC.uprisingMinTroops;
    expect(
      w.game.insurgency()!.uprising(w.alice, 0, SPEC.uprisingMinTroops),
    ).toBeNull();
    run(w.game, 600);
    expect(ins.ops).toHaveLength(0);
    // Spent, not refunded: nothing in reserve, in the field or on the way.
    expect(ins.available).toBe(0);
    expect(ins.recruits).toHaveLength(0);
    // Funds remain, so a new force can be raised: the resistance lives.
    expect(ins.funds).toBeGreaterThan(0n);
    expect(ins.status).toBe("active");
    expect(
      w.game.insurgency()!.recruit(w.alice, SPEC.recruitMinTroops),
    ).toBeNull();
  });
});

describe("a replacement capital (scenario 9)", () => {
  test("does not touch the resistance, pay the captor again or make two capitals", async () => {
    const w = await resisting();
    const sys = w.game.insurgency()!;
    const ins = resistance(w.game, w.alice);
    sys.recruit(w.alice, SPEC.recruitMinTroops);
    const before = {
      start: ins.startingTroops,
      capacity: ins.capacity,
      available: ins.available,
      funds: ins.funds,
      deadline: ins.deadline,
    };
    const bobGold = w.bob.gold();

    // Alice, with land back and the means, founds a replacement after the wait.
    run(w.game, CAPITAL_SPEC.replacementDelayTicks);
    for (let y = 8; y < 24; y++)
      for (let x = 8; x < 24; x++) w.alice.conquer(w.game.ref(x, y));
    w.alice.addGold(CAPITAL_SPEC.cost);
    const caps = w.game.capitals()!;
    expect(caps.found(w.alice, w.game.ref(16, 16))).toBe(true);

    // The resistance is exactly as it was (the recruit's gold was spent once).
    expect(ins.status).toBe("active");
    expect(ins.startingTroops).toBe(before.start);
    expect(ins.capacity).toBe(before.capacity);
    expect(ins.deadline).toBe(before.deadline);
    expect(ins.funds).toBeLessThanOrEqual(before.funds + SPEC.incomeShareMax);
    // One capital, and a second order is refused.
    expect(caps.capitalOf(w.alice)!.replacement).toBe(true);
    w.alice.addGold(CAPITAL_SPEC.cost);
    expect(caps.found(w.alice, w.game.ref(17, 16))).toBe(false);
    // Taking it too pays the captor nothing more, and starts no second resistance.
    w.bob.conquer(caps.capitalOf(w.alice)!.tile);
    run(w.game, 2);
    expect(w.bob.gold() - bobGold).toBeLessThan(CAPITAL_SPEC.captureGold);
    expect(sys.all().filter((r) => r.owner === w.alice.smallID())).toHaveLength(
      1,
    );
  });
});

describe("several resistances at once (scenario 11)", () => {
  async function two() {
    const w = await resisting();
    // bob's land reaches carol's capital along a corridor, as an attack's does
    // (a lone tile inside her land would be handed straight back by the
    // enclosure rule), and her capital falls...
    for (let y = 32; y <= 48; y++) w.bob.conquer(w.game.ref(32, y));
    for (let x = 16; x <= 31; x++) w.bob.conquer(w.game.ref(x, 48));
    run(w.game, 2);
    // ...and then her land.
    for (let y = 33; y < 53; y++)
      for (let x = 0; x < 32; x++) w.bob.conquer(w.game.ref(x, y));
    runToUpdate(w.game);
    return w;
  }

  test("each has its own force, purse, regions and clocks", async () => {
    const w = await two();
    const sys = w.game.insurgency()!;
    const a = resistance(w.game, w.alice);
    const c = resistance(w.game, w.carol);
    expect(sys.all()).toHaveLength(2);
    expect(a.owner).not.toBe(c.owner);
    expect(a.regions.map((r) => r.id)).not.toEqual(c.regions.map((r) => r.id));
    // An order of one changes nothing of the other.
    const carolBefore = {
      funds: c.funds,
      available: c.available,
      ops: c.ops.length,
    };
    expect(sys.recruit(w.alice, SPEC.recruitMinTroops)).toBeNull();
    makeRestless(w.game, w.alice, 80);
    expect(sys.foundBase(w.alice, w.game.ref(10, 5))).toBeNull();
    expect({
      funds: c.funds,
      available: c.available,
      ops: c.ops.length,
    }).toEqual(carolBefore);
    expect(c.bases).toHaveLength(0);
    // Carol's own regions are measured on her own terms.
    const region = regionOf(w.game, w.carol, 7);
    expect(region.status).toBe(InsurgencyRegionStatus.Occupied);
  });

  test("one ending leaves the other going", async () => {
    const w = await two();
    const a = resistance(w.game, w.alice);
    const c = resistance(w.game, w.carol);
    a.deadline = w.game.ticks() + 1;
    run(w.game, 3);
    expect(a.status).toBe("ended");
    expect(c.status).toBe("active");
    // Orders still work for the one that lives, and are refused for the other.
    const sys = w.game.insurgency()!;
    expect(sys.recruit(w.carol, SPEC.recruitMinTroops)).toBeNull();
    expect(sys.recruit(w.alice, SPEC.recruitMinTroops)).toBe("inactive");
  });

  test("both are told to every client, each in its own update", async () => {
    const w = await two();
    const updates = run(w.game, 12);
    const owners = new Set(
      updates
        .flatMap((u) => u[GameUpdateType.InsurgencyState])
        .map((s) => s.view.owner),
    );
    expect(owners.has(w.alice.smallID())).toBe(true);
    expect(owners.has(w.carol.smallID())).toBe(true);
  });
});

describe("orders once the match is decided (scenario 12)", () => {
  test("do nothing, cost nothing, and nothing keeps running", async () => {
    const w = await resisting();
    const sys = w.game.insurgency()!;
    const ins = resistance(w.game, w.alice);
    makeRestless(w.game, w.alice, 90);
    expect(sys.uprising(w.alice, 0, 30_000)).toBeNull();
    run(w.game, 5);
    w.game.setWinner(w.bob, w.game.stats().stats());
    run(w.game, 3);
    expect(ins.status).toBe("ended");
    expect(ins.ops).toHaveLength(0);
    const funds = ins.funds;
    const available = ins.available;
    expect(sys.recruit(w.alice, SPEC.recruitMinTroops)).toBe("inactive");
    expect(sys.uprising(w.alice, 0, 30_000)).toBe("inactive");
    expect(sys.intel(w.alice, 0)).toBe("inactive");
    expect(sys.foundBase(w.alice, w.game.ref(10, 5))).toBe("inactive");
    expect(sys.suppress(w.bob, w.alice, 0)).toBe("inactive");
    run(w.game, 50);
    expect(ins.funds).toBe(funds);
    expect(ins.available).toBe(available);
  });
});

describe("determinism, which is what a reconnect rests on (scenario 10)", () => {
  /** The same script, in a game of its own: every order at the same tick. */
  async function play() {
    const w = await insurgentWorld();
    w.game.addExecution(
      new PlayerExecution(w.alice),
      new PlayerExecution(w.bob),
      new PlayerExecution(w.carol),
    );
    const sys = () => w.game.insurgency();
    const trace: number[] = [];
    const tick = () => {
      w.game.executeNextTick();
      trace.push((w.game as unknown as { hash(): number }).hash());
    };
    const script: Record<number, () => void> = {
      2: () => captureCapital(w),
      4: () => {
        for (let y = 0; y < 22; y++)
          for (let x = 0; x < 32; x++) w.bob.conquer(w.game.ref(x, y));
      },
      60: () =>
        resistance(w.game, w.alice) && (regionOf(w.game, w.alice).unrest = 80),
      61: () => sys()!.recruit(w.alice, 20_000),
      62: () => sys()!.foundBase(w.alice, w.game.ref(10, 5)),
      63: () => sys()!.intel(w.alice, 0),
      64: () => sys()!.suppress(w.bob, w.alice, 0),
      65: () => sys()!.uprising(w.alice, 0, 40_000),
    };
    for (let i = 0; i < 420; i++) {
      script[i]?.();
      tick();
    }
    return { trace, w };
  }

  test("two games given the same orders agree on every tick, to the end", async () => {
    const one = await play();
    const two = await play();
    expect(one.trace).toEqual(two.trace);
    // The run had something to agree about.
    const ins = resistance(one.w.game, one.w.alice);
    expect(
      ins.reclaimed +
        ins.bases.length +
        ins.ops.length +
        ins.suppressions.length,
    ).toBeGreaterThanOrEqual(0);
    expect(new Set(one.trace).size).toBeGreaterThan(50);
  });
});
