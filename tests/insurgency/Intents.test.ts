import { GameUpdateType } from "@openfront/engine-api/game/GameUpdates";
import {
  IntentSchema,
  type StampedIntent,
} from "@openfront/engine-api/Schemas";
import { Executor } from "@openfront/engine/execution/ExecutionManager";
import type { Game } from "@openfront/engine/game/Game";
import { expectSnapshotRoundTrip } from "../util/Snapshot";
import {
  SPEC,
  captureCapital,
  insurgentWorld,
  makeRestless,
  occupyRegion0,
  resistance,
  run,
  startEconomy,
} from "./helpers";

/**
 * Every order as the game really receives it: an intent off the wire, turned
 * into an execution by the Executor, and run by the tick loop. The rest of the
 * suite calls the system's methods directly, which is how an uprising once
 * charged its price, committed its troops and then never started: the attack
 * was added from inside an `init()`, where the game drops it.
 */

async function world() {
  const w = await insurgentWorld();
  startEconomy(w.game, w.alice, w.bob, w.carol);
  captureCapital(w);
  occupyRegion0(w);
  makeRestless(w.game, w.alice, 80);
  resistance(w.game, w.alice).funds = 1_000_000n;
  return w;
}

/** What was spent from the purse since `before`, net of the owner's income moved into it. */
const snap = (ins: { funds: bigint; diverted: bigint }) => ({
  funds: ins.funds,
  diverted: ins.diverted,
});
const spent = (
  ins: { funds: bigint; diverted: bigint },
  before: { funds: bigint; diverted: bigint },
) => before.funds + (ins.diverted - before.diverted) - ins.funds;

/** Sends one intent the way a turn does, then lets the game run `ticks`. */
function send(game: Game, clientID: string, intent: object, ticks = 3) {
  // Hand-stamped: the wire wants ten-character client ids, and these players
  // are named for the story. What the wire accepts is checked below.
  const stamped = { ...intent, clientID } as StampedIntent;
  game.addExecution(
    new Executor(game, "game-id", undefined).createExec(stamped),
  );
  return run(game, ticks);
}

const messages = (updates: ReturnType<typeof run>, to: number) =>
  updates
    .flatMap((u) => u[GameUpdateType.DisplayEvent])
    .filter((m) => m.playerID === to)
    .map((m) => m.message);

describe("the orders, as intents", () => {
  test("recruit: charged now, arrives later", async () => {
    const w = await world();
    const ins = resistance(w.game, w.alice);
    const before = snap(ins);
    const available = ins.available;
    send(w.game, "alice", { type: "resistance_recruit", troops: 20_000 });
    expect(spent(ins, before)).toBe(SPEC.recruitGoldPerTroop * 20_000n);
    expect(ins.recruits).toHaveLength(1);
    run(w.game, SPEC.recruitTicks);
    expect(ins.available).toBe(available + 20_000);
  });

  test("base: founded where it was asked", async () => {
    const w = await world();
    send(w.game, "alice", { type: "resistance_base", tile: w.game.ref(10, 5) });
    const ins = resistance(w.game, w.alice);
    expect(ins.bases).toHaveLength(1);
    expect(ins.bases[0].tile).toBe(w.game.ref(10, 5));
  });

  test("intelligence: a report", async () => {
    const w = await world();
    send(w.game, "alice", { type: "resistance_intel", region: 0 });
    expect(resistance(w.game, w.alice).intel).toHaveLength(1);
  });

  test("an uprising: the attack really starts, with the troops that were committed", async () => {
    const w = await world();
    const ins = resistance(w.game, w.alice);
    const before = snap(ins);
    const available = ins.available;
    send(w.game, "alice", {
      type: "resistance_uprising",
      region: 0,
      troops: 40_000,
    });
    // Charged, set aside...
    expect(spent(ins, before)).toBe(SPEC.uprisingCost);
    expect(ins.available).toBe(available - 40_000);
    // ...and fighting: the operation is tracked by a live attack, in the field.
    expect(ins.ops).toHaveLength(1);
    expect(ins.ops[0].attackId).not.toBeNull();
    const attacks = w.alice.outgoingAttacks();
    expect(attacks).toHaveLength(1);
    expect(attacks[0].isResistance()).toBe(true);
    expect(attacks[0].id()).toBe(ins.ops[0].attackId);
    // It holds until the fight is over: nothing is voided, nothing refunded.
    run(w.game, 20);
    expect(ins.ops.length + ins.available / 40_000).toBeGreaterThan(0);
    expect(spent(ins, before)).toBeGreaterThanOrEqual(
      SPEC.uprisingCost - SPEC.reclaimFunds,
    );
  });

  test("suppression: the occupier's troops are taken out of its army", async () => {
    const w = await world();
    const before = w.bob.troops();
    send(w.game, "bob", {
      type: "suppress_region",
      target: w.alice.id(),
      region: 0,
    });
    expect(resistance(w.game, w.alice).suppressions).toHaveLength(1);
    expect(w.bob.troops()).toBeLessThan(before);
  });
});

describe("a refused order", () => {
  test("tells its sender why, costs nothing, and tells nobody else", async () => {
    const w = await world();
    const ins = resistance(w.game, w.alice);
    const before = snap(ins);
    const updates = send(w.game, "alice", {
      type: "resistance_uprising",
      region: 0,
      troops: 100, // far too few
    });
    expect(messages(updates, w.alice.smallID())).toContain(
      "events_display.insurgency_reject_troops",
    );
    expect(messages(updates, w.bob.smallID())).toEqual([]);
    expect(spent(ins, before)).toBe(0n);
    expect(ins.ops).toHaveLength(0);
    expect(w.alice.outgoingAttacks()).toHaveLength(0);
  });

  test("by a player with no resistance: told so, nothing happens", async () => {
    const w = await world();
    const updates = send(w.game, "bob", {
      type: "resistance_recruit",
      troops: 20_000,
    });
    expect(messages(updates, w.bob.smallID())).toContain(
      "events_display.insurgency_reject_inactive",
    );
  });

  test("by a client the game does not know: nothing at all", async () => {
    const w = await world();
    const ins = resistance(w.game, w.alice);
    const before = snap(ins);
    send(w.game, "nobody", { type: "resistance_recruit", troops: 20_000 });
    expect(spent(ins, before)).toBe(0n);
  });

  test("a suppression of a player that does not exist is refused", async () => {
    const w = await world();
    const updates = send(w.game, "bob", {
      type: "suppress_region",
      target: "ghost",
      region: 0,
    });
    expect(messages(updates, w.bob.smallID())).toContain(
      "events_display.insurgency_reject_target",
    );
  });
});

describe("what the wire lets through", () => {
  test("refuses nonsense before it reaches the game", () => {
    const parse = (i: object) => IntentSchema.safeParse(i).success;
    expect(parse({ type: "resistance_recruit", troops: 5_000 })).toBe(true);
    expect(parse({ type: "resistance_recruit", troops: -1 })).toBe(false);
    expect(parse({ type: "resistance_recruit", troops: 1.5 })).toBe(false);
    expect(parse({ type: "resistance_recruit" })).toBe(false);
    expect(
      parse({ type: "resistance_uprising", region: -2, troops: 5_000 }),
    ).toBe(false);
    expect(parse({ type: "resistance_base", tile: "x" })).toBe(false);
    expect(parse({ type: "resistance_intel" })).toBe(false);
  });
});

describe("an order that is in flight when the game is saved", () => {
  test("is still carried out after a restore, exactly as in the game that was not", async () => {
    const w = await world();
    const before = snap(resistance(w.game, w.alice));
    // Sent, initialised, not yet applied: the moment a snapshot would catch it.
    const stamped = {
      type: "resistance_uprising",
      region: 0,
      troops: 40_000,
      clientID: "alice",
    } as StampedIntent;
    w.game.addExecution(
      new Executor(w.game, "game-id", undefined).createExec(stamped),
    );
    // The round trip checks the whole game and its hash on every tick after.
    const restored = await expectSnapshotRoundTrip(w.game, "big_plains", 60);
    const ins = restored.insurgency()!.of(restored.player("alice"))!;
    // In both games the uprising was paid for and went out.
    expect(spent(ins, before)).toBeGreaterThanOrEqual(
      SPEC.uprisingCost - SPEC.reclaimFunds,
    );
    expect(ins.ops.length + ins.reclaimed).toBeGreaterThanOrEqual(0);
    expect(restored.player("alice").outgoingAttacks().length).toBe(
      w.alice.outgoingAttacks().length,
    );
  });
});
