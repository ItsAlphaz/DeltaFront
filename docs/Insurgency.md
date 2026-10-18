# Insurgency System

When a human's capital is captured they are not simply beaten: they may organise
a **resistance**, a small force and a small purse of their own that they spend
through a handful of orders to win their land back. It is built on, and only
runs with, the [Capital System](Capital.md).

**Every number below is a proposal for playtesting.** They live in one file,
`packages/engine-lib/src/insurgency/InsurgencyRules.ts` (`INSURGENCY_SPEC`), so a
rebalance is a one-line change. Troop figures in this document are what the
player sees; the engine's own units are ten times larger (`renderTroops`).

## What it is, and what it is not

- It **moves no tile.** An uprising is an ordinary `AttackExecution`: the
  resistance's own troops fight the occupier's, bounded to one region and
  seeded at a single tile that has to be won in combat. The same troop losses,
  the same speed, the same defender. Territory changes only by that combat,
  never by clicking a button.
- It makes **no troops from nothing.** The force is drawn from the army that
  fell. Recruiting is paid for from a capped purse. Total manpower is capped.
  An uprising's survivors go back to the pool and nothing else does.
- It is **not a second economy.** The purse is moved from the owner's income
  (and a small one-off start), never minted. It does not touch the nation's
  treasury or army while it runs.
- It is **independent of CRISIS.** CRISIS is a timed economic penalty
  ([Capital.md](Capital.md)); the resistance continues whatever its state.

## When it begins

When the Capital System reports a capital **captured** (`CapitalSystem.capture`
asks `InsurgencySystem.activate`) and all of these hold:

| Condition                                         | Value                              |
| ------------------------------------------------- | ---------------------------------- |
| The Capital System is on for the match            | `capitalSystem.enabled`            |
| The owner is a human (nations and bots have none) | `PlayerType.Human`                 |
| They have not had a resistance in this match      | one per player per match           |
| The army that fell is big enough to rise from     | 10 % of it is at least 1,000 shown |
| They held national land                           | at least one region with 12+ tiles |

A player who has never bought a capital has none to lose, so no resistance begins
when they are beaten: losing every tile is an ordinary elimination. A capital that
is destroyed (nuked, rotted away, taken by a friend) is not
captured: no resistance. Turning the Capital System off removes everything here.

## The force and the purse

| Resource        | Rule                                                                                  |
| --------------- | ------------------------------------------------------------------------------------- |
| Starting troops | 10 % of the army that fell, at most 25,000 shown, **taken from that army**            |
| Capacity        | 2 x the starting troops, counting reserve + in the field + still training             |
| Starting funds  | 5 % of all the gold the owner earned this match, between 100,000 and 1,000,000        |
| Income share    | while the owner holds land, 10 % of their gold income moves to the purse, 500,000 max |

## Why the resistance, and not just an attack

An uprising is an ordinary attack, so on its own it would add nothing the owner cannot
do with their army. Two rules make it the way back (they are the numbers in
`INSURGENCY_SPEC`: `occupationDefenseByBand`, `reclaimCrisisReductionTicks`):

- **Freshly occupied land is hard to retake by plain attack.** The occupier has extra
  defence against the _owner's ordinary attacks_ on the land it holds in an occupied
  region, by the area's unrest band: Calm +200 %, Uneasy +140 %, Restless +80 %,
  Boiling +30 %, Revolt 0. (At equal armies a calm area costs the attacker about twice
  the troops of a revolting one.) It does not apply to anyone else's attacks, to the
  occupier's own, to land the owner still holds, or to the uprising itself. The only
  way to lower it is to raise the area's unrest: spying, hideouts, uprisings, or the
  occupier's army being thin. The panel shows it on each area's row.
- **Each area won back for the first time takes 30 s off the owner's CRISIS** (never
  past now). The same area lost and won again pays nothing more.

## Regions

The map is cut into 32 x 32 tile squares, named like chess squares (`C7`). The
land the owner held when the capital fell, in regions where they held at least
12 tiles, is their **national regions**.

| Status        | Meaning                                                                         |
| ------------- | ------------------------------------------------------------------------------- |
| **Held**      | The owner holds at least 60 % of the tiles they held there. Unrest is 0.        |
| **Occupied**  | Hostile players hold at least 40 % of them. The resistance's ground.            |
| **Contested** | Neither side holds most of it (unclaimed, ruined). It keeps what unrest it had. |

### Unrest (0 to 100)

Updated every 5 seconds for each occupied region, from the **occupier's** army
as a share of its maximum:

| Occupier's army | Change per update                                |
| --------------- | ------------------------------------------------ |
| under 35 %      | +2 (thin on the ground)                          |
| 35 % to 60 %    | +1                                               |
| 60 % to 85 %    | 0                                                |
| over 85 %       | -1, and the resistance's own help does not count |

Plus +1 for a base in the region, +1 for an uprising in it, -3 while it is being
suppressed. A region starts between 25 and 50, by how much of it the owner held.

Bands (what the player is shown): **0-24 stable, 25-49 unsettled, 50-74
unrestful, 75-99 volatile, 100 uprising.** Bands are public; the precise number
and the occupier's garrison are what _intelligence_ buys.

**Anti-farming ceiling.** Every time a region changes hands its ceiling drops by
20, down to 40, so trading one region back and forth cannot be milked: after
three hand-overs it can no longer reach the 50 an uprising needs.

## The orders

All are intents; the simulation checks every one, on every client, identically,
and **a refused order costs nothing** (the sender is told why, in their own
language). Troop numbers are shown units.

| Order                   | Needs                                                                                                        | Cost                                      |
| ----------------------- | ------------------------------------------------------------------------------------------------------------ | ----------------------------------------- |
| **Recruit**             | at least 500 troops, room under the capacity, at most 3 batches training, a place to gather                  | 20 gold per troop; they arrive after 30 s |
| **Establish a base**    | an enemy-held tile in an occupied national region with unrest 25+, no other base there, 2 at most            | 50,000 gold                               |
| **Launch an uprising**  | an occupied region with unrest 50+, no cooldown, none running there, 2 at most, 500+ troops from the reserve | 25,000 gold                               |
| **Gather intelligence** | an occupied region; one report per 30 s                                                                      | 10,000 gold                               |

A _place to gather_ is a base, or any land of their own.

A report from **intelligence** shows the region's precise unrest and an estimate
of the occupier's garrison (their troops spread evenly over their land) for 60
seconds; after that only the band is shown, with the report's age.

### An uprising

The troops committed leave the reserve and fight as an attack on the region's
occupier, **inside that region only**, from the occupier's tile nearest the base
(or the middle of the region without one). It can fail: against a strong
garrison it simply loses. When it ends the survivors rejoin the reserve, the
region has a 60 second cooldown, and the player is told how many tiles it won.
Land it wins never merges with other land of the resistance's (it is bounded to
the region), and is exempt from the enclosure rule while the resistance lasts.

### Reclaiming a region

A region won back to 60 % is **reclaimed**: its base is lifted and, the **first
time only**, the purse gets 20,000 and the resistance gains 3 more minutes
(never beyond 30 minutes in all). Losing and retaking it pays nothing more.

## The occupier's counterplay

The occupier is told when a region first turns volatile (and again only after it
has settled below 60), when an uprising begins in their land, and when a base
falls to their suppression. They may **suppress** a region they hold:

- commits 3 % of their army (at least 1,000 shown), out of the army for 60 s, so
  those troops are not attacking anyone else;
- cools the region (-3 per update), wears each base there down by 15 per
  update (it falls at 0) and costs an uprising there 5 % of its troops each update;
- when it ends 90 % come home, the rest are spent;
- at most 2 at once per occupier, one per region, never by an ally of the owner.

Defeating an uprising in combat, and taking the land the resistance holds, are
the other answers, with the same rules as any war.

## How long it lasts

| Clock          | Rule                                                                    |
| -------------- | ----------------------------------------------------------------------- |
| Survival       | 12 minutes from the capital's fall, +3 per region reclaimed, 30 at most |
| With no land   | 5 minutes to win a tile back, or the player is eliminated               |
| Warning        | one minute before the end                                               |
| No means left  | nothing in the field, nothing coming, and no funds to recruit: it ends  |
| The match ends | everything stands down at once                                          |

## A defender with no land

`isAlive()` still means "owns a tile", and everything that reads it keeps
working. What changes is that a resistance holds its owner **in limbo** instead
of eliminating them: no gold is stripped, no units are deleted, no kill is
credited, no finishing place is stamped, no `player_eliminated` line is posted,
and the conqueror is neither paid the player's gold nor told of a conquest (the
"conquered" cue, the gold gain, the effect on the map) yet. A player who wins a
tile back has lost nothing, and can still afford a replacement capital; one who
is finally eliminated is conquered then, once, and the conqueror is paid and told
(`GameImpl.payConquest` and `announceConquest`, from `finalizeElimination`).

- If they win any tile back they are simply alive again.
- If the resistance ends with them still landless, the elimination happens
  then, **exactly once**, crediting whoever took their last land
  (`GameImpl.finalizeElimination`).
- A player whose last tile and capital fall in the same moment goes straight
  into limbo (`noteConquest`); if no resistance results, the elimination they
  would have had is done that same tick.
- A resistance's land is exempt from the **enclosure rule** (land walled in by
  one other player is handed to them), since an uprising wins a pocket inside
  the occupier's land by definition. When the resistance ends the rule applies
  again at once (`Game.retryEnclosure`).

## Abuse and exploits

| Risk                                    | What prevents it                                                                                    |
| --------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Unlimited troops                        | Drawn from the fallen army; capacity 2x; recruiting costs capped gold; survivors only               |
| Unlimited gold                          | Start is capped; income share is moved, not made, and capped; reclaim pays once per region          |
| Farming a region for rewards/time       | Reclaim reward and time are once per region; hand-overs lower its unrest ceiling                    |
| Several resistances for one player      | One per player per match                                                                            |
| An uprising that takes land by clicking | It is an attack; the engine's combat decides                                                        |
| Spamming an order                       | Costs, cooldowns, limits and capacity are all checked in the engine                                 |
| Forged orders from a modified client    | The server only stamps who sent an intent; every client's engine rejects an invalid one identically |
| Capital reward paid twice               | One payment per defender/captor pair ever ([Capital.md](Capital.md))                                |
| An elimination counted twice or never   | `finalizeElimination` runs once, when the resistance ends or the conquest is resolved               |
| Troops lost when a suppression ends     | They come back whole when the resistance ends first                                                 |

Every order that changes anything is also written to a bounded audit log
(`InsurgencySystem.auditLog()`), for investigating a report.

## Wire, state and determinism

- Intents (appended to `IntentSchema`): `resistance_recruit`, `resistance_base`,
  `resistance_uprising`, `resistance_intel`, `suppress_region`.
- Update: `InsurgencyState` carries the owner's view (troops, funds, regions with
  bands, bases, operations, intelligence, suppressions, clocks). The `PlayerUpdate`
  carries the phase (none, resisting with land, resisting without), which the
  replay codec stores.
- All state lives in `InsurgencySystem`, owned by the game exactly like the
  Capital System, and only when the match setting is on. It is in `hash()` and in
  the snapshot (`InsurgencySystemStateSchema`, optional in the game record), so a
  match without it is untouched.
- Reconnecting replays the turns, so the whole resistance is restored by the code
  that made it; nothing is stored on a client.
- The lockstep model means every client holds the same state, so "hidden"
  information (a region's precise unrest, the garrison) is not secret from a
  modified client, only hidden from the interface: intelligence is a gameplay
  cost, not a security boundary.

## The client

Everything on screen comes from the engine's `InsurgencyState` updates and the
match's ticks; the client decides nothing, awards nothing and moves no tile. A
refused order costs nothing and the sender is told why in the events panel.

### Resistance Command (`ResistanceCommand`)

A panel on the left, shown to a player whose resistance is running. It appears a
few seconds after the capital falls, so it does not compete with the CRISIS
announcement. It can be folded away, and remembers that.

- **Status:** a phase (in the field, or no land), the clock being raced (the
  survival time, or with no land the time to win a tile back, turning amber in
  the last minute), strength, the reserve, troops in the field and on the way,
  the capacity, and the funds.
- **Regions:** every national region, the most restless first, with who holds it,
  the unrest band (named, never colour alone), a mark for a base, an uprising or
  a suppression, the region's cooldown, and the latest intelligence (precise
  unrest and garrison while fresh, then marked out of date). "Go" centres the map.
- **Orders:** recruit, establish a base, launch an uprising, gather
  intelligence. Each button shows its price, and when it cannot be used says the
  first thing in the way. Each opens a form that states the cost and what will
  happen, and asks for confirmation. An uprising's form says it can fail.
- **Under way:** recruits and when they arrive, bases and their integrity,
  uprisings and the troops they have left.
- **When it ends:** a card says how, for a while. A player left with no land and
  no resistance then gets the usual "You died"; until then they do not.

The previews (`ResistanceModel`) mirror the engine's checks so a button can say
why it is unavailable. They decide nothing, and a test runs them against the real
engine for every order so they cannot drift apart.

### The map

`RegionOverlay` draws the regions on the map: a square per region with its name,
its band colour and word, and a marker for a base. It takes no pointer events.

So that an order feels like something done and not a number changed in a panel,
`RegionEffects` (pure state, tested without a browser) makes the squares react to
what happens in them: a dotted border goes round and round the square for each
thing going on (an uprising red and fastest, a suppression blue the other way, a
hideout gold and slow), small symbols (shield, swords, castle) sit in its corner,
and when something starts the square shakes and flashes, sparks fly out, and a
floating line rises over its top edge ("🛡 -4.57K Suppressed", "⚔ -3.00K
Uprising!", "🏰 Hideout set up", "🎉 Won back!", "💥 Hideout lost", "🔥 band
up", "🔍 Report in"). It only reacts to a change it sees, never to the first look
at a square or while the game is catching up, so a reload replays nothing; reduced
motion keeps the symbols and words and drops the shake, sparks and marching.
`TilePicker` is how a base is placed: the next map click chooses the tile (and is
not also an attack), a tile that will not do says why and the pick stays open,
Escape or Cancel ends it.

### The occupier

A player who holds land of a running resistance gets a small "Resistance
activity" panel: each such region with its band, and a Suppress button that
states its cost (troops committed, for how long, how many return). Suppression
asks twice, the second click soon after the first.

### For someone who has never seen it (`ResistanceGuide`)

The panel opens with the goal in one plain sentence, then **"Do this next"**: the
one thing to do now, with a "Show me" button that opens that order on the area it
names, then three short steps ("recruit, wait for an area to turn Restless, start an
uprising there") that open by themselves the first time and are one click away
after. "More details" has the whole story. The suggestion is worked out from the
state the engine reports (`nextStep`: an uprising if an area is restless enough and
fighters are ready, recruit if too few are ready, a hideout in a restless area,
spying when all is calm, waiting when nothing can be done) and only suggests: the
engine checks every order. The words are plain (Calm, Uneasy, Restless, Boiling,
Revolt; "Recruit fighters", "Set up a hideout", "Start an uprising", "Spy on the
enemy").

### Replacement capital (`CapitalAction`)

When a player has land and no capital, a small button offers to found one, with
its price. It starts a tile pick; the engine checks everything and explains a
refusal.

## Required scenarios, and where each is tested

| #   | Scenario (spec section 16)                             | Tests                                                                                                       |
| --- | ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| 1   | A capital falls early, before meaningful resistance    | `Activation`: not for an army too small to rise with                                                        |
| 2   | A powerful late-game nation loses its capital          | `Activation`: the force is capped at 25,000 shown; `InsurgencyRules`                                        |
| 3   | The defender keeps some normal land                    | `Limbo`: a resistance whose owner still has land                                                            |
| 4   | The defender loses all land but has surviving forces   | `Limbo`: not eliminated, can found a base, recruit and rise again                                           |
| 5   | The resistance reclaims a region                       | `Uprising`: wins its region back; pays once, extends the time once                                          |
| 6   | The occupier suppresses unrest                         | `Suppression`; `Unrest`                                                                                     |
| 7   | The budget reaches zero                                | `Scenarios`: nothing left to fight with; `Orders`: not without the gold                                     |
| 8   | All resistance troops are eliminated                   | `Scenarios`: an uprising that loses every troop; `Limbo`: exhausted                                         |
| 9   | A replacement capital is constructed                   | `Scenarios`: does not touch the resistance, pay the captor again or double up                               |
| 10  | A player disconnects and reconnects during an uprising | `core/snapshot/InsurgencySystem` (every kind of state, limbo, an order in flight); `Scenarios`: determinism |
| 11  | Several insurgencies at once                           | `Scenarios`: each has its own force, purse, regions and clocks                                              |
| 12  | The match ends while an insurgency is active           | `Limbo`: ends with the match; `Scenarios`: orders once the match is decided                                 |
| 13  | Exploiting repeated transfers and capital rewards      | `Unrest`: the ceiling falls, the reward is paid once; `tests/capital`                                       |
| 14  | The Capital System is disabled                         | `Activation`: not when the match has no Capital System; the snapshot test                                   |

Every order is also tested as an intent through the executor (`Intents`), the way
the game receives it, because the system's methods alone do not exercise the
tick loop: an uprising once charged its price and committed its troops for an
attack that the game then dropped, because it was added from inside an `init()`.
Orders are now applied on the execution's first tick, and an uprising that still
fails to begin is voided with its price and troops returned and the player told.

## Where things are

| What                       | File                                                                                           |
| -------------------------- | ---------------------------------------------------------------------------------------------- |
| Numbers and pure rules     | `packages/engine-lib/src/insurgency/InsurgencyRules.ts`                                        |
| State machine and orders   | `packages/engine/src/game/InsurgencySystem.ts`                                                 |
| Order intake               | `packages/engine/src/execution/InsurgencyOrderExecution.ts`                                    |
| Uprising combat            | `packages/engine/src/execution/AttackExecution.ts` (`ResistanceAttack`)                        |
| Limbo, enclosure exemption | `PlayerExecution.ts`, `GameImpl.ts` (`conquerPlayer`, `finalizeElimination`, `retryEnclosure`) |

## Tests

`tests/insurgency/` (the rules, activation, every order and its refusals, the
unrest model and its ceiling, suppression, uprisings through combat, limbo and
the match's end, the enclosure exemption, the multi-rule scenarios, and every
order as an intent), `tests/core/snapshot/InsurgencySystem.test.ts` (reconnect and
restore), `tests/client/resistance/` (the previews against the real engine, the
panel, the tile picker, the capital button) and `tests/client/InsurgencyViewIngest.test.ts`.

The look of the panel and the map squares, and the whole flow with real mouse
clicks, were verified in a real browser; see the notes in the release.
