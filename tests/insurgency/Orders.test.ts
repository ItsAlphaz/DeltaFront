import { InsurgencyRegionStatus } from "@openfront/engine-api/game/GameUpdates";
import { recruitCost } from "@openfront/engine-lib/insurgency/InsurgencyRules";
import {
  SPEC,
  captureCapital,
  insurgentWorld,
  makeRestless,
  occupyRegion0,
  rect,
  resistance,
  run,
  runToUpdate,
} from "./helpers";

/** A world where alice's resistance has begun and bob holds most of region 0. */
async function occupied() {
  const w = await insurgentWorld();
  captureCapital(w);
  occupyRegion0(w);
  return w;
}

describe("recruiting", () => {
  test("is paid for now, arrives after its time, and joins the reserve", async () => {
    const w = await occupied();
    const ins = resistance(w.game, w.alice);
    const sys = w.game.insurgency()!;
    ins.funds = 500_000n;
    ins.available = 100_000;
    const before = ins.funds;
    expect(sys.recruit(w.alice, 50_000)).toBeNull();
    expect(ins.funds).toBe(before - recruitCost(SPEC, 50_000));
    expect(ins.recruits).toHaveLength(1);
    // Not in the reserve yet, but counted towards the capacity.
    expect(ins.available).toBe(100_000);
    expect(sys.totalTroops(ins)).toBe(150_000);
    run(w.game, SPEC.recruitTicks - 1);
    expect(ins.available).toBe(100_000);
    run(w.game, 2);
    expect(ins.available).toBe(150_000);
    expect(ins.recruits).toHaveLength(0);
  });

  test("never past the capacity, and nothing is charged when refused", async () => {
    const w = await occupied();
    const ins = resistance(w.game, w.alice);
    const sys = w.game.insurgency()!;
    ins.funds = 10_000_000n;
    const room = ins.capacity - sys.totalTroops(ins); // 100,000
    const before = ins.funds;
    expect(sys.recruit(w.alice, room + 1)).toBe("capacity");
    expect(ins.funds).toBe(before);
    expect(sys.recruit(w.alice, room)).toBeNull();
    // Full now: another is refused however rich.
    expect(sys.recruit(w.alice, SPEC.recruitMinTroops)).toBe("capacity");
    expect(sys.totalTroops(ins)).toBe(ins.capacity);
  });

  test("not without the gold", async () => {
    const w = await occupied();
    const ins = resistance(w.game, w.alice);
    ins.funds = recruitCost(SPEC, 10_000) - 1n;
    expect(w.game.insurgency()!.recruit(w.alice, 10_000)).toBe("funds");
    expect(ins.recruits).toHaveLength(0);
    expect(ins.funds).toBe(recruitCost(SPEC, 10_000) - 1n);
  });

  test("not too few, not fractions, not negatives, not NaN", async () => {
    const w = await occupied();
    const sys = w.game.insurgency()!;
    resistance(w.game, w.alice).funds = 10_000_000n;
    resistance(w.game, w.alice).available = 0;
    expect(sys.recruit(w.alice, SPEC.recruitMinTroops - 1)).toBe("troops");
    expect(sys.recruit(w.alice, 10_000.5)).toBe("troops");
    expect(sys.recruit(w.alice, -50_000)).toBe("troops");
    expect(sys.recruit(w.alice, Number.NaN)).toBe("troops");
    expect(resistance(w.game, w.alice).funds).toBe(10_000_000n);
  });

  test("only a few batches at once", async () => {
    const w = await occupied();
    const ins = resistance(w.game, w.alice);
    const sys = w.game.insurgency()!;
    ins.funds = 10_000_000n;
    ins.available = 0;
    for (let i = 0; i < SPEC.maxPendingRecruits; i++) {
      expect(sys.recruit(w.alice, 10_000)).toBeNull();
    }
    expect(sys.recruit(w.alice, 10_000)).toBe("limit");
  });

  test("a player who is not resisting cannot", async () => {
    const w = await occupied();
    expect(w.game.insurgency()!.recruit(w.carol, 10_000)).toBe("inactive");
    expect(w.game.insurgency()!.recruit(w.bob, 10_000)).toBe("inactive");
  });

  test("recruits that arrive with nowhere to gather scatter, and free their room", async () => {
    const w = await occupied();
    const ins = resistance(w.game, w.alice);
    const sys = w.game.insurgency()!;
    ins.funds = 1_000_000n;
    expect(sys.recruit(w.alice, 20_000)).toBeNull();
    // She loses her last land and has no base to arrive at.
    for (const t of [...w.alice.tiles()]) w.bob.conquer(t);
    const total = sys.totalTroops(ins);
    run(w.game, SPEC.recruitTicks + 2);
    expect(ins.recruits).toHaveLength(0);
    expect(sys.totalTroops(ins)).toBe(total - 20_000);
  });
});

describe("a base", () => {
  const tileIn = (w: Awaited<ReturnType<typeof occupied>>) => w.game.ref(10, 5); // in the part of region 0 bob holds

  test("is founded on enemy-held land of a restless, occupied region, and paid for", async () => {
    const w = await occupied();
    const ins = resistance(w.game, w.alice);
    makeRestless(w.game, w.alice, 30);
    const before = ins.funds;
    expect(w.game.insurgency()!.foundBase(w.alice, tileIn(w))).toBeNull();
    expect(ins.bases).toHaveLength(1);
    expect(ins.bases[0]).toMatchObject({ region: 0, integrity: 100 });
    expect(ins.funds).toBe(before - SPEC.baseCost);
  });

  test("not where the region is calm", async () => {
    const w = await occupied();
    const ins = resistance(w.game, w.alice);
    makeRestless(w.game, w.alice, SPEC.baseMinUnrest - 1);
    const before = ins.funds;
    expect(w.game.insurgency()!.foundBase(w.alice, tileIn(w))).toBe("unrest");
    expect(ins.funds).toBe(before);
    expect(ins.bases).toHaveLength(0);
  });

  test("not on her own land, a friend's, unowned land, or another region", async () => {
    const w = await occupied();
    makeRestless(w.game, w.alice, 60);
    const sys = w.game.insurgency()!;
    // her own tile (rows 22.. are still hers)
    expect(sys.foundBase(w.alice, w.game.ref(10, 28))).toBe("tile");
    // carol's land in another region, which is not one of hers
    expect(sys.foundBase(w.alice, w.game.ref(10, 40))).toBe("region");
    // unowned
    expect(sys.foundBase(w.alice, w.game.ref(150, 150))).toBe("tile");
    // off the map
    expect(sys.foundBase(w.alice, -3)).toBe("tile");
    expect(resistance(w.game, w.alice).bases).toHaveLength(0);
  });

  test("not on land held by an ally", async () => {
    const w = await occupied();
    makeRestless(w.game, w.alice, 60);
    // bob and alice make peace: his land is not hostile any more.
    w.alice.createAllianceRequest(w.bob)!.accept();
    expect(w.alice.isFriendly(w.bob)).toBe(true);
    expect(w.game.insurgency()!.foundBase(w.alice, tileIn(w))).toBe("tile");
  });

  test("one to a region, and only a few in all", async () => {
    const w = await occupied();
    makeRestless(w.game, w.alice, 60);
    const sys = w.game.insurgency()!;
    expect(sys.foundBase(w.alice, tileIn(w))).toBeNull();
    expect(sys.foundBase(w.alice, w.game.ref(12, 6))).toBe("busy");
    expect(resistance(w.game, w.alice).bases).toHaveLength(1);
  });

  test("not without the gold", async () => {
    const w = await occupied();
    makeRestless(w.game, w.alice, 60);
    resistance(w.game, w.alice).funds = SPEC.baseCost - 1n;
    expect(w.game.insurgency()!.foundBase(w.alice, tileIn(w))).toBe("funds");
  });

  test("is gone when its region is won back", async () => {
    const w = await occupied();
    makeRestless(w.game, w.alice, 60);
    w.game.insurgency()!.foundBase(w.alice, tileIn(w));
    // Alice takes the whole region back.
    rect(w.game, w.alice, 0, 0, 31, 31);
    runToUpdate(w.game);
    expect(resistance(w.game, w.alice).bases).toHaveLength(0);
  });
});

describe("intelligence", () => {
  test("is paid for, rate-limited, and reports a region's precise unrest and garrison", async () => {
    const w = await occupied();
    const ins = resistance(w.game, w.alice);
    const sys = w.game.insurgency()!;
    makeRestless(w.game, w.alice, 63);
    const before = ins.funds;
    expect(sys.intel(w.alice, 0)).toBeNull();
    expect(ins.funds).toBe(before - SPEC.intelCost);
    expect(ins.intel).toHaveLength(1);
    expect(ins.intel[0]).toMatchObject({
      region: 0,
      unrest: 63,
      occupier: w.bob.smallID(),
    });
    expect(ins.intel[0].garrison).toBeGreaterThan(0);
    // Again at once: cooling down, and nothing charged.
    expect(sys.intel(w.alice, 0)).toBe("cooldown");
    expect(ins.funds).toBe(before - SPEC.intelCost);
    run(w.game, SPEC.intelCooldownTicks);
    expect(sys.intel(w.alice, 0)).toBeNull();
  });

  test("not on a region that is not occupied, or is not hers", async () => {
    const w = await insurgentWorld();
    captureCapital(w);
    const sys = w.game.insurgency()!;
    expect(resistance(w.game, w.alice).regions[0].status).toBe(
      InsurgencyRegionStatus.Held,
    );
    expect(sys.intel(w.alice, 0)).toBe("not_occupied");
    expect(sys.intel(w.alice, 3)).toBe("region");
    expect(sys.intel(w.alice, 99_999)).toBe("region");
    expect(sys.intel(w.alice, -1)).toBe("region");
    expect(sys.intel(w.alice, Number.NaN)).toBe("region");
  });

  test("goes stale: the view carries it only while it is fresh", async () => {
    const w = await occupied();
    const sys = w.game.insurgency()!;
    const ins = resistance(w.game, w.alice);
    sys.intel(w.alice, 0);
    expect(sys.view(ins).intel).toHaveLength(1);
    run(w.game, SPEC.intelFreshTicks + 5);
    expect(sys.view(ins).intel).toHaveLength(0);
  });

  test("is not free: the purse can run too low", async () => {
    const w = await occupied();
    resistance(w.game, w.alice).funds = SPEC.intelCost - 1n;
    expect(w.game.insurgency()!.intel(w.alice, 0)).toBe("funds");
  });
});

describe("the owner's income", () => {
  test("a share goes to the resistance, moved not made, until a cap", async () => {
    const w = await occupied();
    const sys = w.game.insurgency()!;
    const ins = resistance(w.game, w.alice);
    const before = ins.funds;
    const kept = sys.divertIncome(w.alice, 1_000n);
    expect(kept).toBe(900n);
    expect(ins.funds).toBe(before + 100n);
    // Up to the cap, and then none.
    ins.diverted = SPEC.incomeShareMax - 30n;
    expect(sys.divertIncome(w.alice, 1_000n)).toBe(970n);
    expect(sys.divertIncome(w.alice, 1_000n)).toBe(1_000n);
    expect(ins.diverted).toBe(SPEC.incomeShareMax);
  });

  test("not for a player with no resistance", async () => {
    const w = await occupied();
    expect(w.game.insurgency()!.divertIncome(w.carol, 1_000n)).toBe(1_000n);
  });
});
