import { GameUpdateType } from "@openfront/engine-api/game/GameUpdates";
import type { Game, Player } from "@openfront/engine/game/Game";
import { matchEvents } from "../capital/helpers";
import { SPEC, annex, annexable, resistance, run } from "./helpers";

const deathOf = (game: Game, p: Player) => game.stats().getPlayerStats(p);

describe("a player whose last land is taken while a resistance can rise", () => {
  test("is not eliminated: nothing stripped, nothing credited, nothing reported", async () => {
    const w = await annexable();
    const updates = annex(w);
    expect(w.alice.numTilesOwned()).toBe(0);
    expect(w.alice.isAlive()).toBe(false);

    // The resistance began, and holds her in the game.
    const ins = resistance(w.game, w.alice);
    expect(ins.status).toBe("active");
    expect(ins.limboSince).toBeGreaterThanOrEqual(0);
    expect(w.game.insurgency()!.holdsLimbo(w.alice)).toBe(true);
    expect(w.game.insurgency()!.phaseOf(w.alice)).toBe(2);

    // Not stripped by the death that did not happen.
    expect(w.alice.gold()).toBeGreaterThan(0n);
    // No kill, no finishing place, no line in the feed.
    expect(deathOf(w.game, w.alice)?.killedBy ?? null).toBeNull();
    expect(deathOf(w.game, w.alice)?.deathPosition ?? null).toBeNull();
    expect(matchEvents(updates, "player_eliminated")).toHaveLength(0);
    // Her execution is still running, to see it through.
    run(w.game, 5);
    expect(w.alice.gold()).toBeGreaterThan(0n);
  });

  test("is told, and the update says she has no land but still resists", async () => {
    const w = await annexable();
    const updates = annex(w);
    const player = updates
      .flatMap((u) => u[GameUpdateType.Player])
      .filter((p) => p.id === w.alice.id());
    const states = player
      .map((p) => p.insurgency)
      .filter((v) => v !== undefined);
    expect(states[states.length - 1]).toBe(2);
    const messages = updates
      .flatMap((u) => u[GameUpdateType.DisplayEvent])
      .map((m) => m.message);
    expect(messages).toContain("events_display.insurgency_limbo");
  });

  test("can found a base on the land bob took, recruit, and rise again", async () => {
    const w = await annexable();
    annex(w);
    const ins = resistance(w.game, w.alice);
    const sys = w.game.insurgency()!;
    ins.funds = 1_000_000n;
    const region = ins.regions[0];
    expect(region.status).toBe(1);
    region.unrest = 80;
    // Nowhere to gather yet.
    expect(sys.recruit(w.alice, 10_000)).toBe("no_location");
    expect(sys.uprising(w.alice, 0, 20_000)).toBe("no_location");
    // A base, on her old land.
    expect(sys.foundBase(w.alice, w.game.ref(3, 3))).toBeNull();
    expect(sys.recruit(w.alice, 10_000)).toBeNull();
    // And an uprising from nothing: the seed is won in combat.
    // (Her army was capped to what 64 tiles can hold, so the reserve is small.)
    expect(ins.available).toBeGreaterThanOrEqual(SPEC.uprisingMinTroops);
    expect(sys.uprising(w.alice, 0, ins.available)).toBeNull();
    run(w.game, 60);
    expect(w.alice.numTilesOwned()).toBeGreaterThan(0);
    expect(w.alice.isAlive()).toBe(true);
    run(w.game, 3);
    expect(ins.limboSince).toBe(-1);
    expect(ins.status).toBe("active");
    expect(sys.phaseOf(w.alice)).toBe(1);
  });

  test("is eliminated when the time is up, once, and the killer is credited", async () => {
    const w = await annexable();
    const early = annex(w);
    const ins = resistance(w.game, w.alice);
    const all = [...early, ...run(w.game, SPEC.limboTicks + 5)];
    expect(ins.status).toBe("ended");
    expect(ins.endReason).toBe("limbo_expired");
    expect(w.game.insurgency()!.holdsLimbo(w.alice)).toBe(false);
    // The elimination happens now, as a conquest by bob would have.
    const stats = deathOf(w.game, w.alice);
    expect(stats?.killedBy).toBe(w.bob.clientID());
    expect(stats?.deathPosition).toBeGreaterThan(0);
    const feed = matchEvents(all, "player_eliminated");
    expect(feed).toHaveLength(1);
    expect(feed[0]).toMatchObject({
      actor: w.bob.smallID(),
      target: w.alice.smallID(),
    });
    // Her gold is stripped and her execution ends, as for any dead player.
    run(w.game, 5);
    expect(w.alice.gold()).toBe(0n);
    expect(matchEvents(run(w.game, 30), "player_eliminated")).toHaveLength(0);
  });

  test("is eliminated at once when nothing is left to fight with", async () => {
    const w = await annexable();
    annex(w);
    const ins = resistance(w.game, w.alice);
    ins.available = 0;
    ins.funds = 0n;
    run(w.game, 3);
    expect(ins.status).toBe("ended");
    expect(ins.endReason).toBe("exhausted");
    expect(deathOf(w.game, w.alice)?.killedBy).toBe(w.bob.clientID());
  });

  test("a player whose capital is gone is eliminated as always: no resistance, no delay", async () => {
    const w = await annexable();
    // carol, with a capital long gone (destroyed), is conquered by bob.
    const carolCapital = w.game.capitals()!.capitalOf(w.carol)!.tile;
    w.carol.relinquish(carolCapital);
    run(w.game, 2);
    expect(w.game.capitals()!.capitalOf(w.carol)).toBeNull();
    w.game.conquerPlayer(w.bob, w.carol);
    expect(deathOf(w.game, w.carol)?.killedBy).toBe(w.bob.clientID());
    expect(deathOf(w.game, w.carol)?.deathPosition).toBeGreaterThan(0);
  });

  test("an elimination put off for a resistance that does not start is finished that very tick", async () => {
    const w = await annexable();
    // alice's capital is about to fall, so her elimination is put off...
    w.game.conquerPlayer(w.bob, w.alice);
    expect(w.game.insurgency()!.holdsLimbo(w.alice)).toBe(true);
    // ...but her land vanishes (nuked) instead, so no one captures the capital
    // and no resistance starts.
    for (const t of [...w.alice.tiles()]) w.alice.relinquish(t);
    const updates = run(w.game, 2);
    expect(w.game.insurgency()!.of(w.alice)).toBeNull();
    expect(w.game.insurgency()!.holdsLimbo(w.alice)).toBe(false);
    // She is eliminated now, with the credit she would always have had.
    expect(deathOf(w.game, w.alice)?.killedBy).toBe(w.bob.clientID());
    expect(matchEvents(updates, "player_eliminated")).toHaveLength(1);
  });

  test("ends with the match, and a player it was keeping alive is then eliminated", async () => {
    const w = await annexable();
    annex(w);
    const ins = resistance(w.game, w.alice);
    expect(ins.status).toBe("active");
    w.game.setWinner(w.bob, w.game.stats().stats());
    const updates = run(w.game, 3);
    expect(ins.status).toBe("ended");
    expect(ins.endReason).toBe("match_over");
    expect(deathOf(w.game, w.alice)?.deathPosition).toBeGreaterThan(0);
    expect(matchEvents(updates, "insurgency_ended")[0]).toMatchObject({
      target: w.alice.smallID(),
      meta: { reason: "match_over" },
    });
  });
});

describe("a resistance whose owner still has land", () => {
  test("dissolves when its time is up, and the player carries on", async () => {
    const w = await annexable();
    // carol, far from anyone, loses her capital but not her land.
    w.bob.conquer(w.game.capitals()!.capitalOf(w.carol)!.tile);
    run(w.game, 2);
    const ins = resistance(w.game, w.carol);
    expect(w.game.insurgency()!.phaseOf(w.carol)).toBe(1);
    run(w.game, SPEC.survivalTicks + 5);
    expect(ins.status).toBe("ended");
    expect(ins.endReason).toBe("survival_expired");
    expect(w.carol.isAlive()).toBe(true);
    expect(ins.available).toBe(0);
    expect(deathOf(w.game, w.carol)?.deathPosition ?? null).toBeNull();
    expect(w.game.insurgency()!.phaseOf(w.carol)).toBe(0);
  });

  test("warns a minute before the end", async () => {
    const w = await annexable();
    w.bob.conquer(w.game.capitals()!.capitalOf(w.carol)!.tile);
    run(w.game, 2);
    const ins = resistance(w.game, w.carol);
    const updates = run(w.game, ins.deadline - w.game.ticks() - 1);
    const warnings = updates
      .flatMap((u) => u[GameUpdateType.DisplayEvent])
      .filter((m) => m.message === "events_display.insurgency_expiring");
    expect(warnings).toHaveLength(1);
    expect(warnings[0].playerID).toBe(w.carol.smallID());
  });
});
