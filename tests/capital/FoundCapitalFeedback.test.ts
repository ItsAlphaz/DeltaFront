import { MessageType } from "@openfront/engine-api/game/GameTypes";
import { GameUpdateType } from "@openfront/engine-api/game/GameUpdates";
import { CAPITAL_SPEC } from "@openfront/engine-lib/capital/CapitalRules";
import { FoundCapitalExecution } from "@openfront/engine/execution/FoundCapitalExecution";
import type { Game, Player } from "@openfront/engine/game/Game";
import { capitalEvents, capitalWorld, land, run } from "./helpers";

/** What one order told `player`, in the same tick it ran. */
function refusals(game: Game, player: Player, tile: number): string[] {
  game.addExecution(new FoundCapitalExecution(player, tile));
  return run(game, 1)
    .flatMap((u) => u[GameUpdateType.DisplayEvent])
    .filter(
      (m) =>
        m.playerID === player.smallID() &&
        m.messageType === MessageType.CAPITAL_ORDER,
    )
    .map((m) => m.message);
}

describe("an order to found a capital that is refused", () => {
  test("tells its sender why, and charges nothing", async () => {
    // alice has her founding capital, then loses it, and bob keeps pushing.
    const { game, alice, bob } = await capitalWorld({ half: 8 });
    alice.addGold(5_000_000n);
    const gold = alice.gold();

    // 1. She still has one.
    expect(refusals(game, alice, game.ref(20, 20))).toEqual([
      "events_display.capital_found_has_capital",
    ]);

    // 2. It falls; too soon to found another.
    bob.conquer(game.capitals()!.capitalOf(alice)!.tile);
    run(game, 1);
    land(game, alice, 20, 20, 8);
    expect(refusals(game, alice, game.ref(20, 20))).toEqual([
      "events_display.capital_found_too_soon",
    ]);

    // 3. After the wait: not hers, on the border, can't pay. Each in turn.
    run(game, CAPITAL_SPEC.replacementDelayTicks);
    expect(refusals(game, alice, game.ref(50, 20))).toEqual([
      "events_display.capital_found_not_owned",
    ]);
    expect(refusals(game, alice, game.ref(12, 20))).toEqual([
      "events_display.capital_found_border",
    ]);
    const purse = alice.gold();
    alice.removeGold(purse);
    expect(refusals(game, alice, game.ref(20, 20))).toEqual([
      "events_display.capital_found_gold",
    ]);
    expect(alice.gold()).toBe(0n);
    expect(game.capitals()!.capitalOf(alice)).toBeNull();
    expect(gold).toBeGreaterThan(0n);

    // 4. With the means, the same order works, says nothing, and pays.
    alice.addGold(CAPITAL_SPEC.cost + 1n);
    game.addExecution(new FoundCapitalExecution(alice, game.ref(20, 20)));
    const updates = run(game, 1);
    expect(capitalEvents(updates).map((e) => e.kind)).toEqual(["founded"]);
    expect(
      updates
        .flatMap((u) => u[GameUpdateType.DisplayEvent])
        .filter((m) => m.messageType === MessageType.CAPITAL_ORDER),
    ).toHaveLength(0);
    expect(alice.gold()).toBe(1n);
  });

  test("tells only the sender", async () => {
    const { game, alice, bob } = await capitalWorld();
    const told = run(game, 0);
    expect(told).toEqual([]);
    game.addExecution(new FoundCapitalExecution(alice, game.ref(20, 20)));
    const updates = run(game, 1)
      .flatMap((u) => u[GameUpdateType.DisplayEvent])
      .filter((m) => m.messageType === MessageType.CAPITAL_ORDER);
    expect(updates.map((m) => m.playerID)).toEqual([alice.smallID()]);
    expect(updates.some((m) => m.playerID === bob.smallID())).toBe(false);
  });
});
