import {
  GameUpdateType,
  InsurgencyRegionStatus,
} from "@openfront/engine-api/game/GameUpdates";
import {
  SPEC,
  captureCapital,
  insurgentWorld,
  makeRestless,
  occupyRegion0,
  regionOf,
  resistance,
  run,
  runToUpdate,
} from "./helpers";

async function occupied() {
  const w = await insurgentWorld();
  captureCapital(w);
  occupyRegion0(w);
  return w;
}

describe("the occupier's suppression", () => {
  test("takes troops out of the occupier's army for its time, and most come home", async () => {
    const w = await occupied();
    const sys = w.game.insurgency()!;
    const ins = resistance(w.game, w.alice);
    const before = w.bob.troops();
    expect(sys.suppress(w.bob, w.alice, 0)).toBeNull();
    const sent = Math.max(
      SPEC.suppressMinTroops,
      Math.floor((before * SPEC.suppressPercent) / 100),
    );
    expect(w.bob.troops()).toBe(before - sent);
    expect(ins.suppressions).toHaveLength(1);
    expect(ins.suppressions[0]).toMatchObject({
      occupier: w.bob.smallID(),
      region: 0,
      troops: sent,
    });
    // It is not attacking anyone meanwhile; when it ends, most are back.
    run(w.game, SPEC.suppressTicks + 2);
    expect(ins.suppressions).toHaveLength(0);
    expect(w.bob.troops()).toBe(
      before - sent + Math.floor((sent * SPEC.suppressReturnPercent) / 100),
    );
    expect(w.bob.troops()).toBeLessThan(before);
  });

  test("cools the region, whatever else is pushing it up", async () => {
    const w = await occupied();
    const region = regionOf(w.game, w.alice);
    w.bob.setTroops(Math.floor(w.game.config().maxTroops(w.bob) * 0.1));
    region.unrest = 50;
    w.game.insurgency()!.suppress(w.bob, w.alice, 0);
    runToUpdate(w.game, 3);
    // +2 thin, -3 suppression: down 1 a update.
    expect(region.unrest).toBeLessThan(50);
  });

  test("wears a base down and destroys it, telling both sides", async () => {
    const w = await occupied();
    const ins = resistance(w.game, w.alice);
    makeRestless(w.game, w.alice, 60);
    expect(
      w.game.insurgency()!.foundBase(w.alice, w.game.ref(10, 5)),
    ).toBeNull();
    // bob has money for an army: enough to suppress for a good while.
    w.game.insurgency()!.suppress(w.bob, w.alice, 0);
    const all = runToUpdate(w.game, 8);
    expect(ins.bases).toHaveLength(0);
    const messages = all.flatMap((u) => u[GameUpdateType.DisplayEvent]);
    expect(
      messages.some(
        (m) =>
          m.message === "events_display.insurgency_base_destroyed" &&
          m.playerID === w.alice.smallID(),
      ),
    ).toBe(true);
    expect(
      messages.some(
        (m) =>
          m.message === "events_display.insurgency_base_destroyed_occupier" &&
          m.playerID === w.bob.smallID(),
      ),
    ).toBe(true);
  });

  test("a base nobody suppresses stands", async () => {
    const w = await occupied();
    const ins = resistance(w.game, w.alice);
    makeRestless(w.game, w.alice, 60);
    w.game.insurgency()!.foundBase(w.alice, w.game.ref(10, 5));
    runToUpdate(w.game, 10);
    expect(ins.bases).toHaveLength(1);
    expect(ins.bases[0].integrity).toBe(100);
  });

  test("wears down an uprising in the region", async () => {
    const w = await occupied();
    const ins = resistance(w.game, w.alice);
    const sys = w.game.insurgency()!;
    makeRestless(w.game, w.alice, 80);
    sys.uprising(w.alice, 0, 40_000);
    run(w.game, 3);
    const attack = w.alice.outgoingAttacks()[0];
    sys.suppress(w.bob, w.alice, 0);
    const before = attack.troops();
    runToUpdate(w.game, 2);
    // (the fight costs a troop a tile; the rest is suppression)
    expect(attack.troops()).toBeLessThan(before * 0.97);
    expect(ins.ops).toHaveLength(1);
  });

  test("only a few at a time, one to a region, and only against land it holds", async () => {
    const w = await occupied();
    const sys = w.game.insurgency()!;
    expect(sys.suppress(w.bob, w.alice, 0)).toBeNull();
    expect(sys.suppress(w.bob, w.alice, 0)).toBe("busy");
    // carol holds nothing of alice's land.
    expect(sys.suppress(w.carol, w.alice, 0)).toBe("not_occupied");
    // not a region of hers
    expect(sys.suppress(w.bob, w.alice, 5)).toBe("region");
    expect(sys.suppress(w.bob, w.alice, -1)).toBe("region");
    // alice cannot suppress herself, nor an ally her
    expect(sys.suppress(w.alice, w.alice, 0)).toBe("target");
    // nobody to suppress
    expect(sys.suppress(w.bob, w.carol, 0)).toBe("target");
  });

  test("not by an ally of the resistance", async () => {
    const w = await occupied();
    w.alice.createAllianceRequest(w.bob)!.accept();
    expect(w.game.insurgency()!.suppress(w.bob, w.alice, 0)).toBe("target");
  });

  test("needs the troops: nothing is taken for an order that is refused", async () => {
    const w = await occupied();
    w.bob.setTroops(SPEC.suppressMinTroops - 1);
    expect(w.game.insurgency()!.suppress(w.bob, w.alice, 0)).toBe("troops");
    expect(w.bob.troops()).toBe(SPEC.suppressMinTroops - 1);
  });

  test("when the resistance ends, the troops sent come home whole", async () => {
    const w = await occupied();
    const ins = resistance(w.game, w.alice);
    const before = w.bob.troops();
    w.game.insurgency()!.suppress(w.bob, w.alice, 0);
    ins.deadline = w.game.ticks() + 1;
    run(w.game, 5);
    expect(ins.status).toBe("ended");
    expect(w.bob.troops()).toBe(before);
  });

  test("shows in the region's view while it lasts", async () => {
    const w = await occupied();
    const sys = w.game.insurgency()!;
    const ins = resistance(w.game, w.alice);
    sys.suppress(w.bob, w.alice, 0);
    const view = sys.view(ins);
    expect(view.suppressions).toEqual([
      expect.objectContaining({ region: 0, occupier: w.bob.smallID() }),
    ]);
    expect(view.regions[0].suppressed).toBe(true);
    expect(view.regions[0].status).toBe(InsurgencyRegionStatus.Occupied);
  });
});
