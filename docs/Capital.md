# Capital System

Nobody starts with a capital: it is bought, for 500,000 gold, and the money
competes with everything else a nation can spend on. While it stands a capital
gives bonuses and unlocks silos and airports. Without one, a nation comes under
**strain** (a slow loss of income and troop regeneration) once the opening grace
is over. When an enemy captures a capital its owner falls into **CRISIS** (a
timed penalty to both), the captor is paid once, and the owner may buy another.
The Insurgency System ([Insurgency.md](Insurgency.md)) starts from the same
event.

Everything here is balanced by simulation and meant to be re-tuned by playtest.
The numbers live in one file, `packages/engine-lib/src/capital/CapitalRules.ts`
(`CAPITAL_SPEC`), so a rebalance is a one-line change, and
[CapitalBalance.md](CapitalBalance.md) records what the numbers were tested
against. (v0.7.0 gave everyone a free capital where they spawned; v0.8.0 sells
it.)

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

| Rule                       | Value                                                                                                                                        |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Who holds a capital        | humans and nations (not bots)                                                                                                                |
| Starting gold              | 200,000 for every human and nation (a host's own starting gold is added on top)                                                              |
| Price                      | 500,000 gold, the first capital and every replacement                                                                                        |
| Where                      | an owned land tile that is not on the border; not during the spawn phase                                                                     |
| Wait                       | none for the first; 30 s after a fall for a replacement                                                                                      |
| Bonuses (at full strength) | +400,000 maximum troops, 25 % cheaper City/Port/Factory/Defense Post, +10 % gold, +25 % troop regeneration, 10 % fewer troops lost attacking |
| Ramp                       | every capital starts at 50 % of its bonuses and reaches 100 % after 3 minutes                                                                |
| Requires a capital         | building a Missile Silo or an Airport (SAM launchers do not: everyone may defend); existing ones keep working                                |
| Strain (no capital)        | none for 10 minutes after the match starts, then −3 % income and troop regeneration for each minute begun, at most −30 %                     |
| CRISIS                     | 50 % gold income and 50 % troop regeneration, 3 or 5 minutes                                                                                 |
| CRISIS and strain          | never together: a player in CRISIS is not strained, and strain begins 10 minutes after a CRISIS ends                                         |
| Captor's reward            | 250,000 gold (125,000 for a rebuilt capital) and troops equal to 10 % of its maximum army, never past the maximum                            |
| Reward                     | **once per defender/captor pair, ever**                                                                                                      |
| An army above its maximum  | drains 1.5 % of the excess a tick (a fallen capital's army melts over about 20 s)                                                            |

A crisis **never eliminates** its owner: it is a penalty, not a death sentence.
A player who loses their capital and then their last tile is not out either;
see "A defender with no land" in [Insurgency.md](Insurgency.md). A player who
never bought a capital has no resistance to fall back on: losing every tile is
an ordinary elimination.

### Lifecycle

1. `CapitalSystem.tick` runs after every execution each tick (so a capital is
   judged where the tick left its tile) and before the match feed. The first
   tick outside the spawn phase is the match's start: the strain's grace counts
   from it.
2. **Bought**: the owner sends `found_capital`; `FoundCapitalExecution` asks
   `CapitalSystem.found`, which re-checks everything (`foundBlock`) and charges
   the gold only if it succeeds. A refused order costs nothing. A capital bought
   by a player who has lost one before is a **replacement** (it pays its captor
   less); otherwise it is a first capital.
   **Built**: it is not a capital yet. For `Config.capitalBuildTicks()` (a SAM
   launcher's construction time) it is a _build_ (`CapitalBuildRecord`): a
   `building` event, no bonuses, no gate opened, nothing to capture, no second
   order (`building`). If the owner loses the tile or dies first, the build ends
   with a `cancelled` event (no refund, no CRISIS, no reward). When it ends the
   capital stands (`founded`, same id) and its bonuses start from half.
3. **Captured**: its tile belongs to an enemy (not a friend, not nobody). The
   system pays the captor once for the pair, starts the owner's CRISIS (only if
   they are alive or about to be kept alive by a resistance), asks the insurgency
   system whether a resistance begins, and emits exactly one `CapitalEvent`.
4. **Destroyed**: its tile belongs to nobody or to a friend (a nuke, the land
   rotted away, the owner died). No reward, no CRISIS. The owner's strain clock
   restarts: they have a fresh 10 minutes to buy another.
5. **CRISIS ends** at its authoritative tick: the penalty lifts and, for a
   living owner, a `crisis_ended` message is shown. Nothing else changes.

### Strain

Having no capital is free for the first 10 minutes, so that a nation can
build first (cities are the strongest early purchase) and still afford a
capital without being forced to buy it at once. After that, each minute without
one takes 3 % more of income and troop regeneration, up to 30 %. It is a
separate penalty from CRISIS and is shown differently (amber, in the capital
panel, never the CRISIS banner); it stops the moment a capital is bought, and
does not run while a CRISIS does. The simulations found a soft buying window of
about minutes 7 to 12, not a single deadline ([CapitalBalance.md](CapitalBalance.md)).

### What the rules read

`CapitalSystem.strengthOf(player)` is 0 with no capital and 50 to 100 as it
ramps. The rules that use it run on both sides, so they take it from
`PlayerLike.capitalStrengthPercent()` (`engine-api/game/ReadViews.ts`): the troop
cap (`Config.maxTroops`), structure prices (`EngineConfig.unitInfo`) and an
attacker's losses (`EngineConfig.attackLogic`). The client's `PlayerView` derives
the same number from `capitalFoundedTick` and the match's tick.

### Nations

A nation builds first and saves second (`NationCapitalBehavior`): a number of
cities by difficulty (Easy two, Medium, Hard and Impossible one), or the match's
age (minutes 9, 8, 7 and 6) if it has built fewer, after which it builds no more
structures until it can pay, unless a real attack (35 % of its army incoming)
makes it spend. A nation that lost its capital rebuys at once. When it buys is
decided by its economy, not by a timetable.

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

### The owner: buying, building, and the moment it stands

- **Placing** (`CapitalAction`, `TilePicker`, `CapitalMarkers`): after the button, a
  translucent capital follows the cursor like a building being placed, green where
  it will do, red with the reason where it will not.
- **Building**: a chip under the leaderboard shows the progress and what can go
  wrong, and an under-construction marker with a filling ring stands on the map.
  The build sound every building makes plays when it is placed.
- **When it stands** (`CapitalFounded`): a card slides in at the left edge, under the
  chip, with a glowing border, a sweep of light, sparkles and the bonuses popping in
  one by one; the left edge of the screen pulses; rings burst out where it stands;
  a chime plays. It is off to the side so the game stays in view, and it leaves by
  itself after 9 s. The chip then keeps showing what the capital does and how far
  its bonuses have grown.

### The captor: `CapitalVictory`

A gold banner ("CAPITAL CAPTURED"), the gold and troops the engine paid
counting up, and the cues the game already has for taking a player and for gold.
It is shown once per capital id, never while catching up, and says so when the
capture paid nothing ("already paid").

### Everyone: `CapitalMarkers`

A badge over each capital in its owner's territory colour (solid for a first
capital, dashed for a replacement, with a pulsing ring on your own), positioned
from the camera each frame. Capitals are public, like any structure.

### Sounds

Synthesised by `scripts/audio/synthesize-capital-audio.ts` (a deterministic
script on `scripts/audio/dsp.ts`; run it to regenerate), shipped as
`resources/sounds/effects/crisis-*.mp3` and credited in `CREDITS.md`.

## Where things are

| What                   | File                                                                                   |
| ---------------------- | -------------------------------------------------------------------------------------- |
| Numbers and pure rules | `packages/engine-lib/src/capital/CapitalRules.ts`                                      |
| State machine          | `packages/engine/src/game/CapitalSystem.ts`                                            |
| Purchase order         | `packages/engine/src/execution/FoundCapitalExecution.ts`                               |
| Nation AI              | `packages/engine/src/execution/nation/NationCapitalBehavior.ts`                        |
| Economy scaling        | `packages/engine/src/execution/PlayerExecution.ts`                                     |
| Match setting          | `packages/engine-api/src/Schemas.ts`, `src/server/ConfigPatch.ts`                      |
| Countdown arithmetic   | `src/client/capital/CrisisClock.ts`                                                    |
| Presentation           | `src/client/hud/layers/{CrisisOverlay,CapitalVictory,CapitalMarkers,CapitalAction}.ts` |

## Tests

`tests/capital/` (rules, payments, CRISIS, replacement, nation behaviour, the
setting off), `tests/core/snapshot/CapitalSystem.test.ts` (round trip),
`tests/server/CapitalSystemDefault.test.ts` (defaults),
`tests/client/CrisisLength.test.ts` (the length choice in Solo, Create Match and
the lobby summary) and `tests/client/capital/` (the countdown arithmetic, the
overlay and the banner).
