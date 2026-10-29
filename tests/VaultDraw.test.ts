import {
  VAULT_RARITIES,
  type VaultRarity,
} from "@openfront/shared/VaultSchemas";
import { describe, expect, it } from "vitest";
import {
  drawPack,
  drawRarity,
  nextPity,
  nextUtcMidnight,
  pickWeightedIndex,
  pityMinRank,
  utcDay,
  type DrawItem,
  type ItemsByRarity,
  type ResolvedPack,
  type Rng,
} from "../src/account-api/domain/vaultDraw";

const item = (rarity: VaultRarity, n: number): DrawItem => ({
  ref: { type: "crown", name: `${rarity}_${n}` },
  flare: `crown:${rarity}_${n}`,
  rarity,
});
const items: ItemsByRarity = Object.fromEntries(
  VAULT_RARITIES.map((r) => [r, [item(r, 1), item(r, 2)]]),
) as unknown as ItemsByRarity;

/** A random source that returns the given values in turn (each clamped into range). */
const script =
  (...values: number[]): Rng =>
  (max) =>
    Math.min(max - 1, values.shift() ?? 0);

const pack = (over: Partial<ResolvedPack["source"]> = {}): ResolvedPack => ({
  items,
  source: {
    name: "p",
    displayName: "P",
    priceSoft: 100,
    rarity: "common",
    slots: [{ common: 1 }, { common: 1 }, { common: 90, rare: 10 }],
    pity: { rareAfter: 3, epicAfter: 5 },
    pool: [],
    ...over,
  } as ResolvedPack["source"],
});

describe("the Vault's draws", () => {
  it("picks an index in proportion to the weights", () => {
    expect(pickWeightedIndex([1, 1, 1], script(0))).toBe(0);
    expect(pickWeightedIndex([1, 1, 1], script(1))).toBe(1);
    expect(pickWeightedIndex([1, 1, 1], script(2))).toBe(2);
    expect(pickWeightedIndex([5, 0, 5], script(5))).toBe(2);
    expect(() => pickWeightedIndex([0, 0], script(0))).toThrow();
  });

  it("really follows the weights over many draws", () => {
    // a deterministic, evenly spread source: 0, 1, 2 ... through the total
    let n = 0;
    const even: Rng = (max) => n++ % max;
    const counts = [0, 0];
    for (let i = 0; i < 1000; i++) counts[pickWeightedIndex([1, 3], even)]++;
    expect(counts[1]).toBe(750);
  });

  it("rules out rarities below a guarantee, and falls back to the lowest above it", () => {
    const rare = VAULT_RARITIES.indexOf("rare");
    expect(drawRarity({ common: 99, rare: 1 }, items, rare, script(0))).toBe(
      "rare",
    );
    // nothing at or above rare in the slot's chances: the lowest rarity that is
    expect(drawRarity({ common: 1 }, items, rare, script(0))).toBe("rare");
    // no guarantee: the slot's own chances
    expect(drawRarity({ common: 1 }, items, 0, script(0))).toBe("common");
  });

  it("only draws a rarity the pool has items for", () => {
    const noEpic = { ...items, epic: [] } as unknown as ItemsByRarity;
    for (let roll = 0; roll < 10; roll++) {
      expect(drawRarity({ common: 5, epic: 5 }, noEpic, 0, script(roll))).toBe(
        "common",
      );
    }
  });

  it("guarantees a rare after enough packs without one, on the last card only", () => {
    const p = pack();
    expect(pityMinRank(p.source, { sinceRare: 1, sinceEpic: 1 })).toBe(0);
    expect(pityMinRank(p.source, { sinceRare: 2, sinceEpic: 2 })).toBe(
      VAULT_RARITIES.indexOf("rare"),
    );
    expect(pityMinRank(p.source, { sinceRare: 2, sinceEpic: 4 })).toBe(
      VAULT_RARITIES.indexOf("epic"),
    );
    const { cards, pity } = drawPack(
      p,
      { sinceRare: 2, sinceEpic: 2 },
      script(0),
    );
    expect(cards.map((c) => c.rarity)).toEqual(["common", "common", "rare"]);
    expect(pity).toEqual({ sinceRare: 0, sinceEpic: 3 });
  });

  it("counts packs without a rare or an epic", () => {
    expect(nextPity({ sinceRare: 1, sinceEpic: 4 }, "uncommon")).toEqual({
      sinceRare: 2,
      sinceEpic: 5,
    });
    expect(nextPity({ sinceRare: 1, sinceEpic: 4 }, "rare")).toEqual({
      sinceRare: 0,
      sinceEpic: 5,
    });
    expect(nextPity({ sinceRare: 1, sinceEpic: 4 }, "legendary")).toEqual({
      sinceRare: 0,
      sinceEpic: 0,
    });
  });

  it("names the UTC day and when the next one starts", () => {
    const now = new Date("2026-10-29T23:59:59.500Z");
    expect(utcDay(now)).toBe("2026-10-29");
    expect(nextUtcMidnight(now).toISOString()).toBe("2026-10-30T00:00:00.000Z");
    expect(
      nextUtcMidnight(new Date("2026-12-31T12:00:00Z")).toISOString(),
    ).toBe("2027-01-01T00:00:00.000Z");
  });
});
