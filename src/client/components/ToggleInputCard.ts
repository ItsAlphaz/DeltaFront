import { LitElement, PropertyValues, html, nothing } from "lit";
import { customElement, property } from "lit/decorators.js";
import { translateText } from "../Utils";
import {
  INPUT_CLASS,
  ROW_LABEL_CLASS,
  VALUE_ROW_CLASS,
} from "./InputCardStyles";

@customElement("toggle-input-card")
export class ToggleInputCard extends LitElement {
  @property({ attribute: false }) labelKey = "";
  @property({ type: Boolean, attribute: false }) checked = false;
  @property({ attribute: false }) inputId?: string;
  @property({ attribute: false }) inputType = "number";
  @property({ attribute: false }) inputMin?: number | string;
  @property({ attribute: false }) inputMax?: number | string;
  @property({ attribute: false }) inputStep?: number | string;
  @property({ attribute: false }) inputValue?: number | string;
  @property({ attribute: false }) inputAriaLabel?: string;
  @property({ attribute: false }) inputPlaceholder?: string;
  // Optional hint shown under the input when its value is 0 (e.g. "Disabled"),
  // so a 0 that means "off" isn't cryptic.
  @property({ attribute: false }) zeroLabel?: string;
  @property({ attribute: false }) defaultInputValue?: number | string;
  @property({ attribute: false }) minValidOnEnable?: number;
  @property({ attribute: false }) onToggle?: (
    checked: boolean,
    value: number | string | undefined,
  ) => void;
  @property({ attribute: false }) onInput?: (e: Event) => void;
  @property({ attribute: false }) onChange?: (e: Event) => void;
  @property({ attribute: false }) onKeyDown?: (e: KeyboardEvent) => void;

  createRenderRoot() {
    return this;
  }

  // Autofocus + select the number input when the card is toggled on. Safe now
  // that the input is always mounted (focusing a freshly-inserted one janked).
  protected updated(changedProperties: PropertyValues<this>) {
    if (!changedProperties.has("checked")) return;
    if (changedProperties.get("checked") === false && this.checked) {
      const input = this.querySelector("input");
      input?.focus();
      input?.select();
    }
  }

  private toOptionalNumber(
    value: number | string | undefined,
  ): number | undefined {
    if (typeof value === "number") {
      return Number.isFinite(value) ? value : undefined;
    }
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (!trimmed) return undefined;
      const numeric = Number(trimmed);
      return Number.isFinite(numeric) ? numeric : undefined;
    }
    return undefined;
  }

  private resolveValueOnEnable(): number | string | undefined {
    const currentValue = this.inputValue;

    if (
      currentValue === undefined ||
      currentValue === null ||
      currentValue === ""
    ) {
      return this.defaultInputValue;
    }

    if (this.minValidOnEnable === undefined) {
      return currentValue;
    }

    const numericValue = this.toOptionalNumber(currentValue);
    if (numericValue === undefined || numericValue < this.minValidOnEnable) {
      return this.defaultInputValue;
    }

    return numericValue;
  }

  private emitToggle() {
    const nextChecked = !this.checked;
    const nextValue = nextChecked ? this.resolveValueOnEnable() : undefined;
    this.onToggle?.(nextChecked, nextValue);
  }

  private handleCardClick = () => {
    this.emitToggle();
  };

  render() {
    return html`
      <div data-ui="value-row" class="${VALUE_ROW_CLASS}">
        <button
          type="button"
          aria-pressed=${this.checked}
          @click=${this.handleCardClick}
          class="ui-focus flex min-w-0 flex-1 cursor-pointer items-center gap-3 text-left"
        >
          <span
            aria-hidden="true"
            class="flex h-5 w-5 shrink-0 items-center justify-center rounded-[5px] border transition-colors ${this
              .checked
              ? "border-ui-accent bg-ui-accent"
              : "border-ui-border-strong bg-ui-panel"}"
          >
            ${this.checked
              ? html`<svg
                  xmlns="http://www.w3.org/2000/svg"
                  class="h-3 w-3 text-white"
                  viewBox="0 0 20 20"
                  fill="currentColor"
                >
                  <path
                    fill-rule="evenodd"
                    d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
                    clip-rule="evenodd"
                  />
                </svg>`
              : ""}
          </span>
          <span class="${ROW_LABEL_CLASS}"
            >${translateText(this.labelKey)}</span
          >
        </button>

        <!-- Keep the input permanently mounted and just hide it when unchecked.
             Rendering it conditionally (\${checked ? input : nothing}) inserts a
             fresh input on enable, and focusing a just-inserted input forces
             several ms of layout/paint per frame. CSS-hiding an always-present
             input avoids that. -->
        <div class="relative shrink-0 ${this.checked ? "" : "hidden"}">
          <input
            type=${this.inputType}
            id=${this.inputId ?? nothing}
            min=${this.inputMin ?? nothing}
            max=${this.inputMax ?? nothing}
            step=${this.inputStep ?? nothing}
            .value=${String(this.inputValue ?? "")}
            class=${INPUT_CLASS}
            aria-label=${this.inputAriaLabel ?? nothing}
            placeholder=${this.inputPlaceholder ?? nothing}
            @input=${this.onInput}
            @change=${this.onChange}
            @keydown=${this.onKeyDown}
          />
          ${this.checked &&
          this.zeroLabel !== undefined &&
          this.toOptionalNumber(this.inputValue) === 0
            ? html`<div
                class="ui-label pointer-events-none absolute right-0 top-full mt-0.5 whitespace-nowrap normal-case tracking-normal"
              >
                ${this.zeroLabel}
              </div>`
            : nothing}
        </div>
      </div>
    `;
  }
}
