// @vitest-environment node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkCatalog } from "../../scripts/cosmetics/check-catalog";
import {
  CATALOG_ASSET_DIR_ENV,
  CATALOG_DIR,
  CATALOG_DIR_ENV,
  catalogEnv,
  CatalogError,
  loadCatalog,
} from "../../src/account-api/catalog/load";
import { findOffer } from "../../src/account-api/catalog/offer";
import { ConfigError, loadConfig } from "../../src/account-api/config";
import {
  makePrivateCatalog,
  PRIVATE_ITEMS,
  PRIVATE_ONLY_FLARES,
  type PrivateCatalog,
} from "./util/privateCatalog";

const ORIGIN = "https://api.example.com";

const made: PrivateCatalog[] = [];
function fixture(options?: Parameters<typeof makePrivateCatalog>[0]) {
  const f = makePrivateCatalog(options);
  made.push(f);
  return f;
}
afterEach(() => {
  for (const f of made.splice(0)) f.cleanup();
});

function issuesOf(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    if (error instanceof CatalogError) return error.issues.join("\n");
    throw error;
  }
  throw new Error("expected the catalog to be rejected");
}

const edit = (file: string, change: (json: any) => void) => {
  const json = JSON.parse(fs.readFileSync(file, "utf8"));
  change(json);
  fs.writeFileSync(file, JSON.stringify(json));
};

describe("which catalog the API uses (DF_CATALOG_DIR, DF_CATALOG_ASSET_DIR)", () => {
  it("is the public sample when neither is set", () => {
    const sample = loadCatalog({ publicOrigin: ORIGIN });
    expect(sample.source).toEqual({
      dir: CATALOG_DIR,
      assetDir: path.join(CATALOG_DIR, "assets"),
      configured: false,
    });
    expect(catalogEnv({})).toEqual({ dir: null, assetDir: null, issues: [] });
    expect(
      catalogEnv({ [CATALOG_DIR_ENV]: "  ", [CATALOG_ASSET_DIR_ENV]: "" }),
    ).toEqual({
      dir: null,
      assetDir: null,
      issues: [],
    });
    expect(sample.validFlares.has("crown:sample_crown")).toBe(true);
  });

  it("is the private catalog when DF_CATALOG_DIR names one, with its images in DF_CATALOG_ASSET_DIR", () => {
    const f = fixture();
    const env = catalogEnv(f.env);
    expect(env).toEqual({ dir: f.dir, assetDir: f.assetDir, issues: [] });
    const catalog = loadCatalog({
      publicOrigin: ORIGIN,
      dir: env.dir!,
      assetDir: env.assetDir!,
    });
    expect(catalog.source).toEqual({
      dir: f.dir,
      assetDir: f.assetDir,
      configured: true,
    });
    for (const flare of PRIVATE_ONLY_FLARES) {
      expect(catalog.validFlares.has(flare), flare).toBe(true);
    }
    // The images come from the asset folder, named by the catalog.
    expect(catalog.assets.has(`${PRIVATE_ITEMS.crown}.svg`)).toBe(true);
    expect(catalog.cosmetics.crowns?.[PRIVATE_ITEMS.crown]?.url).toMatch(
      new RegExp(
        `^${ORIGIN}/cosmetics/assets/${PRIVATE_ITEMS.crown}\\.svg\\?v=[0-9a-f]{12}$`,
      ),
    );
  });

  it("looks for the images in <DF_CATALOG_DIR>/assets when DF_CATALOG_ASSET_DIR is not set", () => {
    const f = fixture({ assetsInsideCatalog: true });
    const catalog = loadCatalog({ publicOrigin: ORIGIN, dir: f.dir });
    expect(catalog.source?.assetDir).toBe(path.join(f.dir, "assets"));
    expect(catalog.assets.has(`${PRIVATE_ITEMS.flag}.svg`)).toBe(true);
  });

  it("replaces the sample completely: nothing of the sample leaks into a configured catalog", () => {
    const f = fixture();
    const catalog = loadCatalog({
      publicOrigin: ORIGIN,
      dir: f.dir,
      assetDir: f.assetDir,
    });
    const sample = loadCatalog({ publicOrigin: ORIGIN });
    const sampleOnly = [...sample.validFlares].filter(
      (flare) => !catalog.validFlares.has(flare),
    );
    expect(sampleOnly).toContain("crown:sample_crown");
    expect(sampleOnly).toContain("effect:sample_nuke_trail");
    expect(catalog.cosmetics.crowns).not.toHaveProperty("sample_crown");
    // ...and the private catalog is a different catalog (different version, for purchase records).
    expect(catalog.version).not.toBe(sample.version);
    // The originals are in both: level rewards point at them everywhere.
    for (const flare of [
      "flag:recruit_banner",
      "pattern:officer_chevrons:ash",
      "effect:colonel_wake",
    ]) {
      expect(catalog.validFlares.has(flare)).toBe(true);
    }
  });

  it("merges effects.json into cosmetics.json, and the version covers both files", () => {
    const f = fixture();
    const split = loadCatalog({
      publicOrigin: ORIGIN,
      dir: f.dir,
      assetDir: f.assetDir,
    });
    expect(split.validFlares.has(`effect:${PRIVATE_ITEMS.effects.atom}`)).toBe(
      true,
    );
    expect(split.validFlares.has("effect:red_wake")).toBe(true); // cosmetics.json's own effects stay
    const before = split.version;
    edit(path.join(f.dir, "effects.json"), (j) => {
      j.effects.railroad[PRIVATE_ITEMS.effects.railroad].priceSoft = 1234;
    });
    const changed = loadCatalog({
      publicOrigin: ORIGIN,
      dir: f.dir,
      assetDir: f.assetDir,
    });
    expect(changed.version).not.toBe(before);
    expect(
      findOffer(changed, {
        cosmeticType: "effect",
        cosmeticName: PRIVATE_ITEMS.effects.railroad,
      })?.price,
    ).toBe(1234);
  });

  it("gives the same catalog whether effects are in one file or two", () => {
    const two = fixture();
    const one = fixture({ single: true });
    const a = loadCatalog({
      publicOrigin: ORIGIN,
      dir: two.dir,
      assetDir: two.assetDir,
    });
    const b = loadCatalog({
      publicOrigin: ORIGIN,
      dir: one.dir,
      assetDir: one.assetDir,
    });
    expect([...a.validFlares]).toEqual([...b.validFlares]);
    expect(Object.keys(a.cosmetics.effects ?? {}).sort()).toEqual(
      Object.keys(b.cosmetics.effects ?? {}).sort(),
    );
  });

  it("sells private items at their own prices, and an admin-only item to no one", () => {
    const f = fixture();
    const catalog = loadCatalog({
      publicOrigin: ORIGIN,
      dir: f.dir,
      assetDir: f.assetDir,
    });
    expect(
      findOffer(catalog, {
        cosmeticType: "crown",
        cosmeticName: PRIVATE_ITEMS.crown,
      })?.price,
    ).toBe(900);
    expect(
      findOffer(catalog, {
        cosmeticType: "flag",
        cosmeticName: PRIVATE_ITEMS.adminFlag,
      }),
    ).toBeNull();
    // ...but it is in the catalog, so an admin may grant it.
    expect(catalog.validFlares.has(`flag:${PRIVATE_ITEMS.adminFlag}`)).toBe(
      true,
    );
  });
});

describe("environment variables", () => {
  it("must be absolute paths, and the asset folder needs the catalog folder", () => {
    expect(
      catalogEnv({ [CATALOG_DIR_ENV]: "relative/catalog" }).issues,
    ).toEqual([`${CATALOG_DIR_ENV} must be an absolute path`]);
    expect(
      catalogEnv({ [CATALOG_DIR_ENV]: "/x", [CATALOG_ASSET_DIR_ENV]: "assets" })
        .issues,
    ).toEqual([`${CATALOG_ASSET_DIR_ENV} must be an absolute path`]);
    expect(
      catalogEnv({ [CATALOG_ASSET_DIR_ENV]: "/only/assets" }).issues,
    ).toEqual([`${CATALOG_ASSET_DIR_ENV} needs ${CATALOG_DIR_ENV} as well`]);
    expect(catalogEnv({ [CATALOG_DIR_ENV]: "/a/b/../c" }).dir).toBe("/a/c");
  });

  it("are read by the API configuration, and a bad one refuses to start without printing the value", () => {
    const base = { GAME_ENV: "dev", DATABASE_URL: "postgres://u:pw-123@db/x" };
    expect(loadConfig(base).catalog).toEqual({ dir: null, assetDir: null });
    expect(
      loadConfig({
        ...base,
        [CATALOG_DIR_ENV]: "/opt/p/catalog",
        [CATALOG_ASSET_DIR_ENV]: "/opt/p/assets",
      }).catalog,
    ).toEqual({ dir: "/opt/p/catalog", assetDir: "/opt/p/assets" });
    let error: unknown;
    try {
      loadConfig({ ...base, [CATALOG_DIR_ENV]: "not-absolute-secret-path" });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(ConfigError);
    expect((error as ConfigError).message).toContain(CATALOG_DIR_ENV);
    expect((error as ConfigError).message).not.toContain(
      "not-absolute-secret-path",
    );
  });
});

describe("a configured catalog that is missing or broken never falls back to the sample", () => {
  it("fails when the directory does not exist", () => {
    const f = fixture();
    expect(
      issuesOf(() =>
        loadCatalog({ publicOrigin: ORIGIN, dir: path.join(f.root, "nope") }),
      ),
    ).toMatch(/cosmetics\.json cannot be read/);
  });

  it("fails when cosmetics.json is missing, a directory, or enormous", () => {
    const f = fixture();
    fs.rmSync(path.join(f.dir, "cosmetics.json"));
    expect(
      issuesOf(() =>
        loadCatalog({ publicOrigin: ORIGIN, dir: f.dir, assetDir: f.assetDir }),
      ),
    ).toMatch(/cosmetics\.json cannot be read/);
    fs.mkdirSync(path.join(f.dir, "cosmetics.json"));
    expect(
      issuesOf(() =>
        loadCatalog({ publicOrigin: ORIGIN, dir: f.dir, assetDir: f.assetDir }),
      ),
    ).toMatch(/not a regular file/);
    fs.rmSync(path.join(f.dir, "cosmetics.json"), { recursive: true });
    fs.writeFileSync(
      path.join(f.dir, "cosmetics.json"),
      " ".repeat(9 * 1024 * 1024),
    );
    expect(
      issuesOf(() =>
        loadCatalog({ publicOrigin: ORIGIN, dir: f.dir, assetDir: f.assetDir }),
      ),
    ).toMatch(/not a regular file of a sensible size/);
  });

  it("fails on malformed JSON in either file", () => {
    const f = fixture();
    fs.writeFileSync(path.join(f.dir, "cosmetics.json"), "{ nope");
    expect(
      issuesOf(() =>
        loadCatalog({ publicOrigin: ORIGIN, dir: f.dir, assetDir: f.assetDir }),
      ),
    ).toMatch(/cosmetics\.json is not valid JSON/);
    const g = fixture();
    fs.writeFileSync(path.join(g.dir, "effects.json"), "[1,");
    expect(
      issuesOf(() =>
        loadCatalog({ publicOrigin: ORIGIN, dir: g.dir, assetDir: g.assetDir }),
      ),
    ).toMatch(/effects\.json is not valid JSON/);
  });

  it("fails on an effects.json of the wrong shape, an effect in both files, or a duplicate key", () => {
    const f = fixture();
    const file = path.join(f.dir, "effects.json");
    fs.writeFileSync(file, JSON.stringify({ effects: {}, packs: {} }));
    expect(
      issuesOf(() =>
        loadCatalog({ publicOrigin: ORIGIN, dir: f.dir, assetDir: f.assetDir }),
      ),
    ).toMatch(/effects\.json/);
    fs.writeFileSync(
      file,
      JSON.stringify({ effects: { transportShipTrail: { red_wake: {} } } }),
    );
    expect(
      issuesOf(() =>
        loadCatalog({ publicOrigin: ORIGIN, dir: f.dir, assetDir: f.assetDir }),
      ),
    ).toMatch(/effects\.transportShipTrail\.red_wake: defined in both/);
    const g = fixture();
    const text = fs.readFileSync(path.join(g.dir, "effects.json"), "utf8");
    fs.writeFileSync(
      path.join(g.dir, "effects.json"),
      text.replace(
        `"${PRIVATE_ITEMS.effects.train}": {`,
        `"${PRIVATE_ITEMS.effects.train}": {},\n"${PRIVATE_ITEMS.effects.train}": {`,
      ),
    );
    expect(
      issuesOf(() =>
        loadCatalog({ publicOrigin: ORIGIN, dir: g.dir, assetDir: g.assetDir }),
      ),
    ).toMatch(/defined twice/);
  });

  it("applies every catalog rule to a private catalog: bad price, bad effect, unknown section", () => {
    const f = fixture();
    edit(path.join(f.dir, "cosmetics.json"), (j) => {
      j.flags[PRIVATE_ITEMS.flag].priceHard = 5;
      j.packs = {};
    });
    expect(
      issuesOf(() =>
        loadCatalog({ publicOrigin: ORIGIN, dir: f.dir, assetDir: f.assetDir }),
      ),
    ).toMatch(/packs|Unrecognized key/);
    const g = fixture();
    edit(path.join(g.dir, "effects.json"), (j) => {
      j.effects.nukeTrail[PRIVATE_ITEMS.effects.nukeTrail].attributes = {
        type: "gradient",
      };
    });
    expect(
      issuesOf(() =>
        loadCatalog({ publicOrigin: ORIGIN, dir: g.dir, assetDir: g.assetDir }),
      ),
    ).toMatch(/effects\.nukeTrail\.prod_nuke_trail/);
  });

  it("fails when a named image is missing from the asset folder", () => {
    const f = fixture();
    fs.rmSync(path.join(f.assetDir, `${PRIVATE_ITEMS.crown}.svg`));
    expect(
      issuesOf(() =>
        loadCatalog({ publicOrigin: ORIGIN, dir: f.dir, assetDir: f.assetDir }),
      ),
    ).toMatch(
      /crowns\.prod_crown\.url: assets\/prod_crown\.svg does not exist/,
    );
  });

  it("fails when the asset folder is not the one that holds the images (the sample's images are not used)", () => {
    const f = fixture();
    expect(
      issuesOf(() =>
        loadCatalog({
          publicOrigin: ORIGIN,
          dir: f.dir,
          assetDir: path.join(f.root, "empty"),
        }),
      ),
    ).toMatch(/does not exist/);
  });
});

describe("images: only what the catalog names, only inside the asset folder", () => {
  it("never reads a file the catalog does not name (decoys, sources, hidden files)", () => {
    const f = fixture();
    const catalog = loadCatalog({
      publicOrigin: ORIGIN,
      dir: f.dir,
      assetDir: f.assetDir,
    });
    for (const file of f.decoys)
      expect(catalog.assets.has(file), file).toBe(false);
    expect([...catalog.assets.keys()].sort()).toEqual(
      [
        "delta_mark.svg",
        "recruit_banner.svg",
        "split_field.svg",
        `${PRIVATE_ITEMS.adminFlag}.svg`,
        `${PRIVATE_ITEMS.flag}.svg`,
        `${PRIVATE_ITEMS.crown}.svg`,
      ].sort(),
    );
    // A file that would fail the naming rules does not stop the catalog loading: it is not read.
    fs.writeFileSync(path.join(f.assetDir, "Bad Name!.psd"), "x");
    expect(() =>
      loadCatalog({ publicOrigin: ORIGIN, dir: f.dir, assetDir: f.assetDir }),
    ).not.toThrow();
  });

  it.each([
    ["a parent path", "../outside.svg"],
    ["a sub-folder", "source/prod_crown.svg"],
    ["an absolute path", "/etc/passwd.svg"],
    ["a URL", "https://example.com/x.svg"],
    ["a data URL", "data:image/svg+xml;base64,AAAA"],
    ["an encoded path", "%2e%2e%2fsecret.svg"],
    ["a backslash path", "..\\secret.svg"],
    ["a null byte", "x\0.svg"],
    ["no extension", "prod_flag"],
    ["a script", "prod_flag.js"],
    ["upper case", "Prod_Flag.svg"],
  ])("refuses a catalog image named with %s", (_what, url) => {
    const f = fixture();
    fs.writeFileSync(path.join(f.root, "outside.svg"), "<svg/>");
    edit(path.join(f.dir, "cosmetics.json"), (j) => {
      j.flags[PRIVATE_ITEMS.flag].url = url;
    });
    const catalog = () =>
      loadCatalog({ publicOrigin: ORIGIN, dir: f.dir, assetDir: f.assetDir });
    expect(issuesOf(catalog)).toMatch(
      /flags\.prod_flag\.url: must be a bare file name/,
    );
  });

  it("does not follow a symbolic link, even to a file the catalog names", () => {
    const f = fixture();
    const secret = path.join(f.root, "secret.svg");
    fs.writeFileSync(secret, "<svg xmlns='http://www.w3.org/2000/svg'/>");
    fs.rmSync(path.join(f.assetDir, `${PRIVATE_ITEMS.flag}.svg`));
    fs.symlinkSync(secret, path.join(f.assetDir, `${PRIVATE_ITEMS.flag}.svg`));
    expect(
      issuesOf(() =>
        loadCatalog({ publicOrigin: ORIGIN, dir: f.dir, assetDir: f.assetDir }),
      ),
    ).toMatch(
      /prod_flag\.svg: is not a regular file \(links are not followed\)/,
    );
  });

  it("does not take a directory for an image, and refuses one over the size limit", () => {
    const f = fixture();
    fs.rmSync(path.join(f.assetDir, `${PRIVATE_ITEMS.flag}.svg`));
    fs.mkdirSync(path.join(f.assetDir, `${PRIVATE_ITEMS.flag}.svg`));
    expect(
      issuesOf(() =>
        loadCatalog({ publicOrigin: ORIGIN, dir: f.dir, assetDir: f.assetDir }),
      ),
    ).toMatch(/is not a regular file/);
    const g = fixture();
    fs.writeFileSync(
      path.join(g.assetDir, `${PRIVATE_ITEMS.flag}.svg`),
      Buffer.alloc(300 * 1024),
    );
    expect(
      issuesOf(() =>
        loadCatalog({ publicOrigin: ORIGIN, dir: g.dir, assetDir: g.assetDir }),
      ),
    ).toMatch(/larger than/);
  });

  it("reads the catalog files only by their fixed names (a stray .json beside them is ignored)", () => {
    const f = fixture();
    fs.writeFileSync(path.join(f.dir, "unreleased.json"), "{ this is not json");
    fs.writeFileSync(path.join(f.dir, "cosmetics.json.bak"), "{ nope");
    expect(() =>
      loadCatalog({ publicOrigin: ORIGIN, dir: f.dir, assetDir: f.assetDir }),
    ).not.toThrow();
  });

  it("serves a catalog whose folders sit behind a symlinked mount point", () => {
    // Deployments often mount the private checkout through a link (current -> releases/x).
    const f = fixture();
    const link = path.join(os.tmpdir(), `df-link-${process.pid}-${Date.now()}`);
    fs.symlinkSync(f.root, link);
    try {
      const catalog = loadCatalog({
        publicOrigin: ORIGIN,
        dir: path.join(link, "catalog"),
        assetDir: path.join(link, "assets"),
      });
      expect(catalog.assets.has(`${PRIVATE_ITEMS.crown}.svg`)).toBe(true);
    } finally {
      fs.rmSync(link);
    }
  });
});

describe("npm run catalog:check (the validator the private repository uses)", () => {
  it("checks the public sample when given nothing", () => {
    const report = checkCatalog();
    expect(report).toContain("catalog ok (public sample)");
    expect(report).toContain("1 crowns");
  });

  it("checks a private catalog by its folders, and names what it found", () => {
    const f = fixture();
    const report = checkCatalog(f.dir, f.assetDir);
    expect(report).toContain("catalog ok (configured)");
    expect(report).toContain("1 transportShipTrail".replace("1", "3"));
    expect(report).toMatch(/\d+ purchasable or granted items, 6 images/);
  });

  it("fails with every problem listed when the catalog is broken or its images are missing", () => {
    const f = fixture();
    fs.rmSync(path.join(f.assetDir, `${PRIVATE_ITEMS.crown}.svg`));
    expect(() => checkCatalog(f.dir, f.assetDir)).toThrow(
      /prod_crown\.svg does not exist/,
    );
    expect(() => checkCatalog(path.join(f.root, "nope"))).toThrow(CatalogError);
  });
});
