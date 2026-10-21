import { crownFlare, effectFlare, flagFlare, patternFlare } from "./flares";
import type { Catalog } from "./load";

/**
 * What a purchase request asks for, resolved against the server's own catalog
 * (docs/DeltaFrontAccountsPlan.md section 9.4). The request carries only a
 * kind, a name and a palette; the flare and the price come from here, so a
 * client can never choose either.
 */
export interface PurchaseRequest {
  cosmeticType: "pattern" | "skin" | "flag" | "crown" | "effect";
  cosmeticName: string;
  colorPaletteName?: string | undefined;
}

export interface Offer {
  flare: string;
  /** Price in Credits: a positive whole number from the catalog. */
  price: number;
}

const own = <T extends object>(record: T | undefined, key: string) =>
  record !== undefined && Object.prototype.hasOwnProperty.call(record, key)
    ? (record as Record<string, T[keyof T]>)[key]
    : undefined;

const isPrice = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0;

/**
 * The flare and price for a request, or null when the catalog does not sell it:
 * an unknown name (own properties only, so `constructor` and friends are just
 * unknown), a kind V1 has none of (skins), a palette the pattern does
 * not have or has archived, a missing palette on a pattern that needs one, a
 * palette on anything else, or an item with no Credits price.
 */
export function findOffer(
  catalog: Catalog,
  request: PurchaseRequest,
): Offer | null {
  const { cosmetics } = catalog;
  const palette = request.colorPaletteName;
  let flare: string;
  let price: unknown;
  switch (request.cosmeticType) {
    case "pattern": {
      const pattern = own(cosmetics.patterns, request.cosmeticName);
      if (pattern === undefined) return null;
      const palettes = pattern.colorPalettes ?? [];
      if (palettes.length === 0) {
        if (palette !== undefined) return null;
        flare = patternFlare(pattern.name, null);
      } else {
        const chosen = palettes.find((p) => p.name === palette);
        if (chosen === undefined || chosen.isArchived) return null;
        flare = patternFlare(pattern.name, chosen.name);
      }
      price = pattern.priceSoft;
      break;
    }
    case "flag": {
      const flag = own(cosmetics.flags, request.cosmeticName);
      if (flag === undefined || palette !== undefined) return null;
      flare = flagFlare(flag.name);
      price = flag.priceSoft;
      break;
    }
    case "crown": {
      const crown = own(cosmetics.crowns, request.cosmeticName);
      if (crown === undefined || palette !== undefined) return null;
      flare = crownFlare(crown.name);
      price = crown.priceSoft;
      break;
    }
    case "effect": {
      if (palette !== undefined) return null;
      const effect = Object.values(cosmetics.effects ?? {})
        .flatMap((byName) => Object.values(byName ?? {}))
        .find((e) => e.name === request.cosmeticName);
      if (effect === undefined) return null;
      flare = effectFlare(effect.name);
      price = effect.priceSoft;
      break;
    }
    default:
      // skins: the catalog has none
      return null;
  }
  if (!isPrice(price) || !catalog.validFlares.has(flare)) return null;
  return { flare, price };
}

export interface BundleOffer {
  name: string;
  /** Every flare the bundle grants, in the bundle's order. */
  flares: string[];
  /** Price in Credits: a positive whole number from the catalog. */
  price: number;
}

/**
 * The flares and price for a bundle name, or null when the catalog has no such
 * bundle. Each item is resolved through `findOffer`, so a bundle can only ever
 * grant what the catalog sells on its own; a bundle that no longer resolves
 * (an item was removed from the catalog after it was written) is not sold at
 * all rather than sold short.
 */
export function findBundleOffer(
  catalog: Catalog,
  packName: string,
): BundleOffer | null {
  const pack = own(catalog.cosmetics.packs, packName);
  if (pack === undefined || !isPrice(pack.priceSoft)) return null;
  const flares: string[] = [];
  for (const item of pack.items) {
    const offer = findOffer(catalog, {
      cosmeticType: item.type,
      cosmeticName: item.name,
      colorPaletteName: item.colorPalette,
    });
    if (offer === null) return null;
    flares.push(offer.flare);
  }
  if (flares.length === 0) return null;
  return { name: pack.name, flares, price: pack.priceSoft };
}
