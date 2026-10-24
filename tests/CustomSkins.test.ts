import {
  CUSTOM_SKIN_GRID_SIZES,
  CustomSkinBodySchema,
  CustomSkinSchema,
  MAX_CUSTOM_SKINS,
  MAX_CUSTOM_SKIN_SIDE,
  SKIN_CREATOR_FLARE,
  customSkinPattern,
  customSkinSelection,
  customSkinSlotOf,
  decodeSkinGrid,
  encodeSkinGrid,
  ownsSkinCreator,
} from "@openfront/shared/CustomSkins";
import { decodePatternData } from "@openfront/shared/PatternDecoder";
import { PlayerCosmeticRefsSchema } from "@openfront/shared/WireSchemas";
import { base64url } from "jose";
import { describe, expect, it } from "vitest";

const checker = (width: number, height: number, scale = 0) => ({
  width,
  height,
  scale,
  secondary: Array.from({ length: width * height }, (_, i) => i % 3 === 0),
});

const body = (patternData: string) => ({
  name: "My design",
  patternData,
  primaryColor: "#aa0000",
  secondaryColor: "#101010",
});

describe("a custom skin's pattern data", () => {
  it("round-trips through the same decoder the renderer uses", () => {
    for (const side of CUSTOM_SKIN_GRID_SIZES) {
      const grid = checker(side, side, 2);
      const data = encodeSkinGrid(grid);
      expect(decodeSkinGrid(data)).toEqual(grid);
      const raw = decodePatternData(data, base64url.decode);
      expect([raw.width, raw.height, raw.scale]).toEqual([side, side, 2]);
    }
  });

  it("marks secondary cells with a set bit, as PatternDecoder.isPrimary reads it", () => {
    const grid = {
      width: 2,
      height: 2,
      scale: 0,
      secondary: [true, false, false, true],
    };
    const bytes = base64url.decode(encodeSkinGrid(grid));
    expect(bytes[3] & 0b1111).toBe(0b1001);
  });

  it("fits the 1403 characters a pattern may use, at the biggest size", () => {
    const data = encodeSkinGrid(
      checker(MAX_CUSTOM_SKIN_SIDE, MAX_CUSTOM_SKIN_SIDE, 3),
    );
    expect(data.length).toBeLessThanOrEqual(1403);
  });

  it("refuses a grid that does not match its size", () => {
    expect(() =>
      encodeSkinGrid({ width: 4, height: 4, scale: 0, secondary: [true] }),
    ).toThrow();
  });
});

describe("what a player may save", () => {
  it("accepts a design in range", () => {
    expect(
      CustomSkinBodySchema.safeParse(body(encodeSkinGrid(checker(16, 16))))
        .success,
    ).toBe(true);
  });

  it("refuses a grid or a tile scale past the limits, and data that is not a pattern", () => {
    const tooWide = encodeSkinGrid(checker(MAX_CUSTOM_SKIN_SIDE + 1, 8));
    const tooTall = encodeSkinGrid(checker(8, MAX_CUSTOM_SKIN_SIDE + 1));
    const tooCoarse = encodeSkinGrid(checker(8, 8, 4));
    for (const data of [
      tooWide,
      tooTall,
      tooCoarse,
      "AAAA",
      "not base64!",
      "",
    ]) {
      expect(
        CustomSkinBodySchema.safeParse(body(data)).success,
        data.slice(0, 12),
      ).toBe(false);
    }
  });

  it("takes only plain lower-case #rrggbb colours", () => {
    const data = encodeSkinGrid(checker(8, 8));
    for (const colour of [
      "red",
      "#FF0000",
      "#fff",
      "#12345g",
      "rgb(0,0,0)",
      "url(x)",
      "",
    ]) {
      expect(
        CustomSkinBodySchema.safeParse({ ...body(data), primaryColor: colour })
          .success,
        colour,
      ).toBe(false);
    }
  });

  it("names a design in plain characters, at most 20", () => {
    const data = encodeSkinGrid(checker(8, 8));
    const ok = (name: string) =>
      CustomSkinBodySchema.safeParse({ ...body(data), name }).success;
    expect(ok("Night Watch-2")).toBe(true);
    for (const name of [
      "",
      " leading",
      "<b>x</b>",
      "a".repeat(21),
      "tab\there",
      "emoji 🙂",
    ]) {
      expect(ok(name), name).toBe(false);
    }
  });

  it("has slots 0 to 4 only", () => {
    const data = encodeSkinGrid(checker(8, 8));
    const ok = (slot: number) =>
      CustomSkinSchema.safeParse({ ...body(data), slot }).success;
    expect(MAX_CUSTOM_SKINS).toBe(5);
    expect([0, 4].map(ok)).toEqual([true, true]);
    expect([-1, 5, 1.5].map(ok)).toEqual([false, false, false]);
  });
});

describe("the right to use the creator", () => {
  it("is the shop item's flare", () => {
    expect(ownsSkinCreator([SKIN_CREATOR_FLARE])).toBe(true);
    expect(ownsSkinCreator(["pattern:*"])).toBe(true);
    expect(ownsSkinCreator(["pattern:grid_check", "flag:delta_mark"])).toBe(
      false,
    );
    expect(ownsSkinCreator([])).toBe(false);
    expect(ownsSkinCreator(undefined)).toBe(false);
  });
});

describe("wearing a design", () => {
  it("gives the match a pattern with the design's own colours", () => {
    const skin = CustomSkinSchema.parse({
      ...body(encodeSkinGrid(checker(8, 8))),
      slot: 2,
    });
    expect(customSkinPattern(skin)).toEqual({
      name: "custom_2",
      patternData: skin.patternData,
      colorPalette: {
        name: "custom",
        primaryColor: "#aa0000",
        secondaryColor: "#101010",
      },
    });
  });

  it("is stored as custom:<slot> and read back only when it names a slot", () => {
    expect(customSkinSelection(3)).toBe("custom:3");
    expect(customSkinSlotOf("custom:3")).toBe(3);
    for (const bad of [
      "custom:5",
      "custom:-1",
      "custom:x",
      "pattern:grid_check",
      "skin:x",
      "",
      null,
    ]) {
      expect(customSkinSlotOf(bad), String(bad)).toBeNull();
    }
  });

  it("is a ref the join message may carry, as a whole number", () => {
    expect(PlayerCosmeticRefsSchema.safeParse({ customSkin: 0 }).success).toBe(
      true,
    );
    expect(
      PlayerCosmeticRefsSchema.safeParse({ customSkin: "0" }).success,
    ).toBe(false);
  });
});
