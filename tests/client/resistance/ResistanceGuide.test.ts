import {
  InsurgencyPhase,
  InsurgencyRegionStatus,
  type InsurgencyRegionView,
  type InsurgencyView,
} from "@openfront/engine-api/game/GameUpdates";
import { INSURGENCY_SPEC as SPEC } from "@openfront/engine-lib/insurgency/InsurgencyRules";
import { describe, expect, it } from "vitest";
import { nextStep } from "../../../src/client/resistance/ResistanceGuide";

function region(
  over: Partial<InsurgencyRegionView> = {},
): InsurgencyRegionView {
  return {
    id: 0,
    former: 800,
    status: InsurgencyRegionStatus.Occupied,
    band: 0,
    occupier: 2,
    cooldownUntil: 0,
    hasBase: false,
    hasOperation: false,
    suppressed: false,
    flips: 0,
    ...over,
  };
}

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
    funds: 5_000_000n,
    fundsStart: 5_000_000n,
    strength: 50,
    bases: [],
    operations: [],
    regions: [region()],
    intel: [],
    intelReadyTick: 0,
    suppressions: [],
    reclaimed: 0,
    ...over,
  };
}

const next = (v: InsurgencyView, land = true) => nextStep(SPEC, v, 100, land);

describe("what a new player is told to do next", () => {
  it("an area that is restless enough, and fighters to send: start the uprising there", () => {
    const v = view({
      regions: [region({ id: 3, band: 2 }), region({ id: 4, band: 3 })],
    });
    // The most restless one.
    expect(next(v)).toEqual({ id: "uprising", order: "uprising", regionId: 4 });
  });

  it("too few fighters ready for an uprising: recruit first", () => {
    const v = view({
      available: SPEC.uprisingMinTroops - 1,
      regions: [region({ band: 2 })],
    });
    expect(next(v)).toEqual({ id: "recruit", order: "recruit" });
  });

  it("a restless area with no hideout yet, nothing ready to rise: set up a hideout there", () => {
    const v = view({ regions: [region({ id: 7, band: 1 })] });
    expect(next(v)).toEqual({ id: "base", order: "base", regionId: 7 });
  });

  it("an uprising already under way: watch it", () => {
    const v = view({
      regions: [region({ band: 2, hasOperation: true })],
      operations: [{} as never],
      bases: [{} as never],
    });
    expect(next(v).id).toBe("running");
  });

  it("everything is calm: spy on the most restless area, or just wait", () => {
    const calm = view({ regions: [region({ id: 5, band: 0 })] });
    expect(next(calm)).toEqual({ id: "intel", order: "intel", regionId: 5 });
    const noSpy = view({
      regions: [region({ band: 0 })],
      intelReadyTick: 10_000,
    });
    expect(next(noSpy).id).toBe("wait");
  });

  it("no gold for what is next: say so and wait", () => {
    const v = view({
      funds: 0n,
      available: 0,
      regions: [region({ band: 0 })],
      intelReadyTick: 10_000,
    });
    expect(next(v).id).toBe("funds");
  });

  it("no enemy-held area, or the resistance over: nothing to do", () => {
    expect(
      next(view({ regions: [region({ status: InsurgencyRegionStatus.Held })] }))
        .id,
    ).toBe("nothing");
    expect(next(view({ phase: InsurgencyPhase.Ended })).id).toBe("nothing");
  });
});
