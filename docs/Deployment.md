# Deploying DeltaFront on one server

This is the production setup for a single Linux server: PostgreSQL, the account API, the game server with the web client, and nginx in front. It is written for the public launch (milestone M7) and is **instructions, not automation**: nothing in the repository deploys anything. The reference files are in [`deploy/`](../deploy).

`npm run launch:check` tells you, without changing anything, whether a deployment is ready. Run it before every launch and after every configuration change.

## 1. What runs where

```
 internet ──443──► nginx (host)  ── TLS, HSTS, rate brakes, X-Forwarded-For overwritten
                     │
      example.com ───┼──► 127.0.0.1:3080  game container  (nginx → Node master :3000 → workers :3001…)
                     │                       serves the web client, /api/*, and the WebSockets (/w0, /w1, …)
  api.example.com ───┴──► 127.0.0.1:8787  account API     (Node, systemd)
                                               │
                                               └──► 127.0.0.1:5432  PostgreSQL (host package, systemd)
```

| Component     | Process owner | Started by                             | Restart behaviour                    | Listens on     |
| ------------- | ------------- | -------------------------------------- | ------------------------------------ | -------------- |
| nginx (edge)  | `www-data`    | distro `nginx.service`                 | `systemctl reload nginx` for config  | 80, 443        |
| game + client | container     | `deltafront-game.service` (docker)     | `Restart=always`, 30 s graceful stop | 127.0.0.1:3080 |
| account API   | `df-api`      | `deltafront-account-api.service`       | `Restart=always`, drains on SIGTERM  | 127.0.0.1:8787 |
| PostgreSQL    | `postgres`    | distro `postgresql.service`            | distro default                       | 127.0.0.1:5432 |
| backup        | `df-backup`   | `deltafront-backup.timer` (03:17 UTC)  | `Persistent=true`, alert on failure  | none           |
| health probe  | `nobody`      | `deltafront-healthcheck.timer` (1 min) | alert on failure                     | none           |

Only 80 and 443 are open to the internet. Nothing else listens on a public address. The game server calls the account API through its public name `https://api.<domain>`; the unit maps that name to the host (`--add-host … :host-gateway`) so the traffic stays on the machine and the TLS certificate still matches.

**One instance of each.** The account API's rate limits and its Turnstile replay cache are in memory, which is correct for one process and wrong for two: with several API instances each would count separately. Running more than one needs a shared store for those two things (Redis or a PostgreSQL table); that is not built and not needed for a single server.

## 2. Before you start: three accounts only a person can create

None of this can be done by code, and none of it has been tested against the real services (see §12).

**Discord application** (<https://discord.com/developers/applications>)

1. _New Application_ → name it after the game.
2. _OAuth2_ → _Redirects_ → add exactly `https://api.<domain>/auth/callback/discord`.
3. Copy the _Client ID_ and _Client Secret_ → `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET` in `api.env`.
4. No bot, no other scopes: the API asks for `identify email` only. Set the app's name, icon and the Terms/Privacy URLs (`https://<domain>/terms-of-service.html`, `/privacy-policy.html`) so the consent screen is honest.

**Google OAuth client** (<https://console.cloud.google.com/apis/credentials>)

1. Create a project. _OAuth consent screen_ → _External_; app name, support email, your domain as an authorized domain, the Terms and Privacy URLs.
2. Scopes: `openid`, `email`, `profile` (non-sensitive: no Google review needed).
3. **Publish the app** ("In production"). In "Testing" mode only listed test users can sign in and grants expire after 7 days.
4. _Credentials_ → _Create OAuth client ID_ → _Web application_ → _Authorized redirect URIs_: exactly `https://api.<domain>/auth/callback/google`. (No JavaScript origins are needed.)
5. Copy the ID and secret → `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`.

**Cloudflare Turnstile** (dashboard → _Turnstile_ → _Add widget_)

1. Hostnames: your domain (a widget on `example.com` also works on its subdomains). Do not add `localhost`.
2. Mode _Managed_ (the client renders it as "interaction only").
3. Site key → `TURNSTILE_SITE_KEY` in `game.env`; secret key → `TURNSTILE_SECRET_KEY` in `api.env`. Never use Cloudflare's published test keys (`1x000…`, `2x000…`, `3x000…`): they always pass or always fail; `launch:check` refuses them.

The API also checks that Cloudflare reports the token was solved on one of your hostnames (`TURNSTILE_ALLOWED_HOSTNAMES`, default your domain) and for the action `join`.

## 3. First-time install

Commands run as root unless noted. Replace `example.com`.

```bash
# 1. Packages: Node 24, PostgreSQL 16 or 17, nginx, certbot, docker, rclone, age, curl
# 2. Users and directories
useradd --system --home /opt/deltafront --shell /usr/sbin/nologin df-api
useradd --system --home /var/lib/df-backup --create-home --shell /usr/sbin/nologin df-backup
install -d -o root -g root -m 0755 /opt/deltafront /etc/deltafront
install -d -o df-backup -g df-backup -m 0700 /var/backups/deltafront

# 3. The code: a release directory and a "current" symlink
git clone <your repository> /opt/deltafront/releases/<commit>   # or unpack a tarball
ln -sfn /opt/deltafront/releases/<commit> /opt/deltafront/current
cd /opt/deltafront/current && npm run inst                       # npm ci --ignore-scripts

# 4. Database roles and database (passwords are passed with -v, never written to a file)
sudo -u postgres psql -v owner_pw="'$(openssl rand -base64 24)'" \
  -v app_pw="'...'" -v backup_pw="'...'" -f deploy/postgresql/roles.sql
#    keep the three passwords in your password manager; they go into the env files below

# 5. The signing key (Ed25519). Private: only df-api reads it. Not in the repository.
openssl genpkey -algorithm ed25519 -out /etc/deltafront/jwt-ed25519.pem
chown df-api:df-api /etc/deltafront/jwt-ed25519.pem && chmod 0600 /etc/deltafront/jwt-ed25519.pem

# 6. Environment files: copy deploy/env/*.example to /etc/deltafront/ and fill in EVERY CHANGE_ME
install -m 0640 -o root -g df-api    deploy/env/api.env.example    /etc/deltafront/api.env
install -m 0600 -o root -g root      deploy/env/game.env.example   /etc/deltafront/game.env
install -m 0640 -o root -g df-backup deploy/env/backup.env.example /etc/deltafront/backup.env

# 7. Migrate (a deliberate step, as the OWNER role: the API's role cannot change the schema)
DATABASE_URL=postgres://df_owner:...@127.0.0.1:5432/deltafront npm run account-api:migrate
npm run account-api:migrate -- status        # everything "applied", nothing "pending"

# 8. Build the game image with the launch features
docker build --build-arg GIT_COMMIT=$(git rev-parse HEAD) \
  --build-arg DF_ACCOUNT_FEATURES=accounts,store,inventory,clans,leaderboards \
  -t deltafront-game:current .

# 9. Start the API, register the game server's key, then start the game
cp deploy/systemd/* /etc/systemd/system/ && systemctl daemon-reload
systemctl enable --now deltafront-account-api
npm run admin -- server:key:create game-1     # prints the key ONCE → API_KEY in game.env
systemctl enable --now deltafront-game

# 10. nginx + TLS
sed 's/example\.com/your-domain.tld/g' deploy/nginx/deltafront.conf > /etc/nginx/conf.d/deltafront.conf
certbot certonly --webroot -w /var/www/certbot -d example.com -d api.example.com
nginx -t && systemctl reload nginx

# 11. Timers and the alert hook
install -m 0755 deploy/bin/df-alert.example /etc/deltafront/alert   # then edit it for YOUR channel
systemctl enable --now deltafront-backup.timer deltafront-healthcheck.timer

# 12. The gate
npm run launch:check -- --probe
```

The admin command line reads `DATABASE_URL` from the environment. Run it as `df-api` with `api.env` loaded:

```bash
sudo -u df-api sh -c 'set -a; . /etc/deltafront/api.env; cd /opt/deltafront/current; exec npm run admin -- user:find <publicId>'
```

### Environment files

| File                              | Mode / owner        | Used by                           | Holds secrets?                                          |
| --------------------------------- | ------------------- | --------------------------------- | ------------------------------------------------------- |
| `/etc/deltafront/api.env`         | 0640 root:df-api    | the account API                   | yes: database password, OAuth secrets, Turnstile secret |
| `/etc/deltafront/game.env`        | 0600 root           | the game container (`--env-file`) | yes: the server API key                                 |
| `/etc/deltafront/backup.env`      | 0640 root:df-backup | the backup job                    | a read-only database password; a **public** age key     |
| `/etc/deltafront/jwt-ed25519.pem` | 0600 df-api         | the account API                   | the signing key                                         |

A `.env` in the repository directory is for development only. The services would load one if it existed (variables already set by systemd win), so do not leave one on the server.

The client build bakes in **only** `DF_ACCOUNT_FEATURES` (a list of feature names, sanitised: an unknown name stops the build) and the public deployment facts the server injects into the page at request time (Turnstile **site** key, domain). No secret is a build argument or reaches the browser bundle; `launch:check` scans the built files for the values of every secret and fails if one is there.

## 4. Feature flags

`DF_ACCOUNT_FEATURES=accounts,store,inventory,clans,leaderboards` is the launch set, identical in the client build (`docker build --build-arg`), the game server (`game.env`) and the account API (`api.env`). It differs from the plan's list (`accounts,leaderboards,store,clans`) by one name: **`inventory`**, because the store and clans read the cosmetic catalog and the Inventory page is part of the launch.

Everything else (`ranked`, `payments`, `friends`, `progression`, `tribes`, `trustedLobbies`) has no backend yet and stays off. This is enforced, not just documented:

- the account API and the game server **refuse to start** outside dev with any other flag (`unfinishedFeatures`);
- the game server refuses to start if its flags differ from the ones the client in `static/` was built with (`static/account-features.txt`, written by `npm run build-prod`);
- `launch:check` fails unless the set is exactly the launch set.

## 5. Updating, and going back

```bash
git -C /opt/deltafront/releases clone … <new-commit>          # or unpack
cd /opt/deltafront/releases/<new-commit> && npm run inst
npm run launch:check -- --no-database                         # config + build sanity
docker build … -t deltafront-game:<new-commit> .              # same build args as before
npm run account-api:migrate                                   # as df_owner; forward-only
ln -sfn /opt/deltafront/releases/<new-commit> /opt/deltafront/current
systemctl restart deltafront-account-api                      # drains, restarts in seconds
docker tag deltafront-game:<new-commit> deltafront-game:current
systemctl restart deltafront-game                             # ~30 s: players reconnect
npm run launch:check -- --probe
```

Keep the previous release directory and image tag. **Rolling back code** is the same steps pointed at the old release. **Migrations are forward-only and never undone**: a bad migration is fixed by a new migration, or, if data was damaged, by restoring the last backup (§8). Each migration runs in its own transaction with its history row, so a failed one leaves nothing behind and `account-api:migrate` can simply be run again after the fix; two concurrent runs are serialised by an advisory lock.

## 6. Health, readiness, logs

| Endpoint                   | Meaning                                                                  | Public?       |
| -------------------------- | ------------------------------------------------------------------------ | ------------- |
| `GET api.<domain>/health`  | the API process answers (liveness)                                       | yes           |
| `GET 127.0.0.1:8787/ready` | database reachable, migrations current, signing key loaded, not draining | loopback only |
| `GET <domain>/api/health`  | the game server master process answers                                   | yes           |

`/ready` answers `{"status":"ready"|"not_ready","checks":{"database":"ok|fail","migrations":…,"signingKey":…,"draining":…}}` and nothing else: no versions, hosts or error text (those go to the log). It turns `not_ready` the moment shutdown starts, and a check never takes longer than 2.5 s. `deltafront-healthcheck.timer` probes all three every minute and runs `deltafront-alert@…` on failure. Also point an external monitor at the two public URLs, because a dead machine cannot report itself.

Logs: the API writes JSON lines to stdout (`journalctl -u deltafront-account-api -o cat`); the game container's logs are `docker logs deltafront-game`. What the API logs, and what it never does:

- one line per refused (4xx) or failed (5xx) request, slow requests at warn, everything at debug: **method, route pattern (`/auth/callback/:provider`), status, milliseconds**. Never the URL, query string, headers, cookies or body, so the OAuth `code` and `state` cannot appear;
- failed sign-ins (`sign-in failed` with provider and reason), refresh-token reuse (`refresh rejected`, reason `reuse_detected`, at warn), join verification failures, Turnstile problems, check-in problems and database errors, each with a reason code;
- every record passes through a redactor (`src/account-api/redact.ts`) that replaces values under keys like `token`, `secret`, `password`, `authorization`, `cookie`, `apiKey`, `email`, and scrubs JWTs, `dfk_` keys, `Bearer` values, `postgres://` URLs, e-mail addresses and `?code=`/`state=` query values out of any text. It is a net under careful code, not a substitute for it.

## 7. Signing-key rotation

Access tokens last 15 minutes and are signed with an Ed25519 key. The API publishes its public keys at `/.well-known/jwks.json` (`kid` = the key's RFC 7638 thumbprint). The game server keeps the whole set in memory, picks by `kid`, refreshes it in the background every 10 minutes and **immediately (once per 30 s at most) when a token names a key it does not know**. A join never waits for a network fetch once the server holds keys; if the API is unreachable it keeps using the keys it has for up to an hour, then refuses.

**Planned rotation** (no one is signed out):

```bash
cd /etc/deltafront
openssl pkey -in jwt-ed25519.pem -pubout -out jwt-previous.pub.pem # the OLD key, public half
openssl genpkey -algorithm ed25519 -out jwt-new.pem
chown df-api:df-api jwt-new.pem jwt-previous.pub.pem && chmod 600 jwt-new.pem jwt-previous.pub.pem
mv jwt-new.pem jwt-ed25519.pem
# api.env:  JWT_PREVIOUS_PUBLIC_KEY_PATH=/etc/deltafront/jwt-previous.pub.pem
systemctl restart deltafront-account-api
```

The key set now lists the new key first and the old one second. New tokens carry the new `kid`; tokens signed with the old key keep verifying (on the API and on the game server). **Wait at least 30 minutes** (15 minutes of token life + up to 10 minutes of game-server cache + slack), then remove `JWT_PREVIOUS_PUBLIC_KEY_PATH`, delete `jwt-previous.pub.pem`, and restart the API again. The old key then disappears from the set and the game server drops it at its next refresh; a token signed with it is refused after that.

**Emergency rotation** (the private key leaked): do the same without the overlap, i.e. replace the key, leave `JWT_PREVIOUS_PUBLIC_KEY_PATH` unset, restart the API, then `systemctl restart deltafront-game` so no game worker holds the old key in memory. Everyone's access token stops working at once; browsers hold refresh cookies, which are independent of the signing key, and quietly get new tokens. If the leak might include refresh-token hashes or the database, also run `npm run admin -- user:revoke-sessions` for affected accounts.

## 8. Backups and the restore drill

PostgreSQL is the only state that matters (the signing key and env files are configuration: keep them in your password manager). `deltafront-backup.timer` runs `npm run backup:run` nightly at 03:17 UTC:

1. `pg_dump --format=custom --compress=9 --no-owner --no-privileges` as the read-only `df_backup` role;
2. piped straight into `age` (public-key encryption) — **the plaintext dump never touches the disk**;
3. written as `deltafront-YYYYMMDDTHHMMSSZ.dump.age` (mode 0600) with a `.sha256`, refusing anything under 1 KiB;
4. copied off-site with `rclone copyto … --immutable` (never overwrites);
5. only then pruned: locally 7 days; off-site 14 daily + 8 weekly + 12 monthly (the newest backup is never pruned, and only files named exactly like backups are ever considered).

Setup: `age-keygen -o ~/df-backup-key.txt` **on a different machine**; put the printed public key (`age1…`) in `BACKUP_AGE_RECIPIENT`; store the private key file in your password manager and on paper. The server holds only the public half, so a stolen server cannot decrypt old backups and a stolen backup bucket is unreadable. `rclone config` as `df-backup` creates the remote named in `BACKUP_REMOTE` (use a bucket-scoped key that can write but not delete if your provider offers one; retention pruning then needs a second, separate credential, or lifecycle rules on the bucket).

`npm run backup:run -- --dry-run` prints exactly what would run (command lines and variable _names_ only).

**Restore drill — do it before launch and then every quarter.** A backup you have not restored is a hope.

```bash
# on any machine that has PostgreSQL client tools, age, and the private key
rclone copyto b2:deltafront-backups/prod/deltafront- ./ < stamp > .dump.age && sha256sum -c ...
npm run backup:drill -- ./deltafront- --identity ~/df-backup-key.txt < stamp > .dump.age
#   → verifies the checksum, creates df_restore_drill_<id>, restores into it, checks that all
#     migrations are recorded and the core tables exist, prints counts, drops the scratch database
```

**Recovering after a disaster:** install the stack (§3), create the roles, `createdb`/restore into `deltafront` with `age --decrypt -i key.txt file.age | pg_restore --no-owner --role=df_owner -d deltafront`, run `npm run account-api:migrate -- status` (it must say nothing is pending for that release; if the backup is older than the code, migrate forward), start the services, run `launch:check -- --probe`. Credits are in the database: a restore loses what happened after the last backup (at most a day); say so to players.

## 9. The database in production

- Pool: `DATABASE_POOL_MAX` (default 10) connections; 5 s connect timeout; idle connections dropped after 30 s; TCP keepalive on, so a restarted PostgreSQL is noticed.
- Per session: `statement_timeout` (`DATABASE_STATEMENT_TIMEOUT_MS`, 30 s), `lock_timeout` 15 s, `idle_in_transaction_session_timeout` 60 s. A runaway query or a stuck transaction frees its connection instead of freezing the service. Migrations lift the statement and idle limits for themselves and use a 30 s lock timeout so a blocked migration fails the deploy instead of queueing the live API behind it.
- Deadlocks and serialization failures are retried (three attempts, short random pause) on a fresh transaction; every other error is thrown at once. Code that takes several locks takes the wallet first, so retries are rare.
- A dropped connection does not kill the process: the pool discards it and the next query opens a new one (tested by terminating the service's database sessions). `/ready` reports the outage while it lasts.
- **Migrations are never applied by the service.** It refuses to start if any are pending and says which command to run. `account-api:migrate` uses an advisory lock, records a checksum per file and refuses a changed file or a database newer than the code.
- Shutdown (`SIGTERM`/`SIGINT`): `/ready` goes 503, the port stops accepting, idle keep-alive connections close at once, in-flight requests get `SHUTDOWN_TIMEOUT_MS` (15 s), then the pool is closed. A 5 s hard backstop ends the process regardless.
- Remote database: use `sslmode=verify-full` in `DATABASE_URL` (`launch:check` warns about an unencrypted remote connection). On the same machine, the loopback connection needs none.

## 10. Rate limits, abuse brakes and headers

Application limits (per process, in memory; windows are fixed):

| Route / action                                                            | Limit                                                               | Key     |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------- | ------- |
| new guest account (`/auth/refresh`, no cookie)                            | 10 per hour                                                         | address |
| sign-in start (`/auth/login`, `/auth/link`)                               | 30 per minute                                                       | address |
| OAuth callback                                                            | 60 per minute                                                       | address |
| session refresh                                                           | 120 per minute                                                      | address |
| username change                                                           | 5 per hour (valid names only; the 7-day cooldown is the real limit) | account |
| store purchase                                                            | 20 per minute                                                       | account |
| clan changes / clan creation                                              | 20 per minute / 3 per day (successful creations)                    | account |
| account deletion request                                                  | 5 per hour                                                          | address |
| public reads (profiles, leaderboards, clans)                              | 240 per minute                                                      | address |
| server calls with a valid key (join verification, check-in, game archive) | 1200 per minute                                                     | address |
| wrong or missing server keys                                              | 30 per minute, then 429 even for the right key                      | address |

nginx adds a coarse brake (30 requests/second, 5/second on `/auth/`) in front. The address is the real client only if `TRUST_PROXY_HOPS=1` and nginx overwrites `X-Forwarded-For` (the shipped config does); `launch:check` fails on `TRUST_PROXY_HOPS=0` behind a proxy because every player would then share one limit.

Headers. The **API** answers JSON only and sends `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `X-Frame-Options: DENY`, `Content-Security-Policy: default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`, `Cache-Control: no-store` by default (public data sets its own: the key set 5 minutes, the catalog and its assets, the news feeds) and HSTS. CORS allows only `ALLOWED_ORIGINS`, with credentials, never `*`. The **game server's page** is sent with the same nosniff/referrer/frame headers, a `Permissions-Policy` that turns off camera, microphone, geolocation, payment and USB, `Cross-Origin-Opener-Policy: same-origin-allow-popups`, and a Content-Security-Policy built from the page itself:

- `script-src 'self'`, the SHA-256 of each inline script actually in the rendered page (so an injected script cannot run; no `'unsafe-inline'`, no `'unsafe-eval'`), Cloudflare Turnstile, the CrazyGames SDK host, and — only when you enabled them — Google Analytics / Cloudflare Web Analytics;
- `connect-src` your API origin, your domain's `wss://`, Turnstile; `frame-src` Turnstile only; `img-src` self, `data:`, `blob:`, Discord's avatar CDN, your API (cosmetic images); `object-src 'none'`; `frame-ancestors 'self'`; `upgrade-insecure-requests`.
- `CSP_MODE=report-only` shows violations in the browser console without blocking while you investigate; `off` disables it and `launch:check` fails on it.

If you add a third-party script or service, add its host to `src/server/SecurityHeaders.ts` and to the audited list in `tests/ThirdPartyHosts.test.ts` and `docs/OpenFrontAudit.md`; the test fails until you do.

## 11. Terms of Service and Privacy Policy (a launch blocker, and yours)

`resources/public/terms-of-service.html` and `privacy-policy.html` are **placeholders**. The text is a legal document that only you can write or commission; code cannot supply it. What the code does is refuse to let the placeholders go public unnoticed:

- the game server in `GAME_ENV=prod` **refuses to start** while either page is a placeholder (`ALLOW_PLACEHOLDER_LEGAL_PAGES=1` overrides this for a private rehearsal and is logged on every start); in staging it warns;
- `npm run launch:check` fails, listing each problem per page.

A page passes when it: no longer carries the `DELTAFRONT PLACEHOLDER` marker or placeholder wording; has a review marker `<!-- DELTAFRONT-LEGAL-REVIEWED: 2026-11-01 by Jane Doe -->` with a real date and name; gives a way to contact you; is at least ~1,500 characters of text; and mentions the subjects DeltaFront's behaviour makes unavoidable. That check is a floor, not legal advice. The pages must truthfully cover:

- **Privacy:** what Discord and Google share (user id, name, avatar, e-mail) and what is stored (identities, username, e-mail only to detect conflicts); the refresh-session cookie (`df_refresh`, HttpOnly, 30 days) and the short-lived `df_oauth` cookie; IP addresses (stored only as a keyed hash with the session, for abuse investigation) and user agents; Cloudflare Turnstile and the data it sees; game records (usernames in replays for 60 days; game history and stats without names afterwards); Credits and purchase history; clans; logs (route, status, no query strings); backups (encrypted, up to 12 months off-site); retention; **deletion** (24 hours after the request; §13) and that an active ban blocks self-service deletion; the operator's identity and contact; the right to access and erase.
- **Terms:** one account per person, conduct and bans, Credits are an in-game currency with **no cash value** and are not transferable or refundable, no warranty and limitation of liability, governing law, changes to the terms, the AGPL notice for the software.

After editing, rebuild (`static/` carries copies) and run `launch:check`.

## 12. Live verification — what no test here could do

The code has been exercised against stand-in providers and a local PostgreSQL. **It has not been run against the real Discord, Google or Cloudflare**, because that needs your credentials and a public domain. Before announcing, do each of these once on the real deployment and watch `journalctl -u deltafront-account-api -o cat` while you do:

1. Sign in with Discord from a clean browser: you return to the game signed in; `/users/@me` shows a Discord identity; a second browser reaches the same account.
2. The same with Google (with a Google account whose e-mail is verified, and note that an e-mail already used by another account is refused on purpose).
3. Click _Cancel_ on each provider's consent screen: you return signed out with no error page.
4. Join a public lobby as a guest and as a signed-in player: both admitted with the widget's token; the API log shows no `Turnstile unavailable`.
5. Simulate a Cloudflare outage: temporarily set a wrong `TURNSTILE_SECRET_KEY` and restart the API; a guest is refused with the "bot check is temporarily unavailable" message, a signed-in player still joins (`TURNSTILE_FALLBACK=registered`). Restore the secret.
6. Finish a game; check the winner's Credits and the leaderboard after the 5-minute rebuild.
7. Delete a test account; 24 hours later confirm it is gone (§13).
8. `npm run backup:run`, then the restore drill (§8).

Until these are done, say in the release notes that sign-in is "launching".

## 13. What happens to your data

| Data                                                     | While the account lives              | After deletion (24 h after the request)                                                                                                                           |
| -------------------------------------------------------- | ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sign-in identities (provider id, e-mail, profile)        | kept                                 | deleted                                                                                                                                                           |
| Refresh sessions (user agent, hashed IP)                 | kept; dead rows pruned after 30 days | deleted at once (all sessions are also revoked when deletion is requested)                                                                                        |
| Username, role, username cooldown                        | kept                                 | cleared                                                                                                                                                           |
| Stats aggregates                                         | kept                                 | deleted                                                                                                                                                           |
| Game history rows                                        | linked to the account                | kept for other players' history but **anonymised**: no account link, name becomes "Deleted player", clan tag removed                                              |
| Stored game record (replay data, includes in-game names) | kept 60 days, then pruned            | pruned on the same schedule; not rewritten (the in-game name is visible to everyone who played)                                                                   |
| Credits wallet, ledger, purchases, owned items           | kept                                 | kept as records under the anonymous tombstone id (they identify no one)                                                                                           |
| Clan membership, leadership                              | kept                                 | removed; a leader's clan passes to the oldest officer, else the oldest member, else it is disbanded                                                               |
| The account row                                          | kept                                 | stays as a **tombstone** (random ids and timestamps only) so references in records keep meaning                                                                   |
| Bans                                                     | kept                                 | **an active ban blocks the request** (otherwise deleting would erase the evidence and let the player return as someone new); the request waits until the ban ends |
| Admin audit log                                          | kept                                 | kept (staff actions)                                                                                                                                              |
| Backups                                                  | rolling 7 / 14 / 8 / 12              | an erased account can reappear if a backup is restored; re-run the deletion afterwards                                                                            |

The deletion job and the retention jobs run every 10 minutes while accounts are enabled; they are idempotent and safe to run from several instances.

## 14. The admin command line

There is no admin web panel and no admin HTTP route (a test asserts the API answers 404 to every admin-looking path). Everything is `npm run admin -- <command>` on the server, with the API's database access:

- destructive commands need `--yes` **and** a `--reason` (up to 200 characters): `user:ban`, `user:unban`, `user:revoke-sessions`, `user:role`, `item:revoke`, `server:key:revoke`, `server:state`, `clan:*` that remove or transfer, `wallet:revoke`; `wallet:grant` also needs a reason, and `item:grant` is idempotent; both are audited;
- every change writes `admin_audit_log` (who, what, which target, the reason, before/after where it matters) **in the same transaction** as the change;
- `server:key:revoke` refuses to revoke the **last** active key (it would lock every game server out) unless you pass `--allow-last`; rotate by creating the new key first. A key registered from the development placeholder is refused when `GAME_ENV` is staging or prod;
- a generated server key is printed once and never stored or logged (only its SHA-256 is kept); `--from-env` registers a key without printing it.
