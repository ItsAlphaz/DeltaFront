import { assetUrl } from "@openfront/shared/AssetUrls";
import type { VaultView } from "@openfront/shared/VaultSchemas";
import { html, LitElement } from "lit";
import { customElement, property } from "lit/decorators.js";
import {
  motionAllowed,
  PACK_COLOR,
  playTick,
  RARITY_COLOR,
  VaultFx,
} from "./VaultFx";
import { tiltLeave, tiltMove, tiltRelease } from "./VaultTilt";

type Segment = VaultView["wheel"]["segments"][number];
type Prize = Segment["prize"];

const TAU = Math.PI * 2;
const SPIN_MS = 5600;
const easeOutQuint = (t: number): number => 1 - Math.pow(1 - t, 5);
const FONT = "Inter, system-ui, sans-serif";

/** The fill of a segment: Credits alternate two night blues, items take their rarity, a pack is pink, the jackpot gold. */
function segmentColors(segment: Segment, index: number): [string, string] {
  const prize = segment.prize;
  if (prize.kind === "item") {
    const color = RARITY_COLOR[prize.rarity];
    return [color, shade(color, -0.5)];
  }
  if (prize.kind === "pack") return [PACK_COLOR, "#7a1d4d"];
  if (prize.amount >= 1000) return ["#ffe266", "#d97706"];
  return index % 2 === 0 ? ["#4a4fa8", "#1c1d44"] : ["#2f6a8c", "#12283e"];
}

function shade(hex: string, amount: number): string {
  const n = parseInt(hex.slice(1), 16);
  const channel = (shift: number) =>
    Math.max(0, Math.min(255, Math.round(((n >> shift) & 255) * (1 + amount))));
  return `rgb(${channel(16)}, ${channel(8)}, ${channel(0)})`;
}

const isJackpot = (prize: Prize): boolean =>
  prize.kind === "credits" && prize.amount >= 1000;

/**
 * The wheel: a canvas that draws the segments (each with the icon of what it
 * gives), a rim of chasing lights, a flapper that ticks past each peg, a glass
 * sheen and a hub. `spinTo(index)` turns it to the winning segment (chosen by
 * the server) over a few seconds of slowing down and resolves when it has
 * stopped. Every peg it passes throws sparks off the pointer; the wheel leans
 * towards the cursor while it is still, and `highlight` lights segments up
 * (the odds list shows which segment a line is about).
 */
@customElement("vault-wheel")
export class VaultWheel extends LitElement {
  @property({ attribute: false }) segments: readonly Segment[] = [];
  /** Segment indexes to light up. */
  @property({ attribute: false }) highlight: readonly number[] = [];

  private rotation = 0;
  private flap = 0;
  private lit = -1;
  /** How far the segments that are not highlighted have dimmed, 0 to 1. */
  private dim = 0;
  private litUntil = 0;
  private spinning = false;
  private frame: number | null = null;
  private visible = true;
  private lastPaint = 0;
  private seen: IntersectionObserver | null = null;
  private fx: VaultFx | null = null;
  private coin: HTMLImageElement | null = null;
  private labelWidths = new Map<string, number>();

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
    if (this.coin === null && typeof Image !== "undefined") {
      this.coin = new Image();
      this.coin.src = assetUrl("images/CreditsIcon.svg");
    }
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

  render() {
    return html`<div class="vault-tilt" style="--tilt-hover-scale: 1">
      <canvas
        data-vault-wheel
        class="mx-auto block aspect-square w-full max-w-[540px]"
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
    const canvas = this.querySelector<HTMLElement>(".vault-tilt");
    if (canvas !== null) tiltRelease(canvas);
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
    const color = segmentColors(segment, index)[0];
    const tip = this.tip();
    const fx = this.effects();
    fx.ring(tip.x, tip.y + tip.h * 0.4, color, tip.w * 0.55);
    fx.burst(tip.x, tip.y + tip.h * 0.08, [color, "#ffffff", "#fff7c2"], {
      count: 46,
      speed: 360,
      gravity: 380,
    });
  }

  private labelWidth(label: string): number {
    let width = this.labelWidths.get(label);
    if (width === undefined) {
      const ctx = document.createElement("canvas").getContext?.("2d");
      if (ctx) {
        ctx.font = `800 100px ${FONT}`;
        width = ctx.measureText(label).width;
      }
      width ??= label.length * 62;
      this.labelWidths.set(label, width);
    }
    return width;
  }

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
    const rect = canvas.getBoundingClientRect();
    if (rect.width === 0) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const size = Math.round(rect.width * dpr);
    if (canvas.width !== size) {
      canvas.width = size;
      canvas.height = size;
    }
    const ctx = canvas.getContext?.("2d");
    if (!ctx) return;
    // idle: a slow drift, so the wheel is never dead
    if (!this.spinning && motionAllowed() && this.lit < 0)
      this.rotation -= 0.0016 * (lively ? 1 : 2);
    if (!this.spinning && this.lit >= 0 && now > this.litUntil) this.lit = -1;
    this.flap *= 0.86;
    const target = this.highlight.length > 0 && !this.spinning ? 1 : 0;
    this.dim += (target - this.dim) * 0.22;
    this.draw(ctx, size, now);
  };

  private draw(ctx: CanvasRenderingContext2D, s: number, now: number): void {
    const c = s / 2;
    const rim = s * 0.465;
    const radius = s * 0.4;
    const n = this.segments.length;
    const slice = TAU / n;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, s, s);

    // a glow behind the wheel that quickens while it turns
    const pulse = 0.5 + 0.5 * Math.sin(now / (this.spinning ? 120 : 700));
    const glow = ctx.createRadialGradient(c, c, radius * 0.6, c, c, s * 0.5);
    glow.addColorStop(0, "rgba(0,0,0,0)");
    glow.addColorStop(
      0.8,
      `rgba(251,191,36,${0.1 + pulse * (this.spinning ? 0.3 : 0.12)})`,
    );
    glow.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, s, s);

    // the rim: a gold ring with a bevel, then the dark channel the bulbs sit in
    const rimGradient = ctx.createLinearGradient(0, 0, s, s);
    rimGradient.addColorStop(0, "#fbe9a0");
    rimGradient.addColorStop(0.45, "#c0891f");
    rimGradient.addColorStop(1, "#6d4709");
    ctx.beginPath();
    ctx.arc(c, c, rim, 0, TAU);
    ctx.fillStyle = rimGradient;
    ctx.fill();
    ctx.beginPath();
    ctx.arc(c, c, rim - s * 0.004, Math.PI * 1.05, Math.PI * 1.7);
    ctx.lineWidth = s * 0.005;
    ctx.strokeStyle = "rgba(255,250,214,0.6)";
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(c, c, radius + s * 0.02, 0, TAU);
    ctx.fillStyle = "#14101c";
    ctx.fill();

    // the rim's lights: a band of light chases round, faster while it spins
    const bulbs = 28;
    const speed = this.spinning ? 0.012 : 0.002;
    for (let i = 0; i < bulbs; i++) {
      const a = (i / bulbs) * TAU - Math.PI / 2;
      const phase = (i / bulbs + now * speed) % 1;
      const on =
        phase < 0.22 || (this.lit >= 0 && Math.floor(now / 160) % 2 === 0);
      const x = c + Math.cos(a) * (rim - s * 0.022);
      const y = c + Math.sin(a) * (rim - s * 0.022);
      ctx.beginPath();
      ctx.arc(x, y, s * 0.0085, 0, TAU);
      ctx.fillStyle = on ? "#fff7c2" : "#7a5a14";
      ctx.shadowColor = on ? "#ffd54a" : "transparent";
      ctx.shadowBlur = on ? s * 0.02 : 0;
      ctx.fill();
      ctx.shadowBlur = 0;
    }

    // the segments
    ctx.save();
    ctx.translate(c, c);
    ctx.rotate(this.rotation);
    this.segments.forEach((segment, i) => {
      const a0 = i * slice - Math.PI / 2;
      const a1 = a0 + slice;
      const [light, dark] = segmentColors(segment, i);
      const fill = ctx.createRadialGradient(0, 0, radius * 0.15, 0, 0, radius);
      fill.addColorStop(0, dark);
      fill.addColorStop(1, light);
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.arc(0, 0, radius, a0, a1);
      ctx.closePath();
      ctx.fillStyle = fill;
      ctx.fill();
      if (i === this.lit) {
        ctx.fillStyle = `rgba(255,255,255,${0.25 + 0.25 * Math.sin(now / 90)})`;
        ctx.fill();
      } else if (this.highlight.includes(i)) {
        ctx.fillStyle = `rgba(255,255,255,${0.2 + 0.1 * Math.sin(now / 150)})`;
        ctx.fill();
      } else if (this.dim > 0.01) {
        // the rest step back, so the ones being pointed at stand out
        ctx.fillStyle = `rgba(8,6,20,${0.64 * this.dim})`;
        ctx.fill();
      }
      ctx.lineWidth = s * 0.004;
      ctx.strokeStyle = "rgba(255,247,194,0.7)";
      ctx.stroke();
      this.drawSegmentContent(ctx, segment, s, radius, a0 + slice / 2);
    });
    // a peg on every boundary
    for (let i = 0; i < n; i++) {
      const a = i * slice - Math.PI / 2;
      ctx.beginPath();
      ctx.arc(
        Math.cos(a) * radius * 0.985,
        Math.sin(a) * radius * 0.985,
        s * 0.0095,
        0,
        TAU,
      );
      ctx.fillStyle = "#fff3b0";
      ctx.fill();
    }
    ctx.restore();

    // depth: the face darkens towards the rim, and a glass sheen lies across it
    ctx.save();
    ctx.beginPath();
    ctx.arc(c, c, radius, 0, TAU);
    ctx.clip();
    const vignette = ctx.createRadialGradient(c, c, radius * 0.7, c, c, radius);
    vignette.addColorStop(0, "rgba(0,0,0,0)");
    vignette.addColorStop(1, "rgba(0,0,0,0.34)");
    ctx.fillStyle = vignette;
    ctx.fillRect(0, 0, s, s);
    const sheen = ctx.createLinearGradient(c - radius, c - radius, c, c);
    sheen.addColorStop(0, "rgba(255,255,255,0.16)");
    sheen.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = sheen;
    ctx.beginPath();
    ctx.ellipse(
      c - radius * 0.28,
      c - radius * 0.42,
      radius * 0.78,
      radius * 0.42,
      -0.6,
      0,
      TAU,
    );
    ctx.fill();
    ctx.restore();

    this.drawHub(ctx, c, s, now);
    this.drawPointer(ctx, c, rim, s);
  }

  /** The icon of what a segment gives and its label, along its middle. */
  private drawSegmentContent(
    ctx: CanvasRenderingContext2D,
    segment: Segment,
    s: number,
    radius: number,
    angle: number,
  ): void {
    const prize = segment.prize;
    const jackpot = isJackpot(prize);
    ctx.save();
    ctx.rotate(angle);

    // the icon at the rim end, standing up from the rim
    ctx.save();
    ctx.translate(radius * 0.83, 0);
    ctx.rotate(Math.PI / 2);
    this.drawIcon(ctx, prize, radius * 0.17);
    ctx.restore();

    // the label inwards of it, as large as the room allows
    const label = segment.label;
    const room = radius * 0.46;
    const fontSize = Math.min(s * 0.052, (room / this.labelWidth(label)) * 100);
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    ctx.fillStyle = jackpot ? "#3a2200" : "#fff";
    ctx.shadowColor = jackpot ? "rgba(255,255,255,0.5)" : "rgba(0,0,0,0.7)";
    ctx.shadowBlur = s * 0.008;
    ctx.font = `800 ${Math.round(fontSize)}px ${FONT}`;
    ctx.fillText(label, radius * 0.68, 0);
    ctx.restore();
  }

  /** Drawn in a unit square (−0.5…0.5), scaled to `size`, its top towards the rim. */
  private drawIcon(
    ctx: CanvasRenderingContext2D,
    prize: Prize,
    size: number,
  ): void {
    ctx.save();
    ctx.scale(size, size);
    ctx.lineJoin = "round";
    ctx.shadowColor = "rgba(0,0,0,0.45)";
    ctx.shadowBlur = size * 0.2;
    if (prize.kind === "item") {
      const color = RARITY_COLOR[prize.rarity];
      ctx.beginPath();
      ctx.moveTo(-0.5, -0.12);
      ctx.lineTo(-0.28, -0.5);
      ctx.lineTo(0.28, -0.5);
      ctx.lineTo(0.5, -0.12);
      ctx.lineTo(0, 0.52);
      ctx.closePath();
      ctx.fillStyle = shade(color, 0.35);
      ctx.fill();
      ctx.shadowBlur = 0;
      ctx.lineWidth = 0.07;
      ctx.strokeStyle = "rgba(255,255,255,0.95)";
      ctx.stroke();
      ctx.lineWidth = 0.045;
      ctx.strokeStyle = "rgba(255,255,255,0.7)";
      ctx.beginPath();
      ctx.moveTo(-0.5, -0.12);
      ctx.lineTo(0.5, -0.12);
      ctx.moveTo(-0.13, -0.12);
      ctx.lineTo(0, 0.52);
      ctx.lineTo(0.13, -0.12);
      ctx.moveTo(-0.28, -0.5);
      ctx.lineTo(-0.13, -0.12);
      ctx.moveTo(0.28, -0.5);
      ctx.lineTo(0.13, -0.12);
      ctx.stroke();
    } else if (prize.kind === "pack") {
      ctx.beginPath();
      ctx.roundRect(-0.34, -0.5, 0.68, 1, 0.1);
      const body = ctx.createLinearGradient(0, -0.5, 0, 0.5);
      body.addColorStop(0, "#ffd0e6");
      body.addColorStop(1, "#d6336c");
      ctx.fillStyle = body;
      ctx.fill();
      ctx.shadowBlur = 0;
      ctx.lineWidth = 0.06;
      ctx.strokeStyle = "rgba(255,255,255,0.95)";
      ctx.stroke();
      ctx.fillStyle = "rgba(255,255,255,0.9)";
      ctx.beginPath();
      for (let i = 0; i < 8; i++) {
        const r = i % 2 === 0 ? 0.2 : 0.06;
        const a = (i * Math.PI) / 4 - Math.PI / 2;
        ctx.lineTo(Math.cos(a) * r, Math.sin(a) * r);
      }
      ctx.closePath();
      ctx.fill();
    } else if (isJackpot(prize)) {
      ctx.beginPath();
      for (let i = 0; i < 16; i++) {
        const r = i % 2 === 0 ? 0.55 : 0.26;
        const a = (i * Math.PI) / 8 - Math.PI / 2;
        ctx.lineTo(Math.cos(a) * r, Math.sin(a) * r);
      }
      ctx.closePath();
      ctx.fillStyle = "#fff6bf";
      ctx.fill();
      ctx.shadowBlur = 0;
      ctx.lineWidth = 0.06;
      ctx.strokeStyle = "#b45309";
      ctx.stroke();
    } else {
      const coin = this.coin;
      if (coin !== null && coin.complete && coin.naturalWidth > 0) {
        ctx.drawImage(coin, -0.55, -0.55, 1.1, 1.1);
      } else {
        ctx.beginPath();
        ctx.arc(0, 0, 0.5, 0, TAU);
        ctx.fillStyle = "#f5c542";
        ctx.fill();
        ctx.shadowBlur = 0;
        ctx.lineWidth = 0.08;
        ctx.strokeStyle = "#b8860b";
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  private drawHub(
    ctx: CanvasRenderingContext2D,
    c: number,
    s: number,
    now: number,
  ): void {
    // a ring that swells from the hub and fades, again and again
    const t = (now / (this.spinning ? 700 : 2200)) % 1;
    ctx.beginPath();
    ctx.arc(c, c, s * (0.075 + t * 0.06), 0, TAU);
    ctx.lineWidth = s * 0.004;
    ctx.strokeStyle = `rgba(255,223,120,${0.5 * (1 - t)})`;
    ctx.stroke();

    const hub = ctx.createRadialGradient(
      c - s * 0.014,
      c - s * 0.014,
      2,
      c,
      c,
      s * 0.08,
    );
    hub.addColorStop(0, "#fff3b0");
    hub.addColorStop(0.5, "#d49a22");
    hub.addColorStop(1, "#6d4709");
    ctx.beginPath();
    ctx.arc(c, c, s * 0.074, 0, TAU);
    ctx.fillStyle = hub;
    ctx.shadowColor = "rgba(0,0,0,0.5)";
    ctx.shadowBlur = s * 0.02;
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.lineWidth = s * 0.006;
    ctx.strokeStyle = "#2a1c04";
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(c, c, s * 0.058, 0, TAU);
    ctx.lineWidth = s * 0.003;
    ctx.strokeStyle = "rgba(255,243,176,0.55)";
    ctx.stroke();
    ctx.fillStyle = "#2a1c04";
    ctx.font = `900 ${Math.round(s * 0.024)}px ${FONT}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("VAULT", c, c);
  }

  /** The pointer at the top, its tip deflected by the flapper. */
  private drawPointer(
    ctx: CanvasRenderingContext2D,
    c: number,
    rim: number,
    s: number,
  ): void {
    ctx.save();
    ctx.translate(c, c - rim - s * 0.004);
    ctx.rotate(this.flap * 0.5);
    ctx.beginPath();
    ctx.moveTo(-s * 0.03, -s * 0.012);
    ctx.lineTo(s * 0.03, -s * 0.012);
    ctx.lineTo(0, s * 0.07);
    ctx.closePath();
    const pointer = ctx.createLinearGradient(0, -s * 0.012, 0, s * 0.07);
    pointer.addColorStop(0, "#ff5a5a");
    pointer.addColorStop(1, "#b3122a");
    ctx.fillStyle = pointer;
    ctx.shadowColor = "rgba(0,0,0,0.6)";
    ctx.shadowBlur = s * 0.012;
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.lineWidth = s * 0.004;
    ctx.strokeStyle = "#fff3b0";
    ctx.stroke();
    // the pivot
    ctx.beginPath();
    ctx.arc(0, -s * 0.004, s * 0.011, 0, TAU);
    ctx.fillStyle = "#fff3b0";
    ctx.fill();
    ctx.restore();
  }
}

const mod = (a: number, n: number): number => ((a % n) + n) % n;
