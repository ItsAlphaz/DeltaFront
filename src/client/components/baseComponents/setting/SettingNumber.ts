import { LitElement, html, nothing } from "lit";
import { customElement, property } from "lit/decorators.js";
import { DESCRIPTION, FIELD, LABEL, RAINBOW, ROW } from "./SettingStyles";

@customElement("setting-number")
export class SettingNumber extends LitElement {
  @property() label = "Setting";
  @property() description = "";
  @property({ type: Number }) value = 0;
  @property({ type: Number }) min = 0;
  @property({ type: Number }) max = 100;
  @property({ type: Boolean }) easter = false;

  createRenderRoot() {
    return this;
  }

  private handleInput(e: Event) {
    const input = e.target as HTMLInputElement;
    const newValue = Number(input.value);
    this.value = newValue;

    this.dispatchEvent(
      new CustomEvent("change", {
        detail: { value: newValue },
        bubbles: true,
        composed: true,
      }),
    );
  }

  render() {
    return html`
      <div class="${ROW} ${this.easter ? RAINBOW : ""}">
        <div class="min-w-0 flex-1">
          <label class="${LABEL}" for="setting-number-input"
            >${this.label}</label
          >
          ${this.description
            ? html`<div class="${DESCRIPTION}">${this.description}</div>`
            : nothing}
        </div>
        <input
          type="number"
          id="setting-number-input"
          class="${FIELD} w-[100px] shrink-0 text-center"
          .value=${String(this.value ?? 0)}
          min=${this.min}
          max=${this.max}
          @input=${this.handleInput}
        />
      </div>
    `;
  }
}
