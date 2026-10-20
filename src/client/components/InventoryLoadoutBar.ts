import { html, LitElement, nothing } from "lit";
import { customElement, property } from "lit/decorators.js";
import { ResolvedCosmetic } from "../Cosmetics";
import { translateText } from "../Utils";
import "./CosmeticPreview";

export type InventoryCategory = "skins" | "flags" | "crowns" | "effects";

export interface InventoryLoadoutEntry {
  category: InventoryCategory;
  label: string;
  items: readonly ResolvedCosmetic[];
  summary: string;
}

@customElement("inventory-loadout-bar")
export class InventoryLoadoutBar extends LitElement {
  @property({ attribute: false })
  entries: readonly InventoryLoadoutEntry[] = [];

  @property({ type: String })
  activeCategory: InventoryCategory = "skins";

  @property({ attribute: false })
  onCategorySelect?: (category: InventoryCategory) => void;

  createRenderRoot() {
    return this;
  }

  private renderPreviews(entry: InventoryLoadoutEntry) {
    const items =
      entry.category === "effects"
        ? entry.items.slice(0, 3)
        : entry.items.slice(0, 1);
    const hiddenCount = entry.items.length - items.length;

    return html`<div
      data-loadout-previews
      class="flex h-12 w-12 shrink-0 items-center justify-center ${entry.category ===
      "effects"
        ? "-space-x-3"
        : ""}"
    >
      ${items.length === 0
        ? html`<div
            class="h-12 w-12 rounded-ui-card border border-ui-border bg-ui-ground"
          ></div>`
        : nothing}
      ${items.map(
        (item, index) =>
          html`<div
            data-loadout-preview
            class="h-12 w-12 shrink-0 overflow-hidden rounded-ui-card border border-ui-border-strong bg-ui-ground p-1 ${entry.category ===
            "effects"
              ? "relative"
              : ""}"
            style=${entry.category === "effects"
              ? `z-index:${3 - index}`
              : nothing}
          >
            <cosmetic-preview .resolved=${item}></cosmetic-preview>
          </div>`,
      )}
      ${hiddenCount > 0
        ? html`<span
            data-loadout-more
            class="ui-mono relative z-10 flex h-6 min-w-6 items-center justify-center rounded-full border border-ui-border-strong bg-ui-surface px-1 text-[11px] font-bold text-ui-text"
            >+${hiddenCount}</span
          >`
        : nothing}
    </div>`;
  }

  render() {
    return html`<section
      data-inventory-loadout
      aria-label=${translateText("inventory.loadout")}
    >
      <h2 class="sr-only">${translateText("inventory.loadout")}</h2>
      <div class="grid grid-cols-2 gap-3 lg:grid-cols-4">
        ${this.entries.map((entry) => {
          const isActive = entry.category === this.activeCategory;
          const ariaSummary =
            entry.category === "effects"
              ? translateText("inventory.showing_effects", {
                  count: entry.items.length,
                })
              : entry.summary;
          return html`<button
            type="button"
            data-loadout-category=${entry.category}
            aria-pressed=${isActive ? "true" : "false"}
            aria-label=${translateText("inventory.loadout_category_label", {
              category: entry.label,
              summary: ariaSummary,
            })}
            class="ui-focus flex min-h-[72px] min-w-0 items-center gap-3 rounded-ui-card border bg-ui-surface p-3 text-left transition-colors cursor-pointer ${isActive
              ? "border-ui-accent bg-ui-accent-tint ring-1 ring-ui-accent"
              : "border-ui-border hover:border-ui-border-hover"}"
            @click=${() => this.onCategorySelect?.(entry.category)}
          >
            ${this.renderPreviews(entry)}
            <span class="flex min-w-0 flex-col gap-0.5">
              <span class="ui-body truncate font-bold text-ui-text"
                >${entry.label}</span
              >
              <span class="ui-body truncate text-[12px] text-ui-muted"
                >${entry.summary}</span
              >
            </span>
          </button>`;
        })}
      </div>
    </section>`;
  }
}
