import {
  VaultPackSourceSchema,
  VaultSourceSchema,
} from "@openfront/shared/VaultSchemas";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// docs/Vault.md: Credits are earned by playing and never sold for money, so the
// Vault must not be payable with anything else.
describe("the Vault is Credits only", () => {
  it("has no price but Credits, in the pack and wheel config", () => {
    const pack = {
      name: "p",
      displayName: "P",
      priceSoft: 100,
      rarity: "common",
      slots: [{ common: 1 }],
      pool: [{ type: "flag", name: "x" }],
    };
    const base = VaultPackSourceSchema.safeParse(pack);
    expect(base.success, JSON.stringify(base.error?.issues)).toBe(true);
    for (const field of ["priceHard", "priceUsd", "product", "price"]) {
      expect(
        VaultPackSourceSchema.safeParse({ ...pack, [field]: 5 }).success,
        field,
      ).toBe(false);
    }
    const wheel = VaultSourceSchema.shape.wheel.shape;
    expect(Object.keys(wheel).filter((k) => /price/i.test(k))).toEqual([
      "spinPrice",
    ]);
  });

  it("is not reachable from the store's purchase routes", () => {
    const store = readFileSync("src/account-api/routes/vault.ts", "utf8");
    expect(store).not.toMatch(/priceHard|stripe|checkout|hard\b/i);
  });
});
