import {
  INSURGENCY_SPEC as S,
  displayTroops,
  fillPermille,
  inBounds,
  isValidRegion,
  nextUnrest,
  recruitCost,
  regionBounds,
  regionGrid,
  regionLabel,
  regionOf,
  startingFunds,
  startingTroops,
  startingUnrest,
  strength,
  survivalDeadline,
  troopCapacity,
  unrestBand,
  unrestCap,
} from "@openfront/engine-lib/insurgency/InsurgencyRules";

describe("the resistance's starting force", () => {
  test("is a tenth of the army that fell, within limits", () => {
    expect(startingTroops(S, 1_000_000)).toBe(100_000);
    expect(startingTroops(S, 600_000)).toBe(60_000);
  });
  test("is capped at 25,000 troops on screen", () => {
    expect(S.startTroopsMax).toBe(250_000);
    expect(displayTroops(S.startTroopsMax)).toBe(25_000);
    expect(startingTroops(S, 50_000_000)).toBe(250_000);
  });
  test("is nothing when the army was too small to rise with", () => {
    expect(startingTroops(S, 99_999)).toBe(0); // a tenth is under the minimum
    expect(startingTroops(S, 100_000)).toBe(10_000);
    expect(startingTroops(S, 0)).toBe(0);
    expect(startingTroops(S, -5)).toBe(0);
  });
  test("its capacity is a multiple of the start, never more", () => {
    expect(troopCapacity(S, 100_000)).toBe(200_000);
  });
});

describe("the resistance's purse", () => {
  test("is a share of what the owner earned, between a floor and a ceiling", () => {
    expect(startingFunds(S, 0n)).toBe(S.startFundsMin);
    expect(startingFunds(S, 4_000_000n)).toBe(200_000n);
    expect(startingFunds(S, 1_000_000_000n)).toBe(S.startFundsMax);
  });
  test("recruiting costs gold per troop, whole troops only", () => {
    expect(recruitCost(S, 50_000)).toBe(100_000n);
    expect(recruitCost(S, 5_000.9)).toBe(10_000n);
    expect(recruitCost(S, -1)).toBe(0n);
  });
});

describe("strength", () => {
  test("is the share of capacity held, 0 to 100", () => {
    expect(strength(100_000, 200_000)).toBe(50);
    expect(strength(0, 200_000)).toBe(0);
    expect(strength(400_000, 200_000)).toBe(100);
    expect(strength(5, 0)).toBe(0);
  });
});

describe("regions", () => {
  const grid = regionGrid(100, 70, 5); // 32 x 32 tiles: 4 columns, 3 rows
  test("the map is cut into squares, numbered row by row", () => {
    expect(grid.cols).toBe(4);
    expect(grid.rows).toBe(3);
    expect(regionOf(grid, 0, 0)).toBe(0);
    expect(regionOf(grid, 31, 31)).toBe(0);
    expect(regionOf(grid, 32, 0)).toBe(1);
    expect(regionOf(grid, 0, 32)).toBe(4);
    expect(regionOf(grid, 99, 69)).toBe(11);
  });
  test("bounds are inclusive, and clipped at the map's edge", () => {
    expect(regionBounds(grid, 0)).toEqual({ x0: 0, y0: 0, x1: 31, y1: 31 });
    expect(regionBounds(grid, 3)).toEqual({ x0: 96, y0: 0, x1: 99, y1: 31 });
    expect(regionBounds(grid, 11)).toEqual({ x0: 96, y0: 64, x1: 99, y1: 69 });
  });
  test("a tile is in its own region's bounds and no other", () => {
    for (const [x, y] of [
      [0, 0],
      [31, 31],
      [32, 0],
      [57, 40],
      [99, 69],
    ]) {
      const r = regionOf(grid, x, y);
      expect(inBounds(regionBounds(grid, r), x, y)).toBe(true);
      expect(inBounds(regionBounds(grid, (r + 1) % 12), x, y)).toBe(false);
    }
  });
  test("a region is named like a chessboard square", () => {
    expect(regionLabel(grid, 0)).toBe("A1");
    expect(regionLabel(grid, 3)).toBe("D1");
    expect(regionLabel(grid, 4)).toBe("A2");
    expect(regionLabel(grid, 11)).toBe("D3");
    const wide = regionGrid(32 * 30, 64, 5); // 30 columns
    expect(regionLabel(wide, 25)).toBe("Z1");
    expect(regionLabel(wide, 26)).toBe("AA1");
    expect(regionLabel(wide, 29)).toBe("AD1");
    expect(regionLabel(wide, 30)).toBe("A2");
  });
  test("only real regions are valid", () => {
    expect(isValidRegion(grid, 0)).toBe(true);
    expect(isValidRegion(grid, 11)).toBe(true);
    expect(isValidRegion(grid, 12)).toBe(false);
    expect(isValidRegion(grid, -1)).toBe(false);
    expect(isValidRegion(grid, 1.5)).toBe(false);
    expect(isValidRegion(grid, Number.NaN)).toBe(false);
  });
});

describe("unrest", () => {
  test("bands follow the spec: 0-24, 25-49, 50-74, 75-99, 100", () => {
    expect(unrestBand(0)).toBe("stable");
    expect(unrestBand(24)).toBe("stable");
    expect(unrestBand(25)).toBe("unsettled");
    expect(unrestBand(49)).toBe("unsettled");
    expect(unrestBand(50)).toBe("unrestful");
    expect(unrestBand(74)).toBe("unrestful");
    expect(unrestBand(75)).toBe("volatile");
    expect(unrestBand(99)).toBe("volatile");
    expect(unrestBand(100)).toBe("uprising");
  });

  test("a region starts restless in proportion to how much of it was held", () => {
    const area = 1024;
    expect(startingUnrest(S, 12, area)).toBe(25);
    expect(startingUnrest(S, 512, area)).toBe(50);
    expect(startingUnrest(S, 1_000, area)).toBe(50);
    expect(startingUnrest(S, 256, area)).toBe(37);
  });

  const base = {
    unrest: 40,
    occupied: true,
    occupierFillPermille: 500,
    hasBase: false,
    hasOperation: false,
    suppressed: false,
    flips: 0,
  };

  test("rises where the occupier is thin, faster the thinner", () => {
    expect(nextUnrest(S, { ...base, occupierFillPermille: 100 })).toBe(42);
    expect(nextUnrest(S, { ...base, occupierFillPermille: 500 })).toBe(41);
    expect(nextUnrest(S, { ...base, occupierFillPermille: 700 })).toBe(40);
  });

  test("falls where the occupier is strong, and the resistance's help does not save it", () => {
    expect(nextUnrest(S, { ...base, occupierFillPermille: 900 })).toBe(39);
    expect(
      nextUnrest(S, {
        ...base,
        occupierFillPermille: 900,
        hasBase: true,
        hasOperation: true,
      }),
    ).toBe(39);
  });

  test("a base and an uprising add to it where the occupier is not strong", () => {
    expect(nextUnrest(S, { ...base, hasBase: true })).toBe(42);
    expect(nextUnrest(S, { ...base, hasBase: true, hasOperation: true })).toBe(
      43,
    );
  });

  test("suppression pushes it down, whatever else", () => {
    expect(
      nextUnrest(S, { ...base, occupierFillPermille: 100, suppressed: true }),
    ).toBe(39);
    expect(nextUnrest(S, { ...base, suppressed: true })).toBe(38);
  });

  test("never leaves 0..100, and a region that is not occupied has none", () => {
    expect(
      nextUnrest(S, { ...base, unrest: 99, occupierFillPermille: 0 }),
    ).toBe(100);
    expect(
      nextUnrest(S, { ...base, unrest: 100, occupierFillPermille: 0 }),
    ).toBe(100);
    expect(
      nextUnrest(S, { ...base, unrest: 0, occupierFillPermille: 1000 }),
    ).toBe(0);
    expect(nextUnrest(S, { ...base, occupied: false })).toBe(0);
  });

  test("each hand-over of a region lowers how restless it can ever get again", () => {
    expect(unrestCap(S, 0)).toBe(100);
    expect(unrestCap(S, 1)).toBe(80);
    expect(unrestCap(S, 2)).toBe(60);
    expect(unrestCap(S, 3)).toBe(40);
    expect(unrestCap(S, 10)).toBe(40); // never below the floor
    expect(
      nextUnrest(S, { ...base, unrest: 99, occupierFillPermille: 0, flips: 2 }),
    ).toBe(60);
  });

  test("cannot climb for ever against a strong occupier, over many updates", () => {
    let unrest = 90;
    for (let i = 0; i < 200; i++) {
      unrest = nextUnrest(S, {
        ...base,
        unrest,
        occupierFillPermille: 950,
        hasBase: true,
        hasOperation: true,
      });
    }
    expect(unrest).toBe(0);
  });

  test("a weak occupier takes a few minutes to bring a region to the edge", () => {
    let unrest = 30;
    let updates = 0;
    while (unrest < 100) {
      unrest = nextUnrest(S, { ...base, unrest, occupierFillPermille: 100 });
      updates++;
    }
    // 35 updates of 5 s at +2: about three minutes.
    expect(updates).toBe(35);
    expect((updates * S.unrestInterval) / 600).toBeGreaterThan(2.5);
  });
});

describe("fill", () => {
  test("is the army as permille of its maximum", () => {
    expect(fillPermille(50, 100)).toBe(500);
    expect(fillPermille(0, 100)).toBe(0);
    expect(fillPermille(500, 100)).toBe(1000);
    expect(fillPermille(5, 0)).toBe(1000);
  });
});

describe("how long the resistance lasts", () => {
  test("a fixed period, extended by each region reclaimed, never past a ceiling", () => {
    expect(survivalDeadline(S, 1_000, 0)).toBe(1_000 + 7_200);
    expect(survivalDeadline(S, 1_000, 2)).toBe(1_000 + 7_200 + 3_600);
    expect(survivalDeadline(S, 1_000, 99)).toBe(1_000 + 18_000);
  });
});
