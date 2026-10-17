import type { TileRef } from "@openfront/engine-api/game/GameMap";
import { renderNumber } from "@openfront/engine-lib/Format";
import { EventBus } from "@openfront/shared/EventBus";
import { LitElement, html, nothing } from "lit";
import { customElement, state } from "lit/decorators.js";
import { Controller } from "../../Controller";
import type { TilePicker } from "../../resistance/TilePicker";
import { SendFoundCapitalIntentEvent } from "../../Transport";
import { translateText } from "../../Utils";
import type { GameView } from "../../view";

/**
 * The way to found a replacement capital (docs/Capital.md): a small button that
 * appears when the player has land but no capital, names the price, and lets
 * them click a tile of their own for it.
 *
 * It only asks. Whether the match has capitals, that the player has none, that
 * the tile is theirs and off the border, that they can pay and have waited: the
 * simulation checks every one, identically on every client, charges nothing for
 * a refusal and tells the sender why. `validate` here only saves a wasted click.
 */

/** A player with no capital for a moment is just between spawning and the engine founding theirs. */
const SHOW_AFTER_TICKS = 10;
const STYLE_ID = "capital-action-style";
const STYLE = `
capital-action { display: block; }
.capital-action {
  position: fixed; left: 12px; top: 164px; z-index: 1100; box-sizing: border-box;
  display: grid; gap: 1px; text-align: left; padding: 5px 10px; cursor: pointer;
  background: rgba(14, 14, 14, 0.93); color: var(--color-df-text, #f5f5f5);
  border: 1px solid var(--color-df-border, #2b2b2b);
  border-left: 3px solid #ffa500; font: 600 12px Inter, system-ui, sans-serif;
}
.capital-action:not(:disabled):hover, .capital-action.picking { border-color: #ffa500; }
.capital-action:disabled { cursor: not-allowed; opacity: 0.6; }
.capital-action b { font: 700 11.5px var(--font-display, "Pixelify Sans", Inter, sans-serif);
  letter-spacing: 0.08em; text-transform: uppercase; }
.capital-action small { font-size: 10.5px; color: var(--color-df-text-secondary, #a7a7a7); }
`;

@customElement("capital-action")
export class CapitalAction extends LitElement implements Controller {
  public game: GameView;
  public eventBus: EventBus;
  public picker: TilePicker;

  @state() private shown = false;
  @state() private affordable = false;
  @state() private cost = 0n;
  /** A tile is being chosen for the order (for the button's look). */
  @state() private picking = false;

  private missingSince: number | null = null;

  createRenderRoot() {
    return this;
  }

  init() {
    if (document.getElementById(STYLE_ID) !== null) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = STYLE;
    document.head.appendChild(style);
  }

  tick(): void {
    const game = this.game;
    if (game === undefined) return;
    const me = game.myPlayer();
    const config = game.config();
    const eligible =
      config.capitalSystemEnabled() &&
      me !== null &&
      me.hasSpawned() &&
      me.isAlive() &&
      !game.inSpawnPhase() &&
      !me.hasCapital();
    if (!eligible) {
      this.missingSince = null;
      this.shown = false;
      if (this.picker?.mode === "found_capital") this.picker.cancel();
      return;
    }
    this.picking = this.picker?.mode === "found_capital";
    this.missingSince ??= game.ticks();
    this.shown = game.ticks() - this.missingSince >= SHOW_AFTER_TICKS;
    // With infinite gold nothing is charged, as with every other purchase.
    const free = config.gameConfig().infiniteGold === true;
    this.cost = free ? 0n : config.capitalSpec().replacementCost;
    this.affordable = me.gold() >= this.cost;
  }

  /** Reads the picker as it is now: the last render may be a pick behind. */
  private toggle(): void {
    if (this.picker?.mode === "found_capital") {
      this.picker.cancel();
      this.picking = false;
    } else {
      this.begin();
      this.picking = true;
    }
  }

  private begin(): void {
    this.picker?.begin({
      mode: "found_capital",
      hint: translateText("capital_action.pick"),
      validate: (tile) => this.problemWith(tile),
      onPick: (tile) => {
        this.eventBus.emit(new SendFoundCapitalIntentEvent(tile));
        (document.activeElement as HTMLElement | null)?.blur?.();
      },
    });
  }

  /** Why this tile will not do, as a sentence, or null if it will. */
  private problemWith(tile: TileRef): string | null {
    const game = this.game;
    const me = game.myPlayer();
    if (me === null) return translateText("capital_action.tile_not_owned");
    if (!game.isLand(tile)) return translateText("capital_action.tile_water");
    const mine = me.smallID();
    if (game.ownerID(tile) !== mine) {
      return translateText("capital_action.tile_not_owned");
    }
    // A tile with a neighbour that is not theirs (the shore too) is on the
    // border, which the engine refuses: a capital there would fall to the first push.
    const x = game.x(tile);
    const y = game.y(tile);
    for (const [dx, dy] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ]) {
      if (!game.isValidCoord(x + dx, y + dy)) continue;
      if (game.ownerID(game.ref(x + dx, y + dy)) !== mine) {
        return translateText("capital_action.tile_border");
      }
    }
    return null;
  }

  render() {
    if (!this.shown) return nothing;
    return html`
      <button
        class="capital-action ${this.picking ? "picking" : ""}"
        data-capital-action
        ?disabled=${!this.affordable}
        title=${this.affordable
          ? ""
          : translateText("capital_action.need", {
              gold: renderNumber(this.cost),
            })}
        @click=${() => this.toggle()}
      >
        <b>${translateText("capital_action.found")}</b>
        <small>
          ${this.affordable
            ? translateText("capital_action.found_sub", {
                gold: renderNumber(this.cost),
              })
            : translateText("capital_action.need", {
                gold: renderNumber(this.cost),
              })}
        </small>
      </button>
    `;
  }
}
