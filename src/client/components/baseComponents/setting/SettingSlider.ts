import { LitElement, html, nothing, type PropertyValues } from "lit";
import { customElement, property } from "lit/decorators.js";
import { DESCRIPTION, LABEL, RAINBOW, ROW } from "./SettingStyles";

@customElement("setting-slider")
export class SettingSlider extends LitElement {
  @property() label = "Setting";
  @property() description = "";
  @property({ type: Number }) value = 0;
  @property({ type: Number }) min = 0;
  @property({ type: Number }) max = 100;
  // Graphics options tune fractional values (opacities, scale factors), which
  // a whole-number slider cannot express.
  @property({ type: Number }) step = 1;
  @property({ type: Boolean }) easter = false;
  @property() unit = "%";
  @property({ attribute: false }) formatValue?: (value: number) => string;

  createRenderRoot() {
    return this;
  }

  private handleInput(e: Event) {
    const input = e.target as HTMLInputElement;
    this.value = Number(input.value);
    this.updateSliderStyle(input);

    this.dispatchEvent(
      new CustomEvent("change", {
        detail: { value: this.value },
        bubbles: true,
        composed: true,
      }),
    );
  }

  private updateSliderStyle(slider: HTMLInputElement) {
    const percent = ((this.value - this.min) / (this.max - this.min)) * 100;
    const clamped = Math.max(0, Math.min(100, percent));
    slider.style.setProperty("--fill", `${clamped}%`);
  }

  /**
   * The filled part of the track is a CSS custom property, which `handleInput`
   * sets during a drag. Setting `.value` from outside — "Reset to defaults",
   * or reopening the tab — moves the thumb but left the fill where it was.
   */
  protected updated(changed: PropertyValues) {
    if (!changed.has("value") && !changed.has("min") && !changed.has("max")) {
      return;
    }
    const slider = this.renderRoot.querySelector(
      "input[type=range]",
    ) as HTMLInputElement | null;
    if (slider) this.updateSliderStyle(slider);
  }

  firstUpdated() {
    const slider = this.renderRoot.querySelector(
      "input[type=range]",
    ) as HTMLInputElement;
    if (slider) this.updateSliderStyle(slider);
  }

  /**
   * This component renders into light DOM, so the inner <input>'s native
   * `change` (fired on release) would bubble to the parent's `@change`
   * listener alongside the CustomEvent from `handleInput`, with no `detail`.
   */
  private stopNativeChange(e: Event) {
    e.stopPropagation();
  }

  render() {
    return html`
      <div
        class="${ROW} flex-col items-stretch sm:flex-row sm:items-center ${this
          .easter
          ? RAINBOW
          : ""}"
      >
        <div class="min-w-0 flex-1">
          <label class="${LABEL}">${this.label}</label>
          ${this.description
            ? html`<div class="${DESCRIPTION}">${this.description}</div>`
            : nothing}
        </div>

        <div class="flex w-full shrink-0 items-center gap-3 sm:w-[220px]">
          <span
            class="ui-mono min-w-[4ch] shrink-0 text-right text-[14px] font-semibold text-ui-text"
            >${this.formatValue
              ? this.formatValue(this.value)
              : `${this.value}${this.unit}`}</span
          >
          <input
            type="range"
            class="ui-focus h-2 w-auto flex-1 appearance-none rounded bg-transparent outline-none
              [&::-webkit-slider-runnable-track]:h-2 [&::-webkit-slider-runnable-track]:rounded [&::-webkit-slider-runnable-track]:bg-[image:linear-gradient(to_right,var(--color-ui-accent)_0%,var(--color-ui-accent)_var(--fill),var(--color-ui-border-strong)_var(--fill),var(--color-ui-border-strong)_100%)]
              [&::-webkit-slider-thumb]:-mt-[5px] [&::-webkit-slider-thumb]:h-[18px] [&::-webkit-slider-thumb]:w-[18px] [&::-webkit-slider-thumb]:cursor-pointer [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-ui-accent
              [&::-moz-range-track]:h-2 [&::-moz-range-track]:rounded [&::-moz-range-track]:bg-ui-border-strong
              [&::-moz-range-progress]:h-2 [&::-moz-range-progress]:rounded [&::-moz-range-progress]:bg-ui-accent
              [&::-moz-range-thumb]:h-[18px] [&::-moz-range-thumb]:w-[18px] [&::-moz-range-thumb]:cursor-pointer [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:border-none [&::-moz-range-thumb]:bg-ui-accent"
            min=${this.min}
            max=${this.max}
            step=${this.step}
            .value=${String(this.value)}
            @input=${this.handleInput}
            @change=${this.stopNativeChange}
          />
        </div>
      </div>
    `;
  }
}
