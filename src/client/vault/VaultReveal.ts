import type { VaultCard, VaultRarity } from "@openfront/shared/VaultSchemas";
import {
  html,
  LitElement,
  nothing,
  type PropertyValues,
  type TemplateResult,
} from "lit";
import { customElement, property, state } from "lit/decorators.js";
import {
  cosmeticDisplayName,
  cosmeticRarityLabel,
} from "../components/CosmeticPresentation";
import "../components/CosmeticPreview";
import type { ResolvedCosmetic } from "../Cosmetics";
import { translateText } from "../Utils";
import {
  motionAllowed,
  playReveal,
  playTear,
  playWin,
  RARITY_COLOR,
  rarityPower,
  VaultFx,
} from "./VaultFx";
import { renderPackArt } from "./VaultPackArt";
import { tone } from "./VaultPixel";
import "./VaultSky";
import { tiltLeave, tiltMove } from "./VaultTilt";

export type RevealMode =
  | {
      kind: "pack";
      pack: string;
      name: string;
      rarity: VaultRarity;
      cards: VaultCard[];
    }
  | { kind: "card"; title: string; card: VaultCard }
  | { kind: "credits"; amount: number; jackpot: boolean };

type Stage = "sealed" | "tearing" | "cards" | "done";

const CSS = `
  /* poses held for a moment, not tweened: the pack shakes and floats a frame at a time */
  @keyframes vr-shake { 0%,100% { transform: translate(0,0); } 20% { transform: translate(-6px,2px); } 40% { transform: translate(6px,-3px); } 60% { transform: translate(-4px,-2px); } 80% { transform: translate(4px,3px); } }
  @keyframes vr-float { 0%,100% { transform: translateY(0); } 25%,75% { transform: translateY(-5px); } 50% { transform: translateY(-10px); } }
  @keyframes vr-left { to { transform: translate(-70%, 12%) rotate(-24deg); opacity: 0; } }
  @keyframes vr-right { to { transform: translate(70%, 12%) rotate(24deg); opacity: 0; } }
  @keyframes vr-flash { 0% { opacity: 0; } 25% { opacity: .95; } 100% { opacity: 0; } }
  @keyframes vr-pop { 0% { transform: scale(.4); opacity: 0; } 60% { transform: scale(1.12); opacity: 1; } 100% { transform: scale(1); } }
  /* the band is a fifth of the card wide: it starts and ends fully off the card, so the loop has no pause and no jump */
  @keyframes vr-shine { from { transform: translateX(-250%) skewX(-18deg); } to { transform: translateX(750%) skewX(-18deg); } }
  .vr-root { background: var(--dither), rgba(6,5,12,.72); }
  .vr-root vault-sky { opacity: .7; }
  .vr-burst { clip-path: polygon(50% 0, 60% 34%, 94% 18%, 68% 46%, 100% 50%, 68% 54%, 94% 82%, 60% 66%, 50% 100%, 40% 66%, 6% 82%, 32% 54%, 0 50%, 32% 46%, 6% 18%, 40% 34%); }
  .vr-card { perspective: 900px; }
  .vr-inner { position: relative; transform-style: preserve-3d; transition: transform .75s steps(8, end); }
  .vr-card[data-flipped="true"] .vr-inner { transform: rotateY(180deg); }
  .vr-face { position: absolute; inset: 0; backface-visibility: hidden; -webkit-backface-visibility: hidden; }
  .vr-back { --u: 4px; border: var(--u) solid transparent; border-image: var(--bi-line) 1 / var(--u) / 0 stretch; background-clip: padding-box; background: var(--dither), #181633; transform: rotateY(0); }
  .vr-front { --u: 4px; border: var(--u) solid transparent; border-image: var(--bi) 1 / var(--u) / 0 stretch; background-clip: padding-box; background: var(--dither), linear-gradient(180deg, color-mix(in srgb, var(--c) 24%, #14121c) 0 52%, #0f0e1c 52%); transform: rotateY(180deg); }
  .vr-card[data-power="3"] .vr-front, .vr-card[data-power="4"] .vr-front { box-shadow: 0 6px 0 color-mix(in srgb, var(--c) 50%, #000); }
  .vr-chip { margin-top: 4px; padding: 3px 6px; font-size: 13px; font-weight: 700; }
  .vr-chip-new { background: #14391f; color: #4ade80; box-shadow: inset 0 0 0 2px #2d8a4e; }
  .vr-chip-dupe { background: #3a2a08; color: #fbbf24; box-shadow: inset 0 0 0 2px #8a5f10; }
  .vr-btn { width: auto; min-height: 52px; justify-content: center; padding: 0 24px; font-size: 16px; font-weight: 700; letter-spacing: .1em; text-transform: uppercase; }
  .vr-btn-quiet { --bg: #2a2838; --hi: #44405c; --lo: #1a1826; --sh: #0a0a10; --bi: var(--bi-line); }
  @media (prefers-reduced-motion: reduce) { .vr-inner { transition: none; } }
`;

/**
 * The reveal: a full-screen stage for what a draw gave. (The tilt, the glare
 * and the pack's art are styled by the page's VAULT_CSS, which is always on the
 * page when this is.) A pack is sealed,
 * tears open and shows its cards one after another, the glow of its tear
 * tinted by the best card; a single card or a Credits prize pops in with a
 * burst. Everything that moves is skipped for reduced motion.
 */
@customElement("vault-reveal")
export class VaultReveal extends LitElement {
  @property({ attribute: false }) mode: RevealMode | null = null;
  /** Finds the catalog entry of a card, to draw its art and name. */
  @property({ attribute: false }) resolve: (
    card: VaultCard,
  ) => ResolvedCosmetic | null = () => null;
  /** Whether "open another" makes sense (the account can still afford it and is under the day's limit). */
  @property({ type: Boolean }) canAgain = false;

  @state() private stage: Stage = "sealed";
  @state() private flipped = 0;
  @state() private flash = false;
  private fx: VaultFx | null = null;
  private timers: ReturnType<typeof setTimeout>[] = [];

  createRenderRoot() {
    return this;
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.clear();
  }

  private clear() {
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
    this.fx?.dispose();
    this.fx = null;
  }

  private later(ms: number, fn: () => void) {
    this.timers.push(setTimeout(fn, ms));
  }

  protected willUpdate(changed: PropertyValues<this>) {
    if (changed.has("mode") && this.mode !== null) {
      this.clear();
      this.flipped = 0;
      this.flash = false;
      this.stage =
        this.mode.kind === "pack" && motionAllowed()
          ? "sealed"
          : this.mode.kind === "pack"
            ? "cards"
            : "done";
    }
  }

  protected updated(changed: PropertyValues<this>) {
    if (changed.has("mode") && this.mode !== null) {
      this.fx = new VaultFx(
        this.querySelector("[data-reveal-stage]") as HTMLElement,
      );
      this.celebrate();
    }
  }

  /** The opening moment of a single card or a Credits prize. */
  private celebrate() {
    const mode = this.mode;
    if (mode === null || mode.kind === "pack") return;
    const stage = this.querySelector("[data-reveal-stage]") as HTMLElement;
    const { width, height } = stage.getBoundingClientRect();
    if (mode.kind === "credits") {
      const colors = mode.jackpot
        ? ["#fde047", "#f59e0b", "#fff"]
        : ["#fbbf24", "#fde68a", "#f59e0b"];
      this.fx?.burst(width / 2, height * 0.42, colors, {
        count: mode.jackpot ? 120 : 60,
        speed: 480,
      });
      if (mode.jackpot) this.fx?.confetti(colors, 140);
      playWin(mode.jackpot ? 4 : 1);
      return;
    }
    const rarity = mode.card.rarity;
    this.burstFor(rarity, width / 2, height * 0.45);
    playReveal(rarity);
  }

  private burstFor(rarity: VaultRarity, x: number, y: number) {
    const power = rarityPower(rarity);
    const color = RARITY_COLOR[rarity];
    this.fx?.burst(x, y, [color, "#fff", color], {
      count: 18 + power * 22,
      speed: 260 + power * 90,
    });
    if (power >= 2) this.fx?.ring(x, y, color, 220 + power * 50);
    if (power >= 3) {
      this.flash = true;
      this.later(700, () => (this.flash = false));
    }
    if (power >= 4) this.fx?.confetti([color, "#fff3b0", "#fff"], 110);
  }

  private tear = () => {
    if (this.stage !== "sealed" || this.mode?.kind !== "pack") return;
    this.stage = "tearing";
    playTear();
    this.later(700, () => {
      this.stage = "cards";
    });
  };

  private flipNext = () => {
    const mode = this.mode;
    if (mode?.kind !== "pack" || this.stage !== "cards") return;
    if (this.flipped >= mode.cards.length) return;
    const index = this.flipped;
    this.flipped = index + 1;
    const card = mode.cards[index];
    playReveal(card.rarity);
    const el = this.querySelector(
      `[data-reveal-card="${index}"]`,
    ) as HTMLElement | null;
    const stage = this.querySelector("[data-reveal-stage]") as HTMLElement;
    if (el !== null) {
      const a = el.getBoundingClientRect();
      const b = stage.getBoundingClientRect();
      this.later(280, () =>
        this.burstFor(
          card.rarity,
          a.left - b.left + a.width / 2,
          a.top - b.top + a.height / 2,
        ),
      );
    }
    if (this.flipped >= mode.cards.length)
      this.later(900, () => (this.stage = "done"));
  };

  private revealAll = () => {
    const mode = this.mode;
    if (mode?.kind !== "pack") return;
    const step = () => {
      if (this.flipped >= mode.cards.length) return;
      this.flipNext();
      this.later(420, step);
    };
    step();
  };

  private close = () => {
    this.dispatchEvent(new CustomEvent("vault-close", { bubbles: true }));
  };

  private again = () => {
    this.dispatchEvent(new CustomEvent("vault-again", { bubbles: true }));
  };

  private renderCard(card: VaultCard, index: number, faceUp: boolean) {
    const resolved = this.resolve(card);
    const color = RARITY_COLOR[card.rarity];
    const name = resolved === null ? card.name : cosmeticDisplayName(resolved);
    return html`<div
      class="vr-card vault-tilt relative h-[236px] w-[158px] shrink-0 min-[430px]:h-[300px] min-[430px]:w-[200px] sm:h-[340px] sm:w-[230px]"
      data-reveal-card=${index}
      data-flipped=${faceUp ? "true" : "false"}
      data-rarity=${card.rarity}
      data-power=${rarityPower(card.rarity)}
    >
      <div class="vr-inner h-full w-full">
        <div class="vr-face vr-back flex items-center justify-center">
          <span class="text-6xl font-bold text-white/20">?</span>
        </div>
        <div
          class="vr-face vr-front flex flex-col overflow-hidden"
          style=${tone(color)}
        >
          <span class="vault-glare" style="z-index: 2"></span>
          <div class="relative min-h-0 flex-1 p-4">
            ${resolved === null
              ? nothing
              : html`<cosmetic-preview
                  .resolved=${resolved}
                  size="detail"
                ></cosmetic-preview>`}
            ${rarityPower(card.rarity) >= 2
              ? html`<span
                  class="pointer-events-none absolute inset-y-0 left-0 w-1/5 bg-white/20"
                  style="animation: vr-shine 2.6s steps(20) infinite; animation-delay: ${-index *
                  0.65}s;"
                ></span>`
              : nothing}
          </div>
          <div class="px-3 pb-3 text-center">
            <div
              class="text-[13px] font-bold uppercase tracking-[0.18em]"
              style="color:${color}"
            >
              ${resolved === null ? card.rarity : cosmeticRarityLabel(resolved)}
            </div>
            <div class="mt-0.5 truncate text-[18px] font-bold text-white">
              ${name}
            </div>
            ${card.dupe
              ? html`<div data-reveal-dupe class="vr-chip vr-chip-dupe">
                  ${translateText("vault.duplicate", {
                    credits: card.credits.toLocaleString(),
                  })}
                </div>`
              : html`<div data-reveal-new class="vr-chip vr-chip-new">
                  ${translateText("vault.new_item")}
                </div>`}
          </div>
        </div>
      </div>
    </div>`;
  }

  render() {
    const mode = this.mode;
    if (mode === null) return html``;
    const bestPack =
      mode.kind === "pack"
        ? mode.cards.reduce<VaultRarity>(
            (best, c) =>
              rarityPower(c.rarity) > rarityPower(best) ? c.rarity : best,
            "common",
          )
        : "common";
    const tint = RARITY_COLOR[mode.kind === "pack" ? bestPack : "legendary"];
    return html`<div
      data-vault-reveal
      class="vr-root fixed inset-0 z-[3000] flex flex-col items-center justify-center"
      role="dialog"
      aria-modal="true"
    >
      <style>
        ${CSS}
      </style>
      <vault-sky
        .spinning=${true}
        .rayCenter=${{ x: 0.5, y: 0.42, r: 0.2 }}
      ></vault-sky>
      <div
        data-reveal-stage
        class="relative flex h-full w-full flex-col items-center justify-center overflow-hidden px-4 pb-[160px] lg:pb-[84px]"
      >
        ${this.flash
          ? html`<div
              class="pointer-events-none absolute inset-0 z-40 bg-white"
              style="animation: vr-flash .7s steps(5) forwards"
            ></div>`
          : nothing}
        ${mode.kind === "pack" ? this.renderPack(mode, tint) : nothing}
        ${mode.kind === "card"
          ? html`<div class="flex flex-col items-center gap-5">
              <h2
                class="text-[28px] font-bold uppercase tracking-widest text-white"
                style="text-shadow: 3px 3px 0 #000"
              >
                ${mode.title}
              </h2>
              <div style="animation: vr-pop .6s steps(6) both">
                ${this.renderCard(mode.card, 0, true)}
              </div>
            </div>`
          : nothing}
        ${mode.kind === "credits"
          ? html`<div class="flex flex-col items-center gap-4 text-center">
              <div
                class="text-base font-bold uppercase tracking-[0.3em] text-amber-300"
                style="text-shadow: 2px 2px 0 #000"
              >
                ${translateText(
                  mode.jackpot ? "vault.jackpot" : "vault.you_won",
                )}
              </div>
              <div
                data-reveal-credits
                class="text-6xl font-bold text-amber-300 sm:text-7xl"
                style="text-shadow: 4px 4px 0 #7a4a05, 8px 8px 0 #000; animation: vr-pop .7s steps(7) both"
              >
                +${mode.amount.toLocaleString()}
              </div>
              <div
                class="text-xl font-bold text-white/80"
                style="text-shadow: 2px 2px 0 #000"
              >
                ${translateText("vault.credits")}
              </div>
            </div>`
          : nothing}
        <div
          class="absolute bottom-[150px] left-0 right-0 z-30 flex justify-center gap-3 lg:bottom-[76px]"
        >
          ${this.stage === "done"
            ? html`${this.canAgain
                  ? html`<button
                      type="button"
                      data-reveal-again
                      class="vault-btn vault-spin vr-btn ui-focus"
                      @click=${this.again}
                    >
                      ${translateText("vault.again")}
                    </button>`
                  : nothing}
                <button
                  type="button"
                  data-reveal-done
                  class="vault-btn vr-btn vr-btn-quiet ui-focus"
                  @click=${this.close}
                >
                  ${translateText("vault.done")}
                </button>`
            : html`<button
                type="button"
                data-reveal-skip
                class="vault-btn vr-btn vr-btn-quiet ui-focus"
                @click=${mode.kind === "pack" && this.stage !== "sealed"
                  ? this.revealAll
                  : this.tear}
              >
                ${translateText(
                  this.stage === "sealed"
                    ? "vault.tear_open"
                    : "vault.reveal_all",
                )}
              </button>`}
        </div>
      </div>
    </div>`;
  }

  private renderPack(
    mode: Extract<RevealMode, { kind: "pack" }>,
    tint: string,
  ) {
    if (this.stage === "sealed" || this.stage === "tearing") {
      const tearing = this.stage === "tearing";
      const base = RARITY_COLOR[mode.rarity];
      const half = (side: "left" | "right") =>
        html`<div
          class="absolute inset-0"
          style="clip-path: ${side === "left"
            ? "inset(0 50% 0 0)"
            : "inset(0 0 0 50%)"}; ${tearing
            ? `animation: vr-${side} .7s ease-in forwards;`
            : ""}"
        >
          ${renderPackArt({ name: mode.name, rarity: mode.rarity })}
        </div>`;
      return html`<div
        class="flex items-center justify-center p-2"
        @pointermove=${(e: PointerEvent) => tiltMove(e, 12)}
        @pointerleave=${tiltLeave}
      >
        <div class="vault-tilt" style="--tilt-hover-scale: 1.06">
          ${this.renderSealed(mode, tint, tearing, base, half)}
        </div>
      </div>`;
    }
    return this.renderCards(mode);
  }

  private renderSealed(
    mode: Extract<RevealMode, { kind: "pack" }>,
    tint: string,
    tearing: boolean,
    base: string,
    half: (side: "left" | "right") => TemplateResult,
  ) {
    return html`<button
      type="button"
      data-reveal-pack
      class="relative h-[360px] w-[250px] cursor-pointer sm:h-[420px] sm:w-[290px]"
      style="${tearing
        ? ""
        : "animation: vr-shake .9s steps(1, end) infinite, vr-float 1.6s steps(1, end) infinite;"} filter: drop-shadow(0 10px 0 rgba(0,0,0,.6));"
      aria-label=${translateText("vault.tear_open")}
      @click=${this.tear}
    >
      ${half("left")}${half("right")}
      ${tearing
        ? html`<div
            class="vr-burst absolute left-1/2 top-1/2 h-[150%] w-[150%] -translate-x-1/2 -translate-y-1/2"
            style="background: ${tint}; animation: vr-flash .7s steps(5) forwards"
          ></div>`
        : nothing}
    </button>`;
  }

  private renderCards(mode: Extract<RevealMode, { kind: "pack" }>) {
    return html`<div class="flex max-w-full flex-col items-center gap-6">
      <h2
        class="text-2xl font-bold uppercase tracking-widest text-white"
        style="text-shadow: 3px 3px 0 #000"
      >
        ${mode.name}
      </h2>
      <div
        class="flex max-w-full flex-wrap items-center justify-center gap-4 sm:gap-6"
      >
        ${mode.cards.map(
          (card, i) =>
            html`<div
              class="cursor-pointer"
              style="animation: vr-pop .5s steps(5) ${i * 0.08}s both"
              @pointermove=${(e: PointerEvent) => tiltMove(e, 12)}
              @pointerleave=${tiltLeave}
              @click=${this.flipNext}
            >
              ${this.renderCard(card, i, i < this.flipped)}
            </div>`,
        )}
      </div>
    </div>`;
  }
}
