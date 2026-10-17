/**
 * The small synthesizer DeltaFront's generated sound effects are built from:
 * oscillators, seeded noise, filters, envelopes, a reverb and the WAV/MP3
 * writers. No samples, no third-party audio: every sound made with it is
 * original DeltaFront audio (see CREDITS.md). Deterministic: the same code
 * always yields the same samples.
 *
 * Used by synthesize-airstrike-audio.ts and synthesize-capital-audio.ts.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// ---------------------------------------------------------------- primitives

export const SR = 44_100;
export const TAU = Math.PI * 2;

/** Seeded PRNG (mulberry32): the same noise on every run. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const buffer = (seconds: number) =>
  new Float32Array(Math.round(seconds * SR));

/** One-pole low-pass coefficient for cutoff `hz`. */
export const lpCoef = (hz: number) => 1 - Math.exp((-TAU * hz) / SR);

/** RBJ band-pass biquad, processed in place with a cutoff that may vary per sample. */
export function bandpass(
  x: Float32Array,
  freqAt: (t: number) => number,
  q: number,
): Float32Array {
  const y = new Float32Array(x.length);
  let x1 = 0;
  let x2 = 0;
  let y1 = 0;
  let y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const w = (TAU * Math.min(freqAt(i / SR), SR * 0.45)) / SR;
    const alpha = Math.sin(w) / (2 * q);
    const a0 = 1 + alpha;
    const b0 = alpha / a0;
    const b2 = -alpha / a0;
    const a1 = (-2 * Math.cos(w)) / a0;
    const a2 = (1 - alpha) / a0;
    const out = b0 * x[i] + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1;
    x1 = x[i];
    y2 = y1;
    y1 = out;
    y[i] = out;
  }
  return y;
}

/** Low-pass with a cutoff that may vary over time (two cascaded one-poles). */
export function lowpass(
  x: Float32Array,
  hzAt: (t: number) => number,
): Float32Array {
  const y = new Float32Array(x.length);
  let s1 = 0;
  let s2 = 0;
  for (let i = 0; i < x.length; i++) {
    const a = lpCoef(hzAt(i / SR));
    s1 += a * (x[i] - s1);
    s2 += a * (s1 - s2);
    y[i] = s2;
  }
  return y;
}

export function highpass(x: Float32Array, hz: number): Float32Array {
  const low = lowpass(x, () => hz);
  return x.map((v, i) => v - low[i]);
}

export function whiteNoise(seconds: number, seed: number): Float32Array {
  const r = rng(seed);
  const b = buffer(seconds);
  for (let i = 0; i < b.length; i++) b[i] = r() * 2 - 1;
  return b;
}

/** Brown(ish) noise: integrated white noise with a leak, for rumble. */
export function brownNoise(seconds: number, seed: number): Float32Array {
  const r = rng(seed);
  const b = buffer(seconds);
  let v = 0;
  for (let i = 0; i < b.length; i++) {
    v = v * 0.996 + (r() * 2 - 1) * 0.06;
    b[i] = v;
  }
  return b;
}

/** Adds `src` into `dst` starting at `at` seconds, scaled by `gain`. */
export function mixInto(
  dst: Float32Array,
  src: Float32Array,
  at = 0,
  gain = 1,
): Float32Array {
  const start = Math.round(at * SR);
  for (let i = 0; i < src.length && start + i < dst.length; i++) {
    if (start + i >= 0) dst[start + i] += src[i] * gain;
  }
  return dst;
}

export function envelope(
  x: Float32Array,
  env: (t: number) => number,
): Float32Array {
  for (let i = 0; i < x.length; i++) x[i] *= env(i / SR);
  return x;
}

/** Attack-then-exponential-decay envelope. */
export const adEnv = (attack: number, decay: number) => (t: number) =>
  t < attack ? t / attack : Math.exp(-(t - attack) / decay);

/** A tone of `freqAt(t)` Hz built from `harmonics` (amplitude per harmonic). */
export function tone(
  seconds: number,
  freqAt: (t: number) => number,
  harmonics: number[] = [1],
): Float32Array {
  const b = buffer(seconds);
  let phase = 0;
  for (let i = 0; i < b.length; i++) {
    phase += (TAU * freqAt(i / SR)) / SR;
    let v = 0;
    for (let h = 0; h < harmonics.length; h++) {
      v += harmonics[h] * Math.sin(phase * (h + 1));
    }
    b[i] = v;
  }
  return b;
}

/** A small Schroeder reverb: parallel combs into series all-passes. */
export function reverb(x: Float32Array, mix: number, size = 1): Float32Array {
  const tail = buffer(x.length / SR + 1.5 * size);
  tail.set(x);
  const wet = new Float32Array(tail.length);
  for (const [ms, fb] of [
    [29.7, 0.8],
    [37.1, 0.78],
    [41.1, 0.76],
    [43.7, 0.74],
  ]) {
    const d = Math.round(((ms * size) / 1000) * SR);
    const line = new Float32Array(tail.length);
    for (let i = 0; i < tail.length; i++) {
      line[i] = tail[i] + (i >= d ? line[i - d] * fb : 0);
      wet[i] += line[i] * 0.25;
    }
  }
  let out = wet;
  for (const ms of [5, 1.7]) {
    const d = Math.round((ms / 1000) * SR);
    const g = 0.5;
    const y = new Float32Array(out.length);
    for (let i = 0; i < out.length; i++) {
      const xd = i >= d ? out[i - d] : 0;
      const yd = i >= d ? y[i - d] : 0;
      y[i] = -g * out[i] + xd + g * yd;
    }
    out = y;
  }
  const dry = tail;
  return dry.map((v, i) => v * (1 - mix) + out[i] * mix);
}

export const softClip = (x: Float32Array, drive: number) =>
  x.map((v) => Math.tanh(v * drive) / Math.tanh(drive));

export function fadeOut(x: Float32Array, seconds: number): Float32Array {
  const n = Math.min(x.length, Math.round(seconds * SR));
  for (let i = 0; i < n; i++) x[x.length - 1 - i] *= i / n;
  return x;
}

export function fadeIn(x: Float32Array, seconds: number): Float32Array {
  const n = Math.min(x.length, Math.round(seconds * SR));
  for (let i = 0; i < n; i++) x[i] *= i / n;
  return x;
}

export function normalize(x: Float32Array, peak = 0.89): Float32Array {
  let max = 0;
  for (const v of x) max = Math.max(max, Math.abs(v));
  return max === 0 ? x : x.map((v) => (v / max) * peak);
}

/** Crops trailing near-silence (below -60 dBFS), keeping a short tail. */
export function trim(x: Float32Array): Float32Array {
  let end = x.length;
  while (end > 0 && Math.abs(x[end - 1]) < 0.001) end--;
  return x.slice(0, Math.min(x.length, end + Math.round(0.05 * SR)));
}

// ------------------------------------------------------------------- output

export function wav(samples: Float32Array): Buffer {
  const data = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i++) {
    const v = Math.max(-1, Math.min(1, samples[i]));
    data.writeInt16LE(Math.round(v * 32767), i * 2);
  }
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(SR, 24);
  header.writeUInt32LE(SR * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

/**
 * Writes each sound as a mono 96 kbps MP3 into `outDir` (ffmpeg must be
 * installed) and prints its length and size.
 */
export function writeSounds(
  sounds: Record<string, () => Float32Array>,
  outDir: string,
  tmpPrefix: string,
): void {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), tmpPrefix));
  try {
    for (const [name, make] of Object.entries(sounds)) {
      const samples = make();
      const wavPath = path.join(tmp, `${name}.wav`);
      fs.writeFileSync(wavPath, wav(samples));
      const mp3Path = path.join(outDir, `${name}.mp3`);
      execFileSync(
        "ffmpeg",
        [
          "-y",
          "-loglevel",
          "error",
          "-i",
          wavPath,
          "-codec:a",
          "libmp3lame",
          "-b:a",
          "96k",
          "-ac",
          "1",
          mp3Path,
        ],
        { stdio: "inherit" },
      );
      const kb = Math.round(fs.statSync(mp3Path).size / 1024);
      console.log(
        `${name}.mp3  ${(samples.length / SR).toFixed(2)} s  ${kb} KB`,
      );
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
