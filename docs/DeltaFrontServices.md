# DeltaFront: external services and the account backend

DeltaFront is a fork of OpenFront. OpenFront runs a closed-source account API (a Cloudflare Worker at `api.<DOMAIN>`) that this repository does not contain. Everything below that needs it is **off by default** in DeltaFront.

The switches live in [`packages/shared/src/AccountFeatures.ts`](../packages/shared/src/AccountFeatures.ts) (`ACCOUNT_FEATURES`), read by both the client and the server. Product settings (links, Steam, ads, tutorial video) live in [`src/client/Branding.ts`](../src/client/Branding.ts).

## What works with no backend

Solo play, the tutorial, private lobbies (create and join, two or more players), the scheduled public lobbies on a local server, settings, help, news (bundled `resources/news.json`), and the whole simulation.

## Feature flags

| Flag           | Hidden when off                                                                                                | Needs from a backend                                                                                                                                                                                                      |
| -------------- | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `accounts`     | Sign-in control, profile, friends, XP, verified names, "sign in for achievements", account/stats/profile pages | `/auth/*` (login, refresh, link), `/.well-known/jwks.json`, `/users/@me` (+ `/username`, `/identity_token`, `/creator`, `/xp/*`, `/prestige`), `/friends`, `/public/player/*`, `/public/progression/config`, `/rewards/*` |
| `store`        | Store, inventory, cosmetics, subscriptions, purchase prompts, "list lobby publicly" (outside dev)              | `/cosmetics.json`, `/shop/purchase*`, `/payments/*`, `/stripe/*`, `/subscriptions/@me/*`, `/creators/code/*`, `/marketing/consent`, server: `/users/@me/lobby_queue`, `/custom_tribes`                                    |
| `ranked`       | Ranked button/page; the server's matchmaking check-in                                                          | `/matchmaking/*` (client), server: `POST /matchmaking/checkin` (long poll)                                                                                                                                                |
| `clans`        | Clan tag picker, clan pages, clan leaderboard                                                                  | `/clans/*`, `/public/clans/leaderboard`, `/public/clan/:tag/exists`, server: `/reserved_clan_tags`                                                                                                                        |
| `leaderboards` | Leaderboard page                                                                                               | `/leaderboard/ranked`, `/leaderboard/tribes`, `/public/tribe/*`                                                                                                                                                           |

Turning any flag on also turns on the server-list heartbeat (`/cluster.json`) and the served news/streams feeds (`/news.json`, `/streams.json`), which fall back to the bundled files when the backend does not answer.

Other server calls to the API, all failing open or being skipped without a backend: `POST /join_verify` (Turnstile + name screening), `POST/GET /game/:id` (game archive; skipped unless a flag is on), `POST /cluster/checkin` (deployed hosts only), a lobby-coordinator websocket (only with `LOBBY_COORDINATOR=api`).

### Newer flags, and turning flags on (`DF_ACCOUNT_FEATURES`)

DeltaFront's own account backend ([`src/account-api`](../src/account-api), planned in [DeltaFrontAccountsPlan.md](DeltaFrontAccountsPlan.md)) adds five flags. They exist from milestone M0 but **nothing reads them yet**; each gets its first use in the milestone that owns the feature, and until then turning one on changes nothing.

| Flag             | Will hide when off                                                                                     | Wired in |
| ---------------- | ------------------------------------------------------------------------------------------------------ | -------- |
| `payments`       | Real money and the premium currency: currency packs, subscriptions, checkout, creator codes, donations | M4       |
| `friends`        | Friends list and requests                                                                              | M1       |
| `progression`    | XP, levels, prestige, reward claims, achievements                                                      | M1       |
| `tribes`         | Custom tribe names and the tribe leaderboard                                                           | M4       |
| `trustedLobbies` | The trusted-accounts-only public lobby rotation                                                        | M1       |

Every flag is off unless `DF_ACCOUNT_FEATURES` names it. The value is a comma-separated list, e.g. `DF_ACCOUNT_FEATURES=accounts,leaderboards`:

- unset or empty means everything off (what ships);
- names must match exactly (case-sensitive); an unknown name enables nothing and is reported (a warning, but the account API refuses to start outside dev);
- there is no wildcard and no way to switch a flag off, only on;
- the client reads it **at build time** (Vite) and the game server and account API read it **at startup**, so a build and the servers it talks to must be given the same value. Put it in the same `.env` (or deployment environment) for all of them. Under `vitest` it is always empty, so a variable in your shell cannot change the test suite.

Enabling a flag in production is the public launch of that feature, so it waits for the milestone's acceptance criteria, and for the account launch also the final Terms of Service and Privacy Policy (the pages in `resources/public/` are labelled placeholders).

### The account API (`src/account-api`)

A separate Node service that will answer the `api.<DOMAIN>` contracts the client already speaks. **Milestone M0 is the foundation only**: configuration, the PostgreSQL schema and migration runner, the constants, and a `/health` endpoint. It serves no account endpoints yet, so it is not started by `npm run dev` and no flag should be enabled against it.

```bash
npm run account-api:migrate           # apply pending migrations (needs DATABASE_URL)
npm run account-api:migrate -- status # what is applied and what is pending
npm run start:account-api             # start the service
npm run admin                         # admin command line (no commands until M1)
npm run test:account-api              # database tests; needs DATABASE_URL_TEST
```

- It needs **PostgreSQL**. There is no fallback database, and the service refuses to start if the database is unreachable or has pending migrations (it never migrates implicitly: run the migrate command as a deploy step first).
- Configuration is read from the environment (a `.env` file works). See [`example.env`](../example.env) for every variable; nothing secret is committed. `GAME_ENV` has no default, and outside `dev` the service fails at startup, listing every problem, if something it needs is missing: the domain and origins, and, when `accounts` is enabled, the signing key and Discord and Google credentials.
- The owner-defined numbers (Credits rewards, the daily cap, clan creation rules) live in [`src/account-api/domain/constants.ts`](../src/account-api/domain/constants.ts) and nowhere else.
- Migrations are forward-only files in `src/account-api/migrations/`. Applied files are never edited (their checksums are verified); change the schema with a new file.

## Classification

| Service / dependency                                                                                                                                                 | Where                                     | Status                                                                                                                                                                                         |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Game simulation, lobbies, solo, private multiplayer, maps, settings, help                                                                                            | `packages/`, `src/server`, `src/client`   | **Works independently**                                                                                                                                                                        |
| News and streams feeds                                                                                                                                               | `Api.ts` (`getNews`, `getStreams`)        | **Works independently** (bundled fallback; the API is not asked unless a flag is on)                                                                                                           |
| Server list `/cluster.json`                                                                                                                                          | `ServerList.ts`                           | **Works independently** (skipped without a backend; the page's own server is used)                                                                                                             |
| Ranked, clans, leaderboards, store, inventory, cosmetics, subscriptions, sign-in, profiles                                                                           | feature flags above                       | **Safe to disable** now (done); **needs a DeltaFront replacement backend** to bring back                                                                                                       |
| Production player admission                                                                                                                                          | `src/server/jwt.ts` (`verifyClientToken`) | **Needs a DeltaFront replacement backend, or a deliberate policy change** (see below)                                                                                                          |
| Public-lobby scheduling on a deployed host                                                                                                                           | `Master.ts` (`checkinBody`, `registers`)  | **Needs a DeltaFront replacement backend, or a standalone mode** (see below)                                                                                                                   |
| Trusted-only public lobbies                                                                                                                                          | `MapPlaylist.ts`                          | **Safe to disable** (done: none scheduled without `accounts`)                                                                                                                                  |
| Tutorial video                                                                                                                                                       | `BRAND.tutorialVideoUrl`                  | **Still hardcoded to OpenFront's YouTube video**; replace or set `""`                                                                                                                          |
| "Based on OpenFront" / credits / source links                                                                                                                        | `Branding.ts`, footer, game-start screen  | **Required attribution** (keep)                                                                                                                                                                |
| `OpenFront` identifiers (`@openfront/*` packages, `window.openfrontDesktop`, `app://openfront`, replay storage keys, snapshot format marker, telemetry/metric names) | across the repo                           | **Internal**; kept so upstream merges stay easy and saved data stays readable. Not player-facing                                                                                               |
| Discord, Reddit, wiki links                                                                                                                                          | `BRAND.discordUrl/redditUrl/wikiUrl`      | **Hidden until you set them**                                                                                                                                                                  |
| Steam app (wishlist promo, "open in Steam")                                                                                                                          | `BRAND.steamAppId`                        | **Hidden until you set it**                                                                                                                                                                    |
| Ads (Playwire RAMP, Admiral) and `ads.txt`                                                                                                                           | `BRAND.adsEnabled`, `Admiral.ts`          | **Removed** (upstream's accounts). Needs your own ad provider if you want ads                                                                                                                  |
| Google Analytics, Google Ads, Cloudflare Web Analytics                                                                                                               | `index.html`, `ServerEnv`                 | **Removed** (upstream's IDs). Optional via `GOOGLE_ANALYTICS_ID`, `CLOUDFLARE_ANALYTICS_TOKEN`                                                                                                 |
| Cloudflare Turnstile                                                                                                                                                 | `index.html`, `TURNSTILE_SITE_KEY`        | **Third-party, yours to configure** (dev uses Cloudflare's always-pass test key). Server-side verification goes through `/join_verify`, so it only protects you once a backend implements that |
| CrazyGames SDK                                                                                                                                                       | `index.html`                              | **Third-party platform SDK**, loaded for every visitor and inert off CrazyGames. Safe to remove if you will not publish there                                                                  |
| Stripe, Twitch embed, Discord CDN avatars, YouTube                                                                                                                   | client                                    | **Third-party**, only reached through gated features (or the tutorial video above)                                                                                                             |
| Grafana Faro, OpenTelemetry                                                                                                                                          | `FARO_COLLECTOR_URL`, `OTEL_*`            | **Off unless you set the env vars**                                                                                                                                                            |
| Deploy tooling (`deploy.sh`, `update.sh`, `setup.sh`, `.github/workflows/*`, `Dockerfile` staging timer)                                                             | repo root                                 | **OpenFront-specific ops**, not shipped to players. Adapt or replace for your hosting                                                                                                          |

## Two decisions before a public deployment

A server run with `GAME_ENV=prod` (or any non-dev environment) behaves differently from local dev. Neither of these is changed here because both are policy choices:

1. **Who may join.** `verifyClientToken` rejects anonymous player IDs outside dev ("persistent ID not allowed in production"), so every player needs a JWT from an issuer at `api.<DOMAIN>` (`/.well-known/jwks.json`). With no backend, nobody can join a production server. Options: build the minimum issuer, or add an explicit, opt-in "anonymous players" mode (this gives up account-based identity and the bot protection that `/join_verify` provides).
2. **Public lobbies on a deployed host.** A host that has a `SUBDOMAIN` registers with the API (`POST /cluster/checkin`) and "schedules nothing until the API calls it open". Without that endpoint a deployed host has no public lobbies (private lobbies and solo still work). Local dev has no `SUBDOMAIN` and schedules its own.
