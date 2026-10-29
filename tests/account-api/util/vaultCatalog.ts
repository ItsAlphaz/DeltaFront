import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CATALOG_DIR } from "../../../src/account-api/catalog/load";

/** The rarities the test Vault's crowns come in. */
export const TEST_RARITIES = [
  "common",
  "uncommon",
  "rare",
  "epic",
  "legendary",
] as const;

const SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8" fill="#000"/></svg>';

/** The test Vault: crowns `vc_<rarity>_<n>`, none for sale, and what the wheel and packs give. */
export function vaultConfig(over: Record<string, unknown> = {}) {
  const pool = TEST_RARITIES.flatMap((rarity) =>
    [1, 2].map((n) => ({ type: "crown", name: `vc_${rarity}_${n}` })),
  );
  return {
    wheel: {
      spinPrice: 150,
      pool,
      segments: [
        {
          id: "c50",
          label: "50",
          weight: 40,
          prize: { kind: "credits", amount: 50 },
        },
        {
          id: "c100",
          label: "100",
          weight: 25,
          prize: { kind: "credits", amount: 100 },
        },
        {
          id: "c500",
          label: "500",
          weight: 5,
          prize: { kind: "credits", amount: 500 },
        },
        {
          id: "rare",
          label: "Rare",
          weight: 10,
          prize: { kind: "item", rarity: "rare" },
        },
        {
          id: "epic",
          label: "Epic",
          weight: 3,
          prize: { kind: "item", rarity: "epic" },
        },
        {
          id: "pack",
          label: "Pack",
          weight: 7,
          prize: { kind: "pack", pack: "recruit" },
        },
      ],
    },
    packs: {
      recruit: {
        name: "recruit",
        displayName: "Recruit Pack",
        priceSoft: 100,
        rarity: "common",
        slots: [
          { common: 70, uncommon: 30 },
          { common: 60, uncommon: 35, rare: 5 },
          { common: 50, uncommon: 30, rare: 15, epic: 5 },
        ],
        pity: { rareAfter: 4, epicAfter: 8 },
        pool,
      },
      warlord: {
        name: "warlord",
        displayName: "Warlord Pack",
        priceSoft: 1500,
        rarity: "legendary",
        slots: [
          { rare: 100 },
          { rare: 70, epic: 30 },
          { epic: 70, legendary: 30 },
        ],
        pool,
      },
    },
    dupeCredits: {
      common: 10,
      uncommon: 25,
      rare: 60,
      epic: 150,
      legendary: 400,
    },
    limits: { paidSpinsPerDay: 20, packsPerDay: 10 },
    ...over,
  };
}

/** A catalog directory: the public sample plus the Vault crowns and `vault` (the config, editable). */
export function catalogWithVault(
  dirs: string[],
  vault: unknown = vaultConfig(),
): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "df-vault-"));
  dirs.push(dir);
  fs.cpSync(path.join(CATALOG_DIR, "assets"), path.join(dir, "assets"), {
    recursive: true,
  });
  fs.writeFileSync(path.join(dir, "assets", "vault_crown.svg"), SVG);
  const json = JSON.parse(
    fs.readFileSync(path.join(CATALOG_DIR, "cosmetics.json"), "utf8"),
  );
  json.crowns ??= {};
  for (const rarity of TEST_RARITIES) {
    for (const n of [1, 2]) {
      const name = `vc_${rarity}_${n}`;
      json.crowns[name] = {
        name,
        url: "vault_crown.svg",
        product: null,
        rarity,
      };
    }
  }
  json.vault = vault;
  fs.writeFileSync(path.join(dir, "cosmetics.json"), JSON.stringify(json));
  return dir;
}
