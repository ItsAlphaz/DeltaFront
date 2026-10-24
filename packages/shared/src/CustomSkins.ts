import { base64url } from "jose";
import { z } from "zod";
import { decodePatternData } from "./PatternDecoder";
import type { PlayerPattern } from "./WireSchemas";

/**
 * Custom territory skins: the "Create Your Own" shop item lets an account draw
 * its own two-colour tile (the same one-bit pattern the catalog's skins use) and
 * save a few of them. Owning the item is the right to do so: the flare below.
 *
 * What a player draws is validated here, once, for the account service (on save)
 * and the game server (on join): a small grid, a small tile scale, two plain
 * colours. Nothing a player types ever reaches the game apart from those.
 */

/** The catalog item that sells the creator. Its flare is the right to use it. */
export const SKIN_CREATOR_NAME = "create_your_own";
export const SKIN_CREATOR_FLARE = `pattern:${SKIN_CREATOR_NAME}`;

/** How many designs an account may keep. */
export const MAX_CUSTOM_SKINS = 5;

/** The grid sizes the editor offers (square), and the biggest the server accepts. */
export const CUSTOM_SKIN_GRID_SIZES = [8, 12, 16, 24, 32] as const;
export const MAX_CUSTOM_SKIN_SIDE = 32;
/** A tile is drawn 2^scale map tiles wide per cell: 0 (finest) to 3. */
export const MAX_CUSTOM_SKIN_SCALE = 3;

export const CUSTOM_SKIN_NAME_MAX = 20;
/** Letters, digits, spaces, dashes and underscores: what a design may be called. */
export const CUSTOM_SKIN_NAME = /^[A-Za-z0-9][A-Za-z0-9 _-]*$/;
export const HEX_COLOR = /^#[0-9a-f]{6}$/;

/** Whether the account's flares include the right to use the creator. */
export function ownsSkinCreator(
  flares: readonly string[] | undefined,
): boolean {
  return (
    flares !== undefined &&
    (flares.includes(SKIN_CREATOR_FLARE) || flares.includes("pattern:*"))
  );
}

/** One cell grid: true is a secondary-colour cell, false the primary. */
export interface SkinGrid {
  width: number;
  height: number;
  scale: number;
  /** Row-major, `width * height` entries. */
  secondary: boolean[];
}

/** Packs a grid into the pattern data the renderer reads (see PatternDecoder). */
export function encodeSkinGrid(grid: SkinGrid): string {
  const { width, height, scale, secondary } = grid;
  if (secondary.length !== width * height) {
    throw new Error("The grid does not match its size.");
  }
  const bytes = new Uint8Array(3 + ((width * height + 7) >> 3));
  bytes[0] = 0;
  bytes[1] = (scale & 0x07) | (((width - 2) & 0x1f) << 3);
  bytes[2] = (((width - 2) >> 5) & 0x03) | (((height - 2) & 0x3f) << 2);
  secondary.forEach((isSecondary, i) => {
    if (isSecondary) bytes[3 + (i >> 3)] |= 1 << (i & 7);
  });
  return base64url.encode(bytes);
}

/** The inverse of encodeSkinGrid. Throws for data the renderer would reject. */
export function decodeSkinGrid(patternData: string): SkinGrid {
  const { width, height, scale, bytes } = decodePatternData(
    patternData,
    base64url.decode,
  );
  const secondary: boolean[] = [];
  for (let i = 0; i < width * height; i++) {
    secondary.push((bytes[3 + (i >> 3)] & (1 << (i & 7))) !== 0);
  }
  return { width, height, scale, secondary };
}

const PatternDataString = z
  .string()
  .max(1403)
  .superRefine((value, ctx) => {
    try {
      const grid = decodeSkinGrid(value);
      if (
        grid.width > MAX_CUSTOM_SKIN_SIDE ||
        grid.height > MAX_CUSTOM_SKIN_SIDE ||
        grid.scale > MAX_CUSTOM_SKIN_SCALE
      ) {
        ctx.addIssue({ code: "custom", message: "That design is too big." });
      }
    } catch {
      ctx.addIssue({ code: "custom", message: "That is not a valid design." });
    }
  });

/** What a player saves: no slot (that is in the URL) and nothing the server decides. */
export const CustomSkinBodySchema = z.object({
  name: z.string().min(1).max(CUSTOM_SKIN_NAME_MAX).regex(CUSTOM_SKIN_NAME),
  patternData: PatternDataString,
  primaryColor: z.string().regex(HEX_COLOR),
  secondaryColor: z.string().regex(HEX_COLOR),
});
export type CustomSkinBody = z.infer<typeof CustomSkinBodySchema>;

/** A saved design, as the account service reports it. */
export const CustomSkinSchema = CustomSkinBodySchema.extend({
  slot: z
    .number()
    .int()
    .min(0)
    .max(MAX_CUSTOM_SKINS - 1),
});
export type CustomSkin = z.infer<typeof CustomSkinSchema>;

/** The pattern a match carries for a saved design. */
export function customSkinPattern(skin: CustomSkin): PlayerPattern {
  return {
    name: `custom_${skin.slot}`,
    patternData: skin.patternData,
    colorPalette: {
      name: "custom",
      primaryColor: skin.primaryColor,
      secondaryColor: skin.secondaryColor,
    },
  };
}

/** The value the equipped-skin setting holds while a design is worn. */
export const CUSTOM_SKIN_SELECTION_PREFIX = "custom:";
export const customSkinSelection = (slot: number): string =>
  `${CUSTOM_SKIN_SELECTION_PREFIX}${slot}`;

/** The slot a stored selection names, or null for anything else. */
export function customSkinSlotOf(selection: string | null): number | null {
  if (
    selection === null ||
    !selection.startsWith(CUSTOM_SKIN_SELECTION_PREFIX)
  ) {
    return null;
  }
  const slot = Number(selection.slice(CUSTOM_SKIN_SELECTION_PREFIX.length));
  return Number.isInteger(slot) && slot >= 0 && slot < MAX_CUSTOM_SKINS
    ? slot
    : null;
}
