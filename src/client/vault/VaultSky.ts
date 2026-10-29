import { html, LitElement } from "lit";
import { customElement, property } from "lit/decorators.js";
import { motionAllowed } from "./VaultFx";
import { BAYER4, pack, TAU } from "./VaultPixel";

/** CSS pixels per pixel of the sky. */
const PIXEL = 4;
/** Shades of each colour channel: few, so the gradients are steps with a dither between them. */
const LEVELS = 11;
const FRAME_MS = 83;

const BASE = [10, 9, 20] as const;
const AMBER = [245, 158, 11] as const;
const VIOLET = [124, 58, 237] as const;
const RED = [229, 56, 59] as const;
const CREAM = [255, 214, 102] as const;

interface Star {
  x: number;
  y: number;
  phase: number;
  speed: number;
}

/** A tiny repeatable pseudo-random run, so the stars are where they were. */
function stars(count: number): Star[] {
  let seed = 7;
  const next = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 0xffffffff;
  };
  return Array.from({ length: count }, () => ({
    x: next(),
    y: next(),
    phase: next(),
    speed: 0.25 + next() * 0.4,
  }));
}

/**
 * The sky behind the Vault's hero: drifting amber, violet and red glows, a
 * sunburst of rays turning behind the wheel, a few stars that twinkle, and a
 * glow where the pointer is, all worked out pixel by pixel on a coarse grid
 * (four screen pixels to one) and quantized to a few shades with an ordered
 * dither, so it is made of the steps of pixel art and not of smooth gradients.
 * It redraws about twelve times a second, and once for reduced motion.
 */
@customElement("vault-sky")
export class VaultSky extends LitElement {
  /** The wheel is turning: the rays and the glow behind it brighten. */
  @property({ type: Boolean }) spinning = false;
  /** Where the rays turn, as shares of the sky's width and height (and of its shorter side, for the radius); by default behind the wheel of the hero it is in. */
  @property({ attribute: false }) rayCenter: {
    x: number;
    y: number;
    r: number;
  } | null = null;

  private grid = { w: 0, h: 0 };
  private image: ImageData | null = null;
  private buffer: Uint32Array | null = null;
  private frame: number | null = null;
  private last = 0;
  private visible = true;
  private seen: IntersectionObserver | null = null;
  private resizer: ResizeObserver | null = null;
  private pointer: { x: number; y: number } | null = null;
  private readonly stars = stars(46);
  private energy = 0;

  createRenderRoot() {
    return this;
  }

  connectedCallback() {
    super.connectedCallback();
    if (typeof IntersectionObserver !== "undefined") {
      this.seen = new IntersectionObserver((entries) => {
        this.visible = entries.some((e) => e.isIntersecting);
      });
      this.seen.observe(this);
    }
    if (typeof ResizeObserver !== "undefined") {
      this.resizer = new ResizeObserver(() => {
        this.resize();
        // a still sky is redrawn at its new size
        if (!motionAllowed()) this.paint(performance.now(), true);
      });
      this.resizer.observe(this);
    }
    this.frame = requestAnimationFrame(this.loop);
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.seen?.disconnect();
    this.resizer?.disconnect();
    this.seen = null;
    this.resizer = null;
    if (this.frame !== null) cancelAnimationFrame(this.frame);
    this.frame = null;
  }

  render() {
    return html`<canvas class="vault-sky-canvas" aria-hidden="true"></canvas>`;
  }

  /** The pointer is at (x, y) of this element, in CSS pixels; null once it leaves. */
  setPointer(point: { x: number; y: number } | null): void {
    this.pointer = point;
  }

  private resize(): void {
    const canvas = this.querySelector<HTMLCanvasElement>("canvas");
    const w = Math.ceil(this.clientWidth / PIXEL);
    const h = Math.ceil(this.clientHeight / PIXEL);
    if (canvas === null || w === 0 || h === 0) return;
    if (this.grid.w === w && this.grid.h === h && this.image !== null) return;
    this.grid = { w, h };
    canvas.width = w;
    canvas.height = h;
    this.image = new ImageData(w, h);
    this.buffer = new Uint32Array(this.image.data.buffer);
  }

  private loop = (now: number): void => {
    this.frame = requestAnimationFrame(this.loop);
    if (!this.visible || !motionAllowed()) {
      // still: drawn when there is nothing yet
      if (this.buffer === null || this.last === 0) this.paint(now, true);
      return;
    }
    if (now - this.last < FRAME_MS) return;
    this.paint(now, false);
  };

  private paint(now: number, still: boolean): void {
    this.resize();
    const canvas = this.querySelector<HTMLCanvasElement>("canvas");
    const ctx = canvas?.getContext?.("2d");
    if (!canvas || !ctx || this.image === null || this.buffer === null) return;
    this.last = now;
    const { w, h } = this.grid;
    const buffer = this.buffer;
    const t = still ? 0 : now / 1000;
    // the rays and glow ease up while the wheel turns
    this.energy += ((this.spinning ? 1 : 0) - this.energy) * 0.2;
    const boost = 1 + this.energy * 1.1;

    // where the wheel is, so the rays turn behind it
    const host = this.closest(".vault-hero");
    const wheel = host?.querySelector<HTMLElement>("vault-wheel canvas");
    const mine = this.getBoundingClientRect();
    let cx = w * 0.3;
    let cy = h * 0.5;
    let radius = Math.min(w, h) * 0.4;
    if (this.rayCenter !== null) {
      cx = this.rayCenter.x * w;
      cy = this.rayCenter.y * h;
      radius = this.rayCenter.r * Math.min(w, h);
    } else if (wheel) {
      const r = wheel.getBoundingClientRect();
      if (r.width > 0) {
        cx = (r.left + r.width / 2 - mine.left) / PIXEL;
        cy = (r.top + r.height / 2 - mine.top) / PIXEL;
        radius = r.width / 2 / PIXEL;
      }
    }

    // the glows: where they are this moment
    const a = {
      x: (0.16 + 0.05 * Math.sin(t * 0.21)) * w,
      y: (0.1 + 0.06 * Math.cos(t * 0.17)) * w,
      r: w * 0.5,
    };
    const b = {
      x: (0.9 + 0.04 * Math.cos(t * 0.19)) * w,
      y: (0.3 + 0.07 * Math.sin(t * 0.15)) * w,
      r: w * 0.46,
    };
    const c = {
      x: (0.55 + 0.06 * Math.sin(t * 0.13)) * w,
      y: h + w * 0.05,
      r: w * 0.42,
    };
    const spot = this.pointer
      ? { x: this.pointer.x / PIXEL, y: this.pointer.y / PIXEL, r: w * 0.16 }
      : null;
    const rays = 14;
    const turn = t * 0.04;

    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const fa = field(x - a.x, y - a.y, a.r);
        const fb = field(x - b.x, y - b.y, b.r);
        const fc = field(x - c.x, y - c.y, c.r);
        let r =
          BASE[0] +
          AMBER[0] * fa * 0.32 +
          VIOLET[0] * fb * 0.4 +
          RED[0] * fc * 0.26;
        let g =
          BASE[1] +
          AMBER[1] * fa * 0.32 +
          VIOLET[1] * fb * 0.4 +
          RED[1] * fc * 0.26;
        let bl =
          BASE[2] +
          AMBER[2] * fa * 0.32 +
          VIOLET[2] * fb * 0.4 +
          RED[2] * fc * 0.26;

        // a halo and a sunburst round the wheel
        const dx = x - cx;
        const dy = y - cy;
        const dist = Math.hypot(dx, dy);
        const halo = field(dx, dy, radius * 1.3) * 0.2 * boost;
        r += AMBER[0] * halo;
        g += AMBER[1] * halo;
        bl += AMBER[2] * halo;
        const near = dist / radius;
        if (near > 0.45 && near < 1.9) {
          const turns = (Math.atan2(dy, dx) / TAU) * rays + turn * rays;
          if (turns - Math.floor(turns) < 0.45) {
            const strength = (1 - Math.abs(near - 1.05) / 0.9) * 0.15 * boost;
            if (strength > 0) {
              r += CREAM[0] * strength;
              g += CREAM[1] * strength;
              bl += CREAM[2] * strength;
            }
          }
        }
        if (spot !== null) {
          const s = field(x - spot.x, y - spot.y, spot.r) * 0.2;
          r += AMBER[0] * s;
          g += AMBER[1] * s;
          bl += AMBER[2] * s;
        }

        // the right of the stage, where the words are, is kept darker
        const calm = 1 - 0.45 * Math.max(0, Math.min(1, (x / w - 0.45) / 0.35));
        r *= calm;
        g *= calm;
        bl *= calm;

        // to a few shades, with the dither choosing which side of a step each pixel falls
        const d = BAYER4[((y & 3) << 2) | (x & 3)] * 0.7;
        buffer[y * w + x] = pack(
          quantize(r, d),
          quantize(g, d),
          quantize(bl, d),
        );
      }
    }

    // stars: a dot, then a plus, then a dot, then out
    const bright = pack(255, 246, 208);
    const dim = pack(168, 160, 196);
    for (const star of this.stars) {
      const sx = Math.floor(star.x * w);
      const sy = Math.floor(star.y * h);
      const stage = Math.floor(
        ((((t * star.speed + star.phase) % 1) + 1) % 1) * 5,
      );
      const put = (px: number, py: number, word: number) => {
        if (px >= 0 && px < w && py >= 0 && py < h) buffer[py * w + px] = word;
      };
      if (stage === 1 || stage === 3) put(sx, sy, dim);
      else if (stage === 2) {
        put(sx, sy, bright);
        put(sx - 1, sy, dim);
        put(sx + 1, sy, dim);
        put(sx, sy - 1, dim);
        put(sx, sy + 1, dim);
      }
    }
    ctx.putImageData(this.image, 0, 0);
  }
}

/** 1 at the centre of a glow to 0 at its edge, falling off like a cone squared. */
function field(dx: number, dy: number, radius: number): number {
  const d = Math.hypot(dx, dy) / radius;
  if (d >= 1) return 0;
  const f = 1 - d;
  return f * f;
}

/** A channel (0 to 255, perhaps over) to one of `LEVELS` shades, the dither deciding the borderline ones. */
function quantize(value: number, dither: number): number {
  const v = Math.max(0, Math.min(255, value)) / 255;
  const level = Math.max(
    0,
    Math.min(LEVELS - 1, Math.floor(v * (LEVELS - 1) + 0.5 + dither)),
  );
  return Math.round((level / (LEVELS - 1)) * 255);
}
