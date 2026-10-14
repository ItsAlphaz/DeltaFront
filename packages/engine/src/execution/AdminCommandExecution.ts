import {
  ADMIN_COMMAND_MAX_AMOUNT,
  ADMIN_COMMANDS,
  type AdminCommand,
} from "@openfront/engine-api/AdminCommands";
import { GameMode, PlayerID } from "@openfront/engine-api/game/GameTypes";
import { toInt } from "@openfront/engine-lib/Util";
import { zPlayerRef } from "@openfront/engine-lib/snapshot/SnapshotType";
import { z } from "zod";
import { Execution, Game, Player } from "../game/Game";
import { execSnapshotType } from "../snapshot/ExecutionSnapshot";
import type {
  ExecRecord,
  SnapshotReader,
  SnapshotWriter,
} from "../snapshot/SnapshotContext";

/**
 * A staff testing command applied to one player: change gold or troops,
 * eliminate them, or force a winner.
 *
 * The engine has no idea who is allowed to do this. The game server checks the
 * sender's permission for the command (Permissions.ts ADMIN_COMMAND_PERMISSION)
 * before it relays the intent, and refuses it otherwise, so by the time an
 * execution exists the command was authorized. It then runs identically on every
 * client, like any other intent, and is recorded with the game.
 *
 * Instant (one init, no ticks). Amounts are clamped to be non-negative whole
 * numbers; a missing target is ignored.
 */
export class AdminCommandExecution implements Execution {
  constructor(
    private issuer: Player,
    private command: AdminCommand,
    private targetID: PlayerID,
    private amount: number | undefined,
  ) {}

  isActive(): boolean {
    return false;
  }

  activeDuringSpawnPhase(): boolean {
    return true;
  }

  init(mg: Game, _ticks: number): void {
    if (!mg.hasPlayer(this.targetID)) {
      console.warn(`admin command target ${this.targetID} not found`);
      return;
    }
    const target = mg.player(this.targetID);
    const amount = Math.min(
      ADMIN_COMMAND_MAX_AMOUNT,
      Math.max(0, Math.floor(this.amount ?? 0)),
    );
    switch (this.command) {
      case "give_gold":
        target.addGold(toInt(amount));
        break;
      case "take_gold":
        target.removeGold(toInt(amount));
        break;
      case "set_gold": {
        const wanted = toInt(amount);
        const have = target.gold();
        if (wanted > have) target.addGold(wanted - have);
        else target.removeGold(have - wanted);
        break;
      }
      case "give_troops":
        target.addTroops(amount);
        break;
      case "take_troops":
        target.removeTroops(amount);
        break;
      case "set_troops":
        target.setTroops(amount);
        break;
      case "eliminate":
        // A player with no land is dead; PlayerExecution then clears the rest
        // and records the death exactly as for a conquest.
        for (const tile of [...target.tiles()]) target.relinquish(tile);
        break;
      case "force_win": {
        if (mg.getWinner() !== null) break;
        const team = target.team();
        const winner =
          mg.config().gameConfig().gameMode === GameMode.Team && team !== null
            ? team
            : target;
        mg.setWinner(winner, mg.stats().stats());
        break;
      }
    }
  }

  tick(_ticks: number): void {}

  snapshot(w: SnapshotWriter): ExecRecord {
    return AdminCommandExecutionSnapshot.write({
      issuer: w.player(this.issuer),
      command: this.command,
      targetID: this.targetID,
      amount: this.amount ?? null,
    });
  }

  restoreSnapshot(s: AdminCommandState, r: SnapshotReader): void {
    this.issuer = r.player(s.issuer);
    this.command = s.command;
    this.targetID = s.targetID;
    this.amount = s.amount ?? undefined;
  }
}

const AdminCommandStateSchema = z.object({
  issuer: zPlayerRef(),
  command: z.enum(ADMIN_COMMANDS),
  targetID: z.string(),
  amount: z.number().nullable(),
});
type AdminCommandState = z.infer<typeof AdminCommandStateSchema>;

export const AdminCommandExecutionSnapshot = execSnapshotType({
  name: "AdminCommand",
  version: 1,
  schema: AdminCommandStateSchema,
  cls: () => AdminCommandExecution,
});
