/**
 * Synthesizes DeltaFront's airstrike sound effects from nothing: oscillators,
 * seeded noise, filters and envelopes. No samples, no third-party audio, so the
 * output is original DeltaFront audio (see CREDITS.md, "Airstrike audio").
 * Deterministic: the same script always writes the same sounds.
 *
 *   npx tsx scripts/audio/synthesize-airstrike-audio.ts [outDir]
 *
 * Writes mono 44.1 kHz WAV files to a temporary folder and encodes each to MP3
 * with ffmpeg (which must be installed) into `outDir`, by default
 * resources/sounds/effects. Each sound is normalised to -1 dBFS peak.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const SR = 44_100;
const TAU = Math.PI * 2;

// ---------------------------------------------------------------- primitives

/** Seeded PRNG (mulberry32): the same noise on every run. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const buffer = (seconds: number) => new Float32Array(Math.round(seconds * SR));

/** One-pole low-pass coefficient for cutoff `hz`. */
const lpCoef = (hz: number) => 1 - Math.exp((-TAU * hz) / SR);

/** RBJ band-pass biquad, processed in place with a cutoff that may vary per sample. */
function bandpass(
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
function lowpass(x: Float32Array, hzAt: (t: number) => number): Float32Array {
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

function highpass(x: Float32Array, hz: number): Float32Array {
  const low = lowpass(x, () => hz);
  return x.map((v, i) => v - low[i]);
}

function whiteNoise(seconds: number, seed: number): Float32Array {
  const r = rng(seed);
  const b = buffer(seconds);
  for (let i = 0; i < b.length; i++) b[i] = r() * 2 - 1;
  return b;
}

/** Brown(ish) noise: integrated white noise with a leak, for rumble. */
function brownNoise(seconds: number, seed: number): Float32Array {
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
function mixInto(
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

function envelope(x: Float32Array, env: (t: number) => number): Float32Array {
  for (let i = 0; i < x.length; i++) x[i] *= env(i / SR);
  return x;
}

/** Attack-then-exponential-decay envelope. */
const adEnv = (attack: number, decay: number) => (t: number) =>
  t < attack ? t / attack : Math.exp(-(t - attack) / decay);

/** A tone of `freqAt(t)` Hz built from `harmonics` (amplitude per harmonic). */
function tone(
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
function reverb(x: Float32Array, mix: number, size = 1): Float32Array {
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

const softClip = (x: Float32Array, drive: number) =>
  x.map((v) => Math.tanh(v * drive) / Math.tanh(drive));

function fadeOut(x: Float32Array, seconds: number): Float32Array {
  const n = Math.min(x.length, Math.round(seconds * SR));
  for (let i = 0; i < n; i++) x[x.length - 1 - i] *= i / n;
  return x;
}

function fadeIn(x: Float32Array, seconds: number): Float32Array {
  const n = Math.min(x.length, Math.round(seconds * SR));
  for (let i = 0; i < n; i++) x[i] *= i / n;
  return x;
}

function normalize(x: Float32Array, peak = 0.89): Float32Array {
  let max = 0;
  for (const v of x) max = Math.max(max, Math.abs(v));
  return max === 0 ? x : x.map((v) => (v / max) * peak);
}

/** Crops trailing near-silence (below -60 dBFS), keeping a short tail. */
function trim(x: Float32Array): Float32Array {
  let end = x.length;
  while (end > 0 && Math.abs(x[end - 1]) < 0.001) end--;
  return x.slice(0, Math.min(x.length, end + Math.round(0.05 * SR)));
}

// -------------------------------------------------------------- the sounds

/** Air-raid siren: a rich tone sweeping up, holding and falling, twice, far off. */
function siren(): Float32Array {
  const len = 4.6;
  const f = (t: number) => {
    const c = t % 2.3;
    const up = Math.min(1, c / 0.9);
    const down = c > 1.6 ? Math.max(0, 1 - (c - 1.6) / 0.7) : 1;
    const rise = (1 - Math.cos(Math.PI * up)) / 2;
    return 240 + 520 * rise * down + 6 * Math.sin(TAU * 5.5 * t);
  };
  const body = tone(len, f, [1, 0.55, 0.35, 0.2, 0.12, 0.06]);
  // A second rotor slightly detuned, as real sirens beat.
  mixInto(
    body,
    tone(len, (t) => f(t) * 1.012, [0.6, 0.3, 0.15]),
    0,
    0.5,
  );
  envelope(body, (t) => Math.min(1, t / 0.25) * Math.min(1, (len - t) / 0.6));
  const distant = lowpass(softClip(body, 1.6), () => 3200);
  return trim(normalize(reverb(fadeOut(distant, 0.3), 0.45, 1.4)));
}

/** Klaxon: an urgent two-tone alarm for a fast, low pass. */
function klaxon(): Float32Array {
  const len = 2.0;
  const out = buffer(len);
  for (let k = 0; k < 8; k++) {
    const hz = k % 2 === 0 ? 880 : 660;
    const beep = tone(0.22, () => hz, [1, 0, 0.45, 0, 0.25, 0, 0.12]);
    envelope(
      beep,
      (t) => Math.min(1, t / 0.01) * Math.min(1, (0.22 - t) / 0.03),
    );
    mixInto(out, beep, k * 0.24);
  }
  return trim(normalize(reverb(softClip(out, 2), 0.25, 0.8)));
}

/** Jet turbine and roar for `len` seconds; `pitchAt` scales the whine. */
function jet(len: number, seed: number, pitchAt: (t: number) => number) {
  const roar = lowpass(whiteNoise(len, seed), (t) => 900 + 2600 * pitchAt(t));
  const rumble = lowpass(brownNoise(len, seed + 1), () => 260);
  const whine = tone(len, (t) => 1500 * pitchAt(t), [1, 0.3]);
  const out = buffer(len);
  mixInto(out, roar, 0, 1);
  mixInto(out, rumble, 0, 2.2);
  mixInto(out, whine, 0, 0.06);
  return out;
}

/** Take-off: the turbine spooling up and away. */
function launch(): Float32Array {
  const len = 2.6;
  const out = jet(len, 11, (t) => 0.55 + 0.45 * Math.min(1, t / 1.6));
  envelope(
    out,
    (t) => Math.min(1, t / 0.5) * Math.exp(-Math.max(0, t - 1.2) / 0.6),
  );
  return trim(normalize(reverb(fadeOut(out, 0.5), 0.2)));
}

/** A low, fast pass overhead: the roar swells, the pitch drops past you. */
function flyby(): Float32Array {
  const len = 3.4;
  const peak = 1.5;
  const doppler = (t: number) => 0.62 + 0.38 / (1 + Math.exp((t - peak) * 3.2));
  const out = jet(len, 21, doppler);
  envelope(out, (t) => 1 / (1 + ((t - peak) / 0.45) ** 2));
  return trim(normalize(reverb(fadeOut(softClip(out, 1.4), 0.6), 0.22)));
}

/** A bomb falling: a descending whistle, rising in level as it nears. */
function bombFall(): Float32Array {
  const len = 1.1;
  const whistle = tone(len, (t) => 1500 - 900 * (t / len) ** 1.3, [1, 0.12]);
  const air = bandpass(whiteNoise(len, 31), (t) => 1400 - 700 * (t / len), 6);
  const out = buffer(len);
  mixInto(out, whistle, 0, 0.5);
  mixInto(out, air, 0, 1.6);
  envelope(out, (t) => 0.25 + 0.75 * (t / len) ** 1.5);
  fadeIn(out, 0.08);
  return normalize(out, 0.7);
}

/** One explosion: transient crack, sub thump, rumble and debris. */
function blast(
  len: number,
  seed: number,
  opts: { sub: number; rumble: number; bright: number; debris: number },
): Float32Array {
  const out = buffer(len);
  const crack = highpass(whiteNoise(0.06, seed), 900);
  envelope(crack, adEnv(0.0008, 0.012));
  mixInto(out, crack, 0, opts.bright);
  const thump = tone(0.9, (t) => 30 + 45 * Math.exp(-t / 0.08), [1, 0.4]);
  envelope(thump, adEnv(0.002, 0.28));
  mixInto(out, thump, 0, opts.sub);
  const body = lowpass(
    whiteNoise(len, seed + 1),
    (t) => 200 + 2500 * Math.exp(-t / 0.18),
  );
  envelope(body, adEnv(0.004, 0.35));
  mixInto(out, body, 0, 1.2);
  const rumble = lowpass(brownNoise(len, seed + 2), () => 160);
  envelope(rumble, adEnv(0.02, len / 3));
  mixInto(out, rumble, 0, opts.rumble);
  // Debris and crackle: short clicks, thinning out.
  const r = rng(seed + 3);
  for (let k = 0; k < opts.debris; k++) {
    const at = 0.08 + r() ** 2 * (len * 0.7);
    const click = highpass(whiteNoise(0.012, seed + 10 + k), 1800);
    envelope(click, adEnv(0.0005, 0.003));
    mixInto(out, click, at, 0.25 * (1 - at / len) * (0.4 + r()));
  }
  return fadeOut(softClip(out, 1.8), len * 0.35);
}

/** The heavy bombing impact: two close detonations and a long tail. */
function bombImpact(): Float32Array {
  const len = 4.2;
  const out = buffer(len);
  mixInto(
    out,
    blast(len, 41, { sub: 1.4, rumble: 3.2, bright: 0.8, debris: 70 }),
  );
  mixInto(
    out,
    blast(3.2, 51, { sub: 1.0, rumble: 2.0, bright: 0.5, debris: 30 }),
    0.18,
    0.7,
  );
  return trim(normalize(reverb(fadeOut(out, 1.2), 0.3, 1.2)));
}

/** Rockets leaving the rails: two bright whooshes. */
function rocketLaunch(): Float32Array {
  const len = 1.4;
  const out = buffer(len);
  for (const [at, seed] of [
    [0, 61],
    [0.16, 62],
  ]) {
    const w = bandpass(
      whiteNoise(1.1, seed),
      (t) => 700 + 3800 * Math.min(1, t / 0.6),
      2.2,
    );
    envelope(w, (t) => Math.min(1, t / 0.03) * Math.exp(-t / 0.35));
    const hiss = highpass(whiteNoise(1.1, seed + 5), 4000);
    envelope(hiss, adEnv(0.01, 0.25));
    mixInto(out, w, at, 1.4);
    mixInto(out, hiss, at, 0.35);
  }
  return trim(normalize(reverb(fadeOut(out, 0.3), 0.18)));
}

/** Rocket impacts: three sharp, bright detonations in quick succession. */
function rocketImpact(): Float32Array {
  const len = 2.8;
  const out = buffer(len);
  for (const [at, seed, g] of [
    [0, 71, 1],
    [0.11, 72, 0.85],
    [0.26, 73, 0.9],
  ]) {
    mixInto(
      out,
      blast(2.2, seed, { sub: 0.7, rumble: 1.2, bright: 1.3, debris: 25 }),
      at,
      g,
    );
  }
  return trim(normalize(reverb(fadeOut(out, 0.6), 0.25)));
}

/**
 * The strafing run's gun: rounds at about 65 a second fuse into one tearing
 * "BRRRRT", then the hits crackle down the line.
 */
function strafe(): Float32Array {
  const len = 1.25;
  const fire = 0.72;
  const rate = 65;
  const out = buffer(len);
  const r = rng(81);
  for (let k = 0; k < Math.floor(fire * rate); k++) {
    const at = k / rate + (r() - 0.5) * 0.0015;
    const round = buffer(0.03);
    const n = whiteNoise(0.03, 100 + k);
    for (let i = 0; i < round.length; i++) {
      const t = i / SR;
      round[i] =
        n[i] * Math.exp(-t / 0.004) +
        Math.sin(TAU * 95 * t) * Math.exp(-t / 0.012) * 1.4;
    }
    mixInto(out, round, at, 0.8 + 0.2 * r());
  }
  // The buzz of the firing rate itself, and the motor.
  const buzz = tone(fire, () => rate, [1, 0.7, 0.5, 0.35, 0.25, 0.18, 0.12]);
  envelope(buzz, (t) => Math.min(1, t / 0.02) * Math.min(1, (fire - t) / 0.03));
  mixInto(out, buzz, 0, 0.5);
  // Hits down range.
  for (let k = 0; k < 26; k++) {
    const at = 0.15 + r() * (fire + 0.25);
    const hit = highpass(whiteNoise(0.02, 300 + k), 1200);
    envelope(hit, adEnv(0.0005, 0.006));
    mixInto(out, hit, at, 0.35);
  }
  const shaped = lowpass(softClip(out, 2.4), () => 6500);
  return trim(normalize(reverb(fadeOut(shaped, 0.2), 0.2, 0.9)));
}

/** Aftermath: a fire burning down, crackles thinning, fading out. */
function fire(): Float32Array {
  const len = 9;
  const out = buffer(len);
  const roar = lowpass(brownNoise(len, 91), () => 420);
  mixInto(out, roar, 0, 1.6);
  const hush = bandpass(whiteNoise(len, 92), () => 900, 0.7);
  mixInto(out, hush, 0, 0.18);
  const r = rng(93);
  let t = 0.05;
  while (t < len) {
    const pop = highpass(
      whiteNoise(0.02, Math.floor(t * 1000) + 500),
      1500 + r() * 2500,
    );
    envelope(pop, adEnv(0.0003, 0.002 + r() * 0.004));
    mixInto(out, pop, t, 0.15 + 0.5 * r() ** 2);
    t += -Math.log(1 - r()) * (0.035 + 0.1 * (t / len));
  }
  envelope(
    out,
    (s) =>
      Math.min(1, s / 0.4) * (s < 3 ? 1 : Math.max(0, 1 - (s - 3) / 6) ** 1.4),
  );
  return fadeOut(normalize(out, 0.55), 0.3);
}

// ------------------------------------------------------------------ output

const SOUNDS: Record<string, () => Float32Array> = {
  "airstrike-siren": siren,
  "airstrike-klaxon": klaxon,
  "airstrike-launch": launch,
  "airstrike-flyby": flyby,
  "airstrike-bomb-fall": bombFall,
  "airstrike-bomb": bombImpact,
  "airstrike-rocket-launch": rocketLaunch,
  "airstrike-rocket-impact": rocketImpact,
  "airstrike-strafe": strafe,
  "airstrike-fire": fire,
};

function wav(samples: Float32Array): Buffer {
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

function main(): void {
  const outDir = path.resolve(process.argv[2] ?? "resources/sounds/effects");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "df-airstrike-audio-"));
  try {
    for (const [name, make] of Object.entries(SOUNDS)) {
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

main();
