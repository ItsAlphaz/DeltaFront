import type { VaultView } from "@openfront/shared/VaultSchemas";

/** A Vault as the API shows it: a five-segment wheel and two packs, with rare-and-better items to chase. */
export function vaultView(overrides: Partial<VaultView> = {}): VaultView {
  return {
    wheel: {
      spinPrice: 150,
      segments: [
        {
          id: "c50",
          label: "50",
          prize: { kind: "credits", amount: 50 },
          percent: 50,
        },
        {
          id: "rare",
          label: "RARE",
          prize: { kind: "item", rarity: "rare" },
          percent: 20,
        },
        {
          id: "epic",
          label: "EPIC",
          prize: { kind: "item", rarity: "epic" },
          percent: 10,
        },
        {
          id: "free",
          label: "FREE PACK",
          prize: { kind: "pack", pack: "recruit" },
          percent: 5,
        },
        {
          id: "jackpot",
          label: "JACKPOT",
          prize: { kind: "credits", amount: 2000 },
          percent: 15,
        },
      ],
      items: [
        { type: "crown", name: "kraken_crown", rarity: "epic" },
        { type: "flag", name: "tide_line", rarity: "common" },
      ],
    },
    packs: [
      {
        name: "recruit",
        displayName: "Recruit Pack",
        tagline: "Three cards.",
        priceSoft: 120,
        rarity: "uncommon",
        inSeason: true,
        pity: { rareAfter: 6 },
        slots: [{ common: 70, uncommon: 30 }, { rare: 100 }],
        items: [
          { type: "crown", name: "kraken_crown", rarity: "epic" },
          { type: "flag", name: "tide_line", rarity: "common" },
          { type: "flag", name: "orchard", rarity: "uncommon" },
        ],
      },
      {
        name: "officer",
        displayName: "Officer Pack",
        priceSoft: 450,
        rarity: "epic",
        inSeason: true,
        pity: { epicAfter: 8 },
        slots: [{ rare: 80, epic: 20 }],
        items: [
          { type: "flag", name: "wyrm_banner", rarity: "legendary" },
          { type: "crown", name: "kraken_crown", rarity: "epic" },
          {
            type: "pattern",
            name: "paisley_drift",
            colorPalette: "vault_indigo_saffron",
            rarity: "rare",
          },
        ],
      },
    ],
    dupeCredits: { common: 10, legendary: 450 },
    limits: { paidSpinsPerDay: 100, packsPerDay: 50 },
    state: {
      pity: {},
      today: { packs: 0, spins: 0 },
      daily: {
        available: true,
        nextAt: new Date(Date.now() + 1e6).toISOString(),
      },
      balance: 5000,
    },
    ...overrides,
  };
}

/** The same Vault for an account with the given counters. */
export function withState(
  state: Partial<NonNullable<VaultView["state"]>>,
): VaultView {
  const base = vaultView();
  return {
    ...base,
    state: { ...base.state!, ...state },
  };
}
