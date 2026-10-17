import {
  InsurgencyPhase,
  InsurgencyRegionStatus,
  type InsurgencyView,
} from "@openfront/engine-api/game/GameUpdates";
import { INSURGENCY_SPEC as SPEC } from "@openfront/engine-lib/insurgency/InsurgencyRules";
import { describe, expect, it } from "vitest";
import {
  availableOrders,
  bandKey,
  capacityLeft,
  eligibleRegions,
  engineTroops,
  intelFor,
  intelIsFresh,
  occupiedBy,
  previewBase,
  previewIntel,
  previewRecruit,
  previewSuppress,
  previewUprising,
  recruitBounds,
  secondsUntil,
  shownTroops,
  sortRegions,
  suppressionsRunning,
  timeLeftSeconds,
  totalTroops,
  whyUnavailable,
  type OrderBlock,
} from "../../../src/client/resistance/ResistanceModel";
import {
  captureCapital,
  insurgentWorld,
  makeRestless,
  occupyRegion0,
  regionOf,
  resistance,
} from "../../insurgency/helpers";

function view(over: Partial<InsurgencyView> = {}): InsurgencyView {
  return {
    owner: 1,
    phase: InsurgencyPhase.Field,
    endReason: "",
    startTick: 0,
    deadline: 7_200,
    limboDeadline: -1,
    startingTroops: 100_000,
    capacity: 200_000,
    available: 100_000,
    deployed: 0,
    pending: [],
    funds: 300_000n,
    fundsStart: 300_000n,
    strength: 50,
    bases: [],
    operations: [],
    regions: [
      {
        id: 0,
        former: 800,
        status: InsurgencyRegionStatus.Occupied,
        band: 2,
        occupier: 2,
        cooldownUntil: 0,
        hasBase: false,
        hasOperation: false,
        suppressed: false,
        flips: 0,
      },
    ],
    intel: [],
    intelReadyTick: 0,
    suppressions: [],
    reclaimed: 0,
    ...over,
  };
}

describe("units", () => {
  it("converts between the engine's troops and the shown ones", () => {
    expect(shownTroops(25_000)).toBe(2_500);
    expect(engineTroops(2_500)).toBe(25_000);
    expect(shownTroops(engineTroops(12_345))).toBe(12_345);
  });

  it("names the bands, and clamps a stray number", () => {
    expect([0, 1, 2, 3, 4].map(bandKey)).toEqual([
      "stable",
      "unsettled",
      "unrestful",
      "volatile",
      "uprising",
    ]);
    expect(bandKey(-3)).toBe("stable");
    expect(bandKey(99)).toBe("uprising");
  });
});

describe("troops and time", () => {
  it("counts the reserve, the field and the way", () => {
    const v = view({
      available: 50_000,
      deployed: 30_000,
      pending: [{ troops: 20_000, arrives: 100 }],
    });
    expect(totalTroops(v)).toBe(100_000);
    expect(capacityLeft(v)).toBe(100_000);
    expect(capacityLeft(view({ available: 300_000 }))).toBe(0);
  });

  it("races the survival time, or with no land the time to win a tile back", () => {
    expect(timeLeftSeconds(view({ deadline: 700 }), 100)).toBe(60);
    const limbo = view({
      phase: InsurgencyPhase.Limbo,
      deadline: 7_200,
      limboDeadline: 400,
    });
    expect(timeLeftSeconds(limbo, 100)).toBe(30);
    expect(secondsUntil(50, 100)).toBe(0);
    expect(secondsUntil(101, 100)).toBe(1);
  });

  it("trusts a report only while it is fresh", () => {
    const report = {
      region: 0,
      tick: 100,
      unrest: 61,
      garrison: 5,
      occupier: 2,
    };
    const v = view({ intel: [report] });
    expect(intelFor(v, 0)).toBe(report);
    expect(intelFor(v, 7)).toBeUndefined();
    expect(intelIsFresh(SPEC, report, 100 + SPEC.intelFreshTicks)).toBe(true);
    expect(intelIsFresh(SPEC, report, 101 + SPEC.intelFreshTicks)).toBe(false);
  });
});

describe("recruiting", () => {
  it("is bounded by the capacity and the purse", () => {
    expect(recruitBounds(SPEC, view())).toEqual({
      min: SPEC.recruitMinTroops,
      max: 100_000, // the capacity left, not the 150,000 the purse could buy
    });
    expect(recruitBounds(SPEC, view({ funds: 30_000n })).max).toBe(15_000);
    expect(recruitBounds(SPEC, view({ funds: 0n })).max).toBe(0);
  });

  it("prices a batch and says when it lands", () => {
    const p = previewRecruit(SPEC, view(), 20_000, true);
    expect(p.block).toBeNull();
    expect(p.cost).toBe(40_000n);
    expect(p.seconds).toBe(30);
    expect(p.roomAfter).toBe(80_000);
  });

  it("says why not", () => {
    const why = (v: InsurgencyView, troops: number, land = true) =>
      previewRecruit(SPEC, v, troops, land).block;
    expect(why(view(), 100)).toBe("troops");
    expect(why(view(), 20_000.5)).toBe("troops");
    expect(why(view({ phase: InsurgencyPhase.Ended }), 20_000)).toBe("ended");
    expect(why(view(), 20_000, false)).toBe("no_location");
    expect(
      why(
        view({ bases: [{ id: 1, region: 0, tile: 5, integrity: 100 }] }),
        20_000,
        false,
      ),
    ).toBeNull();
    expect(why(view(), 150_000)).toBe("capacity");
    expect(why(view({ funds: 10_000n }), 20_000)).toBe("funds");
    const full = view({
      pending: [1, 2, 3].map((i) => ({ troops: 5_000, arrives: 100 * i })),
    });
    expect(why(full, 20_000)).toBe("limit");
  });
});

describe("the other orders", () => {
  const occupied = view().regions[0];

  it("a base needs an occupied region with some unrest, free, and the means", () => {
    expect(previewBase(SPEC, view(), occupied).block).toBeNull();
    expect(previewBase(SPEC, view(), occupied).cost).toBe(SPEC.baseCost);
    expect(previewBase(SPEC, view(), undefined).block).toBe("no_region");
    expect(
      previewBase(SPEC, view(), {
        ...occupied,
        status: InsurgencyRegionStatus.Held,
      }).block,
    ).toBe("not_occupied");
    expect(previewBase(SPEC, view(), { ...occupied, band: 0 }).block).toBe(
      "unrest",
    );
    expect(
      previewBase(SPEC, view(), { ...occupied, hasBase: true }).block,
    ).toBe("busy");
    const two = view({
      bases: [1, 2].map((id) => ({ id, region: id, tile: id, integrity: 100 })),
    });
    expect(previewBase(SPEC, two, occupied).block).toBe("limit");
    expect(previewBase(SPEC, view({ funds: 100n }), occupied).block).toBe(
      "funds",
    );
  });

  it("an uprising needs unrest, no cooldown, troops from the reserve and the means", () => {
    const up = (
      v: InsurgencyView,
      r = occupied,
      troops = 10_000,
      now = 100,
      land = true,
    ) => previewUprising(SPEC, v, r, troops, now, land).block;
    expect(up(view())).toBeNull();
    expect(up(view(), { ...occupied, band: 1 })).toBe("unrest");
    expect(up(view(), { ...occupied, cooldownUntil: 500 })).toBe("cooldown");
    expect(
      up(view(), { ...occupied, cooldownUntil: 500 }, 10_000, 500),
    ).toBeNull();
    expect(up(view(), { ...occupied, hasOperation: true })).toBe("busy");
    expect(up(view(), occupied, 100)).toBe("troops");
    expect(up(view({ available: 5_000 }), occupied, 10_000)).toBe("reserve");
    expect(up(view({ funds: 0n }))).toBe("funds");
    expect(up(view(), occupied, 10_000, 100, false)).toBe("no_location");
    const busy = view({
      operations: [1, 2].map((id) => ({
        id,
        region: id,
        committed: 1,
        troops: 1,
        startTick: 0,
      })),
    });
    expect(up(busy)).toBe("limit");
  });

  it("intelligence waits out its cooldown", () => {
    expect(previewIntel(SPEC, view(), occupied, 0).block).toBeNull();
    expect(
      previewIntel(SPEC, view({ intelReadyTick: 300 }), occupied, 100).block,
    ).toBe("cooldown");
    expect(previewIntel(SPEC, view({ funds: 5n }), occupied, 100).block).toBe(
      "funds",
    );
    expect(previewIntel(SPEC, view(), undefined, 100).block).toBe("no_region");
  });

  it("offers an order only when one could be sent", () => {
    const all = availableOrders(SPEC, view(), 100, true);
    expect(all).toEqual({
      recruit: true,
      base: true,
      uprising: true,
      intel: true,
    });
    const calm = view({ regions: [{ ...occupied, band: 0 }] });
    expect(availableOrders(SPEC, calm, 100, true)).toMatchObject({
      base: false,
      uprising: false,
      intel: true,
    });
    const broke = view({ funds: 0n });
    expect(availableOrders(SPEC, broke, 100, true)).toEqual({
      recruit: false,
      base: false,
      uprising: false,
      intel: false,
    });
    expect(
      availableOrders(SPEC, view({ phase: InsurgencyPhase.Ended }), 100, true)
        .recruit,
    ).toBe(false);
  });
});

describe("what can be offered at all", () => {
  const occupied = view().regions[0];
  const why = (
    v: InsurgencyView,
    order: Parameters<typeof whyUnavailable>[2],
    now = 100,
    land = true,
  ) => whyUnavailable(SPEC, v, order, now, land);

  it("names the first thing in the way", () => {
    const ended = view({ phase: InsurgencyPhase.Ended });
    for (const o of ["recruit", "base", "uprising", "intel"] as const) {
      expect(why(ended, o)).toBe("ended");
      expect(why(view(), o)).toBeNull();
    }
    expect(why(view({ funds: 0n }), "recruit")).toBe("funds");
    expect(why(view({ funds: 0n }), "base")).toBe("funds");
    expect(why(view({ funds: 0n }), "uprising")).toBe("funds");
    expect(why(view({ funds: 0n }), "intel")).toBe("funds");
    expect(why(view(), "recruit", 100, false)).toBe("no_location");
    expect(why(view({ available: 100 }), "uprising")).toBe("reserve");
    expect(why(view({ intelReadyTick: 999 }), "intel")).toBe("cooldown");
  });

  it("looks at the regions: nothing occupied, nothing restless, nothing free", () => {
    const held = view({
      regions: [{ ...occupied, status: InsurgencyRegionStatus.Held, band: 0 }],
    });
    expect(why(held, "base")).toBe("not_occupied");
    expect(why(held, "uprising")).toBe("not_occupied");
    expect(why(held, "intel")).toBe("not_occupied");
    const calm = view({ regions: [{ ...occupied, band: 0 }] });
    expect(why(calm, "base")).toBe("unrest");
    expect(why(calm, "uprising")).toBe("unrest");
    expect(why(calm, "intel")).toBeNull();
    const taken = view({
      regions: [
        { ...occupied, hasBase: true, hasOperation: true, cooldownUntil: 500 },
      ],
    });
    expect(why(taken, "base")).toBe("busy");
    expect(why(taken, "uprising")).toBe("busy");
    const resting = view({ regions: [{ ...occupied, cooldownUntil: 500 }] });
    expect(why(resting, "uprising", 100)).toBe("cooldown");
    expect(why(resting, "uprising", 500)).toBeNull();
  });

  it("offers a region only if the order could go there", () => {
    const regions = [
      { ...occupied, id: 0, band: 3 },
      { ...occupied, id: 1, band: 1 },
      { ...occupied, id: 2, band: 4, hasOperation: true },
      { ...occupied, id: 3, band: 4, cooldownUntil: 900 },
      { ...occupied, id: 4, status: InsurgencyRegionStatus.Held, band: 0 },
    ];
    const v = view({ regions });
    expect(eligibleRegions(SPEC, v, "uprising", 100).map((r) => r.id)).toEqual([
      0,
    ]);
    expect(eligibleRegions(SPEC, v, "intel", 100).map((r) => r.id)).toEqual([
      0, 1, 2, 3,
    ]);
  });

  it("lists the regions in play first, the most restless first", () => {
    const r = (id: number, band: number, status: InsurgencyRegionStatus) => ({
      ...occupied,
      id,
      band,
      status,
    });
    const sorted = sortRegions([
      r(5, 0, InsurgencyRegionStatus.Held),
      r(2, 1, InsurgencyRegionStatus.Occupied),
      r(9, 3, InsurgencyRegionStatus.Occupied),
      r(1, 0, InsurgencyRegionStatus.Contested),
      r(3, 3, InsurgencyRegionStatus.Occupied),
    ]);
    expect(sorted.map((x) => x.id)).toEqual([3, 9, 2, 1, 5]);
  });
});

describe("the occupier's side", () => {
  it("lists what it holds of a running resistance, the most restless first", () => {
    const region = (id: number, band: number, occupier = 2) => ({
      ...view().regions[0],
      id,
      band,
      occupier,
    });
    const mine = view({
      owner: 1,
      regions: [region(0, 1), region(1, 3), region(2, 4, 3), region(3, 0)],
      suppressions: [{ region: 1, occupier: 2, endTick: 900 }],
    });
    const over = view({
      owner: 5,
      phase: InsurgencyPhase.Ended,
      regions: [region(9, 4)],
    });
    const list = occupiedBy([mine, over], 2);
    expect(list.map((x) => x.region.id)).toEqual([1, 0, 3]);
    expect(list[0].suppressionEndTick).toBe(900);
    expect(list[1].suppressionEndTick).toBeNull();
    expect(suppressionsRunning([mine, over], 2)).toBe(1);
    expect(suppressionsRunning([mine], 3)).toBe(0);
  });

  it("prices a suppression", () => {
    const p = previewSuppress(SPEC, 1_000_000, 0, false);
    expect(p).toEqual({
      troops: 30_000,
      seconds: 60,
      returned: 27_000,
      block: null,
    });
    expect(previewSuppress(SPEC, 100_000, 0, false).troops).toBe(
      SPEC.suppressMinTroops,
    );
    expect(previewSuppress(SPEC, 1_000_000, 0, true).block).toBe("busy");
    expect(
      previewSuppress(SPEC, 1_000_000, SPEC.suppressMax, false).block,
    ).toBe("limit");
    expect(previewSuppress(SPEC, 5_000, 0, false).block).toBe("troops");
  });
});

// -------------------------------------------------- against the real engine

/** The engine's refusals, in the panel's words. */
const ENGINE_TO_BLOCK: Record<string, OrderBlock> = {
  inactive: "ended",
  region: "no_region",
  not_occupied: "not_occupied",
  unrest: "unrest",
  funds: "funds",
  capacity: "capacity",
  limit: "limit",
  cooldown: "cooldown",
  busy: "busy",
  no_location: "no_location",
};

describe("the previews agree with the engine", () => {
  async function world() {
    const w = await insurgentWorld();
    captureCapital(w);
    occupyRegion0(w);
    const sys = w.game.insurgency()!;
    const get = () => sys.view(resistance(w.game, w.alice));
    return { w, sys, get };
  }

  it("on a base", async () => {
    const { w, sys, get } = await world();
    makeRestless(w.game, w.alice, 60);
    const tile = w.game.ref(10, 5);
    const v = get();
    const target = v.regions.find((r) => r.id === 0);
    expect(previewBase(SPEC, v, target).block).toBeNull();
    expect(sys.foundBase(w.alice, tile)).toBeNull();
    // A second in the same region.
    const again = get();
    const block = previewBase(SPEC, again, again.regions[0]).block;
    expect(block).toBe("busy");
    expect(ENGINE_TO_BLOCK[sys.foundBase(w.alice, tile) ?? ""]).toBe(block);
  });

  it("on an uprising, whichever way it is refused", async () => {
    const { w, sys, get } = await world();
    const cases: { unrest: number; troops: number }[] = [
      { unrest: 10, troops: 20_000 }, // too calm
      { unrest: 80, troops: 100 }, // too few
      { unrest: 80, troops: 20_000 }, // fine
    ];
    for (const c of cases) {
      makeRestless(w.game, w.alice, c.unrest);
      // The view's band is what the panel has to go on.
      const v = get();
      const target = v.regions.find((r) => r.id === 0);
      const preview = previewUprising(
        SPEC,
        v,
        target,
        c.troops,
        w.game.ticks(),
        true,
      );
      const engine = sys.uprising(w.alice, 0, c.troops);
      // The panel says no exactly when the engine does...
      expect(preview.block === null).toBe(engine === null);
      // ...and for the same reason (the engine's "troops" covers two of ours).
      if (engine !== null) {
        const expected =
          engine === "troops"
            ? ["troops", "reserve"]
            : [ENGINE_TO_BLOCK[engine]];
        expect(expected).toContain(preview.block);
      }
    }
  });

  it("on recruiting, and the bounds it offers", async () => {
    const { w, sys, get } = await world();
    const v0 = get();
    const b = recruitBounds(SPEC, v0);
    // The biggest batch the panel offers is accepted; one troop more is not.
    expect(previewRecruit(SPEC, v0, b.max, true).block).toBeNull();
    expect(previewRecruit(SPEC, v0, b.max + 1, true).block).not.toBeNull();
    expect(sys.recruit(w.alice, b.max + 1)).not.toBeNull();
    expect(sys.recruit(w.alice, b.max)).toBeNull();
    // The purse is spent now (it bound before the capacity did), and both say so.
    const v1 = get();
    expect(v1.funds).toBe(0n);
    expect(capacityLeft(v1)).toBeGreaterThan(0);
    expect(previewRecruit(SPEC, v1, SPEC.recruitMinTroops, true).block).toBe(
      "funds",
    );
    expect(
      ENGINE_TO_BLOCK[sys.recruit(w.alice, SPEC.recruitMinTroops) ?? ""],
    ).toBe("funds");
  });

  it("on the capacity, with a purse that is not the limit", async () => {
    const { w, sys, get } = await world();
    resistance(w.game, w.alice).funds = 10_000_000n;
    const v0 = get();
    const b = recruitBounds(SPEC, v0);
    expect(b.max).toBe(capacityLeft(v0));
    expect(sys.recruit(w.alice, b.max)).toBeNull();
    const v1 = get();
    expect(capacityLeft(v1)).toBe(0);
    expect(totalTroops(v1)).toBe(v1.capacity);
    expect(previewRecruit(SPEC, v1, SPEC.recruitMinTroops, true).block).toBe(
      "capacity",
    );
    expect(
      ENGINE_TO_BLOCK[sys.recruit(w.alice, SPEC.recruitMinTroops) ?? ""],
    ).toBe("capacity");
  });

  it("on intelligence and its cooldown", async () => {
    const { w, sys, get } = await world();
    const v0 = get();
    expect(
      previewIntel(SPEC, v0, v0.regions[0], w.game.ticks()).block,
    ).toBeNull();
    expect(sys.intel(w.alice, 0)).toBeNull();
    const v1 = get();
    const block = previewIntel(SPEC, v1, v1.regions[0], w.game.ticks()).block;
    expect(block).toBe("cooldown");
    expect(ENGINE_TO_BLOCK[sys.intel(w.alice, 0) ?? ""]).toBe(block);
    expect(regionOf(w.game, w.alice).status).toBe(
      InsurgencyRegionStatus.Occupied,
    );
  });
});
