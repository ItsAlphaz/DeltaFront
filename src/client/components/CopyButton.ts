import { LitElement, html, type TemplateResult } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { ClientEnv } from "src/client/ClientEnv";
import { crazyGamesSDK } from "../CrazyGamesSDK";
import { UserSettings } from "../UserSettings";
import { copyToClipboard, showToast, translateText } from "../Utils";

@customElement("copy-button")
export class CopyButton extends LitElement {
  @property({ type: String, attribute: "lobby-id" }) lobbyId = "";
  @property({ type: String, attribute: "lobby-suffix" }) lobbySuffix = "";
  @property({ type: Boolean, attribute: "include-lobby-query" })
  includeLobbyQuery = false;
  @property({ type: String, attribute: "copy-text" }) copyText = "";
  @property({ type: String, attribute: "display-text" }) displayText = "";
  // Rich label override (e.g. a username split into colored base and
  // discriminator). Takes precedence over displayText when set; displayText
  // should still be passed as the plain-text equivalent for the masked and
  // "copied" states.
  @property({ attribute: false }) displayContent: TemplateResult | null = null;
  @property({ type: Boolean, attribute: "show-visibility-toggle" })
  showVisibilityToggle = true;
  @property({ type: Boolean, attribute: "show-copy-icon" })
  showCopyIcon = true;
  @property({ type: Boolean }) compact = false;
  /** The lobby's short join code: shown in place of the long id, which the copy still carries. */
  @property({ type: String, attribute: "join-code" }) joinCode = "";
  /** A small label before the code ("CODE"). */
  @property({ type: String }) heading = "";

  @state() private lobbyIdVisible = true;

  private userSettings: UserSettings = new UserSettings();
  private maskLabel = html`&bull;&bull;&bull;&bull;&bull;&bull;&bull;&bull;`;

  createRenderRoot() {
    return this;
  }

  protected willUpdate(
    changedProperties: Map<string | number | symbol, unknown>,
  ) {
    if (changedProperties.has("lobbyId")) {
      this.lobbyIdVisible = this.userSettings.lobbyIdVisibility();
    }
    if (
      changedProperties.has("showVisibilityToggle") ||
      changedProperties.has("compact")
    ) {
      if (!this.showVisibilityToggle || this.compact) {
        this.lobbyIdVisible = true;
      }
    }
  }

  private toggleVisibility() {
    if (!this.showVisibilityToggle || this.compact) return;
    this.lobbyIdVisible = !this.lobbyIdVisible;
  }

  private enableSelectAll(e: Event) {
    (e.currentTarget as HTMLElement).classList.add("select-all");
  }

  private clearSelectAll(e: Event) {
    (e.currentTarget as HTMLElement).classList.remove("select-all");
  }

  private async buildCopyUrl(): Promise<string> {
    // ClientEnv.shareOrigin(), not window.location: this string goes to the
    // clipboard and then to another player, and under the desktop shell the
    // document's own origin is `app://openfront` — a link only that one
    // Electron process can open. See deriveShareOrigin.
    let url = `${ClientEnv.shareOrigin()}${ClientEnv.gamePath(this.lobbyId)}`;
    if (this.includeLobbyQuery) {
      url += `?lobby&s=${encodeURIComponent(this.lobbySuffix)}`;
    }
    return url;
  }

  private async resolveCopyText(): Promise<string | null> {
    if (this.copyText) return this.copyText;
    if (crazyGamesSDK.isOnCrazyGames()) {
      return crazyGamesSDK.createInviteLink(this.lobbyId);
    }
    if (!this.lobbyId) return "";
    return await this.buildCopyUrl();
  }

  async handleCopy() {
    const text = await this.resolveCopyText();
    if (!text) {
      showToast(translateText("common.failed_copy"), "red");
      return;
    }

    try {
      await copyToClipboard(text);
      showToast(translateText("common.copied"), "green");
    } catch {
      showToast(translateText("common.failed_copy"), "red");
    }
  }

  private canCopy() {
    return Boolean(this.copyText || this.lobbyId);
  }

  render() {
    const canCopy = this.canCopy();
    const allowMask = this.showVisibilityToggle && !this.compact;
    const rawLabel =
      this.displayContent ??
      (this.displayText || this.joinCode || this.lobbyId || this.copyText);
    const label = allowMask && !this.lobbyIdVisible ? this.maskLabel : rawLabel;
    const disabledClass = canCopy ? "" : "opacity-60 cursor-not-allowed";
    const toggleDisabled = !this.lobbyId;
    const toggleClass = toggleDisabled ? "opacity-60 cursor-not-allowed" : "";

    if (this.compact) {
      return html`
        <button
          @click=${this.handleCopy}
          class="ui-focus ui-mono rounded-[6px] border border-ui-border bg-ui-surface px-2 py-0.5 text-[12px] text-ui-muted transition-colors hover:border-ui-border-hover hover:text-ui-text ${disabledClass}"
          title="${translateText("common.click_to_copy")}"
          aria-label="${translateText("common.click_to_copy")}"
          ?disabled=${!canCopy}
          type="button"
        >
          ${label}
        </button>
      `;
    }

    return html`
      <div
        class="flex h-11 max-w-[320px] flex-nowrap items-center gap-1 rounded-ui-card border border-ui-border-strong bg-ui-surface px-3"
      >
        ${this.heading
          ? html`<span class="ui-label mr-1 shrink-0">${this.heading}</span>`
          : ""}
        <button
          @click=${this.handleCopy}
          @dblclick=${this.enableSelectAll}
          @mouseleave=${this.clearSelectAll}
          class="ui-focus ui-mono min-w-[80px] cursor-pointer select-none truncate border-0 bg-transparent px-2 text-center text-[14px] font-semibold tracking-wider text-ui-text ${disabledClass}"
          title="${translateText("common.click_to_copy")}"
          aria-label="${translateText("common.click_to_copy")}"
          ?disabled=${!canCopy}
          type="button"
        >
          ${label}
        </button>
        ${this.showVisibilityToggle
          ? html`<button
              @click=${this.toggleVisibility}
              class="ui-focus flex h-9 w-9 items-center justify-center rounded-[8px] text-ui-muted transition-colors hover:text-ui-text cursor-pointer ${toggleClass}"
              title="${translateText("user_setting.toggle_visibility")}"
              ?disabled=${toggleDisabled}
              type="button"
            >
              ${this.lobbyIdVisible
                ? html`<svg
                    viewBox="0 0 512 512"
                    height="16px"
                    width="16px"
                    fill="currentColor"
                  >
                    <path
                      d="M256 105c-101.8 0-188.4 62.7-224 151 35.6 88.3 122.2 151 224 151s188.4-62.7 224-151c-35.6-88.3-122.2-151-224-151zm0 251.7c-56 0-101.7-45.7-101.7-101.7S200 153.3 256 153.3 357.7 199 357.7 255 312 356.7 256 356.7zm0-161.1c-33 0-59.4 26.4-59.4 59.4s26.4 59.4 59.4 59.4 59.4-26.4 59.4-59.4-26.4-59.4-59.4-59.4z"
                    ></path>
                  </svg>`
                : html`<svg
                    viewBox="0 0 512 512"
                    height="16px"
                    width="16px"
                    fill="currentColor"
                  >
                    <path
                      d="M448 256s-64-128-192-128S64 256 64 256c32 64 96 128 192 128s160-64 192-128z"
                      fill="none"
                      stroke="currentColor"
                      stroke-width="32"
                    ></path>
                    <path
                      d="M144 256l224 0"
                      fill="none"
                      stroke="currentColor"
                      stroke-width="32"
                      stroke-linecap="round"
                    ></path>
                  </svg>`}
            </button>`
          : ""}
        ${this.showCopyIcon
          ? html`<button
              @click=${this.handleCopy}
              class="ui-focus flex h-9 items-center gap-1.5 rounded-[8px] px-2 text-[13px] font-semibold text-ui-muted transition-colors hover:text-ui-text cursor-pointer ${disabledClass}"
              title="${translateText("common.click_to_copy")}"
              aria-label="${translateText("common.click_to_copy")}"
              ?disabled=${!canCopy}
              type="button"
            >
              <svg
                viewBox="0 0 24 24"
                height="16px"
                width="16px"
                fill="currentColor"
                aria-hidden="true"
              >
                <path
                  d="M16 1H4c-1.1 0-2 .9-2 2v12h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z"
                />
              </svg>
              <span class="hidden sm:inline"
                >${translateText("common.copy")}</span
              >
            </button>`
          : ""}
      </div>
    `;
  }
}
