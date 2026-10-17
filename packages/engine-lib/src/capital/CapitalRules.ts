import type { Gold } from "@openfront/engine-api/game/GameTypes";

/**
 * The Capital System's numbers and the pure rules over them (docs/Capital.md).
 * Developer tuning, not match settings: every value is a proposal for
 * playtesting, in one place so a rebalance is a one-line change. Pure data and
 * integer arithmetic only: the same on every client.
 *
 * A capital is a player's seat of government, founded where they spawn when the
 * spawn phase ends. While it stands it adds a small bonus to gold income and
 * troop regeneration. When an enemy captures it the owner enters CRISIS (a
 * timed penalty to both), the captor is paid once, and the owner may found a
 * replacement for gold.
 */
export interface CapitalSpec {
  /** Gold a replacement capital costs. */
  replacementCost: Gold;
  /** Ticks after a capital falls before a replacement may be founded. */
  replacementDelayTicks: number;
  /** Percent of normal gold income during CRISIS. */
  crisisIncomePercent: number;
  /** Percent of normal troop regeneration during CRISIS. */
  crisisRegenPercent: number;
  /** Extra percent of gold income while a capital stands (at full strength). */
  bonusIncomePercent: number;
  /** Extra percent of troop regeneration while a capital stands (at full strength). */
  bonusRegenPercent: number;
  /** A replacement capital starts at this percent of its full bonus... */
  replacementBonusStartPercent: number;
  /** ...and reaches 100 percent after standing this many ticks. */
  replacementRampTicks: number;
  /** Gold paid to a captor for taking an original capital. */
  captureGold: Gold;
  /** Gold paid to a captor for taking a replacement capital. */
  captureGoldReplacement: Gold;
  /** Troops paid to a captor, as a percent of its maximum army (never past the maximum). */
  captureTroopsPercent: number;
}

export const CAPITAL_SPEC: CapitalSpec = {
  replacementCost: 500_000n,
  replacementDelayTicks: 300,
  crisisIncomePercent: 50,
  crisisRegenPercent: 50,
  bonusIncomePercent: 10,
  bonusRegenPercent: 10,
  replacementBonusStartPercent: 50,
  replacementRampTicks: 3_000,
  captureGold: 250_000n,
  captureGoldReplacement: 125_000n,
  captureTroopsPercent: 10,
};

/** Ticks in one minute of game time (the simulation runs at 10 ticks a second). */
export const TICKS_PER_MINUTE = 600;

/** The two crisis lengths a match can use. Anything else reads as the default. */
export const CRISIS_MINUTES_DEFAULT = 3;
export const CRISIS_MINUTES_LONG = 5;

export function normalizeCrisisMinutes(
  minutes: number | undefined,
): typeof CRISIS_MINUTES_DEFAULT | typeof CRISIS_MINUTES_LONG {
  return minutes === CRISIS_MINUTES_LONG
    ? CRISIS_MINUTES_LONG
    : CRISIS_MINUTES_DEFAULT;
}

export function crisisTicks(minutes: number | undefined): number {
  return normalizeCrisisMinutes(minutes) * TICKS_PER_MINUTE;
}

/**
 * The bonus percent (0..spec bonus) a capital contributes: its full bonus, or
 * for a replacement the ramp from `replacementBonusStartPercent` of it up to all
 * of it over `replacementRampTicks`. `bonus` is the full bonus being scaled.
 */
export function capitalBonusPercent(
  spec: CapitalSpec,
  bonus: number,
  replacement: boolean,
  ageTicks: number,
): number {
  if (!replacement || ageTicks >= spec.replacementRampTicks) return bonus;
  const start = spec.replacementBonusStartPercent;
  const age = Math.max(0, ageTicks);
  const share = start + Math.floor(((100 - start) * age) / spec.replacementRampTicks);
  return Math.floor((bonus * share) / 100);
}

/**
 * `amount` scaled by a whole-number percent. Only growth is scaled: a negative
 * amount (a pool above its maximum draining back down) is never softened or
 * deepened by a bonus or a penalty.
 */
export function scaleByPercent(amount: number, percent: number): number {
  if (amount <= 0 || percent === 100) return amount;
  return Math.floor((amount * percent) / 100);
}

export function scaleGoldByPercent(amount: Gold, percent: number): Gold {
  if (amount <= 0n || percent === 100) return amount;
  return (amount * BigInt(percent)) / 100n;
}

/**
 * Troops a captor is paid: `captureTroopsPercent` of its maximum army, but never
 * more than fits under that maximum, so the grant cannot be drained straight
 * back by the regeneration's pull towards the maximum.
 */
export function captureTroopReward(
  spec: CapitalSpec,
  maxTroops: number,
  currentTroops: number,
): number {
  const grant = Math.floor((maxTroops * spec.captureTroopsPercent) / 100);
  const room = Math.max(0, Math.floor(maxTroops) - Math.floor(currentTroops));
  return Math.max(0, Math.min(grant, room));
}

/** `defender:captor`, the key a pair's single capture payment is recorded under. */
export function capturePairKey(defender: number, captor: number): string {
  return `${defender}:${captor}`;
}
