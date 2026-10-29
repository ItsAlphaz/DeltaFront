import type { VaultRarity } from "@openfront/shared/VaultSchemas";
import { UserSettings } from "../UserSettings";

/**
 * The Vault's effects: particles on a canvas (bursts, confetti, rings) and
 * short synthesised sounds (no audio files). Both are switched off for
 * reduced motion, and the sounds follow the sound-effects volume setting.
 */

export const RARITY_COLOR: Record<VaultRarity, string> = {
  common: "#9ca3af",
  uncommon: "#4ade80",
  rare: "#38bdf8",
  epic: "#c084fc",
  legendary: "#fbbf24",
};

/** How much a rarity is celebrated: particles, and the notes of its sound. */
const RARITY_POWER: Record<VaultRarity, number> = {
  common: 0,
  uncommon: 1,
  rare: 2,
  epic: 3,
  legendary: 4,
};
export const rarityPower = (rarity: VaultRarity): number =>
  RARITY_POWER[rarity];

export function motionAllowed(): boolean {
  return !window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
}

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  age: number;
  size: number;
  color: string;
  gravity: number;
  spin: number;
  rotation: number;
  shape: "dot" | "bar" | "star";
}

/** A canvas laid over its host that draws bursts of particles and stops itself when none are left. */
export class VaultFx {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D | null;
  private particles: Particle[] = [];
  private rings: {
    x: number;
    y: number;
    color: string;
    age: number;
    life: number;
    size: number;
  }[] = [];
  private frame: number | null = null;
  private last = 0;

  constructor(host: HTMLElement) {
    this.canvas = document.createElement("canvas");
    this.canvas.setAttribute("aria-hidden", "true");
    this.canvas.style.cssText =
      "position:absolute;inset:0;width:100%;height:100%;pointer-events:none;z-index:50";
    host.appendChild(this.canvas);
    this.ctx = this.canvas.getContext?.("2d") ?? null;
  }

  dispose(): void {
    if (this.frame !== null) cancelAnimationFrame(this.frame);
    this.frame = null;
    this.particles = [];
    this.canvas.remove();
  }

  private size(): { w: number; h: number } {
    const rect = this.canvas.getBoundingClientRect();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.max(1, Math.round(rect.width * dpr));
    const h = Math.max(1, Math.round(rect.height * dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    return { w: rect.width, h: rect.height };
  }

  /** A burst of sparks flying out of (x, y) in the host's own pixels. */
  burst(
    x: number,
    y: number,
    colors: string[],
    options: {
      count?: number;
      speed?: number;
      gravity?: number;
      shape?: Particle["shape"];
    } = {},
  ): void {
    if (!motionAllowed() || this.ctx === null) return;
    const count = options.count ?? 40;
    for (let i = 0; i < count; i++) {
      const angle = Math.random() * Math.PI * 2;
      const speed = (options.speed ?? 320) * (0.3 + Math.random() * 0.8);
      this.particles.push({
        x,
        y,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        life: 0.7 + Math.random() * 0.9,
        age: 0,
        size: 2 + Math.random() * 4,
        color: colors[i % colors.length],
        gravity: options.gravity ?? 420,
        spin: (Math.random() - 0.5) * 12,
        rotation: Math.random() * Math.PI,
        shape: options.shape ?? (Math.random() < 0.3 ? "star" : "dot"),
      });
    }
    this.start();
  }

  /** Confetti falling from the top of the host. */
  confetti(colors: string[], count = 90): void {
    if (!motionAllowed() || this.ctx === null) return;
    const { w } = this.size();
    for (let i = 0; i < count; i++) {
      this.particles.push({
        x: Math.random() * w,
        y: -10 - Math.random() * 120,
        vx: (Math.random() - 0.5) * 160,
        vy: 80 + Math.random() * 220,
        life: 2 + Math.random() * 1.6,
        age: 0,
        size: 4 + Math.random() * 5,
        color: colors[i % colors.length],
        gravity: 140,
        spin: (Math.random() - 0.5) * 14,
        rotation: Math.random() * Math.PI,
        shape: "bar",
      });
    }
    this.start();
  }

  /** A ring that grows and fades from (x, y). */
  ring(x: number, y: number, color: string, size = 260): void {
    if (!motionAllowed() || this.ctx === null) return;
    this.rings.push({ x, y, color, age: 0, life: 0.8, size });
    this.start();
  }

  private start(): void {
    if (this.frame !== null) return;
    this.last = performance.now();
    this.frame = requestAnimationFrame(this.tick);
  }

  private tick = (now: number): void => {
    const ctx = this.ctx;
    if (ctx === null) return;
    const dt = Math.min(0.05, (now - this.last) / 1000);
    this.last = now;
    const { w, h } = this.size();
    const dpr = this.canvas.width / Math.max(1, w);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.globalCompositeOperation = "lighter";
    for (const r of this.rings) {
      r.age += dt;
      const t = r.age / r.life;
      ctx.globalAlpha = Math.max(0, 1 - t);
      ctx.strokeStyle = r.color;
      ctx.lineWidth = 6 * (1 - t) + 1;
      ctx.beginPath();
      ctx.arc(r.x, r.y, r.size * t, 0, Math.PI * 2);
      ctx.stroke();
    }
    this.rings = this.rings.filter((r) => r.age < r.life);
    for (const p of this.particles) {
      p.age += dt;
      p.vy += p.gravity * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.rotation += p.spin * dt;
      const t = p.age / p.life;
      ctx.globalAlpha = Math.max(0, 1 - t * t);
      ctx.fillStyle = p.color;
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rotation);
      if (p.shape === "bar") {
        ctx.fillRect(-p.size / 2, -p.size, p.size, p.size * 2);
      } else if (p.shape === "star") {
        ctx.beginPath();
        for (let i = 0; i < 8; i++) {
          const rad = i % 2 === 0 ? p.size * 1.6 : p.size * 0.5;
          const a = (i * Math.PI) / 4;
          ctx.lineTo(Math.cos(a) * rad, Math.sin(a) * rad);
        }
        ctx.closePath();
        ctx.fill();
      } else {
        ctx.beginPath();
        ctx.arc(0, 0, p.size, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    }
    this.particles = this.particles.filter(
      (p) => p.age < p.life && p.y < h + 40,
    );
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";
    if (this.particles.length > 0 || this.rings.length > 0) {
      this.frame = requestAnimationFrame(this.tick);
    } else {
      this.frame = null;
      ctx.clearRect(0, 0, w, h);
    }
  };
}

// ---- sound ---------------------------------------------------------------------

let audio: AudioContext | null = null;

function context(): AudioContext | null {
  const volume = new UserSettings().soundEffectsVolume();
  if (!(volume > 0) || typeof AudioContext === "undefined") return null;
  audio ??= new AudioContext();
  if (audio.state === "suspended") void audio.resume();
  return audio;
}

function tone(
  ctx: AudioContext,
  frequency: number,
  start: number,
  length: number,
  type: OscillatorType,
  gain: number,
  slideTo?: number,
): void {
  const volume = new UserSettings().soundEffectsVolume();
  const osc = ctx.createOscillator();
  const amp = ctx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(frequency, ctx.currentTime + start);
  if (slideTo !== undefined) {
    osc.frequency.exponentialRampToValueAtTime(
      slideTo,
      ctx.currentTime + start + length,
    );
  }
  amp.gain.setValueAtTime(0.0001, ctx.currentTime + start);
  amp.gain.exponentialRampToValueAtTime(
    Math.max(0.0002, gain * volume),
    ctx.currentTime + start + 0.01,
  );
  amp.gain.exponentialRampToValueAtTime(
    0.0001,
    ctx.currentTime + start + length,
  );
  osc.connect(amp).connect(ctx.destination);
  osc.start(ctx.currentTime + start);
  osc.stop(ctx.currentTime + start + length + 0.02);
}

/** The wheel's flapper ticking past a peg. */
export function playTick(pitch = 1): void {
  const ctx = context();
  if (ctx === null || !motionAllowed()) return;
  tone(ctx, 1500 * pitch, 0, 0.04, "square", 0.05, 900 * pitch);
}

/** A pack tearing open: a rising sweep and a thump. */
export function playTear(): void {
  const ctx = context();
  if (ctx === null) return;
  tone(ctx, 140, 0, 0.35, "sawtooth", 0.1, 900);
  tone(ctx, 70, 0.28, 0.22, "sine", 0.25, 40);
}

/** A card turning over: higher and longer the better it is. */
export function playReveal(rarity: VaultRarity): void {
  const ctx = context();
  if (ctx === null) return;
  const power = rarityPower(rarity);
  tone(ctx, 420 + power * 80, 0, 0.12, "triangle", 0.12, 640 + power * 120);
  if (power >= 2) {
    const notes = [523, 659, 784, 1047, 1319].slice(0, power + 1);
    notes.forEach((n, i) => tone(ctx, n, 0.1 + i * 0.07, 0.3, "triangle", 0.1));
  }
}

/** The wheel stopping on a prize. */
export function playWin(power: number): void {
  const ctx = context();
  if (ctx === null) return;
  const notes = [392, 523, 659, 784, 1047, 1319];
  notes
    .slice(0, 2 + Math.min(4, power + 1))
    .forEach((n, i) => tone(ctx, n, i * 0.08, 0.35, "square", 0.07));
}
