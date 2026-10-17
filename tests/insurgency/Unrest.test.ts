import {
  GameUpdateType,
  InsurgencyRegionStatus,
} from "@openfront/engine-api/game/GameUpdates";
import { unrestCap } from "@openfront/engine-lib/insurgency/InsurgencyRules";
import {
  SPEC,
  captureCapital,
  insurgentWorld,
  occupyRegion0,
  rect,
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

describe("unrest", () => {
  test("a region starts restless in proportion to the land that was held, once occupied", async () => {
    const w = await occupied();
    const region = regionOf(w.game, w.alice);
    expect(region.status).toBe(InsurgencyRegionStatus.Occupied);
    expect(region.occupier).toBe(w.bob.smallID());
    expect(region.unrest).toBeGreaterThanOrEqual(SPEC.unrestStartMin);
    expect(region.unrest).toBeLessThanOrEqual(SPEC.unrestStartMax);
  });

  test("a region still held by its owner has none", async () => {
    const w = await insurgentWorld();
    captureCapital(w);
    runToUpdate(w.game, 3);
    const region = regionOf(w.game, w.alice);
    expect(region.status).toBe(InsurgencyRegionStatus.Held);
    expect(region.unrest).toBe(0);
  });

  test("rises where the occupier's army is thin, and falls where it is strong", async () => {
    const w = await occupied();
    const region = regionOf(w.game, w.alice);
    const max = w.game.config().maxTroops(w.bob);

    region.unrest = 40;
    w.bob.setTroops(Math.floor(max * 0.2)); // thin
    runToUpdate(w.game, 5);
    const thin = region.unrest;
    expect(thin).toBeGreaterThan(40);

    region.unrest = 40;
    w.bob.setTroops(Math.floor(max * 0.95)); // strong
    runToUpdate(w.game, 5);
    expect(region.unrest).toBeLessThan(40);
  });

  test("never climbs without limit against a heavily defended region", async () => {
    const w = await occupied();
    const region = regionOf(w.game, w.alice);
    const max = w.game.config().maxTroops(w.bob);
    w.bob.setTroops(Math.floor(max * 0.95));
    // The resistance does everything it can: a base, an uprising under way.
    region.unrest = 80;
    resistance(w.game, w.alice).bases.push({
      id: 99,
      region: 0,
      tile: w.game.ref(10, 5),
      foundedTick: 0,
      integrity: 100,
    });
    runToUpdate(w.game, 100);
    expect(region.unrest).toBeLessThan(80);
    expect(region.unrest).toBeGreaterThanOrEqual(0);
  });

  test("reaches the top and stays there, never past 100", async () => {
    const w = await occupied();
    const region = regionOf(w.game, w.alice);
    w.bob.setTroops(1_000);
    runToUpdate(w.game, 80);
    expect(region.unrest).toBe(100);
  });

  test("a base helps it along", async () => {
    const w = await occupied();
    const ins = resistance(w.game, w.alice);
    const region = regionOf(w.game, w.alice);
    const max = w.game.config().maxTroops(w.bob);
    w.bob.setTroops(Math.floor(max * 0.45)); // middling: +1, +1 with a base
    region.unrest = 30;
    runToUpdate(w.game, 4);
    const without = region.unrest;
    expect(without).toBe(34);
    region.unrest = 30;
    ins.bases.push({
      id: 99,
      region: 0,
      tile: w.game.ref(10, 5),
      foundedTick: 0,
      integrity: 100,
    });
    runToUpdate(w.game, 4);
    expect(region.unrest).toBe(38);
  });

  test("warns the occupier once when a region turns volatile, and again only after it settles", async () => {
    const w = await occupied();
    const region = regionOf(w.game, w.alice);
    const max = w.game.config().maxTroops(w.bob);
    const warnings = (updates: ReturnType<typeof runToUpdate>) =>
      updates
        .flatMap((u) => u[GameUpdateType.DisplayEvent])
        .filter(
          (m) =>
            m.message === "events_display.insurgency_region_volatile" ||
            m.message === "events_display.insurgency_region_uprising",
        );
    w.bob.setTroops(Math.floor(max * 0.1));
    region.unrest = SPEC.volatileAt - 2;
    const first = warnings(runToUpdate(w.game, 3));
    expect(first.length).toBeGreaterThanOrEqual(1);
    expect(first.every((m) => m.playerID === w.bob.smallID())).toBe(true);
    // Staying volatile does not repeat it.
    expect(warnings(runToUpdate(w.game, 6))).toHaveLength(
      first.filter((m) => m.message.endsWith("uprising")).length > 0 ? 0 : 0,
    );
    // It settles below the re-arm line and then rises again: one more.
    w.bob.setTroops(Math.floor(max * 0.99));
    region.unrest = SPEC.volatileRearmAt - 1;
    runToUpdate(w.game, 2);
    w.bob.setTroops(Math.floor(max * 0.1));
    region.unrest = SPEC.volatileAt - 2;
    expect(warnings(runToUpdate(w.game, 3)).length).toBeGreaterThanOrEqual(1);
  });

  test("each time a region changes hands the most it can ever reach falls", async () => {
    const w = await occupied();
    const region = regionOf(w.game, w.alice);
    w.bob.setTroops(1_000); // so thin it would climb to 100
    // alice takes the region back (a hand-over), then bob retakes it (another).
    for (let flips = 1; flips <= 4; flips++) {
      rect(w.game, w.alice, 0, 0, 31, 31);
      runToUpdate(w.game);
      expect(region.status).toBe(InsurgencyRegionStatus.Held);
      rect(w.game, w.bob, 0, 0, 31, 21);
      // Long enough to climb to the ceiling, short of the survival deadline.
      runToUpdate(w.game, 30);
      expect(region.status).toBe(InsurgencyRegionStatus.Occupied);
      expect(region.unrest).toBeLessThanOrEqual(unrestCap(SPEC, region.flips));
    }
    expect(region.flips).toBe(8); // four reclaims and four retakings
    expect(region.unrest).toBe(SPEC.unrestCapMin);
    // So far down that an uprising can no longer be called there.
    expect(SPEC.unrestCapMin).toBeLessThan(SPEC.uprisingMinUnrest);
    expect(
      w.game.insurgency()!.uprising(w.alice, 0, SPEC.uprisingMinTroops),
    ).toBe("unrest");
  });

  test("moving land back and forth pays the reclaim reward once, and gains no time after the first", async () => {
    const w = await occupied();
    const ins = resistance(w.game, w.alice);
    const deadline = ins.deadline;
    const funds = ins.funds;
    for (let i = 0; i < 6; i++) {
      rect(w.game, w.alice, 0, 0, 31, 31);
      runToUpdate(w.game);
      rect(w.game, w.bob, 0, 0, 31, 21);
      runToUpdate(w.game);
    }
    expect(ins.reclaimed).toBe(1);
    expect(ins.funds).toBe(funds + SPEC.reclaimFunds);
    expect(ins.deadline).toBe(deadline + SPEC.survivalExtensionTicks);
    expect(regionOf(w.game, w.alice).flips).toBeGreaterThan(5);
  });

  test("a region neither side holds keeps what unrest it had", async () => {
    const w = await occupied();
    const region = regionOf(w.game, w.alice);
    region.unrest = 66;
    // Both lose it (a nuke, a wasteland): nobody holds most of it.
    for (const t of [...w.bob.tiles()]) {
      const x = w.game.x(t);
      const y = w.game.y(t);
      if (x < 32 && y < 32) w.bob.relinquish(t);
    }
    for (const t of [...w.alice.tiles()]) {
      if (w.game.x(t) < 32 && w.game.y(t) < 32) w.alice.relinquish(t);
    }
    runToUpdate(w.game, 2);
    expect(region.status).toBe(InsurgencyRegionStatus.Contested);
    expect(region.unrest).toBe(66);
    run(w.game, 1);
  });
});
