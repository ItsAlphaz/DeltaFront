import { UnitType } from "@openfront/engine-api/game/GameTypes";
import { GameUpdateType } from "@openfront/engine-api/game/GameUpdates";
import { CAPITAL_SPEC } from "@openfront/engine-lib/capital/CapitalRules";
import { SAM_CONSTRUCTION_TICKS } from "@openfront/engine-lib/configuration/Config";
import { FoundCapitalExecution } from "@openfront/engine/execution/FoundCapitalExecution";
import {
  isSavingForCapital,
  maybeFoundNationCapital,
} from "@openfront/engine/execution/nation/NationCapitalBehavior";
import { expectSnapshotRoundTrip } from "../util/Snapshot";
import { RealCapitalBuildConfig } from "../util/TestConfig";
import { capitalEvents, capitalWorld, land, run } from "./helpers";

/** A capital takes as long to build as a SAM launcher, and gives nothing until it stands. */
async function world(config: Parameters<typeof capitalWorld>[0] = {}) {
  const w = await capitalWorld({
    skipFirstTick: true,
    configClass: RealCapitalBuildConfig,
    ...config,
  });
  run(w.game, 1);
  w.alice.addGold(CAPITAL_SPEC.cost);
  return w;
}

describe("a capital is built, not bought at once", () => {
  test("it takes as long as a SAM launcher, and none with instant build", async () => {
    const { game } = await world();
    expect(game.config().capitalBuildTicks()).toBe(SAM_CONSTRUCTION_TICKS);
    expect(game.config().capitalBuildTicks()).toBe(
      game.config().unitInfo(UnitType.SAMLauncher).constructionDuration,
    );
    const quick = await world({ config: { instantBuild: true } });
    expect(quick.game.config().capitalBuildTicks()).toBe(0);
    expect(
      quick.game.capitals()!.found(quick.alice, quick.game.ref(20, 20)),
    ).toBe(true);
    expect(quick.game.capitals()!.capitalOf(quick.alice)).not.toBeNull();
  });

  test("buying charges the gold and starts the building; the capital gives nothing yet", async () => {
    const { game, alice } = await world();
    const caps = game.capitals()!;
    const gold = alice.gold();
    const maxBefore = game.config().maxTroops(alice);
    const now = game.ticks();
    expect(caps.found(alice, game.ref(20, 20))).toBe(true);
    expect(alice.gold()).toBe(gold - CAPITAL_SPEC.cost);
    const build = caps.buildingOf(alice)!;
    expect(build).toMatchObject({
      tile: game.ref(20, 20),
      startTick: now,
      endTick: now + SAM_CONSTRUCTION_TICKS,
      replacement: false,
    });
    // Not a capital: no bonuses, no gate opened, nothing to capture.
    expect(caps.capitalOf(alice)).toBeNull();
    expect(caps.strengthOf(alice)).toBe(0);
    expect(game.config().maxTroops(alice)).toBe(maxBefore);
    expect(alice.needsCapitalFor(UnitType.MissileSilo)).toBe(true);
    // The client is told where, and until when.
    const u = run(game, 1)[0][GameUpdateType.Player].find(
      (p) => p.id === alice.id(),
    )!;
    expect(u.capitalBuildTile).toBe(game.ref(20, 20));
    expect(u.capitalBuildStartTick).toBe(now);
    expect(u.capitalBuildEndTick).toBe(now + SAM_CONSTRUCTION_TICKS);
  });

  test("announces the start once, and the capital stands exactly when the building ends", async () => {
    const { game, alice } = await world();
    const caps = game.capitals()!;
    // The order, as a player sends it: the update is made in the tick it runs.
    game.addExecution(new FoundCapitalExecution(alice, game.ref(20, 20)));
    const started = capitalEvents(run(game, 1));
    const start = caps.buildingOf(alice)!.startTick;
    expect(started.map((e) => e.kind)).toEqual(["building"]);
    expect(started[0].completeTick).toBe(start + SAM_CONSTRUCTION_TICKS);
    // Still building until its time, then it stands, in the very tick.
    const end = caps.buildingOf(alice)!.endTick;
    const kinds: string[] = [];
    while (caps.capitalOf(alice) === null) {
      expect(game.ticks()).toBeLessThanOrEqual(end + 1);
      expect(caps.buildingOf(alice)).not.toBeNull();
      kinds.push(...capitalEvents(run(game, 1)).map((e) => e.kind));
    }
    expect(kinds).toEqual(["founded"]);
    const capital = caps.capitalOf(alice)!;
    expect(capital.id).toBe(started[0].capitalId);
    expect(capital.foundedTick).toBeGreaterThanOrEqual(end);
    expect(capital.foundedTick).toBeLessThanOrEqual(end + 1);
    expect(caps.buildingOf(alice)).toBeNull();
    expect(caps.strengthOf(alice)).toBe(50);
    expect(alice.needsCapitalFor(UnitType.MissileSilo)).toBe(false);
  });

  test("a second order while it is being built is refused and charges nothing", async () => {
    const { game, alice } = await world();
    const caps = game.capitals()!;
    caps.found(alice, game.ref(20, 20));
    alice.addGold(CAPITAL_SPEC.cost);
    const gold = alice.gold();
    expect(caps.foundBlock(alice, game.ref(21, 20))).toBe("building");
    game.addExecution(new FoundCapitalExecution(alice, game.ref(21, 20)));
    const updates = run(game, 1);
    expect(alice.gold()).toBe(gold);
    expect(caps.buildingOf(alice)!.tile).toBe(game.ref(20, 20));
    const said = updates
      .flatMap((u) => u[GameUpdateType.DisplayEvent])
      .map((m) => m.message);
    expect(said).toContain("events_display.capital_found_building");
  });

  test("losing the land under it ends the building: nothing is refunded, nobody is paid, no CRISIS", async () => {
    const { game, alice, bob } = await world();
    const caps = game.capitals()!;
    const goldAfterBuy = alice.gold() - CAPITAL_SPEC.cost;
    caps.found(alice, game.ref(20, 20));
    run(game, 100);
    const bobGold = bob.gold();
    bob.conquer(game.ref(20, 20));
    const events = capitalEvents(run(game, 1));
    expect(events.map((e) => e.kind)).toEqual(["cancelled"]);
    expect(events[0].rewardGold).toBe(0n);
    expect(caps.buildingOf(alice)).toBeNull();
    expect(caps.capitalOf(alice)).toBeNull();
    expect(caps.inCrisis(alice)).toBe(false);
    expect(caps.crisisOf(alice)).toBeNull();
    expect(bob.gold()).toBe(bobGold);
    expect(alice.gold()).toBe(goldAfterBuy);
    // It is not a capital that fell, so the next is not a replacement.
    land(game, alice, 20, 20, 6);
    alice.addGold(CAPITAL_SPEC.cost);
    caps.found(alice, game.ref(21, 20));
    expect(caps.buildingOf(alice)!.replacement).toBe(false);
  });

  test("a rebuilt capital is still a replacement when it stands", async () => {
    const { game, alice, bob } = await world();
    const caps = game.capitals()!;
    caps.found(alice, game.ref(20, 20));
    run(game, SAM_CONSTRUCTION_TICKS + 1);
    bob.conquer(caps.capitalOf(alice)!.tile);
    run(game, 1);
    land(game, alice, 20, 20, 6);
    run(game, CAPITAL_SPEC.replacementDelayTicks);
    alice.addGold(CAPITAL_SPEC.cost);
    expect(caps.found(alice, game.ref(21, 20))).toBe(true);
    expect(caps.buildingOf(alice)!.replacement).toBe(true);
    run(game, SAM_CONSTRUCTION_TICKS + 1);
    expect(caps.capitalOf(alice)).toMatchObject({ replacement: true });
  });

  test("snapshots while it is being built, and the restored game finishes it", async () => {
    const { game, alice } = await world();
    game.capitals()!.found(alice, game.ref(20, 20));
    run(game, 50);
    const restored = await expectSnapshotRoundTrip(game, "big_plains", 20);
    const a = restored.player("alice");
    expect(restored.capitals()!.buildingOf(a)).toMatchObject({
      tile: game.ref(20, 20),
    });
  });

  test("a nation that has paid does not save or buy again while it waits", async () => {
    const { game, alice } = await world();
    run(game, 8 * 600); // old enough to start saving
    const caps = game.capitals()!;
    alice.addGold(CAPITAL_SPEC.cost);
    expect(isSavingForCapital(game, alice)).toBe(true);
    expect(maybeFoundNationCapital(game, alice)).toBe(true);
    expect(caps.buildingOf(alice)).not.toBeNull();
    alice.addGold(CAPITAL_SPEC.cost);
    expect(isSavingForCapital(game, alice)).toBe(false);
    expect(maybeFoundNationCapital(game, alice)).toBe(false);
  });
});
