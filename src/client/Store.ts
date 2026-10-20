import { ACCOUNT_FEATURES } from "@openfront/shared/AccountFeatures";
import {
  isGrantedSubscription,
  UserMeResponse,
} from "@openfront/shared/ApiSchemas";
import {
  CosmeticPack,
  Cosmetics,
  Effect,
  EFFECT_TYPES,
  EffectType,
  isNukeExplosionEffect,
  NUKE_EXPLOSION_TYPES,
  NukeExplosionType,
  Product,
} from "@openfront/shared/CosmeticSchemas";
import type { PropertyValues, TemplateResult } from "lit";
import { html } from "lit";
import { customElement, state } from "lit/decorators.js";
import { BaseModal } from "./components/BaseModal";
import "./components/CosmeticCard";
import {
  cosmeticDisplayName,
  cosmeticRarity,
  cosmeticRarityLabel,
  cosmeticSelectionLabel,
  cosmeticTypeLabel,
} from "./components/CosmeticPresentation";
import { isPreviewableCosmetic } from "./components/CosmeticPreviewBubble";
import "./components/CosmeticPreviewModal";
import "./components/CreditsIcon";
import { formatCurrencyAmount } from "./components/CurrencyDisplay";
import "./components/CustomCurrencyCard";
import "./components/EffectsGrid";
import type { InlineCheckout } from "./components/InlineCheckout";
import "./components/NotLoggedInWarning";
import "./components/PackContentsDialog";
import "./components/PlutoniumIcon";
import { ProgressiveList } from "./components/ProgressiveList";
import "./components/PurchaseButton";
import { alignPurchaseRows } from "./components/PurchaseButton";
import "./components/TribesPanel";
import {
  tierForRarity,
  uiBadge,
  uiButton,
  uiCheck,
  uiDetailHeading,
  uiDetailPanel,
  uiDetailRows,
  uiIcons,
  uiItemCard,
  uiPageHeader,
  uiSegmented,
  uiStatusChip,
  uiSwatches,
  uiTabs,
  uiTwoColumn,
} from "./components/ui/PageUi";
import {
  fetchCosmetics,
  findPackItem,
  groupCosmeticVariants,
  ownedPackItems,
  purchaseCosmetic,
  resolveCosmetics,
  ResolvedCosmetic,
  translateCosmetic,
} from "./Cosmetics";
import { matchesStoreItem } from "./EquippedCosmetics";
import {
  priceStringToCents,
  reportPendingSteamAuthorizations,
} from "./Payments";
import { lastUserMeResponse } from "./UserMeBroadcast";
import { translateText } from "./Utils";

type StoreTab =
  | "cosmetics"
  | "bundles"
  | "effects"
  | "packs"
  | "subscriptions"
  | "tribes";

const COSMETICS_SUB_TABS = ["patterns", "flags", "crowns"] as const;
type CosmeticsSubTab = (typeof COSMETICS_SUB_TABS)[number];

/** Sub-tab holding the catalog item a store deep link points at. */
export function subTabForItem(itemKey: string): CosmeticsSubTab {
  if (itemKey.startsWith("crown:")) return "crowns";
  if (itemKey.startsWith("flag:")) return "flags";
  return "patterns";
}

interface StoreBrowserOptions {
  emptyTranslationKey: string;
  userHasSubscription?: boolean;
  trailingContent?: TemplateResult;
  gridClass?: string;
  cardClass?: string;
  emptyClass?: string;
}

// Owned items of these kinds stay listed in the store, marked Owned.
const OWNED_LISTED_TYPES: readonly ResolvedCosmetic["type"][] = [
  "pattern",
  "skin",
  "flag",
  "crown",
  "effect",
];

@customElement("store-modal")
export class StoreModal extends BaseModal {
  protected routerName = "store";
  private cosmetics: Cosmetics | null = null;
  private affiliateCode: string | null = null;
  private userMeResponse: UserMeResponse | false = false;
  // `userMeResponse` starts at `false`, which is also what "no session" looks
  // like, so a tab that renders a sign-in prompt on `false` would show it to a
  // logged-in player for the whole window before Main's first userMeResponse
  // broadcast (a Steam ticket exchange on desktop). This distinguishes the
  // two: nothing is asserted about the session until it has actually settled.
  // Reactive on its own, unlike `userMeResponse`: onUserMe() only calls
  // refresh() after the catalog fetch, and a settled no-session result must
  // not wait on a slow catalog before it may say so.
  @state() private authSettled = false;
  private cosmeticsSubTab: CosmeticsSubTab = "patterns";
  // The Effects tab's own category (Boat trail, Nuke trail, ...) and, for nuke
  // explosions, the bomb the explosion is for (Atom / Hydrogen / MIRV).
  private effectType: EffectType = EFFECT_TYPES[0];
  private nukeType: NukeExplosionType = NUKE_EXPLOSION_TYPES[0];
  // The "Hide owned" filter over the cosmetics and effects grids.
  private hideOwned = false;
  // Item the URL asked for (`#modal=store&item=<key>`). Held until its group
  // is visible, then inspected so the store opens on that item.
  private requestedItem: string | null = null;
  private inspected: ResolvedCosmetic | null = null;
  private previewingCosmetic: ResolvedCosmetic | null = null;
  private visibleGroups: readonly (readonly ResolvedCosmetic[])[] = [];
  /** The bundle whose contents dialog is open, if any. */
  private openedPack: ResolvedCosmetic | null = null;
  private readonly pages = new ProgressiveList(this);

  protected modalConfig() {
    if (this.affiliateCode) {
      // Affiliate mode: hide tabs, show only items associated with the code.
      return { ui: true };
    }
    // The top-level tabs are the header's segmented control, not o-modal's row.
    return { tabs: this.visibleTabs(), hideTabs: true, ui: true };
  }

  /**
   * Only the tabs whose feature exists (docs/DeltaFrontAccountsPlan.md 17.1):
   * currency packs and subscriptions are real-money and need `payments`, custom
   * tribe names need `tribes`, and bundles (priced in the premium currency, so
   * `payments` too) appear only when the loaded catalog has some (DeltaFront's
   * V1 catalog has none). That leaves Cosmetics and
   * Effects, the two tabs that spend Credits.
   */
  private visibleTabs(): Array<{ key: string; label: string }> {
    // Until the catalog has loaded the tab is kept (a deep link to it must
    // survive the load); once loaded, a catalog without bundles drops it.
    const hasBundles =
      this.cosmetics === null ||
      Object.keys(this.cosmetics.packs ?? {}).length > 0;
    const tabs: Array<[boolean, string, string]> = [
      [ACCOUNT_FEATURES.payments, "packs", "store.packs"],
      [ACCOUNT_FEATURES.payments, "subscriptions", "store.subscriptions"],
      [ACCOUNT_FEATURES.payments && hasBundles, "bundles", "store.bundles"],
      [true, "cosmetics", "store.cosmetics"],
      [true, "effects", "store.effects"],
      [ACCOUNT_FEATURES.tribes, "tribes", "store.tribes"],
    ];
    return tabs
      .filter(([shown]) => shown)
      .map(([, key, label]) => ({ key, label: translateText(label) }));
  }

  connectedCallback() {
    super.connectedCallback();
    document.addEventListener("userMeResponse", this.onUserMeEvent);
    // The store loads on demand, usually after Main's broadcast went out.
    const last = lastUserMeResponse();
    if (last !== null) void this.onUserMe(last.response);
    this.addEventListener("open-cosmetic-preview", this.onOpenCosmeticPreview);
    // Rows re-wrap on resize, so which currencies share a row changes with it.
    if (typeof ResizeObserver !== "undefined") {
      this.rowObserver ??= new ResizeObserver(() => alignPurchaseRows(this));
      this.rowObserver.observe(this);
    }
  }

  disconnectedCallback() {
    document.removeEventListener("userMeResponse", this.onUserMeEvent);
    this.removeEventListener(
      "open-cosmetic-preview",
      this.onOpenCosmeticPreview,
    );
    this.rowObserver?.disconnect();
    if (this.alignFrame !== null) cancelAnimationFrame(this.alignFrame);
    this.alignFrame = null;
    super.disconnectedCallback();
  }

  protected updated(changed: PropertyValues) {
    super.updated(changed);
    // The cards are nested components, so their purchase buttons only exist
    // (and only have positions) after their own updates commit — a frame later.
    alignPurchaseRows(this);
    if (typeof requestAnimationFrame === "undefined") return;
    this.alignFrame ??= requestAnimationFrame(() => {
      this.alignFrame = null;
      alignPurchaseRows(this);
    });
  }

  private onUserMeEvent = (event: Event) => {
    const customEvent = event as CustomEvent<UserMeResponse | false>;
    this.onUserMe(customEvent.detail);
  };

  private onOpenCosmeticPreview = (event: Event) => {
    const customEvent = event as CustomEvent<ResolvedCosmetic>;
    this.previewingCosmetic = customEvent.detail;
    this.requestUpdate();
  };

  private rowObserver: ResizeObserver | null = null;
  private alignFrame: number | null = null;

  async onUserMe(userMeResponse: UserMeResponse | false) {
    this.userMeResponse = userMeResponse;
    this.authSettled = true;
    this.cosmetics = await fetchCosmetics();
    this.selectVisible(this.groupsForTab(this.activeTab));
    await this.refresh();
  }

  private renderHeader(): TemplateResult {
    const currency =
      this.userMeResponse === false
        ? undefined
        : this.userMeResponse.player.currency;
    const tabs = this.affiliateCode ? [] : this.visibleTabs();
    const hard = ACCOUNT_FEATURES.payments
      ? formatCurrencyAmount(currency?.hard)
      : null;
    const soft = formatCurrencyAmount(currency?.soft);
    return uiPageHeader({
      title: translateText("store.title"),
      backLabel: translateText("common.back"),
      onBack: () => this.close(),
      controls:
        tabs.length > 1
          ? uiSegmented({
              options: tabs,
              value: this.activeTab,
              onChange: (key) => this.setActiveTab(key),
              ariaLabel: translateText("store.title"),
              name: "store-tabs",
            })
          : undefined,
      status: html`${hard !== null || soft !== null
          ? uiStatusChip(
              html`${hard !== null
                ? html`<span
                    data-store-balance="hard"
                    class="flex items-center gap-2"
                    title=${translateText("cosmetics.hard")}
                    ><plutonium-icon .size=${18}></plutonium-icon>${hard}</span
                  >`
                : ""}${soft !== null
                ? html`<span
                    data-store-balance="soft"
                    class="flex items-center gap-2"
                    title=${translateText("cosmetics.soft")}
                    ><credits-icon .size=${18}></credits-icon>${soft}</span
                  >`
                : ""}`,
            )
          : ""}<not-logged-in-warning></not-logged-in-warning>`,
    });
  }

  /**
   * What the Cosmetics and Effects tabs list: everything for sale and
   * everything the player already owns, so a bought (or free) item stays on
   * its card with an "Owned" status instead of vanishing. The Default tile
   * (no cosmetic) and anything blocked are left out.
   */
  private resolvedListed(): ResolvedCosmetic[] {
    return resolveCosmetics(
      this.cosmetics,
      this.userMeResponse,
      this.affiliateCode,
    ).filter(
      (resolved) =>
        resolved.cosmetic !== null &&
        (resolved.relationship === "purchasable" ||
          (resolved.relationship === "owned" &&
            OWNED_LISTED_TYPES.includes(resolved.type))),
    );
  }

  private resolvedPurchasables(): ResolvedCosmetic[] {
    return resolveCosmetics(
      this.cosmetics,
      this.userMeResponse,
      this.affiliateCode,
    ).filter((resolved) => resolved.relationship === "purchasable");
  }

  /** "Hide owned": drop the groups whose every item the player already owns. */
  private withoutOwned(
    groups: readonly (readonly ResolvedCosmetic[])[],
  ): readonly (readonly ResolvedCosmetic[])[] {
    if (!this.hideOwned) return groups;
    return groups.filter((group) =>
      group.some((item) => item.relationship !== "owned"),
    );
  }

  /** The effects of the category (and, for explosions, the bomb) now shown. */
  private effectGroups(): readonly (readonly ResolvedCosmetic[])[] {
    return this.withoutOwned(
      this.resolvedListed()
        .filter(
          (resolved) =>
            resolved.type === "effect" &&
            resolved.effectType === this.effectType &&
            (this.effectType !== "nukeExplosion" ||
              this.nukeTypeOf(resolved) === this.nukeType),
        )
        .map((resolved) => [resolved]),
    );
  }

  private nukeTypeOf(resolved: ResolvedCosmetic): string | null {
    const effect = resolved.cosmetic as Effect | null;
    return effect && isNukeExplosionEffect(effect)
      ? effect.attributes.nukeType
      : null;
  }

  private cosmeticsGroups(
    tab: CosmeticsSubTab,
  ): readonly (readonly ResolvedCosmetic[])[] {
    return this.withoutOwned(this.unfilteredCosmeticsGroups(tab));
  }

  private unfilteredCosmeticsGroups(
    tab: CosmeticsSubTab,
  ): readonly (readonly ResolvedCosmetic[])[] {
    const items = this.resolvedListed();
    if (tab === "flags") {
      return items
        .filter((resolved) => resolved.type === "flag")
        .map((r) => [r]);
    }
    if (tab === "crowns") {
      return items
        .filter((resolved) => resolved.type === "crown")
        .map((r) => [r]);
    }
    return groupCosmeticVariants(
      items.filter(
        (resolved) => resolved.type === "pattern" || resolved.type === "skin",
      ),
    );
  }

  private groupsForTab(tab: string): readonly (readonly ResolvedCosmetic[])[] {
    if (this.affiliateCode) {
      return groupCosmeticVariants(
        this.resolvedPurchasables().filter((resolved) => {
          const c = resolved.cosmetic;
          return (
            c !== null &&
            "affiliateCode" in c &&
            c.affiliateCode === this.affiliateCode
          );
        }),
      );
    }
    if (tab === "cosmetics") {
      return this.cosmeticsGroups(this.cosmeticsSubTab);
    }
    if (tab === "effects") {
      return this.effectGroups();
    }
    if (tab === "packs") {
      return this.resolvedPurchasables()
        .filter((resolved) => resolved.type === "pack")
        .map((resolved) => [resolved]);
    }
    if (tab === "bundles") {
      // Owned and partially owned bundles stay listed (as a status, not a
      // buy button) so the player can see why one isn't for sale to them.
      return resolveCosmetics(
        this.cosmetics,
        this.userMeResponse,
        this.affiliateCode,
      )
        .filter(
          (resolved) =>
            resolved.type === "cosmeticPack" &&
            (resolved.relationship !== "blocked" ||
              this.ownedPackItemNames(resolved).length > 0),
        )
        .map((resolved) => [resolved]);
    }
    if (tab === "subscriptions") {
      return resolveCosmetics(
        this.cosmetics,
        this.userMeResponse,
        this.affiliateCode,
      )
        .filter(
          (resolved) =>
            resolved.type === "subscription" &&
            (resolved.relationship === "purchasable" ||
              resolved.relationship === "owned"),
        )
        .map((resolved) => [resolved]);
    }
    return [];
  }

  private inspect(resolved: ResolvedCosmetic): void {
    this.inspected = resolved;
    this.requestUpdate();
  }

  // Activating a bundle also opens its contents: the card only has room to
  // tile a few items, so the dialog is where each one is shown with its name.
  private activate(resolved: ResolvedCosmetic): void {
    if (resolved.type === "cosmeticPack") this.openedPack = resolved;
    if (isPreviewableCosmetic(resolved)) this.previewingCosmetic = resolved;
    this.inspect(resolved);
  }

  private closePack(): void {
    this.openedPack = null;
    this.requestUpdate();
  }

  private reconcileInspection(
    groups: readonly (readonly ResolvedCosmetic[])[],
  ): void {
    const visible = groups.flat();
    const wanted = this.requestedItem;
    if (wanted !== null) {
      const match = visible.find((item) => matchesStoreItem(item.key, wanted));
      // The catalog loads after open, so keep the request until its item shows.
      if (match !== undefined) {
        this.requestedItem = null;
        this.inspected = match;
        return;
      }
    }
    const current = visible.find((item) => item.key === this.inspected?.key);
    this.inspected = current ?? groups[0]?.[0] ?? null;
  }

  private selectVisible(
    groups: readonly (readonly ResolvedCosmetic[])[],
  ): void {
    this.visibleGroups = groups;
    this.reconcileInspection(groups);
  }

  protected onTabEnter(key: string): void {
    this.selectVisible(this.groupsForTab(key));
    this.requestUpdate();
  }

  /**
   * Skins and Flags always; Crowns only when the catalog has any (DeltaFront's
   * V1 catalog has none, and an empty tab is a dead end). A catalog that is
   * still loading keeps the tab, like the bundles tab.
   */
  private cosmeticsSubTabs(): readonly CosmeticsSubTab[] {
    const loaded = this.cosmetics !== null;
    const hasCrowns = resolveCosmetics(
      this.cosmetics,
      this.userMeResponse,
      this.affiliateCode,
    ).some((resolved) => resolved.type === "crown");
    return COSMETICS_SUB_TABS.filter(
      (tab) => tab !== "crowns" || !loaded || hasCrowns,
    );
  }

  private setCosmeticsSubTab(tab: CosmeticsSubTab): void {
    this.cosmeticsSubTab = tab;
    this.selectVisible(this.cosmeticsGroups(tab));
    this.requestUpdate();
  }

  /** Display names of the bundle's items the player already owns. */
  private ownedPackItemNames(resolved: ResolvedCosmetic): string[] {
    return ownedPackItems(
      resolved.cosmetic as CosmeticPack,
      this.userMeResponse,
    ).map((item) => {
      const found = findPackItem(item, resolved.packItems ?? []);
      return found ? cosmeticSelectionLabel(found) : item.name;
    });
  }

  // Same box as a purchase button (w-full, min-h-11, text-base) so an owned
  // tier or bundle reads as a peer of its neighbours' buy action instead of
  // a small tag tucked to one side of the card.
  private renderStatus(text: string, muted = false): TemplateResult {
    return html`<span
      data-store-status
      class="mt-2 flex min-h-11 w-full items-center justify-center rounded-lg border px-2 py-1.5 text-center font-bold ${muted
        ? "border-white/15 bg-white/5 text-xs text-white/60"
        : "border-white/30 bg-white/10 text-base text-white"}"
      >${text}</span
    >`;
  }

  private renderCardAction(
    active: ResolvedCosmetic,
    userHasSubscription: boolean,
    ui = false,
  ): TemplateResult {
    if (active.type === "subscription" && active.relationship === "owned") {
      return this.renderStatus(translateText("store.subscribed"));
    }
    if (
      active.relationship === "owned" &&
      OWNED_LISTED_TYPES.includes(active.type)
    ) {
      return this.renderStatus(translateText("store.owned"));
    }
    if (active.type === "cosmeticPack") {
      if (active.relationship === "owned") {
        return this.renderStatus(translateText("store.pack_owned"));
      }
      if (active.relationship === "blocked") {
        return this.renderStatus(
          translateText("store.pack_partially_owned", {
            items: this.ownedPackItemNames(active).join(", "),
          }),
          true,
        );
      }
    }
    return this.renderPurchaseAction(active, userHasSubscription, ui);
  }

  private renderCosmeticCards(
    groups: readonly (readonly ResolvedCosmetic[])[] = this.visibleGroups,
    userHasSubscription = false,
    cardClass = "block h-full min-w-0",
  ): TemplateResult {
    return html`${groups.map((group) => {
      const focused = group.find((item) => item.key === this.inspected?.key);
      const active = focused ?? group[0];
      const action = this.renderCardAction(active, userHasSubscription);
      return html`<cosmetic-card
        data-store-product
        data-cosmetic-key=${group[0].key}
        class=${cardClass}
        .resolved=${group[0]}
        .variants=${group.length > 1 ||
        group[0].type === "pattern" ||
        group[0].type === "skin"
          ? group
          : []}
        .activeVariantKey=${active.key}
        .actionContent=${action}
        state=${focused ? "focused" : "idle"}
        .onActivate=${(resolved: ResolvedCosmetic) => this.activate(resolved)}
        .onVariantActivate=${(resolved: ResolvedCosmetic) =>
          this.inspect(resolved)}
      ></cosmetic-card>`;
    })}`;
  }

  private renderPurchaseAction(
    resolved: ResolvedCosmetic,
    userHasSubscription: boolean,
    ui = false,
  ): TemplateResult {
    const priced = resolved.cosmetic as {
      name?: string;
      product?: Product | null;
      priceHard?: number;
      priceSoft?: number;
      rarity?: string;
    } | null;
    const isPurchasable = resolved.relationship === "purchasable";
    // Only packs and subscriptions still check out in USD; cosmetics are
    // currency-only (their catalog product is always null now, but a cached
    // cosmetics.json may still carry one — never render a dollar button).
    const product =
      isPurchasable &&
      (resolved.type === "pack" || resolved.type === "subscription")
        ? (priced?.product ?? null)
        : null;
    const priceHard = isPurchasable ? priced?.priceHard : undefined;
    const priceSoft = isPurchasable ? priced?.priceSoft : undefined;
    const purchase = (method: "dollar" | "hard" | "soft") =>
      purchaseCosmetic(resolved, method);
    // Currency packs check out inline (wallet button / in-page card form)
    // when the display price parses; anything else — including subscriptions,
    // which are recurring and not a PaymentIntent — keeps the redirect flow,
    // which is also what an unparseable price degrades to.
    const amountCents =
      resolved.type === "pack" && product !== null && priced?.name !== undefined
        ? priceStringToCents(product.price)
        : null;
    const inlineCheckout =
      amountCents !== null
        ? {
            request: {
              kind: "currency_pack" as const,
              packName: priced!.name!,
            },
            amountCents,
            successMessageKey: "store.currency_pack_purchase_success",
          }
        : null;
    // Reserved currency lines are assigned per visual row by
    // alignPurchaseRows() once the grid has laid out.
    return html`<purchase-button
      .ui=${ui}
      .product=${product}
      .inlineCheckout=${inlineCheckout}
      .priceHard=${priceHard ?? null}
      .priceSoft=${priceSoft ?? null}
      .rarity=${priced?.rarity ?? "common"}
      .itemName=${cosmeticSelectionLabel(resolved)}
      .dollarLabelKey=${resolved.type === "subscription" && userHasSubscription
        ? "store.switch_button"
        : ""}
      .priceSuffix=${resolved.type === "subscription"
        ? translateText("store.price_per_month")
        : ""}
      .onPurchaseDollar=${product ? () => purchase("dollar") : undefined}
      .onPurchaseHard=${priceHard !== undefined
        ? () => purchase("hard")
        : undefined}
      .onPurchaseSoft=${priceSoft !== undefined
        ? () => purchase("soft")
        : undefined}
    ></purchase-button>`;
  }

  private renderBrowserLayout(
    cards: TemplateResult,
    gridClass = "grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-4",
  ): TemplateResult {
    return html`<div data-store-browser class="grid grid-cols-1 gap-4 p-3">
      <div data-store-grid class=${gridClass}>${cards}</div>
    </div>`;
  }

  private renderBrowser(
    groups: readonly (readonly ResolvedCosmetic[])[],
    options: StoreBrowserOptions,
  ): TemplateResult {
    const page = this.pages.page(
      "store-grid",
      `${this.affiliateCode ?? ""}:${this.activeTab}:${this.cosmeticsSubTab}`,
      groups,
    );
    const cards =
      groups.length === 0
        ? options.trailingContent
          ? html``
          : html`<div
              class=${`${options.emptyClass ?? "col-span-full"} py-8 text-center text-sm font-bold uppercase tracking-wider text-white/40`}
            >
              ${translateText(options.emptyTranslationKey)}
            </div>`
        : this.renderCosmeticCards(
            page.items,
            options.userHasSubscription,
            options.cardClass,
          );
    return this.renderBrowserLayout(
      html`${cards}${page.more}${options.trailingContent ?? ""}`,
      options.gridClass,
    );
  }

  // ---- The cosmetics and effects pages: categories as underline tabs, a grid of
  // cards, and the selected item in the detail panel with the one buy action.

  private browserTabs(): {
    tabs: { key: string; label: string }[];
    value: string;
    onChange: (key: string) => void;
    ariaLabel: string;
  } {
    if (this.activeTab === "effects") {
      return {
        tabs: EFFECT_TYPES.map((type) => ({
          key: type,
          label: translateText(`effects.type.${type}`),
        })),
        value: this.effectType,
        onChange: (key) => {
          this.effectType = key as EffectType;
          this.pages.reset();
          this.selectVisible(this.effectGroups());
          this.requestUpdate();
        },
        ariaLabel: translateText("store.effects"),
      };
    }
    return {
      tabs: this.cosmeticsSubTabs().map((tab) => ({
        key: tab,
        label: translateText(`store.${tab}`),
      })),
      value: this.cosmeticsSubTab,
      onChange: (key) => this.setCosmeticsSubTab(key as CosmeticsSubTab),
      ariaLabel: translateText("store.cosmetics"),
    };
  }

  private setNukeType(type: NukeExplosionType): void {
    this.nukeType = type;
    this.pages.reset();
    this.selectVisible(this.effectGroups());
    this.requestUpdate();
  }

  private setHideOwned(hide: boolean): void {
    this.hideOwned = hide;
    this.pages.reset();
    this.selectVisible(this.groupsForTab(this.activeTab));
    this.requestUpdate();
  }

  private emptyKey(): string {
    if (this.affiliateCode) return "store.no_affiliate_items";
    if (this.activeTab === "effects") return "store.no_effects";
    return this.cosmeticsSubTab === "flags"
      ? "store.no_flags"
      : this.cosmeticsSubTab === "crowns"
        ? "store.no_crowns"
        : "store.no_skins";
  }

  private priceMeta(resolved: ResolvedCosmetic): TemplateResult | undefined {
    if (resolved.relationship !== "purchasable") return undefined;
    const priced = resolved.cosmetic as {
      priceHard?: number;
      priceSoft?: number;
    } | null;
    if (priced?.priceSoft !== undefined) {
      return html`<credits-icon .size=${14}></credits-icon
        >${priced.priceSoft.toLocaleString()}`;
    }
    if (priced?.priceHard !== undefined) {
      return html`<plutonium-icon .size=${14}></plutonium-icon
        >${priced.priceHard.toLocaleString()}`;
    }
    return undefined;
  }

  private renderItemCard(group: readonly ResolvedCosmetic[]): TemplateResult {
    const focused = group.find((item) => item.key === this.inspected?.key);
    const active = focused ?? group[0];
    return uiItemCard({
      hook: "store-product",
      dataKey: group[0].key,
      preview: html`<cosmetic-preview
        .resolved=${active}
        size="card"
      ></cosmetic-preview>`,
      name: cosmeticDisplayName(active),
      meta: this.priceMeta(active),
      tier: tierForRarity(cosmeticRarity(active)),
      selected: focused !== undefined,
      badge:
        active.relationship === "owned"
          ? uiBadge(translateText("store.owned"), "success")
          : undefined,
      onSelect: () => this.inspect(focused ?? group[0]),
    });
  }

  private renderBrowserPage(): TemplateResult {
    // Affiliate mode lists one creator's items: no categories, just the grid.
    const nav = this.affiliateCode ? null : this.browserTabs();
    const groups = this.visibleGroups;
    const page = this.pages.page(
      "store-grid",
      `${this.affiliateCode ?? ""}:${this.activeTab}:${this.cosmeticsSubTab}:${this.effectType}:${this.nukeType}:${this.hideOwned}`,
      groups,
    );
    const nukeTabs =
      !this.affiliateCode &&
      this.activeTab === "effects" &&
      this.effectType === "nukeExplosion"
        ? uiSegmented({
            options: NUKE_EXPLOSION_TYPES.map((type) => ({
              key: type,
              label: translateText(`effects.nukeType.${type}`),
            })),
            value: this.nukeType,
            onChange: (key) => this.setNukeType(key),
            ariaLabel: translateText("store.effects"),
            name: "nuke-type",
          })
        : html`<span></span>`;
    const content = html`${nav
        ? uiTabs({ ...nav, name: "store-categories" })
        : ""}
      <div class="flex flex-wrap items-center justify-between gap-3 px-6 pt-5">
        ${nukeTabs}
        <div class="ml-auto flex items-center gap-4">
          ${uiCheck({
            label: translateText("store.hide_owned"),
            checked: this.hideOwned,
            onChange: (checked) => this.setHideOwned(checked),
            name: "hide-owned",
          })}
          <span data-store-count class="ui-label normal-case tracking-normal"
            >${translateText("store.items_count", {
              count: groups.length,
            })}</span
          >
        </div>
      </div>
      <div data-store-browser class="p-6">
        ${groups.length === 0
          ? html`<p
              data-store-empty
              class="ui-body py-10 text-center text-ui-muted"
            >
              ${translateText(this.emptyKey())}
            </p>`
          : html`<div
              data-store-grid
              class="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-4"
            >
              ${page.items.map((group) =>
                this.renderItemCard(group),
              )}${page.more}
            </div>`}
      </div>`;
    return uiTwoColumn({ content, detail: this.renderDetailPanel() });
  }

  /** The inspected item's group: its colour variants, if it has any. */
  private inspectedGroup(): readonly ResolvedCosmetic[] {
    const key = this.inspected?.key;
    return (
      this.visibleGroups.find((group) =>
        group.some((item) => item.key === key),
      ) ?? (this.inspected ? [this.inspected] : [])
    );
  }

  private balanceAfter(resolved: ResolvedCosmetic): number | null {
    if (this.userMeResponse === false) return null;
    if (resolved.relationship !== "purchasable") return null;
    const price = (resolved.cosmetic as { priceSoft?: number } | null)
      ?.priceSoft;
    const soft = this.userMeResponse.player.currency?.soft;
    if (price === undefined || soft === undefined || soft === null) return null;
    return Number(soft) - price;
  }

  private renderDetailPanel(): TemplateResult {
    const active = this.inspected;
    if (active === null) {
      return uiDetailPanel({
        body: html`<p data-store-detail-empty class="ui-body text-ui-muted">
          ${translateText("store.select_item")}
        </p>`,
      });
    }
    const group = this.inspectedGroup();
    const priced = active.cosmetic as {
      priceHard?: number;
      priceSoft?: number;
    } | null;
    const effect =
      active.type === "effect" ? (active.cosmetic as Effect) : null;
    const eyebrow =
      cosmeticTypeLabel(active) +
      (this.nukeTypeOf(active) !== null
        ? ` · ${translateText(`effects.nukeType.${this.nukeTypeOf(active)}`)}`
        : "");
    const after = this.balanceAfter(active);
    const rows: { label: string; value: string | TemplateResult }[] = [];
    if (effect !== null) {
      const style = effect.attributes.type;
      rows.push({
        label: translateText("store.style"),
        value: style.charAt(0).toUpperCase() + style.slice(1),
      });
    }
    rows.push({
      label: translateText("store.rarity"),
      value: cosmeticRarityLabel(active),
    });
    if (active.relationship === "purchasable") {
      const price = this.priceMeta(active);
      if (price !== undefined) {
        rows.push({
          label: translateText("store.price"),
          value: html`<span class="inline-flex items-center gap-1.5"
            >${price}</span
          >`,
        });
      }
      if (after !== null) {
        rows.push({
          label: translateText("store.balance_after"),
          value:
            after < 0
              ? html`<span class="text-ui-accent-soft"
                  >${after.toLocaleString()}</span
                >`
              : after.toLocaleString(),
        });
      }
    }
    const swatches = group
      .filter(
        (variant) =>
          variant.colorPalette !== null ||
          (variant.type === "pattern" && variant.cosmetic !== null),
      )
      .map((variant) => ({
        key: variant.key,
        label: variant.colorPalette
          ? translateCosmetic(
              "territory_patterns.color_palette",
              variant.colorPalette.name,
            )
          : translateText("territory_patterns.pattern.default"),
        primary: variant.colorPalette?.primaryColor ?? "var(--color-ui-text)",
        secondary:
          variant.colorPalette?.secondaryColor ?? "var(--color-ui-ground)",
      }));
    const owned =
      active.relationship === "owned" &&
      OWNED_LISTED_TYPES.includes(active.type);
    return uiDetailPanel({
      body: html`<div
          data-store-detail-preview
          class="relative flex aspect-[4/3] items-center justify-center overflow-hidden rounded-ui-card border border-ui-border bg-ui-ground p-4"
        >
          <cosmetic-preview
            .resolved=${active}
            size="detail"
          ></cosmetic-preview>
          ${isPreviewableCosmetic(active)
            ? html`<span class="absolute bottom-3 right-3">
                ${uiButton({
                  label: html`${uiIcons.play()}${translateText("store.preview")}`,
                  onClick: () => {
                    this.previewingCosmetic = active;
                    this.requestUpdate();
                  },
                  name: "preview",
                })}
              </span>`
            : ""}
        </div>
        ${uiDetailHeading({
          eyebrow,
          title: cosmeticDisplayName(active),
        })}
        ${swatches.length > 1
          ? html`<div>
              <div class="ui-label mb-3">${translateText("store.color")}</div>
              ${uiSwatches({
                swatches,
                value: active.key,
                onChange: (key) => {
                  const variant = group.find((item) => item.key === key);
                  if (variant) this.inspect(variant);
                },
              })}
            </div>`
          : ""}
        ${uiDetailRows(rows)}`,
      action: owned
        ? html`<div class="flex flex-col gap-2">
            ${uiButton({
              label: translateText("store.owned"),
              block: true,
              disabled: true,
              name: "owned",
            })}
            ${uiButton({
              label: translateText("store.open_inventory"),
              variant: "text",
              onClick: () => window.showPage?.("page-inventory"),
              name: "open-inventory",
            })}
          </div>`
        : this.renderCardAction(active, false, true),
    });
  }

  private renderPackGrid(): TemplateResult {
    // The custom-amount card is always purchasable (priced inline server-side,
    // no catalog entry), and follows the fixed packs at the end of the grid.
    // On BOTH rails: the Steam rail sells custom amounts since OPE-337, so
    // there is no longer a rail on which this card is a dead button.
    return this.renderBrowser(this.visibleGroups, {
      emptyTranslationKey: "store.no_packs",
      trailingContent: html`<custom-currency-card
        class="block w-[calc(50%-0.5rem)] max-w-48 shrink-0 sm:w-48"
      ></custom-currency-card>`,
      gridClass:
        "flex flex-wrap items-stretch justify-center content-start gap-4 p-4 sm:p-8",
      cardClass: "block w-[calc(50%-0.5rem)] max-w-48 shrink-0 sm:w-48",
      emptyClass:
        "w-full py-8 text-center text-sm font-bold uppercase tracking-wider text-white/40",
    });
  }

  private renderBundleGrid(): TemplateResult {
    return html`${this.renderBrowser(this.visibleGroups, {
      emptyTranslationKey: "store.no_bundles",
    })}${this.openedPack && !this.previewingCosmetic
      ? // The dialog is portaled above the modal's stacking context, so a
        // preview opened from one of its items would render underneath it.
        // Yield to the preview; the dialog comes back when it closes.
        html`<pack-contents-dialog
          .pack=${this.openedPack}
          .actionContent=${this.renderCardAction(this.openedPack, false)}
          @close=${() => this.closePack()}
        ></pack-contents-dialog>`
      : ""}`;
  }

  private renderSubscriptionGrid(): TemplateResult {
    // Drives the "Switch" label on the other tiers' buy buttons. A granted
    // player is deliberately NOT counted (OPE-440): they have nothing to
    // switch from — nobody is billing them — so every tier, theirs included,
    // is a first purchase and reads as a plain price.
    const sub =
      this.userMeResponse === false
        ? null
        : this.userMeResponse.player.subscription;
    const userHasSubscription = sub !== null && !isGrantedSubscription(sub);
    return this.renderBrowser(this.visibleGroups, {
      emptyTranslationKey: "store.no_subscriptions",
      userHasSubscription,
      gridClass:
        "flex flex-wrap items-stretch justify-center content-start gap-4 p-4 sm:p-8",
      cardClass: "block w-[calc(50%-0.5rem)] max-w-48 shrink-0 sm:w-48",
      emptyClass:
        "w-full py-8 text-center text-sm font-bold uppercase tracking-wider text-white/40",
    });
  }

  protected renderHeaderSlot() {
    return html`${this.renderHeader()}
    ${this.previewingCosmetic
      ? html`<cosmetic-preview-modal
          .resolved=${this.previewingCosmetic}
          @close-preview=${() => {
            this.previewingCosmetic = null;
            this.requestUpdate();
          }}
        ></cosmetic-preview-modal>`
      : ""}`;
  }

  protected renderBody(key: string): TemplateResult {
    if (this.affiliateCode) {
      return this.renderBrowserPage();
    }
    switch (key as StoreTab) {
      case "cosmetics":
      case "effects":
        return this.renderBrowserPage();
      case "bundles":
        return this.renderPlainPage(this.renderBundleGrid());
      case "subscriptions":
        return this.renderPlainPage(this.renderSubscriptionGrid());
      case "tribes":
        return this.renderPlainPage(this.renderTribeGrid());
      case "packs":
      default:
        return this.renderPlainPage(this.renderPackGrid());
    }
  }

  /** Packs, subscriptions, bundles and tribes (payments features): no detail panel. */
  private renderPlainPage(content: TemplateResult): TemplateResult {
    return html`<div class="p-3">${content}</div>`;
  }

  private renderTribeGrid(): TemplateResult {
    // The panel's `false` branch is a sign-in prompt, i.e. a logged-out
    // state; hold it back until the session is known (see authSettled).
    if (!this.authSettled) return html``;
    return html`<tribes-panel
      .userMeResponse=${this.userMeResponse}
    ></tribes-panel>`;
  }

  protected async onOpen(args?: Record<string, unknown>) {
    // Drain any Steam overlay approval parked before this UI existed. The
    // main process's "something arrived" nudge is contentless, so one that
    // fired with no window listening is heard by nobody and sits parked until
    // something drains it -- which makes this required on every open, not an
    // optimisation.
    void reportPendingSteamAuthorizations();
    const affiliate =
      typeof args?.affiliateCode === "string" ? args.affiliateCode : null;
    this.affiliateCode = affiliate;
    this.requestedItem = typeof args?.item === "string" ? args.item : null;
    if (this.requestedItem !== null) {
      this.cosmeticsSubTab = subTabForItem(this.requestedItem);
    }
    this.cosmetics ??= await fetchCosmetics();
    this.selectVisible(this.groupsForTab(this.activeTab));
    await this.refresh();
  }

  protected onClose(): void {
    // The store hides via CSS (inline modal), so the tiles never disconnect
    // and an open card-payment modal — portaled to <body> — would float over
    // the play page after Escape closes the store. Close it explicitly.
    for (const inline of this.querySelectorAll<InlineCheckout>(
      "inline-checkout",
    )) {
      inline.closeCardModal();
    }
    this.affiliateCode = null;
    this.openedPack = null;
    this.previewingCosmetic = null;
    this.pages.reset();
    this.requestedItem = null;
    this.selectVisible(this.groupsForTab(this.activeTab));
  }

  public async refresh() {
    this.requestUpdate();
  }
}
