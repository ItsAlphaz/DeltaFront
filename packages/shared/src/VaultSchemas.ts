import { z } from "zod/v4";

/**
 * The Vault: a spin wheel and packs of cosmetics paid for with Credits (the
 * only currency, earned by playing; see docs/Vault.md). This file holds what
 * the catalog says about it, which the account API validates at startup and
 * the client shows (odds included), and what the API answers.
 *
 * Nothing here is a price or an outcome a browser can choose: the server reads
 * the config, draws with secure randomness and writes the result.
 */

export const VAULT_RARITIES = [
  "common",
  "uncommon",
  "rare",
  "epic",
  "legendary",
] as const;
export type VaultRarity = (typeof VAULT_RARITIES)[number];

/** How good a rarity is, for "at least rare" rules. */
export const rarityRank = (rarity: VaultRarity): number =>
  VAULT_RARITIES.indexOf(rarity);

const Name = z.string().regex(/^[a-z0-9_]{1,32}$/);

/** A catalog item the Vault can hand out. */
export const VaultItemRefSchema = z.strictObject({
  type: z.enum(["pattern", "flag", "crown", "effect"]),
  name: Name,
  colorPalette: Name.optional(),
});
export type VaultItemRef = z.infer<typeof VaultItemRefSchema>;

/** Relative chances by rarity. Whole numbers; at least one above zero. */
export const RarityWeightsSchema = z
  .partialRecord(z.enum(VAULT_RARITIES), z.number().int().min(0).max(1_000_000))
  .refine((w) => Object.values(w).some((v) => (v ?? 0) > 0), {
    message: "needs at least one weight above zero",
  });
export type RarityWeights = z.infer<typeof RarityWeightsSchema>;

export const VaultPackSourceSchema = z.strictObject({
  name: Name,
  displayName: z.string().min(1).max(40),
  tagline: z.string().max(80).optional(),
  priceSoft: z.number().int().min(1),
  /** The colour the pack's art takes. */
  rarity: z.enum(VAULT_RARITIES),
  /** One entry per card in the pack: that card's chances by rarity. */
  slots: z.array(RarityWeightsSchema).min(1).max(8),
  /**
   * A bad-luck guarantee, counted per pack type: after this many packs in a
   * row whose best card was below rare (epic), the next pack's last card is
   * at least rare (epic).
   */
  pity: z
    .strictObject({
      rareAfter: z.number().int().min(2).max(200).optional(),
      epicAfter: z.number().int().min(2).max(500).optional(),
    })
    .default({}),
  /** What a card can be: a card of rarity R is one of the pool's items of rarity R. */
  pool: z.array(VaultItemRefSchema).min(1).max(200),
  startsAt: z.iso.datetime().optional(),
  endsAt: z.iso.datetime().optional(),
});
export type VaultPackSource = z.infer<typeof VaultPackSourceSchema>;

export const WheelPrizeSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("credits"),
    amount: z.number().int().min(1),
  }),
  /** One item of this rarity from the wheel's pool. */
  z.strictObject({ kind: z.literal("item"), rarity: z.enum(VAULT_RARITIES) }),
  /** A pack opened for free. */
  z.strictObject({ kind: z.literal("pack"), pack: Name }),
]);
export type WheelPrize = z.infer<typeof WheelPrizeSchema>;

export const WheelSegmentSchema = z.strictObject({
  id: Name,
  label: z.string().min(1).max(24),
  weight: z.number().int().min(1).max(1_000_000),
  prize: WheelPrizeSchema,
});
export type WheelSegment = z.infer<typeof WheelSegmentSchema>;

export const VaultWheelSourceSchema = z.strictObject({
  spinPrice: z.number().int().min(1),
  /** The wheel is drawn in this order; the chances are the weights, not the sizes. */
  segments: z.array(WheelSegmentSchema).min(6).max(16),
  pool: z.array(VaultItemRefSchema).min(1).max(200),
});

export const VaultSourceSchema = z.strictObject({
  wheel: VaultWheelSourceSchema,
  packs: z.record(Name, VaultPackSourceSchema),
  /** Credits paid for a card the account already owns, by rarity. */
  dupeCredits: z.record(z.enum(VAULT_RARITIES), z.number().int().min(0)),
  /** The most the account may buy per UTC day, so nobody spends a day away. */
  limits: z.strictObject({
    paidSpinsPerDay: z.number().int().min(1).max(500),
    packsPerDay: z.number().int().min(1).max(500),
  }),
});
export type VaultSource = z.infer<typeof VaultSourceSchema>;

// ---- what the API answers --------------------------------------------------

/** A card: one item the account was given, or already had. */
export const VaultCardSchema = z.object({
  type: z.enum(["pattern", "flag", "crown", "effect"]),
  name: Name,
  colorPalette: Name.optional(),
  rarity: z.enum(VAULT_RARITIES),
  /** The account owned it already: it paid `credits` Credits instead. */
  dupe: z.boolean(),
  credits: z.number().int().min(0),
});
export type VaultCard = z.infer<typeof VaultCardSchema>;

export const VaultPackResultSchema = z.object({
  pack: Name,
  cards: z.array(VaultCardSchema),
});
export type VaultPackResult = z.infer<typeof VaultPackResultSchema>;

export const VaultSpinResultSchema = z.object({
  segment: z.number().int().min(0),
  segmentId: Name,
  prize: WheelPrizeSchema,
  /** The item, when the prize was one. */
  card: VaultCardSchema.optional(),
  /** The pack that opened, when the prize was one. */
  pack: VaultPackResultSchema.optional(),
  /** Credits the spin paid out in all (a credits prize, and refunds for duplicates). */
  creditsWon: z.number().int().min(0),
  /** What the spin cost: 0 for the daily spin. */
  cost: z.number().int().min(0),
  daily: z.boolean(),
});
export type VaultSpinResult = z.infer<typeof VaultSpinResultSchema>;

/** The odds the page shows: every chance as a percentage of 100, to two places. */
export const percentOf = (weight: number, total: number): number =>
  total <= 0 ? 0 : Math.round((weight / total) * 10_000) / 100;
