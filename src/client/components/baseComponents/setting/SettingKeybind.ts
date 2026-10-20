import { LitElement, html, nothing } from "lit";
import { customElement, property } from "lit/decorators.js";
import { formatKeyForDisplay, translateText } from "../../../../client/Utils";
import { DESCRIPTION, LABEL, RAINBOW, ROW } from "./SettingStyles";

@customElement("setting-keybind")
export class SettingKeybind extends LitElement {
  @property() label = "Setting";
  @property() description = "";
  @property({ type: String, reflect: true }) action = "";
  @property({ type: String }) defaultKey = "";
  @property({ type: String }) value = "";
  @property({ type: String }) display = "";
  @property({ type: Boolean }) easter = false;

  createRenderRoot() {
    return this;
  }

  private listening = false;

  render() {
    const currentValue = this.value === "" ? "" : this.value || this.defaultKey;
    const canReset = this.value !== undefined && this.value !== this.defaultKey;
    const displayValue = this.display || currentValue;
    const smallButton =
      "ui-focus min-h-8 rounded-ui-card border border-ui-border-strong bg-ui-surface px-3 text-[11px] font-semibold uppercase tracking-[0.08em] text-ui-muted transition-colors hover:border-ui-border-hover hover:text-ui-text";

    return html`
      <div class="${ROW} ${this.easter ? RAINBOW : ""}">
        <div class="min-w-0 flex-1">
          <label class="${LABEL}">${this.label}</label>
          ${this.description
            ? html`<div class="${DESCRIPTION}">${this.description}</div>`
            : nothing}
        </div>

        <div class="flex shrink-0 items-center gap-3">
          <div
            class="ui-focus ui-mono relative flex h-11 min-w-[80px] cursor-pointer select-none items-center justify-center rounded-ui-card border bg-ui-ground px-4 text-[16px] font-bold text-ui-text transition-colors hover:border-ui-border-hover ${this
              .listening
              ? "border-ui-accent text-ui-accent-soft"
              : "border-ui-border-strong"}"
            role="button"
            aria-label="${translateText("user_setting.press_a_key")}"
            tabindex="0"
            @keydown=${this.handleKeydown}
            @click=${this.startListening}
            @blur=${this.handleBlur}
          >
            ${this.listening ? "..." : this.displayKey(displayValue)}
          </div>

          <div class="flex flex-col gap-1">
            <button
              class="${smallButton} ${canReset
                ? ""
                : "pointer-events-none cursor-not-allowed opacity-50"}"
              @click=${this.resetToDefault}
              ?disabled=${!canReset}
            >
              ${translateText("user_setting.reset")}
            </button>
            <button class="${smallButton}" @click=${this.unbindKey}>
              ${translateText("user_setting.unbind")}
            </button>
          </div>
        </div>
      </div>
    `;
  }

  private displayKey(key: string): string {
    if (!key || key === "Null") return translateText("common.none");
    return formatKeyForDisplay(key);
  }

  private startListening() {
    this.listening = true;
    this.requestUpdate();
  }

  private handleKeydown(e: KeyboardEvent) {
    if (!this.listening) return;

    if (e.key === "Escape") {
      // Cancel listening on Escape without bubbling to close parent modals
      e.preventDefault();
      e.stopPropagation();
      this.listening = false;
      this.requestUpdate();
      return;
    }

    // Allow Tab to work normally (don't trap focus)
    if (e.key === "Tab") {
      return;
    }

    // Don't capture lone modifier keys — wait for the actual key
    if (
      e.code === "ShiftLeft" ||
      e.code === "ShiftRight" ||
      e.code === "ControlLeft" ||
      e.code === "ControlRight" ||
      e.code === "AltLeft" ||
      e.code === "AltRight" ||
      e.code === "MetaLeft" ||
      e.code === "MetaRight"
    ) {
      return;
    }

    // Prevent default only for keys we're actually capturing
    e.preventDefault();

    const code = e.shiftKey ? `Shift+${e.code}` : e.code;
    const displayKey = e.shiftKey ? `Shift+${e.key.toUpperCase()}` : e.key;
    const prevValue = this.value;

    // Temporarily set the value to the new code for validation in parent
    this.value = code;

    const event = new CustomEvent("change", {
      detail: { action: this.action, value: code, key: displayKey, prevValue },
      bubbles: true,
      composed: true,
    });
    this.dispatchEvent(event);

    // If parent rejects (restores value), this.value will be set back externally
    // Otherwise, keep the new value
    this.listening = false;
    this.requestUpdate();
  }

  private handleBlur() {
    this.listening = false;
    this.requestUpdate();
  }

  private resetToDefault() {
    this.value = this.defaultKey;
    this.dispatchEvent(
      new CustomEvent("change", {
        detail: {
          action: this.action,
          value: this.defaultKey,
        },
        bubbles: true,
        composed: true,
      }),
    );
  }

  private unbindKey() {
    this.value = "Null";
    this.dispatchEvent(
      new CustomEvent("change", {
        detail: {
          action: this.action,
          value: "Null",
          key: "",
        },
        bubbles: true,
        composed: true,
      }),
    );
    this.requestUpdate();
  }
}
