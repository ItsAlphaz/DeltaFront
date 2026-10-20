import { html, LitElement, render as litRender } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { translateText } from "../Utils";

/**
 * A reusable inline confirmation / acknowledgement dialog.
 *
 * Usage:
 * ```html
 * <confirm-dialog
 *   .message=${"Are you sure?"}
 *   variant="danger"
 *   @confirm=${() => doThing()}
 *   @cancel=${() => {}}
 * ></confirm-dialog>
 * ```
 *
 * For ban-style flows, add a textarea:
 * ```html
 * <confirm-dialog
 *   .message=${"Ban this player?"}
 *   variant="warning"
 *   textareaPlaceholder="Reason (optional)"
 *   @confirm=${(e) => ban(e.detail.text)}
 *   @cancel=${() => {}}
 * ></confirm-dialog>
 * ```
 */
@customElement("confirm-dialog")
export class ConfirmDialog extends LitElement {
  @property() heading = "";
  @property() message = "";
  @property() variant: "danger" | "warning" = "danger";
  @property() textareaPlaceholder = "";
  @property() confirmText = "";
  @property() cancelText = "";
  @property({ type: Boolean }) disabled = false;
  @property({ type: Boolean }) showClose = false;
  @property({ type: Boolean }) wide = false;
  @property() buttons: "confirmCancel" | "confirmOnly" | "none" =
    "confirmCancel";

  @state() private text = "";

  private portal: HTMLDivElement | null = null;

  createRenderRoot() {
    return this;
  }

  connectedCallback() {
    super.connectedCallback();
    this.portal = document.createElement("div");
    document.body.appendChild(this.portal);
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    if (this.portal) {
      litRender(html``, this.portal);
      this.portal.remove();
      this.portal = null;
    }
  }

  render() {
    if (this.portal) {
      litRender(this.renderOverlay(), this.portal);
    }
    return html``;
  }

  private renderOverlay() {
    const isDanger = this.variant === "danger";
    // The website's dialog (components/ui/PageUi.ts): a bordered panel, a
    // quiet Cancel and one main action. Danger puts the accent on the border
    // and the message; the main action is the accent button either way.
    const borderColor = isDanger
      ? "border-ui-accent"
      : "border-ui-border-strong";
    const textColor = isDanger ? "text-ui-accent-soft" : "text-ui-muted";
    const btnClass =
      "bg-ui-accent text-white border-transparent hover:bg-ui-accent-soft";
    const buttonBase =
      "ui-focus flex-1 min-h-11 px-4 text-[13px] font-semibold uppercase tracking-[0.06em] rounded-ui-card border transition-colors disabled:opacity-50 disabled:pointer-events-none cursor-pointer";

    return html`
      <div
        class="fixed inset-0 z-[10020] flex items-center justify-center bg-black/80 font-ui"
        @click=${(e: Event) => {
          if (e.target === e.currentTarget) this.handleCancel();
        }}
      >
        <div
          class="relative mx-4 w-full ${this.wide
            ? "max-w-md"
            : "max-w-sm"} rounded-ui-panel border ${borderColor} bg-ui-panel p-6 text-ui-text shadow-2xl"
        >
          ${this.showClose
            ? html`<button
                @click=${() => this.handleCancel()}
                aria-label=${translateText("common.close")}
                class="ui-focus absolute top-3 right-3 flex h-9 w-9 items-center justify-center rounded-ui-card text-xl leading-none text-ui-muted transition-colors hover:bg-ui-surface hover:text-ui-text cursor-pointer"
              >
                ×
              </button>`
            : ""}
          ${this.heading
            ? html`<h2 class="ui-heading mb-2 pr-8 text-ui-text">
                ${this.heading}
              </h2>`
            : ""}
          <p class="ui-body mb-5 ${textColor}">${this.message}</p>
          ${this.textareaPlaceholder
            ? html`<textarea
                .value=${this.text}
                @input=${(e: Event) =>
                  (this.text = (e.target as HTMLTextAreaElement).value)}
                maxlength="200"
                rows="2"
                placeholder="${this.textareaPlaceholder}"
                class="ui-focus mb-4 w-full resize-none rounded-ui-card border border-ui-border-strong bg-ui-ground px-3 py-2 text-sm text-ui-text placeholder:text-ui-placeholder"
              ></textarea>`
            : ""}
          ${this.buttons === "none"
            ? ""
            : html`<div class="flex gap-3">
                ${this.buttons === "confirmCancel"
                  ? html`<button
                      @click=${() => this.handleCancel()}
                      ?disabled=${this.disabled}
                      class="${buttonBase} border-ui-border-strong bg-ui-surface text-ui-text hover:border-ui-border-hover"
                    >
                      ${this.cancelText || translateText("common.cancel")}
                    </button>`
                  : ""}
                <button
                  @click=${() => this.handleConfirm()}
                  ?disabled=${this.disabled}
                  class="${buttonBase} ${btnClass}"
                >
                  ${this.confirmText || translateText("common.confirm")}
                </button>
              </div>`}
        </div>
      </div>
    `;
  }

  private handleConfirm() {
    this.dispatchEvent(
      new CustomEvent("confirm", { detail: { text: this.text } }),
    );
    this.text = "";
  }

  private handleCancel() {
    this.dispatchEvent(new CustomEvent("cancel"));
    this.text = "";
  }
}
