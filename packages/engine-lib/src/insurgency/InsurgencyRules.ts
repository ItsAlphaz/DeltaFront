import type { Gold } from "@openfront/engine-api/game/GameTypes";

/**
 * The Insurgency System's numbers and the pure rules over them
 * (docs/Insurgency.md). Developer tuning, not match settings, and every value
 * is a starting point for playtesting, in one place so a rebalance is a
 * one-line change. Integer arithmetic only: the same on every client.
 *
 * Troops here are the engine's own units, which are ten times what the player
 * sees (renderTroops divides by 10): 25,000 troops on screen is 250,000 here.
 *
 * A defeated human whose capital has fallen may organise a resistance: a small
 * force and a small purse of their own, kept apart from their nation's army and
 * treasury, spent through four orders (recruit, found a base, launch an
 * uprising, gather intelligence). The map is cut into square regions; the land
 * the player held when the capital fell is their national regions, each with an
 * unrest that rises where the occupier is thin on the ground and falls where
 * they are strong or have sent troops to suppress it. Nothing here moves a tile:
 * an uprising is an ordinary attack, bounded to its region.
 */
export interface InsurgencySpec {
  // ---- the force the resistance starts with ----
  /** Percent of the owner's army, when its capital fell, that rises. */
  startTroopsPercent: number;
  /** The most it can start with (25,000 on screen). */
  startTroopsMax: number;
  /** A smaller army than this has nothing to rise with: no insurgency. */
  startTroopsMin: number;
  /** Total manpower (in the field, in reserve, in training) never exceeds the start times this. */
  capacityMultiplier: number;

  // ---- the purse ----
  /** Starting funds: this percent of all the gold the owner ever earned... */
  startFundsPercentOfGoldEarned: number;
  /** ...but at least this... */
  startFundsMin: Gold;
  /** ...and at most this. */
  startFundsMax: Gold;
  /** While it holds land, this percent of the owner's gold income goes to the resistance... */
  incomeSharePercent: number;
  /** ...until it has diverted this much in all (it is moved, never created). */
  incomeShareMax: Gold;

  // ---- recruitment ----
  /** Gold per troop (engine units) recruited. */
  recruitGoldPerTroop: Gold;
  recruitMinTroops: number;
  /** Ticks a batch takes to arrive. */
  recruitTicks: number;
  maxPendingRecruits: number;

  // ---- bases ----
  baseCost: Gold;
  maxBases: number;
  /** A region needs at least this much unrest for a base. */
  baseMinUnrest: number;

  // ---- uprisings ----
  uprisingCost: Gold;
  /** A region needs at least this much unrest for an uprising. */
  uprisingMinUnrest: number;
  uprisingMinTroops: number;
  maxOperations: number;
  /** After an uprising in a region ends, no new one there for this long. */
  regionCooldownTicks: number;

  // ---- regions ----
  /** A region is a square of 2^shift tiles a side. */
  regionShift: number;
  /** A region the owner held fewer tiles of than this is not worth resisting for. */
  minRegionTiles: number;
  /** A region is occupied when hostile players hold this percent of the tiles the owner held. */
  occupiedPercent: number;
  /** ...and reclaimed when the owner holds this percent again. */
  reclaimedPercent: number;

  // ---- unrest (0..100) ----
  /** Ticks between unrest updates. */
  unrestInterval: number;
  /** A region starts between these, by how much of it the owner held. */
  unrestStartMin: number;
  unrestStartMax: number;
  /** The occupier's army as permille of its maximum: below `low` it is thin, above `high` it is strong. */
  unrestLowFillPermille: number;
  unrestMidFillPermille: number;
  unrestHighFillPermille: number;
  /** Change per update: occupier thin, middling, strong; a base in the region; an uprising in it; suppression. */
  unrestWeakStep: number;
  unrestMidStep: number;
  unrestStrongStep: number;
  unrestBaseStep: number;
  unrestOpStep: number;
  unrestSuppressStep: number;
  /** Each time a region changes hands its ceiling drops by this, down to `unrestCapMin`. */
  flipCapStep: number;
  unrestCapMin: number;
  /** The occupier is warned at this unrest, and again only after it has fallen below `volatileRearmAt`. */
  volatileAt: number;
  volatileRearmAt: number;

  // ---- intelligence ----
  intelCost: Gold;
  intelCooldownTicks: number;
  /** A report is precise this long, then only the band. */
  intelFreshTicks: number;

  // ---- suppression (the occupier's answer) ----
  /** Troops committed: this percent of the occupier's army, at least `suppressMinTroops`. */
  suppressPercent: number;
  suppressMinTroops: number;
  suppressTicks: number;
  /** Suppressions one player may run at once. */
  suppressMax: number;
  /** Each update, a base in a suppressed region loses this much integrity (of 100). */
  suppressBaseDamage: number;
  /** ...and an uprising there loses this percent of its troops. */
  suppressOpAttritionPercent: number;
  /** When it ends this percent of the troops come home; the rest are spent. */
  suppressReturnPercent: number;

  // ---- how long it lasts ----
  /** The resistance dissolves this long after it began... */
  survivalTicks: number;
  /** ...each region reclaimed adds this much... */
  survivalExtensionTicks: number;
  /** ...but never past this long in all. */
  survivalMaxTicks: number;
  /** A player with no land at all survives this long, unless they win some back. */
  limboTicks: number;
  /** Funds paid once for each region reclaimed. */
  reclaimFunds: Gold;
  /**
   * Extra defence, in percent, an occupier has against the ordinary attacks of the
   * player whose land it holds, by the area's unrest band (stable, unsettled,
   * unrestful, volatile, uprising): freshly occupied land is hard to retake by
   * simply attacking, and eases as the people turn against the occupier. An
   * uprising is not an ordinary attack and does not meet it.
   */
  occupationDefenseByBand: readonly number[];
  /** Ticks taken off the owner's CRISIS for each region won back for the first time. */
  reclaimCrisisReductionTicks: number;
  /** The player is warned this long before the end. */
  warnTicks: number;
}

export const INSURGENCY_SPEC: InsurgencySpec = {
  startTroopsPercent: 10,
  startTroopsMax: 250_000,
  startTroopsMin: 10_000,
  capacityMultiplier: 2,

  startFundsPercentOfGoldEarned: 5,
  startFundsMin: 100_000n,
  startFundsMax: 1_000_000n,
  incomeSharePercent: 10,
  incomeShareMax: 500_000n,

  recruitGoldPerTroop: 2n,
  recruitMinTroops: 5_000,
  recruitTicks: 300,
  maxPendingRecruits: 3,

  baseCost: 50_000n,
  maxBases: 2,
  baseMinUnrest: 25,

  uprisingCost: 25_000n,
  uprisingMinUnrest: 50,
  uprisingMinTroops: 5_000,
  maxOperations: 2,
  regionCooldownTicks: 600,

  regionShift: 5,
  minRegionTiles: 12,
  occupiedPercent: 40,
  reclaimedPercent: 60,

  unrestInterval: 50,
  unrestStartMin: 25,
  unrestStartMax: 50,
  unrestLowFillPermille: 350,
  unrestMidFillPermille: 600,
  unrestHighFillPermille: 850,
  unrestWeakStep: 2,
  unrestMidStep: 1,
  unrestStrongStep: -1,
  unrestBaseStep: 1,
  unrestOpStep: 1,
  unrestSuppressStep: -3,
  flipCapStep: 20,
  unrestCapMin: 40,
  volatileAt: 75,
  volatileRearmAt: 60,

  intelCost: 10_000n,
  intelCooldownTicks: 300,
  intelFreshTicks: 600,

  suppressPercent: 3,
  suppressMinTroops: 10_000,
  suppressTicks: 600,
  suppressMax: 2,
  suppressBaseDamage: 15,
  suppressOpAttritionPercent: 5,
  suppressReturnPercent: 90,

  survivalTicks: 7_200,
  survivalExtensionTicks: 1_800,
  survivalMaxTicks: 18_000,
  limboTicks: 3_000,
  reclaimFunds: 20_000n,
  occupationDefenseByBand: [200, 140, 80, 30, 0],
  reclaimCrisisReductionTicks: 300,
  warnTicks: 600,
};

/** What a region's unrest means to the player (0-24, 25-49, 50-74, 75-99, 100). */
export type UnrestBand =
  | "stable"
  | "unsettled"
  | "unrestful"
  | "volatile"
  | "uprising";

/** The extra defence percent an occupier has in an area at this unrest (see `occupationDefenseByBand`). */
export function occupationDefensePercent(
  spec: InsurgencySpec,
  unrest: number,
): number {
  const band =
    unrest >= 100
      ? 4
      : unrest >= 75
        ? 3
        : unrest >= 50
          ? 2
          : unrest >= 25
            ? 1
            : 0;
  return spec.occupationDefenseByBand[band] ?? 0;
}

export function unrestBand(unrest: number): UnrestBand {
  if (unrest >= 100) return "uprising";
  if (unrest >= 75) return "volatile";
  if (unrest >= 50) return "unrestful";
  if (unrest >= 25) return "unsettled";
  return "stable";
}

// ---------------------------------------------------------------- regions

/** The map's regions: squares of `1 << shift` tiles a side, numbered row by row. */
export interface RegionGrid {
  shift: number;
  size: number;
  cols: number;
  rows: number;
  width: number;
  height: number;
}

export function regionGrid(
  width: number,
  height: number,
  shift: number,
): RegionGrid {
  const size = 1 << shift;
  return {
    shift,
    size,
    cols: Math.ceil(width / size),
    rows: Math.ceil(height / size),
    width,
    height,
  };
}

export function regionOf(grid: RegionGrid, x: number, y: number): number {
  return (y >> grid.shift) * grid.cols + (x >> grid.shift);
}

export interface RegionBounds {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** The tiles of a region, inclusive: a region on the map's edge is smaller. */
export function regionBounds(grid: RegionGrid, region: number): RegionBounds {
  const x0 = (region % grid.cols) * grid.size;
  const y0 = Math.floor(region / grid.cols) * grid.size;
  return {
    x0,
    y0,
    x1: Math.min(grid.width - 1, x0 + grid.size - 1),
    y1: Math.min(grid.height - 1, y0 + grid.size - 1),
  };
}

/**
 * A region's name on the map, like a chessboard square: the column as letters
 * (A..Z, then AA..) and the row from 1. "C7" is easier to find than 214.
 */
export function regionLabel(grid: RegionGrid, region: number): string {
  let col = region % grid.cols;
  let letters = "";
  do {
    letters = String.fromCharCode(65 + (col % 26)) + letters;
    col = Math.floor(col / 26) - 1;
  } while (col >= 0);
  return `${letters}${Math.floor(region / grid.cols) + 1}`;
}

export function isValidRegion(grid: RegionGrid, region: number): boolean {
  return (
    Number.isInteger(region) && region >= 0 && region < grid.cols * grid.rows
  );
}

export function inBounds(b: RegionBounds, x: number, y: number): boolean {
  return x >= b.x0 && x <= b.x1 && y >= b.y0 && y <= b.y1;
}

// ----------------------------------------------------- the force and the purse

/** Troops (engine units) the resistance starts with, or 0 when there is too little to rise. */
export function startingTroops(spec: InsurgencySpec, army: number): number {
  const rising = Math.min(
    spec.startTroopsMax,
    Math.floor((Math.max(0, army) * spec.startTroopsPercent) / 100),
  );
  return rising >= spec.startTroopsMin ? rising : 0;
}

/** The most troops the resistance may ever hold at once. */
export function troopCapacity(spec: InsurgencySpec, starting: number): number {
  return starting * spec.capacityMultiplier;
}

/** The starting purse, by how much the owner earned over the match. */
export function startingFunds(spec: InsurgencySpec, goldEarned: Gold): Gold {
  const share =
    (goldEarned * BigInt(spec.startFundsPercentOfGoldEarned)) / 100n;
  if (share < spec.startFundsMin) return spec.startFundsMin;
  if (share > spec.startFundsMax) return spec.startFundsMax;
  return share;
}

export function recruitCost(spec: InsurgencySpec, troops: number): Gold {
  return spec.recruitGoldPerTroop * BigInt(Math.max(0, Math.floor(troops)));
}

/** 0..100: how much of its capacity the resistance holds. */
export function strength(total: number, capacity: number): number {
  if (capacity <= 0) return 0;
  return Math.min(100, Math.max(0, Math.round((100 * total) / capacity)));
}

// ------------------------------------------------------------------ unrest

/** A region starts restless in proportion to how much of it the owner held. */
export function startingUnrest(
  spec: InsurgencySpec,
  formerTiles: number,
  regionArea: number,
): number {
  const share = Math.min(1, formerTiles / Math.max(1, regionArea / 2));
  return (
    spec.unrestStartMin +
    Math.floor((spec.unrestStartMax - spec.unrestStartMin) * share)
  );
}

/** Each hand-over of a region lowers how restless it can ever get again. */
export function unrestCap(spec: InsurgencySpec, flips: number): number {
  return Math.max(spec.unrestCapMin, 100 - flips * spec.flipCapStep);
}

export interface UnrestInput {
  unrest: number;
  occupied: boolean;
  /** The occupier's army as permille of its maximum. */
  occupierFillPermille: number;
  hasBase: boolean;
  hasOperation: boolean;
  suppressed: boolean;
  flips: number;
}

/**
 * The region's unrest after one update. It rises where the occupier is thin on
 * the ground, is helped by the resistance's own presence (a base, an uprising),
 * and falls where the occupier is strong or is suppressing. A strong occupier
 * wins outright: the resistance's help does not count against it, so unrest
 * cannot climb while a region is heavily defended. A region that is not
 * occupied has no unrest to speak of.
 */
export function nextUnrest(spec: InsurgencySpec, input: UnrestInput): number {
  if (!input.occupied) return 0;
  const cap = unrestCap(spec, input.flips);
  let delta: number;
  if (input.occupierFillPermille >= spec.unrestHighFillPermille) {
    delta = spec.unrestStrongStep;
  } else {
    delta =
      input.occupierFillPermille < spec.unrestLowFillPermille
        ? spec.unrestWeakStep
        : input.occupierFillPermille < spec.unrestMidFillPermille
          ? spec.unrestMidStep
          : 0;
    if (input.hasBase) delta += spec.unrestBaseStep;
    if (input.hasOperation) delta += spec.unrestOpStep;
  }
  if (input.suppressed) delta += spec.unrestSuppressStep;
  return Math.max(0, Math.min(cap, input.unrest + delta));
}

/** An army as permille of its maximum, 0..1000. */
export function fillPermille(troops: number, maxTroops: number): number {
  if (maxTroops <= 0) return 1000;
  return Math.max(0, Math.min(1000, Math.floor((1000 * troops) / maxTroops)));
}

// ---------------------------------------------------------------- time

/** The tick the resistance dissolves unless it earns more time. */
export function survivalDeadline(
  spec: InsurgencySpec,
  startTick: number,
  reclaimedRegions: number,
): number {
  const total = Math.min(
    spec.survivalMaxTicks,
    spec.survivalTicks + reclaimedRegions * spec.survivalExtensionTicks,
  );
  return startTick + total;
}

/** Engine troops as shown to the player. */
export function displayTroops(troops: number): number {
  return Math.floor(troops / 10);
}
