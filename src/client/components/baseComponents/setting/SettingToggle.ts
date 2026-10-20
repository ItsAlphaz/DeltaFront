import { LitElement, html, nothing } from "lit";
import { customElement, property } from "lit/decorators.js";
import { DESCRIPTION, LABEL, RAINBOW, ROW } from "./SettingStyles";

@customElement("setting-toggle")
export class SettingToggle extends LitElement {
  @property() label = "Setting";
  @property() description = "";
  @property() id = "";
  @property({ type: Boolean, reflect: true }) checked = false;
  @property({ type: Boolean }) easter = false;
  /** Dependent settings use this while their parent setting is off. */
  @property({ type: Boolean, reflect: true }) disabled = false;

  createRenderRoot() {
    return this;
  }

  // `.checked` is a property binding, not `?checked`: once the player has
  // clicked the box, its dirty checkedness flag makes the attribute inert, so
  // an attribute binding could never un-check it again — "Reset to defaults"
  // would leave the box showing the old state.
  private handleChange(e: Event) {
    const input = e.target as HTMLInputElement;
    this.checked = input.checked;
  }

  render() {
    return html`
      <label
        class="${ROW} ${this.disabled
          ? "cursor-not-allowed opacity-50"
          : "cursor-pointer"} ${this.easter ? RAINBOW : ""}"
      >
        <span class="min-w-0 flex-1">
          <span class="${LABEL}">${this.label}</span>
          ${this.description
            ? html`<div class="${DESCRIPTION}">${this.description}</div>`
            : nothing}
        </span>
        <input
          type="checkbox"
          role="switch"
          class="peer sr-only"
          id=${this.id}
          .checked=${this.checked}
          ?disabled=${this.disabled}
          @change=${this.handleChange}
        />
        <span
          aria-hidden="true"
          class="relative h-6 w-11 shrink-0 rounded-full border border-ui-border-strong bg-ui-ground transition-colors peer-checked:border-ui-accent peer-checked:bg-ui-accent peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-ui-accent after:absolute after:left-0.5 after:top-0.5 after:h-[18px] after:w-[18px] after:rounded-full after:bg-ui-text after:transition-transform peer-checked:after:translate-x-5"
        ></span>
      </label>
    `;
  }
}
