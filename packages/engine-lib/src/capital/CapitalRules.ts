import { type Gold, UnitType } from "@openfront/engine-api/game/GameTypes";

/**
 * The Capital System's numbers and the pure rules over them (docs/Capital.md).
 * Developer tuning, not match settings: every value is a proposal for
 * playtesting, in one place so a rebalance is a one-line change. Pure data and
 * integer arithmetic only: the same on every client.
 *
 * Every capital is bought: nobody starts with one. While it stands it adds
 * bonuses (ramping in over its first minutes); without one, a nation is under
 * strain once the opening grace is over. When an enemy captures it the owner
 * enters CRISIS (a timed penalty to income and troop regeneration), the captor
 * is paid once, and the owner may buy another.
 */
export interface CapitalSpec {
  /** Gold every capital costs, the first and any replacement. */
  cost: Gold;
  /** Gold everyone starts with while the Capital System is on (the host's own is added). */
  startingGold: Gold;
  /** Ticks after a capital falls before another may be bought (never the first). */
  replacementDelayTicks: number;
  /** Percent of normal gold income during CRISIS. */
  crisisIncomePercent: number;
  /** Percent of normal troop regeneration during CRISIS. */
  crisisRegenPercent: number;
  /** Extra percent of gold income while a capital stands (at full strength). */
  bonusIncomePercent: number;
  /** Extra percent of troop regeneration while a capital stands (at full strength). */
  bonusRegenPercent: number;
  /** Flat extra maximum troops while a capital stands (at full strength). */
  bonusMaxTroops: number;
  /** Percent off City, Port, Factory and Defense Post while a capital stands (at full strength). */
  bonusDiscountPercent: number;
  /** Percent off the troops an attacker loses while a capital stands (at full strength). */
  bonusAttackLossPercent: number;
  /** A new capital starts at this percent of its full bonuses... */
  rampStartPercent: number;
  /** ...and reaches 100 percent after standing this many ticks. */
  rampTicks: number;
  /** Ticks after the match starts (or after a CRISIS ends) before having no capital costs anything. */
  strainGraceTicks: number;
  /** Percent of income and troop regeneration lost for each minute of strain, started. */
  strainPercentPerMinute: number;
  /** The most strain can take, in percent. */
  strainMaxPercent: number;
  /** Percent of the troops above the maximum that drain away each tick (the army of a fallen capital). */
  excessTroopsDrainPercent: number;
  /** Gold paid to a captor for taking a first capital. */
  captureGold: Gold;
  /** Gold paid to a captor for taking a rebuilt capital. */
  captureGoldReplacement: Gold;
  /** Troops paid to a captor, as a percent of its maximum army (never past the maximum). */
  captureTroopsPercent: number;
}

export const CAPITAL_SPEC: CapitalSpec = {
  cost: 500_000n,
  startingGold: 200_000n,
  replacementDelayTicks: 300,
  crisisIncomePercent: 50,
  crisisRegenPercent: 50,
  bonusIncomePercent: 10,
  bonusRegenPercent: 25,
  bonusMaxTroops: 400_000,
  bonusDiscountPercent: 25,
  bonusAttackLossPercent: 10,
  rampStartPercent: 50,
  rampTicks: 1_800,
  strainGraceTicks: 6_000,
  strainPercentPerMinute: 3,
  strainMaxPercent: 30,
  excessTroopsDrainPercent: 1.5,
  captureGold: 250_000n,
  captureGoldReplacement: 125_000n,
  captureTroopsPercent: 10,
};

/** The structures a standing capital makes cheaper. */
export const CAPITAL_DISCOUNT_STRUCTURES: readonly UnitType[] = [
  UnitType.City,
  UnitType.Port,
  UnitType.Factory,
  UnitType.DefensePost,
];

/**
 * The structures only a nation with a standing capital may build: the ones that
 * launch attacks from afar. (SAM launchers are not here: every nation may
 * defend itself.) Existing ones keep working if the capital falls.
 */
export const CAPITAL_REQUIRED_STRUCTURES: readonly UnitType[] = [
  UnitType.MissileSilo,
  UnitType.Airport,
];

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
 * How much of its bonuses a capital gives (50 to 100 percent): a new capital
 * starts at `rampStartPercent` and reaches all of it after `rampTicks`.
 */
export function capitalStrengthPercent(
  spec: CapitalSpec,
  ageTicks: number,
): number {
  if (ageTicks >= spec.rampTicks) return 100;
  const start = spec.rampStartPercent;
  const age = Math.max(0, ageTicks);
  return start + Math.floor(((100 - start) * age) / spec.rampTicks);
}

/** `bonus` (a percent or an amount) at a capital's current `strength` (50 to 100). */
export function scaleBonus(bonus: number, strength: number): number {
  return Math.floor((bonus * strength) / 100);
}

/**
 * The strain on a nation without a capital, in percent (0 to the maximum): none
 * until `strainGraceTicks` after `sinceTick` (the match start, or the end of its
 * last CRISIS), then `strainPercentPerMinute` for each minute begun.
 */
export function strainPercent(
  spec: CapitalSpec,
  sinceTick: number,
  nowTick: number,
): number {
  const over = nowTick - sinceTick - spec.strainGraceTicks;
  if (over < 0) return 0;
  const minutes = 1 + Math.floor(over / TICKS_PER_MINUTE);
  return Math.min(spec.strainMaxPercent, spec.strainPercentPerMinute * minutes);
}

/** The tick strain begins for a nation that has had no capital since `sinceTick`. */
export function strainStartTick(spec: CapitalSpec, sinceTick: number): number {
  return sinceTick + spec.strainGraceTicks;
}

/** `cost` less a capital's structure discount at `strength`. */
export function discountedCost(
  spec: CapitalSpec,
  cost: Gold,
  strength: number,
): Gold {
  const percent = scaleBonus(spec.bonusDiscountPercent, strength);
  return (cost * BigInt(100 - percent)) / 100n;
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
