import type { ProgressionMe } from "@openfront/shared/ApiSchemas";
import { html, LitElement, nothing, svg, TemplateResult } from "lit";
import { customElement, state } from "lit/decorators.js";
import { challengeLabelKey, difficultyNameKey } from "../Progression";
import { fetchProgressionMe } from "../ProgressionApi";
import { translateText } from "../Utils";
import "./CreditsIcon";
import { formatXp, xpBar } from "./XpBar";

/**
 * The account page's progression cards under the profile header: today's and
 * this week's challenges (one card, with how many are done and when each set
 * resets), the running season, and your recent XP. Everything comes from
 * GET /progression/me; this element only draws it.
 *
 * It announces what it read (`progression-loaded`, the ProgressionMe as
 * detail) so the page can give the header the titles to choose from and the
 * next milestone, which are drawn there.
 */

/** "5h 20m", "2d 3h", "12m": how long until a challenge period resets. */
export function compactDuration(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  const days = Math.floor(minutes / 1_440);
  const hours = Math.floor((minutes % 1_440) / 60);
  const mins = minutes % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}

// Spelled out in full so the translation checks can see every key.
const SOURCE_KEYS: Record<string, string> = {
  match: "progression.history_match",
  match_private_game: "progression.history_match_private",
  match_unlisted_game: "progression.history_match_unlisted",
  match_public_too_few_humans: "progression.history_match_low_pop",
  match_short_game: "progression.history_match_short",
  match_admin_modified: "progression.history_match_modified",
  match_eliminated: "progression.history_match_eliminated",
  match_solo: "progression.history_match_solo",
  daily_challenge: "progression.history_daily_challenge",
  weekly_challenge: "progression.history_weekly_challenge",
  admin_grant: "progression.history_admin_grant",
  admin_revoke: "progression.history_admin_revoke",
  admin_set: "progression.history_admin_set",
};

/** "Hard", in the player's language; a difficulty this client has no name for is shown as it came. */
function soloDifficulty(difficulty: string): string {
  const key = difficultyNameKey(difficulty);
  return key === null ? difficulty : translateText(key);
}

/** The line's label: a reduced match says why ("Private Match"), never an internal name. */
function historyKey(entry: { source: string; detail?: string | null }): string {
  const specific =
    entry.detail === undefined || entry.detail === null
      ? undefined
      : SOURCE_KEYS[`${entry.source}_${entry.detail}`];
  return specific ?? SOURCE_KEYS[entry.source] ?? "progression.history_other";
}

const CARD = "rounded-xl border border-white/10 bg-df-panel p-5 sm:p-7";
const CARD_HEADING =
  "m-0 font-display text-lg font-bold uppercase tracking-[0.25em] text-white";

const CLOCK = svg`<svg
  class="h-4 w-4 shrink-0"
  viewBox="0 0 24 24"
  fill="none"
  stroke="currentColor"
  stroke-width="2"
  stroke-linecap="round"
  aria-hidden="true"
>
  <circle cx="12" cy="12" r="9"></circle>
  <path d="M12 7v5l3 2"></path>
</svg>`;

const CHECK = svg`<svg
  class="h-3.5 w-3.5 shrink-0"
  viewBox="0 0 24 24"
  fill="none"
  stroke="currentColor"
  stroke-width="3"
  stroke-linecap="round"
  stroke-linejoin="round"
  aria-hidden="true"
>
  <path d="M5 12.5l4.5 4.5L19 7.5"></path>
</svg>`;

@customElement("progression-panel")
export class ProgressionPanel extends LitElement {
  @state() private me: ProgressionMe | null = null;
  @state() private failed = false;

  // Replaceable for tests.
  load: () => Promise<ProgressionMe | false> = fetchProgressionMe;
  now: () => number = Date.now;

  createRenderRoot() {
    return this;
  }

  connectedCallback(): void {
    super.connectedCallback();
    void this.refresh();
  }

  /** Reads the section again (after a claim, a prestige, a title or a game). */
  public async refresh(): Promise<void> {
    const me = await this.load();
    this.failed = me === false;
    if (me !== false) {
      this.me = me;
      this.dispatchEvent(
        new CustomEvent<ProgressionMe>("progression-loaded", {
          detail: me,
          bubbles: true,
          composed: true,
        }),
      );
    }
  }

  private openSeasonTrack = (): void => {
    window.location.hash = "modal=season";
  };

  render(): TemplateResult | typeof nothing {
    const me = this.me;
    if (me === null) return nothing;
    return html`<div data-progression-panel class="flex flex-col gap-6">
      ${this.renderChallenges(me)} ${this.renderSeason(me)}
      ${this.renderHistory(me)}
    </div>`;
  }

  private renderSeason(me: ProgressionMe): TemplateResult | typeof nothing {
    const season = me.season;
    if (season === null) return nothing;
    const maxed = season.level >= season.maxLevel;
    const into = season.xp % season.xpPerLevel;
    const percent = maxed ? 100 : (into / season.xpPerLevel) * 100;
    const unclaimed = me.seasonTrack.filter((t) => t.rewardId !== null).length;
    return html`<section
      data-progression-season
      class="${CARD} df-enter flex flex-col gap-4"
      style="--i: 2"
    >
      <div
        class="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1"
      >
        <h3 class="${CARD_HEADING}">
          ${translateText("progression.season_heading")}
        </h3>
        <span class="inline-flex items-center gap-1.5 text-sm text-white/50">
          ${CLOCK}
          ${translateText("progression.season_ends_in", {
            time: compactDuration(Date.parse(season.endsAt) - this.now()),
          })}
        </span>
      </div>
      <div class="text-base font-bold text-white">
        ${translateText("progression.season_summary", {
          name: season.name,
          level: season.level,
        })}
        <span class="font-normal text-white/60"
          >· ${formatXp(season.xp)} XP</span
        >
      </div>
      ${xpBar(percent, { heightClass: "h-2" })}
      <div class="flex flex-wrap items-center justify-between gap-3">
        <span class="text-sm text-white/55"
          >${maxed
            ? translateText("progression.max_level")
            : translateText("progression.xp_progress", {
                current: formatXp(into),
                next: formatXp(season.xpPerLevel),
              })}</span
        >
        <button
          type="button"
          data-progression-open-track
          class="df-btn text-xs"
          @click=${this.openSeasonTrack}
        >
          ${translateText("progression.season_track")}${unclaimed > 0
            ? html` <span
                data-progression-track-badge
                class="ml-1 rounded-full bg-df-red px-1.5 text-[10px] font-bold"
                >${unclaimed}</span
              >`
            : nothing}
        </button>
      </div>
    </section>`;
  }

  // One row: the name and "2 / 3" over a thin bar, and the reward in a column
  // of its own behind a short rule. The column keeps its width on a phone (the
  // name wraps instead), so "+1,500 XP" and the Credits line never collide
  // with the progress.
  private renderChallenge(
    c: ProgressionMe["challenges"]["daily"]["items"][number],
    order: number,
  ): TemplateResult {
    const percent = Math.min(100, (c.progress / c.target) * 100);
    const count = `${formatXp(Math.min(c.progress, c.target))} / ${formatXp(c.target)}`;
    return html`<div
      data-progression-challenge=${c.id}
      data-complete=${c.completed ? "true" : nothing}
      class="df-enter flex items-stretch border border-white/10 bg-white/[0.04]"
      style="--i: ${2 + order}"
    >
      <div class="flex min-w-0 flex-1 flex-col gap-3 px-4 py-4 sm:px-5">
        <div class="flex items-baseline justify-between gap-3">
          <span
            class="min-w-0 break-words text-base font-medium sm:text-lg ${c.completed
              ? "text-white/55"
              : "text-white"}"
            >${translateText(challengeLabelKey(c.id))}</span
          >
          <span
            data-progression-count
            class="inline-flex shrink-0 items-center gap-1 text-xs tabular-nums ${c.completed
              ? "font-bold text-green-400"
              : "text-white/55"}"
            >${c.completed
              ? html`${CHECK}${translateText("progression.challenge_completed")}`
              : count}</span
          >
        </div>
        ${xpBar(percent, {
          heightClass: "h-1.5",
          valueText: count,
        })}
      </div>
      <div
        data-progression-reward
        class="my-4 flex w-28 shrink-0 flex-col items-center justify-center gap-1 border-l border-white/10 px-3 sm:w-36"
      >
        <span class="whitespace-nowrap text-base font-extrabold text-yellow-300"
          >${translateText("progression.xp_total", {
            xp: formatXp(c.xp),
          })}</span
        >
        ${c.credits > 0
          ? html`<span
              data-progression-credits
              class="inline-flex items-center gap-1.5 whitespace-nowrap text-sm text-white/60"
              title=${translateText("progression.credits")}
            >
              <credits-icon .size=${14}></credits-icon>
              ${translateText("progression.reward_credits", {
                credits: formatXp(c.credits),
              })}
            </span>`
          : nothing}
      </div>
    </div>`;
  }

  private renderChallenges(me: ProgressionMe): TemplateResult {
    const periods = [
      ["daily", me.challenges.daily, "progression.challenges_daily"],
      ["weekly", me.challenges.weekly, "progression.challenges_weekly"],
    ] as const;
    const all = [...me.challenges.daily.items, ...me.challenges.weekly.items];
    const done = all.filter((c) => c.completed).length;
    return html`<section
      data-progression-challenges
      class="${CARD} df-enter flex flex-col gap-6"
      style="--i: 1"
    >
      <div
        class="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1"
      >
        <h3 class="${CARD_HEADING}">
          ${translateText("progression.challenges_title")}
        </h3>
        <span data-progression-total class="text-sm text-white/55"
          >${translateText("progression.challenges_complete", {
            done,
            total: all.length,
          })}</span
        >
      </div>
      ${periods.map(
        ([period, data, key]) =>
          html`<div
            data-progression-period=${period}
            class="flex flex-col gap-3"
          >
            <div class="flex items-center justify-between gap-3">
              <h4
                class="m-0 text-xs font-bold uppercase tracking-[0.18em] text-white/55"
              >
                ${translateText(key)}
              </h4>
              <span
                data-progression-resets
                class="inline-flex items-center gap-1.5 text-sm text-white/50"
              >
                ${CLOCK}
                ${translateText("progression.resets_in", {
                  time: compactDuration(Date.parse(data.resetsAt) - this.now()),
                })}
              </span>
            </div>
            ${data.items.map((c, i) =>
              this.renderChallenge(c, i + (period === "weekly" ? 3 : 0)),
            )}
          </div>`,
      )}
    </section>`;
  }

  private renderHistory(me: ProgressionMe): TemplateResult | typeof nothing {
    if (me.history.length === 0) return nothing;
    return html`<details
      data-progression-history
      class="${CARD} df-enter"
      style="--i: 3"
    >
      <summary
        class="cursor-pointer font-display text-sm font-bold uppercase tracking-[0.25em] text-white/60"
      >
        ${translateText("progression.history_heading")}
      </summary>
      <ul class="m-0 mt-2 flex list-none flex-col gap-1 p-0 text-sm">
        ${me.history.map(
          (h) =>
            html`<li class="flex items-center justify-between gap-3">
              <span class="min-w-0 text-white/70"
                >${translateText(historyKey(h))}${h.solo === undefined
                  ? nothing
                  : html`<span
                      data-history-solo
                      class="block truncate text-xs text-white/45"
                      >${translateText("progression.history_solo_meta", {
                        difficulty: soloDifficulty(h.solo.difficulty),
                        tribes: h.solo.tribes,
                        nations: h.solo.nations,
                      })}</span
                    >`}</span
              >
              <span
                class="font-bold tabular-nums ${h.amount < 0
                  ? "text-sky-300"
                  : "text-yellow-300"}"
                >${translateText(
                  h.amount < 0
                    ? "progression.history_minus"
                    : "progression.history_plus",
                  { xp: formatXp(Math.abs(h.amount)) },
                )}</span
              >
            </li>`,
        )}
      </ul>
    </details>`;
  }
}
