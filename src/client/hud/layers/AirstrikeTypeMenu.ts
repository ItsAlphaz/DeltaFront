import { TileRef } from "@openfront/engine-api/game/GameMap";
import {
  AirstrikeTypes,
  AirstrikeUnitType,
  BuildableUnit,
  UnitType,
} from "@openfront/engine-api/game/GameTypes";
import { AirstrikeBlockReason } from "@openfront/engine-lib/airstrike/AirstrikeRules";
import { renderNumber } from "@openfront/engine-lib/Format";
import { EventBus } from "@openfront/shared/EventBus";
import { html, LitElement, nothing } from "lit";
import { customElement, state } from "lit/decorators.js";
import { Controller } from "../../Controller";
import {
  airstrikeBlockReason,
  airstrikeReasonText,
} from "../../controllers/AirstrikeTargeting";
import {
  AirstrikeBlockedEvent,
  CloseAirstrikeMenuEvent,
  ShowAirstrikeMenuEvent,
} from "../../InputHandler";
import { BuildUnitIntentEvent } from "../../Transport";
import { UIState } from "../../UIState";
import { translateText } from "../../Utils";
import { GameView } from "../../view";
import {
  bombingRunIcon,
  goldCoinIcon,
  rocketStrikeIcon,
  strafingRunIcon,
} from "../HotbarIcons";

/** Browsers where storage is blocked still work: the last strike type is a convenience. */
const LAST_TYPE_KEY = "airstrike.lastType";
const PANEL_WIDTH = 288;
const PANEL_MARGIN = 16;
const PANEL_HEIGHT_ESTIMATE = 440;
/** A pointer released this soon after the menu opened is the click that opened it. */
const OPEN_GUARD_MS = 150;

interface StrikeOption {
  type: AirstrikeUnitType;
  /** Translation key suffix: unit_type.<key>, build_menu.desc.<key>. */
  key: "bombing_run" | "rocket_strike" | "strafing_run";
  icon: string;
}

const OPTIONS: readonly StrikeOption[] = [
  { type: UnitType.BombingRun, key: "bombing_run", icon: bombingRunIcon },
  { type: UnitType.RocketStrike, key: "rocket_strike", icon: rocketStrikeIcon },
  { type: UnitType.StrafingRun, key: "strafing_run", icon: strafingRunIcon },
];

interface OptionState {
  cost: bigint;
  /** Why this strike cannot be launched at the target right now (null = it can). */
  reason: AirstrikeBlockReason | null;
  reasonText: string;
}

function readLastType(): AirstrikeUnitType | null {
  try {
    const stored = localStorage.getItem(LAST_TYPE_KEY);
    return AirstrikeTypes.types.find((t) => t === stored) ?? null;
  } catch {
    return null;
  }
}

function writeLastType(type: AirstrikeUnitType): void {
  try {
    localStorage.setItem(LAST_TYPE_KEY, type);
  } catch {
    // Storage blocked: the menu just opens on the default next time.
  }
}

/**
 * The strike-type menu: after an Airstrike is aimed at a valid target, the
 * player picks Bombing Run, Rocket Strike or Strafing Run here, and only
 * then is anything launched.
 *
 * State lives in `uiState.airstrikeTarget` (non-null exactly while the menu
 * is shown) and `uiState.airstrikeType` (the selection). Every way of closing
 * goes through `close()`, so the menu can never be left open without its
 * target or the other way round, and a launch is emitted at most once per
 * opening. The simulation decides everything: this only sends the intent.
 */
@customElement("airstrike-type-menu")
export class AirstrikeTypeMenu extends LitElement implements Controller {
  public game: GameView;
  public eventBus: EventBus;
  public uiState: UIState;

  @state() private open = false;
  @state() private tile: TileRef | null = null;
  @state() private pos = { x: 0, y: 0 };
  @state() private states = new Map<AirstrikeUnitType, OptionState>();

  private launching = false;
  private openedAt = 0;
  private refreshSeq = 0;

  createRenderRoot() {
    return this;
  }

  init() {
    this.uiState.airstrikeType = readLastType() ?? this.uiState.airstrikeType;
    this.eventBus.on(ShowAirstrikeMenuEvent, (e) =>
      this.show(e.tile, e.x, e.y),
    );
    this.eventBus.on(CloseAirstrikeMenuEvent, () => this.hide());
  }

  tick() {
    if (!this.open) return;
    // Self-heal: the menu only exists while aiming an Airstrike in a live game.
    const me = this.game.myPlayer();
    if (
      this.uiState.ghostStructure !== UnitType.Airstrike ||
      this.uiState.airstrikeTarget === null ||
      me === null ||
      !me.isAlive() ||
      this.game.inSpawnPhase()
    ) {
      this.close("ghost_changed");
      return;
    }
    void this.refresh();
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.removeListeners();
  }

  // --- opening and closing -------------------------------------------------

  private show(tile: TileRef, x: number, y: number) {
    this.uiState.airstrikeTarget = tile;
    this.tile = tile;
    this.pos = { x, y };
    this.launching = false;
    this.openedAt = performance.now();
    this.open = true;
    this.addListeners();
    void this.refresh();
  }

  /** Hide without telling anyone (the close event already went out). */
  private hide() {
    if (!this.open) return;
    this.open = false;
    this.tile = null;
    this.launching = false;
    this.removeListeners();
    // Give the keyboard back to the game.
    (document.activeElement as HTMLElement | null)?.blur?.();
  }

  private close(reason: CloseAirstrikeMenuEvent["reason"]) {
    this.uiState.airstrikeTarget = null;
    this.hide();
    this.eventBus.emit(new CloseAirstrikeMenuEvent(reason));
  }

  // --- data -------------------------------------------------------------------

  /** Re-asks the engine whether each strike can be launched at the target. */
  private async refresh() {
    const me = this.game.myPlayer();
    const tile = this.tile;
    if (!me || tile === null) return;
    const seq = ++this.refreshSeq;
    const buildables = await me.buildables(tile, AirstrikeTypes.types);
    if (seq !== this.refreshSeq || !this.open || tile !== this.tile) return;
    const next = new Map<AirstrikeUnitType, OptionState>();
    for (const option of OPTIONS) {
      const b: BuildableUnit | undefined = buildables.find(
        (u) => u.type === option.type,
      );
      const cost = b?.cost ?? 0n;
      const reason = airstrikeBlockReason(
        this.game,
        me,
        option.type,
        tile,
        b !== undefined && b.canBuild !== false,
        cost,
      );
      next.set(option.type, {
        cost,
        reason,
        reasonText:
          reason === null
            ? ""
            : airstrikeReasonText(this.game, me, reason, tile),
      });
    }
    this.states = next;
  }

  private selectedOption(): StrikeOption {
    return (
      OPTIONS.find((o) => o.type === this.uiState.airstrikeType) ?? OPTIONS[0]
    );
  }

  private launchable(type: AirstrikeUnitType): boolean {
    return this.states.get(type)?.reason === null;
  }

  // --- selection ------------------------------------------------------------

  private select(type: AirstrikeUnitType) {
    this.uiState.airstrikeType = type;
    this.requestUpdate();
    void this.refresh();
  }

  /** Arrow/Home/End movement: skips strikes that cannot be launched. */
  private move(step: 1 | -1) {
    const from = OPTIONS.findIndex(
      (o) => o.type === this.selectedOption().type,
    );
    for (let i = 1; i <= OPTIONS.length; i++) {
      const candidate =
        OPTIONS[(from + step * i + OPTIONS.length * 2) % OPTIONS.length];
      if (this.launchable(candidate.type)) {
        this.select(candidate.type);
        return;
      }
    }
    // Nothing launchable: still step, so the player can read each reason.
    this.select(OPTIONS[(from + step + OPTIONS.length) % OPTIONS.length].type);
  }

  // --- launching ------------------------------------------------------------

  private async launch() {
    if (this.launching || !this.open || this.tile === null) return;
    const option = this.selectedOption();
    const tile = this.tile;
    const me = this.game.myPlayer();
    if (!me) return;
    if (!this.launchable(option.type)) {
      this.eventBus.emit(new AirstrikeBlockedEvent(tile));
      return;
    }
    // One launch per opening, even if Enter is pressed twice.
    this.launching = true;
    // Check again against the engine: the target may have changed owner or the
    // airport may have fired since the menu opened.
    const buildables = await me.buildables(tile, [option.type]);
    const b = buildables.find((u) => u.type === option.type);
    if (!this.open || this.tile !== tile) return;
    if (!b || b.canBuild === false) {
      this.launching = false;
      this.eventBus.emit(new AirstrikeBlockedEvent(tile));
      void this.refresh();
      return;
    }
    this.eventBus.emit(new BuildUnitIntentEvent(option.type, tile));
    this.uiState.airstrikeType = option.type;
    writeLastType(option.type);
    this.close("launched");
  }

  // --- input ------------------------------------------------------------------

  private onKeyDown = (e: KeyboardEvent) => {
    if (!this.open) return;
    const insideButton =
      e.target instanceof HTMLElement &&
      this.contains(e.target) &&
      e.target.tagName === "BUTTON" &&
      e.target.getAttribute("role") !== "radio";
    const consume = () => {
      e.preventDefault();
      e.stopPropagation();
    };
    switch (e.code) {
      case "Escape":
        consume();
        this.close("escape");
        return;
      case "ArrowDown":
      case "ArrowRight":
        consume();
        this.move(1);
        return;
      case "ArrowUp":
      case "ArrowLeft":
        consume();
        this.move(-1);
        return;
      case "Home":
        consume();
        this.select(OPTIONS[0].type);
        return;
      case "End":
        consume();
        this.select(OPTIONS[OPTIONS.length - 1].type);
        return;
      case "Digit1":
      case "Numpad1":
      case "Digit2":
      case "Numpad2":
      case "Digit3":
      case "Numpad3": {
        consume();
        // Digits only select; launching always takes a deliberate Enter or click.
        this.select(OPTIONS[Number(e.code.slice(-1)) - 1].type);
        return;
      }
      case "Enter":
      case "NumpadEnter":
      case "Space":
        // A focused Cancel/Close button keeps its own Enter/Space behavior.
        if (insideButton) {
          e.stopPropagation();
          return;
        }
        consume();
        void this.launch();
        return;
      case "Tab":
        this.trapFocus(e);
        return;
    }
    // Everything else is swallowed so no game keybind fires behind the menu.
    if (!e.metaKey && !e.ctrlKey && !e.altKey) e.stopPropagation();
  };

  private trapFocus(e: KeyboardEvent) {
    const focusable = Array.from(
      this.querySelectorAll<HTMLElement>(
        "button:not([disabled]), [role=radio][tabindex='0']",
      ),
    );
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const active = document.activeElement;
    if (e.shiftKey && (active === first || !this.contains(active))) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && (active === last || !this.contains(active))) {
      e.preventDefault();
      first.focus();
    }
  }

  private onPointerDown = (e: PointerEvent) => {
    if (!this.open || this.contains(e.target as Node)) return;
    // A mouse click on the map closes the menu through the build preview
    // (which swallows it); anywhere else, or a touch, closes it here.
    if (e.pointerType === "mouse" && e.target instanceof HTMLCanvasElement) {
      return;
    }
    this.close("outside");
  };

  private addListeners() {
    window.addEventListener("keydown", this.onKeyDown, true);
    window.addEventListener("pointerdown", this.onPointerDown, true);
  }

  private removeListeners() {
    window.removeEventListener("keydown", this.onKeyDown, true);
    window.removeEventListener("pointerdown", this.onPointerDown, true);
  }

  private onWheel(e: WheelEvent) {
    e.preventDefault();
    e.stopPropagation();
    this.move(e.deltaY > 0 ? 1 : -1);
  }

  private onOptionClick(type: AirstrikeUnitType) {
    if (performance.now() - this.openedAt < OPEN_GUARD_MS) return;
    this.select(type);
  }

  private onOptionDoubleClick(type: AirstrikeUnitType) {
    if (performance.now() - this.openedAt < OPEN_GUARD_MS) return;
    this.select(type);
    void this.launch();
  }

  protected updated() {
    // Focus the selected option when the menu opens.
    if (this.open && !this.contains(document.activeElement)) {
      this.querySelector<HTMLElement>(
        "[role=radio][aria-checked=true]",
      )?.focus();
    }
  }

  // --- rendering --------------------------------------------------------------

  private panelStyle(): string {
    if (window.innerWidth < 640) return "";
    const left = Math.min(
      Math.max(PANEL_MARGIN, this.pos.x + PANEL_MARGIN),
      window.innerWidth - PANEL_WIDTH - PANEL_MARGIN,
    );
    const top = Math.min(
      Math.max(PANEL_MARGIN, this.pos.y + PANEL_MARGIN),
      Math.max(
        PANEL_MARGIN,
        window.innerHeight - PANEL_HEIGHT_ESTIMATE - PANEL_MARGIN,
      ),
    );
    return `left:${left}px;top:${top}px;width:${PANEL_WIDTH}px`;
  }

  private renderOption(option: StrikeOption, index: number) {
    const selected = option.type === this.selectedOption().type;
    const state = this.states.get(option.type);
    const blocked = state !== undefined && state.reason !== null;
    const reasonId = `airstrike-reason-${option.key}`;
    return html`
      <button
        type="button"
        role="radio"
        aria-checked=${selected ? "true" : "false"}
        aria-disabled=${blocked ? "true" : "false"}
        aria-describedby=${reasonId}
        tabindex=${selected ? "0" : "-1"}
        class="w-full min-h-[64px] flex items-start gap-3 p-2.5 rounded-sm border text-left transition-colors cursor-pointer focus-visible:outline-2 focus-visible:outline-df-text ${selected
          ? "border-df-red bg-df-red/15"
          : "border-df-border bg-df-bg-secondary hover:border-df-red"} ${blocked
          ? "opacity-70"
          : ""}"
        @click=${() => this.onOptionClick(option.type)}
        @dblclick=${() => this.onOptionDoubleClick(option.type)}
      >
        <img src=${option.icon} alt="" class="size-8 shrink-0 mt-0.5" />
        <span class="flex-1 min-w-0">
          <span class="flex items-baseline justify-between gap-2">
            <span class="font-bold text-sm uppercase tracking-wide text-df-text"
              >${translateText(`unit_type.${option.key}`)}</span
            >
            <span
              class="text-[10px] text-df-text-muted shrink-0"
              aria-hidden="true"
              >${index + 1}</span
            >
          </span>
          <span class="block text-xs text-df-text-secondary leading-snug"
            >${translateText(`build_menu.desc.${option.key}`, {
              range: this.game.config().airportRange(),
            })}</span
          >
          <span
            class="mt-1 flex items-center gap-1 text-xs text-yellow-300"
            translate="no"
          >
            <img src=${goldCoinIcon} alt="" class="size-3" />
            ${state === undefined ? "" : renderNumber(state.cost)}
          </span>
          <span id=${reasonId} class="block text-xs text-df-red-bright"
            >${blocked ? state.reasonText : ""}</span
          >
        </span>
      </button>
    `;
  }

  render() {
    if (!this.open) return nothing;
    const sheet = window.innerWidth < 640;
    const canLaunch = this.launchable(this.selectedOption().type);
    return html`
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="airstrike-menu-title"
        class="${sheet
          ? "fixed inset-x-0 bottom-0 pb-[env(safe-area-inset-bottom)] rounded-t-md"
          : "fixed rounded-md"} z-[9999] bg-df-panel border border-df-border shadow-2xl text-df-text pointer-events-auto"
        style=${this.panelStyle()}
        @contextmenu=${(e: Event) => {
          e.preventDefault();
          this.close("right_click");
        }}
        @wheel=${(e: WheelEvent) => this.onWheel(e)}
      >
        <div class="flex items-center justify-between px-3 pt-3 pb-2">
          <h2
            id="airstrike-menu-title"
            class="text-sm font-bold uppercase tracking-wider text-df-text"
          >
            ${translateText("airstrike_menu.title")}
          </h2>
          <button
            type="button"
            class="size-11 -mr-2 -mt-2 flex items-center justify-center text-df-text-secondary hover:text-df-text focus-visible:outline-2 focus-visible:outline-df-text"
            aria-label=${translateText("airstrike_menu.close")}
            @click=${() => this.close("cancel")}
          >
            ✕
          </button>
        </div>
        <div
          role="radiogroup"
          aria-labelledby="airstrike-menu-title"
          class="flex flex-col gap-2 px-3"
        >
          ${OPTIONS.map((o, i) => this.renderOption(o, i))}
        </div>
        <div class="flex gap-2 px-3 pt-3">
          <button
            type="button"
            class="df-btn df-btn-secondary flex-1 min-h-11"
            @click=${() => this.close("cancel")}
          >
            ${translateText("airstrike_menu.cancel")}
          </button>
          <button
            type="button"
            class="df-btn df-btn-primary flex-1 min-h-11"
            ?disabled=${!canLaunch}
            @click=${() => void this.launch()}
          >
            ${translateText("airstrike_menu.launch")}
          </button>
        </div>
        <p class="px-3 pt-2 pb-3 text-[10px] text-df-text-muted">
          ${translateText("airstrike_menu.hint")}
        </p>
      </div>
    `;
  }
}
