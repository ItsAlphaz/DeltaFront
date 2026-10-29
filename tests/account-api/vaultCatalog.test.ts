import fs from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { CatalogError, loadCatalog } from "../../src/account-api/catalog/load";
import { catalogWithVault, vaultConfig } from "./util/vaultCatalog";

// The Vault's config is validated when the catalog loads, so a typo is a
// startup error and never a draw that fails in front of a player.

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0))
    fs.rmSync(d, { recursive: true, force: true });
});

const load = (vault: unknown) =>
  loadCatalog({
    publicOrigin: "http://localhost:8787",
    dir: catalogWithVault(dirs, vault),
  });
const issuesOf = (vault: unknown): string => {
  try {
    load(vault);
  } catch (error) {
    if (error instanceof CatalogError) return error.issues.join("\n");
    throw error;
  }
  throw new Error("expected the catalog to be rejected");
};

describe("the Vault in the catalog", () => {
  it("loads, resolves its items and keeps itself out of what clients download", () => {
    const catalog = load(vaultConfig());
    expect(catalog.vault?.packs.size).toBe(2);
    expect(catalog.vault?.packs.get("recruit")?.items.rare).toHaveLength(2);
    expect(catalog.vault?.wheelItems.epic[0].flare).toBe("crown:vc_epic_1");
    expect(catalog.body).not.toContain("dupeCredits");
    expect(catalog.body).not.toContain("paidSpinsPerDay");
    // the Vault's crowns are not for sale: nothing sells them
    expect(catalog.cosmetics.crowns?.vc_epic_1.priceSoft).toBeUndefined();
  });

  it("is optional", () => {
    const dir = catalogWithVault(dirs);
    const file = `${dir}/cosmetics.json`;
    const json = JSON.parse(fs.readFileSync(file, "utf8"));
    delete json.vault;
    fs.writeFileSync(file, JSON.stringify(json));
    expect(loadCatalog({ publicOrigin: "http://x", dir }).vault).toBeNull();
  });

  it("rejects an item that does not exist", () => {
    const base = vaultConfig();
    const bad = {
      ...base,
      wheel: { ...base.wheel, pool: [{ type: "crown", name: "nope" }] },
    };
    expect(issuesOf(bad)).toContain("there is no crown nope");
  });

  it("rejects a slot that can draw a rarity the pool has none of", () => {
    const base = vaultConfig();
    const onlyCommon = [{ type: "crown", name: "vc_common_1" }];
    const bad = {
      ...base,
      packs: {
        ...base.packs,
        recruit: { ...base.packs.recruit, pool: onlyCommon },
      },
    };
    expect(issuesOf(bad)).toMatch(
      /slots\.1: can draw a uncommon card but the pool has none/,
    );
  });

  it("rejects a wheel prize the wheel cannot give", () => {
    const base = vaultConfig();
    const noEpic = {
      ...base.wheel,
      pool: base.wheel.pool.filter((i) => !i.name.includes("epic")),
    };
    expect(issuesOf({ ...base, wheel: noEpic })).toContain(
      "a epic item prize but the wheel's pool has none",
    );
    const badPack = {
      ...base.wheel,
      segments: base.wheel.segments.map((s) =>
        s.id === "pack" ? { ...s, prize: { kind: "pack", pack: "ghost" } } : s,
      ),
    };
    expect(issuesOf({ ...base, wheel: badPack })).toContain(
      "there is no pack ghost",
    );
  });

  it("rejects duplicate segment ids, a mismatched pack name, a missing duplicate payout and a repeated item", () => {
    const base = vaultConfig();
    const dupSeg = {
      ...base.wheel,
      segments: [
        ...base.wheel.segments.slice(0, 5),
        { ...base.wheel.segments[0] },
      ],
    };
    expect(issuesOf({ ...base, wheel: dupSeg })).toContain(
      "the segment id c50 is used twice",
    );
    expect(
      issuesOf({
        ...base,
        packs: {
          ...base.packs,
          recruit: { ...base.packs.recruit, name: "other" },
        },
      }),
    ).toContain("the key and the pack name differ");
    const partial: Record<string, number> = { ...base.dupeCredits };
    delete partial.legendary;
    expect(issuesOf({ ...base, dupeCredits: partial })).toMatch(
      /dupeCredits|legendary/,
    );
    const twice = [...base.wheel.pool, base.wheel.pool[0]];
    expect(
      issuesOf({ ...base, wheel: { ...base.wheel, pool: twice } }),
    ).toContain("is in the pool twice");
  });

  it("rejects a malformed config", () => {
    const base = vaultConfig();
    expect(issuesOf({ ...base, extra: true })).toMatch(/vault/);
    expect(
      issuesOf({ ...base, wheel: { ...base.wheel, spinPrice: 0 } }),
    ).toMatch(/spinPrice/);
    expect(
      issuesOf({
        ...base,
        wheel: { ...base.wheel, segments: base.wheel.segments.slice(0, 3) },
      }),
    ).toMatch(/segments/);
  });
});
