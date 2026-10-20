import { RankedType } from "@openfront/engine-api/game/GameTypes";
import { ACCOUNT_FEATURES } from "@openfront/shared/AccountFeatures";
import type { UserMeResponse } from "@openfront/shared/ApiSchemas";
import { html, nothing } from "lit";
import { customElement, query, state } from "lit/decorators.js";
import { BaseModal } from "./components/BaseModal";
import "./components/leaderboard/LeaderboardClanTable";
import type { LeaderboardClanTable } from "./components/leaderboard/LeaderboardClanTable";
import "./components/leaderboard/LeaderboardPlayerList";
import type { LeaderboardPlayerList } from "./components/leaderboard/LeaderboardPlayerList";
import "./components/leaderboard/LeaderboardTribeTable";
import type { LeaderboardTribeTable } from "./components/leaderboard/LeaderboardTribeTable";
import "./components/leaderboard/LeaderboardXpTable";
import type { LeaderboardXpTable } from "./components/leaderboard/LeaderboardXpTable";
import {
  uiButton,
  uiDetailPanel,
  uiPageHeader,
  uiTabs,
  uiTwoColumn,
} from "./components/ui/PageUi";
import { formatXp } from "./components/XpBar";
import { rankLabelKey } from "./Progression";
import { lastUserMeResponse } from "./UserMeBroadcast";
import { translateText } from "./Utils";

// The basic (non-ranked) player board: first, and always there.
const BASIC_TAB = "basic";

const RANKED_TAB_KEYS = ["players", "players2v2", "playersFfa"] as const;

// Which tabs exist follows the features that back them: the ranked ladders
// need `ranked`, the clan board `clans`, the tribe board `tribes`. A tab whose
// feature is off is not shown at all (and is not rendered or fetched).
function availableTabKeys(): string[] {
  return [
    BASIC_TAB,
    ...(ACCOUNT_FEATURES.progression ? ["xp", "season"] : []),
    ...(ACCOUNT_FEATURES.ranked ? RANKED_TAB_KEYS : []),
    ...(ACCOUNT_FEATURES.clans ? ["clans"] : []),
    ...(ACCOUNT_FEATURES.tribes ? ["tribes"] : []),
  ];
}

// Tab key -> ladder. "players" predates the 2v2 ladder and stays the 1v1 tab
// so existing `#modal=leaderboard&tab=players` links keep working. The ladder
// tabs share one <leaderboard-player-list>: a page fetch returns every ladder.
const PLAYER_TABS: Record<string, RankedType> = {
  players: RankedType.OneVOne,
  players2v2: RankedType.TwoVTwo,
  playersFfa: RankedType.FreeForAll,
};

@customElement("leaderboard-modal")
export class LeaderboardModal extends BaseModal {
  protected routerName = "leaderboard";

  @state()
  private clanDateRange: { start: string; end: string } | null = null;

  @query("leaderboard-player-list[data-board='ranked']")
  private playerList?: LeaderboardPlayerList;
  @query("leaderboard-player-list[data-board='basic']")
  private basicList?: LeaderboardPlayerList;
  @query("leaderboard-xp-table[data-board='xp']")
  private xpTable?: LeaderboardXpTable;
  @query("leaderboard-xp-table[data-board='season']")
  private seasonTable?: LeaderboardXpTable;
  @query("leaderboard-clan-table")
  private clanTable?: LeaderboardClanTable;
  @query("leaderboard-tribe-table")
  private tribeTable?: LeaderboardTribeTable;

  private loadToken = 0;
  private lastRankedType: RankedType = RankedType.OneVOne;
  // Who is looking: their row is tagged "You" and "Your standing" is about them.
  @state() private me: UserMeResponse | false =
    lastUserMeResponse()?.response ?? false;

  private onUserMe = (event: Event) => {
    this.me = (event as CustomEvent<UserMeResponse | false>).detail;
  };

  connectedCallback(): void {
    super.connectedCallback();
    document.addEventListener("userMeResponse", this.onUserMe);
    const last = lastUserMeResponse();
    if (last !== null) this.me = last.response;
  }

  disconnectedCallback(): void {
    document.removeEventListener("userMeResponse", this.onUserMe);
    super.disconnectedCallback();
  }

  private get myPublicId(): string {
    return this.me === false ? "" : this.me.player.publicId;
  }

  protected modalConfig() {
    const labels: Record<string, string> = {
      [BASIC_TAB]: translateText("leaderboard_modal.basic_tab"),
      xp: translateText("leaderboard_modal.xp_tab"),
      season: translateText("leaderboard_modal.season_tab"),
      players: translateText("leaderboard_modal.ranked_tab"),
      players2v2: translateText("leaderboard_modal.ranked_2v2_tab"),
      playersFfa: translateText("leaderboard_modal.ranked_ffa_tab"),
      clans: translateText("leaderboard_modal.clans_tab"),
      tribes: translateText("leaderboard_modal.tribes_tab"),
    };
    return {
      ui: true,
      hideTabs: true,
      tabs: availableTabKeys().map((key) => ({ key, label: labels[key] })),
    };
  }

  private rankedTypeFor(tab: string): RankedType | null {
    return PLAYER_TABS[tab] ?? null;
  }

  private tabComponent(tab: string) {
    if (tab === BASIC_TAB) return this.basicList;
    if (tab === "xp") return this.xpTable;
    if (tab === "season") return this.seasonTable;
    if (this.rankedTypeFor(tab) !== null) return this.playerList;
    if (tab === "clans") return this.clanTable;
    return this.tribeTable;
  }

  protected onOpen(): void {
    this.loadActiveTabData();
  }

  protected onTabEnter(): void {
    // The player list is one element shared by the ladder tabs, so it needs a
    // ranked type even while another tab is up: keep showing the last one.
    this.lastRankedType =
      this.rankedTypeFor(this.activeTab) ?? this.lastRankedType;
    this.loadActiveTabData();
  }

  private loadActiveTabData() {
    const token = ++this.loadToken;

    const active = this.activeTab;

    const run = async () => {
      if (token !== this.loadToken) return;

      if (active === BASIC_TAB) {
        await this.basicList?.ensureLoaded();
        if (token !== this.loadToken) return;
        this.basicList?.handleTabActivated();
      } else if (this.rankedTypeFor(active) !== null) {
        await this.playerList?.ensureLoaded();
        if (token !== this.loadToken) return;
        this.playerList?.handleTabActivated();
      } else {
        await this.tabComponent(active)?.ensureLoaded();
      }

      queueMicrotask(() => {
        if (token !== this.loadToken) return;
        for (const key of availableTabKeys()) {
          if (key !== active) void this.tabComponent(key)?.ensureLoaded();
        }
      });
    };

    void (async () => {
      if (!this.tabComponent(active)) {
        await this.updateComplete;
      }
      await run();
    })();
  }

  private handleClanDateRangeChange(
    event: CustomEvent<{ start: string; end: string }>,
  ) {
    this.clanDateRange = event.detail;
  }

  protected renderHeaderSlot() {
    let note = html``;
    if (this.activeTab === "clans" && this.clanDateRange) {
      const start = new Date(this.clanDateRange.start).toLocaleDateString();
      const end = new Date(this.clanDateRange.end).toLocaleDateString();
      note = html`<span class="ui-body text-ui-muted"
        >(${start} - ${end})</span
      >`;
    } else if (this.activeTab === BASIC_TAB) {
      note = html`<span class="ui-body hidden italic text-ui-muted md:inline"
        >(${translateText("leaderboard_modal.refresh_time_basic")})</span
      >`;
    } else if (
      this.rankedTypeFor(this.activeTab) !== null ||
      this.activeTab === "tribes"
    ) {
      note = html`<span class="ui-body hidden italic text-ui-muted md:inline"
        >(${translateText("leaderboard_modal.refresh_time")})</span
      >`;
    }
    return uiPageHeader({
      title: translateText("leaderboard_modal.title"),
      backLabel: translateText("common.close"),
      onBack: () => this.close(),
      controls: note,
    });
  }

  private activeBoard() {
    return this.tabComponent(this.activeTab) as
      | { myRank?(): number | null; jumpToMe?(): boolean }
      | undefined;
  }

  /** "Your standing": rank on the board shown, lifetime XP, title and level. */
  private renderStanding() {
    if (this.me === false) {
      return uiDetailPanel({
        body: html`<p data-standing-signed-out class="ui-body text-ui-muted">
          ${translateText("leaderboard_modal.sign_in_standing")}
        </p>`,
      });
    }
    const player = this.me.player;
    const progress = player.progress;
    const name = player.username ?? translateText("main.account");
    const rank = this.activeBoard()?.myRank?.() ?? null;
    const tile = (label: string, value: string) =>
      html`<div
        class="min-w-0 flex-1 rounded-ui-card border border-ui-border bg-ui-panel p-3.5"
      >
        <div class="ui-label">${label}</div>
        <div class="ui-mono mt-2 text-[22px] font-bold text-ui-text">
          ${value}
        </div>
      </div>`;
    return uiDetailPanel({
      body: html`<div class="ui-label">
          ${translateText("leaderboard_modal.your_standing")}
        </div>
        <div class="flex items-center gap-4">
          <span
            aria-hidden="true"
            class="flex h-14 w-14 shrink-0 items-center justify-center rounded-full border-2 border-ui-accent bg-ui-panel text-[20px] font-bold text-ui-accent-soft"
            >${name.charAt(0).toUpperCase()}</span
          >
          <div class="min-w-0">
            <div
              data-standing-name
              class="ui-title truncate normal-case tracking-normal text-ui-text"
            >
              ${name}
            </div>
            ${progress
              ? html`<div data-standing-title class="ui-label mt-1">
                  ${translateText(rankLabelKey(progress.level))} ·
                  ${translateText("progression.level", {
                    level: progress.level,
                  })}
                </div>`
              : nothing}
          </div>
        </div>
        <div class="flex gap-3">
          ${tile(
            translateText("leaderboard_modal.rank_stat"),
            rank === null ? "—" : `#${rank}`,
          )}
          ${progress
            ? tile(
                translateText("leaderboard_modal.lifetime_xp_stat"),
                formatXp(progress.lifetimeXp),
              )
            : nothing}
        </div>`,
      action: uiButton({
        label: translateText("leaderboard_modal.jump_to_my_rank"),
        block: true,
        disabled: rank === null,
        name: "jump",
        onClick: () => this.activeBoard()?.jumpToMe?.(),
      }),
    });
  }

  protected renderBody() {
    const tabs = uiTabs({
      tabs: availableTabKeys().map((key) => ({
        key,
        label:
          (this.modalConfig().tabs ?? []).find((tab) => tab.key === key)
            ?.label ?? key,
      })),
      value: this.activeTab,
      onChange: (key) => this.setActiveTab(key),
      ariaLabel: translateText("leaderboard_modal.title"),
      name: "leaderboard-tabs",
    });
    const content = html`${tabs}
      <div class="min-h-0 flex-1" @board-updated=${() => this.requestUpdate()}>
        ${ACCOUNT_FEATURES.ranked
          ? html`<leaderboard-player-list
              data-board="ranked"
              class=${this.rankedTypeFor(this.activeTab) !== null
                ? "block h-full max-lg:h-[70vh]"
                : "hidden"}
              .rankedType=${this.rankedTypeFor(this.activeTab) ??
              this.lastRankedType}
            ></leaderboard-player-list>`
          : ""}
        <leaderboard-player-list
          data-board="basic"
          class=${this.activeTab === BASIC_TAB
            ? "block h-full max-lg:h-[70vh]"
            : "hidden"}
          .basic=${true}
        ></leaderboard-player-list>
        ${ACCOUNT_FEATURES.progression
          ? html`<leaderboard-xp-table
                data-board="xp"
                mode="lifetime"
                .currentPublicId=${this.myPublicId}
                class=${this.activeTab === "xp" ? "block" : "hidden"}
              ></leaderboard-xp-table>
              <leaderboard-xp-table
                data-board="season"
                mode="season"
                .currentPublicId=${this.myPublicId}
                class=${this.activeTab === "season" ? "block" : "hidden"}
              ></leaderboard-xp-table>`
          : ""}
        ${ACCOUNT_FEATURES.clans
          ? html`<leaderboard-clan-table
              class=${this.activeTab === "clans" ? "block" : "hidden"}
              @date-range-change=${(
                event: CustomEvent<{ start: string; end: string }>,
              ) => this.handleClanDateRangeChange(event)}
            ></leaderboard-clan-table>`
          : ""}
        ${ACCOUNT_FEATURES.tribes
          ? html`<leaderboard-tribe-table
              class=${this.activeTab === "tribes" ? "block" : "hidden"}
            ></leaderboard-tribe-table>`
          : ""}
      </div>`;
    return uiTwoColumn({ content, detail: this.renderStanding() });
  }
}
