import type { VaultView } from "@openfront/shared/VaultSchemas";
import { html, LitElement } from "lit";
import { customElement, property } from "lit/decorators.js";
import { motionAllowed, playTick, RARITY_COLOR } from "./VaultFx";

type Segment = VaultView["wheel"]["segments"][number];

const TAU = Math.PI * 2;
const SPIN_MS = 5600;
const easeOutQuint = (t: number): number => 1 - Math.pow(1 - t, 5);

/** The fill of a segment: Credits alternate two night blues, items take their rarity, a pack is cyan, the jackpot gold. */
function segmentColors(segment: Segment, index: number): [string, string] {
  const prize = segment.prize;
  if (prize.kind === "item") {
    const color = RARITY_COLOR[prize.rarity];
    return [color, shade(color, -0.45)];
  }
  if (prize.kind === "pack") return ["#38bdf8", "#1d4ed8"];
  if (prize.amount >= 1000) return ["#fde047", "#d97706"];
  return index % 2 === 0 ? ["#3b3f78", "#1c1d44"] : ["#2a5b78", "#12283e"];
}

function shade(hex: string, amount: number): string {
  const n = parseInt(hex.slice(1), 16);
  const channel = (shift: number) =>
    Math.max(0, Math.min(255, Math.round(((n >> shift) & 255) * (1 + amount))));
  return `rgb(${channel(16)}, ${channel(8)}, ${channel(0)})`;
}

/**
 * The wheel: a canvas that draws the segments, a rim of chasing lights, a
 * flapper that ticks past each peg and a hub. `spinTo(index)` turns it to the
 * winning segment (chosen by the server) over a few seconds of slowing down,
 * and resolves when it has stopped.
 */
@customElement("vault-wheel")
export class VaultWheel extends LitElement {
  @property({ attribute: false }) segments: readonly Segment[] = [];
  @property({ type: Boolean }) hot = false;

  private rotation = 0;
  private flap = 0;
  private lit = -1;
  private litUntil = 0;
  private spinning = false;
  private frame: number | null = null;
  private started = 0;

  createRenderRoot() {
    return this;
  }

  connectedCallback() {
    super.connectedCallback();
    this.frame = requestAnimationFrame(this.paint);
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    if (this.frame !== null) cancelAnimationFrame(this.frame);
    this.frame = null;
  }

  render() {
    return html`<canvas
      data-vault-wheel
      class="mx-auto block aspect-square w-full max-w-[540px]"
      aria-hidden="true"
    ></canvas>`;
  }

  get isSpinning(): boolean {
    return this.spinning;
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
    if (!motionAllowed()) {
      this.rotation = target;
      this.lit = index;
      this.litUntil = performance.now() + 2600;
      return Promise.resolve();
    }
    this.spinning = true;
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
        }
        if (p < 1) {
          requestAnimationFrame(step);
        } else {
          this.spinning = false;
          this.lit = index;
          this.litUntil = now + 2600;
          resolve();
        }
      };
      requestAnimationFrame(step);
    });
  }

  private paint = (now: number): void => {
    this.frame = requestAnimationFrame(this.paint);
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
    if (this.started === 0) this.started = now;
    // idle: a slow drift, so the wheel is never dead
    if (!this.spinning && motionAllowed() && this.lit < 0)
      this.rotation -= 0.0016;
    if (!this.spinning && this.lit >= 0 && now > this.litUntil) this.lit = -1;
    this.flap *= 0.86;

    const s = size;
    const c = s / 2;
    const rim = s * 0.465;
    const radius = s * 0.4;
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

    // the rim
    const rimGradient = ctx.createLinearGradient(0, 0, s, s);
    rimGradient.addColorStop(0, "#f8e08e");
    rimGradient.addColorStop(0.5, "#b8801c");
    rimGradient.addColorStop(1, "#6d4709");
    ctx.beginPath();
    ctx.arc(c, c, rim, 0, TAU);
    ctx.fillStyle = rimGradient;
    ctx.fill();
    ctx.beginPath();
    ctx.arc(c, c, radius + s * 0.02, 0, TAU);
    ctx.fillStyle = "#16121f";
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
    const n = this.segments.length;
    const slice = TAU / n;
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
      }
      ctx.lineWidth = s * 0.004;
      ctx.strokeStyle = "rgba(255,247,194,0.7)";
      ctx.stroke();
      // the label, along the segment's middle
      ctx.save();
      ctx.rotate(a0 + slice / 2);
      ctx.textAlign = "right";
      ctx.textBaseline = "middle";
      ctx.fillStyle = "#fff";
      ctx.shadowColor = "rgba(0,0,0,0.7)";
      ctx.shadowBlur = s * 0.008;
      const long = segment.label.length > 7;
      ctx.font = `800 ${Math.round(s * (long ? 0.031 : 0.045))}px Inter, system-ui, sans-serif`;
      ctx.fillText(segment.label, radius * 0.9, 0);
      ctx.restore();
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

    // the hub
    const hub = ctx.createRadialGradient(
      c - s * 0.012,
      c - s * 0.012,
      2,
      c,
      c,
      s * 0.075,
    );
    hub.addColorStop(0, "#fff3b0");
    hub.addColorStop(0.5, "#d49a22");
    hub.addColorStop(1, "#6d4709");
    ctx.beginPath();
    ctx.arc(c, c, s * 0.072, 0, TAU);
    ctx.fillStyle = hub;
    ctx.fill();
    ctx.lineWidth = s * 0.006;
    ctx.strokeStyle = "#2a1c04";
    ctx.stroke();
    ctx.fillStyle = "#2a1c04";
    ctx.font = `900 ${Math.round(s * 0.026)}px Inter, system-ui, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("VAULT", c, c);

    // the pointer at the top, its tip deflected by the flapper
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
    ctx.restore();
  };
}

const mod = (a: number, n: number): number => ((a % n) + n) % n;
