import {
  rarityRank,
  VAULT_RARITIES,
  type VaultItemView,
  type VaultRarity,
  type VaultView,
} from "@openfront/shared/VaultSchemas";
import { html, LitElement, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { repeat } from "lit/directives/repeat.js";
import {
  cosmeticDisplayName,
  cosmeticRarityLabel,
} from "../components/CosmeticPresentation";
import "../components/CosmeticPreview";
import { uiSegmented } from "../components/ui/PageUi";
import { translateCosmetic, type ResolvedCosmetic } from "../Cosmetics";
import { translateText } from "../Utils";
import { RARITY_COLOR, rarityPower } from "./VaultFx";
import {
  rarityName,
  vaultIcons,
  vaultSectionHead,
  watchInView,
} from "./VaultParts";
import { tiltLeave, tiltMove } from "./VaultTilt";

type Status = "all" | "owned" | "missing";

/** Where an item can be won. */
interface Source {
  wheel: boolean;
  /** The packs that can hold it, by name. */
  packs: string[];
}

/** "Wheel · 3 packs", or the pack's name when it is only in one. */
const sourceText = (source: Source | undefined): string =>
  [
    source?.wheel === true ? translateText("vault.source_wheel") : null,
    source === undefined || source.packs.length === 0
      ? null
      : source.packs.length === 1
        ? source.packs[0]
        : translateText("vault.source_packs", { count: source.packs.length }),
  ]
    .filter((part) => part !== null)
    .join(" · ");
type RarityFilter = "all" | VaultRarity;

/** The flare an item is owned as: `crown:kraken_crown`, `pattern:gravel:mint`. */
export const itemFlare = (item: {
  type: string;
  name: string;
  colorPalette?: string | undefined;
}): string =>
  item.colorPalette === undefined
    ? `${item.type}:${item.name}`
    : `${item.type}:${item.name}:${item.colorPalette}`;

/**
 * The Vault collection: every rare-and-better piece the Vault gives out as a
 * card that leans towards the pointer, the ones not yet won dimmed and locked
 * (until they are pointed at) with where each is found, the epic and legendary
 * ones with a light running round their edge. A progress bar and filters by
 * state and rarity sit above.
 */
@customElement("vault-collection")
export class VaultCollection extends LitElement {
  @property({ attribute: false }) view: VaultView | null = null;
  /** The account's flares. */
  @property({ attribute: false }) owned: ReadonlySet<string> = new Set();
  /** Finds the catalog entry of an item, to draw it and name it. */
  @property({ attribute: false }) resolve: (
    item: VaultItemView,
  ) => ResolvedCosmetic | null = () => null;

  @state() private status: Status = "all";
  @state() private rarity: RarityFilter = "all";

  createRenderRoot() {
    return this;
  }

  protected updated() {
    watchInView(this);
  }

  /** The pieces worth chasing, best first: the cheap ones are in the shop. */
  private items(view: VaultView): VaultItemView[] {
    const seen = new Set<string>();
    const items = [
      ...view.wheel.items,
      ...view.packs.flatMap((p) => p.items),
    ].filter((item) => {
      const key = itemFlare(item);
      if (seen.has(key)) return false;
      seen.add(key);
      return rarityRank(item.rarity) >= rarityRank("rare");
    });
    items.sort(
      (a, b) =>
        rarityRank(b.rarity) - rarityRank(a.rarity) ||
        a.name.localeCompare(b.name),
    );
    return items;
  }

  /** Where each item can be won: the wheel and the packs that hold it. */
  private sources(view: VaultView): Map<string, Source> {
    const out = new Map<string, Source>();
    const of = (item: VaultItemView): Source => {
      const key = itemFlare(item);
      let source = out.get(key);
      if (source === undefined) {
        source = { wheel: false, packs: [] };
        out.set(key, source);
      }
      return source;
    };
    for (const item of view.wheel.items) of(item).wheel = true;
    for (const pack of view.packs) {
      for (const item of pack.items) of(item).packs.push(pack.displayName);
    }
    return out;
  }

  render() {
    const view = this.view;
    if (view === null) return nothing;
    const all = this.items(view);
    const have = (item: VaultItemView) => this.owned.has(itemFlare(item));
    const ownedCount = all.filter(have).length;
    const percent = all.length === 0 ? 0 : (ownedCount / all.length) * 100;
    const sources = this.sources(view);
    const shown = all.filter(
      (item) =>
        (this.rarity === "all" || item.rarity === this.rarity) &&
        (this.status === "all" || (this.status === "owned") === have(item)),
    );
    const rarities = VAULT_RARITIES.filter((r) =>
      all.some((item) => item.rarity === r),
    ).reverse();
    return html`<section data-vault-collection class="flex flex-col gap-6">
      <div data-vault-in-view>
        ${vaultSectionHead({
          title: translateText("vault.collection"),
          blurb: translateText("vault.collection_blurb"),
          aside: html`<div class="flex flex-col items-end gap-2">
            <div
              class="ui-mono text-2xl font-bold text-white"
              data-vault-collection-count
            >
              ${ownedCount} / ${all.length}
            </div>
            <div
              class="vault-progress"
              role="progressbar"
              aria-valuemin="0"
              aria-valuemax=${all.length}
              aria-valuenow=${ownedCount}
            >
              <i style="--p:${percent}%"></i>
            </div>
          </div>`,
        })}
      </div>
      <div
        data-vault-in-view
        style="--d:.08s"
        class="flex flex-wrap items-center justify-between gap-3"
      >
        ${uiSegmented<Status>({
          options: [
            { key: "all", label: translateText("vault.filter_all") },
            { key: "owned", label: translateText("vault.filter_owned") },
            { key: "missing", label: translateText("vault.filter_missing") },
          ],
          value: this.status,
          onChange: (key) => (this.status = key),
          ariaLabel: translateText("vault.collection"),
          name: "vault-status",
        })}
        <div class="flex flex-wrap gap-2" role="group">
          ${rarities.map((r) => {
            const total = all.filter((i) => i.rarity === r).length;
            const mine = all.filter((i) => i.rarity === r && have(i)).length;
            return html`<button
              type="button"
              class="vault-chip ui-focus"
              data-vault-rarity=${r}
              style="--c:${RARITY_COLOR[r]}"
              aria-pressed=${this.rarity === r ? "true" : "false"}
              @click=${() => (this.rarity = this.rarity === r ? "all" : r)}
            >
              <span class="vault-dot"></span>${rarityName(r)}
              <span class="ui-mono text-white/55">${mine}/${total}</span>
            </button>`;
          })}
        </div>
      </div>
      ${shown.length === 0
        ? html`<p
            data-vault-collection-empty
            class="rounded-ui-card border border-dashed border-white/10 p-10 text-center text-ui-muted"
          >
            ${translateText("vault.collection_empty")}
          </p>`
        : html`<div
            class="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5"
          >
            ${repeat(
              shown,
              (item) => itemFlare(item),
              (item, i) =>
                this.renderItem(
                  item,
                  have(item),
                  sources.get(itemFlare(item)),
                  i,
                ),
            )}
          </div>`}
    </section>`;
  }

  private renderItem(
    item: VaultItemView,
    have: boolean,
    source: Source | undefined,
    index: number,
  ) {
    const resolved = this.resolve(item);
    const color = RARITY_COLOR[item.rarity];
    const power = rarityPower(item.rarity);
    return html`<div
      data-vault-item=${item.name}
      data-owned=${have ? "true" : "false"}
      data-vault-in-view
      style="--d:${(index % 5) * 0.06}s"
      @pointermove=${(e: PointerEvent) => tiltMove(e, 9)}
      @pointerleave=${tiltLeave}
    >
      <article
        class="vault-item vault-tilt"
        data-owned=${have ? "true" : "false"}
        style="--c:${color}; --tilt-hover-scale: 1.04"
      >
        ${power >= 3 ? html`<span class="vault-edge"></span>` : nothing}
        <span class="vault-item-state"
          >${have
            ? html`${vaultIcons.check("h-3 w-3")}${translateText("vault.owned")}`
            : html`${vaultIcons.lock("h-3 w-3")}${translateText("vault.locked")}`}</span
        >
        <div class="vault-item-art">
          ${resolved === null
            ? html`<div
                class="flex h-full items-center justify-center"
                style="color:${color}"
              >
                ${vaultIcons.gem("h-10 w-10")}
              </div>`
            : html`<cosmetic-preview .resolved=${resolved}></cosmetic-preview>`}
        </div>
        <div class="flex flex-1 flex-col gap-1 px-4 pb-4 text-center">
          <div
            class="text-[10px] font-black uppercase tracking-[0.2em]"
            style="color:${color}"
          >
            ${resolved === null
              ? rarityName(item.rarity)
              : cosmeticRarityLabel(resolved)}
          </div>
          <div class="truncate text-[15px] font-bold text-white">
            ${resolved === null ? item.name : cosmeticDisplayName(resolved)}
          </div>
          ${item.colorPalette === undefined
            ? nothing
            : html`<div
                data-vault-variant
                class="-mt-0.5 truncate text-xs font-semibold text-white/55"
              >
                ${translateCosmetic(
                  "territory_patterns.color_palette",
                  item.colorPalette.replace(/^vault_/, ""),
                )}
              </div>`}
          <div
            data-vault-sources
            class="mt-auto flex items-center justify-center gap-1.5 pt-1 text-[11px] text-white/45"
          >
            ${vaultIcons.gift("h-3 w-3")}
            <span
              class="truncate"
              title=${[
                ...(source?.wheel === true
                  ? [translateText("vault.source_wheel")]
                  : []),
                ...(source?.packs ?? []),
              ].join(" · ")}
              >${sourceText(source)}</span
            >
          </div>
        </div>
        <span class="vault-glare"></span>
      </article>
    </div>`;
  }
}
