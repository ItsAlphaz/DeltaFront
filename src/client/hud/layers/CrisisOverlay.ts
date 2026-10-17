import { GameUpdateType } from "@openfront/engine-api/game/GameUpdates";
import { EventBus } from "@openfront/shared/EventBus";
import { LitElement, css, html, nothing } from "lit";
import { customElement, state } from "lit/decorators.js";
import {
  OVER_VISIBLE_MS,
  crisisLevel,
  crossedThreshold,
  formatCountdown,
  remainingFraction,
  secondsLeft,
  shouldAnnounce,
  type CrisisLevel,
} from "../../capital/CrisisClock";
import { Controller } from "../../Controller";
import { PlaySoundEffectEvent, type SoundEffect } from "../../sound/Sounds";
import { translateText } from "../../Utils";
import type { GameView } from "../../view";

/**
 * What the player whose capital has fallen sees and hears (docs/Capital.md).
 *
 * Two stages that are one animation: a full-screen CRISIS announcement, then the
 * same CRISIS title shrinking and travelling to a panel on the right edge, where
 * it stays with the time left until the crisis ends. The title is a single
 * element throughout, so nothing is removed and replaced.
 *
 * Nothing here decides anything. The crisis, its start and its end are the
 * engine's (PlayerView.crisis*), and every number on screen is derived from the
 * match's ticks: the countdown is the match's, not the browser's. It holds when
 * the game is paused, runs while a menu is open, and is right after a reconnect.
 * The announcement itself plays only for a crisis that has just begun and only
 * live (a rejoining client has the indicator and nothing else), and never
 * covers the map in a way that stops the player acting: the layer takes no
 * pointer events at all.
 *
 * Reduced motion: no scaling, flash or shake. The same words appear, fade in and
 * settle into the panel.
 */

/** How long the title takes to scale into view. */
const ANNOUNCE_IN_MS = 700;
/** The announcement stays at full size this long (counted from its start). */
const ANNOUNCE_HOLD_MS = 3_000;
/** The title's flight from the middle of the screen to the panel. */
const DOCK_MS = 1_100;
/** How large the title is on the screen's centre, as a share of its width. */
const ANNOUNCE_WIDTH_SHARE = 0.6;
/** The same, in reduced motion: a third of the width, at least this many pixels, at most most of the screen. */
const REDUCED_WIDTH_SHARE = 0.34;
const REDUCED_MIN_WIDTH = 220;
const REDUCED_MAX_SHARE = 0.8;
const MAX_ANNOUNCE_SCALE = 14;
const SHAKE_MS = 480;

type Phase = "idle" | "announce" | "docking" | "active" | "over";

@customElement("crisis-overlay")
export class CrisisOverlay extends LitElement implements Controller {
  public game: GameView;
  public eventBus: EventBus;

  @state() private phase: Phase = "idle";
  @state() private seconds = 0;
  @state() private fraction = 1;
  @state() private level: CrisisLevel = "running";
  /** Alternates 0/1 with each pulse so the one-shot CSS animation restarts. */
  @state() private pulse = -1;

  /** The crisis on screen, by its start tick (-1: none). */
  private shownCrisis = -1;
  private lastSeconds: number | null = null;
  private timers: ReturnType<typeof setTimeout>[] = [];
  private matchOver = false;
  /** Where the title sits at the centre of the screen, as a transform. */
  private centreTransform = "none";

  static styles = css`
    :host {
      position: fixed;
      inset: 0;
      z-index: 1500;
      pointer-events: none;
      font-family: var(--font-display, "Pixelify Sans", Inter, sans-serif);
    }

    .edge,
    .flash {
      position: fixed;
      inset: 0;
      pointer-events: none;
      opacity: 0;
    }
    .edge {
      box-shadow:
        inset 0 0 120px 34px rgba(255, 160, 0, 0.7),
        inset 0 0 280px 90px rgba(227, 27, 35, 0.5);
    }
    .edge.on {
      animation: edge 3.6s ease-out forwards;
    }
    @keyframes edge {
      0% {
        opacity: 0;
      }
      10% {
        opacity: 1;
      }
      28% {
        opacity: 0.5;
      }
      42% {
        opacity: 1;
      }
      62% {
        opacity: 0.4;
      }
      100% {
        opacity: 0;
      }
    }
    .flash {
      background: radial-gradient(
        circle at 50% 46%,
        rgba(255, 214, 130, 0.6),
        rgba(255, 96, 40, 0.2) 52%,
        transparent 78%
      );
    }
    .flash.on {
      animation: flash 0.6s ease-out forwards;
    }
    @keyframes flash {
      0% {
        opacity: 0;
      }
      18% {
        opacity: 1;
      }
      100% {
        opacity: 0;
      }
    }

    /* The words under the giant title: the only text the screen centre holds. */
    .sub {
      position: fixed;
      left: 0;
      right: 0;
      text-align: center;
      font-weight: 700;
      font-size: clamp(14px, 2.6vw, 34px);
      letter-spacing: 0.32em;
      color: #fff1cf;
      /* A dark band that fades at both ends: legible on snow as on sea. */
      padding: 10px 0;
      background: linear-gradient(
        90deg,
        transparent,
        rgba(10, 5, 0, 0.74) 16%,
        rgba(10, 5, 0, 0.74) 84%,
        transparent
      );
      text-shadow:
        0 0 14px rgba(255, 140, 0, 0.85),
        0 2px 0 rgba(0, 0, 0, 0.95),
        2px 0 0 rgba(0, 0, 0, 0.6),
        -2px 0 0 rgba(0, 0, 0, 0.6);
      opacity: 0;
      pointer-events: none;
    }
    .sub.in {
      animation: sub-in 0.9s 0.45s cubic-bezier(0.2, 0.8, 0.2, 1) forwards;
    }
    .sub.out {
      opacity: 1;
      animation: sub-out 0.5s ease-in forwards;
    }
    @keyframes sub-in {
      from {
        opacity: 0;
        letter-spacing: 0.7em;
        transform: translateY(10px);
      }
      to {
        opacity: 1;
        letter-spacing: 0.32em;
        transform: none;
      }
    }
    @keyframes sub-out {
      to {
        opacity: 0;
        transform: translateY(-10px);
      }
    }

    /* The indicator: where the title ends up, and stays. */
    .dock {
      position: fixed;
      right: 16px;
      top: 132px;
      width: 208px;
      box-sizing: border-box;
      padding: 8px 14px 12px;
      color: var(--color-df-text, #f5f5f5);
      --accent: var(--color-df-red, #e31b23);
    }
    .dock .chrome {
      position: absolute;
      inset: 0;
      background: rgba(10, 10, 10, 0.86);
      border: 1px solid var(--color-df-border, #2b2b2b);
      border-left: 3px solid var(--accent);
      box-shadow: 0 6px 22px rgba(0, 0, 0, 0.55);
      opacity: 0;
      transition: opacity 0.4s ease;
    }
    .dock.docked .chrome {
      opacity: 1;
    }
    .dock.level-warning {
      --accent: #ffa500;
    }
    .dock.level-urgent {
      --accent: #ff252d;
    }
    .dock.level-over {
      --accent: #3fbf7f;
    }

    .title {
      position: relative;
      font-weight: 800;
      font-size: 28px;
      line-height: 1;
      letter-spacing: 0.08em;
      color: #ffb020;
      /* A dark outline just outside the letters. The fill is orange, which on
         snow is barely darker than the ground, and a glow cannot make up the
         difference (measured: 1.1 to 1.4 to 1 without it). It scales with the
         title, so it stays a thin edge at every size. */
      -webkit-text-stroke: 0.06em rgba(24, 8, 0, 0.92);
      paint-order: stroke fill;
      text-shadow:
        0 0 14px rgba(255, 120, 0, 0.9),
        0 0 36px rgba(227, 27, 35, 0.75),
        0 2px 0 rgba(0, 0, 0, 0.75);
      white-space: nowrap;
      transform-origin: 50% 50%;
      will-change: transform;
    }
    .dock.level-over .title {
      color: #8fe3b4;
      text-shadow:
        0 0 14px rgba(63, 191, 127, 0.7),
        0 2px 0 rgba(0, 0, 0, 0.75);
    }

    .info {
      position: relative;
      margin-top: 8px;
      opacity: 0;
      transform: translateY(-6px);
      transition:
        opacity 0.45s ease,
        transform 0.45s ease;
    }
    .info.show {
      opacity: 1;
      transform: none;
    }
    .status {
      font-size: 13px;
      font-weight: 700;
      letter-spacing: 0.14em;
      color: var(--accent);
    }
    .time {
      margin-top: 4px;
      font-size: 34px;
      font-weight: 700;
      line-height: 1;
      letter-spacing: 0.04em;
      font-variant-numeric: tabular-nums;
    }
    .label {
      margin-top: 2px;
      font-size: 11px;
      letter-spacing: 0.18em;
      color: var(--color-df-text-secondary, #a7a7a7);
    }
    .bar {
      margin-top: 8px;
      height: 6px;
      background: rgba(255, 255, 255, 0.1);
      overflow: hidden;
    }
    .fill {
      height: 100%;
      width: 100%;
      transform-origin: 0 50%;
      background: var(--accent);
      transition:
        transform 1s linear,
        background-color 0.4s ease;
    }

    /* 60 seconds: one pulse of the whole indicator (a or b, so it can repeat). */
    .dock.pulse-0 .chrome,
    .dock.pulse-1 .chrome {
      animation: warn-0 1.4s ease-out;
    }
    .dock.pulse-1 .chrome {
      animation-name: warn-1;
    }
    @keyframes warn-0 {
      0% {
        box-shadow: 0 0 0 0 rgba(255, 165, 0, 0.9);
      }
      100% {
        box-shadow: 0 0 0 22px rgba(255, 165, 0, 0);
      }
    }
    @keyframes warn-1 {
      0% {
        box-shadow: 0 0 0 0 rgba(255, 165, 0, 0.9);
      }
      100% {
        box-shadow: 0 0 0 22px rgba(255, 165, 0, 0);
      }
    }
    /* 10 seconds: the digits breathe. The screen does not flash. */
    .dock.level-urgent .time {
      color: #ff6b6b;
      animation: breathe 1s ease-in-out infinite;
    }
    @keyframes breathe {
      50% {
        opacity: 0.55;
      }
    }

    .dock.leaving {
      animation: leave 0.6s ease-in forwards;
    }
    @keyframes leave {
      to {
        opacity: 0;
        transform: translateX(24px);
      }
    }

    @media (prefers-reduced-motion: reduce) {
      .edge.on {
        animation: edge-still 2.4s ease-out forwards;
      }
      @keyframes edge-still {
        0% {
          opacity: 0;
        }
        20% {
          opacity: 0.8;
        }
        100% {
          opacity: 0;
        }
      }
      .flash.on {
        animation: none;
      }
      .sub.in {
        animation: sub-fade 0.6s 0.2s ease-out forwards;
      }
      @keyframes sub-fade {
        to {
          opacity: 1;
        }
      }
      .dock.pulse-0 .chrome,
      .dock.pulse-1 .chrome {
        animation: none;
      }
      .dock.level-urgent .time {
        animation: none;
      }
      .fill {
        transition: none;
      }
    }
  `;

  init() {}

  disconnectedCallback(): void {
    super.disconnectedCallback();
    this.clearTimers();
  }

  // ---- The match's state, once per tick ----

  tick(): void {
    const game = this.game;
    if (game === undefined) return;

    // The match is over: there is no crisis left to track.
    if (game.updatesSinceLastTick()?.[GameUpdateType.Win]?.length) {
      this.matchOver = true;
    }
    const me = game.myPlayer();
    // A defender whose last land went with the capital is out of the game
    // only if no resistance holds them in it (PlayerView.isInLimbo).
    const playing = me !== null && (me.isAlive() || me.isInLimbo());
    if (this.matchOver || me === null || !me.hasCrisis() || !playing) {
      if (this.phase !== "idle") this.reset();
      this.shownCrisis = -1;
      return;
    }

    const start = me.crisisStartTick();
    const end = me.crisisEndTick();
    const now = game.ticks();
    if (start !== this.shownCrisis) {
      this.shownCrisis = start;
      this.lastSeconds = null;
      this.noticeCrisis(start, end, now);
    }
    if (this.phase === "idle") return;

    const seconds = secondsLeft(end, now);
    const over = now >= end;
    const crossing = crossedThreshold(this.lastSeconds, seconds);
    this.lastSeconds = seconds;
    if (crossing !== null && !game.isCatchingUp()) {
      this.pulse = this.pulse === 0 ? 1 : 0;
      if (crossing === "warn") this.play("crisis-warning");
    }
    this.seconds = seconds;
    this.fraction = remainingFraction(start, end, now);
    this.level = crisisLevel(seconds, over);
    if (over && this.phase !== "over") this.enterOver();
  }

  /** A crisis this client has not shown yet: announce it, or just show it. */
  private noticeCrisis(start: number, end: number, now: number): void {
    this.clearTimers();
    if (now >= end) {
      // Over before this client got here (a rejoin long after): nothing to show.
      this.phase = "idle";
      return;
    }
    const announce = shouldAnnounce({
      catchingUp: this.game.isCatchingUp(),
      startTick: start,
      nowTick: now,
    });
    if (announce) {
      void this.announce();
    } else {
      this.phase = "active";
    }
  }

  // ---- The announcement ----

  private reducedMotion(): boolean {
    return (
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    );
  }

  private async announce(): Promise<void> {
    this.phase = "announce";
    this.play("crisis-capital-lost");
    await this.updateComplete;
    this.placeTitleAtCentre();
    this.playEntrance();
    this.shakeMap();
    this.schedule(() => this.dock(), ANNOUNCE_HOLD_MS);
  }

  /** Works out where the title is at the middle of the screen, and how big. */
  private placeTitleAtCentre(): void {
    const title = this.titleEl();
    const sub = this.renderRoot.querySelector<HTMLElement>(".sub");
    if (title === null) return;
    title.getAnimations?.().forEach((a) => a.cancel());
    const rect = title.getBoundingClientRect();
    const cx = window.innerWidth / 2;
    const cy = window.innerHeight * 0.46;
    const dx = cx - (rect.left + rect.width / 2);
    const dy = cy - (rect.top + rect.height / 2);
    // Calm mode is smaller (a third of the screen), but never smaller than a
    // readable headline on a narrow screen: a phone's third would be a title
    // smaller than the one in the panel it is about to fly to.
    const calmWidth = Math.min(
      window.innerWidth * REDUCED_MAX_SHARE,
      Math.max(REDUCED_MIN_WIDTH, window.innerWidth * REDUCED_WIDTH_SHARE),
    );
    const scale = this.reducedMotion()
      ? Math.min(MAX_ANNOUNCE_SCALE, calmWidth / rect.width)
      : Math.min(
          MAX_ANNOUNCE_SCALE,
          (window.innerWidth * ANNOUNCE_WIDTH_SHARE) / rect.width,
        );
    this.centreTransform = `translate(${dx}px, ${dy}px) scale(${scale})`;
    if (sub !== null) {
      // Just under the title's baseline, whatever its size.
      sub.style.top = `${cy + (rect.height * scale) / 2 + 22}px`;
    }
    // Held at the centre from the first frame: before the entrance runs it
    // would otherwise flash in its panel position.
    title.style.transform = this.centreTransform;
  }

  /** Scales in from beyond the screen, overshoots and settles. */
  private playEntrance(): void {
    const title = this.titleEl();
    if (title === null || typeof title.animate !== "function") return;
    const at = this.centreTransform;
    if (this.reducedMotion()) {
      title.animate([{ opacity: 0 }, { opacity: 1 }], {
        duration: 500,
        fill: "forwards",
      });
      return;
    }
    const scaled = (factor: number) => `${at} scale(${factor})`;
    title.animate(
      [
        {
          transform: scaled(2.6),
          opacity: 0,
          filter: "blur(16px)",
          offset: 0,
        },
        {
          transform: scaled(0.93),
          opacity: 1,
          filter: "blur(0px)",
          offset: 0.55,
        },
        { transform: scaled(1.035), opacity: 1, offset: 0.78 },
        { transform: scaled(1), opacity: 1, filter: "blur(0px)", offset: 1 },
      ],
      {
        duration: ANNOUNCE_IN_MS,
        easing: "cubic-bezier(0.2, 0.8, 0.2, 1)",
        fill: "forwards",
      },
    );
  }

  /** A short, small jolt of the map (the HUD stays put). */
  private shakeMap(): void {
    if (this.reducedMotion()) return;
    const canvas = document.getElementById("webgl-debug-canvas");
    if (canvas === null || typeof canvas.animate !== "function") return;
    canvas.animate(
      [
        { transform: "translate(0, 0)" },
        { transform: "translate(-5px, 3px)" },
        { transform: "translate(4px, -3px)" },
        { transform: "translate(-3px, -2px)" },
        { transform: "translate(2px, 2px)" },
        { transform: "translate(-1px, 1px)" },
        { transform: "translate(0, 0)" },
      ],
      { duration: SHAKE_MS, easing: "ease-out" },
    );
  }

  /** The same title flies to the panel: one continuous motion. */
  private dock(): void {
    if (this.phase !== "announce") return;
    this.phase = "docking";
    const title = this.titleEl();
    const finish = () => {
      if (this.phase !== "docking") return;
      title?.getAnimations?.().forEach((a) => a.cancel());
      if (title !== null) title.style.transform = "";
      this.phase = "active";
    };
    if (
      title === null ||
      typeof title.animate !== "function" ||
      this.reducedMotion()
    ) {
      finish();
      return;
    }
    title.style.transform = "";
    const flight = title.animate(
      [{ transform: this.centreTransform }, { transform: "none" }],
      {
        duration: DOCK_MS,
        easing: "cubic-bezier(0.65, 0, 0.2, 1)",
        fill: "forwards",
      },
    );
    flight.onfinish = finish;
    // Belt and braces: if the animation never reports finishing (a hidden
    // tab throttles it), the panel must still appear.
    this.schedule(finish, DOCK_MS + 400);
  }

  // ---- The end of the crisis ----

  private enterOver(): void {
    this.clearTimers();
    const title = this.titleEl();
    title?.getAnimations?.().forEach((a) => a.cancel());
    if (title !== null) title.style.transform = "";
    this.phase = "over";
    if (!this.game.isCatchingUp()) this.play("crisis-over");
    this.schedule(() => this.reset(), OVER_VISIBLE_MS);
  }

  private reset(): void {
    this.clearTimers();
    this.phase = "idle";
    this.lastSeconds = null;
  }

  // ---- Helpers ----

  private play(effect: SoundEffect): void {
    this.eventBus?.emit(new PlaySoundEffectEvent(effect));
  }

  private titleEl(): HTMLElement | null {
    return this.renderRoot.querySelector<HTMLElement>(".title");
  }

  private schedule(fn: () => void, ms: number): void {
    this.timers.push(setTimeout(fn, ms));
  }

  private clearTimers(): void {
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
  }

  // ---- Render ----

  render() {
    if (this.phase === "idle") return nothing;
    const announcing = this.phase === "announce" || this.phase === "docking";
    const docked = this.phase === "active" || this.phase === "over";
    const over = this.phase === "over";
    const time = formatCountdown(this.seconds);
    const classes = [
      "dock",
      docked ? "docked" : "",
      `level-${this.level}`,
      this.pulse >= 0 ? `pulse-${this.pulse}` : "",
    ]
      .filter(Boolean)
      .join(" ");
    return html`
      <div class="edge ${this.phase === "announce" ? "on" : ""}"></div>
      <div class="flash ${this.phase === "announce" ? "on" : ""}"></div>
      ${announcing
        ? html`<div
            class="sub ${this.phase === "docking" ? "out" : "in"}"
            role="alert"
          >
            ${translateText("crisis.capital_has_fallen")}
          </div>`
        : nothing}
      <section
        class=${classes}
        data-crisis-phase=${this.phase}
        data-crisis-level=${this.level}
        aria-label=${translateText("crisis.aria", { time })}
      >
        <div class="chrome"></div>
        <div class="title">
          ${over ? translateText("crisis.over") : translateText("crisis.title")}
        </div>
        <div class="info ${docked ? "show" : ""}">
          <div class="status">
            ${over
              ? translateText("crisis.penalties_lifted")
              : translateText("crisis.capital_lost")}
          </div>
          <div class="time" role="timer" aria-live="off">${time}</div>
          <div class="label">
            ${over ? nothing : translateText("crisis.time_remaining")}
          </div>
          <div class="bar" aria-hidden="true">
            <div
              class="fill"
              style="transform: scaleX(${over ? 0 : this.fraction})"
            ></div>
          </div>
        </div>
      </section>
    `;
  }
}
