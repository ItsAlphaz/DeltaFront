/**
 * Airstrike impact effects: the blast, the fires and smoke that burn on for
 * 40-50 s, and the casualty numbers. The GL passes are driven through their
 * real methods with the GL-free state they touch.
 */

import { UnitType } from "@openfront/engine-api/game/GameTypes";
import { AirstrikeImpactPhase } from "@openfront/engine-api/game/GameUpdates";
import { describe, expect, it } from "vitest";
import {
  airstrikeSeverity,
  FX_MINI_BIG_SMOKE,
  FX_MINI_FIRE,
  FX_MINI_SMOKE_FIRE,
  FxSpritePass,
} from "../../../src/client/render/gl/passes/fx-pass/FxSpritePass";
import {
  CASUALTY_LIFETIME_MS,
  casualtyScaleFactor,
  MAX_CASUALTY_POPUPS,
  WorldTextPass,
} from "../../../src/client/render/gl/passes/WorldTextPass";
import settingsJson from "../../../src/client/render/gl/render-settings.json";
import type { AirstrikeImpactFx } from "../../../src/client/render/types";

const fxSettings = settingsJson.fx;

interface Sprite {
  x: number;
  y: number;
  fxType: number;
  startMs: number;
  lifetimeMs: number;
  linger?: boolean;
}

function spritePass(nowRef: { t: number }) {
  const pass = Object.create(FxSpritePass.prototype) as FxSpritePass;
  const f32 = new Float32Array(4096 * 4);
  Object.assign(pass, {
    activeFx: [] as Sprite[],
    settings: { fx: fxSettings },
    config: { msPerTick: () => 100 },
    timeFn: () => nowRef.t,
    instanceBuf: {
      float32: f32,
      uint8: new Uint8Array(f32.buffer),
      ensureCapacity: () => {},
    },
  });
  return pass;
}
const sprites = (p: FxSpritePass) =>
  (p as unknown as { activeFx: Sprite[] }).activeFx;
const lingering = (p: FxSpritePass) => sprites(p).filter((s) => s.linger);

const event = (over: Partial<AirstrikeImpactFx>): AirstrikeImpactFx => ({
  phase: AirstrikeImpactPhase.BombImpact,
  strikeType: UnitType.BombingRun,
  fromX: 100,
  fromY: 100,
  toX: 100,
  toY: 100,
  radius: 10,
  attackerID: 1,
  killed: 5_000,
  cityLevel: 0,
  levels: 0,
  ...over,
});

describe("airstrike fires and smoke", () => {
  it("burn for about 45 s after a bombing run, 50 s after rockets, 40 s after strafing", () => {
    const cases = [
      [AirstrikeImpactPhase.BombImpact, fxSettings.airstrikeBombFireLifetimeMs],
      [
        AirstrikeImpactPhase.RocketImpact,
        fxSettings.airstrikeRocketFireLifetimeMs,
      ],
      [
        AirstrikeImpactPhase.StrafeBurst,
        fxSettings.airstrikeStrafeFireLifetimeMs,
      ],
    ] as const;
    expect(cases.map(([, ms]) => ms)).toEqual([45_000, 50_000, 40_000]);
    for (const [phase, ms] of cases) {
      const now = { t: 1_000 };
      const p = spritePass(now);
      p.spawnAirstrikeImpact(
        event({ phase, fromX: 80, toX: 110, radius: phase === 3 ? 2 : 10 }),
        now.t,
      );
      const patches = lingering(p);
      expect(patches.length).toBeGreaterThan(0);
      for (const s of patches) {
        // Each varies a little (+-15%) so the area burns out gradually.
        expect(s.lifetimeMs).toBeGreaterThanOrEqual(ms * 0.85);
        expect(s.lifetimeMs).toBeLessThanOrEqual(ms * 1.15);
        // Fires catch within the first second and a half.
        expect(s.startMs - now.t).toBeLessThanOrEqual(1_500);
        // Several small patches, near the strike, not one big overlay.
        expect(Math.abs(s.x - 100)).toBeLessThanOrEqual(30);
      }
    }
  });

  it("burn where the damage was, more of them the worse it was, more over a city", () => {
    const count = (over: Partial<AirstrikeImpactFx>) => {
      const now = { t: 0 };
      const p = spritePass(now);
      p.spawnAirstrikeImpact(event(over), 0);
      return lingering(p).filter(
        (s) => s.fxType === FX_MINI_FIRE || s.fxType === FX_MINI_SMOKE_FIRE,
      ).length;
    };
    const light = count({ killed: 200 });
    const heavy = count({ killed: 80_000 });
    const city = count({ killed: 80_000, cityLevel: 3 });
    expect(heavy).toBeGreaterThan(light);
    expect(city).toBeGreaterThan(heavy);
    // Nothing killed, nothing damaged: no fire at all.
    expect(count({ killed: 0, levels: 0 })).toBe(0);
  });

  it("go out on time and clean themselves up", () => {
    const now = { t: 0 };
    const p = spritePass(now);
    p.spawnAirstrikeImpact(event({}), 0);
    expect(lingering(p).length).toBeGreaterThan(0);
    now.t = 30_000;
    p.tick();
    expect(lingering(p).length).toBeGreaterThan(0);
    now.t = 45_000 * 1.15 + 1_600;
    p.tick();
    expect(sprites(p)).toHaveLength(0);
  });

  it("are refreshed by a strike on the same spot, never piled up", () => {
    const now = { t: 0 };
    const p = spritePass(now);
    p.spawnAirstrikeImpact(event({}), 0);
    const first = lingering(p).length;
    for (let i = 1; i <= 10; i++) {
      now.t = i * 2_000;
      p.spawnAirstrikeImpact(event({}), now.t);
    }
    // The same event hashes to the same spots: each repeat refreshes them.
    expect(lingering(p).length).toBe(first);
    // ...and they now burn on from the last strike.
    const end = Math.max(...lingering(p).map((s) => s.startMs + s.lifetimeMs));
    expect(end).toBeGreaterThan(20_000 + 45_000 * 0.85);
  });

  it("never exceed the cap, however many strikes land", () => {
    const now = { t: 0 };
    const p = spritePass(now);
    for (let i = 0; i < 200; i++) {
      p.spawnAirstrikeImpact(
        event({ toX: 20 + (i % 20) * 30, toY: 20 + Math.floor(i / 20) * 30 }),
        now.t,
      );
    }
    expect(lingering(p).length).toBeLessThanOrEqual(
      fxSettings.airstrikeMaxLingering,
    );
    expect(sprites(p).some((s) => s.fxType === FX_MINI_BIG_SMOKE)).toBe(true);
  });

  it("draws a staggered blast only once it has started", () => {
    const now = { t: 0 };
    const p = spritePass(now);
    p.spawnAirstrikeImpact(
      event({ phase: AirstrikeImpactPhase.RocketImpact }),
      0,
    );
    p.tick();
    const later = sprites(p).filter((s) => s.startMs > 0);
    expect(later.length).toBeGreaterThan(0);
    const buf = (p as unknown as { instanceBuf: { uint8: Uint8Array } })
      .instanceBuf.uint8;
    const idx = sprites(p).indexOf(later[0]);
    expect(buf[idx * 16 + 13]).toBe(0); // alpha: not visible yet
  });

  it("severity grows with casualties and structure damage, within 0..1", () => {
    expect(airstrikeSeverity(0, 0)).toBe(0);
    expect(airstrikeSeverity(1_000, 0)).toBeGreaterThan(0);
    expect(airstrikeSeverity(100_000, 0)).toBeGreaterThan(
      airstrikeSeverity(1_000, 0),
    );
    expect(airstrikeSeverity(10_000_000, 9)).toBe(1);
  });
});

// ── casualty numbers ────────────────────────────────────────────────────────

interface Popup {
  text: string;
  scale: number;
  x: number;
  y: number;
  startMs: number;
  colorG: number;
  casualty?: { key: string; killed: number; detail: boolean };
}

function textPass(nowRef: { t: number }) {
  const pass = Object.create(WorldTextPass.prototype) as WorldTextPass;
  Object.assign(pass, {
    active: [] as Popup[],
    config: { msPerTick: () => 100 },
    timeFn: () => nowRef.t,
  });
  return pass;
}
const popups = (p: WorldTextPass) =>
  (p as unknown as { active: Popup[] }).active;

const casualty = (killed: number, over: Partial<AirstrikeImpactFx> = {}) =>
  event({
    killed,
    casualtyText: `-${killed.toLocaleString("en-US")} troops`,
    detailText: null,
    ...over,
  });

describe("airstrike casualty numbers", () => {
  it("show the troops the strike really killed, with thousands separators", () => {
    const p = textPass({ t: 0 });
    p.applyAirstrikeCasualties([casualty(4_250)]);
    expect(popups(p).map((x) => x.text)).toEqual(["-4,250 troops"]);
  });

  it("show nothing for a strike that killed nobody and damaged nothing", () => {
    const p = textPass({ t: 0 });
    p.applyAirstrikeCasualties([
      event({ killed: 0, casualtyText: null, detailText: null }),
    ]);
    expect(popups(p)).toHaveLength(0);
  });

  it("add a strafing run's bursts up into one number", () => {
    const now = { t: 0 };
    const p = textPass(now);
    const burst = (k: number, x: number) =>
      casualty(k, {
        phase: AirstrikeImpactPhase.StrafeBurst,
        strikeType: UnitType.StrafingRun,
        toX: x,
      });
    p.applyAirstrikeCasualties([burst(1_000, 100)]);
    now.t = 500;
    p.applyAirstrikeCasualties([burst(2_500, 110)]);
    now.t = 1_000;
    p.applyAirstrikeCasualties([burst(1_250, 120), burst(1_000, 130)]);
    expect(popups(p).map((x) => x.text)).toEqual(["-5,750 troops"]);
  });

  it("keep separate strikes apart", () => {
    const p = textPass({ t: 0 });
    p.applyAirstrikeCasualties([
      casualty(1_000, { attackerID: 1 }),
      casualty(2_000, { attackerID: 2 }),
      casualty(3_000, { attackerID: 1, toX: 400 }),
    ]);
    expect(popups(p)).toHaveLength(3);
  });

  it("are bigger for heavier losses and for city garrisons, within bounds", () => {
    expect(casualtyScaleFactor(12_800, false)).toBeGreaterThan(
      casualtyScaleFactor(1_000, false),
    );
    expect(casualtyScaleFactor(1_000, true)).toBeGreaterThan(
      casualtyScaleFactor(1_000, false),
    );
    expect(casualtyScaleFactor(10, false)).toBeGreaterThanOrEqual(0.85);
    expect(casualtyScaleFactor(1e9, true)).toBeLessThanOrEqual(1.9);
  });

  it("mark a city garrison hit with its own line and a hotter colour", () => {
    const p = textPass({ t: 0 });
    p.applyAirstrikeCasualties([
      casualty(12_800, { cityLevel: 3, detailText: "City garrison hit" }),
    ]);
    const [number, detail] = popups(p);
    expect(number.text).toBe("-12,800 troops");
    expect(detail.text).toBe("City garrison hit");
    expect(number.colorG).toBeGreaterThan(0.4); // orange, not red
  });

  it("show structure damage apart from troop losses", () => {
    const p = textPass({ t: 0 });
    p.applyAirstrikeCasualties([
      event({
        killed: 0,
        levels: 2,
        casualtyText: null,
        detailText: "-2 building levels",
      }),
    ]);
    expect(popups(p).map((x) => x.text)).toEqual(["-2 building levels"]);
  });

  it("never pile up: at most a fixed number, the oldest go first", () => {
    const now = { t: 0 };
    const p = textPass(now);
    for (let i = 0; i < 60; i++) {
      now.t = i;
      p.applyAirstrikeCasualties([casualty(1_000, { attackerID: i })]);
    }
    expect(popups(p).length).toBe(MAX_CASUALTY_POPUPS);
    expect(Math.min(...popups(p).map((x) => x.startMs))).toBe(
      60 - MAX_CASUALTY_POPUPS,
    );
  });

  it("are not shown for an event older than their lifetime (seeking)", () => {
    const p = textPass({ t: 10_000 });
    p.applyAirstrikeCasualties([
      casualty(1_000, { tickAge: CASUALTY_LIFETIME_MS / 100 + 1 }),
    ]);
    expect(popups(p)).toHaveLength(0);
  });
});
