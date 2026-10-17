import type { TileRef } from "@openfront/engine-api/game/GameMap";
import { EventBus } from "@openfront/shared/EventBus";
import { Controller } from "../Controller";
import { MouseUpEvent } from "../InputHandler";
import type { TransformHandler } from "../TransformHandler";
import type { PickMode, UIState } from "../UIState";
import { translateText } from "../Utils";
import type { GameView } from "../view";

/**
 * Choosing a tile for an order: a resistance base, a replacement capital.
 *
 * While a pick is under way the next map click belongs to it and not to the
 * attack a click normally sends (`uiState.pickMode`, which the map-click handler
 * respects). A tile that cannot be used says why and the pick stays open; a good
 * one ends it and hands the tile to the order. Escape or the hint's button ends
 * it with nothing sent.
 *
 * It only chooses. What an order costs, whether it is allowed and what it does
 * are the simulation's: `validate` is there to save a wasted click, nothing more.
 */
export interface PickRequest {
  mode: PickMode;
  /** What to tell the player while they choose. */
  hint: string;
  /** Why this tile will not do (a sentence for the player), or null when it will. */
  validate: (tile: TileRef) => string | null;
  onPick: (tile: TileRef) => void;
}

const STYLE_ID = "tile-picker-style";
const STYLE = `
.tile-picker-hint {
  position: fixed; left: 50%; top: 76px; transform: translateX(-50%);
  z-index: 1400; max-width: min(560px, 92vw); box-sizing: border-box;
  display: flex; align-items: center; gap: 12px; padding: 8px 14px;
  background: rgba(10, 10, 10, 0.92);
  border: 1px solid var(--color-df-border, #2b2b2b);
  border-left: 3px solid var(--color-df-red, #e31b23);
  color: var(--color-df-text, #f5f5f5);
  font: 600 14px/1.3 var(--font-display, "Pixelify Sans", Inter, sans-serif);
  letter-spacing: 0.04em; pointer-events: none;
}
.tile-picker-hint .msg { flex: 1; }
.tile-picker-hint .msg.bad { color: #ffb347; }
.tile-picker-hint button {
  pointer-events: auto; cursor: pointer; padding: 4px 10px;
  background: var(--color-df-panel, #1a1a1a); color: inherit;
  border: 1px solid var(--color-df-border, #2b2b2b);
  font: inherit; text-transform: uppercase; letter-spacing: 0.08em;
}
.tile-picker-hint button:hover { border-color: var(--color-df-red, #e31b23); }
`;

export class TilePicker implements Controller {
  private request: PickRequest | null = null;
  private hintEl: HTMLElement | null = null;
  private messageEl: HTMLElement | null = null;
  private readonly onKey = (e: KeyboardEvent) => {
    if (e.code === "Escape") this.cancel();
  };

  constructor(
    private readonly game: GameView,
    private readonly eventBus: EventBus,
    private readonly uiState: UIState,
    private readonly transformHandler: TransformHandler,
  ) {
    // Registered once for the life of the game: the bus walks its listeners
    // while it calls them, so a listener that removed itself in the middle of a
    // click could make it skip a neighbour.
    this.eventBus.on(MouseUpEvent, (e) => this.onClick(e));
  }

  /** What is being chosen, or null. */
  get mode(): PickMode | null {
    return this.request?.mode ?? null;
  }

  /** Starts choosing; a pick already under way is dropped without sending anything. */
  begin(request: PickRequest): void {
    this.end();
    this.request = request;
    this.uiState.pickMode = request.mode;
    this.showHint(request.hint);
    window.addEventListener("keydown", this.onKey, true);
  }

  /** Stops choosing, sending nothing. */
  cancel(): void {
    this.end();
  }

  /** Self-heal: a pick has no meaning once the game is over or the player has no say in it. */
  tick(): void {
    if (this.request === null) return;
    const me = this.game.myPlayer();
    if (me === null || this.game.inSpawnPhase()) this.end();
  }

  private end(): void {
    if (this.request === null && this.hintEl === null) return;
    this.request = null;
    this.uiState.pickMode = null;
    window.removeEventListener("keydown", this.onKey, true);
    this.hintEl?.remove();
    this.hintEl = null;
    this.messageEl = null;
  }

  private onClick(e: MouseUpEvent): void {
    const request = this.request;
    if (request === null) return;
    const cell = this.transformHandler.screenToWorldCoordinates(e.x, e.y);
    if (!this.game.isValidCoord(cell.x, cell.y)) return;
    const tile = this.game.ref(cell.x, cell.y);
    const why = request.validate(tile);
    if (why !== null) {
      this.say(why, true);
      return;
    }
    // After the bus has finished with this click: the map-click handler, which
    // may run after this one, must still see that a tile was being picked.
    queueMicrotask(() => {
      if (this.request !== request) return;
      this.end();
      request.onPick(tile);
    });
  }

  // ---- The hint ----

  private ensureStyle(): void {
    if (document.getElementById(STYLE_ID) !== null) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = STYLE;
    document.head.appendChild(style);
  }

  private showHint(text: string): void {
    this.ensureStyle();
    const el = document.createElement("div");
    el.className = "tile-picker-hint";
    el.setAttribute("role", "status");
    const msg = document.createElement("span");
    msg.className = "msg";
    msg.textContent = text;
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.textContent = translateText("tile_picker.cancel");
    cancel.addEventListener("click", () => this.cancel());
    el.append(msg, cancel);
    document.body.appendChild(el);
    this.hintEl = el;
    this.messageEl = msg;
  }

  private say(text: string, bad: boolean): void {
    if (this.messageEl === null) return;
    this.messageEl.textContent = text;
    this.messageEl.classList.toggle("bad", bad);
  }
}
