import type { VaultView } from "@openfront/shared/VaultSchemas";
import { html, LitElement, type PropertyValues } from "lit";
import { customElement, property } from "lit/decorators.js";
import {
  motionAllowed,
  PACK_COLOR,
  playTick,
  RARITY_COLOR,
  VaultFx,
} from "./VaultFx";
import {
  bayerAt,
  darken,
  hexToRgb,
  lighten,
  mix,
  pack,
  packRgb,
  PIXEL_FONT,
  pixelFontReady,
  TAU,
  type Rgb,
} from "./VaultPixel";
import { spriteColor, spriteRows, type SpriteName } from "./VaultSprites";
import { tiltLeave, tiltMove, tiltRelease } from "./VaultTilt";

type Segment = VaultView["wheel"]["segments"][number];
type Prize = Segment["prize"];

const SPIN_MS = 5600;
const HALF_PI = Math.PI / 2;
const easeOutQuint = (t: number): number => 1 - Math.pow(1 - t, 5);
const mod = (a: number, n: number): number => ((a % n) + n) % n;

/** Texels of a decal per pixel of the wheel: the labels are drawn at twice the size and sampled down, so a thin stroke does not vanish as the wheel turns. */
const K = 2;

const OUTLINE: Rgb = [20, 15, 28];
const CREAM: Rgb = [255, 243, 176];
const GOLD_RAMP: readonly Rgb[] = [
  [109, 71, 9],
  [184, 128, 28],
  [224, 168, 42],
  [251, 233, 160],
];

/** The two ends of a segment's shading: Credits alternate two night blues, items take their rarity, a pack is pink, the jackpot gold. */
function segmentColors(segment: Segment, index: number): [Rgb, Rgb] {
  const prize = segment.prize;
  if (prize.kind === "item") {
    const color = hexToRgb(RARITY_COLOR[prize.rarity]);
    return [color, darken(color, 0.5)];
  }
  if (prize.kind === "pack") return [hexToRgb(PACK_COLOR), [122, 29, 77]];
  if (prize.amount >= 1000) {
    return [
      [255, 226, 102],
      [217, 119, 6],
    ];
  }
  return index % 2 === 0
    ? [
        [74, 79, 168],
        [28, 29, 68],
      ]
    : [
        [47, 106, 140],
        [18, 40, 62],
      ];
}

const isJackpot = (prize: Prize): boolean =>
  prize.kind === "credits" && prize.amount >= 1000;

const rgbHex = (c: Rgb): string =>
  `#${c.map((v) => v.toString(16).padStart(2, "0")).join("")}`;

/** The icon of what a segment gives, and the colour it is tinted. */
function iconOf(prize: Prize): { name: SpriteName; tint: Rgb } {
  if (prize.kind === "item") {
    return {
      name: "gem",
      tint: lighten(hexToRgb(RARITY_COLOR[prize.rarity]), 0.2),
    };
  }
  if (prize.kind === "pack")
    return { name: "pack", tint: hexToRgb(PACK_COLOR) };
  return { name: isJackpot(prize) ? "star" : "coin", tint: [255, 255, 255] };
}

/** What a decal's texel numbers stand for, besides 0 (nothing): 1 the label's outline, 2 the label, 3 and up the icon's colours. */
const SPRITE_INDEX: Record<string, number> = {
  K: 3,
  L: 4,
  P: 5,
  D: 6,
  W: 7,
  Y: 8,
  y: 9,
  R: 10,
  r: 11,
  B: 12,
};

/**
 * A segment's label and icon, drawn once as a small bitmap in the segment's
 * own frame (`u` out from the hub, `v` across), to be looked up as the wheel
 * turns.
 */
interface Decal {
  w: number;
  h: number;
  /** Half the height, in pixels of the wheel: where `v` is 0. */
  vh: number;
  data: Uint8Array;
  palette: Uint32Array;
}

/** What is the same until the wheel is a different size: where each pixel is, and the parts that never move. */
interface Geometry {
  size: number;
  center: number;
  rimOuter: number;
  face: number;
  /** The rim, its shadow and the dark channel; 0 where there is nothing or where the face goes. */
  base: Uint32Array;
  /** The hub's own pixels: 0 where it is not. */
  hubLayer: Uint32Array;
  faceIdx: Int32Array;
  faceDx: Float32Array;
  faceDy: Float32Array;
  faceR: Float32Array;
  facePhi: Float32Array;
  image: ImageData;
  buffer: Uint32Array;
}

/**
 * The wheel, drawn pixel by pixel on a small grid and shown at whole-number
 * size, so every edge is a staircase and every shade a dither. The segments
 * (each with the pixel icon and label of what it gives), the rim of chasing
 * bulbs, the pegs, the hub and the pointer are all worked out here, not drawn
 * by the browser. `spinTo(index)` turns it to the winning segment (chosen by
 * the server) over a few seconds of slowing down and resolves when it has
 * stopped; every peg it passes throws sparks off the pointer. The wheel leans
 * towards the cursor while it is still, and `highlight` lights segments up
 * and steps the others back.
 */
@customElement("vault-wheel")
export class VaultWheel extends LitElement {
  @property({ attribute: false }) segments: readonly Segment[] = [];
  /** Segment indexes to light up. */
  @property({ attribute: false }) highlight: readonly number[] = [];

  private rotation = 0;
  private flap = 0;
  private lit = -1;
  private litUntil = 0;
  /** How far the segments that are not highlighted have dimmed, 0 to 1. */
  private dim = 0;
  private spinning = false;
  private frame: number | null = null;
  private visible = true;
  private lastPaint = 0;
  private seen: IntersectionObserver | null = null;
  private fx: VaultFx | null = null;
  private geometry: Geometry | null = null;
  private decals: Decal[] = [];
  private decalsFor = "";
  private fontReady = false;

  createRenderRoot() {
    return this;
  }

  connectedCallback() {
    super.connectedCallback();
    // the sparks are a canvas laid over this element
    this.classList.add("relative", "block");
    this.addEventListener("pointermove", this.onPointerMove);
    this.addEventListener("pointerleave", this.onPointerLeave);
    if (typeof IntersectionObserver !== "undefined") {
      // a wheel scrolled out of sight is not drawn
      this.seen = new IntersectionObserver((entries) => {
        this.visible = entries.some((e) => e.isIntersecting);
      });
      this.seen.observe(this);
    }
    // labels are drawn in the pixel face: again once it is here
    void pixelFontReady().then(() => {
      this.fontReady = true;
    });
    this.frame = requestAnimationFrame(this.paint);
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.removeEventListener("pointermove", this.onPointerMove);
    this.removeEventListener("pointerleave", this.onPointerLeave);
    this.seen?.disconnect();
    this.seen = null;
    if (this.frame !== null) cancelAnimationFrame(this.frame);
    this.frame = null;
    this.fx?.dispose();
    this.fx = null;
  }

  protected willUpdate(changed: PropertyValues<this>) {
    if (changed.has("segments")) this.decalsFor = "";
  }

  render() {
    return html`<div class="vault-tilt" style="--tilt-hover-scale: 1">
      <canvas
        data-vault-wheel
        class="vault-wheel-canvas mx-auto block"
        aria-hidden="true"
      ></canvas>
    </div>`;
  }

  get isSpinning(): boolean {
    return this.spinning;
  }

  private onPointerMove = (event: PointerEvent) => {
    if (this.spinning) return;
    tiltMove(event, 5);
  };

  private onPointerLeave = (event: PointerEvent) => tiltLeave(event);

  private effects(): VaultFx {
    this.fx ??= new VaultFx(this);
    return this.fx;
  }

  /** Where the pointer's tip is, in this element's own pixels. */
  private tip(): { x: number; y: number; w: number; h: number } {
    const canvas = this.querySelector<HTMLCanvasElement>("canvas");
    const here = this.getBoundingClientRect();
    const rect = canvas?.getBoundingClientRect() ?? here;
    return {
      x: rect.left - here.left + rect.width / 2,
      y: rect.top - here.top + rect.height * 0.1,
      w: rect.width,
      h: rect.height,
    };
  }

  /** Turns to segment `index` and stops there; resolves once it has. */
  spinTo(index: number): Promise<void> {
    const n = this.segments.length;
    if (n === 0) return Promise.resolve();
    const slice = TAU / n;
    // land somewhere inside the segment, not always dead centre
    const inside = (Math.random() - 0.5) * slice * 0.7;
    const target = -((index + 0.5) * slice + inside);
    const turns = 5 + Math.floor(Math.random() * 2);
    const from = this.rotation;
    // the next angle at or below `from` that lands on the target, then the extra turns
    const base = from - mod(from - target, TAU) - turns * TAU;
    const landed = () => {
      this.lit = index;
      this.litUntil = performance.now() + 2600;
      this.celebrate(index);
    };
    if (!motionAllowed()) {
      this.rotation = target;
      landed();
      return Promise.resolve();
    }
    this.spinning = true;
    const lean = this.querySelector<HTMLElement>(".vault-tilt");
    if (lean !== null) tiltRelease(lean);
    return new Promise((resolve) => {
      const begin = performance.now();
      let lastPeg = Math.floor((-from / slice) * 1);
      const step = (now: number) => {
        const p = Math.min(1, (now - begin) / SPIN_MS);
        this.rotation = from + (base - from) * easeOutQuint(p);
        const peg = Math.floor(-this.rotation / slice);
        if (peg !== lastPeg) {
          lastPeg = peg;
          this.flap = 1;
          playTick(0.9 + (1 - p) * 0.5);
          this.sparks(1 - p);
        }
        if (p < 1) {
          requestAnimationFrame(step);
        } else {
          this.spinning = false;
          landed();
          resolve();
        }
      };
      requestAnimationFrame(step);
    });
  }

  /** A few sparks off the pointer's tip, more of them while the wheel is fast. */
  private sparks(speed: number): void {
    const tip = this.tip();
    this.effects().burst(tip.x, tip.y, ["#fff7c2", "#fbbf24", "#fb923c"], {
      count: speed > 0.35 ? 3 : 1,
      speed: 150 + speed * 160,
      gravity: 620,
      life: 0.5,
      shape: "dot",
    });
  }

  /** The wheel has stopped: a ring from the hub and a burst where the prize is. */
  private celebrate(index: number): void {
    const segment = this.segments[index];
    if (segment === undefined) return;
    const color = rgbHex(segmentColors(segment, index)[0]);
    const tip = this.tip();
    const fx = this.effects();
    fx.ring(tip.x, tip.y + tip.h * 0.4, color, tip.w * 0.55);
    fx.burst(tip.x, tip.y + tip.h * 0.08, [color, "#ffffff", "#fff7c2"], {
      count: 46,
      speed: 360,
      gravity: 380,
    });
  }

  // ---- what never moves ----------------------------------------------------------

  private scratchContext(
    width: number,
    height: number,
  ): CanvasRenderingContext2D | null {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    return canvas.getContext?.("2d", { willReadFrequently: true }) ?? null;
  }

  private build(size: number): Geometry {
    const c = size / 2;
    const rimOuter = size * 0.465;
    const rimInner = size * 0.42;
    const face = size * 0.4;
    const hub = size * 0.075;
    const count = size * size;
    const base = new Uint32Array(count);
    const hubLayer = new Uint32Array(count);
    const faceIdx: number[] = [];
    const faceDx: number[] = [];
    const faceDy: number[] = [];
    const faceR: number[] = [];
    const facePhi: number[] = [];
    // a hard shadow down and to the right, in the dark of the page
    const shadow = Math.max(2, Math.round(size * 0.012));
    const shadowWord = pack(8, 6, 14);
    const channel = pack(18, 14, 26);
    const ramp = GOLD_RAMP.map(packRgb);
    const outline = packRgb([26, 18, 8]);
    const cream = packRgb(CREAM);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const dx = x + 0.5 - c;
        const dy = y + 0.5 - c;
        const r = Math.hypot(dx, dy);
        const i = y * size + x;
        // light from the top left: on a ring, the side that faces it is bright
        const nx = r === 0 ? 0 : dx / r;
        const ny = r === 0 ? 0 : dy / r;
        const lum = nx * -0.62 + ny * -0.78;
        if (r > rimOuter) {
          if (Math.hypot(dx - shadow, dy - shadow) <= rimOuter) {
            base[i] = shadowWord;
          }
        } else if (r > rimOuter - 1.2) {
          base[i] = outline;
        } else if (r > rimInner) {
          // the gold rim: a lip bright on the outside and dark on the inside
          const q = (r - rimInner) / (rimOuter - rimInner);
          const bevel = q > 0.78 ? 0.3 : q < 0.2 ? -0.35 : 0;
          const level = Math.floor(
            ((lum * 0.5 + bevel + 1) / 2) * 4 + bayerAt(x, y),
          );
          base[i] = ramp[Math.max(0, Math.min(3, level))];
        } else if (r > face) {
          base[i] = channel;
        } else if (r > hub) {
          faceIdx.push(i);
          faceDx.push(dx);
          faceDy.push(dy);
          faceR.push(r);
          facePhi.push(Math.atan2(dy, dx));
        } else if (r > hub - 1.2) {
          // the hub: a gold disc with a lip and an inner ring
          hubLayer[i] = outline;
        } else if (r > hub * 0.8 && r < hub * 0.8 + 1) {
          hubLayer[i] = cream;
        } else {
          const level = Math.floor(((lum * 0.5 + 1) / 2) * 4 + bayerAt(x, y));
          hubLayer[i] = ramp[Math.max(0, Math.min(3, level))];
        }
      }
    }
    this.stampHubLabel(hubLayer, size, c, hub);
    const image = new ImageData(size, size);
    return {
      size,
      center: c,
      rimOuter,
      face,
      base,
      hubLayer,
      faceIdx: Int32Array.from(faceIdx),
      faceDx: Float32Array.from(faceDx),
      faceDy: Float32Array.from(faceDy),
      faceR: Float32Array.from(faceR),
      facePhi: Float32Array.from(facePhi),
      image,
      buffer: new Uint32Array(image.data.buffer),
    };
  }

  /** "VAULT" on the hub, from the pixel face. */
  private stampHubLabel(
    layer: Uint32Array,
    size: number,
    c: number,
    hub: number,
  ): void {
    const box = Math.ceil(hub * 2);
    const ctx = this.scratchContext(box, box);
    if (ctx === null) return;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.font = `700 ${Math.max(6, Math.round(hub * 0.5))}px ${PIXEL_FONT}`;
    ctx.fillStyle = "#000";
    ctx.fillText("VAULT", box / 2, box / 2 + 0.5);
    const data = ctx.getImageData(0, 0, box, box).data;
    const ink = packRgb([42, 28, 4]);
    const left = Math.round(c - box / 2);
    const top = Math.round(c - box / 2);
    for (let y = 0; y < box; y++) {
      for (let x = 0; x < box; x++) {
        if (data[(y * box + x) * 4 + 3] > 127) {
          layer[(top + y) * size + left + x] = ink;
        }
      }
    }
  }

  // ---- the labels ------------------------------------------------------------------

  private buildDecals(geo: Geometry): Decal[] {
    const n = this.segments.length;
    const face = geo.face;
    const slice = TAU / Math.max(1, n);
    const vh = face * Math.tan(slice / 2) + 1;
    const w = Math.ceil(face * K);
    const h = Math.ceil(vh * 2 * K);
    const ctx = this.scratchContext(w, h);
    return this.segments.map((segment) => {
      const data = new Uint8Array(w * h);
      const palette = new Uint32Array(16);
      const jackpot = isJackpot(segment.prize);
      palette[1] = packRgb(jackpot ? [255, 240, 170] : OUTLINE);
      palette[2] = packRgb(jackpot ? [58, 34, 0] : [255, 255, 255]);

      // the icon, standing up from the rim end
      const { name, tint } = iconOf(segment.prize);
      for (const ch of Object.keys(SPRITE_INDEX)) {
        palette[SPRITE_INDEX[ch]] = packRgb(spriteColor(ch, tint));
      }
      const rows = spriteRows(name);
      const sw = Math.max(...rows.map((r) => r.length));
      const sh = rows.length;
      const texel = Math.max(
        2,
        Math.round((face * 0.19 * K) / Math.max(sw, sh)),
      );
      const x0 = Math.round(face * 0.83 * K - (sh * texel) / 2);
      const y0 = Math.round(h / 2 - (sw * texel) / 2);
      rows.forEach((row, sy) => {
        for (let sx = 0; sx < row.length; sx++) {
          const code = SPRITE_INDEX[row[sx]];
          if (code === undefined) continue;
          // turned a quarter, so the top of the icon points out to the rim
          const px = x0 + (sh - 1 - sy) * texel;
          const py = y0 + sx * texel;
          for (let dy = 0; dy < texel; dy++) {
            for (let dx = 0; dx < texel; dx++) {
              const tx = px + dx;
              const ty = py + dy;
              if (tx >= 0 && tx < w && ty >= 0 && ty < h) {
                data[ty * w + tx] = code;
              }
            }
          }
        }
      });

      // the label inwards of it, as large as the room allows, outlined
      if (ctx !== null) {
        const label = segment.label;
        ctx.font = `700 100px ${PIXEL_FONT}`;
        const room = face * 0.46 * K;
        const fontSize = Math.min(
          geo.size * 0.05 * K,
          (room / ctx.measureText(label).width) * 100,
        );
        ctx.clearRect(0, 0, w, h);
        ctx.textAlign = "right";
        ctx.textBaseline = "middle";
        ctx.font = `700 ${fontSize}px ${PIXEL_FONT}`;
        ctx.lineJoin = "round";
        ctx.lineWidth = 3 * K;
        ctx.strokeStyle = "#000";
        ctx.fillStyle = "#000";
        const x = face * 0.69 * K;
        const y = h / 2 + fontSize * 0.04;
        ctx.strokeText(label, x, y);
        ctx.fillText(label, x, y);
        const outlined = ctx.getImageData(0, 0, w, h).data;
        ctx.clearRect(0, 0, w, h);
        ctx.fillText(label, x, y);
        const filled = ctx.getImageData(0, 0, w, h).data;
        for (let i = 0; i < w * h; i++) {
          if (data[i] !== 0) continue;
          if (filled[i * 4 + 3] > 127) data[i] = 2;
          else if (outlined[i * 4 + 3] > 127) data[i] = 1;
        }
      }
      return { w, h, vh, data, palette };
    });
  }

  // ---- each frame ---------------------------------------------------------------------

  private paint = (now: number): void => {
    this.frame = requestAnimationFrame(this.paint);
    if (!this.visible) return;
    const lively =
      this.spinning ||
      this.lit >= 0 ||
      this.highlight.length > 0 ||
      this.dim > 0.01;
    // a still wheel only needs to move at half the speed
    if (!lively && now - this.lastPaint < 33) return;
    this.lastPaint = now;
    const canvas = this.querySelector<HTMLCanvasElement>("canvas");
    if (canvas === null || this.segments.length === 0) return;
    // as wide as the room allows (a pixel of the wheel is two of the screen's,
    // one on a phone), on a grid that fits whole
    const avail = Math.min(540, this.clientWidth);
    if (avail === 0) return;
    const pixel = avail >= 420 ? 2 : 1;
    const size = Math.floor(avail / pixel);
    if (this.geometry === null || this.geometry.size !== size) {
      this.geometry = this.build(size);
      canvas.width = size;
      canvas.height = size;
      this.decalsFor = "";
    }
    const geo = this.geometry;
    canvas.style.width = `${size * pixel}px`;
    canvas.style.height = `${size * pixel}px`;
    const ctx = canvas.getContext?.("2d");
    if (!ctx) return;
    const key = `${this.fontReady}:${size}`;
    if (this.decalsFor !== key) {
      this.decals = this.buildDecals(geo);
      this.decalsFor = key;
    }
    // idle: a slow drift, so the wheel is never dead
    if (!this.spinning && motionAllowed() && this.lit < 0) {
      this.rotation -= 0.0016 * (lively ? 1 : 2);
    }
    if (!this.spinning && this.lit >= 0 && now > this.litUntil) this.lit = -1;
    this.flap *= 0.86;
    const target = this.highlight.length > 0 && !this.spinning ? 1 : 0;
    this.dim += (target - this.dim) * 0.22;
    this.draw(geo, now);
    ctx.putImageData(geo.image, 0, 0);
  };

  private draw(geo: Geometry, now: number): void {
    const { buffer: out, size } = geo;
    out.set(geo.base);
    const n = this.segments.length;
    const slice = TAU / n;
    const rot = this.rotation;

    // each segment's shading this frame, and which way its label runs
    const ramps: number[][] = [];
    const cos = new Float32Array(n);
    const sin = new Float32Array(n);
    // dimming moves in quarters, so the others step back in a few shades
    const dim = Math.round(this.dim * 4) / 4;
    const blink = Math.floor(now / 140) % 2 === 0;
    for (let i = 0; i < n; i++) {
      const [light, dark] = segmentColors(this.segments[i], i);
      let boost = 0;
      let shadeBy = 0;
      if (i === this.lit) boost = blink ? 0.45 : 0.2;
      else if (this.highlight.includes(i)) boost = blink ? 0.3 : 0.2;
      else shadeBy = dim * 0.64;
      ramps.push(
        [0, 1, 2, 3].map((level) => {
          let c = mix(dark, light, level / 3);
          if (boost > 0) c = lighten(c, boost);
          if (shadeBy > 0) c = darken(c, shadeBy);
          return packRgb(c);
        }),
      );
      const theta = rot + (i + 0.5) * slice - HALF_PI;
      cos[i] = Math.cos(theta);
      sin[i] = Math.sin(theta);
    }

    const line = packRgb([217, 201, 138]);
    const { faceIdx, faceDx, faceDy, faceR, facePhi, face } = geo;
    for (let k = 0; k < faceIdx.length; k++) {
      const idx = faceIdx[k];
      const r = faceR[k];
      let a = facePhi[k] - rot + HALF_PI;
      a -= Math.floor(a / TAU) * TAU;
      const seg = Math.min(n - 1, Math.floor(a / slice));
      const within = a - seg * slice;
      // the lines between segments, a pixel wide
      if (Math.min(within, slice - within) * r < 0.7) {
        out[idx] = line;
        continue;
      }
      // the label and icon, if this pixel is on them
      const dx = faceDx[k];
      const dy = faceDy[k];
      const u = dx * cos[seg] + dy * sin[seg];
      const v = -dx * sin[seg] + dy * cos[seg];
      const decal = this.decals[seg];
      if (decal !== undefined && u > 0 && u < face && Math.abs(v) < decal.vh) {
        const code = this.sample(decal, u, v);
        if (code !== 0) {
          out[idx] = decal.palette[code];
          continue;
        }
      }
      // the face: dark at the hub, light at the rim, in dithered steps
      const level = Math.floor(
        (r / face) * 4 + bayerAt(idx % size, (idx / size) | 0),
      );
      out[idx] = ramps[seg][level < 0 ? 0 : level > 3 ? 3 : level];
    }

    // a peg on every line
    const peg = size >= 200 ? 3 : 2;
    const pegColor = packRgb(CREAM);
    for (let i = 0; i < n; i++) {
      const a = rot + i * slice - HALF_PI;
      this.square(
        geo,
        geo.center + Math.cos(a) * face * 0.975,
        geo.center + Math.sin(a) * face * 0.975,
        peg,
        pegColor,
      );
    }

    // the hub
    const hubLayer = geo.hubLayer;
    for (let i = 0; i < hubLayer.length; i++) {
      if (hubLayer[i] !== 0) out[i] = hubLayer[i];
    }

    // the rim's bulbs: a band of light chases round, faster while it spins,
    // and all of them blink once the wheel has stopped
    const bulbs = 28;
    const stepped = Math.floor(now / (this.spinning ? 55 : 150));
    const bulbSize = size >= 200 ? 3 : 2;
    const rBulb = geo.rimOuter - size * 0.022;
    const bright = packRgb([255, 247, 194]);
    const dull = packRgb([122, 90, 20]);
    for (let i = 0; i < bulbs; i++) {
      const a = (i / bulbs) * TAU - HALF_PI;
      const on = (i + stepped) % bulbs < 6 || (this.lit >= 0 && blink);
      this.square(
        geo,
        geo.center + Math.cos(a) * rBulb,
        geo.center + Math.sin(a) * rBulb,
        bulbSize,
        on ? bright : dull,
      );
    }

    this.drawPointer(geo);
  }

  /** What is at `(u, v)` of a decal: the commonest of four samples, if at least two are not empty. */
  private sample(decal: Decal, u: number, v: number): number {
    const { w, h, vh, data } = decal;
    const codes = [0, 0, 0, 0];
    let filled = 0;
    for (let s = 0; s < 4; s++) {
      const tu = Math.floor((u + (s & 1 ? 0.25 : -0.25)) * K);
      const tv = Math.floor((v + vh + (s & 2 ? 0.25 : -0.25)) * K);
      const code =
        tu >= 0 && tu < w && tv >= 0 && tv < h ? data[tv * w + tu] : 0;
      codes[s] = code;
      if (code !== 0) filled++;
    }
    if (filled < 2) return 0;
    let best = 0;
    let bestCount = 0;
    for (const code of codes) {
      if (code === 0) continue;
      let count = 0;
      for (const other of codes) if (other === code) count++;
      if (count > bestCount) {
        best = code;
        bestCount = count;
      }
    }
    return best;
  }

  /** A square of `side` pixels centred on a point of the grid. */
  private square(
    geo: Geometry,
    x: number,
    y: number,
    side: number,
    word: number,
  ): void {
    const left = Math.round(x - side / 2);
    const top = Math.round(y - side / 2);
    for (let dy = 0; dy < side; dy++) {
      for (let dx = 0; dx < side; dx++) {
        const px = left + dx;
        const py = top + dy;
        if (px >= 0 && px < geo.size && py >= 0 && py < geo.size) {
          geo.buffer[py * geo.size + px] = word;
        }
      }
    }
  }

  /** The pointer at the top, a pixel arrow with a cream outline, its tip deflected by the flapper. */
  private drawPointer(geo: Geometry): void {
    const { size, center, rimOuter } = geo;
    const px = center;
    const py = center - rimOuter - size * 0.004;
    const half = size * 0.03;
    const top = size * 0.012;
    const length = size * 0.07;
    const angle = this.flap * 0.5;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const reach = Math.ceil(length + half + 3);
    const fill = [
      packRgb([255, 90, 90]),
      packRgb([214, 38, 58]),
      packRgb([179, 18, 42]),
    ];
    const cream = packRgb(CREAM);
    for (let y = Math.floor(py - reach); y <= Math.ceil(py + reach); y++) {
      for (let x = Math.floor(px - reach); x <= Math.ceil(px + reach); x++) {
        if (x < 0 || x >= size || y < 0 || y >= size) continue;
        const dx = x + 0.5 - px;
        const dy = y + 0.5 - py;
        // back into the pointer's own frame
        const lx = dx * cos + dy * sin;
        const ly = -dx * sin + dy * cos;
        if (ly < -top || ly > length) continue;
        const reachAt = half * (1 - (ly + top) / (length + top));
        const inset = reachAt - Math.abs(lx);
        if (inset < 0) continue;
        const edge = inset < 1.1 || ly + top < 1.1;
        const t = (ly + top) / (length + top);
        geo.buffer[y * size + x] = edge
          ? cream
          : fill[t < 0.4 ? 0 : t < 0.75 ? 1 : 2];
      }
    }
    // the pivot
    this.square(geo, px, py, 4, cream);
  }
}
