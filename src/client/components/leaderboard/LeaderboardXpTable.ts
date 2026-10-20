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
import { uiBadge, uiButton } from "../ui/PageUi";
import { formatXp } from "../XpBar";

/**
 * The XP leaderboards: lifetime XP (`mode="lifetime"`) and the running season
 * (`mode="season"`, with a picker for archived seasons). Pages are fetched on
 * request and appended; the API caps how far back it goes.
 */
@customElement("leaderboard-xp-table")
export class LeaderboardXpTable extends LitElement {
  @property({ type: String }) mode: "lifetime" | "season" = "lifetime";
  /** The signed-in player's public id: their row is highlighted and tagged "You". */
  @property({ type: String }) currentPublicId = "";

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
      this.dispatchEvent(
        new CustomEvent("board-updated", { bubbles: true, composed: true }),
      );
    }
  }

  /** The signed-in player's rank on the rows loaded so far, or null. */
  public myRank(): number | null {
    if (this.currentPublicId === "") return null;
    return (
      this.players.find((p) => p.playerId === this.currentPublicId)?.rank ??
      null
    );
  }

  /** Scroll the signed-in player's row into view; false when it is not loaded. */
  public jumpToMe(): boolean {
    const row = this.querySelector<HTMLElement>(
      `[data-xp-row="${this.currentPublicId}"]`,
    );
    if (!row) return false;
    row.scrollIntoView({ block: "center", behavior: "smooth" });
    return true;
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
    const me =
      this.currentPublicId !== "" && p.playerId === this.currentPublicId;
    return html`<tr
      data-xp-row=${p.playerId}
      data-current-user=${me ? "true" : "false"}
      class="border-b border-ui-border transition-colors ${me
        ? "bg-ui-accent-tint"
        : "hover:bg-ui-surface"}"
    >
      <td class="px-4 py-3">
        <span
          data-rank-badge=${p.rank === 1 ? "gold" : "plain"}
          class="ui-mono mx-auto flex h-9 w-9 items-center justify-center rounded-ui-card text-[15px] font-bold ${p.rank ===
          1
            ? "bg-ui-gold/15 text-ui-gold"
            : "bg-ui-surface text-ui-muted"}"
          >${p.rank}</span
        >
      </td>
      <td class="px-4 py-3">
        <div class="flex items-center gap-3">
          <level-badge
            .level=${p.level}
            .prestige=${p.prestige}
            .legend=${p.legend}
            .size=${32}
          ></level-badge>
          <div class="min-w-0">
            <div class="flex items-center gap-2">
              <player-name
                .username=${p.accountUsername}
                .verified=${p.verified}
                .staffRole=${p.staffRole}
                .publicId=${p.playerId}
                .nameClass=${"font-bold text-ui-text truncate text-[15px] hover:underline"}
                .onNameClick=${() => this.openProfile(p.playerId)}
              ></player-name>
              ${me
                ? uiBadge(translateText("leaderboard_modal.you"), "accent")
                : nothing}
            </div>
            <div class="ui-label mt-0.5">
              ${translateText(rankLabelKey(p.level))}
            </div>
          </div>
        </div>
      </td>
      <td class="px-4 py-3 pr-6 text-right">
        <span class="ui-mono text-[15px] font-semibold text-ui-text"
          >${formatXp(p.xp)}</span
        >
      </td>
    </tr>`;
  }

  render() {
    const seasonPicker =
      this.mode === "season" && this.seasons.length > 1
        ? html`<div class="px-6 pt-5">
            <select
              data-xp-season-picker
              aria-label=${translateText("progression.season_xp")}
              class="ui-focus ui-body h-11 w-full max-w-xs rounded-ui-card border border-ui-border-strong bg-ui-surface px-3 text-ui-text"
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
            </select>
          </div>`
        : nothing;
    const heading =
      this.mode === "season" && this.season
        ? html`<div data-xp-season-name class="ui-label px-6 pt-5">
            ${this.season.name}
            ${this.season.archived
              ? html`<span class="ml-2"
                  >${translateText("progression.season_archived")}</span
                >`
              : nothing}
          </div>`
        : nothing;
    if (this.isLoading && this.players.length === 0) {
      return html`<p class="ui-body p-10 text-center text-ui-muted">
        ${translateText("common.loading")}
      </p>`;
    }
    if (this.error && this.players.length === 0) {
      return html`<p
        class="ui-body p-10 text-center text-ui-accent-soft"
        data-xp-error
      >
        ${translateText("leaderboard_modal.error")}
      </p>`;
    }
    if (this.players.length === 0) {
      return html`${seasonPicker}
        <p class="ui-body p-10 text-center text-ui-muted" data-xp-empty>
          ${translateText(
            this.mode === "season"
              ? "progression.season_board_empty"
              : "progression.xp_board_empty",
          )}
        </p>`;
    }
    return html`${seasonPicker}${heading}
      <div class="overflow-x-auto px-6 pt-4">
        <table class="w-full text-left" data-xp-table>
          <thead>
            <tr class="ui-label border-b border-ui-border">
              <th class="w-20 px-4 py-3 text-center font-semibold">
                ${translateText("leaderboard_modal.rank")}
              </th>
              <th class="px-4 py-3 font-semibold">
                ${translateText("leaderboard_modal.player")}
              </th>
              <th class="px-4 py-3 pr-6 text-right font-semibold">
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
        : html`<div class="flex justify-center p-6">
            <span data-xp-more-wrap>
              ${uiButton({
                label: translateText("progression.load_more"),
                disabled: this.isLoading,
                name: "load-more",
                onClick: () => void this.loadMore(),
              })}
            </span>
          </div>`}`;
  }
}
