import {
  PlayerInfo,
  PlayerType,
  TerrainType,
  UnitType,
} from "@openfront/engine-api/game/GameTypes";
import { GameUpdateType } from "@openfront/engine-api/game/GameUpdates";
import {
  CAPITAL_SPEC,
  scaleBonus,
} from "@openfront/engine-lib/capital/CapitalRules";
import { AttackLogicInput } from "@openfront/engine/configuration/EngineConfig";
import { setup } from "../util/Setup";
import { UseRealAttackLogic } from "../util/TestConfig";
import { buyCapital, capitalWorld, human, land, run } from "./helpers";

/** alice with a capital, bob without: the same land, side by side. */
async function oneHasOne(opts: Parameters<typeof capitalWorld>[0] = {}) {
  const w = await capitalWorld({ skipFirstTick: true, ...opts });
  run(w.game, 1);
  buyCapital(w.game, w.alice);
  return w;
}

describe("everyone starts with the grant and no capital", () => {
  test("humans and nations get the starting grant, a host's gold comes on top, tribes get none", async () => {
    const game = await setup(
      "big_plains",
      { capitalSystem: { enabled: true }, startingGold: 100_000 },
      [
        human("h"),
        new PlayerInfo("n", PlayerType.Nation, null, "n"),
        new PlayerInfo("t", PlayerType.Bot, null, "t"),
      ],
    );
    expect(game.player("h").gold()).toBe(CAPITAL_SPEC.startingGold + 100_000n);
    expect(game.player("n").gold()).toBe(CAPITAL_SPEC.startingGold + 100_000n);
    expect(game.player("t").gold()).toBe(100_000n * 0n + 0n);
    expect(game.capitals()!.capitalOf(game.player("h"))).toBeNull();
  });

  test("the setting off changes nothing: no grant", async () => {
    const game = await setup("big_plains", { startingGold: 100_000 }, [
      human("h"),
    ]);
    expect(game.player("h").gold()).toBe(100_000n);
  });
});

describe("what a standing capital gives", () => {
  test("its maximum-troop bonus is flat, and ramps in from half", async () => {
    const { game, alice, bob } = await oneHasOne();
    const config = game.config();
    const gap = () => config.maxTroops(alice) - config.maxTroops(bob);
    expect(gap()).toBe(scaleBonus(CAPITAL_SPEC.bonusMaxTroops, 50));
    run(game, CAPITAL_SPEC.rampTicks);
    expect(gap()).toBe(CAPITAL_SPEC.bonusMaxTroops);
    // The player's own strength is the number the rule reads.
    expect(alice.capitalStrengthPercent()).toBe(100);
    expect(bob.capitalStrengthPercent()).toBe(0);
  });

  test("it makes cities, ports, factories and defense posts cheaper, and nothing else", async () => {
    const { game, alice, bob } = await oneHasOne();
    const cost = (p: typeof alice, t: UnitType) =>
      game.unitInfo(t).cost(game, p);
    const full = cost(bob, UnitType.City);
    // At half strength: half the discount.
    expect(cost(alice, UnitType.City)).toBe(
      (full * BigInt(100 - scaleBonus(CAPITAL_SPEC.bonusDiscountPercent, 50))) /
        100n,
    );
    run(game, CAPITAL_SPEC.rampTicks);
    for (const t of [
      UnitType.City,
      UnitType.Port,
      UnitType.Factory,
      UnitType.DefensePost,
    ]) {
      expect(cost(alice, t)).toBe(
        (cost(bob, t) * BigInt(100 - CAPITAL_SPEC.bonusDiscountPercent)) / 100n,
      );
    }
    expect(cost(alice, UnitType.City)).toBe((full * 75n) / 100n);
    // Not the others.
    for (const t of [UnitType.SAMLauncher, UnitType.MissileSilo]) {
      expect(cost(alice, t)).toBe(cost(bob, t));
    }
  });

  test("a capital that falls takes its discount and troop bonus with it", async () => {
    const { game, alice, bob } = await oneHasOne();
    run(game, CAPITAL_SPEC.rampTicks);
    const config = game.config();
    const maxBefore = config.maxTroops(alice);
    expect(game.unitInfo(UnitType.City).cost(game, alice)).toBeLessThan(
      game.unitInfo(UnitType.City).cost(game, bob),
    );
    bob.conquer(game.capitals()!.capitalOf(alice)!.tile);
    run(game, 1);
    expect(alice.capitalStrengthPercent()).toBe(0);
    expect(game.unitInfo(UnitType.City).cost(game, alice)).toBe(
      game.unitInfo(UnitType.City).cost(game, bob),
    );
    // The flat bonus is gone (and a tile with it).
    expect(config.maxTroops(alice)).toBeLessThan(
      maxBefore - CAPITAL_SPEC.bonusMaxTroops + 1,
    );
  });

  test("it spares an attacker a share of its losses, scaled by how far it has ramped", async () => {
    const { game } = await oneHasOne({ configClass: UseRealAttackLogic });
    const input = (capitalStrength: number): AttackLogicInput => ({
      terrain: TerrainType.Plains,
      attackTroops: 10_000,
      attacker: { type: PlayerType.Human, numTiles: 500, capitalStrength },
      defender: {
        type: PlayerType.Human,
        numTiles: 500,
        troops: 10_000,
        isTraitor: false,
        isDisconnectedTeammate: false,
      },
      defenderHasDefensePost: false,
      falloutRatio: null,
      borderSize: 40,
    });
    const loss = (s: number) => game.config().attackLogic(input(s));
    const none = loss(0).attackerTroopLoss;
    const full = loss(100);
    expect(full.attackerTroopLoss).toBeCloseTo(
      (none * (100 - CAPITAL_SPEC.bonusAttackLossPercent)) / 100,
      6,
    );
    expect(loss(50).attackerTroopLoss).toBeCloseTo(
      (none * (100 - scaleBonus(CAPITAL_SPEC.bonusAttackLossPercent, 50))) /
        100,
      6,
    );
    // Only the attacker's losses: the defender's and the pace are untouched.
    expect(full.defenderTroopLoss).toBe(loss(0).defenderTroopLoss);
    expect(full.tickFraction).toBe(loss(0).tickFraction);
  });
});

describe("silos and airports need a capital", () => {
  test("without one they cannot be built, with one they can; SAM launchers always can", async () => {
    const { game, alice, bob } = await oneHasOne();
    alice.addGold(5_000_000n);
    bob.addGold(5_000_000n);
    const tile = (p: typeof alice) => p.spawnTile()!;
    expect(bob.needsCapitalFor(UnitType.MissileSilo)).toBe(true);
    expect(bob.needsCapitalFor(UnitType.Airport)).toBe(true);
    expect(bob.needsCapitalFor(UnitType.SAMLauncher)).toBe(false);
    expect(bob.needsCapitalFor(UnitType.City)).toBe(false);
    expect(bob.canBuild(UnitType.MissileSilo, tile(bob))).toBe(false);
    expect(bob.canBuild(UnitType.Airport, tile(bob))).toBe(false);
    expect(bob.canBuild(UnitType.SAMLauncher, tile(bob))).not.toBe(false);
    expect(bob.canBuild(UnitType.City, tile(bob))).not.toBe(false);

    expect(alice.needsCapitalFor(UnitType.MissileSilo)).toBe(false);
    expect(alice.canBuild(UnitType.MissileSilo, tile(alice))).not.toBe(false);
    expect(game.capitals()).not.toBeNull();
  });

  test("a silo built with a capital keeps working when the capital falls, but no new one can be built", async () => {
    const { game, alice, bob } = await oneHasOne();
    alice.addGold(5_000_000n);
    const silo = alice.buildUnit(UnitType.MissileSilo, game.ref(18, 18), {});
    bob.conquer(game.capitals()!.capitalOf(alice)!.tile);
    run(game, 1);
    expect(game.capitals()!.capitalOf(alice)).toBeNull();
    expect(silo.isActive()).toBe(true);
    expect(alice.canBuild(UnitType.MissileSilo, game.ref(22, 22))).toBe(false);
  });

  test("the match without the Capital System has no such requirement", async () => {
    const game = await setup("big_plains", {}, [human("a")]);
    const a = game.player("a");
    land(game, a, 20, 20, 6);
    a.setSpawnTile(game.ref(20, 20));
    a.addGold(5_000_000n);
    expect(a.needsCapitalFor(UnitType.MissileSilo)).toBe(false);
    expect(a.canBuild(UnitType.MissileSilo, game.ref(20, 20))).not.toBe(false);
  });
});

describe("the strain of having no capital", () => {
  /** alice without a capital, the match started. */
  async function strained() {
    const w = await capitalWorld({ skipFirstTick: true });
    run(w.game, 1);
    const caps = w.game.capitals()!;
    const start = caps.strainStartOf(w.alice);
    return { ...w, caps, start };
  }

  test("there is none during the grace, then 3% for each minute begun, to 30%", async () => {
    const { game, alice, caps, start } = await strained();
    expect(start).toBeGreaterThan(CAPITAL_SPEC.strainGraceTicks - 1);
    run(game, start - game.ticks() - 1);
    expect(caps.strainOf(alice)).toBe(0);
    expect(caps.incomePercent(alice)).toBe(100);
    run(game, 1);
    expect(caps.strainOf(alice)).toBe(3);
    expect(caps.incomePercent(alice)).toBe(97);
    expect(caps.regenPercent(alice)).toBe(97);
    run(game, 600);
    expect(caps.strainOf(alice)).toBe(6);
    run(game, 600 * 20);
    expect(caps.strainOf(alice)).toBe(CAPITAL_SPEC.strainMaxPercent);
    expect(caps.incomePercent(alice)).toBe(70);
  });

  test("buying a capital ends it at once", async () => {
    const { game, alice, caps, start } = await strained();
    run(game, start - game.ticks() + 600);
    expect(caps.strainOf(alice)).toBe(6);
    alice.addGold(CAPITAL_SPEC.cost);
    expect(caps.found(alice, game.ref(20, 20))).toBe(true);
    expect(caps.strainOf(alice)).toBe(0);
    expect(caps.strainStartOf(alice)).toBe(-1);
    // The bonus (not the strain) is what the economy reads now.
    expect(caps.incomePercent(alice)).toBeGreaterThan(100);
  });

  test("is never the CRISIS: no crisis record, no crisis fields, not a loss of a capital", async () => {
    const { game, alice, caps, start } = await strained();
    run(game, start - game.ticks() + 600 * 3);
    expect(caps.strainOf(alice)).toBeGreaterThan(0);
    expect(caps.inCrisis(alice)).toBe(false);
    expect(caps.crisisOf(alice)).toBeNull();
    const u = alice.toUpdate();
    expect(u?.crisisEndTick ?? -1).toBe(-1);
    // And no event: strain does not announce itself as a fall.
    const events = run(game, 600).flatMap(
      (x) => x[GameUpdateType.CapitalEvent],
    );
    expect(events).toEqual([]);
  });

  test("a player in CRISIS is not also strained, and gets a fresh grace to rebuy", async () => {
    const w = await capitalWorld({ skipFirstTick: true });
    const { game, alice, bob } = w;
    run(game, 1);
    buyCapital(game, alice);
    buyCapital(game, bob);
    const caps = game.capitals()!;
    // Long after the grace of the match, alice loses her capital.
    run(game, CAPITAL_SPEC.strainGraceTicks + 2_000);
    bob.conquer(caps.capitalOf(alice)!.tile);
    run(game, 1);
    expect(caps.inCrisis(alice)).toBe(true);
    const crisisEnd = caps.crisisOf(alice)!.endTick;
    // CRISIS alone: halved, no strain on top.
    expect(caps.strainOf(alice)).toBe(0);
    expect(caps.incomePercent(alice)).toBe(50);
    // Strain would begin a grace after the CRISIS ends, not before.
    expect(caps.strainStartOf(alice)).toBe(
      crisisEnd + CAPITAL_SPEC.strainGraceTicks,
    );
    run(game, crisisEnd - game.ticks() + 10);
    expect(caps.inCrisis(alice)).toBe(false);
    expect(caps.strainOf(alice)).toBe(0);
    expect(caps.incomePercent(alice)).toBe(100);
    run(game, CAPITAL_SPEC.strainGraceTicks);
    expect(caps.strainOf(alice)).toBeGreaterThan(0);
  });

  test("tells the client when it begins, and -1 once there is a capital", async () => {
    const { game, alice, bob, start } = await strained();
    const updateOf = (p: typeof alice) =>
      run(game, 1)[0][GameUpdateType.Player].find((u) => u.id === p.id());
    const before = updateOf(alice);
    // Already told (first tick): an unchanged value is not sent again.
    expect(before?.strainStartTick ?? start).toBe(start);
    buyCapital(game, bob);
    const after = run(game, 1)[0][GameUpdateType.Player].find(
      (u) => u.id === bob.id(),
    )!;
    expect(after.strainStartTick).toBe(-1);
    expect(after.capitalFoundedTick).toBe(game.ticks() - 1);
  });
});

describe("strain after a capital that was destroyed, not captured", () => {
  test("a destroyed capital restarts the grace even when an older CRISIS is on record", async () => {
    const { game, alice, bob } = await capitalWorld({ skipFirstTick: true });
    run(game, 1);
    buyCapital(game, alice);
    buyCapital(game, bob);
    const caps = game.capitals()!;
    // First, a captured capital and its CRISIS...
    bob.conquer(caps.capitalOf(alice)!.tile);
    run(game, 1);
    const crisisEnd = caps.crisisOf(alice)!.endTick;
    run(game, crisisEnd - game.ticks() + CAPITAL_SPEC.replacementDelayTicks);
    // ...she buys another, long after the match's own grace is over...
    land(game, alice, 20, 20, 6);
    run(game, CAPITAL_SPEC.strainGraceTicks);
    buyCapital(game, alice, game.ref(21, 20));
    // ...and that one is destroyed (nobody holds the tile any more).
    alice.relinquish(caps.capitalOf(alice)!.tile);
    run(game, 1);
    const fell = game.ticks() - 1;
    expect(caps.capitalOf(alice)).toBeNull();
    // A fresh grace from the loss, not strain at once from the old CRISIS.
    expect(caps.strainOf(alice)).toBe(0);
    expect(caps.strainStartOf(alice)).toBeGreaterThanOrEqual(
      fell + CAPITAL_SPEC.strainGraceTicks,
    );
  });
});
