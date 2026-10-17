# Capital System

A capital is a player's seat of government. While it stands it gives a small
bonus to gold and troop regeneration. When an enemy captures it, its owner falls
into **CRISIS** (a timed penalty to both), the captor is paid once, and the
owner may found a replacement for gold. The Insurgency System
([Insurgency.md](Insurgency.md)) starts from the same event.

Everything here is a proposal for playtesting. The numbers live in one file,
`packages/engine-lib/src/capital/CapitalRules.ts` (`CAPITAL_SPEC`), so a
rebalance is a one-line change.

## The match setting

`GameConfig.capitalSystem?: { enabled?: boolean; crisisMinutes?: 3 | 5 }`
(`packages/engine-api/src/Schemas.ts`, appended last: the wire format is
positional).

| Where                                | Default                                              |
| ------------------------------------ | ---------------------------------------------------- |
| Solo (`SinglePlayerModal`)           | on                                                   |
| Create Match (`HostLobbyModal`)      | on                                                   |
| A bare private lobby (`GameManager`) | on                                                   |
| Public lobbies                       | off (they keep the rules their players already know) |

Off means nothing exists: no capitals, no CRISIS, no insurgency, no extra hash
or snapshot data, and the match plays exactly as it did before the feature.
`crisisMinutes` is 3 (default) or 5; anything else reads as 3. Solo and Create
Match offer both lengths on the Capital System card (it grows a "CRISIS: 3 min /
5 min" choice while the system is on), and the default length is never sent, so a
default match's config is the same bytes it always was. A host can edit both
while the lobby is open (`src/server/ConfigPatch.ts`); the server replaces the
whole `capitalSystem` object, so leaving the length out is how a host goes back
to 3 minutes. Public lobbies have no choice: they keep the system off.

## Rules

| Rule                              | Value                                                                                                         |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Who holds a capital               | humans and nations (not bots)                                                                                 |
| Founded                           | when the spawn phase ends, where the player spawned                                                           |
| Bonus while a capital stands      | +10 % gold income, +10 % troop regeneration                                                                   |
| CRISIS                            | 50 % gold income and 50 % troop regeneration, 3 or 5 minutes                                                  |
| CRISIS and a standing replacement | the penalty applies to the rate including any capital bonus                                                   |
| Replacement                       | 500,000 gold, after a 30 s wait, on an owned land tile that is not on the border                              |
| Replacement's bonus               | starts at 50 % of the full bonus, reaches 100 % over 5 minutes                                                |
| Captor's reward                   | 250,000 gold (125,000 for a replacement) and troops equal to 10 % of its maximum army, never past the maximum |
| Reward                            | **once per defender/captor pair, ever**                                                                       |

A crisis **never eliminates** its owner: it is a penalty, not a death sentence.
A player who loses their capital and then their last tile is not out either;
see "A defender with no land" in [Insurgency.md](Insurgency.md).

### Lifecycle

1. `CapitalSystem.tick` runs after every execution each tick (so a capital is
   judged where the tick left its tile) and before the match feed.
2. **Founded**: `designate()` gives each holder a capital at its spawn tile (or
   the first tile it still holds). Nations found theirs the same way and found a
   replacement through `NationCapitalBehavior` when they can afford one.
3. **Captured**: its tile belongs to an enemy (not a friend, not nobody). The
   system pays the captor once for the pair, starts the owner's CRISIS (only if
   they are alive or about to be kept alive by a resistance), asks the insurgency
   system whether a resistance begins, and emits exactly one `CapitalEvent`.
4. **Destroyed**: its tile belongs to nobody or to a friend (a nuke, the land
   rotted away, the owner died). No reward, no CRISIS.
5. **Replaced**: the owner sends `found_capital`; `FoundCapitalExecution` asks
   `CapitalSystem.found`, which re-checks everything (`foundBlock`) and charges
   the gold only if it succeeds. A refused order costs nothing.
6. **CRISIS ends** at its authoritative tick: the penalty lifts and, for a
   living owner, a `crisis_ended` message is shown. Nothing else changes.

### Why a capture can never pay twice

`capture()` removes the capital record in the same call that reports the fall,
so one capital is reported at most once; the pair key `defender:captor` is
stored in `paid`, so a rebuilt capital taken again by the same player, or a pair
trading a capital back and forth, pays nothing the second time (the event still
fires, with a reward of zero, and the banner says so).

## XP

The captor's gold and troops are paid in the match. A capture also earns progression XP
([Progression.md](Progression.md)): 40 XP for each human owner whose capital a player captured, at
most three in a game, in full awards only. It follows the same once-per-pair rule as the reward: the
engine records a capture in the player's stats (`capitals`: victim and tick) at the moment it pays,
never for a capture that paid nothing and never for a bot or a nation, and the account API counts
each owner once, only after the first two minutes of the match.

## Wire, state and determinism

- Intent: `found_capital { tile }` (appended to `IntentSchema`).
- Updates: `CapitalEvent` (`founded | captured | destroyed`), and the
  `PlayerUpdate` fields `capitalTile`, `crisisStartTick`, `crisisEndTick`.
- The simulation owns all of it. The client derives its countdown from ticks and
  never keeps its own clock.
- `hash()` includes the capital state only when the setting is on, so a match
  without it hashes as before. The snapshot record is optional in the game
  schema (`CapitalSystemStateSchema`), so old snapshots still load.
- Reconnecting replays the turns, so every capital, crisis and payment is
  restored exactly by the same code that made it.

## Client presentation

All of it is driven by engine events and ticks; the client awards nothing and
decides nothing. Every layer takes **no pointer events**, so none can get
between the player and the front.

### The defender: `CrisisOverlay` (`src/client/hud/layers/CrisisOverlay.ts`)

1. **Announcement** (about 3.7 s): a full-screen "CRISIS" scales in from beyond
   the screen, overshoots and settles at the middle, with "YOUR CAPITAL HAS
   FALLEN" beneath it, amber and red glow along the screen's edges, one flash, a
   short jolt of the map (the HUD stays still) and the `crisis-capital-lost`
   stinger.
2. **Docking** (1.1 s): the _same element_ shrinks and travels to a panel at the
   right edge in one animation (nothing is removed and replaced), and the panel
   reveals "CAPITAL LOST", the time left and "TIME REMAINING".
3. **Indicator**: `mm:ss` and a progress bar, derived from `crisisEndTick` and
   the match's tick. It holds while the game is paused, runs while a menu is
   open and is right after a reconnect. It stays until the crisis ends, or the
   match does.
4. **60 s left**: one pulse of the whole panel and the `crisis-warning` cue.
5. **10 s left**: the panel turns urgent (red, steady). Nothing flashes
   screen-wide.
6. **Over**: "CRISIS OVER / PENALTIES LIFTED" and the `crisis-over` cue, for
   eight seconds.

Only a crisis that has just begun is announced, and only live: a client that is
catching up (joining late, reconnecting) shows the indicator for a crisis still
running and nothing for the old ones. Thresholds are crossed downward and in
order, so a rejoin with 30 s left is never told that 60 s just passed
(`CrisisClock.ts`, all pure and unit tested).

With `prefers-reduced-motion`: no scaling, flash or shake; the same words fade
in and settle into the panel.

### The captor: `CapitalVictory`

A gold banner ("CAPITAL CAPTURED"), the gold and troops the engine paid
counting up, and the cues the game already has for taking a player and for gold.
It is shown once per capital id, never while catching up, and says so when the
capture paid nothing ("already paid").

### Everyone: `CapitalMarkers`

A badge over each capital in its owner's territory colour (solid for a founding
capital, dashed for a replacement, with a pulsing ring on your own), positioned
from the camera each frame. Capitals are public, like any structure.

### Sounds

Synthesised by `scripts/audio/synthesize-capital-audio.ts` (a deterministic
script on `scripts/audio/dsp.ts`; run it to regenerate), shipped as
`resources/sounds/effects/crisis-*.mp3` and credited in `CREDITS.md`.

## Where things are

| What                   | File                                                                     |
| ---------------------- | ------------------------------------------------------------------------ |
| Numbers and pure rules | `packages/engine-lib/src/capital/CapitalRules.ts`                        |
| State machine          | `packages/engine/src/game/CapitalSystem.ts`                              |
| Replacement order      | `packages/engine/src/execution/FoundCapitalExecution.ts`                 |
| Nation AI              | `packages/engine/src/execution/nation/NationCapitalBehavior.ts`          |
| Economy scaling        | `packages/engine/src/execution/PlayerExecution.ts`                       |
| Match setting          | `packages/engine-api/src/Schemas.ts`, `src/server/ConfigPatch.ts`        |
| Countdown arithmetic   | `src/client/capital/CrisisClock.ts`                                      |
| Presentation           | `src/client/hud/layers/{CrisisOverlay,CapitalVictory,CapitalMarkers}.ts` |

## Tests

`tests/capital/` (rules, payments, CRISIS, replacement, nation behaviour, the
setting off), `tests/core/snapshot/CapitalSystem.test.ts` (round trip),
`tests/server/CapitalSystemDefault.test.ts` (defaults),
`tests/client/CrisisLength.test.ts` (the length choice in Solo, Create Match and
the lobby summary) and `tests/client/capital/` (the countdown arithmetic, the
overlay and the banner).
