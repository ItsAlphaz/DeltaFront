import { html, nothing, svg, type TemplateResult } from "lit";
import { staffBadge } from "../components/ui/StaffBadge";
import { verifiedBadge } from "../components/ui/VerifiedBadge";
import { translateText } from "../Utils";
import type {
  DescribedEvent,
  MatchEventIcon,
  PlayerSlot,
} from "./MatchEventText";
import { slotText } from "./MatchEventText";

/**
 * Draws one described match event: an icon, then the sentence with the players
 * in it as chips (colour, clan tag, name, then the staff badge and the verified
 * check, the same marks every other surface draws). Shared by the live feed and
 * the full log, so a line reads the same in both.
 */

export type Translate = (
  key: string,
  params?: Record<string, string | number>,
) => string;

// Strokes only, on a 24 x 24 grid; colour comes from the row (currentColor).
// SVG fragments need the `svg` tag: `html` would create them in the HTML namespace.
function glyph(icon: MatchEventIcon) {
  switch (icon) {
    case "eliminated": // a crosshair
      return svg`<circle cx="12" cy="12" r="6.5"></circle>
        <path d="M12 2.5v5M12 16.5v5M2.5 12h5M16.5 12h5"></path>`;
    case "crown":
      return svg`<path d="M3.5 18.5 5 7.5l4.6 4.7L12 5l2.4 7.2L19 7.5l1.5 11Z"></path>`;
    case "alliance": // two rings, linked
      return svg`<circle cx="8.8" cy="12" r="5"></circle>
        <circle cx="15.2" cy="12" r="5"></circle>`;
    case "alliance_broken": // two rings, apart, a break between
      return svg`<circle cx="6.5" cy="12" r="4"></circle>
        <circle cx="17.5" cy="12" r="4"></circle>
        <path d="M10.8 12h.4M12.8 12h.4"></path>
        <path d="M11 6.5l2 11"></path>`;
    case "territory": // a downward trend
      return svg`<path d="M3 6l6 6 4-4 8 8"></path>
        <path d="M15 16h6v-6"></path>`;
    case "flag":
      return svg`<path d="M5.5 21V4M5.5 4.5h12.5l-3 4.5 3 4.5H5.5"></path>`;
    case "admin": // a bolt
      return svg`<path d="M13 2.5 5.5 13.5h5.5l-1 8 8-12h-5.5Z"></path>`;
  }
}

export function matchEventIcon(
  icon: MatchEventIcon,
  sizeClass = "w-3.5 h-3.5",
) {
  return html`<svg
    viewBox="0 0 24 24"
    class="${sizeClass} shrink-0"
    fill="none"
    stroke="currentColor"
    stroke-width="2"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
    data-match-event-icon=${icon}
  >
    ${glyph(icon)}
  </svg>`;
}

/** One player inside a sentence. */
export function playerChip(slot: PlayerSlot | undefined): TemplateResult {
  if (slot === undefined) {
    return html`<span class="text-df-text-muted">?</span>`;
  }
  return html`<span
    class="inline-flex items-center gap-1 min-w-0 max-w-full align-middle"
    data-match-event-player=${slot.id}
  >
    ${slot.color === null
      ? nothing
      : html`<span
          class="inline-block w-2 h-2 rounded-[2px] shrink-0 border border-white/30"
          style="background:${slot.color}"
        ></span>`}
    ${slot.clan === null
      ? nothing
      : html`<span class="text-df-text-secondary shrink-0"
          >[${slot.clan}]</span
        >`}
    <span class="font-semibold text-white truncate">${slot.name}</span>
    ${staffBadge(slot.staff, "w-3.5 h-3.5")}
    ${slot.verified ? verifiedBadge("w-3.5 h-3.5") : nothing}
  </span>`;
}

const ROLE_KEYS = {
  owner: "match_events.role_owner",
  admin: "match_events.role_admin",
  mod: "match_events.role_mod",
} as const;

const MARK_ACTOR = "\uE000actor\uE001";
const MARK_TARGET = "\uE000target\uE001";
const MARK_ROLE = "\uE000role\uE001";

/**
 * The sentence with its players filled in as chips. The sentence is translated
 * once, with marker strings where the players go; the markers are then swapped
 * for the chips, so every language keeps its own word order.
 */
export function sentence(
  desc: DescribedEvent,
  translate: Translate = translateText,
): TemplateResult {
  const text = translate(desc.key, {
    ...desc.params,
    actor: MARK_ACTOR,
    target: MARK_TARGET,
    role: MARK_ROLE,
  });
  const parts = text.split(/(\uE000(?:actor|target|role)\uE001)/u);
  return html`${parts.map((part) => {
    switch (part) {
      case MARK_ACTOR:
        return playerChip(desc.slots.actor);
      case MARK_TARGET:
        return playerChip(desc.slots.target);
      case MARK_ROLE:
        return html`<span
          class="uppercase tracking-wide text-[0.85em] text-df-red-bright font-semibold"
          >${desc.role === null ? "" : translate(ROLE_KEYS[desc.role])}</span
        >`;
      default:
        return part;
    }
  })}`;
}

/** The sentence as plain text (labels, tests, copy): "[DELTA] Alphaz eliminated RedFox". */
export function sentenceText(
  desc: DescribedEvent,
  translate: Translate = translateText,
): string {
  const who = (s: PlayerSlot | undefined) =>
    s === undefined ? "?" : slotText(s);
  const text = translate(desc.key, {
    ...desc.params,
    actor: who(desc.slots.actor),
    target: who(desc.slots.target),
    role: desc.role === null ? "" : translate(ROLE_KEYS[desc.role]),
  });
  return desc.repeat > 1 ? `${text} ×${desc.repeat}` : text;
}

/** The "×4" of a collapsed run, when the sentence does not already say how many. */
export function repeatBadge(desc: DescribedEvent) {
  return desc.repeat > 1
    ? html`<span class="text-df-text-muted font-mono shrink-0"
        >×${desc.repeat}</span
      >`
    : nothing;
}
