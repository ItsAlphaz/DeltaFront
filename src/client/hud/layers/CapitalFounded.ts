import {
  GameUpdateType,
  type CapitalEventUpdate,
} from "@openfront/engine-api/game/GameUpdates";
import { renderNumber } from "@openfront/engine-lib/Format";
import { EventBus } from "@openfront/shared/EventBus";
import { LitElement, css, html, nothing } from "lit";
import { customElement, state } from "lit/decorators.js";
import { Controller } from "../../Controller";
import { PlaySoundEffectEvent } from "../../sound/Sounds";
import { translateText } from "../../Utils";
import type { GameView } from "../../view";

/**
 * What the player sees and hears about their capital, off to the side so the
 * game stays in view:
 *
 *  - when they buy one (the building begins): the build sound every building
 *    has;
 *  - when it stands: a card that slides in from the left edge under the capital
 *    panel, with a glowing edge, a sweep of light, sparkles and the bonuses
 *    popping in one by one; a pulse along the left edge of the screen; and a
 *    chime. It leaves by itself after a few seconds. A burst of rings goes off
 *    on the map where it stands (CapitalMarkers).
 *
 * It is driven by the engine's CapitalEvent ("building", "founded", once per
 * capital), and the numbers are the rules' own (`capitalSpec`), so it cannot
 * disagree with the game. Nothing is shown or played while the game is catching
 * up (a rejoining client replays old events), and nothing takes pointer events.
 * Reduced motion: the same card and words, no movement.
 */

const SHOW_MS = 9_000;
/** Where the capital panel ends (it reports this itself), else under the leaderboard. */
const FALLBACK_TOP = 200;
const EXTRA_VAR = "--df-capital-extra";

@customElement("capital-founded")
export class CapitalFounded extends LitElement implements Controller {
  public game: GameView;
  public eventBus: EventBus;

  @state() private shown = false;
  @state() private replacement = false;
  @state() private leaving = false;
  @state() private top = FALLBACK_TOP;

  private seen = new Set<string>();
  private timers: ReturnType<typeof setTimeout>[] = [];

  static styles = css`
    :host {
      position: fixed;
      inset: 0;
      z-index: 1450;
      pointer-events: none;
      font-family: var(--font-display, "Pixelify Sans", Inter, sans-serif);
    }
    .edge {
      position: fixed;
      left: 0;
      top: 0;
      bottom: 0;
      width: 46px;
      background: linear-gradient(
        90deg,
        rgba(80, 230, 160, 0.55),
        rgba(80, 230, 160, 0.12) 55%,
        transparent
      );
      animation: edge 3.4s ease-out forwards;
    }
    @keyframes edge {
      0% {
        opacity: 0;
      }
      12% {
        opacity: 1;
      }
      34% {
        opacity: 0.35;
      }
      52% {
        opacity: 1;
      }
      100% {
        opacity: 0;
      }
    }
    .card {
      position: fixed;
      left: 8px;
      width: 232px;
      box-sizing: border-box;
      padding: 10px 12px 12px;
      text-align: center;
      overflow: hidden;
      color: #eafff3;
      background: linear-gradient(
        180deg,
        rgba(8, 36, 24, 0.95),
        rgba(4, 16, 11, 0.96)
      );
      border: 2px solid #5be3a2;
      border-left-width: 4px;
      animation:
        slide 0.7s cubic-bezier(0.2, 1.35, 0.3, 1) both,
        glow 1.4s ease-in-out 0.7s 6;
    }
    .card.leaving {
      animation: leave 0.6s ease-in forwards;
    }
    @keyframes slide {
      from {
        opacity: 0;
        transform: translateX(-120%);
      }
      to {
        opacity: 1;
        transform: none;
      }
    }
    @keyframes leave {
      to {
        opacity: 0;
        transform: translateX(-110%);
      }
    }
    @keyframes glow {
      0%,
      100% {
        box-shadow:
          0 0 0 1px rgba(0, 0, 0, 0.6),
          0 0 14px 2px rgba(80, 230, 160, 0.45);
      }
      50% {
        box-shadow:
          0 0 0 1px rgba(0, 0, 0, 0.6),
          0 0 34px 8px rgba(80, 230, 160, 0.85);
      }
    }
    .shine {
      position: absolute;
      top: -30%;
      bottom: -30%;
      width: 46px;
      left: -60px;
      background: linear-gradient(
        90deg,
        transparent,
        rgba(255, 255, 255, 0.45),
        transparent
      );
      transform: skewX(-20deg);
      animation: shine 2.2s ease-in-out 0.9s infinite;
    }
    @keyframes shine {
      0% {
        left: -60px;
      }
      55%,
      100% {
        left: 280px;
      }
    }
    .title {
      font-size: 17px;
      font-weight: 800;
      letter-spacing: 0.1em;
      background: linear-gradient(180deg, #f3fff8, #6ee7a8 60%, #2fa86c);
      -webkit-background-clip: text;
      background-clip: text;
      color: transparent;
      filter: drop-shadow(0 1px 0 rgba(0, 0, 0, 0.8))
        drop-shadow(0 0 8px rgba(63, 191, 127, 0.8));
    }
    .sub {
      margin-top: 2px;
      font-size: 10px;
      letter-spacing: 0.14em;
      color: #a9efc9;
    }
    ul {
      list-style: none;
      margin: 8px 0 0;
      padding: 0;
      display: grid;
      gap: 3px;
      text-align: left;
    }
    li {
      font-family: Inter, system-ui, sans-serif;
      font-size: 11.5px;
      font-weight: 700;
      padding: 2px 6px;
      background: rgba(63, 191, 127, 0.14);
      border-left: 2px solid #5be3a2;
      animation: pop 0.45s cubic-bezier(0.2, 1.5, 0.4, 1) both;
      animation-delay: calc(0.6s + var(--i) * 0.3s);
    }
    li::before {
      content: "▲ ";
      color: #6ee7a8;
      font-size: 9px;
    }
    li.unlock {
      color: #ffe9a6;
      border-left-color: #ffc442;
      background: rgba(255, 176, 32, 0.12);
    }
    li.unlock::before {
      content: "★ ";
      color: #ffc442;
    }
    @keyframes pop {
      0% {
        opacity: 0;
        transform: translateX(-16px) scale(0.9);
        background: rgba(120, 255, 190, 0.7);
      }
      100% {
        opacity: 1;
        transform: none;
      }
    }
    .spark {
      position: absolute;
      bottom: 4px;
      left: var(--x);
      color: #c9ffe2;
      font-size: var(--s);
      text-shadow: 0 0 6px #6ee7a8;
      opacity: 0;
      animation: rise 2.6s ease-out var(--d) infinite;
    }
    @keyframes rise {
      0% {
        opacity: 0;
        transform: translateY(0) scale(0.5);
      }
      20% {
        opacity: 1;
      }
      100% {
        opacity: 0;
        transform: translateY(-150px) scale(1.1) rotate(40deg);
      }
    }
    @media (prefers-reduced-motion: reduce) {
      .card,
      li {
        animation: none;
      }
      .card.leaving {
        opacity: 0;
        transition: opacity 0.4s;
      }
      .edge,
      .shine,
      .spark {
        display: none;
      }
    }
  `;

  init() {}

  disconnectedCallback(): void {
    super.disconnectedCallback();
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
    document.documentElement.style.removeProperty(EXTRA_VAR);
  }

  tick(): void {
    const game = this.game;
    if (game === undefined) return;
    if (this.shown) this.follow();
    const events = game.updatesSinceLastTick()?.[GameUpdateType.CapitalEvent];
    if (events === undefined || events.length === 0) return;
    const me = game.myPlayer();
    if (me === null) return;
    for (const e of events) {
      if (e.owner !== me.smallID()) continue;
      const key = `${e.capitalId}:${e.kind}`;
      if (this.seen.has(key)) continue;
      this.seen.add(key);
      // A rejoining client replays every old event on its way here.
      if (game.isCatchingUp()) continue;
      this.react(e);
    }
  }

  private react(e: CapitalEventUpdate): void {
    if (e.kind === "building") {
      // The sound every building makes when it is placed.
      this.eventBus?.emit(new PlaySoundEffectEvent("build-city"));
    } else if (e.kind === "founded") {
      this.eventBus?.emit(new PlaySoundEffectEvent("silo-built"));
      this.show(e.replacement);
    }
  }

  private show(replacement: boolean): void {
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
    this.replacement = replacement;
    this.shown = true;
    this.leaving = false;
    this.follow();
    this.timers.push(setTimeout(() => (this.leaving = true), SHOW_MS - 600));
    this.timers.push(
      setTimeout(() => {
        this.shown = false;
        document.documentElement.style.removeProperty(EXTRA_VAR);
      }, SHOW_MS),
    );
  }

  /**
   * Under the capital panel, in the same column, and the panel under that (the
   * resistance's) steps aside for as long as this is up.
   */
  private follow(): void {
    const panel = document.querySelector(".capital-owned");
    const bottom = panel?.getBoundingClientRect().bottom;
    this.top = bottom === undefined ? FALLBACK_TOP : Math.ceil(bottom) + 8;
  }

  protected updated(): void {
    const card = this.shadowRoot?.querySelector(".card");
    if (card === null || card === undefined) return;
    document.documentElement.style.setProperty(
      EXTRA_VAR,
      `${Math.ceil(card.getBoundingClientRect().height) + 8}px`,
    );
  }

  render() {
    if (!this.shown) return nothing;
    const spec = this.game.config().capitalSpec();
    const lines = [
      translateText("capital_founded.troops", {
        amount: renderNumber(spec.bonusMaxTroops),
      }),
      translateText("capital_founded.discount", {
        percent: spec.bonusDiscountPercent,
      }),
      translateText("capital_founded.income", {
        percent: spec.bonusIncomePercent,
      }),
      translateText("capital_founded.regen", {
        percent: spec.bonusRegenPercent,
      }),
      translateText("capital_founded.loss", {
        percent: spec.bonusAttackLossPercent,
      }),
    ];
    const sparks = [
      ["12%", "0s", "13px"],
      ["30%", "0.7s", "9px"],
      ["52%", "1.3s", "15px"],
      ["70%", "0.4s", "10px"],
      ["86%", "1.9s", "12px"],
      ["44%", "2.2s", "8px"],
    ];
    return html`
      <div class="edge"></div>
      <div
        class="card ${this.leaving ? "leaving" : ""}"
        role="status"
        data-capital-founded
        style="top: ${this.top}px"
      >
        <div class="shine"></div>
        ${sparks.map(
          ([x, d, s]) =>
            html`<span class="spark" style="--x:${x};--d:${d};--s:${s}"
              >✦</span
            >`,
        )}
        <div class="title">
          ${translateText(
            this.replacement
              ? "capital_founded.title_replacement"
              : "capital_founded.title",
          )}
        </div>
        <div class="sub">${translateText("capital_founded.subtitle")}</div>
        <ul>
          ${lines.map((text, i) => html`<li style="--i: ${i}">${text}</li>`)}
          <li class="unlock" style="--i: 5">
            ${translateText("capital_founded.unlocks")}
          </li>
        </ul>
      </div>
    `;
  }
}
