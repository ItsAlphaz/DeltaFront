import {
  AirstrikeTypes,
  AirstrikeUnitType,
  Difficulty,
  PlayerInfo,
  PlayerType,
  UnitType,
} from "@openfront/engine-api/game/GameTypes";
import { PseudoRandom } from "@openfront/engine-lib/PseudoRandom";
import { NationExecutionSnapshot } from "@openfront/engine/execution/NationExecution";
import { NationAirBehavior } from "@openfront/engine/execution/nation/NationAirBehavior";
import { NationAllianceBehavior } from "@openfront/engine/execution/nation/NationAllianceBehavior";
import { NationEmojiBehavior } from "@openfront/engine/execution/nation/NationEmojiBehavior";
import { NationNukeBehavior } from "@openfront/engine/execution/nation/NationNukeBehavior";
import { AiAttackBehavior } from "@openfront/engine/execution/utils/AiAttackBehavior";
import { Game, Player } from "@openfront/engine/game/Game";
import { snapshotGame } from "@openfront/engine/snapshot/GameSnapshot";
import {
  conquerRect,
  conquerSquare,
  ShortRangeConfig,
} from "./airstrike/helpers";
import { setup } from "./util/Setup";
import { diffSnapshots } from "./util/Snapshot";
import { TestConfig } from "./util/TestConfig";
import { constructionExecution } from "./util/utils";

interface Duel {
  game: Game;
  nation: Player;
  human: Player;
  air: NationAirBehavior;
}

function behaviorsFor(game: Game, nation: Player, seed = 1) {
  const emoji = new NationEmojiBehavior(new PseudoRandom(seed), game, nation);
  const alliance = new NationAllianceBehavior(
    new PseudoRandom(seed),
    game,
    nation,
    emoji,
  );
  const attack = new AiAttackBehavior(
    new PseudoRandom(seed),
    game,
    nation,
    0.5,
    0.3,
    0.2,
    alliance,
    emoji,
  );
  const nuke = new NationNukeBehavior(
    new PseudoRandom(seed),
    game,
    nation,
    attack,
    emoji,
  );
  const air = new NationAirBehavior(
    new PseudoRandom(seed),
    game,
    nation,
    attack,
    nuke,
    emoji,
  );
  return { emoji, alliance, attack, nuke, air };
}

/** A nation with an airport at (20, 100) and 50M gold; a human with no land yet. */
async function duel(
  difficulty = Difficulty.Hard,
  opts: {
    configClass?: typeof TestConfig;
    config?: Record<string, unknown>;
    extra?: PlayerInfo[];
  } = {},
): Promise<Duel> {
  const game = await setup(
    "big_plains",
    { difficulty, infiniteGold: false, instantBuild: true, ...opts.config },
    [
      new PlayerInfo("nation", PlayerType.Nation, null, "nation_id"),
      new PlayerInfo("human", PlayerType.Human, "human_client", "human_id"),
      ...(opts.extra ?? []),
    ],
    undefined,
    opts.configClass ?? TestConfig,
  );
  const nation = game.player("nation_id");
  const human = game.player("human_id");
  nation.addGold(50_000_000n);
  conquerSquare(game, nation, 20, 100, 5);
  constructionExecution(game, nation, 20, 100, UnitType.Airport);
  return { game, nation, human, air: behaviorsFor(game, nation).air };
}

/** Lets the nation decide, then runs until any aircraft is in the air. */
function strike(d: Duel): AirstrikeUnitType | null {
  d.air.maybeLaunchAirstrike();
  for (let i = 0; i < 6; i++) {
    d.game.executeNextTick();
    for (const t of AirstrikeTypes.types) {
      if (d.nation.units(t).length > 0) return t;
    }
  }
  return null;
}

function placeHuman(
  d: Duel,
  cx: number,
  cy: number,
  half: number,
  troops: number,
) {
  conquerSquare(d.game, d.human, cx, cy, half);
  d.human.setTroops(troops);
}

describe("Nation airstrikes: what to launch", () => {
  it("a troop-dense cluster with two structures gets a Bombing Run", async () => {
    const d = await duel();
    placeHuman(d, 100, 100, 4, 2_000_000);
    d.human.buildUnit(UnitType.City, d.game.ref(98, 100), {});
    d.human.buildUnit(UnitType.City, d.game.ref(103, 100), {});
    expect(strike(d)).toBe(UnitType.BombingRun);
  });

  it("on Impossible, a lone ready SAM is worth a Rocket Strike (the best odds through it)", async () => {
    const d = await duel(Difficulty.Impossible);
    placeHuman(d, 100, 100, 3, 10_000);
    d.human.addGold(10_000_000n);
    constructionExecution(d.game, d.human, 100, 100, UnitType.SAMLauncher);
    expect(d.human.units(UnitType.SAMLauncher)).toHaveLength(1);
    expect(strike(d)).toBe(UnitType.RocketStrike);
  });

  it("a long front under attack is retaliated against with a Strafing Run", async () => {
    const d = await duel();
    // A long thin strip of enemy troops running along our border.
    conquerRect(d.game, d.nation, 20, 60, 80, 140);
    conquerRect(d.game, d.human, 81, 60, 140, 140);
    d.human.setTroops(3_000_000);
    const b = behaviorsFor(d.game, d.nation);
    vi.spyOn(b.attack, "findIncomingAttackPlayer").mockReturnValue(d.human);
    expect(strike({ ...d, air: b.air })).toBe(UnitType.StrafingRun);
  });

  it("never picks a strike worth less than its price", async () => {
    const d = await duel();
    // A handful of troops and no buildings: nothing to gain.
    placeHuman(d, 100, 100, 2, 100);
    expect(strike(d)).toBeNull();
  });
});

describe("Nation airstrikes: SAM survival thresholds", () => {
  async function sammed(difficulty: Difficulty) {
    const d = await duel(difficulty);
    placeHuman(d, 100, 100, 3, 10_000);
    d.human.addGold(10_000_000n);
    constructionExecution(d.game, d.human, 100, 100, UnitType.SAMLauncher);
    return d;
  }

  it("Hard will not fly into a ready SAM (best survival 0.5 < 0.6)", async () => {
    expect(strike(await sammed(Difficulty.Hard))).toBeNull();
  });

  it("Impossible will (0.5 >= 0.4) with a rocket", async () => {
    expect(strike(await sammed(Difficulty.Impossible))).toBe(
      UnitType.RocketStrike,
    );
  });

  it("a SAM that is rearming does not count against the strike", async () => {
    const d = await sammed(Difficulty.Hard);
    d.human.units(UnitType.SAMLauncher)[0].launch();
    expect(strike(d)).not.toBeNull();
  });
});

describe("Nation airstrikes: when not to launch", () => {
  async function worthwhile(difficulty = Difficulty.Hard, opts = {}) {
    const d = await duel(difficulty, opts);
    placeHuman(d, 100, 100, 4, 2_000_000);
    d.human.buildUnit(UnitType.City, d.game.ref(98, 100), {});
    d.human.buildUnit(UnitType.City, d.game.ref(103, 100), {});
    return d;
  }

  it("Easy nations never launch", async () => {
    expect(strike(await worthwhile(Difficulty.Easy))).toBeNull();
  });

  it("not without the gold: Hard needs 3x the price in hand", async () => {
    const d = await worthwhile();
    d.nation.removeGold(d.nation.gold());
    // Hard wants 3x the price: even the cheapest strike (250k) needs 750k.
    d.nation.addGold(700_000n);
    expect(strike(d)).toBeNull();
    d.nation.addGold(1_000_000n);
    expect(strike(d)).not.toBeNull();
  });

  it("not while the only airport is rearming", async () => {
    const d = await worthwhile();
    d.nation.units(UnitType.Airport)[0].launch();
    expect(strike(d)).toBeNull();
  });

  it("not without an airport", async () => {
    const d = await worthwhile();
    d.nation.units(UnitType.Airport)[0].delete(false);
    expect(strike(d)).toBeNull();
  });

  it("not within the minimum gap after a strike", async () => {
    const d = await worthwhile();
    expect(strike(d)).not.toBeNull();
    // A second airport is ready, but the nation just struck.
    conquerSquare(d.game, d.nation, 20, 140, 5);
    constructionExecution(d.game, d.nation, 20, 140, UnitType.Airport);
    d.air.maybeLaunchAirstrike();
    for (let i = 0; i < 6; i++) d.game.executeNextTick();
    const planes = AirstrikeTypes.types.flatMap((t) => d.nation.units(t));
    expect(planes.length).toBeLessThanOrEqual(1);
  });

  it("not at an ally, a teammate or a tribe", async () => {
    const d = await worthwhile();
    d.nation.createAllianceRequest(d.human)!.accept();
    expect(strike(d)).toBeNull();
  });

  it("not when the strike types are disabled in the game", async () => {
    const d = await worthwhile(Difficulty.Hard, {
      config: { disabledUnits: [UnitType.Airstrike] },
    });
    expect(strike(d)).toBeNull();
  });

  it("only targets within the airport's range", async () => {
    const d = await duel(Difficulty.Hard, { configClass: ShortRangeConfig });
    placeHuman(d, 180, 100, 4, 2_000_000);
    d.human.buildUnit(UnitType.City, d.game.ref(178, 100), {});
    d.human.buildUnit(UnitType.City, d.game.ref(183, 100), {});
    expect(strike(d)).toBeNull();
  });
});

describe("Nation airstrikes: determinism and saving", () => {
  async function run() {
    const d = await duel();
    placeHuman(d, 100, 100, 4, 2_000_000);
    d.human.buildUnit(UnitType.City, d.game.ref(98, 100), {});
    const type = strike(d);
    for (let i = 0; i < 60; i++) d.game.executeNextTick();
    return { type, snapshot: snapshotGame(d.game), troops: d.human.troops() };
  }

  it("two identical games make identical decisions and end identical", async () => {
    const a = await run();
    const b = await run();
    expect(a.type).not.toBeNull();
    expect(a.type).toBe(b.type);
    expect(a.troops).toBe(b.troops);
    expect(diffSnapshots(a.snapshot, b.snapshot)).toEqual([]);
  });

  it("remembers its last strike so it does not repeat it", async () => {
    const d = await duel();
    placeHuman(d, 100, 100, 4, 2_000_000);
    expect(strike(d)).not.toBeNull();

    const before = d.air as any;
    expect(before.lastStrikeTick).not.toBeNull();
    expect(before.recentStrikes).toHaveLength(1);
    expect(before.strikesLaunched).toBe(1);
  });
});

describe("Nation snapshot migration", () => {
  const migrate = NationExecutionSnapshot.migrations[1];

  it("a v1 nation record gains an empty air behavior", () => {
    const v1 = {
      active: true,
      behaviors: { nuke: { v: 1, d: {} }, structure: { v: 1, d: {} } },
    };
    const migrated = migrate(v1);
    expect(migrated.behaviors.nuke).toEqual({ v: 1, d: {} });
    expect(migrated.behaviors.air).toEqual({
      v: 1,
      d: { lastStrikeTick: null, recentStrikes: [], strikesLaunched: 0 },
    });
  });

  it("a nation that never initialised its behaviors is left alone", () => {
    const v1 = { active: true, behaviors: null };
    expect(migrate(v1)).toEqual(v1);
  });
});
