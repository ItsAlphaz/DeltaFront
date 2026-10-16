// @vitest-environment node
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The production store catalog is a private repository (docs/PrivateStore.md).
 * These checks keep this repository from growing it back: what is tracked under
 * the catalog folder is the small public sample and nothing else, and the
 * ignore rules that stop a private checkout, a production effects file or a
 * design source from being committed are present.
 */
const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

function tracked(): string[] | null {
  try {
    return execFileSync("git", ["-C", ROOT, "ls-files"], {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    })
      .split("\n")
      .filter(Boolean);
  } catch {
    return null; // not a git checkout (a tarball): the tree checks below still run
  }
}

/** The only files the public sample catalog consists of. */
const SAMPLE_FILES = [
  "src/account-api/catalog/cosmetics.json",
  "src/account-api/catalog/flares.ts",
  "src/account-api/catalog/load.ts",
  "src/account-api/catalog/offer.ts",
  "src/account-api/catalog/assets/delta_mark.svg",
  "src/account-api/catalog/assets/recruit_banner.svg",
  "src/account-api/catalog/assets/sample_crown.svg",
  "src/account-api/catalog/assets/split_field.svg",
];

describe("the public repository holds only the sample catalog", () => {
  it("tracks exactly the sample catalog's files under src/account-api/catalog", () => {
    const files = tracked();
    if (files === null) return;
    expect(
      files.filter((f) => f.startsWith("src/account-api/catalog/")).sort(),
    ).toEqual([...SAMPLE_FILES].sort());
  });

  it("tracks no catalog generator, production catalog file or image folder anywhere else", () => {
    const files = tracked();
    if (files === null) return;
    const allowed = new Set([
      "scripts/cosmetics/encode-pattern.ts",
      "scripts/cosmetics/check-catalog.ts",
      "scripts/cosmetics/bitmaps/delta_stripes.txt",
      "scripts/cosmetics/bitmaps/grid_check.txt",
      "scripts/cosmetics/bitmaps/officer_chevrons.txt",
    ]);
    expect(
      files.filter(
        (f) => f.startsWith("scripts/cosmetics/") && !allowed.has(f),
      ),
    ).toEqual([]);
    for (const f of files) {
      expect(f, f).not.toMatch(
        /(^|\/)(effects\.json|private-store|DeltaFront-Private-Store|store-private|catalog-private)(\/|$)/,
      );
      expect(f, f).not.toMatch(/\.(psd|ai|xcf|kra|sketch)$/i);
    }
  });

  it("keeps the sample catalog small: a few items, a few tiny images", () => {
    const text = fs.readFileSync(
      path.join(ROOT, "src/account-api/catalog/cosmetics.json"),
      "utf8",
    );
    const json = JSON.parse(text) as Record<string, any>;
    const items =
      Object.keys(json.patterns).length +
      Object.keys(json.flags).length +
      Object.keys(json.crowns ?? {}).length +
      Object.values<any>(json.effects).reduce(
        (n: number, byName: any) => n + Object.keys(byName).length,
        0,
      );
    expect(items).toBeLessThanOrEqual(24);
    expect(text.length).toBeLessThan(40 * 1024);
    const dir = path.join(ROOT, "src/account-api/catalog/assets");
    const images = fs.readdirSync(dir);
    expect(images.length).toBeLessThanOrEqual(8);
    for (const file of images) {
      expect(fs.statSync(path.join(dir, file)).size, file).toBeLessThan(4096);
    }
  });

  it("ignores a private checkout, a production effects file and design sources, in git and in the Docker build", () => {
    const ignore = fs.readFileSync(path.join(ROOT, ".gitignore"), "utf8");
    for (const pattern of [
      "/private-store/",
      "/DeltaFront-Private-Store/",
      "/src/account-api/catalog/effects.json",
      "/src/account-api/catalog/private/",
      "*.psd",
    ]) {
      expect(ignore, pattern).toContain(pattern);
    }
    const docker = fs.readFileSync(path.join(ROOT, ".dockerignore"), "utf8");
    for (const dir of ["private-store/", "DeltaFront-Private-Store/"]) {
      expect(docker, dir).toContain(dir);
    }
  });

  it("documents the private catalog: the variables, the loading rules and the licence split", () => {
    const doc = fs.readFileSync(
      path.join(ROOT, "docs/PrivateStore.md"),
      "utf8",
    );
    for (const needle of [
      "DF_CATALOG_DIR",
      "DF_CATALOG_ASSET_DIR",
      "never falls back",
      "All Rights Reserved",
      "CC BY-SA 4.0",
    ]) {
      expect(doc, needle).toContain(needle);
    }
    const env = fs.readFileSync(
      path.join(ROOT, "deploy/env/api.env.example"),
      "utf8",
    );
    expect(env).toContain("DF_CATALOG_DIR");
    expect(env).toContain("DF_CATALOG_ASSET_DIR");
  });

  it("does not hard-code the server's private paths in application code", () => {
    for (const file of [
      "src/account-api/catalog/load.ts",
      "src/account-api/config.ts",
      "src/account-api/service.ts",
      "src/account-api/admin/commands.ts",
    ]) {
      expect(
        fs.readFileSync(path.join(ROOT, file), "utf8"),
        file,
      ).not.toContain("/opt/deltafront-private");
    }
  });
});
