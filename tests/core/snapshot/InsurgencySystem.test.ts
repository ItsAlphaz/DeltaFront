import { MessageType } from "@openfront/engine-api/game/GameTypes";
import {
  InsurgencyPhase,
  InsurgencyRegionStatus,
} from "@openfront/engine-api/game/GameUpdates";
import {
  readSnapshotHeader,
  snapshotGame,
} from "@openfront/engine/snapshot/GameSnapshot";
import { human } from "../../capital/helpers";
import {
  SPEC,
  annex,
  annexable,
  captureCapital,
  insurgentWorld,
  makeRestless,
  occupyRegion0,
  resistance,
  run,
  startEconomy,
} from "../../insurgency/helpers";
import { setup } from "../../util/Setup";
import { expectSnapshotRoundTrip } from "../../util/Snapshot";

/**
 * A client that reconnects is brought to the present by replaying the match,
 * and a server restarts a game from a snapshot: either way the resistance must
 * come back exactly (docs/Insurgency.md). The round trip checks the whole game
 * graph, the snapshot bytes and the state hash on every tick afterwards.
 */
describe("Insurgency snapshots", () => {
  test("a resistance with every kind of state restores exactly and plays on identically", async () => {
    const w = await insurgentWorld();
    startEconomy(w.game, w.alice, w.bob, w.carol);
    captureCapital(w);
    occupyRegion0(w);
    makeRestless(w.game, w.alice, 80);
    resistance(w.game, w.alice).funds = 1_000_000n; // enough for all of it
    const sys = w.game.insurgency()!;
    expect(sys.recruit(w.alice, 20_000)).toBeNull(); // on its way
    expect(sys.foundBase(w.alice, w.game.ref(10, 5))).toBeNull(); // a base
    expect(sys.intel(w.alice, 0)).toBeNull(); // a report
    expect(sys.suppress(w.bob, w.alice, 0)).toBeNull(); // a suppression running
    expect(sys.uprising(w.alice, 0, 40_000)).toBeNull(); // an uprising in the field
    run(w.game, 8);
    const ins = resistance(w.game, w.alice);
    expect(ins.recruits).toHaveLength(1);
    expect(ins.bases).toHaveLength(1);
    expect(ins.intel).toHaveLength(1);
    expect(ins.suppressions).toHaveLength(1);
    expect(ins.ops).toHaveLength(1);

    // Past the recruits' arrival, the suppression's end and the unrest updates.
    const restored = await expectSnapshotRoundTrip(w.game, "big_plains", 700);

    // The restored game knows what the live one does, to the number.
    const a = restored.insurgency()!.of(restored.player("alice"))!;
    const live = resistance(w.game, w.alice);
    expect(a.status).toBe(live.status);
    expect(a.funds).toBe(live.funds);
    expect(a.available).toBe(live.available);
    expect(a.deadline).toBe(live.deadline);
    expect(a.regions.map((r) => [r.id, r.status, r.unrest, r.flips])).toEqual(
      live.regions.map((r) => [r.id, r.status, r.unrest, r.flips]),
    );
  });

  test("a resistance of a player with no land, in limbo", async () => {
    const w = await annexable();
    annex(w);
    const ins = resistance(w.game, w.alice);
    expect(ins.limboSince).toBeGreaterThanOrEqual(0);
    const restored = await expectSnapshotRoundTrip(w.game, "big_plains", 40);
    const view = restored.insurgency()!;
    const a = restored.player("alice");
    expect(view.holdsLimbo(a)).toBe(true);
    expect(view.phaseOf(a)).toBe(2);
    expect(a.isAlive()).toBe(false);
  });

  test("and through its end: the elimination is done once, in both", async () => {
    const w = await annexable();
    annex(w);
    const ins = resistance(w.game, w.alice);
    const restored = await expectSnapshotRoundTrip(w.game, "big_plains", 5);
    // The limbo runs out in both games, on the same tick.
    ins.limboDeadline = w.game.ticks() + 20;
    restored.insurgency()!.of(restored.player("alice"))!.limboDeadline =
      restored.ticks() + 20;
    for (let i = 0; i < 30; i++) {
      w.game.executeNextTick();
      restored.executeNextTick();
    }
    expect(ins.status).toBe("ended");
    expect(restored.insurgency()!.of(restored.player("alice"))!.status).toBe(
      "ended",
    );
    expect(restored.player("alice").isAlive()).toBe(false);
  });

  test("a resistance that has ended is still known to a client that arrives later", async () => {
    const w = await insurgentWorld();
    startEconomy(w.game, w.alice, w.bob, w.carol);
    captureCapital(w);
    occupyRegion0(w);
    resistance(w.game, w.alice).deadline = w.game.ticks() + 1;
    run(w.game, 4);
    const restored = await expectSnapshotRoundTrip(w.game, "big_plains", 10);
    const a = restored.insurgency()!.of(restored.player("alice"))!;
    expect(a.status).toBe("ended");
    expect(a.endReason).toBe("survival_expired");
    // The view a late client is sent says so.
    const view = restored.insurgency()!.view(a);
    expect(view.phase).toBe(InsurgencyPhase.Ended);
    expect(view.regions[0].status).toBe(InsurgencyRegionStatus.Occupied);
    void MessageType;
    void SPEC;
  });

  test("a game with the Capital System off snapshots as it always did", async () => {
    const game = await setup("big_plains", {}, [human("a"), human("b")]);
    const bytes = snapshotGame(game, { gameID: "g" });
    expect(readSnapshotHeader(bytes).gameConfig.capitalSystem).toBeUndefined();
    const text = new TextDecoder("latin1").decode(bytes);
    expect(text).not.toContain("matchOverHandled");
    expect(text).not.toContain("limboDeadline");
  });
});
