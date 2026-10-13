// @vitest-environment node
import { CosmeticsSchema } from "@openfront/shared/CosmeticSchemas";
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
import { findOffer } from "../../src/account-api/catalog/offer";
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

describe("the shipped DeltaFront catalog", () => {
  const catalog = loadCatalog({ publicOrigin: ORIGIN });

  it("loads, and holds exactly the planned placeholder set (docs plan 9.3)", () => {
    expect([...catalog.validFlares]).toEqual([
      "effect:red_wake",
      "flag:delta_mark",
      "flag:split_field",
      "pattern:delta_stripes:ash",
      "pattern:delta_stripes:ember",
      "pattern:grid_check:ember",
    ]);
    expect(Object.keys(catalog.cosmetics.patterns)).toEqual([
      "delta_stripes",
      "grid_check",
    ]);
    expect(Object.keys(catalog.cosmetics.flags)).toEqual([
      "delta_mark",
      "split_field",
    ]);
    expect(catalog.cosmetics.effects?.transportShipTrail).toHaveProperty(
      "red_wake",
    );
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
      ...Object.values<any>(source.effects).flatMap((byName: any) =>
        Object.values(byName),
      ),
    ] as Array<Record<string, any>>;

    it("has only the five V1 item kinds, and none of the real-money or premium sections", () => {
      expect(Object.keys(source).sort()).toEqual([
        "colorPalettes",
        "defaultFlares",
        "effects",
        "flags",
        "patterns",
      ]);
      for (const forbidden of [
        "packs",
        "currencyPacks",
        "subscriptions",
        "tribeNames",
        "lobbyQueue",
        "crowns",
        "skins",
      ]) {
        expect(source, forbidden).not.toHaveProperty(forbidden);
      }
      expect(everyItem).toHaveLength(5);
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
      for (const group of ["patterns", "flags"]) {
        for (const [key, item] of Object.entries<any>(source[group])) {
          expect(item.name).toBe(key);
        }
      }
    });

    it("has every asset on disk, and no asset that nothing uses", () => {
      const referenced = new Set<string>();
      for (const flag of Object.values<any>(source.flags)) {
        referenced.add(flag.url);
        expect(
          fs.existsSync(path.join(CATALOG_DIR, "assets", flag.url)),
          flag.url,
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
      for (const name of ["delta_stripes", "grid_check"]) {
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
      for (const colour of source.effects.transportShipTrail.red_wake.attributes
        .colors) {
        expect(palette.has(colour)).toBe(true);
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
      "crowns",
      { c: { name: "c", url: "x.svg", product: null, rarity: "common" } },
    ],
    [
      "skins",
      { s: { name: "s", url: "x.svg", product: null, rarity: "common" } },
    ],
    ["packs", {}],
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
    expect(effectFlare("red_wake")).toBe("effect:red_wake");
  });

  it("have a strict shape: no wildcards, no spaces, bounded length, no other kinds", () => {
    for (const ok of [
      "pattern:a:b",
      "pattern:a",
      "flag:x_1",
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
      "crown:x",
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

  it("sells every non-default item, at the plan's prices (docs plan 9.3), in Credits only", () => {
    const wanted = {
      "pattern:delta_stripes:ember": 300,
      "pattern:grid_check:ember": 500,
      "flag:delta_mark": 400,
      "flag:split_field": 400,
      "effect:red_wake": 600,
    };
    const offers: Record<string, number | undefined> = {
      "pattern:delta_stripes:ember": findOffer(catalog, {
        cosmeticType: "pattern",
        cosmeticName: "delta_stripes",
        colorPaletteName: "ember",
      })?.price,
      "pattern:grid_check:ember": findOffer(catalog, {
        cosmeticType: "pattern",
        cosmeticName: "grid_check",
        colorPaletteName: "ember",
      })?.price,
      "flag:delta_mark": findOffer(catalog, {
        cosmeticType: "flag",
        cosmeticName: "delta_mark",
      })?.price,
      "flag:split_field": findOffer(catalog, {
        cosmeticType: "flag",
        cosmeticName: "split_field",
      })?.price,
      "effect:red_wake": findOffer(catalog, {
        cosmeticType: "effect",
        cosmeticName: "red_wake",
      })?.price,
    };
    expect(offers).toEqual(wanted);
    // Everything in the catalog is either bought with those prices or free by default.
    const sellable = new Set(Object.keys(wanted));
    for (const flare of catalog.validFlares) {
      expect(
        sellable.has(flare) || catalog.defaultFlares.includes(flare),
        flare,
      ).toBe(true);
    }
  });

  it("prices are positive whole numbers, no item has a premium price or product, and the free item keeps its own palette free", () => {
    for (const item of [
      ...Object.values(source.patterns),
      ...Object.values(source.flags),
      ...Object.values<any>(source.effects).flatMap((byName: any) =>
        Object.values(byName),
      ),
    ] as Array<Record<string, any>>) {
      expect(
        Number.isInteger(item.priceSoft) && item.priceSoft > 0,
        item.name,
      ).toBe(true);
      expect(item.priceHard, item.name).toBeUndefined();
      expect(item.product, item.name).toBeNull();
    }
    // The free palette is owned by everyone, so nobody is ever offered it for sale.
    expect(catalog.defaultFlares).toEqual(["pattern:delta_stripes:ash"]);
  });

  it("keeps the prices within reach of play: the dearest item costs no more than two days of the daily Credits cap", () => {
    const dearest = Math.max(
      ...(Object.values(source.patterns) as any[]).map((p) => p.priceSoft),
      ...(Object.values(source.flags) as any[]).map((p) => p.priceSoft),
      source.effects.transportShipTrail.red_wake.priceSoft,
    );
    expect(dearest).toBeLessThanOrEqual(2 * ECONOMY.dailyGameplayCap);
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
