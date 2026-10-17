import { PlayerInfo, PlayerType } from "@openfront/engine-api/game/GameTypes";
import { CAPITAL_SPEC } from "@openfront/engine-lib/capital/CapitalRules";
import { maybeFoundNationCapital } from "@openfront/engine/execution/nation/NationCapitalBehavior";
import { setup } from "../util/Setup";
import { land, run } from "./helpers";

async function nationWorld() {
  const game = await setup("big_plains", { capitalSystem: { enabled: true } }, [
    new PlayerInfo("nation", PlayerType.Nation, null, "nation"),
    new PlayerInfo("raider", PlayerType.Human, "raider", "raider"),
  ]);
  const nation = game.player("nation");
  const raider = game.player("raider");
  land(game, nation, 20, 20, 6);
  nation.setSpawnTile(game.ref(20, 20));
  land(game, raider, 33, 20, 6);
  raider.setSpawnTile(game.ref(33, 20));
  run(game, 1);
  return { game, nation, raider };
}

describe("a nation rebuilds its capital", () => {
  test("a nation has a capital, and does nothing while it does", async () => {
    const { game, nation } = await nationWorld();
    expect(game.capitals()!.capitalOf(nation)).not.toBeNull();
    nation.addGold(5_000_000n);
    expect(maybeFoundNationCapital(game, nation)).toBe(false);
  });

  test("not before it can pay, nor before the delay is over", async () => {
    const { game, nation, raider } = await nationWorld();
    raider.conquer(game.capitals()!.capitalOf(nation)!.tile);
    run(game, 1);
    land(game, nation, 20, 20, 6);
    // No gold yet.
    run(game, CAPITAL_SPEC.replacementDelayTicks);
    expect(maybeFoundNationCapital(game, nation)).toBe(false);
    // Gold, but the capital has only just fallen again: a new loss restarts the wait.
    nation.addGold(CAPITAL_SPEC.replacementCost);
    expect(maybeFoundNationCapital(game, nation)).toBe(true);
  });

  test("founds an interior replacement once it can pay, and only one", async () => {
    const { game, nation, raider } = await nationWorld();
    raider.conquer(game.capitals()!.capitalOf(nation)!.tile);
    run(game, 1);
    land(game, nation, 20, 20, 6);
    nation.addGold(CAPITAL_SPEC.replacementCost * 2n);
    expect(maybeFoundNationCapital(game, nation)).toBe(false); // too soon
    run(game, CAPITAL_SPEC.replacementDelayTicks);
    const before = nation.gold();
    expect(maybeFoundNationCapital(game, nation)).toBe(true);
    const capital = game.capitals()!.capitalOf(nation)!;
    expect(capital.replacement).toBe(true);
    expect(nation.borderTiles().has(capital.tile)).toBe(false);
    expect(nation.gold()).toBe(before - CAPITAL_SPEC.replacementCost);
    expect(maybeFoundNationCapital(game, nation)).toBe(false);
  });

  test("finds an interior tile when the spawn tile has become a border", async () => {
    const { game, nation, raider } = await nationWorld();
    raider.conquer(game.capitals()!.capitalOf(nation)!.tile);
    run(game, 1);
    // The nation is left with a strip along the border, and a bigger area behind it.
    for (const t of [...nation.tiles()]) nation.relinquish(t);
    land(game, nation, 20, 40, 5);
    nation.setSpawnTile(game.ref(20, 45)); // an edge tile of the new land
    nation.addGold(CAPITAL_SPEC.replacementCost);
    run(game, CAPITAL_SPEC.replacementDelayTicks);
    expect(maybeFoundNationCapital(game, nation)).toBe(true);
    const tile = game.capitals()!.capitalOf(nation)!.tile;
    expect(nation.borderTiles().has(tile)).toBe(false);
  });

  test("a tribe never gets one", async () => {
    const game = await setup(
      "big_plains",
      { capitalSystem: { enabled: true } },
      [new PlayerInfo("tribe", PlayerType.Bot, null, "tribe")],
    );
    const tribe = game.player("tribe");
    land(game, tribe, 20, 20, 5);
    tribe.setSpawnTile(game.ref(20, 20));
    tribe.addGold(10_000_000n);
    run(game, CAPITAL_SPEC.replacementDelayTicks + 5);
    expect(maybeFoundNationCapital(game, tribe)).toBe(false);
    expect(game.capitals()!.capitalOf(tribe)).toBeNull();
  });
});
