# Pre-release playtest: Capital System, CRISIS and the insurgency (v0.7.0)

v0.7.0 is on `origin/main` and **not deployed**. The spec's definition of done is a
playtest; this is the plan, and what has been done of it so far. Rules of the plan:

- **A row is not verified until it says how it was tested.** A passing unit test is not
  a playtest, and a script driving a browser is not a person.
- **Audio, reduced motion, readability, multiplayer and balance are only called verified
  for what was actually measured.** Where a script measured part of one of them, the row
  says exactly which part, and what only a person can judge stays "not tested".
- Nothing here deploys, releases or changes production.

Last run of the automated evidence: commit `b2722f3b2` (typecheck, lint, formatting, the
full suite of 11,597 tests, the production build, and `joins.e2e.db` 47 of 47 in its own
network namespace all pass).

## How to read the results

| Mark | Meaning                                                                     |
| ---- | --------------------------------------------------------------------------- |
| ✅   | tested, passed, and the row says how                                        |
| ⚠️   | tested, works, but a finding needs a decision (see the findings)            |
| ❌   | tested and failed (rows that failed and were fixed say so, and were re-run) |
| ⬜   | not tested                                                                  |

**Evidence kinds:** **T** an automated test in the repo; **B** a scripted real browser
(headed Chrome, real mouse and key events, hooked to read the game's own updates);
**M** two real browsers through the real game server; **H** a human playing.
The browser scripts are in [`scripts/playtest/`](../scripts/playtest/README.md); the
balance numbers are in [InsurgencyBalance.md](InsurgencyBalance.md).

## What a human is needed for

Only a person can judge: whether the **sound** is audible, distinct and not irritating,
whether the CRISIS animation **feels** right on their screen, whether the resistance is
**understandable and fun**, whether the balance feels **fair** against a much stronger
occupier, and how the game feels **with other people**. Scripts give numbers for these;
they do not give the verdict.

## Exit criteria (to ask for deployment approval)

1. Every row is ✅, or ⚠️ with the owner's decision recorded, and none is ❌.
2. The human sessions (H1 to H6) are done and their findings are triaged.
3. The full suite, typecheck, lint, formatting and the production build pass on the
   release commit.
4. Known limitations are written down (end of this document).

Status today: criterion 3 holds for `b2722f3b2`; criterion 1 holds except the rows that
need a person; **criterion 2 is what is left.**

---

## 1. Full gameplay flow

| #   | Check                                                                                  | Kind | Status                                 |
| --- | -------------------------------------------------------------------------------------- | ---- | -------------------------------------- |
| 1.1 | The whole flow in order, from a fresh match, an assertion at every step (`golden.mjs`) | B    | ✅ 60 of 60 on the final code          |
| 1.2 | The same rules at engine level (orders, costs, limits, reclaim, replacement)           | T    | ✅ `tests/insurgency`, `tests/capital` |
| 1.3 | The flow played by a person, with sound, in a real match against nations               | H1   | ⬜                                     |
| 1.4 | The flow played by a person as the defender, against a scripted raider (rig)           | H2   | ⬜                                     |

1.1 covers: both capitals founded; the capture pays 250K and troops once; the CRISIS is
exactly 1,800 ticks; the announcement (announce, docking, active; title 60% of the width and
centred; subtitle; glow and flash then gone; the panel at the right edge); the resistance
(force 10% of the fallen army, purse 100K, capacity twice the force, the panel showing the
engine's numbers); pause (the match and CRISIS time both hold) and the Solo settings menu
(which pauses a Solo match); intelligence (10K, a report with unrest and garrison); a recruit
(charged exactly what the form showed; arrives after 30 s); a base (50K); unrest rising while
the occupier is busy; an uprising (25K, +20K reclaim reward once, +3 minutes); four refused
orders (each tells the sender why, nothing charged); the countdown on every one of 634
samples; the warning at 01:00, urgent at 00:10, "penalties lifted" at the end; the three cues
at the right ticks; a replacement capital (500K); no page or console errors.

## 2. Occupier counterplay

| #   | Check                                                                                        | Kind | Status                                                                                                              |
| --- | -------------------------------------------------------------------------------------------- | ---- | ------------------------------------------------------------------------------------------------------------------- |
| 2.1 | Suppression: costs troops, cools unrest, wears bases, returns 90%, limits                    | T, B | ✅ T; B `occupier.mjs` 21 of 21 (two-step click, 9,464 units taken in one step, the exact 90% back at the end tick) |
| 2.2 | Unrest against a thin, a middling and a strong occupier: the numbers and the windows (sweep) | T    | ⚠️ measured: see F6 and [InsurgencyBalance.md](InsurgencyBalance.md)                                                |
| 2.3 | Defending occupied land: the occupier's own attacks on an uprising's pocket                  | T    | ✅ `Enclosure`, and the sweep's counter-attacking rows                                                              |
| 2.4 | **Is it fair** against a much stronger occupier (the verdict)                                | H3   | ⬜                                                                                                                  |
| 2.5 | The occupier's panel and warnings, played by a person (rig, scripted resistance)             | H3   | ⬜ (the panel and its warnings work: 2.1 B)                                                                         |

## 3. Balance and exploits

| #   | Check                                                                                                         | Kind | Status                                                                                      |
| --- | ------------------------------------------------------------------------------------------------------------- | ---- | ------------------------------------------------------------------------------------------- |
| 3.1 | A capture pays once per defender/captor pair, ever (also a rebuilt capital)                                   | T    | ✅ `tests/capital`                                                                          |
| 3.2 | Capture XP: 40 each, at most 3, human owners once, after 2 minutes, full awards only                          | T    | ✅ `xpFormula`, `progression*.db` (real Postgres)                                           |
| 3.3 | Repeat and simultaneous captures; a friend's or teammate's capture; nations' capitals                         | T    | ✅ `tests/capital/Exploits.test.ts` (8 tests)                                               |
| 3.4 | Costs and limits as a table (troops, gold, time) and what each buys                                           | T    | ✅ [InsurgencyBalance.md](InsurgencyBalance.md) sections 4 and 5 (generated from the specs) |
| 3.5 | Resistance survival, landless limbo, the enclosure exemption: no way to hold land or stay in a match for ever | T    | ✅ `tests/insurgency/NoForever.test.ts`, `Limbo`, `Enclosure`                               |
| 3.6 | Capture gold and troops are the right size (is capturing nations too lucrative)                               | H5   | ⬜ numbers in F7                                                                            |

## 4. CRISIS presentation

| #   | Check                                                                                                                                    | Kind | Status                                                                                                                                                                                                                                                                                                                                                                               |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 4.1 | The animation's timing, the dock's position, the effects' timing (per-frame record)                                                      | B    | ✅                                                                                                                                                                                                                                                                                                                                                                                   |
| 4.2 | Layout at many resolutions and densities: nothing clipped, nothing off screen                                                            | B    | ✅ nine sizes from 390x844 at 3x to 3840x2160 (`presentation.mjs sizes`)                                                                                                                                                                                                                                                                                                             |
| 4.3 | Readability over snow, sea and land: measured contrast of the words and the title                                                        | B    | ✅ after a fix (F2): title median 5.3 to 1, worst 3.1; subtitle median 7 to 9, worst 3.0                                                                                                                                                                                                                                                                                             |
| 4.4 | Warning timings: the 60 s pulse and cue, the urgent last 10 s, the end                                                                   | B    | ✅ `golden.mjs` 13 to 14                                                                                                                                                                                                                                                                                                                                                             |
| 4.5 | Timer accuracy: it is the match's time; it holds on pause, runs behind menus                                                             | B, M | ✅ holds on pause; runs on with a menu open in a real match (+55 ticks in 5.5 s, time -6 s); a Solo menu pauses the match, so the clock holds (F8)                                                                                                                                                                                                                                   |
| 4.6 | Reduced motion, with the browser's preference emulated                                                                                   | B    | ✅ emulated at 1080p and on a phone (title neither scales nor travels, no flash); after a fix (F3). **Still to be seen on your own system's setting (H4)**                                                                                                                                                                                                                           |
| 4.7 | Audio: the cues start at the right moments; their levels measured (not clipped, not silent)                                              | B    | ✅ _measured, not heard_: starts on the fall's tick, at 60 s left, and at the end; none at 10 s; output peaks 0.43 to 0.44 (about -7 dBFS) through the real Web Audio graph. Loudness against the game's own sounds (offline, LUFS): the new cues sit at -11 to -13.4, with the nuke warning at -13.0 and the airstrike siren at -10.7; "conquered" is -11.1 against "victory" -18.2 |
| 4.8 | **How it looks and sounds to a person**, on their own screen: animation, contrast, audio, the reduced-motion setting of their own system | H4   | ⬜                                                                                                                                                                                                                                                                                                                                                                                   |

## 5. Match settings

| #   | Check                                                                            | Kind | Status                                                                                                                           |
| --- | -------------------------------------------------------------------------------- | ---- | -------------------------------------------------------------------------------------------------------------------------------- |
| 5.1 | Solo and Create Match default to on; off removes capitals, CRISIS and insurgency | T    | ✅ `CapitalSystemDefault`, `Activation`                                                                                          |
| 5.2 | The same in the real modals; what a started match is sent                        | B    | ✅ `modals.mjs`: on by default in Solo and Create Match; a new lobby on a current server has it on; off sends nothing            |
| 5.3 | Public lobbies leave it off, read from the real server's lobby feed              | B    | ✅ 18 of 18 on your dev server, 15 of 15 on a current one                                                                        |
| 5.4 | The CRISIS length (3 or 5 minutes) can be chosen, by the host and in Solo        | T, B | ✅ it was missing: added (F1). Solo sends 5 only when chosen; the host's choice reaches the server and going back to 3 clears it |

## 6. Failure and recovery

| #   | Check                                                                                               | Kind | Status                                                                                                                                                                                                                                                                    |
| --- | --------------------------------------------------------------------------------------------------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 6.1 | Rejected orders: the sender is told why, nothing is charged; a refund when an uprising cannot begin | T, B | ✅ T (`Intents`, `Uprising`); B `golden.mjs` 12 (four refusals, in the events panel)                                                                                                                                                                                      |
| 6.2 | The match ends during a CRISIS and during a resistance: everything stands down                      | T, B | ✅ T; B `matchend.mjs`: the CRISIS panel goes, the resistance is `match_over`, funds and reserve freeze, an order is refused as "inactive". The run was the landless variant; the landed one is T                                                                         |
| 6.3 | Simultaneous captures (two attackers, two capitals, the owner capturing back the same tick)         | T    | ✅ `tests/capital/Exploits.test.ts`                                                                                                                                                                                                                                       |
| 6.4 | Replay and snapshot determinism with orders in flight (what a reconnect rests on)                   | T, M | ✅ T; M: a client that reloaded replayed the whole match from the server's turns and its hashes equal the other's at every tick                                                                                                                                           |
| 6.5 | Two real clients through the real server stay in step, tick by tick                                 | M    | ✅ two real Chrome windows, a lobby made on the real Create Lobby screen: 3,160 shared hash ticks, 0 differ; the server's log has 0 desync and 0 warnings. A second run: 115 of 115                                                                                       |
| 6.6 | A real client reloads in the middle of a CRISIS and a resistance and is brought back exactly        | M    | ✅ the defender reloaded at 01:07 left: back within 2 ticks, indicator `00:50` right, no announcement or "capital lost" cue replayed, panel and state identical, the live 60 s warning heard at its tick; then the captor reloaded: no capture cue replayed, hashes equal |
| 6.7 | Playing with other people: lag, a disconnect, someone leaving                                       | H6   | ⬜                                                                                                                                                                                                                                                                        |

Orders over the real wire: intelligence, base and recruit by real clicks, Suppress by the
occupier's two clicks, an uprising and a replacement capital through the client's own
transport (both refused for lack of what they need, answered identically by both clients);
and every new intent round-trips the binary encoding (`tests/insurgency/Wire.test.ts`).

## 7. Automated checks

| #   | Check                                                                           | Kind | Status                                                                                                                   |
| --- | ------------------------------------------------------------------------------- | ---- | ------------------------------------------------------------------------------------------------------------------------ |
| 7.1 | Typecheck, lint, formatting, the full suite, the production build               | T    | ✅ at `b2722f3b2` (11,597 tests; the build was made in a private copy, so your working tree and `static/` are untouched) |
| 7.2 | `joins.e2e.db` (real game server, API and WebSocket) **beside your dev server** | T    | ✅ 47 of 47, in a private network namespace (below)                                                                      |

`joins.e2e.db` needs ports 8787, 3000 and 3001, which a running dev server holds. A private
network namespace gives it its own; the test database is reached through its unix socket:

```
unshare -Urn bash -c 'ip link set lo up && \
  env DATABASE_URL_TEST="postgres://df:df@%2Ftmp/df_test?port=54317" \
  npx vitest tests/account-api/joins.e2e.db.test.ts --run'
```

(With that unix-socket URL `launchCheck.db.test.ts` warns "database on another host"; give
the suite the TCP URL `postgres://df:df@127.0.0.1:54317/df_test` for a full run.)

---

## Human sessions

Each is 20 to 40 minutes. The rig opens a maximized Chrome with sound on, sets the scenario
up, plays the other side from a script, and records a timeline (state, messages, orders, the
CRISIS clock) so that "it felt off at about minute 4" can be looked up. Bring back: what you
saw, what confused you, anything that felt unfair or broken, and the game clock (top right)
when it happened.

```
node scripts/playtest/rig.mjs defender --raider thin       # H2
node scripts/playtest/rig.mjs defender --raider strong     # H3: a strong occupier
node scripts/playtest/rig.mjs defender --raider counter    # H3: it keeps attacking you
node scripts/playtest/rig.mjs occupier                     # H3: you are the occupier
node scripts/playtest/rig.mjs presentation                 # H4
node scripts/playtest/rig.mjs solo                         # H1 and H5
```

- **H1 Solo, natural** (`solo`). Solo, a small map, many nations, Medium or Hard, the Capital
  System at its default. Find your capital marker. Capture the nearest nation's capital: you
  should see the gold banner once, hear the capture cue and the coin, and be paid.
- **H2 Defender** (`defender --raider thin`). A scripted raider takes your capital after about
  a minute and a half of game time. You should see the CRISIS announcement, then the panel;
  Resistance Command appears on the left. Try each order. Ask yourself: do I understand why
  this started, what each order costs and does, what the unrest words mean, and why a button
  is disabled?
- **H3 Occupier and fairness.** `defender --raider strong`: can you do anything against a
  strong occupier, and is that fair? `defender --raider counter`: it takes what is left of
  your land (about 35 s in the sweep): acceptable? `occupier`: do the warnings reach you in
  time, and is Suppress worth its price?
- **H4 Presentation** (`presentation`). On your own screen and, if you can, a second one: is
  the CRISIS title readable over snow, sea and land (pan and zoom before the fall)? Is the
  subtitle? Does the sound fit, too loud or too quiet next to the game's own? Turn on your
  system's "reduce motion" and repeat.
- **H5 Rewards and exploits.** Capture several nations' capitals. Is the gold and troop
  reward too big? Try to cheat: capture the same capital twice, have a friend do it, hide
  land inside someone's territory while resisting.
- **H6 Other people.** Restart your dev game server first (below), then Create Match with a
  friend: a CRISIS and an uprising in front of two people, one of whom closes the tab and
  comes back mid-crisis.

## Findings

Where each was found, what was done, and which row was re-run.

| #   | Finding                                                                                                                                                                                                                                                                                                                                                                                  | Action                                                                                                                                                                               |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| F1  | **No way to choose a 3 or 5 minute CRISIS** in Solo or Create Match, although the engine and the spec have it                                                                                                                                                                                                                                                                            | Added to the Capital System card (like the Doomsday Clock's pace); the default is never sent. `ddb71a73b`; rows 5.2 to 5.4                                                           |
| F2  | **The CRISIS title had almost no contrast with snow or pale ground** (1.1 to 2.4 to 1 median; the subtitle, with its band, 7 to 9)                                                                                                                                                                                                                                                       | A thin dark outline in em, so it scales with the title. Now median 5.3, worst 3.1 on every background tried. `16652065e`; row 4.3                                                    |
| F3  | **Reduced-motion title shrank below the panel's own on a phone** (133 px against 150 px, contrast 2.4 to 1)                                                                                                                                                                                                                                                                              | A floor (220 px) and a ceiling (80% of the screen); wide screens unchanged. `cc88ab709`; rows 4.2, 4.6                                                                               |
| F4  | **A player a resistance holds in the game was "conquered" and robbed of half her gold** the moment her last tile went, and the conqueror heard "conquered" of someone still fighting. The docs and the Limbo test said otherwise; the test passed only because its player had never attacked. A landless defender who won a tile back could then not afford the 500K replacement capital | The payment and the announcement now happen at the real elimination (`finalizeElimination`), once. New tests; mutation-checked. Found while playing the occupier's side. `50fc888b4` |
| F5  | **Capital badges were screen-sized discs** (about 380 px across at 1,248 px) with the crown and coin floating above: `padding: 15%` resolves against the whole screen. In every screenshot since the markers were built; jsdom has no layout so no test saw it                                                                                                                           | A small grid with the icon sized to the badge itself; a test pins the rule; the browser runs measure the badge (28 px). `900047caa`                                                  |
| F6  | **Balance (owner decision): see below**                                                                                                                                                                                                                                                                                                                                                  |                                                                                                                                                                                      |
| F7  | A capture pays 250K gold, about 3.8 minutes of a player's income, and 10% of the maximum army (about 12 s of regeneration); once per defender and captor pair, so it scales with the number of different players conquered. A nation's capital pays the gold too (no XP)                                                                                                                 | For H5 and your judgement                                                                                                                                                            |
| F8  | In **Solo** the settings menu pauses the match (so the CRISIS clock holds with it); in a real match a menu does not (the clock runs on). By design: the clock is the match's                                                                                                                                                                                                             | none                                                                                                                                                                                 |
| F9  | A defender whose capital falls to an all-in attack is usually landless within seconds (in every two-client run, and most solo ones). Her first useful order is then a base (50K, unrest 25+); Recruit and Uprising say "You need land or a base to gather at"                                                                                                                            | For H2: is that clear enough?                                                                                                                                                        |
| E1  | **Environment, not code: your dev game server (started Oct 16 13:20) predates the Capital System's server code.** A lobby made on it has no `capitalSystem` and ignores the host's changes                                                                                                                                                                                               | Restart `npm run dev` before H6 or any Create Match test. The Vite client hot-reloads and is current. Solo does not use the game server                                              |

**F6, what the sweep says** (single maps and scripted play, so measurements, not a verdict):

- A first strike is always available: a region she held at least half of starts at unrest 50,
  exactly what an uprising needs. Against a 95% occupier it won 300 to 400 tiles and
  reclaimed nothing.
- A strong occupier (85% of its army or more) shuts the resistance down after that: unrest
  only falls. The occupier's army recovers from 20% to 85% in about 31 seconds, so unless it
  keeps spending troops the window in which unrest can rise is under half a minute.
- Money is the real ceiling (a troop 20 gold, an uprising 25K, a base 50K, a purse of 100K).
  A 500K purse reclaims everything occupied against a 40% occupier; 100K reclaims one region.
- The knobs: `unrestStrongStep`, `unrestHighFillPermille`, `unrestStartMax`, the purse and
  force numbers (list at the end of [InsurgencyBalance.md](InsurgencyBalance.md)).

## Known limitations

- **Balance and feel are unplaytested by a person.** The numbers are proposals; the sweep is
  scripted, on one map. H3 and H5 are the verdict.
- **Sound was measured, not heard; reduced motion was emulated, not set on your system;
  readability was measured, not judged by eyes other than mine.** H4.
- **Multiplayer was tested with two clients and a real server, not with other people, lag or
  a larger lobby.** An uprising and a replacement capital over the real wire were reached only
  as refusals (the occupier stayed strong, the defender had no land); both are covered by the
  encoding test and, in a browser, by the solo runs.
- The match-end browser run was the landless variant; the landed one is covered by tests.
- Nations as occupiers were not played in a browser (`NationCapital` tests cover them).
- Public lobbies keep the system off, by design. One resistance per player per match, limbo,
  the enclosure exemption and the starting force coming out of the fallen army are design
  decisions for you.
- The live XP preview omits capture XP and the banner has no XP chip (eligibility is decided
  server-side); it appears in the end-of-match breakdown. There is no admin view of the
  audit log.
- The first-run tutorial panel overlaps the bottom of the screen in a fresh browser profile
  (not ours); the scripts dismiss it.

## Re-running the evidence

`scripts/playtest/README.md`: every browser script, run through `scripts/playtest/stack.sh`,
which uses a private copy of the game and a private network namespace and never touches your
dev server.
