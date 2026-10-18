# Capital balance: what the paid-capital numbers were tested against

v0.8.0 sells the capital (500,000 gold, [Capital.md](Capital.md)). The numbers
were chosen by simulation, not by feel: the real engine and the real nation AI,
with the proposed rules patched in memory, on the world map with 18 nations a
game at random spawns, for 20 or 40 minutes. About 2,500 games in all. The
harness was scratch code (not in the repository); this is what it found.

## Assumptions and limits

- The nation AI stands in for players. A person balances better than any of the
  strategies below.
- The test configuration disables the navmesh, so trade and sea play are largely
  absent and port income is understated. Its SAM range is 20 tiles against 70 in
  the game, so interception rates in the simulations say nothing about how well a
  SAM defends (the engine test `NuclearCounterplay` covers that it can be built
  and works).
- 18 nations on the world map is sparser than a real game. Survival noise is
  about ±0.05 to ±0.09 per cell (95 %); the 40-minute cells are smaller.
- Every claim below is about the simulations. Humans have not played it.

## Strategies tested

| Strategy | What it does                                           |
| -------- | ------------------------------------------------------ |
| EARLY    | saves from the start, builds nothing until the capital |
| CITY1    | builds one city, then saves                            |
| CITY2    | builds two cities, then saves                          |
| MID9     | builds as usual until minute 9, then saves             |
| LATE15   | the same, from minute 15                               |
| NEVER    | never buys a capital                                   |

## Findings

**Timing (income only).** EARLY buys at 5.1 minutes, CITY1 at 7.1, CITY2 at 11.4,
as arithmetic says (200,000 start, 100 gold a tick, a city 125,000 then 250,000).
In wars the median purchase is 9 to 12 minutes: conquest gold shortens it.

**Saving from the start is a trap.** Survival at minute 20 (pooled, 480 nation
games each): EARLY 0.30, CITY1 0.43, CITY2 0.49, MID9 0.51, LATE15 0.50, NEVER
0.51. EARLY has about half the cities at minute 10 (1.2 against 2.4 to 3.2).
No bonus tested (up to +30 % maximum troops, 20 % fewer losses) or a 350,000
starting grant rescued it: the danger is in the first minutes, before any bonus
arrives. Nations therefore build first (`NationCapitalBehavior`).

**No snowball.** Owners at minute 10 survive more often (0.88 against 0.60), but
the same with every bonus at zero (0.88 against 0.63), and with bonuses doubled
(0.81 against 0.60): it is successful nations affording a capital, not the
capital. Head to head against NEVER with no strain (60 games each, strength =
mean of troop and tile share, 0 = equal):

| Design                                              | Owner advantage |
| --------------------------------------------------- | --------------- |
| capital has no bonus                                | −0.01           |
| +10 % maximum troops (the first proposal)           | +0.01           |
| flat +250,000 maximum troops                        | −0.02           |
| flat +400,000                                       | −0.00           |
| 25 % cheaper structures                             | +0.01           |
| +50 gold a tick                                     | −0.00           |
| **flat +400,000 and 25 % cheaper structures**       | **+0.02**       |
| +600,000, 30 % cheaper, +50 gold a tick, more regen | +0.01           |
| +800,000, 40 %, +100 gold a tick, more (too strong) | +0.04           |

The strongest design makes not buying a bad strategy (NEVER's tile share falls to
0.34), which is why it was rejected; the chosen one is the first where owners
come out ahead without that. Owners survive slightly less than NEVER in every
design (−0.04 to −0.09): a capital is a target, and its fall means CRISIS.

**Strain makes a window, not a deadline.** Pooled over two designs, buying at
minute 15 (LATE15) loses about 0.25 strength under every strain curve tried
(8 minutes at 4 %, 10 at 3 %, 15 at 2 %); buying anywhere from minutes 7 to 12
(CITY1, CITY2, MID9) is about equal. At 40 minutes NEVER survives 0.21 with
strain against 0.36 without. The three curves could not be told apart at this
sample size: the chosen 10 minutes, 3 %, 30 % is the proposal's, kept.

**Silos and airports.** With the gate on, nations without a capital are targeted
by far fewer nukes (1.85 per living nation against 5.13) and own SAMs less often
(27 % against 69 %). About 17 % of living nations at minutes 10 to 20 held a
silo, SAM or airport without a capital in the ungated runs: those are the ones
the gate stops.

**AI by difficulty** (24 games each, all nations on one policy; "balanced" builds
a city first, "pure" saves from the start):

| Difficulty | Policy   | Median buy (min) | Survival at 20 (free capital) | Cities at 10 (free capital) |
| ---------- | -------- | ---------------- | ----------------------------- | --------------------------- |
| Easy       | pure     | 5.1              | 0.63 (0.64)                   | 1.1 (3.2)                   |
| Easy       | balanced | 7.2              | 0.62                          | 2.5                         |
| Medium     | pure     | 5.1              | 0.47 (0.43)                   | 1.4 (3.0)                   |
| Medium     | balanced | 8.8              | 0.43                          | 1.9                         |
| Hard       | pure     | 5.1              | 0.57 (0.55)                   | 1.3 (2.7)                   |
| Hard       | balanced | 11.3             | 0.55                          | 1.5                         |
| Impossible | pure     | 5.0              | 0.56 (0.63)                   | 1.2 (2.4)                   |
| Impossible | balanced | 7.9              | 0.60                          | 1.3                         |

Survival matches the free-capital game except pure-saving Impossible. A nation
that saves from the start has half the cities, ports and defense posts; in a mixed
field it is the weakest. At minute 10 only 29 % to 65 % of living nations own a
capital, so strain falls on the AI too.

## The shipped nation policy, end to end

The tables above patched the rules into an older build. The shipped policy
(`NationCapitalBehavior`: one or two cities first by difficulty, then save, no
saving under a real attack) was then played on the real v0.8.0 code, unpatched:
24 matches of 18 nations per difficulty, 20 minutes (`tests/capital/PolicySweep.test.ts`,
skipped unless `POLICY_SWEEP=1`).

| Difficulty | Bought by minute 20 | Median buy (min) | Middle half (min) | Survival at 20 (free capital) | Own a capital at 10 / 20 (of the living) | Cities at 10 (free capital) |
| ---------- | ------------------- | ---------------- | ----------------- | ----------------------------- | ---------------------------------------- | --------------------------- |
| Easy       | 63 %                | 8.0              | 6.7 to 10.1       | 0.63 (0.64)                   | 51 % / 62 %                              | 3.5 (3.2)                   |
| Medium     | 42 %                | 7.9              | (one city first)  | 0.45 (0.43)                   | 39 % / 58 %                              | 2.0 (3.0)                   |
| Hard       | 40 %                | 9.8              | 7.1 to 14.5       | 0.54 (0.55)                   | 26 % / 42 %                              | 1.6 (2.7)                   |
| Impossible | 60 %                | 7.1              | 7.1 to 8.8        | 0.62 (0.63)                   | 52 % / 47 %                              | 1.4 (2.4)                   |

(The "bought" column counts every nation, dead ones included. Survival is that of
the free-capital game of the earlier sweep.) Survival is the same as with a free
capital at every difficulty; what changes is the build: fewer ports (Medium has
0.07 at minute 10 against 1.5) and, for Medium and Hard, a capital that comes
late (only 12 % and 26 % of the living own one at minute 10, so strain falls on
most of them for a while). Medium first built two cities, and bought at 11.3 minutes with only 12 % of the
living owning a capital at minute 10; it now builds one first, which brings the
median to 7.9 minutes and 39 % at minute 10 with the same survival (the Medium row
is from that second run).

A capital now takes 30 s to build (a SAM launcher's time), which the simulations did
not model: it delays every capital by 30 s, which changes none of the timings above
by more than a minute, and adds a way to lose the gold (the land is taken first).

## What changed in the numbers

| Rule                  | v0.7.0                      | v0.8.0                                     |
| --------------------- | --------------------------- | ------------------------------------------ |
| First capital         | free, at spawn              | 500,000 gold, anywhere interior            |
| Starting gold         | 0                           | 200,000 (everyone), host's on top          |
| Income / regeneration | +10 % / +10 %               | +10 % / +25 %                              |
| Maximum troops        | none                        | +400,000 flat                              |
| Structures            | full price                  | City, Port, Factory, Defense Post −25 %    |
| Attacking losses      | none                        | −10 %                                      |
| Silo, airport         | anyone                      | need a capital (SAM launchers do not)      |
| No capital            | not possible                | strain after 10 minutes, −3 %/min to −30 % |
| Bonus ramp            | replacement only, 5 minutes | every capital, 50 % to 100 % in 3 minutes  |

Re-run the balance sweep (`BALANCE_SWEEP=1`, [InsurgencyBalance.md](InsurgencyBalance.md))
after any change here: a flat maximum-troop bonus moves the occupier's army
against its maximum, which is what unrest reads.
