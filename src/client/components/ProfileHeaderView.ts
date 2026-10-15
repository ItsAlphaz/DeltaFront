import type { StaffRoleWire } from "@openfront/shared/WireSchemas";
import { html, nothing, TemplateResult } from "lit";
import {
  clampPrestige,
  levelFraction,
  rankLabelKey,
  titleText,
} from "../Progression";
import { translateText } from "../Utils";
import "./LevelBadge";
import { levelBadgeLabel } from "./LevelBadge";
import { staffBadge, staffRoleLabel } from "./ui/StaffBadge";
import { splitAccountUsername } from "./ui/UsernameText";
import { verifiedBadge } from "./ui/VerifiedBadge";
import { formatXp, segmentedXpBar, xpProgressText } from "./XpBar";

/**
 * The pieces of a player's profile header, drawn one way for everyone. Your own
 * Account page and another player's Stats page are two views of the same
 * profile system: the same bands, the same avatar with its level chip, the same
 * name, badges and chips, the same LEVEL · RANK line and segmented XP bar, with
 * the same spacing. Each view says what is private to it (Credits, the title
 * select, the linked handle on your page; the lifetime XP and the title others
 * see on theirs) and leaves the rest to these.
 *
 * Every hook is `data-ph-*` (profile header), so one test and one stylesheet
 * serve both. Pure functions of what they are given: nothing here fetches.
 */

/** Where the bands sit: roomy enough that the XP never crowds the avatar. */
export const PH_SPACING = {
  // The identity band's bottom edge clears the level chip that overhangs the avatar.
  identity: "px-6 pt-6 pb-9 sm:px-8 sm:pt-8 sm:pb-10",
  // The progression band: a rule, a shade of its own and room above the level line.
  progression:
    "border-t border-white/15 bg-black/25 px-6 pb-7 pt-7 sm:px-8 sm:pb-8 sm:pt-8",
  // A band under it (the title row).
  band: "border-t border-white/10 px-6 py-6 sm:px-8",
} as const;

export interface PhLevel {
  level: number;
  prestige: number;
  legend: boolean;
}

// The card both views sit in: one border, one panel (the hex pattern and the
// opening flourish come from ProfileHeaderBase).
export const PH_CARD_CLASS =
  "relative overflow-hidden rounded-xl border border-white/10 bg-df-panel text-white";

// ------------------------------------------------------------------ identity

/** The first letter of the name, for the avatar tile when there is no picture. */
export function initialOf(name: string | null | undefined): string {
  return (name ?? "?").trim().charAt(0).toUpperCase() || "?";
}

/** The avatar tile and, when there is a level, its chip on the corner. */
export function phAvatar(opts: {
  url: string | null;
  initial: string;
  level: PhLevel | null;
}): TemplateResult {
  const { url, initial, level } = opts;
  return html`<div data-ph-avatar-wrap class="relative shrink-0">
    <div
      data-ph-avatar
      class="grid h-20 w-20 place-items-center overflow-hidden border border-white/20 bg-black/50 sm:h-24 sm:w-24"
    >
      ${url === null
        ? html`<span
            class="font-display text-4xl font-bold text-white sm:text-5xl"
            aria-hidden="true"
            >${initial}</span
          >`
        : html`<img
            class="h-full w-full object-cover"
            src=${url}
            alt=${translateText("discord_user_header.avatar_alt")}
            @error=${(e: Event) => {
              (e.target as HTMLImageElement).style.display = "none";
            }}
          />`}
    </div>
    ${level === null
      ? nothing
      : html`<span
          data-ph-level-chip
          role="img"
          aria-label=${levelBadgeLabel(
            level.level,
            level.prestige,
            level.legend,
          )}
          class="absolute -bottom-2 -right-2 grid h-7 min-w-7 place-items-center bg-df-red px-1.5 font-display text-sm font-bold leading-none text-white shadow-[0_0_0_3px_var(--color-df-panel)]"
          >${level.level}</span
        >`}
  </div>`;
}

/** The clan tag, a line of its own above the name. */
export function phClan(tag: string | null): TemplateResult | typeof nothing {
  return tag === null
    ? nothing
    : html`<span
        data-ph-clan
        class="max-w-full truncate font-display text-xs font-bold uppercase tracking-[0.2em] text-df-red-bright"
        >[${tag}]</span
      >`;
}

/**
 * The name as one run of text ("Aydin.4821"), the discriminator muted when
 * there is one: textContent is the whole name either way.
 */
export function phName(username: string): TemplateResult {
  const { base, discriminator } = splitAccountUsername(username);
  return html`${base}${discriminator === null
    ? nothing
    : html`<span class="font-normal text-white/40">.${discriminator}</span>`}`;
}

/**
 * The account's name with its badges, and one chip per status. Three different
 * facts, each from its own source and none implying another:
 *   - Verified: users.verified, set only by the admin CLI;
 *   - the staff role: read by the API from the database;
 *   - the linked Discord/Google/email identity, drawn OUTSIDE this block.
 *
 * The block is `contents`: its rows join the column of the identity band (so
 * the handle can sit between the name and the chips) while staying together in
 * the DOM under one element. `ids` names the parts for your own page, where
 * more than one thing looks for them; another player's card has none.
 */
export function phStatus(opts: {
  username: string | null;
  verified: boolean;
  staffRole: StaffRoleWire | undefined;
  ids: boolean;
  // Verified, but no username yet: say so, and offer to set one.
  askForUsername: boolean;
}): TemplateResult | typeof nothing {
  const { username, verified, staffRole, ids } = opts;
  if (!verified && staffRole === undefined && username === null) {
    return nothing;
  }
  const id = (name: string) => (ids ? name : nothing);
  const chip =
    "inline-flex items-center gap-1.5 border px-3 py-1.5 font-display text-[11px] font-bold uppercase leading-none tracking-[0.16em]";
  const staffChip =
    staffRole === "owner"
      ? "border-df-red/50 bg-df-red/15 text-red-200"
      : "border-white/20 bg-white/10 text-white/80";
  return html`
    <div id=${id("account-status")} class="contents">
      <div
        class="order-1 flex min-w-0 max-w-full items-center gap-2.5 text-2xl font-black leading-tight text-white sm:text-3xl"
      >
        ${username !== null
          ? html`<span
              id=${id("account-username")}
              data-ph-name
              class="min-w-0 truncate"
              title=${username}
              >${phName(username)}</span
            >`
          : nothing}
        ${staffBadge(staffRole, "w-5 h-5 shrink-0")}
        ${verified ? verifiedBadge("w-6 h-6 shrink-0") : nothing}
      </div>
      ${verified || staffRole !== undefined
        ? html`<div class="order-3 mt-1 flex flex-wrap items-center gap-2">
            ${verified
              ? html`<span
                  id=${id("account-verified-chip")}
                  data-ph-chip="verified"
                  class="${chip} border-white/25 bg-black text-white"
                >
                  ${verifiedBadge("w-3.5 h-3.5", "text-df-red-bright", null)}
                  ${translateText("account_modal.verified_label")}
                </span>`
              : nothing}
            ${staffRole !== undefined
              ? html`<span
                  id=${id("account-staff-chip")}
                  data-ph-chip="staff"
                  data-staff-role=${staffRole}
                  class="${chip} ${staffChip}"
                >
                  ${staffBadge(staffRole, "w-3.5 h-3.5", null)}
                  ${staffRoleLabel(staffRole)}
                </span>`
              : nothing}
          </div>`
        : nothing}
      ${verified && username === null && opts.askForUsername
        ? html`<div
            id=${id("account-verified-needs-username")}
            class="order-4 mt-1 flex flex-col items-start gap-2"
          >
            <span class="text-sm text-white/70"
              >${translateText("account_modal.verified_needs_username")}</span
            >
            <button
              type="button"
              class="df-btn"
              @click=${() => {
                window.location.hash = "modal=change-username";
              }}
            >
              ${translateText("account_modal.set_username")}
            </button>
          </div>`
        : nothing}
    </div>
  `;
}

/** The title other players see under a name: a star and the earned title. */
export function phTitle(title: string | null): TemplateResult | typeof nothing {
  if (title === null) return nothing;
  return html`<span
    data-ph-title
    class="order-2 max-w-full truncate text-sm font-bold uppercase tracking-wider text-yellow-300"
    >★ ${titleText(title, translateText)}</span
  >`;
}

/**
 * The identity band: the avatar and who the player is on the left, an aside on
 * the right (your Credits, or another player's lifetime XP) that goes under them
 * on a phone. `identity` is whatever sits beside the avatar (clan, status, ...).
 */
export function phIdentityBand(opts: {
  avatar: TemplateResult;
  identity: TemplateResult;
  aside: TemplateResult | typeof nothing;
  style?: string;
}): TemplateResult {
  return html`<div
    data-ph-identity
    class="relative flex flex-col gap-6 ${PH_SPACING.identity} sm:flex-row sm:items-start sm:justify-between sm:gap-8"
    style=${opts.style ?? ""}
  >
    <div class="flex min-w-0 items-start gap-4 sm:gap-6">
      ${opts.avatar}
      <div class="flex min-w-0 flex-1 flex-col gap-1">${opts.identity}</div>
    </div>
    ${opts.aside}
  </div>`;
}

/** The aside's label over its figure; `kind` says which ("credits", "lifetime"). */
export function phAside(
  kind: string,
  label: string,
  figure: TemplateResult,
): TemplateResult {
  return html`<div
    data-ph-aside=${kind}
    class="flex shrink-0 flex-col gap-2 sm:items-end"
  >
    <span
      class="font-display text-xs font-bold uppercase tracking-[0.22em] text-white/50"
      >${label}</span
    >
    ${figure}
  </div>`;
}

// --------------------------------------------------------------- progression

/**
 * LEVEL 47 · LIEUTENANT · PRESTIGE 3, or LEGEND · SUPREME COMMANDER · PRESTIGE
 * 10, with the prestige emblem before it once there is one.
 */
export function phLevelLine(level: PhLevel): TemplateResult {
  const prestige = clampPrestige(level.prestige);
  const emblem = level.legend || prestige > 0;
  const text = level.legend
    ? "bg-gradient-to-r from-yellow-300 via-fuchsia-300 to-yellow-300 bg-clip-text text-transparent"
    : "text-white";
  return html`<div class="flex min-w-0 items-center gap-3">
    ${emblem
      ? html`<level-badge
          data-ph-emblem
          .level=${level.level}
          .prestige=${level.prestige}
          .legend=${level.legend}
          .size=${32}
        ></level-badge>`
      : nothing}
    <div
      data-ph-level-line
      class="min-w-0 break-words font-display text-lg font-bold uppercase leading-snug tracking-[0.16em] sm:text-xl ${text}"
    >
      ${level.legend
        ? translateText("progression.legend")
        : translateText("progression.level", { level: level.level })}
      <span class="text-white/30">·</span>
      <span data-ph-rank class="whitespace-nowrap"
        >${translateText(rankLabelKey(level.level))}</span
      >
      ${prestige > 0
        ? html`<span class="text-white/30">·</span>
            <span
              data-ph-prestige
              class="whitespace-nowrap ${level.legend ? "" : "text-yellow-300"}"
              >${translateText("progression.prestige", { prestige })}</span
            >`
        : nothing}
    </div>
  </div>`;
}

/**
 * The progression band: the level line, what is under it on the left (the next
 * milestone on your page; the season on another's) and the XP figure on the
 * right, then the segmented bar on a row of its own, and `after` (the Prestige
 * strip) below that. Without XP in the level (an older public endpoint) the
 * figure and the bar are left out.
 */
export function phProgressionBand(opts: {
  level: PhLevel;
  xpInLevel?: number;
  xpForNext?: number;
  left: TemplateResult | typeof nothing;
  after?: TemplateResult | typeof nothing;
}): TemplateResult {
  const { level, xpInLevel, xpForNext } = opts;
  const hasXp = xpInLevel !== undefined && xpForNext !== undefined;
  const next = level.legend ? 0 : (xpForNext ?? 0);
  const xpText = hasXp ? xpProgressText(xpInLevel, next) : null;
  const fraction = level.legend
    ? 1
    : levelFraction(xpInLevel ?? 0, xpForNext ?? 0);
  return html`<div
    data-ph-progression
    class="relative flex flex-col gap-4 ${PH_SPACING.progression}"
  >
    ${phLevelLine(level)}
    <div
      class="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1 text-sm"
    >
      <div class="min-w-0 text-white/55">${opts.left}</div>
      ${xpText === null
        ? nothing
        : html`<span
            data-ph-xp-text
            class="shrink-0 font-bold tabular-nums text-white"
            >${xpText}</span
          >`}
    </div>
    ${xpText === null
      ? nothing
      : html`<div class="mt-1">
          ${segmentedXpBar(fraction * 100, { valueText: xpText })}
        </div>`}
    ${opts.after ?? nothing}
  </div>`;
}

/** The Prestige strip, shown at level 100 on your own card. */
export function phPrestigeStrip(onPrestige: () => void): TemplateResult {
  return html`<div
    class="mt-2 flex flex-wrap items-center justify-between gap-3 border border-yellow-300/30 bg-yellow-300/5 px-4 py-3"
  >
    <span class="text-sm text-yellow-200"
      >${translateText("prestige.ready")}</span
    >
    <button
      type="button"
      data-ph-prestige-button
      class="profile-prestige-button df-btn"
      @click=${onPrestige}
    >
      ${translateText("prestige.button")}
    </button>
  </div>`;
}

/** The lifetime XP figure: the aside of another player's card. */
export function phLifetimeFigure(xp: number): TemplateResult {
  return html`<span
    data-ph-lifetime
    class="text-3xl font-black leading-none tabular-nums text-yellow-300"
    >${formatXp(xp)}</span
  >`;
}
