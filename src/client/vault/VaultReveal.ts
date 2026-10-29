import type { VaultCard, VaultRarity } from "@openfront/shared/VaultSchemas";
import { html, LitElement, nothing, type PropertyValues } from "lit";
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
  @keyframes vr-shake { 0%,100% { transform: translate(0,0) rotate(0); } 20% { transform: translate(-6px,2px) rotate(-2deg); } 40% { transform: translate(6px,-3px) rotate(2deg); } 60% { transform: translate(-4px,-2px) rotate(-1.5deg); } 80% { transform: translate(4px,3px) rotate(1.5deg); } }
  @keyframes vr-float { 0%,100% { transform: translateY(0); } 50% { transform: translateY(-10px); } }
  @keyframes vr-glow { 0%,100% { opacity: .55; } 50% { opacity: 1; } }
  @keyframes vr-left { to { transform: translate(-70%, 12%) rotate(-24deg); opacity: 0; } }
  @keyframes vr-right { to { transform: translate(70%, 12%) rotate(24deg); opacity: 0; } }
  @keyframes vr-flash { 0% { opacity: 0; } 25% { opacity: .95; } 100% { opacity: 0; } }
  @keyframes vr-pop { 0% { transform: scale(.4); opacity: 0; } 60% { transform: scale(1.12); opacity: 1; } 100% { transform: scale(1); } }
  @keyframes vr-rays { to { transform: rotate(360deg); } }
  /* the band is a fifth of the card wide: it starts and ends fully off the card, so the loop has no pause and no jump */
  @keyframes vr-shine { from { transform: translateX(-250%) skewX(-18deg); } to { transform: translateX(750%) skewX(-18deg); } }
  .vr-card { perspective: 900px; }
  .vr-inner { position: relative; transform-style: preserve-3d; transition: transform .75s cubic-bezier(.2,.8,.2,1.1); }
  .vr-card[data-flipped="true"] .vr-inner { transform: rotateY(180deg); }
  .vr-face { position: absolute; inset: 0; backface-visibility: hidden; -webkit-backface-visibility: hidden; }
  .vr-back { transform: rotateY(0); }
  .vr-front { transform: rotateY(180deg); }
  @media (prefers-reduced-motion: reduce) { .vr-inner { transition: none; } }
`;

/**
 * The reveal: a full-screen stage for what a draw gave. A pack is sealed,
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
      class="vr-card relative h-[300px] w-[200px] shrink-0 sm:h-[340px] sm:w-[230px]"
      data-reveal-card=${index}
      data-flipped=${faceUp ? "true" : "false"}
      data-rarity=${card.rarity}
    >
      <div class="vr-inner h-full w-full">
        <div
          class="vr-face vr-back flex items-center justify-center rounded-2xl border-2 border-white/15"
          style="background: radial-gradient(circle at 50% 35%, #2b2a52, #0f0e24 70%);"
        >
          <span class="font-pixel text-5xl text-white/20">?</span>
        </div>
        <div
          class="vr-face vr-front flex flex-col overflow-hidden rounded-2xl"
          style="border: 3px solid ${color}; background: linear-gradient(180deg, ${color}33, #0f0e1c 60%); box-shadow: 0 0 ${18 +
          rarityPower(card.rarity) * 10}px ${color}88;"
        >
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
                  style="animation: vr-shine 2.6s linear infinite;"
                ></span>`
              : nothing}
          </div>
          <div class="px-3 pb-3 text-center">
            <div
              class="text-[11px] font-black uppercase tracking-[0.18em]"
              style="color:${color}"
            >
              ${resolved === null ? card.rarity : cosmeticRarityLabel(resolved)}
            </div>
            <div class="mt-0.5 truncate text-base font-bold text-white">
              ${name}
            </div>
            ${card.dupe
              ? html`<div
                  data-reveal-dupe
                  class="mt-1 rounded-md bg-amber-400/15 px-2 py-1 text-xs font-bold text-amber-300"
                >
                  ${translateText("vault.duplicate", {
                    credits: card.credits.toLocaleString(),
                  })}
                </div>`
              : html`<div
                  data-reveal-new
                  class="mt-1 rounded-md bg-emerald-400/15 px-2 py-1 text-xs font-bold text-emerald-300"
                >
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
      class="fixed inset-0 z-[3000] flex flex-col items-center justify-center bg-black/85 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
    >
      <style>
        ${CSS}
      </style>
      <div
        data-reveal-stage
        class="relative flex h-full w-full flex-col items-center justify-center overflow-hidden px-4"
      >
        ${this.flash
          ? html`<div
              class="pointer-events-none absolute inset-0 z-40 bg-white"
              style="animation: vr-flash .7s ease-out forwards"
            ></div>`
          : nothing}
        ${mode.kind === "pack" ? this.renderPack(mode, tint) : nothing}
        ${mode.kind === "card"
          ? html`<div class="flex flex-col items-center gap-5">
              <h2
                class="text-2xl font-black uppercase tracking-widest text-white"
              >
                ${mode.title}
              </h2>
              <div style="animation: vr-pop .6s ease-out both">
                ${this.renderCard(mode.card, 0, true)}
              </div>
            </div>`
          : nothing}
        ${mode.kind === "credits"
          ? html`<div class="flex flex-col items-center gap-4 text-center">
              <div
                class="pointer-events-none absolute left-1/2 top-[42%] h-[520px] w-[520px] -translate-x-1/2 -translate-y-1/2 opacity-60"
                style="background: conic-gradient(from 0deg, transparent 0 8%, #fbbf2455 10% 14%, transparent 16% 33%, #fbbf2455 35% 39%, transparent 41% 58%, #fbbf2455 60% 64%, transparent 66% 83%, #fbbf2455 85% 89%, transparent 91%); animation: vr-rays 14s linear infinite; mask-image: radial-gradient(circle, #000 20%, transparent 70%);"
              ></div>
              <div
                class="text-sm font-black uppercase tracking-[0.3em] text-amber-300"
              >
                ${translateText(
                  mode.jackpot ? "vault.jackpot" : "vault.you_won",
                )}
              </div>
              <div
                data-reveal-credits
                class="font-pixel text-6xl text-amber-300 sm:text-7xl"
                style="text-shadow: 0 0 30px #f59e0b; animation: vr-pop .7s ease-out both"
              >
                +${mode.amount.toLocaleString()}
              </div>
              <div class="text-lg font-bold text-white/80">
                ${translateText("vault.credits")}
              </div>
            </div>`
          : nothing}
        <div
          class="absolute bottom-[76px] left-0 right-0 z-30 flex justify-center gap-3"
        >
          ${this.stage === "done"
            ? html`${this.canAgain
                  ? html`<button
                      type="button"
                      data-reveal-again
                      class="ui-focus rounded-ui-card bg-ui-accent px-6 py-3 text-sm font-black uppercase tracking-widest text-white hover:brightness-110"
                      @click=${this.again}
                    >
                      ${translateText("vault.again")}
                    </button>`
                  : nothing}
                <button
                  type="button"
                  data-reveal-done
                  class="ui-focus rounded-ui-card border border-white/25 bg-white/10 px-6 py-3 text-sm font-bold uppercase tracking-widest text-white hover:bg-white/20"
                  @click=${this.close}
                >
                  ${translateText("vault.done")}
                </button>`
            : html`<button
                type="button"
                data-reveal-skip
                class="ui-focus rounded-ui-card border border-white/20 bg-white/5 px-5 py-2 text-xs font-bold uppercase tracking-widest text-white/70 hover:bg-white/15"
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
          class="absolute inset-0 overflow-hidden rounded-3xl"
          style="clip-path: ${side === "left"
            ? "inset(0 50% 0 0)"
            : "inset(0 0 0 50%)"}; background: linear-gradient(160deg, ${base}, #1a1530 70%); ${tearing
            ? `animation: vr-${side} .7s ease-in forwards;`
            : ""}"
        >
          ${this.packArt(mode, base)}
        </div>`;
      return html`<button
        type="button"
        data-reveal-pack
        class="relative h-[360px] w-[250px] cursor-pointer sm:h-[420px] sm:w-[290px]"
        style="${tearing
          ? ""
          : "animation: vr-shake .9s ease-in-out infinite, vr-float 2.4s ease-in-out infinite;"} filter: drop-shadow(0 0 40px ${tearing
          ? tint
          : base}aa);"
        aria-label=${translateText("vault.tear_open")}
        @click=${this.tear}
      >
        ${half("left")}${half("right")}
        ${tearing
          ? html`<div
              class="absolute left-1/2 top-1/2 h-[140%] w-[140%] -translate-x-1/2 -translate-y-1/2 rounded-full"
              style="background: radial-gradient(circle, ${tint}, transparent 65%); animation: vr-flash .7s ease-out forwards"
            ></div>`
          : nothing}
      </button>`;
    }
    return html`<div class="flex max-w-full flex-col items-center gap-6">
      <h2 class="text-xl font-black uppercase tracking-widest text-white">
        ${mode.name}
      </h2>
      <div
        class="flex max-w-full flex-wrap items-center justify-center gap-4 sm:gap-6"
      >
        ${mode.cards.map(
          (card, i) =>
            html`<div
              class="cursor-pointer"
              style="animation: vr-pop .5s ease-out ${i * 0.08}s both"
              @click=${this.flipNext}
            >
              ${this.renderCard(card, i, i < this.flipped)}
            </div>`,
        )}
      </div>
    </div>`;
  }

  private packArt(mode: Extract<RevealMode, { kind: "pack" }>, color: string) {
    return html`<div
      class="flex h-full w-full flex-col items-center justify-center gap-3 text-center"
    >
      <div
        class="text-6xl text-white"
        style="filter: drop-shadow(0 0 12px ${color})"
      >
        ✦
      </div>
      <div
        class="px-3 text-lg font-black uppercase tracking-[0.2em] text-white"
      >
        ${mode.name}
      </div>
      <div
        class="text-[10px] font-bold uppercase tracking-[0.3em] text-white/70"
      >
        DeltaFront
      </div>
    </div>`;
  }
}
