import { UserMeResponse } from "@openfront/shared/ApiSchemas";
import { html } from "lit";
import { customElement, state } from "lit/decorators.js";
import { responseHasLinkedIdentity } from "../AccountIdentity";
import { getUserMe } from "../Api";
import { userAuth } from "../Auth";
import { crazyGamesSDK } from "../CrazyGamesSDK";
import type { MatchmakingMode } from "../Matchmaking";
import { translateText } from "../Utils";
import { BaseModal } from "./BaseModal";
import {
  trustLockIcon,
  trustRequiredDialog,
  viewerIsTrusted,
} from "./LobbyCard";
import { uiPageHeader } from "./ui/PageUi";

@customElement("ranked-modal")
export class RankedModal extends BaseModal {
  protected routerName = "ranked";

  @state() private elo: number | string = "...";
  @state() private elo2v2: number | string = "...";
  @state() private eloFfa: number | string = "...";
  @state() private userMeResponse: UserMeResponse | false = false;
  @state() private errorMessage: string | null = null;
  // Hides the trust lock until /users/@me answers, so a trusted player
  // doesn't see it flash red first.
  @state() private loading = true;
  @state() private showTrustRequired = false;
  // CrazyGames players authenticate through the SDK, not a linked
  // Discord/Google/email account, so track that separately for ranked.
  @state() private crazyGamesSignedIn = false;

  // Eligible to see/play ranked: a linked account or a signed-in CrazyGames one.
  private isRankedEligible(): boolean {
    return (
      responseHasLinkedIdentity(this.userMeResponse) || this.crazyGamesSignedIn
    );
  }

  constructor() {
    super();
    this.id = "page-ranked";
  }

  connectedCallback() {
    super.connectedCallback();
    document.addEventListener(
      "userMeResponse",
      this.handleUserMeResponse as EventListener,
    );
  }

  disconnectedCallback() {
    document.removeEventListener(
      "userMeResponse",
      this.handleUserMeResponse as EventListener,
    );
    super.disconnectedCallback();
  }

  private handleUserMeResponse = (
    event: CustomEvent<UserMeResponse | false>,
  ) => {
    this.errorMessage = null;
    this.userMeResponse = event.detail;
    this.updateElo();
  };

  private updateElo() {
    if (this.errorMessage) {
      this.elo = translateText("map_component.error");
      this.elo2v2 = translateText("map_component.error");
      this.eloFfa = translateText("map_component.error");
      return;
    }

    if (this.isRankedEligible()) {
      const leaderboard = this.userMeResponse
        ? this.userMeResponse.player.leaderboard
        : undefined;
      const noElo = translateText("matchmaking_modal.no_elo");
      this.elo = leaderboard?.oneVone?.elo ?? noElo;
      this.elo2v2 = leaderboard?.twoVtwo?.elo ?? noElo;
      this.eloFfa = leaderboard?.ffa?.elo ?? noElo;
    }
  }

  protected override async onOpen(): Promise<void> {
    this.loading = true;
    this.showTrustRequired = false;
    this.elo = "...";
    this.elo2v2 = "...";
    this.eloFfa = "...";
    this.errorMessage = null;

    try {
      const userMe = await getUserMe();
      this.userMeResponse = userMe;
      this.crazyGamesSignedIn =
        crazyGamesSDK.isOnCrazyGames() &&
        (await crazyGamesSDK.getUserProfile()) !== null;
    } catch (error) {
      console.warn("Failed to fetch user profile for ranked modal", error);
      this.userMeResponse = false;
      this.errorMessage = translateText("map_component.error");
      this.elo = translateText("map_component.error");
      this.elo2v2 = translateText("map_component.error");
      this.eloFfa = translateText("map_component.error");
    } finally {
      this.loading = false;
      this.updateElo();
    }
  }

  createRenderRoot() {
    return this;
  }

  protected renderHeaderSlot() {
    return uiPageHeader({
      title: translateText("mode_selector.ranked_title"),
      onBack: () => this.close(),
      backLabel: translateText("common.back"),
    });
  }

  protected renderBody() {
    return html`
      <div class="p-6">
        <div class="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          ${this.renderCard(
            translateText("mode_selector.ranked_1v1_title"),
            this.errorMessage ??
              (this.isRankedEligible()
                ? translateText("matchmaking_modal.elo", { elo: this.elo })
                : translateText("mode_selector.ranked_title")),
            () => this.handleRanked("1v1"),
          )}
          ${this.renderCard(
            translateText("mode_selector.ranked_2v2_title"),
            this.errorMessage ??
              (this.isRankedEligible()
                ? translateText("matchmaking_modal.elo", { elo: this.elo2v2 })
                : translateText("mode_selector.ranked_title")),
            () => this.handleRanked("2v2"),
          )}
          ${this.renderCard(
            translateText("mode_selector.ranked_ffa_title"),
            this.errorMessage ??
              (this.isRankedEligible()
                ? translateText("matchmaking_modal.elo", { elo: this.eloFfa })
                : translateText("mode_selector.ranked_title")),
            () => this.handleRanked("ffa"),
          )}
          ${this.renderDisabledCard(
            translateText("mode_selector.coming_soon"),
            "",
          )}
        </div>
        <p
          class="ui-body mt-6 max-w-3xl text-[13px] leading-relaxed text-ui-muted"
        >
          ${translateText("mode_selector.ranked_pairing_note")}
        </p>
        ${this.showTrustRequired
          ? trustRequiredDialog(
              this.isRankedEligible(),
              () => (this.showTrustRequired = false),
              "ranked",
            )
          : ""}
      </div>
    `;
  }

  private renderCard(title: string, subtitle: string, onClick: () => void) {
    // Ranked admits trusted accounts only: a green open lock when the
    // player's account is trusted, a red closed one otherwise.
    const lock = this.trustKnown()
      ? trustLockIcon(viewerIsTrusted(this.userMeResponse), {
          tooltipTitle: translateText(
            "mode_selector.ranked_trust_tooltip_title",
          ),
        })
      : "";
    return html`
      <button
        type="button"
        data-ranked-card
        @click=${onClick}
        class="ui-focus relative flex h-32 w-full cursor-pointer flex-col items-center justify-center gap-2 rounded-ui-card border border-ui-border bg-ui-surface p-6 text-center transition-colors hover:border-ui-border-hover"
      >
        <h3 class="ui-title text-ui-text">${title}</h3>
        <p class="ui-label whitespace-pre-line">${subtitle}</p>
        ${lock}
      </button>
    `;
  }

  private renderDisabledCard(title: string, subtitle: string) {
    return html`
      <div
        class="relative flex h-32 w-full cursor-not-allowed flex-col items-center justify-center gap-2 rounded-ui-card border border-dashed border-ui-border-strong p-6 text-center opacity-60"
      >
        <h3 class="ui-title text-ui-muted">${title}</h3>
        <p class="ui-label whitespace-pre-line">${subtitle}</p>
      </div>
    `;
  }

  // Whether /users/@me has answered, so the trust tier can be read.
  private trustKnown(): boolean {
    return !this.loading && this.errorMessage === null;
  }

  private async handleRanked(mode: MatchmakingMode) {
    // Ranked admits trusted accounts only; the popup says how to get there
    // (sign in first when signed out). Unknown tier: the service decides.
    if (this.trustKnown() && !viewerIsTrusted(this.userMeResponse)) {
      this.showTrustRequired = true;
      return;
    }
    if ((await userAuth()) === false) {
      this.close();
      window.showPage?.("page-account");
      return;
    }

    document.dispatchEvent(
      new CustomEvent("open-matchmaking", { detail: { mode } }),
    );
  }
}
