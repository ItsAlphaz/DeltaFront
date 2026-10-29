import {
  VAULT_RARITIES,
  rarityRank,
  type RarityWeights,
  type VaultItemRef,
  type VaultPackSource,
  type VaultRarity,
  type VaultSource,
} from "@openfront/shared/VaultSchemas";
import { randomInt } from "node:crypto";

/**
 * The Vault's randomness and rules, with no database in it: given the config,
 * the account's bad-luck counters and a source of random numbers, what is
 * drawn. The transaction around it is domain/vault.ts.
 */

/** A random whole number in [0, max). Secure randomness; tests pass their own. */
export type Rng = (max: number) => number;
export const secureRng: Rng = (max) => randomInt(max);

/** A catalog item the Vault can give, with what the catalog says about it. */
export interface DrawItem {
  ref: VaultItemRef;
  flare: string;
  rarity: VaultRarity;
}

export type ItemsByRarity = Readonly<Record<VaultRarity, readonly DrawItem[]>>;

export interface ResolvedPack {
  source: VaultPackSource;
  items: ItemsByRarity;
}

export interface ResolvedVault {
  source: VaultSource;
  packs: ReadonlyMap<string, ResolvedPack>;
  /** The wheel's item prizes come from here. */
  wheelItems: ItemsByRarity;
}

export interface Pity {
  sinceRare: number;
  sinceEpic: number;
}

const RARE = rarityRank("rare");
const EPIC = rarityRank("epic");

/** An index into `weights`, chosen with probability proportional to each weight. */
export function pickWeightedIndex(
  weights: readonly number[],
  rng: Rng,
): number {
  const total = weights.reduce((sum, w) => sum + w, 0);
  if (!(total > 0)) throw new Error("no weight to draw from");
  let roll = rng(total);
  for (let i = 0; i < weights.length; i++) {
    if (roll < weights[i]) return i;
    roll -= weights[i];
  }
  return weights.length - 1;
}

/**
 * A rarity for one card. `minRank` (a bad-luck guarantee) rules out anything
 * below it; if the slot's chances leave nothing at or above it, the card is
 * of the lowest rarity the pool has at or above it.
 */
export function drawRarity(
  weights: RarityWeights,
  items: ItemsByRarity,
  minRank: number,
  rng: Rng,
): VaultRarity {
  const usable = VAULT_RARITIES.filter(
    (r) =>
      rarityRank(r) >= minRank && (weights[r] ?? 0) > 0 && items[r].length > 0,
  );
  if (usable.length > 0) {
    return usable[
      pickWeightedIndex(
        usable.map((r) => weights[r] ?? 0),
        rng,
      )
    ];
  }
  const fallback = VAULT_RARITIES.find(
    (r) => rarityRank(r) >= minRank && items[r].length > 0,
  );
  if (fallback !== undefined) return fallback;
  // Nothing at or above the guarantee exists: whatever the slot normally gives.
  const any = VAULT_RARITIES.filter(
    (r) => (weights[r] ?? 0) > 0 && items[r].length > 0,
  );
  if (any.length === 0) throw new Error("a slot with nothing to draw");
  return any[
    pickWeightedIndex(
      any.map((r) => weights[r] ?? 0),
      rng,
    )
  ];
}

export function pickItem(
  items: ItemsByRarity,
  rarity: VaultRarity,
  rng: Rng,
): DrawItem {
  const pool = items[rarity];
  return pool[rng(pool.length)];
}

/** The guarantee this account's counters put on the pack's last card. */
export function pityMinRank(pack: VaultPackSource, pity: Pity): number {
  let min = 0;
  if (
    pack.pity.rareAfter !== undefined &&
    pity.sinceRare >= pack.pity.rareAfter - 1
  ) {
    min = RARE;
  }
  if (
    pack.pity.epicAfter !== undefined &&
    pity.sinceEpic >= pack.pity.epicAfter - 1
  ) {
    min = EPIC;
  }
  return min;
}

/** The counters after a pack whose best card was `best`. */
export function nextPity(pity: Pity, best: VaultRarity): Pity {
  const rank = rarityRank(best);
  return {
    sinceRare: rank >= RARE ? 0 : pity.sinceRare + 1,
    sinceEpic: rank >= EPIC ? 0 : pity.sinceEpic + 1,
  };
}

/** The cards of one pack, and the counters after it. The guarantee rides on the last card. */
export function drawPack(
  pack: ResolvedPack,
  pity: Pity,
  rng: Rng,
): { cards: DrawItem[]; pity: Pity } {
  const slots = pack.source.slots;
  const guarantee = pityMinRank(pack.source, pity);
  const cards = slots.map((weights, index) => {
    const min = index === slots.length - 1 ? guarantee : 0;
    const rarity = drawRarity(weights, pack.items, min, rng);
    return pickItem(pack.items, rarity, rng);
  });
  let best: VaultRarity = "common";
  for (const card of cards) {
    if (rarityRank(card.rarity) > rarityRank(best)) best = card.rarity;
  }
  return { cards, pity: nextPity(pity, best) };
}

/** The wheel's winning segment. */
export function spinWheel(vault: ResolvedVault, rng: Rng): number {
  return pickWeightedIndex(
    vault.source.wheel.segments.map((s) => s.weight),
    rng,
  );
}

/** The next UTC midnight after `now`: when the daily spin comes back. */
export function nextUtcMidnight(now: Date): Date {
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1),
  );
}

/** The UTC day of `now`, as YYYY-MM-DD. */
export function utcDay(now: Date): string {
  return now.toISOString().slice(0, 10);
}
