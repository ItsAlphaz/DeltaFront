import type { StaffRoleWire } from "@openfront/shared/WireSchemas";
import { html, nothing, TemplateResult } from "lit";
import { customElement, property } from "lit/decorators.js";
import {
  clampPrestige,
  levelFraction,
  rankLabelKey,
  titleText,
} from "../Progression";
import { translateText } from "../Utils";
import "./LevelBadge";
import { levelBadgeAccent } from "./LevelBadge";
import { PLAYED_OPEN_KEYS_KEPT, ProfileHeaderBase } from "./ProfileHeaderBase";
import {
  initialOf,
  PH_CARD_CLASS,
  phAside,
  phAvatar,
  phClan,
  phIdentityBand,
  phLifetimeFigure,
  phPrestigeStrip,
  phProgressionBand,
  phStatus,
  phTitle,
} from "./ProfileHeaderView";
import { formatXp, xpProgressText } from "./XpBar";

// A player's level side, at a glance. `full` heads a Stats tab (yours and
// public profiles): the same header your own Account page has, drawn by the
// same pieces (ProfileHeaderView) and opened by the same flourish
// (ProfileHeaderBase): the avatar with its level chip, the clan tag, the name
// with its badges and chips, the title they chose to show, their lifetime XP,
// then LEVEL · RANK, the season and the segmented XP bar. Games and wins are
// left to the stats right under it, so nothing shows twice. `compact` is one
// row, for the CrazyGames account page, and plays no flourish.

export { PLAYED_OPEN_KEYS_KEPT };

export interface ProfileCardProgress {
  prestige: number;
  level: number;
  legend: boolean;
  lifetimeXp: number;
  // Missing when the source doesn't say (an older public endpoint): the XP
  // bar is left out then.
  xpInLevel?: number;
  xpForNext?: number;
  // At level 100 with ranks left: the Prestige button shows on your own card.
  canPrestige?: boolean;
  // The title the player chose to show (a title id, see Progression.titleText).
  title?: string | null;
  // The running season: where the player stands in it. Left out between seasons.
  season?: { name: string; level: number; xp: number } | null;
}

// Segments the compact XP bar is drawn in.
const BAR_SEGMENTS = 10;

@customElement("profile-card")
export class ProfileCard extends ProfileHeaderBase {
  @property({ type: String }) variant: "full" | "compact" = "full";
  @property({ type: String }) username = "";
  @property({ attribute: false }) clanTag: string | null = null;
  // Null when progression is off: nothing renders.
  @property({ attribute: false }) progress: ProfileCardProgress | null = null;
  // The account's own standing: a verified check and a staff role are shown
  // as badges beside the name and as chips under it, as on your own page.
  @property({ type: Boolean }) verified = false;
  @property({ attribute: false }) staffRole: StaffRoleWire | undefined =
    undefined;
  // Your own card: offers Prestige when you can. Emits `prestige-request`.
  @property({ type: Boolean }) prestigeable = false;

  private get compact(): boolean {
    return this.variant === "compact";
  }

  protected flourishWanted(): boolean {
    return !this.compact && this.progress !== null;
  }

  protected isLegend(): boolean {
    return !this.compact && this.progress?.legend === true;
  }

  private canPrestige(progress: ProfileCardProgress): boolean {
    return this.prestigeable && progress.canPrestige === true;
  }

  private requestPrestige = (): void => {
    this.dispatchEvent(
      new CustomEvent("prestige-request", { bubbles: true, composed: true }),
    );
  };

  render() {
    const progress = this.progress;
    if (progress === null) return nothing;
    return this.compact
      ? this.renderCompact(progress)
      : this.renderFull(progress);
  }

  // ------------------------------------------------------------------ full

  private renderFull(progress: ProfileCardProgress): TemplateResult {
    const level = {
      level: progress.level,
      prestige: progress.prestige,
      legend: progress.legend,
    };
    const status = phStatus({
      username: this.username,
      verified: this.verified,
      staffRole: this.staffRole,
      ids: false,
      askForUsername: false,
    });
    return html`<section
      data-ph-root
      data-profile-card="full"
      ?data-profile-legend=${progress.legend}
      class="${PH_CARD_CLASS} ${this.cardClasses()}"
    >
      ${this.renderBackdrop()}
      ${phIdentityBand({
        avatar: phAvatar({
          url: null,
          initial: initialOf(this.username),
          level,
        }),
        identity: html`${phClan(this.clanTag)}${status}${phTitle(
          progress.title ?? null,
        )}`,
        aside: phAside(
          "lifetime",
          translateText("profile_card.lifetime_xp"),
          phLifetimeFigure(progress.lifetimeXp),
        ),
      })}
      ${phProgressionBand({
        level,
        xpInLevel: progress.xpInLevel,
        xpForNext: progress.xpForNext,
        left: this.renderUnderLevel(progress),
        after: this.canPrestige(progress)
          ? phPrestigeStrip(this.requestPrestige)
          : nothing,
      })}
    </section>`;
  }

  // What sits under the LEVEL line on the left: how far to the next level,
  // and the running season when there is one.
  private renderUnderLevel(
    progress: ProfileCardProgress,
  ): TemplateResult | typeof nothing {
    const { xpInLevel, xpForNext } = progress;
    const toNext =
      progress.legend || xpInLevel === undefined || xpForNext === undefined
        ? null
        : Math.max(0, xpForNext - xpInLevel);
    const season = progress.season ?? null;
    if (toNext === null && season === null) return nothing;
    return html`<div class="flex flex-col gap-0.5">
      ${toNext === null
        ? nothing
        : html`<span data-ph-to-next
            >${translateText("profile_card.to_next", {
              xp: formatXp(toNext),
              level: progress.level + 1,
            })}</span
          >`}
      ${season === null
        ? nothing
        : html`<span data-ph-season class="normal-case tracking-normal"
            >${translateText("progression.profile_season", {
              name: season.name,
              level: season.level,
              xp: formatXp(season.xp),
            })}</span
          >`}
    </div>`;
  }

  // --------------------------------------------------------------- compact

  // The military rank and the chosen title: "Captain · Veteran".
  private renderCompactRankLine(progress: ProfileCardProgress): TemplateResult {
    const title =
      progress.title === undefined || progress.title === null
        ? null
        : titleText(progress.title, translateText);
    return html`<div
      data-profile-rank-line
      class="mt-0.5 text-xs font-bold uppercase tracking-wider text-white/70"
    >
      <span data-profile-rank
        >${translateText(rankLabelKey(progress.level))}</span
      >${title === null
        ? nothing
        : html` <span class="text-white/30">·</span>
            <span data-profile-title class="text-yellow-300">${title}</span>`}
    </div>`;
  }

  // "PRESTIGE 3 · LEVEL 47", "LEVEL 47", or "LEGEND · PRESTIGE 10".
  private renderCompactLevelCore(
    progress: ProfileCardProgress,
  ): TemplateResult {
    const size = "text-sm tracking-wider";
    const prestige = clampPrestige(progress.prestige);
    if (progress.legend) {
      return html`<div
        data-profile-level-line
        class="bg-gradient-to-r from-yellow-300 via-fuchsia-300 to-yellow-300 bg-clip-text font-black uppercase text-transparent ${size}"
      >
        ${translateText("progression.legend")}
        <span class="text-white/40">·</span>
        ${translateText("progression.prestige", { prestige })}
      </div>`;
    }
    return html`<div
      data-profile-level-line
      class="font-black uppercase text-white ${size}"
    >
      ${prestige > 0
        ? html`<span class="text-yellow-300"
              >${translateText("progression.prestige", { prestige })}</span
            >
            <span class="text-white/30">·</span>`
        : nothing}
      ${translateText("progression.level", { level: progress.level })}
    </div>`;
  }

  private renderCompactBar(fill: number): TemplateResult {
    return html`<div
      data-xp-bar
      class="relative h-2 w-full overflow-hidden rounded-sm bg-white/15"
      role="progressbar"
      aria-valuemin="0"
      aria-valuemax="100"
      aria-valuenow=${Math.round(fill * 100)}
    >
      <div
        data-xp-bar-fill
        class="h-full bg-yellow-400 shadow-[0_0_10px_rgba(250,204,21,0.6)]"
        style="width: ${fill * 100}%"
      ></div>
      ${Array.from(
        { length: BAR_SEGMENTS - 1 },
        (_, i) =>
          html`<span
            aria-hidden="true"
            class="absolute top-0 h-full w-[2px] -translate-x-1/2 bg-[#0b1424]"
            style="left: ${((i + 1) * 100) / BAR_SEGMENTS}%"
          ></span>`,
      )}
    </div>`;
  }

  // The compact card's progress: the XP figure over the bar, as one block of
  // a fixed width, so the bar doesn't stretch across the whole card.
  private renderCompactXp(
    progress: ProfileCardProgress,
  ): TemplateResult | typeof nothing {
    const { xpInLevel, xpForNext } = progress;
    if (xpInLevel === undefined || xpForNext === undefined) return nothing;
    const fill = progress.legend ? 1 : levelFraction(xpInLevel, xpForNext);
    return html`<div class="w-full shrink-0 sm:w-64">
      <div
        data-profile-xp
        class="mb-1.5 text-right text-xs font-semibold tabular-nums text-white/60"
      >
        ${xpProgressText(xpInLevel, progress.legend ? 0 : xpForNext)}
      </div>
      ${this.renderCompactBar(fill)}
    </div>`;
  }

  private renderCompact(progress: ProfileCardProgress): TemplateResult {
    const accent = levelBadgeAccent(progress.level, progress.legend);
    const clan =
      this.clanTag === null
        ? nothing
        : html`<span
            data-profile-clan
            class="shrink-0 text-sm font-black tracking-wider text-df-red-bright"
            >[${this.clanTag}]</span
          >`;
    const name = html`<span
      data-profile-name
      class="truncate text-2xl font-black leading-tight"
      title=${this.username}
      >${this.username}</span
    >`;
    // One row: the badge and who you are on the left, the level's progress
    // in a block of its own on the right (under them on a phone).
    return html`<section
      data-profile-card="compact"
      class="relative overflow-hidden rounded-xl border border-white/10 bg-gradient-to-br from-[#0b1424] to-[#132644] px-5 py-4 text-white"
    >
      <div
        class="relative flex flex-col gap-4 sm:flex-row sm:items-center sm:gap-6"
      >
        <div class="flex min-w-0 flex-1 items-center gap-4">
          <div class="relative grid shrink-0 place-items-center">
            <div
              aria-hidden="true"
              class="absolute -inset-4 rounded-full"
              style="background: radial-gradient(circle, ${accent}55 0%, transparent 70%)"
            ></div>
            <level-badge
              class="relative"
              .level=${progress.level}
              .prestige=${progress.prestige}
              .legend=${progress.legend}
              .size=${64}
            ></level-badge>
          </div>
          <div class="min-w-0">
            <div class="flex min-w-0 items-baseline gap-2">${clan} ${name}</div>
            <div class="mt-0.5">
              ${this.renderCompactLevelCore(progress)}
              ${this.renderCompactRankLine(progress)}
            </div>
          </div>
        </div>
        ${this.canPrestige(progress)
          ? html`<div class="flex shrink-0 justify-end">
              <button
                type="button"
                data-profile-prestige
                class="profile-prestige-button rounded-xl border border-yellow-300/70 bg-gradient-to-b from-yellow-300 to-amber-500 px-6 py-2.5 text-sm font-black uppercase tracking-widest text-zinc-900 transition-transform hover:-translate-y-0.5"
                @click=${this.requestPrestige}
              >
                ${translateText("prestige.button")}
              </button>
            </div>`
          : this.renderCompactXp(progress)}
      </div>
    </section>`;
  }
}
