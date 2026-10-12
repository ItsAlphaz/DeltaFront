import { TileRef } from "@openfront/engine-api/game/GameMap";
import {
  AirstrikeTypes,
  AirstrikeUnitType,
  Difficulty,
  PlayerType,
  Structures,
  UnitType,
} from "@openfront/engine-api/game/GameTypes";
import {
  airstrikeFlightPath,
  corridorBurstTiles,
  discTiles,
  strafingCorridor,
} from "@openfront/engine-lib/airstrike/AirstrikeGeometry";
import { airstrikeTroopLoss } from "@openfront/engine-lib/airstrike/AirstrikeRules";
import { PseudoRandom } from "@openfront/engine-lib/PseudoRandom";
import {
  readVersioned,
  snapshotType,
  Versioned,
  zInt,
  zTile,
} from "@openfront/engine-lib/snapshot/SnapshotType";
import { z } from "zod";
import { Game, Player } from "../../game/Game";
import type {
  SnapshotReader,
  SnapshotWriter,
} from "../../snapshot/SnapshotContext";
import {
  isAirstrikeVictim,
  strafeStructureCandidate,
  structureCandidates,
} from "../airstrike/AirstrikeDamage";
import { ConstructionExecution } from "../ConstructionExecution";
import { AiAttackBehavior } from "../utils/AiAttackBehavior";
import { EMOJI_NUKE, NationEmojiBehavior } from "./NationEmojiBehavior";
import { NationNukeBehavior } from "./NationNukeBehavior";
import { randTerritoryTileArray } from "./NationUtils";

/** Ticks a nation waits between airstrikes, by difficulty (Easy never strikes). */
export const AIR_MIN_GAP_TICKS: Record<Difficulty, number> = {
  [Difficulty.Easy]: Number.MAX_SAFE_INTEGER,
  [Difficulty.Medium]: 900,
  [Difficulty.Hard]: 450,
  [Difficulty.Impossible]: 250,
};
/** A nation only strikes while holding this multiple of the strike's price. */
export const AIR_GOLD_MULTIPLIER: Record<Difficulty, number> = {
  [Difficulty.Easy]: Infinity,
  [Difficulty.Medium]: 4,
  [Difficulty.Hard]: 3,
  [Difficulty.Impossible]: 2,
};
/** Hard and Impossible nations retaliate on a thinner margin. */
export const AIR_RETALIATION_GOLD_MULTIPLIER = 1.5;
/** Estimated value (gold) times survival, over price, a strike must reach. */
export const AIR_MIN_EFFICIENCY = 1.2;
/** Lowest chance of getting through enemy SAMs a nation will accept. */
export const AIR_MIN_SURVIVAL: Record<Difficulty, number> = {
  [Difficulty.Easy]: 1,
  [Difficulty.Medium]: 0,
  [Difficulty.Hard]: 0.6,
  [Difficulty.Impossible]: 0.4,
};
/** Gold a nation counts per troop (engine unit) a strike kills. */
export const AIR_TROOP_GOLD_VALUE = 1;
/** Gold a nation counts per level of a structure a strike removes. */
export const STRUCTURE_LEVEL_GOLD_VALUE: Partial<Record<UnitType, number>> = {
  [UnitType.MissileSilo]: 600_000,
  [UnitType.SAMLauncher]: 600_000,
  [UnitType.Airport]: 700_000,
  [UnitType.Factory]: 300_000,
  [UnitType.Port]: 250_000,
  [UnitType.City]: 250_000,
  [UnitType.DefensePost]: 100_000,
};
/** Bonus when a strike would take a structure all the way to level 0. */
export const AIR_DESTROY_BONUS = 1.5;
/**
 * A strafing run only hits whatever structure lies under its line (one at
 * most): its structure damage counts for half of a bomb's or rocket's.
 */
export const AIR_STRAFE_STRUCTURE_FACTOR = 0.5;
/** Bonus for a strafing run along the front when retaliating. */
export const AIR_STRAFE_FRONT_BONUS = 1.5;
export const AIR_RECENT_MEMORY_TICKS = 600;
export const AIR_RECENT_RADIUS = 15;
/** Random enemy territory tiles tried as targets, besides structures. */
export const AIR_RANDOM_CANDIDATES: Record<Difficulty, number> = {
  [Difficulty.Easy]: 0,
  [Difficulty.Medium]: 8,
  [Difficulty.Hard]: 12,
  [Difficulty.Impossible]: 24,
};
/** Border tiles tried as strafing targets when retaliating. */
const AIR_BORDER_CANDIDATES = 10;

/**
 * Nation airstrikes: when to launch, at what, and with which of the three
 * strikes. Chooses by estimated gold value (troops killed, structure levels
 * removed) times the chance of getting through enemy SAMs, over the price,
 * and never strikes without a rearmed airport, enough gold in hand, or a
 * worthwhile target. Uses the nation's shared seeded random generator.
 */
export class NationAirBehavior {
  private lastStrikeTick: number | null = null;
  private recentStrikes: [number, TileRef][] = [];
  private strikesLaunched = 0;

  constructor(
    private random: PseudoRandom,
    private game: Game,
    private player: Player,
    private attackBehavior: AiAttackBehavior,
    private nukeBehavior: NationNukeBehavior,
    private emojiBehavior: NationEmojiBehavior,
  ) {}

  snapshot(w: SnapshotWriter): Versioned {
    return w.versioned(NationAirBehaviorSnapshot, {
      lastStrikeTick: this.lastStrikeTick,
      recentStrikes: this.recentStrikes.map(([t, tile]) => [t, tile]),
      strikesLaunched: this.strikesLaunched,
    });
  }

  /** Fills a prototype-only shell; only assigns (see README). */
  restoreSnapshot(
    raw: unknown,
    r: SnapshotReader,
    random: PseudoRandom,
    player: Player,
    attackBehavior: AiAttackBehavior,
    nukeBehavior: NationNukeBehavior,
    emojiBehavior: NationEmojiBehavior,
  ): void {
    const s = readVersioned(NationAirBehaviorSnapshot, raw);
    this.random = random;
    this.game = r.game;
    this.player = player;
    this.attackBehavior = attackBehavior;
    this.nukeBehavior = nukeBehavior;
    this.emojiBehavior = emojiBehavior;
    this.lastStrikeTick = s.lastStrikeTick;
    this.recentStrikes = s.recentStrikes.map(([t, tile]) => [t, tile]);
    this.strikesLaunched = s.strikesLaunched;
  }

  private cost(type: AirstrikeUnitType): bigint {
    return this.game.unitInfo(type).cost(this.game, this.player);
  }

  /** Launches at most one airstrike, if one is clearly worth its price. */
  maybeLaunchAirstrike(): void {
    const game = this.game;
    const config = game.config();
    const { difficulty } = config.gameConfig();
    const ticks = game.ticks();
    if (
      difficulty === Difficulty.Easy ||
      config.isUnitDisabled(UnitType.Airport) ||
      config.isUnitDisabled(UnitType.Airstrike)
    ) {
      return;
    }
    const airports = this.player.units(UnitType.Airport);
    if (
      !airports.some(
        (a) => a.isActive() && !a.isUnderConstruction() && !a.isInCooldown(),
      )
    ) {
      return;
    }
    if (
      this.lastStrikeTick !== null &&
      ticks - this.lastStrikeTick < AIR_MIN_GAP_TICKS[difficulty]
    ) {
      return;
    }

    // Retaliation first, then whoever the nuke logic would go after.
    const incoming = this.attackBehavior.findIncomingAttackPlayer();
    const target = incoming ?? this.nukeBehavior.findBestNukeTarget();
    const retaliation = incoming !== null;
    if (
      target === null ||
      target.type() === PlayerType.Bot ||
      this.player.isFriendly(target, true) ||
      this.player.isOnSameTeam(target) ||
      this.attackBehavior.shouldAttack(target) === false
    ) {
      return;
    }

    const multiplier =
      retaliation &&
      (difficulty === Difficulty.Hard || difficulty === Difficulty.Impossible)
        ? AIR_RETALIATION_GOLD_MULTIPLIER
        : AIR_GOLD_MULTIPLIER[difficulty];
    const affordable = AirstrikeTypes.types.filter(
      (t) =>
        !config.isUnitDisabled(t) &&
        this.player.gold() >=
          (this.cost(t) * BigInt(Math.round(multiplier * 100))) / 100n,
    );
    if (affordable.length === 0) return;

    this.recentStrikes = this.recentStrikes.filter(
      ([t]) => ticks - t <= AIR_RECENT_MEMORY_TICKS,
    );

    let best: {
      type: AirstrikeUnitType;
      tile: TileRef;
      efficiency: number;
    } | null = null;
    for (const tile of this.candidateTiles(target, retaliation, difficulty)) {
      if (this.isRecentTarget(tile)) continue;
      // The selector answers "can any strike be launched here" (validity is
      // identical for the three types; only the price differs).
      if (this.player.canBuild(UnitType.Airstrike, tile) === false) continue;
      for (const type of affordable) {
        const src = this.player.canBuild(type, tile);
        if (src === false) continue;
        const survival =
          difficulty === Difficulty.Hard || difficulty === Difficulty.Impossible
            ? this.estimateSurvival(type, src, tile)
            : 1;
        if (survival < AIR_MIN_SURVIVAL[difficulty]) continue;
        const value = this.estimateValue(type, src, tile, retaliation);
        const efficiency = (value * survival) / Number(this.cost(type));
        if (best === null || efficiency > best.efficiency) {
          best = { type, tile, efficiency };
        }
      }
    }
    if (best === null || best.efficiency < AIR_MIN_EFFICIENCY) return;

    game.addExecution(
      new ConstructionExecution(this.player, best.type, best.tile),
    );
    this.lastStrikeTick = ticks;
    this.recentStrikes.push([ticks, best.tile]);
    this.strikesLaunched++;
    if (retaliation) this.emojiBehavior.maybeSendEmoji(target, EMOJI_NUKE);
  }

  /** Target tiles to evaluate, in a deterministic order, without repeats. */
  private candidateTiles(
    target: Player,
    retaliation: boolean,
    difficulty: Difficulty,
  ): TileRef[] {
    const tiles = new Set<TileRef>();
    for (const structure of target.units(Structures.types)) {
      tiles.add(structure.tile());
    }
    for (const t of randTerritoryTileArray(
      this.random,
      this.game,
      target,
      AIR_RANDOM_CANDIDATES[difficulty],
    )) {
      tiles.add(t);
    }
    if (retaliation) {
      // The border we share: where a strafing run does its work.
      let taken = 0;
      for (const t of target.borderTiles()) {
        if (taken >= AIR_BORDER_CANDIDATES) break;
        if (this.touchesOurLand(t)) {
          tiles.add(t);
          taken++;
        }
      }
    }
    return [...tiles];
  }

  private touchesOurLand(tile: TileRef): boolean {
    return this.game
      .neighbors(tile)
      .some((n) => this.game.owner(n) === this.player);
  }

  private isRecentTarget(tile: TileRef): boolean {
    const r2 = AIR_RECENT_RADIUS * AIR_RECENT_RADIUS;
    return this.recentStrikes.some(
      ([, t]) => this.game.euclideanDistSquared(tile, t) <= r2,
    );
  }

  /** Gold value of what a strike of this type would do at `tile` right now (reads only). */
  private estimateValue(
    type: AirstrikeUnitType,
    src: TileRef,
    tile: TileRef,
    retaliation: boolean,
  ): number {
    const game = this.game;
    const spec = game.config().airstrikeSpec(type);
    const troopValue = (tiles: readonly TileRef[]): number => {
      const hit = new Map<Player, number>();
      for (const t of tiles) {
        const owner = game.owner(t);
        if (!isAirstrikeVictim(this.player, owner)) continue;
        hit.set(owner, (hit.get(owner) ?? 0) + 1);
      }
      let sum = 0;
      for (const [owner, n] of hit) {
        sum +=
          airstrikeTroopLoss(spec, owner.troops(), n, owner.numTilesOwned()) *
          AIR_TROOP_GOLD_VALUE;
      }
      return sum;
    };
    const levelValue = (
      unit: { type(): UnitType; level(): number },
      levels: number,
    ): number => {
      const removed = Math.min(levels, unit.level());
      const base = STRUCTURE_LEVEL_GOLD_VALUE[unit.type()] ?? 0;
      return base * removed * (unit.level() <= levels ? AIR_DESTROY_BONUS : 1);
    };

    if (type !== UnitType.StrafingRun) {
      let value = troopValue(discTiles(game, tile, spec.radius));
      for (const unit of structureCandidates(
        game,
        this.player,
        tile,
        spec.structureRadius,
      ).slice(0, spec.maxStructures)) {
        value += levelValue(unit, spec.structureLevels);
      }
      return value;
    }

    const corridor = strafingCorridor(game, src, tile, spec);
    let value = 0;
    let structureHit = false;
    let alongOurFront = false;
    for (let k = 0; k < corridor.bursts; k++) {
      const tiles = corridorBurstTiles(game, corridor, k);
      value += troopValue(tiles);
      if (retaliation && !alongOurFront) {
        alongOurFront = tiles.some((t) => this.touchesOurLand(t));
      }
      if (!structureHit) {
        const unit = strafeStructureCandidate(
          game,
          this.player,
          corridor,
          k,
          spec,
        );
        if (unit !== null) {
          value +=
            levelValue(unit, spec.structureLevels) *
            AIR_STRAFE_STRUCTURE_FACTOR;
          structureHit = true;
        }
      }
    }
    return alongOurFront ? value * AIR_STRAFE_FRONT_BONUS : value;
  }

  /** Chance the aircraft gets through every ready enemy SAM covering its route. */
  private estimateSurvival(
    type: AirstrikeUnitType,
    src: TileRef,
    tile: TileRef,
  ): number {
    const game = this.game;
    const config = game.config();
    const spec = config.airstrikeSpec(type);
    const path = airstrikeFlightPath(
      game,
      src,
      tile,
      type,
      spec,
      config.airstrikePlaneSpeed(),
    );
    if (path.length === 0) return 1;
    // Every 4th tile and the last: close enough, and cheap.
    const sampled = path.filter((_, i) => i % 4 === 0 || i === path.length - 1);
    let survival = 1;
    for (const sam of game.units(UnitType.SAMLauncher)) {
      if (
        !sam.isActive() ||
        sam.isUnderConstruction() ||
        sam.isInCooldown() ||
        this.player.isFriendly(sam.owner(), true)
      ) {
        continue;
      }
      const range = config.samRange(sam.level());
      const covered = sampled.some(
        (t) => game.euclideanDistSquared(t, sam.tile()) <= range * range,
      );
      if (covered) survival *= 1 - spec.samHitPercent / 100;
    }
    return survival;
  }
}

export const NationAirBehaviorSnapshot = snapshotType({
  name: "NationAirBehavior",
  version: 1,
  schema: z.object({
    lastStrikeTick: zInt().nullable(),
    recentStrikes: z.array(z.tuple([zInt(), zTile()])),
    strikesLaunched: zInt(),
  }),
});
