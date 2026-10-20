import type { ProgressionTrack } from "@openfront/shared/ApiSchemas";
import { html, LitElement, nothing, svg, TemplateResult } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { claimReward, invalidateUserMe } from "../Api";
import { showInGameAlert } from "../InGameModal";
import { MAX_LEVEL, titleText } from "../Progression";
import { fetchProgressionTrack } from "../ProgressionApi";
import {
  centerScrollLeft,
  flareLabel,
  levelPercent,
  levelState,
  nextWinMilestone,
  rewardState,
  trackPercent,
  winMilestones,
} from "../ProgressionTrack";
import { prefersReducedMotion } from "../utilities/ReducedMotion";
import { translateText } from "../Utils";
import "./CreditsIcon";
import { claimOpening } from "./ProfileHeaderBase";
import { formatXp, xpProgressText } from "./XpBar";

/**
 * The account's Progression tab: the reward track (levels 1 to 100 of this
 * prestige run, what the milestone levels pay and whether each is claimed,
 * ready or locked), the prestige history and the lifetime-win milestones.
 *
 * Everything comes from GET /progression/track and is drawn as given: the
 * levels that pay are the server's milestone levels, so every other level is a
 * plain numbered node with no reward. A claim is the same
 * `POST /rewards/:id/claim` the rewards panel and the season track use; the
 * server pays once, and a repeat finds nothing. Own account only: reward ids
 * and claim state are private, so there is no read-only twin for another
 * player's profile (their public level and title are on their profile card).
 *
 * It announces a claim (`progression-claimed`) so the page can re-read the
 * Credits balance.
 */

const CARD = "rounded-xl border border-white/10 bg-df-panel p-5 sm:p-7";
const CARD_HEADING =
  "m-0 font-display text-lg font-bold uppercase tracking-[0.25em] text-white";

const LOCK = svg`<svg class="h-3.5 w-3.5 shrink-0" viewBox="0 0 24 24" fill="none"
  stroke="currentColor" stroke-width="2" stroke-linecap="round"
  stroke-linejoin="round" aria-hidden="true">
  <rect x="5" y="11" width="14" height="9" rx="2"></rect>
  <path d="M8 11V8a4 4 0 0 1 8 0v3"></path>
</svg>`;

const CHECK = svg`<svg class="h-3.5 w-3.5 shrink-0" viewBox="0 0 24 24" fill="none"
  stroke="currentColor" stroke-width="3" stroke-linecap="round"
  stroke-linejoin="round" aria-hidden="true">
  <path d="M5 12.5l4.5 4.5L19 7.5"></path>
</svg>`;

const CHEVRON = (direction: "left" | "right") => svg`<svg class="h-5 w-5"
  viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"
  stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
  <path d=${direction === "left" ? "M15 5l-7 7 7 7" : "M9 5l7 7-7 7"}></path>
</svg>`;

const DOT = html`<span
  class="inline-block h-2.5 w-2.5 rounded-full bg-amber-300"
  aria-hidden="true"
></span>`;

/** How far the arrows move the track: most of a screenful, so two levels stay in view. */
const PAGE_FRACTION = 0.8;

@customElement("progression-tab")
export class ProgressionTab extends LitElement {
  /** Names one opening of the page: the entrance plays once per opening, not on a tab switch. */
  @property({ type: String }) openKey?: string;

  @state() private track: ProgressionTrack | null = null;
  @state() private failed = false;
  @state() private claiming: string | null = null;
  @state() private popLevel: number | null = null;
  @state() private atStart = true;
  @state() private atEnd = false;
  // The bars and the marker draw at 0 for one frame and then ease to their
  // value; with reduced motion the transition is off, so it only sets the value.
  @state() private entered = false;

  // Replaceable for tests.
  load: () => Promise<ProgressionTrack | false> = fetchProgressionTrack;
  claim: (rewardId: string) => ReturnType<typeof claimReward> = (rewardId) =>
    claimReward(rewardId);

  private centered = false;
  private intro = false;

  createRenderRoot() {
    return this;
  }

  connectedCallback(): void {
    super.connectedCallback();
    this.intro = claimOpening(
      this.openKey === undefined
        ? undefined
        : `progression-tab-${this.openKey}`,
    );
    void this.refresh();
  }

  /** Reads the tab again (after a claim). */
  public async refresh(): Promise<void> {
    const track = await this.load();
    this.failed = track === false;
    if (track !== false) this.track = track;
  }

  protected updated(): void {
    const track = this.track;
    if (track === null) return;
    if (!this.entered) {
      requestAnimationFrame(() => {
        this.entered = true;
      });
    }
    if (!this.centered) {
      this.centered = true;
      this.centerOn(track.progress.level, false);
    }
  }

  private scroller(): HTMLElement | null {
    return this.querySelector<HTMLElement>("[data-track-scroller]");
  }

  /** Scrolls so the level's node is in the middle of the track. */
  private centerOn(level: number, smooth: boolean): void {
    const scroller = this.scroller();
    const node = scroller?.querySelector<HTMLElement>(
      `[data-track-level="${level}"]`,
    );
    if (!scroller || !node) return;
    const left = centerScrollLeft(
      node.offsetLeft,
      node.offsetWidth,
      scroller.clientWidth,
    );
    this.moveTrack(scroller, left, smooth);
    this.syncEdges();
  }

  private moveTrack(
    scroller: HTMLElement,
    left: number,
    smooth: boolean,
  ): void {
    if (smooth && !prefersReducedMotion() && scroller.scrollTo !== undefined) {
      scroller.scrollTo({ left, behavior: "smooth" });
    } else {
      scroller.scrollLeft = left;
    }
  }

  private page(direction: -1 | 1): void {
    const scroller = this.scroller();
    if (scroller === null) return;
    this.moveTrack(
      scroller,
      Math.max(
        0,
        scroller.scrollLeft + direction * scroller.clientWidth * PAGE_FRACTION,
      ),
      true,
    );
  }

  private syncEdges = (): void => {
    const scroller = this.scroller();
    if (scroller === null) return;
    this.atStart = scroller.scrollLeft <= 1;
    this.atEnd =
      scroller.scrollLeft + scroller.clientWidth >= scroller.scrollWidth - 1;
  };

  private async claimLevel(level: number, rewardId: string): Promise<void> {
    if (this.claiming !== null) return;
    this.claiming = rewardId;
    try {
      const result = await this.claim(rewardId);
      if (result === false) {
        await showInGameAlert(translateText("account_modal.claim_failed"));
        return;
      }
      // "not_found" is a claim made elsewhere (a double click, a second device):
      // the Credits were paid exactly once, so this just reads the track again.
      invalidateUserMe();
      if (result !== "not_found") this.popLevel = level;
      this.dispatchEvent(
        new CustomEvent("progression-claimed", {
          bubbles: true,
          composed: true,
        }),
      );
      await this.refresh();
    } finally {
      this.claiming = null;
    }
  }

  render(): TemplateResult | typeof nothing {
    if (this.failed && this.track === null) {
      return html`<p class="p-2 text-ui-muted" data-progression-failed>
        ${translateText("progression.load_failed")}
      </p>`;
    }
    const track = this.track;
    if (track === null) {
      return html`<p class="p-2 text-ui-muted" data-progression-loading>
        ${translateText("progression.loading")}
      </p>`;
    }
    return html`<div
      data-progression-tab
      class="flex flex-col gap-6 ${this.intro ? "account-intro" : ""}"
    >
      ${this.renderTrack(track)} ${this.renderPrestigeHistory(track)}
      ${this.renderMilestones(track)}
    </div>`;
  }

  // -- reward track ----------------------------------------------------------

  private renderTrack(track: ProgressionTrack): TemplateResult {
    const { progress } = track;
    const percent = this.entered ? trackPercent(progress) : 0;
    const marker = trackPercent(progress);
    return html`<section
      data-progression-section="track"
      class="${CARD} df-enter flex flex-col gap-5"
      style="--i: 0"
    >
      <h2 class=${CARD_HEADING}>${translateText("progression.track_title")}</h2>
      <div data-track-strip class="flex flex-col gap-2">
        <div class="relative h-5">
          <span
            data-track-you
            class="absolute top-0 whitespace-nowrap text-xs font-bold text-ui-gold"
            style="left: ${marker}%; transform: translateX(-${marker}%)"
            >${translateText("progression.track_you", {
              level: progress.level,
            })}</span
          >
          <span
            class="absolute right-0 top-0 text-xs font-bold text-ui-muted"
            style=${marker > 80 ? "display:none" : ""}
            >${translateText("progression.track_end", {
              max: MAX_LEVEL,
              prestige: progress.prestige + 1,
            })}</span
          >
        </div>
        <div
          data-track-bar
          class="relative h-2.5 rounded-full bg-white/10"
          role="progressbar"
          aria-label=${translateText("progression.xp_bar_label")}
          aria-valuemin="0"
          aria-valuemax="100"
          aria-valuenow=${Math.round(marker)}
        >
          <div
            data-track-fill
            class="h-full rounded-full bg-df-red transition-[width] duration-700 ease-out motion-reduce:transition-none"
            style="width: ${percent}%"
          ></div>
          ${track.levels.map(
            (entry) =>
              html`<span
                data-track-diamond=${entry.level}
                class="absolute top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rotate-45 border ${entry.unlocked
                  ? "border-df-red-bright bg-df-red"
                  : "border-white/30 bg-df-panel"}"
                style="left: ${levelPercent(entry.level)}%"
              ></span>`,
          )}
        </div>
        <div data-track-xp class="text-sm text-ui-muted">
          ${translateText("progression.level", { level: progress.level })}
          <span class="text-ui-muted"
            >·
            ${progress.xpForNext > 0
              ? xpProgressText(progress.xpInLevel, progress.xpForNext)
              : translateText("progression.max_level")}</span
          >
        </div>
      </div>
      <div class="flex items-start gap-2">
        <button
          type="button"
          data-track-prev
          class="df-btn df-btn-secondary mt-2 hidden h-12 w-10 shrink-0 items-center justify-center self-start p-0 sm:flex"
          aria-label=${translateText("progression.track_prev")}
          ?disabled=${this.atStart}
          @click=${() => this.page(-1)}
        >
          ${CHEVRON("left")}
        </button>
        <div
          data-track-scroller
          class="custom-scrollbar relative min-w-0 flex-1 touch-pan-x snap-x overflow-x-auto overscroll-x-contain pb-3"
          role="list"
          aria-label=${translateText("progression.track_aria")}
          @scroll=${this.syncEdges}
        >
          <div class="flex w-max items-start gap-0 py-2">
            ${track.levels.length === 0
              ? nothing
              : Array.from({ length: MAX_LEVEL }, (_, i) =>
                  this.renderNode(track, i + 1),
                )}
          </div>
        </div>
        <button
          type="button"
          data-track-next
          class="df-btn df-btn-secondary mt-2 hidden h-12 w-10 shrink-0 items-center justify-center self-start p-0 sm:flex"
          aria-label=${translateText("progression.track_next")}
          ?disabled=${this.atEnd}
          @click=${() => this.page(1)}
        >
          ${CHEVRON("right")}
        </button>
      </div>
      <ul
        data-track-legend
        class="m-0 flex list-none flex-wrap items-center gap-x-5 gap-y-1 p-0 text-sm text-ui-muted"
      >
        <li class="flex items-center gap-1.5 text-ui-success">
          ${CHECK}<span class="text-ui-muted"
            >${translateText("progression.claimed")}</span
          >
        </li>
        <li class="flex items-center gap-1.5">
          ${DOT}<span>${translateText("progression.track_ready")}</span>
        </li>
        <li class="flex items-center gap-1.5">
          ${LOCK}<span>${translateText("progression.locked")}</span>
        </li>
      </ul>
    </section>`;
  }

  private renderNode(track: ProgressionTrack, level: number): TemplateResult {
    const entry = track.levels.find((l) => l.level === level);
    const state = levelState(level, track.progress.level);
    const reward = entry === undefined ? null : rewardState(entry);
    const circle =
      state === "current"
        ? "h-12 w-12 border-df-red bg-df-red/25 text-white df-track-current"
        : state === "passed"
          ? "h-10 w-10 border-white/30 bg-white/10 text-white"
          : "h-10 w-10 border-white/10 bg-black/20 text-white/40";
    const accent =
      reward === "ready"
        ? "border-amber-300 text-amber-200 df-track-ready"
        : reward === "claimed"
          ? "border-emerald-400/70"
          : reward === "reached"
            ? "border-white/40"
            : reward === "locked"
              ? "border-df-red/50"
              : "";
    return html`<div
      role="listitem"
      data-track-level=${level}
      data-level-state=${state}
      data-reward-state=${reward ?? nothing}
      class="relative flex shrink-0 snap-center flex-col items-center gap-1.5 ${entry ===
      undefined
        ? "w-14"
        : "w-28"}"
    >
      <span
        class="absolute left-0 right-0 top-6 -z-0 h-px ${level <=
        track.progress.level
          ? "bg-df-red/60"
          : "bg-white/10"}"
        aria-hidden="true"
      ></span>
      <div class="relative z-10 flex h-12 items-center">
        <span
          data-track-circle
          class="relative z-10 flex items-center justify-center rounded-full border-2 text-sm font-bold ${circle} ${accent}"
          aria-current=${state === "current" ? "step" : nothing}
        >
          ${level}
          ${reward === "claimed"
            ? html`<span
                class="absolute -right-1 -top-1 rounded-full bg-emerald-500 p-0.5 text-black ${this
                  .popLevel === level
                  ? "df-claim-pop"
                  : ""}"
                >${CHECK}</span
              >`
            : nothing}
        </span>
      </div>
      ${state === "current"
        ? html`<span
            class="text-[10px] font-bold uppercase tracking-[0.1em] text-ui-accent-soft"
            >${translateText("progression.track_you_here")}</span
          >`
        : nothing}
      ${entry === undefined || reward === null
        ? nothing
        : this.renderReward(entry, reward)}
    </div>`;
  }

  private renderReward(
    entry: ProgressionTrack["levels"][number],
    state: ReturnType<typeof rewardState>,
  ): TemplateResult {
    return html`<div
      data-track-reward=${entry.level}
      data-state=${state}
      class="relative z-10 flex w-full flex-col items-center gap-1 rounded-lg border px-2 py-1.5 text-center ${state ===
      "ready"
        ? "border-amber-300/60 bg-amber-300/10"
        : state === "claimed"
          ? "border-emerald-400/30 bg-emerald-400/5"
          : "border-white/10 bg-black/20"} ${state === "locked"
        ? "opacity-70"
        : ""}"
    >
      <span
        data-track-credits
        class="flex items-center gap-1 text-sm font-bold text-ui-text"
      >
        <credits-icon .size=${16}></credits-icon>
        ${translateText("progression.reward_credits", {
          credits: formatXp(entry.credits),
        })}
      </span>
      ${entry.flare === null
        ? nothing
        : html`<span
            data-track-flare
            class="max-w-full truncate text-[11px] text-ui-muted"
            >${flareLabel(entry.flare)}</span
          >`}
      ${entry.title === null
        ? nothing
        : html`<span
            data-track-title
            class="max-w-full truncate text-[11px] text-ui-muted"
            >${translateText("progression.track_title_reward", {
              title: titleText(entry.title, translateText),
            })}</span
          >`}
      ${state === "ready" && entry.rewardId !== null
        ? html`<button
            type="button"
            data-track-claim=${entry.rewardId}
            class="df-btn df-btn-primary min-h-0! px-3! py-1.5! text-xs"
            ?disabled=${this.claiming !== null}
            @click=${() => void this.claimLevel(entry.level, entry.rewardId!)}
          >
            ${translateText("progression.claim")}
          </button>`
        : html`<span
            data-track-status
            class="flex items-center gap-1 text-[11px] ${state === "claimed"
              ? "text-emerald-400"
              : "text-white/50"}"
            >${state === "claimed"
              ? html`${CHECK}${translateText("progression.claimed")}`
              : state === "reached"
                ? translateText("progression.track_reached")
                : html`${LOCK}${translateText("progression.locked")}`}</span
          >`}
    </div>`;
  }

  // -- prestige history ------------------------------------------------------

  private renderPrestigeHistory(track: ProgressionTrack): TemplateResult {
    return html`<section
      data-progression-section="prestige"
      class="${CARD} df-enter flex flex-col gap-4"
      style="--i: 1"
    >
      <h2 class=${CARD_HEADING}>
        ${translateText("progression.prestige_history")}
      </h2>
      ${track.prestigeHistory.length === 0
        ? html`<p class="m-0 text-lg text-ui-muted" data-prestige-empty>
            ${translateText("progression.prestige_history_empty")}
          </p>`
        : html`<ul class="m-0 flex list-none flex-col gap-2 p-0">
            ${track.prestigeHistory.map(
              (e) =>
                html`<li
                  data-prestige-event=${e.prestige}
                  class="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 rounded-lg border border-ui-border bg-ui-panel px-4 py-3"
                >
                  <div class="min-w-0">
                    <div class="font-bold text-ui-text">
                      ${translateText("progression.prestige_history_entry", {
                        rank: e.prestige,
                      })}
                    </div>
                    <div class="text-xs text-ui-muted">
                      ${translateText("progression.prestige_history_run", {
                        xp: formatXp(e.runXpBefore),
                      })}
                    </div>
                  </div>
                  <div class="text-xs text-ui-muted sm:text-right">
                    <div data-prestige-date>
                      ${new Date(e.at).toLocaleDateString()}
                    </div>
                    ${e.credits === null
                      ? nothing
                      : html`<div data-prestige-reward>
                          ${translateText(
                            e.claimed
                              ? "progression.prestige_history_reward_claimed"
                              : "progression.prestige_history_reward_waiting",
                            { credits: formatXp(e.credits) },
                          )}
                        </div>`}
                  </div>
                </li>`,
            )}
          </ul>`}
    </section>`;
  }

  // -- milestones ------------------------------------------------------------

  private renderMilestones(track: ProgressionTrack): TemplateResult {
    const next = nextWinMilestone(track.wins);
    return html`<section
      data-progression-section="milestones"
      class="${CARD} df-enter flex flex-col gap-4"
      style="--i: 2"
    >
      <div class="flex flex-wrap items-baseline justify-between gap-2">
        <h2 class=${CARD_HEADING}>
          ${translateText("progression.milestones")}
        </h2>
        <span class="text-sm text-ui-muted" data-milestones-total
          >${translateText("progression.milestones_total", {
            count: formatXp(track.wins),
          })}</span
        >
      </div>
      <h3 class="m-0 text-base font-semibold text-ui-text">
        ${translateText("progression.milestones_wins")}
      </h3>
      <ul
        class="m-0 grid list-none grid-cols-2 gap-3 p-0 sm:grid-cols-3 lg:grid-cols-5"
      >
        ${winMilestones(track.wins).map(
          (m) =>
            html`<li
              data-win-milestone=${m.target}
              data-state=${m.achieved ? "achieved" : "locked"}
              data-current=${next?.target === m.target ? "true" : nothing}
              class="flex flex-col items-center gap-1 rounded-lg border px-3 py-3 text-center ${m.achieved
                ? "border-df-red/60 bg-df-red/10"
                : "border-white/10 bg-black/20 opacity-70"}"
            >
              <span
                class="flex h-12 w-12 items-center justify-center rounded-full border-2 text-sm font-bold ${m.achieved
                  ? "border-df-red bg-df-red/25 text-white"
                  : "border-white/15 text-white/40"}"
                >${m.target}</span
              >
              <span class="text-sm font-bold text-ui-text"
                >${translateText("progression.milestone_wins", {
                  count: m.target,
                })}</span
              >
              ${m.achieved
                ? html`<span
                    class="flex items-center gap-1 text-xs text-ui-success"
                    >${CHECK}${translateText(
                      "progression.milestone_achieved",
                    )}</span
                  >`
                : html`<span class="text-xs text-ui-muted"
                    >${translateText("progression.milestone_not_yet")} ·
                    ${translateText("progression.milestone_progress", {
                      current: m.progress,
                      target: m.target,
                    })}</span
                  >`}
              ${m.target === 100
                ? html`<span class="text-[11px] text-ui-muted"
                    >${translateText("progression.milestone_conqueror")}</span
                  >`
                : nothing}
            </li>`,
        )}
      </ul>
    </section>`;
  }
}
