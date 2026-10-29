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

## The page

`src/client/VaultModal.ts` holds the account's state, the draws and the reveal
that follows them; the rest is components in `src/client/vault/`:

- **The hero** (a pixel sky with a sunburst, stars and a glow that follows the
  pointer): the wheel (`VaultWheel`: an icon on every
  segment, a chasing rim of lights, sparks off the pointer at every peg, a lean
  towards the cursor), the daily spin (a bar of blocks that fills as the day passes, a
  `hh:mm:ss` countdown, a gold claim button while it is ready), the spin button
  and `VaultWheelOdds`: a bar and legend of the chances by kind, with the full
  table folded under "Show odds". Pointing at a bar, a chip or a row dims the
  rest of the wheel so the segments it is about stand out.
- **The packs** (`VaultPacks`): foil packs (`VaultPackArt`, also the sealed pack
  of the reveal) that float, lean towards the pointer and shine; the price; the
  bad-luck guarantee as a meter filling towards the pack that is sure to hold a
  better card; each card's chances shown over the pack under "Show odds".
- **The collection** (`VaultCollection`): the rare-and-better pieces as cards,
  filterable by state and rarity, locked until won, with where each is found.
- **The balance** in the header (`VaultCount`) counts to its new value and shows
  the change ("+250") floating beside it; it is held back while a prize is being
  revealed so it does not give the result away.

## The pixel look

The page is pixel art, in the game's own pixel face (Pixelify Sans, the nav's):

- **Frames** are a border of whole pixels (`--u`, 4px; 3px on a phone) with the
  corner pixel left out (`pixelBorder` in `VaultPixel.ts`, a `border-image`),
  so shadows, filters and transforms still work. Buttons have a light top, a
  dark bottom and a hard shadow they sink into when pressed. Shades are flat
  bands with a checker dither; no soft blurs or glows.
- **The wheel** (`VaultWheel`) is not drawn by the browser: every pixel of a
  small grid (two screen pixels to one; one on a phone) is worked out, with an
  ordered dither for the shading, a pixel-art rim of chasing bulbs, and each
  segment's icon (`VaultSprites.ts`) and label looked up from a small bitmap as
  the wheel turns. The sky behind the hero (`VaultSky`) is made the same way:
  drifting dithered glows, a sunburst of rays behind the wheel, twinkling pixel
  stars and a glow under the pointer, at about twelve frames a second.
- **Icons** are pixel sprites (rows of characters, one per pixel), drawn as
  crisp SVG for the page and, rotated, into the wheel.
- **Motion** is in steps (`steps()`), and sparks and rings are squares on a
  four-pixel grid. Every loop starts and ends where nothing shows (off the card,
  at zero opacity, a full turn) so none pauses or jumps. Reduced motion turns it
  all off: the wheel jumps to its result, nothing floats or sweeps, the sky is
  drawn once, and everything is shown at once. The sounds are square waves.

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
