import { InsurgencyRegionStatus } from "@openfront/engine-api/game/GameUpdates";

/**
 * What happens ON THE MAP when the resistance does something: a shake, a flash,
 * sparks and a floating "-4.57K" with a symbol, over the very square it happened
 * in, so that pressing Suppress or Set up a hideout feels like doing something
 * and not like changing a number in a panel (docs/Insurgency.md).
 *
 * It is pure state, no canvas: it watches what the engine reports about each area
 * from frame to frame and says what is going on, so it is tested without a
 * browser. RegionOverlay draws it. It decides nothing about the game, and it only
 * reacts to a change it SEES (never to the first look at an area, nor while the
 * game is catching up), so a reload replays nothing.
 */

export type EffectKind =
  | "suppress"
  | "suppress_end"
  | "base"
  | "base_lost"
  | "uprising"
  | "uprising_end"
  | "won"
  | "angrier"
  | "report";

/** What the overlay tells it about an area each frame. */
export interface Seen {
  id: number;
  status: InsurgencyRegionStatus;
  band: number;
  hasBase: boolean;
  hasOperation: boolean;
  suppressed: boolean;
  /** Engine-unit troops: what a suppression costs, what an uprising sent. */
  suppressTroops: number;
  operationTroops: number;
  /** The area has a report (its text), for "a report came in". */
  note: string;
}

export interface Effect {
  kind: EffectKind;
  region: number;
  start: number;
  /** The words, already translated (a symbol, then the amount or the news). */
  text: string;
  /** A smaller line under it. */
  sub: string;
  color: string;
  /** How long the square shakes and how long everything lasts, in ms. */
  shakeMs: number;
  lifeMs: number;
  flash: boolean;
  /** Sparks thrown out from the middle. */
  sparks: number;
  /** Bigger for the moments that matter. */
  big: boolean;
}

export interface Words {
  /** "4.57K" style: an amount of troops (engine units), as shown. */
  troops(n: number): string;
  band(band: number): string;
  fx(
    key: "base" | "base_lost" | "suppress" | "uprising" | "won" | "report",
  ): string;
}

const BLUE = "#4aa3ff";
const GOLD = "#ffc233";
const RED = "#ff4d3d";
const GREEN = "#3fe08a";
const CYAN = "#5eead4";
const GREY = "#c9ced6";

export const LIFE_MS = 2_600;
export const SHAKE_MS = 900;

interface Snap {
  suppressTroops: number;
  hasBase: boolean;
  hasOperation: boolean;
  suppressed: boolean;
  band: number;
  status: InsurgencyRegionStatus;
  note: string;
}

export class RegionEffects {
  private prev = new Map<number, Snap>();
  private effects: Effect[] = [];

  constructor(private readonly words: Words) {}

  /**
   * Looks at the areas as they are now. `quiet`: do not react (the game is
   * catching up); the picture is still taken, so nothing replays later.
   */
  observe(areas: readonly Seen[], now: number, quiet: boolean): void {
    for (const a of areas) {
      const before = this.prev.get(a.id);
      this.prev.set(a.id, {
        suppressTroops: a.suppressTroops,
        hasBase: a.hasBase,
        hasOperation: a.hasOperation,
        suppressed: a.suppressed,
        band: a.band,
        status: a.status,
        note: a.note,
      });
      if (before === undefined || quiet) continue;
      const w = this.words;
      const add = (e: Omit<Effect, "region" | "start" | "lifeMs">) =>
        this.effects.push({ ...e, region: a.id, start: now, lifeMs: LIFE_MS });
      if (!before.suppressed && a.suppressed) {
        add({
          kind: "suppress",
          // The cost as it was before the army paid it.
          text: `🛡 -${w.troops(Math.max(before.suppressTroops, a.suppressTroops))}`,
          sub: w.fx("suppress"),
          color: BLUE,
          shakeMs: SHAKE_MS,
          flash: true,
          sparks: 14,
          big: true,
        });
      } else if (before.suppressed && !a.suppressed) {
        add({
          kind: "suppress_end",
          text: "🛡",
          sub: "",
          color: GREY,
          shakeMs: 0,
          flash: false,
          sparks: 0,
          big: false,
        });
      }
      if (!before.hasBase && a.hasBase) {
        add({
          kind: "base",
          text: "🏰",
          sub: w.fx("base"),
          color: GOLD,
          shakeMs: SHAKE_MS,
          flash: true,
          sparks: 18,
          big: true,
        });
      } else if (before.hasBase && !a.hasBase) {
        add({
          kind: "base_lost",
          text: "💥",
          sub: w.fx("base_lost"),
          color: RED,
          shakeMs: SHAKE_MS,
          flash: true,
          sparks: 10,
          big: false,
        });
      }
      if (!before.hasOperation && a.hasOperation) {
        add({
          kind: "uprising",
          text: `⚔ -${w.troops(a.operationTroops)}`,
          sub: w.fx("uprising"),
          color: RED,
          shakeMs: SHAKE_MS,
          flash: true,
          sparks: 20,
          big: true,
        });
      } else if (before.hasOperation && !a.hasOperation) {
        add({
          kind: "uprising_end",
          text: "⚔",
          sub: "",
          color: GREY,
          shakeMs: 0,
          flash: false,
          sparks: 0,
          big: false,
        });
      }
      if (
        before.status === InsurgencyRegionStatus.Occupied &&
        a.status === InsurgencyRegionStatus.Held
      ) {
        add({
          kind: "won",
          text: "🎉",
          sub: w.fx("won"),
          color: GREEN,
          shakeMs: SHAKE_MS,
          flash: true,
          sparks: 30,
          big: true,
        });
      } else if (
        a.band > before.band &&
        a.status === InsurgencyRegionStatus.Occupied
      ) {
        add({
          kind: "angrier",
          text: "🔥",
          sub: w.band(a.band),
          color: a.band >= 3 ? RED : GOLD,
          shakeMs: 0,
          flash: false,
          sparks: 6,
          big: false,
        });
      }
      if (before.note === "" && a.note !== "") {
        add({
          kind: "report",
          text: "🔍",
          sub: w.fx("report"),
          color: CYAN,
          shakeMs: 0,
          flash: false,
          sparks: 8,
          big: false,
        });
      }
    }
  }

  /** The effects still going at `now` (the finished ones are dropped). */
  active(now: number): readonly Effect[] {
    this.effects = this.effects.filter((e) => now - e.start < e.lifeMs);
    return this.effects;
  }

  /**
   * How far a square is shaken now, in pixels: a fast wobble that dies away over
   * the longest shake going in it. Nothing in reduced motion.
   */
  shake(
    region: number,
    now: number,
    reduced: boolean,
  ): { dx: number; dy: number } {
    if (reduced) return { dx: 0, dy: 0 };
    let amp = 0;
    for (const e of this.effects) {
      if (e.region !== region || e.shakeMs <= 0) continue;
      const age = now - e.start;
      if (age < 0 || age >= e.shakeMs) continue;
      amp = Math.max(amp, 7 * (1 - age / e.shakeMs));
    }
    if (amp === 0) return { dx: 0, dy: 0 };
    return { dx: Math.sin(now / 23) * amp, dy: Math.cos(now / 17) * amp * 0.7 };
  }

  /** The flash of an effect, 1 at the start fading to 0 (0 when it has none). */
  flash(e: Effect, now: number): number {
    if (!e.flash) return 0;
    const age = now - e.start;
    return age < 0 || age > 600 ? 0 : 1 - age / 600;
  }
}

/** How a marching border moves: pixels a second, and its dash, by what the area has going. */
export interface March {
  color: string;
  speed: number;
  dash: [number, number];
}

/**
 * The dotted border that revolves around a square: one per thing going on in it
 * (an uprising fastest, a suppression, a hideout slowly). Several can stack, drawn
 * one inside the other.
 */
export function marches(a: {
  hasOperation: boolean;
  suppressed: boolean;
  hasBase: boolean;
}): March[] {
  const out: March[] = [];
  if (a.hasOperation) out.push({ color: RED, speed: 90, dash: [10, 6] });
  if (a.suppressed) out.push({ color: BLUE, speed: -55, dash: [8, 5] });
  if (a.hasBase) out.push({ color: GOLD, speed: 32, dash: [4, 6] });
  return out;
}
