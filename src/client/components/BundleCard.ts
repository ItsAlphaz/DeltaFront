import type { CosmeticPack } from "@openfront/shared/CosmeticSchemas";
import {
  html,
  LitElement,
  nothing,
  type PropertyValues,
  type TemplateResult,
} from "lit";
import { customElement, property } from "lit/decorators.js";
import { bundleSavings, type ResolvedCosmetic } from "../Cosmetics";
import { translateText } from "../Utils";
import { ensurePixelCardStyles } from "../vault/VaultCardStyles";
import { playTick, RARITY_COLOR, VaultFx } from "../vault/VaultFx";
import { pixelBorder, tone } from "../vault/VaultPixel";
import { tiltLeave, tiltMove } from "../vault/VaultTilt";
import { cosmeticTypeLabel } from "./CosmeticPresentation";
import "./CosmeticPreview";
import "./CreditsIcon";

// The Store's bundle card, in the Vault's pixel look: a supply crate with a
// hazard-striped lid in the bundle's tier colour, a pixel frame in that colour
// (--c, with --bi its border: `tone()`), the loadout laid out under targeting
// brackets with the most valuable item as the hero, a pixel stamp for the
// saving and a plate for the price. It leans towards the pointer, its tiles
// hop one after the other, sparks rise from the crate, and a click bursts
// pixels from where it landed. Everything that moves moves in steps, and all of
// it is off for reduced motion. Self-contained styling below.
const STYLE_ID = "bundle-card-styles";

/** The tier colour of a bundle (its rarity), shared with the contents dialog. */
export const TIER_COLOR: Record<string, string> = {
  common: "var(--color-ui-tier-gray)",
  uncommon: "var(--color-ui-tier-green)",
  rare: "var(--color-ui-tier-blue)",
  epic: "var(--color-ui-tier-purple)",
  legendary: "var(--color-ui-gold)",
};

/** The tier as a plain colour, which the pixel borders (an SVG) need, and the style that sets it. */
export const tierHex = (rarity: string): string =>
  (RARITY_COLOR as Record<string, string>)[rarity] ?? RARITY_COLOR.common;
export const tierStyle = (rarity: string): string =>
  `--tier:${TIER_COLOR[rarity] ?? TIER_COLOR.common};${tone(tierHex(rarity))}`;

const PLUS =
  "polygon(40% 0, 60% 0, 60% 40%, 100% 40%, 100% 60%, 60% 60%, 60% 100%, 40% 100%, 40% 60%, 0 60%, 0 40%, 40% 40%)";

export const BUNDLE_CSS = `
.bundle-card, .bundle-card *, .bundle-banner, .bundle-banner *, .pc-dialog, .pc-dialog * { font-family: var(--font-pixel, "Pixelify Sans"), Inter, system-ui, sans-serif; }
bundle-card { position: relative; }
bundle-card:hover { z-index: 10; }
.bc-host { position: relative; height: 100%; }
.bundle-card {
  --u: 4px;
  --tier: var(--color-ui-tier-gray);
  --c: #9ca3af;
  --bi-green: ${pixelBorder("#4ade80")};
  position: relative;
  display: flex;
  flex-direction: column;
  min-width: 0;
  height: 100%;
  cursor: pointer;
  text-align: left;
  border: var(--u) solid transparent;
  border-image: var(--bi) 1 / var(--u) / 0 stretch;
  background-clip: padding-box;
  background:
    conic-gradient(rgba(255,255,255,.05) 25% , transparent 0 50%, rgba(255,255,255,.05) 0 75%, transparent 0) 0 0 / calc(var(--u) * 2) calc(var(--u) * 2),
    linear-gradient(180deg, color-mix(in srgb, var(--c) 24%, #16151d) 0 36%, color-mix(in srgb, var(--c) 10%, #13121a) 36% 38%, #111016 38%);
  transition: box-shadow 120ms steps(2, end);
}
@media (max-width: 640px) { .bundle-card { --u: 3px; } }
.bundle-card:hover { box-shadow: 0 6px 0 color-mix(in srgb, var(--c) 45%, #000); }
.bundle-card.vault-tilt:active { --tilt-s: 0.97; box-shadow: none; }
.bundle-card:focus-visible { outline: 3px solid #fff; outline-offset: 3px; }
.bundle-card[data-focused] { box-shadow: 0 6px 0 color-mix(in srgb, var(--c) 75%, #000), 0 0 0 3px rgba(255,255,255,.25); }
.bundle-card .vault-edge { z-index: 4; }
.bundle-card .vault-glare { z-index: 5; }
.bundle-card .bc-hazard {
  height: 12px;
  flex: none;
  background: repeating-linear-gradient(90deg, var(--c) 0 8px, #0b0814 8px 16px);
  box-shadow: 0 4px 0 rgba(0,0,0,.5);
}
.bundle-card:hover .bc-hazard { animation: bc-march 0.6s steps(4) infinite; }
@keyframes bc-march { to { background-position: 16px 0; } }
.bundle-card .bc-meta {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 14px 14px 0;
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: rgba(255,255,255,.6);
}
.bundle-card .bc-tier {
  --u: 2px;
  padding: 2px 8px;
  border: var(--u) solid transparent;
  border-image: var(--bi) 1 / var(--u) / 0 stretch;
  background-clip: padding-box;
  color: var(--c);
  background-color: color-mix(in srgb, var(--c) 16%, #14121c);
}
.bundle-card .bc-name {
  margin: 10px 14px 0;
  font-size: clamp(22px, 1.9vw, 28px);
  font-weight: 700;
  line-height: 1.05;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: #fff;
  text-shadow: 3px 3px 0 #000;
}
.bundle-card .bc-tag { margin: 6px 14px 0; font-size: 14px; color: rgba(255,255,255,.62); }
.bundle-card .bc-ends {
  margin: 6px 14px 0;
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: var(--color-ui-accent-soft);
}
.bundle-card .bc-ends::before {
  content: "";
  display: inline-block;
  width: 8px;
  height: 8px;
  margin-right: 8px;
  background: var(--color-ui-accent);
  animation: bc-blink 1s steps(2, end) infinite;
}
@keyframes bc-blink { 0%, 49.9% { opacity: 1; } 50%, 100% { opacity: .25; } }
.bundle-card .bc-loadout {
  position: relative;
  display: grid;
  grid-template-columns: 2fr 1fr;
  grid-template-rows: 1fr 1fr;
  gap: 8px;
  margin: 14px 14px 0;
  aspect-ratio: 3 / 2;
}
.bundle-card .bc-tile {
  position: relative;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 6px;
  background: rgba(0,0,0,.42);
  box-shadow: inset 0 0 0 3px rgba(255,255,255,.07);
  transition: transform 120ms steps(2, end), box-shadow 120ms steps(2, end);
}
.bundle-card .bc-tile[data-hero] { grid-row: 1 / span 2; padding: 10px; }
.bundle-card:hover .bc-tile { transform: translateY(-4px); box-shadow: inset 0 0 0 3px color-mix(in srgb, var(--c) 55%, #000), 0 4px 0 rgba(0,0,0,.5); }
.bundle-card:hover .bc-tile:nth-child(2) { transition-delay: 60ms; }
.bundle-card:hover .bc-tile:nth-child(3) { transition-delay: 120ms; }
.bundle-card .bc-tile > cosmetic-preview { width: auto; height: 100%; max-width: 100%; aspect-ratio: 1 / 1; }
.bundle-card .bc-tile::after {
  content: "";
  position: absolute;
  inset: 4px;
  pointer-events: none;
  opacity: 0.55;
  --b: var(--c);
  background:
    linear-gradient(var(--b), var(--b)) top left / 10px 4px no-repeat,
    linear-gradient(var(--b), var(--b)) top left / 4px 10px no-repeat,
    linear-gradient(var(--b), var(--b)) top right / 10px 4px no-repeat,
    linear-gradient(var(--b), var(--b)) top right / 4px 10px no-repeat,
    linear-gradient(var(--b), var(--b)) bottom left / 10px 4px no-repeat,
    linear-gradient(var(--b), var(--b)) bottom left / 4px 10px no-repeat,
    linear-gradient(var(--b), var(--b)) bottom right / 10px 4px no-repeat,
    linear-gradient(var(--b), var(--b)) bottom right / 4px 10px no-repeat;
}
.bundle-card:hover .bc-tile::after { opacity: 1; animation: bc-brackets .5s steps(2, end) infinite alternate; }
@keyframes bc-brackets { to { inset: 2px; } }
.bundle-card .bc-more {
  position: absolute;
  inset: 0;
  z-index: 2;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(10,9,16,.74);
  font-size: 20px;
  font-weight: 700;
  letter-spacing: 0.08em;
  color: #fff;
  text-shadow: 2px 2px 0 #000;
}
.bundle-card .bc-spark { position: absolute; bottom: 20%; width: 12px; height: 12px; background: color-mix(in srgb, var(--c) 45%, #fff); clip-path: ${PLUS}; opacity: 0; pointer-events: none; z-index: 3; }
.bundle-card:hover .bc-spark { animation: bc-rise 1.2s steps(6, end) infinite; animation-delay: var(--d, 0s); }
@keyframes bc-rise { 0% { opacity: 0; transform: translateY(16px); } 30% { opacity: 1; } 100% { opacity: 0; transform: translateY(-48px); } }
.bundle-card .bc-stamp {
  --u: 3px;
  position: absolute;
  z-index: 6;
  top: -12px;
  right: -8px;
  padding: 5px 10px;
  border: var(--u) solid transparent;
  border-image: var(--bi) 1 / var(--u) / 0 stretch;
  background-clip: padding-box;
  background-color: #14121c;
  color: var(--c);
  box-shadow: 4px 4px 0 #000;
  font-size: 15px;
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  white-space: nowrap;
  pointer-events: none;
}
.bundle-card:hover .bc-stamp { animation: bc-wiggle .5s steps(1, end) infinite; }
@keyframes bc-wiggle { 0% { transform: translate(0, 0); } 50% { transform: translate(0, -4px); } }
.bundle-card[data-owned] .bc-stamp {
  top: 38%;
  right: auto;
  left: 50%;
  font-size: 20px;
  color: #4ade80;
  border-image-source: var(--bi-green);
  transform: translateX(-50%);
}
.bundle-card[data-owned]:hover .bc-stamp { animation: none; }
.bundle-card[data-owned] .bc-tile,
.bundle-card[data-partial] .bc-tile { filter: grayscale(0.8) brightness(0.7); }
.bundle-card .bc-foot { position: relative; margin-top: auto; padding: 16px 14px 14px; }
.bundle-card .bc-value {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 10px;
  font-size: 13px;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: rgba(255,255,255,.6);
}
.bundle-card .bc-value s { color: rgba(255,255,255,.4); }
.bundle-card .bc-value b { color: var(--c); font-weight: 700; }
.bundle-card .bc-plate { position: relative; padding: 2px 0 0; }
.bundle-card .bc-plate button, .bundle-card .bc-plate > * { border-radius: 0; }
.bundle-card .bc-rivet { position: absolute; top: -8px; width: 4px; height: 4px; background: var(--c); opacity: .7; }
.bundle-card .bc-rivet:nth-child(1) { left: 0; }
.bundle-card .bc-rivet:nth-child(2) { right: 0; }
.bc-pop { position: absolute; inset: 0; z-index: 7; pointer-events: none; background: var(--c); opacity: 0; animation: bc-flash .24s steps(2, end); }
@keyframes bc-flash { 0% { opacity: .38; } 50% { opacity: .2; } 100% { opacity: 0; } }

/* the strip over the grid */
.bundle-banner {
  --u: 4px;
  display: flex;
  align-items: center;
  gap: 14px;
  margin: 12px 12px 0;
  padding: 10px 16px;
  border: var(--u) solid transparent;
  border-image: ${pixelBorder("#3a3750")} 1 / var(--u) / 0 stretch;
  background-clip: padding-box;
  background-color: #14121c;
  box-shadow: 0 var(--u) 0 rgba(0,0,0,.5);
}
.bundle-banner .bb-hazard { width: 64px; height: 12px; flex: none; background: repeating-linear-gradient(90deg, var(--color-ui-accent) 0 8px, #0b0814 8px 16px); animation: bc-march 1.2s steps(8) infinite; }
.bundle-banner .bb-text { font-size: 14px; font-weight: 700; letter-spacing: 0.16em; text-transform: uppercase; color: rgba(255,255,255,.7); }

/* the contents dialog */
.pc-overlay { position: fixed; inset: 0; z-index: 10020; display: flex; align-items: center; justify-content: center; background: rgba(0,0,0,.82); animation: pc-fade .2s steps(4, end); }
@keyframes pc-fade { from { opacity: 0; } to { opacity: 1; } }
.pc-dialog {
  --u: 4px;
  --tier: var(--color-ui-tier-gray);
  --c: #9ca3af;
  position: relative;
  margin: 0 16px;
  max-height: 85vh;
  width: 100%;
  max-width: 42rem;
  overflow-y: auto;
  border: var(--u) solid transparent;
  border-image: var(--bi) 1 / var(--u) / 0 stretch;
  background-clip: padding-box;
  background:
    conic-gradient(rgba(255,255,255,.05) 25%, transparent 0 50%, rgba(255,255,255,.05) 0 75%, transparent 0) 0 0 / 8px 8px,
    linear-gradient(180deg, color-mix(in srgb, var(--c) 18%, #14131b) 0 22%, #111016 22%);
  box-shadow: 0 8px 0 #000;
  animation: pc-pop .28s steps(5, end);
  scrollbar-width: thin;
}
@keyframes pc-pop { from { opacity: 0; transform: translateY(36px) scale(.94); } to { opacity: 1; transform: none; } }
.pc-dialog .pc-hazard { height: 12px; width: 100%; background: repeating-linear-gradient(90deg, var(--c) 0 8px, #0b0814 8px 16px); animation: bc-march 1.6s steps(8) infinite; }
.pc-dialog .pc-close { position: absolute; right: 12px; top: 24px; display: flex; width: 36px; height: 36px; align-items: center; justify-content: center; background: #14121c; box-shadow: inset 0 0 0 3px #3a3750, 3px 3px 0 #000; color: rgba(255,255,255,.7); font-size: 24px; line-height: 1; cursor: pointer; transition: transform .08s steps(2, end); }
.pc-dialog .pc-close:hover { background: var(--color-ui-accent); color: #fff; transform: translateY(-2px); box-shadow: inset 0 0 0 3px #a3181b, 3px 5px 0 #000; }
.pc-dialog .pc-close:active { transform: translateY(2px); box-shadow: inset 0 0 0 3px #a3181b; }
.pc-dialog .pc-title { margin: 0 0 4px; padding-right: 44px; font-size: 30px; font-weight: 700; letter-spacing: .04em; text-transform: uppercase; color: #fff; text-shadow: 3px 3px 0 #000; }
.pc-dialog .pc-tag { margin: 0 0 4px; font-size: 14px; font-weight: 700; letter-spacing: .18em; text-transform: uppercase; color: var(--c); text-shadow: 2px 2px 0 #000; }
.pc-dialog .pc-desc { margin: 0 0 16px; font-size: 16px; color: rgba(255,255,255,.65); }
.pc-dialog .pc-savings { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 16px; padding: 10px 14px; background: rgba(0,0,0,.42); box-shadow: inset 0 0 0 3px color-mix(in srgb, var(--c) 40%, #000); font-size: 14px; letter-spacing: .06em; text-transform: uppercase; color: rgba(255,255,255,.65); }
.pc-dialog .pc-savings b { color: var(--c); }
.pc-dialog .pc-item { animation: pc-in .3s steps(4, end) backwards; animation-delay: var(--d, 0s); }
@keyframes pc-in { from { opacity: 0; transform: translateY(20px); } to { opacity: 1; transform: none; } }
.pc-dialog .pc-type { font-size: 12px; font-weight: 700; letter-spacing: .14em; text-transform: uppercase; color: rgba(255,255,255,.6); }

@media (prefers-reduced-motion: reduce) {
  .bundle-card, .bundle-card .bc-tile { transition: none; }
  .bundle-card:hover .bc-hazard, .bundle-card:hover .bc-tile::after, .bundle-card:hover .bc-spark, .bundle-card:hover .bc-stamp, .bundle-card .bc-ends::before, .bundle-banner .bb-hazard, .pc-dialog, .pc-overlay, .pc-dialog .pc-hazard, .pc-dialog .pc-item, .bc-pop { animation: none !important; }
}
`;

/** Puts the bundle styles (card, banner, dialog) on the page, once. */
export function ensureBundleStyles(): void {
  ensurePixelCardStyles();
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = BUNDLE_CSS;
  document.head.appendChild(style);
}

/** "3d 4h", "5h 12m" or "9m": how long a seasonal bundle has left. */
export function timeLeft(ms: number): string {
  const minutes = Math.max(0, Math.floor(ms / 60_000));
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  return `${minutes}m`;
}

@customElement("bundle-card")
export class BundleCard extends LitElement {
  @property({ attribute: false }) resolved!: ResolvedCosmetic;
  /** The bundle's buy action, or its ownership status (what the Store computes for it). */
  @property({ attribute: false }) actionContent:
    | TemplateResult
    | typeof nothing = nothing;
  /** 1-based position in the shop, printed as "LOT 03". */
  @property({ type: Number }) lot = 1;
  @property({ type: String, reflect: true }) state: "idle" | "focused" = "idle";
  @property({ attribute: false }) onActivate:
    | ((resolved: ResolvedCosmetic) => void)
    | undefined;

  createRenderRoot() {
    return this;
  }

  protected willUpdate(_changed: PropertyValues) {
    ensureBundleStyles();
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.fx?.dispose();
    this.fx = null;
  }

  private fx: VaultFx | null = null;

  private activate() {
    this.onActivate?.(this.resolved);
  }

  /** A click bursts pixels from where it landed, and the crate flashes once. */
  private pop(event: MouseEvent) {
    const target = event.target as HTMLElement | null;
    if (target?.closest("button, a, [data-cosmetic-action]")) return;
    const host = this.querySelector<HTMLElement>(".bc-host");
    if (host === null || (event.clientX === 0 && event.clientY === 0)) return;
    const rect = host.getBoundingClientRect();
    const color = tierHex(
      String((this.resolved.cosmetic as CosmeticPack).rarity),
    );
    this.fx ??= new VaultFx(host);
    this.fx.burst(
      event.clientX - rect.left,
      event.clientY - rect.top,
      [color, "#ffffff", "#fde68a"],
      {
        count: 22,
        speed: 260,
        gravity: 300,
        life: 0.6,
        shape: "dot",
      },
    );
    playTick(1.4);
    const flash = document.createElement("span");
    flash.className = "bc-pop";
    flash.setAttribute("aria-hidden", "true");
    this.querySelector(".bundle-card")?.appendChild(flash);
    flash.addEventListener("animationend", () => flash.remove());
    setTimeout(() => flash.remove(), 400);
  }

  private renderTile(item: ResolvedCosmetic, hero: boolean, more: number) {
    return html`<div
      class="bc-tile"
      ?data-hero=${hero}
      data-bundle-item=${item.key}
      title=${cosmeticTypeLabel(item)}
    >
      <cosmetic-preview .resolved=${item} size="card"></cosmetic-preview>
      ${more > 0
        ? html`<span class="bc-more" data-bundle-more>+${more}</span>`
        : nothing}
    </div>`;
  }

  render() {
    const pack = this.resolved.cosmetic as CosmeticPack;
    const items = this.resolved.packItems ?? [];
    const rarity = String(pack.rarity);
    const savings = bundleSavings(this.resolved);
    const owned = this.resolved.relationship === "owned";
    const partial = this.resolved.relationship === "blocked";
    // The most valuable item is the hero, the next two follow in order; the
    // rest hide behind "+N" on the last tile.
    const price = (item: ResolvedCosmetic) =>
      (item.cosmetic as { priceSoft?: number } | null)?.priceSoft ?? 0;
    const ranked = [...items].sort((a, b) => price(b) - price(a));
    const shown = ranked.slice(0, 3);
    const extra = Math.max(0, items.length - shown.length);
    const lot = String(this.lot).padStart(2, "0");
    const edge = rarity === "epic" || rarity === "legendary";
    return html`<div
      class="bc-host"
      @pointermove=${(e: PointerEvent) => tiltMove(e, 7)}
      @pointerleave=${tiltLeave}
    >
      <div
        class="bundle-card vault-tilt"
        data-store-product
        data-bundle-card
        data-cosmetic-key=${this.resolved.key}
        ?data-focused=${this.state === "focused"}
        ?data-owned=${owned}
        ?data-partial=${partial}
        style="${tierStyle(rarity)};--tilt-hover-scale:1.03"
        role="button"
        tabindex="0"
        aria-label=${pack.displayName}
        @click=${(e: MouseEvent) => {
          this.pop(e);
          this.activate();
        }}
        @keydown=${(e: KeyboardEvent) => {
          if (e.target !== e.currentTarget) return;
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            this.activate();
          }
        }}
      >
        ${edge
          ? html`<span class="vault-edge" aria-hidden="true"></span>`
          : nothing}
        <div class="bc-hazard" aria-hidden="true"></div>
        <div class="bc-meta">
          <span translate="no"
            >${translateText("store.bundle_lot", { lot })} ·
            ${translateText("store.bundle_items", {
              count: items.length,
            })}</span
          >
          <span class="bc-tier">${translateText(`cosmetics.${rarity}`)}</span>
        </div>
        <h3 class="bc-name">${pack.displayName}</h3>
        ${pack.tagline ? html`<p class="bc-tag">${pack.tagline}</p>` : nothing}
        ${pack.endsAt !== undefined
          ? html`<p class="bc-ends" data-bundle-ends>
              ${translateText("store.bundle_ends_in", {
                time: timeLeft(Date.parse(pack.endsAt) - Date.now()),
              })}
            </p>`
          : nothing}
        <div class="bc-loadout">
          ${shown.map((item, index) =>
            this.renderTile(item, index === 0, index === 2 ? extra : 0),
          )}
          ${savings !== null && savings.savePct > 0 && !owned && !partial
            ? html`<span class="bc-stamp" data-bundle-save
                >${translateText("store.bundle_save", {
                  percent: savings.savePct,
                })}</span
              >`
            : nothing}
          ${[16, 38, 62, 84].map(
            (left, i) =>
              html`<i
                class="bc-spark"
                aria-hidden="true"
                style="left:${left}%;--d:${i * 0.28}s"
              ></i>`,
          )}
          ${owned
            ? html`<span class="bc-stamp" data-bundle-secured
                >${translateText("store.bundle_secured")}</span
              >`
            : nothing}
        </div>
        <div class="bc-foot">
          ${savings !== null && savings.savePct > 0 && !owned && !partial
            ? html`<div class="bc-value">
                <span
                  >${translateText("store.bundle_value")}
                  <s>${savings.value.toLocaleString()}</s></span
                ><b
                  >${translateText("store.bundle_you_save", {
                    amount: (savings.value - savings.price).toLocaleString(),
                  })}</b
                >
              </div>`
            : nothing}
          <div class="bc-plate">
            <i class="bc-rivet" aria-hidden="true"></i
            ><i class="bc-rivet" aria-hidden="true"></i>
            ${this.actionContent}
          </div>
        </div>
        <span class="vault-glare" aria-hidden="true"></span>
      </div>
    </div>`;
  }
}
