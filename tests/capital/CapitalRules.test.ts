import {
  CAPITAL_SPEC,
  capitalStrengthPercent,
  discountedCost,
  scaleBonus,
  strainPercent,
  strainStartTick,
} from "@openfront/engine-lib/capital/CapitalRules";

const spec = CAPITAL_SPEC;

describe("capital rules", () => {
  test("a capital ramps from half its bonuses to all of them, never past", () => {
    expect(capitalStrengthPercent(spec, 0)).toBe(50);
    expect(capitalStrengthPercent(spec, -5)).toBe(50);
    expect(capitalStrengthPercent(spec, spec.rampTicks / 2)).toBe(75);
    expect(capitalStrengthPercent(spec, spec.rampTicks)).toBe(100);
    expect(capitalStrengthPercent(spec, spec.rampTicks * 5)).toBe(100);
  });

  test("a bonus is scaled by whole numbers", () => {
    expect(scaleBonus(25, 50)).toBe(12);
    expect(scaleBonus(25, 100)).toBe(25);
    expect(scaleBonus(400_000, 50)).toBe(200_000);
    expect(scaleBonus(0, 100)).toBe(0);
  });

  test("strain: none in the grace, 3% for each minute begun, at most 30%", () => {
    const since = 1_000;
    const at = (offset: number) =>
      strainPercent(spec, since, since + spec.strainGraceTicks + offset);
    expect(strainPercent(spec, since, since)).toBe(0);
    expect(at(-1)).toBe(0);
    expect(at(0)).toBe(3);
    expect(at(599)).toBe(3);
    expect(at(600)).toBe(6);
    expect(at(600 * 9)).toBe(30);
    expect(at(600 * 100)).toBe(30);
    expect(strainStartTick(spec, since)).toBe(since + spec.strainGraceTicks);
  });

  test("the discount comes off the price, and never below it", () => {
    expect(discountedCost(spec, 125_000n, 100)).toBe(93_750n);
    expect(discountedCost(spec, 125_000n, 50)).toBe(110_000n);
    expect(discountedCost(spec, 0n, 100)).toBe(0n);
  });

  test("the numbers are the ones the balance simulations settled on", () => {
    // docs/CapitalBalance.md: change these together with that sweep.
    expect(spec.cost).toBe(500_000n);
    expect(spec.startingGold).toBe(200_000n);
    expect(spec.bonusMaxTroops).toBe(400_000);
    expect(spec.bonusDiscountPercent).toBe(25);
    expect(spec.bonusIncomePercent).toBe(10);
    expect(spec.bonusRegenPercent).toBe(25);
    expect(spec.bonusAttackLossPercent).toBe(10);
    expect(spec.strainGraceTicks).toBe(10 * 600);
    expect(spec.strainPercentPerMinute).toBe(3);
    expect(spec.strainMaxPercent).toBe(30);
  });
});
