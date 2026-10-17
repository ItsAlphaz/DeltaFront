import { PlayerInfo, PlayerType } from "@openfront/engine-api/game/GameTypes";
import { CAPITAL_SPEC } from "@openfront/engine-lib/capital/CapitalRules";
import type { Game, Player } from "@openfront/engine/game/Game";
import { capitalWorld, land, run } from "./helpers";

/** The captures a player is credited with for XP, as the game record will carry them. */
function captures(game: Game, p: Player) {
  return game.stats().getPlayerStats(p)?.capitals ?? [];
}

const capitalTile = (game: Game, p: Player) =>
  game.capitals()!.capitalOf(p)!.tile;

describe("capital captures in the stats (what the capture XP reads)", () => {
  test("a paid capture of a human's capital is recorded once, with who and when", async () => {
    const { game, alice, bob } = await capitalWorld();
    expect(captures(game, bob)).toEqual([]);
    bob.conquer(capitalTile(game, alice));
    run(game, 1);
    expect(captures(game, bob)).toEqual([
      { victim: "alice", tick: BigInt(game.ticks() - 1) },
    ]);
    // The captured player's own record is not touched.
    expect(captures(game, alice)).toEqual([]);
  });

  test("not again for the same owner: a rebuilt capital taken once more pays nothing, and counts for nothing", async () => {
    const { game, alice, bob } = await capitalWorld({
      config: { infiniteGold: true },
    });
    bob.conquer(capitalTile(game, alice));
    run(game, 1 + CAPITAL_SPEC.replacementDelayTicks);
    land(game, alice, 20, 20, 6);
    expect(game.capitals()!.found(alice, game.ref(21, 20))).toBe(true);
    bob.conquer(game.ref(21, 20));
    run(game, 1);
    // Two captures of alice's capitals, one credit.
    expect(game.capitals()!.capturesBy(bob)).toBe(2);
    expect(captures(game, bob)).toHaveLength(1);
  });

  test("another captor is credited for the same owner: the rule is the pair's", async () => {
    const { game, alice, bob, players } = await capitalWorld({
      ids: ["alice", "bob", "carol"],
    });
    const carol = players.carol;
    bob.conquer(capitalTile(game, alice));
    run(game, 1);
    // carol takes bob's, and alice (still a human with a capital to lose) takes carol's.
    carol.conquer(capitalTile(game, bob));
    run(game, 1);
    expect(captures(game, carol).map((c) => c.victim)).toEqual(["bob"]);
    expect(captures(game, bob).map((c) => c.victim)).toEqual(["alice"]);
  });

  test("nothing for a nation or a bot: they are not players the XP counts", async () => {
    const { game, alice } = await capitalWorld();
    const nation = game.addPlayer(
      new PlayerInfo("Nation", PlayerType.Nation, null, "nation01"),
    );
    land(game, nation, 60, 20, 4);
    nation.setSpawnTile(game.ref(60, 20));
    run(game, 1);
    expect(game.capitals()!.capitalOf(nation)).not.toBeNull();
    alice.conquer(capitalTile(game, nation));
    run(game, 1);
    // Gold and troops were paid (the Capital System's own), but no XP credit.
    expect(game.capitals()!.capturesBy(alice)).toBe(1);
    expect(captures(game, alice)).toEqual([]);
  });

  test("a capital that was destroyed, not captured, credits nobody", async () => {
    const { game, alice, bob } = await capitalWorld();
    const tile = capitalTile(game, alice);
    alice.relinquish(tile);
    run(game, 1);
    expect(game.capitals()!.capitalOf(alice)).toBeNull();
    expect(captures(game, bob)).toEqual([]);
  });
});
