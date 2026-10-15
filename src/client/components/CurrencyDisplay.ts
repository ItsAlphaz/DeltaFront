import { ACCOUNT_FEATURES } from "@openfront/shared/AccountFeatures";
import { html, LitElement, PropertyValues } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { translateText } from "../Utils";
import { countUp } from "../utilities/CountUp";
import "./CreditsIcon";
import "./PlutoniumIcon";

// Player wallets arrive as numbers (CurrencyBalancesSchema coerces them), clan
// treasuries as decimal bigint strings (ClanInfoSchema) that can exceed
// Number.MAX_SAFE_INTEGER — so strings are parsed with BigInt, never Number.
// Returns null when there is no amount to show (absent, or unparseable), which
// the renderer treats as "hide this side" rather than "zero". Note BigInt("")
// is 0n, hence the falsy guard on the string branch.
export function formatCurrencyAmount(
  value: number | string | null | undefined,
): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") {
    return Number.isFinite(value) ? value.toLocaleString() : null;
  }
  if (!value) return null;
  try {
    return BigInt(value).toLocaleString();
  } catch {
    return null;
  }
}

@customElement("currency-display")
export class CurrencyDisplay extends LitElement {
  // Not attributes: these accept bigint strings as well as numbers, and are
  // always set via property binding.
  @property({ attribute: false })
  hard: number | string | null = null;

  @property({ attribute: false })
  soft: number | string | null = null;

  // Dimmer and smaller, for sitting inside a metadata row rather than
  // standing alone as a wallet header.
  @property({ type: Boolean })
  compact = false;

  // The account header's figure: Credits as the big number of the card.
  @property({ type: Boolean })
  large = false;

  // Eases the Credits figure up from 0 the first time it shows (the account
  // page's opening). Never under reduced motion; the real value is always what
  // it ends on.
  @property({ type: Boolean })
  countIn = false;

  @state() private counting: number | null = null;
  private counted = false;
  private stopCounting: (() => void) | null = null;

  createRenderRoot() {
    return this;
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    this.stopCounting?.();
    this.stopCounting = null;
  }

  protected willUpdate(changed: PropertyValues<this>): void {
    super.willUpdate(changed);
    if (
      this.counted ||
      !this.countIn ||
      typeof this.soft !== "number" ||
      !(this.soft > 0)
    ) {
      return;
    }
    this.counted = true;
    const target = this.soft;
    this.stopCounting = countUp(target, (value) => {
      this.counting = value >= target ? null : value;
    });
  }

  render() {
    // DeltaFront has one currency, Credits (the "soft" slot). The premium
    // slot is shown only where payments exist.
    const hard = ACCOUNT_FEATURES.payments
      ? formatCurrencyAmount(this.hard)
      : null;
    const soft =
      this.counting !== null
        ? this.counting.toLocaleString()
        : formatCurrencyAmount(this.soft);
    if (hard === null && soft === null) return html``;

    const compact = this.compact;
    const large = this.large && !compact;
    const row = compact
      ? "flex items-center gap-3 text-xs"
      : large
        ? "flex flex-wrap items-center gap-x-5 gap-y-1 sm:justify-end"
        : "flex gap-3 justify-center";
    const hardText = compact
      ? "text-xs text-green-400/70"
      : large
        ? "text-2xl font-black leading-none tabular-nums text-green-400"
        : "text-sm font-bold text-green-400";
    const softText = compact
      ? "text-xs text-df-text-secondary"
      : large
        ? "text-3xl font-black leading-none tabular-nums text-white"
        : "text-sm font-bold text-white";

    return html`
      <div class="${row}">
        ${hard === null
          ? ""
          : html`<div
              class="flex items-center gap-1.5"
              title=${translateText("cosmetics.hard")}
            >
              <plutonium-icon
                .size=${compact ? 12 : large ? 24 : 16}
              ></plutonium-icon>
              <span class="${hardText}">${hard}</span>
            </div>`}
        ${soft === null
          ? ""
          : html`<div
              class="flex items-center gap-1.5"
              title=${translateText("cosmetics.soft")}
            >
              <credits-icon
                .size=${compact ? 14 : large ? 30 : 20}
                style=${compact || large ? "" : "margin-top:3px"}
              ></credits-icon>
              <span class="${softText}">${soft}</span>
            </div>`}
      </div>
    `;
  }
}
