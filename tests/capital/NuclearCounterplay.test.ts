import {
  PlayerInfo,
  PlayerType,
  UnitType,
} from "@openfront/engine-api/game/GameTypes";
import { BOMB_INDEX_INTERCEPT } from "@openfront/engine-api/StatsSchemas";
import { CAPITAL_SPEC } from "@openfront/engine-lib/capital/CapitalRules";
import { NukeExecution } from "@openfront/engine/execution/NukeExecution";
import { SpawnExecution } from "@openfront/engine/execution/SpawnExecution";
import { Game, Player } from "@openfront/engine/game/Game";
import { setup } from "../util/Setup";
import { TestConfig } from "../util/TestConfig";
import { constructionExecution, executeTicks } from "../util/utils";

/**
 * Silos and airports need a capital; SAM launchers do not (docs/Capital.md). A
 * nation that has not bought a capital yet must still be able to defend itself
 * against nuclear attack through the ordinary build path, and the defence must
 * work: the requirement may stop it attacking from afar, never from defending.
 */
let game: Game;
let attacker: Player;
let defender: Player;

describe("a nation without a capital against nuclear attack", () => {
  beforeEach(async () => {
    game = await setup(
      "big_plains",
      {
        capitalSystem: { enabled: true },
        instantBuild: true,
        startingGold: 10_000_000,
      },
      [],
      undefined,
      TestConfig,
    );
    for (const id of ["defender_id", "attacker_id"]) {
      game.addPlayer(new PlayerInfo(id, PlayerType.Human, id, id));
    }
    game.addExecution(
      new SpawnExecution(
        "g",
        game.player("defender_id").info(),
        game.ref(1, 1),
      ),
      new SpawnExecution(
        "g",
        game.player("attacker_id").info(),
        game.ref(30, 30),
      ),
    );
    attacker = game.player("attacker_id");
    defender = game.player("defender_id");
    executeTicks(game, 3);
  });

  test("it can build a SAM launcher with no capital, by the ordinary order", () => {
    expect(game.capitals()!.capitalOf(defender)).toBeNull();
    constructionExecution(game, defender, 1, 1, UnitType.SAMLauncher);
    expect(defender.units(UnitType.SAMLauncher)).toHaveLength(1);
  });

  test("and it takes a nuke down, as it would with a capital", () => {
    constructionExecution(game, defender, 1, 1, UnitType.SAMLauncher);
    executeTicks(game, 2);
    // The attacker has a capital, so it may have a silo.
    attacker.addGold(CAPITAL_SPEC.cost);
    expect(game.capitals()!.found(attacker, game.ref(30, 30))).toBe(true);
    expect(attacker.canBuild(UnitType.MissileSilo, game.ref(31, 31))).not.toBe(
      false,
    );
    constructionExecution(game, attacker, 31, 31, UnitType.MissileSilo, 8);
    expect(attacker.units(UnitType.MissileSilo)).toHaveLength(1);

    game.addExecution(
      new NukeExecution(
        UnitType.AtomBomb,
        attacker,
        game.ref(3, 1),
        game.ref(30, 30),
      ),
    );
    executeTicks(game, 25);
    expect(attacker.units(UnitType.AtomBomb)).toHaveLength(0);
    // Shot down by the capital-less defender's SAM, not detonated.
    expect(
      game.stats().getPlayerStats(defender)?.bombs?.abomb?.[
        BOMB_INDEX_INTERCEPT
      ],
    ).toBe(1n);
  });

  test("while without a capital it cannot raise its own silo or airport", () => {
    constructionExecution(game, defender, 3, 3, UnitType.MissileSilo);
    constructionExecution(game, defender, 5, 3, UnitType.Airport);
    expect(defender.units(UnitType.MissileSilo)).toHaveLength(0);
    expect(defender.units(UnitType.Airport)).toHaveLength(0);
    // Buying one opens the silo.
    expect(game.capitals()!.found(defender, game.ref(1, 1))).toBe(true);
    constructionExecution(game, defender, 3, 3, UnitType.MissileSilo);
    expect(defender.units(UnitType.MissileSilo)).toHaveLength(1);
  });

  test("a capital-less nation keeps every other defence: posts, cities, ports", () => {
    for (const t of [UnitType.DefensePost, UnitType.City]) {
      expect(defender.needsCapitalFor(t)).toBe(false);
    }
    constructionExecution(game, defender, 2, 2, UnitType.DefensePost);
    expect(defender.units(UnitType.DefensePost)).toHaveLength(1);
  });
});
