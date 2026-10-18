import {
  PlayerInfo,
  PlayerType,
  UnitType,
} from "@openfront/engine-api/game/GameTypes";
import { CAPITAL_SPEC } from "@openfront/engine-lib/capital/CapitalRules";
import { AttackExecution } from "@openfront/engine/execution/AttackExecution";
import {
  isSavingForCapital,
  maybeFoundNationCapital,
  readyToSave,
} from "@openfront/engine/execution/nation/NationCapitalBehavior";
import { setup } from "../util/Setup";
import { buyCapital, land, run } from "./helpers";

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

/** Ticks of a Medium nation's wait before it saves whatever it has built. */
const SAVE_FROM = 8 * 600;

describe("a nation buys its first capital", () => {
  test("a nation starts without one, and builds before it saves", async () => {
    const { game, nation } = await nationWorld();
    expect(game.capitals()!.capitalOf(nation)).toBeNull();
    nation.addGold(5_000_000n);
    // It has built nothing yet, and the match is young: not now.
    expect(readyToSave(game, nation)).toBe(false);
    expect(isSavingForCapital(game, nation)).toBe(false);
    expect(maybeFoundNationCapital(game, nation)).toBe(false);
    expect(game.capitals()!.capitalOf(nation)).toBeNull();
  });

  test("after its first cities it saves: structures hold back, and it buys at the price", async () => {
    const { game, nation } = await nationWorld();
    for (const [x, y] of [
      [18, 18],
      [22, 22],
    ]) {
      nation.buildUnit(UnitType.City, game.ref(x, y), {});
    }
    expect(nation.units(UnitType.City)).toHaveLength(2);
    expect(readyToSave(game, nation)).toBe(true);
    expect(isSavingForCapital(game, nation)).toBe(true);

    // It cannot pay yet: nothing happens, and it keeps saving.
    nation.removeGold(nation.gold());
    nation.addGold(CAPITAL_SPEC.cost - 1n);
    expect(maybeFoundNationCapital(game, nation)).toBe(false);
    expect(isSavingForCapital(game, nation)).toBe(true);

    nation.addGold(1n);
    const before = nation.gold();
    expect(maybeFoundNationCapital(game, nation)).toBe(true);
    expect(nation.gold()).toBe(before - CAPITAL_SPEC.cost);
    const capital = game.capitals()!.capitalOf(nation)!;
    expect(capital.replacement).toBe(false);
    expect(nation.borderTiles().has(capital.tile)).toBe(false);
    // Having one, it stops saving, and does not buy another.
    expect(isSavingForCapital(game, nation)).toBe(false);
    expect(maybeFoundNationCapital(game, nation)).toBe(false);
  });

  test("with no cities it still starts saving once the match is old enough", async () => {
    const { game, nation } = await nationWorld();
    run(game, SAVE_FROM);
    expect(readyToSave(game, nation)).toBe(true);
    expect(isSavingForCapital(game, nation)).toBe(true);
  });

  test("a nation under a real attack spends instead of saving", async () => {
    const { game, nation, raider } = await nationWorld();
    run(game, SAVE_FROM);
    raider.setTroops(1_000_000);
    nation.setTroops(10_000);
    game.addExecution(new AttackExecution(900_000, raider, nation.id(), null));
    run(game, 2);
    expect(nation.incomingAttacks().length).toBeGreaterThan(0);
    expect(isSavingForCapital(game, nation)).toBe(false);
  });
});

describe("a nation rebuys a capital it lost", () => {
  async function lost() {
    const w = await nationWorld();
    buyCapital(w.game, w.nation);
    w.raider.conquer(w.game.capitals()!.capitalOf(w.nation)!.tile);
    run(w.game, 1);
    land(w.game, w.nation, 20, 20, 6);
    return w;
  }

  test("not before it can pay, nor before the delay is over", async () => {
    const { game, nation } = await lost();
    // No gold yet.
    run(game, CAPITAL_SPEC.replacementDelayTicks);
    expect(maybeFoundNationCapital(game, nation)).toBe(false);
    // Gold, and the wait is over.
    nation.addGold(CAPITAL_SPEC.cost);
    expect(maybeFoundNationCapital(game, nation)).toBe(true);
  });

  test("founds an interior replacement once it can pay, and only one", async () => {
    const { game, nation } = await lost();
    nation.addGold(CAPITAL_SPEC.cost * 2n);
    expect(maybeFoundNationCapital(game, nation)).toBe(false); // too soon
    run(game, CAPITAL_SPEC.replacementDelayTicks);
    const before = nation.gold();
    expect(maybeFoundNationCapital(game, nation)).toBe(true);
    const capital = game.capitals()!.capitalOf(nation)!;
    expect(capital.replacement).toBe(true);
    expect(nation.borderTiles().has(capital.tile)).toBe(false);
    expect(nation.gold()).toBe(before - CAPITAL_SPEC.cost);
    expect(maybeFoundNationCapital(game, nation)).toBe(false);
  });

  test("finds an interior tile when the spawn tile has become a border", async () => {
    const { game, nation } = await lost();
    // The nation is left with a strip along the border, and a bigger area behind it.
    for (const t of [...nation.tiles()]) nation.relinquish(t);
    land(game, nation, 20, 40, 5);
    nation.setSpawnTile(game.ref(20, 45)); // an edge tile of the new land
    nation.addGold(CAPITAL_SPEC.cost);
    run(game, CAPITAL_SPEC.replacementDelayTicks);
    expect(maybeFoundNationCapital(game, nation)).toBe(true);
    const tile = game.capitals()!.capitalOf(nation)!.tile;
    expect(nation.borderTiles().has(tile)).toBe(false);
  });
});

describe("a tribe", () => {
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
