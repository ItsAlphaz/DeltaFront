import { html } from "lit";
import { customElement } from "lit/decorators.js";
import { tempTokenLogin } from "./Auth";
import { BaseModal } from "./components/BaseModal";
import "./components/Difficulties";
import { modalHeader } from "./components/ui/ModalHeader";
import { showInGameAlert } from "./InGameModal";
import { translateText } from "./Utils";

@customElement("token-login")
export class TokenLoginModal extends BaseModal {
  private isAttemptingLogin = false;

  private retryInterval: NodeJS.Timeout | undefined = undefined;

  private successTimeout: ReturnType<typeof setTimeout> | undefined;

  private loginGeneration = 0;

  private token: string | null = null;

  private email: string | null = null;

  private attemptCount = 0;

  constructor() {
    super();
  }

  protected modalConfig() {
    return { maxWidth: "620px" };
  }

  protected renderHeaderSlot() {
    return modalHeader({
      title: translateText("token_login_modal.title"),
      onBack: () => this.close(),
      ariaLabel: translateText("common.back"),
    });
  }

  protected renderBody() {
    return html`
      <div class="flex-1 flex flex-col gap-4 p-6">
        ${this.email ? this.loginSuccess(this.email) : this.loggingIn()}
      </div>
    `;
  }

  private loggingIn() {
    const loggingText = translateText("token_login_modal.title");
    return html`
      <div class="flex items-center gap-4">
        <div
          class="flex h-12 w-12 items-center justify-center rounded-full border border-ui-accent/40 bg-ui-accent-tint"
        >
          <div
            class="h-6 w-6 animate-spin rounded-full border-2 border-ui-border-strong border-t-ui-accent"
          ></div>
        </div>
        <div class="flex flex-col gap-2">
          <p class="ui-heading text-ui-text">${loggingText}</p>
          <div
            class="h-1 w-full overflow-hidden rounded-full bg-ui-border-strong"
          >
            <div class="h-full w-1/2 animate-pulse bg-ui-accent"></div>
          </div>
        </div>
      </div>
    `;
  }

  private loginSuccess(email: string) {
    const successText = translateText("token_login_modal.success", { email });
    return html`
      <div class="flex items-center gap-4">
        <div
          class="flex h-12 w-12 items-center justify-center rounded-full border border-ui-success/40 bg-ui-success/10"
        >
          <div class="h-2 w-2 animate-pulse rounded-full bg-ui-success"></div>
        </div>
        <p class="ui-body text-ui-text">${successText}</p>
      </div>
    `;
  }

  public openWithToken(token: string): void {
    this.token = token;
    this.open();
  }

  public open(args?: Record<string, unknown>): void {
    if (!this.token) {
      return;
    }
    super.open(args);
  }

  protected onOpen(): void {
    this.loginGeneration++;
    this.email = null;
    this.attemptCount = 0;
    this.isAttemptingLogin = false;
    clearInterval(this.retryInterval);
    clearTimeout(this.successTimeout);
    this.requestUpdate();
    this.retryInterval = setInterval(() => this.tryLogin(), 3000);
    void this.tryLogin();
  }

  protected onClose(): void {
    this.loginGeneration++;
    this.token = null;
    clearInterval(this.retryInterval);
    clearTimeout(this.successTimeout);
    this.attemptCount = 0;
    this.isAttemptingLogin = false;
  }

  private async tryLogin() {
    const generation = this.loginGeneration;
    if (this.isAttemptingLogin) {
      return;
    }
    if (this.attemptCount > 3) {
      this.close();
      void showInGameAlert(translateText("error_modal.login_failed"));
      return;
    }
    this.attemptCount++;
    this.isAttemptingLogin = true;
    if (this.token === null) {
      this.close();
      return;
    }
    try {
      const result = await tempTokenLogin(this.token);
      if (generation !== this.loginGeneration) {
        return;
      }
      if (result.status === "retry") {
        return;
      }
      if (result.status === "failed") {
        // Permanent failures cannot succeed with another attempt.
        clearInterval(this.retryInterval);
        this.close();
        const messageKey = {
          consumed: "error_modal.login_token_consumed",
          expired: "error_modal.login_token_expired",
          invalid: "error_modal.login_token_invalid",
          email_exists: "error_modal.login_token_email_exists",
          deleted: "error_modal.login_token_deleted",
          wrong_browser: "error_modal.login_token_wrong_browser",
        }[result.code];
        void showInGameAlert(translateText(messageKey));
        return;
      }
      this.email = result.email;
      clearInterval(this.retryInterval);
      this.successTimeout = setTimeout(() => {
        if (generation !== this.loginGeneration) {
          return;
        }
        this.close();
        window.location.reload();
      }, 1000);
      this.requestUpdate();
    } catch (e) {
      if (generation === this.loginGeneration) {
        console.error(e);
      }
    } finally {
      if (generation === this.loginGeneration) {
        this.isAttemptingLogin = false;
      }
    }
  }
}
