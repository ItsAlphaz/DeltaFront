# Airstrike V2 — Implementation Plan

Status: **plan only — nothing in this document has been implemented.**
Source of truth when this was written: the uncommitted Airstrike V1 working tree on
top of commit `67fcc8fec` ("uopdated homepage").

**Amendments (final, supersede anything older in this file):** one aircraft
speed of 2 tiles/tick for all strike types (§3, §4.6); SAM hit chances
65 % / 50 % / 60 % (§3.1, §7); airport destroyed mid-flight (§5.7a); no refund
on interception (§5.7b); own/allied buildings never damaged (§9.1).

This plan is written so a coding model can execute it top to bottom without
re-deciding design questions. Every number, name, file and rule is fixed here.
Where a choice was made, the reason is given once, next to it. If something in
the code no longer matches what this plan describes, stop and re-read the
relevant section of the "Current architecture" chapter before improvising.

---

## 0. Ground rules for the implementer

1. **Never commit or push.** Leave every change in the working tree.
2. **Determinism.** Engine code (`packages/engine*`) must not use `Math.random`,
   `Date.now`, `new Date`, `performance.now()` for decisions, or the
   approximated `Math` functions (`sin`, `cos`, `atan2`, `pow`, `exp`, `log`,
   `**` with exponent ≠ 2). `Math.sqrt`, `Math.round`, `Math.floor`,
   `Math.ceil`, `Math.min`, `Math.max`, `Math.abs`, `Math.hypot`
   (avoid; use sqrt of a sum) and plain IEEE arithmetic are fine. Use
   `PseudoRandom` (seeded, snapshotted) for any randomness. ESLint enforces part
   of this; `tests/LayerBoundaries.test.ts` enforces the rest.
3. **Engine changes need tests** (CLAUDE.md). Every engine step below lists its
   test.
4. **All UI text through `translateText()`**, keys in `resources/lang/en.json`
   kept alphabetically sorted (`tests/EnJsonSorted.test.ts`), and every key
   must be referenced from source (`tests/TranslationSystem.test.ts`, "en.json
   keys stay in sync with source usage").
5. **Append, never insert,** for anything with positional encoding: `UnitType`
   enum members, `MessageType`, `GameUpdateType`, `PlayerStatsSchema` fields,
   stats index constants, `otherUnits`, `UNIT_ORDER` / `STRUCTURE_ORDER` atlas
   columns. (zbin encodes enums/fields positionally — `packages/zbin/README.md`.)
6. **Keep AGPL/branding notices** (`© OpenFront and Contributors`, "Based on
   OpenFront").
7. Do not leave dev servers running after browser checks.
8. Run `npm run typecheck`, `npm run lint`, `npx vitest --run` at the end of
   every phase. Use `npm run typecheck`, **never** `npx tsc -b` (it emits `.js`
   files into the tree).

---

## 1. Current architecture discovered

### 1.1 Airstrike V1 (uncommitted, this is what V2 replaces)

| Concern        | Where                                                                                                                                                               | What it does today                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unit types     | `packages/engine-api/src/game/GameTypes.ts` `enum UnitType`                                                                                                         | `Airport = "Airport"`, `Airstrike = "Airstrike"` appended last. `Airport` ∈ `Structures`; `Airstrike` ∈ `BuildableAttacks`. `Airstrike` is **both** the buildable attack and the flying plane unit.                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Messages       | same file, `enum MessageType`                                                                                                                                       | `AIRSTRIKE_INBOUND`, `AIRSTRIKE_HIT` appended; both `MessageCategory.ATTACK`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Rules config   | `packages/engine-lib/src/configuration/Config.ts`                                                                                                                   | `AirportCooldown()` = 150, `launcherCooldown(type)`, `airportRange()` = 100, `airstrikeRadius()` = 12, `unitInfo(Airport)` = 100-tick construction, not upgradable; `unitInfo(Airstrike)` = `{}`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Costs / tuning | `packages/engine/src/configuration/EngineConfig.ts`                                                                                                                 | `unitCost(Airport)` = `min(1.5M, (n+1)*500k)`; `unitCost(Airstrike)` = 300k; `airstrikeSpeed()` = 4; `airstrikeTroopLoss(troops, hit, owned)` = `floor(troops * min(2000, floor(20000*hit/owned)) / 10000)`.                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Unit params    | `packages/engine/src/game/Game.ts` `UnitParamsMap`                                                                                                                  | `[Airport]: Record<string, never>`, `[Airstrike]: { targetTile?: number }`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Targeting      | `packages/engine/src/game/PlayerImpl.ts` `canSpawnUnitType` → `airstrikeSpawn(tile)`                                                                                | Rejects during spawn immunity, non-land/impassable, unowned/own/friendly targets; returns the tile of the nearest (euclidean²) active, finished, non-cooldown airport within `airportRange`. Airport placement = `landBasedStructureSpawn`.                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Construction   | `packages/engine/src/execution/ConstructionExecution.ts`                                                                                                            | `Airport` is a structure → `MissileSiloExecution` on completion (rearm timer). `Airstrike` (non-structure) → `new AirstrikeExecution(player, tile)`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Rearm          | `packages/engine/src/execution/MissileSiloExecution.ts`                                                                                                             | Reloads when `config.launcherCooldown(unit.type()) - (ticks - queue[0]) <= 0`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Strike         | `packages/engine/src/execution/AirstrikeExecution.ts`                                                                                                               | Tick 1: `canBuild` → `buildUnit(Airstrike, airportTile, {targetTile})` (charges 300k) → `recordMotionPlan` (grid, 1 tile/tick) → `airport.launch()` → raw English `displayIncomingUnit(... "X - airstrike inbound")`. Each tick: move along `flightPath()` (exported; straight line, `steps = ceil(dist/speed)`, positions `round(d*i/steps)`). On arrival: count hostile tiles per owner in radius 12, `removeTroops(airstrikeTroopLoss)`, `displayMessage("events_display.airstrike_hit")`, `setReachedTarget()`, `delete(false)`. Snapshot type `"Airstrike"` v1 `{active, initialized, plane, player, dst, src, step}`. Registered in `ExecutionRegistry.ts`. |
| Tests          | `tests/Airstrike.test.ts` (18 tests), `tests/util/ScriptedGame.ts` `airIntent()` (scheduled airport + `UnitType.Airstrike` intents for the full-game snapshot test) |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Client         | see 1.9                                                                                                                                                             | Hotbar `H`/`J`, preview rings, F-16 sprite col 12 of `unit-atlas.png`, airport icon col 6 of `icon-atlas.png`, diamond structure shape, rearm bar, impact FX via dead-unit path.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |

**Release status:** V1 is _uncommitted_. No shipped save, replay, record or
stats payload contains `Airport`/`Airstrike` data. This matters for §11.

### 1.2 Nukes and silos

- `NukeExecution` builds the nuke unit with `{targetTile, trajectory: TrajectoryTile[]}`.
  Passing `trajectory` makes `UnitImpl` allocate `_nukeState =
{trajectory, trajectoryIndex, targetedBySam, waitTicks}`; this is what SAMs
  read (`trajectory()`, `trajectoryIndex()`, `nukeState().waitTicks`,
  `targetedBySAM()`), and it is already serialized by the unit snapshot
  (`trajectoryTiles`/`trajectoryTargetable` arrays). Each tick the nuke calls
  `setTrajectoryIndex(i)` and `setTargetable(...)`.
- Detonation relinquishes tiles, converts land to water, kills troops with
  compounding `nukeDeathFactor`, and **`unit.delete(true, attacker)` for every
  unit (structures included) within the outer radius** except nukes and SAM
  missiles. Nukes therefore destroy whole structures regardless of level.
- Silo cooldown: `unit.launch()` pushes `ticks` onto `missileTimerQueue`;
  `isInCooldown()` ⇔ `queue.length === level`.

### 1.3 SAMs (`SAMLauncherExecution.ts`, `SAMMissileExecution.ts`)

- `SAMTargetingSystem.getValidTargets` queries
  `nearbyUnits(samTile, maxSamRange()*4, [AtomBomb, HydrogenBomb, MIRVWarhead])`,
  filters out own/friendly/`targetedBySAM` units, and for each unit computes the
  **first trajectory index** where the tile is within `dynamicSamRange` and the
  SAM missile (speed 12, manhattan) can arrive in time. Results are cached per
  unit id. Targets due this tick or next are scored
  (`computeTargetScore`: hydro bonus 70 001, distance bonus ≤ 200 000,
  urgency ≤ 10 000) and fired in score order while the SAM has missiles.
- Launch: `sam.launch()`, `target.setTargetedBySAM(true)`, add
  `SAMMissileExecution(samTile, owner, sam, target, interceptionTile)`.
- The missile flies the air pathfinder to the interception tile; on arrival it
  **always** destroys the target (`target.delete(true, samOwner)`), sends
  `events_display.missile_intercepted` (`MessageType.SAM_HIT`) and
  `stats().bombIntercept`. There is no hit chance today.
- `SAMLauncherExecution` already owns `pseudoRandom = new PseudoRandom(sam.id())`
  (snapshotted) **but never draws from it** — it can be used for a plane
  hit roll without changing existing nuke behavior.
- A fast-path skips all work when no nukes exist (`unitCount(...) === 0`).
- `MessageType.SAM_MISS` exists (warn colour) but nothing emits it.

### 1.4 Structure damage/destruction

- `Unit.delete(displayMessage?, destroyer?)` is the destruction path; when a
  destroyer is passed it records `unitDestroy`/`unitLose` stats for the types
  listed in `UnitImpl.delete`.
- `Unit.decreaseLevel(destroyer?)` **already exists** (`UnitImpl.ts`): it drops
  one level, pops the silo/SAM missile queue, resets SAM upgrade state, and at
  level 0 calls `delete(true, destroyer)`. Nothing in the engine calls it yet;
  tests cover it (`tests/UnitMemoInvalidation.test.ts`,
  `tests/core/executions/SAMLauncherExecution.test.ts`). **V2 reuses it for all
  airstrike structure damage.** No new building-death architecture.
- Non-upgradable structures (Airport, DefensePost) are always level 1, so one
  level of damage destroys them.
- `structureMinDist()` = 15, so a radius-10 disc can contain at most two
  structures and a radius-6 disc at most one.

### 1.5 Nation AI

- `NationExecution` owns one shared `PseudoRandom` and seven behaviors
  (emoji, MIRV, alliance, warship, attack, nuke, structure). On attack ticks
  (`ticks % attackRate === attackTick`) it runs, in order: emoji, embargo
  relations, alliance handling, `mirvBehavior.considerMIRV()`,
  `structureBehavior.handleStructures()`, warships, embargoes,
  `attackBehavior.maybeAttack()`, counter-warship, `nukeBehavior.maybeSendNuke()`.
  It also calls `handleStructures()` at 1/3 and 2/3 of the interval.
- Each behavior snapshots itself as its own versioned record inside
  `NationExecutionSnapshot` (`name: "Nation"`, `version: 1`, schema field
  `behaviors: {emoji, mirv, alliance, warship, attack, nuke, structure}`).
- `NationStructureBehavior`: ratio-per-city table (`getStructureRatios`),
  `buildOrder = [Port, Factory, SAMLauncher, MissileSilo]`, then City;
  perceived-cost inflation to save gold for nukes; `structureSpawnTile`
  samples 25 tiles and scores them with a per-type value function
  (`structureSpawnTileValue` **throws** for unknown types).
- `NationNukeBehavior`: target = `findBestNukeTarget()` (public: retaliation
  → impossible special cases → ally targets → most hated non-weak player →
  FFA crown → strongest team); skips bots, teammates and
  `attackBehavior.shouldAttack(target) === false`; candidate tiles = target
  structures + `randTerritoryTileArray(random, game, target, 10|30)`;
  per-tile value = structure weights (City 25k/level, Silo 50k/level, Port
  15k, Factory 15k, DefensePost 5k) minus distance penalty and recent-target
  penalty; Hard/Impossible reject SAM-interceptable trajectories; perceived
  cost grows after each launch.
- `AiAttackBehavior.findIncomingAttackPlayer()` and `shouldAttack(other)` are
  public and reusable.

### 1.6 Save / snapshot / replay

- Every execution writes `{t: name, v: version, d: data}` via
  `execSnapshotType`; bumping `version` requires `migrations[v]` for every
  older version (`snapshotType` throws at module load otherwise). Restores run
  migrations then zod-validate.
- `EXECUTION_SNAPSHOT_TYPES` must list every execution class
  (`tests/core/snapshot/FullGameSnapshot.test.ts` checks a scripted game
  exercises every registered type).
- `tests/core/snapshot/SnapshotFixtures.test.ts` loads gzipped snapshots
  written by earlier builds (`tests/testdata/snapshots/format-*.snapshot.gz`)
  and steps them 100 ticks — this exercises any migration you add to `Nation`
  or `SAMMissile`.
- Game stats snapshot (`StatsSnapshot`) stores the raw stats tree
  (`z.record(z.string(), z.unknown())`) — new stats fields need no snapshot
  migration.
- **Replays require an exact `gitCommit` match** (`WireSchemas.ts` comment,
  `JoinLobbyModal.checkArchivedGame`). Changing engine behavior never needs to
  stay replay-compatible with older commits; only _parsing_ archived records
  must keep working.

### 1.7 Stats (`packages/engine-api/src/StatsSchemas.ts`, `packages/engine/src/game/StatsImpl.ts`)

- `PlayerStatsSchema` is a zod object; zbin encodes fields in declaration order
  on the live wire (same-build peers only). Archived records travel as JSON and
  are read by `ArchivedPlayerStatsSchema` (lenient preprocess).
- The established compatible-extension pattern (already used for `tiles`,
  `alliances`, `peakTroops`, `donations`, `spawnTile`, `BOAT_INDEX_LOST`,
  `GOLD_INDEX_DONATE_RECV`): **append** a new optional field at the end of the
  object, and **append** new indices to variable-length arrays.
- `units` = `partialRecord(OtherUnitSchema, number[])`, indices
  BUILT/DESTROY/CAPTURE/LOST/UPGRADE. `bombs` = `partialRecord(BombUnitSchema,
number[])`, indices LAUNCH/LAND/INTERCEPT.
- Display: `src/client/components/baseComponents/stats/PlayerStatsTable.ts`
  (`BUILDING_ORDER` and `UNIT_LABEL_KEYS` are compile-checked against
  `otherUnits`), `PlayerStatsTree.ts` (`mergeStatRecord` for `bombs`/`units`),
  `PlayerStatsSummary.ts`. Live leaderboard columns:
  `src/client/StatsConstants.ts` `COLUMN_IDS` + `hud/layers/lib/StatsColumns.ts`.

### 1.8 Localization, audio, FX, events

- 41 locale files in `resources/lang/` (+ `metadata.json`). Non-English files
  are partial (195–2117 keys vs 2347) and fall back to English. Files are
  Crowdin-managed upstream; only `en.json` is sort-checked. Every locale is
  checked for valid ICU (`TranslationSystem.test.ts` "all translation strings
  are valid ICU messages"). French files use the typographic apostrophe `’`.
- Incoming-unit warnings (`Game.displayIncomingUnit(unitID, message, type,
playerID)` → `UnitIncomingUpdate {unitID, message, messageType, playerID}`)
  carry a raw string; `EventsDisplay.onUnitIncomingEvent` shows it verbatim.
  Nuke and V1 airstrike warnings are therefore untranslated English.
- `EventsDisplay.resolveParams` translates `params.unit` when it starts with
  `unit_type.` for `missile_intercepted`/`unit_destroyed`, and rewrites
  `params.name` from `focusPlayerID`.
- Audio: `src/client/sound/Sounds.ts` (`SoundEffect` union, URL map,
  exhaustive `CUE_CATEGORY`), `SoundEffectController` derives cues from game
  updates (launch on unit creation, hit on unit death with `reachedTarget`,
  warning on `UnitIncoming`, throttled). Cues are global and **non-spatial**;
  channels `effects`/`alerts`/`interface`. Assets in `resources/sounds/` are
  CC BY-SA 4.0 (`LICENSE-ASSETS`, attribution "OpenFront") and are reusable by
  DeltaFront. Present but unregistered: `sam-shoot.mp3` (4.9 s),
  `sam-hit.mp3` (2.5 s), `warship-shot.mp3` (1.8 s), `warship-lost.mp3` (6.0 s).
  `ffmpeg` is installed locally (useful for placeholder synthesis).
- FX: `GameView.buildFrameEvents` turns inactive unit updates into
  `FrameEvents.deadUnits` → `Upload.ts` → `MapRenderer/Renderer.applyDeadUnits`
  → `FxPass.spawnUnit` → `FxSpritePass.spawnFxForUnit` (+`FxShockwavePass` for
  nukes/SAMs). Sprite types `FX_*` (atlas rows) with fixed frame timing
  (explosions 4–10 frames × 70 ms ≈ 0.3–0.7 s); looping types (smoke/fire)
  get explicit lifetimes via `pushDebris` (`fx.debrisLifetimeMs` 6000).
  New `GameUpdateType`s must be routed in
  `src/client/replay/codec/FrameNormalizer.ts` `UPDATE_TYPE_ROUTING`
  (compile-enforced); `"misc"` stores the update as-is in replays.
- Telegraphs: `render/frame/derive/NukeTelegraphs.ts` draws a ring at
  `unit.targetTile` for unit types present in `NUKE_MAGNITUDES`
  (`render/types/UnitType.ts`).

### 1.9 Client input / UI

- Ghost flow: hotbar/keybind sets `uiState.ghostStructure`;
  `BuildPreviewController` queries `myPlayer.buildables(tile, [type])` every
  50 ms, builds `GhostPreviewData` (range circle, `rangeWarning`, cost label via
  `WorldTextPass.setGhostCostLabel(... topText)`), confirms on `MouseUpEvent` /
  `ConfirmGhostStructureEvent` (Enter). V1 additions:
  `shouldPreserveGhostAfterBuild(Airstrike) = true`, `rejectAirstrike()` →
  `view.triggerBlockedFlash`.
- `InputHandler`: Escape clears the ghost then emits `CloseViewEvent`; Enter
  with a ghost emits `ConfirmGhostStructureEvent`; build keybinds (digits, `H`,
  `J`) call `setGhostStructure` when `canUseBuildKeybinds()`; right-click
  clears the ghost; **touch taps emit `TouchEvent`, never `MouseUpEvent`**, so
  on touch, ghosts cannot be confirmed — building on mobile goes through the
  radial menu.
- Radial menu (`hud/layers/RadialMenuElements.ts`): the attack ring lists
  `BuildableAttacks` from `flattenedBuildTable`; an item with a non-empty
  `subMenu(params)` opens it on click, otherwise `action(params)` runs;
  disabled items ignore clicks. Buildables at the clicked tile come from
  `params.playerActions.buildableUnits` (computed with `PlayerBuildable.types`).
- `BuildMenu` panel (`build-menu`, Ctrl-click) sends
  `BuildUnitIntentEvent(type, tile)` directly.
- Coverage rings: `SAMRadiusPass` was generalised in V1 with
  `RadiusSource {unitType, range, selfOnly}`; `Renderer` owns a second instance
  for airports (`AIRPORT_RADIUS_TYPES = {"Airport","Airstrike"}`), visible for
  those ghosts and hotbar hovers. Ring stroke/dash are world-unit settings
  (`render-settings.json` `samRadius`: stroke 1.5, dash 12, gap 6).
- `CrosshairPass` shows a crosshair for Warship/MIRV/Airstrike ghosts;
  `RangeCirclePass` draws one circle (white, red when `rangeWarning`).

### 1.10 Timing and scale

- `msPerTick()` = 100 ms → 10 ticks/s.
- Nukes fly 10 tiles/tick (MIRV 15, warhead 22); SAM missiles 12 tiles/tick.
- SAM range `150 − 480/(level+5)`: L1 = 70, L5 = 102, max 150.
- Production World map is 2000×1000 tiles (compact 1000×500); test maps:
  `world` 2000×1000, `big_plains` 200×200, `plains` 100×100.

---

## 2. Design decisions (summary)

| #   | Decision                                                                                                                                                                                                                                        | Why                                                                                                                                                                                                                                                                                                                                              |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| D1  | Split the V1 `Airstrike` unit type into a **selector** (`Airstrike`, never instantiated) and **three strike unit types** (`BombingRun`, `RocketStrike`, `StrafingRun`) that are both the purchasable order _and_ the flying plane unit.         | Costs, `buildables()`, `canBuild`, disabled-unit checks, intents, stats and client visuals all key off `UnitType`. Each strike type gets its own price via `unitCost` with no intent-schema change (`build_unit.unit` is `z.enum(UnitType)`; appended values are wire-safe), and the client knows which strike a plane is from `unitType` alone. |
| D2  | Planes carry a full **trajectory** (`TrajectoryTile[]`, all `targetable: true`) and update `trajectoryIndex` each tick.                                                                                                                         | Lets `SAMTargetingSystem` engage planes with its existing interception math, unchanged, and reuses the unit snapshot's `nukeState` serialization.                                                                                                                                                                                                |
| D3  | SAM shots at planes **can miss**: hit roll at launch from the SAM's existing `PseudoRandom`, per-strike-type hit chance. Nukes stay 100%.                                                                                                       | Guaranteed interception would make airstrikes useless against any SAM coverage. A deterministic roll from already-snapshotted state keeps sync.                                                                                                                                                                                                  |
| D4  | Structure damage = `decreaseLevel(attacker)` (existing). Bombing: −1 level to every hostile structure in the blast. Rocket: −2 levels to the nearest hostile structure. Strafing: −1 level to the first hostile structure under the centerline. | Reuses the existing level/destruction path and its stats; levels make upgraded cities resilient while single-level high-value targets (SAM L1, silo L1, airport, defense post) die.                                                                                                                                                              |
| D5  | One uniform airport **rearm of 200 ticks (20 s)** after any strike type.                                                                                                                                                                        | `missileTimerQueue` stores launch ticks and the client readiness bar assumes one duration per unit type; per-type rearm would need a semantics change to that queue for one unit type. Strike types are differentiated by price, footprint, effect and SAM survivability instead (all fly at the same speed).                                    |
| D6  | Strike-type choice happens **after** the target: a DOM menu (`<airstrike-type-menu>`) for the ghost/hotbar/build-panel flow, and a radial submenu for the right-click/touch flow.                                                               | The radial menu is the only target-first flow that works on touch; the DOM menu gives keyboard and accessibility and a rich description.                                                                                                                                                                                                         |
| D7  | New `GameUpdateType.AirstrikeImpact` emitted by the engine at each damage moment (bomb impact, rocket release, rocket impact, strafing burst). Routed `"misc"` for replays.                                                                     | Rocket impacts happen after the plane is gone, and strafing bursts happen mid-flight; FX and audio need exact, simulation-timed positions without the client re-deriving rules.                                                                                                                                                                  |
| D8  | Shared pure geometry + rules in **engine-lib** (`packages/engine-lib/src/airstrike/`).                                                                                                                                                          | CLAUDE.md: rules used by both engine and client live in engine-lib; guarantees the preview corridor equals the simulated corridor.                                                                                                                                                                                                               |
| D9  | New nation behavior `NationAirBehavior` (strikes) + airport placement inside `NationStructureBehavior`.                                                                                                                                         | Follows the existing behavior split (structures vs. weapons) and snapshot layout.                                                                                                                                                                                                                                                                |
| D10 | Airstrike stats live in a new appended `air` field keyed by strike type; airports join `otherUnits` as `"airp"`.                                                                                                                                | Same extension pattern the stats schema already uses; old archived records stay readable.                                                                                                                                                                                                                                                        |

---

## 3. Balance (exact values)

Tick = 100 ms. "Share" below = `tilesHitOfThatPlayer / tilesOwnedByThatPlayer`.
Troop loss for one application:
`loss = floor(troops × min(capBps, floor(factorBps × hit / max(1, owned))) / 10000)`
(integer basis points; deterministic).

|                             | **Airport**                                                                                           | **Bombing Run**                                                            | **Rocket Strike**                                                                          | **Strafing Run**                                                                                                                 | Atom Bomb (ref)                  |
| --------------------------- | ----------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| Price                       | 1,000,000 first, +500,000 each, max 2,000,000                                                         | **400,000**                                                                | **350,000**                                                                                | **250,000**                                                                                                                      | 750,000                          |
| Range                       | **400 tiles** (euclidean, from airport to target tile)                                                | ←                                                                          | ←                                                                                          | ←                                                                                                                                | silo: map-wide                   |
| Build / rearm               | 100 ticks (10 s) build; **200 ticks (20 s) rearm after any strike**; one strike in flight per airport |                                                                            |                                                                                            |                                                                                                                                  | silo 9 s                         |
| Plane speed                 | —                                                                                                     | **2 tiles/tick** (same F-16 for all three)                                 | **2 tiles/tick** (same aircraft; "fast" = quick weapon delivery)                           | **2 tiles/tick**                                                                                                                 | 10                               |
| Release                     | —                                                                                                     | over the target                                                            | **10 tiles short of the target** (standoff); rockets hit **3 ticks** later                 | flies **through** the target and exits                                                                                           | —                                |
| Area                        | —                                                                                                     | disc **r = 10** (~314 tiles)                                               | disc **r = 4** (~50 tiles)                                                                 | corridor **40 long × 5 wide** (half-width 2), centred on the target along the approach line, split into **4 bursts of 10 tiles** | r 12/30                          |
| Troop damage                | —                                                                                                     | factor **3.0×** share, cap **25 %** per player                             | factor **4.0×** share, cap **10 %**                                                        | per burst factor **3.0×** share, cap **5 %** (≤ ~18.5 % for a player under the whole corridor)                                   | ~75 % for a 10k-tile player      |
| Structure damage            | —                                                                                                     | every hostile structure with tile within **r = 10** loses **1 level**      | nearest hostile structure within **lock radius 6** loses **2 levels**                      | first hostile structure (in flight order) within **1.5 tiles** of the centerline loses **1 level**; max 1 per run                | all structures in r 30 destroyed |
| Land                        | —                                                                                                     | never destroyed                                                            | never destroyed                                                                            | never destroyed                                                                                                                  | destroyed                        |
| SAM hit chance per SAM shot | —                                                                                                     | **65 %**                                                                   | **50 %**                                                                                   | **60 %**                                                                                                                         | 100 % (unchanged)                |
| Telegraph for defender      | —                                                                                                     | ring r = 10 at target                                                      | ring r = 4 at target                                                                       | none (plane + warning)                                                                                                           | ring                             |
| Tactical role               | Strategic enabler; huge radius means usually 1–2 needed                                               | Area denial; clustered troops/structures; softens a front before an attack | Surgical removal of SAMs, silos, airports, defense posts, factories; best survival vs SAMs | Cheap anti-troop line attack along a front; partial damage even if shot down mid-pass                                            | Map-changing                     |

### 3.1 Why these numbers

- **One aircraft speed: 2 tiles/tick for every strike type.** All three
  strikes are flown by the same F-16, so its physical speed never changes.
  V1's 4 tiles/tick crossed a 100-tile strike in 2.5 s. At 2 tiles/tick
  (20 tiles/s) a typical 100–200 tile strike takes 5–10 s, long enough to be
  noticed, telegraphed and reacted to by SAMs (a SAM L1 covers a 140-tile
  chord, i.e. ≥ 3.5 s of exposure for a plane passing near it) while still
  feeling responsive. A deliberate maximum-range (400-tile) strike takes about
  20 s — the price of reach. "Rocket Strike is fast" describes its **weapon
  delivery**, not the aircraft: the rockets are released 10 tiles short of the
  target and land 3 ticks later in a small, precise footprint (r 4), so the
  plane spends ~5 fewer ticks over the target area than a bomber and the
  effect arrives as one sharp hit. Its SAM-survival edge comes from the lower
  hit chance, not from speed.
- **Range 400 (requested ×4).** Coverage area ×16, so the airport price rises
  to silo level (1M) and the cap to 2M. Three airports cover most of a 2000×1000
  map; the escalating price prevents carpeting.
- **Not a nuke.** The bombing run's footprint is ~11 % of an atom bomb's outer
  area (r 10 vs 30), kills at most 25 % of a player's troops, never removes
  land and only strips one level from at most two structures. Against a
  mid-size 5 000-tile player a full-coverage bombing kills `3 × 314/5000 ≈
18.8 %`; against a 20 000-tile player ≈ 4.7 %. An atom bomb kills ~75 % and
  deletes the land. Nukes stay the answer to large players; airstrikes are the
  answer to fronts and to specific structures.
- **Strafing bursts.** Four timed bursts make the line attack readable (four
  puffs travelling with the plane) and give SAMs a meaningful role: a plane
  shot down after two bursts has dealt half its damage.
- **SAM hit chances (per SAM shot): Bombing 65 %, Rocket 50 %, Strafing
  60 %.** Each engagement is an independent roll from that SAM's deterministic
  `PseudoRandom`, so overlapping coverage compounds naturally:

  | Ready SAMs engaging | Bombing survives | Rocket survives | Strafing survives |
  | ------------------- | ---------------- | --------------- | ----------------- |
  | 0                   | 100 %            | 100 %           | 100 %             |
  | 1                   | 35 %             | 50 %            | 40 %              |
  | 2                   | 12.25 %          | 25 %            | 16 %              |
  | 3                   | 4.3 %            | 12.5 %          | 6.4 %             |

  SAMs stay the hard counter to airstrikes, while a single SAM is no longer an
  absolute wall; a rocket aimed at a lone SAM is a coin-flip trade of 350k
  against the SAM. Nuke interception is unchanged (always hits, and no RNG is
  drawn for nukes).

- **Uniform 20 s rearm** (D5). With three airports a player can strike every
  ~7 s at most, for ≥ 750k gold per 20 s.

---

## 4. Data-model changes

### 4.1 `UnitType` (append, in this order, after `Airstrike`)

```ts
// DeltaFront airstrikes V2: Airstrike is now only the selector the player
// picks before choosing a strike type; these three are both the purchasable
// strike and the aircraft unit that flies it. Appended last (wire order).
BombingRun = "Bombing Run",
RocketStrike = "Rocket Strike",
StrafingRun = "Strafing Run",
```

New group (GameTypes.ts, after `BuildableAttacks`):

```ts
export const AirstrikeTypes = unitTypeGroup([
  UnitType.BombingRun,
  UnitType.RocketStrike,
  UnitType.StrafingRun,
] as const);
export type AirstrikeUnitType = (typeof AirstrikeTypes.types)[number];
```

`PlayerBuildable = unitTypeGroup([...BuildMenus.types, UnitType.TransportShip, ...AirstrikeTypes.types] as const)`.
`BuildableAttacks` keeps `Airstrike` (selector) and does **not** get the three
types (they must not appear as separate radial/hotbar items).

### 4.2 `MessageType` (append after `AIRSTRIKE_HIT`)

`AIRSTRIKE_RESULT` (attacker feedback; `MessageCategory.ATTACK`).
Existing ones reused: `AIRSTRIKE_INBOUND`, `AIRSTRIKE_HIT`, `SAM_HIT`,
`SAM_MISS`, `UNIT_DESTROYED` (attacker lost a plane).

### 4.3 `GameUpdateType` (append after `DonateEvent`)

```ts
AirstrikeImpact,
```

```ts
export enum AirstrikeImpactPhase {
  BombImpact = 0,
  RocketRelease = 1,
  RocketImpact = 2,
  StrafeBurst = 3,
}
export interface AirstrikeImpactUpdate {
  type: GameUpdateType.AirstrikeImpact;
  strikeType: UnitType; // one of AirstrikeTypes
  attackerID: number; // smallID
  phase: AirstrikeImpactPhase;
  from: TileRef; // release point / burst segment start / impact centre
  to: TileRef; // impact centre / burst segment end
  radius: number; // blast radius, or corridor half-width
  affected: number[]; // smallIDs of players that lost troops or structure levels
}
```

Add it to the `GameUpdate` union.

### 4.4 `UnitIncomingUpdate` (+optional field)

`params?: Record<string, string | number>` — and `Game.displayIncomingUnit(unitID, message, type, playerID, params?)`.

### 4.5 `UnitParamsMap` (`packages/engine/src/game/Game.ts`)

```ts
[UnitType.Airstrike]: Record<string, never>;          // selector, never built
[UnitType.BombingRun]: { targetTile?: number; trajectory: TrajectoryTile[] };
[UnitType.RocketStrike]: { targetTile?: number; trajectory: TrajectoryTile[] };
[UnitType.StrafingRun]: { targetTile?: number; trajectory: TrajectoryTile[] };
```

### 4.6 Rules config (`packages/engine-lib/src/configuration/Config.ts`)

Remove V1 `airstrikeRadius()`. Add module-level exports
`export const AIRPORT_RANGE_TILES = 400;` and
`export const AIRPORT_REARM_TICKS = 200;` and make `airportRange()` return
`AIRPORT_RANGE_TILES` and `AirportCooldown()` return `AIRPORT_REARM_TICKS`
(the Help modal lives outside a game and has no `Config` instance, so it reads
these constants; everything in-game keeps calling the methods). Add:

```ts
export interface AirstrikeSpec {
  radius: number;           // bomb/rocket troop radius; strafing corridor half-width
  troopFactorBps: number;
  troopCapBps: number;      // per application (per burst for strafing)
  structureRadius: number;  // bomb: blast; rocket: lock radius; strafing: centerline tolerance
  structureLevels: number;  // levels removed per affected structure
  maxStructures: number;    // bomb: Number.MAX_SAFE_INTEGER; rocket 1; strafing 1
  samHitPercent: number;
  standoff: number;         // rocket only (else 0)
  rocketFlightTicks: number;// rocket only (else 0)
  corridorLength: number;   // strafing only (else 0)
  corridorBursts: number;   // strafing only (else 0)
  exitTail: number;         // strafing only (else 0)
  telegraphRadius: number;  // 0 = no telegraph ring
}
airstrikeSpec(type: UnitType): AirstrikeSpec  // throws for non-AirstrikeTypes
```

Values (verbatim from §3):

| field             | BombingRun       | RocketStrike | StrafingRun |
| ----------------- | ---------------- | ------------ | ----------- |
| radius            | 10               | 4            | 2           |
| troopFactorBps    | 30000            | 40000        | 30000       |
| troopCapBps       | 2500             | 1000         | 500         |
| structureRadius   | 10               | 6            | 1.5         |
| structureLevels   | 1                | 2            | 1           |
| maxStructures     | MAX_SAFE_INTEGER | 1            | 1           |
| samHitPercent     | 65               | 50           | 60          |
| standoff          | 0                | 10           | 0           |
| rocketFlightTicks | 0                | 3            | 0           |
| corridorLength    | 0                | 0            | 40          |
| corridorBursts    | 0                | 0            | 4           |
| exitTail          | 0                | 0            | 8           |
| telegraphRadius   | 10               | 4            | 0           |

Aircraft speed is **not** part of the per-type spec: add
`export const AIRSTRIKE_PLANE_SPEED = 2;` (tiles per tick) next to the airport
constants and `airstrikePlaneSpeed(): number { return AIRSTRIKE_PLANE_SPEED; }`.
Every flight-path, corridor-burst, AI and client calculation uses this one
value for all three strike types.

`unitInfo`: add `BombingRun`, `RocketStrike`, `StrafingRun` to the `info = {}`
group. `isUnitDisabled(type)`: also return `true` for any `AirstrikeTypes`
member when `disabledUnits` contains `UnitType.Airstrike` (family toggle).

### 4.7 Costs (`packages/engine/src/configuration/EngineConfig.ts` `unitCost`)

- `Airport`: `costWrapper((n) => Math.min(2_000_000, 1_000_000 + n * 500_000), UnitType.Airport)`.
- `BombingRun` 400k, `RocketStrike` 350k, `StrafingRun` 250k, each
  `costWrapper(() => X, type)`.
- `Airstrike` (selector): a function returning the **minimum** of
  `unitInfo(t).cost(game, player)` over `AirstrikeTypes.types` that are not
  disabled (returns the BombingRun cost if all are disabled). This makes every
  existing UI (hotbar affordability, radial tooltip "cost") show "the cheapest
  strike you could buy".
- Remove V1 `airstrikeSpeed()` and `airstrikeTroopLoss()` from EngineConfig
  (replaced by engine-lib functions, §4.8).

### 4.8 New engine-lib modules (`packages/engine-lib/src/airstrike/`)

`AirstrikeGeometry.ts` (imports only engine-api `GameMap`, `TileRef`):

```ts
export function straightPath(map, src, dst, speed): TileRef[]; // V1 flightPath, moved here verbatim
export function airstrikeEndPoint(map, src, dst, type, spec): TileRef; // bomb: dst; rocket: standoff point (src if D ≤ standoff); strafe: exit point clipped to map
export function airstrikeFlightPath(
  map,
  src,
  dst,
  type,
  spec,
  speed,
): TileRef[]; // straightPath(src → endPoint), excludes src, may be []
export interface Corridor {
  sx: number;
  sy: number;
  ux: number;
  uy: number; // origin + unit direction (floats)
  sStart: number;
  sEnd: number;
  halfWidth: number;
  bursts: number;
}
export function strafingCorridor(map, src, dst, spec): Corridor; // along-track window [D − L/2, D + L/2] clamped to ≥ 0
export function corridorBurstTiles(map, c: Corridor, burst: number): TileRef[]; // tiles of segment `burst`, scan order y then x
export function corridorTiles(map, c): TileRef[]; // all segments (preview + AI)
export function alongTrack(map, c, tile): number; // projection distance
export function burstTriggerSteps(map, path, c): number[]; // for each burst k: first path index whose alongTrack ≥ segment end (else last index)
export function discTiles(map, center, radius): TileRef[]; // scan order y then x, clamped to map
```

Corridor membership of tile (x,y): `px = x − sx, py = y − sy`,
`s = px·ux + py·uy`, `perp = |px·uy − py·ux|`; inside segment k iff
`segStart(k) ≤ s < segEnd(k)` (last segment inclusive of `sEnd`) and
`perp ≤ halfWidth`. `segStart(k) = sStart + k·(sEnd−sStart)/bursts`. Direction
`(ux,uy) = (dx,dy)/sqrt(dx²+dy²)` with `dx,dy = dst − src`; if `src === dst`
use `(0,−1)`. Scan the integer bounding box of the corridor rectangle.
All of this is IEEE-deterministic (only `+ − × ÷ sqrt round floor ceil`).

`AirstrikeRules.ts`:

```ts
export type AirstrikeBlockReason =
  | "disabled"
  | "spawn_immunity"
  | "invalid_terrain"
  | "not_hostile"
  | "no_airport"
  | "airport_building"
  | "airport_rearming"
  | "out_of_range"
  | "not_enough_gold";
export interface AirportInfo {
  tile: TileRef;
  active: boolean;
  underConstruction: boolean;
  inCooldown: boolean;
}
/** Nearest usable airport for a target, or the reason none is usable. */
export function pickAirstrikeAirport(
  map: GameMap,
  target: TileRef,
  airports: readonly AirportInfo[],
  range: number,
):
  | { airport: TileRef; reason: null }
  | { airport: null; reason: AirstrikeBlockReason };
export function airstrikeTroopLoss(
  spec: AirstrikeSpec,
  troops: number,
  hit: number,
  owned: number,
): number;
```

`pickAirstrikeAirport` order of checks: no active airports → `no_airport`;
let `inRange = active airports with dist² ≤ range²`; none → `out_of_range`;
`ready = inRange.filter(!underConstruction && !inCooldown)`; if non-empty
return the one with the smallest dist² (ties: lower array index); else if every
in-range airport is under construction → `airport_building`, else
`airport_rearming`.

### 4.9 Stats schema (`packages/engine-api/src/StatsSchemas.ts`)

- `otherUnits`: append `"airp"`; `OtherUnitType` adds `UnitType.Airport`;
  `unitTypeToOtherUnit[Airport] = "airp"`.
- New, **appended at the end of `PlayerStatsSchema`'s shape** (after `spawnTile`):

```ts
// Appended (zbin field order). Keyed by strike type.
air: z.partialRecord(AirUnitSchema, AtLeastOneNumberSchema).optional(),
```

```ts
export const airUnits = ["bomb", "rckt", "strf"] as const;
export const AirUnitSchema = z.enum(airUnits);
export type AirUnit = z.infer<typeof AirUnitSchema>;
export const unitTypeToAirUnit = {
  [UnitType.BombingRun]: "bomb",
  [UnitType.RocketStrike]: "rckt",
  [UnitType.StrafingRun]: "strf",
} as const satisfies Record<AirstrikeUnitType, AirUnit>;
export const AIR_INDEX_LAUNCH = 0; // strikes launched
export const AIR_INDEX_COMPLETE = 1; // strikes that delivered their (full) attack
export const AIR_INDEX_SHOT_DOWN = 2; // own aircraft lost (SAM, nuke, owner change)
export const AIR_INDEX_INTERCEPT = 3; // enemy aircraft this player's SAMs shot down (credited to SAM owner)
export const AIR_INDEX_TROOPS_KILLED = 4; // troops (internal units) killed
export const AIR_INDEX_LEVELS_DESTROYED = 5; // structure levels removed
export const AIR_INDEX_STRUCTURES_DESTROYED = 6; // structures that reached level 0
```

(`AirstrikeUnitType` must be importable here; `StatsSchemas.ts` already imports
`UnitType` from `./game/GameTypes`.)

### 4.10 Client state (`src/client/UIState.ts`)

```ts
airstrikeTarget: TileRef | null; // non-null ⇔ strike-type menu open
airstrikeType: AirstrikeUnitType; // selected / last used; default BombingRun
```

Initialise in `hud/GameRenderer.ts` (`airstrikeTarget: null, airstrikeType: UnitType.BombingRun`).

---

## 5. Simulation flow per strike

`AirstrikeExecution` is rewritten (same file, same snapshot name `"Airstrike"`).

### 5.1 State

```ts
private active = true;
private mg: Game;
private phase: "pending" | "flying" | "rockets" | "done" = "pending";
private plane: Unit | null = null;
private src: TileRef | null = null;      // launching airport tile
private step = 0;                        // index into path of the next tile
private burstsApplied = 0;               // strafing
private impactTick: number | null = null;// rocket
private totals: Array<[smallID: number, killed: number, levels: number]> = []; // per damaged player, insertion order
// derived (not snapshotted; recomputed from src, dst, strikeType, config):
private path: TileRef[]; private corridor: Corridor | null; private burstSteps: number[];
constructor(private player: Player, private dst: TileRef, private strikeType: AirstrikeUnitType) {}
```

### 5.2 Launch (first tick, `phase === "pending"`)

1. `spawn = player.canBuild(strikeType, dst)`. If `false` → `active = false`
   (no message; client already gave feedback; mirrors NukeExecution).
2. `src = spawn`; `spec = config.airstrikeSpec(strikeType)`;
   `path = airstrikeFlightPath(mg, src, dst, strikeType, spec, config.airstrikePlaneSpeed())`; for strafing
   `corridor = strafingCorridor(...)`, `burstSteps = burstTriggerSteps(...)`.
3. `trajectory = path.map((tile) => ({ tile, targetable: true }))`.
4. `plane = player.buildUnit(strikeType, src, { targetTile: dst, trajectory })`
   — this charges the strike cost and records construction.
5. `mg.recordMotionPlan({ kind: "grid", unitId: plane.id(), planId: 1, startTick: ticks + 1, ticksPerStep: 1, path: [src, ...path] })`.
6. Airport: `player.units(Airport).find(a => a.tile() === src)?.launch()`.
7. Stats: `mg.stats().airLaunch(player, strikeType)`.
8. Warnings — `displayIncomingUnit(plane.id(), "events_display.airstrike_inbound", MessageType.AIRSTRIKE_INBOUND, victimId, { name: player.displayName(), unit: unitTypeKey(strikeType) })` for:
   bombing/rocket → owner of `dst` if a non-friendly player; strafing → every
   distinct non-friendly player owning ≥ 1 corridor tile (scan order).
9. `phase = "flying"`; return. (If `path.length === 0` — rocket fired from an
   airport within 10 tiles of the target — the next tick goes straight to the
   "arrived" branch of §5.3 step 6 and releases.)

### 5.3 Every later tick

1. If `phase === "rockets"`: if `mg.ticks() >= impactTick` → rocket impact
   (§5.5) → finish. Return.
2. If `!plane.isActive()` → **shot down / destroyed** (§5.7). Return.
3. If `plane.owner() !== player` (captured on owner elimination) →
   `plane.delete(false)`, treat as shot down without intercept credit. Return.
4. If `step < path.length`: `plane.move(path[step])`,
   `plane.setTrajectoryIndex(step)`, `step++`.
5. Strafing: while `burstsApplied < bursts && step - 1 >= burstSteps[burstsApplied]`
   → apply burst `burstsApplied` (§5.6), `burstsApplied++`.
6. If `step >= path.length` (arrived at end point):
   - Bombing → impact (§5.4) at `dst`, `plane.setReachedTarget()`,
     `plane.delete(false)`, finish.
   - Rocket → emit `AirstrikeImpact{phase: RocketRelease, from: planeTile, to: dst}`,
     `plane.setReachedTarget()`, `plane.delete(false)`,
     `impactTick = mg.ticks() + spec.rocketFlightTicks`, `phase = "rockets"`.
   - Strafing → apply any remaining bursts (path clipped at the map edge),
     `plane.setReachedTarget()`, `plane.delete(false)`, finish.
     "Finish" = flush messages + stats (§5.8), `active = false`.

### 5.4 Bombing impact

- `hostile(owner) := isAirstrikeVictim(player, owner)` (§9.1), evaluated
  **now** (alliances formed mid-flight spare the new ally).
- Troops: count hostile tiles per owner in `discTiles(dst, spec.radius)` (scan
  order → `Map` insertion order); for each: `killed = airstrikeTroopLoss(spec,
owner.troops(), hit, owner.numTilesOwned())`, `owner.removeTroops(killed)`,
  `owner.updateRelation(player, -50)`, accumulate totals.
- Structures: `mg.nearbyUnits(dst, spec.structureRadius, Structures.types)`,
  **filter to `isAirstrikeVictim(player, unit.owner())` first**, then **sort by
  `(distSquared, unit.id())`**, then take up to `spec.maxStructures` (own and
  allied structures never consume a slot, so a rocket aimed next to your own
  city still hits the nearest _enemy_ structure — or nothing), for each: `levelsRemoved = min(spec.structureLevels,
unit.level())`; call `unit.decreaseLevel(player)` that many times (stop when
  inactive); accumulate levels + destroyed.
- Emit `AirstrikeImpact{phase: BombImpact, from: dst, to: dst, radius, affected}`.

### 5.5 Rocket impact

Same as bombing with `spec` of `RocketStrike` (radius 4, factor 4.0×, cap 10 %),
but structures = the single nearest hostile structure within
`structureRadius = 6`, −2 levels. Emit `{phase: RocketImpact, from: releaseTile, to: dst}`
(store `releaseTile` in state: snapshot field `releaseTile: zTile().nullable()`).
If the plane was destroyed before release there are no rockets.

### 5.6 Strafing burst k

- Tiles: `corridorBurstTiles(mg, corridor, k)`; hostile tiles per owner →
  troop loss with the strafing spec (cap 5 % per burst).
- Structures: only while no strafing structure hit has happened yet in this
  run: among hostile structures whose tile lies in segment k's along-track
  window and `perp ≤ 1.5`, take the one with the smallest `alongTrack` (ties:
  lower id) → `decreaseLevel(player)` once.
- Emit `{phase: StrafeBurst, from: segStartTile, to: segEndTile, radius: halfWidth, affected}`
  where the segment tiles are the rounded corridor centerline points.
- Partial progress counts: bursts already applied stay applied if the plane is
  later shot down.

### 5.7 Shot down / destroyed

`plane` inactive and `phase === "flying"` →

- `stats.airShotDown(player, strikeType)`;
- message to attacker: `displayMessage("events_display.aircraft_shot_down", MessageType.UNIT_DESTROYED, player.id(), undefined, { unit: unitTypeKey(strikeType) })`;
- flush accumulated strafing totals (§5.8) — partial damage is reported;
- `active = false`. (SAM-side credit and messages are in §7.)

### 5.7a Airport destroyed or captured while its aircraft is airborne

- The aircraft **continues its mission** unchanged: `AirstrikeExecution` only
  stores the airport's _tile_ (`src`) for path math and never re-reads the
  airport unit after launch, so nothing in §5.3 checks the airport.
- Destroying (or capturing) the airport **does not destroy the plane**. The
  plane is a separate unit; nukes only remove it if it is inside their blast
  (§7 step 7), and a SAM only if it intercepts it.
- Future launches from that airport are impossible: a destroyed airport is
  inactive and drops out of `player.units(Airport)`, so `pickAirstrikeAirport`
  never returns it; a captured airport now belongs to the captor (its rearm
  queue goes with it).
- No refund (see 5.7b) and no extra message.
- Test (`AirstrikeTargeting` or `AirstrikeBombing`): launch, then
  `airport.delete(true, enemy)` on the next tick → the plane keeps moving, the
  strike lands with full effect, `canBuild(<any strike>, target)` is `false`
  afterwards (`no_airport` reason) until another airport exists.

### 5.7b Cost and rearm when the aircraft is intercepted

- The strike's price is charged **once, at launch** (`buildUnit` in §5.2
  step 4) and is **never refunded** — not when shot down by a SAM, not when
  destroyed by a nuke, not when removed because the attacker was eliminated,
  and not when a rocket strike is shot down before releasing.
- The airport enters its **normal 200-tick rearm** at launch (§5.2 step 6,
  `airport.launch()`); interception does not shorten, reset or cancel it.
- Stats still count the launch (`airLaunch`) plus `airShotDown`; `airComplete`
  is not incremented.
- Test (`AirstrikeSam`): with a forced 100 % hit, the attacker's gold after the
  interception equals gold right after launch (no refund, ignoring per-tick
  income — compare against an identical run with no SAM), and
  `airport.isInCooldown()` stays true until exactly 200 ticks after launch.

### 5.8 Messages + stats at finish

For each `[smallID, killed, levels]` in `totals` (insertion order):

- victim: `displayMessage("events_display.airstrike_hit", AIRSTRIKE_HIT, victim.id(), undefined, { name: player.displayName(), unit: unitTypeKey(t), troops: renderTroops(killed) }, undefined, player.id())`;
  if `levels > 0` also `"events_display.airstrike_buildings_hit"` with `{name, unit, count: levels}`.
- attacker: one `"events_display.airstrike_result"` (`AIRSTRIKE_RESULT`) with
  `{ unit, troops: renderTroops(sumKilled), count: sumLevels }`.
- stats: `airTroopsKilled(player, t, sumKilled)`, `airStructureDamage(player, t, sumLevels, sumDestroyed)`,
  and `airComplete(player, t)` only when the strike delivered fully (bomb
  impact, rocket impact, or strafing reached the exit).

`unitTypeKey(t)`: `BombingRun → "unit_type.bombing_run"`, `RocketStrike →
"unit_type.rocket_strike"`, `StrafingRun → "unit_type.strafing_run"`.

### 5.9 Snapshot (§11.2 for versioning)

```ts
const AirstrikeStateSchema = z.object({
  active: z.boolean(),
  initialized: z.boolean(),
  phase: z.enum(["pending", "flying", "rockets", "done"]),
  plane: zRef().nullable(),
  player: zPlayerRef(),
  strikeType: UnitTypeSchema,
  dst: zTile(),
  src: zTile().nullable(),
  step: zInt(),
  burstsApplied: zInt(),
  impactTick: zInt().nullable(),
  releaseTile: zTile().nullable(),
  totals: z.array(z.tuple([zInt(), zNum(), zInt()])),
  destroyed: zInt(),
});
```

`restoreSnapshot` recomputes `path`, `corridor`, `burstSteps` from
`src/dst/strikeType/r.game.config()` when `src !== null`.

---

## 6. Attack-menu state flow (client only; nothing here is simulated)

```
IDLE ──J / hotbar / build-panel──▶ TARGETING (ghost = Airstrike)
TARGETING ──hover──▶ preview: selected type's shape at cursor (white | red + reason label)
TARGETING ──click invalid──▶ blocked X flash + reason label, stay TARGETING
TARGETING ──click valid (canBuild(Airstrike) ≠ false)──▶ MENU(tile)
MENU ──↑/↓/1–3/wheel/click option──▶ MENU (selection changes, preview shape updates, still locked to tile)
MENU ──Launch / Enter / double-click option──▶ final check
        final check ok  ──▶ emit BuildUnitIntentEvent(type, tile); remember type ──▶ TARGETING
        final check fail──▶ blocked X flash, reason shown, stay MENU (Launch disabled)
MENU ──Esc / ✕ / Cancel / click outside / right-click / map click──▶ TARGETING
any state ──ghost cleared or changed, player dead, game over, spawn phase──▶ IDLE (menu closed, target cleared)
Radial: right-click tile ▶ attack ring ▶ Airstrike ▶ 3 strike items ▶ click = intent (no DOM menu)
```

Invariants:

- `uiState.airstrikeTarget !== null` ⇔ the menu is open. Every close path calls
  one function, `closeAirstrikeMenu(reason)`, that sets it to `null`, unlocks
  the preview, and restores focus to the canvas. No path can leave
  `airstrikeTarget` set without the element visible (self-heal: the menu's
  `tick()` closes itself if `uiState.ghostStructure !== Airstrike`).
- While the menu is open: build keybinds, Enter→ConfirmGhost, and map clicks are
  inert (see §15 step C-7); the camera can still be dragged.
- The intent is emitted at most once per open (a `launching` flag, reset only
  when the menu closes).

---

## 7. SAM interception flow

1. `SAMLauncherExecution.tick`: replace the three-type fast path with
   `SAM_TARGET_TYPES = [AtomBomb, HydrogenBomb, MIRVWarhead, ...AirstrikeTypes.types]`
   (all counts zero → return).
2. `SAMTargetingSystem.getValidTargets`: query `SAM_TARGET_TYPES`. Planes have
   `nukeState`, all-`targetable` trajectories and `waitTicks = 0`, so
   `computeInterceptionTile` / `checkDetonationInterception` work unchanged.
3. `computeTargetScore`: `typeBonus = AirstrikeTypes.has(type) ? -150_000 : (hydro ? 70_001 : 0)`
   — nukes are preferred whenever both are due.
4. On launch, before `addExecution`:
   ```ts
   const willHit = AirstrikeTypes.has(target.unit.type())
     ? this.pseudoRandom!.nextInt(0, 100) <
       this.mg.config().airstrikeSpec(target.unit.type()).samHitPercent
     : true;
   ```
   (Draw only for planes — nuke behavior and its RNG sequence are unchanged.)
   Pass `willHit` to `SAMMissileExecution` (new last constructor parameter,
   default `true`).
5. `SAMMissileExecution`:
   - whitelist = `[AtomBomb, HydrogenBomb, MIRVWarhead, ...AirstrikeTypes.types]`;
   - on `COMPLETE`:
     - `willHit` → existing path; for planes additionally
       `stats().airIntercept(owner, type)` instead of `bombIntercept`, and the
       message `events_display.missile_intercepted` with
       `unit: unitTypeKey(type)` (add the three keys to
       `INTERCEPTED_UNIT_TRANSLATION_KEYS`); `target.delete(true, owner)`.
     - `!willHit` → `displayMessage("events_display.sam_missed", MessageType.SAM_MISS, owner.id(), undefined, { unit })`,
       `target.setTargetedBySAM(false)` (another SAM, or this one after reload,
       may engage), `missile.delete(false)`, `active = false`.
   - snapshot: add `willHit: z.boolean()`; version 2, migration
     `1: (d) => ({ ...d, willHit: true })`.
6. Multiple SAMs: one missile per plane at a time (`targetedBySAM`); after a
   miss others can fire in the same or later ticks while the plane is in range.
7. Nuke detonations delete planes in their outer radius (existing loop) —
   handled as "destroyed" by §5.7; no intercept credit.
8. Rockets after release are not interceptable (V2 scope; listed in §18).

---

## 8. AI decision flow

### 8.1 Airport building (`NationStructureBehavior`)

- `getStructureRatios(difficulty)` add
  `[UnitType.Airport]: { ratioPerCity: AIRPORT_RATIO_BY_DIFFICULTY[difficulty], perceivedCostIncreasePerOwned: 1 }`
  with `AIRPORT_RATIO_BY_DIFFICULTY = { Easy: 0, Medium: 0.1, Hard: 0.15, Impossible: 0.2 }`.
- `MAX_AIRPORTS_BY_DIFFICULTY = { Easy: 0, Medium: 1, Hard: 2, Impossible: 3 }`;
  in `shouldBuildStructure`: `owned >= MAX → false`.
- `buildOrder` = `[Port, Factory, SAMLauncher, MissileSilo, Airport]`; skip
  Airport when `isUnitDisabled(Airport)` or `isUnitDisabled(Airstrike)`.
- `structureSpawnTileValue(Airport)` → new `airportValue()`:
  ```
  hostile = all units of Structures.types owned by players p with
            p !== me && !me.isFriendly(p) && p.type() !== Bot      (computed once per call)
  value(tile):
    covered = Σ over hostile within airportRange of tile: STRUCTURE_LEVEL_GOLD_VALUE[type] × level / 100_000
    if covered === 0 → return 0
    w = covered × 10
    w += min(nearestTileDistCapped(borderTiles, tile, borderSpacing), borderSpacing)  // safety, like silos
    if any own airport within airportRange × 0.5 → w *= 0.25                          // anti-stacking
    return w
  ```
  and in `structureSpawnTile`, for `Airport` only, return `null` when the best
  value is `≤ 0` (never build an airport that covers nothing).
- Second+ airport: also require, in `shouldBuildStructure`, that at least 3
  hostile structures lie outside every existing own airport's range (cheap
  O(hostile × airports) dist² check). This is the "avoid useless stacking" rule.

### 8.2 Strikes (`NationAirBehavior`, new file `packages/engine/src/execution/nation/NationAirBehavior.ts`)

Constants (top of file, exported for tests):

```ts
export const AIR_MIN_GAP_TICKS: Record<Difficulty, number> = {
  Easy: Number.MAX_SAFE_INTEGER,
  Medium: 900,
  Hard: 450,
  Impossible: 250,
};
export const AIR_GOLD_MULTIPLIER: Record<Difficulty, number> = {
  Easy: Infinity,
  Medium: 4,
  Hard: 3,
  Impossible: 2,
};
export const AIR_RETALIATION_GOLD_MULTIPLIER = 1.5; // Hard/Impossible when target is the incoming attacker
export const AIR_MIN_EFFICIENCY = 1.2; // value × survival / cost
export const AIR_MIN_SURVIVAL: Record<Difficulty, number> = {
  Easy: 1,
  Medium: 0,
  Hard: 0.6,
  Impossible: 0.4,
};
export const AIR_TROOP_GOLD_VALUE = 1; // gold per internal troop unit killed
export const STRUCTURE_LEVEL_GOLD_VALUE: Partial<Record<UnitType, number>> = {
  MissileSilo: 600_000,
  SAMLauncher: 600_000,
  Airport: 700_000,
  Factory: 300_000,
  Port: 250_000,
  City: 250_000,
  DefensePost: 100_000,
};
export const AIR_DESTROY_BONUS = 1.5; // multiplier when a structure would reach level 0
export const AIR_STRAFE_FRONT_BONUS = 1.5;
export const AIR_RECENT_MEMORY_TICKS = 600;
export const AIR_RECENT_RADIUS = 15;
export const AIR_RANDOM_CANDIDATES: Record<Difficulty, number> = {
  Easy: 0,
  Medium: 8,
  Hard: 12,
  Impossible: 24,
};
```

`maybeLaunchAirstrike()` (called from `NationExecution.tick` right after
`nukeBehavior.maybeSendNuke()`):

1. Return if Easy, or Airport/Airstrike disabled, or no airport, or no armed
   airport (`active && !underConstruction && !isInCooldown`), or
   `ticks − lastStrikeTick < AIR_MIN_GAP_TICKS[d]`.
2. `target = attackBehavior.findIncomingAttackPlayer() ?? nukeBehavior.findBestNukeTarget()`;
   `retaliation = target came from findIncomingAttackPlayer`. Return if null,
   bot, friendly, same team, or `attackBehavior.shouldAttack(target) === false`.
3. Gold gate per type: `gold ≥ cost(t) × (retaliation && d ≥ Hard ? 1.5 : AIR_GOLD_MULTIPLIER[d])`.
   No affordable enabled type → return.
4. Candidates (deterministic order, deduplicated with a `Set`):
   target's structures (`target.units(Structures.types)` tiles) →
   `randTerritoryTileArray(random, game, target, AIR_RANDOM_CANDIDATES[d])` →
   if retaliation: up to 10 of `target.borderTiles()` that neighbour our
   territory (first 10 in iteration order). Filter: `player.canBuild(UnitType.Airstrike, c) !== false`
   (the selector: same target/airport validity as every strike type, gold
   checked against the _cheapest_ type — filtering with `BombingRun` would drop
   every candidate for a nation that can only afford a strafing run) and not within `AIR_RECENT_RADIUS` of
   a strike in `recentStrikes` (pruned to `AIR_RECENT_MEMORY_TICKS`).
5. For each candidate `c` and each enabled, affordable type `t`:
   `src = player.canBuild(t, c)`; `value = estimateValue(t, src, c)`;
   `survival = d ≥ Hard ? estimateSurvival(t, src, c) : 1`;
   skip if `survival < AIR_MIN_SURVIVAL[d]`;
   `eff = value × survival / Number(cost(t))`. Keep the best (strictly greater
   wins → first max in candidate order, type order Bombing, Rocket, Strafing).
6. If `best.eff ≥ AIR_MIN_EFFICIENCY`: `game.addExecution(new ConstructionExecution(player, best.t, best.c))`,
   `lastStrikeTick = ticks`, push `[ticks, c]` to `recentStrikes`,
   `strikesLaunched++`, `emojiBehavior.maybeSendEmoji(target, EMOJI_NUKE)`
   only when retaliation (reuse existing emoji constant).

`estimateValue(t, src, c)` (pure reads, no mutation):

- Bombing: troop value = Σ hostile owners over `discTiles(c, 10)`:
  `airstrikeTroopLoss(spec, owner.troops(), hit, owned) × AIR_TROOP_GOLD_VALUE`;
  structure value = Σ hostile structures within 10:
  `STRUCTURE_LEVEL_GOLD_VALUE[type] × (level === 1 ? AIR_DESTROY_BONUS : 1)`.
- Rocket: troop value over `discTiles(c, 4)`; structure = nearest hostile
  within 6: `value × min(2, level) × (level ≤ 2 ? AIR_DESTROY_BONUS : 1)`.
- Strafing: `corridor = strafingCorridor(src, c)`; troop value = Σ over bursts
  of per-burst losses (use current troops for every burst — slight
  over-estimate, fine); + first centerline structure × 1 level; ×
  `AIR_STRAFE_FRONT_BONUS` if retaliation and any corridor tile neighbours our
  territory.
  `estimateSurvival(t, src, c)`: path = `airstrikeFlightPath(...)`; for each enemy
  SAM (`!player.isFriendly(owner)`, active, not under construction, not in
  cooldown): if any path tile (check every 4th tile and the last) is within
  `samRange(level)` → `survival *= 1 − samHitPercent(t)/100`.

Snapshot: `NationAirBehaviorSnapshot = snapshotType({ name: "NationAirBehavior", version: 1, schema: z.object({ lastStrikeTick: zInt().nullable(), recentStrikes: z.array(z.tuple([zInt(), zTile()])), strikesLaunched: zInt() }) })`.
Uses the nation's shared `random` (same as every other behavior).

Expected emergent behavior (verified by tests, §16): Rocket vs lone SAM / silo
/ airport; Bombing vs dense troop fronts or two clustered structures; Strafing
when retaliating along a long shared border; nothing when broke, on Easy, when
rearming, or when SAM coverage makes survival too low (Hard), with Impossible
still trying rockets into single-SAM coverage.

---

## 9. Building-damage rules (authoritative)

|                         | Bombing Run                                                                                                                                        | Rocket Strike                                            | Strafing Run                                                                                                   |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Which structures        | every hostile structure whose tile is within euclidean 10 of the target                                                                            | the single hostile structure nearest the target within 6 | the first hostile structure along the flight direction within 1.5 tiles of the centerline, inside the corridor |
| Damage                  | −1 level each                                                                                                                                      | −2 levels                                                | −1 level                                                                                                       |
| Max structures          | unlimited (≤ 2 in practice)                                                                                                                        | 1                                                        | 1 per run                                                                                                      |
| Ordering                | `(distSquared, id)`                                                                                                                                | `(distSquared, id)`                                      | `(alongTrack, id)`                                                                                             |
| Under construction      | yes (level 1 → destroyed; construction stops)                                                                                                      | yes                                                      | yes                                                                                                            |
| Allied / teammate / own | never                                                                                                                                              | never                                                    | never                                                                                                          |
| Hostility evaluated     | at impact tick                                                                                                                                     | at impact tick                                           | at each burst tick                                                                                             |
| Path                    | `Unit.decreaseLevel(attacker)` → at level 0 `delete(true, attacker)` (stats `unitDestroy`/`unitLose`, railroad cleanup via the normal delete path) | ←                                                        | ←                                                                                                              |
| Land                    | untouched                                                                                                                                          | untouched                                                | untouched                                                                                                      |
| Units (ships, trains)   | untouched in V2                                                                                                                                    | untouched                                                | untouched                                                                                                      |

"Structure" = `Structures.types` (City, Port, Factory, DefensePost, SAMLauncher,
MissileSilo, Airport).

### 9.1 Own and allied buildings are never damaged

One predicate, in `packages/engine/src/execution/airstrike/AirstrikeDamage.ts`,
gates **every** troop and structure effect of every strike type:

```ts
/** Whether an airstrike by `attacker` may hurt `owner` right now. */
export function isAirstrikeVictim(
  attacker: Player,
  owner: Player | TerraNullius,
): owner is Player {
  return (
    owner.isPlayer() && owner !== attacker && !attacker.isFriendly(owner, true) // allies + teammates, incl. disconnected (AFK) ones
  );
}
```

Rules:

1. The attacker's **own** structures and troops are never affected, even when
   they sit inside the blast, rocket lock radius or strafing corridor.
2. **Allied and teammate** structures/troops are never affected, including
   disconnected allies/teammates (`treatAFKFriendly = true`, matching
   `NukeExecution`'s friendly-unit check), and including alliances formed while
   the plane is in the air (the predicate is evaluated at impact/burst time).
3. The filter is applied **before** ordering and before the per-strike
   structure limit (`maxStructures`), so a friendly building can never
   "absorb" the rocket's single hit or the strafing run's single structure hit.
4. Unowned land and terra nullius are never "damaged" (no troops, no
   structures).
5. Targeting already rejects own/allied/teammate target tiles (§5.2,
   `airstrikeSpawn`); rules 1–4 cover everything _around_ a valid target.

Tests (add to `AirstrikeBombing`, `AirstrikeRocket`, `AirstrikeStrafing`):
own structure and an ally's structure placed inside the area beside an enemy
structure → only the enemy structure loses levels, own/ally levels and troops
unchanged; rocket aimed so the attacker's own structure is the _nearest_
structure → the nearest **enemy** structure within 6 is hit instead (or none);
strafing corridor whose first centerline structure is allied → the next
enemy structure is the one hit; disconnected teammate's structure in the blast
→ untouched.

---

## 10. Localization changes

### 10.1 `en.json` (sorted; `’` for apostrophes)

| Key                                      | English                                                                                                                     |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `airstrike_menu.cancel`                  | Cancel                                                                                                                      |
| `airstrike_menu.close`                   | Close                                                                                                                       |
| `airstrike_menu.cost`                    | {cost} gold                                                                                                                 |
| `airstrike_menu.hint`                    | ↑↓ or 1–3 to choose · Enter to launch · Esc to cancel                                                                       |
| `airstrike_menu.launch`                  | Launch                                                                                                                      |
| `airstrike_menu.reason.airport_building` | Your airport is still being built                                                                                           |
| `airstrike_menu.reason.airport_rearming` | Airport rearming ({seconds}s)                                                                                               |
| `airstrike_menu.reason.disabled`         | Disabled in this game                                                                                                       |
| `airstrike_menu.reason.invalid_terrain`  | Can’t strike here                                                                                                           |
| `airstrike_menu.reason.no_airport`       | Build an airport first                                                                                                      |
| `airstrike_menu.reason.not_enough_gold`  | Not enough gold                                                                                                             |
| `airstrike_menu.reason.not_hostile`      | Choose enemy territory                                                                                                      |
| `airstrike_menu.reason.out_of_range`     | Out of range of your airports                                                                                               |
| `airstrike_menu.reason.spawn_immunity`   | Spawn protection is active                                                                                                  |
| `airstrike_menu.title`                   | Airstrike type                                                                                                              |
| `build_menu.desc.airport`                | Launches airstrikes within {range} tiles                                                                                    |
| `build_menu.desc.airstrike`              | Choose a target, then a strike type                                                                                         |
| `build_menu.desc.bombing_run`            | Strong area damage. Can destroy buildings.                                                                                  |
| `build_menu.desc.rocket_strike`          | Precise strike. Strong against structures.                                                                                  |
| `build_menu.desc.strafing_run`           | Line attack. Strong against troops.                                                                                         |
| `events_display.aircraft_shot_down`      | Your {unit} was shot down                                                                                                   |
| `events_display.airstrike_buildings_hit` | Buildings damaged by {name}’s {unit}: {count}                                                                               |
| `events_display.airstrike_hit`           | {name}’s {unit} killed {troops} of your troops                                                                              |
| `events_display.airstrike_inbound`       | {name} - {unit} inbound                                                                                                     |
| `events_display.airstrike_result`        | {unit}: {troops} troops killed, {count} building levels destroyed                                                           |
| `events_display.sam_missed`              | SAM missed {unit}                                                                                                           |
| `help_modal.build_airport_desc`          | Launches airstrikes at enemy land within {range} tiles. Rearms {seconds} seconds after each strike.                         |
| `help_modal.build_airstrike_desc`        | Pick enemy land in range of an airport, then choose Bombing Run, Rocket Strike or Strafing Run. SAMs can shoot planes down. |
| `player_stats_table.air_stats`           | Airstrikes                                                                                                                  |
| `player_stats_table.completed`           | Completed                                                                                                                   |
| `player_stats_table.levels_destroyed`    | Levels destroyed                                                                                                            |
| `player_stats_table.shot_down`           | Shot down                                                                                                                   |
| `player_stats_table.troops_killed`       | Troops killed                                                                                                               |
| `unit_type.bombing_run`                  | Bombing Run                                                                                                                 |
| `unit_type.rocket_strike`                | Rocket Strike                                                                                                               |
| `unit_type.strafing_run`                 | Strafing Run                                                                                                                |
| `leaderboard.airports`                   | Airports                                                                                                                    |

`build_menu.desc.airport` / `help_modal.build_airport_desc` take `range` (and
`seconds`) params at the call sites, so the text can never drift from
`airportRange()` / `AirportCooldown()`. **Every** place that translates a
`build_menu.desc.*` key must pass `{ range: game.config().airportRange() }`
(extra params are ignored by other keys): `RadialMenuElements.createMenuElements`
tooltip, `BuildMenu.render`, `UnitDisplay.renderUnitItem` tooltip, and
`AirstrikeTypeMenu`. Otherwise players would see a literal `{range}`. The existing
`events_display.airstrike_hit` English text changes; its params change from
`{name, troops}` to `{name, unit, troops}`.

Avoid ICU plural syntax in all new strings (use the "label: {count}" form), so
every locale stays valid without per-locale plural categories.

### 10.2 Every other locale

The user explicitly asked for every supported language. Add **all** keys of
§10.1 to every `resources/lang/*.json` except `metadata.json`, translated into
that file's language (Toki Pona for `tp`, Esperanto for `eo`, Swiss German
spelling for `de-CH`, Latin-script Serbo-Croatian for `sh`). Rules:

- keep placeholders byte-identical (`{name}`, `{unit}`, `{troops}`, `{count}`,
  `{cost}`, `{seconds}`, `{range}`);
- never put an ASCII `'` directly before `{` or `}` (ICU quoting) — use `’`;
- create a missing namespace object when a sparse file lacks it;
- insert by loading with Python `json` (preserves order), adding keys, dumping
  with `indent=2, ensure_ascii=False` + trailing newline; for any namespace
  object you create or extend, keep the file's existing key order and append
  new keys at the end of that object (non-English files are not sort-checked);
- verify each file round-trips (`json.loads`) and the ICU test passes.
  Translations are machine-generated: flag them in the final report as needing
  native/Crowdin review. Note the trade-off: upstream Crowdin syncs may overwrite
  these files; DeltaFront currently does not sync from Crowdin.

### 10.3 Localizing the inbound warning

- `displayIncomingUnit` gains `params`; `NukeExecution` keeps its raw strings
  (out of scope), airstrikes send the key + params.
- `EventsDisplay.onUnitIncomingEvent`: if `event.message.startsWith("events_display.")`
  → `translateText(event.message, resolveIncomingParams(event.params))` where
  `resolveIncomingParams` translates `params.unit` when it starts with
  `unit_type.`; otherwise keep the raw string (nukes).
- Extend `resolveParams` (DisplayEvent) to translate `params.unit` for
  `airstrike_hit`, `airstrike_buildings_hit`, `airstrike_result`,
  `aircraft_shot_down`, `sam_missed` (in addition to the existing two keys).

---

## 11. Save / replay compatibility strategy

### 11.1 Preconditions (check first, Phase 0)

`git log --oneline -- packages/engine/src/execution/AirstrikeExecution.ts` must
be empty (V1 never committed). If it is **not** empty (V1 was committed and
possibly shipped), follow 11.3's "if V1 shipped" column instead.

### 11.2 Per-record plan

| Record                             | Change                                                                                       | Versioning                                                                                                                                                                 |
| ---------------------------------- | -------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Airstrike` execution              | new schema (§5.9)                                                                            | V1 unreleased → keep `version: 1`, replace schema.                                                                                                                         |
| `SAMMissile` execution             | `+willHit`                                                                                   | **v2**, migration `1: d => ({...d, willHit: true})` (upstream v1 records exist in fixtures).                                                                               |
| `Nation` execution                 | `behaviors.air`                                                                              | **v2**, migration `1: d => d.behaviors === null ? d : {...d, behaviors: {...d.behaviors, air: {v: 1, d: {lastStrikeTick: null, recentStrikes: [], strikesLaunched: 0}}}}`. |
| `NationAirBehavior`                | new                                                                                          | v1.                                                                                                                                                                        |
| `NationStructureBehavior`          | none (airport logic is stateless)                                                            | unchanged.                                                                                                                                                                 |
| `SAMLauncher`                      | none (cache keyed by unit id; RNG already stored)                                            | unchanged.                                                                                                                                                                 |
| Units                              | strike units use existing `nukeState` serialization; new `UnitType` values are plain strings | unchanged.                                                                                                                                                                 |
| `MissileSilo` exec (airport rearm) | none                                                                                         | unchanged.                                                                                                                                                                 |
| Stats                              | raw tree                                                                                     | unchanged (`StatsSnapshot` v1).                                                                                                                                            |
| `SNAPSHOT_FORMAT_VERSION`          | not bumped (only per-type versions change)                                                   | no new fixture required.                                                                                                                                                   |

### 11.3 Replays and records

- Replays: exact-commit only (§1.6) — no engine-behavior compatibility needed.
- Intents: `build_unit.unit` = `z.enum(UnitType)`; appending enum values keeps
  every existing value's encoding. Old records never contain the new values.
- `UnitIncomingUpdate.params` is optional; worker→main messages are structured
  clones, and replay "misc" storage is schemaless.
- `GameUpdateType.AirstrikeImpact` is appended; route `"misc"`.

| If V1 shipped (11.1 fails)                                        | Do this instead                                                                                                                                                                                                                                                                                                                                          |
| ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Airstrike` execution v1 records exist                            | bump to v2; migration `1: d => ({ ...d, phase: d.active ? "flying" : "done", strikeType: "Bombing Run", burstsApplied: 0, impactTick: null, releaseTile: null, totals: [], destroyed: 0 })`. Also, in `restoreSnapshot`, if the restored `plane` unit's type is `UnitType.Airstrike` (V1 plane), delete it silently on first tick and end the execution. |
| `build_unit` intents with `unit: "Airstrike"` in archived records | `ConstructionExecution` rejects them (warn); replays are exact-commit anyway.                                                                                                                                                                                                                                                                            |

---

## 12. Stats compatibility strategy

- Appending `air` at the end of `PlayerStatsSchema` and `"airp"` at the end of
  `otherUnits` follows the documented safe pattern; old JSON records parse
  (fields optional / keys absent), the strict live-wire schema stays
  same-build-only.
- Implement `Stats` methods (§13 step E-10) and display:
  - `PlayerStatsTable`: `BUILDING_ORDER.airp = 7`, `UNIT_LABEL_KEYS.airp =
"unit_type.airport"`; new section after nukes:
    heading `player_stats_table.air_stats`, row header `player_stats_table.weapon`,
    columns launched / completed / shot_down / intercepted / troops_killed /
    levels_destroyed / destroyed (indices 0–6), rows `airUnits` with labels
    `unit_type.bombing_run|rocket_strike|strafing_run`, troops rendered with
    `renderTroops`.
  - `UNIT_LABEL_KEYS` must also cover `airUnits` (extend the `satisfies` union).
  - `PlayerStatsTree`: merge (`mergeStatRecord(base.air, next.air)`) and clone
    (`air: stats.air ? { ...stats.air } : undefined`).
  - Live leaderboard: append column id `"airports"` to `COLUMN_IDS` (hideable,
    not default) + `unitColumn("airports", "leaderboard.airports", UnitType.Airport, airportIcon)`.
- If any zbin golden test pins `PlayerStatsSchema`'s byte layout and fails,
  regenerate that vector and say so in the final report (it is a same-build wire
  format by design).

---

## 13. Audio architecture

New `SoundEffect` names (`src/client/sound/Sounds.ts`) and assets:

| Cue                    | Category | Asset                                                               | When it plays (local player perspective)                                                               | Throttle |
| ---------------------- | -------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | -------- |
| `airstrike-launch`     | effects  | **placeholder** `sounds/effects/airstrike-launch.mp3` (synthesized) | a strike unit owned by me is created                                                                   | 5 ticks  |
| `airstrike-flyby`      | alerts   | **placeholder** `sounds/effects/airstrike-flyby.mp3` (synthesized)  | `UnitIncoming` `AIRSTRIKE_INBOUND` addressed to me                                                     | 10 ticks |
| `airstrike-bomb`       | effects  | **placeholder** `sounds/effects/airstrike-bomb.mp3` (synthesized)   | `AirstrikeImpact` BombImpact where I am attacker or in `affected`                                      | 3 ticks  |
| `airstrike-rocket`     | effects  | reuse `sam-shoot.mp3` (CC BY-SA, missile launch)                    | RocketRelease, attacker or victim is me                                                                | 3 ticks  |
| `airstrike-rocket-hit` | effects  | reuse `sam-hit.mp3` (missile explosion)                             | RocketImpact, attacker or victim is me                                                                 | 3 ticks  |
| `airstrike-strafe`     | effects  | **placeholder** `sounds/effects/airstrike-strafe.mp3` (synthesized) | StrafeBurst, attacker or victim is me                                                                  | 5 ticks  |
| `sam-launch`           | effects  | reuse `sam-shoot.mp3`                                               | a `SAMMissile` unit is created that is mine, or whose `targetUnitId` unit is mine (nukes _and_ planes) | 5 ticks  |
| `sam-intercept`        | effects  | reuse `sam-hit.mp3`                                                 | `DisplayEvent` `events_display.missile_intercepted` for me                                             | 3 ticks  |
| `aircraft-down`        | effects  | **placeholder** `sounds/effects/aircraft-down.mp3` (synthesized)    | `DisplayEvent` `events_display.aircraft_shot_down` for me                                              | 3 ticks  |

Placeholders are generated locally with `ffmpeg` (license-clean, own work);
commands (run from repo root):

```sh
ffmpeg -y -f lavfi -i "anoisesrc=d=2.4:c=brown:a=0.6" -af "highpass=f=180,lowpass=f=2600,afade=t=in:d=0.5,afade=t=out:st=1.4:d=1.0,volume=0.7" -ac 1 -ar 44100 -b:a 96k resources/sounds/effects/airstrike-launch.mp3
ffmpeg -y -f lavfi -i "anoisesrc=d=3.0:c=pink:a=0.5" -af "bandpass=f=900:w=1200,afade=t=in:d=1.2,afade=t=out:st=1.6:d=1.4,volume=0.6" -ac 1 -ar 44100 -b:a 96k resources/sounds/effects/airstrike-flyby.mp3
ffmpeg -y -f lavfi -i "anoisesrc=d=1.6:c=brown:a=0.9" -af "lowpass=f=420,afade=t=out:st=0.05:d=1.5,volume=1.4" -ac 1 -ar 44100 -b:a 96k resources/sounds/effects/airstrike-bomb.mp3
ffmpeg -y -f lavfi -i "anoisesrc=d=0.9:c=white:a=0.6" -af "highpass=f=700,volume='if(lt(mod(t,0.075),0.03),1,0)':eval=frame,afade=t=out:st=0.6:d=0.3" -ac 1 -ar 44100 -b:a 96k resources/sounds/effects/airstrike-strafe.mp3
ffmpeg -y -f lavfi -i "anoisesrc=d=2.2:c=brown:a=0.8" -af "lowpass=f=900,afade=t=in:d=0.02,afade=t=out:st=0.3:d=1.9,volume=1.1" -ac 1 -ar 44100 -b:a 96k resources/sounds/effects/aircraft-down.mp3
```

Each placeholder entry in `soundEffectUrls` gets a `// PLACEHOLDER: synthesized with ffmpeg; replace with final asset (same file name)` comment. Add a line to `CREDITS.md`: placeholders are original synthesized audio (DeltaFront, CC0-equivalent), and the two reused cues are OpenFront CC BY-SA 4.0.
Volume/spatial: like every existing weapon cue — global, non-spatial, on the
`effects` channel (flyby on `alerts`, like `nuke-warning`). No positional audio
is introduced.
Remove the V1 `Airport → "sam-built"` mapping? **No** — keep it (airport build cue).

---

## 14. Visual / effect changes

### 14.1 FX from `AirstrikeImpact`

- `FrameEvents` += `airstrikeImpacts: AirstrikeImpactFx[]` (`{phase, strikeType, fromX, fromY, toX, toY, radius, tickAge?}`);
  `GameView.buildFrameEvents` fills it from `GameUpdateType.AirstrikeImpact`;
  `ReplayFrameBuilder` initializes it empty; `Upload.ts` calls
  `view.applyAirstrikeImpacts(...)`; `MapRenderer`/`Renderer` forward to
  `FxPass.applyAirstrikeImpacts` (honour `tickAge` like `applyDeadUnits`).
- `FxSpritePass.spawnAirstrikeImpact(fx, now)` — positions from a stable hash
  (`hash = (x*73856093) ^ (y*19349663) ^ (i*83492791)`; render-only):
  | Phase | Sprites |
  |---|---|
  | BombImpact | `FX_BUILDING_EXPLOSION` at centre; `FX_UNIT_EXPLOSION` ×3 within 0.4 r; `FX_MINI_EXPLOSION` ×8 within 0.8 r; lingering `FX_MINI_BIG_SMOKE` ×3 and `FX_MINI_SMOKE_FIRE` ×2 within 0.6 r, lifetime `fx.airstrikeSmokeLifetimeMs` (3500) via the debris path |
  | RocketRelease | `FX_DUST` at release point; `FX_MINI_SMOKE` puffs ×5 evenly along release→target, lifetime `fx.airstrikeTrailLifetimeMs` (1200) |
  | RocketImpact | `FX_BUILDING_EXPLOSION` at target; `FX_MINI_EXPLOSION` ×4 within 3 tiles; lingering `FX_MINI_FIRE` ×2, lifetime `fx.airstrikeFireLifetimeMs` (2500) |
  | StrafeBurst | `FX_DUST` ×6 and `FX_MINI_EXPLOSION` ×3 spread along the segment (±halfWidth across); lingering `FX_MINI_SMOKE` ×2, lifetime `fx.airstrikeDustLifetimeMs` (1500) |
- `FxShockwavePass.pushAirstrikeShockwave(x, y, radius)`: ring to
  `radius × fx.airstrikeShockwaveRadiusFactor` (1.6) over
  `fx.airstrikeShockwaveDurationMs` (900) — BombImpact and RocketImpact only.
- Plane destroyed (dead unit, strike type, `!reachedTarget`):
  `FX_SAM_EXPLOSION` + lingering `FX_MINI_SMOKE_FIRE` (2000 ms). Planes that
  `reachedTarget` spawn **nothing** on death (impact FX come from the event).
  Remove V1 `spawnAirstrikeSprites` and its dead-unit trigger.
- New settings in `render-settings.json` `fx` + `RenderSettings` type:
  `airstrikeSmokeLifetimeMs 3500, airstrikeFireLifetimeMs 2500,
airstrikeDustLifetimeMs 1500, airstrikeTrailLifetimeMs 1200,
airstrikeShockwaveDurationMs 900, airstrikeShockwaveRadiusFactor 1.6`.
- Cost: ≤ 20 sprite instances per event, existing instanced pass, no new
  textures. Gameplay never waits on FX (FX spawn when the update arrives).

### 14.2 Aircraft rendering

- `render/types/UnitType.ts`: replace `UT_AIRSTRIKE` with
  `UT_BOMBING_RUN = "Bombing Run"`, `UT_ROCKET_STRIKE = "Rocket Strike"`,
  `UT_STRAFING_RUN = "Strafing Run"`; `AIRCRAFT_TYPES` set; append the three to
  `ALL_UNIT_TYPES`; keep `UT_AIRPORT`.
- `UnitPass`: rename the last `UNIT_ORDER` entry to the synthetic `"Aircraft"`
  (column 12, unchanged pixels); after building `typeToAtlasCol`, map every
  `AIRCRAFT_TYPES` member to that column; `MISSILE_TYPES` += aircraft;
  smoothing + heading for any aircraft type (heading towards `targetTile`
  until `pos` is the end; for strafing, after passing the target, use
  `lastPos → pos`).
  Heading rule fix: compute heading from `lastPos → pos` whenever they differ,
  else from `pos → targetTile` (strafing planes continue past the target).
- `PointLightPass`: aircraft light `{r: 1, g: 0.9, b: 0.7, radius: 8, intensity: 1.6}` and smoothing like nukes.
- Telegraphs: add `AIRSTRIKE_TELEGRAPH_RADII` (`{[UT_BOMBING_RUN]: 10, [UT_ROCKET_STRIKE]: 4}`) to
  `render/types/UnitType.ts`; `extractNukeTelegraphs` also emits a telegraph
  (inner = outer = radius) for those types.

### 14.3 Previews

- Airport ring readability: new `render-settings.json` block `airportRadius`
  `{strokeWidth: 3, dashLen: 36, gapLen: 18, rotationSpeed: 10, alpha: 0.9,
outlineWidth: 0.4, outlineSoftness: 0.15, fillAlpha: 0.05, minStrokePx: 2}`;
  `RadiusSource` gains `settingsKey: "samRadius" | "airportRadius"`;
  `SAMRadiusPass.draw(cam, zoom)` sets `uStrokeWidth = max(strokeWidth,
minStrokePx / zoom)` (`zoom` = screen px per tile, as passed to
  `structurePass.draw`) and `uFillAlpha`; shader: inside `dist < radius −
stroke` output `vec4(color, uFillAlpha)` instead of discarding (SAM settings
  use `fillAlpha: 0`, `minStrokePx: 0` → identical to today). 400-tile rings:
  one instanced quad (804×804 tiles) per airport; overlaps stack fill alpha
  (acceptable at 0.05). No performance concern (≤ 3 per player, fragment work
  bounded by screen area).
- Strike shapes (`BuildPreviewController.buildGhostPreviewData`):
  - Airport ghost: `rangeRadius = airportRange()` (400).
  - Airstrike ghost: shape of `uiState.airstrikeType` at the cursor (or the
    locked target while the menu is open): Bombing → circle 10; Rocket →
    circle 4; Strafing → corridor (§14.4) from the launch airport
    (`buildable.canBuild` tile) through the target. `rangeWarning` when
    `canBuild === false`. Ghost cost label shows the selected type's cost
    and, when invalid, `topText = translateText("airstrike_menu.reason." + reason)`.
- New `CorridorPreviewPass` (`render/gl/passes/CorridorPreviewPass.ts`, shaders
  `shaders/corridor/corridor.{vert,frag}.glsl`): one quad covering the
  corridor's bounding rectangle; fragment computes along/perp distance to the
  segment; fill alpha 0.12, 1-tile outline, 3 dashed dividers between bursts;
  white when valid, red (`1.0, 0.2, 0.2`) when invalid. Driven by
  `GhostPreviewData.corridor?: { x0, y0, x1, y1, halfWidth, segments } | null`
  (`null` = hidden). Drawn right after `rangeCirclePass`.

---

## 15. Step-by-step instructions

Each step: **FILE / CLASS-FUNCTION / CHANGE / WHY / DEPENDENCIES / TEST.**
Steps are ordered; dependencies refer to step ids.

### Phase 0 — Preconditions

**P-1**
FILE: (shell)
CHANGE: `git status --porcelain`; confirm the V1 file list matches §1.1;
`git log --oneline -- packages/engine/src/execution/AirstrikeExecution.ts` (must
be empty, else apply §11.3 alternative). Run `npm run typecheck`,
`npm run lint`, `npx vitest --run` and save the baseline counts.
WHY: start from a known-green tree.
TEST: baseline green (613 files / 8022 tests at time of writing).

### Phase A — engine-api

**A-1**
FILE: `packages/engine-api/src/game/GameTypes.ts`
CLASS/FUNCTION: `enum UnitType`, groups
CHANGE: append `BombingRun`, `RocketStrike`, `StrafingRun` (§4.1); add
`AirstrikeTypes`, `AirstrikeUnitType`; extend `PlayerBuildable`.
WHY: D1. DEPENDENCIES: none.
TEST: typecheck lists every exhaustive switch to update (Config.unitInfo,
EngineConfig.unitCost, UnitParamsMap, PlayerImpl.canSpawnUnitType) — fix in
B/E steps.

**A-2**
FILE: same — `enum MessageType`, `MESSAGE_TYPE_CATEGORIES`
CHANGE: append `AIRSTRIKE_RESULT` (category ATTACK).
DEPENDENCIES: A-1. TEST: compile.

**A-3**
FILE: `packages/engine-api/src/game/GameUpdates.ts`
CHANGE: append `GameUpdateType.AirstrikeImpact`; add `AirstrikeImpactPhase`,
`AirstrikeImpactUpdate` (§4.3) to the union; `UnitIncomingUpdate.params?`.
WHY: D7, §10.3. TEST: compile errors in `FrameNormalizer.UPDATE_TYPE_ROUTING`
(fixed in C-14).

**A-4**
FILE: `packages/engine-api/src/StatsSchemas.ts`
CHANGE: §4.9 (append `"airp"`, `OtherUnitType`, map; `airUnits`,
`AirUnitSchema`, `unitTypeToAirUnit`, `AIR_INDEX_*`; append `air` field last).
WHY: D10, §12. DEPENDENCIES: A-1.
TEST: `tests/zbin/*` and stats tests still pass; new
`tests/AirstrikeStats.test.ts` (E-15) round-trips a record with and without
`air` through `PlayerStatsSchema` and `ArchivedPlayerStatsSchema`.

### Phase B — engine-lib

**B-1**
FILE: `packages/engine-lib/src/configuration/Config.ts`
CLASS/FUNCTION: `airportRange`, `AirportCooldown`, `airstrikeSpec` (new),
`unitInfo`, `isUnitDisabled`; remove `airstrikeRadius`
CHANGE: §4.6.
WHY: single source of balance truth readable by engine and client.
DEPENDENCIES: A-1.
TEST: `tests/AirstrikeConfig.test.ts`: `airportRange() === 400`,
`AirportCooldown() === 200`, every spec field equals §4.6's table,
`isUnitDisabled(BombingRun)` true when `disabledUnits: [Airstrike]`,
`unitInfo(StrafingRun)` has no construction duration.

**B-2**
FILE: new `packages/engine-lib/src/airstrike/AirstrikeGeometry.ts`
CHANGE: §4.8 geometry functions (move V1 `flightPath` here as `straightPath`).
WHY: D8. DEPENDENCIES: B-1 (spec type).
TEST: `tests/AirstrikeGeometry.test.ts` (uses a `GameMapImpl` built from
`big_plains`): straight path ends exactly on target and has
`ceil(dist/2)` steps (`AIRSTRIKE_PLANE_SPEED`); rocket end point is 10 tiles short (and equals src
when D ≤ 10); strafing end point is `D + 20 + 8` along the line and clipped at
the map edge; corridor of a horizontal approach has exactly `41 × 5` tiles away
from edges; burst tiles partition the corridor (disjoint, union = all);
`burstTriggerSteps` is non-decreasing and ≤ last index; results identical when
called twice (pure).

**B-3**
FILE: new `packages/engine-lib/src/airstrike/AirstrikeRules.ts`
CHANGE: `AirstrikeBlockReason`, `AirportInfo`, `pickAirstrikeAirport`,
`airstrikeTroopLoss` (§4.8).
DEPENDENCIES: B-1, B-2.
TEST: `tests/AirstrikeRules.test.ts`: each reason in priority order; nearest
ready airport chosen; tie → first index; troop loss = 0 for 0 troops/0 hit;
caps applied per spec; integer results.

**B-4**
FILE: `tests/LayerBoundaries.test.ts` (read only)
CHANGE: none — confirm the new engine-lib files import only engine-api / zod.
TEST: passes.

### Phase E — engine

**E-1**
FILE: `packages/engine/src/configuration/EngineConfig.ts`
CLASS/FUNCTION: `unitCost`; remove `airstrikeSpeed`, `airstrikeTroopLoss`
CHANGE: §4.7.
DEPENDENCIES: A-1, B-1.
TEST: AirstrikeConfig test: costs 1M/1.5M/2M/2M for 0–3 airports; strike costs;
selector cost = min of enabled types (250k; 350k when Strafing disabled);
infinite-gold human → 0.

**E-2**
FILE: `packages/engine/src/game/Game.ts`
CHANGE: `UnitParamsMap` per §4.5; `displayIncomingUnit(..., params?)`.
DEPENDENCIES: A-1, A-3. TEST: compile.

**E-3**
FILE: `packages/engine/src/game/GameImpl.ts` `displayIncomingUnit`
CHANGE: forward `params` into the update (omit the key when undefined).
TEST: covered by E-12 tests (inbound update carries params).

**E-4**
FILE: `packages/engine/src/game/PlayerImpl.ts`
CLASS/FUNCTION: `canSpawnUnitType`, `airstrikeSpawn`
CHANGE: `case Airstrike` and the three strike types → `this.airstrikeSpawn(tile)`.
Rewrite `airstrikeSpawn` to: spawn-immunity → false; not land / impassable →
false; owner not a hostile player → false; then
`pickAirstrikeAirport(mg, tile, this.units(Airport).map(a => ({tile: a.tile(),
active: a.isActive(), underConstruction: a.isUnderConstruction(), inCooldown:
a.isInCooldown()})), config.airportRange())` → `airport ?? false`.
WHY: one rule for engine and client (D8).
DEPENDENCIES: B-3.
TEST: E-12 targeting tests.

**E-5**
FILE: `packages/engine/src/game/UnitImpl.ts`
CHANGE: add `UnitType.Airport` to the three stats switches (constructor
`unitBuild`, `setOwner` capture/lose, `delete` destroy/lose).
WHY: "Airports built/destroyed/captured/lost" stats.
TEST: E-15.

**E-6**
FILE: `packages/engine/src/game/Stats.ts`, `StatsImpl.ts`
CHANGE: add `airLaunch`, `airComplete`, `airShotDown`, `airIntercept`,
`airTroopsKilled`, `airStructureDamage(player, type, levels, destroyed)`; private
`_addAir(player, type, index, value)` mirroring `_addBomb`.
DEPENDENCIES: A-4. TEST: E-15.

**E-7**
FILE: `packages/engine/src/execution/ConstructionExecution.ts`
CHANGE: remove the V1 `case UnitType.Airstrike`; add
`case BombingRun / RocketStrike / StrafingRun: addExecution(new AirstrikeExecution(player, this.tile, this.constructionType))`.
`UnitType.Airstrike` falls to the default branch (warn, nothing built).
WHY: the selector is never a purchase; prevents a free strike exploit.
TEST: E-12 "build_unit Airstrike intent does nothing and charges nothing".

**E-8**
FILE: `packages/engine/src/execution/AirstrikeExecution.ts`
CHANGE: full rewrite per §5 (state, launch, tick, bomb/rocket/strafe, shot down,
messages, stats, AirstrikeImpact updates via `mg.addUpdate({...})`, snapshot).
Damage helpers in a sibling module
`packages/engine/src/execution/airstrike/AirstrikeDamage.ts`:
`applyTroopDamage(game, attacker, tiles, spec, totals): number[]` (returns
affected smallIDs) and `applyStructureDamage(game, attacker, candidates, levels, totals): {levels, destroyed}`.
DEPENDENCIES: A-1…A-3, B-1…B-3, E-1…E-7.
TEST: E-12, E-13, E-14.

**E-9**
FILE: `packages/engine/src/execution/MissileSiloExecution.ts`
CHANGE: none (reads `launcherCooldown`, now 200 for airports). Verify.

**E-10**
FILE: `packages/engine/src/execution/SAMLauncherExecution.ts`
CHANGE: §7 steps 1–4 (`SAM_TARGET_TYPES`, scoring, `willHit` roll, pass to missile).
DEPENDENCIES: A-1, B-1. TEST: E-14.

**E-11**
FILE: `packages/engine/src/execution/SAMMissileExecution.ts`
CHANGE: §7 step 5 (whitelist, hit/miss, stats, messages, snapshot v2 +
migration).
TEST: E-14; `SnapshotFixtures` (migration exercised).

**E-12 (tests)**
FILE: replace `tests/Airstrike.test.ts` with `tests/airstrike/AirstrikeTargeting.test.ts`
CHANGE: port V1 targeting/placement/cooldown tests to the new types and add:
400-tile range on the `world` map (find two land tiles on one row 399 and 401
tiles from an airport by scanning `isLand`; conquer small squares there);
edge-of-range on `big_plains` with a `TestConfig` subclass overriding
`airportRange()` → 100; all three types share validity; selector intent is
rejected; rearm 200 ticks; spawn immunity; allied/teammate/own/unowned rejected;
construction 100 ticks; inbound update has key + params.

**E-13 (tests)**
FILES: `tests/airstrike/AirstrikeBombing.test.ts`, `AirstrikeRocket.test.ts`,
`AirstrikeStrafing.test.ts`
CHANGE: see §16 matrix rows BOMB/ROCKET/STRAFE.

**E-14 (tests)**
FILE: `tests/airstrike/AirstrikeSam.test.ts` (+ extend
`tests/core/executions/SAMLauncherExecution.test.ts` with "nukes unaffected by
the plane hit roll")
CHANGE: §16 SAM rows. Use a `TestConfig` subclass overriding `airstrikeSpec`
(samHitPercent 100 or 0) to make outcomes certain where needed; one test with
the real values runs N=200 engagements per strike type and asserts the observed
hit rates are within ±10 points of 65 / 50 / 60 % (deterministic seed, so the
exact counts are stable — assert the exact numbers once observed). Another test
puts a plane through two SAMs' coverage with forced misses on the first SAM and
asserts the second SAM engages (compounding).

**E-15 (tests)**
FILE: `tests/AirstrikeStats.test.ts`
CHANGE: §16 STATS rows.

**E-16 (tests)**
FILE: `tests/airstrike/AirstrikeSnapshot.test.ts`
CHANGE: §16 SAVE rows using `roundTrip(game, map)` from `tests/util/Snapshot.ts`.

### Phase N — Nation AI

**N-1**
FILE: `packages/engine/src/execution/nation/NationStructureBehavior.ts`
CHANGE: §8.1 (ratios, max, build order, `airportValue`, zero-value guard,
coverage-gap rule).
DEPENDENCIES: E-\*.
TEST: extend `tests/NationStructureBehavior.test.ts` (N-4).

**N-2**
FILE: new `packages/engine/src/execution/nation/NationAirBehavior.ts`
CHANGE: §8.2.
DEPENDENCIES: E-\*, N-1 not required.
TEST: `tests/NationAirBehavior.test.ts` (N-4).

**N-3**
FILE: `packages/engine/src/execution/NationExecution.ts`
CHANGE: field `airBehavior`; construct in `initializeBehaviors` after
`nukeBehavior` (`new NationAirBehavior(random, mg, player, attackBehavior,
nukeBehavior, emojiBehavior)`); call `this.airBehavior.maybeLaunchAirstrike()`
after `maybeSendNuke()`; snapshot `air`; restore (shell + `restoreSnapshot(b.air, r,
random, player, attack, nuke, emoji)`); schema `air: VersionedSchema`; bump to
v2 with the §11.2 migration.
TEST: SnapshotFixtures + FullGameSnapshot.

**N-4 (tests)**
FILES: `tests/NationAirBehavior.test.ts`, extend `tests/NationStructureBehavior.test.ts`
CHANGE: §16 AI rows. Pattern: `tests/NationNukeTargeting.test.ts` (construct
behaviors directly with `new PseudoRandom(1)` on `big_plains` with a reduced
`airportRange` `TestConfig` where needed).

### Phase C — client

**C-1**
FILE: `src/client/render/types/UnitType.ts`, `index.ts`
CHANGE: §14.2 constants/sets/telegraph radii.

**C-2**
FILE: `src/client/render/gl/passes/UnitPass.ts`, `PointLightPass.ts`,
`render/frame/derive/NukeTelegraphs.ts`
CHANGE: §14.2.
TEST: extend `tests/client/render/...` heading test (or add
`tests/client/render/AircraftHeading.test.ts`) for `planeHeadingByte`:
`(0,-1) → 0`, `(1,0) → 64`, `(0,1) → 128`, `(-1,0) → 192`; and a telegraph test:
bombing plane with targetTile → telegraph radius 10; strafing → none.

**C-3**
FILE: `src/client/render/gl/passes/SamRadiusPass.ts`,
`shaders/sam-radius/sam-radius.frag.glsl`, `render/gl/Renderer.ts`,
`render/gl/RenderSettings.ts`, `render/gl/render-settings.json`
CHANGE: §14.3 airport ring settings/fill/min stroke; pass `zoom` to both radius
passes' `draw`.
TEST: browser check (§16 UI rows); SAM ring pixels unchanged (fillAlpha 0).

**C-4**
FILE: new `src/client/render/gl/passes/CorridorPreviewPass.ts` + shaders;
`render/types/*` (`GhostPreviewData.corridor`); `Renderer.updateGhostPreview`;
`MapRenderer` passthrough.
CHANGE: §14.3.

**C-5**
FILE: `src/client/render/gl/passes/fx-pass/FxSpritePass.ts`, `fx-pass/index.ts`,
`fx-pass/FxShockwavePass.ts`, `render/types/FrameEvents.ts`,
`render/types/Renderer.ts`, `render/frame/Upload.ts`, `render/gl/MapRenderer.ts`,
`render/gl/Renderer.ts`, `view/GameView.ts` (`buildFrameEvents`),
`replay/ReplayFrameBuilder.ts`
CHANGE: §14.1.
TEST: unit test that `GameView.buildFrameEvents` maps an `AirstrikeImpact`
update into `airstrikeImpacts` (follow existing GameView tests under
`tests/client/view`).

**C-6**
FILE: new `src/client/hud/layers/AirstrikeTypeMenu.ts` (`<airstrike-type-menu>`),
`index.html` (mount next to `<build-menu>`), `hud/GameRenderer.ts` (wire
`game`, `eventBus`, `uiState`, `transformHandler`; add to `layers`).
CHANGE: implement §6 + this spec:

- Events (in `InputHandler.ts` next to the others): `ShowAirstrikeMenuEvent(tile, screenX, screenY)`, `CloseAirstrikeMenuEvent(reason)`.
- Light DOM (`createRenderRoot() { return this; }`), Tailwind with DeltaFront
  tokens (`df-panel`, `df-border`, `df-btn`, red accent for selection/focus).
- Layout: fixed panel 288 px wide at `(screenX+16, screenY+16)`, clamped to the
  viewport with 16 px margins; on viewports < 640 px wide render as a bottom
  sheet (full width, `pb-[env(safe-area-inset-bottom)]`).
  Header: `airstrike_menu.title` + ✕ (`aria-label=airstrike_menu.close`).
  Three option cards (icon, name, two-line description from
  `build_menu.desc.<type>`, cost via `airstrike_menu.cost` + `renderNumber`,
  hotkey number, disabled reason line). Footer: Cancel + Launch (`df-btn`
  primary), hint line `airstrike_menu.hint`.
- Accessibility: `role="dialog" aria-modal="true" aria-labelledby`; options in
  `role="radiogroup"`, each `role="radio" aria-checked aria-disabled
aria-describedby`; focus the selected option on open; Tab cycles within the
  dialog; focus returns to the canvas on close; minimum 44 px touch targets;
  visible focus ring.
- Input: a `window` **capture-phase** `keydown` listener active only while
  open that handles and `stopPropagation()`s: ArrowUp/Down/Left/Right, Home,
  End (move selection, skip disabled), Digit1–3/Numpad1–3 (select only),
  Enter/NumpadEnter/Space (launch), Escape (close → TARGETING). `wheel` on the
  panel moves the selection and `stopPropagation()`/`preventDefault()` (no map
  zoom). Click option = select; `dblclick` option = launch; pointerdown
  outside the panel = close; ignore pointerup within 150 ms of opening.
- Data: on open and every `tick()`: `myPlayer.buildables(tile,
AirstrikeTypes.types)`; per type compute reason: disabled (config) →
  `disabled`; `canBuild === false` → reason from `pickAirstrikeAirport` and the
  target checks (client mirror using `GameView`/`UnitView`; rearm seconds
  = `ceil((queue[0] + AirportCooldown − ticks)/10)`); gold < cost →
  `not_enough_gold`. Launch disabled when the selected type has a reason.
- Launch: final `buildables` check; ok → `eventBus.emit(new BuildUnitIntentEvent(type, tile))`,
  `uiState.airstrikeType = type`, persist via `UserSettings` key
  `airstrike.lastType` (try/catch), close; fail → `view.triggerBlockedFlash`
  via a `TriggerBlockedFlashEvent` or direct `MapRenderer` reference, keep open.
- Self-heal: in `tick()` close if `uiState.ghostStructure !== UnitType.Airstrike`
  or the player is dead or the game is in spawn phase.
- Icons: new `resources/images/BombingRunIconWhite.svg`,
  `RocketStrikeIconWhite.svg`, `StrafingRunIconWhite.svg` (32×32 white glyphs
  in the style of `AirstrikeIconWhite.svg`: plane + three bomb dots; rocket;
  plane + dashed line). Export them from `hud/HotbarIcons.ts`.
  TEST: `tests/client/AirstrikeTypeMenu.test.ts` (jsdom, stub game/eventBus like
  `tests/client/controllers/BuildPreviewController.test.ts`): opens with three
  options; keyboard selection skips disabled; digits select but do not launch;
  Enter launches once (double Enter → one intent); Escape closes and keeps the
  ghost; outside click closes; invalid at confirm → no intent; becomes invalid
  while open → Launch disabled; wheel changes selection; closes itself when the
  ghost changes.

**C-7**
FILE: `src/client/InputHandler.ts`
CHANGE: Escape: if `uiState.airstrikeTarget !== null` → emit
`CloseAirstrikeMenuEvent("escape")` and return before clearing the ghost.
Enter: skip `ConfirmGhostStructureEvent` while the menu is open.
`canUseBuildKeybinds()` → also require `uiState.airstrikeTarget === null`.
`onContextMenu`: if the menu is open → close it (do not clear the ghost).
`setGhostStructure`: when switching away from Airstrike, emit
`CloseAirstrikeMenuEvent("ghost_changed")`. Keep `KeyH`/`KeyJ` defaults.
TEST: extend `tests/client/InGameKeybindCapture.test.ts` or add
`tests/client/AirstrikeKeyboard.test.ts`.

**C-8**
FILE: `src/client/controllers/BuildPreviewController.ts`
CHANGE: `createStructure`/`requestConfirmStructure`: ghost Airstrike + valid →
set `uiState.airstrikeTarget = tile`, emit `ShowAirstrikeMenuEvent` (no intent);
invalid → `rejectAirstrike` (flash, keep ghost). While
`uiState.airstrikeTarget !== null`, a `MouseUpEvent` closes the menu
(`CloseAirstrikeMenuEvent("map_click")`) instead of confirming; `renderGhost`
anchors to the locked tile (`snapToPlacement: true`) and queries
`buildables(lockedTile, [uiState.airstrikeType])`. Preview shapes per §14.3.
`shouldPreserveGhostAfterBuild` → `true` for the three strike types and
`Airstrike`. `syncGhostState`: ghost cleared/changed → close menu.
TEST: extend `tests/client/controllers/BuildPreviewController.test.ts`: valid
click opens the menu and emits no intent; invalid click flashes; map click
while open closes the menu without an intent; preserve-ghost cases.

**C-9**
FILE: `src/client/hud/layers/RadialMenuElements.ts`
CHANGE: in `createMenuElements`, for `item.unitType === UnitType.Airstrike`:
`subMenu` returns three elements (one per enabled strike type): `id
"attack_<type>"`, name/description/cost tooltip, reason tooltip when
`buildableUnit.canBuild === false` or unaffordable, `disabled` accordingly,
`color: COLORS.attack`, icon per type, `action` → `BuildUnitIntentEvent(type,
p.tile)` + `p.closeMenu()`. Airstrike item tooltip adds the reason when
disabled. Skip the bulk/upgrade submenu logic for Airstrike.
TEST: unit test of `createMenuElements` for an enemy tile with stubbed
`playerActions.buildableUnits` (3 submenu entries; disabled when canBuild false).

**C-10**
FILE: `src/client/hud/layers/BuildMenu.ts` (`buildTable`, `sendBuildOrUpgrade`)
CHANGE: `Airstrike` click → hide panel, set `uiState.ghostStructure =
Airstrike`, `uiState.airstrikeTarget = clickedTile`, emit
`ShowAirstrikeMenuEvent(clickedTile, innerWidth/2, innerHeight/2)`; never emit
an intent for `Airstrike`. Update `build_menu.desc.airport` call site to pass
`{range}`.

**C-11**
FILE: `src/client/hud/layers/UnitDisplay.ts`
CHANGE: tooltip description for Airport passes `{range: config.airportRange()}`;
`canBuild(Airstrike)` unchanged (cost = min strike cost). Show "from" price:
none needed (label is the cost already).

**C-12**
FILE: `src/client/hud/layers/EventsDisplay.ts`
CHANGE: §10.3 (incoming translation; `resolveParams` key list); add
`AIRSTRIKE_RESULT` to nothing (minor feed). Keep `AIRSTRIKE_INBOUND` tier 1 and
in `isInboundWarning`.
FILE: `src/client/Utils.ts` `getMessageTypeClasses`: `AIRSTRIKE_RESULT` → success.

**C-13**
FILE: `src/client/controllers/SoundEffectController.ts`, `src/client/sound/Sounds.ts`
CHANGE: §13 (new cues, `CUE_CATEGORY`, triggers, throttles); placeholder files.
TEST: extend `tests/client/controllers/SoundEffectController.test.ts`: own strike
creation → `airstrike-launch`; enemy strike creation → nothing; inbound to me →
`airstrike-flyby`; bomb impact affecting me → `airstrike-bomb`; impact not
involving me → nothing; throttle collapses two bursts in the same tick.

**C-14**
FILE: `src/client/replay/codec/FrameNormalizer.ts`
CHANGE: `AirstrikeImpact: "misc"`.

**C-15**
FILES: `src/client/components/baseComponents/stats/PlayerStatsTable.ts`,
`PlayerStatsTree.ts`, `src/client/StatsConstants.ts`,
`src/client/hud/layers/lib/StatsColumns.ts`
CHANGE: §12.
TEST: extend `tests/client/PlayerStatsTable.test.ts` (airport row, air section
renders zeros when `air` missing, values when present) and
`tests/client/PlayerStatsTreeMerge.test.ts` (air merge).

**C-16**
FILE: `src/client/HelpModal.ts`
CHANGE: two rows after the SAM row: Airport (`AirportIconWhite.svg`,
`help_modal.build_airport_desc` with `{range, seconds}` from config) and
Airstrike (`AirstrikeIconWhite.svg`, `help_modal.build_airstrike_desc`).
Params: `{ range: AIRPORT_RANGE_TILES, seconds: AIRPORT_REARM_TICKS / 10 }`
imported from `@openfront/engine-lib/configuration/Config` (allowed for the
homepage chunk; it is not game-client code).

**C-17**
FILE: `src/client/components/GameConfigSettings.ts`, `src/client/JoinLobbyModal.ts`
CHANGE: none required (family toggle). Verify the Airstrike toggle disables all
three types in game (manual check + B-1 test).

### Phase L — localization

**L-1** `resources/lang/en.json` per §10.1 (sorted).
**L-2** All other locale files per §10.2.
**L-3** New test `tests/AirstrikeLocalization.test.ts`: for every
`resources/lang/*.json` except `metadata.json`, every §10.1 key exists and its
set of `{placeholder}` names equals English's.

### Phase S — scripted full game

**S-1**
FILE: `tests/util/ScriptedGame.ts` `airIntent`
CHANGE: strike intents use `AirstrikeTypes.types[(tick / 5) % 3]` instead of
`UnitType.Airstrike`; keep validity via `p.canBuild(type, n)`.
TEST: `FullGameSnapshot` "every execution type" still includes `Airstrike`, and
all three variants pass.

### Phase V — verification

**V-1** `npm run typecheck`, `npm run lint`, `npx prettier --check` on changed
files, `npx vitest --run`.
**V-2** Browser check (dev server, then stop it): §16 UI rows, screenshots of
each preview, the menu (desktop + 390 px wide), each strike's FX, a SAM
interception, and the stats table.
**V-3** Final report: files, decisions, deviations, test counts, review flags
(machine translations, placeholder audio).

---

## 16. Test matrix

| Area    | Test                                                                                                                              | File                                                   |
| ------- | --------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| AIRPORT | builds on own land; not on enemy land; 100-tick construction; not upgradable                                                      | AirstrikeTargeting                                     |
| AIRPORT | price 1M → 1.5M → 2M → 2M                                                                                                         | AirstrikeConfig                                        |
| AIRPORT | `airportRange() === 400`; target at 399 tiles valid, 401 invalid (world map)                                                      | AirstrikeTargeting                                     |
| AIRPORT | edge with overridden range 100: exactly 100 valid, 101 invalid                                                                    | AirstrikeTargeting                                     |
| AIRPORT | rearm: in cooldown for 199 ticks after launch, ready at 200; strikes blocked meanwhile                                            | AirstrikeTargeting                                     |
| AIRPORT | nearest ready airport launches; second airport used when first is rearming                                                        | AirstrikeTargeting                                     |
| AIRPORT | stats `units.airp` built/destroyed/captured/lost                                                                                  | AirstrikeStats                                         |
| MENU    | target first: valid click opens menu, emits no intent                                                                             | BuildPreviewController                                 |
| MENU    | cancel via Esc/✕/outside/right-click/map click → ghost kept, target cleared                                                       | AirstrikeTypeMenu, BuildPreviewController              |
| MENU    | target invalid at confirm → no intent, flash                                                                                      | AirstrikeTypeMenu                                      |
| MENU    | target invalidated while open → Launch disabled with reason                                                                       | AirstrikeTypeMenu                                      |
| MENU    | selection via arrows/digits/wheel; disabled skipped; Enter launches once                                                          | AirstrikeTypeMenu                                      |
| MENU    | self-closes when ghost changes / player dies                                                                                      | AirstrikeTypeMenu                                      |
| MENU    | build keybinds inert while open; Esc closes menu only                                                                             | AirstrikeKeyboard                                      |
| RADIAL  | Airstrike item opens 3-entry submenu; disabled entries per canBuild/gold; click emits typed intent                                | RadialMenuElements test                                |
| BOMB    | troops: full-coverage small player loses exactly `cap` (25 %); big player loses `floor(troops×3×share)`                           | AirstrikeBombing                                       |
| BOMB    | two hostile structures in r 10 each −1 level; level-1 one destroyed (stats destroy/lose)                                          | AirstrikeBombing                                       |
| BOMB    | allied (formed mid-flight) and own tiles/structures untouched                                                                     | AirstrikeBombing                                       |
| BOMB    | land preserved (`numTilesOwned`, `isLand`)                                                                                        | AirstrikeBombing                                       |
| BOMB    | flight time = `ceil(dist/2)` ticks                                                                                                | AirstrikeBombing                                       |
| ROCKET  | releases 10 tiles short; plane gone at release; impact exactly 3 ticks later                                                      | AirstrikeRocket                                        |
| ROCKET  | only tiles within r 4 lose troops; cap 10 %                                                                                       | AirstrikeRocket                                        |
| ROCKET  | nearest hostile structure within 6 loses 2 levels (L3 city → L1; L1 SAM destroyed; airport destroyed); other structures untouched | AirstrikeRocket                                        |
| ROCKET  | shot down before release → no damage; after release → damage still lands                                                          | AirstrikeRocket, AirstrikeSam                          |
| STRAFE  | corridor = 41×5 tiles for a horizontal approach; direction = airport→target                                                       | AirstrikeStrafing                                      |
| STRAFE  | 4 bursts at the expected steps; damage lands progressively                                                                        | AirstrikeStrafing                                      |
| STRAFE  | multiple players crossed: each loses per-burst capped troops                                                                      | AirstrikeStrafing                                      |
| STRAFE  | ally inside corridor spared (alliance formed mid-pass spares later bursts only)                                                   | AirstrikeStrafing                                      |
| STRAFE  | plane continues past target and is deleted at the exit with `reachedTarget`                                                       | AirstrikeStrafing                                      |
| STRAFE  | exit clipped at map edge without throwing                                                                                         | AirstrikeStrafing                                      |
| STRAFE  | at most one structure hit, the first under the centerline                                                                         | AirstrikeStrafing                                      |
| SAM     | SAM acquires a plane in range and launches (missile unit exists, `targetedBySAM`)                                                 | AirstrikeSam                                           |
| SAM     | hit (forced 100 %): plane destroyed, attacker `aircraft_shot_down`, SAM owner `missile_intercepted`, stats shotDown/intercept     | AirstrikeSam                                           |
| SAM     | miss (forced 0 %): `sam_missed`, plane continues, flag cleared, second SAM engages                                                | AirstrikeSam                                           |
| SAM     | one SAM fires one missile per plane at a time; two SAMs can both engage after a miss                                              | AirstrikeSam                                           |
| SAM     | nuke prioritized over plane when both due                                                                                         | AirstrikeSam                                           |
| SAM     | nuke interception unchanged (always hits; RNG not drawn)                                                                          | SAMLauncherExecution                                   |
| SAM     | real hit rates over 200 seeded engagements ≈ 65 / 50 / 60 % (exact deterministic counts)                                          | AirstrikeSam                                           |
| SAM     | strafing partial damage kept when shot down mid-pass                                                                              | AirstrikeSam                                           |
| AI      | Hard nation with ≥ 7 cities and hostile structures in range builds 1 airport; Easy never                                          | NationStructureBehavior                                |
| AI      | no airport when nothing hostile in range; no second airport without a coverage gap; max per difficulty                            | NationStructureBehavior                                |
| AI      | chooses Rocket vs lone L1 SAM; Bombing vs troop-dense cluster with 2 structures; Strafing when retaliating along a long border    | NationAirBehavior                                      |
| AI      | no strike when gold < cost × multiplier; when all airports rearming; within min gap; vs allies/teammates/bots                     | NationAirBehavior                                      |
| AI      | Hard skips a target covered by 1 ready SAM (best survival 0.5 < 0.6); Impossible picks Rocket there (0.5 ≥ 0.4)                   | NationAirBehavior                                      |
| AI      | deterministic: two identical runs → identical intents                                                                             | NationAirBehavior                                      |
| SAVE    | each type: snapshot mid-flight → restore → identical snapshots after N ticks                                                      | AirstrikeSnapshot                                      |
| SAVE    | strafing mid-pass (after burst 2)                                                                                                 | AirstrikeSnapshot                                      |
| SAVE    | rocket in "rockets" phase                                                                                                         | AirstrikeSnapshot                                      |
| SAVE    | SAM missile in flight towards a plane (with `willHit` false and true)                                                             | AirstrikeSnapshot                                      |
| SAVE    | migrations: SAMMissile v1 → v2, Nation v1 → v2 (SnapshotFixtures)                                                                 | existing                                               |
| SYNC    | two independent games, same inputs → identical snapshots (FFA, Team)                                                              | AirstrikeSnapshot                                      |
| SYNC    | full scripted game incl. all three types (all 3 variants)                                                                         | FullGameSnapshot                                       |
| SYNC    | alliance formed mid-flight behaves identically after restore                                                                      | AirstrikeSnapshot                                      |
| STATS   | launch/complete/shotDown/intercept/troops/levels/destroyed increments                                                             | AirstrikeStats                                         |
| STATS   | old record without `air`/`airp` parses (strict + archived)                                                                        | AirstrikeStats                                         |
| STATS   | table + tree merge render air stats                                                                                               | PlayerStatsTable, PlayerStatsTreeMerge                 |
| LOC     | every locale has every key; placeholders match; ICU valid; en sorted; keys used                                                   | AirstrikeLocalization, TranslationSystem, EnJsonSorted |
| FX      | AirstrikeImpact → frame event                                                                                                     | GameView test                                          |
| AUDIO   | cue triggers + throttles                                                                                                          | SoundEffectController                                  |
| RENDER  | heading byte, telegraphs                                                                                                          | render tests                                           |

---

## 17. Recommended implementation order

1. Phase 0 (P-1).
2. Phase A (A-1 … A-4) — then make typecheck green with minimal stubs.
3. Phase B (B-1 … B-4) + its tests.
4. Phase E (E-1 … E-11), then tests E-12 … E-16. **Checkpoint: engine fully
   tested, client compiling (temporarily map old `UT_AIRSTRIKE` to the three
   new strings if needed).**
5. Phase S (S-1) and run FullGameSnapshot/SnapshotFixtures.
6. Phase N (N-1 … N-4).
7. Phase C in this order: C-1, C-2, C-14, C-5, C-3, C-4, C-8, C-7, C-6, C-9,
   C-10, C-11, C-12, C-15, C-16, C-17, C-13 (audio last; placeholders first).
8. Phase L.
9. Phase V.

---

## 18. Risks and edge cases

| Risk / edge case                                                   | Handling                                                                                                                                     |
| ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Attacker eliminated mid-flight; plane transferred to the conqueror | §5.3 step 3: delete plane, end strike, count as shot down (no intercept credit).                                                             |
| Launching airport destroyed/captured mid-flight                    | §5.7a: the plane continues and the strike lands; the airport can no longer launch; no refund.                                                |
| Target captured by the attacker or an ally mid-flight              | Hostility re-evaluated at impact/burst → no self/ally damage.                                                                                |
| Nuke detonation near a plane                                       | Existing loop deletes the plane → handled as destroyed.                                                                                      |
| Plane over impassable/water/fallout                                | Allowed; only owned land takes damage.                                                                                                       |
| Strafing exit beyond map edge                                      | Path and corridor clipped; remaining bursts applied at the end.                                                                              |
| Rocket with airport closer than 10 tiles                           | Release on the first tick at the airport tile.                                                                                               |
| `nearbyUnits` ordering                                             | Always re-sort by `(distSquared, id)` before damage.                                                                                         |
| SAM ammo bait (planes drain SAM missiles before nukes)             | Intentional tactic; nukes are scored above planes when both are due.                                                                         |
| SAM cache keyed by unit id                                         | Unchanged; planes use fresh ids.                                                                                                             |
| 400-tile ring invisible when larger than the screen                | Faint fill (§14.3) shows "inside coverage"; red strike shape + reason label outside.                                                         |
| AI performance with 400-tile ranges                                | Airport value uses one hostile-structure list per call (O(candidates × structures)); strike evaluation bounded (≤ ~40 candidates × 3 types). |
| Shared nation PRNG perturbation                                    | Adding draws changes nation decisions vs. the old build (acceptable; replays are exact-commit).                                              |
| Machine translations quality / Crowdin overwrite                   | Flag for review; documented.                                                                                                                 |
| `UnitIncomingUpdate.params` absent for nukes                       | Client falls back to the raw message.                                                                                                        |
| Menu stuck open                                                    | Single close function, self-heal in `tick()`, every UI-closing event routes to it.                                                           |
| Double launch                                                      | `launching` flag + engine `canBuild` re-check (second intent fails on cooldown).                                                             |
| Touch devices                                                      | Radial submenu path; DOM menu is touch-capable for tablets using the hotbar.                                                                 |
| Rockets not SAM-interceptable                                      | Documented V2 limitation (follow-up).                                                                                                        |
| Ships/trains under strikes                                         | Unaffected in V2 (follow-up: warship damage).                                                                                                |
| Plane vanishes at bomb/rocket release                              | V1 behavior kept; follow-up: egress flight back to base.                                                                                     |
| Replays lack airstrike FX                                          | Updates stored as "misc"; replay FX wiring is a follow-up.                                                                                   |

---

## 19. Acceptance criteria

1. Airport range is exactly 400 everywhere (config, preview ring, targeting,
   AI, help text, tests); airport costs 1M/+500k/max 2M; rearm 20 s.
2. Selecting a valid target never launches immediately; a menu (desktop) or
   radial submenu (right-click/touch) chooses Bombing / Rocket / Strafing;
   cancel always returns cleanly to targeting; no stuck state.
3. Bombing, Rocket and Strafing behave per §5/§9 with §3's numbers, never
   destroy land, and never hurt own/allied/teammate troops or buildings even
   when they overlap the effect area (§9.1).
4. Every strike's aircraft flies at 2 tiles per tick, rotates correctly, strafing planes exit
   past the target.
5. SAMs engage planes with 65 % / 50 % / 60 % hit chance per shot (bombing /
   rocket / strafing); hits and misses are deterministic and reported; nuke
   interception is unchanged. Intercepted strikes are not refunded and the
   airport still rearms normally; destroying an airport never destroys an
   aircraft already in flight.
6. Nations build airports (not on Easy) and launch all three strike types with
   sensible choices and without starving nukes.
7. Stats record airports and airstrike metrics; old records still parse.
8. Every new string is localized in all 41 locales; nothing user-visible is
   hardcoded English (the airstrike inbound warning included).
9. Sounds play for launch, flyby, impacts, gunfire, SAM launch/intercept,
   aircraft down; placeholders are clearly marked and license-clean.
10. Impact FX are visible for 1.5–3.5 s and distinct per strike type; gameplay
    timing is independent of rendering.
11. Snapshot round-trips are byte-identical mid-flight for every strike type;
    fixtures from earlier builds load; full scripted games stay deterministic.
12. `npm run typecheck`, `npm run lint`, `npx vitest --run` all pass; nothing
    committed or pushed; no dev server left running.

---

## 20. Final checklist (mechanical)

- [ ] P-1 baseline green, V1 confirmed unreleased
- [ ] A-1 UnitType + AirstrikeTypes + PlayerBuildable
- [ ] A-2 MessageType.AIRSTRIKE_RESULT
- [ ] A-3 GameUpdateType.AirstrikeImpact + UnitIncomingUpdate.params
- [ ] A-4 stats schema (airp, air, indices) appended
- [ ] B-1 Config: range 400, cooldown 200, `AIRSTRIKE_PLANE_SPEED` 2, airstrikeSpec (SAM 65/50/60), family disable
- [ ] B-2 AirstrikeGeometry + tests
- [ ] B-3 AirstrikeRules + tests
- [ ] E-1 costs (airport 1M/+500k/2M; 400k/350k/250k; selector = min)
- [ ] E-2/E-3 UnitParamsMap, displayIncomingUnit params
- [ ] E-4 PlayerImpl targeting via pickAirstrikeAirport
- [ ] E-5 UnitImpl stats switches include Airport
- [ ] E-6 Stats methods
- [ ] E-7 ConstructionExecution routes strike types; selector rejected
- [ ] E-8 AirstrikeExecution rewrite + AirstrikeDamage (`isAirstrikeVictim` filter before ordering/limits; §5.7a airport loss; §5.7b no refund)
- [ ] E-10/E-11 SAM targeting of planes, hit roll, miss path, SAMMissile v2
- [ ] E-12…E-16 engine tests
- [ ] S-1 ScriptedGame uses strike types
- [ ] N-1 airport placement; N-2 NationAirBehavior; N-3 Nation v2; N-4 tests
- [ ] C-1/C-2 render types, UnitPass, lights, telegraphs
- [ ] C-3 airport ring settings/fill/min stroke
- [ ] C-4 CorridorPreviewPass
- [ ] C-5 AirstrikeImpact FX pipeline + lifetimes
- [ ] C-6 `<airstrike-type-menu>` + icons
- [ ] C-7 InputHandler integration
- [ ] C-8 BuildPreviewController flow + previews
- [ ] C-9 radial submenu
- [ ] C-10 build panel
- [ ] C-11 hotbar text params
- [ ] C-12 EventsDisplay translation + colors
- [ ] C-13 audio cues + placeholders + CREDITS note
- [ ] C-14 FrameNormalizer routing
- [ ] C-15 stats UI
- [ ] C-16 help modal rows
- [ ] C-17 family toggle verified
- [ ] L-1 en.json (sorted, all keys used)
- [ ] L-2 all 40 other locales
- [ ] L-3 localization test
- [ ] V-1 typecheck/lint/prettier/tests green
- [ ] V-2 browser verification, dev server stopped
- [ ] V-3 final report (machine translations + placeholder audio flagged)
