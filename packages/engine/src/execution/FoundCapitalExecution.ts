import { TileRef } from "@openfront/engine-api/game/GameMap";
import { MessageType } from "@openfront/engine-api/game/GameTypes";
import { zPlayerRef, zTile } from "@openfront/engine-lib/snapshot/SnapshotType";
import { z } from "zod";
import type { FoundBlock } from "../game/CapitalSystem";
import { Execution, Game, Player } from "../game/Game";
import { execSnapshotType } from "../snapshot/ExecutionSnapshot";
import type {
  ExecRecord,
  SnapshotReader,
  SnapshotWriter,
} from "../snapshot/SnapshotContext";

/**
 * What a refused order tells its sender. Literal keys (not built from the
 * reason) so the translation check can see that each one is used, and a new
 * reason cannot be added without its message.
 */
const REFUSAL_MESSAGES: Record<FoundBlock, string> = {
  not_a_holder: "events_display.capital_found_not_a_holder",
  spawn_phase: "events_display.capital_found_spawn_phase",
  dead: "events_display.capital_found_dead",
  has_capital: "events_display.capital_found_has_capital",
  building: "events_display.capital_found_building",
  too_soon: "events_display.capital_found_too_soon",
  gold: "events_display.capital_found_gold",
  tile: "events_display.capital_found_tile",
  not_owned: "events_display.capital_found_not_owned",
  border: "events_display.capital_found_border",
};

/**
 * A player's order to buy a capital (the first or a replacement) at `tile`. The Capital System
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
    // found() checks everything again and charges only if it succeeds. The
    // reason is read first: a successful order changes the answer.
    const block = capitals.foundBlock(this.player, this.tile);
    if (!capitals.found(this.player, this.tile) && block !== null) {
      mg.displayMessage(
        REFUSAL_MESSAGES[block],
        MessageType.CAPITAL_ORDER,
        this.player.id(),
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
