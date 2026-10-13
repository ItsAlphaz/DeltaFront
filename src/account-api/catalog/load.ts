import {
  ColorPaletteSchema,
  CosmeticsSchema,
  EFFECT_TYPES,
  EffectSchema,
  FlagSchema,
  PatternSchema,
  type Cosmetics,
} from "@openfront/shared/CosmeticSchemas";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod/v4";
import { effectFlare, flagFlare, hasFlareShape, patternFlare } from "./flares";

/**
 * The DeltaFront cosmetic catalog (docs/DeltaFrontAccountsPlan.md sections 9.3
 * and 10, decision D6).
 *
 * `cosmetics.json` is the one source of item definitions. It is the client's
 * own `CosmeticsSchema` shape plus `defaultFlares` (the free items every
 * account owns), and it is checked here, strictly, before the API will start:
 * a catalog with a mistake in it is a boot failure, never a half-working
 * store. Assets are the files in `assets/`; the catalog refers to them by bare
 * file name and the API expands that to its own URL.
 *
 * Adding an item is data only: an entry in the JSON (and a file in `assets/`
 * for a flag), then a deploy.
 */

export const CATALOG_DIR = path.dirname(fileURLToPath(import.meta.url));
export const ASSET_ROUTE = "/cosmetics/assets";

/** An asset is a bare lowercase file name with an image extension. */
const ASSET_FILE = /^[a-z0-9_]{1,48}\.(svg|png|webp)$/;
const CONTENT_TYPES: Record<string, string> = {
  svg: "image/svg+xml",
  png: "image/png",
  webp: "image/webp",
};
/** Placeholder art is tiny; anything bigger is not a placeholder. */
export const MAX_ASSET_BYTES = 256 * 1024;
export const MAX_ITEMS = 500;

export interface CatalogAsset {
  file: string;
  contentType: string;
  bytes: Buffer;
  /** First 12 hex digits of the content hash: the cache-busting `?v=`. */
  version: string;
}

export interface Catalog {
  /** SHA-256 of the catalog file (what a purchase records as `catalog_version`). */
  version: string;
  /** The `/cosmetics.json` body: the catalog without `defaultFlares`, asset URLs absolute. */
  body: string;
  etag: string;
  cosmetics: Cosmetics;
  /** Flares every account owns, sorted. */
  defaultFlares: readonly string[];
  /** Every flare the catalog can grant, sorted. */
  validFlares: ReadonlySet<string>;
  assets: ReadonlyMap<string, CatalogAsset>;
}

export class CatalogError extends Error {
  constructor(readonly issues: string[]) {
    super(
      `Invalid cosmetic catalog:\n${issues.map((i) => `  - ${i}`).join("\n")}`,
    );
    this.name = "CatalogError";
  }
}

// z.strictObject: a key the V1 catalog does not allow (crowns, skins, packs,
// currencyPacks, subscriptions, tribeNames, lobbyQueue) is an error, not
// something quietly dropped.
const SourceSchema = z.strictObject({
  defaultFlares: z.array(z.string()),
  colorPalettes: z.record(z.string(), ColorPaletteSchema),
  patterns: z.record(z.string(), PatternSchema),
  flags: z.record(z.string(), FlagSchema),
  effects: z.partialRecord(
    z.enum(EFFECT_TYPES),
    z.record(z.string(), EffectSchema),
  ),
});

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

/**
 * Names every key that appears twice in one JSON object, as a path. (JSON.parse
 * keeps the last duplicate silently, which is how a copy-pasted item would
 * overwrite another one without anyone noticing.)
 */
export function findDuplicateKeys(text: string): string[] {
  const found: string[] = [];
  let i = 0;
  const skipSpace = () => {
    while (i < text.length && " \t\r\n".includes(text[i])) i++;
  };
  const readString = (): string => {
    const start = i;
    i++; // opening quote
    while (i < text.length && text[i] !== '"') i += text[i] === "\\" ? 2 : 1;
    i++; // closing quote
    return JSON.parse(text.slice(start, i)) as string;
  };
  const readValue = (where: string): void => {
    skipSpace();
    const c = text[i];
    if (c === "{") {
      i++;
      const seen = new Set<string>();
      skipSpace();
      while (i < text.length && text[i] !== "}") {
        skipSpace();
        const key = readString();
        const here = where === "" ? key : `${where}.${key}`;
        if (seen.has(key)) found.push(here);
        seen.add(key);
        skipSpace();
        i++; // colon
        readValue(here);
        skipSpace();
        if (text[i] === ",") i++;
        skipSpace();
      }
      i++;
    } else if (c === "[") {
      i++;
      skipSpace();
      let n = 0;
      while (i < text.length && text[i] !== "]") {
        readValue(`${where}[${n++}]`);
        skipSpace();
        if (text[i] === ",") i++;
        skipSpace();
      }
      i++;
    } else if (c === '"') {
      readString();
    } else {
      while (i < text.length && !",}] \t\r\n".includes(text[i])) i++;
    }
  };
  readValue("");
  return found;
}

const sha256 = (data: string | Buffer): string =>
  createHash("sha256").update(data).digest("hex");

/**
 * Validates the catalog source and returns the loaded catalog, or throws a
 * CatalogError listing every problem found.
 *
 * @param assetFiles the files available in `assets/` (name to bytes)
 * @param publicOrigin where browsers reach this API; asset URLs are built on it
 */
export function parseCatalog(
  text: string,
  assetFiles: ReadonlyMap<string, Buffer>,
  publicOrigin: string,
): Catalog {
  const issues: string[] = [];

  for (const key of findDuplicateKeys(text)) {
    issues.push(`${key}: defined twice (duplicate item or key)`);
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    throw new CatalogError([
      `cosmetics.json is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    ]);
  }
  const parsed = SourceSchema.safeParse(json);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      issues.push(`${issue.path.join(".") || "(catalog)"}: ${issue.message}`);
    }
    throw new CatalogError(issues);
  }
  const source = parsed.data;

  // Assets: bare, well-named, small, and present.
  const assets = new Map<string, CatalogAsset>();
  for (const [file, bytes] of assetFiles) {
    if (!ASSET_FILE.test(file)) {
      issues.push(
        `assets/${file}: file names are lowercase letters, digits and underscores with a .svg, .png or .webp extension`,
      );
      continue;
    }
    if (bytes.length > MAX_ASSET_BYTES) {
      issues.push(`assets/${file}: larger than ${MAX_ASSET_BYTES} bytes`);
      continue;
    }
    assets.set(file, {
      file,
      contentType: CONTENT_TYPES[file.slice(file.lastIndexOf(".") + 1)],
      bytes,
      version: sha256(bytes).slice(0, 12),
    });
  }
  const assetUrl = (
    where: string,
    url: string | undefined,
  ): string | undefined => {
    if (url === undefined) return undefined;
    if (!ASSET_FILE.test(url)) {
      issues.push(
        `${where}.url: must be a bare file name in assets/ (got ${JSON.stringify(url.slice(0, 60))})`,
      );
      return undefined;
    }
    const asset = assets.get(url);
    if (asset === undefined) {
      issues.push(`${where}.url: assets/${url} does not exist`);
      return undefined;
    }
    return `${publicOrigin}${ASSET_ROUTE}/${asset.file}?v=${asset.version}`;
  };

  const checkItem = (
    where: string,
    key: string,
    item: {
      name: string;
      product: unknown;
      priceSoft?: number;
      priceHard?: number;
      affiliateCode?: string | null;
    },
  ): void => {
    if (item.name !== key) {
      issues.push(
        `${where}: the key and the item name differ (${JSON.stringify(item.name)})`,
      );
    }
    if (item.priceHard !== undefined) {
      issues.push(
        `${where}: priceHard is not allowed (DeltaFront has one currency, Credits)`,
      );
    }
    if (item.product !== null) {
      issues.push(`${where}: product must be null (no real-money products)`);
    }
    if (item.affiliateCode !== undefined && item.affiliateCode !== null) {
      issues.push(`${where}: affiliateCode is not used`);
    }
    if (
      item.priceSoft !== undefined &&
      !(Number.isInteger(item.priceSoft) && item.priceSoft > 0)
    ) {
      issues.push(
        `${where}: priceSoft must be a positive whole number of Credits`,
      );
    }
  };

  const flares = new Set<string>();
  const addFlare = (where: string, flare: string): void => {
    if (!hasFlareShape(flare)) {
      issues.push(`${where}: ${JSON.stringify(flare)} is not a valid flare`);
    } else if (flares.has(flare)) {
      issues.push(
        `${where}: flare ${flare} is already defined by another item`,
      );
    }
    flares.add(flare);
  };

  for (const [key, palette] of Object.entries(source.colorPalettes)) {
    const where = `colorPalettes.${key}`;
    if (palette.name !== key)
      issues.push(`${where}: the key and the palette name differ`);
    if (!/^[a-z0-9_]{1,32}$/.test(key))
      issues.push(
        `${where}: palette names are lowercase letters, digits and underscores`,
      );
    for (const colour of [palette.primaryColor, palette.secondaryColor]) {
      if (!HEX_COLOR.test(colour))
        issues.push(
          `${where}: ${JSON.stringify(colour)} is not a #rrggbb colour`,
        );
    }
  }

  for (const [key, pattern] of Object.entries(source.patterns)) {
    const where = `patterns.${key}`;
    checkItem(where, key, pattern);
    const palettes = pattern.colorPalettes ?? [];
    if (palettes.length === 0)
      addFlare(where, patternFlare(pattern.name, null));
    const seen = new Set<string>();
    for (const palette of palettes) {
      if (!(palette.name in source.colorPalettes)) {
        issues.push(
          `${where}: palette ${JSON.stringify(palette.name)} is not defined in colorPalettes`,
        );
        continue;
      }
      if (seen.has(palette.name))
        issues.push(`${where}: palette ${palette.name} is listed twice`);
      seen.add(palette.name);
      addFlare(where, patternFlare(pattern.name, palette.name));
    }
  }

  const flags: Cosmetics["flags"] = {};
  for (const [key, flag] of Object.entries(source.flags)) {
    const where = `flags.${key}`;
    checkItem(where, key, flag);
    addFlare(where, flagFlare(flag.name));
    flags[key] = { ...flag, url: assetUrl(where, flag.url) ?? flag.url };
  }

  const effects: Record<string, Record<string, unknown>> = {};
  const effectNames = new Map<string, string>();
  for (const [effectType, byName] of Object.entries(source.effects)) {
    effects[effectType] = {};
    for (const [key, effect] of Object.entries(byName)) {
      const where = `effects.${effectType}.${key}`;
      checkItem(where, key, effect);
      if (effect.effectType !== effectType) {
        issues.push(
          `${where}: effectType ${JSON.stringify(effect.effectType)} does not match its group`,
        );
      }
      // The flare is effect:<name> with no type, so a name is one effect.
      const other = effectNames.get(effect.name);
      if (other !== undefined) {
        issues.push(
          `${where}: the effect name ${effect.name} is already used under ${other}`,
        );
      }
      effectNames.set(effect.name, effectType);
      addFlare(where, effectFlare(effect.name));
      effects[effectType][key] = {
        ...effect,
        ...(effect.url === undefined
          ? {}
          : { url: assetUrl(where, effect.url) ?? effect.url }),
      };
    }
  }

  if (flares.size === 0) issues.push("the catalog has no items");
  if (flares.size > MAX_ITEMS)
    issues.push(`the catalog has more than ${MAX_ITEMS} items`);

  // The free items every account owns.
  const defaults = new Set<string>();
  for (const flare of source.defaultFlares) {
    if (!flares.has(flare)) {
      issues.push(
        `defaultFlares: ${JSON.stringify(flare)} is not an item in the catalog`,
      );
    } else if (defaults.has(flare)) {
      issues.push(`defaultFlares: ${flare} is listed twice`);
    }
    defaults.add(flare);
  }

  if (issues.length > 0) throw new CatalogError(issues);

  // What the client downloads is checked against its own schema, so the API
  // can never serve a catalog the client or the game server would refuse.
  const served = CosmeticsSchema.safeParse({
    colorPalettes: source.colorPalettes,
    patterns: source.patterns,
    flags,
    effects,
  });
  if (!served.success) {
    throw new CatalogError(
      served.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
    );
  }
  const body = JSON.stringify(served.data);
  return {
    version: sha256(text),
    body,
    etag: `"${sha256(body).slice(0, 32)}"`,
    cosmetics: served.data,
    defaultFlares: [...defaults].sort(),
    validFlares: new Set([...flares].sort()),
    assets,
  };
}

/** Reads the catalog and its assets from disk and validates them. */
export function loadCatalog(options: {
  publicOrigin: string;
  dir?: string;
}): Catalog {
  const dir = options.dir ?? CATALOG_DIR;
  const text = fs.readFileSync(path.join(dir, "cosmetics.json"), "utf8");
  const assetDir = path.join(dir, "assets");
  const files = new Map<string, Buffer>();
  if (fs.existsSync(assetDir)) {
    for (const entry of fs.readdirSync(assetDir, { withFileTypes: true })) {
      if (entry.isFile() && !entry.name.startsWith(".")) {
        files.set(entry.name, fs.readFileSync(path.join(assetDir, entry.name)));
      }
    }
  }
  return parseCatalog(text, files, options.publicOrigin);
}
