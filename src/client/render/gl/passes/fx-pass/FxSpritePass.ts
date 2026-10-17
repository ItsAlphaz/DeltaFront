/**
 * FxSpritePass — instanced textured quads sampling an animated sprite atlas.
 *
 * Manages: sprite FX state (explosions, dust, conquest, debris).
 * Atlas layout: 12 horizontal sprite strips stacked vertically.
 * Pre-built by generate-sprite-atlases.mjs.
 */

import { AirstrikeImpactPhase } from "@openfront/engine-api/game/GameUpdates";
import type { Config } from "@openfront/engine-lib/configuration/Config";
import type {
  AirstrikeImpactFx,
  ConquestFx,
  DeadUnitFx,
  RendererConfig,
} from "../../../types";
import {
  AIRCRAFT_TYPES,
  STRUCTURE_TYPES,
  UT_SHELL,
  UT_TRAIN,
  UT_WARSHIP,
} from "../../../types";
import { DynamicInstanceBuffer } from "../../DynamicBuffer";
import type { RenderSettings } from "../../RenderSettings";
import { createProgram, shaderSrc } from "../../utils/GlUtils";
import { nukeExplosionRadius } from "./FxSettings";

import { assetUrl } from "@openfront/shared/AssetUrls";
import fxAtlasMeta from "resources/atlases/fx-atlas-meta.json";

import spriteFragSrc from "../../shaders/fx/sprite.frag.glsl?raw";
import spriteVertSrc from "../../shaders/fx/sprite.vert.glsl?raw";

const fxAtlasUrl = assetUrl("atlases/fx-atlas.png");

// ---------------------------------------------------------------------------
// FX type indices (atlas row)
// ---------------------------------------------------------------------------

export const FX_NUKE = 0;
export const FX_SAM_EXPLOSION = 1;
export const FX_BUILDING_EXPLOSION = 2;
export const FX_UNIT_EXPLOSION = 3;
export const FX_MINI_EXPLOSION = 4;
export const FX_SINKING_SHIP = 5;
export const FX_MINI_FIRE = 6;
export const FX_MINI_SMOKE = 7;
export const FX_MINI_BIG_SMOKE = 8;
export const FX_MINI_SMOKE_FIRE = 9;
export const FX_DUST = 10;
export const FX_CONQUEST = 11;
const FX_TYPE_COUNT = 12;

// ---------------------------------------------------------------------------
// FX sprite config (matches AnimatedSpriteLoader)
// ---------------------------------------------------------------------------

interface FxTypeConfig {
  frameWidth: number;
  frameCount: number;
  frameDurationMs: number;
  looping: boolean;
}

const FX_CONFIG: FxTypeConfig[] = [
  /* 0 Nuke          */ {
    frameWidth: 60,
    frameCount: 9,
    frameDurationMs: 70,
    looping: false,
  },
  /* 1 SAMExplosion   */ {
    frameWidth: 48,
    frameCount: 9,
    frameDurationMs: 70,
    looping: false,
  },
  /* 2 BuildingExpl   */ {
    frameWidth: 17,
    frameCount: 10,
    frameDurationMs: 70,
    looping: false,
  },
  /* 3 UnitExplosion  */ {
    frameWidth: 19,
    frameCount: 4,
    frameDurationMs: 70,
    looping: false,
  },
  /* 4 MiniExplosion  */ {
    frameWidth: 13,
    frameCount: 4,
    frameDurationMs: 70,
    looping: false,
  },
  /* 5 SinkingShip    */ {
    frameWidth: 16,
    frameCount: 14,
    frameDurationMs: 90,
    looping: false,
  },
  /* 6 MiniFire       */ {
    frameWidth: 7,
    frameCount: 6,
    frameDurationMs: 100,
    looping: true,
  },
  /* 7 MiniSmoke      */ {
    frameWidth: 11,
    frameCount: 4,
    frameDurationMs: 120,
    looping: true,
  },
  /* 8 MiniBigSmoke   */ {
    frameWidth: 24,
    frameCount: 5,
    frameDurationMs: 120,
    looping: true,
  },
  /* 9 MiniSmokeFire  */ {
    frameWidth: 24,
    frameCount: 5,
    frameDurationMs: 120,
    looping: true,
  },
  /* 10 Dust          */ {
    frameWidth: 9,
    frameCount: 3,
    frameDurationMs: 100,
    looping: false,
  },
  /* 11 Conquest      */ {
    frameWidth: 21,
    frameCount: 10,
    frameDurationMs: 90,
    looping: false,
  },
];

// ---------------------------------------------------------------------------
// Nuke debris plan
// ---------------------------------------------------------------------------

const DEBRIS_PLAN = [
  { type: FX_MINI_FIRE, radiusFactor: 1.0, density: 1 / 25 },
  { type: FX_MINI_SMOKE, radiusFactor: 1.0, density: 1 / 28 },
  { type: FX_MINI_BIG_SMOKE, radiusFactor: 0.9, density: 1 / 70 },
  { type: FX_MINI_SMOKE_FIRE, radiusFactor: 0.9, density: 1 / 70 },
];

/** Deterministic float in [0,1) from an integer seed (mulberry32). */
function seededRandom(seed: number): number {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

// ---------------------------------------------------------------------------
// Active FX state
// ---------------------------------------------------------------------------

interface ActiveFx {
  x: number;
  y: number;
  fxType: number;
  startMs: number;
  lifetimeMs: number;
  fadeIn: number; // fraction 0–1 (start of full alpha)
  fadeOut: number; // fraction 0–1 (start of fade out)
  /** An airstrike's lingering fire or smoke patch (capped, refreshed in place). */
  linger?: boolean;
}

/** How bad an airstrike hit was, 0..1, from what it really did. */
export function airstrikeSeverity(killed: number, levels: number): number {
  const score = Math.max(0, killed) + Math.max(0, levels) * 20_000;
  if (score <= 0) return 0;
  return Math.min(1, Math.max(0, Math.log10(score) - 2) / 3);
}

/** A repeat strike within this many tiles of a burning patch refreshes it. */
const LINGER_REFRESH_TILES = 2;

// ---------------------------------------------------------------------------
// Instance data layout
// ---------------------------------------------------------------------------

const SPRITE_FLOATS = 4; // x, y, fxType, [frameIdx u8, alpha u8, pad, pad]
const SPRITE_BYTES = 16;

// ---------------------------------------------------------------------------
// FxSpritePass
// ---------------------------------------------------------------------------

export class FxSpritePass {
  private gl: WebGL2RenderingContext;
  private mapW: number;
  private settings: RenderSettings;

  private program: WebGLProgram;
  private uCamera: WebGLUniformLocation;
  private uFxUV: WebGLUniformLocation;
  private uFxWorld: WebGLUniformLocation;
  private vao: WebGLVertexArrayObject;
  private instanceBuf: DynamicInstanceBuffer;
  private spriteCount = 0;
  private atlasTex: WebGLTexture;
  private atlasReady = false;

  private activeFx: ActiveFx[] = [];
  private timeFn: () => number = () => performance.now();

  constructor(
    gl: WebGL2RenderingContext,
    header: RendererConfig,
    settings: RenderSettings,
    private config: Config,
  ) {
    this.gl = gl;
    this.mapW = header.mapWidth;
    this.settings = settings;

    this.program = createProgram(
      gl,
      shaderSrc(spriteVertSrc, { FX_TYPE_COUNT }),
      spriteFragSrc,
      "FxSpritePass",
    );
    this.uCamera = gl.getUniformLocation(this.program, "uCamera")!;
    this.uFxUV = gl.getUniformLocation(this.program, "uFxUV")!;
    this.uFxWorld = gl.getUniformLocation(this.program, "uFxWorld")!;
    gl.useProgram(this.program);
    gl.uniform1i(gl.getUniformLocation(this.program, "uAtlas"), 0);

    // Placeholder atlas (1x1 transparent)
    this.atlasTex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.atlasTex);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA,
      1,
      1,
      0,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      new Uint8Array([0, 0, 0, 0]),
    );
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    // Instance buffer
    const glBuf = gl.createBuffer()!;
    this.instanceBuf = new DynamicInstanceBuffer(gl, glBuf, 256, SPRITE_FLOATS);

    // VAO
    this.vao = gl.createVertexArray()!;
    gl.bindVertexArray(this.vao);

    const quadBuf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([0, 0, 1, 0, 0, 1, 1, 0, 1, 1, 0, 1]),
      gl.STATIC_DRAW,
    );
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    gl.bindBuffer(gl.ARRAY_BUFFER, glBuf);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 3, gl.FLOAT, false, SPRITE_BYTES, 0);
    gl.vertexAttribDivisor(1, 1);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 2, gl.UNSIGNED_BYTE, false, SPRITE_BYTES, 12);
    gl.vertexAttribDivisor(2, 1);

    gl.bindVertexArray(null);

    this.loadAtlas();
  }

  // -------------------------------------------------------------------------
  // Atlas loading
  // -------------------------------------------------------------------------

  private isDisposed = false;

  private async loadAtlas(): Promise<void> {
    try {
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.src = fxAtlasUrl;
      await img.decode();
      if (this.isDisposed) return;
      const gl = this.gl;

      gl.bindTexture(gl.TEXTURE_2D, this.atlasTex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);

      const meta = fxAtlasMeta;
      const uvData = new Float32Array(FX_TYPE_COUNT * 4);
      const worldData = new Float32Array(FX_TYPE_COUNT * 4);

      for (let i = 0; i < FX_TYPE_COUNT; i++) {
        const row = meta.rows[i];
        uvData[i * 4 + 0] = row.yOffset / meta.height;
        uvData[i * 4 + 1] = row.height / meta.height;
        uvData[i * 4 + 2] = row.worldWidth / meta.width;
        uvData[i * 4 + 3] = 0;
        worldData[i * 4 + 0] = row.worldWidth;
        worldData[i * 4 + 1] = row.worldHeight;
        worldData[i * 4 + 2] = 0;
        worldData[i * 4 + 3] = 0;
      }

      gl.useProgram(this.program);
      gl.uniform4fv(this.uFxUV, uvData);
      gl.uniform4fv(this.uFxWorld, worldData);

      this.atlasReady = true;
    } catch (e) {
      console.warn("Failed to load fx atlas:", e);
    }
  }

  // -------------------------------------------------------------------------
  // Spawning
  // -------------------------------------------------------------------------

  applyRailroadDust(tileRefs: number[]): void {
    const now = this.timeFn();
    for (const ref of tileRefs) {
      if (Math.random() > 0.33) continue;
      const x = ref % this.mapW;
      const y = (ref - x) / this.mapW;
      this.pushFx(x, y, FX_DUST, now);
    }
  }

  applyConquestEvents(events: ConquestFx[]): void {
    const now = this.timeFn();
    const fx = this.settings.fx;
    for (const evt of events) {
      const startMs = now - (evt.tickAge ?? 0) * this.config.msPerTick();
      if (now - startMs >= fx.conquestLifetimeMs) continue;
      this.activeFx.push({
        x: evt.x,
        y: evt.y,
        fxType: FX_CONQUEST,
        startMs,
        lifetimeMs: fx.conquestLifetimeMs,
        fadeIn: fx.conquestFadeIn,
        fadeOut: fx.conquestFadeOut,
      });
    }
  }

  /**
   * Spawn sprite FX for a dead unit. Returns the nuke radius if a nuke
   * exploded (so the orchestrator can also spawn a shockwave), or null.
   */
  spawnFxForUnit(unit: DeadUnitFx, now: number): void {
    const typeName = unit.unitType;
    const x = unit.pos % this.mapW;
    const y = (unit.pos - x) / this.mapW;

    const nukeRadius = nukeExplosionRadius(this.settings.fx, typeName);
    if (nukeRadius !== undefined) {
      if (unit.reachedTarget) {
        this.spawnNukeSprites(x, y, nukeRadius, now, unit.pos);
      } else {
        this.pushFx(x, y, FX_SAM_EXPLOSION, now);
      }
      return;
    }

    if (typeName === UT_WARSHIP) {
      this.pushFx(x, y, FX_UNIT_EXPLOSION, now);
      this.pushFx(x, y, FX_SINKING_SHIP, now);
      return;
    }

    if (AIRCRAFT_TYPES.has(typeName)) {
      // An aircraft that delivered its attack leaves quietly (the impact
      // effects come from the strike's own events); one shot down explodes.
      if (!unit.reachedTarget) {
        this.pushFx(x, y, FX_SAM_EXPLOSION, now);
        this.pushLingering(
          x,
          y,
          FX_MINI_SMOKE_FIRE,
          now,
          this.settings.fx.airstrikeSmokeLifetimeMs,
        );
      }
      return;
    }

    if (typeName === UT_SHELL && unit.reachedTarget) {
      this.pushFx(x, y, FX_MINI_EXPLOSION, now);
      return;
    }

    if (typeName === UT_TRAIN && !unit.reachedTarget) {
      this.pushFx(x, y, FX_MINI_EXPLOSION, now);
      return;
    }

    if (STRUCTURE_TYPES.has(typeName)) {
      this.pushFx(x, y, FX_BUILDING_EXPLOSION, now);
    }
  }

  /**
   * The sprites of an airstrike effect, centred where the simulation dealt the
   * damage: a blast sized to the strike, and fires and smoke that burn on for
   * ~40-50 s where it did damage (more of them the worse it was, more again
   * over a city garrison). Scatter positions come from a stable hash of the
   * event, so the same event looks the same wherever it is drawn. Presentation
   * only; the burning patches never hurt anything.
   */
  spawnAirstrikeImpact(fx: AirstrikeImpactFx, now: number): void {
    const s = this.settings.fx;
    const seed = (n: number) =>
      (fx.toX * 73856093) ^ (fx.toY * 19349663) ^ (n * 83492791);
    const rand = (n: number) => seededRandom(seed(n));
    const scatter = (n: number, r: number): [number, number] => {
      const angle = rand(n) * Math.PI * 2;
      const dist = Math.sqrt(seededRandom(seed(n) + 0x10000)) * r;
      return [
        Math.round(fx.toX + Math.cos(angle) * dist),
        Math.round(fx.toY + Math.sin(angle) * dist),
      ];
    };
    const severity = airstrikeSeverity(fx.killed ?? 0, fx.levels ?? 0);
    const city = (fx.cityLevel ?? 0) > 0;
    const damaged = (fx.killed ?? 0) > 0 || (fx.levels ?? 0) > 0;
    /** Fire/smoke patches: `base` plus up to `extra` more with severity, more over a city. */
    const patches = (base: number, extra: number) =>
      damaged ? base + Math.round(extra * severity) + (city ? 2 : 0) : 0;
    const burn = (
      n: number,
      x: number,
      y: number,
      type: number,
      lifetimeMs: number,
    ) => {
      // Fires catch over the first second and a half and burn out at
      // slightly different times, so the area fades gradually.
      const start = now + rand(n + 500) * 1500;
      const life = lifetimeMs * (0.85 + 0.3 * rand(n + 600));
      this.pushAirstrikeLinger(x, y, type, start, life);
    };

    switch (fx.phase) {
      case AirstrikeImpactPhase.BombImpact: {
        const r = fx.radius;
        // Sprites sized to the real blast (a 20-tile disc): the 48-tile SAM
        // fireball would read as a nuke and hide the map.
        this.pushFx(fx.toX, fx.toY, FX_UNIT_EXPLOSION, now);
        this.pushFx(fx.toX, fx.toY, FX_BUILDING_EXPLOSION, now + 60);
        if (city) {
          for (let i = 0; i < 2; i++) {
            const [x, y] = scatter(1 + i, r * 0.35);
            this.pushFx(x, y, FX_UNIT_EXPLOSION, now + 140 + i * 120);
          }
        }
        for (let i = 0; i < 6; i++) {
          const [x, y] = scatter(10 + i, r * 0.55);
          this.pushFx(x, y, FX_BUILDING_EXPLOSION, now + rand(40 + i) * 300);
        }
        for (let i = 0; i < 5; i++) {
          const [x, y] = scatter(20 + i, r * 0.75);
          this.pushFx(x, y, FX_UNIT_EXPLOSION, now + rand(50 + i) * 400);
        }
        for (let i = 0; i < 12; i++) {
          const [x, y] = scatter(30 + i, r * 0.95);
          this.pushFx(x, y, FX_MINI_EXPLOSION, now + rand(60 + i) * 550);
        }
        // A ring of dust thrown out at the edge of the blast.
        for (let i = 0; i < 10; i++) {
          const a = (i / 10) * Math.PI * 2 + rand(70 + i) * 0.4;
          this.pushFx(
            Math.round(fx.toX + Math.cos(a) * r),
            Math.round(fx.toY + Math.sin(a) * r),
            FX_DUST,
            now + 120,
          );
        }
        const fires = patches(4, 5);
        for (let i = 0; i < fires; i++) {
          const [x, y] = scatter(100 + i, r * 0.8);
          burn(
            100 + i,
            x,
            y,
            i % 3 === 0 ? FX_MINI_SMOKE_FIRE : FX_MINI_FIRE,
            s.airstrikeBombFireLifetimeMs,
          );
        }
        const smokes = damaged ? 2 + Math.round(2 * severity) : 1;
        for (let i = 0; i < smokes; i++) {
          const [x, y] = scatter(200 + i, r * 0.6);
          burn(200 + i, x, y, FX_MINI_BIG_SMOKE, s.airstrikeBombFireLifetimeMs);
        }
        return;
      }
      case AirstrikeImpactPhase.RocketRelease: {
        this.pushFx(fx.fromX, fx.fromY, FX_DUST, now);
        // A smoke trail along the rockets' flight to the target.
        for (let i = 1; i <= 6; i++) {
          const t = i / 7;
          this.pushLingering(
            Math.round(fx.fromX + (fx.toX - fx.fromX) * t),
            Math.round(fx.fromY + (fx.toY - fx.fromY) * t),
            FX_MINI_SMOKE,
            now + t * 250,
            s.airstrikeTrailLifetimeMs,
          );
        }
        return;
      }
      case AirstrikeImpactPhase.RocketImpact: {
        // Three detonations in quick succession, as the rockets land.
        const offsets = [0, 110, 260];
        offsets.forEach((delay, k) => {
          const [x, y] = k === 0 ? [fx.toX, fx.toY] : scatter(k, 2.5);
          this.pushFx(x, y, FX_BUILDING_EXPLOSION, now + delay);
          for (let i = 0; i < 3; i++) {
            const [mx, my] = scatter(10 + k * 5 + i, 3);
            this.pushFx(mx, my, FX_MINI_EXPLOSION, now + delay + i * 40);
          }
        });
        if (city) this.pushFx(fx.toX, fx.toY, FX_UNIT_EXPLOSION, now + 60);
        // Intense, localized: smoke-and-fire columns in a tight cluster.
        const fires = patches(3, 3);
        for (let i = 0; i < fires; i++) {
          const [x, y] = scatter(100 + i, fx.radius * 0.9);
          burn(
            100 + i,
            x,
            y,
            i % 2 === 0 ? FX_MINI_SMOKE_FIRE : FX_MINI_FIRE,
            s.airstrikeRocketFireLifetimeMs,
          );
        }
        if (damaged) {
          for (let i = 0; i < 2; i++) {
            const [x, y] = scatter(200 + i, fx.radius * 0.5);
            burn(
              200 + i,
              x,
              y,
              FX_MINI_BIG_SMOKE,
              s.airstrikeRocketFireLifetimeMs,
            );
          }
        }
        return;
      }
      case AirstrikeImpactPhase.StrafeBurst: {
        // Spread along the burst's segment, a little to either side of the
        // line, sweeping in the direction of flight over the burst.
        const dx = fx.toX - fx.fromX;
        const dy = fx.toY - fx.fromY;
        const len = Math.sqrt(dx * dx + dy * dy) || 1;
        const along = (n: number): [number, number, number] => {
          const t = rand(n);
          const side = (seededRandom(seed(n) + 0x20000) - 0.5) * 2 * fx.radius;
          return [
            Math.round(fx.fromX + dx * t - (dy / len) * side),
            Math.round(fx.fromY + dy * t + (dx / len) * side),
            t,
          ];
        };
        for (let i = 0; i < 14; i++) {
          const [x, y, t] = along(i);
          this.pushFx(x, y, FX_DUST, now + t * 450);
        }
        for (let i = 0; i < 5; i++) {
          const [x, y, t] = along(20 + i);
          this.pushFx(x, y, FX_MINI_EXPLOSION, now + t * 450);
        }
        // Light, scattered fires down the line.
        const fires = damaged ? 1 + Math.round(severity) + (city ? 1 : 0) : 0;
        for (let i = 0; i < fires; i++) {
          const [x, y] = along(100 + i);
          burn(100 + i, x, y, FX_MINI_FIRE, s.airstrikeStrafeFireLifetimeMs);
        }
        if (damaged) {
          const [x, y] = along(200);
          burn(200, x, y, FX_MINI_SMOKE, s.airstrikeStrafeFireLifetimeMs);
        }
        return;
      }
    }
  }

  /**
   * A lingering airstrike fire or smoke patch. A patch of the same kind already
   * burning within LINGER_REFRESH_TILES is refreshed instead of a new one being
   * added, and past airstrikeMaxLingering the oldest patch goes, so repeated
   * strikes can never pile up effects without bound.
   */
  private pushAirstrikeLinger(
    x: number,
    y: number,
    fxType: number,
    startMs: number,
    lifetimeMs: number,
  ): void {
    let oldest = -1;
    let lingering = 0;
    for (let i = 0; i < this.activeFx.length; i++) {
      const f = this.activeFx[i];
      if (!f.linger) continue;
      lingering++;
      if (
        f.fxType === fxType &&
        Math.abs(f.x - x) <= LINGER_REFRESH_TILES &&
        Math.abs(f.y - y) <= LINGER_REFRESH_TILES
      ) {
        // Burning again: from now, for the longer of the two lifetimes left.
        const left = f.startMs + f.lifetimeMs - startMs;
        f.startMs = Math.min(f.startMs, startMs);
        f.lifetimeMs = startMs - f.startMs + Math.max(left, lifetimeMs);
        return;
      }
      if (oldest === -1 || f.startMs < this.activeFx[oldest].startMs) {
        oldest = i;
      }
    }
    if (lingering >= this.settings.fx.airstrikeMaxLingering && oldest !== -1) {
      this.activeFx[oldest] = this.activeFx[this.activeFx.length - 1];
      this.activeFx.pop();
    }
    this.activeFx.push({
      x,
      y,
      fxType,
      startMs,
      lifetimeMs,
      fadeIn: 0.04,
      fadeOut: 0.55,
      linger: true,
    });
  }

  private spawnNukeSprites(
    x: number,
    y: number,
    radius: number,
    now: number,
    pos: number,
  ): void {
    this.pushFx(x, y, FX_NUKE, now);

    let debrisIdx = 0;
    const densityScale = this.settings.fx.debrisDensity;
    for (const { type, radiusFactor, density } of DEBRIS_PLAN) {
      const count = Math.max(0, Math.floor(radius * density * densityScale));
      const r = radius * radiusFactor;
      for (let i = 0; i < count; i++) {
        const seed = pos * 997 + debrisIdx++;
        const angle = seededRandom(seed) * Math.PI * 2;
        const dist = seededRandom(seed + 0x10000) * (r / 2);
        const dx = Math.floor(Math.cos(angle) * dist);
        const dy = Math.floor(Math.sin(angle) * dist);
        this.pushDebris(x + dx, y + dy, type, now);
      }
    }
  }

  pushFx(x: number, y: number, fxType: number, now: number): void {
    const cfg = FX_CONFIG[fxType];
    this.activeFx.push({
      x,
      y,
      fxType,
      startMs: now,
      lifetimeMs: cfg.frameDurationMs * cfg.frameCount,
      fadeIn: 0,
      fadeOut: 1,
    });
  }

  /** A looping sprite (smoke, fire, dust) kept on screen for `lifetimeMs`, fading out. */
  private pushLingering(
    x: number,
    y: number,
    fxType: number,
    now: number,
    lifetimeMs: number,
  ): void {
    this.activeFx.push({
      x,
      y,
      fxType,
      startMs: now,
      lifetimeMs,
      fadeIn: 0.1,
      fadeOut: 0.6,
    });
  }

  private pushDebris(x: number, y: number, fxType: number, now: number): void {
    const fx = this.settings.fx;
    this.activeFx.push({
      x,
      y,
      fxType,
      startMs: now,
      lifetimeMs: fx.debrisLifetimeMs,
      fadeIn: fx.debrisFadeIn,
      fadeOut: fx.debrisFadeOut,
    });
  }

  // -------------------------------------------------------------------------
  // Tick
  // -------------------------------------------------------------------------

  tick(): void {
    if (this.activeFx.length === 0) return;
    const now = this.timeFn();

    for (let i = this.activeFx.length - 1; i >= 0; i--) {
      if (now - this.activeFx[i].startMs >= this.activeFx[i].lifetimeMs) {
        this.activeFx[i] = this.activeFx[this.activeFx.length - 1];
        this.activeFx.pop();
      }
    }

    this.rebuildInstances(now);
  }

  private rebuildInstances(now: number): void {
    const count = this.activeFx.length;
    this.instanceBuf.ensureCapacity(count);

    for (let i = 0; i < count; i++) {
      const fx = this.activeFx[i];
      const cfg = FX_CONFIG[fx.fxType];
      const elapsed = now - fx.startMs;
      if (elapsed < 0) {
        // Scheduled a moment later (a staggered blast, a fire catching).
        const off = i * SPRITE_FLOATS;
        this.instanceBuf.float32[off + 0] = fx.x;
        this.instanceBuf.float32[off + 1] = fx.y;
        this.instanceBuf.float32[off + 2] = fx.fxType;
        this.instanceBuf.uint8[i * SPRITE_BYTES + 12] = 0;
        this.instanceBuf.uint8[i * SPRITE_BYTES + 13] = 0;
        continue;
      }

      let frameIdx: number;
      if (cfg.looping) {
        const cycle = cfg.frameDurationMs * cfg.frameCount;
        frameIdx = Math.floor((elapsed % cycle) / cfg.frameDurationMs);
      } else {
        frameIdx = Math.min(
          Math.floor(elapsed / cfg.frameDurationMs),
          cfg.frameCount - 1,
        );
      }

      let alpha = 255;
      if (fx.fadeIn > 0 || fx.fadeOut < 1) {
        const t = elapsed / fx.lifetimeMs;
        if (t < fx.fadeIn) {
          alpha = Math.floor((t / fx.fadeIn) * 255);
        } else if (t > fx.fadeOut) {
          alpha = Math.floor(((1 - t) / (1 - fx.fadeOut)) * 255);
        }
      }

      const off = i * SPRITE_FLOATS;
      this.instanceBuf.float32[off + 0] = fx.x;
      this.instanceBuf.float32[off + 1] = fx.y;
      this.instanceBuf.float32[off + 2] = fx.fxType;
      const byteOff = i * SPRITE_BYTES;
      this.instanceBuf.uint8[byteOff + 12] = frameIdx;
      this.instanceBuf.uint8[byteOff + 13] = alpha;
    }

    this.spriteCount = count;
  }

  // -------------------------------------------------------------------------
  // Draw
  // -------------------------------------------------------------------------

  draw(cameraMatrix: Float32Array): void {
    if (this.spriteCount === 0 || !this.atlasReady) return;
    const gl = this.gl;
    gl.useProgram(this.program);
    gl.uniformMatrix3fv(this.uCamera, false, cameraMatrix);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.atlasTex);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceBuf.buffer);
    gl.bufferSubData(
      gl.ARRAY_BUFFER,
      0,
      this.instanceBuf.float32,
      0,
      this.spriteCount * SPRITE_FLOATS,
    );
    gl.bindVertexArray(this.vao);
    gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, this.spriteCount);
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  setTimeFn(fn: () => number): void {
    this.timeFn = fn;
  }

  clear(): void {
    this.activeFx.length = 0;
    this.spriteCount = 0;
  }

  dispose(): void {
    this.isDisposed = true;
    const gl = this.gl;
    gl.deleteProgram(this.program);
    this.instanceBuf.dispose();
    gl.deleteVertexArray(this.vao);
    gl.deleteTexture(this.atlasTex);
  }
}
