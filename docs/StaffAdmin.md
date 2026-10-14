# Staff roles, permissions and the admin tools

DeltaFront has three staff roles (owner, admin, moderator), a web admin panel,
an in-game admin panel and one audit log behind all of them. This page is the
overview; the code is the reference.

## One authority for what a role may do

[`packages/shared/src/Permissions.ts`](../packages/shared/src/Permissions.ts) is
the only place that decides what a role can do. The account API, the game server
and the client (to hide what a player may not use) all ask `hasPermission(role,
permission)`. A test fails if any other source file compares a role to a staff
role name.

- `users.role` holds `owner`, `admin`, `mod`, `flagged` or nothing. `flagged` is a
  moderation state, not a staff role. `root` is upstream's spelling of owner and is
  read as `owner`.
- A role owns an **explicit set** of permissions (no "level >= n"), so a role that
  does not nest later (support, developer, tournament staff) is one new entry in
  `ROLE_GRANTS`.
- **Verified** (`users.verified`) and the **bare-username entitlement**
  (`users.bare_username_enabled`) are not roles and grant no permission.

### The matrix

| Permission                                                                                            | mod | admin | owner |
| ----------------------------------------------------------------------------------------------------- | :-: | :---: | :---: |
| `admin.panel.view`, `admin.dashboard.view`, `admin.users.view`, `admin.users.ban`, `admin.clans.view` |  x  |   x   |   x   |
| `admin.audit.view_moderation` (moderation actions only)                                               |  x  |   x   |   x   |
| `game.admin.panel`, `.spectate`, `.kick`, `.nations`                                                  |  x  |   x   |   x   |
| `admin.users.view_email`, `.sessions`, `.verify`, `.bare_name`, `.role`                               |     |   x   |   x   |
| `admin.wallet.grant`, `admin.inventory.grant`, `admin.clans.manage`, `admin.clans.official`           |     |   x   |   x   |
| `admin.audit.view` (everything), `admin.server.view`                                                  |     |   x   |   x   |
| `admin.xp.view` (an account's progression)                                                            |  x  |   x   |   x   |
| `admin.xp.history`, `admin.xp.grant`, `admin.xp.revoke`                                               |     |   x   |   x   |
| `admin.xp.set`, `admin.seasons.manage`                                                                |     |       |   x   |
| `game.admin.pause`, `.kill`, `.debug`                                                                 |     |   x   |   x   |
| `admin.roles.manage_admins`, `admin.clans.delete`, `admin.server.manage`                              |     |       |   x   |
| `game.admin.resources`, `.force_end`, `.impersonate_ai` (arbitrary game state)                        |     |       |   x   |
| `game.admin.public` (state-changing commands in public or listed games)                               |     |       |   x   |
| `game.admin.public.counted` (...and the game still counts)                                            |     |       |   x   |

`tests/Permissions.test.ts` spells the whole table out; moving a permission between
roles means changing that test, on purpose.

### Role changes

`canChangeRole` (same file): nobody changes their own role; an admin manages
moderators and the flag; only the owner touches admins; **owner is never assigned
over HTTP**. The CLI is the operator:

```bash
sudo -u df-api sh -c '
set -a
. /etc/deltafront/api.env
set +a
cd /opt/deltafront/current
exec npm run admin -- user:role <publicId> owner --reason "DeltaFront owner" --yes
'
```

At most `ACCOUNT_RULES.maxOwners` (3) accounts hold owner, and the last owner cannot
be demoted. `canActOnTarget`: nobody bans or signs out an account of equal or higher
standing.

## The `/admin` API

Authorization is decided on every request, in `src/account-api/routes/admin.ts`:
the bearer token must be valid with a live session, then the role is **read from the
database** (never from a token claim or anything sent), then `hasPermission` must
hold. No token is 401, no permission is 403. A demotion, a ban or a revoked session
ends access at once. Browsers authenticate with the `Authorization` header (no
cookie), so there is nothing to forge cross-site. Reads and writes are rate limited
per staff account. Every change takes a **reason**, destructive ones an explicit
`confirm: true`, runs in one transaction with its audit row, and no response carries
a token, hash or key.

| Endpoint                                                                                                            | Permission                                                     |
| ------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| `GET /admin/me`, `/admin/dashboard`                                                                                 | panel / dashboard view                                         |
| `GET /admin/users?q=`, `/admin/users/:id`                                                                           | `admin.users.view`                                             |
| `POST /admin/users/:id/verified`, `/bare-name`, `/role`, `/credits`, `/items`, `/ban`, `/unban`, `/revoke-sessions` | verify, bare_name, role, wallet, inventory, ban, ban, sessions |
| `GET /admin/clans`, `/admin/clans/:tag`                                                                             | `admin.clans.view`                                             |
| `POST /admin/clans` (official), `/rename`, `/tag`, `/open`, `/transfer`, `/members/:id/remove`, `/bans/:id`         | official / manage                                              |
| `POST /admin/clans/:tag/delete`                                                                                     | `admin.clans.delete` (owner)                                   |
| `GET /admin/audit`                                                                                                  | all, or moderation actions only                                |
| `GET /admin/server`                                                                                                 | `admin.server.view`                                            |
| `GET /admin/users/:id/progression`, `GET .../xp-history`                                                            | `admin.xp.view`, `admin.xp.history`                            |
| `POST /admin/users/:id/xp` (`grant`, `revoke`, `set`)                                                               | `admin.xp.grant`, `.revoke`, `.set`                            |
| `POST /admin/users/:id/season-reset`, `GET/POST /admin/seasons`, `PATCH /admin/seasons/:id`, `POST .../close`       | `admin.seasons.manage` (owner)                                 |
| `POST /game_admin/audit`                                                                                            | game-server key (not a browser)                                |

The CLI and the API call the same functions (`src/account-api/domain/adminOps.ts`),
so a rule is written once. Opening the panel: profile menu > Admin panel
(`#modal=admin`); what it shows follows the role, but that is presentation only.

## XP and seasons

See [Progression.md](Progression.md). XP changes follow the wallet pattern: a reason
(required), the audit row written first (`xp:grant`, `xp:revoke`, `xp:set`,
`season:create|update|close|reset-user`) with actor, role, target, amount and
before/after, and an `xp_ledger` row whose reference is the audit id. `canActOnTarget`
applies and nobody changes their own XP from the web panel (the CLI is the operator). A
grant is at most 100,000 XP per command; a revoke larger than the run is refused; `set`
moves lifetime XP by the difference. A revoke never takes back a reward already
unlocked. CLI: `xp:show`, `xp:grant`, `xp:revoke`, `xp:set`, `season:list`,
`season:create`, `season:close`.

## Audit log

`admin_audit_log` records `actor`, `actor_user_id`, `actor_role` (a snapshot), `source`
(`cli`, `web` or `game`), `action`, the target, the reason and the details, in the same
transaction as the change. Actions are `user:*`, `wallet:*`, `item:*`, `clan:*`,
`server:*` and `game:kick|pause|command`. Owners and admins see all of it,
moderators moderation actions only. Secret-looking keys in `details` are redacted when
shown.

## Badges

Staff badges (owner, admin, moderator) are separate marks from the verified check and
can show beside it. They come from an explicit, server-stamped `staffRole`:
`/users/@me`, the public profile, the leaderboard, clan member lists, and, in a game,
the player's cosmetics and the lobby roster (stamped by the game server from the API's
answer at join, whatever the client sent). They are never worked out from a username,
a bare name or verification, and are hidden beside anonymized names.

## In-game admin

Open the panel with the toggle at the top of the screen or the backquote key (staff
only). Tabs: Players (list, camera, kick, eliminate, resources), Game (pause, force a
winner, debug info) and Testing tools. Every action is an ordinary intent the **game
server** authorizes against the sender's permission before relaying it
(`src/server/IntentAuthorization.ts`); the engine then applies it identically on every
client (`AdminCommandExecution`). The role the server acts on is the API's current
answer at join, so a demotion applies to the next join.

- Commands that change the game (`admin_command`) need their own permission, and in a
  public or listed game also `game.admin.public`, which only the owner holds. An admin
  or moderator is refused there (403, "owner-only") exactly as before; kicks, pauses and
  the camera still work for them. The panel offers an admin "Admin tools are disabled in
  public games" instead of the tools.
- Whether a command makes the game a test is `adminCommandInvalidatesResult` (shared):
  **only the owner's commands in a public or listed game leave the result intact**
  (`game.admin.public.counted`); every command in a private or unlisted game, the
  owner's included, makes it **admin-modified**: no stats, Credits, clan-threshold credit
  or leaderboard entry. The game server stamps what it relayed into the record
  (`info.adminActions`: command, the sender's stored role, whether the game was public or
  listed, a count), and the API recomputes the verdict from the role and game kind, never
  from a stored "harmless" flag. It fails closed: an `admin_command` in the recorded turns
  that the metadata does not account for (an older server, a damaged record) invalidates.
  The audit log records owner commands in public games like any other and says nothing
  about the result.
- Staff kicks, pauses and commands are reported to `/game_admin/audit` (best effort,
  always in the game server's own log), with whether the game was `public` or `listed`.
- Every command that runs also appears to the players in that game as a public match
  event ("Owner Alphaz used admin tools on RedFox", "Alphaz forced the winner") with no
  amounts, reason or audit detail; see [MatchEvents.md](MatchEvents.md). The event is a
  consequence of the recorded command and changes nothing about admin-modified detection.

## Official clans

Admins and owners skip the account-age and completed-games rules and may use reserved
tags and names (so `DeltaFront` / `DELTA` can exist). No match history is invented.
Verified-only and bare-name-only accounts get no such right.

## Deliberately not built yet

Invulnerability, forced alliances, instant tile capture, game speed, "reveal map"
(there is no fog of war), a feature-flag and maintenance-mode system, staff notes,
reports and tickets, temporary permissions. The permission and audit structure leaves
room for each.
