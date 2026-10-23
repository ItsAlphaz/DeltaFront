import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ResolvedCosmetic } from "../../src/client/Cosmetics";

const mocks = vi.hoisted(() => ({
  resolved: [] as unknown[],
}));

vi.mock("../../src/client/Cosmetics", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/client/Cosmetics")>()),
  fetchCosmetics: vi.fn(async () => ({ patterns: {}, flags: {}, effects: {} })),
  resolveCosmetics: vi.fn(() => mocks.resolved),
}));

import "../../src/client/components/FeaturedBundleStrip";
import { pickFeaturedBundle } from "../../src/client/components/FeaturedBundleStrip";

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

describe("<featured-bundle-strip>", () => {
  beforeEach(() => {
    mocks.resolved = [bundle("doomsday", 1990)];
  });
  afterEach(() => {
    document.body.innerHTML = "";
    delete (window as { showPage?: unknown }).showPage;
  });

  async function mount() {
    const el = document.createElement(
      "featured-bundle-strip",
    ) as HTMLElement & {
      updateComplete: Promise<unknown>;
    };
    document.body.appendChild(el);
    await vi.waitFor(() =>
      expect(el.querySelector("[data-featured-bundle]")).not.toBeNull(),
    );
    return el;
  }

  it("shows the featured bundle's name and price, and opens the Store's Bundles tab", async () => {
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
    button.click();
    expect(showPage).toHaveBeenCalledWith("page-item-store");
    await vi.waitFor(() =>
      expect(store.setActiveTab).toHaveBeenCalledWith("bundles"),
    );
  });

  it("renders nothing when no bundle is worth featuring", async () => {
    mocks.resolved = [];
    const el = document.createElement(
      "featured-bundle-strip",
    ) as HTMLElement & {
      updateComplete: Promise<unknown>;
    };
    document.body.appendChild(el);
    await el.updateComplete;
    await new Promise((r) => setTimeout(r, 20));
    expect(el.querySelector("[data-featured-bundle]")).toBeNull();
  });
});
