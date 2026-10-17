/**
 * WorldTextPass — MSDF-rendered text in world space.
 *
 * One pass, one MSDF atlas, several callers:
 *  - Conquest popups: "+ 500" gold text at conquered player locations (fade only)
 *  - Bonus popups:    "+ 45K" income text at port tiles (rises upward + fades)
 *  - Ghost cost label: persistent build-cost number under the ghost cursor
 *  - Airstrike casualties: "-4,250 troops" rising over the strike area, and a
 *    city / structure line under it
 */

import type { Config } from "@openfront/engine-lib/configuration/Config";
import type { AirstrikeImpactFx, BonusEvent, ConquestFx } from "../../types";
import type { RenderSettings } from "../RenderSettings";
import { renderDpr } from "../utils/Dpr";
import { createProgram } from "../utils/GlUtils";
import type { GlyphTables } from "./name-pass/AtlasData";
import { buildGlyphTables, parseAtlasData } from "./name-pass/AtlasData";
import { buildGlyphMetricsTex } from "./name-pass/DataTextures";
import { layoutString } from "./name-pass/TextLayout";
import { CHAR_RANGE, MAX_CHARS } from "./name-pass/Types";

import { renderNumber } from "@openfront/engine-lib/Format";
import { assetUrl } from "@openfront/shared/AssetUrls";
import fragSrc from "../shaders/world-text/world-text.frag.glsl?raw";
import vertSrc from "../shaders/world-text/world-text.vert.glsl?raw";

const atlasUrl = assetUrl("atlases/msdf-atlas.png");

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// worldX, worldY, cursorX, charCode, alpha, colorR, colorG, colorB, scale, outlineWidth
const FLOATS_PER_INSTANCE = 10;
const BYTES_PER_INSTANCE = FLOATS_PER_INSTANCE * 4;
const CONQUEST_LIFETIME_MS = 2500;
/** Tiles below conquered name location (matches upstream DynamicUILayer). */
const CONQUEST_Y_OFFSET = 8;
/** World-space font size for conquest popups. */
const CONQUEST_SCALE = 6;
const CONQUEST_OUTLINE_WIDTH = 2.0;
/** Matches player-name outline width for a consistent UI look. */
const GHOST_COST_OUTLINE_WIDTH = 1.4;
/**
 * Screen-relative em scale for attack troop labels. Pre-divided by the current
 * zoom each frame so the on-screen label size stays constant regardless of
 * how far the camera is zoomed.
 */
const ATTACK_LABEL_SCREEN_SCALE = 17.0;
const ATTACK_LABEL_OUTLINE_WIDTH = 1.2;

/** Airstrike casualty popups: how long they rise, and how they group. */
export const CASUALTY_LIFETIME_MS = 2800;
/** World units per second the number rises (scaled with the text). */
const CASUALTY_RISE = 3;
/** World-space size of a 1,000-troop number; it never drops below the screen minimum. */
const CASUALTY_SCALE = 5;
/** Smallest on-screen size (CSS px em) so a number stays readable zoomed out. */
const CASUALTY_MIN_SCREEN_SCALE = 15;
const CASUALTY_OUTLINE_WIDTH = 1.6;
/** Tiles above the strike centre the number starts at. */
const CASUALTY_Y_OFFSET = 2;
/** The detail line sits this far under the number, in units of its size. */
const DETAIL_LINE_OFFSET = 1.25;
/** Hits of one strike (a strafing run's bursts) within this time and range add up. */
const CASUALTY_MERGE_MS = 1500;
const CASUALTY_MERGE_TILES = 40;
/** Casualty popups alive at once; past it the oldest go first. */
export const MAX_CASUALTY_POPUPS = 24;

/** Size factor of a casualty number: bigger for heavier losses, bounded. */
export function casualtyScaleFactor(killed: number, cityHit: boolean): number {
  const k = Math.max(1, killed);
  const f = Math.min(1.7, Math.max(0.85, 1 + 0.25 * Math.log10(k / 1000)));
  return cityHit ? Math.min(1.9, f * 1.15) : f;
}

// ---------------------------------------------------------------------------
// Active popup tracking
// ---------------------------------------------------------------------------

interface ActivePopup {
  x: number;
  y: number;
  text: string;
  startMs: number;
  lifetimeMs: number;
  riseSpeed: number; // world units per second (0 = no rise)
  colorR: number;
  colorG: number;
  colorB: number;
  scale: number;
  outlineWidth: number;
  /** Never drawn smaller than this on screen (CSS px em); rise and offset scale with it. */
  minScreenScale?: number;
  /** Shift down by this many text sizes (a second line). */
  lineOffset?: number;
  /** Airstrike casualties: what this popup counts, to merge a strike's hits. */
  casualty?: { key: string; killed: number; detail: boolean };
}

/**
 * Persistent attack-troop label rendered at a world-space position.
 * AttackingTroopsController pushes a fresh list each frame with already-
 * interpolated positions (smoothing happens controller-side).
 */
export interface AttackTroopLabel {
  x: number;
  y: number;
  text: string;
  colorR: number;
  colorG: number;
  colorB: number;
}

function formatGold(gold: number): string {
  if (gold >= 1_000_000) return (gold / 1_000_000).toFixed(1) + "M";
  if (gold >= 1_000) return (gold / 1_000).toFixed(1) + "K";
  return gold.toString();
}

// ---------------------------------------------------------------------------
// WorldTextPass
// ---------------------------------------------------------------------------

export class WorldTextPass {
  private gl: WebGL2RenderingContext;
  private program: WebGLProgram;
  private maxInstances = 512;

  // Uniform locations
  private uCamera: WebGLUniformLocation;
  private uZoom: WebGLUniformLocation;
  private uMinScreenScale: WebGLUniformLocation;
  private uDistRange: WebGLUniformLocation;

  private vao: WebGLVertexArrayObject;
  private instanceBuf: WebGLBuffer;
  private instanceData: Float32Array;
  private instanceCount = 0;

  private glyphMetricsTex: WebGLTexture;
  private atlasTex: WebGLTexture | null = null;
  private atlasReady = false;

  // CPU-side glyph tables for layoutString
  private glyph: GlyphTables;
  private kernTable: Int8Array;

  // Reusable buffers for layoutString
  private charCodes = new Uint8Array(MAX_CHARS);
  private cursors = new Float32Array(MAX_CHARS);

  private distanceRange: number;
  private fontSize: number;
  private atlasScaleH: number;
  private base: number;

  // Active popups (both conquest and bonus, unified)
  private active: ActivePopup[] = [];

  // Persistent ghost-cost label (separate from popup lifecycle; doesn't fade).
  private ghostCostLabel: {
    x: number;
    y: number;
    text: string;
    topText?: string;
    colorR: number;
    colorG: number;
    colorB: number;
  } | null = null;

  // Persistent attack-troop labels. Controller pushes the full list each frame
  // (already interpolated), so we just iterate and render.
  private attackTroopLabels: AttackTroopLabel[] = [];

  // Settings reference
  private settings: RenderSettings;

  // Map width for tile→x/y conversion
  private mapW = 0;

  // Pluggable time source (same pattern as FxPass)
  private timeFn: () => number = () => performance.now();
  private now(): number {
    return this.timeFn();
  }

  constructor(
    gl: WebGL2RenderingContext,
    settings: RenderSettings,
    private config: Config,
  ) {
    this.gl = gl;
    this.settings = settings;

    // Parse atlas data (shared with NamePass/StructureLevelPass)
    const atlas = parseAtlasData();
    this.glyph = buildGlyphTables(atlas.chars);
    this.kernTable = new Int8Array(CHAR_RANGE * CHAR_RANGE);
    this.distanceRange = atlas.distanceRange;
    this.fontSize = atlas.fontSize;
    this.atlasScaleH = atlas.scaleH;
    this.base = atlas.base;

    // Compile shaders
    this.program = createProgram(gl, vertSrc, fragSrc, "WorldTextPass");

    // Texture unit bindings
    gl.useProgram(this.program);
    gl.uniform1i(gl.getUniformLocation(this.program, "uAtlas"), 0);
    gl.uniform1i(gl.getUniformLocation(this.program, "uGlyphMetrics"), 1);

    // Static uniforms
    gl.uniform1f(
      gl.getUniformLocation(this.program, "uFontSize")!,
      this.fontSize,
    );
    gl.uniform1f(
      gl.getUniformLocation(this.program, "uAtlasScaleH")!,
      this.atlasScaleH,
    );
    gl.uniform1f(gl.getUniformLocation(this.program, "uBase")!, this.base);

    // Dynamic uniform locations
    this.uCamera = gl.getUniformLocation(this.program, "uCamera")!;
    this.uZoom = gl.getUniformLocation(this.program, "uZoom")!;
    this.uMinScreenScale = gl.getUniformLocation(
      this.program,
      "uMinScreenScale",
    )!;
    this.uDistRange = gl.getUniformLocation(this.program, "uDistRange")!;

    // Glyph metrics data texture
    this.glyphMetricsTex = buildGlyphMetricsTex(gl, atlas);

    // Start async MSDF atlas load
    this.loadAtlas();

    // Instance buffer
    this.instanceData = new Float32Array(
      this.maxInstances * FLOATS_PER_INSTANCE,
    );
    this.instanceBuf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceBuf);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      this.instanceData.byteLength,
      gl.DYNAMIC_DRAW,
    );

    // VAO
    this.vao = gl.createVertexArray()!;
    gl.bindVertexArray(this.vao);

    // Attribute 0: unit quad [0,1]²
    const quadBuf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([0, 0, 1, 0, 0, 1, 1, 0, 1, 1, 0, 1]),
      gl.STATIC_DRAW,
    );
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    // Per-instance attributes from instance buffer
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceBuf);
    // Attribute 1: vec4 (worldX, worldY, cursorX, charCode) at offset 0
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 4, gl.FLOAT, false, BYTES_PER_INSTANCE, 0);
    gl.vertexAttribDivisor(1, 1);
    // Attribute 2: vec4 (alpha, colorR, colorG, colorB) at offset 16
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 4, gl.FLOAT, false, BYTES_PER_INSTANCE, 16);
    gl.vertexAttribDivisor(2, 1);
    // Attribute 3: vec2 (scale, outlineWidth) at offset 32
    gl.enableVertexAttribArray(3);
    gl.vertexAttribPointer(3, 2, gl.FLOAT, false, BYTES_PER_INSTANCE, 32);
    gl.vertexAttribDivisor(3, 1);

    gl.bindVertexArray(null);
  }

  private loadAtlas(): void {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      const gl = this.gl;
      const tex = gl.createTexture()!;
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
      this.atlasTex = tex;
      this.atlasReady = true;
    };
    img.src = atlasUrl;
  }

  setMapWidth(w: number): void {
    this.mapW = w;
  }

  // -------------------------------------------------------------------------
  // Event input
  // -------------------------------------------------------------------------

  applyConquestEvents(events: ConquestFx[]): void {
    const now = this.now();
    for (const evt of events) {
      const startMs = now - (evt.tickAge ?? 0) * this.config.msPerTick();
      if (now - startMs >= CONQUEST_LIFETIME_MS) continue;
      this.active.push({
        x: evt.x,
        y: evt.y + CONQUEST_Y_OFFSET,
        text: "+ " + formatGold(evt.gold),
        startMs,
        lifetimeMs: CONQUEST_LIFETIME_MS,
        riseSpeed: 0,
        colorR: 1,
        colorG: 1,
        colorB: 1,
        scale: CONQUEST_SCALE,
        outlineWidth: CONQUEST_OUTLINE_WIDTH,
      });
    }
  }

  /**
   * Casualty numbers for airstrike impacts, from the troops the simulation
   * really killed. A strike's hits close together (a strafing run's bursts)
   * add up into one number instead of stacking; the text is already translated.
   */
  applyAirstrikeCasualties(events: AirstrikeImpactFx[]): void {
    const now = this.now();
    for (const evt of events) {
      const startMs = now - (evt.tickAge ?? 0) * this.config.msPerTick();
      if (now - startMs >= CASUALTY_LIFETIME_MS) continue;
      const killed = evt.killed ?? 0;
      const cityHit = (evt.cityLevel ?? 0) > 0;
      if (!evt.casualtyText && !evt.detailText) continue;
      const key = `${evt.attackerID ?? -1}:${evt.strikeType}`;
      const merged = this.active.find(
        (p) =>
          p.casualty?.key === key &&
          !p.casualty.detail &&
          now - p.startMs < CASUALTY_MERGE_MS &&
          Math.abs(p.x - evt.toX) <= CASUALTY_MERGE_TILES &&
          Math.abs(p.y + CASUALTY_Y_OFFSET - evt.toY) <= CASUALTY_MERGE_TILES,
      );
      if (merged !== undefined && evt.casualtyText && killed > 0) {
        merged.casualty!.killed += killed;
        merged.text = evt.casualtyText.replace(
          Math.round(killed).toLocaleString("en-US"),
          Math.round(merged.casualty!.killed).toLocaleString("en-US"),
        );
        merged.startMs = startMs;
        merged.scale =
          CASUALTY_SCALE *
          casualtyScaleFactor(merged.casualty!.killed, cityHit);
        // Its detail line rises with it.
        for (const p of this.active) {
          if (p.casualty?.key === key && p.casualty.detail) p.startMs = startMs;
        }
        continue;
      }
      const factor = casualtyScaleFactor(killed, cityHit);
      const y = evt.toY - CASUALTY_Y_OFFSET;
      if (evt.casualtyText) {
        this.pushCasualty({
          x: evt.toX,
          y,
          text: evt.casualtyText,
          startMs,
          lifetimeMs: CASUALTY_LIFETIME_MS,
          riseSpeed: CASUALTY_RISE,
          // City garrisons in a hotter orange, other troops in red.
          colorR: 1,
          colorG: cityHit ? 0.55 : 0.28,
          colorB: cityHit ? 0.15 : 0.25,
          scale: CASUALTY_SCALE * factor,
          outlineWidth: CASUALTY_OUTLINE_WIDTH,
          minScreenScale: CASUALTY_MIN_SCREEN_SCALE * factor,
          casualty: { key, killed, detail: false },
        });
      }
      const detailShown = this.active.find(
        (p) =>
          p.casualty?.key === key &&
          p.casualty.detail &&
          p.text === evt.detailText &&
          now - p.startMs < CASUALTY_MERGE_MS,
      );
      if (detailShown !== undefined) {
        detailShown.startMs = startMs;
      } else if (evt.detailText) {
        this.pushCasualty({
          x: evt.toX,
          y,
          text: evt.detailText,
          startMs,
          lifetimeMs: CASUALTY_LIFETIME_MS,
          riseSpeed: CASUALTY_RISE,
          colorR: 1,
          colorG: 0.85,
          colorB: 0.35,
          scale: CASUALTY_SCALE * 0.7,
          outlineWidth: CASUALTY_OUTLINE_WIDTH,
          minScreenScale: CASUALTY_MIN_SCREEN_SCALE * 0.7,
          lineOffset: evt.casualtyText ? DETAIL_LINE_OFFSET / 0.7 : 0,
          casualty: { key, killed: 0, detail: true },
        });
      }
    }
  }

  /** Adds a casualty popup, dropping the oldest past MAX_CASUALTY_POPUPS. */
  private pushCasualty(popup: ActivePopup): void {
    const casualties = this.active.filter((p) => p.casualty !== undefined);
    if (casualties.length >= MAX_CASUALTY_POPUPS) {
      let oldest = casualties[0];
      for (const p of casualties) if (p.startMs < oldest.startMs) oldest = p;
      this.active.splice(this.active.indexOf(oldest), 1);
    }
    this.active.push(popup);
  }

  applyBonusEvents(events: BonusEvent[]): void {
    if (this.mapW === 0) return;
    const now = this.now();
    const s = this.settings.bonusPopup;
    for (const evt of events) {
      if (evt.gold === 0) continue;
      const x = evt.tile % this.mapW;
      const y = Math.floor(evt.tile / this.mapW);
      const sign = evt.gold >= 0 ? "+" : "-";
      this.active.push({
        x,
        y: y + s.yOffset,
        text: sign + " " + formatGold(Math.abs(evt.gold)),
        startMs: now,
        lifetimeMs: s.lifetimeMs,
        riseSpeed: s.riseSpeed,
        colorR: s.colorR,
        colorG: s.colorG,
        colorB: s.colorB,
        scale: s.scale,
        outlineWidth: s.outlineWidth,
      });
    }
  }

  /**
   * Set or clear the ghost-cost label rendered under the build cursor.
   * `null` clears it. Called from Renderer.updateGhostPreview.
   */
  setGhostCostLabel(
    label: {
      tileX: number;
      tileY: number;
      cost: number;
      canAfford: boolean;
      canPlace: boolean;
      topText?: string;
    } | null,
  ): void {
    if (label === null) {
      this.ghostCostLabel = null;
      return;
    }
    // Color precedence: red (can't afford) > gray (can't place here) > white (OK).
    let r = 1,
      g = 1,
      b = 1;
    if (!label.canAfford) {
      g = 0.3;
      b = 0.3;
    } else if (!label.canPlace) {
      r = 0.6;
      g = 0.6;
      b = 0.6;
    }

    // The vertex shader adds +0.5 to (x, y) for tile-center alignment, so we
    // pass raw tile coords here — same convention as the other popup entries.
    // Y offset is applied in rebuildInstances (zoom-relative).
    this.ghostCostLabel = {
      x: label.tileX,
      y: label.tileY,
      // cost 0 means "no cost line" (multiplier-badge-only label).
      text: label.cost > 0 ? renderNumber(label.cost) : "",
      topText: label.topText,
      colorR: r,
      colorG: g,
      colorB: b,
    };
  }

  /**
   * Replace the set of attack-troop labels. Controller pushes the full list
   * each frame with interpolated positions; empty array clears them.
   */
  setAttackTroopLabels(labels: AttackTroopLabel[]): void {
    this.attackTroopLabels = labels;
  }

  // -------------------------------------------------------------------------
  // Tick — cull expired, rebuild instance buffer
  // -------------------------------------------------------------------------

  tick(zoom: number): void {
    if (
      this.active.length === 0 &&
      this.ghostCostLabel === null &&
      this.attackTroopLabels.length === 0
    ) {
      this.instanceCount = 0;
      return;
    }
    const now = this.now();

    // Remove expired popups (swap-remove)
    for (let i = this.active.length - 1; i >= 0; i--) {
      if (now - this.active[i].startMs >= this.active[i].lifetimeMs) {
        this.active[i] = this.active[this.active.length - 1];
        this.active.pop();
      }
    }

    this.rebuildInstances(now, zoom);
  }

  private rebuildInstances(now: number, zoom: number): void {
    let count = 0;
    // canvasW in Camera is cssWidth*dpr, so `zoom` is device-px-per-world-unit.
    // Multiply screen-relative scales by dpr to keep a constant CSS-pixel size.
    const dpr = renderDpr();

    for (const popup of this.active) {
      const elapsed = now - popup.startMs;
      const alpha = Math.max(0, 1 - elapsed / popup.lifetimeMs);
      if (alpha <= 0) continue;

      // A popup with a screen minimum grows when zoomed out, and its rise and
      // line offset grow with it, so it reads the same at any zoom.
      const scale =
        popup.minScreenScale !== undefined
          ? Math.max(
              popup.scale,
              (popup.minScreenScale * dpr) / Math.max(zoom, 0.0001),
            )
          : popup.scale;
      const grow = scale / popup.scale;
      // Rise animation: move upward over time
      const riseY =
        (popup.riseSpeed > 0
          ? popup.y - (elapsed / 1000) * popup.riseSpeed * grow
          : popup.y) +
        (popup.lineOffset ?? 0) * scale;

      layoutString(
        popup.text,
        this.glyph,
        this.kernTable,
        this.charCodes,
        this.cursors,
      );
      const len = Math.min(popup.text.length, MAX_CHARS);

      for (let i = 0; i < len; i++) {
        if (this.charCodes[i] === 0) continue;
        if (count >= this.maxInstances) {
          this.growBuffer();
        }

        const off = count * FLOATS_PER_INSTANCE;
        this.instanceData[off + 0] = popup.x;
        this.instanceData[off + 1] = riseY;
        this.instanceData[off + 2] = this.cursors[i];
        this.instanceData[off + 3] = this.charCodes[i];
        this.instanceData[off + 4] = alpha;
        this.instanceData[off + 5] = popup.colorR;
        this.instanceData[off + 6] = popup.colorG;
        this.instanceData[off + 7] = popup.colorB;
        this.instanceData[off + 8] = scale;
        this.instanceData[off + 9] = popup.outlineWidth;
        count++;
      }
    }

    // Attack troop labels — persistent, no fade. Controller interpolates
    // positions before pushing. Scale is divided by zoom so the label keeps
    // a constant on-screen size regardless of how zoomed-in the camera is.
    const attackScale =
      (ATTACK_LABEL_SCREEN_SCALE * dpr) / Math.max(zoom, 0.0001);
    for (const label of this.attackTroopLabels) {
      layoutString(
        label.text,
        this.glyph,
        this.kernTable,
        this.charCodes,
        this.cursors,
      );
      const len = Math.min(label.text.length, MAX_CHARS);
      for (let i = 0; i < len; i++) {
        if (this.charCodes[i] === 0) continue;
        if (count >= this.maxInstances) this.growBuffer();

        const off = count * FLOATS_PER_INSTANCE;
        this.instanceData[off + 0] = label.x;
        this.instanceData[off + 1] = label.y;
        this.instanceData[off + 2] = this.cursors[i];
        this.instanceData[off + 3] = this.charCodes[i];
        this.instanceData[off + 4] = 1;
        this.instanceData[off + 5] = label.colorR;
        this.instanceData[off + 6] = label.colorG;
        this.instanceData[off + 7] = label.colorB;
        this.instanceData[off + 8] = attackScale;
        this.instanceData[off + 9] = ATTACK_LABEL_OUTLINE_WIDTH;
        count++;
      }
    }

    // Ghost cost label — persistent, no fade or rise. layoutString already
    // centers cursors around 0, so passing the tile coord places the text
    // centered on the tile (vertex shader adds the +0.5 tile-center offset).
    // Scale is divided by zoom so the chip keeps a constant on-screen size.
    const label = this.ghostCostLabel;
    if (label) {
      const invZoom = 1 / Math.max(zoom, 0.0001);
      const ghostScale = this.settings.ghostCost.screenScale * dpr * invZoom;
      const ghostY =
        label.y + this.settings.ghostCost.screenYOffset * dpr * invZoom;

      if (label.topText) {
        const topY = label.y - 30 * dpr * invZoom;
        layoutString(
          label.topText,
          this.glyph,
          this.kernTable,
          this.charCodes,
          this.cursors,
        );
        const len = Math.min(label.topText.length, MAX_CHARS);
        for (let i = 0; i < len; i++) {
          if (this.charCodes[i] === 0) continue;
          if (count >= this.maxInstances) this.growBuffer();

          const off = count * FLOATS_PER_INSTANCE;
          this.instanceData[off + 0] = label.x;
          this.instanceData[off + 1] = topY;
          this.instanceData[off + 2] = this.cursors[i];
          this.instanceData[off + 3] = this.charCodes[i];
          this.instanceData[off + 4] = 1;
          this.instanceData[off + 5] = label.colorR;
          this.instanceData[off + 6] = label.colorG;
          this.instanceData[off + 7] = label.colorB;
          this.instanceData[off + 8] = ghostScale;
          this.instanceData[off + 9] = GHOST_COST_OUTLINE_WIDTH;
          count++;
        }
      }

      if (label.text) {
        layoutString(
          label.text,
          this.glyph,
          this.kernTable,
          this.charCodes,
          this.cursors,
        );
        const len = Math.min(label.text.length, MAX_CHARS);
        for (let i = 0; i < len; i++) {
          if (this.charCodes[i] === 0) continue;
          if (count >= this.maxInstances) this.growBuffer();

          const off = count * FLOATS_PER_INSTANCE;
          this.instanceData[off + 0] = label.x;
          this.instanceData[off + 1] = ghostY;
          this.instanceData[off + 2] = this.cursors[i];
          this.instanceData[off + 3] = this.charCodes[i];
          this.instanceData[off + 4] = 1;
          this.instanceData[off + 5] = label.colorR;
          this.instanceData[off + 6] = label.colorG;
          this.instanceData[off + 7] = label.colorB;
          this.instanceData[off + 8] = ghostScale;
          this.instanceData[off + 9] = GHOST_COST_OUTLINE_WIDTH;
          count++;
        }
      }
    }

    this.instanceCount = count;
  }

  private growBuffer(): void {
    this.maxInstances *= 2;
    const newData = new Float32Array(this.maxInstances * FLOATS_PER_INSTANCE);
    newData.set(this.instanceData);
    this.instanceData = newData;
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceBuf);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      this.instanceData.byteLength,
      gl.DYNAMIC_DRAW,
    );
  }

  // -------------------------------------------------------------------------
  // Draw
  // -------------------------------------------------------------------------

  draw(cameraMatrix: Float32Array, zoom: number): void {
    if (!this.atlasReady || this.instanceCount === 0) return;
    if (zoom < this.settings.bonusPopup.cullZoom) return;

    const gl = this.gl;
    gl.useProgram(this.program);
    gl.uniformMatrix3fv(this.uCamera, false, cameraMatrix);
    gl.uniform1f(this.uZoom, zoom);
    const dpr = renderDpr();
    gl.uniform1f(
      this.uMinScreenScale,
      this.settings.bonusPopup.minScreenScale * dpr,
    );
    gl.uniform1f(this.uDistRange, this.distanceRange);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.atlasTex!);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.glyphMetricsTex);

    gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceBuf);
    gl.bufferSubData(
      gl.ARRAY_BUFFER,
      0,
      this.instanceData,
      0,
      this.instanceCount * FLOATS_PER_INSTANCE,
    );

    gl.bindVertexArray(this.vao);
    gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, this.instanceCount);
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /** Override the time source. Default: performance.now (wall clock). */
  setTimeFn(fn: () => number): void {
    this.timeFn = fn;
  }

  clear(): void {
    this.active.length = 0;
    this.attackTroopLabels = [];
    this.instanceCount = 0;
  }

  dispose(): void {
    const gl = this.gl;
    gl.deleteProgram(this.program);
    gl.deleteBuffer(this.instanceBuf);
    gl.deleteVertexArray(this.vao);
    gl.deleteTexture(this.glyphMetricsTex);
    if (this.atlasTex) gl.deleteTexture(this.atlasTex);
  }
}
