import { ACCOUNT_FEATURES } from "@openfront/shared/AccountFeatures";
import { UserMeResponse } from "@openfront/shared/ApiSchemas";
import { assetUrl } from "@openfront/shared/AssetUrls";
import {
  Cosmetics,
  Effect,
  EFFECT_TYPES,
  EffectType,
  Flag,
  isNukeExplosionEffect,
  NUKE_EXPLOSION_TYPES,
  NukeExplosionType,
  Skin,
} from "@openfront/shared/CosmeticSchemas";
import { PlayerPattern } from "@openfront/shared/WireSchemas";
import type { TemplateResult } from "lit";
import { html, nothing } from "lit";
import { customElement, state } from "lit/decorators.js";
import Countries from "resources/countries.json" with { type: "json" };
import { getUserMe } from "./Api";
import { userAuth } from "./Auth";
import { BaseModal } from "./components/BaseModal";
import "./components/CosmeticCard";
import {
  cosmeticDisplayName,
  cosmeticRarityLabel,
  cosmeticSelectionLabel,
  cosmeticTypeLabel,
} from "./components/CosmeticPresentation";
import { isPreviewableCosmetic } from "./components/CosmeticPreviewBubble";
import "./components/CosmeticPreviewModal";
import "./components/CreditsIcon";
import { formatCurrencyAmount } from "./components/CurrencyDisplay";
import "./components/InventoryLoadoutBar";
import type {
  InventoryCategory,
  InventoryLoadoutEntry,
} from "./components/InventoryLoadoutBar";
import "./components/InventoryLoadoutMenu";
import { ProgressiveList } from "./components/ProgressiveList";
import {
  uiButton,
  uiDetailHeading,
  uiDetailPanel,
  uiDetailRows,
  uiIcons,
  uiPageHeader,
  uiSearch,
  uiSegmented,
  uiStatusChip,
  uiSwatches,
  uiTabs,
  uiTwoColumn,
} from "./components/ui/PageUi";
import { signedOutNotice } from "./components/ui/SignedOutNotice";
import {
  fetchCosmetics,
  groupCosmeticVariants,
  resolveCosmetics,
  ResolvedCosmetic,
  resolvedToPlayerPattern,
  translateCosmetic,
} from "./Cosmetics";
import {
  CROWN_KEY,
  EFFECTS_KEY,
  FLAG_KEY,
  MAX_LOADOUTS,
  PATTERN_KEY,
  USER_SETTINGS_CHANGED_EVENT,
  UserSettings,
} from "./UserSettings";
import { translateText } from "./Utils";

type OwnershipState = "loading" | "guest" | "loaded" | "error";

function countryFlag(name: string, code: string): Flag {
  return {
    name,
    url: assetUrl(`/flags/${code}.svg`),
    product: null,
    rarity: "common",
    affiliateCode: null,
  };
}

/**
 * The player's owned cosmetics, grouped into equip categories.
 */
@customElement("inventory-modal")
export class InventoryModal extends BaseModal {
  protected routerName = "inventory";

  @state() private search = "";
  @state() private isLoading = false;
  @state() private loadFailed = false;
  @state() private ownershipState: OwnershipState = "loading";
  @state() private previewingCosmetic: ResolvedCosmetic | null = null;
  // The item the detail panel shows (selecting a card inspects it; the panel's
  // Equip / Unequip button is what changes what is worn).
  @state() private inspectedKey: string | null = null;
  // The Effects category's own sub-tabs (Boat trail, Nuke trail, ...) and, for
  // nuke explosions, the bomb the explosion is for.
  @state() private effectType: EffectType = EFFECT_TYPES[0];
  @state() private nukeType: NukeExplosionType = NUKE_EXPLOSION_TYPES[0];

  private cosmetics: Cosmetics | null = null;
  private userSettings: UserSettings = new UserSettings();
  private userMeResponse: UserMeResponse | false = false;
  private catalogLoad: Promise<Cosmetics | null> | null = null;
  private inventoryLoadId = 0;
  private ownershipLoadId = 0;
  private resolvedCache:
    | {
        cosmetics: Cosmetics | null;
        userMeResponse: UserMeResponse | false;
        items: ResolvedCosmetic[];
      }
    | undefined;
  private readonly countryFlagTiles = Countries.filter(
    (country) => country.code !== "xx" && country.restricted !== true,
  ).map<ResolvedCosmetic>((country) => ({
    type: "flag",
    cosmetic: countryFlag(country.name, country.code),
    colorPalette: null,
    relationship: "owned",
    key: `country:${country.code}`,
  }));
  protected modalConfig() {
    return {
      ui: true,
      hideTabs: true,
      tabs: [
        { key: "skins", label: translateText("store.patterns") },
        { key: "flags", label: translateText("store.flags") },
        { key: "crowns", label: translateText("store.crowns") },
        { key: "effects", label: translateText("store.effects") },
      ],
    };
  }

  private readonly pages = new ProgressiveList(this);

  private _onCosmeticSelected = () => this.updateFromSettings();

  private _onUserMe = (event: Event) => {
    void this.onUserMe((event as CustomEvent<UserMeResponse | false>).detail);
  };

  private onOpenCosmeticPreview = (event: Event) => {
    const customEvent = event as CustomEvent<ResolvedCosmetic>;
    this.previewingCosmetic = customEvent.detail;
  };

  connectedCallback() {
    super.connectedCallback();
    document.addEventListener("userMeResponse", this._onUserMe);
    this.addEventListener("open-cosmetic-preview", this.onOpenCosmeticPreview);
    window.addEventListener(
      `${USER_SETTINGS_CHANGED_EVENT}:${PATTERN_KEY}`,
      this._onCosmeticSelected,
    );
    window.addEventListener(
      `${USER_SETTINGS_CHANGED_EVENT}:${FLAG_KEY}`,
      this._onCosmeticSelected,
    );
    window.addEventListener(
      `${USER_SETTINGS_CHANGED_EVENT}:${CROWN_KEY}`,
      this._onCosmeticSelected,
    );
    window.addEventListener(
      `${USER_SETTINGS_CHANGED_EVENT}:${EFFECTS_KEY}`,
      this._onCosmeticSelected,
    );
  }

  disconnectedCallback() {
    this.removeEventListener(
      "open-cosmetic-preview",
      this.onOpenCosmeticPreview,
    );
    super.disconnectedCallback();
    document.removeEventListener("userMeResponse", this._onUserMe);
    window.removeEventListener(
      `${USER_SETTINGS_CHANGED_EVENT}:${PATTERN_KEY}`,
      this._onCosmeticSelected,
    );
    window.removeEventListener(
      `${USER_SETTINGS_CHANGED_EVENT}:${FLAG_KEY}`,
      this._onCosmeticSelected,
    );
    window.removeEventListener(
      `${USER_SETTINGS_CHANGED_EVENT}:${CROWN_KEY}`,
      this._onCosmeticSelected,
    );
    window.removeEventListener(
      `${USER_SETTINGS_CHANGED_EVENT}:${EFFECTS_KEY}`,
      this._onCosmeticSelected,
    );
  }

  private updateFromSettings(): void {
    this.requestUpdate();
  }

  private async loadOwnership(
    userMeResponse?: UserMeResponse | false,
  ): Promise<void> {
    const loadId = ++this.ownershipLoadId;
    if (userMeResponse !== undefined && userMeResponse !== false) {
      this.userMeResponse = userMeResponse;
      this.ownershipState = "loaded";
      return;
    }

    try {
      const auth = await userAuth();
      if (loadId !== this.ownershipLoadId) return;
      if (auth === false) {
        this.userMeResponse = false;
        this.ownershipState = "guest";
        return;
      }

      const response = userMeResponse === false ? false : await getUserMe();
      if (loadId !== this.ownershipLoadId) return;
      if (response === false) {
        this.userMeResponse = false;
        this.ownershipState = "error";
        return;
      }

      this.userMeResponse = response;
      this.ownershipState = "loaded";
    } catch {
      if (loadId !== this.ownershipLoadId) return;
      this.userMeResponse = false;
      this.ownershipState = "error";
    }
  }

  private loadCatalog(): Promise<Cosmetics | null> {
    if (this.catalogLoad !== null) return this.catalogLoad;
    const request = fetchCosmetics();
    const guarded = request.finally(() => {
      if (this.catalogLoad === guarded) this.catalogLoad = null;
    });
    this.catalogLoad = guarded;
    return guarded;
  }

  private async loadInventory(
    userMeResponse?: UserMeResponse | false,
  ): Promise<void> {
    const loadId = ++this.inventoryLoadId;
    this.isLoading = true;
    this.loadFailed = false;
    this.ownershipState = "loading";
    try {
      const [cosmetics] = await Promise.all([
        this.loadCatalog(),
        this.loadOwnership(userMeResponse),
      ]);
      if (loadId !== this.inventoryLoadId) return;
      this.cosmetics = cosmetics;
      this.loadFailed = cosmetics === null;
    } catch {
      if (loadId !== this.inventoryLoadId) return;
      this.cosmetics = null;
      this.loadFailed = true;
      if (this.ownershipState === "loading") this.ownershipState = "error";
    } finally {
      if (loadId === this.inventoryLoadId) {
        this.isLoading = false;
        this.updateFromSettings();
      }
    }
  }

  async onUserMe(userMeResponse: UserMeResponse | false) {
    await this.loadInventory(userMeResponse);
  }

  private includedInSearch(name: string): boolean {
    const displayName = name.replace(/_/g, " ");
    return displayName.toLowerCase().includes(this.search.toLowerCase());
  }

  private handleSearch(event: Event) {
    this.search = (event.target as HTMLInputElement).value;
  }

  private hasOwnedCatalogItem(
    types: readonly ResolvedCosmetic["type"][],
  ): boolean {
    return this.resolvedItems().some(
      (resolved) =>
        types.includes(resolved.type) &&
        resolved.cosmetic !== null &&
        resolved.relationship === "owned",
    );
  }

  private resolvedItems(): ResolvedCosmetic[] {
    if (
      this.resolvedCache?.cosmetics === this.cosmetics &&
      this.resolvedCache.userMeResponse === this.userMeResponse
    ) {
      return this.resolvedCache.items;
    }
    const items = resolveCosmetics(this.cosmetics, this.userMeResponse, null);
    this.resolvedCache = {
      cosmetics: this.cosmetics,
      userMeResponse: this.userMeResponse,
      items,
    };
    return items;
  }

  private equippedSkin(): ResolvedCosmetic | null {
    const items = this.resolvedItems();
    const skinName = this.userSettings.getSelectedSkinName();
    if (skinName !== null) {
      return (
        items.find(
          (item) => item.type === "skin" && item.cosmetic?.name === skinName,
        ) ?? null
      );
    }
    const pattern = this.userSettings.getSelectedPatternName(this.cosmetics);
    if (pattern === null) return null;
    return (
      items.find(
        (item) =>
          item.type === "pattern" &&
          item.cosmetic?.name === pattern.name &&
          (item.colorPalette?.name ?? null) ===
            (pattern.colorPalette?.name ?? null),
      ) ?? null
    );
  }

  private equippedFlag(): ResolvedCosmetic | null {
    const selectedFlag = this.userSettings.getFlag();
    if (selectedFlag === null) return null;
    return (
      this.resolvedItems().find(
        (item) => item.type === "flag" && item.key === selectedFlag,
      ) ??
      this.countryFlagTiles.find((item) => item.key === selectedFlag) ??
      null
    );
  }

  private equippedCrown(): ResolvedCosmetic | null {
    const selectedCrown = this.userSettings.getSelectedCrownName();
    if (selectedCrown === null) return null;
    return (
      this.resolvedItems().find(
        (item) =>
          item.type === "crown" && item.cosmetic?.name === selectedCrown,
      ) ?? null
    );
  }

  private effectSlotFor(item: ResolvedCosmetic): string | null {
    if (item.type !== "effect" || item.cosmetic === null) return null;
    const effect = item.cosmetic as Effect;
    if (isNukeExplosionEffect(effect)) return effect.attributes.nukeType;
    return item.effectType ?? null;
  }

  private equippedEffects(): ResolvedCosmetic[] {
    const selected = this.userSettings.getSelectedEffects();
    return this.resolvedItems().filter(
      (item) =>
        item.type === "effect" &&
        item.cosmetic !== null &&
        this.effectSlotFor(item) !== null &&
        selected[this.effectSlotFor(item)!] === item.cosmetic.name,
    );
  }

  /**
   * The crowns slot exists only while the catalog defines crowns: DeltaFront's
   * V1 catalog has none, and an empty slot would only be a dead end.
   */
  private catalogHasCrowns(): boolean {
    return Object.keys(this.cosmetics?.crowns ?? {}).length > 0;
  }

  private loadoutEntries(): InventoryLoadoutEntry[] {
    const effects = this.equippedEffects();
    const entries: Array<{
      category: Exclude<InventoryCategory, "effects">;
      label: string;
      item: ResolvedCosmetic | null;
    }> = [
      {
        category: "skins",
        label: translateText("store.patterns"),
        item: this.equippedSkin(),
      },
      {
        category: "flags",
        label: translateText("store.flags"),
        item: this.equippedFlag(),
      },
      {
        category: "crowns",
        label: translateText("store.crowns"),
        item: this.equippedCrown(),
      },
    ];
    return [
      ...entries
        .filter(
          ({ category }) => category !== "crowns" || this.catalogHasCrowns(),
        )
        .map(({ category, label, item }) => ({
          category,
          label,
          items: item ? [item] : [],
          summary: item ? cosmeticDisplayName(item) : "",
        })),
      {
        category: "effects",
        label: translateText("store.effects"),
        items: effects,
        summary: translateText("inventory.showing_effects", {
          count: effects.length,
        }),
      },
    ];
  }

  /** Slot buttons read as a numbered row, so keep them in slot order. */
  private loadoutNames(): string[] {
    return this.userSettings
      .getLoadouts()
      .map((loadout) => loadout.name)
      .sort();
  }

  private hasEquippedCosmetic(): boolean {
    const current = this.userSettings.captureLoadout("");
    return (
      current.pattern !== null ||
      current.flag !== null ||
      current.crown !== null ||
      Object.keys(current.effects).length > 0
    );
  }

  private renderLoadoutMenu(): TemplateResult {
    const names = this.loadoutNames();
    return html`<inventory-loadout-menu
      .names=${names}
      .active=${this.userSettings.getActiveLoadout() ?? ""}
      .canAdd=${names.length < MAX_LOADOUTS}
      .onSelect=${(name: string) => this.applyLoadout(name)}
      .onAdd=${() => this.addLoadout()}
      .onDelete=${(name: string) => this.deleteLoadout(name)}
    ></inventory-loadout-menu>`;
  }

  private applyLoadout(name: string) {
    // Re-selecting the active slot would only re-equip what's already worn.
    if (this.userSettings.getActiveLoadout() === name) return;
    if (!this.userSettings.applyLoadout(name)) return;
    this.showMessage(translateText("inventory.loadout_applied", { name }));
    this.updateFromSettings();
  }

  private addLoadout() {
    const added = this.userSettings.addLoadout();
    if (added === null) {
      this.showMessage(
        translateText("inventory.loadout_limit", { count: MAX_LOADOUTS }),
      );
      return;
    }
    this.showMessage(
      translateText("inventory.loadout_saved", { name: added.name }),
    );
    this.updateFromSettings();
  }

  private deleteLoadout(name: string) {
    this.userSettings.deleteLoadout(name);
    this.showMessage(translateText("inventory.loadout_deleted", { name }));
    this.updateFromSettings();
  }

  private unequipAll() {
    this.userSettings.unequipAll();
    this.showMessage(translateText("inventory.unequipped_all"));
    this.updateFromSettings();
  }

  // ---- The groups each category lists (one card per group of colour variants)

  private skinGroups(): readonly (readonly ResolvedCosmetic[])[] {
    return groupCosmeticVariants(
      this.resolvedItems().filter(
        (r) =>
          (r.type === "pattern" || r.type === "skin") &&
          r.relationship === "owned" &&
          r.cosmetic !== null &&
          this.includedInSearch(r.cosmetic.name),
      ),
    );
  }

  private crownGroups(): readonly (readonly ResolvedCosmetic[])[] {
    return this.resolvedItems()
      .filter(
        (r) =>
          r.type === "crown" &&
          r.relationship === "owned" &&
          r.cosmetic !== null &&
          this.includedInSearch(r.cosmetic.name),
      )
      .map((r) => [r]);
  }

  private flagGroups(): readonly (readonly ResolvedCosmetic[])[] {
    const cosmeticFlags = this.resolvedItems().filter(
      (r) =>
        r.type === "flag" &&
        r.relationship === "owned" &&
        r.cosmetic !== null &&
        this.includedInSearch(r.cosmetic.name),
    );
    const countryFlags = this.countryFlagTiles.filter(
      (resolved) =>
        this.includedInSearch(resolved.cosmetic!.name) ||
        this.includedInSearch(resolved.key.slice("country:".length)),
    );
    return [...cosmeticFlags, ...countryFlags].map((r) => [r]);
  }

  private nukeTypeOf(item: ResolvedCosmetic): string | null {
    const effect = item.cosmetic as Effect | null;
    return effect && isNukeExplosionEffect(effect)
      ? effect.attributes.nukeType
      : null;
  }

  private effectGroups(): readonly (readonly ResolvedCosmetic[])[] {
    return this.resolvedItems()
      .filter(
        (r) =>
          r.type === "effect" &&
          r.cosmetic !== null &&
          r.relationship === "owned" &&
          r.effectType === this.effectType &&
          (this.effectType !== "nukeExplosion" ||
            this.nukeTypeOf(r) === this.nukeType) &&
          this.includedInSearch(r.cosmetic.name),
      )
      .map((r) => [r]);
  }

  private groupsFor(tab: string): readonly (readonly ResolvedCosmetic[])[] {
    if (tab === "flags") return this.flagGroups();
    if (tab === "crowns" && this.catalogHasCrowns()) return this.crownGroups();
    if (tab === "effects") return this.effectGroups();
    return this.skinGroups();
  }

  /** Whether an item is what the player is wearing now. */
  private isEquipped(item: ResolvedCosmetic): boolean {
    switch (item.type) {
      case "pattern":
      case "skin":
        return this.equippedSkin()?.key === item.key;
      case "flag":
        return this.equippedFlag()?.key === item.key;
      case "crown":
        return this.equippedCrown()?.key === item.key;
      case "effect": {
        const slot = this.effectSlotFor(item);
        return (
          slot !== null &&
          this.userSettings.getSelectedEffects()[slot] === item.cosmetic?.name
        );
      }
      default:
        return false;
    }
  }

  private selectEffect(item: ResolvedCosmetic, equip: boolean): void {
    const slot = this.effectSlotFor(item);
    if (slot === null) return;
    this.userSettings.setSelectedEffectName(
      slot,
      equip ? (item.cosmetic?.name ?? undefined) : undefined,
    );
    if (equip) this.showSelectedPopup(item);
    this.requestUpdate();
  }

  private equip(item: ResolvedCosmetic): void {
    if (item.type === "pattern" || item.type === "skin") {
      this.selectCosmetic(item);
    } else if (item.type === "crown") {
      this.selectCrown(item);
    } else if (item.type === "flag") {
      this.selectFlag(item);
    } else if (item.type === "effect") {
      this.selectEffect(item, true);
    }
  }

  private unequip(item: ResolvedCosmetic): void {
    if (item.type === "pattern" || item.type === "skin") {
      this.userSettings.setSelectedPatternName(undefined);
    } else if (item.type === "crown") {
      this.userSettings.setSelectedCrownName(undefined);
    } else if (item.type === "flag") {
      this.userSettings.clearFlag(true);
    } else if (item.type === "effect") {
      this.selectEffect(item, false);
    }
  }

  private inspect(item: ResolvedCosmetic): void {
    this.inspectedKey = item.key;
  }

  /** The group the panel shows: the inspected one, else the worn one, else the first. */
  private panelGroup(
    groups: readonly (readonly ResolvedCosmetic[])[],
  ): readonly ResolvedCosmetic[] | null {
    return (
      groups.find((g) => g.some((i) => i.key === this.inspectedKey)) ??
      groups.find((g) => g.some((i) => this.isEquipped(i))) ??
      groups[0] ??
      null
    );
  }

  private panelItem(group: readonly ResolvedCosmetic[]): ResolvedCosmetic {
    return (
      group.find((i) => i.key === this.inspectedKey) ??
      group.find((i) => this.isEquipped(i)) ??
      group[0]
    );
  }

  private renderEmptyState(tab: string): TemplateResult {
    if (tab === "flags") return html``;
    if (tab === "effects") {
      return html`<p
        data-effects-empty=${this.effectType}
        class="ui-body py-10 text-center text-ui-muted"
      >
        ${translateText("inventory.no_owned_effects_of_type", {
          type: translateText(`effects.type.${this.effectType}`),
        })}
      </p>`;
    }
    const key = tab === "crowns" ? "crowns" : "skins";
    return html`<p
      data-inventory-empty=${key}
      class="ui-body py-10 text-center text-ui-muted"
    >
      ${translateText(`inventory.no_owned_${key}`)}
    </p>`;
  }

  // The same card as the Store's (components/CosmeticCard.ts): a worn item is
  // marked Equipped, the inspected one is focused, and picking one only shows it
  // in the detail panel, which holds Equip / Unequip.
  private renderItemCard(group: readonly ResolvedCosmetic[]): TemplateResult {
    const worn = group.find((i) => this.isEquipped(i));
    const inspected = group.find((i) => i.key === this.inspectedKey);
    const active = inspected ?? worn ?? group[0];
    return html`<cosmetic-card
      data-inventory-item
      data-cosmetic-key=${group[0].key}
      class="block h-full min-w-0"
      .resolved=${group[0]}
      .variants=${group.length > 1 ||
      group[0].type === "pattern" ||
      group[0].type === "skin"
        ? group
        : []}
      .activeVariantKey=${active.key}
      state=${worn ? "equipped" : inspected ? "focused" : "idle"}
      .onActivate=${(item: ResolvedCosmetic) => this.inspect(item)}
      .onVariantActivate=${(item: ResolvedCosmetic) => this.inspect(item)}
    ></cosmetic-card>`;
  }

  private renderDetailPanel(
    groups: readonly (readonly ResolvedCosmetic[])[],
  ): TemplateResult {
    const group = this.panelGroup(groups);
    if (group === null) {
      return uiDetailPanel({
        body: html`<p data-inventory-detail-empty class="ui-body text-ui-muted">
          ${translateText("inventory.select_item")}
        </p>`,
      });
    }
    const active = this.panelItem(group);
    const worn = this.isEquipped(active);
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
    const eyebrow =
      cosmeticTypeLabel(active) +
      (this.nukeTypeOf(active) !== null
        ? ` · ${translateText(`effects.nukeType.${this.nukeTypeOf(active)}`)}`
        : "");
    return uiDetailPanel({
      body: html`<div
          data-inventory-detail-preview
          class="relative flex aspect-[4/3] items-center justify-center overflow-hidden rounded-ui-card border border-ui-border bg-ui-ground p-4"
        >
          <cosmetic-preview
            .resolved=${active}
            size="detail"
          ></cosmetic-preview>
        </div>
        <!-- Under the artwork, not on it: the button used to cover its corner. -->
        ${isPreviewableCosmetic(active)
          ? html`<div class="[&>button]:w-full">
              ${uiButton({
                label: html`${uiIcons.play()}${translateText("store.preview")}`,
                onClick: () => (this.previewingCosmetic = active),
                name: "preview",
              })}
            </div>`
          : nothing}
        ${uiDetailHeading({ eyebrow, title: cosmeticDisplayName(active) })}
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
          : nothing}
        ${uiDetailRows([
          {
            label: translateText("store.rarity"),
            value: cosmeticRarityLabel(active),
          },
        ])}`,
      action: worn
        ? uiButton({
            label: translateText("inventory.unequip"),
            block: true,
            name: "unequip",
            onClick: () => this.unequip(active),
          })
        : uiButton({
            label: translateText("inventory.equip"),
            variant: "primary",
            block: true,
            name: "equip",
            onClick: () => this.equip(active),
          }),
    });
  }

  /**
   * The Credits balance and, when the account is not signed in, the way to
   * sign in. The Store button is part of the store feature (milestone M5) and
   * does not exist before it: the inventory never offers a purchase.
   */
  private renderHeaderActions(isLoggedIn: boolean): TemplateResult {
    const credits =
      this.userMeResponse === false
        ? null
        : (this.userMeResponse.player.currency?.soft ?? null);
    const showStore = isLoggedIn && ACCOUNT_FEATURES.store;
    const showSignIn = !isLoggedIn && ACCOUNT_FEATURES.accounts;
    return html`${isLoggedIn && credits !== null
      ? html`<span data-inventory-credits
          >${uiStatusChip(
            html`<credits-icon .size=${18}></credits-icon
              >${formatCurrencyAmount(credits)}`,
          )}</span
        >`
      : nothing}
    ${showStore || showSignIn
      ? html`<span class="no-crazygames">
          ${uiButton({
            label: isLoggedIn
              ? html`${translateText("main.store")}${uiIcons.arrowRight()}`
              : translateText("common.not_logged_in"),
            name: isLoggedIn ? "store" : "sign-in",
            onClick: () => {
              if (isLoggedIn) {
                this.close();
                window.location.hash = "modal=store&tab=cosmetics";
              } else {
                window.showPage?.("page-account");
              }
            },
          })}
        </span>`
      : nothing}`;
  }

  protected renderHeaderSlot() {
    const isLoggedIn = this.userMeResponse !== false;
    return html`${uiPageHeader({
      title: translateText("inventory.title"),
      backLabel: translateText("common.back"),
      onBack: () => this.close(),
      controls: this.isModalOpen ? this.renderLoadoutMenu() : undefined,
      status: this.renderHeaderActions(isLoggedIn),
    })}
    ${this.previewingCosmetic
      ? html`<cosmetic-preview-modal
          .resolved=${this.previewingCosmetic}
          @close-preview=${() => {
            this.previewingCosmetic = null;
          }}
        ></cosmetic-preview-modal>`
      : nothing}`;
  }

  private effectTabs() {
    const tabs = uiTabs({
      tabs: EFFECT_TYPES.map((type) => ({
        key: type,
        label: translateText(`effects.type.${type}`),
      })),
      value: this.effectType,
      onChange: (key) => {
        this.effectType = key as EffectType;
        this.pages.reset();
      },
      ariaLabel: translateText("store.effects"),
      name: "inventory-effects",
    });
    const nuke =
      this.effectType === "nukeExplosion"
        ? html`<div class="px-6 pt-4">
            ${uiSegmented({
              options: NUKE_EXPLOSION_TYPES.map((type) => ({
                key: type,
                label: translateText(`effects.nukeType.${type}`),
              })),
              value: this.nukeType,
              onChange: (key) => {
                this.nukeType = key;
                this.pages.reset();
              },
              ariaLabel: translateText("store.effects"),
              name: "nuke-type",
            })}
          </div>`
        : nothing;
    return html`${tabs}${nuke}`;
  }

  protected renderBody(tab: string) {
    // BaseModal renders the body even while closed, and this one is always
    // mounted: skip building a grid no one can see from the main menu.
    if (!this.isModalOpen) return html``;
    if (this.isLoading || this.ownershipState === "loading") {
      return html`<div
        data-inventory-state="loading"
        aria-busy="true"
        class="p-6"
      >
        <span class="sr-only">${translateText("inventory.loading")}</span>
        <div
          data-inventory-skeleton="loadout"
          class="my-2 h-28 animate-pulse rounded-ui-card bg-ui-surface"
        ></div>
        <div
          data-inventory-skeleton="grid"
          class="grid grid-cols-2 gap-3 sm:grid-cols-3"
        >
          ${Array.from(
            { length: 6 },
            () =>
              html`<div
                class="aspect-square animate-pulse rounded-ui-card bg-ui-surface"
              ></div>`,
          )}
        </div>
      </div>`;
    }
    if (this.loadFailed || this.ownershipState === "error") {
      return html`<div
        data-inventory-state="error"
        class="flex flex-col items-center gap-4 p-8 text-center text-ui-accent-soft"
      >
        <p>${translateText("inventory.load_failed")}</p>
        <button
          type="button"
          data-inventory-retry
          ?disabled=${this.isLoading}
          class="ui-focus min-h-11 rounded-ui-card bg-ui-accent px-5 font-ui text-[13px] font-bold uppercase tracking-[0.06em] text-white disabled:cursor-not-allowed disabled:opacity-50"
          @click=${(event: Event) => {
            if (this.isLoading) return;
            (event.currentTarget as HTMLButtonElement).disabled = true;
            void this.loadInventory();
          }}
        >
          ${translateText("inventory.retry")}
        </button>
      </div>`;
    }
    const activeTab =
      tab === "crowns" && !this.catalogHasCrowns() ? "skins" : tab;
    const groups = this.groupsFor(activeTab);
    const page = this.pages.page(
      `inventory-${activeTab}`,
      `${this.search}:${this.effectType}:${this.nukeType}`,
      groups,
    );
    const category = tab as InventoryCategory;
    const owned = groups.length;
    const content = html`${this.ownershipState === "guest"
        ? html`<div data-inventory-sign-in class="px-6 pt-6">
            ${signedOutNotice(
              () => window.showPage?.("page-account"),
              translateText("inventory.sign_in_for_cosmetics"),
            )}
          </div>`
        : nothing}
      <div class="flex items-center justify-between px-6 pb-3 pt-6">
        <h2 class="ui-label">${translateText("inventory.equipped_heading")}</h2>
        <span data-inventory-unequip-all-wrap>
          ${uiButton({
            label: translateText("inventory.unequip_all"),
            variant: "text",
            disabled: !this.hasEquippedCosmetic(),
            name: "unequip-all",
            onClick: () => this.unequipAll(),
          })}
        </span>
      </div>
      <div class="px-6">
        <inventory-loadout-bar
          .entries=${this.loadoutEntries()}
          .activeCategory=${category}
          .onCategorySelect=${(selected: InventoryCategory) =>
            this.setActiveTab(selected)}
        ></inventory-loadout-bar>
      </div>
      <div class="mt-6 border-t border-ui-border"></div>
      ${activeTab === "effects" ? this.effectTabs() : nothing}
      <div class="flex flex-wrap items-center justify-between gap-3 px-6 pt-5">
        <div class="flex items-baseline gap-3">
          <h2 class="ui-heading text-ui-text">
            ${translateText(
              activeTab === "effects"
                ? "store.effects"
                : activeTab === "flags"
                  ? "store.flags"
                  : activeTab === "crowns"
                    ? "store.crowns"
                    : "store.patterns",
            )}
          </h2>
          <span
            data-inventory-count
            class="ui-label normal-case tracking-normal"
            >${translateText("inventory.owned_count", { count: owned })}</span
          >
        </div>
        <div class="w-full sm:w-[280px]">
          ${uiSearch({
            value: this.search,
            placeholder: translateText("cosmetics.search"),
            ariaLabel: translateText("cosmetics.search"),
            onInput: (value) => (this.search = value),
          })}
        </div>
      </div>
      <div class="p-6">
        ${owned === 0 ? this.renderEmptyState(activeTab) : nothing}
        <div
          data-inventory-grid=${activeTab}
          class="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-4"
        >
          ${page.items.map((group) => this.renderItemCard(group))}${page.more}
        </div>
      </div>`;
    return uiTwoColumn({ content, detail: this.renderDetailPanel(groups) });
  }

  public open(args?: Record<string, unknown>): void {
    const tabs = this.modalConfig().tabs ?? [];
    const requestedTab =
      typeof args?.tab === "string" && tabs.some((tab) => tab.key === args.tab)
        ? args.tab
        : null;
    const tab = requestedTab ?? (this.activeTab || tabs[0]?.key);
    super.open({ ...args, ...(tab ? { tab } : {}) });
  }

  protected async onOpen(): Promise<void> {
    if (
      this.ownershipState === "loading" ||
      (this.cosmetics === null && !this.loadFailed)
    ) {
      await this.loadInventory();
      return;
    }
    this.updateFromSettings();
  }

  protected onClose(): void {
    this.search = "";
    this.previewingCosmetic = null;
    this.pages.reset();
  }

  // A query typed for skins rarely matches anything in flags, so a stale
  // search reads as an empty tab. Reset it whenever the category changes.
  protected onTabEnter(key: string): void {
    this.search = "";
    // Effects open on their first category, as they always have.
    if (key === "effects") {
      this.effectType = EFFECT_TYPES[0];
      this.nukeType = NUKE_EXPLOSION_TYPES[0];
    }
  }

  private selectCosmetic(resolved: ResolvedCosmetic) {
    if (resolved.type === "pattern") {
      this.selectPattern(resolvedToPlayerPattern(resolved), resolved);
    } else if (resolved.type === "skin") {
      this.selectSkin((resolved.cosmetic as Skin | null)?.name ?? null);
      this.showSelectedPopup(resolved);
    }
  }

  private selectSkin(skinName: string | null) {
    this.userSettings.setSelectedPatternName(
      skinName === null ? undefined : `skin:${skinName}`,
    );
  }

  private selectCrown(resolved: ResolvedCosmetic) {
    this.userSettings.setSelectedCrownName(
      resolved.cosmetic?.name ?? undefined,
    );
    this.showSelectedPopup(resolved);
  }

  private selectFlag(resolved: ResolvedCosmetic) {
    this.userSettings.setFlag(resolved.key);
    this.showSelectedPopup(resolved);
  }

  private selectPattern(
    pattern: PlayerPattern | null,
    resolved: ResolvedCosmetic,
  ) {
    if (pattern === null) {
      this.userSettings.setSelectedPatternName(undefined);
    } else {
      const name =
        pattern.colorPalette?.name === undefined
          ? pattern.name
          : `${pattern.name}:${pattern.colorPalette.name}`;
      this.userSettings.setSelectedPatternName(`pattern:${name}`);
    }
    this.showSelectedPopup(resolved);
  }

  private showSelectedPopup(resolved: ResolvedCosmetic) {
    this.showMessage(
      translateText("inventory.selected_cosmetic", {
        name: cosmeticSelectionLabel(resolved),
      }),
    );
  }

  private showMessage(message: string) {
    window.dispatchEvent(
      new CustomEvent("show-message", {
        detail: { message, duration: 2000 },
      }),
    );
  }

  public async refresh() {
    this.requestUpdate();
  }
}
