import {
  GameType,
  MessageType,
  PlayerType,
} from "@openfront/engine-api/game/GameTypes";
import { GameUpdateType } from "@openfront/engine-api/game/GameUpdates";
import { CAPITAL_SPEC } from "@openfront/engine-lib/capital/CapitalRules";
import { Game, Player } from "@openfront/engine/game/Game";
import { setup } from "../util/Setup";
import { TestConfig } from "../util/TestConfig";
import {
  capitalEvents,
  capitalWorld,
  human,
  land,
  matchEvents,
  run,
} from "./helpers";

/** The tile a player's capital stands on. */
function capitalTile(game: Game, p: Player) {
  return game.capitals()!.capitalOf(p)!.tile;
}

describe("CapitalSystem: the match setting", () => {
  test("is off unless the match turns it on", async () => {
    const game = await setup("big_plains", {}, [human("a"), human("b")]);
    expect(game.config().capitalSystemEnabled()).toBe(false);
    expect(game.capitals()).toBeNull();
    // Nothing changes in the player updates either.
    const a = game.player("a");
    land(game, a, 20, 20, 3);
    const update = a.toUpdate()!;
    expect(update.capitalTile).toBeUndefined();
    expect(update.crisisEndTick).toBeUndefined();
  });

  test("is off when the setting says disabled", async () => {
    const game = await setup(
      "big_plains",
      { capitalSystem: { enabled: false } },
      [human("a")],
    );
    expect(game.capitals()).toBeNull();
  });

  test("reads the crisis length: 3 minutes, or 5 when asked", async () => {
    const three = await setup("big_plains", {
      capitalSystem: { enabled: true },
    });
    expect(three.config().crisisDurationTicks()).toBe(1_800);
    const five = await setup("big_plains", {
      capitalSystem: { enabled: true, crisisMinutes: 5 },
    });
    expect(five.config().crisisDurationTicks()).toBe(3_000);
    const odd = await setup("big_plains", {
      capitalSystem: { enabled: true, crisisMinutes: 4 },
    });
    expect(odd.config().crisisDurationTicks()).toBe(1_800);
  });
});

describe("CapitalSystem: the founding capital", () => {
  test("is founded where each human spawned, once the spawn phase is over", async () => {
    const { game, alice, bob } = await capitalWorld();
    const caps = game.capitals()!;
    expect(caps.capitalOf(alice)!.tile).toBe(game.ref(20, 20));
    expect(caps.capitalOf(bob)!.tile).toBe(game.ref(20 + 6 * 2 + 1, 20));
    expect(caps.capitalOf(alice)!.replacement).toBe(false);
    expect(caps.crisisOf(alice)).toBeNull();
  });

  test("waits for the spawn phase to end", async () => {
    const game = await setup(
      "big_plains",
      { capitalSystem: { enabled: true } },
      [human("a")],
      undefined,
      undefined,
      false, // leave the spawn phase running
    );
    const a = game.player("a");
    land(game, a, 20, 20, 3);
    a.setSpawnTile(game.ref(20, 20));
    expect(game.inSpawnPhase()).toBe(true);
    run(game, 3);
    expect(game.capitals()!.capitalOf(a)).toBeNull();
    game.endSpawnPhase();
    run(game, 1);
    expect(game.capitals()!.capitalOf(a)).not.toBeNull();
  });

  test("a tribe has none, and a player who never spawned has none", async () => {
    const game = await setup(
      "big_plains",
      { capitalSystem: { enabled: true } },
      [human("a"), human("idle")],
    );
    const a = game.player("a");
    land(game, a, 20, 20, 3);
    a.setSpawnTile(game.ref(20, 20));
    // A tribe: a bot-type player holding land.
    const tribe = game.addPlayer({
      ...human("tribe"),
      playerType: PlayerType.Bot,
    } as never);
    land(game, tribe, 60, 20, 3);
    tribe.setSpawnTile(game.ref(60, 20));
    run(game, 2);
    const caps = game.capitals()!;
    expect(caps.capitalOf(a)).not.toBeNull();
    expect(caps.capitalOf(tribe)).toBeNull();
    expect(caps.capitalOf(game.player("idle"))).toBeNull();
  });

  test("is not founded twice", async () => {
    const { game, alice } = await capitalWorld();
    const first = game.capitals()!.capitalOf(alice)!;
    run(game, 20);
    expect(game.capitals()!.capitalOf(alice)).toBe(first);
  });

  test("shows in the player's update, and -1 for none", async () => {
    const { game, alice, bob } = await capitalWorld({ skipFirstTick: true });
    // The first update of a player carries every field.
    const updates = game.executeNextTick()[GameUpdateType.Player];
    const u = updates.find((p) => p.id === alice.id())!;
    expect(u.capitalTile).toBe(game.ref(20, 20));
    expect(u.capitalIsReplacement).toBe(false);
    expect(u.crisisStartTick).toBe(-1);
    expect(u.crisisEndTick).toBe(-1);

    // A later change is sent as a diff: the capital is gone, CRISIS begins.
    bob.conquer(capitalTile(game, alice));
    const after = run(game, 1)[0][GameUpdateType.Player].find(
      (p) => p.id === alice.id(),
    )!;
    expect(after.capitalTile).toBe(-1);
    expect(after.crisisEndTick).toBe(game.ticks() - 1 + 1_800);
    // And nothing is re-sent when nothing changed.
    const quiet = run(game, 1)[0][GameUpdateType.Player].find(
      (p) => p.id === alice.id(),
    );
    expect(quiet).toBeUndefined();
  });
});

describe("CapitalSystem: a capital is captured", () => {
  test("by an enemy taking its tile: one event, one payment, CRISIS for the owner", async () => {
    const { game, alice, bob } = await capitalWorld();
    const goldBefore = bob.gold();
    bob.removeTroops(bob.troops() - 1_000); // room under the maximum
    const troopsBefore = bob.troops();
    const tile = capitalTile(game, alice);
    bob.conquer(tile);
    const tickOfCapture = game.ticks();
    const updates = run(game, 1);

    const events = capitalEvents(updates);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: "captured",
      tile,
      owner: alice.smallID(),
      captor: bob.smallID(),
      replacement: false,
      rewardGold: CAPITAL_SPEC.captureGold,
      crisisEndTick: tickOfCapture + 1_800,
    });
    expect(events[0].rewardTroops).toBeGreaterThan(0);

    expect(bob.gold()).toBe(goldBefore + CAPITAL_SPEC.captureGold);
    expect(bob.troops()).toBe(troopsBefore + events[0].rewardTroops);

    const caps = game.capitals()!;
    expect(caps.capitalOf(alice)).toBeNull();
    expect(caps.inCrisis(alice)).toBe(true);
    expect(caps.crisisOf(alice)).toMatchObject({
      startTick: tickOfCapture,
      endTick: tickOfCapture + 1_800,
      captor: bob.smallID(),
    });
    expect(caps.capturesBy(bob)).toBe(1);
    expect(caps.hasBeenPaid(alice, bob)).toBe(true);

    const feed = matchEvents(updates, "capital_captured");
    expect(feed).toHaveLength(1);
    expect(feed[0]).toMatchObject({
      actor: bob.smallID(),
      target: alice.smallID(),
      severity: "major",
    });
  });

  test("tells both players, by name", async () => {
    const { game, alice, bob } = await capitalWorld();
    bob.conquer(capitalTile(game, alice));
    const updates = run(game, 1);
    const messages = updates.flatMap((u) => u[GameUpdateType.DisplayEvent]);
    const toBob = messages.find(
      (m) => m.messageType === MessageType.CAPITAL_CAPTURED,
    )!;
    const toAlice = messages.find(
      (m) => m.messageType === MessageType.CAPITAL_LOST,
    )!;
    expect(toBob.playerID).toBe(bob.smallID());
    expect(toBob.params?.name).toBe("alice");
    expect(toAlice.playerID).toBe(alice.smallID());
    expect(toAlice.params).toMatchObject({ name: "bob", minutes: 3 });
  });

  test("is reported once, however often the tile then changes hands", async () => {
    const { game, alice, bob } = await capitalWorld();
    const tile = capitalTile(game, alice);
    bob.conquer(tile);
    const all = run(game, 1);
    // Back and forth: alice retakes it, bob retakes it, and so on.
    for (let i = 0; i < 6; i++) {
      (i % 2 === 0 ? alice : bob).conquer(tile);
      all.push(...run(game, 1));
    }
    expect(capitalEvents(all)).toHaveLength(1);
    expect(matchEvents(all, "capital_captured")).toHaveLength(1);
    expect(game.capitals()!.capitalOf(alice)).toBeNull();
    expect(game.capitals()!.capturesBy(bob)).toBe(1);
  });

  test("by a real attack, not only by assignment", async () => {
    const { game, alice, bob } = await capitalWorld();
    // bob borders alice and attacks with everything it has.
    const { AttackExecution } =
      await import("@openfront/engine/execution/AttackExecution");
    game.addExecution(new AttackExecution(bob.troops(), bob, alice.id(), null));
    const all = run(game, 200);
    expect(
      capitalEvents(all).filter((e) => e.kind === "captured"),
    ).toHaveLength(1);
    expect(game.capitals()!.capitalOf(alice)).toBeNull();
    expect(game.capitals()!.capturesBy(bob)).toBe(1);
  });

  test("pays the troops only up to the maximum army", async () => {
    const { game, alice, bob } = await capitalWorld();
    bob.conquer(capitalTile(game, alice));
    // Already full (the tile just taken raised the maximum a little).
    bob.setTroops(game.config().maxTroops(bob));
    const events = capitalEvents(run(game, 1));
    expect(events[0].rewardTroops).toBe(0);
    expect(bob.troops()).toBeLessThanOrEqual(game.config().maxTroops(bob));
  });
});

describe("CapitalSystem: no repeated rewards", () => {
  async function fallenWorld() {
    const w = await capitalWorld({ config: { infiniteGold: true } });
    w.bob.conquer(capitalTile(w.game, w.alice));
    run(w.game, 1);
    return w;
  }

  test("a replacement taken again by the same captor pays nothing", async () => {
    const { game, alice, bob } = await fallenWorld();
    run(game, CAPITAL_SPEC.replacementDelayTicks);
    const tile = game.ref(20, 20);
    alice.conquer(tile); // alice's land again, with the interior a capital may use
    land(game, alice, 20, 20, 5);
    const found = game.capitals()!.found(alice, tile);
    expect(found).toBe(true);
    const goldBefore = bob.gold();
    bob.conquer(tile);
    const events = capitalEvents(run(game, 1));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: "captured",
      replacement: true,
      rewardGold: 0n,
      rewardTroops: 0,
    });
    expect(bob.gold()).toBe(goldBefore);
    // CRISIS still starts again for the owner.
    expect(game.capitals()!.inCrisis(alice)).toBe(true);
  });

  test("a replacement taken by someone else pays the smaller reward, once", async () => {
    const { game, alice, bob } = await capitalWorld({
      config: { infiniteGold: true },
      ids: ["alice", "bob", "carol"],
    });
    const carol = game.player("carol");
    bob.conquer(capitalTile(game, alice));
    run(game, CAPITAL_SPEC.replacementDelayTicks + 1);
    land(game, alice, 20, 20, 5);
    expect(game.capitals()!.found(alice, game.ref(20, 20))).toBe(true);
    const before = carol.gold();
    carol.conquer(game.ref(20, 20));
    const events = capitalEvents(run(game, 1));
    expect(events[0].rewardGold).toBe(CAPITAL_SPEC.captureGoldReplacement);
    expect(carol.gold()).toBe(before + CAPITAL_SPEC.captureGoldReplacement);
  });
});

describe("CapitalSystem: a capital that is destroyed or given up", () => {
  test("land that falls to no one destroys it, with no reward and no CRISIS", async () => {
    const { game, alice, bob } = await capitalWorld();
    const tile = capitalTile(game, alice);
    const goldBefore = bob.gold();
    alice.relinquish(tile); // nuked, rotted away
    const updates = run(game, 1);
    const events = capitalEvents(updates);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: "destroyed",
      captor: null,
      rewardGold: 0n,
      crisisEndTick: -1,
    });
    expect(game.capitals()!.capitalOf(alice)).toBeNull();
    expect(game.capitals()!.inCrisis(alice)).toBe(false);
    expect(game.capitals()!.crisisOf(alice)).toBeNull();
    expect(bob.gold()).toBe(goldBefore);
    expect(matchEvents(updates, "capital_captured")).toHaveLength(0);
  });

  test("an ally taking the tile is not a capture", async () => {
    const { game, alice, bob } = await capitalWorld();
    const req = alice.createAllianceRequest(bob)!;
    req.accept();
    expect(alice.isFriendly(bob)).toBe(true);
    const goldBefore = bob.gold();
    bob.conquer(capitalTile(game, alice));
    const events = capitalEvents(run(game, 1));
    expect(events.map((e) => e.kind)).toEqual(["destroyed"]);
    expect(bob.gold()).toBe(goldBefore);
    expect(game.capitals()!.inCrisis(alice)).toBe(false);
  });

  test("a player with no land left is not put in CRISIS", async () => {
    const { game, alice, bob } = await capitalWorld({ half: 1 });
    // bob takes every tile alice has in the same tick.
    for (const t of [...alice.tiles()]) bob.conquer(t);
    expect(alice.isAlive()).toBe(false);
    const events = capitalEvents(run(game, 1));
    expect(events[0].kind).toBe("captured");
    expect(events[0].crisisEndTick).toBe(-1);
    expect(game.capitals()!.crisisOf(alice)).toBeNull();
  });
});

describe("CapitalSystem: CRISIS and the economy", () => {
  test("a standing capital adds its bonus, CRISIS halves income and regeneration", async () => {
    const { game, alice, bob } = await capitalWorld();
    const caps = game.capitals()!;
    expect(caps.incomePercent(alice)).toBe(110);
    expect(caps.regenPercent(alice)).toBe(110);
    // bob has no capital to its name once it falls:
    const bobCapital = capitalTile(game, bob);
    alice.conquer(bobCapital);
    run(game, 1);
    expect(caps.inCrisis(bob)).toBe(true);
    expect(caps.incomePercent(bob)).toBe(50);
    expect(caps.regenPercent(bob)).toBe(50);
    // A player never in crisis and without a capital earns the normal amount.
    expect(caps.incomePercent(game.player("alice"))).toBe(110);
  });

  test("CRISIS ends on time, announced once, and eliminates no one", async () => {
    const { game, alice, bob } = await capitalWorld();
    bob.conquer(capitalTile(game, alice));
    run(game, 1);
    const caps = game.capitals()!;
    const end = caps.crisisOf(alice)!.endTick;
    const before = run(game, end - game.ticks() - 1);
    expect(caps.inCrisis(alice)).toBe(true);
    const after = run(game, 5);
    expect(caps.inCrisis(alice)).toBe(false);
    expect(alice.isAlive()).toBe(true);
    const ended = [...before, ...after]
      .flatMap((u) => u[GameUpdateType.DisplayEvent])
      .filter((m) => m.messageType === MessageType.CRISIS_ENDED);
    expect(ended).toHaveLength(1);
    expect(ended[0].playerID).toBe(alice.smallID());
    // The record stays, so a client can show the finished state.
    expect(caps.crisisOf(alice)!.endTick).toBe(end);
    expect(alice.toUpdate()?.crisisEndTick ?? end).toBe(end);
  });

  test("the economy hook scales gold and troop regeneration", async () => {
    const { game, alice, bob } = await capitalWorld({
      config: { infiniteGold: false },
    });
    const { PlayerExecution } =
      await import("@openfront/engine/execution/PlayerExecution");
    game.addExecution(new PlayerExecution(alice), new PlayerExecution(bob));
    // One tick to start both, one to measure.
    run(game, 1);
    const income = game.config().goldAdditionRate(alice);
    const a0 = alice.gold();
    run(game, 1);
    expect(alice.gold() - a0).toBe((income * 110n) / 100n);

    bob.conquer(capitalTile(game, alice));
    run(game, 1); // the capture is seen, CRISIS begins
    const a1 = alice.gold();
    run(game, 1);
    expect(alice.gold() - a1).toBe((income * 50n) / 100n);
  });

  test("the five-minute length lasts five minutes", async () => {
    const { game, alice, bob } = await capitalWorld({
      config: { capitalSystem: { enabled: true, crisisMinutes: 5 } },
    });
    bob.conquer(capitalTile(game, alice));
    const events = capitalEvents(run(game, 1));
    expect(events[0].crisisEndTick - game.ticks() + 1).toBe(3_000);
  });
});

describe("CapitalSystem: founding a replacement", () => {
  async function fallen() {
    const w = await capitalWorld({ config: { infiniteGold: false } });
    w.bob.conquer(capitalTile(w.game, w.alice));
    run(w.game, 1);
    // alice gets her land back, with room for an interior tile.
    land(w.game, w.alice, 20, 20, 6);
    w.alice.addGold(2_000_000n);
    return w;
  }

  test("is blocked for a player who has a capital", async () => {
    const { game, alice } = await capitalWorld();
    alice.addGold(1_000_000n);
    expect(game.capitals()!.foundBlock(alice, game.ref(21, 21))).toBe(
      "has_capital",
    );
    expect(game.capitals()!.found(alice, game.ref(21, 21))).toBe(false);
  });

  test("waits a moment after the fall, then needs gold, an owned interior tile", async () => {
    const { game, alice } = await fallen();
    const caps = game.capitals()!;
    const tile = game.ref(20, 20);
    expect(caps.foundBlock(alice, tile)).toBe("too_soon");
    run(game, CAPITAL_SPEC.replacementDelayTicks);
    expect(caps.foundBlock(alice, tile)).toBeNull();

    // not enough gold
    alice.removeGold(alice.gold());
    expect(caps.foundBlock(alice, tile)).toBe("gold");
    alice.addGold(500_000n);
    expect(caps.foundBlock(alice, tile)).toBeNull();
    // someone else's tile, a tile on the border, water
    expect(caps.foundBlock(alice, game.ref(100, 100))).toBe("not_owned");
    expect(caps.foundBlock(alice, game.ref(14, 20))).toBe("border");
    expect(caps.foundBlock(alice, -5)).toBe("tile");
  });

  test("charges the price, founds a replacement and says so", async () => {
    const { game, alice } = await fallen();
    run(game, CAPITAL_SPEC.replacementDelayTicks);
    const before = alice.gold();
    const tile = game.ref(21, 20);
    expect(game.capitals()!.found(alice, tile)).toBe(true);
    expect(alice.gold()).toBe(before - CAPITAL_SPEC.replacementCost);
    const capital = game.capitals()!.capitalOf(alice)!;
    expect(capital).toMatchObject({ tile, replacement: true });
    const updates = run(game, 1);
    expect(capitalEvents(updates).map((e) => e.kind)).toEqual([]);
    // (the founding update was emitted in the tick `found` ran in)
  });

  test("a replacement starts at half its bonus and ramps to all of it", async () => {
    const { game, alice } = await fallen();
    run(game, CAPITAL_SPEC.replacementDelayTicks);
    game.capitals()!.found(alice, game.ref(21, 20));
    const caps = game.capitals()!;
    // CRISIS is still running: 50% of (100 + 5) now.
    expect(caps.incomePercent(alice)).toBe(52);
    run(game, CAPITAL_SPEC.replacementRampTicks);
    // Full bonus 110, still halved while CRISIS lasts (3 minutes < ramp).
    expect(caps.inCrisis(alice)).toBe(false);
    expect(caps.incomePercent(alice)).toBe(110);
  });

  test("an order through the intent path does the same, and a bad one nothing", async () => {
    const { game, alice } = await fallen();
    run(game, CAPITAL_SPEC.replacementDelayTicks);
    const { FoundCapitalExecution } =
      await import("@openfront/engine/execution/FoundCapitalExecution");
    const gold = alice.gold();
    game.addExecution(new FoundCapitalExecution(alice, game.ref(100, 100)));
    run(game, 1);
    expect(alice.gold()).toBe(gold);
    expect(game.capitals()!.capitalOf(alice)).toBeNull();
    game.addExecution(new FoundCapitalExecution(alice, game.ref(21, 20)));
    const updates = run(game, 1);
    expect(game.capitals()!.capitalOf(alice)).not.toBeNull();
    expect(capitalEvents(updates).map((e) => e.kind)).toEqual(["founded"]);
    // A second order does nothing (it already has one).
    game.addExecution(new FoundCapitalExecution(alice, game.ref(22, 20)));
    run(game, 1);
    expect(game.capitals()!.capitalOf(alice)!.tile).toBe(game.ref(21, 20));
  });

  test("is free with infinite gold, like every other build", async () => {
    const { game, alice, bob } = await capitalWorld({
      config: { infiniteGold: true },
    });
    bob.conquer(capitalTile(game, alice));
    run(game, 1 + CAPITAL_SPEC.replacementDelayTicks);
    land(game, alice, 20, 20, 6);
    const gold = alice.gold();
    expect(game.capitals()!.found(alice, game.ref(21, 20))).toBe(true);
    expect(alice.gold()).toBe(gold);
  });
});

describe("CapitalSystem: determinism", () => {
  test("two identical games agree on everything, tick by tick", async () => {
    async function play() {
      const { game, alice, bob } = await capitalWorld({
        configClass: TestConfig,
      });
      const trace: number[] = [];
      bob.conquer(capitalTile(game, alice));
      for (let i = 0; i < 40; i++) {
        const u = game.executeNextTick();
        const h = u[GameUpdateType.Hash][0];
        if (h !== undefined) trace.push(h.hash);
      }
      return trace;
    }
    const a = await play();
    const b = await play();
    expect(a.length).toBeGreaterThan(0);
    expect(a).toEqual(b);
  });

  test("a capital's fall changes the game hash", async () => {
    const withCapital = await capitalWorld();
    const without = await capitalWorld({
      config: { capitalSystem: undefined },
    });
    // Same land, same tick: the system adds a term, so the hashes differ.
    withCapital.game.executeNextTick();
    without.game.executeNextTick();
    const h = (g: Game) => {
      let found = 0;
      for (let i = 0; i < 12; i++) {
        const u = g.executeNextTick()[GameUpdateType.Hash][0];
        if (u !== undefined) found = u.hash;
      }
      return found;
    };
    expect(h(withCapital.game)).not.toBe(h(without.game));
  });

  test("a single-player game uses the same rules", async () => {
    const w = await capitalWorld({
      config: { gameType: GameType.Singleplayer },
    });
    expect(w.game.capitals()).not.toBeNull();
  });
});
