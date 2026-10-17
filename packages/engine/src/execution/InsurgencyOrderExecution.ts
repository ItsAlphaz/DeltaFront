import { MessageType } from "@openfront/engine-api/game/GameTypes";
import { zInt, zPlayerRef } from "@openfront/engine-lib/snapshot/SnapshotType";
import { z } from "zod";
import { Execution, Game, Player } from "../game/Game";
import type { Reject } from "../game/InsurgencySystem";
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
const REJECT_MESSAGES: Record<Reject, string> = {
  inactive: "events_display.insurgency_reject_inactive",
  region: "events_display.insurgency_reject_region",
  not_occupied: "events_display.insurgency_reject_not_occupied",
  unrest: "events_display.insurgency_reject_unrest",
  funds: "events_display.insurgency_reject_funds",
  capacity: "events_display.insurgency_reject_capacity",
  troops: "events_display.insurgency_reject_troops",
  limit: "events_display.insurgency_reject_limit",
  cooldown: "events_display.insurgency_reject_cooldown",
  tile: "events_display.insurgency_reject_tile",
  no_location: "events_display.insurgency_reject_no_location",
  target: "events_display.insurgency_reject_target",
  busy: "events_display.insurgency_reject_busy",
};

/** An order of the insurgency (docs/Insurgency.md), as an intent carries it. */
export type InsurgencyOrder =
  | { kind: "recruit"; troops: number }
  | { kind: "base"; tile: number }
  | { kind: "uprising"; region: number; troops: number }
  | { kind: "intel"; region: number }
  | { kind: "suppress"; target: string; region: number };

/**
 * One order, applied the moment it is read. InsurgencySystem checks everything
 * (that the sender has a resistance, the costs, limits and cooldowns, the
 * region and the troops) and charges nothing for an order it refuses. The
 * sender is told why: it may be a race with another order in the same turn.
 */
export class InsurgencyOrderExecution implements Execution {
  constructor(
    private player: Player,
    private order: InsurgencyOrder,
  ) {}

  init(mg: Game, _: number): void {
    const system = mg.insurgency();
    if (system === null) return;
    let rejected: Reject | null;
    switch (this.order.kind) {
      case "recruit":
        rejected = system.recruit(this.player, this.order.troops);
        break;
      case "base":
        rejected = system.foundBase(this.player, this.order.tile);
        break;
      case "uprising":
        rejected = system.uprising(
          this.player,
          this.order.region,
          this.order.troops,
        );
        break;
      case "intel":
        rejected = system.intel(this.player, this.order.region);
        break;
      case "suppress": {
        // The target is a player id; one that does not exist is no order at all.
        rejected = mg.hasPlayer(this.order.target)
          ? system.suppress(
              this.player,
              mg.player(this.order.target),
              this.order.region,
            )
          : "target";
        break;
      }
    }
    if (rejected !== null) {
      mg.displayMessage(
        REJECT_MESSAGES[rejected],
        MessageType.INSURGENCY_ORDER,
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
    return InsurgencyOrderExecutionSnapshot.write({
      player: w.player(this.player),
      order: this.order,
    });
  }

  restoreSnapshot(s: InsurgencyOrderState, r: SnapshotReader): void {
    this.player = r.player(s.player);
    this.order = s.order;
  }
}

const InsurgencyOrderStateSchema = z.object({
  player: zPlayerRef(),
  order: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("recruit"), troops: zInt() }),
    z.object({ kind: z.literal("base"), tile: zInt() }),
    z.object({
      kind: z.literal("uprising"),
      region: zInt(),
      troops: zInt(),
    }),
    z.object({ kind: z.literal("intel"), region: zInt() }),
    z.object({
      kind: z.literal("suppress"),
      target: z.string(),
      region: zInt(),
    }),
  ]),
});
type InsurgencyOrderState = z.infer<typeof InsurgencyOrderStateSchema>;

export const InsurgencyOrderExecutionSnapshot = execSnapshotType({
  name: "InsurgencyOrder",
  version: 1,
  schema: InsurgencyOrderStateSchema,
  cls: () => InsurgencyOrderExecution,
});
