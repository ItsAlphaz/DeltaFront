import type {
  ProgressionMe,
  UserMeResponse,
} from "@openfront/shared/ApiSchemas";
import { html, nothing, TemplateResult } from "lit";
import {
  clampPrestige,
  levelFraction,
  rankLabelKey,
  titleText,
} from "../Progression";
import { getDiscordAvatarUrl, translateText } from "../Utils";
import "./CurrencyDisplay";
import "./LevelBadge";
import { levelBadgeLabel } from "./LevelBadge";
import { staffBadge, staffRoleLabel } from "./ui/StaffBadge";
import { verifiedBadge } from "./ui/VerifiedBadge";
import { formatXp, segmentedXpBar, xpProgressText } from "./XpBar";

/**
 * The top of the Account page: ONE card, in three bands with real space and a
 * full-width rule between them.
 *
 *   identity     avatar + level chip · [CLAN] name ✓ · @handle · chips     Credits
 *   progression  LEVEL 47 · RANK · prestige
 *                next milestone                                  XP into level
 *                segmented XP bar, on its own row
 *   title        Display title / hint                              [select]
 *
 * The XP bar is a band of its own under a rule instead of sitting beside the
 * avatar, which is what keeps it from being jammed against the identity. On a
 * narrow screen every group stacks; the name truncates, tags and handles
 * truncate, and the XP figure wraps under the level line instead of pushing the
 * card wider.
 *
 * A plain template function, not an element: the modal renders it in its own
 * pass, so the status block, the chips and the title select are in the DOM the
 * moment the modal is. Nothing here fetches or saves: the title choice and the
 * Prestige press are callbacks for the page to act on.
 */
export interface AccountProfileHeaderProps {
  player: UserMeResponse["player"];
  // The linked sign-in identities (Discord, Google, email, Steam).
  identity: UserMeResponse["user"] | null | undefined;
  // Titles to pick from, once /progression/me has answered. The level, XP and
  // the chosen title come from player.progress and show at once.
  progression: ProgressionMe | null;
  prestigeable: boolean;
  savingTitle?: boolean;
  onTitleChange: (title: string | null) => void;
  onPrestige: () => void;
}

// A faint engineering grid behind the identity band.
const GRID_STYLE =
  "background-image: linear-gradient(rgba(255,255,255,0.035) 1px, transparent 1px), " +
  "linear-gradient(90deg, rgba(255,255,255,0.035) 1px, transparent 1px); " +
  "background-size: 24px 24px;";

/** The linked identity as the player knows it: "@alphaz", an email, a persona. */
export function linkedHandle(
  identity: UserMeResponse["user"] | null | undefined,
): { text: string; kind: "discord" | "google" | "email" | "steam" } | null {
  if (identity?.discord) {
    return { text: `@${identity.discord.username}`, kind: "discord" };
  }
  if (identity?.google) return { text: identity.google.email, kind: "google" };
  if (identity?.email) return { text: identity.email, kind: "email" };
  if (identity?.steam) {
    const name = identity.steam.personaName?.trim();
    return {
      text:
        name === undefined || name === ""
          ? translateText("steam_user_header.default_name")
          : name,
      kind: "steam",
    };
  }
  return null;
}

function avatarUrl(
  identity: UserMeResponse["user"] | null | undefined,
): string | null {
  if (identity?.discord) return getDiscordAvatarUrl(identity.discord);
  return identity?.steam?.avatarUrl ?? null;
}

function renderAvatar(props: AccountProfileHeaderProps): TemplateResult {
  const { player, identity } = props;
  const url = avatarUrl(identity);
  const progress = player.progress;
  const initial = (
    player.username ??
    linkedHandle(identity)?.text.replace(/^@/, "") ??
    "?"
  )
    .trim()
    .charAt(0)
    .toUpperCase();
  return html`<div class="relative shrink-0">
    <div
      data-account-avatar
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
    ${progress
      ? html`<span
          data-account-level-chip
          role="img"
          aria-label=${levelBadgeLabel(
            progress.level,
            progress.prestige,
            progress.legend,
          )}
          class="absolute -bottom-2 -right-2 grid h-7 min-w-7 place-items-center bg-df-red px-1.5 font-display text-sm font-bold leading-none text-white shadow-[0_0_0_3px_var(--color-df-panel)]"
          >${progress.level}</span
        >`
      : nothing}
  </div>`;
}

// The DeltaFront account itself, apart from the sign-in identity: its username
// with the verified check, and one chip per status. Three different facts, each
// from its own source and none implying another:
//   - Verified: users.verified (player.verified), set only by the admin CLI;
//   - the staff role: player.staffRole, read by the API from the database;
//   - the linked Discord/Google/email identity, drawn OUTSIDE this block.
//
// The block is `contents`: its rows join the column of the identity band (so
// the handle can sit between the name and the chips) while staying together in
// the DOM under #account-status.
function renderStatus(
  props: AccountProfileHeaderProps,
): TemplateResult | typeof nothing {
  const { player } = props;
  const verified = player.verified === true;
  const staffRole = player.staffRole;
  const username = player.username ?? null;
  if (!verified && staffRole === undefined && username === null) {
    return nothing;
  }
  const chip =
    "inline-flex items-center gap-1.5 border px-3 py-1.5 font-display text-[11px] font-bold uppercase leading-none tracking-[0.16em]";
  const staffChip =
    staffRole === "owner"
      ? "border-df-red/50 bg-df-red/15 text-red-200"
      : "border-white/20 bg-white/10 text-white/80";
  return html`
    <div id="account-status" class="contents">
      <div
        class="order-1 flex min-w-0 max-w-full items-center gap-2.5 text-2xl font-black leading-tight text-white sm:text-3xl"
      >
        ${username !== null
          ? html`<span id="account-username" class="min-w-0 truncate"
              >${username}</span
            >`
          : nothing}
        ${staffBadge(staffRole, "w-5 h-5 shrink-0")}
        ${verified ? verifiedBadge("w-6 h-6 shrink-0") : nothing}
      </div>
      ${verified || staffRole !== undefined
        ? html`<div class="order-3 mt-1 flex flex-wrap items-center gap-2">
            ${verified
              ? html`<span
                  id="account-verified-chip"
                  class="${chip} border-white/25 bg-black text-white"
                >
                  ${verifiedBadge("w-3.5 h-3.5", "text-df-red-bright", null)}
                  ${translateText("account_modal.verified_label")}
                </span>`
              : nothing}
            ${staffRole !== undefined
              ? html`<span
                  id="account-staff-chip"
                  data-staff-role=${staffRole}
                  class="${chip} ${staffChip}"
                >
                  ${staffBadge(staffRole, "w-3.5 h-3.5", null)}
                  ${staffRoleLabel(staffRole)}
                </span>`
              : nothing}
          </div>`
        : nothing}
      ${verified && username === null
        ? html`<div
            id="account-verified-needs-username"
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

function renderIdentity(props: AccountProfileHeaderProps): TemplateResult {
  const { player, identity } = props;
  const handle = linkedHandle(identity);
  const status = renderStatus(props);
  const clan = player.clans?.[0]?.tag ?? null;
  const currency = player.currency;
  return html`<div
    data-account-identity
    class="flex flex-col gap-6 p-5 sm:flex-row sm:items-start sm:justify-between sm:gap-8 sm:p-7"
    style=${GRID_STYLE}
  >
    <div class="flex min-w-0 items-start gap-4 sm:gap-6">
      ${renderAvatar(props)}
      <div class="flex min-w-0 flex-1 flex-col gap-1">
        ${clan === null
          ? nothing
          : html`<span
              data-account-clan
              class="order-0 max-w-full truncate font-display text-xs font-bold uppercase tracking-[0.2em] text-df-red-bright"
              >[${clan}]</span
            >`}
        ${status === nothing
          ? html`<div
              data-account-fallback-name
              class="order-1 truncate text-2xl font-black text-white"
            >
              ${handle?.text ?? ""}
            </div>`
          : status}
        ${handle === null || status === nothing
          ? nothing
          : html`<div
              data-account-handle
              data-account-handle-kind=${handle.kind}
              class="order-2 truncate text-base text-white/55"
              title=${handle.text}
            >
              ${handle.text}
            </div>`}
      </div>
    </div>
    ${currency
      ? html`<div
          data-account-credits
          class="flex shrink-0 flex-col gap-2 sm:items-end"
        >
          <span
            class="font-display text-xs font-bold uppercase tracking-[0.22em] text-white/50"
            >${translateText("account_modal.credits_label")}</span
          >
          <currency-display
            large
            .hard=${currency.hard}
            .soft=${currency.soft}
          ></currency-display>
        </div>`
      : nothing}
  </div>`;
}

function renderProgression(
  props: AccountProfileHeaderProps,
): TemplateResult | typeof nothing {
  const progress = props.player.progress;
  if (!progress) return nothing;
  const prestige = clampPrestige(progress.prestige);
  const fraction = progress.legend
    ? 1
    : levelFraction(progress.xpInLevel, progress.xpForNext);
  const milestone = props.progression?.nextMilestone ?? null;
  const xpText = xpProgressText(
    progress.xpInLevel,
    progress.legend ? 0 : progress.xpForNext,
  );
  const showEmblem = progress.legend || prestige > 0;
  return html`<div
    data-account-progression
    class="flex flex-col gap-3 border-t border-white/10 p-5 sm:p-7"
  >
    <div class="flex min-w-0 items-center gap-3">
      ${showEmblem
        ? html`<level-badge
            data-account-emblem
            .level=${progress.level}
            .prestige=${progress.prestige}
            .legend=${progress.legend}
            .size=${32}
          ></level-badge>`
        : nothing}
      <div
        data-account-level-line
        class="min-w-0 break-words font-display text-lg font-bold uppercase leading-snug tracking-[0.16em] text-white sm:text-xl"
      >
        ${progress.legend
          ? translateText("progression.legend")
          : translateText("progression.level", { level: progress.level })}
        <span class="text-white/30">·</span>
        <span data-account-rank class="whitespace-nowrap"
          >${translateText(rankLabelKey(progress.level))}</span
        >
        ${prestige > 0
          ? html`<span class="text-white/30">·</span>
              <span
                data-account-prestige
                class="whitespace-nowrap text-yellow-300"
                >${translateText("progression.prestige", { prestige })}</span
              >`
          : nothing}
      </div>
    </div>
    <div
      class="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1 text-sm"
    >
      ${milestone === null
        ? html`<span></span>`
        : html`<span data-account-milestone class="min-w-0 text-white/55"
            >${translateText("progression.next_milestone", {
              level: milestone.level,
              credits: formatXp(milestone.credits),
            })}</span
          >`}
      <span
        data-account-xp-text
        class="shrink-0 font-bold tabular-nums text-white"
        >${xpText}</span
      >
    </div>
    <div class="mt-1">
      ${segmentedXpBar(fraction * 100, { valueText: xpText })}
    </div>
    ${props.prestigeable && progress.canPrestige
      ? html`<div
          class="mt-2 flex flex-wrap items-center justify-between gap-3 border border-yellow-300/30 bg-yellow-300/5 px-4 py-3"
        >
          <span class="text-sm text-yellow-200"
            >${translateText("prestige.ready")}</span
          >
          <button
            type="button"
            data-account-prestige-button
            class="df-btn"
            @click=${props.onPrestige}
          >
            ${translateText("prestige.button")}
          </button>
        </div>`
      : nothing}
  </div>`;
}

function renderTitleRow(
  props: AccountProfileHeaderProps,
): TemplateResult | typeof nothing {
  const progress = props.player.progress;
  if (!progress) return nothing;
  const titles = props.progression?.titles ?? [];
  const selected = props.progression
    ? props.progression.selectedTitle
    : (progress.title ?? null);
  return html`<div
    data-account-title-row
    class="flex flex-col gap-3 border-t border-white/10 p-5 sm:flex-row sm:items-center sm:justify-between sm:gap-6 sm:p-7"
  >
    <div class="min-w-0">
      <div class="text-base font-bold text-white">
        ${translateText("progression.display_title")}
      </div>
      <div class="text-sm text-white/50">
        ${translateText("progression.display_title_hint")}
      </div>
    </div>
    <select
      data-account-title
      aria-label=${translateText("progression.display_title")}
      class="df-input w-full shrink-0 sm:w-64"
      ?disabled=${props.savingTitle === true || props.progression === null}
      @change=${(e: Event) =>
        props.onTitleChange((e.target as HTMLSelectElement).value || null)}
    >
      <option value="" ?selected=${selected === null}>
        ${translateText("progression.title_none")}
      </option>
      ${titles.map(
        (id) =>
          html`<option value=${id} ?selected=${selected === id}>
            ${titleText(id, translateText)}
          </option>`,
      )}
    </select>
  </div>`;
}

export function accountProfileHeader(
  props: AccountProfileHeaderProps,
): TemplateResult {
  return html`<section
    data-account-header
    class="overflow-hidden rounded-xl border border-white/10 bg-df-panel"
  >
    ${renderIdentity(props)} ${renderProgression(props)}
    ${renderTitleRow(props)}
  </section>`;
}
