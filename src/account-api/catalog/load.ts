import {
  ColorPaletteSchema,
  CosmeticsSchema,
  CrownSchema,
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
import {
  crownFlare,
  effectFlare,
  flagFlare,
  hasFlareShape,
  patternFlare,
} from "./flares";

/**
 * The DeltaFront cosmetic catalog (docs/DeltaFrontAccountsPlan.md sections 9.3
 * and 10, decision D6).
 *
 * Two places can hold it:
 *
 *   - the PUBLIC SAMPLE, `cosmetics.json` and `assets/` beside this file: a
 *     handful of items, enough to run the store, the inventory and the tests;
 *   - the PRODUCTION catalog, a private directory the operator points the API
 *     at with DF_CATALOG_DIR (and DF_CATALOG_ASSET_DIR). It is not in this
 *     repository (docs/PrivateStore.md).
 *
 * A catalog directory holds `cosmetics.json` (the client's own `CosmeticsSchema`
 * shape plus `defaultFlares`, the free items every account owns) and,
 * optionally, `effects.json` (`{ "effects": { ... } }`, merged in). It is
 * checked here, strictly, before the API will start: a catalog with a mistake
 * in it is a boot failure, never a half-working store, and a configured catalog
 * that cannot be read never falls back to the sample (owned items would vanish).
 *
 * Assets are bare file names the catalog refers to, in the asset directory.
 * Only the files the catalog names are read: nothing else in that directory
 * (sources, unused variants, a listing) is ever loaded or served, and the API
 * expands a name to its own URL.
 */

/** The public sample catalog: this folder (`cosmetics.json`, `assets/`). */
export const CATALOG_DIR = path.dirname(fileURLToPath(import.meta.url));
export const ASSET_ROUTE = "/cosmetics/assets";

/** Where the production catalog and its images are (absolute paths; unset means the sample). */
export const CATALOG_DIR_ENV = "DF_CATALOG_DIR";
export const CATALOG_ASSET_DIR_ENV = "DF_CATALOG_ASSET_DIR";

/** An asset is a bare lowercase file name with an image extension. */
const ASSET_FILE = /^[a-z0-9_]{1,48}\.(svg|png|webp)$/;
const CONTENT_TYPES: Record<string, string> = {
  svg: "image/svg+xml",
  png: "image/png",
  webp: "image/webp",
};
/** Placeholder art is tiny; anything bigger is not a placeholder. */
export const MAX_ASSET_BYTES = 256 * 1024;
export const MAX_ITEMS = 1500;

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
  /** Where it was read from; null for a catalog built from text (tests). */
  source: CatalogSource | null;
}

export interface CatalogSource {
  dir: string;
  assetDir: string;
  /** True when the operator configured the directory; false for the public sample. */
  configured: boolean;
}

export class CatalogError extends Error {
  constructor(readonly issues: string[]) {
    super(
      `Invalid cosmetic catalog:\n${issues.map((i) => `  - ${i}`).join("\n")}`,
    );
    this.name = "CatalogError";
  }
}

// z.strictObject: a key the V1 catalog does not allow (skins, packs,
// currencyPacks, subscriptions, tribeNames, lobbyQueue) is an error, not
// something quietly dropped.
const SourceSchema = z.strictObject({
  defaultFlares: z.array(z.string()),
  colorPalettes: z.record(z.string(), ColorPaletteSchema),
  patterns: z.record(z.string(), PatternSchema),
  flags: z.record(z.string(), FlagSchema),
  crowns: z.record(z.string(), CrownSchema).optional(),
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
  /** What the version is the hash of, when the text was assembled from several files. */
  versionOf: string = text,
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

  const crowns: NonNullable<Cosmetics["crowns"]> = {};
  for (const [key, crown] of Object.entries(source.crowns ?? {})) {
    const where = `crowns.${key}`;
    checkItem(where, key, crown);
    addFlare(where, crownFlare(crown.name));
    crowns[key] = { ...crown, url: assetUrl(where, crown.url) ?? crown.url };
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
    ...(source.crowns === undefined ? {} : { crowns }),
    effects,
  });
  if (!served.success) {
    throw new CatalogError(
      served.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
    );
  }
  const body = JSON.stringify(served.data);
  return {
    version: sha256(versionOf),
    body,
    etag: `"${sha256(body).slice(0, 32)}"`,
    cosmetics: served.data,
    defaultFlares: [...defaults].sort(),
    validFlares: new Set([...flares].sort()),
    assets,
    source: null,
  };
}

/**
 * The catalog directories named by the environment: both null means the public
 * sample. Problems come back as lines (the caller turns them into its own error),
 * so a bad value is reported rather than quietly ignored.
 */
export function catalogEnv(env: Record<string, string | undefined>): {
  dir: string | null;
  assetDir: string | null;
  issues: string[];
} {
  const issues: string[] = [];
  const read = (name: string): string | null => {
    const value = env[name]?.trim();
    if (value === undefined || value === "") return null;
    if (!path.isAbsolute(value)) {
      issues.push(`${name} must be an absolute path`);
      return null;
    }
    if (value.includes("\0")) {
      issues.push(`${name} is not a valid path`);
      return null;
    }
    return path.resolve(value);
  };
  const dir = read(CATALOG_DIR_ENV);
  const assetDir = read(CATALOG_ASSET_DIR_ENV);
  if (assetDir !== null && dir === null && issues.length === 0) {
    issues.push(`${CATALOG_ASSET_DIR_ENV} needs ${CATALOG_DIR_ENV} as well`);
  }
  return { dir, assetDir, issues };
}

const catalogFile = (
  dir: string,
  name: string,
  required: boolean,
): string | null => {
  const full = path.join(dir, name);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(full);
  } catch (error) {
    if (!required && (error as NodeJS.ErrnoException).code === "ENOENT")
      return null;
    throw new CatalogError([
      `${name} cannot be read in ${dir}: ${(error as NodeJS.ErrnoException).code ?? "error"}`,
    ]);
  }
  if (!stat.isFile() || stat.size > MAX_CATALOG_BYTES) {
    throw new CatalogError([
      `${name} in ${dir} is not a regular file of a sensible size`,
    ]);
  }
  return fs.readFileSync(full, "utf8");
};

/** The asset names a parsed catalog source refers to (`url` of flags, crowns and effects). */
function referencedAssets(json: unknown): string[] {
  const out = new Set<string>();
  const visit = (group: unknown) => {
    if (group === null || typeof group !== "object") return;
    for (const item of Object.values(group as Record<string, unknown>)) {
      const url = (item as { url?: unknown } | null)?.url;
      if (typeof url === "string") out.add(url);
    }
  };
  const source = json as {
    flags?: unknown;
    crowns?: unknown;
    effects?: unknown;
  };
  visit(source.flags);
  visit(source.crowns);
  if (source.effects !== null && typeof source.effects === "object") {
    for (const byName of Object.values(
      source.effects as Record<string, unknown>,
    ))
      visit(byName);
  }
  return [...out];
}

/**
 * One asset the catalog names: a regular file directly inside the asset
 * directory. A name that is not a bare file name, a missing file, a symlink or
 * anything that resolves outside the directory is left out, and parseCatalog
 * reports it as the catalog's problem (it names a file that does not exist).
 */
function readAsset(
  assetRoot: string,
  name: string,
  issues: string[],
): Buffer | null {
  if (!ASSET_FILE.test(name)) return null;
  const full = path.join(assetRoot, name);
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(full);
  } catch {
    return null;
  }
  if (!stat.isFile()) {
    issues.push(
      `assets/${name}: is not a regular file (links are not followed)`,
    );
    return null;
  }
  if (stat.size > MAX_ASSET_BYTES) {
    issues.push(`assets/${name}: larger than ${MAX_ASSET_BYTES} bytes`);
    return null;
  }
  const real = fs.realpathSync(full);
  if (path.dirname(real) !== fs.realpathSync(assetRoot)) {
    issues.push(`assets/${name}: resolves outside the asset directory`);
    return null;
  }
  return fs.readFileSync(real);
}

const MAX_CATALOG_BYTES = 8 * 1024 * 1024;

/**
 * Reads the catalog and its assets from disk and validates them. With no
 * options it is the public sample; `dir` (and `assetDir`, default `<dir>/assets`)
 * name a configured catalog, which must be complete and valid or this throws.
 */
export function loadCatalog(options: {
  publicOrigin: string;
  dir?: string;
  assetDir?: string;
}): Catalog {
  const configured = options.dir !== undefined;
  const dir = options.dir ?? CATALOG_DIR;
  const assetRoot = options.assetDir ?? path.join(dir, "assets");
  const issues: string[] = [];

  const cosmeticsText = catalogFile(dir, "cosmetics.json", true)!;
  const effectsText = catalogFile(dir, "effects.json", false);
  let text = cosmeticsText;
  let versionOf = cosmeticsText;
  let json: unknown;
  try {
    json = JSON.parse(cosmeticsText);
  } catch (error) {
    throw new CatalogError([
      `cosmetics.json is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    ]);
  }
  if (effectsText !== null) {
    let extra: unknown;
    try {
      extra = JSON.parse(effectsText);
    } catch (error) {
      throw new CatalogError([
        `effects.json is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      ]);
    }
    // (Both files are valid JSON now, so the duplicate-key scan below can read them.)
    for (const key of findDuplicateKeys(effectsText)) {
      issues.push(`effects.json ${key}: defined twice (duplicate item or key)`);
    }
    for (const key of findDuplicateKeys(cosmeticsText)) {
      issues.push(`${key}: defined twice (duplicate item or key)`);
    }
    const parsed = z
      .strictObject({
        effects: z.record(z.string(), z.record(z.string(), z.unknown())),
      })
      .safeParse(extra);
    if (!parsed.success) {
      throw new CatalogError(
        parsed.error.issues.map(
          (i) => `effects.json ${i.path.join(".") || "(file)"}: ${i.message}`,
        ),
      );
    }
    const merged = json as {
      effects?: Record<string, Record<string, unknown>>;
    };
    merged.effects ??= {};
    for (const [type, byName] of Object.entries(parsed.data.effects)) {
      const into = (merged.effects[type] ??= {});
      for (const [name, effect] of Object.entries(byName)) {
        if (name in into)
          issues.push(
            `effects.${type}.${name}: defined in both cosmetics.json and effects.json`,
          );
        into[name] = effect;
      }
    }
    if (issues.length > 0) throw new CatalogError(issues);
    text = JSON.stringify(merged);
    versionOf = `${cosmeticsText}\n${effectsText}`;
  }

  const files = new Map<string, Buffer>();
  for (const name of referencedAssets(json)) {
    const bytes = readAsset(assetRoot, name, issues);
    if (bytes !== null) files.set(name, bytes);
  }
  if (issues.length > 0) throw new CatalogError(issues);
  const catalog = parseCatalog(text, files, options.publicOrigin, versionOf);
  catalog.source = { dir, assetDir: assetRoot, configured };
  return catalog;
}
