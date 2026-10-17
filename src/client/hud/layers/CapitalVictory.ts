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

const SHOW_MS = 5_200;
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

  private queue: Capture[] = [];
  private seen = new Set<number>();
  private timers: ReturnType<typeof setTimeout>[] = [];
  private raf = 0;

  static styles = css`
    :host {
      position: fixed;
      left: 0;
      right: 0;
      top: 0;
      z-index: 1450;
      pointer-events: none;
      font-family: var(--font-display, "Pixelify Sans", Inter, sans-serif);
    }
    .banner {
      position: relative;
      /* Below the leaderboard, clear of the match feed's first line. */
      margin: clamp(160px, 20vh, 240px) auto 0;
      width: min(560px, 92vw);
      box-sizing: border-box;
      padding: 14px 22px 16px;
      text-align: center;
      color: #fff7e0;
      background: linear-gradient(
        180deg,
        rgba(36, 26, 6, 0.9),
        rgba(14, 10, 2, 0.92)
      );
      border: 1px solid rgba(255, 196, 66, 0.7);
      box-shadow:
        0 0 0 1px rgba(0, 0, 0, 0.6),
        0 0 38px rgba(255, 176, 32, 0.45),
        inset 0 0 28px rgba(255, 176, 32, 0.18);
      animation: rise 0.75s cubic-bezier(0.2, 1.3, 0.3, 1) both;
    }
    .banner.leaving {
      animation: leave 0.6s ease-in forwards;
    }
    @keyframes rise {
      from {
        opacity: 0;
        transform: translateY(-30px) scale(0.82);
      }
      to {
        opacity: 1;
        transform: none;
      }
    }
    @keyframes leave {
      to {
        opacity: 0;
        transform: translateY(-16px) scale(0.96);
      }
    }
    .title {
      font-size: clamp(26px, 5.2vw, 46px);
      font-weight: 800;
      letter-spacing: 0.1em;
      line-height: 1.05;
      background: linear-gradient(180deg, #fff3b0, #ffb020 55%, #e8741a);
      -webkit-background-clip: text;
      background-clip: text;
      color: transparent;
      filter: drop-shadow(0 2px 0 rgba(0, 0, 0, 0.7))
        drop-shadow(0 0 14px rgba(255, 170, 30, 0.7));
    }
    .sub {
      margin-top: 6px;
      font-size: clamp(13px, 2.2vw, 18px);
      letter-spacing: 0.16em;
      color: #ffd9a0;
    }
    .rewards {
      display: flex;
      justify-content: center;
      gap: 12px;
      margin-top: 12px;
      flex-wrap: wrap;
    }
    .chip {
      min-width: 120px;
      padding: 6px 12px;
      font-size: 20px;
      font-weight: 700;
      letter-spacing: 0.06em;
      background: rgba(255, 176, 32, 0.14);
      border: 1px solid rgba(255, 196, 66, 0.5);
      color: #ffe9a6;
      font-variant-numeric: tabular-nums;
    }
    .chip small {
      display: block;
      font-size: 10px;
      letter-spacing: 0.2em;
      color: #d8b574;
    }
    .none {
      margin-top: 10px;
      font-size: 12px;
      letter-spacing: 0.14em;
      color: #b59a62;
    }

    .spark {
      position: absolute;
      top: 50%;
      width: 6px;
      height: 6px;
      background: #ffd36b;
      box-shadow: 0 0 8px 2px rgba(255, 190, 60, 0.9);
      opacity: 0;
      animation: spark 1.6s ease-out infinite;
    }
    @keyframes spark {
      0% {
        opacity: 0;
        transform: translate(0, 0) scale(0.4);
      }
      15% {
        opacity: 1;
      }
      100% {
        opacity: 0;
        transform: translate(var(--dx), var(--dy)) scale(1.1);
      }
    }
    .glow {
      position: fixed;
      inset: 0;
      pointer-events: none;
      background: radial-gradient(
        ellipse at 50% 18%,
        rgba(255, 196, 66, 0.28),
        transparent 55%
      );
      animation: glow 1.6s ease-out forwards;
    }
    @keyframes glow {
      from {
        opacity: 1;
      }
      to {
        opacity: 0;
      }
    }

    @media (prefers-reduced-motion: reduce) {
      .banner {
        animation: fade 0.4s ease-out both;
      }
      .banner.leaving {
        animation: fade-out 0.4s ease-in forwards;
      }
      @keyframes fade {
        from {
          opacity: 0;
        }
      }
      @keyframes fade-out {
        to {
          opacity: 0;
        }
      }
      .spark,
      .glow {
        display: none;
      }
    }
  `;

  init() {}

  disconnectedCallback(): void {
    super.disconnectedCallback();
    this.clearTimers();
    cancelAnimationFrame(this.raf);
  }

  tick(): void {
    const game = this.game;
    if (game === undefined) return;
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
      [-220, -34, 0],
      [-150, -52, 0.3],
      [-60, -60, 0.15],
      [40, -58, 0.45],
      [130, -50, 0.1],
      [215, -30, 0.35],
      [-190, 40, 0.5],
      [180, 44, 0.2],
    ];
    return sparks.map(
      ([dx, dy, delay]) =>
        html`<i
          class="spark"
          style="left:50%; --dx:${dx}px; --dy:${dy}px; animation-delay:${delay}s"
        ></i>`,
    );
  }

  render() {
    const capture = this.current;
    if (capture === null) return nothing;
    const paid = capture.gold > 0n || capture.troops > 0;
    return html`
      <div class="glow"></div>
      <div
        class="banner ${this.leaving ? "leaving" : ""}"
        data-capital-victory=${capture.capitalId}
        role="status"
      >
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
