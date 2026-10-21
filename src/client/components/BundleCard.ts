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
import { cosmeticTypeLabel } from "./CosmeticPresentation";
import "./CosmeticPreview";
import "./CreditsIcon";

// The Store's bundle card: a sealed supply crate. A hazard-striped lid in the
// bundle's tier colour, a stencilled name, the loadout laid out under targeting
// brackets with the most valuable item as the hero, a rubber-stamped saving
// and a riveted price plate. Self-contained styling below (the website's
// tokens, one tier colour per card as --tier).
const STYLE_ID = "bundle-card-styles";

const INK = `url("data:image/svg+xml;utf8,${encodeURIComponent(
  "<svg xmlns='http://www.w3.org/2000/svg' width='120' height='120'>" +
    "<filter id='n'><feTurbulence type='fractalNoise' baseFrequency='.85' numOctaves='2' seed='4'/>" +
    "<feColorMatrix values='0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 -1.5 2.2'/></filter>" +
    "<rect width='100%' height='100%' filter='url(#n)'/></svg>",
)}")`;

/** The tier colour of a bundle (its rarity), shared with the contents dialog. */
export const TIER_COLOR: Record<string, string> = {
  common: "var(--color-ui-tier-gray)",
  uncommon: "var(--color-ui-tier-green)",
  rare: "var(--color-ui-tier-blue)",
  epic: "var(--color-ui-tier-purple)",
  legendary: "var(--color-ui-gold)",
};

const CSS = `
.bundle-card {
  --tier: var(--color-ui-tier-gray);
  position: relative;
  display: flex;
  flex-direction: column;
  min-width: 0;
  height: 100%;
  overflow: hidden;
  cursor: pointer;
  text-align: left;
  border: 1px solid color-mix(in srgb, var(--tier) 38%, var(--color-ui-border));
  border-radius: var(--radius-ui-card);
  background:
    radial-gradient(120% 70% at 50% 0%, color-mix(in srgb, var(--tier) 16%, transparent), transparent 70%),
    linear-gradient(180deg, var(--color-ui-surface), var(--color-ui-panel));
  transition: transform 160ms ease, box-shadow 160ms ease, border-color 160ms ease;
}
.bundle-card:hover {
  transform: translateY(-3px);
  border-color: color-mix(in srgb, var(--tier) 75%, var(--color-ui-border));
  box-shadow: 0 16px 36px -14px color-mix(in srgb, var(--tier) 70%, transparent);
}
.bundle-card:focus-visible,
.bundle-card[data-focused] {
  outline: 2px solid var(--color-ui-accent);
  outline-offset: 2px;
}
.bundle-card .bc-hazard {
  height: 10px;
  flex: none;
  background: repeating-linear-gradient(-45deg, var(--tier) 0 8px, var(--color-ui-ground) 8px 16px);
  background-size: 22.63px 22.63px;
  box-shadow: 0 1px 0 color-mix(in srgb, black 60%, transparent);
}
.bundle-card:hover .bc-hazard {
  animation: bc-hazard 0.9s linear infinite;
}
@keyframes bc-hazard {
  to { background-position: 22.63px 0; }
}
.bundle-card .bc-meta {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 12px 14px 0;
  font-family: var(--font-pixel);
  font-size: 10px;
  letter-spacing: 0.16em;
  text-transform: uppercase;
  color: var(--color-ui-muted);
}
.bundle-card .bc-tier {
  padding: 2px 8px;
  border: 1px solid color-mix(in srgb, var(--tier) 60%, transparent);
  border-radius: 4px;
  color: var(--tier);
  background: color-mix(in srgb, var(--tier) 12%, transparent);
}
.bundle-card .bc-name {
  margin: 8px 14px 0;
  font-family: var(--font-pixel);
  font-size: clamp(19px, 1.7vw, 25px);
  line-height: 1.05;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--color-ui-text);
  text-shadow: 2px 2px 0 color-mix(in srgb, black 55%, transparent);
}
.bundle-card .bc-tag {
  margin: 4px 14px 0;
  font-size: 12px;
  color: var(--color-ui-muted);
}
.bundle-card .bc-loadout {
  position: relative;
  display: grid;
  grid-template-columns: 2fr 1fr;
  grid-template-rows: 1fr 1fr;
  gap: 8px;
  margin: 12px 14px 0;
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
  border-radius: 6px;
  background:
    repeating-linear-gradient(0deg, color-mix(in srgb, white 3.5%, transparent) 0 1px, transparent 1px 3px),
    var(--color-ui-ground);
  border: 1px solid var(--color-ui-border);
  transition: transform 180ms ease, border-color 180ms ease;
}
.bundle-card .bc-tile[data-hero] {
  grid-row: 1 / span 2;
  padding: 10px;
}
.bundle-card:hover .bc-tile {
  transform: translateY(-3px);
  border-color: color-mix(in srgb, var(--tier) 55%, var(--color-ui-border));
}
.bundle-card:hover .bc-tile:nth-child(2) { transition-delay: 40ms; }
.bundle-card:hover .bc-tile:nth-child(3) { transition-delay: 80ms; }
.bundle-card .bc-tile > cosmetic-preview {
  width: auto;
  height: 100%;
  max-width: 100%;
  aspect-ratio: 1 / 1;
}
.bundle-card .bc-tile::after {
  content: "";
  position: absolute;
  inset: 3px;
  pointer-events: none;
  opacity: 0.6;
  transition: opacity 160ms ease;
  --b: var(--tier);
  background:
    linear-gradient(var(--b), var(--b)) top left / 9px 2px no-repeat,
    linear-gradient(var(--b), var(--b)) top left / 2px 9px no-repeat,
    linear-gradient(var(--b), var(--b)) top right / 9px 2px no-repeat,
    linear-gradient(var(--b), var(--b)) top right / 2px 9px no-repeat,
    linear-gradient(var(--b), var(--b)) bottom left / 9px 2px no-repeat,
    linear-gradient(var(--b), var(--b)) bottom left / 2px 9px no-repeat,
    linear-gradient(var(--b), var(--b)) bottom right / 9px 2px no-repeat,
    linear-gradient(var(--b), var(--b)) bottom right / 2px 9px no-repeat;
}
.bundle-card:hover .bc-tile::after { opacity: 1; }
.bundle-card .bc-more {
  position: absolute;
  inset: 0;
  z-index: 2;
  display: flex;
  align-items: center;
  justify-content: center;
  background: color-mix(in srgb, var(--color-ui-ground) 72%, transparent);
  font-family: var(--font-pixel);
  font-size: 15px;
  letter-spacing: 0.08em;
  color: var(--color-ui-text);
}
.bundle-card .bc-stamp {
  position: absolute;
  z-index: 3;
  top: -8px;
  right: -6px;
  padding: 3px 9px 1px;
  border: 3px solid var(--color-ui-accent);
  border-radius: 3px;
  color: var(--color-ui-accent);
  background: color-mix(in srgb, var(--color-ui-ground) 82%, transparent);
  font-family: var(--font-ui-mono);
  font-size: 13px;
  font-weight: 800;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  white-space: nowrap;
  transform: rotate(9deg);
  -webkit-mask-image: ${INK};
  mask-image: ${INK};
  -webkit-mask-size: 120px 120px;
  mask-size: 120px 120px;
  pointer-events: none;
}
.bundle-card[data-owned] .bc-stamp {
  top: 38%;
  right: auto;
  left: 50%;
  font-size: 20px;
  color: var(--color-ui-success);
  border-color: var(--color-ui-success);
  transform: translateX(-50%) rotate(-10deg);
}
.bundle-card[data-owned] .bc-tile,
.bundle-card[data-partial] .bc-tile { filter: grayscale(0.7) brightness(0.8); }
.bundle-card .bc-foot {
  position: relative;
  margin-top: auto;
  padding: 14px 14px 14px;
}
.bundle-card .bc-value {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 8px;
  font-size: 11px;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--color-ui-muted);
}
.bundle-card .bc-value s { color: var(--color-ui-placeholder); }
.bundle-card .bc-value b { color: var(--tier); font-weight: 700; }
.bundle-card .bc-plate {
  position: relative;
  padding: 2px 0 0;
}
.bundle-card .bc-rivet {
  position: absolute;
  top: -5px;
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: radial-gradient(circle at 35% 35%, var(--color-ui-border-hover), var(--color-ui-border));
  box-shadow: 0 0 0 1px var(--color-ui-ground);
}
.bundle-card .bc-rivet:nth-child(1) { left: 0; }
.bundle-card .bc-rivet:nth-child(2) { right: 0; }
@media (prefers-reduced-motion: reduce) {
  .bundle-card,
  .bundle-card .bc-tile { transition: none; }
  .bundle-card:hover { transform: none; }
  .bundle-card:hover .bc-hazard { animation: none; }
}
`;

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
    if (!document.getElementById(STYLE_ID)) {
      const style = document.createElement("style");
      style.id = STYLE_ID;
      style.textContent = CSS;
      document.head.appendChild(style);
    }
  }

  private activate() {
    this.onActivate?.(this.resolved);
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
    return html`<div
      class="bundle-card"
      data-store-product
      data-bundle-card
      data-cosmetic-key=${this.resolved.key}
      ?data-focused=${this.state === "focused"}
      ?data-owned=${owned}
      ?data-partial=${partial}
      style="--tier: ${TIER_COLOR[rarity] ?? TIER_COLOR.common}"
      role="button"
      tabindex="0"
      aria-label=${pack.displayName}
      @click=${() => this.activate()}
      @keydown=${(e: KeyboardEvent) => {
        if (e.target !== e.currentTarget) return;
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          this.activate();
        }
      }}
    >
      <div class="bc-hazard" aria-hidden="true"></div>
      <div class="bc-meta">
        <span translate="no"
          >${translateText("store.bundle_lot", { lot })} ·
          ${translateText("store.bundle_items", { count: items.length })}</span
        >
        <span class="bc-tier">${translateText(`cosmetics.${rarity}`)}</span>
      </div>
      <h3 class="bc-name">${pack.displayName}</h3>
      ${pack.tagline ? html`<p class="bc-tag">${pack.tagline}</p>` : nothing}
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
    </div>`;
  }
}
