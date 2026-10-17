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

A capital that is destroyed (nuked, rotted away, taken by a friend) is not
captured: no resistance. Turning the Capital System off removes everything here.

## The force and the purse

| Resource        | Rule                                                                                  |
| --------------- | ------------------------------------------------------------------------------------- |
| Starting troops | 10 % of the army that fell, at most 25,000 shown, **taken from that army**            |
| Capacity        | 2 x the starting troops, counting reserve + in the field + still training             |
| Starting funds  | 5 % of all the gold the owner earned this match, between 100,000 and 1,000,000        |
| Income share    | while the owner holds land, 10 % of their gold income moves to the purse, 500,000 max |

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
credited, no finishing place is stamped, no `player_eliminated` line is posted.

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

## Where things are

| What                       | File                                                                                           |
| -------------------------- | ---------------------------------------------------------------------------------------------- |
| Numbers and pure rules     | `packages/engine-lib/src/insurgency/InsurgencyRules.ts`                                        |
| State machine and orders   | `packages/engine/src/game/InsurgencySystem.ts`                                                 |
| Order intake               | `packages/engine/src/execution/InsurgencyOrderExecution.ts`                                    |
| Uprising combat            | `packages/engine/src/execution/AttackExecution.ts` (`ResistanceAttack`)                        |
| Limbo, enclosure exemption | `PlayerExecution.ts`, `GameImpl.ts` (`conquerPlayer`, `finalizeElimination`, `retryEnclosure`) |

## Tests

`tests/insurgency/`: the rules, activation, every order and its refusals, the
unrest model and ceiling, suppression, uprisings through combat, limbo and
elimination, and the enclosure exemption. `tests/core/snapshot/` covers the round
trip.
