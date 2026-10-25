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
import {
  FEATURED_ROTATION_MS,
  featuredCandidates,
  msUntilNextFeatured,
  pickFeaturedBundle,
} from "../../src/client/FeaturedBundle";

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

describe("the featured bundle candidates", () => {
  it("is nothing when there is nothing to feature", () => {
    expect(pickFeaturedBundle([], false, NOW)).toBeNull();
    expect(
      pickFeaturedBundle([bundle("owned", 1800, {}, "owned")], false, NOW),
    ).toBeNull();
  });

  it("takes the biggest saving when none is seasonal", () => {
    const picked = featuredCandidates(
      [bundle("small", 2400), bundle("big", 1500), bundle("mid", 2000)],
      false,
      NOW,
    );
    expect(picked.map((r) => (r.cosmetic as { name: string }).name)).toEqual([
      "big",
      "mid",
      "small",
    ]);
  });

  it("prefers a seasonal bundle, the one ending soonest", () => {
    const picked = featuredCandidates(
      [
        bundle("evergreen", 1000),
        bundle("later", 2000, { endsAt: "2026-12-01T00:00:00Z" }),
        bundle("soon", 2400, { endsAt: "2026-10-25T00:00:00Z" }),
      ],
      false,
      NOW,
    );
    expect(picked.map((r) => (r.cosmetic as { name: string }).name)).toEqual([
      "soon",
      "later",
      "evergreen",
    ]);
  });

  it("skips a bundle that has ended, has not started, is part-owned or is level-locked", () => {
    const picked = featuredCandidates(
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
    expect(picked.map((r) => (r.cosmetic as { name: string }).name)).toEqual([
      "fine",
    ]);
    // the same locked bundle is offered once the account is high enough
    const high = featuredCandidates(
      [bundle("locked", 1000, {}, "purchasable", [item(1000, 40), item(1500)])],
      me(40),
      NOW,
    );
    expect(high).toHaveLength(1);
  });
});

describe("pickFeaturedBundle", () => {
  const three = () => [bundle("a", 1500), bundle("b", 2000), bundle("c", 2400)];
  const nameAt = (now: number) =>
    (pickFeaturedBundle(three(), false, now)!.cosmetic as { name: string })
      .name;

  it("is nothing when there is nothing to feature", () => {
    expect(pickFeaturedBundle([], false, NOW)).toBeNull();
  });

  it("stays the same within an hour and moves to the next at the top of the hour", () => {
    const hour = Math.floor(NOW / FEATURED_ROTATION_MS) * FEATURED_ROTATION_MS;
    const first = nameAt(hour);
    expect(nameAt(hour + FEATURED_ROTATION_MS - 1)).toBe(first);
    const second = nameAt(hour + FEATURED_ROTATION_MS);
    expect(second).not.toBe(first);
    const third = nameAt(hour + 2 * FEATURED_ROTATION_MS);
    expect(new Set([first, second, third]).size).toBe(3);
    // and round again after the last
    expect(nameAt(hour + 3 * FEATURED_ROTATION_MS)).toBe(first);
  });

  it("is a single bundle's turn every hour when there is only one", () => {
    const only = [bundle("only", 1500)];
    for (let h = 0; h < 4; h++) {
      const picked = pickFeaturedBundle(
        only,
        false,
        NOW + h * FEATURED_ROTATION_MS,
      );
      expect((picked!.cosmetic as { name: string }).name).toBe("only");
    }
  });

  it("says how long until the hour turns", () => {
    const hour = Math.floor(NOW / FEATURED_ROTATION_MS) * FEATURED_ROTATION_MS;
    expect(msUntilNextFeatured(hour)).toBe(FEATURED_ROTATION_MS);
    expect(msUntilNextFeatured(hour + 1000)).toBe(FEATURED_ROTATION_MS - 1000);
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
      expect(el.querySelectorAll("button[aria-label^='news_box']").length).toBe(
        3,
      ),
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
    expect(el.querySelectorAll("button[aria-label^='news_box']").length).toBe(
      1,
    );
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
