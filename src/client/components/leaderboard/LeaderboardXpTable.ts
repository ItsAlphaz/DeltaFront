import type {
  XpLeaderboardEntry,
  XpLeaderboardResponse,
} from "@openfront/shared/ApiSchemas";
import { html, LitElement, nothing, TemplateResult } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { loadModal } from "../../LazyModals";
import { rankLabelKey } from "../../Progression";
import {
  fetchSeasonLeaderboard,
  fetchXpLeaderboard,
} from "../../ProgressionApi";
import { translateText } from "../../Utils";
import "../LevelBadge";
import "../PlayerName";
import { formatXp } from "../XpBar";

/**
 * The XP leaderboards: lifetime XP (`mode="lifetime"`) and the running season
 * (`mode="season"`, with a picker for archived seasons). Pages are fetched on
 * request and appended; the API caps how far back it goes.
 */
@customElement("leaderboard-xp-table")
export class LeaderboardXpTable extends LitElement {
  @property({ type: String }) mode: "lifetime" | "season" = "lifetime";

  @state() private players: XpLeaderboardEntry[] = [];
  @state() private seasons: Array<{ number: number; name: string }> = [];
  @state() private season: XpLeaderboardResponse["season"] = undefined;
  @state() private selectedSeason: number | undefined = undefined;
  @state() private isLoading = false;
  @state() private error = false;
  @state() private reachedEnd = false;

  private page = 0;
  private hasLoaded = false;

  createRenderRoot() {
    return this;
  }

  public async ensureLoaded(): Promise<void> {
    if (this.hasLoaded || this.isLoading) return;
    await this.loadMore();
  }

  private async pickSeason(value: string): Promise<void> {
    this.selectedSeason = value === "" ? undefined : Number(value);
    this.players = [];
    this.page = 0;
    this.reachedEnd = false;
    await this.loadMore();
  }

  public async loadMore(): Promise<void> {
    if (this.isLoading || this.reachedEnd) return;
    this.isLoading = true;
    this.error = false;
    try {
      const next = this.page + 1;
      const result =
        this.mode === "lifetime"
          ? await fetchXpLeaderboard(next)
          : await fetchSeasonLeaderboard(next, this.selectedSeason);
      if (result === "reached_limit") {
        this.reachedEnd = true;
        return;
      }
      if (result === false) {
        this.error = true;
        return;
      }
      this.page = next;
      this.hasLoaded = true;
      this.players = [...this.players, ...result.players];
      this.season = result.season;
      this.seasons = result.seasons ?? this.seasons;
      // A short page is the last one.
      if (result.players.length === 0) this.reachedEnd = true;
    } finally {
      this.isLoading = false;
    }
  }

  private openProfile(publicId: string): void {
    loadModal("player-profile-modal").then(
      () =>
        document
          .querySelector<
            HTMLElement & { openFromLeaderboard(publicId: string): void }
          >("player-profile-modal")
          ?.openFromLeaderboard(publicId),
      (err) => console.error("player-profile-modal failed to load:", err),
    );
  }

  private renderRow(p: XpLeaderboardEntry): TemplateResult {
    return html`<tr
      data-xp-row=${p.playerId}
      class="border-b border-white/5 hover:bg-white/5"
    >
      <td class="py-3 px-4 text-center font-mono text-lg text-white/80">
        ${p.rank}
      </td>
      <td class="py-3 px-4">
        <div class="flex items-center gap-3">
          <level-badge
            .level=${p.level}
            .prestige=${p.prestige}
            .legend=${p.legend}
            .size=${28}
          ></level-badge>
          <div class="min-w-0">
            <player-name
              .username=${p.accountUsername}
              .verified=${p.verified}
              .staffRole=${p.staffRole}
              .publicId=${p.playerId}
              .nameClass=${"font-bold text-df-text truncate text-base hover:underline hover:text-df-red-bright"}
              .onNameClick=${() => this.openProfile(p.playerId)}
            ></player-name>
            <div class="text-[11px] uppercase tracking-wider text-white/50">
              ${translateText(rankLabelKey(p.level))}
            </div>
          </div>
        </div>
      </td>
      <td class="py-3 px-4 text-right pr-6">
        <span class="font-mono font-bold text-yellow-300"
          >${formatXp(p.xp)}</span
        >
      </td>
    </tr>`;
  }

  render() {
    const seasonPicker =
      this.mode === "season" && this.seasons.length > 1
        ? html`<select
            data-xp-season-picker
            class="df-input m-3 text-sm"
            @change=${(e: Event) =>
              void this.pickSeason((e.target as HTMLSelectElement).value)}
          >
            ${this.seasons.map(
              (s) =>
                html`<option
                  value=${s.number}
                  ?selected=${this.season?.number === s.number}
                >
                  ${s.name}
                </option>`,
            )}
          </select>`
        : nothing;
    const heading =
      this.mode === "season" && this.season
        ? html`<div
            data-xp-season-name
            class="px-4 pt-3 text-sm font-bold uppercase tracking-widest text-white/60"
          >
            ${this.season.name}
            ${this.season.archived
              ? html`<span class="ml-2 text-white/40"
                  >${translateText("progression.season_archived")}</span
                >`
              : nothing}
          </div>`
        : nothing;
    if (this.isLoading && this.players.length === 0) {
      return html`<p class="p-8 text-center text-white/60">
        ${translateText("common.loading")}
      </p>`;
    }
    if (this.error && this.players.length === 0) {
      return html`<p class="p-8 text-center text-red-400" data-xp-error>
        ${translateText("leaderboard_modal.error")}
      </p>`;
    }
    if (this.players.length === 0) {
      return html`${seasonPicker}
        <p class="p-8 text-center text-white/60" data-xp-empty>
          ${translateText(
            this.mode === "season"
              ? "progression.season_board_empty"
              : "progression.xp_board_empty",
          )}
        </p>`;
    }
    return html`${seasonPicker}${heading}
      <div class="overflow-x-auto">
        <table class="w-full text-left" data-xp-table>
          <thead>
            <tr class="text-xs uppercase tracking-wider text-white/40">
              <th class="py-2 px-4 text-center">
                ${translateText("leaderboard_modal.rank")}
              </th>
              <th class="py-2 px-4">
                ${translateText("leaderboard_modal.player")}
              </th>
              <th class="py-2 px-4 text-right pr-6">
                ${translateText(
                  this.mode === "season"
                    ? "progression.season_xp"
                    : "progression.lifetime_xp",
                )}
              </th>
            </tr>
          </thead>
          <tbody>
            ${this.players.map((p) => this.renderRow(p))}
          </tbody>
        </table>
      </div>
      ${this.reachedEnd
        ? nothing
        : html`<div class="p-4 text-center">
            <button
              type="button"
              data-xp-more
              class="df-btn"
              ?disabled=${this.isLoading}
              @click=${() => void this.loadMore()}
            >
              ${translateText("progression.load_more")}
            </button>
          </div>`}`;
  }
}
