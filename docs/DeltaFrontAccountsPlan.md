# DeltaFront Accounts Plan: accounts, store, inventory, leaderboards, clans

Status: **plan only**. Nothing here is implemented, enabled, created or deployed.

Audience: the DeltaFront owner (decisions, costs, rollout) and the engineer or agent who later implements it (sections 18–24 are the execution guide).

**The owner decisions in [section 0](#0-owner-decisions-authoritative) are final and override any other recommendation in this document.**

Everything in sections 1–4 was derived from the code in this repository (paths and line references are given). Where a statement is about OpenFront's closed backend and can only be inferred from client code or comments, it is marked **(inferred)**.

---

## Contents

0. [Owner decisions (authoritative)](#0-owner-decisions-authoritative)
1. [Existing architecture discovered](#1-existing-architecture-discovered)
2. [Feature inventory](#2-feature-inventory)
3. [OpenFront private API dependencies](#3-openfront-private-api-dependencies)
4. [Exact API contracts already present](#4-exact-api-contracts-already-present)
5. [Minimum DeltaFront backend architecture](#5-minimum-deltafront-backend-architecture)
6. [PostgreSQL schema](#6-postgresql-schema)
7. [Authentication plan](#7-authentication-plan)
8. [Profile and stats plan](#8-profile-and-stats-plan)
9. [Store plan](#9-store-plan)
10. [Inventory plan](#10-inventory-plan)
11. [Leaderboard plan](#11-leaderboard-plan)
12. [Clan plan](#12-clan-plan)
13. [Website and navigation plan](#13-website-and-navigation-plan)
14. [Security model](#14-security-model)
15. [Admin plan](#15-admin-plan)
16. [Hosting plan](#16-hosting-plan)
17. [Feature-flag rollout](#17-feature-flag-rollout)
18. [Migration strategy](#18-migration-strategy)
19. [Test matrix](#19-test-matrix)
20. [Implementation milestones](#20-implementation-milestones)
21. [Risks](#21-risks)
22. [Complexity estimates](#22-complexity-estimates)
23. [Acceptance criteria](#23-acceptance-criteria)
24. [Execution checklist](#24-execution-checklist)

---

## Summary

The client and game server already contain almost the complete OpenFront account product: sign-in UI, session handling, `/users/@me`, store, inventory, cosmetics ownership, profile pages, leaderboards, clans, clan tags, stats ingestion and production admission. All of it talks to one closed-source API at `api.<DOMAIN>`, and all of it is switched off by `ACCOUNT_FEATURES` (`packages/shared/src/AccountFeatures.ts`).

So the work is mostly **backend**: a DeltaFront-owned API that answers the same paths with the same shapes. We reuse OpenFront's open-source client architecture and API contracts, **not** its proprietary content (catalog, artwork, products, currency names).

The client needs only a handful of changes:

- **Finer feature flags.** Hide parts of the existing UI that V1 will not back: real-money payments and the premium currency, friends, XP and progression, custom tribe names, ranked, and Steam, CrazyGames and email sign-in.
- **A single "Credits" currency.** The existing `soft` currency slot carries Credits (section 9.2). Only the currency label and icon change.
- **Create a clan.** The existing clan UI has no "create clan" flow (OpenFront appears to create clans out of band), so this needs a new endpoint and a small form.
- **A basic player leaderboard.** The existing player leaderboard tabs are all ranked Elo ladders, so a non-ranked "players" tab needs one new endpoint. The display schema for it already exists.
- **Smaller items:** the trusted-lobby rotation, JWKS key rotation on the game server, and a small DeltaFront-owned placeholder catalog.

The owner decisions in [section 0](#0-owner-decisions-authoritative) are final:

- **Sign-in:** V1 is Guest + Discord + Google. No passwords. Magic links come later, without redesign.
- **Currency:** V1 uses one currency, **Credits**, earned server-side by playing.
- **Clans:** creation needs an account at least 3 days old with at least 10 completed games. A player can be in one clan at a time and own one.
- **Legal:** real Terms and Privacy pages are required before public launch.

Recommended hosting: **one VPS** running the game server, the account API and PostgreSQL behind Nginx, with off-site database backups (section 16).

---

## 0. Owner decisions (authoritative)

These decisions override any recommendation elsewhere in this document. Each one names the sections it changes.

### D1. One currency: Credits

- DeltaFront V1 has a single virtual currency, **Credits**. The OpenFront names "Caps" and "Plutonium" are not used anywhere in DeltaFront's economy.
- **Gameplay rewards:**
  - **+100 Credits** per completed game;
  - **+250 additional Credits** for a win;
  - at most **1,000 Credits per day** from gameplay (UTC day).
- **Values live in one constants module,** `src/account-api/domain/constants.ts` (`ECONOMY`), so rebalancing is a one-line change.
- **The backend alone calculates and awards Credits,** from server-submitted game records. No endpoint lets the browser change a balance.
- **Wire mapping:** Credits use the existing `soft` slot of the contract, and `hard` is always 0 (section 9.2).
- **Affected sections:** 6.2, 6.3, 8.1, 8.3, 9, 13, 14.4, 15, 17, 19, 23, 24.

### D2. Clan rules

- **To create a clan,** the account must be at least **3 days** old and have at least **10 completed games** (same definition as D1, section 9.5).
- **One clan per player.** A player can **belong to one clan at a time** and **own one clan at a time**. With one membership, one ownership follows, but both limits are checked explicitly.
- **Thresholds live in `CLAN_RULES`** in the same constants module.
- **Reuse the existing clan contracts,** adding only `POST /clans` and the error codes in section 12.2.
- **Affected sections:** 6.4, 12.2, 12.4, 19, 23, 24.

### D3. Sign-in: Guest, Discord, Google

- **No password authentication in V1.**
- **No magic-link email authentication yet.** The architecture stays magic-link-compatible:
  - one sign-in funnel shared by all providers;
  - `email` remains a valid identity provider;
  - the existing client flow (`/auth/magic-link`, `#token-login`, `/auth/login/token`) is left intact, but hidden and unrouted.
- **Affected sections:** 6.1, 7, 14, 17, 19, 20, 23, 24.

### D4. No email provider in V1

Magic links and the email provider move to a later milestone, **M8**, after public launch. The first account milestones have no email dependency.

- **Affected sections:** 7, 16, 20, 21.

### D5. Terms of Service and Privacy Policy

- **Dev and staging:** placeholder pages are acceptable if they are clearly labelled as such. The repo already has them: `resources/public/terms-of-service.html` and `privacy-policy.html` (served at `/terms-of-service.html` and `/privacy-policy.html`, linked from `Footer.ts`). Each says the policy _"has not been published yet"_ and carries a `DELTAFRONT PLACEHOLDER` comment. They must not be presented as legally complete.
- **Public account launch:** complete Terms and Privacy pages are a **launch gate** (section 17.3, M7). They must cover Discord/Google OAuth data, account data, game records, cookies, retention and deletion.
- **Affected sections:** 13, 17, 20, 23, 24.

### D6. DeltaFront-owned store content

- **Do not copy or recreate** OpenFront's proprietary store catalog, cosmetic artwork, paid products, product names, or backend-provided assets.
- **Catalog.** DeltaFront has its own data-driven catalog (`src/account-api/catalog/cosmetics.json`, validated by the existing `CosmeticsSchema`). It starts with a very small set of clearly original, simple placeholder items (section 9.3).
- **Adding a cosmetic** means editing the catalog file and adding an asset. No core store code changes.
- **Affected sections:** 9, 10, 19, 21, 23, 24.

### What the decisions change in milestone order

Using only Discord and Google removes every email dependency from the first milestones:

- The old **M1b (magic links)** is gone from V1, and magic links become **M8** after launch.
- Credits **earning** moves into **M2**, together with stats ingestion, because rewards and the clan threshold both depend on "completed games" computed there. Spending stays in **M5**.
- Nothing else reorders. The final order is in section 20.

---

## 1. Existing architecture discovered

### 1.1 Where the account backend is referenced

| Piece               | File                                                                                             | What it does                                                                                                                                 |
| ------------------- | ------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| API origin (client) | `src/client/ApiBase.ts`                                                                          | `getApiBase()` = `https://api.<audience>`; on `localhost` it is `process.env.API_DOMAIN`, `localStorage.apiHost`, or `http://localhost:8787` |
| API origin (server) | `src/server/ServerEnv.ts:127`                                                                    | `jwtIssuer()` = `https://api.<DOMAIN>` (or `http://localhost:8787` when `DOMAIN=localhost`)                                                  |
| Server→API secret   | `src/server/ServerEnv.ts:350`                                                                    | `apiKey()` = `process.env.API_KEY`, sent as `x-api-key`                                                                                      |
| Feature switches    | `packages/shared/src/AccountFeatures.ts`                                                         | `accounts`, `store`, `ranked`, `clans`, `leaderboards`, all `false`; `usesAccountApi()` = any on                                             |
| Docs                | `docs/DeltaFrontServices.md`, `docs/Auth.md`, `docs/API.md`                                      | Services classification; token model; OpenFront public API (games/players/clans)                                                             |
| Response schemas    | `packages/shared/src/ApiSchemas.ts`, `ClanApiSchemas.ts`, `CosmeticSchemas.ts`, `WireSchemas.ts` | The zod contracts the client and server parse API responses with                                                                             |

### 1.2 Session model (as implemented in `src/client/Auth.ts`)

- **Refresh token.** An HTTP-only cookie on the API origin, sent with `credentials: "include"` to `POST /auth/refresh`, `/auth/logout`, `/auth/revoke`, `/auth/login/token`, `/auth/magic-link` and `DELETE /users/@me`. `docs/Auth.md` says it has a 30-day TTL and is rotated on refresh.
- **Access token.** A JWT held in memory only (`__jwt`). `/auth/refresh` returns `{ jwt, expiresIn }` (seconds). The client refreshes 3 minutes before expiry (`Auth.ts:432`). `docs/Auth.md` says the TTL is 15 minutes.
- **Claims** (`TokenPayloadSchema`, `ApiSchemas.ts:23`):
  - `jti`, `iat`, `exp`, `iss`, `aud`.
  - `sub` = base64url of a UUID. `base64urlToUuid` turns it into the **persistent ID**.
  - `role` ∈ `root | admin | mod | flagged | banned | string` (optional).
  - `provider` (optional; `"steam"` changes join verification).
- **Client checks.** The client checks `iss === getApiBase()` and, outside localhost, `aud === DOMAIN` (`Auth.ts:410–425`). It does not verify the signature (that code is commented out).
- **Game-server checks.** The server verifies the signature with `jose.jwtVerify(..., { algorithms: ["EdDSA"], issuer, audience })` (`src/server/jwt.ts:37`). It fetches the key from `/.well-known/jwks.json` and caches `keys[0]` for the life of the process (`ServerEnv.ts:133–150`).
- **Guest sessions exist in the contract.** `src/client/Main.ts:841`: _"a guest account satisfies it (POST /auth/refresh mints one for any visitor)"_. A guest is a user with no linked identity; `src/client/AccountIdentity.ts` decides "signed in" by the presence of a linked identity. **(inferred)** OpenFront's `/auth/refresh` creates a user and sets the cookie when no cookie is present.
- **Without accounts.** `getPlayToken()` falls back to a random UUID kept in `localStorage.player_persistent_id`. The game server accepts that only in `GameEnv.Dev` (`jwt.ts:26`): _"persistent ID not allowed in production"_.
- **Platform-specific sign-in** (Steam desktop shell, CrazyGames) goes through `POST /auth/steam` and `POST /auth/crazygames`, each returning `{ jwt, expiresIn }` without a cookie.

### 1.3 Production admission (game server, `src/server/Worker.ts:580–860`)

On every websocket join:

1. **Verify the token.** `verifyClientToken(token)`: either a JWT (verified with the JWKS) or, in dev only, a bare UUID. `role === "banned"` → close `Banned`.
2. **Look up the account.** For a JWT, the server calls `GET /users/@me` with the player's bearer **and** `x-api-key`. A 401 or 403 closes the join as terminal; other failures are retryable (`userMeFailureClose`). From the response it reads `flares`, `publicId`, `friends`, `clans[].tag`, the username fields, `trustTier` and the level badge.
3. **Screen the name and Turnstile.** `POST /join_verify` (`src/server/JoinVerify.ts`) checks Turnstile and screens the name. It fails open to the local censor on any API error.
4. **Check the clan tag** against `/reserved_clan_tags` (`Privilege.ts:decideClanTag`):
   - a member of the clan keeps the tag;
   - a tag no clan holds is "fictional" and is kept;
   - a registered tag worn by a non-member is dropped.
5. **Check cosmetics.** Every cosmetic referenced in the join message is checked against the player's `flares` and the `/cosmetics.json` catalog (`Privilege.ts:isAllowed`). An unowned cosmetic closes the socket with `CosmeticsForbidden`.

The catalog and the reserved tags are polled every 3 minutes by `PrivilegeRefresher`, which only starts when `store || clans` is on. It requires **both** endpoints to answer; until the first successful load it uses `FailOpenPrivilegeChecker`, which keeps any clan tag and strips all catalog cosmetics.

### 1.4 Game results (server-authoritative)

- **Finding the winner.** At game end the winner comes from client votes. If the vote is disputed, the server replays the game itself in a subprocess (`GameServer.settleWinner`, `GameServer.ts:1945`).
- **The record.** `archiveGame` builds a `GameRecord`: `info.players[]`, each carrying `clientID`, `username`, `clanTag`, `persistentID` (the JWT subject, i.e. the user id) and `stats: PlayerStats`; plus `info.winner`, `turns[]`, `gitCommit`, timestamps and `publicGameType`.
- **Submission.** `archive()` POSTs the record to `POST /game/:gameID` with `x-api-key` (`src/server/Archive.ts`). It is skipped unless `usesAccountApi()`. `readGameRecord` reads it back with `GET /game/:id`.
- **Winner format.** `WinnerSchema` (`engine-api/Schemas.ts:640`) is `["player", clientID, ...clientIDs] | ["team", teamName, ...clientIDs] | ["nation", name, ...clientIDs]`. Players whose `clientID` appears after index 1 won.
- **Singleplayer games are client-submitted.** `LocalServer.ts:357` posts them gzipped to `POST /archive_singleplayer_game` with the user's bearer. They are **not** trustworthy for anything competitive.

### 1.5 Public lobbies and server discovery

- **Lobby lists** come from the game server itself: a websocket at `/wN/lobbies` (`src/client/LobbySocket.ts`). No API is involved.
- **Scheduling.** A deployed host (one with a public host/`SUBDOMAIN`) schedules no public lobbies until `POST /cluster/checkin` answers `{ state: "open" }` (`Master.ts:165`, `ClusterCheckin.ts`). Local dev schedules on its own.
- **Server list.** When any flag is on, the client fetches `GET /cluster.json?site=` (`ServerList.ts`) and otherwise falls back to the page's own server.
- **Trusted lobbies.** With `accounts` on, every Nth public lobby is **trusted-only** (`MapPlaylist.ts:142`); only accounts with `trustTier === "trusted"` may join.

### 1.6 Cosmetics and ownership model

- **Catalog.** `GET /cosmetics.json` (`CosmeticsSchema`, `CosmeticSchemas.ts`) holds:
  - `patterns` (base64url pattern data plus `colorPalettes`), `flags`, `crowns`, `skins` (each with a `url`), and `effects` (per effect type);
  - `packs` (bundles priced in hard currency), plus `currencyPacks`, `subscriptions`, `tribeNames` and `lobbyQueue`, which are all real-money or premium features.
  - Every item has `priceSoft?`, `priceHard?`, `product` (Stripe, nullable) and `rarity`.
- **Ownership is a list of flare strings** in `/users/@me` `player.flares`:
  - `pattern:<name>` (legacy, uncoloured) or `pattern:<name>:<palette>`;
  - `flag:<name>`, `skin:<name>`, `crown:<name>`, `effect:<name>`, `color:<hex>`;
  - wildcards `pattern:*`, `flag:*`, `skin:*`, `crown:*`, `effect:*` (`Privilege.ts`, `Cosmetics.ts:934–1086`).
- **Equipping is client-side.** Selections live in `UserSettings` localStorage, scoped per `publicId` (`UserSettings.setPlayerId`). They are sent as `PlayerCosmeticRefs` in the join message and validated by the server against flares. **No equip/unequip endpoint exists.**
- **Currencies.** Upstream labels `soft` "Caps" and `hard` "Plutonium" (`en.json`: `cosmetics.soft`, `cosmetics.hard`). Balances are in `player.currency`. DeltaFront replaces both with a single currency, **Credits**, in the `soft` slot (D1).

### 1.7 Website shell

- **Nav items already exist and are flag-gated.** `src/client/components/DesktopNavBar.ts` already renders PLAY, STORE (`store`), INVENTORY (`store`), LEADERBOARD (`leaderboards`), CLANS (`clans`) and `<nav-account-menu>` (`accounts`), in DeltaFront styling. `MobileNavBar.ts` is the mobile counterpart.
- **Pages** are Lit modals routed by `#modal=<name>` (`ModalRouter.ts`, `LazyModals.ts`): `store-modal` (`Store.ts`), `InventoryModal.ts`, `LeaderboardModal.ts`, `ClanModal.ts` plus `components/clan/*`, `AccountModal.ts`, `PlayerProfileModal.ts`.

### 1.8 No backend or database exists yet

- There is no server code for accounts and no SQL, ORM or migrations anywhere in the repo.
- `@types/pg` is a dev dependency but nothing imports `pg`.
- `client-api.json` contains only `{ "clientApi": 1 }`.
- The dev default `http://localhost:8787` is Cloudflare Wrangler's default port **(inferred)**: OpenFront runs its API as a Worker. We do not need to.

---

## 2. Feature inventory

Legend:

| Code   | Meaning                                      |
| ------ | -------------------------------------------- |
| **C**  | Fully present in client                      |
| **S**  | Fully present in game server                 |
| **P**  | Partially present                            |
| **UI** | UI only                                      |
| **K**  | API contract present (zod schema and caller) |
| **F**  | Disabled by feature flag                     |
| **O**  | Depends on OpenFront private API             |
| **M**  | Completely missing                           |

| Area                 | Component                                                                                             | Status          | Notes                                                                                                             |
| -------------------- | ----------------------------------------------------------------------------------------------------- | --------------- | ----------------------------------------------------------------------------------------------------------------- |
| **Auth**             | Guest session minting                                                                                 | C K F O         | `POST /auth/refresh` with no cookie (inferred from `Main.ts:841`)                                                 |
|                      | Discord / Google OAuth sign-in                                                                        | C K F O         | `GET /auth/login/{discord,google}?redirect_uri=`; results via `#login=<result>` (`LoginResult.ts`)                |
|                      | Email magic link                                                                                      | C K F O         | `POST /auth/magic-link` → email → `#token-login?token-login=<t>` → `GET /auth/login/token` (`TokenLoginModal.ts`) |
|                      | Steam (web OpenID, desktop ticket), CrazyGames                                                        | C K F O         | Web Steam sign-in never creates an account (`no_account`)                                                         |
|                      | Account linking (Google, Steam)                                                                       | C K F O         | `GET /auth/link/google` → `{ url }`                                                                               |
|                      | Logout / revoke all                                                                                   | C K F O         | `/auth/logout`, `/auth/revoke`                                                                                    |
|                      | Username/password                                                                                     | **M**           | No UI, schema or endpoint                                                                                         |
|                      | JWKS                                                                                                  | S K O           | Game server only                                                                                                  |
| **Profile**          | `/users/@me`                                                                                          | C S K F O       | The central contract (section 4.2)                                                                                |
|                      | Account username (base.discriminator)                                                                 | C K F O         | `PUT /users/@me/username`                                                                                         |
|                      | Public profile and stats tree                                                                         | C K F O         | `/public/player/:publicId`, `/games`                                                                              |
|                      | Account deletion                                                                                      | C K F O         | `DELETE /users/@me` (cookie)                                                                                      |
|                      | Friends                                                                                               | C K F O         | `/friends*`                                                                                                       |
|                      | XP, levels, prestige, rewards                                                                         | C K F O         | `/users/@me/xp/*`, `/prestige`, `/public/progression/config`, `/rewards/*`                                        |
|                      | Identity tokens, creator codes, marketing consent                                                     | C K F O         | Optional fields; UI hides itself when absent                                                                      |
| **Store**            | Store page (6 tabs)                                                                                   | C K F O         | Tabs: packs, subscriptions, bundles, cosmetics, effects, tribes (`Store.ts:105`)                                  |
|                      | Soft/hard currency purchase                                                                           | C K F O         | `POST /shop/purchase`, `/shop/purchase/pack`                                                                      |
|                      | Real money (Stripe, Steam, subscriptions)                                                             | C K F O         | `/payments/*`, `/stripe/*`, `/subscriptions/@me/*`                                                                |
|                      | Catalog content (art, patterns)                                                                       | **M**           | OpenFront's catalog is served by their API, not in this repo, and is not ours to copy                             |
| **Inventory**        | Inventory page (patterns, flags, crowns, effects)                                                     | C K F           | Reads catalog + flares                                                                                            |
|                      | Equip/unequip                                                                                         | C               | Local, per-account scoped; no server endpoint by design                                                           |
|                      | Multiplayer propagation and ownership check                                                           | S               | `Privilege.ts`, needs `/cosmetics.json` + flares                                                                  |
| **Leaderboards**     | Ranked 1v1/2v2/FFA ladders                                                                            | C K F O         | `GET /leaderboard/ranked?page=`                                                                                   |
|                      | Clan leaderboard                                                                                      | C K F O         | `GET /public/clans/leaderboard`                                                                                   |
|                      | Tribe leaderboard                                                                                     | C K F O         | `GET /leaderboard/tribes?page=`                                                                                   |
|                      | Basic (non-ranked) player leaderboard                                                                 | P               | Display schema `PlayerLeaderboardResponseSchema` and `LeaderboardPlayerList` exist; **no endpoint or fetcher**    |
| **Clans**            | Browse, detail, members, join/leave, requests, kick, promote/demote, transfer, ban, disband, settings | C K F O         | `src/client/ClanApi.ts`, `components/clan/*`                                                                      |
|                      | **Create clan**                                                                                       | **M**           | No endpoint, UI or strings (`clan_modal.*` has none)                                                              |
|                      | Clan games, clan stats, donations                                                                     | C K F O         | Donations are clan currency (defer)                                                                               |
|                      | Clan tag picker and tag ownership check                                                               | C K F O         | `UsernameInput.ts`, `checkClanTagOwnership`, `/public/clan/:tag/exists`                                           |
|                      | In-game clan tag enforcement                                                                          | S F             | `PrivilegeRefresher` + `/reserved_clan_tags`                                                                      |
| **Stats**            | Engine stats per player                                                                               | S               | `PlayerStatsSchema` in `GameRecord`                                                                               |
|                      | Authoritative winner                                                                                  | S               | Vote plus server replay                                                                                           |
|                      | Persistence and aggregation                                                                           | **M** (backend) | OpenFront does it server-side from `POST /game/:id`                                                               |
| **Currency**         | Balances, debt refusals, rewards                                                                      | C K F O         | `player.currency`, `rewards[]`                                                                                    |
|                      | Earning soft currency by playing                                                                      | **M**           | Not visible in client; OpenFront grants via subscriptions and prestige                                            |
| **Server admission** | JWT verification, ban close, `/users/@me` lookup                                                      | S F O           | Needs JWKS and `/users/@me`                                                                                       |
|                      | Turnstile + name screening                                                                            | S O             | `/join_verify` (fails open)                                                                                       |
| **Server discovery** | Public lobbies list                                                                                   | S               | Game-server websocket                                                                                             |
|                      | Cluster check-in (deployed hosts)                                                                     | S O             | `/cluster/checkin`                                                                                                |
|                      | Server list                                                                                           | C O             | `/cluster.json`                                                                                                   |
|                      | Game archive / replays                                                                                | S C O           | `POST`/`GET /game/:id`                                                                                            |

---

## 3. OpenFront private API dependencies

Every call below goes to `api.<DOMAIN>`. "When off" describes behaviour with all flags off (today).

| Dependency                                 | Caller              | Gated by                                | When off / on failure                                     |
| ------------------------------------------ | ------------------- | --------------------------------------- | --------------------------------------------------------- |
| `/auth/*`, `/users/@me`, profile endpoints | client              | `accounts` (`userAuth()` returns false) | Signed out; persistent UUID play token                    |
| `/.well-known/jwks.json`                   | game server         | any JWT join                            | Only reached when a JWT is presented                      |
| `/users/@me` (with `x-api-key`)            | game server join    | JWT present                             | Join closed (terminal on 401/403)                         |
| `/join_verify`                             | game server join    | always in prod path                     | Fails open to local censor; **Turnstile then unverified** |
| `/cosmetics.json`, `/reserved_clan_tags`   | game server poll    | `store \|\| clans`                      | Fail-open checker (no catalog cosmetics; any clan tag)    |
| `/cosmetics.json`                          | client              | `store`                                 | `null` → no cosmetics UI                                  |
| `/game/:id` POST/GET                       | game server, client | `usesAccountApi()`                      | Not archived; no replays of finished games                |
| `/archive_singleplayer_game`               | client              | signed in                               | Not archived                                              |
| `/cluster/checkin`                         | game server master  | deployed host                           | **No public lobbies on a deployed host**                  |
| `/cluster.json`                            | client              | `usesAccountApi()`                      | Page's own server                                         |
| `/custom_tribes`                           | game server         | `store`                                 | Fails open (organic bot names)                            |
| `/users/@me/lobby_queue`                   | game server         | `store` + listed lobby                  | Not reachable without `canCreatePublicLobbies`            |
| `/matchmaking/*`                           | client + server     | `ranked`                                | Hidden                                                    |
| `/news.json`, `/streams.json`              | client              | `usesAccountApi()`                      | Bundled fallback                                          |
| lobby-coordinator websocket                | game server         | `LOBBY_COORDINATOR=api`                 | Not used                                                  |

---

## 4. Exact API contracts already present

Each schema below is in `packages/shared/src/ApiSchemas.ts` unless another file is named. "Caller" is the function that issues the request.

Every bearer-authed client call sends `Authorization: Bearer <jwt>` (via `getAuthHeader()` or `userAuth()`). Server-to-API calls send `x-api-key: $API_KEY`.

### 4.1 Auth

| Method           | Path                                                  | Auth                            | Request                     | Response                                                                                                                            | Caller                   | Feature                   |
| ---------------- | ----------------------------------------------------- | ------------------------------- | --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ------------------------ | ------------------------- |
| POST             | `/auth/refresh`                                       | refresh cookie                  | none                        | 200 `{ jwt: string, expiresIn: number }`; 401 = dead session (client logs out); other = transient                                   | `Auth.doRefreshJwt`      | Session + guest minting   |
| POST             | `/auth/logout`                                        | cookie                          | none                        | 2xx                                                                                                                                 | `Auth.logOut()`          | Logout                    |
| POST             | `/auth/revoke`                                        | cookie                          | none                        | 2xx                                                                                                                                 | `Auth.logOut(true)`      | Sign out everywhere       |
| GET (navigation) | `/auth/login/discord?redirect_uri=<url>`              | none                            | browser redirect            | 302 to provider; callback sets cookie, 302 to `redirect_uri` (optionally `#login=email_exists\|deleted\|error\|no_account\|cancel`) | `Auth.discordLogin`      | Sign-in                   |
| GET (navigation) | `/auth/login/google?redirect_uri=`                    | none                            | same                        | same                                                                                                                                | `Auth.googleLogin`       | Sign-in                   |
| GET (navigation) | `/auth/login/steam?redirect_uri=`                     | none                            | same                        | same; never creates an account                                                                                                      | `Auth.steamLogin`        | Sign-in (defer)           |
| GET              | `/auth/link/google?redirect_uri=`                     | bearer + cookie                 | none                        | 200 `{ url }` (client navigates)                                                                                                    | `Auth.linkGoogle`        | Link provider             |
| GET              | `/auth/link/steam?redirect_uri=`                      | bearer + cookie                 | none                        | 200 `{ url }`                                                                                                                       | `Auth.linkSteam`         | defer                     |
| POST             | `/auth/magic-link`                                    | cookie (`credentials: include`) | `{ email, redirectDomain }` | 2xx                                                                                                                                 | `Auth.sendMagicLink`     | Email sign-in and linking |
| GET              | `/auth/login/token?login-token=<t>`                   | sets cookie                     | none                        | 200 `{ email }`; 400 `{ code: "consumed" \| "expired" \| "invalid" }`; 429                                                          | `Auth.tempTokenLogin`    | Magic-link completion     |
| POST             | `/auth/steam`                                         | none                            | `{ ticket }`                | `{ jwt, expiresIn }`                                                                                                                | `Auth.doSteamLogin`      | Desktop (defer)           |
| POST             | `/auth/crazygames`                                    | none                            | `{ token }`                 | `{ jwt, expiresIn }`                                                                                                                | `Auth.doCrazyGamesLogin` | defer                     |
| GET/POST         | `/auth/steam/link*`, `/auth/steam/link_ticket/:token` | bearer                          | see `SteamLink.ts`          |                                                                                                                                     |                          | defer                     |
| GET              | `/.well-known/jwks.json`                              | none                            | none                        | `{ keys: [JWK] }` (Ed25519, `keys[0]` used)                                                                                         | `ServerEnv.jwkPublicKey` | Admission                 |

Note: `RefreshResponseSchema` (`{ token }`) exists but is **not** what the client reads. `/auth/refresh` must return `{ jwt, expiresIn }`.

### 4.2 Users and profile

| Method          | Path                                                                                                        | Auth                                    | Request                         | Response                                                                                                                                                                                                                           | Caller                                  |
| --------------- | ----------------------------------------------------------------------------------------------------------- | --------------------------------------- | ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| GET             | `/users/@me`                                                                                                | bearer (+ `x-api-key` from game server) | none                            | `UserMeResponseSchema` (below); 401 → client logs out                                                                                                                                                                              | `Api.getUserMe`, `server/jwt.getUserMe` |
| DELETE          | `/users/@me`                                                                                                | cookie                                  | none                            | 204 queued (deleted after 24h); 401; 403 `{ message }`; 429                                                                                                                                                                        | `Api.deleteAccount`                     |
| PUT             | `/users/@me/username`                                                                                       | bearer                                  | `{ username, acceptSuffixed? }` | 200 `PutUsernameResponseSchema` `{ username, base, discriminator, usernameStatus, nextUsernameChangeAt, ... }`; 400 `{ code: "USERNAME_PROFANE" }` or `{ reason }`; 409 `{ code: "BARE_NAME_TAKEN", base }` or taken; 429 cooldown | `Api.updateUsername`                    |
| GET             | `/player/:publicId`                                                                                         | bearer                                  | none                            | `PlayerProfileSchema`                                                                                                                                                                                                              | `Api.fetchPlayerById` (`AccountModal`)  |
| GET             | `/public/player/:publicId`                                                                                  | none                                    | none                            | `PlayerProfileSchema`                                                                                                                                                                                                              | `Api.fetchPublicPlayerProfile`          |
| GET             | `/public/player/:publicId/games`                                                                            | none                                    | query: filters, cursor          | `PublicPlayerGamesResponseSchema`                                                                                                                                                                                                  | `Api.fetchPublicPlayerGames`            |
| GET/POST/DELETE | `/friends`, `/friends/requests[/:id[/accept]]`, `/friends/:id`                                              | bearer                                  |                                 | `Friends*Schema`                                                                                                                                                                                                                   | `FriendsApi.ts` (defer)                 |
| GET/POST        | `/users/@me/xp/:gameId`, `/users/@me/prestige`, `/public/player/:id/progress`, `/public/progression/config` | mixed                                   |                                 | progression schemas                                                                                                                                                                                                                | `ProgressionApi.ts` (defer)             |
| POST            | `/rewards/:id/claim`, `/rewards/claim-all`                                                                  | bearer                                  |                                 | `{ currency }`                                                                                                                                                                                                                     | `Api.claimReward*` (defer)              |
| GET             | `/public/identity_token/audiences`; POST `/users/@me/identity_token`                                        |                                         |                                 |                                                                                                                                                                                                                                    | defer (empty audiences hides UI)        |
| GET/PUT/DELETE  | `/creators/code/:code`, `/users/@me/creator`; POST `/marketing/consent`                                     |                                         |                                 |                                                                                                                                                                                                                                    | defer                                   |

**`UserMeResponseSchema`** (`ApiSchemas.ts:352`). Required fields are marked ✱. Everything else is optional, and the UI hides the feature when it's absent.

```
{
  user ✱: { discord?: {id, avatar, username, global_name, discriminator},
            google?: {email}, email?: string, steam?: {steamId, personaName, avatarUrl} },
  ban?: { category, reason|null, expiresAt|null } | null,
  player ✱: {
    publicId ✱, adfree ✱: bool, unlimitedRanked ✱: bool, canCreatePublicLobbies ✱: bool,
    trustTier?: "untrusted"|"trusted"|null,
    username?, usernameBase?, usernameDiscriminator?, usernameStatus?: "unclaimed"|"claimed"|"premium"|"indefinite",
    usernameClaimExpiresAt?, nextUsernameChangeAt?,
    flares?: string[],
    achievements ✱: { singleplayerMap ✱: [{mapName, difficulty}], player?: [{achievement, game|null, achievedAt|null}] },
    leaderboard?: { oneVone?: {elo?}, twoVtwo?: {elo?}, ffa?: {elo?} },
    currency?: { soft: number, hard: number },
    rewards?: [{ id, currencyType, amount, reason, note|null }],
    progress?, levelHidden?: bool,
    clans?: [{ tag, name, role: "leader"|"officer"|"member", joinedAt, memberCount, softBalance?, hardBalance? }],
    clanRequests?: [{ tag, name, createdAt }],
    friends ✱: string[],
    subscription ✱: {...} | null,
    pastDueSubscription?, marketingConsent?, creator?
  }
}
```

A guest is `user: {}`. `AccountIdentity.ts` treats "no linked identity" as not signed in.

### 4.3 Store, inventory and payments

| Method   | Path                                                                                                                                          | Auth                           | Request                                                                                                                         | Response                                                                                                                                                               | Caller                                            |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| GET      | `/cosmetics.json`                                                                                                                             | none (server adds `x-api-key`) | none                                                                                                                            | `CosmeticsSchema`                                                                                                                                                      | `Cosmetics.fetchCosmetics`, `PrivilegeRefresher`  |
| POST     | `/shop/purchase`                                                                                                                              | bearer                         | `{ cosmeticType: "pattern"\|"skin"\|"flag"\|"crown"\|"effect", cosmeticName, currencyType: "hard"\|"soft", colorPaletteName? }` | 2xx; 400 `{ reason: "Insufficient balance" }` or debt `{ code, debt }`; 409 already owned; 401                                                                         | `Api.purchaseWithCurrency`                        |
| POST     | `/shop/purchase/pack`                                                                                                                         | bearer                         | `{ packName }`                                                                                                                  | 200 `{ packName, currencyType, amount, flareNames[] }`; 400 reasons (`Pack not found`, `Pack is not for sale`, …, `Insufficient balance`); 409 `{ ownedFlareNames[] }` | `Api.purchaseCosmeticPack`                        |
| POST     | `/payments/checkout`, `/payments/steam/finalize`, `/stripe/create-custom-currency-checkout`, `/subscriptions/@me/{cancel,change-tier,portal}` | bearer                         |                                                                                                                                 |                                                                                                                                                                        | `Api.ts`, `Payments.ts` (defer)                   |
| GET/POST | `/users/@me/tribe_names`, `/users/@me/tribe_names/:id/boosts`, `/public/tribe/:name`                                                          |                                |                                                                                                                                 |                                                                                                                                                                        | defer                                             |
| POST     | `/custom_tribes`                                                                                                                              | `x-api-key`                    | `{ players: [{clientId, publicId}] }`                                                                                           | `{ tribes: Tribe[] }` (≤100)                                                                                                                                           | `server/CustomTribes.ts` (called when `store` on) |
| POST     | `/users/@me/lobby_queue`                                                                                                                      | bearer + `x-api-key`           |                                                                                                                                 |                                                                                                                                                                        | `server/LobbyQueuePayment.ts` (defer)             |

DeltaFront V1 uses only the `soft` currency slot, as **Credits** (D1, section 9.2), and none of the deferred rows.

### 4.4 Leaderboards

| Method | Path                         | Auth | Response                                                                                                                                                                                                                           | Caller                          |
| ------ | ---------------------------- | ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| GET    | `/leaderboard/ranked?page=N` | none | `RankedLeaderboardResponseSchema` `{ "1v1": Entry[], "2v2"?: Entry[], "ffa"?: Entry[] }`, Entry = `{ rank, elo, peakElo\|null, wins, losses, total, public_id, accountUsername\|null }`; 400 page-bounds message → "reached limit" | `Api.fetchPlayerLeaderboard`    |
| GET    | `/leaderboard/tribes?page=N` | none | `TribeLeaderboardResponseSchema`                                                                                                                                                                                                   | `Api.fetchTribeLeaderboardPage` |
| GET    | `/public/clans/leaderboard`  | none | `ClanLeaderboardResponseSchema` `{ start, end, clans: [{ clanTag, games, wins, losses, playerSessions, weightedWins, weightedLosses, weightedWLRatio }], total?, limit? }`                                                         | `ClanApi.fetchClanLeaderboard`  |

### 4.5 Clans (`src/client/ClanApi.ts`, schemas in `ClanApiSchemas.ts`)

All of these are bearer-authed via `clanFetch` unless marked public.

| Method   | Path                                         | Request                                         | Response / errors                                                                                                                                   |
| -------- | -------------------------------------------- | ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET      | `/clans?page&limit&search`                   |                                                 | `ClanBrowseResponse { results: ClanInfo[], total, page, limit }`                                                                                    |
| GET      | `/clans/:tag`                                |                                                 | `ClanInfo { name≤35, tag, description≤200, discordUrl?, isOpen, createdAt?, memberCount?, softBalance?, hardBalance? }`                             |
| GET      | `/public/clan/:TAG/exists` (public)          |                                                 | 200 exists / 404 not                                                                                                                                |
| GET      | `/clans/:tag/members?page&limit&sort&order`  |                                                 | `ClanMembersResponse { results: [{ role, joinedAt, publicId, username?, stats? }], total, page, limit, pendingRequests? }`                          |
| POST     | `/clans/:tag/join`                           |                                                 | `{ status: "joined"\|"requested" }`; 409 (message containing "request" → pending, else already member); 403 `{ code: "BANNED", reason? }`; 401; 429 |
| POST     | `/clans/:tag/leave`                          |                                                 | 2xx                                                                                                                                                 |
| PATCH    | `/clans/:tag`                                | `{ name?, description?, discordUrl?, isOpen? }` | `ClanInfo`; 400 `{ code: "DISCORD_INVALID"\|"DISCORD_EXPIRES" }`; 429                                                                               |
| DELETE   | `/clans/:tag`                                |                                                 | 2xx (disband)                                                                                                                                       |
| POST     | `/clans/:tag/{kick,promote,demote,transfer}` | `{ targetPublicId }`                            | 2xx                                                                                                                                                 |
| GET      | `/clans/:tag/requests?page&limit`            |                                                 | `ClanRequestsResponse`                                                                                                                              |
| POST     | `/clans/:tag/requests/{approve,deny}`        | `{ targetPublicId }`                            | 2xx                                                                                                                                                 |
| POST     | `/clans/:tag/requests/withdraw`              |                                                 | 2xx                                                                                                                                                 |
| POST     | `/clans/:tag/ban`, `/unban`                  | `{ targetPublicId, reason? }`                   | 2xx                                                                                                                                                 |
| GET      | `/clans/:tag/bans?page&limit`                |                                                 | `ClanBansResponse`                                                                                                                                  |
| GET      | `/clans/:tag/games?filter&cursor`            |                                                 | `ClanGamesResponse { results, nextCursor }`; 403                                                                                                    |
| POST/GET | `/clans/:tag/donate`, `/donations`           |                                                 | defer (clan currency)                                                                                                                               |
| GET      | `/reserved_clan_tags` (`x-api-key`)          |                                                 | `string[]` (every registered tag)                                                                                                                   |

### 4.6 Game server and discovery

| Method | Path                          | Auth                                 | Request                                                                      | Response                                                                                    | Caller                                                                         |
| ------ | ----------------------------- | ------------------------------------ | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| POST   | `/game/:gameID`               | `x-api-key`                          | `GameRecord` JSON (`WireSchemas.ts:846`)                                     | 2xx                                                                                         | `server/Archive.archive`                                                       |
| GET    | `/game/:gameID`               | `x-api-key` (server) / none (client) |                                                                              | `GameRecord`                                                                                | `Archive.readGameRecord`, `JoinLobbyModal`, `ReplayRecord`, `GamePreviewRoute` |
| POST   | `/archive_singleplayer_game`  | bearer, `Content-Encoding: gzip`     | `GameRecord`                                                                 | 2xx                                                                                         | `LocalServer.ts`                                                               |
| POST   | `/join_verify`                | `x-api-key`                          | `{ ip, token\|null, username, clanTag\|null }`                               | `{ status: "approved", username, clanTag? }` or `{ status: "rejected", reason }`            | `server/JoinVerify.verifyJoin` (5s timeout)                                    |
| POST   | `/cluster/checkin`            | `x-api-key`                          | `{ site, letter, host, version, numWorkers, liveGames, machine? }` every 10s | `{ state: "open"\|"draining"\|"fenced" }`; refusal `{ reason?, host? }`                     | `server/ClusterCheckin.sendCheckin`                                            |
| GET    | `/cluster.json?site=`         | none                                 |                                                                              | `ServerListSchema { latest?, servers: { [letter]: { host, numWorkers, version, state } } }` | `client/ServerList.ts`                                                         |
| POST   | `/matchmaking/checkin`        | `x-api-key`                          |                                                                              |                                                                                             | defer (`ranked`)                                                               |
| GET    | `/news.json`, `/streams.json` | none                                 |                                                                              | `NewsItem[]`, `StreamsFeed`                                                                 | optional (bundled fallback)                                                    |

---

## 5. Minimum DeltaFront backend architecture

### 5.1 Shape

One new Node.js service, **`account-api`**, in this repository:

```
src/account-api/
  index.ts              entry: config, pg pool, express app, listen (port 8787 in dev)
  config.ts             env parsing (zod)
  db/                   pool, tx helper, repositories (one file per table group)
  migrations/           0001_init.sql, 0002_…  (forward-only)
  auth/                 jwt.ts (sign/JWKS), sessions.ts, oauth/{discord,google}.ts, signIn.ts, cookies.ts  (magicLink.ts in M8)
  routes/               auth.ts, users.ts, profile.ts, store.ts, leaderboard.ts, clans.ts, game.ts, cluster.ts, server.ts
  domain/               constants.ts (ECONOMY, CLAN_RULES), stats.ts (aggregation, completed games), economy.ts (Credits), clans.ts (permissions), usernames.ts, moderation.ts
  catalog/cosmetics.json  DeltaFront catalog (source of truth for items and prices)
  admin/cli.ts          admin commands (section 15)
```

**Why in this repo.** It imports the existing zod schemas from `@openfront/shared` (`ApiSchemas`, `ClanApiSchemas`, `CosmeticSchemas`, `WireSchemas`) and `@openfront/engine-api` (`PlayerStatsSchema`, `WinnerSchema`). Responses can then be validated in tests with the **exact** schemas the client parses, which is the strongest guarantee that we match the existing contract. It is AGPL like the rest.

**Stack.** Use what the repo already depends on: `express` 5, `jose`, `zod`, `express-rate-limit`, `winston`, `obscenity` (name screening, already used by `Censor.ts`). Add **one** dependency: `pg`. Do not add an ORM; plain SQL keeps the schema reviewable.

**Layer rule** (extend `tests/LayerBoundaries.test.ts`): `src/account-api` may import `@openfront/engine-api`, `@openfront/engine-lib` (only if needed), `@openfront/shared`, `zod`, `pg`, `express`, `jose`. It may never import `src/client`, `src/server` or `@openfront/engine`.

**Scripts:**

| Script                | Purpose                                                                                                            |
| --------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `start:account-api`   | Run the service                                                                                                    |
| `account-api:migrate` | Apply migrations                                                                                                   |
| `admin`               | Admin CLI                                                                                                          |
| `test:account-api`    | Database-backed tests (needs Postgres)                                                                             |
| `dev`                 | Gains the account API as a third process; only starts when `DATABASE_URL` is set, otherwise dev stays backend-free |

### 5.2 Runtime topology

```
browser ──https──> <DOMAIN>          (nginx → game server master/workers; static from CDN)
browser ──https──> api.<DOMAIN>      (nginx → account-api :8787)
game server ──https/local──> account-api   (x-api-key; prefer the private network/localhost)
account-api ──> PostgreSQL
account-api ──> Discord / Google OAuth, email provider (Resend/Postmark/SES), Cloudflare Turnstile siteverify
```

The API is stateless (all state in Postgres), so it can later move or scale independently (option B).

### 5.3 Endpoints the V1 backend implements

Grouped by milestone in section 20. Everything else in section 4 stays unimplemented, and its UI stays hidden behind the finer flags in section 17.

---

## 6. PostgreSQL schema

Conventions:

- All timestamps are `timestamptz`, and all money amounts are `bigint`.
- `citext` (extension) is used for case-insensitive unique names.
- IDs: `users.id` is a **UUID**, because it _is_ the persistent ID and the JWT `sub` (base64url-encoded with `uuidToBase64url`, `packages/shared/src/Base64.ts`). Other tables use `bigserial`.
- `public_id` is a separate random, shareable ID (never the UUID: `Auth.ts` warns _"DO NOT EXPOSE THIS ID"_).

### 6.1 Identity and sessions

**`users`**: one row per account, guest or registered.

| Field                             | Type                                             | Notes                                            |
| --------------------------------- | ------------------------------------------------ | ------------------------------------------------ |
| id                                | uuid PK                                          | JWT `sub`                                        |
| public_id                         | text UNIQUE NOT NULL                             | e.g. 10-char nanoid, `[A-Za-z0-9]`               |
| kind                              | text NOT NULL CHECK (`guest`, `registered`)      | registered = has ≥1 identity                     |
| role                              | text NULL CHECK (`root`,`admin`,`mod`,`flagged`) | `banned` is derived from `bans`, not stored here |
| username_base                     | citext NULL                                      |                                                  |
| username_discriminator            | char(4) NULL                                     |                                                  |
| next_username_change_at           | timestamptz NULL                                 |                                                  |
| level_hidden                      | boolean NOT NULL DEFAULT false                   |                                                  |
| created_at, last_seen_at          | timestamptz                                      |                                                  |
| deletion_requested_at, deleted_at | timestamptz NULL                                 | deletion runs 24h after request                  |

- UNIQUE `(username_base, username_discriminator)` WHERE `username_base IS NOT NULL`.
- Indexes on `(kind, last_seen_at)` (guest cleanup) and `(created_at)`.

**`auth_identities`**: a linked sign-in method.

- Fields: `id` bigserial PK; `user_id` uuid FK → users ON DELETE CASCADE; `provider` text CHECK (`discord`,`google`,`email`,`steam`); `provider_user_id` text NOT NULL (Discord id, Google `sub`, lower-cased email, SteamID64); `email` citext NULL; `email_verified` bool; `display_name`, `avatar` text NULL (Discord `username`/`global_name`/`avatar`/`discriminator` stored as jsonb `profile`); `created_at`, `last_login_at`.
- UNIQUE `(provider, provider_user_id)`; UNIQUE `(user_id, provider)` (one of each per account); index `(email)`.

**`refresh_sessions`**

- Fields: `id` uuid PK; `user_id` FK; `family_id` uuid NOT NULL; `token_hash` bytea UNIQUE NOT NULL (SHA-256 of the opaque token); `parent_id` uuid NULL; `created_at`, `last_used_at`, `expires_at`; `revoked_at` NULL; `revoked_reason` text NULL; `user_agent` text; `ip_hash` bytea.
- Indexes on `(user_id) WHERE revoked_at IS NULL` and `(family_id)`.

**`magic_link_tokens`**: **deferred to M8** (D3/D4). It is not created in `0001_init.sql`; the M8 migration adds it unchanged.

- Fields: `token_hash` bytea PK; `email` citext; `redirect_domain` text; `link_user_id` uuid NULL (set when an already signed-in user is adding email); `created_at`; `expires_at` (+15 min); `consumed_at` NULL; `request_ip_hash`.
- Index `(email, created_at)` for rate limiting.

**`oauth_states`**

- Fields: `state` text PK (random); `provider`; `redirect_uri` (validated); `pkce_verifier`; `link_user_id` NULL; `created_at`; `expires_at` (+10 min).

**`bans`**

- Fields: `id` bigserial PK; `user_id` FK; `category` text; `reason` text NULL (shown to the user); `created_by` uuid NULL; `created_at`; `expires_at` NULL; `revoked_at` NULL.
- Index `(user_id) WHERE revoked_at IS NULL`.

### 6.2 Economy and inventory

One currency (D1). Credits are stored as a single balance. The API maps that balance to `currency.soft` on the wire (section 9.2).

**`wallets`**

- Fields: `user_id` uuid PK FK; `credits` bigint NOT NULL DEFAULT 0 CHECK ≥ 0; `updated_at`.
- No `hard` column. A future premium currency would be a new, separately reviewed migration.

**`currency_ledger`**: append-only, never updated.

- Fields: `id` bigserial PK; `user_id` FK; `currency` text NOT NULL DEFAULT `'credits'` CHECK (`credits`) (kept as a column so the ledger format survives a future currency); `delta` bigint ≠ 0; `balance_after` bigint; `reason` text CHECK (`purchase`,`game_reward`,`admin_grant`,`admin_revoke`,`refund`); `ref_type` text NULL; `ref_id` text NULL; `actor` uuid NULL (admin); `created_at`; `reward_day` date NULL (UTC day, set for `game_reward`).
- Index `(user_id, created_at DESC)`.
- Index `(user_id, reward_day)` WHERE `reason = 'game_reward'` (daily-cap sum).
- UNIQUE `(user_id, ref_type, ref_id)` WHERE `reason = 'game_reward'`, so the same game can never pay twice.

**`user_flares`**: ownership.

- Fields: `user_id` FK; `flare` text (`pattern:x:pal`, `flag:x`, …); `source` text CHECK (`purchase`,`admin`); `purchase_id` bigint NULL; `granted_at`; `revoked_at` NULL.
- PK `(user_id, flare)`; index `(flare)` (admin queries).
- Default (free) items are not stored here; they come from the catalog config (section 10).

**`purchases`**

- Fields: `id` bigserial PK; `user_id` FK; `kind` text CHECK (`cosmetic`) (`pack` is added later, together with bundles); `item_key` text; `flares` text[]; `price_credits` bigint; `catalog_version` text (hash of the catalog file); `created_at`.
- Index `(user_id, created_at DESC)`.

Item definitions are **not** a table in V1: they live in `src/account-api/catalog/cosmetics.json`, validated against `CosmeticsSchema` at startup (section 9.3).

### 6.3 Games and stats

**`games`**

| Field                                            | Notes                                                   |
| ------------------------------------------------ | ------------------------------------------------------- |
| id bigserial PK                                  | Exposed as `gameId` BigIntString in stats `recentGames` |
| game_code varchar(10) UNIQUE NOT NULL            | The client game ID                                      |
| source                                           | `server` \| `singleplayer`                              |
| type                                             | Public / Private / Singleplayer                         |
| mode, difficulty, map, player_teams, ranked_type | From the record config                                  |
| public_game_type                                 |                                                         |
| started_at, ended_at, duration_s                 |                                                         |
| human_players int                                |                                                         |
| winner jsonb                                     |                                                         |
| git_commit, server_letter                        |                                                         |
| counts_for_stats bool                            | Rules in section 8.3                                    |
| created_at                                       |                                                         |

Index `(started_at DESC)`.

**`game_records`**

- Fields: `game_id` PK FK; `record_gz` bytea (gzipped `GameRecord` JSON); `bytes` int; `expires_at` NULL (retention, e.g. 30–90 days).

**`game_players`**

- Fields: `game_id` FK; `client_id` text; `user_id` uuid NULL FK (resolved from `persistentID`); `username` text; `clan_tag` text NULL; `clan_id` bigint NULL (set only if the user was a member of that tag's clan at game start); `result` text CHECK (`victory`,`defeat`,`incomplete`); `completed` boolean NOT NULL (section 9.5); `credits_awarded` bigint NOT NULL DEFAULT 0; `stats` jsonb (`PlayerStats`).
- PK `(game_id, client_id)`; indexes `(user_id, game_id DESC)`, `(clan_id, game_id DESC)` and `(user_id) WHERE completed` (clan threshold count).

**`player_stat_aggregates`**

- Fields: `user_id`; `game_type`; `mode`; `difficulty`; `wins`; `losses`; `total` bigint; `stats` jsonb (element-wise sum of `PlayerStats`); `updated_at`.
- PK `(user_id, game_type, mode, difficulty)`.

**`leaderboard_players`**: a materialized view or table refreshed every few minutes (section 11).

### 6.4 Clans

**`clans`**

- Fields: `id` bigserial PK; `tag` citext NOT NULL (stored upper-case); `name` citext NOT NULL; `description` text DEFAULT '' (≤200); `discord_url` text NULL; `is_open` bool DEFAULT true; `created_by` uuid FK; `created_at`; `disbanded_at` NULL; `removed_by_admin` bool DEFAULT false.
- UNIQUE `(tag)` WHERE `disbanded_at IS NULL`; UNIQUE `(name)` WHERE `disbanded_at IS NULL`.

**`clan_members`**

- Fields: `clan_id` FK; `user_id` FK; `role` text CHECK (`leader`,`officer`,`member`); `joined_at`.
- PK `(clan_id, user_id)`; **UNIQUE `(user_id)`** (one clan at a time, D2: membership and therefore ownership); UNIQUE `(clan_id)` WHERE `role = 'leader'` (exactly one leader).

**`clan_join_requests`**

- Fields: `clan_id`; `user_id`; `created_at`.
- PK `(clan_id, user_id)` (pending only; rows deleted on decision, and all of a user's requests deleted when they join any clan); at most `CLAN_RULES.maxPendingRequests` per user (checked in the transaction).

**`clan_bans`**

- Fields: `clan_id`; `user_id`; `banned_by`; `reason` NULL; `created_at`.
- PK `(clan_id, user_id)`.

**`clan_tag_holds`**: blocks reuse of a disbanded clan's tag so it cannot be impersonated in replays and history.

- Fields: `tag` citext PK; `released_at`; `reusable_after`.

**`clan_events`**: audit of joins, kicks, promotions, transfers and renames.

- Fields: `id`; `clan_id`; `actor`; `action`; `target` NULL; `details` jsonb; `created_at`.

### 6.5 Servers and admin

**`game_servers`**

- Fields: `site`; `letter`; `host`; `version`; `num_workers`; `live_games`; `machine` NULL; `state` (`open`/`draining`/`fenced`, admin-set, default `open`); `last_checkin_at`.
- PK `(site, letter)`.

**`server_api_keys`**

- Fields: `id`; `name`; `key_hash` bytea UNIQUE; `created_at`; `revoked_at` NULL.

**`admin_audit_log`**

- Fields: `id`; `actor` text (OS user or admin uuid); `action`; `target_type`; `target_id`; `details` jsonb; `created_at`.

### 6.6 Relationships

```
users 1─* auth_identities, refresh_sessions, bans, user_flares, purchases, currency_ledger, game_players, clan_members
users 1─1 wallets
games 1─* game_players; games 1─1 game_records
clans 1─* clan_members, clan_join_requests, clan_bans, clan_events; game_players *─1 clans (clan_id)
```

Deferred tables, not in V1: `magic_link_tokens` (M8), friends, progression/XP, rewards, subscriptions, creator codes, tribe names, clan wallets and donations, ranked Elo.

---

## 7. Authentication plan

### 7.1 Methods (D3)

| Method                                | Present in client                         | Decision                                                                      |
| ------------------------------------- | ----------------------------------------- | ----------------------------------------------------------------------------- |
| Guest session (refresh mints a guest) | yes (contract)                            | **V1 (M1)**                                                                   |
| Discord OAuth                         | yes, button on web                        | **V1 (M1)**                                                                   |
| Google OAuth                          | yes, button on web                        | **V1 (M1)**                                                                   |
| Email magic link                      | yes, field on web and in account settings | **Later (M8).** UI hidden in V1; architecture preserved (7.4)                 |
| Steam web OpenID                      | yes, button                               | Hidden; deferred                                                              |
| Steam desktop ticket / CrazyGames     | yes                                       | Deferred (no desktop shell / CrazyGames launch planned)                       |
| Username/password                     | **no**                                    | Not in V1 (owner decision); could be added later as another identity provider |

### 7.2 What this means for the client

- **No sign-in redesign.** `AccountModal.renderLoginOptions` already renders Discord, Google, Steam, an "or" divider and an email field.
- **One provider switch.** A shared `AUTH_PROVIDERS` constant (`{ discord: true, google: true, email: false, steam: false }`, section 17.1) hides the Steam button, the divider and the email field in `AccountModal`. It also hides the email field in `components/AccountSettingsPanel.ts` (`renderEmailField`, which calls `sendMagicLink`).
- **No email infrastructure** in V1 (D4).
- **Account recovery** is the linked Discord or Google account. A guest who never links loses the account if their cookies are cleared; the existing not-signed-in warning UI (`components/NotLoggedInWarning.ts`) covers the messaging.

### 7.3 Flows

**Single sign-in funnel.** Every provider ends in one function:

```ts
// src/account-api/auth/signIn.ts
completeSignIn(
  identity: { provider: "discord" | "google" | "email" | "steam"; providerUserId: string;
              email: string | null; emailVerified: boolean; profile: unknown },
  currentSession: Session | null,
): Promise<{ user: User; outcome: "signed_in" | "upgraded_guest" | "email_exists" | "deleted" }>
```

The Discord and Google callbacks use it in V1. The M8 magic-link token endpoint will use it unchanged (section 7.4).

**Guest (`POST /auth/refresh` with no or invalid cookie, valid origin):**

1. Rate-limit by IP (section 14).
2. In one transaction, insert a `users(kind='guest', public_id)` row and a `wallets` row, and create a session family.
3. Set the cookie and return `{ jwt, expiresIn: 900 }`.

Guests can play multiplayer in production and earn stats and Credits from completed games. They **cannot** purchase, create or join clans, or rename: the server refuses with 403 `{ code: "LOGIN_REQUIRED" }`, and the client shows its existing sign-in prompts (verify per screen).

The client calls `logOut()` on a 401 from `/auth/refresh`, so for a visitor with no cookie the API must answer **200 with a new guest**, not 401. The only 401 is for a presented cookie that is revoked, expired or reused, which clears the cookie. The next refresh then mints a new guest.

**OAuth (Discord, Google), `GET /auth/login/<p>?redirect_uri=`:**

1. Validate `redirect_uri` against the allowed origins (exact origin match, `https`, or `http://localhost:*` in dev).
2. Store `oauth_states` (state + PKCE verifier + redirect) and 302 to the provider. Scopes: Discord `identify email`; Google `openid email profile`.
3. The callback `GET /auth/callback/<p>` checks the state, exchanges the code, reads the profile and calls `completeSignIn`:
   - **Identity already exists** → sign in to that user. If the current cookie belonged to a guest that has no games, purchases or clans, the guest is marked for cleanup; otherwise it is left as is. **We never merge accounts.**
   - **Identity is new and the current cookie is a guest** → attach the identity to the guest and set `kind='registered'`. The player keeps the stats and Credits they earned as a guest.
   - **Identity is new and the verified email belongs to a different account** → `#login=email_exists` (we never auto-merge by email, same as the client copy).
   - **Account is queued for deletion** → `#login=deleted`.
   - **Provider denied** → `#login=cancel`. **Verification failed** → `#login=error`.
4. Rotate the session (a new family for the signed-in user), set the cookie, and 302 to `redirect_uri`.

**Link Google to a signed-in account (`GET /auth/link/google`):** bearer plus cookie. Returns `{ url }`. The callback attaches the identity, or returns `#login=email_exists` if it is held by another account. Discord accounts can link Google, and Google accounts can sign in with Discord only if Discord is not yet attached elsewhere. There is no Discord link endpoint in the client contract, so none is added.

**Refresh rotation and reuse detection:**

- Each refresh replaces the token (new row, `parent_id` = old row) and revokes the old one.
- Presenting a revoked token **after** a 10-second grace window revokes the whole family (theft signal) and returns 401.
- Within the grace window, return the already-rotated child's new token **only** if the request comes from the same `user_agent` and IP hash. Multiple tabs refreshing at once are normal (each tab has its own in-memory `__refreshPromise`).

**Logout and revoke:** `/auth/logout` revokes the current family; `/auth/revoke` revokes all of the user's sessions. Both clear the cookie.

### 7.4 Keeping magic links addable later (M8)

V1 must not close the door on email sign-in:

- **Identity provider.** `auth_identities.provider` already allows `email` (with `provider_user_id` = lower-cased email, `email_verified = true`).
- **Sign-in funnel.** `completeSignIn` already covers the email outcomes (guest upgrade, `email_exists`, link mode via `currentSession`).
- **Database.** The `magic_link_tokens` table (section 6.1) is **not** created in `0001_init.sql`. M8 adds it in its own migration.
- **Endpoints.** `/auth/magic-link` and `/auth/login/token` are **not routed** in V1 (404). The client never calls them, because `AUTH_PROVIDERS.email` is false. The client code (`sendMagicLink`, `tempTokenLogin`, `TokenLoginModal`, the `#token-login` route in `Main.ts`) is kept unchanged so M8 is backend-only plus flipping `AUTH_PROVIDERS.email`.
- **M8 work:** email provider adapter, `POST /auth/magic-link { email, redirectDomain }` (always 204), the emailed link `https://<redirectDomain>/#token-login?token-login=<token>`, and `GET /auth/login/token` (200 `{ email }` or 400 `consumed|expired|invalid`). Rate limits are in section 14.3.

### 7.5 Tokens and keys

- **JWT.** EdDSA (Ed25519) via `jose`.
  - Claims: `{ jti, sub: uuidToBase64url(user.id), iat, exp: iat+900, iss: "https://api.<DOMAIN>", aud: "<DOMAIN>", role?, provider? }`.
  - `role` is `"banned"` when an active ban exists. `provider` is `"guest"`, `"discord"`, `"google"` or `"email"` (the client and server treat unknown strings as fine).
- **Issuer must equal what the client computes.** In dev that is `http://localhost:8787`, with `DOMAIN=localhost`.
- **JWKS.** `/.well-known/jwks.json` returns `{ keys: [current, previous?] }`, each with a `kid`. The **current key must be first**, because the game server uses `keys[0]` (section 14.1 covers the rotation fix).
- **Private keys** live in a file or env secret on the API host only, never in the repo and never in the browser bundle.
- **Refresh cookie:**

  ```
  Set-Cookie: df_refresh=<opaque 32-byte base64url>; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=2592000
  ```

  Host-only on `api.<DOMAIN>`. Because `<DOMAIN>` and `api.<DOMAIN>` are same-site, `SameSite=Lax` cookies are sent with the client's `credentials: "include"` fetches.

---

## 8. Profile and stats plan

### 8.1 `/users/@me` for V1

Built from one query over users, identities, wallet, flares, clan memberships, pending clan requests and the active ban.

| Field                                                        | V1 value                                                                                   |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------ |
| `user`                                                       | `{ discord?, google?, email? }` from identities                                            |
| `ban`                                                        | the active ban or `null`                                                                   |
| `player.publicId`                                            |                                                                                            |
| `player.adfree`, `unlimitedRanked`, `canCreatePublicLobbies` | `false`                                                                                    |
| `player.trustTier`                                           | Computed (section 14.6)                                                                    |
| username fields                                              | From `users`; `usernameStatus: "unclaimed"`                                                |
| `player.flares`                                              | Active `user_flares` (plus default flares, section 10)                                     |
| `player.achievements`                                        | `{ singleplayerMap: [], player: [] }`                                                      |
| `player.currency`                                            | `{ soft: <Credits balance>, hard: 0 }` (D1)                                                |
| `player.clans`, `player.clanRequests`                        |                                                                                            |
| `player.friends`                                             | `[]`                                                                                       |
| `player.subscription`                                        | `null`                                                                                     |
| `player.levelHidden`                                         |                                                                                            |
| Omitted                                                      | `progress`, `rewards`, `marketingConsent`, `creator`, `leaderboard` (UIs hide when absent) |

Latency budget: under 30 ms at p95. It is on the critical path of every multiplayer join.

### 8.2 Usernames (`PUT /users/@me/username`)

- **Validation.** Use the same charset the wire accepts (`engine-api/Schemas.ts` username schema; the account base must be representable there). Base length is 3–20, no dots.
- **Screening.** `obscenity` + DeltaFront's blocklist, refusing with `USERNAME_PROFANE`.
- **Discriminator.** A random 4-digit discriminator; retry on collision.
- **Cooldown.** 7 days, returned as `nextUsernameChangeAt`.
- Bare (premium) names are not offered in V1, so `BARE_NAME_TAKEN` never occurs.
- Guests get 403 `LOGIN_REQUIRED`.

### 8.3 Stats ingestion (`POST /game/:gameID`, `x-api-key`)

1. **Authenticate** the key against `server_api_keys`. Parse the body with `GameRecordSchema` and require the path id to equal `info.gameID`.
2. **Idempotency.** If `games.game_code` exists, return 200 and do nothing.
3. **Store.** Insert `games` and `game_records` (gzip).
4. **Resolve players.** For each `info.players[i]`, resolve `persistentID` → `users.id`; skip null, unknown or deleted users. Compute `result` from `info.winner`:
   - `victory` if the player's clientID is in the winner list;
   - `defeat` if the game had a winner and they are not in it;
   - `incomplete` if there is no winner.
   - Resolve `clan_id` only if that user was a member of the clan with that tag at `info.start`.
5. **Decide `counts_for_stats`.** True only when all hold: `source = server`; `type = Public`; at least 2 human players with accounts; `duration_s` ≥ 120; `gitCommit` is a known build (optional). Private games are stored and shown in history, but excluded from leaderboards, Credits and the clan threshold (easy to farm with alt accounts).
6. **Decide `completed`** per player (definition in section 9.5) and store it on `game_players`.
7. **Update `player_stat_aggregates`** (wins, losses, total, element-wise `PlayerStats` sum) for every resolved player with `counts_for_stats`, plus the Private bucket for private games (profile only).
8. **Award Credits** (section 9.5) in the same transaction, and store the amount on `game_players.credits_awarded`.

Singleplayer (`POST /archive_singleplayer_game`, bearer, gzip): store it with `source = singleplayer` and `counts_for_stats = false`, and keep it only for the Singleplayer profile tree and (later) map achievements. Cap at 50 per user per day. Implement in M2 or defer; it isn't needed for any V1 acceptance criterion.

### 8.4 Profile reads

- **`GET /public/player/:publicId`** → `PlayerProfileSchema`:
  - `createdAt`; `username`; `user` (Discord profile if linked);
  - `stats: PlayerStatsTree`, built from aggregates as `{ Public: { [mode]: { [difficulty]: Leaf } }, Private: …, Singleplayer: … }`;
  - `recent`, computed on read from the last 100 `game_players` rows;
  - `clans`.
  - `Ranked` is omitted.
- **`GET /player/:publicId`** (bearer) returns the same.
- **`GET /public/player/:publicId/games`** uses keyset pagination on `(game_id DESC)`, with filters mapped from `PlayerGameModeFilter`/`PlayerGameTypeFilter`.

`PlayerStats` summation is a pure function in `src/account-api/domain/stats.ts`, with unit tests. All `PlayerStatsSchema` fields are arrays of bigint (or BigIntString on the wire); sum them element-wise and pad the shorter array with zeros.

---

## 9. Store plan

### 9.1 What the existing store expects

- **Tabs** (fixed, `Store.ts:105`): `packs` (currency packs, real money), `subscriptions` (real money), `bundles` (`packs` in the catalog, priced in hard currency only: `CosmeticPackSchema.priceHard`), `cosmetics` (patterns, flags, crowns, skins sub-tabs), `effects`, `tribes` (custom tribe names, hard currency).
- **Prices** come from the catalog item: `priceSoft` and/or `priceHard`. `cosmeticRelationship` (`Cosmetics.ts:934`) marks an item owned (flare present), purchasable (has a price and the affiliate code matches) or blocked.
- **Purchase.** `purchaseCosmetic` → `POST /shop/purchase` or `/shop/purchase/pack` → then `broadcastFreshUserMe()` to refresh flares and balances.
- **Currency display.** `components/CurrencyDisplay.ts` renders `hard` (Plutonium icon, `cosmetics.hard`) and `soft` (bottle-cap icon `CapIcon`, `cosmetics.soft`) from `player.currency`, used by `Store.renderHeader`, `AccountModal`, purchase buttons and others.
- **Stripe** is imported (`@stripe/stripe-js`, `StripeInline.ts`), but only on the payments, subscription and currency-pack paths.

### 9.2 V1 currency: Credits (D1)

There is one currency, and it travels in the existing **`soft`** slot of every contract:

| Contract field                       | V1 meaning                                                             |
| ------------------------------------ | ---------------------------------------------------------------------- |
| `/users/@me` `player.currency.soft`  | Credits balance                                                        |
| `/users/@me` `player.currency.hard`  | Always `0` (the schema requires the field)                             |
| Catalog `priceSoft`                  | Price in Credits                                                       |
| Catalog `priceHard`                  | Never set                                                              |
| `POST /shop/purchase` `currencyType` | Must be `"soft"`; `"hard"` → 400 `{ reason: "Currency not accepted" }` |

**Why reuse `soft`:** no contract change. Every store, purchase and balance path already handles it. Only the player-facing name and icon change.

Client changes (small):

- **Label.** In `resources/lang/en.json`, `cosmetics.soft` becomes **"Credits"**. In the other locale files, remove the localized `cosmetics.soft` value so they fall back to English "Credits" (`LangSelector` falls back to `defaultTranslations`); do not machine-translate.
- **Icon.** A new original `resources/images/CreditsIcon.svg` (simple DeltaFront red/white mark) and `<credits-icon>` replace `CapIcon` for the soft amount in `CurrencyDisplay`. The bottle-cap icon is upstream branding for "Caps" and is not reused for Credits.
- **Hide the premium currency.** `CurrencyDisplay` and every other hard-currency surface render only when `ACCOUNT_FEATURES.payments` is on, because the premium currency only exists with real-money payments. Surfaces to cover: `PurchaseButton`, `CustomCurrencyCard`, clan donation views, `TribesPanel`, `HostLobbyModal` queue price, `PrestigeFlow`, `RewardsPanel`; most are already behind V1-off flags.
- **Audit.** Every remaining `en.json` string that says "Caps" or "Plutonium" must be unreachable in V1 (behind `payments`, `progression`, `tribes`, or clan donations). Add a test that asserts this list (section 19).

**Server authority:**

- Balances change only inside the API: game rewards (ingestion, server key), purchases (price from the server's catalog) and admin grants (CLI).
- No endpoint accepts an amount from a player.
- `wallets.credits` has `CHECK ≥ 0`, and every change writes the append-only ledger.

### 9.3 DeltaFront catalog (D6)

**Data-driven by design.** `src/account-api/catalog/cosmetics.json` is the single source of item definitions and prices:

- **Validation at startup.** It is validated with the client's own `CosmeticsSchema`; the process refuses to start if it is invalid.
- **Serving.** It is served at `GET /cosmetics.json` (`Cache-Control: public, max-age=300`, ETag).
- **Assets.** Images live next to it in `src/account-api/catalog/assets/` and are served by the API at `/cosmetics/assets/<file>` with long-lived caching (versioned file names). The catalog stores relative asset paths; the API expands them to absolute URLs (`<API_PUBLIC_ORIGIN>/cosmetics/assets/<file>`) when it loads the file. The client uses `url` fields directly as image sources.
- **Adding an item is data only:**
  1. add an entry (and an asset if it has one);
  2. optionally add a localized display name (`translateCosmetic` falls back to the title-cased catalog name, e.g. `delta_stripes` → "Delta Stripes");
  3. deploy the API.

  No store, inventory or server code changes.

- **V1 omits** `currencyPacks`, `subscriptions`, `tribeNames`, `lobbyQueue`, `skins`, `crowns` and `packs` (bundles are hard-currency-only in the contract). Every item has `product: null` and only `priceSoft`.

**Content rules** (enforced by review and by the catalog test in section 19):

- Only items made for DeltaFront.
- No OpenFront catalog entries, artwork, paid products, product names or backend-provided assets, and nothing recreated to look like them.
- Assets are simple, original geometric designs in the DeltaFront palette (black, white, red), listed in `CREDITS.md` as DeltaFront placeholder assets under the repo's asset licence.

**Initial placeholder set** (development and testing; names and prices are placeholders the owner can change):

| Type                          | Catalog name    | Display       | Asset / data                                                                       | Price (Credits)                         |
| ----------------------------- | --------------- | ------------- | ---------------------------------------------------------------------------------- | --------------------------------------- |
| Pattern                       | `delta_stripes` | Delta Stripes | Diagonal stripe bitmap; palettes `ember` (red on black) and `ash` (white on black) | `ember`: 300; `ash`: **free (default)** |
| Pattern                       | `grid_check`    | Grid Check    | Checkerboard bitmap; palette `ember`                                               | 500                                     |
| Flag                          | `delta_mark`    | Delta Mark    | `delta_mark.svg`: red triangle on black                                            | 400                                     |
| Flag                          | `split_field`   | Split Field   | `split_field.svg`: black/white halves with a red bar                               | 400                                     |
| Effect (`transportShipTrail`) | `red_wake`      | Red Wake      | No asset: gradient attributes `["#e31b23", "#f5f5f5"]`                             | 600                                     |

- **Pattern data.** Pattern data is the base64url format `decodePatternData` (`packages/shared/src/PatternDecoder.ts`) reads. Generate it with a small script, `scripts/cosmetics/encode-pattern.ts`, that encodes a tiny bitmap; its test round-trips through `decodePatternData`.
- **Palettes** go in the catalog's `colorPalettes`, with the patterns' `colorPalettes` entries `isArchived: false`.

### 9.4 Purchase flow (`POST /shop/purchase`)

1. Require a registered (non-guest), non-banned user.
2. Require `currencyType === "soft"`.
3. Look up the item and its `priceSoft` in the **server's** catalog from `(cosmeticType, cosmeticName, colorPaletteName)`. The client never sends a price. An item with no `priceSoft` (unknown, or free/default) → 400 `{ reason: "Item not for sale" }`.
4. Build the flare: `pattern:<name>:<palette>` (palette required unless the pattern has none), `flag:<name>`, `effect:<name>`.
5. In one transaction:
   - `SELECT credits FROM wallets WHERE user_id=$1 FOR UPDATE`;
   - if the flare is owned (or a default) → 409;
   - if credits are below the price → 400 `{ reason: "Insufficient balance" }` (the client's existing message);
   - debit, insert `currency_ledger(-price, reason 'purchase')`, `purchases` and `user_flares`.
6. Return 200 `{}`. The client then re-fetches `/users/@me` (existing behaviour).

`POST /shop/purchase/pack` is **not implemented** in V1. The bundles tab is hidden because the catalog has no `packs` (section 17.1).

### 9.5 Earning Credits (D1)

Constants, the only place the values live:

```ts
// src/account-api/domain/constants.ts
export const ECONOMY = {
  currencyName: "Credits",
  completedGameReward: 100, // Credits per completed game
  winBonus: 250, // additional Credits for a win
  dailyGameplayCap: 1_000, // max Credits from gameplay per UTC day
  minEliminationTick: 1_200, // an elimination before 2 minutes (10 ticks/s) is not a completed game
} as const;
```

**Completed game**, used for Credits and for the clan threshold (D2). A player completed a game when all of these hold:

1. The game is **counted** (`counts_for_stats`, section 8.3: server-submitted, Public, at least 2 human accounts, at least 120 s).
2. The game **ended with a winner** (`info.winner` present).
3. The player **survived to the end** (`stats.finalTiles` set) **or was eliminated** (`stats.killedAt` set) at or after `minEliminationTick`.
4. The player was **connected** at that moment: in `turns`, the latest `mark_disconnected` intent for their clientID up to the end turn (survivor) or the `killedAt` tick (eliminated) is absent or `isDisconnected: false`.

**Award at ingestion**, for each resolved player in the same transaction as the stats:

```
earned  = completed ? completedGameReward + (result == victory ? winBonus : 0) : 0
today   = SUM(delta) FROM currency_ledger WHERE user_id = $u AND reason = 'game_reward' AND reward_day = <UTC day of games.ended_at>
grant   = clamp(earned, 0, dailyGameplayCap - today)
if grant > 0: wallets.credits += grant; ledger(+grant, 'game_reward', ref = game_code, reward_day)
game_players.credits_awarded = grant
```

- **Locking.** The wallet row is locked (`FOR UPDATE`) before the daily sum, so concurrent ingestions cannot exceed the cap.
- **Idempotency.** The unique ledger index on `(user_id, ref_type, ref_id)` makes re-posting a record pay nothing.
- **Guests earn too,** and keep their Credits when they link Discord or Google (guest upgrade, section 7.3).
- **No claim step.** The existing `rewards[]` field and `/rewards/*` endpoints stay unused (`rewards` omitted, UI hidden by `progression`).

### 9.6 Real-money purchases (later, separate)

Real-money purchases are not in V1. They need a premium currency or direct product sales, Stripe Checkout and webhooks (`/payments/checkout` contract), tax and VAT, refunds and chargebacks (the client already handles negative-balance debt refusals), and terms updates. Keep the `payments` flag off until then. Adding them is a new, reviewed design, including whether a premium currency exists at all.

---

## 10. Inventory plan

- **No new architecture.** Ownership = `user_flares`, surfaced as `/users/@me` `flares`. Inventory (`InventoryModal.ts`) and Store read catalog + flares exactly as today.
- **Equip/unequip stays client-side, as the existing design intends.** The selection is stored per account in localStorage (`UserSettings` scoped by `publicId`) and sent with every join as `PlayerCosmeticRefs`. The game server enforces ownership (`Privilege.isAllowed`) against fresh `/users/@me` flares and closes the join if anything is unowned. The client pre-filters unowned selections (`getPlayerCosmeticsRefs`) so that does not happen in normal use.
  - Trade-off: the loadout does not follow the player to another device.
  - If that is wanted later, add **new** `GET`/`PUT /users/@me/loadout` and have `getPlayerCosmeticsRefs` prefer it. Not V1.
- **Default flares.** Free items everyone owns (in V1: `pattern:delta_stripes:ash`, section 9.3; optionally `color:` flares for free colours) are marked in the catalog config and returned in `flares` for every user, guests included, not stored per user.
- **Catalog content** is DeltaFront-owned and data-driven (D6, section 9.3).
- **Cosmetic propagation into multiplayer** already works once the catalog and flares exist:
  - the server resolves refs into `PlayerCosmetics` (pattern data, flag URL, skin URL, effects);
  - they go into `GameStartInfo.players[].cosmetics`;
  - every client renders them.
  - Nothing new is needed beyond serving `/cosmetics.json` and `/reserved_clan_tags` (both required by `PrivilegeRefresher`; serve `[]` for tags before clans exist).
- **Revoking an item** (admin): set `user_flares.revoked_at`. The next join drops it; the client clears the local selection when the flare disappears (existing behaviour in `getPlayerCosmeticsRefs`).

---

## 11. Leaderboard plan

### 11.1 What exists

- **`LeaderboardModal.ts` tabs:**
  - `players`, `players2v2`, `playersFfa`: ranked Elo ladders from `GET /leaderboard/ranked?page=`;
  - `clans`: `GET /public/clans/leaderboard`;
  - `tribes`: `GET /leaderboard/tribes`.
- **Pagination.** `page=N`; the server signals the end with 400 and a page-bounds message (`isPageBoundsMessage`).
- **Display rows.** `LeaderboardPlayerList` renders `PlayerLeaderboardEntry { rank, playerId, accountUsername, flag?, elo, games, wins, losses, winRate }`. The schema `PlayerLeaderboardResponseSchema { players: Entry[] }` exists, but no fetcher uses it.

### 11.2 Basic global leaderboard (V1), separate from ranked

- **New endpoint:**

  ```
  GET /leaderboard/players?page=N&period=all|30d
  → PlayerLeaderboardResponseSchema
  ```

  - `playerId` = publicId.
  - `elo` becomes **optional** in `PlayerLeaderboardEntrySchema`. This is a client-internal display type, and making the field optional changes nothing for ranked rows. Omit it here, and the list hides that column when absent.

- **Ranking.** Over `counts_for_stats` games only. Eligibility: ≥ 10 counted games in the period.
  - Order by `wins DESC`, then `winRate DESC`, then `games DESC`, then `public_id ASC` (deterministic).
  - Competition ranking (1, 2, 2, 4) on `(wins, winRate)`.
- **Query strategy.**
  - A `leaderboard_players` table rebuilt every 5 minutes by a timer inside the API process (a single instance in V1; use `pg_try_advisory_lock` so a second instance would skip).
  - It is computed from `game_players JOIN games` for the period.
  - Pages of 50 come from the precomputed rank (`WHERE rank_pos BETWEEN …`).
  - The response sends `Cache-Control: public, max-age=60`.
  - The page cap is 20 pages; beyond that, return 400 with the page-bounds message the client recognises.
- **Clan leaderboard** (`/public/clans/leaderboard`), last 30 days by default:
  - A clan "game" is a counted game where ≥ 1 player had a validated `clan_id`. The clan wins if any such player won.
  - `playerSessions` = number of member appearances.
  - `weightedWins`/`weightedLosses` weight each game by `min(5, max(0.5, human_players / 10))`.
  - `weightedWLRatio = weightedWins / max(1, weightedLosses)`.
  - Returned with `start`, `end`, `total`, `limit`, sorted by `weightedWLRatio DESC`, then `games DESC`.
- **Ranked and tribe tabs** are hidden by flags (`ranked`, `tribes`) until those systems exist.
- **Anti-cheat:**
  - only server-submitted public games count; private and singleplayer never do;
  - the winner is the server's (vote plus replay);
  - minimum human players and duration apply;
  - an admin can mark a game `counts_for_stats=false` and rebuild aggregates (`admin game:void`);
  - flagged or banned users are excluded from boards.

---

## 12. Clan plan

### 12.1 Existing UI and behaviour (reuse everything)

- **Views:** browse/search, detail, members (with stats and sorting), manage, join requests (approve/deny), my requests (withdraw), bans, transfer leadership, game history, map view, stats breakdown, donations (`src/client/components/clan/*`).
- **Roles** (fixed by schema): `leader`, `officer`, `member`. There are no "invites"; the model is **open join** (`isOpen`) or **request → approve**.
- **Tags:** 2–5 alphanumerics (`ClanTagSchema`), case-insensitive. Players pick one of their clans' tags (or a free fictional tag) in `UsernameInput`. The game server enforces the tag via `/reserved_clan_tags` + `/users/@me` `clans`.

### 12.2 Missing: create clan (new contract) and membership rules (D2)

Constants, in the same module as `ECONOMY`:

```ts
// src/account-api/domain/constants.ts
export const CLAN_RULES = {
  createMinAccountAgeDays: 3,
  createMinCompletedGames: 10, // "completed game" as defined in section 9.5
  maxClansPerMember: 1, // also enforced by UNIQUE clan_members(user_id)
  maxOwnedClans: 1,
  maxPendingRequests: 3,
  disbandedTagHoldDays: 90,
  nameChangeCooldownDays: 30,
} as const;
```

`maxClansPerMember: 1` is backed by a database unique index (section 6.4), so raising it later needs a migration as well as a constant change. That is intentional, because the database must not allow a second membership through a race.

**Create clan endpoint:**

```
POST /clans  { name, tag, description?, isOpen? }
→ 201 ClanInfo
```

- 400 `{ code: "INVALID_TAG" | "INVALID_NAME" | "NAME_PROFANE" }`
- 409 `{ code: "TAG_TAKEN" | "NAME_TAKEN" | "TAG_HELD" }`
- 403 `{ code: "LOGIN_REQUIRED" | "BANNED" | "ALREADY_IN_CLAN" | "ACCOUNT_TOO_NEW" | "NOT_ENOUGH_GAMES", required?: number, current?: number }`
- 429

**Create rules:**

- Registered (not a guest) and not banned.
- `now - users.created_at ≥ createMinAccountAgeDays`.
- `COUNT(game_players WHERE user_id AND completed) ≥ createMinCompletedGames`.
- **Not currently in any clan.** Because of the one-clan rule this covers both "already a member" and "already owns a clan".
- Tag and name pass `ClanTagSchema` (2–5 alphanumerics) / the 35-character name limit, `obscenity` screening, and the reserved list (`ADMIN`, `MOD`, `DEV`, `STAFF`, `DF`, `DELTA`, …).
- The creator becomes `leader`. Their pending join requests elsewhere are deleted.

**One clan at a time on the existing endpoints:**

- **`POST /clans/:tag/join`** while in a clan → 409 `{ code: "ALREADY_IN_CLAN", message: "Already in a clan" }`.
  - The client's 409 handler maps any message without "request" to `clan_modal.error_already_member`.
  - Add a small client change: map `code === "ALREADY_IN_CLAN"` to a new string `clan_modal.error_already_in_clan` ("Leave your current clan first").
- **Join requests.** A player outside a clan may have up to `maxPendingRequests` pending requests.
- **Approve.** Joining any clan (open join, approval, creation) deletes all of that player's other pending requests. Approving a request whose player has meanwhile joined another clan → 409 `ALREADY_IN_CLAN`, and the request is removed.
- **`/users/@me` `clans`** stays an array (contract) with at most one element.

**Client (create flow):**

- `ClanApi.createClan()`, and a "Create clan" button + form in `ClanBrowseView`, shown only to registered players.
- New `clan_modal.create_*` strings in `en.json`. `ACCOUNT_TOO_NEW` and `NOT_ENOUGH_GAMES` messages show the requirement (`{days}`, `{games}`, current count) using the response's `required` and `current` fields.

### 12.3 Permissions (server-side, in `domain/clans.ts`)

| Action                                        | Leader              | Officer          | Member | Notes                                                                                                                                |
| --------------------------------------------- | ------------------- | ---------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| PATCH name                                    | ✓                   |                  |        | Name change screened; 30-day cooldown                                                                                                |
| PATCH description, discordUrl, isOpen         | ✓                   | ✓                |        | Discord URL validated (`discord.gg` / `discord.com/invite`) → `DISCORD_INVALID`                                                      |
| Approve/deny requests                         | ✓                   | ✓                |        |                                                                                                                                      |
| Kick                                          | ✓ (anyone but self) | ✓ (members only) |        |                                                                                                                                      |
| Ban/unban                                     | ✓                   | ✓ (members only) |        | Ban also removes membership and pending request                                                                                      |
| Promote member→officer, demote officer→member | ✓                   |                  |        |                                                                                                                                      |
| Transfer leadership                           | ✓                   |                  |        | Target must be a current member; old leader becomes officer                                                                          |
| Disband                                       | ✓                   |                  |        | Sets `disbanded_at`, deletes memberships, writes a `clan_tag_holds` row (90 days)                                                    |
| Leave                                         | ✓\*                 | ✓                | ✓      | \*A leader with other members gets 409 `{ code: "TRANSFER_REQUIRED" }` (UI has `select_new_leader`). A sole member leaving disbands. |
| View games/requests/bans                      | members / officers+ |                  |        | Games: members only (403 otherwise, as the client expects)                                                                           |

All actions verify `(clan_id, actor)` membership and role inside the same transaction as the change, with `SELECT … FOR UPDATE` on the clan row. Leader uniqueness is guaranteed by the partial unique index.

### 12.4 Edge cases

| Case                                     | Handling                                                                                                |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Duplicate tag/name                       | Case-insensitive partial unique indexes; disbanded tags held for `CLAN_RULES.disbandedTagHoldDays` (90) |
| Second clan                              | Refused: `ALREADY_IN_CLAN` on create, join and approve; `UNIQUE clan_members(user_id)` stops races      |
| Banned (site) user                       | 403 on every clan write                                                                                 |
| Banned from the clan                     | 403 `BANNED` on join                                                                                    |
| Owner leaving                            | Must transfer first; a sole member leaving disbands                                                     |
| Owner account deleted                    | Auto-transfer to the oldest officer, else the oldest member, else disband                               |
| Abandoned clan (leader inactive 60 days) | Admin `clan:transfer` or `clan:disband`; no automatic action in V1                                      |
| Inappropriate names                      | Screened on create and rename; admin `clan:remove` (marks `removed_by_admin`, holds the tag)            |
| Spoofed tag in game                      | Existing server enforcement via `reserved_clan_tags` (all active and held tags)                         |

### 12.5 Clan tag in game

No change: once `/reserved_clan_tags` returns active plus held tags and `/users/@me` returns `clans[].tag`, `Privilege.decideClanTag` keeps members' tags, keeps fictional ones and drops impersonations. `join_verify` may also return the screened `clanTag`.

---

## 13. Website and navigation plan

- **Use the existing nav.** `DesktopNavBar.ts` already renders PLAY / STORE / INVENTORY / LEADERBOARD / CLANS and the account menu, each gated by its flag, using the DeltaFront nav classes (red active underline, pixel font), as in the current homepage screenshot. Turning a flag on makes the item appear; no new nav component is needed. Check `MobileNavBar.ts` the same way.
- **Remaining blue styles** (from upstream) to restyle to `--color-df-*` tokens when each section ships:
  - `AccountModal` login buttons: keep the Discord and Google brand colours (required by their brand guidelines), but the frame uses `df` tokens already;
  - store, inventory and clan cards: audit for `blue-*` Tailwind classes;
  - `CLAUDE.md` rule: red for primary actions, selection, focus.
- **Guest state:**
  - The nav shows a **Sign in** control (`NavAccountButton`) and STORE, LEADERBOARD and CLANS.
  - Store and clan pages are browsable. Buy, equip-a-paid-item, create, join and rename prompt sign-in (server enforces `LOGIN_REQUIRED`).
  - INVENTORY shows free/default items plus the existing "sign in for cosmetics" prompt (`inventory.sign_in_for_cosmetics`).
  - Play is unaffected.
- **Signed-in state:** the account menu (`NavAccountMenu`: profile, settings, logout), plus the **Credits** balance in the store header (`Store.renderHeader` → `CurrencyDisplay`, Credits label and icon, no premium currency; section 9.2).
- **Notifications, help, settings:** the existing icons (`NavUtilityIcons`, `NavNotificationsController`) need no change.
- **Footer:** keep the "© OpenFront and Contributors" notice (AGPL §7).
- **Terms and Privacy (D5).** The footer already links `/terms-of-service.html` and `/privacy-policy.html`, served from `resources/public/`. Today these are DeltaFront placeholders that visibly say the policy has not been published, which is acceptable in dev and staging only. Final pages covering Discord/Google OAuth data, account data, game records, cookies, retention and deletion are a **public launch blocker** (M7).

---

## 14. Security model

### 14.1 Tokens and sessions

| Threat               | Control                                                                                                                                                                                                                                     |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Forged JWT           | Ed25519 signature verified by the game server (`jose`, `algorithms: ["EdDSA"]`, issuer and audience pinned)                                                                                                                                 |
| Stolen access token  | 15-minute TTL; in memory only                                                                                                                                                                                                               |
| Stolen refresh token | HttpOnly, Secure cookie; rotation with family-wide revocation on reuse                                                                                                                                                                      |
| Revocation           | `/auth/logout`, `/auth/revoke`; ban → `role:"banned"` within 15 min; the game server also gets `ban` via `/users/@me` at join                                                                                                               |
| Key rotation         | JWKS lists current + previous. **Game-server change (M7):** replace `ServerEnv.jwkPublicKey`'s cache-forever `keys[0]` with `jose.createRemoteJWKSet` (kid-aware, auto-refresh). Until then, rotating keys requires restarting game servers |

### 14.2 Web

- **CORS.** Allowlist of origins from `ALLOWED_ORIGINS` (`https://<DOMAIN>`, plus dev `http://localhost:9000`), with `Access-Control-Allow-Credentials: true`. Never reflect arbitrary origins.
- **CSRF.**
  - Cookie-authenticated mutations (`/auth/refresh`, `/auth/logout`, `/auth/revoke`, `DELETE /users/@me`; from M8 also `/auth/magic-link`) require an `Origin` header in the allowlist; `SameSite=Lax` adds a second layer.
  - Bearer-authenticated endpoints are not CSRF-able (no ambient credential).
  - (M8) `GET /auth/login/token` sets a cookie: it is single-use and token-bound, and it validates `Origin` when present.
- **Open redirects.** `redirect_uri` and `redirectDomain` must match the allowlisted origins exactly.

### 14.3 Abuse limits

All limits use `express-rate-limit` with an in-memory store in V1 (single instance); move to a Postgres or Redis store if scaled.

| Endpoint                                        | Limit                                                 |
| ----------------------------------------------- | ----------------------------------------------------- |
| Guest creation (`/auth/refresh` without cookie) | 10/hour/IP; 200/hour global alarm                     |
| OAuth start                                     | 30/min/IP                                             |
| Purchases, clan writes                          | 20/min/user                                           |
| Clan creation                                   | 3/day/user (on top of the D2 thresholds)              |
| Username change                                 | Cooldown + 5/hour/user                                |
| Leaderboards and public reads                   | 120/min/IP + HTTP caching                             |
| (M8) `/auth/magic-link`                         | 3/15 min per email, 10/hour per IP; silent 204        |
| (M8) `/auth/login/token`                        | 10/min/IP; tokens are 256-bit, single-use, 15-min TTL |

Brute force: V1 has no passwords and no email codes. Sign-in relies on Discord and Google.

### 14.4 Economy and inventory integrity

- **Credits, prices and ownership are server-only.**
  - The client sends `(type, name, palette, currencyType)`; the server looks up the price in its own catalog.
  - Transactions lock the wallet row; `wallets.credits CHECK (≥ 0)`; unique `(user_id, flare)`.
  - The ledger is append-only, and every admin grant is audited.
- **No endpoint changes a balance or grants an item at a player's request.** The only sources are:
  - game ingestion (server key, computed from the server-decided winner and the D1 constants);
  - purchases (debit only);
  - the admin CLI.
- **Daily cap** is enforced under the wallet lock with the per-game unique ledger key, so replays, retries and concurrent ingestions cannot exceed 1,000 Credits a day.
- **Forged inventory in multiplayer** is blocked by the game server re-checking flares at every join.

### 14.5 Server-to-API

- **Per-server keys.** Each game-server host gets its own random 256-bit key. `server_api_keys` stores SHA-256; comparison is constant-time. Keys can be revoked individually. The API refuses server endpoints when the key is missing or revoked.
- **Server-only endpoints:** `/game/:id` POST, `/join_verify`, `/cluster/checkin`, `/reserved_clan_tags`, `/custom_tribes`, `/users/@me` with `x-api-key`. If the key leaks, the attacker could submit fake results, so:
  - prefer a private network or localhost (option A);
  - optionally IP-allowlist server endpoints;
  - the ingestion sanity checks (known `gitCommit`, `game_code` letter matches a registered server letter, sane duration and player counts) limit the damage.
- **Fake game results** are covered by the key, idempotency on `game_code`, schema validation, `counts_for_stats` rules and admin `game:void`.
- **Forged check-ins** are refused unless the key is valid. `state` comes from the database (admin-set), never from the request.
- **Secrets** (`API_KEY`, JWT private key, OAuth client secrets, email API key, `DATABASE_URL`, Turnstile secret) live only in server env files (`chmod 600`). Nothing secret goes in `vite` `define` or the bundle. `example.env` documents names only.

### 14.6 Accounts, roles and bans

- **Privilege escalation.**
  - `users.role` is only settable by the admin CLI.
  - No endpoint accepts a role.
  - Clan roles change only through the permission-checked actions.
- **Banned accounts.**
  - JWT `role: "banned"`; `/users/@me` returns `ban` (the existing `BannedModal` shows it).
  - All writes return 403.
  - The game server closes joins (`CloseCode.Banned`).
- **`trustTier`.** `trusted` when the account is registered, ≥ 7 days old, has ≥ 10 counted games and is not flagged or banned; otherwise `untrusted`. Trusted-only lobbies stay off until there are enough trusted players (section 17).

### 14.7 Join verification (M7)

`POST /join_verify`:

- Verify Cloudflare Turnstile server-side (`siteverify` with the secret).
- Screen the name and clan tag with `obscenity` + blocklist. Return `approved` with cleaned values, or `rejected`.
- Without it, the game server fails open (local censor, **Turnstile unverified**). This is acceptable for the first private beta, not for public launch.

---

## 15. Admin plan

Start with a **CLI** (`npm run admin -- <command>`), run over SSH on the API host against `DATABASE_URL`. There is no web admin panel and no admin HTTP endpoints in V1, which leaves nothing extra to attack.

| Command                                                                                                      | Effect                                                                        |
| ------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------- |
| `user:find <publicId\|email\|discordId\|username>`                                                           | Print matching accounts                                                       |
| `user:show <publicId>`                                                                                       | Identities, sessions, bans, wallet, flares, clans, last 20 games, ledger tail |
| `user:ban <publicId> --category --reason [--days N]` / `user:unban`                                          | Ban/unban; also revokes sessions                                              |
| `user:revoke-sessions <publicId>`                                                                            | Sign out everywhere                                                           |
| `user:role <publicId> <admin\|mod\|flagged\|none>`                                                           |                                                                               |
| `wallet:grant <publicId> <amount> --reason` / `wallet:revoke`                                                | Credits only; ledger-backed                                                   |
| `item:grant <publicId> <flare>` / `item:revoke`                                                              | Validates the flare against the catalog                                       |
| `clan:show <TAG>`, `clan:rename`, `clan:transfer <TAG> <publicId>`, `clan:remove <TAG> --reason`             |                                                                               |
| `game:show <gameCode>`, `game:void <gameCode>` + `stats:rebuild [--user]`                                    |                                                                               |
| `server:key:create <name>` / `server:key:revoke <id>`, `server:state <site> <letter> open\|draining\|fenced` |                                                                               |

Every command writes `admin_audit_log` (`actor` = OS user from `$SUDO_USER`/`$USER`) and runs in a transaction. Destructive commands require `--yes`.

Later: read-only admin HTTP endpoints behind JWT `role in (admin, root)` (`isAdminRole` exists) plus a small page.

---

## 16. Hosting plan

Prices are approximate public list prices as of this writing; **verify before buying**.

### Option A: single VPS (recommended to start)

- **Host.** One VPS, 2–4 vCPU / 4–8 GB (e.g. Hetzner CPX21–CPX31 ≈ €8–16/mo, or DigitalOcean 4 GB ≈ $24/mo). It runs:
  - Nginx (TLS via Let's Encrypt; `<DOMAIN>` → game server, `api.<DOMAIN>` → account-api);
  - the game server (existing Docker/supervisord setup);
  - account-api (one process);
  - PostgreSQL 16/17 (local socket; game server ↔ API over localhost).
- **Backups.** Nightly `pg_dump` + WAL-free daily snapshots to object storage (Backblaze B2 / R2, cents per month). Test a restore monthly. Provider snapshots (+20%) are optional.
- **CDN.** The existing `CDN_BASE` setup for static assets (e.g. Cloudflare in front: free plan).
- **Email.** Not needed until M8 (D4). Later: Resend / Postmark / SES, free tier up to a few thousand emails a month, then ≈ $10–20/mo.
- **Cost.** ≈ **$10–35/month** total.
- **Trade-offs.** Simplest to operate and debug, with the lowest latency between game server and API. A single point of failure: if the box dies, everything is down until restore. Vertical scaling only.

### Option B: split services

- **Game server** on a VPS (it needs long-lived websockets and low latency; PaaS sleep and idle policies hurt it).
- **account-api** on Railway / Render / Fly (≈ $5–20/mo).
- **Postgres** on Supabase / Neon / Railway (free tiers are small and may pause; production tiers ≈ $19–25/mo).
- **Cost.** ≈ **$35–80/month.**
- **Trade-offs.** Managed database backups and failover, independent scaling and deploys. Against that: more moving parts, cross-network latency on every join (`/users/@me`), more secrets to distribute, and a public network between game server and API (needs the per-server keys and TLS strictly).

|              | A: single VPS                 | B: split                           |
| ------------ | ----------------------------- | ---------------------------------- |
| Monthly cost | $10–35                        | $35–80                             |
| Simplicity   | High                          | Medium                             |
| Maintenance  | You patch the OS and Postgres | Less database operations work      |
| Scaling      | Vertical                      | Horizontal for the API, managed DB |
| Reliability  | Single box + backups          | Managed DB, more components        |

**Recommendation:** start with A. The API is stateless and configured by env, so moving it or the database to B later is a configuration change, not a rewrite.

---

## 17. Feature-flag rollout

### 17.1 Flag changes (small client/shared change)

Extend `AccountFeatures` so no UI is enabled before its backend exists:

```ts
// packages/shared/src/AccountFeatures.ts (proposed)
accounts: boolean; // sign-in, /users/@me, profile, usernames, account settings
store: boolean; // store page (cosmetics, effects), inventory, catalog
ranked: boolean; // unchanged
clans: boolean; // unchanged
leaderboards: boolean; // leaderboard page (basic + clans)
// new, all false:
payments: boolean; // real money AND the premium ("hard") currency: currency packs, subscriptions,
// Stripe/Steam checkout, creator codes, lobby queue, clan donations, hard-currency display
friends: boolean; // friends list and requests
progression: boolean; // XP, levels, prestige, rewards claims, achievements UI
tribes: boolean; // custom tribe names (store tab, tribe leaderboard, /custom_tribes)
trustedLobbies: boolean; // MapPlaylist trusted-only rotation

// Sign-in methods the client offers (D3). The API refuses providers set to false.
export const AUTH_PROVIDERS = {
  discord: true,
  google: true,
  email: false,
  steam: false,
} as const;
```

**Store tabs** (`Store.modalConfig`):

- `packs` and `subscriptions` only when `payments`;
- `tribes` only when `tribes`;
- `bundles` only when the loaded catalog has `packs` (none in V1). Re-render the tabs after the catalog loads.

`tests/setup.ts` turns every flag on; extend it for the new flags so the inherited suite keeps testing the full product. Tests of the V1 configuration turn them off themselves.

### 17.2 Environments

`ACCOUNT_FEATURES` is a compiled constant today, the same in every build. To test with flags on in dev and staging while the public site stays off, M0 adds one override:

- a comma-separated variable, `DF_ACCOUNT_FEATURES` (e.g. `accounts,leaderboards`);
- read by the client through a Vite `define` and by the game server from `process.env`;
- the same `.env` drives both, so client and server cannot disagree;
- unset, it means today's defaults (all off).

**Public enablement** (production `DF_ACCOUNT_FEATURES` containing `accounts`) is the **public account launch**. It is gated on M7 and on D5's completed Terms and Privacy pages.

### 17.3 Staged rollout

The order follows the code's dependencies:

- everything needs auth and `/users/@me`;
- Credits and the clan threshold need "completed games" from ingestion;
- the store needs the catalog and the server's `PrivilegeRefresher`, which also needs `/reserved_clan_tags`;
- the clan leaderboard needs clans and stats.

| Milestone                                                          | Flags on in dev/staging at the end         | Production                                             |
| ------------------------------------------------------------------ | ------------------------------------------ | ------------------------------------------------------ |
| M0 Foundations                                                     | none                                       | off                                                    |
| M1 Core auth (Guest, Discord, Google) + admission + discovery      | `accounts`                                 | off                                                    |
| M2 Profile, persistent stats, Credits earning                      | (still `accounts`)                         | off                                                    |
| M3 Basic leaderboards                                              | `leaderboards` (clans tab hidden until M6) | off                                                    |
| M4 Inventory + DeltaFront catalog (default item, admin grants)     | `store` (no prices yet)                    | off                                                    |
| M5 Store (spend Credits)                                           | prices added to the catalog                | off                                                    |
| M6 Clans                                                           | `clans`                                    | off                                                    |
| M7 Hardening + **launch gate** (legal pages, join verify, backups) | `trustedLobbies` optional                  | **Public launch:** `accounts,leaderboards,store,clans` |
| M8 Email magic links (post-launch)                                 | `AUTH_PROVIDERS.email`                     | on after its acceptance criteria pass                  |

Rollback for any milestone is to remove the flag: the UI disappears, and the backend can keep running.

---

## 18. Migration strategy

1. **Database migrations.** Forward-only numbered SQL files in `src/account-api/migrations/`. A small runner applies them in order inside a transaction, holding `pg_advisory_lock`, and records them in `schema_migrations(version, applied_at, checksum)`. Run it in deploys before starting the new API version. Every migration is backward compatible with the previous API version (expand → deploy → contract).
2. **From no backend to backend.**
   - Today's players have no server-side data (no stats or purchases were ever stored), so nothing needs migrating.
   - The client's local `player_persistent_id` is discarded by `clearLocalSession` once accounts are on. Players become guests on first load.
   - Local free selections (country flags, colours) remain valid; paid ones don't exist yet.
3. **Contract changes.** Prefer additive changes; old clients ignore unknown fields (most schemas are `z.object`, which strips extras). The only proposed contract edits are:
   - `PlayerLeaderboardEntry.elo` becomes optional (client-internal type);
   - the new `POST /clans` and `GET /leaderboard/players`;
   - the new clan error codes (`ALREADY_IN_CLAN`, `ACCOUNT_TOO_NEW`, `NOT_ENOUGH_GAMES`, …);
   - the new flags and `AUTH_PROVIDERS`.

   Credits need **no** contract change: they use the existing `soft` slot (section 9.2).

4. **Upstream merges.** The client contract may change upstream. Contract tests (section 19) that parse API responses with the shared schemas catch drift when an upstream merge changes a schema.
5. **Replays.** Stored records include `gitCommit`; replays already require the exact commit (existing behaviour). Set a retention policy for `game_records` (e.g. 60 days) with a nightly prune job.
6. **Key and secret rotation.** JWT key: add the new key, publish it second, swap it to first, wait 15 min, remove the old one (restart game servers until M7's JWKS change). Server keys: create the new one, deploy it, revoke the old one.

7. **Rebalancing.** Changing `ECONOMY` or `CLAN_RULES` changes future grants and checks only. Past ledger rows and memberships are never rewritten.

---

## 19. Test matrix

Backend tests live in `tests/account-api/`.

- **Pure domain tests** (permissions, stats summation, completed-game rule, Credits rewards and cap, username rules, catalog validation, flare building) run in the normal `npm test` with no database.
- **Database tests** run in `npm run test:account-api` against a real Postgres (`DATABASE_URL_TEST`; locally `docker run postgres:17`; CI as a service container). Each test file uses a fresh schema.
- **Contract tests:** every route test parses the response with the **client's** zod schema from `@openfront/shared`.

| Area        | Test                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Level                    |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------ |
| Auth        | Guest creation: no cookie → 200, cookie set, JWT verifies against JWKS, `sub` decodes to the user id, `/users/@me` has `user: {}`                                                                                                                                                                                                                                                                                                                      | DB                       |
|             | Guest rate limit per IP                                                                                                                                                                                                                                                                                                                                                                                                                                | DB                       |
|             | Login with mocked Discord and Google token + profile endpoints: identity created; guest upgrade keeps stats **and Credits**; existing identity switches user; `email_exists`; `deleted`; bad state → `error`                                                                                                                                                                                                                                           | DB                       |
|             | Disabled providers: `/auth/login/steam` and `/auth/magic-link` → 404; the API refuses providers set to false in `AUTH_PROVIDERS`                                                                                                                                                                                                                                                                                                                       | DB                       |
|             | `completeSignIn` covers the `email` provider (unit, no route), so M8 needs no redesign                                                                                                                                                                                                                                                                                                                                                                 | unit                     |
|             | Refresh: rotation returns a new token; old token within grace → same family; old token after grace → family revoked + 401                                                                                                                                                                                                                                                                                                                              | DB                       |
|             | Logout revokes the family; revoke-all revokes every session                                                                                                                                                                                                                                                                                                                                                                                            | DB                       |
|             | Invalid JWT (bad signature, wrong iss/aud) → 401 on bearer routes; expired JWT → 401                                                                                                                                                                                                                                                                                                                                                                   | DB                       |
|             | CSRF: cookie mutation with foreign `Origin` → 403                                                                                                                                                                                                                                                                                                                                                                                                      | DB                       |
| Profile     | `/users/@me` parses with `UserMeResponseSchema` (guest and registered); `currency` = `{ soft: credits, hard: 0 }`; ban field; account persists across sessions                                                                                                                                                                                                                                                                                         | DB                       |
|             | Username: valid, profane, cooldown 429, guest 403                                                                                                                                                                                                                                                                                                                                                                                                      | DB                       |
| Stats       | Ingest a recorded game (fixture from `tests/` replay data): `games`, `game_players`, aggregates; idempotent re-post; winner mapping for player/team/nation winners; private game excluded from leaderboard; singleplayer never counts                                                                                                                                                                                                                  | DB                       |
|             | Completed-game rule: survivor connected at end ✓; eliminated after 2 min while connected ✓; eliminated before `minEliminationTick` ✗; disconnected before end or elimination ✗; no winner ✗; private game ✗                                                                                                                                                                                                                                            | unit                     |
|             | `PlayerStats` element-wise sum incl. padding                                                                                                                                                                                                                                                                                                                                                                                                           | unit                     |
|             | Invalid server key → 401; revoked key → 401                                                                                                                                                                                                                                                                                                                                                                                                            | DB                       |
| Credits     | Completed game +100; win +350 total; non-completed 0; daily cap 1,000 with a partial last grant (e.g. 900 + win → +100); cap resets at the UTC day boundary; re-posted record pays nothing; concurrent ingestions never exceed the cap; constants change the result (no hard-coded values)                                                                                                                                                             | unit + DB                |
|             | No route changes a balance from player input (route inventory test: only `/shop/purchase` debits, only ingestion and admin credit)                                                                                                                                                                                                                                                                                                                     | DB                       |
| Store       | `/cosmetics.json` parses with `CosmeticsSchema`; asset URLs expanded and served                                                                                                                                                                                                                                                                                                                                                                        | DB                       |
|             | **Catalog content test:** only `priceSoft` prices; no `priceHard`, `product`, `packs`, `currencyPacks`, `subscriptions`, `tribeNames`, `lobbyQueue`; names unique; every asset path exists; every item listed in `CREDITS.md`                                                                                                                                                                                                                          | unit                     |
|             | Purchase success (Credits debited, flare granted, ledger row); insufficient → 400 `Insufficient balance`; already owned or default → 409; unknown or unpriced item → 400; `currencyType: "hard"` → 400; guest → 403                                                                                                                                                                                                                                    | DB                       |
|             | Forged purchase: client-sent price ignored; concurrent double purchase → exactly one succeeds                                                                                                                                                                                                                                                                                                                                                          | DB                       |
| Inventory   | Owned flare appears in `/users/@me`; revoked flare disappears; the default item is present for every user (guests included)                                                                                                                                                                                                                                                                                                                            | DB                       |
|             | Game server: join with an owned pattern → allowed; unowned → `CosmeticsForbidden` (extend `tests/server/GameServerJoin.test.ts` with a fake API)                                                                                                                                                                                                                                                                                                       | server                   |
| Leaderboard | Correct order and ties (competition rank); eligibility threshold; pagination + page-bounds 400; response parses with `PlayerLeaderboardResponseSchema`                                                                                                                                                                                                                                                                                                 | DB                       |
|             | Forged stats rejected: client-archived singleplayer and private games don't move the board; voided game removed after rebuild                                                                                                                                                                                                                                                                                                                          | DB                       |
| Clans       | Create: success at exactly 3 days / 10 completed games; `ACCOUNT_TOO_NEW` at 2d23h; `NOT_ENOUGH_GAMES` at 9 (incomplete and private games not counted); `ALREADY_IN_CLAN` for a member and for a leader; duplicate tag/name (case-insensitive); held tag; profane; guest                                                                                                                                                                               | DB                       |
|             | One clan at a time: join open clan while in a clan → 409 `ALREADY_IN_CLAN`; approval after joining elsewhere → 409 and request removed; joining deletes other pending requests; max pending requests; DB unique index rejects a racing second membership                                                                                                                                                                                               | DB                       |
|             | Join open / request closed / banned; approve, deny, withdraw; leave; leader leave → `TRANSFER_REQUIRED`; sole member leave → disband                                                                                                                                                                                                                                                                                                                   | DB                       |
|             | Kick/promote/demote/transfer/ban permission matrix (every role × action)                                                                                                                                                                                                                                                                                                                                                                               | unit + DB                |
|             | Owner transfer keeps exactly one leader (concurrent transfers)                                                                                                                                                                                                                                                                                                                                                                                         | DB                       |
|             | `/reserved_clan_tags` includes active + held tags                                                                                                                                                                                                                                                                                                                                                                                                      | DB                       |
| Game server | Authenticated admission: JWT from the test API → join succeeds; persistent ID in prod → refused; banned → closed                                                                                                                                                                                                                                                                                                                                       | server/e2e               |
|             | Result submission reaches the API; invalid key rejected                                                                                                                                                                                                                                                                                                                                                                                                | e2e                      |
|             | `/cluster/checkin` → `open`; unknown key → refused; `/cluster.json` lists the server                                                                                                                                                                                                                                                                                                                                                                   | DB                       |
| Multiplayer | Account identity: two clients with API-issued JWTs join one game; the record maps both to their users; both receive Credits per D1                                                                                                                                                                                                                                                                                                                     | e2e                      |
|             | Cosmetic propagation: client A's owned pattern appears in B's `GameStartInfo`                                                                                                                                                                                                                                                                                                                                                                          | e2e                      |
|             | Clan tag propagation: a member keeps the tag, a non-member wearing a registered tag has it dropped                                                                                                                                                                                                                                                                                                                                                     | e2e                      |
| Client      | Flag gating: new flags hide store tabs (packs, subscriptions, tribes, empty bundles), leaderboard tabs, friends, progression, hard currency; `AUTH_PROVIDERS` hides Steam, the divider and the email field in `AccountModal` **and** `AccountSettingsPanel`; "Credits" label and icon; Caps/Plutonium strings unreachable in V1; create-clan form incl. `ACCOUNT_TOO_NEW` / `NOT_ENOUGH_GAMES` / `ALREADY_IN_CLAN` messages; basic leaderboard fetcher | unit (existing patterns) |
| Legal       | Footer links resolve; placeholder pages visibly say they are not published policies (dev); launch checklist item for final pages (section 24, M7)                                                                                                                                                                                                                                                                                                      | unit + manual            |

The e2e tests start account-api (test DB) and a game server in-process (patterns exist in `tests/server/*`) and drive websockets directly.

M8 adds the magic-link tests: issue (always 204), consume, `consumed`, `expired`, `invalid`, rate limits, open-redirect refusal, guest upgrade and link mode through `completeSignIn`.

---

## 20. Implementation milestones

Final recommended order (D1–D6 applied):

| #   | Name                                       | Contents                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Depends on                                       |
| --- | ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| M0  | Foundations                                | `src/account-api` skeleton, config, `pg`, migration runner, `0001_init.sql` (section 6 tables, **without** `magic_link_tokens`), `domain/constants.ts` (`ECONOMY`, `CLAN_RULES`), LayerBoundaries rule, scripts, test harness, `example.env` additions, new flags (all false), `AUTH_PROVIDERS`, `DF_ACCOUNT_FEATURES` override                                                                                                                                                  | none                                             |
| M1  | Core auth + admission + discovery          | JWT/JWKS, refresh/guest/logout/revoke, `completeSignIn`, Discord + Google OAuth, link Google, `/users/@me` (V1 fields), server keys, `/cluster/checkin`, `/cluster.json`, `POST`/`GET /game/:id` (store only), `/news.json` + `/streams.json` (bundled files), CORS/CSRF/rate limits, admin CLI basics (user, ban, server keys). Client: `AUTH_PROVIDERS` in `AccountModal` and `AccountSettingsPanel`; hide friends and progression UI behind the new flags; trusted-lobby flag | M0                                               |
| M2  | Profile, persistent stats, Credits earning | Ingestion → `completed` + aggregates, wallets + ledger + D1 rewards with daily cap, `/public/player/:id`, `/player/:id`, `/games`, usernames, `DELETE /users/@me` + deletion job, guest cleanup job, optional singleplayer archive                                                                                                                                                                                                                                               | M1                                               |
| M3  | Basic leaderboards                         | `leaderboard_players` rebuild, `GET /leaderboard/players`, client tab + fetcher + optional `elo`, hide ranked and tribes tabs by flag                                                                                                                                                                                                                                                                                                                                            | M2                                               |
| M4  | Inventory + DeltaFront catalog             | Catalog file + placeholder assets + pattern encoder, `/cosmetics.json` + asset serving, `/reserved_clan_tags` (`[]` before clans), `/custom_tribes` → `{ tribes: [] }`, flares + default item in `/users/@me`, admin `item:*`. Client: "Credits" label and icon, hard currency hidden unless `payments`, store tab filtering                                                                                                                                                     | M1 (M2 for balances shown)                       |
| M5  | Store (spend Credits)                      | `/shop/purchase` with locked transactions, prices in the catalog, admin `wallet:*`                                                                                                                                                                                                                                                                                                                                                                                               | M2, M4                                           |
| M6  | Clans                                      | All section 4.5 endpoints except donations, `POST /clans` with D2 rules, one-clan enforcement, client create form + `ALREADY_IN_CLAN` message, clan stats in ingestion, `/public/clans/leaderboard`, clan games, admin `clan:*`, donation UI hidden unless `payments`                                                                                                                                                                                                            | M2 (completed games), M4 (reserved-tag plumbing) |
| M7  | Production hardening + public launch gate  | `/join_verify` (Turnstile + screening), JWKS `createRemoteJWKSet` on the game server, per-server keys enforced, backups and restore drill, monitoring, **final Terms of Service and Privacy Policy**, load test of `/users/@me` at join rate, optional trusted lobbies, then public enablement                                                                                                                                                                                   | M1–M6                                            |
| M8  | Email magic links (post-launch)            | Email provider adapter (SPF/DKIM/DMARC), `magic_link_tokens` migration, `/auth/magic-link`, `/auth/login/token`, templates, rate limits, privacy-policy update for email, then `AUTH_PROVIDERS.email = true`                                                                                                                                                                                                                                                                     | M7                                               |

**Effect of Discord + Google only:**

- M1 no longer has an external email dependency, so it is self-contained apart from the two OAuth app registrations.
- The magic-link milestone moves from right after M1 to M8.
- Credits earning joins M2, because both the reward and the clan threshold are computed from the same ingestion step.
- M6 (clans) depends only on M2 and the reserved-tag endpoint. It could swap with M4–M5 if clans matter more than the store, but store first stands up `PrivilegeRefresher` (catalog + reserved tags), which clan-tag enforcement reuses, so the recommended order keeps it before clans.

---

## 21. Risks

| Risk                                                                                                    | Impact                                              | Mitigation                                                                                                                              |
| ------------------------------------------------------------------------------------------------------- | --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| **Proprietary content.** Accidentally reusing OpenFront's catalog, art, product names or currency names | Legal exposure                                      | D6 rules; catalog content test; placeholder assets made for DeltaFront and listed in `CREDITS.md`; reviewers check every catalog change |
| Leftover "Caps"/"Plutonium" text reachable in V1                                                        | Off-brand, confusing                                | Label change, icon swap, payments-gated hard-currency UI, string-reachability test                                                      |
| Hidden contract details beyond what the client parses (e.g. exact 400 reason strings)                   | UI shows generic errors                             | Contract tests plus reading each caller's error branches (section 4) before implementing a route                                        |
| Guest-row growth (bots, crawlers)                                                                       | DB bloat                                            | Rate limits; nightly cleanup of guests with no games or purchases inactive for 30 days                                                  |
| Guests losing earned Credits when cookies are cleared                                                   | Player frustration                                  | Existing not-signed-in warning; prompt to link Discord/Google; upgrades keep everything                                                 |
| `/users/@me` on every join                                                                              | Join latency and outage coupling                    | One indexed query, localhost in option A; the game server already treats 5xx as retryable                                               |
| JWKS cached forever on the game server                                                                  | Key rotation needs restarts                         | M7 `createRemoteJWKSet`                                                                                                                 |
| Economy farming (alts, idle joins)                                                                      | Inflation, fake clan eligibility                    | Public server games only; completed-game rule (connected, ≥ 2 min); 1,000/day cap; admin void                                           |
| Discord or Google outage                                                                                | No new sign-ins (existing sessions keep refreshing) | Two providers; guests can still play                                                                                                    |
| OAuth app setup and branding                                                                            | Delays                                              | Discord needs no review for `identify email`; Google basic scopes need only a consent-screen brand                                      |
| Turnstile unverified until M7                                                                           | Bot joins                                           | Ship M7 `/join_verify` before public launch                                                                                             |
| Legal pages not ready                                                                                   | Public launch blocked                               | D5 launch gate; placeholders are clearly labelled until then                                                                            |
| Privacy (GDPR)                                                                                          | Legal                                               | Data minimisation (hashed IPs), deletion flow, final privacy policy before launch                                                       |
| Upstream merge conflicts in client code                                                                 | Merge effort                                        | Keep client changes tiny and flag-based                                                                                                 |
| Single VPS failure                                                                                      | Downtime and data loss                              | Off-site nightly backups plus a tested restore; move to option B when revenue justifies                                                 |
| Trusted lobbies with few trusted users                                                                  | Empty lobbies                                       | `trustedLobbies` flag off at launch                                                                                                     |
| Email deliverability (M8 only)                                                                          | Magic links land in spam                            | Reputable provider, SPF/DKIM/DMARC                                                                                                      |

---

## 22. Complexity estimates

Rough focused-engineering effort, assuming the contracts in section 4. S = ≤ 1 day, M = 2–4 days, L = 1–2 weeks.

| Milestone | Size | Main effort                                                                                                                                          |
| --------- | ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| M0        | M    | Skeleton, migrations, test harness with real Postgres, flag override                                                                                 |
| M1        | L    | OAuth correctness, sign-in funnel, session rotation, CORS/CSRF, `/users/@me` contract, check-in                                                      |
| M2        | L    | Stats aggregation (`PlayerStats` sum, tree shape), completed-game rule from turns, Credits with cap and concurrency tests, deletion and cleanup jobs |
| M3        | S–M  | Rebuild job, endpoint, small client tab                                                                                                              |
| M4        | M    | Catalog plumbing, five placeholder items, pattern encoder, asset serving, Credits label and icon, hiding hard currency                               |
| M5        | S–M  | Purchase transaction and concurrency tests                                                                                                           |
| M6        | L    | Many endpoints, permission matrix, one-clan rules, create-clan UI, clan stats                                                                        |
| M7        | M–L  | Join verify, ops (backups, monitoring), load tests, legal pages (owner-provided text)                                                                |
| M8        | M    | Email provider, magic-link endpoints, templates                                                                                                      |

---

## 23. Acceptance criteria

**M0:**

- `npm test`, `npm run typecheck` and `npm run lint` pass with all flags off.
- `ECONOMY` and `CLAN_RULES` are the only places the D1/D2 values appear.

**M1:**

- A fresh browser (staging) gets a guest session and can join a public multiplayer game; the game server logs a JWT join, not a persistent ID.
- Discord and Google sign-in work.
- A guest who signs in keeps their games.
- Logout and revoke work.
- The Steam button, the "or" divider and every email field are hidden. `/auth/magic-link` is 404.
- A deployed host gets public lobbies through `/cluster/checkin`.
- No UI for friends, progression, payments, ranked or tribes is visible.

**M2:**

- After a public game, both players' profiles show the game and updated totals.
- A completed game pays exactly 100 Credits; a win pays 350.
- A player who leaves early or is eliminated in the first 2 minutes gets nothing.
- The 1,000/day cap holds with a partial last grant.
- Re-posting the same record changes nothing. A private game shows in history but pays nothing and is not on leaderboards.
- A username can be set (with suffix) and appears on the profile and in game.

**M3:**

- The leaderboard players tab lists eligible players in the documented order, paginates, and stops at the page bound.
- Ranked and tribes tabs are hidden.

**M4:**

- The store and inventory show only the DeltaFront placeholder catalog (no OpenFront items, names or art).
- Every player has the free default pattern. Admin-granted items show for their owner.
- An equipped owned item is seen by other players in game; an unowned one is impossible to join with.
- The balance is labelled "Credits" with the Credits icon, and no Plutonium or Caps text or icon is visible.

**M5:**

- Buying an item debits Credits exactly once even under double-clicks; owned items show as owned; insufficient balance shows the existing message.
- The ledger reconciles with wallet balances.
- A request with `currencyType: "hard"` or a forged price changes nothing.

**M6:**

- A registered player meeting 3 days / 10 completed games can create a clan with a unique tag and name; others get the specific requirement message.
- A player can never be in, or own, two clans (including under concurrent requests).
- Every permission in section 12.3 is enforced by the server.
- The tag shows in game for members and is dropped for impersonators.
- The clan leaderboard lists clans.

**M7 (public launch gate):**

- Final Terms of Service and Privacy Policy replace the placeholders.
- Turnstile is verified on join.
- Rotating the JWT key needs no game-server restart.
- A backup restore is tested.
- `/users/@me` p95 is under 50 ms at expected join peaks.
- Only then does production `DF_ACCOUNT_FEATURES` enable `accounts,leaderboards,store,clans`.

**M8:** an email sign-in link arrives, signs in once, refuses reuse (`consumed`), and upgrades a guest like Discord/Google do.

---

## 24. Execution checklist

Work milestone by milestone. Do not enable a flag in production before M7. Follow `CLAUDE.md`: `npm run typecheck` (not `tsc -b`), `npm run lint`, Prettier, `translateText()` with sorted `en.json` keys, and no commits unless asked.

### M0: Foundations

1. **FILE:** `package.json`
   - **CHANGE:** Add dependency `pg` (keep `@types/pg`). Add scripts `start:account-api` (`tsx src/account-api/index.ts`), `account-api:migrate`, `admin`, `test:account-api`.
   - **WHY:** Service entry points.
   - **TEST:** `npm run typecheck`.
2. **FILE:** `src/account-api/config.ts`
   - **CHANGE:** zod-parsed env: `DATABASE_URL`, `DOMAIN`, `API_PORT` (8787), `API_PUBLIC_ORIGIN`, `ALLOWED_ORIGINS`, JWT key paths, Discord/Google client ids and secrets.
   - **TEST:** Unit test of parse failures.
3. **FILE:** `src/account-api/domain/constants.ts`
   - **CHANGE:** `ECONOMY` and `CLAN_RULES` exactly as in sections 9.5 and 12.2.
   - **WHY:** D1/D2 values live in one place.
   - **TEST:** A grep-style test that no other file hard-codes 100/250/1000 reward values or the 3/10 clan thresholds.
4. **FILE:** `src/account-api/db/*`, `migrations/0001_init.sql`, `migrate.ts`
   - **CHANGE:** Pool, `tx()`, runner (advisory lock, checksum), and the section 6 schema without `magic_link_tokens`.
   - **TEST:** Migrations apply twice on an empty DB.
5. **FILE:** `tests/LayerBoundaries.test.ts`
   - **CHANGE:** Add the `src/account-api` rule (section 5.1).
6. **FILE:** `packages/shared/src/AccountFeatures.ts`, `vite.config.ts`, `tests/setup.ts`
   - **CHANGE:** New flags (false), `AUTH_PROVIDERS`, the `DF_ACCOUNT_FEATURES` override (Vite `define` for the client, `process.env` for the server), and the new flags on in `tests/setup.ts`.
   - **TEST:** Full `npx vitest --run`; a unit test of override parsing.
7. **FILE:** `example.env`, `docs/DeltaFrontServices.md`
   - **CHANGE:** New env names (no values); the backend lives in `src/account-api`.

### M1: Core auth, admission, discovery

8. **FILE:** `src/account-api/auth/jwt.ts`
   - **FUNCTION:** `signAccessToken`, `jwks()`.
   - **CHANGE:** Ed25519; `iss` = `https://api.<DOMAIN>` (`http://localhost:8787` in dev); current key first.
   - **TEST:** A token signed here passes `src/server/jwt.verifyClientToken`.
9. **FILE:** `src/account-api/auth/sessions.ts`, `auth/signIn.ts`, `routes/auth.ts`
   - **CHANGE:** `/auth/refresh` (guest mint, rotation, reuse detection), `/auth/logout`, `/auth/revoke`, cookie helper, Origin check, `completeSignIn` (supports `email` for M8 but no email route).
   - **TEST:** Section 19 auth rows.
10. **FILE:** `src/account-api/auth/oauth/{discord,google}.ts`, `routes/auth.ts`
    - **CHANGE:** Login start and callback, `/auth/link/google` → `{ url }`, `#login=` results. Providers disabled in `AUTH_PROVIDERS` are not routed.
    - **TEST:** Mocked provider HTTP.
11. **FILE:** `src/account-api/routes/users.ts`
    - **CHANGE:** `GET /users/@me` (section 8.1; `currency: { soft: credits, hard: 0 }`).
    - **TEST:** Parse with `UserMeResponseSchema`.
12. **FILE:** `src/account-api/routes/server.ts`, `cluster.ts`, `game.ts`
    - **CHANGE:** `requireServerKey`; `/cluster/checkin`; `/cluster.json`; `POST`/`GET /game/:id` (store only); `/news.json`, `/streams.json`.
    - **TEST:** Section 19 game-server rows.
13. **FILE:** `src/account-api/admin/cli.ts`
    - **CHANGE:** `user:*`, `server:key:*` with audit log.
14. **FILE:** `src/client/AccountModal.ts` (`renderLoginOptions`), `src/client/components/AccountSettingsPanel.ts` (`renderEmailField` and its section)
    - **CHANGE:** Render providers and the email field only when `AUTH_PROVIDERS` enables them; drop the "or" divider when the email field is hidden. Leave `Auth.sendMagicLink`, `tempTokenLogin`, `TokenLoginModal` and the `#token-login` route untouched (D3).
    - **TEST:** Extend `tests/client/AccountModal.rendering.test.ts` and `AccountSettingsModal.test.ts`.
15. **FILES:** friends and progression UI (`FriendsList.ts`, `ProgressionApi.ts` callers, `GameXpPanel.ts`, `RewardsPanel.ts`, `PrestigeFlow.ts`, level badges; find with grep)
    - **CHANGE:** Gate on `ACCOUNT_FEATURES.friends` / `.progression`.
    - **TEST:** Rendering tests with flags off.
16. **FILE:** `src/server/MapPlaylist.ts:142`
    - **CHANGE:** Require `ACCOUNT_FEATURES.trustedLobbies` for the trusted rotation.
17. **FILE:** `resources/public/terms-of-service.html`, `privacy-policy.html`
    - **CHANGE:** None needed for dev: they are already visibly labelled as unpublished placeholders (D5). Verify the visible text never claims to be a complete policy.
18. **Enable** `accounts` in dev/staging only (`DF_ACCOUNT_FEATURES`).

### M2: Profile, stats, Credits earning

19. **FILE:** `src/account-api/domain/stats.ts`
    - **FUNCTION:** `sumPlayerStats`, `resultFor`, `countsForStats`, `isCompleted(record, clientID)` (section 9.5, from `stats.finalTiles`/`killedAt` and `mark_disconnected` turns), `buildStatsTree`.
    - **TEST:** Unit, including every completed-game case.
20. **FILE:** `src/account-api/domain/economy.ts`
    - **FUNCTION:** `gameReward(completed, won)`, `applyGameReward(tx, userId, gameCode, endedAt, amount)` (wallet lock, daily sum, clamp, ledger).
    - **TEST:** Section 19 Credits rows.
21. **FILE:** `src/account-api/routes/game.ts`
    - **CHANGE:** Ingestion writes `game_players` (`completed`, `credits_awarded`), aggregates and rewards in one transaction.
    - **TEST:** Fixture record from an existing test replay.
22. **FILE:** `src/account-api/routes/profile.ts`, `routes/users.ts`, `domain/usernames.ts`
    - **CHANGE:** Profile endpoints, `PUT /users/@me/username`, `DELETE /users/@me` + 24h deletion job, guest cleanup job.
    - **TEST:** Section 19 profile rows.

### M3: Basic leaderboards

23. **FILE:** `src/account-api/routes/leaderboard.ts`, `jobs/leaderboard.ts`
    - **CHANGE:** 5-minute rebuild with an advisory lock; `GET /leaderboard/players?page&period`.
24. **FILE:** `packages/shared/src/ApiSchemas.ts`
    - **CHANGE:** `PlayerLeaderboardEntrySchema.elo` becomes optional.
    - **TEST:** `tests/client/ApiPlayerLeaderboard.test.ts`.
25. **FILE:** `src/client/Api.ts` (`fetchBasicPlayerLeaderboard`), `LeaderboardModal.ts`, `components/leaderboard/LeaderboardPlayerList.ts`, `en.json`
    - **CHANGE:** Basic players tab first; ranked tabs only with `ranked`, tribes with `tribes`, clans with `clans`; hide the Elo column when absent.
    - **TEST:** `tests/client/LeaderboardModal.test.ts`.
    - Then enable `leaderboards` in dev/staging.

### M4: Inventory and DeltaFront catalog

26. **FILE:** `src/account-api/catalog/cosmetics.json`, `catalog/assets/*`, `scripts/cosmetics/encode-pattern.ts`, `CREDITS.md`
    - **CHANGE:** The five placeholder items in section 9.3 (original geometric assets; `delta_stripes:ash` free by default); the pattern encoder with a round-trip test; asset credits.
    - **TEST:** Catalog content test (section 19).
27. **FILE:** `src/account-api/catalog/load.ts`, `routes/store.ts`, `routes/server.ts`
    - **CHANGE:** Load, validate with `CosmeticsSchema`, expand asset URLs; `GET /cosmetics.json`; `GET /cosmetics/assets/:file`; `/reserved_clan_tags` (`[]` until M6); `/custom_tribes` → `{ tribes: [] }`; default flares in `/users/@me`.
    - **TEST:** `PrivilegeRefresher` loads against the test API.
28. **FILE:** `resources/lang/en.json` + other locale files, `resources/images/CreditsIcon.svg`, `src/client/components/CreditsIcon.ts`, `components/CurrencyDisplay.ts`, hard-currency surfaces (section 9.2)
    - **CHANGE:** `cosmetics.soft` = "Credits" (remove localized values elsewhere so English shows); the Credits icon replaces `CapIcon` for soft; hard currency renders only with `payments`.
    - **TEST:** CurrencyDisplay test; string-reachability test.
29. **FILE:** `src/client/Store.ts` (`modalConfig`)
    - **CHANGE:** Tab filtering per section 17.1; re-render after the catalog loads.
    - **TEST:** `tests/client/StoreModal.test.ts`.
30. Admin `item:grant` / `item:revoke`. Then enable `store` in dev/staging.

### M5: Store

31. **FILE:** `src/account-api/routes/store.ts`, `domain/economy.ts`
    - **CHANGE:** `POST /shop/purchase` (section 9.4); admin `wallet:grant` / `wallet:revoke` (Credits only).
    - **TEST:** Section 19 store rows incl. the concurrent double purchase.
32. Add `priceSoft` to the catalog's paid placeholder items.

### M6: Clans

33. **FILE:** `src/account-api/domain/clans.ts`
    - **FUNCTION:** `can(actorRole, action, targetRole)`, `checkCreateEligibility(user, completedGames)` using `CLAN_RULES`.
    - **TEST:** Exhaustive unit matrix + threshold edges.
34. **FILE:** `migrations/000N_clans.sql` (if not in 0001), `routes/clans.ts`
    - **CHANGE:** Every section 4.5 endpoint except donations; `POST /clans`; `ALREADY_IN_CLAN` on join/approve/create; pending-request cleanup; `/public/clan/:TAG/exists`; clan data in `/users/@me` and profiles; clan stats + `/public/clans/leaderboard`; `/clans/:tag/games`; real `/reserved_clan_tags`.
    - **TEST:** Parse every response with the `ClanApiSchemas` schemas; section 19 clan rows.
35. **FILE:** `src/client/ClanApi.ts` (`createClan`, `ALREADY_IN_CLAN` mapping), `components/clan/ClanBrowseView.ts`, `en.json` (`clan_modal.create_*`, `clan_modal.error_already_in_clan`)
    - **CHANGE:** Create-clan flow with requirement messages; DeltaFront styling.
    - **TEST:** New component test.
36. Hide clan donation UI unless `payments`. Admin `clan:*`. Then enable `clans` in dev/staging.

### M7: Hardening and public launch gate

37. **FILE:** `src/account-api/routes/server.ts`
    - **CHANGE:** `POST /join_verify` (Turnstile siteverify + name/tag screening).
    - **TEST:** Mocked siteverify; `tests/server/JoinVerify.test.ts`.
38. **FILE:** `src/server/ServerEnv.ts`, `src/server/jwt.ts`
    - **CHANGE:** `jose.createRemoteJWKSet` instead of the cached `keys[0]`.
    - **TEST:** Verification after rotation.
39. Ops: Nginx for `api.<DOMAIN>`, a process entry, nightly `pg_dump` off-site + a restore drill, `/health`, alerts.
40. **Owner:** final Terms of Service and Privacy Policy (OAuth data, account data, game records, cookies, retention, deletion) replace the placeholders. **Launch blocker.**
41. Load-test `/users/@me` and `/auth/refresh`.
42. Set production `DF_ACCOUNT_FEATURES=accounts,leaderboards,store,clans`. `trustedLobbies` is optional, later.

### M8: Email magic links (post-launch)

43. **FILE:** `migrations/000N_magic_links.sql`, `src/account-api/auth/magicLink.ts`, `auth/email.ts`
    - **CHANGE:** `magic_link_tokens`, the provider adapter, `/auth/magic-link`, `/auth/login/token` through `completeSignIn`, rate limits.
    - **TEST:** M8 tests (section 19).
44. Privacy-policy update for email. Set `AUTH_PROVIDERS.email = true`.
