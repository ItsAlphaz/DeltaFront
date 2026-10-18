import {
  MessageType,
  PlayerInfo,
  PlayerType,
} from "@openfront/engine-api/game/GameTypes";
import {
  GameUpdateType,
  InsurgencyPhase,
  InsurgencyRegionStatus,
} from "@openfront/engine-api/game/GameUpdates";
import { buyCapital, human, land, matchEvents } from "../capital/helpers";
import { setup } from "../util/Setup";
import {
  SPEC,
  captureCapital,
  insurgentWorld,
  occupyRegion0,
  rect,
  resistance,
  run,
  viewIn,
} from "./helpers";

describe("a capital's fall starts the owner's resistance", () => {
  test("a human with an army and land gets one, a tenth of the army strong", async () => {
    const w = await insurgentWorld();
    const armyBefore = w.alice.troops();
    const updates = [captureCapital(w)];
    const ins = resistance(w.game, w.alice);

    expect(ins.status).toBe("active");
    expect(ins.startingTroops).toBe(100_000); // a tenth of 1,000,000
    expect(ins.available).toBe(100_000);
    expect(ins.capacity).toBe(200_000);
    expect(ins.captor).toBe(w.bob.smallID());
    // The purse: a share of what she earned, floored.
    expect(ins.funds).toBe(SPEC.startFundsMin);
    expect(ins.fundsStart).toBe(ins.funds);
    // It rises from the army that fell: taken from it, not made.
    expect(w.alice.troops()).toBe(armyBefore - 100_000);
    // Her land is her national regions.
    expect(ins.regions.map((r) => r.id)).toEqual([0]);
    expect(ins.regions[0].former).toBeGreaterThanOrEqual(1000);
    expect(ins.deadline).toBe(ins.startTick + SPEC.survivalTicks);

    // Both players, and the feed, are told.
    const messages = updates.flatMap((u) => u[GameUpdateType.DisplayEvent]);
    const toAlice = messages.find(
      (m) => m.messageType === MessageType.INSURGENCY_STARTED,
    )!;
    expect(toAlice.playerID).toBe(w.alice.smallID());
    expect(toAlice.params).toMatchObject({ troops: "10.0K" });
    const toBob = messages.find(
      (m) => m.messageType === MessageType.INSURGENCY_WARNING,
    )!;
    expect(toBob.playerID).toBe(w.bob.smallID());
    const feed = matchEvents(updates, "insurgency_started");
    expect(feed).toHaveLength(1);
    expect(feed[0]).toMatchObject({
      actor: w.bob.smallID(),
      target: w.alice.smallID(),
    });
  });

  test("the strength is capped at 25,000 troops on screen", async () => {
    const w = await insurgentWorld();
    w.alice.setTroops(500_000_000);
    captureCapital(w);
    expect(resistance(w.game, w.alice).startingTroops).toBe(250_000);
    expect(SPEC.startTroopsMax / 10).toBe(25_000);
  });

  test("not for an army too small to rise with: an early capture", async () => {
    const w = await insurgentWorld();
    w.alice.setTroops(99_999); // a tenth is under the minimum
    const armyBefore = w.alice.troops();
    captureCapital(w);
    expect(w.game.insurgency()!.of(w.alice)).toBeNull();
    expect(w.alice.troops()).toBe(armyBefore);
    // CRISIS is separate: it still starts.
    expect(w.game.capitals()!.inCrisis(w.alice)).toBe(true);
  });

  test("not for a nation or a tribe: the resistance is a human's to command", async () => {
    const game = await setup(
      "big_plains",
      { capitalSystem: { enabled: true } },
      [
        new PlayerInfo("nation", PlayerType.Nation, null, "nation"),
        human("bob"),
      ],
    );
    const nation = game.player("nation");
    const bob = game.player("bob");
    rect(game, nation, 0, 0, 31, 31);
    nation.setSpawnTile(game.ref(16, 16));
    rect(game, bob, 32, 0, 63, 31);
    bob.setSpawnTile(game.ref(48, 16));
    nation.setTroops(1_000_000);
    game.executeNextTick();
    buyCapital(game, nation);
    bob.conquer(game.capitals()!.capitalOf(nation)!.tile);
    game.executeNextTick();
    expect(game.insurgency()!.of(nation)).toBeNull();
    expect(game.capitals()!.inCrisis(nation)).toBe(true);
  });

  test("only once per match: a rebuilt capital's fall does not start another", async () => {
    const w = await insurgentWorld({ infiniteGold: true });
    captureCapital(w);
    expect(resistance(w.game, w.alice).status).toBe("active");
    const first = resistance(w.game, w.alice);
    const gold = first.funds;
    run(w.game, 400);
    land(w.game, w.alice, 10, 10, 6);
    expect(w.game.capitals()!.found(w.alice, w.game.ref(10, 10))).toBe(true);
    w.carol.conquer(w.game.ref(10, 10));
    run(w.game, 2);
    // Still the one resistance, with the same purse and the same start.
    expect(w.game.insurgency()!.all()).toHaveLength(1);
    expect(resistance(w.game, w.alice)).toBe(first);
    expect(first.fundsStart).toBe(gold);
    expect(first.startingTroops).toBe(100_000);
  });

  test("not when the match has no Capital System", async () => {
    const game = await setup("big_plains", {}, [human("alice"), human("bob")]);
    expect(game.insurgency()).toBeNull();
    expect(game.capitals()).toBeNull();
  });

  test("not when its owner has no national land to rise on", async () => {
    const w = await insurgentWorld();
    // Her land is her capital's tile and a few scattered tiles: no region of
    // hers holds enough to be worth resisting for.
    for (const t of [...w.alice.tiles()]) w.alice.relinquish(t);
    const capital = w.game.capitals()!.capitalOf(w.alice)!.tile;
    w.alice.conquer(capital);
    for (let i = 0; i < 5; i++) w.alice.conquer(w.game.ref(2 * i, 2 * i));
    w.bob.conquer(capital);
    run(w.game, 2);
    expect(w.game.insurgency()!.of(w.alice)).toBeNull();
    // The capital still fell: CRISIS.
    expect(w.game.capitals()!.inCrisis(w.alice)).toBe(true);
  });

  test("the state is sent to the clients, with the regions and their bands", async () => {
    const w = await insurgentWorld();
    const first = [captureCapital(w)];
    const view = viewIn(first, w.alice.smallID())!;
    expect(view.phase).toBe(InsurgencyPhase.Field);
    expect(view.capacity).toBe(200_000);
    expect(view.available).toBe(100_000);
    expect(view.strength).toBe(50);
    expect(view.regions).toHaveLength(1);
    expect(view.regions[0].status).toBe(InsurgencyRegionStatus.Held);
    const later = occupyRegion0(w);
    run(w.game, 6).forEach((u) => later.push(u));
    const view2 = viewIn(later, w.alice.smallID())!;
    expect(view2.regions[0].status).toBe(InsurgencyRegionStatus.Occupied);
    // Between 25 and 50 to start: unsettled.
    expect(view2.regions[0].band).toBeGreaterThanOrEqual(1);
    expect(view2.regions[0].occupier).toBe(w.bob.smallID());
  });
});
