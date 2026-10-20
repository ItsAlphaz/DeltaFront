import { html, LitElement, nothing } from "lit";
import { customElement, property } from "lit/decorators.js";
import { translateText } from "../Utils";

/**
 * The loadout switcher in the page header: LOADOUT, one button per saved slot
 * and a button to add another. The active slot mirrors whatever is equipped,
 * so there is nothing to save by hand. (Unequip all is the page's own button.)
 */
@customElement("inventory-loadout-menu")
export class InventoryLoadoutMenu extends LitElement {
  @property({ attribute: false })
  names: readonly string[] = [];

  /** The slot equip changes are written into, or "" when none is. */
  @property({ type: String })
  active = "";

  @property({ type: Boolean })
  canAdd = false;

  @property({ attribute: false })
  onSelect?: (name: string) => void;

  @property({ attribute: false })
  onAdd?: () => void;

  @property({ attribute: false })
  onDelete?: (name: string) => void;

  createRenderRoot() {
    return this;
  }

  private renderSlot(name: string) {
    const isActive = name === this.active;
    return html`<div class="flex items-stretch">
      <button
        type="button"
        data-loadout-slot=${name}
        aria-pressed=${isActive ? "true" : "false"}
        aria-label=${translateText("inventory.loadout_slot", { name })}
        class="ui-focus ui-mono flex min-h-9 min-w-9 items-center justify-center rounded-[8px] px-3 text-[13px] font-semibold transition-colors cursor-pointer ${isActive
          ? "bg-ui-border-strong text-ui-text"
          : "text-ui-muted hover:text-ui-text"}"
        @click=${() => this.onSelect?.(name)}
      >
        ${name}
      </button>
      ${isActive
        ? html`<button
            type="button"
            data-loadout-delete=${name}
            aria-label=${translateText("inventory.loadout_delete_target", {
              name,
            })}
            class="ui-focus flex min-h-9 w-7 items-center justify-center rounded-[8px] text-[12px] text-ui-muted transition-colors hover:text-ui-text cursor-pointer"
            @click=${() => this.onDelete?.(name)}
          >
            ✕
          </button>`
        : nothing}
    </div>`;
  }

  render() {
    return html`<section
      data-inventory-loadout-menu
      aria-label=${translateText("inventory.loadout_presets")}
      class="inline-flex max-w-full items-center gap-1 overflow-x-auto overflow-y-hidden rounded-ui-card border border-ui-border bg-ui-ground p-1 pl-3"
    >
      <span class="ui-label mr-2 shrink-0"
        >${translateText("inventory.loadout_label")}</span
      >
      ${this.names.map((name) => this.renderSlot(name))}
      <button
        type="button"
        data-loadout-add
        ?disabled=${!this.canAdd}
        aria-label=${translateText("inventory.loadout_add")}
        class="ui-focus flex min-h-9 w-9 shrink-0 items-center justify-center rounded-[8px] text-ui-muted transition-colors hover:text-ui-text disabled:cursor-not-allowed disabled:opacity-40 cursor-pointer"
        @click=${() => this.onAdd?.()}
      >
        +
      </button>
    </section>`;
  }
}
