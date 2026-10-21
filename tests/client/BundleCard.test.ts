import { afterEach, describe, expect, it, vi } from "vitest";
import {
  bundleSavings,
  cosmeticPackRelationship,
  type ResolvedCosmetic,
} from "../../src/client/Cosmetics";
import "../../src/client/components/BundleCard";
import type { BundleCard } from "../../src/client/components/BundleCard";

const effect = (
  name: string,
  priceSoft: number | undefined,
): ResolvedCosmetic => ({
  type: "effect",
  cosmetic: {
    name,
    priceSoft,
    rarity: "common",
    effectType: "warship",
    product: null,
    attributes: { type: "gradient", colors: ["#ffffff", "#000000"] },
  } as never,
  colorPalette: null,
  relationship: "purchasable",
  key: `effect:${name}`,
  effectType: "warship",
});

const pack = (
  items: ResolvedCosmetic[],
  over: Record<string, unknown> = {},
  relationship: ResolvedCosmetic["relationship"] = "purchasable",
): ResolvedCosmetic => ({
  type: "cosmeticPack",
  cosmetic: {
    name: "kit",
    displayName: "War Kit",
    description: "d",
    tagline: "Industrial might",
    priceSoft: 1800,
    rarity: "epic",
    items: items.map((item) => ({
      type: item.type,
      name: item.cosmetic!.name,
    })),
    ...over,
  } as never,
  colorPalette: null,
  relationship,
  key: "cosmeticPack:kit",
  packItems: items,
});

const four = [
  effect("a", 300),
  effect("b", 900),
  effect("c", 600),
  effect("d", 600),
];

describe("bundleSavings", () => {
  it("is the sum of the items' Credits prices against the bundle's, as a whole percentage", () => {
    expect(bundleSavings(pack(four))).toEqual({
      value: 2400,
      price: 1800,
      savePct: 25,
    });
  });

  it("has no saving when the bundle costs as much as its items", () => {
    expect(bundleSavings(pack(four, { priceSoft: 2400 }))?.savePct).toBe(0);
  });

  it("has no honest sum when an item has no Credits price or is missing from the catalog", () => {
    expect(
      bundleSavings(pack([effect("a", 300), effect("b", undefined)])),
    ).toBe(null);
    const short = pack(four);
    short.packItems = four.slice(0, 3);
    expect(bundleSavings(short)).toBeNull();
  });

  it("is null for anything but a Credits bundle", () => {
    expect(bundleSavings(four[0])).toBeNull();
    expect(bundleSavings(pack(four, { priceSoft: undefined }))).toBeNull();
  });
});

describe("cosmeticPackRelationship with Credits", () => {
  const me = (flares: string[]) =>
    ({ player: { flares, currency: { soft: 0, hard: 0 } } }) as never;
  const bare = (over: Record<string, unknown>) =>
    ({
      name: "k",
      displayName: "K",
      description: "",
      rarity: "common",
      items: [{ type: "flag", name: "x" }],
      ...over,
    }) as never;

  it("is purchasable with only a Credits price, and blocked with no price at all", () => {
    expect(
      cosmeticPackRelationship(bare({ priceSoft: 500 }), me([]), null),
    ).toBe("purchasable");
    expect(cosmeticPackRelationship(bare({}), me([]), null)).toBe("blocked");
  });

  it("is owned once every item is, and blocked while only some are", () => {
    const two = bare({
      priceSoft: 500,
      items: [
        { type: "flag", name: "x" },
        { type: "flag", name: "y" },
      ],
    });
    expect(cosmeticPackRelationship(two, me(["flag:x"]), null)).toBe("blocked");
    expect(cosmeticPackRelationship(two, me(["flag:x", "flag:y"]), null)).toBe(
      "owned",
    );
  });
});

describe("<bundle-card>", () => {
  const cards: HTMLElement[] = [];
  afterEach(() => {
    cards.splice(0).forEach((card) => card.remove());
  });

  async function mount(resolved: ResolvedCosmetic, extra = {}) {
    const card = document.createElement("bundle-card") as BundleCard;
    Object.assign(card, { resolved, ...extra });
    document.body.appendChild(card);
    cards.push(card);
    await card.updateComplete;
    return card;
  }
  const tiles = (card: HTMLElement) => [
    ...card.querySelectorAll<HTMLElement>("[data-bundle-item]"),
  ];

  it("lays out the three most valuable items, the best as the hero, with +N for the rest", async () => {
    const card = await mount(pack(four));
    expect(tiles(card).map((t) => t.getAttribute("data-bundle-item"))).toEqual([
      "effect:b",
      "effect:c",
      "effect:d",
    ]);
    expect(tiles(card)[0].hasAttribute("data-hero")).toBe(true);
    expect(card.querySelector("[data-bundle-more]")?.textContent).toBe("+1");
  });

  it("shows no +N when every item fits", async () => {
    const card = await mount(pack(four.slice(0, 3), { priceSoft: 1200 }));
    expect(tiles(card)).toHaveLength(3);
    expect(card.querySelector("[data-bundle-more]")).toBeNull();
  });

  it("stamps the saving and prints the value and the tier", async () => {
    const card = await mount(pack(four), { lot: 3 });
    expect(card.querySelector("[data-bundle-save]")).toBeTruthy();
    expect(card.querySelector(".bc-value")?.textContent).toContain("2,400");
    expect(card.querySelector(".bc-meta")?.textContent).toContain(
      "store.bundle_lot",
    );
    expect(
      card
        .querySelector<HTMLElement>("[data-bundle-card]")!
        .style.getPropertyValue("--tier"),
    ).toContain("--color-ui-tier-purple");
  });

  it("is stamped SECURED when owned, and shows no saving stamp", async () => {
    const card = await mount(pack(four, {}, "owned"));
    expect(card.querySelector("[data-bundle-secured]")).toBeTruthy();
    expect(card.querySelector("[data-bundle-save]")).toBeNull();
    expect(
      card.querySelector("[data-bundle-card]")!.hasAttribute("data-owned"),
    ).toBe(true);
  });

  it("shows no saving stamp for a bundle that is part-owned", async () => {
    const card = await mount(pack(four, {}, "blocked"));
    expect(card.querySelector("[data-bundle-save]")).toBeNull();
    expect(
      card.querySelector("[data-bundle-card]")!.hasAttribute("data-partial"),
    ).toBe(true);
  });

  it("renders the action it is given in the price plate", async () => {
    const { html } = await import("lit");
    const card = await mount(pack(four), {
      actionContent: html`<b data-act>BUY FOR 1,800</b>`,
    });
    expect(card.querySelector(".bc-plate [data-act]")?.textContent).toBe(
      "BUY FOR 1,800",
    );
  });

  it("activates on click and on Enter or Space, but not from a key pressed inside the action", async () => {
    const onActivate = vi.fn();
    const { html } = await import("lit");
    const card = await mount(pack(four), {
      onActivate,
      actionContent: html`<button data-inner>buy</button>`,
    });
    const root = card.querySelector<HTMLElement>("[data-bundle-card]")!;
    root.click();
    root.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
    );
    root.dispatchEvent(
      new KeyboardEvent("keydown", { key: " ", bubbles: true }),
    );
    expect(onActivate).toHaveBeenCalledTimes(3);
    card
      .querySelector("[data-inner]")!
      .dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
      );
    expect(onActivate).toHaveBeenCalledTimes(3);
  });

  it("is marked focused when it is the inspected one", async () => {
    const card = await mount(pack(four), { state: "focused" });
    expect(
      card.querySelector("[data-bundle-card]")!.hasAttribute("data-focused"),
    ).toBe(true);
  });
});
