# The private store catalog

DeltaFront's code is public. Its **production store** (the full catalog of
patterns, flags, crowns and effects, their prices and their artwork) is not: it
lives in a separate **private repository** and is loaded by the account API at
runtime from a directory on the server. This is the same shape OpenFront uses
(an open game, a closed catalog behind its API).

What this protects, and what it cannot:

- It stops anyone getting the whole catalog, its prices, unreleased items, the
  generator and unused variants with one `git clone`.
- It cannot stop someone saving an image their browser shows them. Anything a
  player sees has been sent to their browser; this is not DRM. Your protection
  for that is the licence, the terms of service and takedown notices.

## What is where

| Public repository (this one)                                                                                                                   | Private repository (`DeltaFront-Private-Store`)                                 |
| ---------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| the store, inventory and equip code                                                                                                            | `catalog/cosmetics.json`: palettes, patterns, flags, crowns, free items, prices |
| the catalog loader, schemas and checks (`src/account-api/catalog/`)                                                                            | `catalog/effects.json`: every effect                                            |
| a small **sample catalog** (`src/account-api/catalog/cosmetics.json`, `assets/`): the original eight items, one crown, one effect of each type | `assets/`: the production images (one flat folder)                              |
| `npm run catalog:check`, the validator the private repo uses                                                                                   | the generator that draws and tunes the items, the checksums, the licence        |
| tests (against the sample and against a stand-in private catalog)                                                                              | sources, unused variants, unreleased items                                      |

The sample is only there so a contributor can run the store, the inventory and
the tests. It is licensed CC BY-SA 4.0 like the rest of the public artwork. The
production catalog is **All Rights Reserved** (the private repository's
`LICENSE`).

## Environment variables (account API and admin CLI)

| Variable               | Meaning                                                                                                                            |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `DF_CATALOG_DIR`       | Absolute path of the directory holding `cosmetics.json` (and optionally `effects.json`, `bundles.json`). Unset: the public sample. |
| `DF_CATALOG_ASSET_DIR` | Absolute path of the images folder. Unset: `<DF_CATALOG_DIR>/assets`. Needs `DF_CATALOG_DIR`.                                      |

Both go in `/etc/deltafront/api.env` (the admin CLI runs with that file loaded,
so it checks items against the same catalog; see Deployment.md §14). Nothing is
hard-coded: `/opt/deltafront-private/store/catalog` is only the example below.

## How the catalog is loaded

At startup the API (and every admin item command) resolves the location, reads
the files and validates them with the same rules as the sample:

1. **Nothing configured** → the public sample. A deployment outside dev logs a
   warning, and `npm run launch:check` shows it as a warning, because a public
   site selling the sample would drop what players own.
2. **Configured** → that catalog and only that one. It **replaces** the sample
   completely; the two are never merged.
3. **Configured but missing or broken → the API refuses to start** (and the
   admin tools exit 1). It never falls back to the sample: players' owned items
   that the sample does not know would vanish from `/users/@me`, and the game
   server would reject their equipped cosmetics at join.
4. `effects.json`, if present, is merged into the effects of `cosmetics.json`;
   an effect defined in both files, a duplicate key, an unknown top-level key,
   or invalid JSON is an error. The catalog `version` (recorded on purchases)
   covers every file.
5. `bundles.json`, if present (`{ "packs": { "<name>": { ... } } }`), adds the
   store's **Bundles**: themed sets sold together for one Credits price (see
   below). `cosmetics.json` may carry a `packs` section instead; a bundle in both
   files, a duplicate key or a bad bundle is an error, and the API will not start.

## Bundles

A bundle is `name` (the key), `displayName` (up to 40 characters), `description`,
an optional one-line `tagline`, `priceSoft` (a positive whole number of Credits),
a `rarity` (`common` to `legendary`, which colours its card) and `items`: 2 to 12
of `{ "type": "pattern" | "flag" | "crown" | "effect", "name": "...", "colorPalette": "..." }`
(`colorPalette` is required for a pattern that has palettes, forbidden otherwise).

The loader refuses a bundle when an item does not exist or is not sold for Credits
(no price: level rewards and admin grants cannot be bought), a pattern names a
palette it does not have or has archived, an item is in the bundle twice, an item
is a free default (no account could ever buy it), or the bundle costs more than
its items do separately. The card shows the saving.

`POST /shop/purchase/pack` buys one in a single transaction (the price is debited
once, every item granted, one `pack` purchase row and one ledger row). It answers
409 with the items already held when an account owns any of them, so a bundle is
only for an account that holds none of its items.

Everything else the sample is held to applies: no premium price, no Stripe
product, valid flares, effects the client can render, patterns the game can
decode. Files the loader does not know (`unreleased.json`, backups) are ignored.

## How private images are served

`GET /cosmetics/assets/<file>` answers only for files **the catalog names**:

- The loader reads the `url` of every flag, crown and effect, keeps only bare
  lowercase file names (`^[a-z0-9_]{1,48}\.(svg|png|webp)$`: no slash, no dot
  segments, no encoded path), and reads each from the asset folder. The route
  looks a name up in that in-memory map; no path is ever built from a request.
- A file that is a symlink, a directory, larger than 256 KB, or that resolves
  outside the asset folder is refused at startup.
- Anything else in the asset folder (a PSD, `unused_variant.svg`, notes, a
  sub-folder, hidden files) is never read and answers 404. There is no
  directory listing.
- Responses carry a content-hash `?v=`, `nosniff`, a `sandbox` CSP and no
  credentials.

The asset folder is **flat** on purpose: the catalog refers to images by a bare
file name, which is what makes the traversal rule simple to enforce. Keep source
files somewhere else in the private repository.

## Working on the private repository

It is self-contained (TypeScript, no dependencies but `tsx`):

```sh
cd DeltaFront-Private-Store
npm install
npm run generate # rewrites catalog/, assets/, manifests/
npm run verify   # sha256sum -c manifests/checksums.sha256
cd ../DeltaFront
npm run catalog:check -- ../DeltaFront-Private-Store/catalog ../DeltaFront-Private-Store/assets
```

`catalog:check` is the loader the API runs at startup, so a catalog that passes
it boots. The original eight items never change: level rewards point at some.

## On the server

```
/opt/deltafront/current                 the public release (what `update` deploys)
/opt/deltafront-private/store           the private repository (checkout or copied files)
    catalog/  assets/  manifests/
```

```
# /etc/deltafront/api.env
DF_CATALOG_DIR=/opt/deltafront-private/store/catalog
DF_CATALOG_ASSET_DIR=/opt/deltafront-private/store/assets
```

The folder must be readable by the `df-api` user and not writable by it:

```sh
install -d -o root -g df-api -m 0750 /opt/deltafront-private
```

**The public `update` never needs a credential for the private repository**: it
deploys public code, expects the private folder to exist, and restarts the
services. Update the store separately, either by copying it (rsync/scp of the
three folders from your machine, then `sha256sum -c manifests/checksums.sha256`),
or with a checkout that uses a **read-only deploy key for that one repository**,
kept on the server (`/root/.ssh` or a dedicated user), never in this repository,
an env file in git, shell history or the updater:

```sh
git -C /opt/deltafront-private/store pull --ff-only
(cd /opt/deltafront-private/store && sha256sum -c manifests/checksums.sha256)
sudo -u df-api sh -c 'set -a; . /etc/deltafront/api.env; cd /opt/deltafront/current; npm run catalog:check -- "$DF_CATALOG_DIR" "$DF_CATALOG_ASSET_DIR"'
systemctl restart deltafront-account-api
```

Check before restarting: a bad catalog stops the API from starting, so the
`catalog:check` line is what keeps a typo from becoming an outage. A catalog
change needs only the API restarted, not the game server (it reads the catalog
from the API over HTTP).

## The Vault's content

The Vault (`docs/Vault.md`) is configured and drawn in this repository too: `generator/vault.ts` holds the wheel, packs, pools, odds and limits, and `vault-crowns.ts`, `vault-flags.ts`, `vault-patterns.ts` the Vault-only art. The generator asserts the economy before it writes the catalog.

## Admin item tools

`npm run admin -- item:grant|item:revoke|item:list` validate against the catalog
in the command's environment, i.e. the private one when `api.env` is loaded as in
Deployment.md §14. `flag:admin_contributors` works if it is in the private
catalog; a flare not in it, a wildcard or a malformed flare is refused. A
catalog that is configured but unreadable is an error, not the sample.

## Staff and admin skins

Six patterns in the private catalog have no price and belong to a role instead
(`packages/shared/src/RoleSkins.ts` names them): `staff_tag` and `staff_diagonal`
for everyone on staff (mod, admin, owner), and `admin_tag`, `admin_diagonal`,
`admin_crest` and `admin_shield` for admins and the owner. Each has one colour
palette with the same name, so its flare is `pattern:<name>:<name>`.

Nothing is stored. `/users/@me` adds the flares of the account's current
`users.role` on top of what it owns, so a promotion shows the skins in the
inventory on the next profile fetch, and `user:role ... none` (or any demotion)
takes them away again, with no row to clean up. A worn skin that is no longer
owned is dropped from the next join by the client. A catalog without these
patterns grants nothing. They are drawn in `generator/role-skins.ts` in the
private repository.

## Licensing

- Code: AGPL-3.0 (the loader, the store UI, the tests).
- Public sample items (the original eight, `sample_crown`, the sample effects):
  CC BY-SA 4.0, listed in `CREDITS.md`.
- Upstream OpenFront-derived assets under `resources/`: unchanged, CC BY-SA 4.0
  (`LICENSE-ASSETS`).
- The production catalog and its art: **All Rights Reserved**, in the private
  repository only. That licence cannot be retroactively applied to anything
  already published (the original eight stay CC BY-SA in the public repository).
  Note that machine-generated artwork may have weaker copyright protection than
  hand-made art in some jurisdictions; the generator, the selection and the
  prices are yours regardless. Ask a lawyer if the exact position matters.

## Before you push the public repository

```sh
node ../DeltaFront-Private-Store/scripts/audit-public-repo.mjs . main origin/main
```

It checks every production file byte for byte against everything reachable from
those refs, and looks for production item names in the tree. It must print
`clean`. `tests/account-api/publicRepoGuard.test.ts` also fails if a production-
sized catalog, an extra image or a design source is tracked.
