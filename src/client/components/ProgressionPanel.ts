import type { ProgressionMe } from "@openfront/shared/ApiSchemas";
import { html, LitElement, nothing, TemplateResult } from "lit";
import { customElement, state } from "lit/decorators.js";
import { challengeLabelKey, rankLabelKey, titleText } from "../Progression";
import { fetchProgressionMe, putDisplayTitle } from "../ProgressionApi";
import { translateText } from "../Utils";
import "./CreditsIcon";
import { formatXp, xpBar } from "./XpBar";

/**
 * The account page's progression section: the title shown beside your name,
 * the next milestone, the running season, today's and this week's challenges,
 * and your recent XP. Everything comes from GET /progression/me; this element
 * only draws it (and sends the title choice).
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
  daily_challenge: "progression.history_daily_challenge",
  weekly_challenge: "progression.history_weekly_challenge",
  admin_grant: "progression.history_admin_grant",
  admin_revoke: "progression.history_admin_revoke",
  admin_set: "progression.history_admin_set",
};

/** The line's label: a reduced match says why ("Private Match"), never an internal name. */
function historyKey(entry: { source: string; detail?: string | null }): string {
  const specific =
    entry.detail == null
      ? undefined
      : SOURCE_KEYS[`${entry.source}_${entry.detail}`];
  return specific ?? SOURCE_KEYS[entry.source] ?? "progression.history_other";
}

@customElement("progression-panel")
export class ProgressionPanel extends LitElement {
  @state() private me: ProgressionMe | null = null;
  @state() private failed = false;
  @state() private saving = false;

  // Replaceable for tests.
  load: () => Promise<ProgressionMe | false> = fetchProgressionMe;
  saveTitle: (title: string | null) => Promise<boolean> = putDisplayTitle;
  now: () => number = Date.now;

  createRenderRoot() {
    return this;
  }

  connectedCallback(): void {
    super.connectedCallback();
    void this.refresh();
  }

  /** Reads the section again (after a claim, a prestige or a game). */
  public async refresh(): Promise<void> {
    const me = await this.load();
    this.failed = me === false;
    if (me !== false) this.me = me;
  }

  private async chooseTitle(value: string): Promise<void> {
    if (this.saving) return;
    this.saving = true;
    try {
      if (await this.saveTitle(value === "" ? null : value)) {
        await this.refresh();
        this.dispatchEvent(
          new CustomEvent("title-changed", { bubbles: true, composed: true }),
        );
      }
    } finally {
      this.saving = false;
    }
  }

  private openSeasonTrack = (): void => {
    window.location.hash = "modal=season";
  };

  render(): TemplateResult | typeof nothing {
    const me = this.me;
    if (me === null) return nothing;
    return html`<section
      data-progression-panel
      class="flex flex-col gap-4 rounded-xl border border-white/10 bg-white/5 p-5"
    >
      ${this.renderIdentity(me)} ${this.renderSeason(me)}
      ${this.renderChallenges(me)} ${this.renderHistory(me)}
    </section>`;
  }

  private heading(key: string): TemplateResult {
    return html`<h3
      class="m-0 text-xs font-bold uppercase tracking-widest text-white/40"
    >
      ${translateText(key)}
    </h3>`;
  }

  private renderIdentity(me: ProgressionMe): TemplateResult {
    const milestone = me.nextMilestone;
    return html`<div data-progression-identity class="flex flex-col gap-2">
      <div class="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div class="text-lg font-black uppercase tracking-wider text-white">
            <span data-progression-rank
              >${translateText(rankLabelKey(me.progress.level))}</span
            >
          </div>
          ${milestone === null
            ? nothing
            : html`<div
                data-progression-milestone
                class="text-xs text-white/60"
              >
                ${translateText("progression.next_milestone", {
                  level: milestone.level,
                  credits: formatXp(milestone.credits),
                })}
              </div>`}
        </div>
        <label class="flex items-center gap-2 text-xs text-white/60">
          <span>${translateText("progression.title_label")}</span>
          <select
            data-progression-title
            class="df-input text-sm"
            ?disabled=${this.saving}
            @change=${(e: Event) =>
              void this.chooseTitle((e.target as HTMLSelectElement).value)}
          >
            <option value="" ?selected=${me.selectedTitle === null}>
              ${translateText("progression.title_none")}
            </option>
            ${me.titles.map(
              (id) =>
                html`<option value=${id} ?selected=${me.selectedTitle === id}>
                  ${titleText(id, translateText)}
                </option>`,
            )}
          </select>
        </label>
      </div>
    </div>`;
  }

  private renderSeason(me: ProgressionMe): TemplateResult | typeof nothing {
    const season = me.season;
    if (season === null) return nothing;
    const maxed = season.level >= season.maxLevel;
    const into = season.xp % season.xpPerLevel;
    const percent = maxed ? 100 : (into / season.xpPerLevel) * 100;
    const unclaimed = me.seasonTrack.filter((t) => t.rewardId !== null).length;
    return html`<div data-progression-season class="flex flex-col gap-2">
      ${this.heading("progression.season_heading")}
      <div class="flex flex-wrap items-center justify-between gap-2">
        <div class="text-sm font-bold text-white">
          ${translateText("progression.season_summary", {
            name: season.name,
            level: season.level,
          })}
          <span class="font-normal text-white/60"
            >· ${formatXp(season.xp)} XP</span
          >
        </div>
        <div class="text-xs text-white/50">
          ${translateText("progression.season_ends_in", {
            time: compactDuration(Date.parse(season.endsAt) - this.now()),
          })}
        </div>
      </div>
      ${xpBar(percent, { heightClass: "h-2" })}
      <div class="flex items-center justify-between gap-2">
        <span class="text-xs text-white/50"
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
    </div>`;
  }

  private renderChallenges(me: ProgressionMe): TemplateResult {
    const periods = [
      ["daily", me.challenges.daily, "progression.challenges_daily"],
      ["weekly", me.challenges.weekly, "progression.challenges_weekly"],
    ] as const;
    return html`<div data-progression-challenges class="flex flex-col gap-4">
      ${periods.map(
        ([period, data, key]) =>
          html`<div
            data-progression-period=${period}
            class="flex flex-col gap-2"
          >
            <div class="flex items-center justify-between">
              ${this.heading(key)}
              <span class="text-xs text-white/40"
                >${translateText("progression.resets_in", {
                  time: compactDuration(Date.parse(data.resetsAt) - this.now()),
                })}</span
              >
            </div>
            ${data.items.map((c) => {
              const percent = Math.min(100, (c.progress / c.target) * 100);
              return html`<div
                data-progression-challenge=${c.id}
                data-complete=${c.completed ? "true" : nothing}
                class="flex flex-col gap-1 rounded-lg border border-white/10 bg-black/20 px-3 py-2"
              >
                <div class="flex items-center justify-between gap-3 text-sm">
                  <span
                    class="min-w-0 truncate ${c.completed
                      ? "text-white/50 line-through"
                      : "text-white"}"
                    >${translateText(challengeLabelKey(c.id))}</span
                  >
                  <span class="shrink-0 text-xs font-bold text-yellow-300">
                    ${translateText("progression.xp_total", {
                      xp: formatXp(c.xp),
                    })}${c.credits > 0
                      ? html` <span class="text-white/60"
                          >+${formatXp(c.credits)}
                          ${translateText("progression.credits")}</span
                        >`
                      : nothing}
                  </span>
                </div>
                ${xpBar(percent, {
                  heightClass: "h-1.5",
                  valueText: `${formatXp(c.progress)} / ${formatXp(c.target)}`,
                })}
                <div class="text-[11px] text-white/40">
                  ${c.completed
                    ? translateText("progression.challenge_completed")
                    : `${formatXp(c.progress)} / ${formatXp(c.target)}`}
                </div>
              </div>`;
            })}
          </div>`,
      )}
    </div>`;
  }

  private renderHistory(me: ProgressionMe): TemplateResult | typeof nothing {
    if (me.history.length === 0) return nothing;
    return html`<details data-progression-history>
      <summary
        class="cursor-pointer text-xs font-bold uppercase tracking-widest text-white/40"
      >
        ${translateText("progression.history_heading")}
      </summary>
      <ul class="m-0 mt-2 flex list-none flex-col gap-1 p-0 text-sm">
        ${me.history.map(
          (h) =>
            html`<li class="flex items-center justify-between gap-3">
              <span class="text-white/70">${translateText(historyKey(h))}</span>
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
