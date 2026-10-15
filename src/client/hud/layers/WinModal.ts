import { GameType, RankedType } from "@openfront/engine-api/game/GameTypes";
import { GameUpdateType } from "@openfront/engine-api/game/GameUpdates";
import { ACCOUNT_FEATURES } from "@openfront/shared/AccountFeatures";
import type { GameXpEligible } from "@openfront/shared/ApiSchemas";
import { Pattern } from "@openfront/shared/CosmeticSchemas";
import { EventBus } from "@openfront/shared/EventBus";
import { html, LitElement, TemplateResult } from "lit";
import { customElement, state } from "lit/decorators.js";
import {
  DESKTOP_TUTORIAL_VIDEO_URL,
  getGamesPlayed,
  homeHref,
  isInIframe,
  translateText,
  TUTORIAL_VIDEO_URL,
} from "../../../client/Utils";
import { getUserMe } from "../../Api";
import { BRAND } from "../../Branding";
import "../../components/CosmeticCard";
import { cosmeticSelectionLabel } from "../../components/CosmeticPresentation";
import type { GameXpPanelState } from "../../components/GameXpPanel";
import type { LegendCeremony } from "../../components/LegendCeremony";
import "../../components/PurchaseButton";
import { hasSteamStorePage } from "../../components/SteamWishlist";
import { Controller } from "../../Controller";
import {
  fetchCosmetics,
  purchaseCosmetic,
  resolveCosmetics,
} from "../../Cosmetics";
import { crazyGamesSDK } from "../../CrazyGamesSDK";
import { isDesktopShell } from "../../DesktopShell";
import { clearPendingXp, rememberPendingXp } from "../../PendingXpStore";
import { Platform } from "../../Platform";
import { MAX_PRESTIGE, reachedLegendThisGame } from "../../Progression";
import { resolveXpAccount } from "../../ProgressionAccount";
import {
  fetchLiveXp,
  fetchProgressionConfig,
  OUT_XP_POLL_MS,
  pollGameXp,
} from "../../ProgressionApi";
import { PlaySoundEffectEvent } from "../../sound/Sounds";
import { SendWinnerEvent } from "../../Transport";
import { GameView } from "../../view";

type LegendCeremonyModule = typeof import("../../components/LegendCeremony");

// The XP section stays out of the startup bundle: it's fetched when a game
// starts (see init), long before the game ends, so the reveal never waits on
// it. Should it still be on its way, the section shows the moment it lands.
let xpPanelModule: Promise<unknown> | null = null;
// How long the end-of-game XP is waited for before the section gives up.
const XP_POLL_TIMEOUT_MS = 150_000;

function loadGameXpPanel(): void {
  xpPanelModule ??= import("../../components/GameXpPanel").catch(
    (err: unknown) => {
      // Tried again at the end of the game, or the next one.
      xpPanelModule = null;
      console.warn("WinModal: XP section failed to load", err);
    },
  );
}

@customElement("win-modal")
export class WinModal extends LitElement implements Controller {
  public game: GameView;
  public eventBus: EventBus;

  private hasShownDeathModal = false;

  @state()
  isVisible = false;

  @state()
  private isWin = false;

  @state()
  private isRankedGame = false;

  @state()
  private patternContent: TemplateResult | null = null;

  // The XP this game earned. Stays hidden unless there is something to say:
  // no progression, a spectator or a replay never see the section at all.
  @state()
  private xpView: GameXpPanelState = { kind: "hidden" };
  // Polling starts once, at the end of the game.
  private xpPolling = false;
  // The player's reduced award for a death is on the panel: it is final.
  private finalShown = false;
  private xpAbort: AbortController | null = null;
  // While the game goes on after the player died: re-reading the XP preview.
  private liveTimer: ReturnType<typeof setInterval> | null = null;
  // Whose XP the section shows: the Legend ceremony plays once per account.
  private xpPublicId: string | null = null;
  // The Legend ceremony, fetched only for a player who could become a Legend
  // (see preloadLegendCeremony); null until it has arrived.
  private legendCeremony: LegendCeremonyModule | null = null;
  private legendCeremonyLoad: Promise<void> | null = null;
  // Replaceable for tests.
  loadLegendCeremony: () => Promise<LegendCeremonyModule> = () =>
    import("../../components/LegendCeremony");

  private _title: string;

  private rand = Math.random();

  // Override to prevent shadow DOM creation
  createRenderRoot() {
    return this;
  }

  constructor() {
    super();
  }

  render() {
    return html`
      <div
        class="${this.isVisible
          ? "fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 bg-gray-800/70 p-4 md:p-6 shrink-0 rounded-lg z-[10010] shadow-2xl backdrop-blur-xs text-white w-[min(90vw,700px)] max-w-[90%] max-h-[90dvh] overflow-hidden flex flex-col"
          : "hidden"}"
      >
        <h2 class="m-0 mb-4 text-[26px] text-center text-white shrink-0">
          ${this._title || ""}
        </h2>
        <div class="min-h-0 flex-1 overflow-y-auto pr-0.5">
          <game-xp-panel
            .view=${this.xpView}
            .onScreen=${this.isVisible}
            .gameType=${this.game?.config().gameConfig().gameType ?? null}
            @xp-legend=${this.onXpLegend}
          ></game-xp-panel>
          ${this.innerHtml()}
        </div>
        <!-- Leaving is the quieter action, on the left; staying in the game
             is the main one, on the right. -->
        <div class="mt-4 flex justify-between gap-2.5 shrink-0">
          ${this.actionButton(
            "quiet",
            translateText("win_modal.exit"),
            () => this._handleExit(),
            "exit",
          )}
          ${this.isRankedGame
            ? this.actionButton(
                "main",
                translateText("win_modal.requeue"),
                () => this._handleRequeue(),
                "requeue",
              )
            : null}
          ${this.actionButton(
            "main",
            this.game?.myPlayer()?.isAlive()
              ? translateText("win_modal.keep")
              : translateText("win_modal.spectate"),
            () => this.hide(),
            "keep",
          )}
        </div>
        ${this.renderActionStyles()}
      </div>
      <legend-ceremony
        @legend-ceremony-closed=${this.onLegendCeremonyClosed}
      ></legend-ceremony>
    `;
  }

  // The server's result for this game made the player a Legend: the moment
  // gets the whole screen, the first time on this account. The XP section
  // rests on its final state behind it, so Continue comes back to the
  // settled popup. Should the ceremony not have arrived (a slow or failed
  // fetch), the XP section plays its own Legend moment instead.
  private onXpLegend = (e: CustomEvent<GameXpEligible>): void => {
    const publicId = this.xpPublicId;
    const legend = this.legendCeremony;
    if (publicId === null || legend === null) return;
    if (legend.legendCeremonySeen(publicId)) return;
    const ceremony = this.querySelector<LegendCeremony>("legend-ceremony");
    if (ceremony === null) return;
    e.preventDefault();
    legend.markLegendCeremonySeen(publicId);
    ceremony.show({ lifetimeXp: e.detail.after.lifetimeXp, at: new Date() });
  };

  // Fetches the Legend ceremony ahead of its moment: once the account is
  // known to be on its last prestige run, and again (should that have missed
  // it) as soon as the server's result says this game made a Legend, while
  // the reveal is still climbing to level 100.
  private preloadLegendCeremony(): void {
    if (this.legendCeremonyLoad !== null) return;
    this.legendCeremonyLoad = this.loadLegendCeremony().then(
      (module) => {
        this.legendCeremony = module;
      },
      (err: unknown) => {
        this.legendCeremonyLoad = null;
        console.warn("WinModal: Legend ceremony failed to load", err);
      },
    );
  }

  // The first of those: where the last run is comes from the config, as the
  // server may move it, and from the client's own constant only without one.
  private async preloadIfLastRun(prestige: number): Promise<void> {
    const config = await fetchProgressionConfig();
    const last =
      config !== false && config.maxPrestige > 0
        ? config.maxPrestige
        : MAX_PRESTIGE;
    if (prestige >= last) this.preloadLegendCeremony();
  }

  private onLegendCeremonyClosed = (): void => {
    this.querySelector<HTMLElement>('[data-win-action="keep"]')?.focus();
  };

  // The modal's own buttons, textured like the store's tiles and buy buttons:
  // a tinted gradient with a coloured border, and on hover they lift, glow
  // and a light streak sweeps across. "main" is the blue action (keep playing,
  // play again); "quiet" is leaving.
  private actionButton(
    tone: "main" | "quiet",
    label: string,
    onClick: () => void,
    action: string,
  ): TemplateResult {
    return html`<button
      type="button"
      data-win-action=${action}
      class="win-action win-action-${tone} flex-1"
      @click=${onClick}
    >
      <span class="relative">${label}</span>
    </button>`;
  }

  private renderActionStyles(): TemplateResult {
    return html`<style>
      .win-action {
        position: relative;
        overflow: hidden;
        display: flex;
        align-items: center;
        justify-content: center;
        min-height: 3rem;
        padding: 0.75rem 1rem;
        border-radius: 0.75rem;
        border: 1px solid;
        color: #fff;
        font-weight: 700;
        font-size: 1.0625rem;
        line-height: 1.25;
        letter-spacing: 0.02em;
        cursor: pointer;
        transition:
          transform 200ms ease-out,
          box-shadow 200ms ease-out,
          border-color 200ms ease-out,
          background 200ms ease-out;
      }
      /* The light streak, parked off the left edge until hover. */
      .win-action::after {
        content: "";
        position: absolute;
        top: -20%;
        bottom: -20%;
        left: -60%;
        width: 40%;
        transform: skewX(-20deg);
        background: linear-gradient(
          90deg,
          transparent,
          rgba(255, 255, 255, 0.28),
          transparent
        );
        pointer-events: none;
      }
      /* The streak sweeps across on the way in only; leaving, it snaps back
         out of sight rather than sweeping back across the button. */
      .win-action:hover::after,
      .win-action:focus-visible::after {
        left: 130%;
        transition: left 550ms ease-out;
      }
      .win-action:hover,
      .win-action:focus-visible {
        transform: translateY(-2px);
      }
      .win-action:active {
        transform: translateY(0) scale(0.98);
      }
      .win-action:focus-visible {
        outline: 2px solid var(--color-df-text);
        outline-offset: 2px;
      }
      .win-action-main {
        background: var(--color-df-red);
        border-color: var(--color-df-red);
        border-bottom-color: var(--color-df-red-dark);
      }
      .win-action-main:hover,
      .win-action-main:focus-visible {
        background: var(--color-df-red-bright);
        border-color: var(--color-df-red-bright);
        border-bottom-color: var(--color-df-red-dark);
      }
      .win-action-quiet {
        background: var(--color-df-panel);
        border-color: var(--color-df-border);
      }
      .win-action-quiet:hover,
      .win-action-quiet:focus-visible {
        background: var(--color-df-bg-secondary);
        border-color: var(--color-df-red);
      }
      @media (prefers-reduced-motion: reduce) {
        .win-action,
        .win-action::after {
          transition: none;
        }
        .win-action:hover,
        .win-action:focus-visible,
        .win-action:active {
          transform: none;
        }
      }
    </style>`;
  }

  innerHtml() {
    // Each promo only appears when what it points at exists: the Steam page,
    // a Discord, a cosmetic store. With none of them, the box stays empty
    // rather than pitching something the player cannot reach.
    const canWishlist = hasSteamStorePage();
    const canDiscord = BRAND.discordUrl !== "";
    const canPatterns = ACCOUNT_FEATURES.store;
    const none = html``;

    if (isInIframe()) {
      if (canWishlist) return this.steamWishlist();
      if (canDiscord) return this.discordDisplay();
      return canPatterns ? this.renderPatternButton() : none;
    }

    if (!this.isWin && getGamesPlayed() < 3 && TUTORIAL_VIDEO_URL !== "") {
      return this.renderYoutubeTutorial();
    }
    if (this.rand < 0.25 && canWishlist) {
      return this.steamWishlist();
    } else if (this.rand < 0.5 && canDiscord) {
      return this.discordDisplay();
    } else if (canPatterns) {
      return this.renderPatternButton();
    }
    return none;
  }

  renderYoutubeTutorial() {
    return html`
      <div class="text-center mb-6 bg-black/30 p-2.5 rounded-sm">
        <h3 class="text-xl font-semibold text-white mb-3">
          ${translateText("win_modal.youtube_tutorial")}
        </h3>
        <!-- 56.25% = 9:16 -->
        <div class="relative w-full pb-[56.25%]">
          ${Platform.isElectron
            ? html`<video
                class="absolute top-0 left-0 w-full h-full rounded-sm"
                src="${this.isVisible ? DESKTOP_TUTORIAL_VIDEO_URL : ""}"
                controls
                preload="metadata"
              ></video>`
            : html`<iframe
                class="absolute top-0 left-0 w-full h-full rounded-sm"
                src="${this.isVisible ? TUTORIAL_VIDEO_URL : ""}"
                title="YouTube video player"
                frameborder="0"
                allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
                allowfullscreen
              ></iframe>`}
        </div>
      </div>
    `;
  }

  renderPatternButton() {
    return html`
      <div class="text-center mb-6 bg-black/30 p-2.5 rounded-sm">
        <h3 class="text-xl font-semibold text-white mb-3">
          ${translateText("win_modal.support_openfront")}
        </h3>
        ${isDesktopShell()
          ? null
          : html`<p class="text-white mb-3">
              ${translateText("win_modal.territory_pattern")}
            </p>`}
        <div
          class="mx-auto w-full overflow-x-auto overflow-y-visible rounded-sm"
        >
          <div
            class="flex min-w-max items-start justify-center gap-4 px-1 py-1"
          >
            ${this.patternContent}
          </div>
        </div>
      </div>
    `;
  }

  async loadPatternContent() {
    const me = await getUserMe();
    const cosmetics = await fetchCosmetics();

    const purchasable = resolveCosmetics(cosmetics, me, null).filter(
      (r) => r.type === "pattern" && r.relationship === "purchasable",
    );

    if (purchasable.length === 0) {
      this.patternContent = html``;
      return;
    }

    // Shuffle the array and take patterns. Will always be 3 wide to allow scrolling
    const shuffled = [...purchasable].sort(() => Math.random() - 0.5);
    const selected = shuffled.slice(0, Math.min(3, shuffled.length));

    this.patternContent = html`
      <div class="flex gap-4 flex-nowrap justify-start items-start">
        ${selected.map((resolved) => {
          // Only patterns were selected above.
          const pattern = resolved.cosmetic as Pattern | null;
          return html`
            <div data-win-cosmetic-promo class="flex w-40 flex-col gap-2">
              <cosmetic-card
                .resolved=${resolved}
                .interactive=${false}
              ></cosmetic-card>
              <purchase-button
                .priceHard=${pattern?.priceHard ?? null}
                .priceSoft=${pattern?.priceSoft ?? null}
                .rarity=${pattern?.rarity ?? "common"}
                .itemName=${cosmeticSelectionLabel(resolved)}
                .onPurchaseHard=${() => purchaseCosmetic(resolved, "hard")}
                .onPurchaseSoft=${() => purchaseCosmetic(resolved, "soft")}
              ></purchase-button>
            </div>
          `;
        })}
      </div>
    `;
  }

  steamWishlist(): TemplateResult {
    return html`
      <div class="text-center mb-6 bg-black/30 p-2.5 rounded-sm">
        <h3 class="text-xl font-semibold text-white mb-3">
          ${translateText("steam_wishlist.buy_on_steam")}
        </h3>
        <steam-wishlist
          campaign="win_modal"
          .active=${this.isVisible}
        ></steam-wishlist>
      </div>
    `;
  }

  discordDisplay(): TemplateResult {
    return html`
      <div class="text-center mb-6 bg-black/30 p-2.5 rounded-sm">
        <h3 class="text-xl font-semibold text-white mb-3">
          ${translateText("win_modal.join_discord")}
        </h3>
        <p class="text-white mb-3">
          ${translateText("win_modal.discord_description")}
        </p>
        <a
          href=${BRAND.discordUrl}
          target="_blank"
          rel="noopener noreferrer"
          class="inline-block px-6 py-3 bg-df-red text-white rounded-sm font-semibold transition-all duration-200 hover:bg-df-red-bright hover:-translate-y-px no-underline"
        >
          ${translateText("win_modal.join_server")}
        </a>
      </div>
    `;
  }

  async show() {
    crazyGamesSDK.gameplayStop();
    this.isRankedGame =
      this.game.config().gameConfig().rankedType !== undefined;
    this.isVisible = true;
    this.requestUpdate();
    try {
      await this.loadPatternContent();
    } catch (error) {
      console.warn("Failed to load win modal cosmetics", error);
      return;
    }
    this.requestUpdate();
  }

  hide() {
    this.isVisible = false;
    this.requestUpdate();
  }

  disconnectedCallback(): void {
    this.stopLiveXp();
    this.xpAbort?.abort();
    super.disconnectedCallback();
  }

  /**
   * Shows the XP of the game that is still on for a player who is out: while
   * the server confirms the elimination, the card says so; the moment it has
   * paid the reduced award, the panel shows what was earned, with the level the
   * player reached. It follows the report until then.
   */
  private startLiveXp(gameId: string): void {
    void this.refreshLiveXp(gameId);
    this.liveTimer ??= setInterval(
      () => void this.refreshLiveXp(gameId),
      OUT_XP_POLL_MS,
    );
  }

  private stopLiveXp(): void {
    if (this.liveTimer === null) return;
    clearInterval(this.liveTimer);
    this.liveTimer = null;
  }

  private async refreshLiveXp(gameId: string): Promise<void> {
    const result = await fetchLiveXp(gameId);
    // The stored game's XP, once polled for, owns the section; so does the
    // award once it is on the panel.
    if (this.xpPolling || this.finalShown) return;
    if (result.status === "unavailable") {
      this.stopLiveXp();
      return;
    }
    if (result.status !== "ok" || result.data.status === "none") return;
    const live = result.data;
    this.xpView = {
      kind: "live",
      data: live,
      playerAlive: this.game.myPlayer()?.isAlive() ?? null,
    };
    if (live.status === "forfeited") return;
    rememberPendingXp(gameId);
    if (live.status === "final") void this.showFinalXp(gameId);
  }

  /**
   * The player was eliminated and has been paid: their award, in full, with the
   * bar and any level reached. There is nothing left to wait for, so the poll
   * for the match's end does not start again for this player.
   */
  private async showFinalXp(gameId: string): Promise<void> {
    if (this.finalShown) return;
    this.finalShown = true;
    this.stopLiveXp();
    this.xpAbort ??= new AbortController();
    const result = await pollGameXp(gameId, {
      signal: this.xpAbort.signal,
      timeoutMs: 20_000,
      intervalMs: 1_000,
    });
    if (result === null) {
      // The card above already says it is final; the full panel can wait for
      // the end of the match.
      this.finalShown = false;
      return;
    }
    if (result.eligible && reachedLegendThisGame(result)) {
      this.preloadLegendCeremony();
    }
    clearPendingXp();
    this.xpView = { kind: "result", data: result };
    // The account has the XP now: the nav's level and bar can catch up.
    document.dispatchEvent(
      new CustomEvent("xp-awarded", { detail: { gameId } }),
    );
  }

  /**
   * Fills the XP section. `gameOver` is false when the player died while the
   * game carries on: their reduced award is paid as soon as the server confirms
   * the elimination and is shown here, and the poll for the stored XP starts
   * when the game really ends (for anyone not already paid).
   */
  private async updateXp(gameOver: boolean): Promise<void> {
    if (this.xpPolling) return;
    // Already paid at the death and on the panel: nothing more to wait for.
    if (this.xpView.kind === "result" && this.xpView.data.eligible) return;
    // Normally here since the game started; tried again should that fetch
    // have failed.
    loadGameXpPanel();
    try {
      const game = this.game;
      // Spectators and replay viewers have no XP of their own.
      if (game.config().isReplay() || !game.myPlayer()) return;
      const account = await resolveXpAccount();
      // /users/@me failed while there is a session: a signed-in player must
      // not be told to sign in over a network blip, so say nothing.
      if (account.kind === "unknown") return;
      if (account.kind === "signed_out") {
        // Only pitch XP when progression is actually on. There is no
        // /users/@me progress to go by here, so ask the public config (404
        // when progression is off; any failure also says nothing).
        const config = await fetchProgressionConfig();
        if (config === false || this.xpPolling) return;
        this.xpView = { kind: "signed_out" };
        return;
      }
      // /users/@me carries progress whenever progression is on (level 1
      // before a first scored game); absent means off: no section at all.
      const progress = account.me.player.progress;
      if (progress === undefined) return;
      // A singleplayer game is never sent to the account API, so there is no
      // XP to wait for: say so at once instead of polling for a minute.
      if (game.config().gameConfig().gameType === GameType.Singleplayer) {
        this.xpView = {
          kind: "result",
          data: {
            gameId: game.gameID(),
            eligible: false,
            reason: "unverified",
          },
        };
        return;
      }
      this.xpPublicId = account.me.player.publicId ?? null;
      if (!progress.legend) void this.preloadIfLastRun(progress.prestige);
      // The game may have ended while this was resolving; the end-of-game
      // call owns the section from then on.
      if (this.xpPolling) return;
      if (!gameOver) {
        this.startLiveXp(game.gameID());
        return;
      }
      this.stopLiveXp();
      this.xpPolling = true;
      this.xpView = { kind: "calculating" };
      // The server has the result before the game is stored: say so at once
      // (and that a win is confirmed) while the stored XP is looked for.
      void this.showSettledPreview(game.gameID());
      this.xpAbort = new AbortController();
      // The game server replays the game to check the winner before it
      // archives it, which can take a while for a long game.
      const result = await pollGameXp(game.gameID(), {
        signal: this.xpAbort.signal,
        timeoutMs: XP_POLL_TIMEOUT_MS,
      });
      if (result?.eligible && reachedLegendThisGame(result)) {
        this.preloadLegendCeremony();
      }
      // Timed out, signed out or unreadable: hide rather than show an error
      // (or, worse, a zero).
      if (result !== null) clearPendingXp();
      this.xpView =
        result === null ? { kind: "hidden" } : { kind: "result", data: result };
    } catch (err) {
      console.warn("WinModal: XP section failed", err);
      this.xpView = { kind: "hidden" };
    }
  }

  // The result is in but the game is not stored yet: show what the API already
  // knows (a confirmed win with its XP, or a forfeit) instead of a bare spinner.
  private async showSettledPreview(gameId: string): Promise<void> {
    const result = await fetchLiveXp(gameId);
    if (this.xpView.kind !== "calculating") return;
    if (result.status !== "ok") return;
    if (
      result.data.status !== "settled" &&
      result.data.status !== "forfeited"
    ) {
      return;
    }
    this.xpView = {
      kind: "live",
      data: result.data,
      playerAlive: this.game.myPlayer()?.isAlive() ?? null,
    };
  }

  private _handleExit() {
    this.hide();
    window.location.href = homeHref();
  }

  private _handleRequeue() {
    this.hide();
    // Requeue for the same mode; Main owns the mechanism (currently a
    // reload with the requeue param, which reopens the queue after the
    // page teardown).
    const rankedType = this.game.config().gameConfig().rankedType;
    document.dispatchEvent(
      new CustomEvent("matchmaking-requeue", {
        detail: {
          mode:
            rankedType === RankedType.TwoVTwo
              ? ("2v2" as const)
              : rankedType === RankedType.FreeForAll
                ? ("ffa" as const)
                : ("1v1" as const),
        },
      }),
    );
  }

  init() {
    if (!this.game.config().isReplay()) loadGameXpPanel();
  }

  tick() {
    const myPlayer = this.game.myPlayer();
    if (
      !this.hasShownDeathModal &&
      myPlayer &&
      !myPlayer.isAlive() &&
      !this.game.inSpawnPhase() &&
      myPlayer.hasSpawned()
    ) {
      this.hasShownDeathModal = true;
      this._title = translateText("win_modal.died");
      this.eventBus.emit(new PlaySoundEffectEvent("defeat"));
      void this.updateXp(false);
      this.show();
    }
    const updates = this.game.updatesSinceLastTick();
    const winUpdates = updates?.[GameUpdateType.Win] ?? [];
    if (winUpdates.length > 0) void this.updateXp(true);
    winUpdates.forEach((wu) => {
      if (wu.winner === undefined) {
        // Match cancelled (e.g. a ranked 2v2 that didn't fill or fully
        // spawn): the game ends with no winner. Still vote the result to the
        // server so the record is archived winnerless (never ranked).
        this.eventBus.emit(new SendWinnerEvent(undefined, wu.allPlayersStats));
        this._title = translateText("win_modal.match_cancelled");
        this.isWin = false;
        history.replaceState(null, "", `${window.location.pathname}?replay`);
        this.show();
      } else if (wu.winner[0] === "team") {
        this.eventBus.emit(new SendWinnerEvent(wu.winner, wu.allPlayersStats));
        if (wu.winner[1] === this.game.myPlayer()?.team()) {
          this._title = translateText("win_modal.your_team");
          this.isWin = true;
          crazyGamesSDK.happytime();
        } else {
          this._title = translateText("win_modal.other_team", {
            team: wu.winner[1],
          });
          this.isWin = false;
        }
        this.playEndOfGameSound();
        history.replaceState(null, "", `${window.location.pathname}?replay`);
        this.show();
      } else if (wu.winner[0] === "nation") {
        this.eventBus.emit(new SendWinnerEvent(wu.winner, wu.allPlayersStats));
        this._title = translateText("win_modal.nation_won", {
          nation: wu.winner[1],
        });
        this.isWin = false;
        this.playEndOfGameSound();
        this.show();
      } else {
        const winner = this.game.playerByClientID(wu.winner[1]);
        if (!winner?.isPlayer()) return;
        const winnerClient = winner.clientID();
        if (winnerClient !== null) {
          this.eventBus.emit(
            new SendWinnerEvent(["player", winnerClient], wu.allPlayersStats),
          );
        }
        if (
          winnerClient !== null &&
          winnerClient === this.game.myPlayer()?.clientID()
        ) {
          this._title = translateText("win_modal.you_won");
          this.isWin = true;
          crazyGamesSDK.happytime();
        } else {
          this._title = translateText("win_modal.other_won", {
            player: winner.displayName(),
          });
          this.isWin = false;
        }
        this.playEndOfGameSound();
        history.replaceState(null, "", `${window.location.pathname}?replay`);
        this.show();
      }
    });
  }

  private playEndOfGameSound(): void {
    if (this.isWin) {
      this.eventBus.emit(new PlaySoundEffectEvent("victory"));
    } else if (!this.hasShownDeathModal && this.game.myPlayer()?.hasSpawned()) {
      // Spawned check: spectators and replay viewers shouldn't get a
      // personal defeat sting. The cue also already played if the player
      // died earlier (hasShownDeathModal).
      this.eventBus.emit(new PlaySoundEffectEvent("defeat"));
    }
  }
}
