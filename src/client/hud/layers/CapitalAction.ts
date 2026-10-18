import type { TileRef } from "@openfront/engine-api/game/GameMap";
import { renderNumber } from "@openfront/engine-lib/Format";
import { EventBus } from "@openfront/shared/EventBus";
import { LitElement, html, nothing } from "lit";
import { customElement, state } from "lit/decorators.js";
import { formatCountdown } from "../../capital/CrisisClock";
import { Controller } from "../../Controller";
import type { TilePicker } from "../../resistance/TilePicker";
import { SendFoundCapitalIntentEvent } from "../../Transport";
import { translateText } from "../../Utils";
import type { GameView } from "../../view";

/**
 * The way to buy a capital (docs/Capital.md): a small panel for a player with
 * land and no capital. It names the price and how much of it they hold, lets
 * them click a tile of their own for it, and explains what having none costs:
 * the strain that starts after the opening grace. (The strain is not the CRISIS
 * a captured capital brings; it is amber, slow, and ends the moment they buy.)
 *
 * It only asks. Whether the match has capitals, that the player has none, that
 * the tile is theirs and off the border, that they can pay and have waited: the
 * simulation checks every one, identically on every client, charges nothing for
 * a refusal and tells the sender why. `validate` here only saves a wasted click.
 */

const STYLE_ID = "capital-action-style";
/** Where the panel ends, for whatever stacks under it (ResistanceCommand). */
const PANEL_BOTTOM_VAR = "--df-capital-panel-bottom";
const STYLE = `
capital-action { display: block; }
.capital-action, .capital-owned {
  position: fixed; left: 8px; z-index: 1100; box-sizing: border-box;
  width: 232px; display: grid; gap: 4px; text-align: center; padding: 6px 10px 8px; cursor: pointer;
  background: rgba(14, 14, 14, 0.93); color: var(--color-df-text, #f5f5f5);
  border: 1px solid var(--color-df-border, #2b2b2b);
  border-left: 3px solid #ffa500; font: 600 12px Inter, system-ui, sans-serif;
}
.capital-action:not(:disabled):hover, .capital-action.picking { border-color: #ffa500; }
.capital-action:disabled { cursor: not-allowed; opacity: 0.85; }
.capital-action b { font: 700 11.5px var(--font-display, "Pixelify Sans", Inter, sans-serif);
  letter-spacing: 0.08em; text-transform: uppercase; }
.capital-action small { font-size: 10.5px; color: var(--color-df-text-secondary, #a7a7a7); }
.capital-action .meter { height: 4px; background: rgba(255,255,255,0.12); }
.capital-action .meter i { display: block; height: 100%; background: #ffa500; }
.capital-action.ready .meter i { background: #3fbf7f; }
.capital-action .strain { font-size: 10.5px; line-height: 1.3; color: var(--color-df-text-secondary, #a7a7a7); }
.capital-action .strain.on { color: #ffb020; font-weight: 700; }
.capital-owned { cursor: default; border-left-color: #3fbf7f; }
.capital-owned.building { border-left-color: #ffa500; }
.capital-owned.building b { color: #ffd45c; }
.capital-owned.building .meter i { background: #ffa500; }
.capital-owned b { font: 700 11.5px var(--font-display, "Pixelify Sans", Inter, sans-serif);
  letter-spacing: 0.08em; text-transform: uppercase; color: #8fe3b4; }
.capital-owned small { font-size: 10.5px; color: var(--color-df-text-secondary, #a7a7a7); }
.capital-owned .meter { height: 4px; background: rgba(255,255,255,0.12); }
.capital-owned .meter i { display: block; height: 100%; background: #3fbf7f; }
.capital-owned .perks { font-size: 10.5px; line-height: 1.35; color: var(--color-df-text, #f5f5f5); }
`;

@customElement("capital-action")
export class CapitalAction extends LitElement implements Controller {
  public game: GameView;
  public eventBus: EventBus;
  public picker: TilePicker;

  @state() private shown = false;
  /** The player has a capital: the panel shows what it is doing for them. */
  @state() private owned = false;
  /** A capital is being built: how far along (0 to 100) and the seconds left. */
  @state() private building = false;
  @state() private buildPercent = 0;
  @state() private buildIn = 0;
  /** How much of its bonuses the capital gives (50 to 100) and the seconds until all of them. */
  @state() private strength = 0;
  @state() private rampIn = 0;
  /** Where the panel's top is: under the leaderboard, with a gap, wherever that ends. */
  @state() private panelTop = 164;
  @state() private affordable = false;
  @state() private cost = 0n;
  @state() private gold = 0n;
  /** Seconds until strain begins (0 once it has), and the strain now, in percent. */
  @state() private strainIn = 0;
  @state() private strainNow = 0;
  @state() private inCrisis = false;
  /** A tile is being chosen for the order (for the button's look). */
  @state() private picking = false;

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
      !game.inSpawnPhase();
    if (!eligible) {
      this.shown = false;
      if (this.picker?.mode === "found_capital") this.picker.cancel();
      return;
    }
    this.placeUnderLeaderboard();
    this.building = !me.hasCapital() && me.isBuildingCapital();
    if (this.building) {
      this.owned = false;
      this.picking = false;
      if (this.picker?.mode === "found_capital") this.picker.cancel();
      this.shown = true;
      this.buildPercent = me.capitalBuildPercent();
      this.buildIn = Math.ceil(me.capitalBuildRemainingTicks() / 10);
      return;
    }
    this.owned = me.hasCapital();
    if (this.owned) {
      if (this.picker?.mode === "found_capital") this.picker.cancel();
      this.picking = false;
      this.shown = true;
      this.strength = me.capitalStrengthPercent();
      const spec = config.capitalSpec();
      this.rampIn = Math.max(
        0,
        Math.ceil(
          (me.capitalFoundedTick() + spec.rampTicks - game.ticks()) / 10,
        ),
      );
      return;
    }
    this.picking = this.picker?.mode === "found_capital";
    this.shown = true;
    // With infinite gold nothing is charged, as with every other purchase.
    const free = config.gameConfig().infiniteGold === true;
    this.cost = free ? 0n : config.capitalSpec().cost;
    this.gold = me.gold();
    this.affordable = this.gold >= this.cost;
    this.inCrisis = me.inCrisis();
    const start = me.strainStartTick();
    this.strainIn =
      start < 0 ? 0 : Math.max(0, Math.ceil((start - game.ticks()) / 10));
    this.strainNow = me.strainPercentNow();
  }

  /**
   * The panel goes under the leaderboard, which grows and shrinks, with a gap
   * between them (never over it).
   */
  private placeUnderLeaderboard(): void {
    const side = document.querySelector("game-left-sidebar aside");
    const bottom = side?.getBoundingClientRect().bottom ?? 0;
    this.panelTop = Math.max(56, Math.ceil(bottom) + 14);
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
      ghost: true,
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

  /**
   * The panel is taller than the single button it was, and the resistance's
   * command panel sits under it in the same column: tell it where this one ends
   * (a CSS variable on the page) so the two never overlap.
   */
  updated(): void {
    const root = document.documentElement.style;
    const panel = this.querySelector<HTMLElement>(
      "[data-capital-action], [data-capital-owned], [data-capital-building]",
    );
    if (!this.shown || panel === null) {
      root.removeProperty(PANEL_BOTTOM_VAR);
      return;
    }
    root.setProperty(
      PANEL_BOTTOM_VAR,
      `${Math.ceil(panel.getBoundingClientRect().bottom) + 8}px`,
    );
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    document.documentElement.style.removeProperty(PANEL_BOTTOM_VAR);
  }

  /** What a capital gives, for the button's tooltip. */
  private benefits(): string {
    const spec = this.game.config().capitalSpec();
    return translateText("capital_action.benefits", {
      troops: renderNumber(spec.bonusMaxTroops),
      discount: spec.bonusDiscountPercent,
      income: spec.bonusIncomePercent,
      regen: spec.bonusRegenPercent,
      loss: spec.bonusAttackLossPercent,
      minutes: Math.round(spec.rampTicks / 600),
    });
  }

  private strainText(): string {
    const spec = this.game.config().capitalSpec();
    if (this.inCrisis) return translateText("capital_action.strain_crisis");
    if (this.strainNow > 0) {
      return translateText("capital_action.strain_now", {
        percent: this.strainNow,
        max: spec.strainMaxPercent,
      });
    }
    return translateText("capital_action.strain_soon", {
      time: formatCountdown(this.strainIn),
      rate: spec.strainPercentPerMinute,
      max: spec.strainMaxPercent,
    });
  }

  /** What the capital is doing for the player: its bonuses and how far they have grown. */
  private renderOwned() {
    const spec = this.game.config().capitalSpec();
    const full = this.strength >= 100;
    return html`
      <div
        class="capital-owned"
        data-capital-owned
        style="top: ${this.panelTop}px"
        title=${this.benefits()}
      >
        <b>${translateText("capital_action.owned")}</b>
        <small>
          ${full
            ? translateText("capital_action.full")
            : translateText("capital_action.ramping", {
                percent: this.strength,
                time: formatCountdown(this.rampIn),
              })}
        </small>
        ${full
          ? nothing
          : html`<span class="meter" aria-hidden="true"
              ><i style="width: ${this.strength}%"></i
            ></span>`}
        <span class="perks" data-capital-perks>
          ${translateText("capital_action.perks", {
            troops: renderNumber(spec.bonusMaxTroops),
            discount: spec.bonusDiscountPercent,
            income: spec.bonusIncomePercent,
            regen: spec.bonusRegenPercent,
          })}
        </span>
      </div>
    `;
  }

  /** Paid for and going up: how far along, with the way it can go wrong. */
  private renderBuilding() {
    return html`
      <div
        class="capital-owned building"
        data-capital-building
        style="top: ${this.panelTop}px"
      >
        <b>${translateText("capital_action.building")}</b>
        <small>
          ${translateText("capital_action.building_sub", {
            time: formatCountdown(this.buildIn),
          })}
        </small>
        <span class="meter" aria-hidden="true"
          ><i style="width: ${this.buildPercent}%"></i
        ></span>
        <span class="perks"
          >${translateText("capital_action.building_hint")}</span
        >
      </div>
    `;
  }

  render() {
    if (!this.shown) return nothing;
    if (this.building) return this.renderBuilding();
    if (this.owned) return this.renderOwned();
    const share =
      this.cost === 0n
        ? 100
        : Math.min(100, Number((this.gold * 100n) / this.cost));
    return html`
      <button
        class="capital-action ${this.picking ? "picking" : ""} ${this.affordable
          ? "ready"
          : ""}"
        data-capital-action
        style="top: ${this.panelTop}px"
        ?disabled=${!this.affordable}
        title=${this.affordable
          ? this.benefits()
          : `${translateText("capital_action.need", {
              gold: renderNumber(this.cost - this.gold),
            })}\n${this.benefits()}`}
        @click=${() => this.toggle()}
      >
        <b>${translateText("capital_action.found")}</b>
        <small>
          ${this.affordable
            ? translateText("capital_action.found_sub", {
                gold: renderNumber(this.cost),
              })
            : translateText("capital_action.progress", {
                have: renderNumber(this.gold),
                cost: renderNumber(this.cost),
              })}
        </small>
        <span class="meter" aria-hidden="true"
          ><i style="width: ${share}%"></i
        ></span>
        <span
          class="strain ${this.strainNow > 0 && !this.inCrisis ? "on" : ""}"
          data-capital-strain
          >${this.strainText()}</span
        >
      </button>
    `;
  }
}
