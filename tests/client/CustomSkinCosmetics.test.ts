import type { UserMeResponse } from "@openfront/shared/ApiSchemas";
import {
  SKIN_CREATOR_FLARE,
  encodeSkinGrid,
  type CustomSkin,
} from "@openfront/shared/CustomSkins";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getUserMe } from "../../src/client/Api";
import {
  getPlayerCosmetics,
  getPlayerCosmeticsRefs,
  groupCosmeticVariants,
  invalidateCosmetics,
  isSkinCreator,
  type ResolvedCosmetic,
} from "../../src/client/Cosmetics";
import { UserSettings } from "../../src/client/UserSettings";

vi.mock("../../src/client/Api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/client/Api")>()),
  getApiBase: () => "https://api.test",
  getUserMe: vi.fn(),
}));

const catalog = {
  patterns: {
    grid_check: {
      name: "grid_check",
      pattern: "AAAAAA",
      product: null,
      rarity: "common",
    },
    create_your_own: {
      name: "create_your_own",
      pattern: "AAAAAA",
      url: "https://cdn.test/create_your_own.png",
      product: null,
      priceSoft: 10000,
      rarity: "legendary",
    },
  },
  flags: {},
};

const skin = (slot: number): CustomSkin => ({
  slot,
  name: `Design ${slot}`,
  patternData: encodeSkinGrid({
    width: 8,
    height: 8,
    scale: 1,
    secondary: Array.from({ length: 64 }, (_, i) => i % 2 === 0),
  }),
  primaryColor: "#aa0000",
  secondaryColor: "#101010",
});

const account = (flares: string[], customSkins: CustomSkin[]) =>
  ({
    player: { publicId: "player-1", flares, customSkins },
  }) as unknown as UserMeResponse;

function resetSettings(): void {
  UserSettings.setPlayerId(null);
  localStorage.clear();
  (
    UserSettings as unknown as { cache: Map<string, string | null> }
  ).cache.clear();
}

const item = (name: string): ResolvedCosmetic => ({
  type: "pattern",
  cosmetic: { name } as never,
  colorPalette: null,
  relationship: "purchasable",
  key: `pattern:${name}`,
});

describe("the Create Your Own shop item", () => {
  it("is recognised by name, as a pattern only", () => {
    expect(isSkinCreator(item("create_your_own"))).toBe(true);
    expect(isSkinCreator(item("grid_check"))).toBe(false);
    expect(
      isSkinCreator({ ...item("create_your_own"), type: "flag" } as never),
    ).toBe(false);
    expect(isSkinCreator(null)).toBe(false);
  });

  it("leads the skins, whatever order the catalog lists them in", () => {
    const groups = groupCosmeticVariants([
      item("grid_check"),
      item("delta_stripes"),
      item("create_your_own"),
      item("officer_chevrons"),
    ]);
    expect(groups.map((g) => g[0].cosmetic!.name)).toEqual([
      "create_your_own",
      "grid_check",
      "delta_stripes",
      "officer_chevrons",
    ]);
  });
});

describe("wearing a saved design in a match", () => {
  beforeEach(() => {
    invalidateCosmetics();
    resetSettings();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, status: 200, json: async () => catalog })),
    );
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    invalidateCosmetics();
    resetSettings();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const wear = (slot: number) => new UserSettings().setSelectedCustomSkin(slot);

  it("sends the slot, and no pattern name", async () => {
    wear(1);
    vi.mocked(getUserMe).mockResolvedValue(
      account([SKIN_CREATOR_FLARE], [skin(0), skin(1)]),
    );
    const refs = await getPlayerCosmeticsRefs();
    expect(refs.customSkin).toBe(1);
    expect(refs.patternName).toBeUndefined();
  });

  it("gives the local game the design's own pattern and colours", async () => {
    wear(1);
    vi.mocked(getUserMe).mockResolvedValue(
      account([SKIN_CREATOR_FLARE], [skin(0), skin(1)]),
    );
    const cosmetics = await getPlayerCosmetics();
    expect(cosmetics.pattern).toEqual({
      name: "custom_1",
      patternData: skin(1).patternData,
      colorPalette: {
        name: "custom",
        primaryColor: "#aa0000",
        secondaryColor: "#101010",
      },
    });
  });

  it("drops it, and forgets the choice, when the design is gone", async () => {
    wear(3);
    vi.mocked(getUserMe).mockResolvedValue(
      account([SKIN_CREATOR_FLARE], [skin(0)]),
    );
    expect((await getPlayerCosmeticsRefs()).customSkin).toBeUndefined();
    expect(new UserSettings().getSelectedCustomSkinSlot()).toBeNull();
  });

  it("drops it when the account no longer owns the creator", async () => {
    wear(0);
    vi.mocked(getUserMe).mockResolvedValue(account([], [skin(0)]));
    expect((await getPlayerCosmeticsRefs()).customSkin).toBeUndefined();
    expect(new UserSettings().getSelectedCustomSkinSlot()).toBeNull();
  });

  it("keeps the choice, but sends nothing, when the profile cannot be read", async () => {
    wear(0);
    vi.mocked(getUserMe).mockResolvedValue(false);
    expect((await getPlayerCosmeticsRefs()).customSkin).toBeUndefined();
    expect(new UserSettings().getSelectedCustomSkinSlot()).toBe(0);
  });

  it("is replaced by choosing a catalog pattern, and the other way round", () => {
    const settings = new UserSettings();
    settings.setSelectedCustomSkin(2);
    expect(settings.getSelectedCustomSkinSlot()).toBe(2);
    settings.setSelectedPatternName("pattern:grid_check");
    expect(settings.getSelectedCustomSkinSlot()).toBeNull();
    settings.setSelectedCustomSkin(2);
    expect(settings.getSelectedPatternName(catalog as never)).toBeNull();
  });
});
