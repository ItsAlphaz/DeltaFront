import { ADMIN_COMMANDS } from "@openfront/engine-api/AdminCommands";
import { PlayerInfo, PlayerType } from "@openfront/engine-api/game/GameTypes";
import {
  IntentSchema,
  StampedIntentSchema,
} from "@openfront/engine-api/Schemas";
import { AdminCommandExecution } from "@openfront/engine/execution/AdminCommandExecution";
import { Executor } from "@openfront/engine/execution/ExecutionManager";
import { SpawnExecution } from "@openfront/engine/execution/SpawnExecution";
import { Game, Player } from "@openfront/engine/game/Game";
import { EXECUTION_SNAPSHOT_TYPES } from "@openfront/engine/snapshot/ExecutionRegistry";
import { setup } from "./util/Setup";
import { executeTicks } from "./util/utils";

describe("AdminCommandExecution", () => {
  let game: Game;
  let admin: Player;
  let victim: Player;

  beforeEach(async () => {
    game = await setup("plains", {});
    const a = new PlayerInfo(
      "Admin",
      PlayerType.Human,
      "clientAdm",
      "adminpl1",
    );
    const v = new PlayerInfo(
      "Victim",
      PlayerType.Human,
      "clientVic",
      "victimp1",
    );
    game.addPlayer(a);
    game.addPlayer(v);
    game.addExecution(
      new SpawnExecution("game_id", game.player(a.id).info(), game.ref(0, 10)),
      new SpawnExecution("game_id", game.player(v.id).info(), game.ref(0, 15)),
    );
    executeTicks(game, 2);
    admin = game.player(a.id);
    victim = game.player(v.id);
  });

  const run = (
    command: (typeof ADMIN_COMMANDS)[number],
    amount?: number,
    target = victim.id(),
  ) => {
    // Applied directly (no tick in between): natural income and troop growth
    // would otherwise move the numbers the test is pinning.
    new AdminCommandExecution(admin, command, target, amount).init(game, 0);
  };

  it("gives, takes and sets gold", () => {
    const start = victim.gold();
    run("give_gold", 5000);
    expect(victim.gold()).toBe(start + 5000n);
    run("take_gold", 2000);
    expect(victim.gold()).toBe(start + 3000n);
    run("set_gold", 42);
    expect(victim.gold()).toBe(42n);
    run("set_gold", 1_000_000);
    expect(victim.gold()).toBe(1_000_000n);
  });

  it("never takes more gold than there is", () => {
    run("set_gold", 10);
    run("take_gold", 1_000_000);
    expect(victim.gold()).toBe(0n);
  });

  it("gives, takes and sets troops", () => {
    run("set_troops", 1000);
    expect(victim.troops()).toBe(1000);
    run("give_troops", 500);
    expect(victim.troops()).toBe(1500);
    run("take_troops", 700);
    expect(victim.troops()).toBe(800);
    run("take_troops", 99_999);
    expect(victim.troops()).toBe(0);
  });

  it("acts only on the named player", () => {
    const before = admin.gold();
    run("give_gold", 777);
    expect(admin.gold()).toBe(before);
  });

  it("clamps a nonsense amount instead of corrupting state", () => {
    run("set_gold", 10);
    run("give_gold", Number.POSITIVE_INFINITY);
    expect(victim.gold() >= 10n).toBe(true);
    expect(Number.isFinite(Number(victim.gold()))).toBe(true);
    run("set_gold", -5);
    expect(victim.gold()).toBe(0n);
    run("set_gold", undefined);
    expect(victim.gold()).toBe(0n);
  });

  it("eliminates a player: no land left, dead", () => {
    expect(victim.isAlive()).toBe(true);
    run("eliminate");
    expect(victim.numTilesOwned()).toBe(0);
    expect(victim.isAlive()).toBe(false);
    expect(admin.isAlive()).toBe(true);
  });

  it("forces a winner, once", () => {
    expect(game.getWinner()).toBeNull();
    run("force_win", undefined, admin.id());
    expect(game.getWinner()).toBe(admin);
    run("force_win", undefined, victim.id());
    expect(game.getWinner()).toBe(admin);
  });

  it("ignores a target that is not in the game", () => {
    expect(() => run("give_gold", 5, "nobody01")).not.toThrow();
  });

  it("is built by the ExecutionManager from a stamped intent", () => {
    const manager = new Executor(game, "game_id", undefined);
    const intent = StampedIntentSchema.parse({
      type: "admin_command",
      command: "set_gold",
      target: victim.id(),
      amount: 123,
      clientID: "clientAdm",
    });
    manager.createExec(intent).init(game, 0);
    expect(victim.gold()).toBe(123n);
  });

  it("is part of the intent schema with a bounded amount, and a snapshot type exists", () => {
    expect(
      IntentSchema.safeParse({
        type: "admin_command",
        command: "give_gold",
        target: "abcdefgh",
        amount: 10,
      }).success,
    ).toBe(true);
    expect(
      IntentSchema.safeParse({
        type: "admin_command",
        command: "give_gold",
        target: "abcdefgh",
        amount: 1e30,
      }).success,
    ).toBe(false);
    expect(
      IntentSchema.safeParse({
        type: "admin_command",
        command: "nuke_everything",
        target: "abcdefgh",
      }).success,
    ).toBe(false);
    expect(EXECUTION_SNAPSHOT_TYPES.map((t) => t.name)).toContain(
      "AdminCommand",
    );
  });

  it("round-trips on the binary wire, keeping every existing intent's encoding", () => {
    const intent = {
      type: "admin_command" as const,
      command: "set_troops" as const,
      target: "victimp1",
      amount: 12_345,
      clientID: "clientAdm",
    };
    expect(
      StampedIntentSchema.parseBytes(StampedIntentSchema.serialize(intent)),
    ).toEqual(intent);
    const noAmount = {
      ...intent,
      command: "eliminate" as const,
      amount: undefined,
    };
    expect(
      StampedIntentSchema.parseBytes(StampedIntentSchema.serialize(noAmount)),
    ).toMatchObject({ type: "admin_command", command: "eliminate" });
    // Appended last, so the tags of the intents before it did not move.
    const spawn = { type: "spawn" as const, tile: 7, clientID: "clientAdm" };
    expect(
      StampedIntentSchema.parseBytes(StampedIntentSchema.serialize(spawn)),
    ).toEqual(spawn);
  });
});
