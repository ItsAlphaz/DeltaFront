import type { UserMeResponse } from "@openfront/shared/ApiSchemas";
import type { Cosmetics } from "@openfront/shared/CosmeticSchemas";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getUserMe } from "../../src/client/Api";
import { userAuth } from "../../src/client/Auth";
import {
  fetchCosmetics,
  type ResolvedCosmetic,
} from "../../src/client/Cosmetics";
import "../../src/client/InventoryModal";
import type { InventoryModal } from "../../src/client/InventoryModal";
import { modalRouter } from "../../src/client/ModalRouter";
import "../../src/client/Store";
import type { StoreModal } from "../../src/client/Store";
import {
  PATTERN_KEY,
  USER_SETTINGS_CHANGED_EVENT,
  UserSettings,
} from "../../src/client/UserSettings";

vi.mock("../../src/client/Api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/client/Api")>()),
  getUserMe: vi.fn(),
}));

vi.mock("../../src/client/Auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/client/Auth")>()),
  userAuth: vi.fn(),
}));

vi.mock("../../src/client/Cosmetics", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/client/Cosmetics")>()),
  fetchCosmetics: vi.fn(),
}));

const catalog = {
  patterns: {
    stripes: {
      name: "stripes",
      pattern: "AAAAAA",
      product: null,
      priceHard: 120,
      rarity: "rare",
      affiliateCode: null,
      colorPalettes: [
        { name: "yellow", isArchived: false },
        { name: "red", isArchived: false },
        { name: "blue", isArchived: false },
        { name: "green", isArchived: false },
      ],
    },
  },
  colorPalettes: {
    yellow: {
      name: "yellow",
      primaryColor: "#eab308",
      secondaryColor: "#713f12",
    },
    red: {
      name: "red",
      primaryColor: "#ef4444",
      secondaryColor: "#7f1d1d",
    },
    blue: {
      name: "blue",
      primaryColor: "#3b82f6",
      secondaryColor: "#1e3a8a",
    },
    green: {
      name: "green",
      primaryColor: "#22c55e",
      secondaryColor: "#14532d",
    },
  },
  flags: {},
  // One crown nobody can buy: the Crowns tab exists only for a catalog with crowns.
  crowns: {
    locked_crown: {
      name: "locked_crown",
      url: "/crowns/locked.svg",
      product: null,
      rarity: "common",
    },
  },
  skins: {},
  effects: {},
} as unknown as Cosmetics;

const userFixture = {
  user: {},
  player: {
    publicId: "locker-integration-player",
    adfree: false,
    unlimitedRanked: false,
    canCreatePublicLobbies: false,
    achievements: { singleplayerMap: [] },
    friends: [],
    subscription: null,
    currency: { soft: 0, hard: 500 },
    flares: ["pattern:stripes:blue", "pattern:stripes:green"],
  },
} as unknown as UserMeResponse;

const yellowKey = "pattern:stripes:yellow";
const redKey = "pattern:stripes:red";
const blueKey = "pattern:stripes:blue";
const greenKey = "pattern:stripes:green";

// The Store's selection (the item its panel shows), and a colour swatch in that panel.
const storeInspected = (store: StoreModal): string | undefined =>
  (store as unknown as { inspected: { key: string } | null }).inspected?.key;
const storeSwatch = (store: StoreModal, key: string) =>
  store.querySelector<HTMLButtonElement>(`[data-variant-key="${key}"]`)!;

type InventoryInternals = {
  resolvedItems(): ResolvedCosmetic[];
  groupsFor(tab: string): readonly (readonly ResolvedCosmetic[])[];
  isEquipped(item: ResolvedCosmetic): boolean;
  activeTab: string;
};

/** The Inventory's card for a key, with the state a tile used to carry ("equipped" when worn). */
function cardFor(root: InventoryModal, key: string) {
  const m = root as unknown as InventoryInternals;
  const group = m
    .groupsFor(m.activeTab)
    .find((candidate) => candidate.some((variant) => variant.key === key));
  const el = [
    ...root.querySelectorAll<HTMLElement>('[data-ui-item="inventory-item"]'),
  ].find((candidate) => candidate.dataset.key === group?.[0].key);
  const item = group?.find((variant) => variant.key === key);
  if (!el || !item) return undefined;
  return {
    el,
    get state() {
      return m.isEquipped(item) ? "equipped" : "idle";
    },
  };
}

/** Select the colour in the panel, then wear it with Equip. */
async function equipVariant(root: InventoryModal, key: string) {
  cardFor(root, key)!.el.click();
  await root.updateComplete;
  root.querySelector<HTMLButtonElement>(`[data-variant-key="${key}"]`)!.click();
  await root.updateComplete;
  root.querySelector<HTMLButtonElement>('[data-ui-button="equip"]')!.click();
  await root.updateComplete;
}

function expectNoNestedInteractiveControls(root: ParentNode): void {
  const interactive = "button, a, input, select, textarea, [role='button']";
  for (const control of root.querySelectorAll(interactive)) {
    expect(control.querySelector(interactive)).toBeNull();
  }
}

describe("Cosmetic locker integration", () => {
  let inventory: InventoryModal;
  let store: StoreModal;
  let languageFixture: HTMLElement;
  let settingsChangeListener: EventListener | undefined;

  Element.prototype.animate ??= () => ({ cancel: () => {} }) as Animation;

  beforeEach(async () => {
    history.replaceState(null, "", "/");
    localStorage.clear();
    new UserSettings().removeCached(PATTERN_KEY);

    const translations = {
      "common.back": "Back",
      "inventory.equipped": "Equipped",
      "inventory.loadout": "Loadout",
      "inventory.showing_effects": "{count} effects equipped",
      "store.cosmetics": "Cosmetics",
      "store.crowns": "Crowns",
      "store.effects": "Effects",
      "store.flags": "Flags",
      "store.packs": "Packs",
      "store.patterns": "Skins",
      "store.subscriptions": "Subscriptions",
      "store.title": "Store",
    };
    languageFixture = document.createElement("lang-selector");
    Object.assign(languageFixture, {
      translations,
      defaultTranslations: translations,
      currentLang: "en",
    });
    document.body.appendChild(languageFixture);

    vi.mocked(fetchCosmetics).mockReset();
    vi.mocked(fetchCosmetics).mockResolvedValue(catalog);
    vi.mocked(getUserMe).mockReset();
    vi.mocked(getUserMe).mockResolvedValue(userFixture);
    vi.mocked(userAuth).mockReset();
    vi.mocked(userAuth).mockResolvedValue({ jwt: "test-token" } as never);

    inventory = document.createElement("inventory-modal") as InventoryModal;
    inventory.id = "page-inventory";
    inventory.inline = true;
    document.body.appendChild(inventory);
    Object.assign(inventory as unknown as Record<string, unknown>, {
      cosmetics: catalog,
      userMeResponse: userFixture,
      ownershipState: "loaded",
      isLoading: false,
      loadFailed: false,
    });
    inventory.requestUpdate();
    await inventory.updateComplete;

    store = document.createElement("store-modal") as StoreModal;
    store.id = "page-item-store";
    store.inline = true;
    document.body.appendChild(store);
    await store.updateComplete;
    await store.onUserMe(userFixture);

    modalRouter.register("inventory", {
      tag: "inventory-modal",
      pageId: "page-inventory",
    });
  });

  afterEach(() => {
    if (settingsChangeListener) {
      window.removeEventListener(
        `${USER_SETTINGS_CHANGED_EVENT}:${PATTERN_KEY}`,
        settingsChangeListener,
      );
      settingsChangeListener = undefined;
    }
    inventory.remove();
    store.remove();
    languageFixture.remove();
    localStorage.clear();
    history.replaceState(null, "", "/");
  });

  it("separates Store inspection from Inventory equip state", async () => {
    const settingsEvent = `${USER_SETTINGS_CHANGED_EVENT}:${PATTERN_KEY}`;
    let settingsChangeCount = 0;
    settingsChangeListener = () => settingsChangeCount++;
    window.addEventListener(settingsEvent, settingsChangeListener);

    inventory.open({ tab: "skins" });
    await inventory.updateComplete;

    await equipVariant(inventory, blueKey);

    expect(settingsChangeCount).toBe(1);
    expect(
      new UserSettings().getSelectedPatternName(catalog)?.colorPalette?.name,
    ).toBe("blue");
    expect(cardFor(inventory, blueKey)?.state).toBe("equipped");

    store.open({ tab: "cosmetics" });
    await vi.waitFor(() => expect(storeInspected(store)).toBe(yellowKey));
    const storeUpdate = vi.spyOn(store, "requestUpdate");
    storeSwatch(store, redKey).click();
    await store.updateComplete;

    expect(storeInspected(store)).toBe(redKey);
    expect(storeUpdate).toHaveBeenCalled();
    storeUpdate.mockRestore();
    expect(settingsChangeCount).toBe(1);
    expect(
      new UserSettings().getSelectedPatternName(catalog)?.colorPalette?.name,
    ).toBe("blue");
  });

  it("resynchronizes Inventory to a distinct external settings variant", async () => {
    const settingsEvent = `${USER_SETTINGS_CHANGED_EVENT}:${PATTERN_KEY}`;
    new UserSettings().setSelectedPatternName(blueKey);
    inventory.open({ tab: "skins" });
    await inventory.updateComplete;
    expect(cardFor(inventory, blueKey)?.state).toBe("equipped");

    new UserSettings().setSelectedPatternName(greenKey);
    window.dispatchEvent(new CustomEvent(settingsEvent));
    await inventory.updateComplete;
    expect(cardFor(inventory, greenKey)?.state).toBe("equipped");
  });

  it("keeps accessible controls and phone layout markers across both surfaces", async () => {
    inventory.open({ tab: "skins" });
    store.open({ tab: "cosmetics" });
    await vi.waitFor(() =>
      expect(
        store.querySelector('[data-ui-item="store-product"]'),
      ).toBeTruthy(),
    );
    await inventory.updateComplete;

    expectNoNestedInteractiveControls(inventory);
    expectNoNestedInteractiveControls(store);

    const inventoryMain = cardFor(inventory, blueKey)!.el as HTMLButtonElement;
    expect(inventoryMain.tagName).toBe("BUTTON");
    expect(inventoryMain.type).toBe("button");
    // the Store's card is itself one button, and its colours are buttons in the panel
    const storeCard = store.querySelector<HTMLButtonElement>(
      '[data-ui-item="store-product"]',
    )!;
    expect(storeCard.tagName).toBe("BUTTON");
    expect(storeCard.type).toBe("button");
    for (const swatch of store.querySelectorAll<HTMLButtonElement>(
      "button[data-variant-key]",
    )) {
      expect(swatch.type).toBe("button");
    }
    // the colours of the selected skin are buttons in the Inventory's panel too
    cardFor(inventory, blueKey)!.el.click();
    await inventory.updateComplete;
    const inventorySwatches = [
      ...inventory.querySelectorAll<HTMLButtonElement>(
        "button[data-variant-key]",
      ),
    ];
    expect(inventorySwatches.length).toBeGreaterThanOrEqual(2);
    for (const swatch of inventorySwatches) {
      expect(swatch.tagName).toBe("BUTTON");
      expect(swatch.type).toBe("button");
    }

    // the slot cards reflow instead of scrolling: two across, four from lg
    expect(
      inventory
        .querySelector("inventory-loadout-bar")
        ?.querySelector("section > div")?.classList,
    ).toContain("grid-cols-2");
    expect(
      inventory.querySelector("[data-inventory-grid]")?.classList,
    ).toContain("grid-cols-2");
    expect(store.querySelector("[data-store-grid]")?.classList).toContain(
      "grid-cols-2",
    );
    // the detail panel stacks under the content below lg, beside it from lg up
    const columns = store.querySelector('[data-ui="two-column"]')!;
    expect(columns.classList).toContain("flex-col");
    expect(columns.classList).toContain("lg:flex-row");
    expect(store.querySelector('[data-ui="detail-panel"]')).toBeTruthy();
    expect(store.querySelector("[data-store-browser] aside")).toBeNull();
    // and the category tabs scroll sideways instead of wrapping
    expect(
      store
        .querySelector('[data-ui="tabs"]')
        ?.classList.contains("overflow-x-auto"),
    ).toBe(true);
  });

  it("preserves the Inventory route tab and clears empty Store products", async () => {
    inventory.open({ tab: "skins" });
    await inventory.updateComplete;
    expect(window.location.hash).toBe("#modal=inventory&tab=skins");

    inventory.setActiveTab("effects");
    await inventory.updateComplete;
    expect(window.location.hash).toBe("#modal=inventory&tab=effects");

    history.replaceState(null, "", "/#modal=inventory&tab=crowns");
    expect(modalRouter.routeFromHash()).toBe(true);
    await vi.waitFor(() =>
      expect((inventory as unknown as { activeTab: string }).activeTab).toBe(
        "crowns",
      ),
    );
    expect(window.location.hash).toBe("#modal=inventory&tab=crowns");

    store.open({ tab: "cosmetics" });
    await vi.waitFor(() => expect(storeInspected(store)).toBe(yellowKey));
    storeSwatch(store, redKey).click();
    await store.updateComplete;
    expect(storeInspected(store)).toBe(redKey);
    const crownsTab = [
      ...store.querySelectorAll<HTMLButtonElement>("button"),
    ].find((candidate) => candidate.textContent?.trim() === "Crowns")!;
    crownsTab.click();
    await store.updateComplete;

    expect(store.querySelector('[data-ui-item="store-product"]')).toBeNull();
    expect(store.querySelector("purchase-button")).toBeNull();
  });
});
