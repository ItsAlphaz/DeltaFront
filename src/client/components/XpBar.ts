import { html, nothing, TemplateResult } from "lit";
import {
  isReducedKey,
  multiplierPercent,
  subscriberTierOf,
  type XpMultiplierKey,
} from "../Progression";
import { translateText } from "../Utils";

// Shared bits of the level / XP UI: number formatting, multiplier lines and
// the progress bar.

export function formatXp(amount: number): string {
  return Math.round(amount).toLocaleString();
}

// Spelled out in full so the translation checks can see every key.
const MULTIPLIER_KEYS = {
  game: "progression.multiplier_game",
  reduced_private: "progression.multiplier_reduced_private",
  reduced_unlisted: "progression.multiplier_reduced_unlisted",
  reduced_low_pop: "progression.multiplier_reduced_low_pop",
  repeat: "progression.multiplier_repeat",
  subscriber: "progression.multiplier_subscriber",
  sovereign: "progression.multiplier_sovereign",
  warlord: "progression.multiplier_warlord",
  vanguard: "progression.multiplier_vanguard",
} as const;

/**
 * A multiplier as a line of its own, the way Overwatch shows a group bonus:
 * "+100% XP (SOVEREIGN BONUS)", "+20% XP (SUBSCRIBER BONUS)" for a boost from
 * no known tier, or "−50% XP (GAME TYPE)" for a cut.
 */
export function xpBonusText(key: XpMultiplierKey, permille: number): string {
  // A reduced game reads "Private Match ×0.25", not a percentage.
  if (isReducedKey(key)) {
    return translateText("progression.reduced_line", {
      source: translateText(MULTIPLIER_KEYS[key]),
      multiplier: String(permille / 1000),
    });
  }
  const percent = multiplierPercent(permille);
  const tier = key === "subscriber" ? subscriberTierOf(permille) : null;
  return translateText(
    percent >= 0 ? "progression.bonus_line" : "progression.penalty_line",
    {
      percent: Math.abs(percent),
      source: translateText(MULTIPLIER_KEYS[tier?.tier ?? key]),
    },
  );
}

/** "1,234 / 5,000 XP", or "Max level" when there is no next level. */
export function xpProgressText(xpInLevel: number, xpForNext: number): string {
  if (!(xpForNext > 0)) return translateText("progression.max_level");
  return translateText("progression.xp_progress", {
    current: formatXp(xpInLevel),
    next: formatXp(xpForNext),
  });
}

/**
 * The XP bar cut into equal square segments, the account header's look: each
 * segment is one tenth of the way to the next level and fills left to right,
 * so a partly filled one still shows exactly how far along the player is. The
 * same progressbar semantics as `xpBar`, so a screen reader hears one value
 * and not ten pieces.
 */
export function segmentedXpBar(
  percent: number,
  opts: { segments?: number; heightClass?: string; valueText?: string } = {},
): TemplateResult {
  const fill = Number.isFinite(percent)
    ? Math.min(100, Math.max(0, percent))
    : 0;
  const count = Math.max(1, Math.floor(opts.segments ?? 10));
  const size = 100 / count;
  return html`<div
    data-xp-bar
    data-xp-segmented
    class="flex w-full gap-1.5 ${opts.heightClass ?? "h-2.5"}"
    role="progressbar"
    aria-label=${translateText("progression.xp_bar_label")}
    aria-valuemin="0"
    aria-valuemax="100"
    aria-valuenow=${Math.round(fill)}
    aria-valuetext=${opts.valueText ?? nothing}
  >
    ${Array.from({ length: count }, (_, i) => {
      const part = Math.min(100, Math.max(0, ((fill - i * size) / size) * 100));
      return html`<div
        data-xp-segment
        data-filled=${part >= 100 ? "full" : part > 0 ? "partial" : "empty"}
        class="h-full min-w-0 flex-1 overflow-hidden bg-white/10"
        style="--seg: ${i}"
      >
        <div
          data-xp-segment-fill
          class="h-full bg-df-red"
          style="width: ${part}%"
        ></div>
      </div>`;
    })}
  </div>`;
}

/**
 * A thin XP bar. `percent` is clamped to 0..100. `valueText` is what a
 * screen reader announces for the value (typically xpProgressText); without
 * it, the percentage. With `animate` the fill eases to a new value when the
 * same bar is drawn again with one (never under reduced motion).
 */
export function xpBar(
  percent: number,
  opts: { heightClass?: string; valueText?: string; animate?: boolean } = {},
): TemplateResult {
  const fill = Number.isFinite(percent)
    ? Math.min(100, Math.max(0, percent))
    : 0;
  return html`<div
    data-xp-bar
    class="w-full overflow-hidden rounded-full bg-white/15 ${opts.heightClass ??
    "h-2"}"
    role="progressbar"
    aria-label=${translateText("progression.xp_bar_label")}
    aria-valuemin="0"
    aria-valuemax="100"
    aria-valuenow=${Math.round(fill)}
    aria-valuetext=${opts.valueText ?? nothing}
  >
    <div
      data-xp-bar-fill
      class="h-full rounded-full bg-df-red ${opts.animate
        ? "transition-[width] duration-700 ease-out motion-reduce:transition-none"
        : ""}"
      style="width: ${fill}%"
    ></div>
  </div>`;
}
