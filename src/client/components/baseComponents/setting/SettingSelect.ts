import { LitElement, html, nothing } from "lit";
import { customElement, property } from "lit/decorators.js";
import { COLUMN_ROW, DESCRIPTION, FIELD, LABEL } from "./SettingStyles";

type SelectOption = {
  value: number | string;
  label: string;
};

@customElement("setting-select")
export class SettingSelect extends LitElement {
  @property() label = "Setting";
  @property() description = "";
  @property({ type: Array }) options: SelectOption[] = [];
  @property({ type: String }) value = "";
  // Set while the value is owned by something the page has to wait for — the
  // Display tab uses it between sending a change to the desktop shell and the
  // shell reporting back, so a second change cannot be queued against a value
  // that is still settling.
  @property({ type: Boolean }) disabled = false;

  createRenderRoot() {
    return this;
  }

  private handleChange(e: Event) {
    const input = e.target as HTMLSelectElement;
    const selected = this.options.find(
      (option) => String(option.value) === input.value,
    );
    const selectedValue = selected?.value ?? input.value;
    this.value = String(selectedValue);

    this.dispatchEvent(
      new CustomEvent("change", {
        detail: { value: selectedValue },
        bubbles: true,
        composed: true,
      }),
    );
  }

  render() {
    return html`
      <div class="${COLUMN_ROW}">
        <div class="min-w-0">
          <label class="${LABEL}" for="setting-select-input"
            >${this.label}</label
          >
          ${this.description
            ? html`<div class="${DESCRIPTION}">${this.description}</div>`
            : nothing}
        </div>
        <div class="relative w-full">
          <select
            id="setting-select-input"
            class="${FIELD} w-full appearance-none pr-9"
            .value=${String(this.value)}
            ?disabled=${this.disabled}
            @change=${this.handleChange}
          >
            ${this.options.map(
              (option) =>
                html`<option
                  value=${String(option.value)}
                  ?selected=${String(option.value) === String(this.value)}
                >
                  ${option.label}
                </option>`,
            )}
          </select>
          <span
            class="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-ui-muted"
            aria-hidden="true"
          >
            <svg
              class="h-4 w-4"
              viewBox="0 0 20 20"
              fill="currentColor"
              aria-hidden="true"
            >
              <path
                fill-rule="evenodd"
                d="M5.23 7.21a.75.75 0 0 1 1.06.02L10 10.94l3.71-3.71a.75.75 0 1 1 1.06 1.06l-4.24 4.24a.75.75 0 0 1-1.06 0L5.21 8.29a.75.75 0 0 1 .02-1.08z"
                clip-rule="evenodd"
              />
            </svg>
          </span>
        </div>
      </div>
    `;
  }
}
