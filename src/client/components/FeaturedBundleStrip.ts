import type { UserMeResponse } from "@openfront/shared/ApiSchemas";
import type { CosmeticPack } from "@openfront/shared/CosmeticSchemas";
import { html, LitElement, nothing } from "lit";
import { customElement, state } from "lit/decorators.js";
import {
  bundleSavings,
  fetchCosmetics,
  levelLockOf,
  resolveCosmetics,
  type ResolvedCosmetic,
} from "../Cosmetics";
import { lastUserMeResponse } from "../UserMeBroadcast";
import { translateText } from "../Utils";
import { timeLeft } from "./BundleCard";
import "./CreditsIcon";

// The homepage's featured-bundle strip: one slim row under Create / Join that
// shows the bundle worth a look (a seasonal one about to end, else the biggest
// saving) and opens the Store's Bundles tab. It hides itself when there is
// nothing to feature.
const STYLE_ID = "featured-bundle-strip-styles";
const CSS = `
.fbs {
  --tier: var(--color-ui-tier-gray);
  position: relative;
  display: flex;
  align-items: center;
  gap: 12px;
  width: 100%;
  height: clamp(36px, 5.4dvh, 48px);
  padding: 0 12px 0 0;
  overflow: hidden;
  isolation: isolate;
  cursor: pointer;
  text-align: left;
  color: var(--color-ui-text);
  background: var(--color-ui-panel);
  border: 1px solid var(--color-ui-border);
  border-radius: 2px;
  transition: border-color 220ms ease, background-color 220ms ease;
}
.fbs:hover,
.fbs:focus-visible {
  border-color: color-mix(in srgb, var(--tier) 70%, var(--color-ui-border));
  background: color-mix(in srgb, var(--tier) 8%, var(--color-ui-panel));
}
.fbs:focus-visible { outline: 2px solid var(--color-ui-accent); outline-offset: 2px; }
.fbs .fbs-hazard {
  align-self: stretch;
  flex: none;
  width: 14px;
  background: repeating-linear-gradient(-45deg, var(--tier) 0 5px, var(--color-ui-ground) 5px 10px);
}
.fbs .fbs-tag {
  flex: none;
  font-family: var(--font-pixel);
  font-size: 10px;
  letter-spacing: 0.16em;
  text-transform: uppercase;
  color: var(--color-ui-muted);
}
.fbs .fbs-name {
  min-width: 0;
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--font-pixel);
  font-size: 13px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}
.fbs .fbs-note {
  flex: none;
  font-family: var(--font-pixel);
  font-size: 10px;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: var(--color-ui-accent-soft);
}
.fbs .fbs-price {
  flex: none;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-family: var(--font-ui-mono);
  font-size: 12px;
  font-weight: 700;
}
.fbs .fbs-sheen {
  position: absolute;
  top: 0;
  bottom: 0;
  left: -40%;
  width: 30%;
  pointer-events: none;
  z-index: -1;
  background: linear-gradient(100deg, transparent, color-mix(in srgb, var(--tier) 28%, transparent), transparent);
  transform: skewX(-18deg);
  opacity: 0;
}
.fbs:hover .fbs-sheen { animation: fbs-sweep 0.9s ease-out; }
@keyframes fbs-sweep {
  0% { left: -40%; opacity: 0; }
  20% { opacity: 1; }
  100% { left: 125%; opacity: 0; }
}
@media (prefers-reduced-motion: reduce) {
  .fbs, .fbs:hover .fbs-sheen { transition: none; animation: none; }
}
`;

const TIER_COLOR: Record<string, string> = {
  common: "var(--color-ui-tier-gray)",
  uncommon: "var(--color-ui-tier-green)",
  rare: "var(--color-ui-tier-blue)",
  epic: "var(--color-ui-tier-purple)",
  legendary: "var(--color-ui-gold)",
};

/**
 * The bundle to feature: one that is for sale to this player, in season and not
 * level-locked. A seasonal bundle (it has an end) comes first, soonest end
 * first, because it will not be there long; otherwise the biggest saving.
 */
export function pickFeaturedBundle(
  resolved: readonly ResolvedCosmetic[],
  userMe: UserMeResponse | false,
  now: number = Date.now(),
): ResolvedCosmetic | null {
  const open = resolved.filter((r) => {
    if (r.type !== "cosmeticPack" || r.relationship !== "purchasable") {
      return false;
    }
    const pack = r.cosmetic as CosmeticPack;
    if (pack.startsAt !== undefined && now < Date.parse(pack.startsAt)) {
      return false;
    }
    if (pack.endsAt !== undefined && now >= Date.parse(pack.endsAt)) {
      return false;
    }
    return (pack.priceSoft ?? 0) > 0 && levelLockOf(r, userMe) === null;
  });
  if (open.length === 0) return null;
  const ends = (r: ResolvedCosmetic) =>
    (r.cosmetic as CosmeticPack).endsAt === undefined
      ? Infinity
      : Date.parse((r.cosmetic as CosmeticPack).endsAt!);
  const saving = (r: ResolvedCosmetic) => bundleSavings(r)?.savePct ?? 0;
  return [...open].sort(
    (a, b) =>
      ends(a) - ends(b) ||
      saving(b) - saving(a) ||
      (a.cosmetic as CosmeticPack).name.localeCompare(
        (b.cosmetic as CosmeticPack).name,
      ),
  )[0];
}

@customElement("featured-bundle-strip")
export class FeaturedBundleStrip extends LitElement {
  @state() private featured: ResolvedCosmetic | null = null;
  private me: UserMeResponse | false = lastUserMeResponse()?.response ?? false;

  createRenderRoot() {
    return this;
  }

  private onUserMe = (event: Event) => {
    this.me = (event as CustomEvent<UserMeResponse | false>).detail;
    void this.refresh();
  };

  connectedCallback() {
    super.connectedCallback();
    if (!document.getElementById(STYLE_ID)) {
      const style = document.createElement("style");
      style.id = STYLE_ID;
      style.textContent = CSS;
      document.head.appendChild(style);
    }
    document.addEventListener("userMeResponse", this.onUserMe);
    void this.refresh();
  }

  disconnectedCallback() {
    document.removeEventListener("userMeResponse", this.onUserMe);
    super.disconnectedCallback();
  }

  private async refresh() {
    const cosmetics = await fetchCosmetics();
    this.featured = pickFeaturedBundle(
      resolveCosmetics(cosmetics, this.me, null),
      this.me,
    );
  }

  /** Opens the Store on its Bundles tab. */
  private open = () => {
    window.showPage?.("page-item-store");
    const store = document.getElementById("page-item-store") as
      | (HTMLElement & { setActiveTab?: (key: string) => void })
      | null;
    requestAnimationFrame(() => store?.setActiveTab?.("bundles"));
  };

  render() {
    const featured = this.featured;
    if (featured === null) return nothing;
    const pack = featured.cosmetic as CosmeticPack;
    const savings = bundleSavings(featured);
    const note =
      pack.endsAt !== undefined
        ? translateText("store.bundle_ends_in", {
            time: timeLeft(Date.parse(pack.endsAt) - Date.now()),
          })
        : savings !== null && savings.savePct > 0
          ? translateText("store.bundle_save", { percent: savings.savePct })
          : "";
    return html`<button
      type="button"
      class="fbs"
      data-featured-bundle=${pack.name}
      style="--tier: ${TIER_COLOR[String(pack.rarity)] ?? TIER_COLOR.common}"
      aria-label=${`${translateText("main.featured_bundle")}: ${pack.displayName}`}
      @click=${this.open}
    >
      <span class="fbs-hazard" aria-hidden="true"></span>
      <span class="fbs-tag">${translateText("main.featured_bundle")}</span>
      <span class="fbs-name">${pack.displayName}</span>
      ${note ? html`<span class="fbs-note">${note}</span>` : nothing}
      <span class="fbs-price"
        ><credits-icon .size=${14}></credits-icon>${(
          pack.priceSoft ?? 0
        ).toLocaleString()}</span
      >
      <span class="fbs-sheen" aria-hidden="true"></span>
    </button>`;
  }
}
