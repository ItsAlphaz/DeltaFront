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
import path from "node:path";
import {
  SR,
  TAU,
  adEnv,
  bandpass,
  brownNoise,
  buffer,
  envelope,
  fadeIn,
  fadeOut,
  highpass,
  lowpass,
  mixInto,
  normalize,
  reverb,
  rng,
  softClip,
  tone,
  trim,
  whiteNoise,
  writeSounds,
} from "./dsp";

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

function main(): void {
  const outDir = path.resolve(process.argv[2] ?? "resources/sounds/effects");
  writeSounds(SOUNDS, outDir, "df-airstrike-audio-");
}

main();
