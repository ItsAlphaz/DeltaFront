import { AttackExecution } from "@openfront/engine/execution/AttackExecution";
import { matchEvents } from "../capital/helpers";
import { annex, annexable, resistance, run } from "./helpers";

/**
 * alice, annexed whole and resisting from no land at all, wins one tile far
 * inside bob's: the kind of pocket the enclosure rule would swallow at once.
 */
async function pocket() {
  const w = await annexable();
  annex(w);
  expect(w.alice.numTilesOwned()).toBe(0);
  const tile = w.game.ref(30, 10);
  w.alice.conquer(tile);
  return { ...w, tile };
}

describe("a pocket inside the occupier's land", () => {
  test("is not absorbed by the enclosure rule while the resistance lasts", async () => {
    const { game, alice, tile } = await pocket();
    expect(resistance(game, alice).status).toBe("active");
    run(game, 200);
    expect(game.ownerID(tile)).toBe(alice.smallID());
    expect(alice.isAlive()).toBe(true);
  });

  test("is absorbed as always once the resistance is over, and the elimination is then credited", async () => {
    const { game, alice, bob, tile } = await pocket();
    const ins = resistance(game, alice);
    ins.deadline = game.ticks() + 1;
    const updates = run(game, 120);
    expect(ins.status).toBe("ended");
    expect(game.ownerID(tile)).toBe(bob.smallID());
    expect(alice.isAlive()).toBe(false);
    // An ordinary elimination by bob: killed once, named.
    expect(game.stats().getPlayerStats(alice)?.killedBy).toBe(bob.clientID());
    expect(matchEvents(updates, "player_eliminated")).toHaveLength(1);
  });

  test("can be taken back by bob in combat like any land", async () => {
    const { game, alice, bob, tile } = await pocket();
    game.addExecution(new AttackExecution(200_000, bob, alice.id(), null));
    run(game, 40);
    expect(game.ownerID(tile)).toBe(bob.smallID());
  });
});
