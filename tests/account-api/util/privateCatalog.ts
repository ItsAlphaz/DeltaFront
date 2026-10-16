import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { encodePattern } from "../../../scripts/cosmetics/encode-pattern";
import { CATALOG_DIR } from "../../../src/account-api/catalog/load";

/**
 * A stand-in for the PRIVATE production catalog: the shape of the real one
 * (`cosmetics.json` plus `effects.json`, images in a folder of their own, a
 * few decoy files that must never be served), with invented items. The real
 * production catalog is not in this repository; nothing here is part of it.
 *
 * It holds the original eight items (every deployment has them: level rewards
 * point at some) and items the public sample does NOT have, so a test can tell
 * which catalog it is talking to.
 */
export const PRIVATE_ITEMS = {
  /** granted by an admin, never sold (no price) */
  adminFlag: "admin_contributors",
  flag: "prod_flag",
  crown: "prod_crown",
  pattern: "prod_pattern",
  effects: {
    transportShipTrail: "prod_ship_trail",
    nukeTrail: "prod_nuke_trail",
    atom: "prod_atom_blast",
    hydro: "prod_hydro_blast",
    mirvWarhead: "prod_mirv_blast",
    structures: "prod_structures",
    warship: "prod_warship",
    train: "prod_train",
    railroad: "prod_railroad",
  },
} as const;

export const PRIVATE_PRICES = {
  flag: 800,
  crown: 900,
  pattern: 1200,
  effect: 1000,
} as const;

/** The flares that exist only in the private catalog. */
export const PRIVATE_ONLY_FLARES = [
  `flag:${PRIVATE_ITEMS.adminFlag}`,
  `flag:${PRIVATE_ITEMS.flag}`,
  `crown:${PRIVATE_ITEMS.crown}`,
  `pattern:${PRIVATE_ITEMS.pattern}:ember`,
  ...Object.values(PRIVATE_ITEMS.effects).map((n) => `effect:${n}`),
];

const svg = (body: string, size = "90", h = "60") =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${h}" viewBox="0 0 ${size} ${h}">${body}</svg>\n`;

export interface PrivateCatalog {
  root: string;
  /** DF_CATALOG_DIR */
  dir: string;
  /** DF_CATALOG_ASSET_DIR */
  assetDir: string;
  /** The environment an operator would set. */
  env: { DF_CATALOG_DIR: string; DF_CATALOG_ASSET_DIR: string };
  /** Files in the asset folder the catalog does not name. */
  decoys: string[];
  cleanup(): void;
}

export function makePrivateCatalog(
  options: {
    /** Put the images in `<dir>/assets` instead of a separate folder. */
    assetsInsideCatalog?: boolean;
    /** Skip effects.json (everything in cosmetics.json). */
    single?: boolean;
  } = {},
): PrivateCatalog {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "df-private-store-"));
  const dir = path.join(root, "catalog");
  const assetDir = options.assetsInsideCatalog
    ? path.join(dir, "assets")
    : path.join(root, "assets");
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(assetDir, { recursive: true });

  // The original eight, as the public sample has them.
  const sample = JSON.parse(
    fs.readFileSync(path.join(CATALOG_DIR, "cosmetics.json"), "utf8"),
  ) as Record<string, any>;
  const cosmetics: Record<string, any> = {
    defaultFlares: sample.defaultFlares,
    colorPalettes: sample.colorPalettes,
    patterns: { ...sample.patterns },
    flags: { ...sample.flags },
    crowns: {},
    effects: {
      transportShipTrail: {
        red_wake: sample.effects.transportShipTrail.red_wake,
        colonel_wake: sample.effects.transportShipTrail.colonel_wake,
      },
    },
  };
  const item = (name: string, extra: Record<string, unknown>) => ({
    name,
    product: null,
    rarity: "rare",
    ...extra,
  });
  cosmetics.patterns[PRIVATE_ITEMS.pattern] = item(PRIVATE_ITEMS.pattern, {
    priceSoft: PRIVATE_PRICES.pattern,
    pattern: encodePattern(["#.#.", ".#.#", "#.#.", ".#.#"], 1),
    colorPalettes: [{ name: "ember", isArchived: false }],
  });
  cosmetics.flags[PRIVATE_ITEMS.adminFlag] = item(PRIVATE_ITEMS.adminFlag, {
    url: `${PRIVATE_ITEMS.adminFlag}.svg`,
  });
  cosmetics.flags[PRIVATE_ITEMS.flag] = item(PRIVATE_ITEMS.flag, {
    priceSoft: PRIVATE_PRICES.flag,
    url: `${PRIVATE_ITEMS.flag}.svg`,
  });
  cosmetics.crowns[PRIVATE_ITEMS.crown] = item(PRIVATE_ITEMS.crown, {
    priceSoft: PRIVATE_PRICES.crown,
    url: `${PRIVATE_ITEMS.crown}.svg`,
  });

  const gradient = {
    type: "gradient",
    colors: ["#112233", "#ddeeff"],
    colorSize: 5,
    movementSpeed: 5,
  };
  const burst = (nukeType: string) => ({
    type: "shockwave",
    nukeType,
    colors: ["#ffaa00", "#ffffff"],
    size: 90,
    speed: 80,
    thickness: 3,
    transitionSpeed: 1,
  });
  const effect = (name: string, effectType: string, attributes: unknown) =>
    item(name, {
      priceSoft: PRIVATE_PRICES.effect,
      effectType,
      attributes,
    });
  const e = PRIVATE_ITEMS.effects;
  const effects: Record<string, Record<string, unknown>> = {
    transportShipTrail: {
      [e.transportShipTrail]: effect(
        e.transportShipTrail,
        "transportShipTrail",
        gradient,
      ),
    },
    nukeTrail: { [e.nukeTrail]: effect(e.nukeTrail, "nukeTrail", gradient) },
    nukeExplosion: {
      [e.atom]: effect(e.atom, "nukeExplosion", burst("atom")),
      [e.hydro]: effect(e.hydro, "nukeExplosion", burst("hydro")),
      [e.mirvWarhead]: effect(
        e.mirvWarhead,
        "nukeExplosion",
        burst("mirvWarhead"),
      ),
    },
    structures: {
      [e.structures]: effect(e.structures, "structures", gradient),
    },
    warship: { [e.warship]: effect(e.warship, "warship", gradient) },
    train: { [e.train]: effect(e.train, "train", gradient) },
    railroad: { [e.railroad]: effect(e.railroad, "railroad", gradient) },
  };
  if (options.single) {
    for (const [type, byName] of Object.entries(effects)) {
      cosmetics.effects[type] = { ...cosmetics.effects[type], ...byName };
    }
  } else {
    fs.writeFileSync(
      path.join(dir, "effects.json"),
      JSON.stringify({ effects }, null, 2),
    );
  }
  fs.writeFileSync(
    path.join(dir, "cosmetics.json"),
    JSON.stringify(cosmetics, null, 2),
  );

  // Images: the originals, then the private ones.
  for (const file of [
    "delta_mark.svg",
    "split_field.svg",
    "recruit_banner.svg",
  ]) {
    fs.copyFileSync(
      path.join(CATALOG_DIR, "assets", file),
      path.join(assetDir, file),
    );
  }
  fs.writeFileSync(
    path.join(assetDir, `${PRIVATE_ITEMS.adminFlag}.svg`),
    svg('<rect width="90" height="60" fill="#224488"/>'),
  );
  fs.writeFileSync(
    path.join(assetDir, `${PRIVATE_ITEMS.flag}.svg`),
    svg('<rect width="90" height="60" fill="#882244"/>'),
  );
  fs.writeFileSync(
    path.join(assetDir, `${PRIVATE_ITEMS.crown}.svg`),
    svg(
      '<path d="M10 100 L10 40 L64 20 L118 40 L118 100 Z" fill="#cc9900"/>',
      "128",
      "128",
    ),
  );

  // Things that live next to production art and must never be served.
  const decoys = [
    "unused_variant.svg",
    "notes.txt",
    "source/prod_crown.psd",
    ".hidden.svg",
  ];
  fs.mkdirSync(path.join(assetDir, "source"), { recursive: true });
  for (const file of decoys)
    fs.writeFileSync(path.join(assetDir, file), "private, not for serving");

  return {
    root,
    dir,
    assetDir,
    env: { DF_CATALOG_DIR: dir, DF_CATALOG_ASSET_DIR: assetDir },
    decoys,
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}
