import { TileRef } from "@openfront/engine-api/game/GameMap";
import {
  AirstrikeUnitType,
  MessageType,
  UnitType,
} from "@openfront/engine-api/game/GameTypes";
import {
  AirstrikeImpactPhase,
  GameUpdateType,
} from "@openfront/engine-api/game/GameUpdates";
import {
  airstrikeFlightPath,
  burstTriggerSteps,
  Corridor,
  corridorBurstTiles,
  corridorEdge,
  corridorTiles,
  discTiles,
  strafingCorridor,
} from "@openfront/engine-lib/airstrike/AirstrikeGeometry";
import { renderTroops } from "@openfront/engine-lib/Format";
import {
  zInt,
  zNum,
  zPlayerRef,
  zRef,
  zTile,
} from "@openfront/engine-lib/snapshot/SnapshotType";
import { z } from "zod";
import { Execution, Game, Player, Unit } from "../game/Game";
import { UnitTypeSchema } from "../snapshot/CommonSchemas";
import { execSnapshotType } from "../snapshot/ExecutionSnapshot";
import type {
  ExecRecord,
  SnapshotReader,
  SnapshotWriter,
} from "../snapshot/SnapshotContext";
import {
  applyStructureDamage,
  applyTroopDamage,
  DamageTotal,
  isAirstrikeVictim,
  strafeStructureCandidate,
  structureCandidates,
} from "./airstrike/AirstrikeDamage";

const STRIKE_TRANSLATION_KEYS: Record<AirstrikeUnitType, string> = {
  [UnitType.BombingRun]: "unit_type.bombing_run",
  [UnitType.RocketStrike]: "unit_type.rocket_strike",
  [UnitType.StrafingRun]: "unit_type.strafing_run",
};

/** Translation key of a strike type's name (for events and messages). */
export function airstrikeTranslationKey(type: AirstrikeUnitType): string {
  return STRIKE_TRANSLATION_KEYS[type];
}

type Phase = "pending" | "flying" | "rockets" | "done";

/**
 * One airstrike, from the order to its last effect.
 *
 * The strike is paid and the airport starts rearming at launch; a plane flies
 * a straight line from the nearest ready airport at AIRSTRIKE_PLANE_SPEED and
 * can be shot down on the way (the strike is then not refunded). What happens
 * on arrival depends on the strike:
 *  - Bombing Run: bombs the target area, then the plane is gone.
 *  - Rocket Strike: releases rockets 10 tiles short of the target, which land
 *    3 ticks later in a small area.
 *  - Strafing Run: flies on through the target, hitting a narrow corridor in
 *    four timed bursts, and leaves past the far end.
 * Troops of hostile players are killed and structures lose levels (never land),
 * through the existing level-loss path. Allies, teammates and the attacker are
 * never hurt, and the airport is only read at launch: destroying it afterwards
 * does not stop a plane already in the air.
 */
export class AirstrikeExecution implements Execution {
  private active = true;
  private mg: Game;
  private phase: Phase = "pending";
  private plane: Unit | null = null;
  /** Launching airport's tile. */
  private src: TileRef | null = null;
  /** Number of path tiles flown. */
  private step = 0;
  private burstsApplied = 0;
  private impactTick: number | null = null;
  private releaseTile: TileRef | null = null;
  private totals: DamageTotal[] = [];
  private destroyed = 0;

  // Derived from src, dst, strikeType and the config; recomputed on restore.
  private path: TileRef[] = [];
  private corridor: Corridor | null = null;
  private burstSteps: number[] = [];

  constructor(
    private player: Player,
    private dst: TileRef,
    private strikeType: AirstrikeUnitType,
  ) {}

  init(mg: Game, ticks: number): void {
    this.mg = mg;
  }

  tick(ticks: number): void {
    switch (this.phase) {
      case "pending":
        this.launch(ticks);
        return;
      case "rockets":
        if (this.mg.ticks() >= this.impactTick!) {
          this.impact(
            AirstrikeImpactPhase.RocketImpact,
            this.releaseTile ?? this.dst,
          );
          this.finish(true);
        }
        return;
      case "done":
        this.active = false;
        return;
      case "flying":
        this.fly();
        return;
    }
  }

  private spec() {
    return this.mg.config().airstrikeSpec(this.strikeType);
  }

  private deriveRoute(): void {
    if (this.src === null) return;
    const config = this.mg.config();
    const spec = this.spec();
    this.path = airstrikeFlightPath(
      this.mg,
      this.src,
      this.dst,
      this.strikeType,
      spec,
      config.airstrikePlaneSpeed(),
    );
    if (this.strikeType === UnitType.StrafingRun) {
      this.corridor = strafingCorridor(this.mg, this.src, this.dst, spec);
      this.burstSteps = burstTriggerSteps(this.mg, this.path, this.corridor);
    }
  }

  private launch(ticks: number): void {
    const spawn = this.player.canBuild(this.strikeType, this.dst);
    if (spawn === false) {
      console.warn(`cannot launch ${this.strikeType}`);
      this.active = false;
      return;
    }
    this.src = spawn;
    this.deriveRoute();

    // The trajectory starts at the airport, like a nuke's, so the plane's
    // trajectory index and the tick it reaches each tile line up for SAMs.
    const trajectory = [spawn, ...this.path].map((tile) => ({
      tile,
      targetable: true,
    }));
    // Charges the strike. From here on it is spent: an intercepted plane is
    // not refunded, and the airport rearms whatever happens to the plane.
    this.plane = this.player.buildUnit(this.strikeType, spawn, {
      targetTile: this.dst,
      trajectory,
    });
    if (this.path.length > 0) {
      this.mg.recordMotionPlan({
        kind: "grid",
        unitId: this.plane.id(),
        planId: 1,
        startTick: ticks + 1,
        ticksPerStep: 1,
        path: [spawn, ...this.path],
      });
    }
    this.player
      .units(UnitType.Airport)
      .find((a) => a.tile() === spawn)
      ?.launch();
    this.mg.stats().airLaunch(this.player, this.strikeType);

    for (const victim of this.threatenedPlayers()) {
      this.mg.displayIncomingUnit(
        this.plane.id(),
        "events_display.airstrike_inbound",
        MessageType.AIRSTRIKE_INBOUND,
        victim.id(),
        {
          name: this.player.displayName(),
          unit: airstrikeTranslationKey(this.strikeType),
        },
      );
    }
    this.phase = "flying";
  }

  /** Players warned of the strike: the target's owner, or every owner under a strafing corridor. */
  private threatenedPlayers(): Player[] {
    const tiles =
      this.corridor !== null
        ? corridorTiles(this.mg, this.corridor)
        : [this.dst];
    const seen = new Set<Player>();
    for (const tile of tiles) {
      const owner = this.mg.owner(tile);
      if (isAirstrikeVictim(this.player, owner)) seen.add(owner);
    }
    return [...seen];
  }

  private fly(): void {
    const plane = this.plane!;
    if (plane.type() === UnitType.Airstrike) {
      // A plane of the first single-type airstrike (a migrated v1 record):
      // it has no trajectory to fly, so retire it quietly.
      if (plane.isActive()) plane.delete(false);
      this.phase = "done";
      this.active = false;
      return;
    }
    if (!plane.isActive()) {
      this.onLost();
      return;
    }
    if (plane.owner() !== this.player) {
      // The attacker was eliminated and its plane captured: the strike ends.
      plane.delete(false);
      this.onLost();
      return;
    }

    if (this.step < this.path.length) {
      plane.move(this.path[this.step]);
      this.step++;
      plane.setTrajectoryIndex(this.step);
    }

    if (this.corridor !== null) {
      while (
        this.burstsApplied < this.corridor.bursts &&
        this.step >= 1 &&
        this.step - 1 >= this.burstSteps[this.burstsApplied]
      ) {
        this.strafeBurst(this.burstsApplied);
        this.burstsApplied++;
      }
    }

    if (this.step < this.path.length) return;

    // Arrived at the end of the flight.
    switch (this.strikeType) {
      case UnitType.BombingRun:
        this.impact(AirstrikeImpactPhase.BombImpact, this.dst);
        this.landPlane();
        this.finish(true);
        return;
      case UnitType.RocketStrike:
        this.releaseTile = plane.tile();
        this.emitImpact(
          AirstrikeImpactPhase.RocketRelease,
          this.releaseTile,
          this.dst,
          this.spec().radius,
          [],
        );
        this.landPlane();
        this.impactTick = this.mg.ticks() + this.spec().rocketFlightTicks;
        this.phase = "rockets";
        return;
      case UnitType.StrafingRun:
        // A corridor clipped by the map edge may leave bursts unfired.
        while (this.burstsApplied < this.corridor!.bursts) {
          this.strafeBurst(this.burstsApplied);
          this.burstsApplied++;
        }
        this.landPlane();
        this.finish(true);
        return;
    }
  }

  /** The aircraft has delivered its attack: remove it without a destruction event. */
  private landPlane(): void {
    const plane = this.plane!;
    plane.setReachedTarget();
    plane.delete(false);
  }

  /** A bomb blast or rocket impact centred on the target. */
  private impact(phase: AirstrikeImpactPhase, from: TileRef): void {
    const spec = this.spec();
    const affected = applyTroopDamage(
      this.mg,
      this.player,
      discTiles(this.mg, this.dst, spec.radius),
      spec,
      this.totals,
    );
    const structures = applyStructureDamage(
      this.player,
      structureCandidates(this.mg, this.player, this.dst, spec.structureRadius),
      spec,
      this.totals,
    );
    this.destroyed += structures.destroyed;
    this.emitImpact(phase, from, this.dst, spec.radius, [
      ...new Set([...affected, ...structures.affected]),
    ]);
  }

  private strafeBurst(burst: number): void {
    const corridor = this.corridor!;
    const spec = this.spec();
    const affected = applyTroopDamage(
      this.mg,
      this.player,
      corridorBurstTiles(this.mg, corridor, burst),
      spec,
      this.totals,
    );
    // At most one structure over the whole run.
    if (!this.hitStructure()) {
      const target = strafeStructureCandidate(
        this.mg,
        this.player,
        corridor,
        burst,
        spec,
      );
      if (target !== null) {
        const dmg = applyStructureDamage(
          this.player,
          [target],
          spec,
          this.totals,
        );
        this.destroyed += dmg.destroyed;
        affected.push(...dmg.affected);
      }
    }
    const segTile = (s: number): TileRef =>
      this.mg.ref(
        Math.min(
          this.mg.width() - 1,
          Math.max(0, Math.round(corridor.sx + corridor.ux * s)),
        ),
        Math.min(
          this.mg.height() - 1,
          Math.max(0, Math.round(corridor.sy + corridor.uy * s)),
        ),
      );
    this.emitImpact(
      AirstrikeImpactPhase.StrafeBurst,
      segTile(corridorEdge(corridor, burst)),
      segTile(corridorEdge(corridor, burst + 1)),
      spec.radius,
      [...new Set(affected)],
    );
  }

  /** Whether a structure of any victim has already been damaged this run. */
  private hitStructure(): boolean {
    return this.totals.some((t) => t[2] > 0);
  }

  private emitImpact(
    phase: AirstrikeImpactPhase,
    from: TileRef,
    to: TileRef,
    radius: number,
    affected: number[],
  ): void {
    this.mg.addUpdate({
      type: GameUpdateType.AirstrikeImpact,
      strikeType: this.strikeType,
      attackerID: this.player.smallID(),
      phase,
      from,
      to,
      radius,
      affected,
    });
  }

  /** The plane was destroyed (SAM, nuke blast, owner eliminated) before finishing. */
  private onLost(): void {
    this.mg.stats().airShotDown(this.player, this.strikeType);
    this.mg.displayMessage(
      "events_display.aircraft_shot_down",
      MessageType.UNIT_DESTROYED,
      this.player.id(),
      undefined,
      { unit: airstrikeTranslationKey(this.strikeType) },
    );
    this.finish(false);
  }

  /** Reports the damage dealt (also what a strafing run did before it was shot down). */
  private finish(complete: boolean): void {
    const unit = airstrikeTranslationKey(this.strikeType);
    let killed = 0;
    let levels = 0;
    for (const [smallID, k, l] of this.totals) {
      killed += k;
      levels += l;
      const victim = this.mg.playerBySmallID(smallID);
      if (!victim.isPlayer()) continue;
      const params = {
        name: this.player.displayName(),
        unit,
      };
      if (k > 0) {
        this.mg.displayMessage(
          "events_display.airstrike_hit",
          MessageType.AIRSTRIKE_HIT,
          victim.id(),
          undefined,
          { ...params, troops: renderTroops(k) },
          undefined,
          this.player.id(),
        );
      }
      if (l > 0) {
        this.mg.displayMessage(
          "events_display.airstrike_buildings_hit",
          MessageType.AIRSTRIKE_HIT,
          victim.id(),
          undefined,
          { ...params, count: l },
          undefined,
          this.player.id(),
        );
      }
    }
    if (complete || killed > 0 || levels > 0) {
      this.mg.displayMessage(
        "events_display.airstrike_result",
        MessageType.AIRSTRIKE_RESULT,
        this.player.id(),
        undefined,
        { unit, troops: renderTroops(killed), count: levels },
      );
    }
    const stats = this.mg.stats();
    if (killed > 0) stats.airTroopsKilled(this.player, this.strikeType, killed);
    if (levels > 0) {
      stats.airStructureDamage(
        this.player,
        this.strikeType,
        levels,
        this.destroyed,
      );
    }
    if (complete) stats.airComplete(this.player, this.strikeType);
    this.phase = "done";
    this.active = false;
  }

  isActive(): boolean {
    return this.active;
  }

  activeDuringSpawnPhase(): boolean {
    return false;
  }

  snapshot(w: SnapshotWriter): ExecRecord {
    return AirstrikeExecutionSnapshot.write({
      active: this.active,
      initialized: this.mg !== undefined,
      phase: this.phase,
      plane: w.unitOrNull(this.plane),
      player: w.player(this.player),
      strikeType: this.strikeType,
      dst: this.dst,
      src: this.src,
      step: this.step,
      burstsApplied: this.burstsApplied,
      impactTick: this.impactTick,
      releaseTile: this.releaseTile,
      totals: this.totals.map(([id, k, l]) => [id, k, l]),
      destroyed: this.destroyed,
    });
  }

  restoreSnapshot(s: AirstrikeState, r: SnapshotReader): void {
    this.active = s.active;
    if (s.initialized) this.mg = r.game;
    this.phase = s.phase;
    this.plane = r.unitOrNull(s.plane);
    this.player = r.player(s.player);
    this.strikeType = s.strikeType as AirstrikeUnitType;
    this.dst = s.dst;
    this.src = s.src;
    this.step = s.step;
    this.burstsApplied = s.burstsApplied;
    this.impactTick = s.impactTick;
    this.releaseTile = s.releaseTile;
    this.totals = s.totals.map(([id, k, l]) => [id, k, l]);
    this.destroyed = s.destroyed;
    this.path = [];
    this.corridor = null;
    this.burstSteps = [];
    if (s.initialized && s.src !== null) this.deriveRoute();
  }
}

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
type AirstrikeState = z.infer<typeof AirstrikeStateSchema>;

export const AirstrikeExecutionSnapshot = execSnapshotType({
  name: "Airstrike",
  version: 2,
  schema: AirstrikeStateSchema,
  migrations: {
    // v1 was the single-type, bomb-only airstrike of the first (local) build:
    // the plane was an `Airstrike` unit and the effect had no phases. Carry
    // the record forward as a bombing run; a v1 plane is retired below.
    1: (d) => ({
      ...d,
      phase: d.active ? (d.plane === null ? "pending" : "flying") : "done",
      strikeType: UnitType.BombingRun,
      burstsApplied: 0,
      impactTick: null,
      releaseTile: null,
      totals: [],
      destroyed: 0,
    }),
  },
  cls: () => AirstrikeExecution,
});
