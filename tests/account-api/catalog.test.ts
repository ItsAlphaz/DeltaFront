// @vitest-environment node
import {
  CosmeticsSchema,
  EFFECT_TYPES,
  effectMatchesSlot,
  findEffectForSlot,
  NUKE_EXPLOSION_TYPES,
} from "@openfront/shared/CosmeticSchemas";
import { decodePatternData } from "@openfront/shared/PatternDecoder";
import { base64url } from "jose";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  encodePattern,
  encodePatternBytes,
  parseBitmap,
} from "../../scripts/cosmetics/encode-pattern";
import {
  crownFlare,
  effectFlare,
  flagFlare,
  hasFlareShape,
  isWildcardFlare,
  patternFlare,
} from "../../src/account-api/catalog/flares";
import {
  CATALOG_DIR,
  CatalogError,
  findDuplicateKeys,
  loadCatalog,
  parseCatalog,
  type Catalog,
} from "../../src/account-api/catalog/load";
import {
  findBundleOffer,
  findOffer,
} from "../../src/account-api/catalog/offer";
import { ECONOMY } from "../../src/account-api/domain/constants";
import { reportedFlares } from "../../src/account-api/repo/inventory";

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const ORIGIN = "http://localhost:8787";

const sourceText = fs.readFileSync(
  path.join(CATALOG_DIR, "cosmetics.json"),
  "utf8",
);
const source = JSON.parse(sourceText) as Record<string, any>;
const realAssets = (): Map<string, Buffer> => {
  const files = new Map<string, Buffer>();
  const dir = path.join(CATALOG_DIR, "assets");
  for (const name of fs.readdirSync(dir)) {
    files.set(name, fs.readFileSync(path.join(dir, name)));
  }
  return files;
};

/** Parses a variation of the shipped catalog; `mutate` edits a deep copy of it. */
function catalogWith(
  mutate: (c: Record<string, any>) => void,
  assets: Map<string, Buffer> = realAssets(),
): Catalog {
  const copy = JSON.parse(sourceText) as Record<string, any>;
  mutate(copy);
  return parseCatalog(JSON.stringify(copy), assets, ORIGIN);
}

function issuesOf(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    if (error instanceof CatalogError) return error.issues.join("\n");
    throw error;
  }
  throw new Error("expected the catalog to be rejected");
}

/** The items DeltaFront shipped first; level rewards point at some, so they never change. */
const ORIGINAL_FLARES = [
  "effect:colonel_wake",
  "effect:red_wake",
  "flag:delta_mark",
  "flag:recruit_banner",
  "flag:split_field",
  "pattern:delta_stripes:ash",
  "pattern:delta_stripes:ember",
  "pattern:grid_check:ember",
  "pattern:officer_chevrons:ash",
];
/** Every flare of the public sample catalog: the original eight and a few plain samples. */
const SAMPLE_FLARES = [
  ...ORIGINAL_FLARES,
  "crown:sample_crown",
  "effect:sample_atom_ring",
  "effect:sample_hydro_ring",
  "effect:sample_mirv_ring",
  "effect:sample_nuke_trail",
  "effect:sample_railroad",
  "effect:sample_structures",
  "effect:sample_train",
  "effect:sample_warship",
].sort();

/** Cosmetics only progression hands out (milestone rewards): in the catalog, never for sale. */
const REWARD_ONLY = new Set([
  "flag:recruit_banner",
  "pattern:officer_chevrons:ash",
  "effect:colonel_wake",
]);
const REWARD_ONLY_NAMES = new Set([
  "recruit_banner",
  "officer_chevrons",
  "colonel_wake",
]);

describe("the shipped DeltaFront catalog", () => {
  const catalog = loadCatalog({ publicOrigin: ORIGIN });

  it("loads, keeps the original eight items exactly, and holds the small public sample", () => {
    for (const flare of ORIGINAL_FLARES) {
      expect(catalog.validFlares.has(flare), flare).toBe(true);
    }
    expect(Object.keys(catalog.cosmetics.patterns).slice(0, 3)).toEqual([
      "delta_stripes",
      "grid_check",
      "officer_chevrons",
    ]);
    expect(Object.keys(catalog.cosmetics.flags).slice(0, 3)).toEqual([
      "delta_mark",
      "split_field",
      "recruit_banner",
    ]);
    expect(catalog.cosmetics.effects?.transportShipTrail).toHaveProperty(
      "red_wake",
    );
    // The public sample is small on purpose: the production catalog is private.
    expect([...catalog.validFlares].sort()).toEqual(SAMPLE_FLARES);
    expect(Object.keys(catalog.cosmetics.crowns ?? {})).toEqual([
      "sample_crown",
    ]);
    for (const type of EFFECT_TYPES) {
      expect(
        Object.keys(catalog.cosmetics.effects?.[type] ?? {}).length,
        type,
      ).toBeGreaterThanOrEqual(1);
    }
  });

  it("holds the cosmetics the level milestones give, and never offers them for sale", () => {
    for (const flare of REWARD_ONLY)
      expect(catalog.validFlares.has(flare)).toBe(true);
    expect(
      findOffer(catalog, {
        cosmeticType: "flag",
        cosmeticName: "recruit_banner",
      }),
    ).toBeNull();
    expect(
      findOffer(catalog, {
        cosmeticType: "pattern",
        cosmeticName: "officer_chevrons",
        colorPaletteName: "ash",
      }),
    ).toBeNull();
    expect(
      findOffer(catalog, {
        cosmeticType: "effect",
        cosmeticName: "colonel_wake",
      }),
    ).toBeNull();
  });

  it("makes exactly one item free: the ash Delta Stripes pattern", () => {
    expect(catalog.defaultFlares).toEqual(["pattern:delta_stripes:ash"]);
    expect(catalog.validFlares.has(catalog.defaultFlares[0])).toBe(true);
  });

  it("is served in the shape the client and the game server parse", () => {
    const served = JSON.parse(catalog.body);
    expect(CosmeticsSchema.safeParse(served).success).toBe(true);
    // The free-item list is the API's own data, not part of the public catalog.
    expect(served).not.toHaveProperty("defaultFlares");
    expect(catalog.etag).toMatch(/^"[0-9a-f]{32}"$/);
    expect(catalog.version).toMatch(/^[0-9a-f]{64}$/);
  });

  it("expands asset names to this API's own absolute URLs, versioned by content", () => {
    for (const flag of Object.values(catalog.cosmetics.flags)) {
      expect(flag.url).toMatch(
        /^http:\/\/localhost:8787\/cosmetics\/assets\/[a-z0-9_]+\.svg\?v=[0-9a-f]{12}$/,
      );
    }
    const other = parseCatalog(
      sourceText,
      new Map([
        ...realAssets(),
        [
          "delta_mark.svg",
          Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>"),
        ],
      ]),
      "https://api.example.com",
    );
    expect(other.cosmetics.flags.delta_mark.url).toMatch(
      /^https:\/\/api\.example\.com\/cosmetics\/assets\/delta_mark\.svg\?v=/,
    );
    expect(other.cosmetics.flags.delta_mark.url).not.toBe(
      catalog.cosmetics.flags.delta_mark.url.replace(
        ORIGIN,
        "https://api.example.com",
      ),
    );
  });

  describe("content rules (decision D6)", () => {
    const everyItem = [
      ...Object.values(source.patterns),
      ...Object.values(source.flags),
      ...Object.values(source.crowns),
      ...Object.values<any>(source.effects).flatMap((byName: any) =>
        Object.values(byName),
      ),
    ] as Array<Record<string, any>>;

    it("has only patterns, flags, crowns and effects, and none of the real-money or premium sections", () => {
      expect(Object.keys(source).sort()).toEqual([
        "colorPalettes",
        "crowns",
        "defaultFlares",
        "effects",
        "flags",
        "packs",
        "patterns",
      ]);
      for (const forbidden of [
        "currencyPacks",
        "subscriptions",
        "tribeNames",
        "lobbyQueue",
        "skins",
      ]) {
        expect(source, forbidden).not.toHaveProperty(forbidden);
      }
      expect(everyItem.length).toBeLessThan(40); // a sample, not a store
    });

    it("uses no premium (hard-currency) price, no Stripe product and no affiliate code", () => {
      for (const item of everyItem) {
        expect(item.priceHard, item.name).toBeUndefined();
        expect(item.product, item.name).toBeNull();
        expect(item.affiliateCode, item.name).toBeUndefined();
        if (item.priceSoft !== undefined) {
          expect(Number.isInteger(item.priceSoft) && item.priceSoft > 0).toBe(
            true,
          );
        }
      }
    });

    it("has unique names, and every key equals its item's name", () => {
      const names = everyItem.map((i) => i.name);
      expect(new Set(names).size).toBe(names.length);
      expect(findDuplicateKeys(sourceText)).toEqual([]);
      for (const group of ["patterns", "flags", "crowns"]) {
        for (const [key, item] of Object.entries<any>(source[group])) {
          expect(item.name).toBe(key);
        }
      }
    });

    it("has every asset on disk, and no asset that nothing uses", () => {
      const referenced = new Set<string>();
      for (const item of [
        ...Object.values<any>(source.flags),
        ...Object.values<any>(source.crowns),
      ]) {
        referenced.add(item.url);
        expect(
          fs.existsSync(path.join(CATALOG_DIR, "assets", item.url)),
          item.url,
        ).toBe(true);
      }
      expect([...realAssets().keys()].sort()).toEqual([...referenced].sort());
    });

    it("credits every item and asset in CREDITS.md as DeltaFront placeholder art", () => {
      const credits = fs.readFileSync(path.join(ROOT, "CREDITS.md"), "utf8");
      for (const item of everyItem) {
        expect(credits, item.name).toContain(item.name);
      }
      for (const file of realAssets().keys()) {
        expect(credits, file).toContain(file);
      }
    });

    it("carries no OpenFront product name, currency name or artwork path", () => {
      const forbidden =
        /openfront|plutonium|\bcaps?\b|bottle|\bhard\b|premium|\bstripe\b|subscription|\/proprietary\//i;
      const texts = [sourceText];
      for (const [name, bytes] of realAssets()) {
        texts.push(name, bytes.toString("utf8"));
      }
      for (const text of texts) expect(text).not.toMatch(forbidden);
    });

    it("draws its patterns from the bitmaps kept beside the encoder (they cannot drift apart)", () => {
      for (const name of ["delta_stripes", "grid_check", "officer_chevrons"]) {
        const rows = parseBitmap(
          fs.readFileSync(
            path.join(ROOT, "scripts/cosmetics/bitmaps", `${name}.txt`),
            "utf8",
          ),
        );
        expect(source.patterns[name].pattern).toBe(encodePattern(rows, 1));
      }
    });

    it("uses only the DeltaFront palette: black, white and red", () => {
      const palette = new Set(["#090909", "#f5f5f5", "#e31b23"]);
      for (const p of Object.values<any>(source.colorPalettes)) {
        expect(palette.has(p.primaryColor)).toBe(true);
        expect(palette.has(p.secondaryColor)).toBe(true);
      }
      for (const byName of Object.values<any>(source.effects)) {
        for (const effect of Object.values<any>(byName)) {
          for (const colour of effect.attributes.colors) {
            expect(palette.has(colour), `${effect.name} ${colour}`).toBe(true);
          }
        }
      }
      for (const [name, bytes] of realAssets()) {
        const colours =
          bytes.toString("utf8").match(/#[0-9a-fA-F]{6}\b/g) ?? [];
        for (const colour of colours) {
          expect(palette.has(colour.toLowerCase()), `${name} ${colour}`).toBe(
            true,
          );
        }
      }
    });
  });
});

describe("catalog validation rejects a bad catalog", () => {
  it("a duplicate item id (the same key twice in the file)", () => {
    const dup = sourceText.replace(
      '"split_field": {',
      '"delta_mark": {\n      "name": "delta_mark", "url": "split_field.svg", "product": null, "rarity": "common"\n    },\n    "split_field": {',
    );
    expect(dup).not.toBe(sourceText);
    expect(() => parseCatalog(dup, realAssets(), ORIGIN)).toThrow(
      /flags\.delta_mark: defined twice/,
    );
  });

  it("two effects with the same name under different effect types (flares have no type)", () => {
    expect(
      issuesOf(() =>
        catalogWith((c) => {
          c.effects.nukeTrail = {
            red_wake: {
              ...c.effects.transportShipTrail.red_wake,
              effectType: "nukeTrail",
            },
          };
        }),
      ),
    ).toMatch(/effect name red_wake is already used under transportShipTrail/);
  });

  it("a crown whose asset is missing, or that is filed under the wrong name", () => {
    const assets = realAssets();
    assets.delete("sample_crown.svg");
    expect(issuesOf(() => catalogWith(() => undefined, assets))).toMatch(
      /crowns\.sample_crown\.url: assets\/sample_crown\.svg does not exist/,
    );
    expect(
      issuesOf(() =>
        catalogWith((c) => {
          c.crowns.sample_crown.name = "something_else";
        }),
      ),
    ).toMatch(/crowns\.sample_crown: the key and the item name differ/);
  });

  it("a crown with a premium price, a product, or a path as its asset", () => {
    expect(
      issuesOf(() =>
        catalogWith((c) => {
          c.crowns.sample_crown.priceHard = 5;
          c.crowns.sample_crown.product = {
            productId: "p",
            priceId: "x",
            price: "$1",
          };
          c.crowns.sample_crown.url = "../crown.svg";
        }),
      ),
    ).toMatch(
      /priceHard is not allowed[\s\S]*product must be null[\s\S]*must be a bare file name/,
    );
  });

  it("a crown and a flag may not share an asset file name by accident (each crown has its own file)", () => {
    const files = Object.values<any>(source.crowns).map((c) => c.url);
    expect(new Set(files).size).toBe(files.length);
    const flagFiles = Object.values<any>(source.flags).map((f) => f.url);
    for (const file of files) expect(flagFiles).not.toContain(file);
  });

  it("a key that does not match the item's name", () => {
    expect(
      issuesOf(() =>
        catalogWith((c) => {
          c.flags.delta_mark.name = "something_else";
        }),
      ),
    ).toMatch(/flags\.delta_mark: the key and the item name differ/);
  });

  it("a flag whose asset is missing", () => {
    const assets = realAssets();
    assets.delete("split_field.svg");
    expect(issuesOf(() => catalogWith(() => undefined, assets))).toMatch(
      /flags\.split_field\.url: assets\/split_field\.svg does not exist/,
    );
  });

  it.each([
    ["a path", "../secret.svg"],
    ["a sub-directory", "sub/delta_mark.svg"],
    ["an absolute URL", "https://example.com/flag.svg"],
    ["a data URL", "data:image/svg+xml;base64,AAAA"],
    ["upper case", "Delta_Mark.svg"],
    ["a script", "delta_mark.js"],
    ["no extension", "delta_mark"],
  ])("a flag asset given as %s", (_what, url) => {
    expect(
      issuesOf(() =>
        catalogWith((c) => {
          c.flags.delta_mark.url = url;
        }),
      ),
    ).toMatch(/flags\.delta_mark\.url: must be a bare file name/);
  });

  it("an asset file with an unsafe name or too large", () => {
    const badName = realAssets().set("Evil Name.svg", Buffer.from("x"));
    expect(issuesOf(() => catalogWith(() => undefined, badName))).toMatch(
      /assets\/Evil Name\.svg: file names are lowercase/,
    );
    const big = realAssets().set("big_one.png", Buffer.alloc(300 * 1024));
    expect(issuesOf(() => catalogWith(() => undefined, big))).toMatch(
      /assets\/big_one\.png: larger than/,
    );
  });

  it("a premium (hard currency) price", () => {
    expect(
      issuesOf(() =>
        catalogWith((c) => {
          c.patterns.grid_check.priceHard = 50;
        }),
      ),
    ).toMatch(/patterns\.grid_check: priceHard is not allowed/);
  });

  it.each([0, -5, 1.5])("a Credits price of %s", (price) => {
    expect(
      issuesOf(() =>
        catalogWith((c) => {
          c.flags.delta_mark.priceSoft = price;
        }),
      ),
    ).toMatch(/priceSoft must be a positive whole number/);
  });

  it("accepts a plain positive Credits price (milestone M5 will use it)", () => {
    const priced = catalogWith((c) => {
      c.flags.delta_mark.priceSoft = 400;
    });
    expect(priced.cosmetics.flags.delta_mark.priceSoft).toBe(400);
  });

  it("a Stripe product, an affiliate code", () => {
    expect(
      issuesOf(() =>
        catalogWith((c) => {
          c.flags.delta_mark.product = {
            productId: "p",
            priceId: "x",
            price: "$1",
          };
          c.flags.split_field.affiliateCode = "creator";
        }),
      ),
    ).toMatch(/product must be null[\s\S]*affiliateCode is not used/);
  });

  it.each([
    [
      "skins",
      { s: { name: "s", url: "x.svg", product: null, rarity: "common" } },
    ],
    ["currencyPacks", {}],
    ["subscriptions", {}],
    ["tribeNames", { priceHard: 1, boostPriceHard: 1, boostDurationDays: 1 }],
    ["lobbyQueue", { priceHard: 1 }],
  ])("a %s section, which V1 does not have", (section, value) => {
    expect(
      issuesOf(() =>
        catalogWith((c) => {
          c[section] = value;
        }),
      ),
    ).toMatch(new RegExp(`${section}|Unrecognized key`));
  });

  it("an invalid cosmetic type or effect type", () => {
    expect(
      issuesOf(() =>
        catalogWith((c) => {
          c.hats = { top: {} };
        }),
      ),
    ).toMatch(/Unrecognized key/);
    expect(
      issuesOf(() =>
        catalogWith((c) => {
          c.effects.confetti = { party: c.effects.transportShipTrail.red_wake };
        }),
      ),
    ).toMatch(/effects/);
  });

  it("an effect the client would silently drop (so it could never be equipped)", () => {
    expect(
      issuesOf(() =>
        catalogWith((c) => {
          c.effects.transportShipTrail.red_wake.attributes = {
            type: "gradient",
          };
        }),
      ),
    ).toMatch(/effects\.transportShipTrail\.red_wake/);
  });

  it("an effect filed under the wrong effect type", () => {
    expect(
      issuesOf(() =>
        catalogWith((c) => {
          c.effects.transportShipTrail.red_wake.effectType = "nukeTrail";
        }),
      ),
    ).toMatch(/effectType "nukeTrail" does not match its group/);
  });

  it("pattern data the game cannot decode", () => {
    expect(
      issuesOf(() =>
        catalogWith((c) => {
          c.patterns.grid_check.pattern = "AAAA";
        }),
      ),
    ).toMatch(/patterns\.grid_check\.pattern/);
  });

  it("a pattern that names an undefined palette, or the same palette twice", () => {
    expect(
      issuesOf(() =>
        catalogWith((c) => {
          c.patterns.grid_check.colorPalettes.push({
            name: "neon",
            isArchived: false,
          });
        }),
      ),
    ).toMatch(/palette "neon" is not defined in colorPalettes/);
    expect(
      issuesOf(() =>
        catalogWith((c) => {
          c.patterns.grid_check.colorPalettes.push({
            name: "ember",
            isArchived: false,
          });
        }),
      ),
    ).toMatch(/palette ember is listed twice/);
  });

  it("a palette colour that is not #rrggbb", () => {
    expect(
      issuesOf(() =>
        catalogWith((c) => {
          c.colorPalettes.ember.primaryColor = "red";
        }),
      ),
    ).toMatch(/not a #rrggbb colour/);
  });

  it("a free/default item that is not in the catalog, a wildcard, or listed twice", () => {
    expect(
      issuesOf(() =>
        catalogWith((c) => {
          c.defaultFlares = ["flag:nope"];
        }),
      ),
    ).toMatch(/"flag:nope" is not an item in the catalog/);
    expect(
      issuesOf(() =>
        catalogWith((c) => {
          c.defaultFlares = ["pattern:*"];
        }),
      ),
    ).toMatch(/"pattern:\*" is not an item in the catalog/);
    expect(
      issuesOf(() =>
        catalogWith((c) => {
          c.defaultFlares = ["flag:delta_mark", "flag:delta_mark"];
        }),
      ),
    ).toMatch(/listed twice/);
  });

  it("a catalog with no items, or one that is not JSON", () => {
    expect(
      issuesOf(() =>
        catalogWith((c) => {
          c.patterns = {};
          c.flags = {};
          c.crowns = {};
          c.effects = {};
          c.defaultFlares = [];
        }),
      ),
    ).toMatch(/no items/);
    expect(() => parseCatalog("{ nope", realAssets(), ORIGIN)).toThrow(
      /not valid JSON/,
    );
  });

  it("reports every problem at once, not just the first", () => {
    const issues = issuesOf(() =>
      catalogWith((c) => {
        c.flags.delta_mark.priceHard = 1;
        c.flags.split_field.url = "../x.svg";
        c.defaultFlares = ["flag:missing"];
      }),
    );
    expect(issues.split("\n").length).toBeGreaterThanOrEqual(3);
  });
});

describe("findDuplicateKeys", () => {
  it("finds a repeated key at any depth, and ignores braces, quotes and equal keys in different objects", () => {
    expect(findDuplicateKeys('{"a":1,"b":{"c":1,"c":2},"a":3}')).toEqual([
      "b.c",
      "a",
    ]);
    expect(findDuplicateKeys('{"a":{"x":1},"b":{"x":2}}')).toEqual([]);
    expect(findDuplicateKeys('{"a":"}{\\"a\\":","b":[{"k":1,"k":2}]}')).toEqual(
      ["b[0].k"],
    );
    expect(
      findDuplicateKeys('{"list":[1,2,{"z":true,"z":null}],"n":-1.5e3}'),
    ).toEqual(["list[2].z"]);
  });
});

describe("flares", () => {
  it("are built from catalog names only, in the shapes the game server checks", () => {
    expect(patternFlare("delta_stripes", "ash")).toBe(
      "pattern:delta_stripes:ash",
    );
    expect(patternFlare("plain", null)).toBe("pattern:plain");
    expect(flagFlare("delta_mark")).toBe("flag:delta_mark");
    expect(crownFlare("sample_crown")).toBe("crown:sample_crown");
    expect(effectFlare("red_wake")).toBe("effect:red_wake");
  });

  it("have a strict shape: no wildcards, no spaces, bounded length, no other kinds", () => {
    for (const ok of [
      "pattern:a:b",
      "pattern:a",
      "flag:x_1",
      "crown:sample_crown",
      "effect:red_wake",
    ]) {
      expect(hasFlareShape(ok), ok).toBe(true);
    }
    for (const bad of [
      "",
      "pattern:*",
      "flag:*",
      "*",
      "flag:Upper",
      "flag:a b",
      "flag:",
      "skin:x",
      "crown:*",
      "crown:Upper",
      "color:ff0000",
      "pattern:a:b:c",
      "flag:../x",
      `flag:${"a".repeat(33)}`,
      42,
      null,
      undefined,
    ]) {
      expect(hasFlareShape(bad), String(bad)).toBe(false);
    }
    expect(isWildcardFlare("pattern:*")).toBe(true);
    expect(isWildcardFlare("*")).toBe(true);
    expect(isWildcardFlare("flag:delta_mark")).toBe(false);
  });
});

describe("what /users/@me reports as flares", () => {
  const catalog = loadCatalog({ publicOrigin: ORIGIN });

  it("is the free item for an account that owns nothing", () => {
    expect(reportedFlares(catalog, [])).toEqual(["pattern:delta_stripes:ash"]);
  });

  it("adds what the account owns, sorted, once each", () => {
    expect(
      reportedFlares(catalog, [
        "flag:delta_mark",
        "pattern:delta_stripes:ash",
        "flag:delta_mark",
        "effect:red_wake",
      ]),
    ).toEqual([
      "effect:red_wake",
      "flag:delta_mark",
      "pattern:delta_stripes:ash",
    ]);
  });

  it("drops anything the catalog does not define: a removed item, a wildcard, junk", () => {
    expect(
      reportedFlares(catalog, [
        "flag:retired_flag",
        "pattern:*",
        "flag:*",
        "effect:*",
        "pattern:delta_stripes",
        "'; DROP TABLE users; --",
      ]),
    ).toEqual(["pattern:delta_stripes:ash"]);
  });
});

describe("the pattern encoder (scripts/cosmetics/encode-pattern.ts)", () => {
  const rows = ["#.#.", ".#.#", "####", "...."];

  it("round-trips through the game's own decoder", () => {
    const data = encodePattern(rows, 2);
    const decoded = decodePatternData(data, base64url.decode);
    expect(decoded.width).toBe(4);
    expect(decoded.height).toBe(4);
    expect(decoded.scale).toBe(2);
    // The bit for every cell is set exactly where the bitmap has a '.'.
    rows.forEach((row, y) => {
      [...row].forEach((cell, x) => {
        const index = y * 4 + x;
        const set =
          (decoded.bytes[3 + (index >> 3)] & (1 << (index & 7))) !== 0;
        expect(set, `${x},${y}`).toBe(cell === ".");
      });
    });
  });

  it("round-trips the largest size and a non-square bitmap", () => {
    const wide = Array.from({ length: 3 }, (_, y) =>
      Array.from({ length: 129 }, (_, x) =>
        (x * 7 + y) % 3 === 0 ? "." : "#",
      ).join(""),
    );
    const decoded = decodePatternData(encodePattern(wide), base64url.decode);
    expect(decoded.width).toBe(129);
    expect(decoded.height).toBe(3);
  });

  it("is accepted by the catalog's pattern schema", () => {
    const catalog = catalogWith((c) => {
      c.patterns.grid_check.pattern = encodePattern(rows, 2);
    });
    expect(catalog.cosmetics.patterns.grid_check.pattern).toBe(
      encodePattern(rows, 2),
    );
  });

  it("refuses bitmaps the format cannot hold", () => {
    expect(() => encodePatternBytes(["#"])).toThrow(/at least 2x2/);
    expect(() => encodePatternBytes(["##", "#"])).toThrow(/as wide/);
    expect(() => encodePatternBytes(["##", "#x"])).toThrow(/only contain/);
    expect(() => encodePatternBytes(["##", "##"], 8)).toThrow(/scale/);
    expect(() =>
      encodePatternBytes(["#".repeat(130), "#".repeat(130)]),
    ).toThrow(/at most/);
    expect(() => encodePatternBytes(Array(66).fill("##"))).toThrow(/at most/);
  });

  it("reads bitmap files, skipping blank lines and // comments", () => {
    expect(parseBitmap("// note\n##\n\n  .#  \r\n")).toEqual(["##", ".#"]);
  });
});

describe("catalog prices (milestone M5)", () => {
  const catalog = loadCatalog({ publicOrigin: ORIGIN });

  it("sells the original items at the plan's prices (docs plan 9.3), in Credits only", () => {
    const priceOf = (request: Parameters<typeof findOffer>[1]) =>
      findOffer(catalog, request)?.price;
    expect({
      "pattern:delta_stripes:ember": priceOf({
        cosmeticType: "pattern",
        cosmeticName: "delta_stripes",
        colorPaletteName: "ember",
      }),
      "pattern:grid_check:ember": priceOf({
        cosmeticType: "pattern",
        cosmeticName: "grid_check",
        colorPaletteName: "ember",
      }),
      "flag:delta_mark": priceOf({
        cosmeticType: "flag",
        cosmeticName: "delta_mark",
      }),
      "flag:split_field": priceOf({
        cosmeticType: "flag",
        cosmeticName: "split_field",
      }),
      "effect:red_wake": priceOf({
        cosmeticType: "effect",
        cosmeticName: "red_wake",
      }),
    }).toEqual({
      "pattern:delta_stripes:ember": 300,
      "pattern:grid_check:ember": 500,
      "flag:delta_mark": 400,
      "flag:split_field": 400,
      "effect:red_wake": 600,
    });
  });

  it("offers every other item at the catalog's own price: a crown, a pattern palette, every kind of effect", () => {
    expect(
      findOffer(catalog, {
        cosmeticType: "crown",
        cosmeticName: "sample_crown",
      }),
    ).toEqual({
      flare: "crown:sample_crown",
      price: source.crowns.sample_crown.priceSoft,
    });
    // A crown takes no palette, and a pattern needs one.
    expect(
      findOffer(catalog, {
        cosmeticType: "crown",
        cosmeticName: "sample_crown",
        colorPaletteName: "ember",
      }),
    ).toBeNull();
    // Everything in the catalog is for sale at a price or is a level reward.
    let sold = 0;
    for (const [name, p] of Object.entries<any>(source.patterns)) {
      for (const palette of p.colorPalettes) {
        const flare = `pattern:${name}:${palette.name}`;
        const offer = findOffer(catalog, {
          cosmeticType: "pattern",
          cosmeticName: name,
          colorPaletteName: palette.name,
        });
        if (offer === null) {
          expect(
            catalog.defaultFlares.includes(flare) || REWARD_ONLY.has(flare),
            flare,
          ).toBe(true);
        } else {
          expect(offer).toEqual({ flare, price: p.priceSoft });
          sold++;
        }
      }
    }
    for (const kind of ["flags", "crowns"] as const) {
      for (const [name, item] of Object.entries<any>(source[kind])) {
        const offer = findOffer(catalog, {
          cosmeticType: kind === "flags" ? "flag" : "crown",
          cosmeticName: name,
        });
        if (offer === null)
          expect(REWARD_ONLY_NAMES.has(name), name).toBe(true);
        else {
          expect(offer.price).toBe(item.priceSoft);
          sold++;
        }
      }
    }
    for (const byName of Object.values<any>(source.effects)) {
      for (const [name, item] of Object.entries<any>(byName)) {
        const offer = findOffer(catalog, {
          cosmeticType: "effect",
          cosmeticName: name,
        });
        if (offer === null)
          expect(REWARD_ONLY_NAMES.has(name), name).toBe(true);
        else {
          expect(offer).toEqual({
            flare: `effect:${name}`,
            price: item.priceSoft,
          });
          sold++;
        }
      }
    }
    // (the free pattern is "for sale" here too: buying it answers "already owned")
    expect(sold).toBe(catalog.validFlares.size - REWARD_ONLY.size);
  });

  it("prices are positive whole numbers, no item has a premium price or product, and the free item keeps its own palette free", () => {
    for (const item of [
      ...Object.values(source.patterns),
      ...Object.values(source.flags),
      ...Object.values(source.crowns),
      ...Object.values<any>(source.effects).flatMap((byName: any) =>
        Object.values(byName),
      ),
    ] as Array<Record<string, any>>) {
      if (REWARD_ONLY_NAMES.has(item.name)) {
        // progression rewards are never sold
        expect(item.priceSoft, item.name).toBeUndefined();
      } else {
        expect(
          Number.isInteger(item.priceSoft) && item.priceSoft > 0,
          item.name,
        ).toBe(true);
      }
      expect(item.priceHard, item.name).toBeUndefined();
      expect(item.product, item.name).toBeNull();
    }
    // The free palette is owned by everyone, so nobody is ever offered it for sale.
    expect(catalog.defaultFlares).toEqual(["pattern:delta_stripes:ash"]);
  });

  it("keeps the prices within reach of play: no item costs more than two days of the daily Credits cap", () => {
    const prices = [
      ...Object.values<any>(source.patterns),
      ...Object.values<any>(source.flags),
      ...Object.values<any>(source.crowns),
      ...Object.values<any>(source.effects).flatMap((byName: any) =>
        Object.values<any>(byName),
      ),
    ].map((item) => item.priceSoft ?? 0);
    expect(Math.max(...prices)).toBeLessThanOrEqual(
      2 * ECONOMY.dailyGameplayCap,
    );
  });

  it("findOffer: the request chooses what to buy, the catalog chooses the flare and the price", () => {
    expect(
      findOffer(catalog, { cosmeticType: "flag", cosmeticName: "delta_mark" }),
    ).toEqual({ flare: "flag:delta_mark", price: 400 });
    // extra fields on the request are not even part of its type
    expect(
      findOffer(
        { ...catalog } as Catalog,
        {
          cosmeticType: "flag",
          cosmeticName: "delta_mark",
          price: 1,
        } as never,
      )?.price,
    ).toBe(400);
  });

  it.each([
    [{ cosmeticType: "flag", cosmeticName: "nope" }],
    [{ cosmeticType: "flag", cosmeticName: "toString" }],
    [{ cosmeticType: "flag", cosmeticName: "__proto__" }],
    [{ cosmeticType: "flag", cosmeticName: "constructor" }],
    [
      {
        cosmeticType: "flag",
        cosmeticName: "delta_mark",
        colorPaletteName: "ember",
      },
    ],
    [{ cosmeticType: "pattern", cosmeticName: "grid_check" }],
    [
      {
        cosmeticType: "pattern",
        cosmeticName: "grid_check",
        colorPaletteName: "ash",
      },
    ],
    [
      {
        cosmeticType: "pattern",
        cosmeticName: "grid_check",
        colorPaletteName: "constructor",
      },
    ],
    [{ cosmeticType: "effect", cosmeticName: "delta_mark" }],
    [{ cosmeticType: "skin", cosmeticName: "delta_stripes" }],
    [{ cosmeticType: "crown", cosmeticName: "delta_mark" }],
    [{ cosmeticType: "crown", cosmeticName: "constructor" }],
    [{ cosmeticType: "crown", cosmeticName: "__proto__" }],
  ])("findOffer sells nothing for %j", (request) => {
    expect(findOffer(catalog, request as never)).toBeNull();
  });

  it("findOffer refuses an item with no price, a zero or negative price, and an archived palette", () => {
    const priced = (price: unknown): Catalog =>
      catalogWith((c) => {
        c.flags.delta_mark.priceSoft = price;
      }, realAssets());
    expect(priced(250).cosmetics.flags.delta_mark.priceSoft).toBe(250);
    const noPrice = catalogWith((c) => {
      delete c.flags.delta_mark.priceSoft;
      delete c.packs;
    });
    expect(
      findOffer(noPrice, { cosmeticType: "flag", cosmeticName: "delta_mark" }),
    ).toBeNull();
    const archived = catalogWith((c) => {
      c.patterns.grid_check.colorPalettes[0].isArchived = true;
    });
    expect(
      findOffer(archived, {
        cosmeticType: "pattern",
        cosmeticName: "grid_check",
        colorPaletteName: "ember",
      }),
    ).toBeNull();
  });
});

describe("the public sample catalog", () => {
  const catalog = loadCatalog({ publicOrigin: ORIGIN });

  it("is small: the production store is a private catalog, not this repository", () => {
    const files = realAssets();
    expect(files.size).toBeLessThanOrEqual(8);
    expect(catalog.validFlares.size).toBeLessThanOrEqual(24);
    expect(sourceText.length).toBeLessThan(40 * 1024);
  });

  it("covers every kind the store and the game use: a pattern, a flag, a crown and an effect of every type and bomb", () => {
    expect(Object.keys(catalog.cosmetics.patterns).length).toBeGreaterThan(0);
    expect(Object.keys(catalog.cosmetics.flags).length).toBeGreaterThan(0);
    expect(Object.keys(catalog.cosmetics.crowns ?? {}).length).toBeGreaterThan(
      0,
    );
    const explosions = Object.values<any>(source.effects.nukeExplosion);
    for (const bomb of NUKE_EXPLOSION_TYPES) {
      expect(
        explosions.some((e) => e.attributes.nukeType === bomb),
        bomb,
      ).toBe(true);
    }
    for (const type of EFFECT_TYPES)
      expect(source.effects).toHaveProperty(type);
  });

  it("can equip every effect: the game finds it in its own slot and in no other", () => {
    for (const [type, byName] of Object.entries<any>(source.effects)) {
      for (const [name, effect] of Object.entries<any>(byName)) {
        const slot =
          type === "nukeExplosion" ? effect.attributes.nukeType : type;
        expect(
          findEffectForSlot(catalog.cosmetics, slot, name)?.name,
          `${type} ${name}`,
        ).toBe(name);
        for (const other of [...EFFECT_TYPES, ...NUKE_EXPLOSION_TYPES]) {
          if (other === slot || other === "nukeExplosion") continue;
          expect(
            effectMatchesSlot(
              catalog.cosmetics.effects![type as "train"]![name],
              other,
            ),
            `${name} in ${other}`,
          ).toBe(false);
        }
      }
    }
  });

  it("keeps effect numbers where the renderer expects them", () => {
    for (const byName of Object.values<any>(source.effects)) {
      for (const [name, e] of Object.entries<any>(byName)) {
        const a = e.attributes;
        expect(a.colors.length, name).toBeGreaterThanOrEqual(2);
        expect(a.colors.length, name).toBeLessThanOrEqual(
          e.effectType === "nukeExplosion" ? 4 : 8,
        );
        for (const colour of a.colors) {
          expect(colour, name).toMatch(/^#[0-9a-f]{6}$/);
        }
        if (a.type === "spiral") expect(e.effectType, name).toBe("nukeTrail");
        if (e.effectType === "nukeExplosion") {
          expect(a.size, name).toBeGreaterThan(0);
          expect(a.speed, name).toBeGreaterThan(0);
          expect(a.thickness, name).toBeGreaterThan(0);
        }
      }
    }
  });

  it("draws every image as a small, self-contained SVG (no script, no outside reference)", () => {
    for (const [file, bytes] of realAssets()) {
      const text = bytes.toString("utf8");
      expect(text, file).toMatch(
        /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/,
      );
      expect(text, file).not.toMatch(
        /<script|onload|onclick|javascript:|<image|<foreignObject|xlink:href|href=|url\(\s*['"]?https?:/i,
      );
      expect(bytes.length, file).toBeLessThan(8 * 1024);
    }
    for (const crown of Object.values<any>(source.crowns)) {
      const text = fs.readFileSync(
        path.join(CATALOG_DIR, "assets", crown.url),
        "utf8",
      );
      // The renderer draws crowns in square cells.
      expect(text, crown.name).toContain('viewBox="0 0 128 128"');
    }
  });

  it("keeps every pattern within what the game decodes, in every palette it is sold in", () => {
    for (const [name, p] of Object.entries<any>(source.patterns)) {
      const decoded = decodePatternData(p.pattern, base64url.decode);
      expect(decoded.width, name).toBeGreaterThanOrEqual(2);
      expect(decoded.height, name).toBeGreaterThanOrEqual(2);
      for (const palette of p.colorPalettes) {
        expect(source.colorPalettes, `${name} ${palette.name}`).toHaveProperty(
          palette.name,
        );
      }
    }
  });
});

describe("bundles", () => {
  const catalog = catalogWith(() => {});

  it("ship in the sample, are served with the catalog and parse in the client's own schema", () => {
    expect(Object.keys(catalog.cosmetics.packs ?? {}).sort()).toEqual([
      "doomsday_cache",
      "recruit_kit",
      "war_machine",
    ]);
    expect(CosmeticsSchema.safeParse(JSON.parse(catalog.body)).success).toBe(
      true,
    );
  });

  it("each cost less than their items do separately, and grant only items the catalog sells", () => {
    for (const pack of Object.values(catalog.cosmetics.packs ?? {})) {
      const offer = findBundleOffer(catalog, pack.name)!;
      expect(offer.price).toBe(pack.priceSoft);
      let sum = 0;
      for (const item of pack.items) {
        const single = findOffer(catalog, {
          cosmeticType: item.type,
          cosmeticName: item.name,
          colorPaletteName: item.colorPalette,
        })!;
        expect(catalog.validFlares.has(single.flare)).toBe(true);
        sum += single.price;
      }
      expect(offer.price).toBeLessThan(sum);
    }
  });

  it("resolve to the flares of their items, in order", () => {
    expect(findBundleOffer(catalog, "recruit_kit")).toEqual({
      name: "recruit_kit",
      flares: [
        "pattern:delta_stripes:ember",
        "flag:delta_mark",
        "effect:red_wake",
      ],
      price: 950,
    });
  });

  it.each(["nope", "constructor", "__proto__", ""])(
    "sell nothing under the name %j",
    (name) => {
      expect(findBundleOffer(catalog, name)).toBeNull();
    },
  );

  it("are refused by the loader for a bad item, a missing palette, a repeat, a price above the sum or an unpriced item", () => {
    const bad = (edit: (pack: Record<string, any>) => void) =>
      issuesOf(() => catalogWith((c) => edit(c.packs.recruit_kit)));
    expect(bad((p) => (p.items[1].name = "no_such_flag"))).toMatch(
      /there is no flag no_such_flag/,
    );
    expect(bad((p) => delete p.items[0].colorPalette)).toMatch(
      /needs one of its live palettes/,
    );
    expect(
      bad((p) => p.items.push({ type: "flag", name: "delta_mark" })),
    ).toMatch(/in the bundle twice/);
    expect(bad((p) => (p.priceSoft = 5000))).toMatch(/more than its items/);
    expect(bad((p) => (p.priceSoft = 0))).toMatch(/positive whole number/);
    expect(bad((p) => (p.name = "other"))).toMatch(/key and the bundle name/);
    expect(bad((p) => (p.items = p.items.slice(0, 1)))).toMatch(
      /expected array to have >=2 items/,
    );
    expect(
      issuesOf(() =>
        catalogWith((c) => {
          delete c.flags.split_field.priceSoft;
          c.packs.recruit_kit.items[1] = { type: "flag", name: "split_field" };
        }),
      ),
    ).toMatch(/not sold for Credits/);
  });

  it("are refused when they hold a free default item, which no account could ever buy", () => {
    expect(
      issuesOf(() =>
        catalogWith((c) => {
          c.packs.recruit_kit.items[0].colorPalette = "ash";
        }),
      ),
    ).toMatch(/pattern:delta_stripes:ash is a free default item/);
  });

  it("an item that stops being sold after load takes its bundle off sale", () => {
    const flags = { ...catalog.cosmetics.flags };
    delete flags.delta_mark;
    const broken: Catalog = {
      ...catalog,
      cosmetics: { ...catalog.cosmetics, flags },
    };
    expect(findBundleOffer(broken, "recruit_kit")).toBeNull();
  });
});
