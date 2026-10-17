import {
  GameUpdateType,
  InsurgencyPhase,
  type InsurgencyView,
} from "@openfront/engine-api/game/GameUpdates";
import { describe, expect, it } from "vitest";
import { makeEmptyGu, makeGameView } from "../util/viewStubs";

function view(
  owner: number,
  over: Partial<InsurgencyView> = {},
): InsurgencyView {
  return {
    owner,
    phase: InsurgencyPhase.Field,
    endReason: "",
    startTick: 0,
    deadline: 7_200,
    limboDeadline: -1,
    startingTroops: 1,
    capacity: 2,
    available: 1,
    deployed: 0,
    pending: [],
    funds: 0n,
    fundsStart: 0n,
    strength: 50,
    bases: [],
    operations: [],
    regions: [],
    intel: [],
    intelReadyTick: 0,
    suppressions: [],
    reclaimed: 0,
    ...over,
  };
}

function send(
  game: ReturnType<typeof makeGameView>,
  tick: number,
  ...views: InsurgencyView[]
) {
  const gu = makeEmptyGu(tick);
  gu.updates[GameUpdateType.InsurgencyState] = views.map((v) => ({
    type: GameUpdateType.InsurgencyState,
    tick,
    view: v,
  }));
  game.update(gu);
}

describe("GameView and the resistance", () => {
  it("knows of none until the engine reports one", () => {
    const game = makeGameView();
    expect(game.insurgencyOf(1)).toBeNull();
    expect([...game.insurgencies()]).toEqual([]);
  });

  it("keeps the latest state of each owner's resistance, and every owner's", () => {
    const game = makeGameView();
    const first = view(1);
    const other = view(2, { funds: 5n });
    send(game, 1, first, other);
    expect(game.insurgencyOf(1)).toBe(first);
    expect(game.insurgencyOf(2)).toBe(other);
    const newer = view(1, { funds: 9n });
    send(game, 2, newer);
    expect(game.insurgencyOf(1)).toBe(newer);
    expect(game.insurgencyOf(2)).toBe(other);
    expect([...game.insurgencies()]).toHaveLength(2);
  });

  it("keeps a resistance that has ended, so the player can be told how", () => {
    const game = makeGameView();
    send(game, 1, view(1));
    send(
      game,
      2,
      view(1, { phase: InsurgencyPhase.Ended, endReason: "exhausted" }),
    );
    expect(game.insurgencyOf(1)!.phase).toBe(InsurgencyPhase.Ended);
    expect(game.insurgencyOf(1)!.endReason).toBe("exhausted");
  });
});
