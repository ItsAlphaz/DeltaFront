# Match events (the live feed and the event log)

A match has a public history: who eliminated whom, who is the largest nation,
which alliances formed and ended, who lost a big share of their land, and when
staff used the admin tools. The game shows it as a compact ticker in the upper
right of the HUD and as a full, filterable log (the list icon in the top bar).

Both read **one structured log**. There is no second representation.

## Where events come from

```
engine (every client, every replay)         client
─────────────────────────────────────       ───────────────────────────────
GameImpl / PlayerExecution / admin cmd      GameView.update ─▶ MatchEventLog ─┬─▶ live feed
        │ transition happens                                                  └─▶ full log
        ▼
MatchEvents (packages/engine/src/game)  ──  GameUpdateType.MatchEvent update
```

- **The engine derives them from simulation state** (`MatchEvents.ts`). It
  only watches: nothing it holds feeds back into the simulation and it is not
  part of the game hash, so a bug there can cost a feed line, never desync a
  game. Its per-tick sampling is wrapped so that even a thrown error cannot
  take a tick down.
- **Nobody can submit one.** There is no intent or client message that carries
  an event or text (`tests/MatchEventsAuthority.test.ts` asserts it, and that
  `MatchEvent` updates are created in exactly one file). The only thing a
  client sends that can cause one is the staff `admin_command` intent, which
  the game server authorizes against the sender's role before it relays it
  (see StaffAdmin.md).
- **Every client sees the same events on the same tick**, because the engine is
  deterministic and each client runs it on the same turns. A replay that re-runs
  the record gets the same ones. The wire between client and game server is
  unchanged.
- **Events are data.** An event is ids and numbers (`MatchEvent` in
  `packages/engine-api/src/game/MatchEvents.ts`): `seq`, `tick`, `type`,
  `severity`, `actor` and `target` (player smallIDs or null), and a small `meta`
  (`cause`, `percent`, `share`, `team`, `command`). No names and no wording:
  those are looked up when a line is drawn.

## The events

| Type                     | When                                         | Severity                         | Filter    |
| ------------------------ | -------------------------------------------- | -------------------------------- | --------- |
| `game_started`           | the spawn phase ends                         | normal                           | System    |
| `game_ending`            | a winner is set (or the match is voided)     | critical                         | System    |
| `player_eliminated`      | a player's last tile is gone                 | critical (a tribe: normal)       | Combat    |
| `largest_nation_changed` | the largest nation (largest team) changes    | major                            | Territory |
| `alliance_formed`        | a request is accepted                        | normal                           | Diplomacy |
| `alliance_broken`        | someone breaks it (`broken`) or it runs out  | major (`expired`: normal)        | Diplomacy |
| `major_territory_loss`   | a player has lost 25 / 50 / 75 % of its peak | normal at 25, major at 50 and 75 | Territory |
| `admin_action`           | a staff command ran in the game              | major (`force_win`: critical)    | System    |

Not built because the game has nothing for them: `war_declared` (there is no
war or declaration state: attacks, embargoes and alliances are all there is)
and `capital_captured` (there are no capitals). An event type is only added
for a concept the engine really has.

## Who gets credit for an elimination

A player is dead when it owns no tiles. The engine knows who took the last of
them in one place: `GameImpl.conquerPlayer(conqueror, conquered)`, called when
an attack finishes off a defender or when a player's last enclosed territory is
absorbed by its captor. That call records a **claim** (`MatchEvents.claimKill`).
The elimination names the conqueror only if the victim is then seen dead before
the tick ends. Every other death has **no reliable killer** and reads "X was
eliminated", never a guess:

- a nuke or an airstrike that clears the last land,
- the doomsday clock rotting the last tiles away,
- a staff elimination (reported as the staff action instead, once, not also as
  an anonymous death),
- a claim whose victim survived the tick (a leftover tile): the credit expires
  with the tick and does not attach to a later, unrelated death.

The elimination is reported once however the two detection paths (the claim at
the end of the tick, the victim's own `PlayerExecution`) interleave.

A tribe falling is `normal`: there are hundreds of them. Nations count as
players.

## Spam control

- **Transitions fire once**: an alliance event is emitted when the alliance
  actually changes state; a repeated request or a quiet tick adds nothing.
- **Sampled states** (largest nation, territory loss) are looked at once per
  second, never per tick.
- **Largest nation** is tracked as an _announced leader_. A challenger must lead
  for 3 s in a row (debounce) and announcements are at least 15 s apart
  (cooldown), so a race produces a few lines, not a stream. A tie keeps the
  holder. The first leader is tracked silently, as is any leader holding under
  3 % of the land (and 100 tiles): the opening seconds, when whoever has one more
  tile "leads", are not news. Tribes do not count. In team games the leader is the
  largest team.
- **Territory loss** is measured against the player's peak, at 25, 50 and 75 %,
  each at most once per player; a collapse across several milestones is one line
  for the highest, and the milestones below it are spent. Players whose peak
  never reached 2 % of the land (and 150 tiles), and tribes, are ignored. An
  elimination is not also a 100 % loss.
- **The client collapses runs** (`MatchEventLog`): tribes falling to the same
  player within 10 s become one line ("Alphaz eliminated 3 tribes"), and repeated
  staff resource commands on the same player ("used admin tools on RedFox ×4").
  A player's elimination, an alliance event, a new leader are never collapsed.
  The engine's events are never merged, only grouped for display.
- **The log keeps at most 500 entries**; past that, ordinary events go before the
  important ones.

## The live feed

`<match-event-feed>` (`src/client/hud/layers/MatchEventFeed.ts`): up to six
compact rows under the top bar, newest first, DeltaFront dark panels with a thin
red accent line. Critical events have a brighter line and glow and stay 20 s;
major 12 s; normal 7 s; each fades over its last 1.5 s. A flurry of small events
cannot push a still-fresh critical one off. Rows take no clicks. On a phone only
the newest four show. While the game is catching up to the server (joining late,
reconnecting) it stays quiet rather than flickering through a backlog.

Detail setting:

- **All events** (default): everything that involves a person, plus all major and
  critical events. Ordinary events that only concern nations and tribes (nations
  allying with each other all game long) stay out of the ticker.
- **Major only**: major and critical events.

The full log always has everything.

## The full log

`<match-event-log-modal>`: the top bar's list icon opens it. The whole match,
newest first, with a game clock, a count, and the filters All / Combat /
Diplomacy / Territory / System. It updates while open; a line with a player takes
the camera to them. Esc, the Close button or a click outside closes it.

## Names, clans, badges, Anonymous Names

A line draws players as chips: territory colour, clan tag, name, then the staff
badge and the verified check, **the same marks every other surface draws**
(`PlayerView.name()`, `clanTag()`, `staffBadgeRole()`, `showsVerifiedBadge()`).
Nothing is inferred from a name. They are looked up each time a line is drawn,
never stored in the event, so the Anonymous Names setting applies live: under it
a player has its generated name, no clan tag and no badges (an admin action then
does not even say "Owner"). Switching it on rewrites the rows already on screen.

## Staff actions and admin-modified games

Every authorized `admin_command` that runs in a game produces an `admin_action`
event: "Owner Alphaz used admin tools on RedFox", "Alphaz eliminated RedFox using
admin tools", "Alphaz forced the winner". The public line carries no amounts, no
reason and no audit detail. The event is a _consequence_ of the command; it adds
nothing to the recorded turns, and the API still decides admin-modified from the
recorded `admin_command` intents (StaffAdmin.md), so such a game still counts for
no stats, Credits, leaderboard or clan threshold.

## Replays

- **Classic replay** re-runs the record through the engine like a live client,
  so it has the events for free.
- **The new replay viewer** keeps the events with the replay (`ReplayEvents.
matchEvents`, collected from the processing run's updates) and rebuilds the same
  `MatchEventLog` from them: playing past an event's frame adds it, a seek
  rebuilds the log up to that frame. `REPLAY_VERSION` is 2, so a replay stored
  without them is processed again. Anonymous Names is not applied anywhere in
  that viewer (the leaderboard shows real names too), so the feed does not either.

## Snapshots, worker protocol, wire

- `GameUpdateType.MatchEvent` is appended last in the enum; the update is
  structured-cloned worker to main thread like the others. **No change to the
  binary client/game-server wire**, and no database migration.
- The tracker's state (leader, pending candidate, peaks, spent milestones,
  numbering) is part of the game snapshot as an optional `game.matchEvents`
  field, so older snapshots still restore.

## Settings

`UserSettings`: `eventFeed` (on), `eventFeedDetail` (`all` | `major`),
`eventFeedSound` (off), on the Gameplay tab. The sound is one quiet cue
(existing `message` and `alliance-broken` sounds, through the normal mixer and its
volumes) for a critical event or a betrayal that concerns someone else, held back
30 ticks after the last, and never for events about the player themselves (those
have their own cues).

## Adding an event

1. Add the type to `MATCH_EVENT_TYPES` and its category in `matchEventCategory`.
2. Report it from the engine code that performs the transition (or sample it in
   `MatchEvents.tick`); decide the severity there.
3. Give it a sentence in `describeEvent` and `en.json` (`match_events.*`) and an
   icon in `MatchEventLine`.
4. Test the state transition, not only the wording (`tests/MatchEvents.test.ts`).

## Known limits

- Kill credit is conquest only; a nuke kill has no killer (see above).
- "Largest nation" is by land tiles, per player (per team in team games).
- Territory loss is relative to a player's peak, so a player who regrows and
  collapses again does not fire a threshold twice.
- The solo game shows the same events; there is no server to filter anything.
