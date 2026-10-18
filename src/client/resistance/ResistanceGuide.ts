import type { Tick } from "@openfront/engine-api/game/GameTypes";
import {
  InsurgencyRegionStatus,
  type InsurgencyRegionView,
  type InsurgencyView,
} from "@openfront/engine-api/game/GameUpdates";
import type { InsurgencySpec } from "@openfront/engine-lib/insurgency/InsurgencyRules";
import {
  eligibleRegions,
  isRunning,
  whyUnavailable,
  type OrderName,
} from "./ResistanceModel";

/**
 * What a player who has never seen this should do next, worked out from the
 * state the engine reports (docs/Insurgency.md): one plain suggestion at a
 * time, with the order it points at. Pure functions, no DOM.
 *
 * It only suggests. The panel's own buttons and the engine's own checks decide
 * what can be sent; a suggestion that is out of date costs nothing.
 */
export type StepId =
  | "uprising"
  | "recruit"
  | "base"
  | "intel"
  | "running"
  | "funds"
  | "wait"
  | "nothing";

export interface Step {
  id: StepId;
  /** The order the "show me" button opens (none when there is only waiting to do). */
  order?: OrderName;
  /** The area it is about. */
  regionId?: number;
}

/** The areas the enemy holds, the most restless first (then the most unrest). */
function restless(view: InsurgencyView): InsurgencyRegionView[] {
  return view.regions
    .filter((r) => r.status === InsurgencyRegionStatus.Occupied)
    .sort((a, b) => b.band - a.band);
}

export function nextStep(
  spec: InsurgencySpec,
  view: InsurgencyView,
  now: Tick,
  hasLand: boolean,
): Step {
  if (!isRunning(view)) return { id: "nothing" };
  const occupied = restless(view);
  if (occupied.length === 0) return { id: "nothing" };
  const can = (order: OrderName) =>
    whyUnavailable(spec, view, order, now, hasLand) === null;

  // An area is ready to rise and there are fighters to send: the point of it all.
  const ready = eligibleRegions(spec, view, "uprising", now).sort(
    (a, b) => b.band - a.band,
  );
  if (can("uprising") && ready.length > 0) {
    return { id: "uprising", order: "uprising", regionId: ready[0].id };
  }
  // Not enough fighters ready to start one: recruit.
  if (view.available < spec.uprisingMinTroops && can("recruit")) {
    return { id: "recruit", order: "recruit" };
  }
  // A hideout in a restless area makes it angrier and is where an uprising starts.
  const forBase = occupied.find((r) => r.band >= 1 && !r.hasBase);
  if (view.bases.length === 0 && can("base") && forBase !== undefined) {
    return { id: "base", order: "base", regionId: forBase.id };
  }
  if (view.operations.length > 0) return { id: "running" };
  // Nothing is ready: unrest rises by itself while the enemy's army is thin.
  if (can("intel")) {
    return { id: "intel", order: "intel", regionId: occupied[0].id };
  }
  const reason = whyUnavailable(spec, view, "recruit", now, hasLand);
  if (reason === "funds") return { id: "funds" };
  return { id: "wait" };
}
