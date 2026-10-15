# Progression: XP, levels, ranks, prestige, seasons and challenges

Everything here is **cosmetic and status only**. XP cannot be bought, no rank, level,
prestige or season position changes anything in a game, and Credits (the currency)
and XP are separate. It lives in the account API and is switched on by the
`progression` feature flag (part of the launch set since v0.3.0).

The shared rules are [`packages/shared/src/ProgressionRules.ts`](../packages/shared/src/ProgressionRules.ts)
(the level curve, ranks, prestige, season levels and track, milestones, titles). The
numbers that tune how XP is earned are `PROGRESSION` in
[`src/account-api/domain/constants.ts`](../src/account-api/domain/constants.ts), the one
place to rebalance them. Each game stores its own breakdown and the XP ledger is
append-only, so changing a number never rewrites history.

## State

`user_progress` holds, per registered account: **lifetime XP** (never reset), **run XP**
(XP of the current prestige run, 0 to 524,810, reset by prestige) and the **prestige**
count (0 to 10). Level and rank are **derived** from run XP, never stored. Prestige 10
at level 100 is **Legend**: no further prestige, lifetime XP keeps counting.

Every change is an `xp_ledger` row (match, daily/weekly challenge, admin grant, revoke
or set). Game and challenge awards are unique per `(user, source, reference)`, so a
game or a challenge can never pay twice, whatever is retried.

## Level curve

`xpToNext(L) = round((10000 + 1500·n + 7·n²) / 200) × 10`, with `n = L − 1`, in whole
numbers.

| Level | XP to next | Run XP at which it is reached |
| ----: | ---------: | ----------------------------: |
|     1 |        500 |                             0 |
|     2 |        580 |                           500 |
|     5 |        810 |                         2,460 |
|    10 |      1,200 |                         7,270 |
|    20 |      2,050 |                        23,060 |
|    25 |      2,500 |                        34,210 |
|    50 |      5,020 |                       126,000 |
|    75 |      7,970 |                       285,900 |
|    90 |      9,950 |                       419,060 |
|    99 |     11,210 |                       513,600 |
|   100 |          — |                       524,810 |

## Ranks (display only)

1–9 Recruit · 10–19 Private · 20–29 Corporal · 30–39 Sergeant · 40–49 Lieutenant ·
50–59 Captain · 60–74 Major · 75–89 Colonel · 90–99 General · 100 Supreme Commander.

## Match XP

Decided when the game server submits the finished game (`domain/ingest.ts`, the same
transaction that stores the game and pays Credits). Nothing comes from a browser.

### How far a game progresses: full, reduced, none

One authoritative answer per game, `progressionEligibility` in `domain/xp.ts`
(`{ mode: "full" | "reduced" | "none", reason }`), built on the stats rule
(`countedVerdict` in `domain/stats.ts`):

| Game                                                                    | Mode        | Reason                  |
| ----------------------------------------------------------------------- | ----------- | ----------------------- |
| A qualifying public game (the stats rule)                               | **full**    | `normal_public`         |
| A public game with too few eligible humans                              | **reduced** | `public_too_few_humans` |
| A private lobby that was publicly listed (or a record that doesn't say) | **reduced** | `private_game`          |
| An unlisted private lobby                                               | **reduced** | `unlisted_game`         |
| Singleplayer                                                            | none        | `singleplayer`          |
| Ranked (not served yet)                                                 | none        | `ranked`                |
| A game staff tests changed (whatever kind it was)                       | none        | `admin_modified`        |
| A game shorter than the stats minimum (two minutes), reduced or not     | none        | `too_short`             |

The owner's commands in a counted public or listed game leave the result intact (see
[StaffAdmin.md](StaffAdmin.md)). The game server records whether a private lobby was
listed (`info.listed`); the client never decides any of this.

**Player-level**, for a game that is full or reduced: a registered account (guests earn
nothing, but count towards the player-count multiplier of a full game), who completed the
game (the Credits rule: there was a winner and they survived to the end, or were
eliminated after two minutes, and were connected), took a gameplay action, and did not
send an admin command in this game (`admin_actor`: nobody farms XP with their tools;
everyone else in the game is still paid). A player who does not qualify has a stored reason
(`guest`, `no_action`, `left_early`, `eliminated_early`, `not_spawned`, `no_winner`,
`admin_actor`).

### Full progression

| Line                               | XP                                                                                         |
| ---------------------------------- | ------------------------------------------------------------------------------------------ |
| Completed match                    | +100                                                                                       |
| Placement (FFA only)               | top 50% +50 · top 25% +100 · top 10% +150, highest tier only                               |
| Victory                            | +250                                                                                       |
| Eliminations                       | +25 each, at most 6; the victim must have lasted two minutes; bots and nations never count |
| First eligible game of the UTC day | +100                                                                                       |
| First eligible win of the UTC day  | +150                                                                                       |

`subtotal × player-count × repeated-opponents`, rounded down, then capped at **1,250**
per match, then the **daily soft cap**: match XP above 6,000 in a UTC day is paid at
25% (the game that crosses the line is split; there is no hard stop). Full games also
advance the season, the challenges and clan XP.

**Player-count multiplier**, by eligible humans (account holders who completed the game
and acted; bots, nations, leavers and idle players do not count): 1–2 ×0.10 · 3–5 ×0.50 ·
6–15 ×1.00 · 16–30 ×1.15 · 31+ ×1.25. The daily bonuses are only spent by a game with at
least ×0.5.

**Repeated opponents:** in a game with 15 or fewer other eligible players, if more than
half of them have completed 5+ counted games with the player in the previous 24 hours the
award is ×0.5, and ×0.25 if more than half have 10+. Flagged `repeat_group`.

### Reduced progression

Completed-match XP plus valid elimination XP (same rules and limit of 6), × **0.25**,
rounded down, to **lifetime XP only**: `(100 + 25) × 0.25 = 31`. Nothing else is paid:
no placement, victory, first-game or first-win XP (and none of the day's bonuses is
used up), no season XP and no season leaderboard entry, no daily or weekly challenge
progress, no clan XP. It still counts towards the per-match cap and the daily soft cap,
and a level milestone reached because lifetime XP crossed a level still unlocks its
reward. The ledger row records why (`private_game`, `unlisted_game`,
`public_too_few_humans`), and the post-game screen and the XP history say so in words
("Private Match ×0.25", "Low-population Match").

Review flags stored with each game (`xp_result.flags`, shown on the admin user page):
`reduced`, `repeat_group`, `soft_cap`, `cap_hit`, `admin_counted`, `tiny_win`.

## Who finished the game

Dying costs nothing; leaving early does. One rule, `playerProgressionOutcome` in
`domain/stats.ts`, answers from the record alone (never from a client) and decides Credits,
the clan threshold and XP alike:

| Outcome                     | When                                                                   | Earns |
| --------------------------- | ---------------------------------------------------------------------- | ----- |
| `completed_alive`           | alive when the result was determined, and still there                  | yes   |
| `completed_eliminated`      | eliminated after the first two minutes and stayed to the result        | yes   |
| `won_and_left_after_result` | on the winning side and left only after the result was determined      | yes   |
| `left_early`                | the server lost the connection before the result and it did not return | no    |
| `disconnected_early`        | an older record whose heartbeat says gone, with no roster to say when  | no    |
| `eliminated_early`          | eliminated in the first two minutes (a free kill, not a game played)   | no    |
| `not_spawned`, `no_winner`  | never owned land; the game had no settled winner                       | no    |

The game server stamps what it alone knows into the archived record: `info.resultTurn` (the
turn the first valid vote for the settled winner arrived at, or the tick its own replay found
the result on) and, for each player still gone when the record was written, `leftTurn` (the
turn their connection was lost; cleared if they return). A player gone at or after the result
left after the game was decided, so a winner who clicks Exit on "You won" is paid even though the
archive and the post-game timer are still running; `RESULT_GRACE_TURNS` (5 turns) allows for the
result reaching the server a moment after the clients' simulations. A drop that comes back leaves
no `leftTurn`, so it is never held against anyone. A record from before these fields is judged by
its heartbeat intents (`mark_disconnected`) as of the last turn. The same rule applies to the full
and the reduced award; admin-modified games and the admin who used a command earn nothing, as before.

## Anti-farming

Counted-game gate for the full award (private, unlisted and low-population games pay only the reduced, lifetime-only one; ranked and singleplayer pay nothing), no XP for players
who left before the result or never acted (see below), bots and nations excluded, elimination limit and victim survival
rule, the player-count and repeated-opponent multipliers, the per-match cap, the daily
soft cap, one transaction per game keyed on the game code with unique ledger rows. No
IP address is used. Guests earn nothing, and an XP-earning account needs a Discord or
Google identity.

## Challenges

Three daily and three weekly slots. Nothing about an assignment is stored: the
challenge in a slot is `SHA-256(userId | period key | slot | POOL_VERSION)` picking from
the slot's pool (`domain/challenges.ts`), so a row exists only once there is progress.
Periods are UTC: a day is `d:YYYY-MM-DD`, a week is the ISO week from Monday 00:00 UTC.
A game counts for the period it **ended** in, and only a game that earned XP advances a
challenge. Completing one pays its XP automatically, once (ledger key
`<period>:<challenge id>`); a weekly challenge's Credits wait to be claimed with the
other rewards. Challenge XP is not multiplied or capped and counts for the season.

## Seasons

Created by the owner (Admin panel > Seasons, or `npm run admin -- season:create`); they
never overlap. A game counts for the season running when it **ended**, and only while
that season is not archived. Season XP is match and challenge XP. **Season level** is
`min(50, 1 + ⌊XP / 2,000⌋)` (98,000 XP reaches 50; more only ranks). Thirty minutes after
a season ends (late results), the job in `jobs/seasons.ts` stores each player's final
level and rank (most XP, then who reached it first, then public id) and archives it.
Nothing is deleted; archived seasons stay readable. The owner can also close the running
season early.

**Free track** (no paid track exists): Credits at season levels 5, 10, 15, 20, 25, 30,
35, 40, 45 and 50 (100, 150, 150, 200, 250, 250, 300, 300, 400, 500; 2,600 in all),
plus a title at 25 and 50, and the season's own cosmetic at level 40 when the owner set
one.

## Prestige

At level 100 the account page offers Prestige (hold to confirm). The server decides:
`POST /users/@me/prestige` takes only an `Idempotency-Key`, locks the account's progress
row, answers a repeated key with the stored result, refuses (409) anything that is not
level 100 below Prestige 10, resets **run XP only**, adds one to the prestige count and
unlocks 1,000 Credits (claimed like any reward). Lifetime XP, Credits, cosmetics, stats,
history, clan, verification, staff role, username and bare-name entitlement, season XP
and titles are untouched.

## Rewards and titles

**Level milestones**, every prestige run for the Credits: level 5 250 · 10 500 + the
Recruit Banner flag · 25 750 + title Veteran · 50 1,000 + title Elite + Officer Chevrons
pattern · 75 1,500 + Colonel Wake ship trail · 100 2,500 + title Supreme Commander. The
cosmetics are in the catalog with no price (never for sale) and are granted at once.
Credits are rows in `progression_rewards`, claimed through the existing rewards UI
(`POST /rewards/:id/claim`, `/rewards/claim-all`): an UPDATE that only matches an
unclaimed reward of the caller, with a unique ledger row, so a double or racing claim
pays once.

**Titles** are collectibles, separate from the military rank, and are computed from
facts (never stored): Veteran, Elite, Supreme Commander, Conqueror (100 counted wins),
Prestige I–X, Legend, Season N Veteran and Elite. The account shows one beside its name
(`PUT /users/@me/title`); a title the account no longer holds reads as none.

## Clans

A member's match XP adds `⌊10%⌋` to the clan (`game_players.clan_xp`), on top of their
own, only for a player who was in the clan and wore its tag when the game started. The
clan page shows the total, the member list each member's contribution and level badge.
Clan levels and unlocks are not built.

## The account page

The Account tab is three cards, top to bottom, all drawn from `GET /users/@me` and
`GET /progression/me`:

1. **Profile header** (`components/AccountProfileHeader.ts`): one card in three bands. The
   identity band holds the avatar with a level chip, the clan tag, the username with its
   verified check, the linked handle, the Verified / owner / admin / mod chips and the Credits
   balance. Under a rule and a shade of its own, the progression band reads `LEVEL n · RANK`
   (and Prestige), the next milestone and `xp / next XP`, with the segmented XP bar on its own
   row, and Prestige at level 100. Under another rule, the display title selector. The XP is
   never beside the avatar: the identity band's bottom padding clears the level chip, and the
   progression band has room above its level line. On a phone every group stacks while names,
   tags and handles truncate.
2. **Challenges and season** (`components/ProgressionPanel.ts`): the Challenges card with
   "n of 6 complete", the daily and weekly sets each with their reset timer, and per row the
   name, `progress / target`, a thin bar and a reward column (`+XP`, and Credits where the
   challenge pays them); then the season card and a collapsed recent-XP list (a reduced game
   says why, see above).
3. **Linked accounts** (`AccountModal.renderLinkedAccounts`): one row per linked provider with
   its mark and who it is, marked Linked, and the link buttons for what is still free.

The header and the panel never fetch for each other: the panel announces what it read
(`progression-loaded`) and the modal hands the titles and the milestone to the header. Without
the `progression` feature only the identity band and the Linked accounts card show.

### One profile system

Another player's Stats page (`components/ProfileCard.ts`, the `full` variant, also heading your
own Stats tab) is the same header, drawn by the same pieces: `ProfileHeaderView.ts` (avatar and
level chip, name with its discriminator and badges, the Verified / staff chips, the LEVEL · RANK
line, the segmented XP bar and the shared spacing tokens, every hook `data-ph-*`) and opened by
the same flourish (`ProfileHeaderBase.ts`). What is private stays on your page (Credits, the
linked handle, the title select, Prestige, the linked accounts); another player's card shows the
public parts instead (lifetime XP, the title they chose to show, the season, how far to the next
level). `ProfileCard` also keeps its `compact` row for the CrazyGames account page.

### Motion

The flourish another player's profile always had is kept, and your own page shares it: once per
opening (`openKey`; not on a tab switch) the avatar and its level chip settle in with a bounce,
the XP bar fills segment by segment, the level line and Credits/lifetime figure rise, a sheen
crosses the card and a pulse of light runs out from behind the avatar through the card's hex
pattern (gold, and returning, for a Legend). On the Account page the sections and the challenge
and linked-account rows then come in one after another (`.account-intro .df-enter`, ordered by
`--i`) and the Credits figure counts up (`<currency-display countIn>`). All of it animates only
opacity and transforms, takes no clicks, and is switched off under `prefers-reduced-motion`, on a
hidden page and inside another site's frame (`flourishAllowed`).

## API

| Endpoint                                                 | Purpose                                                    |
| -------------------------------------------------------- | ---------------------------------------------------------- |
| `GET /users/@me`                                         | adds `progress`, `levelHidden`, unclaimed `rewards`        |
| `GET /users/@me/xp/:gameId`                              | the XP of the caller's game (404 until processed)          |
| `POST /users/@me/prestige`                               | prestige (needs `Idempotency-Key`)                         |
| `GET /progression/me`                                    | account page: challenges, season, track, titles, recent XP |
| `PUT /users/@me/title`                                   | choose a title                                             |
| `GET /public/player/:publicId/progress`                  | another player's level (404 if hidden or a guest)          |
| `GET /public/progression/config`                         | curve, ranks, milestones, running season                   |
| `GET /leaderboard/xp`, `GET /leaderboard/season?season=` | XP boards                                                  |
| `POST /rewards/:id/claim`, `POST /rewards/claim-all`     | Credits rewards                                            |

All answer 404 while the feature is off. Admin endpoints and permissions are in
[StaffAdmin.md](StaffAdmin.md).

## Migration

`0007_progression.sql` (forward-only; nothing is rewritten or backfilled). Games stored
before it show "played before levels existed". The tables are inert while the flag is off.
