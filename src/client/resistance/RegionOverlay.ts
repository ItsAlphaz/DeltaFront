import type { TileRef } from "@openfront/engine-api/game/GameMap";
import { Cell } from "@openfront/engine-api/game/GameTypes";
import { InsurgencyRegionStatus } from "@openfront/engine-api/game/GameUpdates";
import {
  regionBounds,
  regionGrid,
  regionLabel,
  type RegionGrid,
} from "@openfront/engine-lib/insurgency/InsurgencyRules";
import type { TransformHandler } from "../TransformHandler";
import type { GameView } from "../view";
import { RegionEffects, marches, type Seen, type Words } from "./RegionEffects";

/**
 * The resistance's regions drawn on the map (docs/Insurgency.md): each 32 x 32
 * square with its name, the colour of its unrest band, and a mark for a base or
 * an uprising. A full-screen canvas that takes no pointer events, positioned
 * with the same transform as the map, so it never gets between the player and
 * the front.
 *
 * It draws what the engine reports and nothing else; colour is never the only
 * channel (the name and the band's word are on the squares and in the panel).
 */

export interface OverlayRegion {
  id: number;
  status: InsurgencyRegionStatus;
  band: number;
  /** The region is the player's own national land (else it is one they occupy). */
  mine: boolean;
  hasBase: boolean;
  hasOperation: boolean;
  suppressed: boolean;
  /** The band in words, and a line from a report (precise unrest, garrison). */
  bandText: string;
  note: string;
  /** Engine-unit troops: what suppressing it costs the occupier, what an uprising there sent. */
  suppressTroops: number;
  operationTroops: number;
}

export interface OverlayModel {
  regions: OverlayRegion[];
  selected: number | null;
  bases: TileRef[];
  /** A tile is being chosen: show every region a little stronger. */
  picking: boolean;
}

export interface ScreenRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A region's square on screen, from where the map's corners are. */
export function regionRect(
  grid: RegionGrid,
  region: number,
  toScreen: (cell: Cell) => { x: number; y: number },
): ScreenRect {
  const b = regionBounds(grid, region);
  const a = toScreen(new Cell(b.x0, b.y0));
  const z = toScreen(new Cell(b.x1 + 1, b.y1 + 1));
  return { x: a.x, y: a.y, w: z.x - a.x, h: z.y - a.y };
}

export function intersects(r: ScreenRect, w: number, h: number): boolean {
  return r.x < w && r.y < h && r.x + r.w > 0 && r.y + r.h > 0;
}

const BAND_COLORS = ["#8b95a5", "#eab308", "#f97316", "#ef4444", "#ff2d55"];
const HELD_COLOR = "#22c55e";
const CONTESTED_COLOR = "#9ca3af";

function colorOf(r: OverlayRegion): string {
  if (r.status === InsurgencyRegionStatus.Held) return HELD_COLOR;
  if (r.status === InsurgencyRegionStatus.Contested) return CONTESTED_COLOR;
  return BAND_COLORS[Math.max(0, Math.min(BAND_COLORS.length - 1, r.band))];
}

export class RegionOverlay {
  private readonly canvas = document.createElement("canvas");
  private ctx: CanvasRenderingContext2D | null = null;
  private grid: RegionGrid;
  private raf = 0;
  private dirty = false;
  private width = 0;
  private height = 0;
  private reduced = false;
  private readonly effects: RegionEffects;

  constructor(
    private readonly game: GameView,
    private readonly transform: TransformHandler,
    /** What to draw now, or null for nothing. Read every frame. */
    private readonly model: () => OverlayModel | null,
    words: Words,
  ) {
    this.effects = new RegionEffects(words);
    this.grid = regionGrid(
      game.width(),
      game.height(),
      game.config().insurgencySpec().regionShift,
    );
    const s = this.canvas.style;
    s.position = "fixed";
    s.inset = "0";
    // A canvas is a replaced element: `inset` alone leaves it at its intrinsic
    // size, which is in device pixels (2.5 times too large on a dense screen).
    s.width = "100%";
    s.height = "100%";
    s.pointerEvents = "none";
    s.zIndex = "35";
  }

  label(region: number): string {
    return regionLabel(this.grid, region);
  }

  start(): void {
    if (this.raf !== 0) return;
    this.reduced =
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    document.body.appendChild(this.canvas);
    this.ctx = this.canvas.getContext("2d") ?? null;
    window.addEventListener("resize", this.onResize);
    this.onResize();
    this.raf = requestAnimationFrame(this.frame);
  }

  stop(): void {
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    window.removeEventListener("resize", this.onResize);
    this.canvas.remove();
  }

  private readonly onResize = () => {
    const dpr = window.devicePixelRatio || 1;
    this.width = window.innerWidth;
    this.height = window.innerHeight;
    this.canvas.width = Math.round(this.width * dpr);
    this.canvas.height = Math.round(this.height * dpr);
    this.ctx?.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.dirty = true;
  };

  private readonly frame = (t: number) => {
    this.raf = requestAnimationFrame(this.frame);
    const ctx = this.ctx;
    if (ctx === null) return;
    const m = this.model();
    if (m === null || m.regions.length === 0) {
      // Clear once, then do no work until there is something to draw again.
      if (this.dirty) {
        ctx.clearRect(0, 0, this.width, this.height);
        this.dirty = false;
      }
      return;
    }
    this.dirty = true;
    this.effects.observe(
      m.regions.map(
        (r): Seen => ({
          id: r.id,
          status: r.status,
          band: r.band,
          hasBase: r.hasBase,
          hasOperation: r.hasOperation,
          suppressed: r.suppressed,
          suppressTroops: r.suppressTroops,
          operationTroops: r.operationTroops,
          note: r.note,
        }),
      ),
      t,
      this.game.isCatchingUp(),
    );
    this.draw(ctx, m, t);
  };

  private draw(ctx: CanvasRenderingContext2D, m: OverlayModel, t: number) {
    ctx.clearRect(0, 0, this.width, this.height);
    const toScreen = (c: Cell) => this.transform.worldToScreenCoordinates(c);
    const pulse = this.reduced ? 0.5 : 0.5 + 0.5 * Math.sin(t / 360);
    for (const r of m.regions) {
      const rect = regionRect(this.grid, r.id, toScreen);
      if (!intersects(rect, this.width, this.height)) continue;
      const color = colorOf(r);
      const selected = r.id === m.selected;
      const urgent =
        r.band >= 4 && r.status === InsurgencyRegionStatus.Occupied;
      const strong = r.status === InsurgencyRegionStatus.Occupied || m.picking;
      const shake = this.effects.shake(r.id, t, this.reduced);
      ctx.save();
      ctx.translate(shake.dx, shake.dy);

      ctx.globalAlpha = (strong ? 0.2 : 0.07) + (urgent ? 0.12 * pulse : 0);
      ctx.fillStyle = color;
      ctx.fillRect(rect.x, rect.y, rect.w, rect.h);

      ctx.globalAlpha = selected ? 1 : strong ? 0.75 : 0.35;
      ctx.lineWidth = selected ? 3 : 1.5;
      ctx.strokeStyle = selected ? "#ffffff" : color;
      ctx.strokeRect(rect.x + 1, rect.y + 1, rect.w - 2, rect.h - 2);

      // A dotted border that goes round and round for each thing happening here.
      marches(r).forEach((march, i) => {
        const inset = 3 + i * 5;
        if (rect.w < inset * 2 + 8 || rect.h < inset * 2 + 8) return;
        ctx.globalAlpha = 0.95;
        ctx.lineWidth = 2.5;
        ctx.strokeStyle = march.color;
        ctx.setLineDash(march.dash);
        ctx.lineDashOffset = this.reduced ? 0 : -(t / 1000) * march.speed;
        ctx.strokeRect(
          rect.x + inset,
          rect.y + inset,
          rect.w - inset * 2,
          rect.h - inset * 2,
        );
      });
      ctx.setLineDash([]);
      ctx.lineDashOffset = 0;

      ctx.globalAlpha = 1;
      this.drawLabel(ctx, r, rect, color);
      this.drawIcons(ctx, r, rect, t);
      ctx.restore();
    }
    this.drawEffects(ctx, toScreen, t);
    for (const tile of m.bases) {
      const x = this.game.x(tile);
      const y = this.game.y(tile);
      const p = toScreen(new Cell(x + 0.5, y + 0.5));
      this.drawBase(ctx, p.x, p.y);
    }
    ctx.globalAlpha = 1;
  }

  /** The things going on in a square, as small symbols in its corner. */
  private drawIcons(
    ctx: CanvasRenderingContext2D,
    r: OverlayRegion,
    rect: ScreenRect,
    t: number,
  ) {
    const icons = [
      r.suppressed ? "🛡" : "",
      r.hasOperation ? "⚔" : "",
      r.hasBase ? "🏰" : "",
    ].filter((x) => x !== "");
    if (icons.length === 0 || rect.w < 60) return;
    const size = Math.max(14, Math.min(24, rect.w / 9));
    ctx.font = `${size}px sans-serif`;
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    ctx.globalAlpha = 1;
    icons.forEach((icon, i) => {
      const bob = this.reduced ? 0 : Math.sin(t / 260 + i) * 1.5;
      ctx.fillText(icon, rect.x + 8 + i * (size + 4), rect.y + 8 + bob);
    });
  }

  /** Shake, flash, sparks and the floating words of what has just happened. */
  private drawEffects(
    ctx: CanvasRenderingContext2D,
    toScreen: (c: Cell) => { x: number; y: number },
    t: number,
  ) {
    for (const e of this.effects.active(t)) {
      const rect = regionRect(this.grid, e.region, toScreen);
      if (!intersects(rect, this.width, this.height)) continue;
      const age = t - e.start;
      const life = age / e.lifeMs;
      const cx = rect.x + rect.w / 2;
      const cy = rect.y + rect.h / 2;
      // A flash over the square.
      const flash = this.effects.flash(e, t);
      if (flash > 0) {
        ctx.globalAlpha = 0.45 * flash;
        ctx.fillStyle = e.color;
        ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
      }
      // Sparks thrown out from the middle.
      if (!this.reduced && e.sparks > 0) {
        const reach =
          Math.min(rect.w, rect.h) *
          0.55 *
          (1 - Math.pow(1 - Math.min(1, life * 1.6), 3));
        ctx.fillStyle = e.color;
        for (let i = 0; i < e.sparks; i++) {
          const angle = i * 2.399963 + e.region;
          const dist = reach * (0.45 + ((i * 37) % 10) / 18);
          ctx.globalAlpha = Math.max(0, 1 - life * 1.5);
          const s = 2 + ((i * 13) % 3);
          ctx.fillRect(
            cx + Math.cos(angle) * dist - s / 2,
            cy + Math.sin(angle) * dist - s / 2,
            s,
            s,
          );
        }
      }
      // The words rise and fade; they shake while the square does.
      // They start in the upper part, clear of the square's own name, and float out over its top edge.
      const rise = this.reduced ? 0 : Math.min(1, life * 1.6) * rect.h * 0.45;
      const baseY = rect.y + rect.h * 0.3;
      const jx = !this.reduced && age < e.shakeMs ? Math.sin(t / 19) * 3 : 0;
      const size = e.big
        ? Math.max(18, Math.min(34, rect.w / 5))
        : Math.max(13, Math.min(20, rect.w / 8));
      ctx.globalAlpha = Math.max(0, 1 - Math.pow(life, 2.5));
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.lineJoin = "round";
      ctx.font = `800 ${size}px "Pixelify Sans", Inter, sans-serif`;
      ctx.lineWidth = 5;
      ctx.strokeStyle = "rgba(0,0,0,0.9)";
      ctx.fillStyle = e.color;
      ctx.strokeText(e.text, cx + jx, baseY - rise);
      ctx.fillText(e.text, cx + jx, baseY - rise);
      if (e.sub !== "") {
        ctx.font = `700 ${Math.round(size * 0.55)}px Inter, sans-serif`;
        ctx.fillStyle = "#ffffff";
        ctx.lineWidth = 4;
        ctx.strokeText(e.sub, cx + jx, baseY - rise + size * 0.85);
        ctx.fillText(e.sub, cx + jx, baseY - rise + size * 0.85);
      }
    }
    ctx.globalAlpha = 1;
  }

  private drawLabel(
    ctx: CanvasRenderingContext2D,
    r: OverlayRegion,
    rect: ScreenRect,
    color: string,
  ) {
    if (rect.w < 30 || rect.h < 22) return;
    const cx = rect.x + rect.w / 2;
    let y = rect.y + rect.h / 2;
    const size = Math.max(11, Math.min(18, rect.w / 7));
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.lineJoin = "round";
    ctx.lineWidth = 3;
    ctx.strokeStyle = "rgba(0,0,0,0.85)";
    ctx.fillStyle = "#ffffff";
    ctx.font = `700 ${size}px "Pixelify Sans", Inter, sans-serif`;
    const lines: string[] = [this.label(r.id)];
    if (rect.h >= 54 && r.status === InsurgencyRegionStatus.Occupied) {
      lines.push(r.bandText);
    }
    if (rect.h >= 84 && r.note !== "") lines.push(r.note);
    if (r.hasOperation && rect.h >= 40) lines.push("⚔");
    y -= ((lines.length - 1) * size * 1.15) / 2;
    lines.forEach((line, i) => {
      const ly = y + i * size * 1.15;
      if (i === 1) ctx.fillStyle = color;
      else if (i > 1) ctx.fillStyle = "#e5e7eb";
      ctx.strokeText(line, cx, ly);
      ctx.fillText(line, cx, ly);
    });
  }

  private drawBase(ctx: CanvasRenderingContext2D, x: number, y: number) {
    const r = 9;
    ctx.globalAlpha = 1;
    ctx.lineWidth = 3;
    ctx.strokeStyle = "rgba(0,0,0,0.85)";
    ctx.strokeRect(x - r, y - r, r * 2, r * 2);
    ctx.lineWidth = 2;
    ctx.strokeStyle = "#ffffff";
    ctx.strokeRect(x - r, y - r, r * 2, r * 2);
    ctx.beginPath();
    ctx.moveTo(x - r - 4, y);
    ctx.lineTo(x + r + 4, y);
    ctx.moveTo(x, y - r - 4);
    ctx.lineTo(x, y + r + 4);
    ctx.stroke();
  }
}
