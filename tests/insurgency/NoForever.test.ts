import { matchEvents } from "../capital/helpers";
import { SPEC, annex, annexable, resistance, run } from "./helpers";

/**
 * Pre-release playtest rows 3.5 (docs/PreReleasePlaytest.md): however a
 * resistance plays, it cannot keep a player in the match, or keep land from the
 * ordinary rules, for ever. The limbo clock restarts each time the player wins a
 * tile; the survival clock, which only reclaimed regions extend, does not.
 */
describe("a resistance cannot last for ever", () => {
  test("winning and losing one tile to restart the limbo clock ends at the survival deadline", async () => {
    const w = await annexable();
    annex(w);
    const ins = resistance(w.game, w.alice);
    const deadline = ins.deadline;
    expect(deadline - ins.startTick).toBe(SPEC.survivalTicks);
    const tile = w.game.ref(30, 10); // deep inside bob's land

    // Every 4 minutes: a tile won (alive, the limbo clock stops), then lost
    // again (a fresh 5 minutes). Never a region reclaimed, so no extension.
    const updates: ReturnType<typeof run>[] = [];
    let flips = 0;
    while (w.game.ticks() < deadline + 200 && ins.status === "active") {
      updates.push(run(w.game, 2_400));
      if (ins.status !== "active") break;
      w.alice.conquer(tile);
      updates.push(run(w.game, 5));
      w.bob.conquer(tile);
      updates.push(run(w.game, 5));
      flips++;
    }
    expect(flips).toBeGreaterThanOrEqual(2);
    // The limbo clock really was restarted, over and over, and never ended it...
    expect(ins.endReason).toBe("survival_expired");
    // ...the survival clock did, no later than it said at the start.
    expect(ins.endTick).toBeLessThanOrEqual(deadline + 1);
    expect(ins.deadline).toBe(deadline);
    // She was eliminated, once, with the credit an ordinary elimination has.
    expect(w.alice.isAlive()).toBe(false);
    expect(matchEvents(updates.flat(), "player_eliminated")).toHaveLength(1);
  });

  test("a resistance that holds a tile when its time is up ends, and the enclosure rule takes the pocket", async () => {
    const w = await annexable();
    annex(w);
    const ins = resistance(w.game, w.alice);
    const tile = w.game.ref(30, 10);
    w.alice.conquer(tile);
    run(w.game, ins.deadline - w.game.ticks() + 2);
    expect(ins.status).toBe("ended");
    expect(ins.endReason).toBe("survival_expired");
    // Alive for the moment she holds the tile, as any one-tile player is...
    // ...and then the rule that was suspended for her applies again.
    run(w.game, 200);
    expect(w.game.ownerID(tile)).toBe(w.bob.smallID());
    expect(w.alice.isAlive()).toBe(false);
  });

  test("the clock never runs past the cap, whatever the regions reclaimed", () => {
    // 20 regions reclaimed would add 60 minutes: the cap says 30 in all.
    const longest = SPEC.survivalMaxTicks;
    expect(longest).toBe(18_000);
    expect(
      SPEC.survivalTicks + 20 * SPEC.survivalExtensionTicks,
    ).toBeGreaterThan(longest);
  });
});
