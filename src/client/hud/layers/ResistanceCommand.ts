import type { TileRef } from "@openfront/engine-api/game/GameMap";
import {
  InsurgencyPhase,
  InsurgencyRegionStatus,
  type InsurgencyRegionView,
  type InsurgencyView,
} from "@openfront/engine-api/game/GameUpdates";
import { renderNumber, renderTroops } from "@openfront/engine-lib/Format";
import {
  regionBounds,
  regionGrid,
  regionLabel,
  regionOf,
  type InsurgencySpec,
  type RegionGrid,
} from "@openfront/engine-lib/insurgency/InsurgencyRules";
import { EventBus } from "@openfront/shared/EventBus";
import { LitElement, html, nothing, type TemplateResult } from "lit";
import { customElement, state } from "lit/decorators.js";
import { formatCountdown } from "../../capital/CrisisClock";
import { Controller } from "../../Controller";
import {
  RegionOverlay,
  type OverlayModel,
  type OverlayRegion,
} from "../../resistance/RegionOverlay";
import {
  availableOrders,
  bandKey,
  eligibleRegions,
  engineTroops,
  intelFor,
  intelIsFresh,
  isRunning,
  occupiedBy,
  pendingTroops,
  previewBase,
  previewIntel,
  previewRecruit,
  previewSuppress,
  previewUprising,
  recruitBounds,
  region as regionOfView,
  secondsUntil,
  shownTroops,
  sortRegions,
  suppressionsRunning,
  timeLeftSeconds,
  whyUnavailable,
  type OccupiedRegion,
  type OrderBlock,
  type OrderName,
} from "../../resistance/ResistanceModel";
import type { TilePicker } from "../../resistance/TilePicker";
import type { TransformHandler } from "../../TransformHandler";
import { GoToPositionEvent } from "../../TransformHandler";
import {
  SendResistanceBaseIntentEvent,
  SendResistanceIntelIntentEvent,
  SendResistanceRecruitIntentEvent,
  SendResistanceUprisingIntentEvent,
  SendSuppressRegionIntentEvent,
} from "../../Transport";
import { translateText } from "../../Utils";
import type { GameView } from "../../view";

/**
 * Resistance Command (docs/Insurgency.md): what a player whose capital has
 * fallen sees and does, and what the occupier of their land sees and does.
 *
 * It shows what the engine reports and sends orders as intents. Nothing here
 * decides anything: the previews mirror the engine's checks so a button can say
 * why it is unavailable (ResistanceModel), and the engine checks every order
 * again, identically on every client. A refused order costs nothing and the
 * sender is told why in the events panel.
 *
 * Every significant order goes through a confirmation that states its cost; an
 * uprising is a battle that can be lost, and says so. The panel and the region
 * squares on the map (RegionOverlay) take no part in combat or territory.
 */

/** A resistance that has only just begun waits this long, so it does not fight the CRISIS announcement for the screen. */
const SETTLE_TICKS = 45;
/** How long the "resistance ended" card stays. */
const ENDED_VISIBLE_MS = 15_000;
/** A suppression asks twice; the second click must come within this. */
const CONFIRM_MS = 4_000;
const RECRUIT_STEP = 50;
const STORAGE_KEY = "resistancePanel.collapsed";
const STYLE_ID = "resistance-command-style";

type Form =
  | { kind: "recruit"; shown: number }
  | { kind: "base"; tile: TileRef }
  | { kind: "uprising"; shown: number }
  | { kind: "intel" };

const STYLE = `
resistance-command { display: block; }
.rc {
  position: fixed; left: 12px; top: 200px; z-index: 1100; width: 316px;
  max-height: calc(100vh - 250px); overflow-y: auto; box-sizing: border-box;
  background: rgba(14, 14, 14, 0.93); color: var(--color-df-text, #f5f5f5);
  border: 1px solid var(--color-df-border, #2b2b2b);
  border-left: 3px solid var(--color-df-red, #e31b23);
  box-shadow: 0 6px 22px rgba(0, 0, 0, 0.5);
  font: 500 12.5px/1.35 Inter, system-ui, sans-serif; user-select: none;
}
.rc + .rc { margin-top: 0; }
.rc.second { top: auto; bottom: 140px; max-height: 34vh; }
.rc button { font: inherit; color: inherit; cursor: pointer; }
.rc button:disabled { cursor: not-allowed; opacity: 0.45; }
.rc-head { display: flex; align-items: center; gap: 8px; padding: 8px 10px; cursor: pointer;
  background: rgba(255,255,255,0.04); }
.rc-title { font: 700 13px var(--font-display, "Pixelify Sans", Inter, sans-serif);
  letter-spacing: 0.14em; text-transform: uppercase; }
.rc-phase { font-size: 11px; letter-spacing: 0.08em; text-transform: uppercase;
  padding: 1px 6px; border: 1px solid #3f6b3f; color: #8fe08f; }
.rc-phase.limbo { border-color: #8a5a1c; color: #ffb347; }
.rc-clock { margin-left: auto; font: 700 15px var(--font-display, monospace);
  font-variant-numeric: tabular-nums; }
.rc-clock.warn { color: #ffb347; }
.rc-clock small { display: block; font: 500 9.5px Inter, sans-serif; color: var(--color-df-text-secondary, #a7a7a7);
  letter-spacing: 0.06em; text-align: right; text-transform: uppercase; }
.rc-fold { background: none; border: 0; padding: 2px 4px; font-size: 14px; }
.rc-body { padding: 8px 10px 10px; display: grid; gap: 8px; }
.rc h3 { margin: 4px 0 0; font: 700 10.5px Inter, sans-serif; letter-spacing: 0.14em;
  text-transform: uppercase; color: var(--color-df-text-secondary, #a7a7a7); }
.rc-meter { position: relative; height: 16px; background: rgba(255,255,255,0.08); }
.rc-meter > div { height: 100%; background: var(--color-df-red, #e31b23); }
.rc-meter > span { position: absolute; inset: 0; display: grid; place-items: center;
  font-size: 10.5px; font-weight: 700; letter-spacing: 0.06em; text-shadow: 0 1px 2px #000; }
.rc-stats { display: grid; grid-template-columns: 1fr 1fr 1fr 1fr; gap: 4px; margin: 0; }
.rc-stats > div { background: rgba(255,255,255,0.05); padding: 4px 6px; }
.rc-stats dt { font-size: 9.5px; letter-spacing: 0.08em; text-transform: uppercase;
  color: var(--color-df-text-secondary, #a7a7a7); }
.rc-stats dd { margin: 0; font-weight: 700; font-variant-numeric: tabular-nums; }
.rc-stats .wide { grid-column: span 4; display: flex; justify-content: space-between; align-items: baseline; }
.rc-regions { list-style: none; margin: 0; padding: 0; display: grid; gap: 3px; max-height: 200px; overflow-y: auto; }
.rc-region { display: grid; grid-template-columns: auto 1fr auto auto; gap: 2px 8px; align-items: center;
  padding: 4px 6px; background: rgba(255,255,255,0.04); border: 1px solid transparent; cursor: pointer; }
.rc-region:hover { border-color: #444; }
.rc-region.sel { border-color: #fff; }
.rc-region .name { font: 700 13px var(--font-display, monospace); }
.rc-region .state { color: var(--color-df-text-secondary, #a7a7a7); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.rc-region .sub { grid-column: 2 / span 3; font-size: 11px; color: #c9c9c9; }
.rc-region .go { background: none; border: 1px solid #444; padding: 0 6px; font-size: 11px; }
.rc-region .go:hover { border-color: var(--color-df-red, #e31b23); }
.rc-band { font-size: 10.5px; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; padding: 0 6px; border: 1px solid; }
.rc-band.b0 { color: #8b95a5; } .rc-band.b1 { color: #eab308; } .rc-band.b2 { color: #f97316; }
.rc-band.b3 { color: #ef4444; } .rc-band.b4 { color: #ff2d55; }
.rc-held { color: #22c55e; border-color: #22c55e; }
.rc-orders { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
.rc-order { display: grid; gap: 1px; text-align: left; padding: 6px 8px; background: var(--color-df-panel, #1a1a1a);
  border: 1px solid var(--color-df-border, #2b2b2b); }
.rc-order:not(:disabled):hover { border-color: var(--color-df-red, #e31b23); }
.rc-order.on { border-color: var(--color-df-red, #e31b23); }
.rc-order b { font: 700 11.5px var(--font-display, Inter, sans-serif); letter-spacing: 0.06em; text-transform: uppercase; }
.rc-order small { font-size: 10.5px; color: var(--color-df-text-secondary, #a7a7a7); }
.rc-form { display: grid; gap: 6px; padding: 8px; background: rgba(255,255,255,0.05); border: 1px solid #3a3a3a; }
.rc-form h4 { margin: 0; font: 700 12px var(--font-display, Inter, sans-serif); letter-spacing: 0.08em; text-transform: uppercase; }
.rc-form p { margin: 0; color: #d0d0d0; }
.rc-form label { display: grid; gap: 3px; }
.rc-form select, .rc-form input[type=range] { width: 100%; }
.rc-form select { background: #111; color: inherit; border: 1px solid #444; padding: 3px; }
.rc-preview { list-style: none; margin: 0; padding: 0; display: grid; gap: 2px; }
.rc-preview li { display: flex; justify-content: space-between; }
.rc-preview li span:last-child { font-weight: 700; font-variant-numeric: tabular-nums; }
.rc-bad { color: #ffb347; }
.rc-actions { display: flex; gap: 6px; }
.rc-actions button { flex: 1; padding: 6px; border: 1px solid #444; background: var(--color-df-panel, #1a1a1a);
  font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; }
.rc-actions .go { background: var(--color-df-red, #e31b23); border-color: var(--color-df-red, #e31b23); color: #fff; }
.rc-list { list-style: none; margin: 0; padding: 0; display: grid; gap: 2px; color: #d0d0d0; }
.rc-ended { padding: 8px 10px 10px; display: grid; gap: 6px; }
.rc-ended button { padding: 5px; border: 1px solid #444; background: var(--color-df-panel, #1a1a1a); }
.rc-occ-row { display: grid; grid-template-columns: auto 1fr auto; gap: 2px 8px; align-items: center;
  padding: 4px 6px; background: rgba(255,255,255,0.04); }
.rc-occ-row .name { font: 700 13px var(--font-display, monospace); }
.rc-occ-row button { grid-column: 1 / span 3; text-align: left; padding: 4px 8px; border: 1px solid #444;
  background: var(--color-df-panel, #1a1a1a); }
.rc-occ-row button:not(:disabled):hover { border-color: var(--color-df-red, #e31b23); }
.rc-occ-row button.sure { background: var(--color-df-red, #e31b23); border-color: var(--color-df-red, #e31b23); color: #fff; }
.rc-occ-row .busy { grid-column: 1 / span 3; color: #8fe08f; }
@media (max-width: 760px) {
  .rc { width: calc(100vw - 24px); top: auto; bottom: 150px; max-height: 42vh; }
  .rc.second { bottom: auto; top: 200px; }
}
@media (prefers-reduced-motion: no-preference) {
  .rc-meter > div { transition: width 0.4s ease; }
}
`;

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

function roundTo(n: number, step: number): number {
  return Math.round(n / step) * step;
}

@customElement("resistance-command")
export class ResistanceCommand extends LitElement implements Controller {
  public game: GameView;
  public eventBus: EventBus;
  public picker: TilePicker;
  public transformHandler: TransformHandler;

  /** The player's own resistance, and the regions of others that they hold. */
  @state() private mine: InsurgencyView | null = null;
  @state() private occupied: OccupiedRegion[] = [];
  @state() private now = 0;
  @state() private collapsed = false;
  @state() private occCollapsed = false;
  @state() private selected: number | null = null;
  @state() private form: Form | null = null;
  @state() private endedOpen = false;
  /** The suppression waiting for its second click, as "owner:region". */
  @state() private sure: string | null = null;

  private overlay: RegionOverlay | null = null;
  private grid: RegionGrid | null = null;
  private timers: ReturnType<typeof setTimeout>[] = [];
  /** The resistance whose end card has been shown or dismissed, by start tick. */
  private endedSeen: number | null = null;

  createRenderRoot() {
    return this;
  }

  init() {
    this.ensureStyle();
    try {
      this.collapsed =
        localStorage.getItem(STORAGE_KEY) === "1" || window.innerWidth < 768;
    } catch {
      this.collapsed = window.innerWidth < 768;
    }
    this.overlay = new RegionOverlay(this.game, this.transformHandler, () =>
      this.overlayModel(),
    );
    this.overlay.start();
  }

  /** A form that has just opened may be below the fold of a panel that scrolls. */
  protected updated(changed: Map<PropertyKey, unknown>): void {
    if (changed.has("form") && this.form !== null) {
      this.querySelector(".rc-form")?.scrollIntoView?.({ block: "nearest" });
    }
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    this.overlay?.stop();
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
  }

  // ---- The match's state, once per tick ----

  tick(): void {
    const game = this.game;
    if (game === undefined) return;
    const me = game.myPlayer();
    if (me === null) {
      this.mine = null;
      this.occupied = [];
      return;
    }
    this.now = game.ticks();
    const mine = game.insurgencyOf(me.smallID());
    this.mine = mine;
    this.occupied = occupiedBy(game.insurgencies(), me.smallID());

    if (mine !== null && mine.phase === InsurgencyPhase.Ended) {
      if (this.endedSeen !== mine.startTick) {
        this.endedSeen = mine.startTick;
        this.endedOpen = !game.isCatchingUp();
        this.form = null;
        this.picker?.cancel();
        this.timers.push(
          setTimeout(() => (this.endedOpen = false), ENDED_VISIBLE_MS),
        );
      }
    } else if (mine !== null) {
      // Orders that no longer make sense drop out by themselves.
      this.dropStaleForm(mine);
    }
  }

  private dropStaleForm(view: InsurgencyView): void {
    if (this.form === null) return;
    const hasLand = this.hasLand();
    if (this.form.kind === "base") return;
    const name: OrderName = this.form.kind;
    if (whyUnavailable(this.spec(), view, name, this.now, hasLand) !== null) {
      this.form = null;
    }
  }

  // ---- Small helpers ----

  private spec(): InsurgencySpec {
    return this.game.config().insurgencySpec();
  }

  private regionGrid(): RegionGrid {
    this.grid ??= regionGrid(
      this.game.width(),
      this.game.height(),
      this.spec().regionShift,
    );
    return this.grid;
  }

  private label(id: number): string {
    return regionLabel(this.regionGrid(), id);
  }

  private hasLand(): boolean {
    return this.game.myPlayer()?.isAlive() ?? false;
  }

  private ensureStyle(): void {
    if (document.getElementById(STYLE_ID) !== null) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = STYLE;
    document.head.appendChild(style);
  }

  private playerName(smallID: number): string {
    const p = this.game.playerBySmallID(smallID);
    return p.isPlayer() ? p.displayName() : "";
  }

  private time(seconds: number): string {
    return formatCountdown(seconds);
  }

  private blockText(block: OrderBlock): string {
    return translateText(`resistance.block_${block}`);
  }

  private bandText(band: number): string {
    return translateText(`resistance.band_${bandKey(band)}`);
  }

  private intelNote(view: InsurgencyView, regionId: number): string {
    const report = intelFor(view, regionId);
    if (report === undefined) return "";
    const age = this.time(secondsUntil(this.now, report.tick));
    if (!intelIsFresh(this.spec(), report, this.now)) {
      return translateText("resistance.intel_stale", { age });
    }
    return translateText("resistance.intel_line", {
      unrest: report.unrest,
      garrison: renderTroops(report.garrison),
      age,
    });
  }

  private toggleCollapsed(): void {
    this.collapsed = !this.collapsed;
    try {
      localStorage.setItem(STORAGE_KEY, this.collapsed ? "1" : "0");
    } catch {
      // Storage blocked: the panel just opens as usual next time.
    }
  }

  // ---- The map overlay ----

  private overlayModel(): OverlayModel | null {
    const regions: OverlayRegion[] = [];
    const mine = this.mine;
    const showMine = mine !== null && isRunning(mine) && !this.collapsed;
    if (showMine) {
      for (const r of mine.regions) {
        regions.push({
          id: r.id,
          status: r.status,
          band: r.band,
          mine: true,
          hasBase: r.hasBase,
          hasOperation: r.hasOperation,
          suppressed: r.suppressed,
          bandText: this.bandText(r.band),
          note: this.intelNote(mine, r.id),
        });
      }
    }
    if (!this.occCollapsed) {
      for (const o of this.occupied) {
        if (regions.some((x) => x.id === o.region.id && x.mine)) continue;
        regions.push({
          id: o.region.id,
          status: o.region.status,
          band: o.region.band,
          mine: false,
          hasBase: o.region.hasBase,
          hasOperation: o.region.hasOperation,
          suppressed: o.region.suppressed,
          bandText: this.bandText(o.region.band),
          note: "",
        });
      }
    }
    if (regions.length === 0) return null;
    return {
      regions,
      selected: this.selected,
      bases: showMine ? mine.bases.map((b) => b.tile) : [],
      picking: this.picker?.mode === "resistance_base",
    };
  }

  // ---- Orders ----

  private openOrder(order: OrderName): void {
    const view = this.mine;
    if (view === null || !isRunning(view)) return;
    const spec = this.spec();
    this.picker?.cancel();
    if (this.form?.kind === order) {
      this.form = null;
      return;
    }
    switch (order) {
      case "recruit": {
        const b = recruitBounds(spec, view);
        const lo = shownTroops(b.min);
        const hi = shownTroops(b.max);
        this.form = {
          kind: "recruit",
          shown: clamp(roundTo(Math.round(hi / 2), RECRUIT_STEP), lo, hi),
        };
        return;
      }
      case "base":
        this.form = null;
        this.picker?.begin({
          mode: "resistance_base",
          hint: translateText("resistance.pick_base"),
          validate: (tile) => this.baseTileProblem(tile),
          onPick: (tile) => {
            this.collapsed = false;
            this.form = { kind: "base", tile };
          },
        });
        return;
      case "uprising": {
        const eligible = eligibleRegions(spec, view, "uprising", this.now);
        if (!eligible.some((r) => r.id === this.selected)) {
          this.selected = eligible[0]?.id ?? null;
        }
        const lo = shownTroops(spec.uprisingMinTroops);
        const hi = shownTroops(view.available);
        this.form = {
          kind: "uprising",
          shown: clamp(roundTo(Math.round(hi / 2), RECRUIT_STEP), lo, hi),
        };
        return;
      }
      case "intel": {
        const eligible = eligibleRegions(spec, view, "intel", this.now);
        if (!eligible.some((r) => r.id === this.selected)) {
          this.selected = eligible[0]?.id ?? null;
        }
        this.form = { kind: "intel" };
        return;
      }
    }
  }

  /** Why this tile will not do for a base, as a sentence, or null if it will. */
  private baseTileProblem(tile: TileRef): string | null {
    const view = this.mine;
    const me = this.game.myPlayer();
    if (view === null || me === null)
      return translateText("resistance.block_ended");
    if (!this.game.isLand(tile))
      return translateText("resistance.pick_not_land");
    const owner = this.game.owner(tile);
    if (
      !owner.isPlayer() ||
      owner.smallID() === me.smallID() ||
      me.isFriendly(owner)
    ) {
      return translateText("resistance.pick_not_enemy");
    }
    const id = regionOf(
      this.regionGrid(),
      this.game.x(tile),
      this.game.y(tile),
    );
    const target = regionOfView(view, id);
    if (target === undefined)
      return translateText("resistance.pick_not_national");
    const block = previewBase(this.spec(), view, target).block;
    return block === null ? null : this.blockText(block);
  }

  private cancelForm(): void {
    this.form = null;
    this.picker?.cancel();
  }

  private confirmForm(): void {
    const form = this.form;
    const view = this.mine;
    if (form === null || view === null) return;
    const spec = this.spec();
    switch (form.kind) {
      case "recruit": {
        const troops = engineTroops(form.shown);
        if (previewRecruit(spec, view, troops, this.hasLand()).block !== null) {
          return;
        }
        this.eventBus.emit(new SendResistanceRecruitIntentEvent(troops));
        break;
      }
      case "base":
        this.eventBus.emit(new SendResistanceBaseIntentEvent(form.tile));
        break;
      case "uprising": {
        if (this.selected === null) return;
        const target = regionOfView(view, this.selected);
        const troops = engineTroops(form.shown);
        const p = previewUprising(
          spec,
          view,
          target,
          troops,
          this.now,
          this.hasLand(),
        );
        if (p.block !== null) return;
        this.eventBus.emit(
          new SendResistanceUprisingIntentEvent(this.selected, troops),
        );
        break;
      }
      case "intel":
        if (this.selected === null) return;
        this.eventBus.emit(new SendResistanceIntelIntentEvent(this.selected));
        break;
    }
    this.form = null;
    (document.activeElement as HTMLElement | null)?.blur?.();
  }

  private setShown(value: number): void {
    const form = this.form;
    if (
      form === null ||
      (form.kind !== "recruit" && form.kind !== "uprising")
    ) {
      return;
    }
    this.form = { ...form, shown: value };
  }

  private selectRegion(id: number): void {
    this.selected = this.selected === id ? null : id;
  }

  private goToRegion(id: number): void {
    const b = regionBounds(this.regionGrid(), id);
    this.eventBus.emit(
      new GoToPositionEvent((b.x0 + b.x1) >> 1, (b.y0 + b.y1) >> 1),
    );
  }

  // ---- The occupier's order ----

  private suppress(o: OccupiedRegion): void {
    const key = `${o.resistance.owner}:${o.region.id}`;
    if (this.sure !== key) {
      this.sure = key;
      this.timers.push(
        setTimeout(() => {
          if (this.sure === key) this.sure = null;
        }, CONFIRM_MS),
      );
      return;
    }
    this.sure = null;
    const target = this.game.playerBySmallID(o.resistance.owner);
    if (!target.isPlayer()) return;
    this.eventBus.emit(new SendSuppressRegionIntentEvent(target, o.region.id));
    (document.activeElement as HTMLElement | null)?.blur?.();
  }

  // ---- Render ----

  render() {
    const mine = this.mine;
    const view = mine !== null && isRunning(mine) ? mine : null;
    const settled =
      view !== null &&
      (this.now >= view.startTick + SETTLE_TICKS || this.game.isCatchingUp());
    const showMine = view !== null && settled;
    const showEnded = mine !== null && !isRunning(mine) && this.endedOpen;
    const showOcc = this.occupied.length > 0;
    if (!showMine && !showEnded && !showOcc) return nothing;
    return html`
      ${showMine ? this.renderMine(view) : nothing}
      ${showEnded ? this.renderEnded(mine) : nothing}
      ${showOcc ? this.renderOccupier(showMine || showEnded) : nothing}
    `;
  }

  private renderMine(view: InsurgencyView): TemplateResult {
    const limbo = view.phase === InsurgencyPhase.Limbo;
    const left = timeLeftSeconds(view, this.now);
    const spec = this.spec();
    const orders = availableOrders(spec, view, this.now, this.hasLand());
    return html`
      <aside
        class="rc"
        data-rc="mine"
        aria-label=${translateText("resistance.aria")}
      >
        <header class="rc-head" @click=${() => this.toggleCollapsed()}>
          <span class="rc-title">${translateText("resistance.title")}</span>
          <span class="rc-phase ${limbo ? "limbo" : ""}">
            ${translateText(
              limbo ? "resistance.phase_limbo" : "resistance.phase_field",
            )}
          </span>
          <span class="rc-clock ${left <= 60 ? "warn" : ""}" role="timer">
            ${this.time(left)}
            <small>
              ${translateText(
                limbo ? "resistance.time_limbo" : "resistance.time_left",
              )}
            </small>
          </span>
          <button
            class="rc-fold"
            aria-expanded=${!this.collapsed}
            aria-label=${translateText(
              this.collapsed ? "resistance.expand" : "resistance.collapse",
            )}
          >
            ${this.collapsed ? "▸" : "▾"}
          </button>
        </header>
        ${this.collapsed
          ? nothing
          : html`<div class="rc-body">
              ${this.renderStats(view)} ${this.renderRegions(view)}
              <h3>${translateText("resistance.orders")}</h3>
              ${this.renderOrders(view, orders)} ${this.renderForm(view)}
              ${this.renderUnderWay(view)}
            </div>`}
      </aside>
    `;
  }

  private renderStats(view: InsurgencyView): TemplateResult {
    return html`
      <div
        class="rc-meter"
        title=${translateText("resistance.strength_title")}
        data-rc="strength"
      >
        <div style="width: ${view.strength}%"></div>
        <span>
          ${translateText("resistance.strength", { percent: view.strength })}
        </span>
      </div>
      <dl class="rc-stats">
        <div>
          <dt>${translateText("resistance.ready")}</dt>
          <dd data-rc="ready">${renderTroops(view.available)}</dd>
        </div>
        <div>
          <dt>${translateText("resistance.in_field")}</dt>
          <dd>${renderTroops(view.deployed)}</dd>
        </div>
        <div>
          <dt>${translateText("resistance.on_the_way")}</dt>
          <dd>${renderTroops(pendingTroops(view))}</dd>
        </div>
        <div>
          <dt>${translateText("resistance.capacity")}</dt>
          <dd>${renderTroops(view.capacity)}</dd>
        </div>
        <div class="wide">
          <dt>${translateText("resistance.funds")}</dt>
          <dd data-rc="funds">${renderNumber(view.funds)}</dd>
        </div>
      </dl>
    `;
  }

  private renderRegions(view: InsurgencyView): TemplateResult {
    const regions = sortRegions(view.regions);
    return html`
      <h3>${translateText("resistance.regions")}</h3>
      <ul class="rc-regions">
        ${regions.map((r) => this.renderRegion(view, r))}
      </ul>
    `;
  }

  private renderRegion(
    view: InsurgencyView,
    r: InsurgencyRegionView,
  ): TemplateResult {
    const occupied = r.status === InsurgencyRegionStatus.Occupied;
    const state = occupied
      ? r.occupier > 0
        ? translateText("resistance.region_occupied", {
            name: this.playerName(r.occupier),
          })
        : translateText("resistance.region_occupied_unknown")
      : translateText(
          r.status === InsurgencyRegionStatus.Held
            ? "resistance.region_held"
            : "resistance.region_contested",
        );
    const marks = [
      r.hasBase ? translateText("resistance.mark_base") : "",
      r.hasOperation ? translateText("resistance.mark_uprising") : "",
      r.suppressed ? translateText("resistance.mark_suppressed") : "",
      occupied && this.now < r.cooldownUntil
        ? translateText("resistance.cooldown_in", {
            time: this.time(secondsUntil(r.cooldownUntil, this.now)),
          })
        : "",
    ].filter((x) => x !== "");
    const note = this.intelNote(view, r.id);
    const sub = [marks.join(" · "), note].filter((x) => x !== "").join(" — ");
    return html`
      <li
        class="rc-region ${this.selected === r.id ? "sel" : ""}"
        data-region=${r.id}
        @click=${() => this.selectRegion(r.id)}
      >
        <span class="name">${this.label(r.id)}</span>
        <span class="state">${state}</span>
        ${occupied
          ? html`<span class="rc-band b${r.band}">
              ${this.bandText(r.band)}
            </span>`
          : html`<span
              class="rc-band ${r.status === InsurgencyRegionStatus.Held
                ? "rc-held"
                : "b0"}"
            ></span>`}
        <button
          class="go"
          title=${translateText("resistance.go_title")}
          @click=${(e: Event) => {
            e.stopPropagation();
            this.goToRegion(r.id);
          }}
        >
          ${translateText("resistance.go")}
        </button>
        ${sub === "" ? nothing : html`<span class="sub">${sub}</span>`}
      </li>
    `;
  }

  private renderOrders(
    view: InsurgencyView,
    orders: Record<OrderName, boolean>,
  ): TemplateResult {
    const spec = this.spec();
    const button = (
      order: OrderName,
      title: string,
      sub: string,
    ): TemplateResult => {
      const block = whyUnavailable(spec, view, order, this.now, this.hasLand());
      const on =
        this.form?.kind === order || this.picker?.mode === "resistance_base";
      return html`
        <button
          class="rc-order ${on &&
          (this.form?.kind === order ||
            (order === "base" && this.picker?.mode === "resistance_base"))
            ? "on"
            : ""}"
          data-order=${order}
          ?disabled=${!orders[order]}
          title=${block === null ? "" : this.blockText(block)}
          @click=${() => this.openOrder(order)}
        >
          <b>${title}</b>
          <small>${block === null ? sub : this.blockText(block)}</small>
        </button>
      `;
    };
    return html`
      <div class="rc-orders">
        ${button(
          "recruit",
          translateText("resistance.order_recruit"),
          translateText("resistance.order_recruit_sub", {
            gold: renderNumber(spec.recruitGoldPerTroop * 10n),
            time: this.time(Math.round(spec.recruitTicks / 10)),
          }),
        )}
        ${button(
          "base",
          translateText("resistance.order_base"),
          translateText("resistance.gold_sub", {
            gold: renderNumber(spec.baseCost),
          }),
        )}
        ${button(
          "uprising",
          translateText("resistance.order_uprising"),
          translateText("resistance.gold_sub", {
            gold: renderNumber(spec.uprisingCost),
          }),
        )}
        ${button(
          "intel",
          translateText("resistance.order_intel"),
          translateText("resistance.gold_sub", {
            gold: renderNumber(spec.intelCost),
          }),
        )}
      </div>
    `;
  }

  private renderForm(view: InsurgencyView): TemplateResult | typeof nothing {
    const form = this.form;
    if (form === null) return nothing;
    const spec = this.spec();
    const hasLand = this.hasLand();
    const actions = (block: OrderBlock | null) => html`
      ${block === null
        ? nothing
        : html`<p class="rc-bad" data-rc="block">${this.blockText(block)}</p>`}
      <div class="rc-actions">
        <button
          class="go"
          data-rc="confirm"
          ?disabled=${block !== null}
          @click=${() => this.confirmForm()}
        >
          ${translateText("resistance.confirm")}
        </button>
        <button data-rc="cancel" @click=${() => this.cancelForm()}>
          ${translateText("resistance.cancel")}
        </button>
      </div>
    `;
    switch (form.kind) {
      case "recruit": {
        const b = recruitBounds(spec, view);
        const lo = shownTroops(b.min);
        const hi = Math.max(lo, shownTroops(b.max));
        const troops = engineTroops(form.shown);
        const p = previewRecruit(spec, view, troops, hasLand);
        return html`
          <div class="rc-form" data-form="recruit">
            <h4>${translateText("resistance.form_recruit_title")}</h4>
            <label>
              <span>
                ${translateText("resistance.form_troops")}:
                <b>${renderNumber(form.shown)}</b>
              </span>
              <input
                type="range"
                min=${lo}
                max=${hi}
                step=${RECRUIT_STEP}
                .value=${String(clamp(form.shown, lo, hi))}
                @input=${(e: Event) =>
                  this.setShown(Number((e.target as HTMLInputElement).value))}
              />
            </label>
            <ul class="rc-preview">
              <li>
                <span>${translateText("resistance.form_cost")}</span>
                <span>${renderNumber(p.cost)}</span>
              </li>
              <li>
                <span>${translateText("resistance.form_arrive")}</span>
                <span>${this.time(p.seconds)}</span>
              </li>
              <li>
                <span>${translateText("resistance.form_room")}</span>
                <span>${renderTroops(Math.max(0, p.roomAfter))}</span>
              </li>
            </ul>
            ${actions(p.block)}
          </div>
        `;
      }
      case "base": {
        const target = regionOfView(
          view,
          regionOf(
            this.regionGrid(),
            this.game.x(form.tile),
            this.game.y(form.tile),
          ),
        );
        const p = previewBase(spec, view, target);
        return html`
          <div class="rc-form" data-form="base">
            <h4>${translateText("resistance.form_base_title")}</h4>
            <p>
              ${translateText("resistance.form_base_text", {
                region: target === undefined ? "?" : this.label(target.id),
              })}
            </p>
            <ul class="rc-preview">
              <li>
                <span>${translateText("resistance.form_cost")}</span>
                <span>${renderNumber(p.cost)}</span>
              </li>
            </ul>
            ${actions(p.block)}
          </div>
        `;
      }
      case "uprising": {
        const eligible = eligibleRegions(spec, view, "uprising", this.now);
        const target = regionOfView(view, this.selected);
        const lo = shownTroops(spec.uprisingMinTroops);
        const hi = Math.max(lo, shownTroops(view.available));
        const p = previewUprising(
          spec,
          view,
          target,
          engineTroops(form.shown),
          this.now,
          hasLand,
        );
        const hasBase = target?.hasBase ?? false;
        return html`
          <div class="rc-form" data-form="uprising">
            <h4>${translateText("resistance.form_uprising_title")}</h4>
            ${this.regionChooser(eligible)}
            <label>
              <span>
                ${translateText("resistance.form_troops")}:
                <b>${renderNumber(form.shown)}</b>
              </span>
              <input
                type="range"
                min=${lo}
                max=${hi}
                step=${RECRUIT_STEP}
                .value=${String(clamp(form.shown, lo, hi))}
                @input=${(e: Event) =>
                  this.setShown(Number((e.target as HTMLInputElement).value))}
              />
            </label>
            <p>
              ${translateText("resistance.form_uprising_text", {
                occupier:
                  target === undefined ? "?" : this.playerName(target.occupier),
                region: target === undefined ? "?" : this.label(target.id),
              })}
              ${translateText(
                hasBase
                  ? "resistance.form_uprising_base"
                  : "resistance.form_uprising_nobase",
              )}
            </p>
            <ul class="rc-preview">
              <li>
                <span>${translateText("resistance.form_cost")}</span>
                <span>${renderNumber(p.cost)}</span>
              </li>
              <li>
                <span>${translateText("resistance.form_commit")}</span>
                <span>${renderNumber(form.shown)}</span>
              </li>
            </ul>
            ${actions(p.block)}
          </div>
        `;
      }
      case "intel": {
        const eligible = eligibleRegions(spec, view, "intel", this.now);
        const target = regionOfView(view, this.selected);
        const p = previewIntel(spec, view, target, this.now);
        return html`
          <div class="rc-form" data-form="intel">
            <h4>${translateText("resistance.form_intel_title")}</h4>
            ${this.regionChooser(eligible)}
            <p>
              ${translateText("resistance.form_intel_text", {
                region: target === undefined ? "?" : this.label(target.id),
              })}
            </p>
            <ul class="rc-preview">
              <li>
                <span>${translateText("resistance.form_cost")}</span>
                <span>${renderNumber(p.cost)}</span>
              </li>
            </ul>
            ${actions(p.block)}
          </div>
        `;
      }
    }
  }

  private regionChooser(eligible: InsurgencyRegionView[]): TemplateResult {
    return html`
      <label>
        <span>${translateText("resistance.form_region")}</span>
        <select
          data-rc="region"
          @change=${(e: Event) => {
            this.selected = Number((e.target as HTMLSelectElement).value);
          }}
        >
          ${eligible.length === 0 ? html`<option value="">—</option>` : nothing}
          ${eligible.map(
            (r) => html`
              <option value=${r.id} ?selected=${r.id === this.selected}>
                ${this.label(r.id)} · ${this.bandText(r.band)}
              </option>
            `,
          )}
        </select>
      </label>
    `;
  }

  private renderUnderWay(
    view: InsurgencyView,
  ): TemplateResult | typeof nothing {
    const lines: string[] = [];
    for (const p of view.pending) {
      lines.push(
        translateText("resistance.recruits_line", {
          troops: renderTroops(p.troops),
          time: this.time(secondsUntil(p.arrives, this.now)),
        }),
      );
    }
    for (const b of view.bases) {
      lines.push(
        translateText("resistance.base_line", {
          region: this.label(b.region),
          integrity: b.integrity,
        }),
      );
    }
    for (const o of view.operations) {
      lines.push(
        translateText("resistance.uprising_line", {
          region: this.label(o.region),
          troops: renderTroops(o.troops),
          committed: renderTroops(o.committed),
        }),
      );
    }
    if (lines.length === 0) return nothing;
    return html`
      <h3>${translateText("resistance.under_way")}</h3>
      <ul class="rc-list" data-rc="under-way">
        ${lines.map((l) => html`<li>${l}</li>`)}
      </ul>
    `;
  }

  private renderEnded(view: InsurgencyView): TemplateResult {
    const reason = [
      "exhausted",
      "limbo_expired",
      "survival_expired",
      "match_over",
    ].includes(view.endReason)
      ? view.endReason
      : "survival_expired";
    return html`
      <aside class="rc" data-rc="ended" role="status">
        <header class="rc-head">
          <span class="rc-title"
            >${translateText("resistance.ended_title")}</span
          >
        </header>
        <div class="rc-ended">
          <span>${translateText(`resistance.ended_${reason}`)}</span>
          <button @click=${() => (this.endedOpen = false)}>
            ${translateText("resistance.dismiss")}
          </button>
        </div>
      </aside>
    `;
  }

  private renderOccupier(second: boolean): TemplateResult {
    const spec = this.spec();
    const me = this.game.myPlayer();
    const army = me?.troops() ?? 0;
    const running = me
      ? suppressionsRunning(this.game.insurgencies(), me.smallID())
      : 0;
    const shown = this.occupied.slice(0, 6);
    return html`
      <aside
        class="rc ${second ? "second" : ""}"
        data-rc="occupier"
        aria-label=${translateText("resistance.occupier_title")}
      >
        <header
          class="rc-head"
          @click=${() => (this.occCollapsed = !this.occCollapsed)}
        >
          <span class="rc-title">
            ${translateText("resistance.occupier_title")}
          </span>
          <button class="rc-fold" style="margin-left:auto">
            ${this.occCollapsed ? "▸" : "▾"}
          </button>
        </header>
        ${this.occCollapsed
          ? nothing
          : html`<div class="rc-body">
              ${shown.map((o) => this.renderOccupied(o, spec, army, running))}
              ${this.occupied.length > shown.length
                ? html`<span>
                    ${translateText("resistance.more", {
                      count: this.occupied.length - shown.length,
                    })}
                  </span>`
                : nothing}
            </div>`}
      </aside>
    `;
  }

  private renderOccupied(
    o: OccupiedRegion,
    spec: InsurgencySpec,
    army: number,
    running: number,
  ): TemplateResult {
    const key = `${o.resistance.owner}:${o.region.id}`;
    const p = previewSuppress(
      spec,
      army,
      running,
      o.suppressionEndTick !== null,
    );
    const sure = this.sure === key;
    const text = sure
      ? translateText("resistance.suppress_confirm", {
          troops: renderTroops(p.troops),
        })
      : translateText("resistance.suppress_sub", {
          troops: renderTroops(p.troops),
          time: this.time(p.seconds),
        });
    return html`
      <div class="rc-occ-row" data-occupied=${key}>
        <span class="name">${this.label(o.region.id)}</span>
        <span class="state">${this.playerName(o.resistance.owner)}</span>
        <span class="rc-band b${o.region.band}">
          ${this.bandText(o.region.band)}
        </span>
        ${o.suppressionEndTick !== null
          ? html`<span class="busy">
              ${translateText("resistance.suppressing", {
                time: this.time(secondsUntil(o.suppressionEndTick, this.now)),
              })}
            </span>`
          : html`<button
              class=${sure ? "sure" : ""}
              data-rc="suppress"
              ?disabled=${p.block !== null}
              title=${p.block === null
                ? translateText("resistance.suppress_title")
                : translateText(`resistance.suppress_block_${p.block}`)}
              @click=${() => this.suppress(o)}
            >
              <b>${translateText("resistance.suppress")}</b> · ${text}
            </button>`}
      </div>
    `;
  }
}
