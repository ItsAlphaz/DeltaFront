import { GAME_ID_REGEX, GameConfig } from "@openfront/engine-api/Schemas";
import { GameMode, GameType } from "@openfront/engine-api/game/GameTypes";
import { assetUrl } from "@openfront/shared/AssetUrls";
import { EventBus } from "@openfront/shared/EventBus";
import { normalizeJoinCode } from "@openfront/shared/JoinCode";
import {
  ClientInfo,
  GameInfo,
  GameRecordSchema,
  LobbyInfoEvent,
  PublicGameInfo,
} from "@openfront/shared/WireSchemas";
import { html, TemplateResult } from "lit";
import { customElement, property, query, state } from "lit/decorators.js";
import { ClientEnv } from "src/client/ClientEnv";
import {
  calculateServerTimeOffset,
  getGameModeLabel,
  getMapName,
  getSecondsUntilServerTimestamp,
  getServerNow,
  renderDuration,
  translateText,
} from "../client/Utils";
import { fetchJoinCode, getApiBase, resolveJoinCode } from "./Api";
import { crazyGamesSDK } from "./CrazyGamesSDK";
import { SendSpectateEvent } from "./LobbyEvents";
import { PublicLobbySocket } from "./LobbySocket";
import { JoinLobbyEvent } from "./Main";
import { ensureServerList, redirectToGameVersion } from "./ServerList";
import { terrainMapFileLoader } from "./TerrainMapFileLoader";
import { normaliseMapKey } from "./Utils";
import { findVersionedShell } from "./VersionedReplay";
import { BaseModal } from "./components/BaseModal";
import "./components/CopyButton";
import { GameStartAlertController } from "./components/GameStartAlertController";
import "./components/LobbyPlayerView";
import { inviteFriendsButton } from "./components/ui/InviteFriendsButton";
import {
  uiBadge,
  uiButton,
  uiDetailPanel,
  uiDetailRows,
  uiIconButton,
  uiIcons,
  uiPageHeader,
  uiSegmented,
  uiTwoColumn,
} from "./components/ui/PageUi";
import { openReplayViewer } from "./replay/ReplayEntry";
import { nationsConfigToSlider } from "./utilities/GameConfigHelpers";
import {
  lobbySettingTagText,
  notableLobbySettings,
} from "./utilities/LobbySettingsSummary";

// The homepage lobby card's modifier pill, one size down: a lobby can run a
// dozen settings and they all have to fit beside the preview.
const CHEAT_TAG =
  "rounded-full border border-ui-gold/40 bg-ui-gold/10 px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.06em] text-ui-gold";
const SETTING_TAG =
  "rounded-full border border-ui-border-strong bg-ui-surface px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.06em] text-ui-muted";

@customElement("join-lobby-modal")
export class JoinLobbyModal extends BaseModal {
  @query("#lobbyIdInput") private lobbyIdInput!: HTMLInputElement;

  @property({ attribute: false }) eventBus: EventBus | null = null;

  @state() private players: ClientInfo[] = [];
  @state() private playerCount: number = 0;
  @state() private gameConfig: GameConfig | null = null;
  @state() private currentLobbyId: string = "";
  // The tracked lobby's four-character join code, when it has one.
  @state() private joinCode = "";
  @state() private currentClientID: string = "";
  @state() private nationCount: number = 0;
  @state() private lobbyStartAt: number | null = null;
  @state() private serverTimeOffset: number = 0;
  @state() private isConnecting: boolean = true;
  @state() private lobbyCreatorClientID: string | null = null;
  // Subscriber-hosted private lobbies listed in the public browser, shown on
  // the pre-join form.
  @state() private hostedLobbies: PublicGameInfo[] = [];
  @state() private hostedLobbiesLoaded = false;
  // Clock offset for the hosted list's countdowns, kept apart from
  // serverTimeOffset (the joined lobby's).
  private hostedServerTimeOffset = 0;
  private readonly gameStartAlert = new GameStartAlertController(
    this,
    () => this.currentLobbyId !== "",
  );

  private leaveLobbyOnClose = true;
  private countdownTimerId: number | null = null;
  private handledJoinTimeout = false;

  private readonly hostedLobbySocket = new PublicLobbySocket((lobbies) => {
    this.hostedServerTimeOffset = calculateServerTimeOffset(lobbies.serverTime);
    // Re-assigned on every broadcast (~2/s), which also keeps the row
    // countdowns ticking.
    this.hostedLobbies = lobbies.games?.hosted ?? [];
    this.hostedLobbiesLoaded = true;
  });

  private isPrivateLobby(): boolean {
    return this.gameConfig?.gameType === GameType.Private;
  }

  // Read off the server's own view of us, so a switch it refused (lobby full,
  // game already started) shows the real state instead of what was asked for.
  private get isSpectating(): boolean {
    return (
      this.players.find((p) => p.clientID === this.currentClientID)
        ?.spectator === true
    );
  }

  private setSpectating(spectator: boolean) {
    this.eventBus?.emit(new SendSpectateEvent(spectator));
  }

  private readonly handleLobbyInfo = (event: LobbyInfoEvent) => {
    const lobby = event.lobby;
    this.currentClientID = event.myClientID;
    // Only stop showing spinner when we have player info
    if (this.isConnecting && lobby.clients) {
      this.isConnecting = false;
    }
    this.updateFromLobby({
      ...lobby,
      startsAt: lobby.startsAt ?? undefined,
    });
  };

  protected renderHeaderSlot() {
    if (!this.currentLobbyId) {
      return uiPageHeader({
        title: translateText("private_lobby.title"),
        onBack: () => this.closeAndLeave(),
        backLabel: translateText("common.close"),
      });
    }
    // Both affordances answer "get my friends into this lobby", so they sit
    // together. Copy stays private-only (the ID is how a private lobby is
    // shared); the Steam invite works for either, because the shell keeps a
    // shadow lobby for any joined game.
    const copy =
      this.currentLobbyId && this.isPrivateLobby()
        ? html`<copy-button
            .lobbyId=${this.currentLobbyId}
            .joinCode=${this.joinCode}
          ></copy-button>`
        : undefined;
    // Except public FFA: inviting Steam friends into an every-man-for-himself
    // public match encourages teaming, so the button stays off there. Public
    // team lobbies and private lobbies keep it. A config that has not arrived
    // yet counts as "off" too — the URL-join and accepted-invite paths render
    // this header before the first lobby_info, and that window must not show
    // a button the config may be about to forbid.
    const isPublicFfa =
      this.gameConfig?.gameType === GameType.Public &&
      this.gameConfig.gameMode !== GameMode.Team;
    const invite =
      this.gameConfig === null || isPublicFfa
        ? undefined
        : inviteFriendsButton();
    return uiPageHeader({
      title: translateText("public_lobby.title"),
      onBack: () => this.closeAndLeave(),
      backLabel: translateText("common.close"),
      // The bell sits with the copy/invite cluster at the right edge.
      status: html`${this.gameStartAlert.renderBell()}
      ${copy && invite
        ? html`<div class="flex items-center gap-2">${copy}${invite}</div>`
        : (copy ?? invite)}`,
    });
  }

  // Play/Spectate switch. Hidden once the game is running: the player list is
  // frozen at start, so the server would refuse to seat anyone new and the
  // control would do nothing.
  private renderSpectateToggle() {
    // Any joined lobby can be spectated — a host-started private lobby has no
    // scheduled start (lobbyStartAt null), and gating on it hid the toggle in
    // exactly the lobbies it exists for. The server still refuses seating after
    // start, so no client-side start check is needed here.
    if (this.isConnecting) return html``;
    return uiSegmented({
      name: "spectate",
      ariaLabel: translateText("private_lobby.spectate"),
      fill: true,
      value: this.isSpectating ? "spectate" : "play",
      options: [
        { key: "play", label: translateText("private_lobby.play") },
        { key: "spectate", label: translateText("private_lobby.spectate") },
      ],
      onChange: (key) => this.setSpectating(key === "spectate"),
    });
  }

  protected renderBody() {
    // Pre-join state: show lobby ID input form
    if (!this.currentLobbyId) {
      return this.renderJoinForm();
    }

    // Post-join state: show lobby info (identical for public & private)
    const secondsRemaining =
      this.lobbyStartAt !== null
        ? getSecondsUntilServerTimestamp(
            this.lobbyStartAt,
            this.serverTimeOffset,
          )
        : null;
    const statusLabel =
      secondsRemaining === null
        ? this.isPrivateLobby()
          ? translateText("private_lobby.joined_waiting")
          : translateText("public_lobby.waiting_for_players")
        : secondsRemaining > 0
          ? translateText("public_lobby.starting_in", {
              time: renderDuration(secondsRemaining),
            })
          : translateText("public_lobby.started");
    const maxPlayers = this.gameConfig?.maxPlayers ?? 0;
    // Seats, not connections: spectators are in the roster but hold none.
    const playerCount = this.players?.filter((p) => !p.spectator).length ?? 0;
    const hostClientID = this.isPrivateLobby()
      ? (this.lobbyCreatorClientID ?? "")
      : "";
    const content = html`<div class="p-6">
      ${this.isConnecting
        ? html`<div
            class="flex min-h-[240px] flex-col items-center justify-center gap-4"
          >
            <div
              class="h-10 w-10 animate-spin rounded-full border-4 border-ui-border-strong border-t-ui-accent"
            ></div>
            <p class="ui-body text-center text-ui-muted">
              ${translateText("public_lobby.connecting")}
            </p>
          </div>`
        : html`
            ${this.gameConfig ? this.renderGameConfig() : html``}
            ${this.players.length > 0
              ? html`
                  <lobby-player-view
                    class="mt-6"
                    .gameMode=${this.gameConfig?.gameMode ?? GameMode.FFA}
                    .clients=${this.players}
                    .lobbyCreatorClientID=${hostClientID}
                    .currentClientID=${this.currentClientID}
                    .anonymizeNames=${this.gameConfig?.anonymizeNames ?? false}
                    .teamCount=${this.gameConfig?.playerTeams ?? 2}
                    .isPublicGame=${this.gameConfig?.gameType ===
                    GameType.Public}
                    .nationCount=${nationsConfigToSlider(
                      this.gameConfig?.nations ?? "default",
                      this.nationCount,
                    )}
                  ></lobby-player-view>
                `
              : ""}
          `}
    </div>`;

    const panel = uiDetailPanel({
      body: html`<div data-lobby-status>
          <div class="ui-label">${translateText("public_lobby.status")}</div>
          <div class="ui-heading mt-1 text-ui-text">${statusLabel}</div>
        </div>
        ${maxPlayers > 0
          ? uiDetailRows([
              {
                label: translateText("host_modal.players_in_lobby", {
                  count: playerCount,
                }),
                value: html`<span class="inline-flex items-center gap-2"
                  >${uiIcons.players()} ${playerCount}/${maxPlayers}</span
                >`,
              },
            ])
          : html``}
        ${this.renderSpectateToggle()}`,
    });

    return html`<div class="flex h-full min-h-0 flex-col">
      ${uiTwoColumn({ content, detail: panel })}
    </div>`;
  }

  private renderJoinForm() {
    // The right panel is the form: the lobby ID, a paste button, Spectate, and
    // the page's one main action (Join) pinned at the bottom. The open lobbies
    // are the content on the left.
    const panel = html`<form
      class="contents"
      data-join-form
      @submit=${this.joinLobbyFromInput}
    >
      ${uiDetailPanel({
        body: html`<div>
            <label for="lobbyIdInput" class="ui-label"
              >${translateText("private_lobby.enter_id")}</label
            >
            <div class="mt-2 flex gap-2">
              <input
                type="text"
                id="lobbyIdInput"
                autocomplete="off"
                placeholder=${translateText("private_lobby.enter_id")}
                @keyup=${this.handleChange}
                class="ui-focus ui-mono h-11 min-w-0 flex-1 rounded-ui-card border border-ui-border-strong bg-ui-ground px-4 text-[14px] text-ui-text placeholder:text-ui-placeholder"
              />
              ${uiIconButton({
                icon: uiIcons.clipboard(),
                ariaLabel: translateText("common.paste"),
                name: "paste",
                onClick: () => void this.pasteFromClipboard(),
              })}
            </div>
          </div>
          ${uiButton({
            label: translateText("private_lobby.spectate"),
            variant: "secondary",
            block: true,
            name: "spectate",
            onClick: () => void this.spectateLobbyFromInput(),
          })}`,
        action: uiButton({
          label: translateText("private_lobby.join_lobby"),
          variant: "primary",
          block: true,
          type: "submit",
          name: "join",
        }),
      })}
    </form>`;

    return html`<div class="flex h-full min-h-0 flex-col">
      ${uiTwoColumn({
        content: html`<div class="p-6">${this.renderHostedLobbies()}</div>`,
        detail: panel,
      })}
    </div>`;
  }

  private renderHostedLobbies() {
    let content: TemplateResult;
    if (!this.hostedLobbiesLoaded) {
      content = html`<div class="flex justify-center py-6">
        <div
          class="h-6 w-6 animate-spin rounded-full border-2 border-ui-border-strong border-t-ui-accent"
        ></div>
      </div>`;
    } else if (this.hostedLobbies.length === 0) {
      content = html`<p
        data-open-lobbies-empty
        class="ui-body rounded-ui-card border border-ui-border bg-ui-surface px-4 py-6 text-center text-ui-muted"
      >
        ${translateText("private_lobby.no_open_lobbies")}
      </p>`;
    } else {
      content = html`<div class="flex flex-col gap-3">
        ${this.hostedLobbies.map((lobby) => this.renderHostedLobbyRow(lobby))}
      </div>`;
    }
    return html`
      <section data-config-section="open-lobbies">
        <h2 class="ui-heading mb-4 text-ui-text">
          ${translateText("private_lobby.open_lobbies")}
        </h2>
        ${content}
      </section>
    `;
  }

  private renderHostedLobbyRow(lobby: PublicGameInfo) {
    const c = lobby.gameConfig;
    const mapName = c ? (getMapName(c.gameMap) ?? c.gameMap) : "";
    const thumbnailUrl = c
      ? assetUrl(
          `maps/${encodeURIComponent(normaliseMapKey(c.gameMap))}/thumbnail.webp`,
        )
      : "";
    // Nation count for this map isn't loaded pre-join, so the numeric-nations
    // default comparison is skipped in the row chips.
    const settings = c ? notableLobbySettings(c, null) : [];
    const disabledUnitCount = c?.disabledUnits?.length ?? 0;
    // A featured lobby names itself; the map drops to the subtitle so nothing
    // is lost. Interpolated by lit as TEXT, never markup — emoji render because
    // they are ordinary codepoints, and the accent comes from a closed set so a
    // label can never restyle the rest of the list.
    const featuredLabel = lobby.featured ? lobby.label : undefined;
    const accentClass =
      featuredLabel === undefined
        ? "text-ui-text"
        : {
            gold: "text-ui-gold",
            blue: "text-ui-tier-blue",
            green: "text-ui-success",
            red: "text-ui-accent-soft",
          }[lobby.accent ?? "gold"];
    const subtitle = c ? getGameModeLabel(c) : "";
    // The map name only moves down here when a label has taken the title line.
    const subtitleLine = featuredLabel
      ? [mapName, subtitle].filter(Boolean).join(" · ")
      : subtitle;
    // The host's Start countdown once armed, otherwise the listing deadline.
    const startAt = lobby.startsAt ?? lobby.autoStartAt;
    const secondsToStart =
      startAt === undefined
        ? undefined
        : getSecondsUntilServerTimestamp(startAt, this.hostedServerTimeOffset);
    return html`
      <button
        type="button"
        data-hosted-lobby=${lobby.gameID}
        @click=${() => this.joinHostedLobby(lobby)}
        class="ui-focus flex w-full cursor-pointer items-center gap-4 rounded-ui-card border border-ui-border bg-ui-surface p-4 text-left transition-colors hover:border-ui-border-hover"
      >
        <img
          src=${thumbnailUrl}
          alt=${mapName}
          class="h-14 w-14 shrink-0 rounded-ui-card border border-ui-border object-cover"
          @error=${(e: Event) => {
            (e.target as HTMLImageElement).style.display = "none";
          }}
        />
        <div class="flex min-w-0 flex-1 flex-col gap-1">
          <div class="flex min-w-0 items-center gap-2">
            <span class="ui-body truncate font-bold ${accentClass}"
              >${featuredLabel ?? mapName}</span
            >
            ${lobby.custom
              ? uiBadge(translateText("public_lobby.custom"), "gold")
              : ""}
          </div>
          <span class="ui-body text-[13px] text-ui-muted">${subtitleLine}</span>
          ${settings.length > 0 || disabledUnitCount > 0
            ? html`<div class="mt-1 flex flex-wrap gap-1.5">
                ${settings.map(
                  (s) =>
                    html`<span class="${SETTING_TAG}"
                      >${lobbySettingTagText(s)}</span
                    >`,
                )}
                ${disabledUnitCount > 0
                  ? html`<span class="${SETTING_TAG}"
                      >${translateText("private_lobby.disabled_units")}:
                      ${disabledUnitCount}</span
                    >`
                  : ""}
              </div>`
            : ""}
        </div>
        <div class="flex shrink-0 flex-col items-end gap-1">
          <div
            class="ui-mono flex items-center gap-2 text-[13px] font-semibold text-ui-text"
          >
            ${uiIcons.players()}
            ${lobby.numClients}${c?.maxPlayers ? `/${c.maxPlayers}` : ""}
          </div>
          ${secondsToStart === undefined
            ? ""
            : html`<span
                class="ui-mono text-[12px] font-semibold text-ui-gold"
                title=${translateText("host_modal.auto_start_timer")}
                >${secondsToStart > 0
                  ? renderDuration(secondsToStart)
                  : translateText("public_lobby.starting_game")}</span
              >`}
        </div>
      </button>
    `;
  }

  private async joinHostedLobby(lobby: PublicGameInfo) {
    const lobbyId = lobby.gameID;
    this.startTrackingLobby(lobbyId, lobby);
    try {
      const gameExists = await this.checkActiveLobby(lobbyId);
      if (!gameExists) {
        // The lobby vanished between the broadcast and the click.
        this.resetTrackingState();
        this.showMessage(translateText("private_lobby.not_found"), "red");
      }
    } catch (error) {
      console.error("Error joining hosted lobby:", error);
      this.resetTrackingState();
      this.showMessage(translateText("private_lobby.error"), "red");
    }
  }

  protected onOpen(args?: Record<string, unknown>): void {
    // Re-armed here (not in onClose's reset) so that once
    // disarmLeaveOnClose() runs, no close cascade can re-arm it and
    // disconnect the player mid game-start.
    this.leaveLobbyOnClose = true;
    this.hostedLobbiesLoaded = false;
    void this.hostedLobbySocket.start();
    const lobbyId = typeof args?.lobbyId === "string" ? args.lobbyId : "";
    const lobbyInfo = args?.lobbyInfo as GameInfo | PublicGameInfo | undefined;
    if (lobbyId) {
      this.startTrackingLobby(lobbyId, lobbyInfo);
      // If opened with lobbyId but no lobbyInfo (URL join case), auto-join the lobby
      if (!lobbyInfo) {
        this.handleUrlJoin(lobbyId, args?.spectate === true);
      }
    }
  }

  private async handleUrlJoin(
    lobbyId: string,
    spectator = false,
  ): Promise<void> {
    try {
      const gameExists = await this.checkActiveLobby(lobbyId, spectator);
      if (gameExists) return;

      // A finished game has no lobby to spectate, so both link forms fall
      // through to the same archive: the play link and the spectate link
      // become the same replay once the game is over.
      // Active lobby not found, check if it's an archived game
      switch (await this.checkArchivedGame(lobbyId)) {
        case "success":
          return;
        case "redirected":
          // Navigating to the versioned replay shell; leave state as-is.
          return;
        case "not_found":
          this.resetTrackingState();
          this.showMessage(translateText("private_lobby.not_found"), "red");
          return;
        case "version_mismatch":
          this.resetTrackingState();
          this.showMessage(
            translateText("private_lobby.version_mismatch"),
            "red",
          );
          return;
        case "error":
          this.resetTrackingState();
          this.showMessage(translateText("private_lobby.error"), "red");
          return;
      }
    } catch (error) {
      console.warn("Error checking lobby from URL:", error);
      this.resetTrackingState();
      this.showMessage(translateText("private_lobby.error"), "red");
    }
  }

  private startTrackingLobby(
    lobbyId: string,
    lobbyInfo?: GameInfo | PublicGameInfo,
  ) {
    this.currentLobbyId = lobbyId;
    this.joinCode = "";
    void fetchJoinCode(lobbyId).then((code) => {
      if (code !== null && this.currentLobbyId === lobbyId)
        this.joinCode = code;
    });
    // clientID will be assigned by server via lobby_info message
    this.currentClientID = "";
    this.gameConfig = null;
    this.players = [];
    this.nationCount = 0;
    this.lobbyStartAt = null;
    this.serverTimeOffset = 0;
    this.lobbyCreatorClientID = null;
    this.gameStartAlert.reset();
    this.isConnecting = true;
    this.handledJoinTimeout = false;
    this.startLobbyUpdates();
    if (lobbyInfo) {
      this.updateFromLobby(lobbyInfo);
      // Only stop showing spinner when we have player info
      if ("clients" in lobbyInfo && lobbyInfo.clients) {
        this.isConnecting = false;
      }
    }
  }

  private resetTrackingState() {
    this.stopLobbyUpdates();
    this.currentLobbyId = "";
    this.currentClientID = "";
    this.isConnecting = false;
  }

  private leaveLobby() {
    if (!this.currentLobbyId) {
      return;
    }
    this.dispatchEvent(
      new CustomEvent("leave-lobby", {
        detail: { lobby: this.currentLobbyId },
        bubbles: true,
        composed: true,
      }),
    );
  }

  public confirmBeforeClose(): boolean | Promise<boolean> {
    if (!this.currentLobbyId) return true;
    return this.confirmClose(translateText("host_modal.leave_confirmation"));
  }

  protected onClose(): void {
    this.hostedLobbySocket.stop();
    this.hostedLobbies = [];
    this.hostedLobbiesLoaded = false;
    this.clearCountdownTimer();
    this.stopLobbyUpdates();

    if (this.leaveLobbyOnClose) {
      this.leaveLobby();
      this.updateHistory("/");
    }

    if (this.lobbyIdInput) this.lobbyIdInput.value = "";
    this.gameConfig = null;
    this.players = [];
    this.currentLobbyId = "";
    this.currentClientID = "";
    this.nationCount = 0;
    this.lobbyStartAt = null;
    this.serverTimeOffset = 0;
    this.lobbyCreatorClientID = null;
    this.gameStartAlert.reset();
    this.isConnecting = true;
  }

  disconnectedCallback() {
    this.hostedLobbySocket.stop();
    this.clearCountdownTimer();
    this.stopLobbyUpdates();
    super.disconnectedCallback();
  }

  public closeAndLeave() {
    this.leaveLobby();
    try {
      this.updateHistory("/");
    } catch (error) {
      console.warn("Failed to restore URL on leave:", error);
    }
    this.leaveLobbyOnClose = false;
    this.close();
  }

  // Closing this modal is part of the game-start transition, not the player
  // leaving. Kept separate from closeWithoutLeaving because closing ANY
  // page-modal navigates via showPage, which force-closes the currently
  // visible page — so all lobby modals must be disarmed before any of them
  // is closed.
  public disarmLeaveOnClose() {
    this.leaveLobbyOnClose = false;
  }

  public closeWithoutLeaving() {
    this.disarmLeaveOnClose();
    this.close();
  }

  private updateHistory(url: string): void {
    if (!crazyGamesSDK.isOnCrazyGames()) {
      history.replaceState(null, "", url);
    }
  }

  // --- Game config rendering ---

  private renderGameConfig(): TemplateResult {
    if (!this.gameConfig) return html``;

    const c = this.gameConfig;
    const mapName = getMapName(c.gameMap);
    const normalizedMap = normaliseMapKey(c.gameMap);
    const thumbnailUrl = assetUrl(
      `maps/${encodeURIComponent(normalizedMap)}/thumbnail.webp`,
    );
    const modeSubtitle = getGameModeLabel(c);

    const tags = notableLobbySettings(c, this.nationCount).map(
      (s) =>
        html`<span class="${SETTING_TAG}">${lobbySettingTagText(s)}</span>`,
    );

    // object-contain, not object-cover: the preview is here to be studied
    // while waiting, so a wide or tall map must show whole rather than cropped
    // to the box. max-h keeps a tall map from pushing the player list away.
    // The frame stretches to the height of the settings beside it and centres
    // the map, so a long list of settings leaves no gap under the preview.
    // With no settings to show, the preview takes the whole row.
    return html`
      <div class="mb-4 flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 class="ui-title text-ui-text">${mapName}</h2>
        <span class="ui-body text-ui-muted">${modeSubtitle}</span>
      </div>
      <div class="mb-6 flex flex-col gap-4 sm:flex-row">
        <div
          data-test-map-preview
          class="flex w-full ${tags.length > 0
            ? "sm:w-3/5"
            : ""} shrink-0 items-center justify-center overflow-hidden rounded-ui-card border border-ui-border bg-ui-ground"
        >
          <img
            src=${thumbnailUrl}
            alt=${mapName ?? c.gameMap}
            class="block max-h-60 w-full object-contain"
            @error=${(e: Event) => {
              const frame = (e.target as HTMLElement).parentElement;
              if (frame) frame.style.display = "none";
            }}
          />
        </div>
        ${tags.length > 0
          ? html`<div
              data-test-lobby-settings
              class="flex min-w-0 flex-1 flex-wrap content-start gap-1.5"
            >
              ${tags}
            </div>`
          : html``}
      </div>
      ${this.renderDisabledUnits()} ${this.renderHostCheats()}
    `;
  }

  private renderDisabledUnits(): TemplateResult {
    if (
      !this.gameConfig ||
      !this.gameConfig.disabledUnits ||
      this.gameConfig.disabledUnits.length === 0
    ) {
      return html``;
    }

    const unitKeys: Record<string, string> = {
      City: "unit_type.city",
      Port: "unit_type.port",
      "Defense Post": "unit_type.defense_post",
      "SAM Launcher": "unit_type.sam_launcher",
      "Missile Silo": "unit_type.missile_silo",
      Warship: "unit_type.warship",
      Factory: "unit_type.factory",
      "Atom Bomb": "unit_type.atom_bomb",
      "Hydrogen Bomb": "unit_type.hydrogen_bomb",
      MIRV: "unit_type.mirv",
      Airport: "unit_type.airport",
      Airstrike: "unit_type.airstrike",
      "Trade Ship": "player_stats_table.unit.trade",
      Transport: "player_stats_table.unit.trans",
      "MIRV Warhead": "player_stats_table.unit.mirvw",
    };

    return html`
      <div
        class="mb-6 rounded-ui-card border border-ui-border bg-ui-surface p-4"
      >
        <div class="ui-label mb-3">
          ${translateText("private_lobby.disabled_units")}
        </div>
        <div class="flex flex-wrap gap-2">
          ${this.gameConfig.disabledUnits.map((unit) => {
            const key = unitKeys[unit];
            const name = key ? translateText(key) : unit;
            return html`<span class="${SETTING_TAG} line-through"
              >${name}</span
            >`;
          })}
        </div>
      </div>
    `;
  }

  private renderHostCheats(): TemplateResult {
    if (!this.gameConfig?.hostCheats) {
      return html``;
    }

    const hc = this.gameConfig.hostCheats;
    const items: TemplateResult[] = [];

    if (hc.infiniteGold)
      items.push(
        html`<span class="${CHEAT_TAG}">
          ${translateText("game_settings.infinite_gold")}
        </span>`,
      );
    if (hc.infiniteTroops)
      items.push(
        html`<span class="${CHEAT_TAG}">
          ${translateText("game_settings.infinite_troops")}
        </span>`,
      );
    if (hc.goldMultiplier)
      items.push(
        html`<span class="${CHEAT_TAG}">
          ${translateText("game_settings.gold_multiplier")}:
          x${hc.goldMultiplier}
        </span>`,
      );
    if (hc.startingGold)
      items.push(
        html`<span class="${CHEAT_TAG}">
          ${translateText("private_lobby.starting_gold")}:
          ${parseFloat((hc.startingGold / 1_000_000).toPrecision(12))}M
        </span>`,
      );

    if (items.length === 0) return html``;

    return html`
      <div
        class="mb-6 rounded-ui-card border border-ui-gold/40 bg-ui-gold/10 p-4"
      >
        <div class="ui-label mb-3 text-ui-gold!">
          ${translateText("private_lobby.host_cheats")}
        </div>
        <div class="flex flex-wrap gap-2">${items}</div>
      </div>
    `;
  }

  // --- Lobby event handling ---

  private updateFromLobby(lobby: GameInfo | PublicGameInfo) {
    this.players = "clients" in lobby ? (lobby.clients ?? []) : [];
    if ("serverTime" in lobby && typeof lobby.serverTime === "number") {
      this.serverTimeOffset = calculateServerTimeOffset(lobby.serverTime);
    }
    this.lobbyStartAt = lobby.startsAt ?? null;
    this.syncCountdownTimer();
    if (lobby.gameConfig) {
      const mapChanged = this.gameConfig?.gameMap !== lobby.gameConfig.gameMap;
      this.gameConfig = lobby.gameConfig;
      if (mapChanged) {
        this.loadNationCount();
      }
    }

    this.lobbyCreatorClientID =
      "lobbyCreatorClientID" in lobby
        ? (lobby.lobbyCreatorClientID ?? null)
        : null;
  }

  private startLobbyUpdates() {
    this.stopLobbyUpdates();
    if (!this.eventBus) {
      console.warn(
        "JoinLobbyModal: eventBus not set, cannot subscribe to lobby updates",
      );
      return;
    }
    this.eventBus.on(LobbyInfoEvent, this.handleLobbyInfo);
  }

  private stopLobbyUpdates() {
    this.eventBus?.off(LobbyInfoEvent, this.handleLobbyInfo);
  }

  // --- Countdown timer ---

  private syncCountdownTimer() {
    if (this.lobbyStartAt === null) {
      this.clearCountdownTimer();
      return;
    }
    if (this.countdownTimerId !== null) {
      return;
    }
    this.countdownTimerId = window.setInterval(() => {
      this.checkForJoinTimeout();
      this.requestUpdate();
    }, 1000);
  }

  private clearCountdownTimer() {
    if (this.countdownTimerId === null) {
      return;
    }
    clearInterval(this.countdownTimerId);
    this.countdownTimerId = null;
  }

  private checkForJoinTimeout() {
    if (
      this.handledJoinTimeout ||
      !this.isConnecting ||
      this.lobbyStartAt === null ||
      !this.isModalOpen
    ) {
      return;
    }
    if (getServerNow(this.serverTimeOffset) < this.lobbyStartAt) {
      return;
    }
    this.handledJoinTimeout = true;
    window.dispatchEvent(
      new CustomEvent("show-message", {
        detail: {
          message: translateText("public_lobby.join_timeout"),
          color: "red",
          duration: 3500,
        },
      }),
    );
    this.closeAndLeave();
  }

  // --- Nation count ---

  private async loadNationCount() {
    if (!this.gameConfig) {
      this.nationCount = 0;
      return;
    }
    const currentMap = this.gameConfig.gameMap;
    try {
      const mapData = terrainMapFileLoader.getMapData(currentMap);
      const manifest = await mapData.manifest();
      if (this.gameConfig?.gameMap === currentMap) {
        this.nationCount = manifest.nations.length;
      }
    } catch (error) {
      console.warn("Failed to load nation count", error);
      if (this.gameConfig?.gameMap === currentMap) {
        this.nationCount = 0;
      }
    }
  }

  // --- Private lobby join flow (lobby ID input) ---

  private isValidLobbyId(value: string): boolean {
    return GAME_ID_REGEX.test(value);
  }

  private normalizeLobbyId(input: string): string | null {
    const trimmed = input.trim();
    if (!trimmed) return null;
    const extracted = this.extractLobbyIdFromUrl(trimmed).trim();
    if (!this.isValidLobbyId(extracted)) return null;
    return extracted;
  }

  private sanitizeForLog(value: string): string {
    return value.replace(/[\r\n]/g, "");
  }

  private extractLobbyIdFromUrl(input: string): string {
    if (!input.startsWith("http")) {
      return input;
    }

    try {
      const url = new URL(input);
      const match = url.pathname.match(/game\/([^/]+)/);
      const candidate = match?.[1];
      if (candidate && GAME_ID_REGEX.test(candidate)) return candidate;

      return input;
    } catch (error) {
      console.warn("Failed to parse lobby URL", error);
      return input;
    }
  }

  private setLobbyId(id: string) {
    if (this.lobbyIdInput) {
      this.lobbyIdInput.value = this.extractLobbyIdFromUrl(id);
    }
  }

  private handleChange(e: Event) {
    const value = (e.target as HTMLInputElement).value.trim();
    this.setLobbyId(value);
  }

  private async pasteFromClipboard() {
    try {
      const clipText = await navigator.clipboard.readText();
      this.setLobbyId(clipText);
    } catch (err) {
      console.warn("Failed to read clipboard contents: ", err);
    }
  }

  private joinLobbyFromInput(e: SubmitEvent): Promise<void> {
    e.preventDefault();
    return this.enterLobbyFromInput(false);
  }

  private spectateLobbyFromInput(): Promise<void> {
    return this.enterLobbyFromInput(true);
  }

  private async enterLobbyFromInput(spectator: boolean): Promise<void> {
    // A four-character join code stands for a live lobby's long id.
    const code = normalizeJoinCode(this.lobbyIdInput.value);
    const lobbyId =
      code !== null
        ? await resolveJoinCode(code)
        : this.normalizeLobbyId(this.lobbyIdInput.value);
    if (!lobbyId) {
      this.showMessage(translateText("private_lobby.not_found"), "red");
      return;
    }

    this.lobbyIdInput.value = lobbyId;
    console.log(`Joining lobby with ID: ${this.sanitizeForLog(lobbyId)}`);

    // Initialize tracking state before checking/joining
    this.startTrackingLobby(lobbyId);

    try {
      const gameExists = await this.checkActiveLobby(lobbyId, spectator);
      if (gameExists) return;

      switch (await this.checkArchivedGame(lobbyId)) {
        case "success":
          return;
        case "redirected":
          // Navigating to the versioned replay shell; leave state as-is.
          return;
        case "not_found":
          this.resetTrackingState();
          this.showMessage(translateText("private_lobby.not_found"), "red");
          return;
        case "version_mismatch":
          this.resetTrackingState();
          this.showMessage(
            translateText("private_lobby.version_mismatch"),
            "red",
          );
          return;
        case "error":
          this.resetTrackingState();
          this.showMessage(translateText("private_lobby.error"), "red");
          return;
      }
    } catch (error) {
      console.warn("Error checking lobby existence:", error);
      this.resetTrackingState();
      this.showMessage(translateText("private_lobby.error"), "red");
    }
  }

  private showMessage(message: string, color: "green" | "red" = "green") {
    window.dispatchEvent(
      new CustomEvent("show-message", {
        detail: { message, duration: 3000, color },
      }),
    );
  }

  private async checkActiveLobby(
    lobbyId: string,
    spectator = false,
  ): Promise<boolean> {
    // The id's letter names the game's server in the API's list
    // (multi-server v2); load it before resolving. No version check here:
    // the letter names the server whatever version it runs, and a mismatch
    // is answered at join time (version_mismatch), never by navigating a
    // page that may be mid-game.
    await ensureServerList();
    // The list also says which build the game's server runs. On the web,
    // open the game at THAT version's page rather than probing it with the
    // wrong bundle: true here means a navigation is under way, and the
    // caller should stop as it does for a game it joined. The desktop and
    // replay shells, and the loop-guarded cases, fall through -- the whole
    // rule lives in redirectToGameVersion.
    if (redirectToGameVersion(lobbyId, spectator)) return true;
    const url = `${ClientEnv.gameHttpBase(lobbyId)}/${ClientEnv.gameWorkerPath(lobbyId)}/api/game/${lobbyId}/exists`;

    const response = await fetch(url, {
      method: "GET",
      headers: { "Content-Type": "application/json" },
    });

    if (!response.ok) {
      return false;
    }
    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.includes("application/json")) {
      return false;
    }

    let gameInfo: { exists?: boolean };
    try {
      gameInfo = await response.json();
    } catch (error) {
      console.warn("Failed to parse active lobby response", error);
      return false;
    }

    if (gameInfo.exists) {
      // A spectator can enter a game that is already running, so the usual
      // "waiting for host to start" is wrong for them.
      this.showMessage(
        translateText(
          spectator
            ? "private_lobby.spectating"
            : "private_lobby.joined_waiting",
        ),
      );

      // Use the clientID that was already set by startTrackingLobby in open()
      this.dispatchEvent(
        new CustomEvent("join-lobby", {
          detail: {
            gameID: lobbyId,
            source: "private",
            spectator,
          } as JoinLobbyEvent,
          bubbles: true,
          composed: true,
        }),
      );

      // Event tracking is already started by open() -> startTrackingLobby()
      // LobbyInfoEvents will update the UI as they arrive
      return true;
    }

    return false;
  }

  private async checkArchivedGame(
    lobbyId: string,
  ): Promise<
    "success" | "redirected" | "not_found" | "version_mismatch" | "error"
  > {
    const archiveResponse = await fetch(`${getApiBase()}/game/${lobbyId}`, {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
      },
    });

    if (archiveResponse.status === 404) {
      return "not_found";
    }
    if (archiveResponse.status !== 200) {
      return "error";
    }

    const archiveData = await archiveResponse.json();
    const parsed = GameRecordSchema.safeParse(archiveData);
    if (!parsed.success) {
      return "version_mismatch";
    }

    const gitCommit = ClientEnv.gitCommit();
    if (gitCommit !== "DEV" && parsed.data.gitCommit !== gitCommit) {
      const safeLobbyId = this.sanitizeForLog(lobbyId);
      console.warn(
        `Git commit hash mismatch for game ${safeLobbyId}`,
        archiveData.details,
      );
      if (await this.redirectToVersionedShell(lobbyId)) {
        return "redirected";
      }
      return "version_mismatch";
    }

    // If the modal closes as part of joining the replay, do not leave/reset URL
    this.leaveLobbyOnClose = false;

    // This build can replay it, so open the replay viewer if the player
    // turned it on (and it hasn't sent this game back to the classic replay).
    if (openReplayViewer(lobbyId, parsed.data)) {
      this.close();
      return "success";
    }

    this.dispatchEvent(
      new CustomEvent("join-lobby", {
        detail: {
          gameID: lobbyId,
          gameRecord: parsed.data,
          source: "private",
        } as JoinLobbyEvent,
        bubbles: true,
        composed: true,
      }),
    );
    return "success";
  }

  // The record was produced by a different build. replay.<domain>/<gameId>
  // serves the matching versioned shell (uploaded by update.sh on every
  // deploy); if it exists, navigate there and let that build replay the game
  // (#4934).
  private async redirectToVersionedShell(lobbyId: string): Promise<boolean> {
    const url = await findVersionedShell(
      ClientEnv.jwtAudience(),
      lobbyId,
      window.location.hostname,
    );
    if (url === null) {
      return false;
    }
    window.location.href = url;
    return true;
  }
}
