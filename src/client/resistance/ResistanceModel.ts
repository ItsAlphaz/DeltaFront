import type { Gold, Tick } from "@openfront/engine-api/game/GameTypes";
import {
  InsurgencyPhase,
  InsurgencyRegionStatus,
  type InsurgencyIntelView,
  type InsurgencyRegionView,
  type InsurgencyView,
} from "@openfront/engine-api/game/GameUpdates";
import type { InsurgencySpec } from "@openfront/engine-lib/insurgency/InsurgencyRules";
import { TICKS_PER_SECOND } from "../capital/CrisisClock";

/**
 * What the Resistance Command panel shows and may offer, worked out from the
 * state the engine reports (docs/Insurgency.md). Pure functions, no DOM, so
 * they are tested without a browser.
 *
 * The previews mirror the engine's own checks so a button can say why it is
 * unavailable and what an order will cost. They decide nothing: the engine
 * checks every order again, identically on every client, and a refused order
 * costs nothing.
 *
 * Troops are the engine's units here (ten times what the player sees); the
 * panel converts at its edges with `displayTroops` / `engineTroops`.
 */

export const TROOP_SCALE = 10;

export function engineTroops(shown: number): number {
  return Math.round(shown * TROOP_SCALE);
}

export function shownTroops(engine: number): number {
  return Math.floor(engine / TROOP_SCALE);
}

/** The words for an unrest band (the view's `band`: 0 to 4). */
export const BAND_KEYS = [
  "stable",
  "unsettled",
  "unrestful",
  "volatile",
  "uprising",
] as const;
export type BandKey = (typeof BAND_KEYS)[number];

export function bandKey(band: number): BandKey {
  return BAND_KEYS[Math.max(0, Math.min(BAND_KEYS.length - 1, band))];
}

/** Why an order cannot be sent now (null: it can). Keys of `resistance.block.*`. */
export type OrderBlock =
  | "ended"
  | "funds"
  | "capacity"
  | "limit"
  | "troops"
  | "reserve"
  | "no_region"
  | "not_occupied"
  | "unrest"
  | "cooldown"
  | "busy"
  | "no_location";

export function isRunning(view: InsurgencyView | null): view is InsurgencyView {
  return view !== null && view.phase !== InsurgencyPhase.Ended;
}

export function pendingTroops(view: InsurgencyView): number {
  let total = 0;
  for (const p of view.pending) total += p.troops;
  return total;
}

/** Everything the resistance has: reserve, in the field, and on the way. */
export function totalTroops(view: InsurgencyView): number {
  return view.available + view.deployed + pendingTroops(view);
}

export function capacityLeft(view: InsurgencyView): number {
  return Math.max(0, view.capacity - totalTroops(view));
}

/** Seconds from `now` to `tick`, never negative. */
export function secondsUntil(tick: Tick, now: Tick): number {
  return Math.max(0, Math.ceil((tick - now) / TICKS_PER_SECOND));
}

/** The clock the player is racing: the survival time, or with no land the time to win a tile back. */
export function timeLeftSeconds(view: InsurgencyView, now: Tick): number {
  const deadline =
    view.phase === InsurgencyPhase.Limbo && view.limboDeadline >= 0
      ? view.limboDeadline
      : view.deadline;
  return secondsUntil(deadline, now);
}

/** A place to gather and arrive: a base, or land of their own. */
export function hasLocation(view: InsurgencyView, hasLand: boolean): boolean {
  return view.bases.length > 0 || hasLand;
}

export function region(
  view: InsurgencyView,
  id: number | null,
): InsurgencyRegionView | undefined {
  return id === null ? undefined : view.regions.find((r) => r.id === id);
}

/** The latest report on a region, if one was ever bought. */
export function intelFor(
  view: InsurgencyView,
  regionId: number,
): InsurgencyIntelView | undefined {
  return view.intel.find((r) => r.region === regionId);
}

/** A report is precise for a while, then only the band is to be trusted. */
export function intelIsFresh(
  spec: InsurgencySpec,
  report: InsurgencyIntelView,
  now: Tick,
): boolean {
  return now - report.tick <= spec.intelFreshTicks;
}

// ---------------------------------------------------------------- recruiting

export interface RecruitBounds {
  min: number;
  /** The most that fits the capacity and the purse (may be below `min`). */
  max: number;
}

export function recruitBounds(
  spec: InsurgencySpec,
  view: InsurgencyView,
): RecruitBounds {
  const affordable = Number(view.funds / spec.recruitGoldPerTroop);
  return {
    min: spec.recruitMinTroops,
    max: Math.max(0, Math.min(capacityLeft(view), affordable)),
  };
}

export interface RecruitPreview {
  cost: Gold;
  seconds: number;
  /** Capacity left once this batch is counted. */
  roomAfter: number;
  block: OrderBlock | null;
}

export function previewRecruit(
  spec: InsurgencySpec,
  view: InsurgencyView,
  troops: number,
  hasLand: boolean,
): RecruitPreview {
  const cost =
    spec.recruitGoldPerTroop * BigInt(Math.max(0, Math.floor(troops)));
  const roomAfter = capacityLeft(view) - Math.max(0, troops);
  let block: OrderBlock | null = null;
  if (!isRunning(view)) block = "ended";
  else if (!Number.isInteger(troops) || troops < spec.recruitMinTroops) {
    block = "troops";
  } else if (view.pending.length >= spec.maxPendingRecruits) block = "limit";
  else if (!hasLocation(view, hasLand)) block = "no_location";
  else if (roomAfter < 0) block = "capacity";
  else if (view.funds < cost) block = "funds";
  return {
    cost,
    seconds: Math.round(spec.recruitTicks / TICKS_PER_SECOND),
    roomAfter,
    block,
  };
}

// ------------------------------------------------------------------ the rest

export interface SimplePreview {
  cost: Gold;
  block: OrderBlock | null;
}

/** A base on a tile of `target` (the region it lies in), once a tile is picked. */
export function previewBase(
  spec: InsurgencySpec,
  view: InsurgencyView,
  target: InsurgencyRegionView | undefined,
): SimplePreview {
  const cost = spec.baseCost;
  let block: OrderBlock | null = null;
  if (!isRunning(view)) block = "ended";
  else if (target === undefined) block = "no_region";
  else if (target.status !== InsurgencyRegionStatus.Occupied) {
    block = "not_occupied";
  } else if (target.band < 1) block = "unrest";
  else if (target.hasBase) block = "busy";
  else if (view.bases.length >= spec.maxBases) block = "limit";
  else if (view.funds < cost) block = "funds";
  return { cost, block };
}

export function previewUprising(
  spec: InsurgencySpec,
  view: InsurgencyView,
  target: InsurgencyRegionView | undefined,
  troops: number,
  now: Tick,
  hasLand: boolean,
): SimplePreview {
  const cost = spec.uprisingCost;
  let block: OrderBlock | null = null;
  if (!isRunning(view)) block = "ended";
  else if (target === undefined) block = "no_region";
  else if (target.status !== InsurgencyRegionStatus.Occupied) {
    block = "not_occupied";
  } else if (target.band < 2) block = "unrest";
  else if (now < target.cooldownUntil) block = "cooldown";
  else if (target.hasOperation) block = "busy";
  else if (view.operations.length >= spec.maxOperations) block = "limit";
  else if (!hasLocation(view, hasLand)) block = "no_location";
  else if (!Number.isInteger(troops) || troops < spec.uprisingMinTroops) {
    block = "troops";
  } else if (troops > view.available) block = "reserve";
  else if (view.funds < cost) block = "funds";
  return { cost, block };
}

export function previewIntel(
  spec: InsurgencySpec,
  view: InsurgencyView,
  target: InsurgencyRegionView | undefined,
  now: Tick,
): SimplePreview {
  const cost = spec.intelCost;
  let block: OrderBlock | null = null;
  if (!isRunning(view)) block = "ended";
  else if (target === undefined) block = "no_region";
  else if (target.status !== InsurgencyRegionStatus.Occupied) {
    block = "not_occupied";
  } else if (now < view.intelReadyTick) block = "cooldown";
  else if (view.funds < cost) block = "funds";
  return { cost, block };
}

export type OrderName = "recruit" | "base" | "uprising" | "intel";

/**
 * Why an order cannot be offered at all right now (null: some region or amount
 * would do). The first thing in the way, in the order a player would fix them.
 */
export function whyUnavailable(
  spec: InsurgencySpec,
  view: InsurgencyView,
  order: OrderName,
  now: Tick,
  hasLand: boolean,
): OrderBlock | null {
  if (!isRunning(view)) return "ended";
  const occupied = view.regions.filter(
    (r) => r.status === InsurgencyRegionStatus.Occupied,
  );
  switch (order) {
    case "recruit": {
      const bounds = recruitBounds(spec, view);
      if (view.pending.length >= spec.maxPendingRecruits) return "limit";
      if (!hasLocation(view, hasLand)) return "no_location";
      if (capacityLeft(view) < bounds.min) return "capacity";
      if (bounds.max < bounds.min) return "funds";
      return null;
    }
    case "base":
      if (view.bases.length >= spec.maxBases) return "limit";
      if (view.funds < spec.baseCost) return "funds";
      if (occupied.length === 0) return "not_occupied";
      if (!occupied.some((r) => r.band >= 1)) return "unrest";
      if (occupied.every((r) => r.band < 1 || r.hasBase)) return "busy";
      return null;
    case "uprising":
      if (view.operations.length >= spec.maxOperations) return "limit";
      if (view.funds < spec.uprisingCost) return "funds";
      if (occupied.length === 0) return "not_occupied";
      if (!hasLocation(view, hasLand)) return "no_location";
      if (view.available < spec.uprisingMinTroops) return "reserve";
      if (!occupied.some((r) => r.band >= 2)) return "unrest";
      if (occupied.every((r) => r.band < 2 || r.hasOperation)) return "busy";
      if (
        occupied.every(
          (r) => r.band < 2 || r.hasOperation || now < r.cooldownUntil,
        )
      ) {
        return "cooldown";
      }
      return null;
    case "intel":
      if (occupied.length === 0) return "not_occupied";
      if (now < view.intelReadyTick) return "cooldown";
      if (view.funds < spec.intelCost) return "funds";
      return null;
  }
}

/** Which orders are worth offering at all right now, for the buttons' enabled state. */
export function availableOrders(
  spec: InsurgencySpec,
  view: InsurgencyView,
  now: Tick,
  hasLand: boolean,
): Record<OrderName, boolean> {
  const ok = (order: OrderName) =>
    whyUnavailable(spec, view, order, now, hasLand) === null;
  return {
    recruit: ok("recruit"),
    base: ok("base"),
    uprising: ok("uprising"),
    intel: ok("intel"),
  };
}

/** The regions an order could be aimed at, for the region chooser. */
export function eligibleRegions(
  spec: InsurgencySpec,
  view: InsurgencyView,
  order: "uprising" | "intel",
  now: Tick,
): InsurgencyRegionView[] {
  return view.regions.filter((r) => {
    if (r.status !== InsurgencyRegionStatus.Occupied) return false;
    if (order === "intel") return true;
    return r.band >= 2 && !r.hasOperation && now >= r.cooldownUntil;
  });
}

/** The panel's order for regions: the ones in play first, the most restless first. */
export function sortRegions(
  regions: readonly InsurgencyRegionView[],
): InsurgencyRegionView[] {
  const rank = (r: InsurgencyRegionView) =>
    r.status === InsurgencyRegionStatus.Occupied
      ? 0
      : r.status === InsurgencyRegionStatus.Contested
        ? 1
        : 2;
  return [...regions].sort(
    (a, b) => rank(a) - rank(b) || b.band - a.band || a.id - b.id,
  );
}

// ----------------------------------------------------------------- the occupier

export interface OccupiedRegion {
  /** The resistance whose region this player holds. */
  resistance: InsurgencyView;
  region: InsurgencyRegionView;
  /** The occupier's own suppression of it, if one is running. */
  suppressionEndTick: Tick | null;
}

/** The regions of running resistances that `me` holds, restless first. */
export function occupiedBy(
  views: Iterable<InsurgencyView>,
  me: number,
): OccupiedRegion[] {
  const out: OccupiedRegion[] = [];
  for (const resistance of views) {
    if (!isRunning(resistance)) continue;
    for (const r of resistance.regions) {
      if (r.status !== InsurgencyRegionStatus.Occupied || r.occupier !== me) {
        continue;
      }
      const s = resistance.suppressions.find(
        (x) => x.region === r.id && x.occupier === me,
      );
      out.push({
        resistance,
        region: r,
        suppressionEndTick: s?.endTick ?? null,
      });
    }
  }
  return out.sort(
    (a, b) => b.region.band - a.region.band || a.region.id - b.region.id,
  );
}

export interface SuppressPreview {
  /** What the occupier's army pays now, in the engine's units. */
  troops: number;
  seconds: number;
  /** What comes home when it ends. */
  returned: number;
  block: "troops" | "limit" | "busy" | null;
}

/** `running`: suppressions this occupier already has going, across every resistance. */
export function previewSuppress(
  spec: InsurgencySpec,
  occupierTroops: number,
  running: number,
  alreadyHere: boolean,
): SuppressPreview {
  const troops = Math.max(
    spec.suppressMinTroops,
    Math.floor((occupierTroops * spec.suppressPercent) / 100),
  );
  let block: SuppressPreview["block"] = null;
  if (alreadyHere) block = "busy";
  else if (running >= spec.suppressMax) block = "limit";
  else if (occupierTroops < troops) block = "troops";
  return {
    troops,
    seconds: Math.round(spec.suppressTicks / TICKS_PER_SECOND),
    returned: Math.floor((troops * spec.suppressReturnPercent) / 100),
    block,
  };
}

/** How many suppressions `me` has going in all the resistances. */
export function suppressionsRunning(
  views: Iterable<InsurgencyView>,
  me: number,
): number {
  let n = 0;
  for (const v of views) {
    if (!isRunning(v)) continue;
    for (const s of v.suppressions) if (s.occupier === me) n++;
  }
  return n;
}
