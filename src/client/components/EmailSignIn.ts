import { LitElement, html, nothing } from "lit";
import { customElement, state } from "lit/decorators.js";
import { requestMagicLink } from "../Auth";
import { translateText } from "../Utils";
import "./baseComponents/Button";

type Phase = "idle" | "sending" | "sent" | "error";

/**
 * The email magic-link form (milestone M8), shown by the sign-in screen and
 * the account settings only when email sign-in is on (AUTH_PROVIDERS.email).
 *
 * One address, one button, and one status line that says only what is true for
 * every address: a link is on its way *if* the address can receive mail. The
 * server answers the same whether or not the address has an account, so
 * neither does this form. Checking the address here is a convenience; the
 * server checks it again.
 */
@customElement("email-sign-in")
export class EmailSignIn extends LitElement {
  @state() private email = "";
  @state() private phase: Phase = "idle";
  @state() private messageKey = "";

  createRenderRoot() {
    return this;
  }

  render() {
    const sending = this.phase === "sending";
    return html`
      <div class="space-y-3" data-email-sign-in>
        <input
          type="email"
          name="email"
          autocomplete="email"
          inputmode="email"
          maxlength="254"
          .value=${this.email}
          ?disabled=${sending}
          aria-invalid=${this.phase === "error" ? "true" : "false"}
          aria-describedby="email-sign-in-status"
          @input=${this.onInput}
          @keydown=${this.onKeydown}
          placeholder=${translateText("account_modal.email_placeholder")}
          class="w-full px-4 py-3 bg-white/5 border border-white/10 rounded-xl text-white placeholder-white/20 focus:outline-none focus:ring-2 focus:ring-df-red/50 focus:border-df-red/50 transition-all font-medium hover:bg-white/10 disabled:opacity-60"
        />
        <o-button
          variant="primary"
          width="block"
          size="md"
          translationKey=${sending
            ? "account_modal.sending_magic_link"
            : "account_modal.get_magic_link"}
          ?disable=${sending}
          @click=${this.submit}
        ></o-button>
        <p
          id="email-sign-in-status"
          role="status"
          aria-live="polite"
          data-email-status=${this.phase}
          class=${this.phase === "error"
            ? "text-sm text-df-red"
            : "text-sm text-white/70"}
        >
          ${this.messageKey === "" ? nothing : translateText(this.messageKey)}
        </p>
      </div>
    `;
  }

  private onInput(e: Event) {
    this.email = (e.target as HTMLInputElement).value;
    if (this.phase === "error") {
      this.phase = "idle";
      this.messageKey = "";
    }
  }

  private onKeydown(e: KeyboardEvent) {
    if (e.key === "Enter") {
      e.preventDefault();
      void this.submit();
    }
  }

  private async submit() {
    if (this.phase === "sending") return;
    const email = this.email.trim();
    if (email === "") {
      this.fail("account_modal.enter_email_address");
      return;
    }
    // Loose on purpose (the server is the judge): something@something.something.
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
      this.fail("account_modal.invalid_email");
      return;
    }
    this.phase = "sending";
    this.messageKey = "";
    const result = await requestMagicLink(email);
    switch (result.status) {
      case "sent":
        this.phase = "sent";
        this.messageKey = "account_modal.magic_link_sent";
        return;
      case "invalid_email":
        return this.fail("account_modal.invalid_email");
      case "rate_limited":
        return this.fail("account_modal.magic_link_rate_limited");
      default:
        return this.fail("account_modal.magic_link_failed");
    }
  }

  private fail(messageKey: string) {
    this.phase = "error";
    this.messageKey = messageKey;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "email-sign-in": EmailSignIn;
  }
}
