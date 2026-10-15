import {
  html,
  LitElement,
  PropertyValues,
  svg,
  SVGTemplateResult,
  TemplateResult,
} from "lit";
import { property, state } from "lit/decorators.js";
import { prefersReducedMotion } from "../utilities/ReducedMotion";

// What the two profile cards share: your own page's header and the Stats
// header of everyone else (and yours). The look is one system (see
// ProfileHeaderView), and so is the way it opens, which lives here.
//
// A card opens with a flourish, once per opening of the page it's on
// (`openKey`; not again on a tab switch): the avatar and its level chip settle
// in with a bounce, the XP bar fills segment by segment, a sheen crosses the
// card and a pulse of light runs out from behind the avatar through the card's
// own hex pattern. A Legend's card is edged and patterned in gold, its pulse is
// gold and comes back gently for a while. None of it under reduced motion, on a
// hidden page, or inside another site's frame.

// The pulses' bands, as wide as their brightest part reaches past the ring.
const BLUE_BAND = 90;
const GOLD_BAND = 110;
// The pulses' final animations: when they end, the layer goes.
const BLUE_PULSE_END = "profile-card-pulse-fade";
const GOLD_PULSE_END = "profile-card-gold-ring";

// Each card names its own hex pattern: a shared id would resolve to the
// first card in the document, which may sit in a hidden page (Chrome draws no
// pattern from a display:none subtree).
let nextPatternId = 0;

// The openings that already played their flourish, by openKey, most recent
// last. A page names each opening anew, so only its latest key can come up
// again: a few are kept (a page can open over another), not every one ever.
export const PLAYED_OPEN_KEYS_KEPT = 8;
const playedOpenKeys: string[] = [];

function isEmbedded(): boolean {
  try {
    return window.self !== window.top;
  } catch {
    return true;
  }
}

/**
 * Whether anything on the page may open with a flourish at all: never under
 * reduced motion, on a hidden page, or inside another site's frame (CrazyGames
 * and the like).
 */
export function flourishAllowed(): boolean {
  return (
    !prefersReducedMotion() &&
    document.visibilityState !== "hidden" &&
    !isEmbedded()
  );
}

/**
 * Claims one opening's flourish: true the first time a key is claimed (and the
 * flourish is allowed), false for every later claim of the same key. Without a
 * key every claim plays.
 */
export function claimOpening(key: string | undefined): boolean {
  if (key !== undefined) {
    if (playedOpenKeys.includes(key)) return false;
    playedOpenKeys.push(key);
    if (playedOpenKeys.length > PLAYED_OPEN_KEYS_KEPT) playedOpenKeys.shift();
  }
  return flourishAllowed();
}

interface Pulse {
  kind: "blue" | "gold";
  // Where it starts (the avatar's middle), in the card's own pixels, and how
  // far it runs (to the farthest corner, and its band past it).
  cx: number;
  cy: number;
  reach: number;
}

export abstract class ProfileHeaderBase extends LitElement {
  private readonly patternId = `profile-card-hex-${nextPatternId++}`;
  // Names one opening of the page the card is on: the flourish plays once per
  // key, however often the card is rendered again (a tab switch builds a new
  // one). Without a key it plays once per card.
  @property({ attribute: false }) openKey: string | undefined = undefined;

  @state() protected intro = false;
  @state() private pulse: Pulse | null = null;
  private introDecided = false;
  private pulseMeasured = false;

  /** Whether this card has anything to open with (it has a level to show). */
  protected abstract flourishWanted(): boolean;
  /** A Legend's card is edged and patterned in gold, and pulses gold. */
  protected abstract isLegend(): boolean;

  createRenderRoot() {
    return this;
  }

  connectedCallback(): void {
    super.connectedCallback();
    ensureProfileCardStyles();
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    this.stopPulse();
  }

  protected willUpdate(changed: PropertyValues<this>): void {
    super.willUpdate(changed);
    // Decided before the first paint with a level to show, so the card never
    // shows once and then jumps into its entrance.
    if (this.introDecided || !this.flourishWanted()) return;
    this.introDecided = true;
    this.intro = claimOpening(this.openKey);
  }

  protected updated(changed: PropertyValues<this>): void {
    super.updated(changed);
    if (!this.intro || this.pulseMeasured) return;
    this.pulseMeasured = true;
    void this.startPulse();
  }

  // Measures where the pulse starts (the avatar's middle) and how far it
  // runs, once the card has laid out, then starts it.
  private async startPulse(): Promise<void> {
    const card = this.querySelector<HTMLElement>("[data-ph-root]");
    if (card === null) return;
    await this.updateComplete;
    if (!this.isConnected || !this.intro) return;
    const box = card.getBoundingClientRect();
    // Not laid out (a hidden page): no pulse.
    if (box.width === 0 || box.height === 0) return;
    // In the card's own pixels: the modal around it may still be scaling in.
    const scale = card.offsetWidth > 0 ? card.offsetWidth / box.width : 1;
    const width = box.width * scale;
    const height = box.height * scale;
    const avatar = card
      .querySelector<HTMLElement>("[data-ph-avatar]")
      ?.getBoundingClientRect();
    const origin = avatar && avatar.width > 0 ? avatar : box;
    const cx = (origin.left + origin.width / 2 - box.left) * scale;
    const cy = (origin.top + origin.height / 2 - box.top) * scale;
    const far = Math.max(
      Math.hypot(cx, cy),
      Math.hypot(width - cx, cy),
      Math.hypot(cx, height - cy),
      Math.hypot(width - cx, height - cy),
    );
    const kind = this.isLegend() ? "gold" : "blue";
    this.pulse = {
      kind,
      cx: Math.round(cx),
      cy: Math.round(cy),
      reach: Math.round(far + (kind === "gold" ? GOLD_BAND : BLUE_BAND)),
    };
    document.addEventListener("visibilitychange", this.onVisibilityChange);
  }

  // A hidden page drops the pulse: it would only play on, unseen.
  private onVisibilityChange = (): void => {
    if (document.visibilityState === "hidden") this.stopPulse();
  };

  private stopPulse(): void {
    document.removeEventListener("visibilitychange", this.onVisibilityChange);
    this.pulse = null;
  }

  // The layer's last animation ending (the names are its own).
  private onPulseEnd = (e: AnimationEvent): void => {
    const end = this.pulse?.kind === "gold" ? GOLD_PULSE_END : BLUE_PULSE_END;
    if (e.animationName === end) this.stopPulse();
  };

  /** The classes the card's section carries for its opening and its rank. */
  protected cardClasses(): string {
    return `${this.isLegend() ? "profile-card-legend" : ""} ${
      this.intro ? "profile-card-intro" : ""
    }`;
  }

  /** The pattern and the pulse behind a card's content, as one fragment. */
  protected renderBackdrop(): TemplateResult {
    return html`${this.renderPattern(
      this.patternId,
      this.isLegend()
        ? this.hexPath("#facc15", 0.075, 1.5)
        : this.hexPath("#2dd4bf", 0.07, 1.5),
      { className: "" },
    )}${this.pulse === null ? html`` : this.renderPulse(this.pulse)}`;
  }

  // The hex pattern behind the card: teal, or gold on a Legend's card.
  // `pulse` draws the brighter copy the opening pulse lights up.
  private renderPattern(
    id: string,
    paths: SVGTemplateResult,
    extra: { className: string; style?: string },
  ): TemplateResult {
    return html`<svg
      aria-hidden="true"
      class="pointer-events-none absolute inset-0 h-full w-full ${extra.className}"
      style=${extra.style ?? ""}
    >
      <defs>
        <pattern
          id=${id}
          width="60"
          height="103.92"
          patternUnits="userSpaceOnUse"
        >
          ${paths}
        </pattern>
      </defs>
      <rect width="100%" height="100%" fill="url(#${id})"></rect>
    </svg>`;
  }

  private hexPath(
    stroke: string,
    opacity: number,
    width: number,
  ): SVGTemplateResult {
    // svg``, not html``: a fragment on its own is parsed as HTML, which
    // would make an HTML element named "path" that draws nothing.
    return svg`<path
      d="M30 0 L60 17.32 L60 51.96 L30 69.28 L0 51.96 L0 17.32 Z M30 69.28 L30 103.92"
      fill="none"
      stroke=${stroke}
      stroke-opacity=${opacity}
      stroke-width=${width}
    ></path>`;
  }

  // The opening pulse: a second, brighter copy of the card's hex pattern,
  // seen only through a ring-shaped mask that grows out from behind the
  // avatar. Drawn once; only the mask's radius (a registered custom property)
  // animates. Blue rings twice and goes; a Legend's gold ring comes back
  // every few seconds for about half a minute.
  private renderPulse(pulse: Pulse): TemplateResult {
    const paths =
      pulse.kind === "gold"
        ? svg`${this.hexPath("#f59e0b", 0.25, 6)}${this.hexPath(
            "#fde68a",
            0.8,
            1.8,
          )}`
        : this.hexPath("#7dd3fc", 0.75, 2);
    const svgTemplate = this.renderPattern(`${this.patternId}-pulse`, paths, {
      className: `profile-card-pulse profile-card-pulse-${pulse.kind}`,
      style: `--cx: ${pulse.cx}px; --cy: ${pulse.cy}px; --reach: ${pulse.reach}px`,
    });
    return html`<div
      data-profile-pulse=${pulse.kind}
      class="pointer-events-none absolute inset-0"
      @animationend=${this.onPulseEnd}
    >
      ${svgTemplate}
    </div>`;
  }
}

const STYLE_ID = "profile-card-styles";

// Once per document, in <head>: the pulses' radii are registered custom
// properties, which only a document stylesheet can declare.
export function ensureProfileCardStyles(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = PROFILE_CARD_CSS;
  document.head.appendChild(style);
}

const blueMask = `radial-gradient(circle at var(--cx) var(--cy),
    transparent calc(var(--pc-wave1) - var(--band)),
    rgba(0, 0, 0, 0.35) calc(var(--pc-wave1) - var(--band) * 0.55),
    #000 calc(var(--pc-wave1) - var(--band) * 0.1),
    transparent calc(var(--pc-wave1) + var(--band) * 0.2)),
  radial-gradient(circle at var(--cx) var(--cy),
    transparent calc(var(--pc-wave2) - var(--band) * 0.8),
    rgba(0, 0, 0, 0.45) calc(var(--pc-wave2) - var(--band) * 0.15),
    transparent calc(var(--pc-wave2) + var(--band) * 0.15))`;

const goldMask = `radial-gradient(circle at var(--cx) var(--cy),
    transparent calc(var(--pc-gold) - var(--band)),
    rgba(0, 0, 0, 0.28) calc(var(--pc-gold) - var(--band) * 0.55),
    rgba(0, 0, 0, 0.7) calc(var(--pc-gold) - var(--band) * 0.12),
    transparent calc(var(--pc-gold) + var(--band) * 0.18))`;

const PROFILE_CARD_CSS = /* css */ `
@property --pc-wave1 { syntax: "<length>"; inherits: false; initial-value: 0px; }
@property --pc-wave2 { syntax: "<length>"; inherits: false; initial-value: 0px; }
@property --pc-gold { syntax: "<length>"; inherits: false; initial-value: 0px; }

/* Opening: the avatar and its level chip settle in with a bounce, the XP bar
   fills one segment after another, the figures slide up, one sheen crosses. */
.profile-card-intro [data-ph-avatar-wrap] {
  animation: profile-card-badge-in 560ms cubic-bezier(0.2, 0.9, 0.3, 1.25) 100ms both;
}
.profile-card-intro [data-ph-level-chip] {
  animation: profile-card-chip-pop 520ms cubic-bezier(0.2, 0.9, 0.3, 1.6) 380ms both;
}
.profile-card-intro level-badge {
  animation: profile-card-badge-in 520ms cubic-bezier(0.2, 0.9, 0.3, 1.25) 250ms both;
}
@keyframes profile-card-badge-in {
  from { opacity: 0; transform: scale(0.7); }
}
@keyframes profile-card-chip-pop {
  from { opacity: 0; transform: scale(0.3); }
}
.profile-card-intro [data-xp-segment-fill] {
  transform-origin: left center;
  animation: profile-card-bar-in 460ms cubic-bezier(0.2, 0.9, 0.3, 1.15)
    calc(300ms + var(--seg, 0) * 70ms) both;
}
@keyframes profile-card-bar-in {
  from { transform: scaleX(0); }
}
.profile-card-intro [data-ph-level-line],
.profile-card-intro [data-ph-aside] {
  animation: df-rise 520ms cubic-bezier(0.2, 0.9, 0.3, 1.1) 200ms both;
}
.profile-card-intro::after {
  content: "";
  position: absolute;
  inset: 0;
  pointer-events: none;
  background: linear-gradient(105deg, transparent 35%, rgba(255, 255, 255, 0.1) 47%,
    rgba(255, 255, 255, 0.18) 50%, rgba(255, 255, 255, 0.1) 53%, transparent 65%);
  transform: translateX(-100%);
  animation: profile-card-sheen 1100ms ease-out 450ms both;
}
@keyframes profile-card-sheen {
  to { transform: translateX(100%); }
}

/* The Account page's sections come in one after another: a small, bouncy
   rise, in the order of their --i. Only while the page's opening plays. */
.account-intro .df-enter {
  animation: df-rise 480ms cubic-bezier(0.2, 0.9, 0.3, 1.15) calc(var(--i, 0) * 80ms + 120ms) both;
}
@keyframes df-rise {
  from { opacity: 0; transform: translateY(12px); }
}

/* The pulse layers. */
.profile-card-pulse-blue {
  --band: ${BLUE_BAND}px;
  filter: drop-shadow(0 0 4px #38bdf8);
  -webkit-mask-image: ${blueMask};
  mask-image: ${blueMask};
  animation:
    profile-card-wave1 1700ms cubic-bezier(0.3, 0.55, 0.45, 1) 150ms both,
    profile-card-wave2 1700ms cubic-bezier(0.3, 0.55, 0.45, 1) 560ms both,
    ${BLUE_PULSE_END} 2400ms linear both;
}
@keyframes profile-card-wave1 {
  from { --pc-wave1: 0px; }
  to { --pc-wave1: var(--reach); }
}
@keyframes profile-card-wave2 {
  from { --pc-wave2: 0px; }
  to { --pc-wave2: var(--reach); }
}
@keyframes ${BLUE_PULSE_END} {
  0%, 70% { opacity: 1; }
  100% { opacity: 0; }
}
.profile-card-pulse-gold {
  --band: ${GOLD_BAND}px;
  -webkit-mask-image: ${goldMask};
  mask-image: ${goldMask};
  animation: ${GOLD_PULSE_END} 3600ms cubic-bezier(0.33, 0.5, 0.5, 1) 300ms 8 both;
}
@keyframes ${GOLD_PULSE_END} {
  0% { --pc-gold: 0px; opacity: 0; }
  6% { opacity: 1; }
  70% { opacity: 1; }
  100% { --pc-gold: var(--reach); opacity: 0; }
}

/* A Legend's card: a thin gold edge and a gold-tinted pattern. */
.profile-card-legend {
  border-color: rgba(250, 204, 21, 0.38) !important;
  box-shadow: 0 0 0 1px rgba(250, 204, 21, 0.12), 0 0 28px rgba(250, 204, 21, 0.1),
    inset 0 0 40px rgba(250, 204, 21, 0.05);
  background-image: linear-gradient(135deg, rgba(250, 204, 21, 0.06), transparent 45%);
}
/* Its Legend line shimmers once as the card opens. */
.profile-card-legend.profile-card-intro [data-ph-level-line] {
  background-size: 200% 100%;
  animation: profile-card-line-shimmer 2.4s ease-in-out both;
}
@keyframes profile-card-line-shimmer {
  from { background-position: 100% 0; }
  to { background-position: -100% 0; }
}

/* The Prestige button glows on and off: the glow is its own layer, and only
   that layer's opacity animates. */
.profile-prestige-button {
  position: relative;
  box-shadow: 0 0 8px rgba(250, 204, 21, 0.45);
}
.profile-prestige-button::before {
  content: "";
  position: absolute;
  inset: 0;
  border-radius: inherit;
  box-shadow: 0 0 22px rgba(250, 204, 21, 0.9);
  opacity: 0;
  pointer-events: none;
  animation: profile-prestige-glow 1.8s ease-in-out infinite;
}
@keyframes profile-prestige-glow {
  50% { opacity: 1; }
}

@media (prefers-reduced-motion: reduce) {
  .profile-card-intro [data-ph-avatar-wrap],
  .profile-card-intro [data-ph-level-chip],
  .profile-card-intro level-badge,
  .profile-card-intro [data-xp-segment-fill],
  .profile-card-intro [data-ph-level-line],
  .profile-card-intro [data-ph-aside],
  .profile-card-legend.profile-card-intro [data-ph-level-line],
  .account-intro .df-enter,
  .profile-prestige-button::before {
    animation: none;
  }
  .profile-card-intro::after,
  .profile-card-pulse {
    display: none;
  }
}
`;
