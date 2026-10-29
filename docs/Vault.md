# The Vault

A page of its own (nav item "Vault", `src/client/VaultModal.ts`) with a spin
wheel, a free daily spin and packs. It hands out cosmetics that are **not for
sale in the shop**, so the best-looking gear has to be won.

## The one rule: Credits only

Spins and packs are paid for with **Credits** (`wallets.soft`), which are earned
by playing (100 per game, +250 for a win, 1,000 a day from play). Credits are
never sold for money, and the Vault must not change that: no price in the Vault
is in plutonium or real currency, there is no Vault product in the store, and a
duplicate pays back Credits, never anything purchasable. If a change would let
real money turn into Vault draws, it is the wrong change.

## What the player sees

- **The wheel**: 12 segments (Credits, an item of a rarity, a free pack, a
  jackpot). A spin costs 150 Credits. The wheel's odds are listed next to it.
- **The daily spin**: free, once per UTC day, for a signed-in account. The button
  shows a `hh:mm:ss` countdown to the next UTC midnight; the nav item shows a
  dot while it is waiting.
- **Packs** (Recruit 120, Officer 450, Warlord 1,600): three or four cards each.
  Each pack has a "bad luck" guarantee: a rare or better card within N packs
  (Recruit 6), an epic or better within N (Officer 8, Warlord 4). "Show odds"
  lists each card's rarity chances per slot.
- **The Vault collection**: every rare-and-better piece the Vault gives out, and
  which of them the player owns.
- Duplicates pay Credits by rarity (`dupeCredits`: 10 / 25 / 70 / 180 / 450),
  always less than the pack or spin that gave them.

The animations (`src/client/vault/`) are canvas 2D and synthesised Web Audio, no
asset files. They follow reduced-motion (no particles, no turning wheel; the
result is shown at once) and the sound-effects volume setting.

## How it is built

The server decides everything. The client sends "spin", "daily" or "open pack
X" and a request id; it never sends a price, a card or a chance.

- `src/account-api/domain/vaultDraw.ts`: pure draw logic (weights, pity, the
  wheel, `secureRng`). Tested in `tests/VaultDraw.test.ts`.
- `src/account-api/domain/vault.ts`: one locked transaction per draw: wallet row
  locked, request id looked up (a retry answers with the stored result and
  charges nothing), checks, debit, draw, grants, ledger rows.
- `src/account-api/routes/vault.ts`: `GET /vault` (public: catalog view and, when
  signed in, the account's pity, today's counters, balance and daily state),
  `POST /vault/spin`, `/vault/daily`, `/vault/packs/:name/open`. Rate-limited
  (`vaultWrite`).
- `migrations/0012_vault.sql`: draws, pity, and `source = 'vault'` on
  `user_flares`.
- Limits per account per day (`vault.limits` in the catalog): 40 paid spins, 40
  packs.
- Items won are ordinary flares, so the inventory, the locker and the in-game
  cosmetics work with them unchanged. The Vault-only pieces have no `product` in the
  catalog, so the shop cannot sell them.

## Content and tuning

The Vault's config (the wheel, packs, item pools, odds, limits, dupe values) and
its art live in the private catalog repository (`generator/vault*.ts`, see
`docs/PrivateStore.md`). The loader (`catalog/load.ts`) validates it when the API
starts or the catalog is reloaded, and the generator asserts the economy: a
duplicate or a prize never returns more Credits than the draw cost.

To change a price, a chance or a pool: edit the private generator, regenerate,
install the catalog on the server (`deploy-to-server.sh --apply`) and restart the
API. A pack can be given a season (`startsAt`/`endsAt`); outside it the pack is
shown as unavailable and refuses draws.
