import { TileRef } from "@openfront/engine-api/game/GameMap";
import {
  zPlayerRef,
  zTile,
} from "@openfront/engine-lib/snapshot/SnapshotType";
import { z } from "zod";
import { Execution, Game, Player } from "../game/Game";
import { execSnapshotType } from "../snapshot/ExecutionSnapshot";
import type {
  ExecRecord,
  SnapshotReader,
  SnapshotWriter,
} from "../snapshot/SnapshotContext";

/**
 * A player's order to found a replacement capital at `tile`. The Capital System
 * decides everything (the match setting, that the player has no capital, owns
 * the tile off the front line, can pay and has waited): an order that fails any
 * check does nothing, charges nothing, and does so the same way on every client.
 */
export class FoundCapitalExecution implements Execution {
  constructor(
    private player: Player,
    private tile: TileRef,
  ) {}

  init(mg: Game, _: number): void {
    const capitals = mg.capitals();
    if (capitals === null) return;
    if (!capitals.found(this.player, this.tile)) {
      console.warn(
        `${this.player.displayName()} cannot found a capital at ${this.tile}: ${capitals.foundBlock(this.player, this.tile)}`,
      );
    }
  }

  tick(_: number): void {}

  isActive(): boolean {
    return false;
  }

  activeDuringSpawnPhase(): boolean {
    return false;
  }

  snapshot(w: SnapshotWriter): ExecRecord {
    return FoundCapitalExecutionSnapshot.write({
      player: w.player(this.player),
      tile: this.tile,
    });
  }

  restoreSnapshot(s: FoundCapitalState, r: SnapshotReader): void {
    this.player = r.player(s.player);
    this.tile = s.tile;
  }
}

const FoundCapitalStateSchema = z.object({
  player: zPlayerRef(),
  tile: zTile(),
});
type FoundCapitalState = z.infer<typeof FoundCapitalStateSchema>;

export const FoundCapitalExecutionSnapshot = execSnapshotType({
  name: "FoundCapital",
  version: 1,
  schema: FoundCapitalStateSchema,
  cls: () => FoundCapitalExecution,
});
