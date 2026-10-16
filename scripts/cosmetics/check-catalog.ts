/**
 * Validates a cosmetic catalog with the same loader the account API runs at
 * startup, without starting anything:
 *
 *   npm run catalog:check                              # the public sample catalog
 *   npm run catalog:check -- <catalog dir> [<asset dir>]
 *
 * The directory holds `cosmetics.json` (and optionally `effects.json`); the
 * asset directory defaults to `<catalog dir>/assets`. Prints what it found and
 * exits 1 listing every problem. Read-only. The production catalog lives in a
 * private repository (docs/PrivateStore.md); this is how that repository checks
 * itself before a deploy.
 */
import path from "node:path";
import { pathToFileURL } from "node:url";
import { CatalogError, loadCatalog } from "../../src/account-api/catalog/load";

export function checkCatalog(dir?: string, assetDir?: string): string {
  const catalog = loadCatalog({
    publicOrigin: "http://localhost",
    dir: dir === undefined ? undefined : path.resolve(dir),
    assetDir: assetDir === undefined ? undefined : path.resolve(assetDir),
  });
  const c = catalog.cosmetics;
  const effects = Object.entries(c.effects ?? {})
    .map(([type, byName]) => `${Object.keys(byName ?? {}).length} ${type}`)
    .join(", ");
  return [
    `catalog ok (${catalog.source?.configured ? "configured" : "public sample"}), version ${catalog.version.slice(0, 12)}`,
    `${Object.keys(c.patterns).length} patterns, ${Object.keys(c.flags).length} flags, ${Object.keys(c.crowns ?? {}).length} crowns, effects: ${effects || "none"}`,
    `${catalog.validFlares.size} purchasable or granted items, ${catalog.assets.size} images`,
  ].join("\n");
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const [dir, assetDir] = process.argv.slice(2);
  try {
    console.log(checkCatalog(dir, assetDir));
  } catch (error) {
    console.error(
      error instanceof CatalogError ? error.message : String(error),
    );
    process.exit(1);
  }
}
