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

Three modes, one authoritative answer per game, `progressionEligibility` in `domain/xp.ts`
(`{ mode: "full" | "reduced" | "none", reason }`), built on the stats rule
(`countedVerdict` in `domain/stats.ts`). The rule is simple: **a player earns XP unless they
left the game while still in it.** Short games, staff commands and dying do not take it away;
they make it reduced.

| Game                                                                    | Mode        | Reason                  |
| ----------------------------------------------------------------------- | ----------- | ----------------------- |
| A qualifying public game (the stats rule)                               | **full**    | `normal_public`         |
| The owner's commands in a public or listed game                         | **full**    | `normal_public`         |
| A public game with too few eligible humans                              | **reduced** | `public_too_few_humans` |
| A private lobby that was publicly listed (or a record that doesn't say) | **reduced** | `private_game`          |
| An unlisted private lobby                                               | **reduced** | `unlisted_game`         |
| A public game shorter than the stats minimum (two minutes)              | **reduced** | `short_game`            |
| A game staff commands changed (any other role, or a private game)       | **reduced** | `admin_modified`        |
| Any game, for a player who was **eliminated**                           | **reduced** | `eliminated`            |
| Singleplayer                                                            | none        | `singleplayer`          |
| Ranked (not served yet)                                                 | none        | `ranked`                |

A game that is reduced for two reasons shows the game's own (a short staff test is `short_game`;
an eliminated player in a private game is `private_game`), and `eliminated` only when the game
itself was full. **Short matches:** a game under two minutes pays the reduced award, not nothing
(the alternative, full XP however short, would let a game be farmed by ending it at once).
**Staff commands:** the owner's commands in a public or listed game leave the result intact (see
[StaffAdmin.md](StaffAdmin.md)); every other staff command, and any command in a private or
unlisted game, makes it a test: no stats, Credits, leaderboard entry, clan threshold or season
XP, but its players still earn the reduced award, the staff member who ran the command
included. The game server records whether a private lobby was listed (`info.listed`); the client
never decides any of this.

**Player-level**, for a game that is full or reduced: a registered account (guests earn
nothing, but count towards the player-count multiplier of a full game) who took a gameplay
action and **did not leave while still in the game**. Then:

- **Still in it at the result** (alive, including the winner, who may leave once the win is
  determined): the game's mode. Full XP in a full game.
- **Eliminated**, whether they stayed, left after the death or the match ended without a
  winner, and even if it was within the first two minutes: the **reduced** award, secured at the
  death (see "A death is paid when it happens").
  (In a team game an eliminated teammate of the winning side is on the reduced award too: a
  death is a death, and there is no victory XP in it.)
- **Left while still in the game**, before the result, alive: nothing. Eliminated after
  leaving, with the empire standing without them: nothing too (`leftWhileAlive`).

A player who does not qualify has a stored reason (`guest`, `no_action`, `left_early`,
`not_spawned`, `no_winner`: the game ended without a winner and they were still in it).

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
reward. The ledger row records why (`eliminated`, `private_game`, `unlisted_game`,
`public_too_few_humans`, `short_game`, `admin_modified`), and the post-game screen and the XP
history say so in words ("Eliminated ×0.25", "Private Match ×0.25", "Short Match ×0.25").

Review flags stored with each game (`xp_result.flags`, shown on the admin user page):
`reduced`, `eliminated`, `early`, `repeat_group`, `soft_cap`, `cap_hit`, `admin_counted`,
`tiny_win`. (`early`: paid while the game was still on.)

## Who finished the game

Credits and the clan threshold still ask whether a player **completed** the game, one rule,
`playerProgressionOutcome` in `domain/stats.ts`, answered from the record alone (never from a
client):

| Outcome                     | When                                                                   | Completed |
| --------------------------- | ---------------------------------------------------------------------- | --------- |
| `completed_alive`           | alive when the result was determined, and still there                  | yes       |
| `completed_eliminated`      | eliminated after the first two minutes and stayed to the result        | yes       |
| `won_and_left_after_result` | on the winning side and left only after the result was determined      | yes       |
| `left_early`                | the server lost the connection before the result and it did not return | no        |
| `disconnected_early`        | an older record whose heartbeat says gone, with no roster to say when  | no        |
| `eliminated_early`          | eliminated in the first two minutes (a free kill, not a game played)   | no        |
| `not_spawned`, `no_winner`  | never owned land; the game had no settled winner                       | no        |

**XP no longer asks it of a player who was eliminated.** For a player still in the game it does:
`completed_*` earns the game's mode, `left_early` earns nothing. For a player who was eliminated
the question is only whether they left _before_ their death (`leftWhileAlive`: the server lost
the connection before the empire fell and it never returned): that is leaving, and nothing is
earned; leaving after the death, staying until the end, or the game having no winner or being
short changes nothing. They are on the reduced award, which is already theirs.

The game server stamps what it alone knows into the archived record: `info.resultTurn` (the
turn the first valid vote for the settled winner arrived at, or the tick its own replay found
the result on) and, for each player still gone when the record was written, `leftTurn` (the
turn their connection was lost; cleared if they return). A player gone at or after the result
left after the game was decided, so a winner who clicks Exit on "You won" is paid even though the
archive and the post-game timer are still running; `RESULT_GRACE_TURNS` (5 turns) allows for the
result reaching the server a moment after the clients' simulations. A drop that comes back leaves
no `leftTurn`, so it is never held against anyone. A record from before these fields is judged by
its heartbeat intents (`mark_disconnected`) as of the last turn.

The **player-count multiplier** counts the humans a game had: accounts who acted and either stayed
to the result or were eliminated after the first two minutes without having left first. A dead
player who leaves does not shrink the game for the winner; an elimination within the first two
minutes (a free kill) or a leaver does not count, so neither can inflate it.

## XP while you play

You see your XP as the game goes. The amounts are a **preview** until they are paid, and what
is paid is paid exactly once: a death when it happens (the reduced award), everything else by
the stored game.

```
game server ──POST /game/:id/progress──▶ account API ──GET /users/@me/xp/live/:id──▶ client
 (what only it knows)                    (the same XP functions     (draws it, works nothing out)
                                          as the final award;
                                          pays a death at once)
```

- **The report** (`LiveProgress`, `packages/shared/src/LiveProgress.ts`) comes from the game
  server's own state and never from a client: who is eliminated (a spawned player who lost their
  last tile, which the agreed snapshot stamps with a finishing place; a player who has not
  spawned yet is not) and who eliminated whom (the majority-voted live stats, which every game
  now has on while `progression` is on), the turns each player was last agreed alive and first
  agreed eliminated, who is connected and when anyone left (the roster, `leftTurn`), who took a
  gameplay action and who ran staff commands (the intents it stamps; `GAMEPLAY_INTENTS` is one
  set shared with the final award), and, once the winner is settled, the result and
  `resultTurn`. It is sent when a new snapshot is agreed, when someone leaves or returns, and
  the moment the result is settled, before the record is uploaded. A single client's own
  live-stats message changes nothing: the server only takes a majority.
- **The assessment** (`assess` in `domain/liveXp.ts`) turns that into what a player's part is
  (out, still playing, gone, nothing) with `progressionEligibility`, `computeMatchXp` and
  `computeReducedXp`, so the figure uses the final award's rules, multipliers and daily caps. The
  preview and the death award read this one function, so they cannot disagree.
- **The client** only reads it (`LiveXpPanel` in the HUD, `LiveXpCard`, the end-of-game section).

| State       | When                                                    | Shows                                                                                 |
| ----------- | ------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `live`      | playing                                                 | "Match XP +150": taking part and each valid elimination, the multiplier               |
| `pending`   | eliminated; the server is confirming it (a few seconds) | "Eliminated", no figure until it is the reduced one, then "finalizing, you can leave" |
| `settled`   | the result is in                                        | the winner's victory and placement are final; "finalizing, you can leave"             |
| `final`     | eliminated and **paid**                                 | "XP earned +31": reduced, already in your account; the full panel with the level bar  |
| `forfeited` | left while still in the game, before the result         | "XP forfeited: you left while still in the game"                                      |
| `none`      | the game pays nothing (guest, ranked, never acted)      | nothing                                                                               |

What is shown at once: participation, the first-game bonus, valid eliminations (a victim counts once
they are known to have lasted the two-minute minimum), the game's multiplier and a reduced match's x0.25.
What stays pending: placement for everyone but a settled winner, victory until the result, and
challenge, season and clan progress, which are paid with the stored game. A reduced game has nothing
competitive pending.

### A death is paid when it happens

An eliminated player's reduced award does not wait for the match. When the game server's report
shows an account eliminated, `settleEliminations` (`domain/earlyXp.ts`), called from
`POST /game/:id/progress`, pays it **in the same request**: a completed match plus the valid
eliminations they made, × 0.25, to lifetime XP only, with the level milestones it unlocks. The
account page, the nav bar and the level update at once; the death screen shows "XP earned" with the
bar and any level reached (`GET /users/@me/xp/:gameId` answers with the award before the game is
stored). The player may exit or spectate; neither changes anything.

Nothing but a death is paid early. Victory, placement, the first-win bonus, season XP, challenges and
clan XP all need the stored game, and a reduced award has none of them.

**Exactly once.** The payment is an `xp_ledger` row keyed on (user, source, game) with a unique
index; `early_xp` (migration `0008`) stores what the player was told (breakdown, level before and
after, levels crossed), keyed on (user, game). The player's progress row is locked first, so a
report, a repeated report and the stored game for the same player run one at a time: a prior
award is found and adopted, never repeated. When the stored game arrives, `awardPlayerXp` looks
for the early award first and **copies it into the player's `game_players` row** (`xp_awarded`,
`xp_result`) instead of working one out; the season, challenges, clan XP and milestone rewards are
untouched by it (a reduced award has none), and the daily soft cap was already applied at the death.
A death the live report could only bound (the victim's elimination fell between two agreed
snapshots that straddle the two-minute mark) is not counted for the killer in the early award, so a
payment is never rounded up; the stored game adopts that figure, so the player is shown the same
amount before and after.

**What a report cannot pay:** a player who left while their empire still stood (`leftTurn` before
the last snapshot they were alive at) and a guest, nor one who never acted, nor anything in a
ranked or singleplayer game; a report for a game already stored is ignored. If the API was
restarted, `early_xp` still holds the payment and the live endpoint answers `final` from it.

A player who leaves from "You won" is told what was awarded (or forfeited) by a toast the next
time the page loads (`PendingXp`); a winner is shown their final figure from the server's own
result and the stored game awards exactly that.

## Anti-farming

What stops farming now that short games, staff tests and deaths pay: the reduced multiplier (×0.25,
lifetime XP only) for all of them; the player-count multiplier and the full-award gate (a full
award needs a counted public game); the repeated-opponents reduction; the elimination limit (6)
and victim survival rule (two minutes); the per-match cap and the daily soft cap; leaving while
still in the game earns nothing; no XP for players who never acted; free kills (eliminated within
the first two minutes) neither pay the killer nor raise the game's player count; bots and nations
excluded; one transaction per game keyed on the game code with unique ledger rows (a death is
paid under the same key). No IP address is used. Guests earn nothing, and an XP-earning account
needs a Discord or Google identity.

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
| `GET /users/@me/xp/:gameId`                              | the XP of the caller's game, or a death's award (404 else) |
| `GET /users/@me/xp/live/:gameId`                         | the XP a running game stands at (404 if none)              |
| `POST /game/:id/progress`                                | a game server's report of a running game; pays a death     |
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

`0008_early_xp.sql` adds `early_xp` (one row per eliminated account player and game): what a death was
paid and told. It is run with the other migrations (`npm run account-api:migrate`, before the API
restarts: the service refuses to start with a migration pending). Nothing is rewritten.
