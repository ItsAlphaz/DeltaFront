import { afterEach, describe, expect, it, vi } from "vitest";
import {
  bundleInSeason,
  bundleSavings,
  cosmeticPackRelationship,
  levelLockOf,
  minLevelOf,
  reachedLevel,
  type ResolvedCosmetic,
} from "../../src/client/Cosmetics";
import "../../src/client/components/BundleCard";
import {
  timeLeft,
  type BundleCard,
} from "../../src/client/components/BundleCard";

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

  it("is drawn in the Vault's pixel look: tier colour, edge light on epic and up, leans, sparks", async () => {
    const epic = await mount(pack(four));
    const root = epic.querySelector<HTMLElement>("[data-bundle-card]")!;
    expect(root.classList).toContain("vault-tilt");
    expect(root.getAttribute("style")).toContain("--c:#c084fc");
    expect(root.getAttribute("style")).toContain("--bi:url(");
    expect(epic.querySelector(".vault-edge")).toBeTruthy();
    expect(epic.querySelector(".vault-glare")).toBeTruthy();
    expect(epic.querySelectorAll(".bc-spark")).toHaveLength(4);
    expect(document.getElementById("bundle-card-styles")).toBeTruthy();

    const common = await mount(pack(four, { rarity: "common" }));
    expect(common.querySelector(".vault-edge")).toBeNull();
  });

  it("is marked focused when it is the inspected one", async () => {
    const card = await mount(pack(four), { state: "focused" });
    expect(
      card.querySelector("[data-bundle-card]")!.hasAttribute("data-focused"),
    ).toBe(true);
  });
});

describe("level locks", () => {
  const lockedEffect = (minLevel: number): ResolvedCosmetic => {
    const r = effect("locked", 900);
    (r.cosmetic as { minLevel?: number }).minLevel = minLevel;
    return r;
  };
  const me = (level: number, prestige = 0) =>
    ({ player: { progress: { level, prestige } } }) as never;

  it("reads the account's level, 100 once prestiged, null without progression", () => {
    expect(reachedLevel(me(12))).toBe(12);
    expect(reachedLevel(me(3, 1))).toBe(100);
    expect(reachedLevel({ player: {} } as never)).toBeNull();
    expect(reachedLevel(false)).toBeNull();
  });

  it("locks an item above the account's level and unlocks it at that level", () => {
    const item = lockedEffect(20);
    expect(minLevelOf(item)).toBe(20);
    expect(levelLockOf(item, me(19))).toBe(20);
    expect(levelLockOf(item, me(20))).toBeNull();
    expect(levelLockOf(item, me(5, 1))).toBeNull(); // prestiged
    expect(levelLockOf(effect("free", 100), me(1))).toBeNull();
    // unknown level: nothing is locked client-side (the server decides)
    expect(levelLockOf(item, false)).toBeNull();
  });

  it("holds a bundle to the highest level of its items", () => {
    const bundle = pack([effect("a", 300), lockedEffect(12), lockedEffect(30)]);
    expect(minLevelOf(bundle)).toBe(30);
    expect(levelLockOf(bundle, me(29))).toBe(30);
    expect(levelLockOf(bundle, me(30))).toBeNull();
  });
});

describe("seasonal bundles", () => {
  const dated = (startsAt?: string, endsAt?: string) =>
    ({ name: "s", startsAt, endsAt }) as never;
  const now = Date.parse("2026-10-20T12:00:00Z");

  it("are in season between startsAt and endsAt, either of which may be absent", () => {
    expect(bundleInSeason(dated(), now)).toBe(true);
    expect(bundleInSeason(dated("2026-10-01T00:00:00Z"), now)).toBe(true);
    expect(bundleInSeason(dated(undefined, "2026-11-01T00:00:00Z"), now)).toBe(
      true,
    );
    expect(bundleInSeason(dated("2026-10-21T00:00:00Z"), now)).toBe(false);
    expect(bundleInSeason(dated(undefined, "2026-10-20T12:00:00Z"), now)).toBe(
      false,
    );
  });

  it("say how long they have left", () => {
    expect(timeLeft(3 * 86_400_000 + 4 * 3_600_000 + 1)).toBe("3d 4h");
    expect(timeLeft(5 * 3_600_000 + 12 * 60_000)).toBe("5h 12m");
    expect(timeLeft(9 * 60_000)).toBe("9m");
    expect(timeLeft(-5)).toBe("0m");
  });

  it("show a countdown on the card only when they end", async () => {
    const card = document.createElement("bundle-card") as BundleCard;
    const withEnd = pack(four, {
      endsAt: new Date(Date.now() + 2 * 86_400_000 + 3_600_000).toISOString(),
    });
    Object.assign(card, { resolved: withEnd });
    document.body.appendChild(card);
    await card.updateComplete;
    expect(card.querySelector("[data-bundle-ends]")?.textContent).toContain(
      "store.bundle_ends_in",
    );
    card.remove();
    const plain = document.createElement("bundle-card") as BundleCard;
    Object.assign(plain, { resolved: pack(four) });
    document.body.appendChild(plain);
    await plain.updateComplete;
    expect(plain.querySelector("[data-bundle-ends]")).toBeNull();
    plain.remove();
  });
});
