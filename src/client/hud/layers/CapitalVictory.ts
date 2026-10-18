import {
  GameUpdateType,
  type CapitalEventUpdate,
} from "@openfront/engine-api/game/GameUpdates";
import { renderNumber, renderTroops } from "@openfront/engine-lib/Format";
import { EventBus } from "@openfront/shared/EventBus";
import { LitElement, css, html, nothing } from "lit";
import { customElement, state } from "lit/decorators.js";
import { Controller } from "../../Controller";
import { PlaySoundEffectEvent, type SoundEffect } from "../../sound/Sounds";
import { translateText } from "../../Utils";
import type { GameView } from "../../view";

/**
 * What the player who has just captured a capital sees and hears: a gold
 * banner, the gold and troops the capture paid, and the cues the game already
 * has for taking a player and for gold. It is the captor's own moment, separate
 * from the owner's CRISIS (CrisisOverlay): the same capture, two experiences.
 *
 * It is driven by the engine's CapitalEvent, which the engine emits exactly
 * once per capital, and the amounts are the ones the engine paid (zero when the
 * captor had already been paid for this player). The client awards nothing. A
 * capital id is shown at most once even so, and nothing is shown while the game
 * is catching up (a rejoining client replays old captures).
 *
 * The banner takes no pointer events, so it never gets between the player and
 * the front. Reduced motion: no flight, sparkles or count-up, just the words.
 */

const SHOW_MS = 7_000;
/** The room this card takes (for the panel under it), and the founded card's. */
const EXTRA_VAR = "--df-capital-extra2";
const FOUNDED_EXTRA_VAR = "--df-capital-extra";
const COUNT_UP_MS = 1_100;
const MAX_QUEUED = 3;

interface Capture {
  capitalId: number;
  name: string;
  gold: bigint;
  troops: number;
}

@customElement("capital-victory")
export class CapitalVictory extends LitElement implements Controller {
  public game: GameView;
  public eventBus: EventBus;

  @state() private current: Capture | null = null;
  /** The numbers on the banner while they count up. */
  @state() private shownGold = 0;
  @state() private shownTroops = 0;
  @state() private leaving = false;
  /** Where the card's top is: under the capital panel (and the founded card, if both are up). */
  @state() private top = 200;

  private queue: Capture[] = [];
  private seen = new Set<number>();
  private timers: ReturnType<typeof setTimeout>[] = [];
  private raf = 0;

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
        rgba(255, 196, 66, 0.6),
        rgba(255, 176, 32, 0.14) 55%,
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
    /* Off to the side, under the capital panel: the game stays in view. */
    .banner {
      position: fixed;
      left: 8px;
      width: 232px;
      box-sizing: border-box;
      padding: 10px 12px 12px;
      text-align: center;
      overflow: hidden;
      color: #fff7e0;
      background: linear-gradient(
        180deg,
        rgba(40, 28, 6, 0.95),
        rgba(16, 11, 2, 0.96)
      );
      border: 2px solid #ffc442;
      border-left-width: 4px;
      animation:
        slide 0.7s cubic-bezier(0.2, 1.35, 0.3, 1) both,
        glow 1.4s ease-in-out 0.7s 6;
    }
    .banner.leaving {
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
          0 0 14px 2px rgba(255, 176, 32, 0.45);
      }
      50% {
        box-shadow:
          0 0 0 1px rgba(0, 0, 0, 0.6),
          0 0 34px 8px rgba(255, 190, 50, 0.9);
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
        rgba(255, 255, 255, 0.5),
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
      line-height: 1.05;
      background: linear-gradient(180deg, #fff3b0, #ffb020 55%, #e8741a);
      -webkit-background-clip: text;
      background-clip: text;
      color: transparent;
      filter: drop-shadow(0 1px 0 rgba(0, 0, 0, 0.8))
        drop-shadow(0 0 8px rgba(255, 170, 30, 0.8));
    }
    .sub {
      margin-top: 3px;
      font-size: 11px;
      letter-spacing: 0.1em;
      color: #ffd9a0;
    }
    .rewards {
      display: grid;
      gap: 4px;
      margin-top: 8px;
    }
    .chip {
      padding: 4px 10px;
      font-family: Inter, system-ui, sans-serif;
      font-size: 17px;
      font-weight: 800;
      letter-spacing: 0.04em;
      background: rgba(255, 176, 32, 0.16);
      border-left: 3px solid #ffc442;
      color: #ffe9a6;
      font-variant-numeric: tabular-nums;
      animation: pop 0.45s cubic-bezier(0.2, 1.5, 0.4, 1) 0.5s both;
    }
    .chip + .chip {
      animation-delay: 0.85s;
    }
    .chip small {
      display: block;
      font-size: 9px;
      letter-spacing: 0.2em;
      color: #d8b574;
    }
    @keyframes pop {
      0% {
        opacity: 0;
        transform: translateX(-16px) scale(0.9);
        background: rgba(255, 220, 120, 0.7);
      }
      100% {
        opacity: 1;
        transform: none;
      }
    }
    .none {
      margin-top: 8px;
      font-size: 11px;
      letter-spacing: 0.1em;
      color: #b59a62;
    }
    .spark {
      position: absolute;
      bottom: 4px;
      left: var(--x);
      color: #ffe38a;
      font-size: var(--s);
      font-style: normal;
      text-shadow: 0 0 6px #ffb020;
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
        transform: translateY(-110px) scale(1.1) rotate(40deg);
      }
    }
    @media (prefers-reduced-motion: reduce) {
      .banner,
      .chip {
        animation: none;
      }
      .banner.leaving {
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
    this.clearTimers();
    cancelAnimationFrame(this.raf);
    document.documentElement.style.removeProperty(EXTRA_VAR);
  }

  tick(): void {
    const game = this.game;
    if (game === undefined) return;
    if (this.current !== null) this.follow();
    const events = game.updatesSinceLastTick()?.[GameUpdateType.CapitalEvent];
    if (events === undefined || events.length === 0) return;
    const me = game.myPlayer();
    if (me === null) return;
    for (const e of events) {
      if (!this.isMine(e, me.smallID())) continue;
      if (this.seen.has(e.capitalId)) continue;
      this.seen.add(e.capitalId);
      // A rejoining client replays every old capture on its way here.
      if (game.isCatchingUp()) continue;
      const owner = game.playerBySmallID(e.owner);
      this.enqueue({
        capitalId: e.capitalId,
        name: owner.isPlayer() ? owner.name() : "?",
        gold: e.rewardGold,
        troops: e.rewardTroops,
      });
    }
  }

  /** Under the capital panel in the left column (and under the founded card, if that is up too). */
  private follow(): void {
    const panel = document.querySelector(
      "[data-capital-action], [data-capital-owned], [data-capital-building]",
    );
    const side = document.querySelector("game-left-sidebar aside");
    const bottom =
      panel?.getBoundingClientRect().bottom ??
      (side === null ? 120 : side.getBoundingClientRect().bottom + 14);
    const extra = parseFloat(
      document.documentElement.style.getPropertyValue(FOUNDED_EXTRA_VAR) || "0",
    );
    this.top = Math.ceil(bottom) + 8 + (Number.isNaN(extra) ? 0 : extra);
  }

  protected updated(): void {
    const root = document.documentElement.style;
    const card = this.shadowRoot?.querySelector(".banner");
    if (card === null || card === undefined) {
      root.removeProperty(EXTRA_VAR);
      return;
    }
    root.setProperty(
      EXTRA_VAR,
      `${Math.ceil(card.getBoundingClientRect().height) + 8}px`,
    );
  }

  private isMine(e: CapitalEventUpdate, mySmallID: number): boolean {
    return e.kind === "captured" && e.captor === mySmallID;
  }

  private enqueue(capture: Capture): void {
    if (this.queue.length >= MAX_QUEUED) return;
    this.queue.push(capture);
    if (this.current === null) this.next();
  }

  private next(): void {
    const capture = this.queue.shift();
    if (capture === undefined) return;
    this.current = capture;
    this.leaving = false;
    this.shownGold = 0;
    this.shownTroops = 0;
    this.play("conquered");
    if (capture.gold > 0n) this.schedule(() => this.play("ka-ching"), 450);
    this.countUp(capture);
    this.schedule(() => (this.leaving = true), SHOW_MS - 600);
    this.schedule(() => {
      this.current = null;
      this.next();
    }, SHOW_MS);
  }

  private reducedMotion(): boolean {
    return (
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    );
  }

  /** The numbers roll up to what the engine paid. */
  private countUp(capture: Capture): void {
    const gold = Number(capture.gold);
    if (this.reducedMotion() || typeof requestAnimationFrame !== "function") {
      this.shownGold = gold;
      this.shownTroops = capture.troops;
      return;
    }
    const start = performance.now();
    const step = (now: number) => {
      const t = Math.min(1, (now - start) / COUNT_UP_MS);
      const eased = 1 - Math.pow(1 - t, 3);
      this.shownGold = Math.round(gold * eased);
      this.shownTroops = Math.round(capture.troops * eased);
      if (t < 1 && this.current === capture) {
        this.raf = requestAnimationFrame(step);
      }
    };
    this.raf = requestAnimationFrame(step);
  }

  private play(effect: SoundEffect): void {
    this.eventBus?.emit(new PlaySoundEffectEvent(effect));
  }

  private schedule(fn: () => void, ms: number): void {
    this.timers.push(setTimeout(fn, ms));
  }

  private clearTimers(): void {
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
  }

  private sparks() {
    // Fixed positions and delays: presentation, not game state.
    const sparks = [
      ["12%", "0s", "13px"],
      ["30%", "0.7s", "9px"],
      ["52%", "1.3s", "15px"],
      ["70%", "0.4s", "10px"],
      ["86%", "1.9s", "12px"],
      ["44%", "2.2s", "8px"],
    ];
    return sparks.map(
      ([x, d, size]) =>
        html`<i class="spark" style="--x:${x};--d:${d};--s:${size}">✦</i>`,
    );
  }

  render() {
    const capture = this.current;
    if (capture === null) return nothing;
    const paid = capture.gold > 0n || capture.troops > 0;
    return html`
      <div class="edge"></div>
      <div
        class="banner ${this.leaving ? "leaving" : ""}"
        data-capital-victory=${capture.capitalId}
        role="status"
        style="top: ${this.top}px"
      >
        <div class="shine"></div>
        ${this.sparks()}
        <div class="title">${translateText("capital_victory.title")}</div>
        <div class="sub">
          ${translateText("capital_victory.subtitle", { name: capture.name })}
        </div>
        ${paid
          ? html`<div class="rewards">
              ${capture.gold > 0n
                ? html`<div class="chip" data-reward="gold">
                    +${renderNumber(this.shownGold)}
                    <small>${translateText("capital_victory.gold")}</small>
                  </div>`
                : nothing}
              ${capture.troops > 0
                ? html`<div class="chip" data-reward="troops">
                    +${renderTroops(this.shownTroops)}
                    <small>${translateText("capital_victory.troops")}</small>
                  </div>`
                : nothing}
            </div>`
          : html`<div class="none">
              ${translateText("capital_victory.already_paid")}
            </div>`}
      </div>
    `;
  }
}
