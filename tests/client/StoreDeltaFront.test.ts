import { ACCOUNT_FEATURES } from "@openfront/shared/AccountFeatures";
import type { UserMeResponse } from "@openfront/shared/ApiSchemas";
import type { Cosmetics } from "@openfront/shared/CosmeticSchemas";
import type { LitElement } from "lit";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { loadCatalog } from "../../src/account-api/catalog/load";
import { getUserMe, purchaseWithCurrency } from "../../src/client/Api";
import { fetchCosmetics } from "../../src/client/Cosmetics";
import { showInGameAlert } from "../../src/client/InGameModal";
import "../../src/client/InventoryModal";
import type { InventoryModal } from "../../src/client/InventoryModal";
import "../../src/client/Store";
import type { StoreModal } from "../../src/client/Store";
import "../../src/client/components/DesktopNavBar";
import "../../src/client/components/MobileNavBar";
import type { PurchaseButton } from "../../src/client/components/PurchaseButton";
import {
  makePrivateCatalog,
  PRIVATE_ITEMS,
} from "../account-api/util/privateCatalog";

// The Credits store as DeltaFront ships it: the real placeholder catalog with
// its prices, the real Store and Inventory components and the real purchase
// flow (src/client/Cosmetics.purchaseCosmetic). Only the network is replaced.

vi.mock("../../src/client/Api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/client/Api")>()),
  getApiBase: () => "https://api.test",
  getUserMe: vi.fn(),
  invalidateUserMe: vi.fn(),
  purchaseWithCurrency: vi.fn(),
}));
vi.mock("../../src/client/Auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/client/Auth")>()),
  userAuth: vi.fn().mockResolvedValue({ jwt: "t" }),
}));
vi.mock("../../src/client/Cosmetics", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/client/Cosmetics")>()),
  fetchCosmetics: vi.fn(),
}));
vi.mock("../../src/client/InGameModal", () => ({
  showInGameAlert: vi.fn().mockResolvedValue(true),
  showInGameConfirm: vi.fn().mockResolvedValue(true),
}));

vi.setConfig({ testTimeout: 30_000 });

const FREE = "pattern:delta_stripes:ash";
const shipped = loadCatalog({ publicOrigin: "https://api.test" });
const full = shipped.cosmetics as Cosmetics;
// A production-style catalog: not the public sample, with private items, loaded
// the way the API does from DF_CATALOG_DIR and DF_CATALOG_ASSET_DIR.
const privateFixture = makePrivateCatalog();
const privateCatalog = loadCatalog({
  publicOrigin: "https://api.test",
  dir: privateFixture.dir,
  assetDir: privateFixture.assetDir,
}).cosmetics as Cosmetics;
afterAll(() => privateFixture.cleanup());

// Most tests here are about how the Store treats a few known items, so they use
// the original eight (the first of each kind). The last describe uses the
// catalogs a deployment really has: the public sample, and a private one.
const pickKeys = <T>(from: Record<string, T> | undefined, keys: string[]) =>
  Object.fromEntries(keys.map((key) => [key, from![key]]));
const catalog: Cosmetics = {
  ...full,
  patterns: pickKeys(full.patterns, [
    "delta_stripes",
    "grid_check",
    "officer_chevrons",
  ]),
  flags: pickKeys(full.flags, ["delta_mark", "split_field", "recruit_banner"]),
  crowns: undefined,
  effects: {
    transportShipTrail: pickKeys(full.effects?.transportShipTrail, [
      "red_wake",
      "colonel_wake",
    ]),
  },
};

function user(
  flares: string[],
  soft: number,
  identity: "registered" | "guest" = "registered",
): UserMeResponse {
  return {
    user:
      identity === "registered" ? { discord: { id: "1", username: "u" } } : {},
    player: { publicId: "pub-1", flares, currency: { soft, hard: 0 } },
  } as unknown as UserMeResponse;
}

const broadcast = (detail: UserMeResponse | false) =>
  document.dispatchEvent(new CustomEvent("userMeResponse", { detail }));

let store: StoreModal;
let reload: ReturnType<typeof vi.fn>;
const originalLocation = window.location;

async function openStore(
  me: UserMeResponse | false,
  tab: "cosmetics" | "effects" = "cosmetics",
  cosmetics: Cosmetics = catalog,
): Promise<StoreModal> {
  vi.mocked(getUserMe).mockResolvedValue(me);
  vi.mocked(fetchCosmetics).mockResolvedValue(cosmetics);
  store = document.createElement("store-modal") as StoreModal;
  store.setAttribute("inline", "");
  document.body.appendChild(store);
  await store.updateComplete;
  broadcast(me);
  store.open({ tab });
  await vi.waitFor(() =>
    expect(store.querySelector('[data-ui-item="store-product"]')).toBeTruthy(),
  );
  await store.updateComplete;
  return store;
}

// The page is a grid of cards and one detail panel: the buy button (and the
// Owned status) belong to the SELECTED card, so a test selects a card first.
const elements = () => [
  ...store.querySelectorAll<HTMLElement>('[data-ui-item="store-product"]'),
];
const cards = () =>
  elements().map((el) => {
    const key = el.dataset.key!;
    return {
      el,
      resolved: {
        key,
        type: key.split(":")[0],
        relationship: /\bowned\b/i.test(el.textContent ?? "")
          ? "owned"
          : "purchasable",
      },
    };
  });
const select = async (card: { el: HTMLElement }) => {
  card.el.click();
  await store.updateComplete;
};
const selectKey = async (prefix: string) => {
  const card = cards().find((c) => c.resolved.key.startsWith(prefix))!;
  expect(card, prefix).toBeTruthy();
  await select(card);
};
/** The panel's buy button: there is at most one, for the selected item. */
const buttons = () => [
  ...store.querySelectorAll<PurchaseButton>("purchase-button"),
];
const statuses = () =>
  [...store.querySelectorAll('[data-ui-button="owned"]')].map((e) =>
    e.textContent?.trim(),
  );

beforeEach(() => {
  document.body.innerHTML = "";
  localStorage.clear();
  Object.assign(ACCOUNT_FEATURES, {
    accounts: true,
    inventory: true,
    store: true,
    payments: false,
    tribes: false,
    progression: false,
    friends: false,
  });
  vi.mocked(purchaseWithCurrency).mockReset();
  vi.mocked(showInGameAlert).mockClear();
  // The nav bars ask the catalog for its hash through the unmocked path.
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: false, status: 404 })),
  );
  reload = vi.fn();
  Object.defineProperty(window, "location", {
    configurable: true,
    value: { ...originalLocation, reload, hash: "" },
  });
  const lang = document.createElement("lang-selector");
  const translations: Record<string, string> = {
    "store.cosmetics": "Cosmetics",
    "store.effects": "Effects",
    "store.packs": "Packs",
    "store.subscriptions": "Subscriptions",
    "store.bundles": "Bundles",
    "store.tribes": "Tribes",
    "store.flags": "Flags",
    "store.crowns": "Crowns",
    "store.patterns": "Skins",
    "store.owned": "Owned",
    "store.title": "Store",
    "cosmetics.soft": "Credits",
    "store.login_required": "log in",
    "store.purchase_success": "Purchase succeeded: {name}",
  };
  Object.assign(lang, {
    translations,
    defaultTranslations: translations,
    currentLang: "en",
  });
  document.body.appendChild(lang);
});
afterEach(() => {
  vi.unstubAllGlobals();
  Object.defineProperty(window, "location", {
    configurable: true,
    value: originalLocation,
  });
  document.body.innerHTML = "";
});

describe("the Store page", () => {
  it("lists the catalog with the Credits prices the catalog sets, and nothing else for sale", async () => {
    await openStore(user([FREE], 1000));
    const priced: (number | null)[] = [];
    for (const card of cards()) {
      await select(card);
      for (const b of buttons()) {
        priced.push(b.priceSoft);
        expect(b.priceHard).toBeNull();
        expect(b.product).toBeNull();
      }
    }
    // Skins tab: the paid Delta Stripes colour and Grid Check (the free ash colour is Owned)
    expect(priced.sort()).toEqual([300, 500]);
  });

  it("shows each Credits price with the Credits coin, never a premium or dollar price", async () => {
    await openStore(user([FREE], 1000));
    for (const card of cards()) {
      await select(card);
      // the price on the card, and in the panel: the Credits coin, never a premium or dollar price
      for (const root of [
        card.el,
        store.querySelector('[data-ui="detail-panel"]')!,
      ]) {
        if (!/\d/.test(root.textContent ?? "")) continue;
        expect(root.querySelector("credits-icon")).toBeTruthy();
        expect(root.querySelector("plutonium-icon")).toBeNull();
      }
      for (const b of buttons()) {
        expect(b.textContent).not.toMatch(/\$|€|£/);
      }
    }
  });

  it("marks the free default as Owned, with no buy button on it", async () => {
    await openStore(user([FREE], 1000));
    await selectKey("pattern:delta_stripes");
    // it opens on the paid colour (a buy button); switch to the free one
    expect(buttons().length).toBe(1);
    expect(statuses()).not.toContain("Owned");
    store
      .querySelector<HTMLElement>(
        '[data-variant-key="pattern:delta_stripes:ash"]',
      )!
      .click();
    await store.updateComplete;
    expect(statuses()).toContain("Owned");
    expect(buttons().length).toBe(0);
  });

  it("offers only the Cosmetics and Effects tabs (no packs, subscriptions, bundles or tribes)", async () => {
    await openStore(user([FREE], 1000));
    const tabs = (
      store as unknown as { modalConfig(): { tabs: Array<{ key: string }> } }
    )
      .modalConfig()
      .tabs.map((t) => t.key);
    expect(tabs).toEqual(["cosmetics", "effects"]);
    expect(store.querySelector("custom-currency-card")).toBeNull();
    expect(store.querySelector("tribes-panel")).toBeNull();
  });

  it("brings the other tabs back only with their own features", async () => {
    Object.assign(ACCOUNT_FEATURES, { payments: true });
    await openStore(user([FREE], 1000));
    const keys = () =>
      (store as unknown as { modalConfig(): { tabs: Array<{ key: string }> } })
        .modalConfig()
        .tabs.map((t) => t.key);
    // the catalog has no bundles, so even with payments there is no Bundles tab
    expect(keys()).toEqual(["packs", "subscriptions", "cosmetics", "effects"]);
    Object.assign(ACCOUNT_FEATURES, { payments: false, tribes: true });
    store.requestUpdate();
    expect(keys()).toEqual(["cosmetics", "effects", "tribes"]);
  });

  it("has no Crowns sub-tab when the catalog has no crowns", async () => {
    await openStore(user([FREE], 1000));
    const subTabs = [...store.querySelectorAll("button")]
      .map((button) => button.textContent?.trim())
      .filter((text) => ["Skins", "Flags", "Crowns"].includes(text ?? ""));
    expect(subTabs).toEqual(["Skins", "Flags"]);
  });

  it("shows the Credits balance with the coin and no premium slot", async () => {
    await openStore(user([FREE], 1250));
    const chip = store.querySelector('[data-ui="status-chip"]')!;
    expect(chip.textContent).toContain((1250).toLocaleString());
    expect(chip.querySelector("credits-icon")).toBeTruthy();
    expect(chip.querySelector("plutonium-icon")).toBeNull();
  });

  it("renders no Caps or Plutonium wording", async () => {
    await openStore(user([FREE], 1250));
    expect(store.innerText ?? store.textContent).not.toMatch(
      /\b(caps?|plutonium)\b/i,
    );
    expect(store.innerHTML).not.toMatch(
      /plutonium|cap-icon|bottle|stripe-|checkout/i,
    );
  });

  it("lists the effect for sale, priced", async () => {
    await openStore(user([FREE], 1000), "effects");
    const priced: (number | null)[] = [];
    for (const card of cards()) {
      await select(card);
      for (const b of buttons()) priced.push(b.priceSoft);
    }
    expect(priced).toEqual([600]);
  });
});

describe("buying", () => {
  async function buyCheck(): Promise<PurchaseButton> {
    // Grid Check is the 500-Credit item: select its card, buy from the panel
    await selectKey("pattern:grid_check");
    const b = buttons().find((x) => x.priceSoft === 500)!;
    expect(b).toBeTruthy();
    return b;
  }

  it("sends only the item (kind, name, palette and the currency): no price", async () => {
    vi.mocked(purchaseWithCurrency).mockResolvedValue({ ok: true });
    await openStore(user([FREE], 1000));
    const b = await buyCheck();
    await b.onPurchaseSoft!();
    expect(purchaseWithCurrency).toHaveBeenCalledTimes(1);
    expect(purchaseWithCurrency).toHaveBeenCalledWith(
      "pattern",
      "grid_check",
      "soft",
      "ember",
    );
  });

  it("after a successful buy: confirms, drops the cached profile and reloads so the balance and ownership are fresh", async () => {
    vi.mocked(purchaseWithCurrency).mockResolvedValue({ ok: true });
    await openStore(user([FREE], 1000));
    await (
      await buyCheck()
    ).onPurchaseSoft!();
    expect(showInGameAlert).toHaveBeenCalledWith(
      expect.stringContaining("Purchase succeeded"),
    );
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("shows the purchased item as Owned and the new balance as soon as the fresh profile arrives", async () => {
    vi.mocked(purchaseWithCurrency).mockResolvedValue({ ok: true });
    await openStore(user([FREE], 1000));
    await selectKey("pattern:grid_check");
    expect(buttons().some((b) => b.priceSoft === 500)).toBe(true);
    // what /users/@me says after the purchase (the server's response, not the client's guess)
    const after = user([FREE, "pattern:grid_check:ember"], 500);
    vi.mocked(getUserMe).mockResolvedValue(after);
    broadcast(after);
    await vi.waitFor(() =>
      expect(buttons().some((b) => b.priceSoft === 500)).toBe(false),
    );
    const grid = cards().find((c) =>
      c.resolved.key.startsWith("pattern:grid_check"),
    )!;
    expect(grid.resolved.relationship).toBe("owned");
    expect(statuses()).toContain("Owned");
    const chip = store.querySelector('[data-ui="status-chip"]')!;
    expect(chip.textContent).toContain("500");
  });

  it("the inventory shows the purchased item at once (it reads the same profile)", async () => {
    const after = user([FREE, "pattern:grid_check:ember"], 500);
    vi.mocked(getUserMe).mockResolvedValue(after);
    vi.mocked(fetchCosmetics).mockResolvedValue(catalog);
    const inventory = document.createElement(
      "inventory-modal",
    ) as InventoryModal;
    inventory.setAttribute("inline", "");
    document.body.appendChild(inventory);
    Object.assign(inventory as unknown as Record<string, unknown>, {
      cosmetics: catalog,
      userMeResponse: after,
      ownershipState: "loaded",
      isLoading: false,
      loadFailed: false,
      isModalOpen: true,
    });
    inventory.requestUpdate();
    await inventory.updateComplete;
    inventory.setActiveTab("skins");
    await inventory.updateComplete;
    const keys = (
      inventory as unknown as {
        groupsFor(tab: string): readonly (readonly { key: string }[])[];
      }
    )
      .groupsFor("skins")
      .flat()
      .map((item) => item.key);
    expect(keys).toContain("pattern:grid_check:ember");
    expect(keys).toContain("pattern:delta_stripes:ash");
    expect(keys).not.toContain("pattern:delta_stripes:ember");
  });

  it("with too few Credits: shows the shortfall in Credits and sends nothing", async () => {
    await openStore(user([FREE], 100));
    const b = await buyCheck();
    const result = await b.onPurchaseSoft!();
    expect(purchaseWithCurrency).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      currency: "Credits",
      shortfall: 400,
      canTopUp: false,
    });
    expect(reload).not.toHaveBeenCalled();
  });

  it("when the server says insufficient after the check passed: shows the shortfall from the fresh balance, nothing charged", async () => {
    vi.mocked(purchaseWithCurrency).mockResolvedValue({
      ok: false,
      code: "insufficient_balance",
    });
    await openStore(user([FREE], 1000));
    vi.mocked(getUserMe).mockResolvedValue(user([FREE], 450));
    const result = await (await buyCheck()).onPurchaseSoft!();
    expect(result).toMatchObject({ currency: "Credits", shortfall: 50 });
    expect(reload).not.toHaveBeenCalled();
  });

  it("an already-owned refusal says nothing was charged and refreshes", async () => {
    vi.mocked(purchaseWithCurrency).mockResolvedValue({
      ok: false,
      code: "already_owned",
    });
    await openStore(user([FREE], 1000));
    await (
      await buyCheck()
    ).onPurchaseSoft!();
    expect(showInGameAlert).toHaveBeenCalled();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("a guest is asked to sign in, and nothing is sent", async () => {
    await openStore(user([FREE], 1000, "guest"));
    await (
      await buyCheck()
    ).onPurchaseSoft!();
    expect(purchaseWithCurrency).not.toHaveBeenCalled();
    expect(showInGameAlert).toHaveBeenCalledWith("log in");
  });

  it("a server refusal of a guest (403) shows the same sign-in message", async () => {
    vi.mocked(purchaseWithCurrency).mockResolvedValue({
      ok: false,
      code: "login_required",
    });
    await openStore(user([FREE], 1000));
    await (
      await buyCheck()
    ).onPurchaseSoft!();
    expect(showInGameAlert).toHaveBeenCalledWith("log in");
    expect(reload).not.toHaveBeenCalled();
  });

  it("a second click while the first is in flight does not send a second request", async () => {
    let finish!: (r: { ok: true }) => void;
    vi.mocked(purchaseWithCurrency).mockReturnValue(
      new Promise((r) => (finish = r)),
    );
    await openStore(user([FREE], 1000));
    const b = await buyCheck();
    (
      b as unknown as { requestCurrencyPurchase(m: "soft"): void }
    ).requestCurrencyPurchase("soft");
    await b.updateComplete;
    const confirm = b.querySelector("confirm-dialog") as LitElement;
    confirm.dispatchEvent(new CustomEvent("confirm"));
    await vi.waitFor(() =>
      expect(purchaseWithCurrency).toHaveBeenCalledTimes(1),
    );
    // clicking Buy again while busy opens nothing and sends nothing
    (
      b as unknown as { requestCurrencyPurchase(m: "soft"): void }
    ).requestCurrencyPurchase("soft");
    expect(b.querySelector("confirm-dialog")).toBeNull();
    finish({ ok: true });
    await vi.waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
    expect(purchaseWithCurrency).toHaveBeenCalledTimes(1);
  });
});

describe("navigation: the Store has its own feature", () => {
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
    "%s shows STORE and INVENTORY with the V1 configuration, and no premium page",
    async (tag) => {
      const nav = await mount(tag);
      expect(page(nav, "page-item-store")).not.toBeNull();
      expect(page(nav, "page-inventory")).not.toBeNull();
      expect(nav.querySelector('[data-page="page-subscription"]')).toBeNull();
    },
  );

  it.each(["desktop-nav-bar", "mobile-nav-bar"])(
    "%s hides STORE with the store feature off",
    async (tag) => {
      ACCOUNT_FEATURES.store = false;
      const nav = await mount(tag);
      expect(page(nav, "page-item-store")).toBeNull();
      expect(page(nav, "page-inventory")).not.toBeNull();
    },
  );
});

describe.each([
  ["the public sample catalog", () => full, "sample_crown", 1],
  [
    "a private production catalog",
    () => privateCatalog,
    PRIVATE_ITEMS.crown,
    1,
  ],
] as const)("the Store page with %s", (_name, cosmetics, crown, minCrowns) => {
  const tabLabels = () =>
    [...store.querySelectorAll("button")]
      .map((button) => button.textContent?.trim())
      .filter((text) => ["Skins", "Flags", "Crowns"].includes(text ?? ""));
  const openCrowns = async (me: UserMeResponse) => {
    await openStore(me, "cosmetics", cosmetics());
    [...store.querySelectorAll("button")]
      .find((b) => b.textContent?.trim() === "Crowns")!
      .click();
    await store.updateComplete;
    await vi.waitFor(() =>
      expect(cards().some((c) => c.resolved.type === "crown")).toBe(true),
    );
  };

  it("has a Crowns sub-tab, and lists the crowns with their Credits prices", async () => {
    await openStore(user([FREE], 5000), "cosmetics", cosmetics());
    expect(tabLabels()).toEqual(["Skins", "Flags", "Crowns"]);
    await openCrowns(user([FREE], 5000));
    const crowns = cards().filter((c) => c.resolved.type === "crown");
    expect(crowns.length).toBeGreaterThanOrEqual(minCrowns);
    for (const c of crowns) {
      expect(c.resolved.relationship).toBe("purchasable");
    }
    const priced: (number | null)[] = [];
    for (const crown of crowns) {
      await select(crown);
      for (const b of buttons()) {
        priced.push(b.priceSoft);
        expect(b.priceHard).toBeNull();
      }
    }
    expect(priced.length).toBeGreaterThanOrEqual(minCrowns);
    for (const price of priced) {
      expect(price).toBeGreaterThan(0);
      expect(price).toBeLessThanOrEqual(2000);
    }
  });

  it("marks a crown the account owns as Owned", async () => {
    await openCrowns(user([FREE, `crown:${crown}`], 5000));
    expect(
      cards().find((c) => c.resolved.key === `crown:${crown}`)!.resolved
        .relationship,
    ).toBe("owned");
  });

  it("lists effects of every type in the Effects tab", async () => {
    await openStore(user([FREE], 5000), "effects", cosmetics());
    await vi.waitFor(() => expect(cards().length).toBeGreaterThan(0));
    expect(cards().every((c) => c.resolved.type === "effect")).toBe(true);
  });
});

describe("the Store page with a private production catalog", () => {
  it("lists the private items, with their private prices, and none of the sample-only ones", async () => {
    await openStore(user([FREE], 9000), "cosmetics", privateCatalog);
    const keys = () => cards().map((c) => c.resolved.key);
    expect(
      keys().some((k) => k.startsWith(`pattern:${PRIVATE_ITEMS.pattern}`)),
    ).toBe(true);
    [...store.querySelectorAll("button")]
      .find((b) => b.textContent?.trim() === "Flags")!
      .click();
    await store.updateComplete;
    await vi.waitFor(() =>
      expect(keys()).toContain(`flag:${PRIVATE_ITEMS.flag}`),
    );
    // The admin-only flag has no price: it is not offered for sale.
    expect(keys()).not.toContain(`flag:${PRIVATE_ITEMS.adminFlag}`);
    expect(keys()).not.toContain("crown:sample_crown");
  });

  it("keeps the effects a private catalog adds, each in its own tab", async () => {
    await openStore(user([FREE], 9000), "effects", privateCatalog);
    await vi.waitFor(() => expect(cards().length).toBeGreaterThan(0));
    const names = () => cards().map((c) => c.resolved.key);
    expect(names()).toContain(
      `effect:transportShipTrail:${PRIVATE_ITEMS.effects.transportShipTrail}`,
    );
    expect(names().some((k) => k.includes("sample_"))).toBe(false);
  });
});
