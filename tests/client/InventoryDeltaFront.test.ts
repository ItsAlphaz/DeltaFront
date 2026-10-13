import { ACCOUNT_FEATURES } from "@openfront/shared/AccountFeatures";
import type { UserMeResponse } from "@openfront/shared/ApiSchemas";
import type { Cosmetics } from "@openfront/shared/CosmeticSchemas";
import type { LitElement } from "lit";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadCatalog } from "../../src/account-api/catalog/load";
import { getUserMe } from "../../src/client/Api";
import { userAuth } from "../../src/client/Auth";
import {
  fetchCosmetics,
  invalidateCosmetics,
} from "../../src/client/Cosmetics";
import "../../src/client/InventoryModal";
import type { InventoryModal } from "../../src/client/InventoryModal";
import {
  EFFECTS_KEY,
  FLAG_KEY,
  LOADOUTS_KEY,
  PATTERN_KEY,
  UserSettings,
} from "../../src/client/UserSettings";
import type { CosmeticCard } from "../../src/client/components/CosmeticCard";
import "../../src/client/components/DesktopNavBar";
import type { InventoryLoadoutBar } from "../../src/client/components/InventoryLoadoutBar";
import "../../src/client/components/MobileNavBar";

// The inventory as DeltaFront ships it: the real placeholder catalog
// (src/account-api/catalog), the flares /users/@me reports, and the real
// components. Only the network (the profile and the catalog fetch) is replaced.

vi.mock("../../src/client/Api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/client/Api")>()),
  getApiBase: () => "https://api.test",
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

const FREE = "pattern:delta_stripes:ash";
const shipped = loadCatalog({ publicOrigin: "https://api.test" });
const catalog = shipped.cosmetics as Cosmetics;

function userWith(flares: string[], soft = 1250): UserMeResponse {
  return {
    user: {},
    player: {
      publicId: "pub-1",
      flares,
      currency: { soft, hard: 0 },
    },
  } as unknown as UserMeResponse;
}

function resetSettings(): void {
  UserSettings.setPlayerId(null);
  localStorage.clear();
  const settings = new UserSettings();
  for (const key of [PATTERN_KEY, FLAG_KEY, EFFECTS_KEY, LOADOUTS_KEY]) {
    settings.removeCached(key);
  }
}

const card = (modal: InventoryModal, key: string) =>
  [...modal.querySelectorAll<CosmeticCard>("cosmetic-card")].find(
    (c) => c.resolved.key === key || c.variants.some((v) => v.key === key),
  );
const cardKeys = (modal: InventoryModal) =>
  [...modal.querySelectorAll<CosmeticCard>("cosmetic-card")].flatMap((c) => [
    c.resolved.key,
    ...c.variants.map((v) => v.key),
  ]);

async function showTab(modal: InventoryModal, tab: string) {
  modal.setActiveTab(tab);
  await modal.updateComplete;
  const effects = modal.querySelector("effects-grid");
  if (effects) await (effects as LitElement).updateComplete;
}

async function openInventory(
  user: UserMeResponse | false,
  ownership: "loaded" | "guest" | "error" | "loading" = "loaded",
): Promise<InventoryModal> {
  vi.mocked(getUserMe).mockResolvedValue(user);
  vi.mocked(fetchCosmetics).mockResolvedValue(catalog);
  const modal = document.createElement("inventory-modal") as InventoryModal;
  modal.setAttribute("inline", "");
  document.body.appendChild(modal);
  Object.assign(modal as unknown as Record<string, unknown>, {
    cosmetics: catalog,
    userMeResponse: user,
    ownershipState: ownership,
    isLoading: false,
    loadFailed: false,
    isModalOpen: true,
  });
  modal.requestUpdate();
  await modal.updateComplete;
  return modal;
}

// Rendering the inventory builds hundreds of country-flag cards.
vi.setConfig({ testTimeout: 30_000 });

beforeEach(() => {
  resetSettings();
  document.body.innerHTML = "";
  // translateText reads the page's language selector; without one every call
  // takes its slow fallback path (hundreds of country-flag cards).
  const lang = document.createElement("lang-selector");
  const translations = {
    "inventory.title": "Inventory",
    "inventory.unequip": "Unequip",
    "common.not_logged_in": "Not logged in",
    "main.store": "Store",
  };
  Object.assign(lang, {
    translations,
    defaultTranslations: translations,
    currentLang: "en",
  });
  document.body.appendChild(lang);
  vi.mocked(userAuth).mockResolvedValue({ jwt: "t" } as never);
});
afterEach(() => {
  resetSettings();
  document.body.innerHTML = "";
});

describe("the inventory page with the DeltaFront catalog", () => {
  it("shows the free pattern to an account that owns nothing else", async () => {
    const modal = await openInventory(userWith([FREE]));
    await showTab(modal, "skins");
    expect(cardKeys(modal)).toContain("pattern:delta_stripes:ash");
  });

  it("shows what the account owns and nothing it does not", async () => {
    const modal = await openInventory(
      userWith([FREE, "flag:delta_mark", "pattern:grid_check:ember"]),
    );
    await showTab(modal, "skins");
    expect(cardKeys(modal)).toContain("pattern:delta_stripes:ash");
    expect(cardKeys(modal)).toContain("pattern:grid_check:ember");
    // Same pattern, a colour the account was not given.
    expect(cardKeys(modal)).not.toContain("pattern:delta_stripes:ember");
    await showTab(modal, "flags");
    expect(cardKeys(modal)).toContain("flag:delta_mark");
    expect(cardKeys(modal)).not.toContain("flag:split_field");
    await showTab(modal, "effects");
    expect(modal.textContent).not.toMatch(/red[_ ]wake/i);
  });

  it("shows an effect once it is owned", async () => {
    const modal = await openInventory(userWith([FREE, "effect:red_wake"]));
    await showTab(modal, "effects");
    const grid = modal.querySelector("effects-grid") as LitElement;
    await grid.updateComplete;
    const keys = [...grid.querySelectorAll<CosmeticCard>("cosmetic-card")].map(
      (c) => c.resolved.key,
    );
    expect(keys).toContain("effect:transportShipTrail:red_wake");
  });

  it("never shows a wildcard-looking or unknown flare as an item", async () => {
    const modal = await openInventory(
      userWith([FREE, "flag:not_in_catalog", "pattern:nothing:ember"]),
    );
    await showTab(modal, "flags");
    expect(cardKeys(modal)).not.toContain("flag:not_in_catalog");
    expect(cardKeys(modal).filter((k) => k.startsWith("flag:"))).toEqual([]);
  });

  it("has no crowns slot, because the V1 catalog has no crowns", async () => {
    const modal = await openInventory(userWith([FREE]));
    const bar = modal.querySelector(
      "inventory-loadout-bar",
    ) as InventoryLoadoutBar;
    expect(bar.entries.map((e) => e.category)).toEqual([
      "skins",
      "flags",
      "effects",
    ]);
  });

  it("offers Unequip, and nothing that buys", async () => {
    ACCOUNT_FEATURES.store = false;
    const modal = await openInventory(userWith([FREE]));
    await showTab(modal, "skins");
    expect(modal.querySelector("[data-inventory-unequip]")).toBeTruthy();
    expect(modal.querySelector("[data-inventory-header-action]")).toBeNull();
    expect(modal.querySelector("o-button")).toBeNull();
    expect(modal.innerHTML).not.toMatch(
      /modal=store|main\.store|\b(buy|purchase)\b/i,
    );
    for (const c of modal.querySelectorAll<CosmeticCard>("cosmetic-card")) {
      expect(c.resolved.relationship).toBe("owned");
    }
  });

  it("shows the Credits balance with the DeltaFront coin", async () => {
    ACCOUNT_FEATURES.payments = false;
    const modal = await openInventory(userWith([FREE], 1250));
    const credits = modal.querySelector<HTMLElement>(
      "[data-inventory-credits]",
    )!;
    expect(credits).toBeTruthy();
    await (credits as LitElement).updateComplete;
    expect(credits.textContent).toContain((1250).toLocaleString());
    expect(credits.querySelector("credits-icon")).toBeTruthy();
    expect(credits.querySelector("plutonium-icon")).toBeNull();
    expect(credits.getAttribute("title") ?? credits.innerHTML).toBeDefined();
  });

  it("hides the premium slot with payments off, even though the wire carries hard: 0", async () => {
    ACCOUNT_FEATURES.payments = false;
    const modal = await openInventory(userWith([FREE], 5));
    const credits = modal.querySelector("[data-inventory-credits]")!;
    await (credits as LitElement).updateComplete;
    expect(credits.querySelector("plutonium-icon")).toBeNull();
    expect(credits.querySelectorAll("credits-icon")).toHaveLength(1);
  });

  it("offers the Store button only when the store feature is on", async () => {
    ACCOUNT_FEATURES.store = false;
    let modal = await openInventory(userWith([FREE]));
    expect(modal.querySelector("[data-inventory-header-action]")).toBeNull();
    modal.remove();
    ACCOUNT_FEATURES.store = true;
    modal = await openInventory(userWith([FREE]));
    expect(modal.querySelector("[data-inventory-header-action]")).toBeTruthy();
  });

  it("asks a signed-out visitor to sign in, with no purchase prompt", async () => {
    ACCOUNT_FEATURES.store = false;
    const modal = await openInventory(false, "guest");
    expect(modal.querySelector("[data-inventory-sign-in]")).toBeTruthy();
    expect(modal.querySelector("[data-inventory-header-action]")).toBeTruthy(); // sign in
    expect(modal.querySelector("[data-inventory-credits]")).toBeNull();
  });

  it("shows a loading state, then an error with Retry", async () => {
    const loading = await openInventory(false, "loading");
    expect(
      loading.querySelector('[data-inventory-state="loading"]'),
    ).toBeTruthy();
    loading.remove();
    const failed = await openInventory(false, "error");
    expect(failed.querySelector('[data-inventory-state="error"]')).toBeTruthy();
    expect(failed.querySelector("[data-inventory-retry]")).toBeTruthy();
  });

  it("says what is missing when nothing is owned in a category", async () => {
    const modal = await openInventory(userWith([]));
    await showTab(modal, "skins");
    expect(modal.querySelector('[data-inventory-empty="skins"]')).toBeTruthy();
  });
});

describe("equipping and unequipping", () => {
  it("equips an owned pattern and flag, and Unequip clears them", async () => {
    const modal = await openInventory(userWith([FREE, "flag:delta_mark"]));
    const settings = new UserSettings();
    await showTab(modal, "skins");
    const pattern = card(modal, "pattern:delta_stripes:ash")!;
    pattern.onActivate!(pattern.resolved);
    await modal.updateComplete;
    expect(settings.getSelectedPatternName(catalog)?.name).toBe(
      "delta_stripes",
    );
    expect(settings.getSelectedPatternName(catalog)?.colorPalette?.name).toBe(
      "ash",
    );

    modal.querySelector<HTMLButtonElement>("[data-inventory-unequip]")!.click();
    await modal.updateComplete;
    expect(settings.getSelectedPatternName(catalog)).toBeNull();

    await showTab(modal, "flags");
    const flag = card(modal, "flag:delta_mark")!;
    flag.onActivate!(flag.resolved);
    await modal.updateComplete;
    expect(settings.getFlag()).toBe("flag:delta_mark");
    modal.querySelector<HTMLButtonElement>("[data-inventory-unequip]")!.click();
    await modal.updateComplete;
    expect(settings.getFlag()).toBeNull();
  });

  it("offers no card for an unowned item, so there is nothing to equip", async () => {
    const modal = await openInventory(userWith([FREE]));
    await showTab(modal, "flags");
    expect(card(modal, "flag:split_field")).toBeUndefined();
    await showTab(modal, "skins");
    expect(card(modal, "pattern:grid_check:ember")).toBeUndefined();
  });
});

describe("what a join sends: selections are checked against ownership", () => {
  beforeEach(() => {
    invalidateCosmetics();
    // The real getPlayerCosmeticsRefs, with the real fetchCosmetics behind it.
    vi.mocked(fetchCosmetics).mockImplementation(async () => catalog);
  });

  async function refsFor(flares: string[], select: (s: UserSettings) => void) {
    vi.mocked(getUserMe).mockResolvedValue(userWith(flares));
    const actual = await vi.importActual<
      typeof import("../../src/client/Cosmetics")
    >("../../src/client/Cosmetics");
    const settings = new UserSettings();
    select(settings);
    // getPlayerCosmeticsRefs calls the module's own fetchCosmetics, which
    // reads /cosmetics.json; serve the shipped catalog for it.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => JSON.parse(shipped.body),
      })),
    );
    actual.invalidateCosmetics();
    const refs = await actual.getPlayerCosmeticsRefs();
    vi.unstubAllGlobals();
    return { refs, settings };
  }

  it("keeps an owned selection", async () => {
    const { refs } = await refsFor([FREE, "flag:delta_mark"], (s) => {
      s.setSelectedPatternName("pattern:delta_stripes:ash");
      s.setFlag("flag:delta_mark");
    });
    expect(refs.patternName).toBe("delta_stripes");
    expect(refs.patternColorPaletteName).toBe("ash");
    expect(refs.flag).toBe("flag:delta_mark");
  });

  it("drops an unowned pattern and forgets the selection (it falls back to no pattern)", async () => {
    const { refs, settings } = await refsFor([FREE], (s) =>
      s.setSelectedPatternName("pattern:grid_check:ember"),
    );
    expect(refs.patternName).toBeUndefined();
    expect(settings.getSelectedPatternName(catalog)).toBeNull();
  });

  it("drops an unowned flag, an unowned effect and an item the catalog does not have", async () => {
    const { refs, settings } = await refsFor([FREE], (s) => {
      s.setFlag("flag:split_field");
      s.setSelectedEffectName("transportShipTrail", "red_wake");
    });
    expect(refs.flag).toBeUndefined();
    expect(refs.effects).toBeUndefined();
    expect(settings.getFlag()).toBeNull();
    const unknown = await refsFor([FREE, "flag:ghost"], (s) =>
      s.setFlag("flag:ghost"),
    );
    expect(unknown.refs.flag).toBeUndefined();
    expect(unknown.settings.getFlag()).toBeNull();
  });

  it("falls back after an admin revokes an item: the next join no longer sends it", async () => {
    const owned = await refsFor([FREE, "effect:red_wake"], (s) =>
      s.setSelectedEffectName("transportShipTrail", "red_wake"),
    );
    expect(owned.refs.effects).toEqual({ transportShipTrail: "red_wake" });
    const revoked = await refsFor([FREE], () => undefined);
    expect(revoked.refs.effects).toBeUndefined();
  });

  it("does not make a country flag need ownership", async () => {
    const { refs } = await refsFor([FREE], (s) => s.setFlag("country:fr"));
    expect(refs.flag).toBe("country:fr");
  });
});

describe("navigation: the inventory has its own feature", () => {
  const page = (root: ParentNode, id: string) =>
    root.querySelector(`[data-page="${id}"]`);
  async function mount(tag: string) {
    const el = document.createElement(tag) as HTMLElement & {
      updateComplete: Promise<unknown>;
    };
    document.body.appendChild(el);
    await el.updateComplete;
    return el;
  }
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;

  it.each(["desktop-nav-bar", "mobile-nav-bar"])(
    "%s shows INVENTORY without STORE when only inventory is on",
    async (tag) => {
      Object.assign(ACCOUNT_FEATURES, { store: false, inventory: true });
      const nav = await mount(tag);
      expect(page(nav, "page-inventory")).not.toBeNull();
      expect(page(nav, "page-item-store")).toBeNull();
    },
  );

  it.each(["desktop-nav-bar", "mobile-nav-bar"])(
    "%s shows STORE without INVENTORY when only the store is on",
    async (tag) => {
      Object.assign(ACCOUNT_FEATURES, { store: true, inventory: false });
      const nav = await mount(tag);
      expect(page(nav, "page-item-store")).not.toBeNull();
      expect(page(nav, "page-inventory")).toBeNull();
    },
  );

  it.each(["desktop-nav-bar", "mobile-nav-bar"])(
    "%s shows neither with both off",
    async (tag) => {
      Object.assign(ACCOUNT_FEATURES, { store: false, inventory: false });
      const nav = await mount(tag);
      expect(page(nav, "page-inventory")).toBeNull();
      expect(page(nav, "page-item-store")).toBeNull();
    },
  );
});

describe("the catalog is only fetched when something uses it", () => {
  it("fetchCosmetics makes no request with the inventory, store and clans all off", async () => {
    const actual = await vi.importActual<
      typeof import("../../src/client/Cosmetics")
    >("../../src/client/Cosmetics");
    actual.invalidateCosmetics();
    Object.assign(ACCOUNT_FEATURES, {
      store: false,
      inventory: false,
      clans: false,
    });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    expect(await actual.fetchCosmetics()).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    Object.assign(ACCOUNT_FEATURES, { inventory: true });
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => JSON.parse(shipped.body),
    });
    expect(await actual.fetchCosmetics()).not.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
    actual.invalidateCosmetics();
  });
});

describe("no Caps or Plutonium anywhere a V1 player can reach", () => {
  const en = JSON.parse(
    fs.readFileSync(
      path.resolve(__dirname, "../../resources/lang/en.json"),
      "utf8",
    ),
  ) as Record<string, unknown>;

  function flatten(
    obj: Record<string, unknown>,
    prefix = "",
  ): Array<[string, string]> {
    return Object.entries(obj).flatMap(([k, v]) =>
      typeof v === "string"
        ? [[`${prefix}${k}`, v] as [string, string]]
        : flatten(v as Record<string, unknown>, `${prefix}${k}.`),
    );
  }
  const OLD_NAME = /\b(caps?|plutonium)\b|bottle/i;

  it("names the one currency Credits", () => {
    expect((en.cosmetics as Record<string, string>).soft).toBe("Credits");
  });

  // Every string that still carries an old currency name, and why it cannot
  // be reached in V1. A new such string fails this test until it is listed
  // here (or reworded), and a string removed from en.json must leave the list.
  const REMAINING: Record<string, string> = {
    "cosmetics.hard": "premium currency label: rendered only with payments",
    "clan_modal.donate_irreversible_hard": "clan donations: clans + payments",
    "host_modal.queue_confirm_body": "paid lobby queue: payments",
    "prestige.caps": "prestige rewards: progression",
    "prestige.gain_caps": "prestige rewards: progression",
    "store.custom_currency_purchase_success": "currency packs: payments",
    "store.pack_debt": "cosmetic packs: payments",
    "store.plutonium_amount": "currency packs: payments",
    "store.tribe_boost_confirm": "tribe boosts: tribes + payments",
    "common.cap_label": "the in-game troop cap, not a currency",
  };

  it("every string that still says Caps or Plutonium belongs to a feature V1 keeps off", () => {
    const flagged = flatten(en)
      .filter(([, value]) => OLD_NAME.test(value))
      .map(([key]) => key)
      .sort();
    expect(flagged).toEqual(Object.keys(REMAINING).sort());
  });

  it("the features those strings belong to are off in the shipped configuration", () => {
    const shippedFeatures = (globalThis as Record<string, unknown>)
      .__SHIPPED_ACCOUNT_FEATURES__ as Record<string, boolean>;
    for (const name of ["payments", "progression", "tribes", "clans"]) {
      expect(shippedFeatures[name], name).toBe(false);
    }
  });

  it("the inventory page and its navigation render none of them", async () => {
    Object.assign(ACCOUNT_FEATURES, {
      store: false,
      payments: false,
      progression: false,
      tribes: false,
      inventory: true,
    });
    const modal = await openInventory(userWith([FREE, "flag:delta_mark"], 99));
    for (const tab of ["skins", "flags", "effects"]) {
      await showTab(modal, tab);
      expect(modal.textContent ?? "").not.toMatch(OLD_NAME);
      expect(modal.innerHTML).not.toMatch(/plutonium|cap-icon|bottle/i);
    }
  });
});
