import { TileRef } from "@openfront/engine-api/game/GameMap";
import { MessageType, UnitType } from "@openfront/engine-api/game/GameTypes";
import { renderTroops } from "@openfront/engine-lib/Format";
import {
  zInt,
  zPlayerRef,
  zRef,
  zTile,
} from "@openfront/engine-lib/snapshot/SnapshotType";
import { z } from "zod";
import { Execution, Game, Player, Unit } from "../game/Game";
import { execSnapshotType } from "../snapshot/ExecutionSnapshot";
import type {
  ExecRecord,
  SnapshotReader,
  SnapshotWriter,
} from "../snapshot/SnapshotContext";

/**
 * Flies an Airstrike plane in a straight line from the player's nearest armed
 * Airport to the target and kills a share of the troops of every non-friendly
 * player holding land inside the strike radius. Unlike a nuke it destroys no
 * tiles or structures: it is a tactical tool to soften a front, not to erase it.
 */
export class AirstrikeExecution implements Execution {
  private active = true;
  private mg: Game;
  private plane: Unit | null = null;
  private src: TileRef | null = null;
  // Straight-line flight path from src (exclusive) to dst (inclusive),
  // derived from src, dst and speed, so it is not stored in snapshots.
  private path: TileRef[] = [];
  private step = 0;

  constructor(
    private player: Player,
    private dst: TileRef,
  ) {}

  init(mg: Game, ticks: number): void {
    this.mg = mg;
  }

  tick(ticks: number): void {
    if (this.plane === null) {
      this.launch(ticks);
      return;
    }

    if (!this.plane.isActive()) {
      this.active = false;
      return;
    }

    const next = this.path[this.step];
    this.step++;
    this.plane.move(next);
    if (this.step >= this.path.length) {
      this.strike();
    }
  }

  private launch(ticks: number): void {
    const spawn = this.player.canBuild(UnitType.Airstrike, this.dst);
    if (spawn === false) {
      console.warn(`cannot launch airstrike`);
      this.active = false;
      return;
    }
    const airport = this.player
      .units(UnitType.Airport)
      .find((a) => a.tile() === spawn);
    this.src = spawn;
    this.path = flightPath(
      this.mg,
      spawn,
      this.dst,
      this.mg.config().airstrikeSpeed(),
    );
    this.plane = this.player.buildUnit(UnitType.Airstrike, spawn, {
      targetTile: this.dst,
    });
    this.mg.recordMotionPlan({
      kind: "grid",
      unitId: this.plane.id(),
      planId: 1,
      startTick: ticks + 1,
      ticksPerStep: 1,
      path: [spawn, ...this.path],
    });
    airport?.launch();

    const target = this.mg.owner(this.dst);
    if (target.isPlayer()) {
      this.mg.displayIncomingUnit(
        this.plane.id(),
        // Matches the nuke inbound warnings, which are not translated yet.
        `${this.player.displayName()} - airstrike inbound`,
        MessageType.AIRSTRIKE_INBOUND,
        target.id(),
      );
    }
  }

  private strike(): void {
    const mg = this.mg;
    const config = mg.config();
    const radius = config.airstrikeRadius();
    const radius2 = radius * radius;
    const cx = mg.x(this.dst);
    const cy = mg.y(this.dst);

    // Tiles hit per player, in tile-scan order so the result is deterministic.
    const tilesHit = new Map<Player, number>();
    const x0 = Math.max(0, cx - radius);
    const y0 = Math.max(0, cy - radius);
    const x1 = Math.min(mg.width() - 1, cx + radius);
    const y1 = Math.min(mg.height() - 1, cy + radius);
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const dx = x - cx;
        const dy = y - cy;
        if (dx * dx + dy * dy > radius2) continue;
        const owner = mg.owner(mg.ref(x, y));
        // Alliances can change mid-flight: only hit who is hostile now.
        if (
          !owner.isPlayer() ||
          owner === this.player ||
          this.player.isFriendly(owner)
        ) {
          continue;
        }
        tilesHit.set(owner, (tilesHit.get(owner) ?? 0) + 1);
      }
    }

    for (const [target, hit] of tilesHit) {
      const killed = config.airstrikeTroopLoss(
        target.troops(),
        hit,
        target.numTilesOwned(),
      );
      target.removeTroops(killed);
      mg.displayMessage(
        "events_display.airstrike_hit",
        MessageType.AIRSTRIKE_HIT,
        target.id(),
        undefined,
        { name: this.player.displayName(), troops: renderTroops(killed) },
        undefined,
        this.player.id(),
      );
    }

    this.active = false;
    this.plane!.setReachedTarget();
    this.plane!.delete(false);
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
      plane: w.unitOrNull(this.plane),
      player: w.player(this.player),
      dst: this.dst,
      src: this.src,
      step: this.step,
    });
  }

  restoreSnapshot(s: AirstrikeState, r: SnapshotReader): void {
    this.active = s.active;
    if (s.initialized) this.mg = r.game;
    this.plane = r.unitOrNull(s.plane);
    this.player = r.player(s.player);
    this.dst = s.dst;
    this.src = s.src;
    this.step = s.step;
    if (this.src !== null) {
      this.path = flightPath(
        r.game,
        this.src,
        this.dst,
        r.game.config().airstrikeSpeed(),
      );
    }
  }
}

/**
 * Tiles a plane passes through flying `speed` tiles per tick from src to dst,
 * one per tick, ending exactly on dst.
 */
export function flightPath(
  mg: Game,
  src: TileRef,
  dst: TileRef,
  speed: number,
): TileRef[] {
  const sx = mg.x(src);
  const sy = mg.y(src);
  const dx = mg.x(dst) - sx;
  const dy = mg.y(dst) - sy;
  const steps = Math.max(
    1,
    Math.ceil(Math.sqrt(dx * dx + dy * dy) / Math.max(1, speed)),
  );
  const path: TileRef[] = [];
  for (let i = 1; i <= steps; i++) {
    path.push(
      mg.ref(
        sx + Math.round((dx * i) / steps),
        sy + Math.round((dy * i) / steps),
      ),
    );
  }
  return path;
}

const AirstrikeStateSchema = z.object({
  active: z.boolean(),
  initialized: z.boolean(),
  plane: zRef().nullable(),
  player: zPlayerRef(),
  dst: zTile(),
  src: zTile().nullable(),
  step: zInt(),
});
type AirstrikeState = z.infer<typeof AirstrikeStateSchema>;

export const AirstrikeExecutionSnapshot = execSnapshotType({
  name: "Airstrike",
  version: 1,
  schema: AirstrikeStateSchema,
  cls: () => AirstrikeExecution,
});
