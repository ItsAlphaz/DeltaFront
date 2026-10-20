import { html, LitElement, nothing } from "lit";
import { customElement, property } from "lit/decorators.js";
import { DESCRIPTION, LABEL, ROW } from "./SettingStyles";

/**
 * A labelled color swatch, shaped like the other setting-* rows.
 *
 * Emits `change` with the picked `#rrggbb` string. A native color input only
 * ever produces a complete six-digit hex, but the value is forwarded verbatim
 * and validated by the host — the same input is reachable by keyboard in some
 * browsers, where a partial value can surface mid-edit.
 */
@customElement("setting-color")
export class SettingColor extends LitElement {
  @property() label = "Setting";
  @property() description = "";
  @property() value = "#000000";

  createRenderRoot() {
    return this;
  }

  private handleInput(e: Event) {
    const input = e.target as HTMLInputElement;
    this.value = input.value;
    this.dispatchEvent(
      new CustomEvent("change", {
        detail: { value: input.value },
        bubbles: true,
        composed: true,
      }),
    );
  }

  render() {
    return html`
      <div class="${ROW}">
        <div class="min-w-0 flex-1">
          <span class="${LABEL}">${this.label}</span>
          ${this.description
            ? html`<div class="${DESCRIPTION}">${this.description}</div>`
            : nothing}
        </div>
        <input
          type="color"
          aria-label=${this.label}
          .value=${this.value}
          @input=${this.handleInput}
          class="ui-focus h-10 w-12 shrink-0 cursor-pointer rounded-ui-card border border-ui-border-strong bg-transparent"
        />
      </div>
    `;
  }
}
