import { CAPITAL_SPEC } from "@openfront/engine-lib/capital/CapitalRules";
import { setup } from "../util/Setup";
import {
  FullStrengthConfig,
  capitalWorld,
  human,
  run,
  startEconomy,
} from "./helpers";

describe("an army above its maximum drains away over seconds", () => {
  test("losing the capital (and its +400K troop cap) does not cut the army in one tick", async () => {
    const { game, alice, bob } = await capitalWorld({
      configClass: FullStrengthConfig,
    });
    startEconomy(game, alice);
    startEconomy(game, bob);
    run(game, 3);
    const config = game.config();
    alice.setTroops(config.maxTroops(alice));
    const before = alice.troops();
    const newMax = before - CAPITAL_SPEC.bonusMaxTroops;
    bob.conquer(game.capitals()!.capitalOf(alice)!.tile);
    run(game, 2);
    // Two ticks on, most of it is still there (it was 74% gone before; the
    // few percent that go at once are what a lost tile takes with it).
    expect(alice.troops()).toBeGreaterThan(before * 0.8);
    // It drains steadily and never below the new maximum.
    let last = alice.troops();
    for (let i = 0; i < 200; i++) {
      run(game, 1);
      expect(alice.troops()).toBeLessThanOrEqual(last + 1);
      expect(alice.troops()).toBeGreaterThanOrEqual(
        config.maxTroops(alice) - 1,
      );
      last = alice.troops();
    }
    // About twenty seconds on, it is close to the new maximum.
    expect(last).toBeLessThan(
      config.maxTroops(alice) + (before - newMax) * 0.1,
    );
    run(game, 600);
    expect(alice.troops()).toBeLessThanOrEqual(config.maxTroops(alice) + 50);
  });

  test("a match without the Capital System keeps the old cut: above the maximum, down to it at once", async () => {
    const game = await setup("big_plains", {}, [human("a")]);
    const a = game.player("a");
    for (let y = 20; y < 30; y++)
      for (let x = 20; x < 30; x++) a.conquer(game.ref(x, y));
    startEconomy(game, a);
    run(game, 2);
    a.setTroops(game.config().maxTroops(a) * 3);
    run(game, 2);
    expect(a.troops()).toBeLessThanOrEqual(game.config().maxTroops(a) + 1);
  });
});
