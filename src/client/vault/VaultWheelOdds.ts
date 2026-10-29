import {
  VAULT_RARITIES,
  type VaultRarity,
  type VaultView,
} from "@openfront/shared/VaultSchemas";
import { html, LitElement, type TemplateResult } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { translateText } from "../Utils";
import { PACK_COLOR, prizeColor } from "./VaultFx";
import { rarityName, vaultIcons } from "./VaultParts";
import { tone } from "./VaultPixel";

type Segment = VaultView["wheel"]["segments"][number];

interface Group {
  key: string;
  color: string;
  label: string;
  percent: number;
  /** The wheel's segments of this kind. */
  indexes: number[];
  icon: TemplateResult;
}

/** 13, 5.3, 0.4: whole numbers from ten up, one decimal below. */
export const percentText = (percent: number): string =>
  `${percent >= 10 ? Math.round(percent) : Math.round(percent * 10) / 10}%`;

/** The wheel's segments grouped by what they give: Credits, a free pack, an item of each rarity. */
export function groupSegments(segments: readonly Segment[]): Group[] {
  const groups = new Map<string, Group>();
  segments.forEach((segment, index) => {
    const prize = segment.prize;
    const key =
      prize.kind === "item" ? `item:${prize.rarity}` : `${prize.kind}`;
    let group = groups.get(key);
    if (group === undefined) {
      group = {
        key,
        color: prizeColor(prize),
        label:
          prize.kind === "credits"
            ? translateText("vault.legend_credits")
            : prize.kind === "pack"
              ? translateText("vault.legend_pack")
              : rarityName(prize.rarity),
        percent: 0,
        indexes: [],
        icon:
          prize.kind === "credits"
            ? vaultIcons.coin(1)
            : prize.kind === "pack"
              ? html`<span style="color:${PACK_COLOR}"
                  >${vaultIcons.gift(1)}</span
                >`
              : html`<span style="color:${prizeColor(prize)}"
                  >${vaultIcons.gem(1)}</span
                >`,
      };
      groups.set(key, group);
    }
    group.percent += segment.percent;
    group.indexes.push(index);
  });
  const order = (key: string): number =>
    key === "credits"
      ? -2
      : key === "pack"
        ? -1
        : VAULT_RARITIES.indexOf(key.slice(5) as VaultRarity);
  return [...groups.values()]
    .map((g) => ({ ...g, percent: Math.round(g.percent * 100) / 100 }))
    .sort((a, b) => order(a.key) - order(b.key));
}

/**
 * What the wheel can give: a bar of the chances by kind, a legend, and the
 * full table folded away under "Show odds". Pointing at a bar, a chip or a row
 * says `vault-highlight` with the segments it is about, so the page can light
 * them up on the wheel.
 */
@customElement("vault-wheel-odds")
export class VaultWheelOdds extends LitElement {
  @property({ attribute: false }) segments: readonly Segment[] = [];
  /** The packs, to name the one a segment gives away. */
  @property({ attribute: false }) packs: readonly {
    name: string;
    displayName: string;
  }[] = [];

  @state() private open = false;

  createRenderRoot() {
    return this;
  }

  private highlight(indexes: readonly number[]) {
    this.dispatchEvent(
      new CustomEvent("vault-highlight", {
        detail: indexes,
        bubbles: true,
      }),
    );
  }

  render() {
    const groups = groupSegments(this.segments);
    const hover = (indexes: number[]) => ({
      enter: () => this.highlight(indexes),
      leave: () => this.highlight([]),
    });
    return html`<div data-vault-odds-block class="flex flex-col gap-3">
      <div class="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <h3
          class="text-[13px] font-extrabold uppercase tracking-[0.16em] text-white/85"
        >
          ${translateText("vault.wheel_odds")}
        </h3>
        <button
          type="button"
          data-vault-odds-toggle
          class="vault-link ui-focus rounded"
          aria-expanded=${this.open ? "true" : "false"}
          @click=${() => (this.open = !this.open)}
        >
          ${translateText(this.open ? "vault.hide_odds" : "vault.show_odds")}
          ${vaultIcons.chevron()}
        </button>
      </div>
      <div
        class="vault-bar"
        role="img"
        aria-label=${translateText("vault.wheel_odds")}
      >
        ${groups.map((g) => {
          const h = hover(g.indexes);
          return html`<i
            style="--w:${g.percent};--c:${g.color}"
            title="${g.label} ${percentText(g.percent)}"
            @pointerenter=${h.enter}
            @pointerleave=${h.leave}
          ></i>`;
        })}
      </div>
      <div class="flex flex-wrap gap-2">
        ${groups.map((g) => {
          const h = hover(g.indexes);
          return html`<span
            class="vault-chip"
            data-vault-legend=${g.key}
            style=${tone(g.color)}
            @pointerenter=${h.enter}
            @pointerleave=${h.leave}
            >${g.icon}${g.label}
            <span class="ui-mono text-white/55"
              >${percentText(g.percent)}</span
            ></span
          >`;
        })}
      </div>
      <div class="vault-drawer" ?data-open=${this.open} ?inert=${!this.open}>
        <div>
          <table data-vault-wheel-odds class="w-full text-sm">
            <tbody>
              ${this.segments.map((s, index) => {
                const h = hover([index]);
                return html`<tr
                  class="vault-oddrow border-b border-white/[0.06]"
                  style="--c:${prizeColor(s.prize)}"
                  @pointerenter=${h.enter}
                  @pointerleave=${h.leave}
                >
                  <td class="w-8 py-2 pl-3 pr-2">
                    <span
                      class="inline-block h-3 w-3 rounded-sm"
                      style="background:${prizeColor(s.prize)}"
                    ></span>
                  </td>
                  <td class="py-2 font-semibold text-white/90">
                    ${this.prizeLabel(s)}
                  </td>
                  <td class="ui-mono py-2 pr-3 text-right text-white/55">
                    ${percentText(s.percent)}
                  </td>
                </tr>`;
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>`;
  }

  private prizeLabel(segment: Segment): string {
    const prize = segment.prize;
    if (prize.kind === "credits") {
      return translateText("vault.prize_credits", {
        amount: prize.amount.toLocaleString(),
      });
    }
    if (prize.kind === "item") {
      return translateText("vault.prize_item", {
        rarity: rarityName(prize.rarity),
      });
    }
    return translateText("vault.prize_pack", {
      pack:
        this.packs.find((p) => p.name === prize.pack)?.displayName ??
        prize.pack,
    });
  }
}
