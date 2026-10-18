# Insurgency and capital balance: what the numbers are

These are the numbers behind `INSURGENCY_SPEC` and `CAPITAL_SPEC` (both are
proposals, see [Insurgency.md](Insurgency.md) and [Capital.md](Capital.md)),
measured by playing the real engine under the real attack and economy rules
(`tests/insurgency/BalanceSweep.test.ts`, skipped in the normal suite):

```
BALANCE_SWEEP=1 BALANCE_OUT=/tmp/balance.md npx vitest tests/insurgency/BalanceSweep.test.ts --run
```

It runs in a few seconds and is deterministic, so a rebalance can be re-measured
straight away. **These are measurements, not a verdict.** Whether the resistance
is _fair_ is a question for people (plan rows 2.4 and 3.6 in
[PreReleasePlaytest.md](PreReleasePlaytest.md)); the sweep only says what happens.

## v0.8.0: capitals are bought, and carry a flat troop bonus

The tables below were measured in v0.7.0, when every capital was free and gave +10 %
income and regeneration. In v0.8.0 a capital is bought and adds a flat +400,000
maximum troops ([Capital.md](Capital.md)), which raises the occupier's maximum and so
lowers the share of it that an army of the same size fills. The sweep was re-run with
capitals bought at full strength (the same scenarios, the same rules otherwise): of
the same rows, more end with the resistance alive at 12 minutes (12 against 9) or
exhausted (14 against 9), fewer end with the survival time expired (24 against 29)
and fewer reclaim a region (5 against 8). The resistance is a little stronger
against a big occupier and no easier to win; no row changed character. The tables
below are v0.7.0's and are not regenerated here; re-run the command above to see the
v0.8.0 ones.

## How to read the tables

- One map (flat plains), one geometry: the defender holds a square, the occupier
  is east of her, takes her capital by a corridor and then the east 60 % of her
  land. Each row is 12 minutes from the fall of the capital.
- The resistance is _played by a script_ that reads the occupier's army (as a
  player who paid for intelligence would). **Eager** launches an uprising with
  everything in reserve the moment a region allows it. **Patient** waits until
  its reserve is at least the garrison it would meet, and buys a base only where
  a base can help. A person may do better or worse.
- _Held_ rows keep the occupier's army at the fraction of its maximum shown,
  however much it spends: the worst case for the resistance, as suppressing or
  counter-attacking then costs it nothing. _Free_ rows let the army regenerate
  by the real rules from the level a big assault leaves it at.
- Troops are as the game shows them (engine units / 10). The purse is the
  minimum (100K) unless stated; the real minimum applies to anyone who earned
  less than 2M gold in the match.
- "Unrest 50 at" is when any region first allows an uprising. "Tiles won" is the
  most land she held beyond what she had after the fall.

## What they show

1. **A first strike is always available.** A region she held at least half of
   starts at unrest 50, which is exactly what an uprising needs, so the start
   force can be thrown in within the first 5 seconds whatever the occupier's
   strength. Against an occupier at 95 % of its army that wins 300 to 400 tiles
   (about a third of a region) and reclaims nothing.
2. **A strong occupier (85 % of its army or more) shuts the resistance down
   after that.** Unrest only falls (1 every 5 seconds), so the window does not
   reopen: there is never a second uprising, and the patient player, who waits
   30 seconds for recruits to arrive, finds the region already below 50 and
   never launches. The 12 minutes then simply run out (`survival_expired`).
   Between 60 % and 85 % unrest stays flat (a base, or an uprising under way,
   adds 1 an update); below 60 % it rises, and the resistance can win back a
   whole region (peak unrest 100 at 15 % and 40 %).
3. **The window after an assault is short.** From 20 % of its army the occupier
   is at 60 % after about 16 seconds and at 85 % after about 31 (from 50 %: 6 and
   22 seconds). Unless it keeps spending troops, an eager resistance gets one
   uprising with its starting force and nothing sustained (section 2: 345 to 395
   tiles, no region reclaimed), and a patient one that began at 50 % never gets
   to launch.
4. **Where the tiles are won matters as much as how many.** At 70 % held the
   same 692 tiles reclaimed a region when won in one uprising and none when split
   across two (a region counts as reclaimed once she holds 60 % of what she had
   there).
5. **Money is the real ceiling.** A recruited troop costs 20 gold, an uprising
   25K, a base 50K, against a purse of 100K at least. With 100K she reclaims one
   region from a 40 % occupier; with 500K, both (all 2,048 occupied tiles;
   section 3). The 10 % income share adds about 6.6K a minute (income is about
   66K a minute).
6. **Nothing protects her land.** An occupier that keeps attacking what is left
   of it (section 2, counter) takes all of it in about 35 seconds, and limbo
   (5 minutes) then expires. That is ordinary combat, and the sweep's defender
   never fights back with her own army (26K shown at the fall), so this is a
   worst case, not a prediction. The script had also spent its purse on recruits
   and could not afford the base a landless player needs ("no location"); the
   engine does allow it (`tests/insurgency/Limbo.test.ts`), so this is about
   advice to the player, not a rule. Plan row 2.5 asks a person whether the
   panel makes that clear.
7. **Capturing a capital pays about four minutes of income** (section 5): 250K gold
   against 66K a minute. The troop reward (10 % of the maximum army) is worth
   about 12 seconds of regeneration at half an army, so it is a flourish; the
   gold is the prize. It is paid once per defender and captor pair, so it scales
   with the number of different players conquered (plan row 3.6).

## The knobs

| To change...                                         | Look at                                                                                                                    |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| how hard a strong occupier shuts the resistance down | `unrestStrongStep` (-1), `unrestHighFillPermille` (850)                                                                    |
| the guaranteed first strike                          | `unrestStartMax` (50, the same as `uprisingMinUnrest`)                                                                     |
| how much force and money a resistance has            | `startTroopsPercent`, `startTroopsMax`, `capacityMultiplier`, `recruitGoldPerTroop`, `startFundsMin`, `incomeSharePercent` |
| how long it lasts                                    | `survivalTicks`, `survivalExtensionTicks`, `survivalMaxTicks`, `limboTicks`                                                |
| what a capture is worth                              | `captureGold`, `captureGoldReplacement`, `captureTroopsPercent`                                                            |

## What this does not show

People using intelligence, bases and timing well; nations or bots as occupiers
(their attack behaviour); several resistances at once; terrain, water and
chokepoints; lag. Those are what the human sessions are for.

# The measurements (generated)

### 1. The occupier's strength held constant (defender 4,096 tiles)

| her tiles | his tiles | his army  | occupier | played  | start force / purse | unrest 50 at (s) | peak unrest | base at (s) | uprisings (troops) | tiles won (peak) | held at end | regions reclaimed | his army 60 % / 85 % at (s) | end                       |
| --------- | --------- | --------- | -------- | ------- | ------------------- | ---------------- | ----------- | ----------- | ------------------ | ---------------- | ----------- | ----------------- | --------------------------- | ------------------------- |
| 4096      | 3025      | 15 % held | passive  | eager   | 3.9K / 100K         | 5                | 100         | never       | 3 (8.2K)           | 1006             | 1007        | 1                 | -                           | exhausted at 524 s        |
| 4096      | 3025      | 15 % held | passive  | patient | 3.9K / 100K         | 5                | 100         | never       | 3 (9.2K)           | 978              | 982         | 1                 | -                           | alive at 12 min           |
| 4096      | 3025      | 40 % held | passive  | eager   | 3.9K / 100K         | 5                | 100         | never       | 3 (8.2K)           | 857              | 858         | 1                 | -                           | exhausted at 526 s        |
| 4096      | 3025      | 40 % held | passive  | patient | 3.9K / 100K         | 5                | 100         | never       | 2 (7.7K)           | 806              | 806         | 1                 | -                           | alive at 12 min           |
| 4096      | 3025      | 70 % held | passive  | eager   | 3.9K / 100K         | 5                | 54          | never       | 2 (7.7K)           | 692              | 693         | 0                 | -                           | exhausted at 349 s        |
| 4096      | 3025      | 70 % held | passive  | patient | 3.9K / 100K         | 5                | 52          | never       | 1 (7.7K)           | 692              | 692         | 1                 | -                           | alive at 12 min           |
| 4096      | 3025      | 95 % held | passive  | eager   | 3.9K / 100K         | 5                | 50          | never       | 1 (3.9K)           | 320              | 320         | 0                 | -                           | survival_expired at 720 s |
| 4096      | 3025      | 95 % held | passive  | patient | 3.9K / 100K         | 5                | 50          | never       | 0 (0.0K)           | 0                | 0           | 0                 | -                           | survival_expired at 720 s |
| 4096      | 14950     | 15 % held | passive  | eager   | 3.9K / 100K         | 5                | 100         | never       | 3 (8.2K)           | 1044             | 1045        | 1                 | -                           | exhausted at 526 s        |
| 4096      | 14950     | 15 % held | passive  | patient | 3.9K / 100K         | 5                | 100         | never       | 3 (8.7K)           | 1108             | 1109        | 1                 | -                           | exhausted at 627 s        |
| 4096      | 14950     | 40 % held | passive  | eager   | 3.9K / 100K         | 5                | 100         | never       | 3 (8.2K)           | 955              | 956         | 1                 | -                           | exhausted at 527 s        |
| 4096      | 14950     | 40 % held | passive  | patient | 3.9K / 100K         | 5                | 100         | never       | 2 (7.7K)           | 897              | 897         | 1                 | -                           | alive at 12 min           |
| 4096      | 14950     | 70 % held | passive  | eager   | 3.9K / 100K         | 5                | 54          | never       | 3 (8.2K)           | 867              | 868         | 1                 | -                           | exhausted at 526 s        |
| 4096      | 14950     | 70 % held | passive  | patient | 3.9K / 100K         | 5                | 54          | never       | 2 (7.7K)           | 815              | 815         | 1                 | -                           | alive at 12 min           |
| 4096      | 14950     | 95 % held | passive  | eager   | 3.9K / 100K         | 5                | 50          | never       | 1 (3.9K)           | 389              | 389         | 0                 | -                           | survival_expired at 720 s |
| 4096      | 14950     | 95 % held | passive  | patient | 3.9K / 100K         | 5                | 50          | never       | 0 (0.0K)           | 0                | 0           | 0                 | -                           | survival_expired at 720 s |
| 4096      | 3025      | 15 % held | suppress | eager   | 3.9K / 100K         | 5                | 50          | never       | 1 (3.9K)           | 480              | 480         | 0                 | -                           | survival_expired at 720 s |
| 4096      | 3025      | 15 % held | suppress | patient | 3.9K / 100K         | 5                | 50          | never       | 1 (3.9K)           | 480              | 480         | 0                 | -                           | survival_expired at 720 s |
| 4096      | 3025      | 40 % held | suppress | eager   | 3.9K / 100K         | 5                | 50          | never       | 1 (3.9K)           | 399              | 399         | 0                 | -                           | survival_expired at 720 s |
| 4096      | 3025      | 40 % held | suppress | patient | 3.9K / 100K         | 5                | 50          | never       | 1 (3.9K)           | 399              | 399         | 0                 | -                           | survival_expired at 720 s |
| 4096      | 3025      | 70 % held | suppress | eager   | 3.9K / 100K         | 5                | 50          | never       | 1 (3.9K)           | 340              | 340         | 0                 | -                           | survival_expired at 720 s |
| 4096      | 3025      | 70 % held | suppress | patient | 3.9K / 100K         | 5                | 50          | never       | 0 (0.0K)           | 0                | 0           | 0                 | -                           | survival_expired at 720 s |
| 4096      | 3025      | 95 % held | suppress | eager   | 3.9K / 100K         | 5                | 50          | never       | 1 (3.9K)           | 305              | 305         | 0                 | -                           | survival_expired at 720 s |
| 4096      | 3025      | 95 % held | suppress | patient | 3.9K / 100K         | 5                | 50          | never       | 0 (0.0K)           | 0                | 0           | 0                 | -                           | survival_expired at 720 s |
| 4096      | 14950     | 15 % held | suppress | eager   | 3.9K / 100K         | 5                | 50          | never       | 1 (3.9K)           | 488              | 488         | 0                 | -                           | survival_expired at 720 s |
| 4096      | 14950     | 15 % held | suppress | patient | 3.9K / 100K         | 5                | 50          | never       | 1 (3.9K)           | 488              | 488         | 0                 | -                           | survival_expired at 720 s |
| 4096      | 14950     | 40 % held | suppress | eager   | 3.9K / 100K         | 5                | 50          | never       | 1 (3.9K)           | 433              | 433         | 0                 | -                           | survival_expired at 720 s |
| 4096      | 14950     | 40 % held | suppress | patient | 3.9K / 100K         | 5                | 50          | never       | 1 (3.9K)           | 433              | 433         | 0                 | -                           | survival_expired at 720 s |
| 4096      | 14950     | 70 % held | suppress | eager   | 3.9K / 100K         | 5                | 50          | never       | 1 (3.9K)           | 391              | 391         | 0                 | -                           | survival_expired at 720 s |
| 4096      | 14950     | 70 % held | suppress | patient | 3.9K / 100K         | 5                | 50          | never       | 1 (3.9K)           | 391              | 391         | 0                 | -                           | survival_expired at 720 s |
| 4096      | 14950     | 95 % held | suppress | eager   | 3.9K / 100K         | 5                | 50          | never       | 1 (3.9K)           | 358              | 358         | 0                 | -                           | survival_expired at 720 s |
| 4096      | 14950     | 95 % held | suppress | patient | 3.9K / 100K         | 5                | 50          | never       | 0 (0.0K)           | 0                | 0           | 0                 | -                           | survival_expired at 720 s |

### 2. The occupier's army regenerating from where an assault leaves it

| her tiles | his tiles | his army  | occupier | played  | start force / purse | unrest 50 at (s) | peak unrest | base at (s) | uprisings (troops) | tiles won (peak) | held at end | regions reclaimed | his army 60 % / 85 % at (s) | end                       |
| --------- | --------- | --------- | -------- | ------- | ------------------- | ---------------- | ----------- | ----------- | ------------------ | ---------------- | ----------- | ----------------- | --------------------------- | ------------------------- |
| 4096      | 3025      | 20 % free | passive  | eager   | 3.9K / 100K         | 5                | 54          | never       | 1 (3.9K)           | 395              | 395         | 0                 | 16 / 31                     | survival_expired at 720 s |
| 4096      | 3025      | 20 % free | passive  | patient | 3.9K / 100K         | 5                | 54          | never       | 1 (3.9K)           | 395              | 395         | 0                 | 16 / 31                     | survival_expired at 720 s |
| 4096      | 3025      | 20 % free | suppress | eager   | 3.9K / 100K         | 5                | 50          | never       | 1 (3.9K)           | 393              | 393         | 0                 | 18 / 33                     | survival_expired at 720 s |
| 4096      | 3025      | 20 % free | suppress | patient | 3.9K / 100K         | 5                | 50          | never       | 1 (3.9K)           | 393              | 393         | 0                 | 18 / 33                     | survival_expired at 720 s |
| 4096      | 3025      | 20 % free | counter  | eager   | 3.9K / 100K         | 5                | 57          | never       | 1 (3.9K)           | 1                | -1600       | 0                 | 44 / 60                     | limbo_expired at 336 s    |
| 4096      | 3025      | 20 % free | counter  | patient | 3.9K / 100K         | 5                | 57          | never       | 1 (3.9K)           | 1                | -1600       | 0                 | 44 / 60                     | limbo_expired at 336 s    |
| 4096      | 3025      | 50 % free | passive  | eager   | 3.9K / 100K         | 5                | 53          | never       | 1 (3.9K)           | 355              | 355         | 0                 | 6 / 22                      | survival_expired at 720 s |
| 4096      | 3025      | 50 % free | passive  | patient | 3.9K / 100K         | 5                | 50          | never       | 0 (0.0K)           | 0                | 0           | 0                 | 6 / 21                      | survival_expired at 720 s |
| 4096      | 3025      | 50 % free | suppress | eager   | 3.9K / 100K         | 5                | 50          | never       | 1 (3.9K)           | 345              | 345         | 0                 | 8 / 24                      | survival_expired at 720 s |
| 4096      | 3025      | 50 % free | suppress | patient | 3.9K / 100K         | 5                | 50          | never       | 0 (0.0K)           | 0                | 0           | 0                 | 8 / 23                      | survival_expired at 720 s |
| 4096      | 3025      | 50 % free | counter  | eager   | 3.9K / 100K         | 5                | 56          | never       | 1 (3.9K)           | 0                | -1600       | 0                 | 35 / 51                     | limbo_expired at 330 s    |
| 4096      | 3025      | 50 % free | counter  | patient | 3.9K / 100K         | 5                | 56          | never       | 1 (3.9K)           | 0                | -1600       | 0                 | 35 / 51                     | limbo_expired at 330 s    |

### 3. The defender's size and purse (occupier held at 40 %, passive)

| her tiles | his tiles | his army  | occupier | played  | start force / purse | unrest 50 at (s) | peak unrest | base at (s) | uprisings (troops) | tiles won (peak) | held at end | regions reclaimed | his army 60 % / 85 % at (s) | end                |
| --------- | --------- | --------- | -------- | ------- | ------------------- | ---------------- | ----------- | ----------- | ------------------ | ---------------- | ----------- | ----------------- | --------------------------- | ------------------ |
| 1024      | 3025      | 40 % held | passive  | patient | 2.3K / 100K         | 5                | 57          | never       | 1 (4.6K)           | 452              | 452         | 1                 | -                           | alive at 12 min    |
| 1024      | 3025      | 40 % held | passive  | patient | 2.3K / 500K         | 5                | 63          | 5           | 1 (4.6K)           | 452              | 452         | 1                 | -                           | alive at 12 min    |
| 4096      | 3025      | 40 % held | passive  | patient | 3.9K / 100K         | 5                | 100         | never       | 2 (7.7K)           | 806              | 806         | 1                 | -                           | alive at 12 min    |
| 4096      | 3025      | 40 % held | passive  | patient | 3.9K / 500K         | 5                | 99          | 5           | 4 (22.1K)          | 2048             | 2048        | 2                 | -                           | alive at 12 min    |
| 8100      | 3025      | 40 % held | passive  | patient | 5.4K / 100K         | 5                | 73          | never       | 2 (9.2K)           | 1001             | 1002        | 1                 | -                           | exhausted at 114 s |
| 8100      | 3025      | 40 % held | passive  | patient | 5.4K / 500K         | 5                | 100         | 5           | 4 (18.8K)          | 2034             | 2035        | 3                 | -                           | exhausted at 157 s |

### 4. Costs and limits (generated from INSURGENCY_SPEC and CAPITAL_SPEC)

Troops are as the game shows them (engine units / 10); gold as is.

| What                                     | Cost                                            | Needs / limits                                                                                                                  | Effect                                                                                                                                               |
| ---------------------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| The resistance (free, automatic)         | -                                               | a human with a capital that falls, an army of at least 10,000 shown, one region of at least 12 tiles; once per player per match | 10 % of the fallen army (at most 25,000 shown) is taken from it and rises; total manpower is capped at 2x that                                       |
| Starting purse                           | -                                               | 5 % of all the gold the player ever earned, at least 100,000, at most 1,000,000                                                 | then 10 % of the owner's income is moved to it while they hold land, 500,000 in all; 20,000 per region reclaimed                                     |
| Recruit                                  | 20 gold per shown troop                         | batches of at least 500 shown; at most 3 pending; within the capacity                                                           | arrive after 30 s                                                                                                                                    |
| Base                                     | 50,000 gold                                     | a region with unrest of at least 25; one per region; at most 2                                                                  | +1 unrest per update there (not against a strong occupier); an uprising there breaks in next to it; gives a landless player a place to stand         |
| Uprising                                 | 25,000 gold + the troops                        | unrest of at least 50; at least 500 shown; at most 2 at once; 60 s cooldown per region                                          | an ordinary attack inside the region; survivors come home                                                                                            |
| Intel                                    | 10,000 gold                                     | 30 s cooldown                                                                                                                   | exact unrest and garrison of a region for 60 s, then only the band                                                                                   |
| Suppress (the occupier)                  | 3 % of its army (at least 1,000 shown) for 60 s | at most 2 at once; one per region                                                                                               | -3 unrest per update; a base there loses 15 integrity per update; an uprising there loses 5 % of its troops per update; 90 % of the troops come home |
| How long it lasts                        | -                                               | 12 min, +3 min for each region reclaimed, never past 30 min                                                                     | a landless player has 5 min to win a tile back; a warning 60 s before either end                                                                     |
| Found a replacement capital              | 500,000 gold                                    | 30 s after the fall; on owned land, off the border; not during the spawn phase                                                  | bonus starts at 50 % and reaches 100 % in 5 min                                                                                                      |
| CRISIS (the owner of a captured capital) | -                                               | 3 or 5 minutes, chosen for the match                                                                                            | income and troop regeneration at 50 % / 50 %; a standing capital gives +10 % / +10 %                                                                 |

### 5. Capture rewards against ordinary income (measured under the real rules)

Capturing a capital pays the captor 250,000 gold (125,000 for a replacement) and 10 % of its maximum army (never past the maximum), once per defender and captor pair, ever. Income and regeneration below are one minute for a player of that size, with no cities or ports, army at half.

| land (tiles) | gold per minute | the capture gold is worth | max army (shown) | troop reward (shown) | regeneration per minute (shown) | the troop reward is worth |
| ------------ | --------------- | ------------------------- | ---------------- | -------------------- | ------------------------------- | ------------------------- |
| 1,024        | 66,000          | 3.8 min of income         | 22,800           | 2,280                | 11,347                          | 12 s of regeneration      |
| 4,096        | 66,000          | 3.8 min of income         | 39,406           | 3,940                | 19,508                          | 12 s of regeneration      |
| 10,000       | 66,000          | 3.8 min of income         | 60,237           | 6,023                | 29,607                          | 12 s of regeneration      |

Experience points: 40 per captured human capital, at most 3 a match, once per owner, only after the first two minutes; the per-match tripwire is 1,500 (the true maximum is 1,275).
