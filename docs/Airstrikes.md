# Airstrikes

An **Airport** (1M, +500k each, max 2M) launches one strike per 20 s (rearm) at a hostile
target within 400 tiles. Three strikes share one fighter, flying 2 tiles per tick in a straight
line from the airport; SAMs can shoot it down (no refund). Rules: `AIRSTRIKE_SPECS` in
`packages/engine-lib/src/configuration/Config.ts`, damage in
`packages/engine/src/execution/airstrike/AirstrikeDamage.ts`, prices in `EngineConfig.ts`.
`AirstrikeV2Plan.md` is the original plan.

## Damage

Troops are a pool spread over a player's land (as nukes assume), so a strike kills:

- **Garrison**: `troopFactor x (land hit / land owned)` of the victim's troops, capped.
- **City bonus**: if one of the victim's finished cities is within 6 tiles of the strike area,
  that loss is multiplied by the city multiplier (by the city's level, up to level 5) and capped
  at the city cap instead. One multiplier per victim: their highest city level in reach, never one
  per city.
- **Army**: each of the victim's attacks whose front (the tiles it is fighting over) runs through
  the area loses `armyFactor x (front hit / front size)` of its troops, capped. Concentrated troops
  on a short front lose far more than the same troops spread along a long one. A strike on the
  front from the defended side hits the attacking army too.

Allies, teammates, the attacker and unowned land are never hurt. Structures lose levels (never
land). The nation AI values a strike with the same planner the strike uses (`planTroopDamage`).

| Strike          | Price            | Area                                   | Garrison factor / cap     | City x (L1 to L5) / cap    | Army factor / cap   | Structures                        |
| --------------- | ---------------- | -------------------------------------- | ------------------------- | -------------------------- | ------------------- | --------------------------------- |
| Bombing Run     | 300k             | disc r 10 (~317 tiles)                 | 6.0 / 30%                 | 1.5 to 2.0 / 45%           | 4.0 / 35%           | -1 level, every structure in r 10 |
| Rocket Strike   | 225k             | disc r 4 (49 tiles), from 10 tiles out | 10.0 / 15%                | 2.0 to 3.0 / 40%           | 5.0 / 30%           | -2 levels, one structure          |
| Strafing Run    | 150k             | 40 x 5 corridor, 4 bursts              | 4.0 / 6% per burst        | 1.25 to 1.5 / 9% per burst | 8.0 / 20% per burst | -1 level, one structure           |
| _Atom bomb_     | _750k + 1M silo_ | _r 12 / 30 (~1,640 tiles destroyed)_   | _~5x land lost, uncapped_ |                            | _hit too_           | _all in range destroyed_          |
| _Hydrogen bomb_ | _5M_             | _r 80 / 100_                           |                           |                            |                     |                                   |

Tactical roles: bombing for a packed heartland, rockets for a city garrison or one key structure,
strafing to cut down an attack in progress along its front.

## Presentation (client only)

Never part of the simulation, so it cannot change an outcome or a replay.

- **Flight**: planes are drawn on their exact line (`render/frame/derive/PlaneFlight.ts`), rebuilt
  from the airport and target with the engine's own geometry. The simulation's tiles are that line
  rounded each tick; drawing between rounded tiles is what made planes zigzag.
- **Sound** (`controllers/AirstrikeAudioController.ts`): siren (bomb, rocket) or klaxon (strafe)
  for the targeted player only, take-off for the attacker, a pass-over ~1.4 s before the end of the
  line, a bomb whistle ~0.9 s before impact, the explosion / rockets / "BRRRT" per burst as each
  lands (deeper over a city), then a fading fire. Panned to the screen position; the attacker and
  the players hit always hear it, others only on screen. Mixer channels, mute and budgets apply.
- **Impact**: blasts sized to the real area, fires and smoke for 45 s (bomb), 50 s (rocket) or
  40 s (strafe) where damage was done, more for heavier damage and city hits; at most 160 patches,
  a repeat strike refreshes rather than stacks.
- **Casualties**: "-4,250 troops" rises over the area from the simulation's own count (a strafing
  run's bursts add up into one number), with "City garrison hit" or "-N building levels" under it.
