import { html, LitElement, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { keyed } from "lit/directives/keyed.js";
import { motionAllowed } from "./VaultFx";

const COUNT_MS = 1100;
const easeOutCubic = (t: number): number => 1 - Math.pow(1 - t, 3);

/**
 * A number that counts to its new value instead of jumping, with the change
 * floating up beside it ("+250", "-150"). The first value is shown as it is;
 * reduced motion shows every value as it is.
 */
@customElement("vault-count")
export class VaultCount extends LitElement {
  @property({ type: Number }) value = 0;

  @state() private shown = 0;
  @state() private delta: { amount: number; id: number } | null = null;

  private ready = false;
  private frame: number | null = null;
  private deltaTimer: ReturnType<typeof setTimeout> | null = null;
  private deltaId = 0;

  createRenderRoot() {
    return this;
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    if (this.frame !== null) cancelAnimationFrame(this.frame);
    if (this.deltaTimer !== null) clearTimeout(this.deltaTimer);
    this.frame = null;
    this.deltaTimer = null;
    // a count that was cut short shows where it was going when it is back
    this.ready = false;
  }

  protected willUpdate(changed: Map<string, unknown>) {
    if (!changed.has("value")) return;
    if (!this.ready || !motionAllowed()) {
      this.ready = true;
      this.shown = this.value;
      return;
    }
    const from = this.shown;
    const to = this.value;
    if (from === to) return;
    this.showDelta(to - from);
    if (this.frame !== null) cancelAnimationFrame(this.frame);
    const begin = performance.now();
    const step = (now: number) => {
      const p = Math.min(1, (now - begin) / COUNT_MS);
      this.shown = from + (to - from) * easeOutCubic(p);
      this.frame = p < 1 ? requestAnimationFrame(step) : null;
    };
    this.frame = requestAnimationFrame(step);
  }

  private showDelta(amount: number) {
    if (this.deltaTimer !== null) clearTimeout(this.deltaTimer);
    this.delta = { amount, id: ++this.deltaId };
    this.deltaTimer = setTimeout(() => {
      this.delta = null;
      this.deltaTimer = null;
    }, 1700);
  }

  render() {
    const delta = this.delta;
    return html`<span class="relative inline-flex items-center">
      <span data-vault-count>${Math.round(this.shown).toLocaleString()}</span>
      ${delta === null
        ? nothing
        : keyed(
            delta.id,
            html`<span
              data-vault-delta
              aria-hidden="true"
              class="vault-delta ${delta.amount > 0
                ? "vault-delta-up"
                : "vault-delta-down"}"
              >${delta.amount > 0 ? "+" : "−"}${Math.abs(
                delta.amount,
              ).toLocaleString()}</span
            >`,
          )}
    </span>`;
  }
}
