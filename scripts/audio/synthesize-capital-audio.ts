/**
 * Synthesizes DeltaFront's Capital System sound effects from nothing:
 * oscillators, seeded noise, filters and envelopes (scripts/audio/dsp.ts). No
 * samples, no third-party audio, so the output is original DeltaFront audio
 * (see CREDITS.md, "Capital and CRISIS audio"). Deterministic: the same script
 * always writes the same sounds.
 *
 *   npx tsx scripts/audio/synthesize-capital-audio.ts [outDir]
 *
 * Writes into `outDir`, by default resources/sounds/effects (ffmpeg required).
 * The player who captures a capital hears existing cues (conquered, ka-ching);
 * these three are the defender's: the fall, the one-minute warning, the end.
 */
import path from "node:path";
import {
  adEnv,
  bandpass,
  buffer,
  envelope,
  fadeOut,
  lowpass,
  mixInto,
  normalize,
  reverb,
  softClip,
  tone,
  trim,
  whiteNoise,
  writeSounds,
} from "./dsp";

/**
 * YOUR CAPITAL HAS FALLEN: a deep impact, a low minor chord that sinks, and a
 * twice-falling alarm over it. Heavy and short: it is a blow, not a jingle.
 */
function capitalLost(): Float32Array {
  const out = buffer(3.6);

  // The blow: a sub boom falling from ~100 Hz to ~28 Hz, and a dull thud.
  const boom = envelope(
    tone(1.8, (t) => 28 + 72 * Math.exp(-t * 7), [1, 0.35]),
    adEnv(0.004, 0.6),
  );
  mixInto(out, boom, 0, 1);
  const thud = envelope(
    lowpass(whiteNoise(0.6, 11), (t) => 90 + 520 * Math.exp(-t * 9)),
    adEnv(0.002, 0.1),
  );
  mixInto(out, thud, 0, 1.1);

  // The weight: E minor from the cellos' range, each note sagging a little.
  for (const [hz, gain] of [
    [82.41, 0.5],
    [98.0, 0.42],
    [123.47, 0.32],
    [164.81, 0.24],
  ]) {
    const note = tone(
      2.9,
      (t) => hz * (1 - 0.03 * Math.min(1, t / 1.6)),
      [1, 0.5, 0.33, 0.22, 0.15],
    );
    envelope(note, (t) => (t < 0.2 ? t / 0.2 : Math.exp(-(t - 0.2) / 1.15)));
    fadeOut(note, 0.4); // end on silence, not on a click
    mixInto(
      out,
      lowpass(note, (t) => 1_400 - 700 * Math.min(1, t / 2)),
      0.1,
      gain * 0.34,
    );
  }

  // The alarm: a sawtooth-ish voice falling from 560 to 390 Hz, twice.
  for (const at of [0.75, 1.5]) {
    const alarm = tone(
      0.66,
      (t) => 560 - 170 * Math.min(1, t / 0.52),
      [1, 0.45, 0.3, 0.2, 0.12, 0.08],
    );
    envelope(
      alarm,
      (t) =>
        Math.min(1, t / 0.015) *
        (t < 0.52 ? 1 : Math.max(0, 1 - (t - 0.52) / 0.14)),
    );
    mixInto(
      out,
      bandpass(
        lowpass(alarm, () => 2_600),
        (t) => 1_100 - 200 * t,
        0.6,
      ),
      at,
      0.5,
    );
  }

  return normalize(trim(fadeOut(reverb(softClip(out, 1.4), 0.26, 1.4), 0.5)));
}

/** One minute left: a quick two-tone alert, twice. Sharp, not scary. */
function crisisWarning(): Float32Array {
  const out = buffer(1.6);
  for (const at of [0, 0.5]) {
    for (const [offset, hz] of [
      [0, 880],
      [0.17, 660],
    ] as const) {
      const beep = envelope(
        tone(0.2, () => hz, [1, 0.3, 0.12]),
        (t) => Math.min(1, t / 0.01) * Math.max(0, 1 - t / 0.2),
      );
      mixInto(out, beep, at + offset, 0.7);
    }
  }
  return normalize(trim(fadeOut(reverb(out, 0.18, 0.8), 0.25)));
}

/** The crisis is over: three soft notes rising and settling. */
function crisisOver(): Float32Array {
  const out = buffer(2.4);
  for (const [at, hz, gain] of [
    [0, 261.63, 0.6],
    [0.28, 392.0, 0.55],
    [0.56, 523.25, 0.5],
  ] as const) {
    const note = envelope(
      tone(1.7, () => hz, [1, 0.25, 0.08]),
      (t) => (t < 0.03 ? t / 0.03 : Math.exp(-(t - 0.03) / 0.7)),
    );
    fadeOut(note, 0.35); // end on silence, not on a click
    mixInto(out, note, at, gain);
  }
  return normalize(trim(fadeOut(reverb(out, 0.3, 1.2), 0.6)));
}

const SOUNDS: Record<string, () => Float32Array> = {
  "crisis-capital-lost": capitalLost,
  "crisis-warning": crisisWarning,
  "crisis-over": crisisOver,
};

function main(): void {
  const outDir = path.resolve(process.argv[2] ?? "resources/sounds/effects");
  writeSounds(SOUNDS, outDir, "df-capital-audio-");
}

main();
