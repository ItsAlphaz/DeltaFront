import { LitElement, html } from "lit";
import { customElement, property, query, state } from "lit/decorators.js";
import { translateText } from "../Utils";

@customElement("fluent-slider")
export class FluentSlider extends LitElement {
  createRenderRoot() {
    return this;
  }

  @property({ type: Number }) value = 0;
  @property({ type: Number }) min = 0;
  @property({ type: Number }) max = 400;
  @property({ type: Number }) step = 1;
  @property({ type: String }) labelKey = "";
  @property({ type: String }) disabledKey = "";
  @property({ type: Number }) defaultValue: number | undefined = undefined;
  @property({ type: String }) defaultLabelKey = "";

  @state() private isEditing = false;

  @query("input[type='number']") private numberInput!: HTMLInputElement;

  private dispatchValueChange() {
    this.dispatchEvent(
      new CustomEvent("value-changed", {
        detail: { value: this.value },
        bubbles: true,
        composed: true,
      }),
    );
  }

  private handleSliderInput(e: Event) {
    const target = e.target as HTMLInputElement;
    this.value = target.valueAsNumber;
  }

  private handleSliderChange(e: Event) {
    const target = e.target as HTMLInputElement;
    this.value = target.valueAsNumber;
    this.dispatchValueChange();
  }

  private handleNumberInput(e: Event) {
    const target = e.target as HTMLInputElement;
    let val = target.valueAsNumber;
    if (isNaN(val)) {
      val = this.min;
    }
    if (val < this.min) val = this.min;
    if (val > this.max) val = this.max;
    this.value = val;
    // Don't dispatch value change on every input - only on blur/enter
  }

  private handleNumberComplete() {
    // Dispatch the value change when editing is complete
    this.dispatchValueChange();
  }

  private handleNumberKeyDown(e: KeyboardEvent) {
    if (e.key === "Enter") {
      this.isEditing = false;
      this.handleNumberComplete();
    }
  }

  private enableEditing() {
    this.isEditing = true;
    this.updateComplete.then(() => this.numberInput?.focus());
  }

  render() {
    const percentage =
      this.max === this.min
        ? 0
        : ((this.value - this.min) / (this.max - this.min)) * 100;
    return html`
      <div class="flex w-full flex-col gap-3">
        <div class="flex items-baseline justify-between gap-3">
          <span class="ui-body text-ui-text"
            >${this.labelKey ? translateText(this.labelKey) : ""}</span
          >
          ${this.isEditing
            ? html`<input
                type="number"
                .min=${this.min}
                .max=${this.max}
                .valueAsNumber=${this.value}
                class="ui-focus ui-mono h-9 w-[72px] rounded-ui-card border border-ui-border-strong bg-ui-panel px-2 text-right text-[16px] font-bold text-ui-text"
                @input=${this.handleNumberInput}
                @blur=${() => {
                  this.isEditing = false;
                  this.handleNumberComplete();
                }}
                @keydown=${this.handleNumberKeyDown}
              />`
            : html`<span
                class="ui-focus ui-mono inline-flex cursor-pointer select-none items-baseline gap-2 text-right text-[20px] font-bold transition-colors hover:text-ui-text ${this
                  .value > 0
                  ? "text-ui-text"
                  : "text-ui-muted"}"
                role="button"
                tabindex="0"
                @click=${this.enableEditing}
                @keydown=${(e: KeyboardEvent) => {
                  if (e.key === "Enter" || e.key === " ") {
                    this.enableEditing();
                    e.preventDefault();
                  }
                }}
              >
                ${this.value === 0 && this.disabledKey
                  ? translateText(this.disabledKey)
                  : this.defaultValue !== undefined &&
                      this.value === this.defaultValue &&
                      this.defaultLabelKey
                    ? html`<span class="ui-label"
                          >${translateText(this.defaultLabelKey)}</span
                        >${this.value}`
                    : this.value}
              </span>`}
        </div>
        <input
          type="range"
          .min=${this.min}
          .max=${this.max}
          .step=${this.step}
          .valueAsNumber=${this.value}
          style="background: linear-gradient(to right, var(--color-ui-accent) 0%, var(--color-ui-accent) ${percentage}%, var(--color-ui-border-strong) ${percentage}%, var(--color-ui-border-strong) 100%); background-size: 100% 6px; background-repeat: no-repeat; background-position: center; border-radius: 9999px;"
          class="ui-focus m-0 h-6 w-full cursor-pointer appearance-none bg-transparent p-0
                 [&::-webkit-slider-runnable-track]:h-[6px] [&::-webkit-slider-runnable-track]:w-full [&::-webkit-slider-runnable-track]:cursor-pointer [&::-webkit-slider-runnable-track]:rounded-full [&::-webkit-slider-runnable-track]:bg-transparent
                 [&::-webkit-slider-thumb]:-mt-[6px] [&::-webkit-slider-thumb]:h-[18px] [&::-webkit-slider-thumb]:w-[18px] [&::-webkit-slider-thumb]:cursor-pointer [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-ui-accent [&::-webkit-slider-thumb]:shadow-[0_0_0_3px_var(--color-ui-accent-tint)]
                 [&::-moz-range-track]:h-[6px] [&::-moz-range-track]:w-full [&::-moz-range-track]:cursor-pointer [&::-moz-range-track]:rounded-full [&::-moz-range-track]:bg-transparent
                 [&::-moz-range-thumb]:h-[18px] [&::-moz-range-thumb]:w-[18px] [&::-moz-range-thumb]:cursor-pointer [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:border-none [&::-moz-range-thumb]:bg-ui-accent [&::-moz-range-thumb]:shadow-[0_0_0_3px_var(--color-ui-accent-tint)]"
          @input=${this.handleSliderInput}
          @change=${this.handleSliderChange}
        />
      </div>
    `;
  }
}
