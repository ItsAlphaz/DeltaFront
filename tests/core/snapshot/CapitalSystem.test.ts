import { CAPITAL_SPEC } from "@openfront/engine-lib/capital/CapitalRules";
import { AttackExecution } from "@openfront/engine/execution/AttackExecution";
import { PlayerExecution } from "@openfront/engine/execution/PlayerExecution";
import { capitalWorld, land, run } from "../../capital/helpers";
import { expectSnapshotRoundTrip } from "../../util/Snapshot";

describe("Capital System snapshots", () => {
  test("a game with capitals restores exactly and plays on identically", async () => {
    const { game } = await capitalWorld();
    await expectSnapshotRoundTrip(game, "big_plains", 20);
  });

  test("mid-CRISIS, with a replacement founded and an attack running", async () => {
    const { game, alice, bob } = await capitalWorld({
      config: { infiniteGold: true },
    });
    game.addExecution(new PlayerExecution(alice), new PlayerExecution(bob));
    bob.conquer(game.capitals()!.capitalOf(alice)!.tile);
    run(game, CAPITAL_SPEC.replacementDelayTicks + 2);
    land(game, alice, 20, 20, 6);
    expect(game.capitals()!.found(alice, game.ref(21, 20))).toBe(true);
    game.addExecution(
      new AttackExecution(bob.troops() / 2, bob, alice.id(), null),
    );
    run(game, 5);
    expect(game.capitals()!.inCrisis(alice)).toBe(true);
    const restored = await expectSnapshotRoundTrip(game, "big_plains", 30);

    // The restored game knows what the live one does: who was paid, when the
    // crisis ends, and which capital is a replacement.
    const c = restored.capitals()!;
    const a = restored.player("alice");
    const b = restored.player("bob");
    expect(c.hasBeenPaid(a, b)).toBe(true);
    expect(c.capitalOf(a)).toMatchObject({ replacement: true });
    expect(c.crisisOf(a)!.endTick).toBe(
      game.capitals()!.crisisOf(alice)!.endTick,
    );
    expect(c.capturesBy(b)).toBe(1);
  });

  test("a game with the system off snapshots as it always did", async () => {
    const { setup } = await import("../../util/Setup");
    const { human } = await import("../../capital/helpers");
    const game = await setup("big_plains", {}, [human("a"), human("b")]);
    const { snapshotGame } =
      await import("@openfront/engine/snapshot/GameSnapshot");
    const { readSnapshotHeader } =
      await import("@openfront/engine/snapshot/GameSnapshot");
    const bytes = snapshotGame(game, { gameID: "g" });
    expect(readSnapshotHeader(bytes).gameConfig.capitalSystem).toBeUndefined();
    // No capitals record is written for it.
    const text = new TextDecoder("latin1").decode(bytes);
    expect(text).not.toContain("designated");
  });
});
