import {
  Difficulty,
  PlayerInfo,
  PlayerType,
  UnitType,
} from "@openfront/engine-api/game/GameTypes";
import { PseudoRandom } from "@openfront/engine-lib/PseudoRandom";
import { NationStructureBehavior } from "@openfront/engine/execution/nation/NationStructureBehavior";
import { Game, Player } from "@openfront/engine/game/Game";
import { conquerSquare, ShortRangeConfig } from "./airstrike/helpers";
import { setup } from "./util/Setup";
import { TestConfig } from "./util/TestConfig";

interface Scene {
  game: Game;
  nation: Player;
  human: Player;
  behavior: NationStructureBehavior;
}

/** A nation owning a block of land with `cities` cities, and a human with `hostile` structures. */
async function scene(
  difficulty: Difficulty,
  cities: number,
  hostile: number,
  configClass: typeof TestConfig = TestConfig,
  hostileAt = { x: 150, y: 100 },
): Promise<Scene> {
  const game = await setup(
    "big_plains",
    { difficulty, infiniteGold: true, instantBuild: true },
    [
      new PlayerInfo("nation", PlayerType.Nation, null, "nation_id"),
      new PlayerInfo("human", PlayerType.Human, "h", "human_id"),
    ],
    undefined,
    configClass,
  );
  const nation = game.player("nation_id");
  const human = game.player("human_id");
  // Infinite gold only applies to humans: a nation pays like in a real game.
  nation.addGold(50_000_000n);
  conquerSquare(game, nation, 40, 100, 30);
  for (let i = 0; i < cities; i++) {
    nation.buildUnit(
      UnitType.City,
      game.ref(15 + (i % 5) * 12, 80 + Math.floor(i / 5) * 12),
      {},
    );
  }
  conquerSquare(game, human, hostileAt.x, hostileAt.y, 15);
  for (let i = 0; i < hostile; i++) {
    human.buildUnit(
      UnitType.City,
      game.ref(hostileAt.x - 10 + i * 6, hostileAt.y),
      {},
    );
  }
  return {
    game,
    nation,
    human,
    behavior: new NationStructureBehavior(new PseudoRandom(1), game, nation),
  };
}

// The private rules, exercised directly like the other nation structure tests.
const shouldBuild = (s: Scene, cities: number) =>
  (s.behavior as any).shouldBuildStructure(UnitType.Airport, cities, false);

const spawnTile = (s: Scene) =>
  (s.behavior as any).structureSpawnTile(UnitType.Airport);

describe("Nation airport placement", () => {
  it("Hard nations build one once they have enough cities and an enemy in range", async () => {
    const s = await scene(Difficulty.Hard, 7, 2);
    expect(shouldBuild(s, 7)).toBe(true);
    expect(shouldBuild(s, 6)).toBe(false); // floor(6 * 0.15) = 0
  });

  it("Easy nations never build one", async () => {
    const s = await scene(Difficulty.Easy, 12, 2);
    expect(shouldBuild(s, 12)).toBe(false);
  });

  it("Medium nations build at most one, Hard two, Impossible three", async () => {
    const limits: [Difficulty, number][] = [
      [Difficulty.Medium, 1],
      [Difficulty.Hard, 2],
      [Difficulty.Impossible, 3],
    ];
    for (const [difficulty, max] of limits) {
      // Hostile structures far from where the airports go, so coverage never runs out.
      const s = await scene(difficulty, 20, 6, ShortRangeConfig, {
        x: 150,
        y: 150,
      });
      for (let i = 0; i < max; i++) {
        expect(shouldBuild(s, 20)).toBe(true);
        s.nation.buildUnit(UnitType.Airport, s.game.ref(20, 20 + i * 20), {});
      }
      expect(shouldBuild(s, 20)).toBe(false);
    }
  });

  it("not when there is nothing hostile to strike", async () => {
    const s = await scene(Difficulty.Hard, 7, 0);
    // The human has land but no structures.
    expect(shouldBuild(s, 7)).toBe(false);
  });

  it("a further airport must add coverage: three enemy structures nobody reaches yet", async () => {
    // Airport range 100 on a 200-wide map: the first covers the nearby enemy only.
    const s = await scene(Difficulty.Hard, 12, 2, ShortRangeConfig, {
      x: 60,
      y: 100,
    });
    s.nation.buildUnit(UnitType.Airport, s.game.ref(40, 100), {});
    expect(shouldBuild(s, 14)).toBe(false); // everything is already in range
    // Three structures far out of the first airport's range.
    conquerSquare(s.game, s.human, 190, 190, 8);
    for (let i = 0; i < 3; i++) {
      s.human.buildUnit(UnitType.City, s.game.ref(184 + i * 6, 190), {});
    }
    expect(shouldBuild(s, 14)).toBe(true);
  });

  it("allies' and teammates' structures are not reasons to build", async () => {
    const s = await scene(Difficulty.Hard, 7, 2);
    s.nation.createAllianceRequest(s.human)!.accept();
    expect(shouldBuild(s, 7)).toBe(false);
  });

  it("picks a tile in its own territory that reaches the enemy", async () => {
    const s = await scene(Difficulty.Hard, 7, 2);
    const tile = spawnTile(s);
    expect(tile).not.toBeNull();
    expect(s.game.owner(tile)).toBe(s.nation);
  });

  it("never picks a spot that reaches nothing", async () => {
    // The enemy is out of range of the whole territory.
    const s = await scene(Difficulty.Hard, 7, 2, ShortRangeConfig, {
      x: 180,
      y: 180,
    });
    expect(spawnTile(s)).toBeNull();
  });

  it("scores a spot overlapping an existing airport far below one that does not", async () => {
    const s = await scene(Difficulty.Hard, 7, 2, ShortRangeConfig, {
      x: 100,
      y: 100,
    });
    s.nation.buildUnit(UnitType.Airport, s.game.ref(15, 75), {});

    const value = (s.behavior as any).airportValue();
    const near = s.game.ref(20, 80); // inside half the airport range of it
    const far = s.game.ref(65, 125); // well outside
    expect(value(far)).toBeGreaterThan(0);
    expect(value(near)).toBeGreaterThan(0);
    expect(value(near)).toBeLessThan(value(far));
  });
});
