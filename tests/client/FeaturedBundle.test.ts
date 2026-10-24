import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ResolvedCosmetic } from "../../src/client/Cosmetics";

const mocks = vi.hoisted(() => ({
  resolved: [] as unknown[],
  news: [] as unknown[],
}));

vi.mock("../../src/client/Api", () => ({
  getNews: vi.fn(async () => mocks.news),
}));

vi.mock("../../src/client/Cosmetics", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/client/Cosmetics")>()),
  fetchCosmetics: vi.fn(async () => ({ patterns: {}, flags: {}, effects: {} })),
  resolveCosmetics: vi.fn(() => mocks.resolved),
}));

import "../../src/client/components/NewsBox";
import { pickFeaturedBundle } from "../../src/client/FeaturedBundle";

const NOW = Date.parse("2026-10-20T12:00:00Z");

function item(price: number, minLevel?: number): ResolvedCosmetic {
  return {
    type: "effect",
    cosmetic: { name: `e${price}`, priceSoft: price, minLevel } as never,
    colorPalette: null,
    relationship: "purchasable",
    key: `effect:e${price}`,
  };
}

function bundle(
  name: string,
  price: number,
  over: Record<string, unknown> = {},
  relationship: ResolvedCosmetic["relationship"] = "purchasable",
  items = [item(1000), item(1500)],
): ResolvedCosmetic {
  return {
    type: "cosmeticPack",
    cosmetic: {
      name,
      displayName: name.toUpperCase(),
      description: "",
      priceSoft: price,
      rarity: "rare",
      items: items.map((i) => ({ type: "effect", name: i.cosmetic!.name })),
      ...over,
    } as never,
    colorPalette: null,
    relationship,
    key: `cosmeticPack:${name}`,
    packItems: items,
  };
}

const me = (level: number) =>
  ({ player: { progress: { level, prestige: 0 } } }) as never;

describe("pickFeaturedBundle", () => {
  it("is nothing when there is nothing to feature", () => {
    expect(pickFeaturedBundle([], false, NOW)).toBeNull();
    expect(
      pickFeaturedBundle([bundle("owned", 1800, {}, "owned")], false, NOW),
    ).toBeNull();
  });

  it("takes the biggest saving when none is seasonal", () => {
    const picked = pickFeaturedBundle(
      [bundle("small", 2400), bundle("big", 1500), bundle("mid", 2000)],
      false,
      NOW,
    );
    expect((picked!.cosmetic as { name: string }).name).toBe("big");
  });

  it("prefers a seasonal bundle, the one ending soonest", () => {
    const picked = pickFeaturedBundle(
      [
        bundle("evergreen", 1000),
        bundle("later", 2000, { endsAt: "2026-12-01T00:00:00Z" }),
        bundle("soon", 2400, { endsAt: "2026-10-25T00:00:00Z" }),
      ],
      false,
      NOW,
    );
    expect((picked!.cosmetic as { name: string }).name).toBe("soon");
  });

  it("skips a bundle that has ended, has not started, is part-owned or is level-locked", () => {
    const picked = pickFeaturedBundle(
      [
        bundle("ended", 1000, { endsAt: "2026-10-19T00:00:00Z" }),
        bundle("future", 1000, { startsAt: "2026-10-21T00:00:00Z" }),
        bundle("partial", 1000, {}, "blocked"),
        bundle("locked", 1000, {}, "purchasable", [item(1000, 40), item(1500)]),
        bundle("fine", 2400),
      ],
      me(10),
      NOW,
    );
    expect((picked!.cosmetic as { name: string }).name).toBe("fine");
    // the same locked bundle is offered once the account is high enough
    const high = pickFeaturedBundle(
      [bundle("locked", 1000, {}, "purchasable", [item(1000, 40), item(1500)])],
      me(40),
      NOW,
    );
    expect(high).not.toBeNull();
  });
});

describe("the featured bundle in <news-box>", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", {
      getItem: () => null,
      setItem: () => {},
      removeItem: () => {},
    });
    mocks.resolved = [bundle("doomsday", 1990)];
    mocks.news = [
      {
        id: "n1",
        title: "Patch notes",
        type: "announcement",
        description: "x",
      },
    ];
  });
  afterEach(() => {
    document.body.innerHTML = "";
    delete (window as { showPage?: unknown }).showPage;
    vi.unstubAllGlobals();
  });

  async function mount() {
    const el = document.createElement("news-box") as HTMLElement;
    el.setAttribute("variant", "strip");
    document.body.appendChild(el);
    await vi.waitFor(() =>
      expect(el.querySelector("[data-featured-bundle]")).not.toBeNull(),
    );
    return el;
  }

  it("is the first notice: the bundle's name and price, opening the Store's Bundles tab", async () => {
    const showPage = vi.fn();
    window.showPage = showPage;
    const store = document.createElement("div") as unknown as HTMLElement & {
      setActiveTab: (key: string) => void;
    };
    store.id = "page-item-store";
    store.setActiveTab = vi.fn();
    document.body.appendChild(store);
    const el = await mount();
    const button = el.querySelector<HTMLButtonElement>(
      "[data-featured-bundle]",
    )!;
    expect(button.getAttribute("data-featured-bundle")).toBe("doomsday");
    expect(button.textContent).toContain("DOOMSDAY");
    expect(button.textContent).toContain("1,990");
    expect(el.textContent).not.toContain("Patch notes");
    // one dot for the bundle, one for the news
    await vi.waitFor(() =>
      expect(el.querySelectorAll("button[aria-label]").length).toBe(3),
    );
    button.click();
    expect(showPage).toHaveBeenCalledWith("page-item-store");
    await vi.waitFor(() =>
      expect(store.setActiveTab).toHaveBeenCalledWith("bundles"),
    );
  });

  it("can be dismissed, leaving the news", async () => {
    const el = await mount();
    const dismiss = [...el.querySelectorAll<HTMLButtonElement>("button")].find(
      (b) => b.getAttribute("aria-label") === "news_box.dismiss",
    )!;
    dismiss.click();
    await vi.waitFor(() =>
      expect(el.querySelector("[data-featured-bundle]")).toBeNull(),
    );
    expect(el.textContent).toContain("Patch notes");
  });

  it("shows alone when there is no news", async () => {
    mocks.news = [];
    const el = await mount();
    expect(el.querySelectorAll("button[aria-label]").length).toBe(1);
  });

  it("shows only the news when no bundle is worth featuring", async () => {
    mocks.resolved = [];
    const el = document.createElement("news-box") as HTMLElement;
    el.setAttribute("variant", "strip");
    document.body.appendChild(el);
    await vi.waitFor(() => expect(el.textContent).toContain("Patch notes"));
    expect(el.querySelector("[data-featured-bundle]")).toBeNull();
  });
});
