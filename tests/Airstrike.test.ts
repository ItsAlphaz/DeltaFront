import { TileRef } from "@openfront/engine-api/game/GameMap";
import {
  PlayerInfo,
  PlayerType,
  UnitType,
} from "@openfront/engine-api/game/GameTypes";
import { GameID } from "@openfront/engine-api/Schemas";
import {
  AirstrikeExecution,
  flightPath,
} from "@openfront/engine/execution/AirstrikeExecution";
import { SpawnExecution } from "@openfront/engine/execution/SpawnExecution";
import { Game, Player } from "@openfront/engine/game/Game";
import { snapshotGame } from "@openfront/engine/snapshot/GameSnapshot";
import { setup } from "./util/Setup";
import { roundTrip } from "./util/Snapshot";
import { constructionExecution, executeTicks } from "./util/utils";

const gameID: GameID = "game_id";
const MAP = "big_plains"; // 200×200 land, so targets can sit out of range

let game: Game;
let attacker: Player;
let defender: Player;

function addHuman(id: string): Player {
  const info = new PlayerInfo(id, PlayerType.Human, null, id);
  game.addPlayer(info);
  return game.player(id);
}

/** Give `player` a square of land centred on (cx, cy). */
function conquerSquare(player: Player, cx: number, cy: number, half: number) {
  for (let y = cy - half; y <= cy + half; y++) {
    for (let x = cx - half; x <= cx + half; x++) {
      player.conquer(game.ref(x, y));
    }
  }
}

function airport(): ReturnType<Player["units"]>[number] {
  return attacker.units(UnitType.Airport)[0];
}

/** Launch an airstrike through the real build path (intent → construction). */
function launchAirstrike(target: TileRef) {
  constructionExecution(
    game,
    attacker,
    game.x(target),
    game.y(target),
    UnitType.Airstrike,
    3,
  );
}

/** Ticks until the plane launched at `target` from the airport arrives. */
function flightTicks(target: TileRef): number {
  return flightPath(
    game,
    airport().tile(),
    target,
    game.config().airstrikeSpeed(),
  ).length;
}

describe("Airstrike", () => {
  // In range of an airport at (10, 10): 50 tiles east. Out of range: far corner.
  let inRange: TileRef;
  let outOfRange: TileRef;

  beforeEach(async () => {
    game = await setup(MAP, { infiniteGold: true, instantBuild: true });
    attacker = addHuman("attacker_id");
    defender = addHuman("defender_id");
    game.addExecution(
      new SpawnExecution(gameID, attacker.info(), game.ref(10, 10)),
    );
    game.executeNextTick();
    game.executeNextTick();

    conquerSquare(defender, 60, 10, 8);
    conquerSquare(defender, 180, 180, 8);
    defender.setTroops(100_000);
    inRange = game.ref(60, 10);
    outOfRange = game.ref(180, 180);
  });

  describe("airport placement", () => {
    test("builds on own land as a non-upgradable structure", () => {
      const tile = game.ref(10, 10);
      expect(attacker.canBuild(UnitType.Airport, tile)).not.toBe(false);
      constructionExecution(game, attacker, 10, 10, UnitType.Airport);
      expect(attacker.units(UnitType.Airport)).toHaveLength(1);
      expect(airport().isUnderConstruction()).toBe(false);
      expect(game.config().unitInfo(UnitType.Airport).upgradable).toBeFalsy();
    });

    test("cannot be built on enemy land", () => {
      expect(attacker.canBuild(UnitType.Airport, inRange)).toBe(false);
    });

    test("takes ten seconds to build without instant build", async () => {
      game = await setup(MAP, { infiniteGold: true });
      attacker = addHuman("attacker_id");
      game.addExecution(
        new SpawnExecution(gameID, attacker.info(), game.ref(10, 10)),
      );
      executeTicks(game, 2);
      constructionExecution(game, attacker, 10, 10, UnitType.Airport);
      expect(airport().isUnderConstruction()).toBe(true);
      // Can't strike from an airport that is still being built.
      expect(attacker.canBuild(UnitType.Airstrike, game.ref(60, 10))).toBe(
        false,
      );
      executeTicks(
        game,
        game.config().unitInfo(UnitType.Airport).constructionDuration!,
      );
      expect(airport().isUnderConstruction()).toBe(false);
    });
  });

  describe("targeting", () => {
    test("needs an airport", () => {
      expect(attacker.units(UnitType.Airport)).toHaveLength(0);
      expect(attacker.canBuild(UnitType.Airstrike, inRange)).toBe(false);

      launchAirstrike(inRange);
      executeTicks(game, 5);
      expect(attacker.units(UnitType.Airstrike)).toHaveLength(0);
      expect(defender.troops()).toBe(100_000);
    });

    test("in-range enemy land launches from the airport", () => {
      constructionExecution(game, attacker, 10, 10, UnitType.Airport);
      expect(attacker.canBuild(UnitType.Airstrike, inRange)).toBe(
        airport().tile(),
      );
    });

    test("out-of-range targets are rejected", () => {
      constructionExecution(game, attacker, 10, 10, UnitType.Airport);
      expect(
        game.euclideanDistSquared(airport().tile(), outOfRange),
      ).toBeGreaterThan(game.config().airportRange() ** 2);
      expect(attacker.canBuild(UnitType.Airstrike, outOfRange)).toBe(false);

      launchAirstrike(outOfRange);
      executeTicks(game, 5);
      expect(attacker.units(UnitType.Airstrike)).toHaveLength(0);
      expect(airport().isInCooldown()).toBe(false);
    });

    test("range edge: just inside hits, just outside doesn't", () => {
      constructionExecution(game, attacker, 10, 10, UnitType.Airport);
      const ax = game.x(airport().tile());
      const ay = game.y(airport().tile());
      const range = game.config().airportRange();
      conquerSquare(defender, ax, ay + range, 2);
      expect(
        attacker.canBuild(UnitType.Airstrike, game.ref(ax, ay + range)),
      ).not.toBe(false);
      expect(
        attacker.canBuild(UnitType.Airstrike, game.ref(ax, ay + range + 1)),
      ).toBe(false);
    });

    test("only hits hostile land: not own, unowned or allied", () => {
      constructionExecution(game, attacker, 10, 10, UnitType.Airport);
      // Own land.
      expect(attacker.canBuild(UnitType.Airstrike, game.ref(10, 10))).toBe(
        false,
      );
      // Unowned land.
      expect(attacker.canBuild(UnitType.Airstrike, game.ref(30, 60))).toBe(
        false,
      );
      // Allied land.
      const req = attacker.createAllianceRequest(defender);
      req!.accept();
      expect(attacker.isFriendly(defender)).toBe(true);
      expect(attacker.canBuild(UnitType.Airstrike, inRange)).toBe(false);
    });

    test("uses the nearest armed airport", () => {
      constructionExecution(game, attacker, 10, 10, UnitType.Airport);
      conquerSquare(attacker, 40, 40, 6);
      constructionExecution(game, attacker, 40, 40, UnitType.Airport);
      const [first, second] = attacker.units(UnitType.Airport);
      const target = game.ref(60, 40);
      conquerSquare(defender, 60, 40, 4);
      const nearest =
        game.euclideanDistSquared(first.tile(), target) <
        game.euclideanDistSquared(second.tile(), target)
          ? first
          : second;
      expect(attacker.canBuild(UnitType.Airstrike, target)).toBe(
        nearest.tile(),
      );
    });
  });

  describe("strike", () => {
    beforeEach(() => {
      constructionExecution(game, attacker, 10, 10, UnitType.Airport);
    });

    test("flies to the target, kills troops and keeps the land", () => {
      const tilesBefore = defender.numTilesOwned();
      const troopsBefore = defender.troops();
      launchAirstrike(inRange);
      expect(attacker.units(UnitType.Airstrike)).toHaveLength(1);
      expect(airport().isInCooldown()).toBe(true);

      executeTicks(game, flightTicks(inRange) + 1);
      expect(attacker.units(UnitType.Airstrike)).toHaveLength(0);

      const killed = troopsBefore - defender.troops();
      expect(killed).toBeGreaterThan(0);
      // Tactical, not a nuke: at most a fifth of the defender's troops.
      expect(killed).toBeLessThanOrEqual(Math.ceil(troopsBefore * 0.2));
      expect(defender.numTilesOwned()).toBe(tilesBefore);
      expect(game.isLand(inRange)).toBe(true);
    });

    test("does not destroy structures in the blast", () => {
      defender.buildUnit(UnitType.City, game.ref(60, 12), {});
      launchAirstrike(inRange);
      executeTicks(game, flightTicks(inRange) + 1);
      expect(defender.units(UnitType.City)).toHaveLength(1);
    });

    test("airport rearms after its cooldown, and blocks strikes until then", () => {
      launchAirstrike(inRange);
      expect(attacker.canBuild(UnitType.Airstrike, inRange)).toBe(false);
      executeTicks(game, game.config().AirportCooldown() - 5);
      expect(airport().isInCooldown()).toBe(true);
      executeTicks(game, 10);
      expect(airport().isInCooldown()).toBe(false);
      expect(attacker.canBuild(UnitType.Airstrike, inRange)).toBe(
        airport().tile(),
      );
    });

    test("costs gold when not on infinite gold", async () => {
      game = await setup(MAP, { instantBuild: true });
      attacker = addHuman("attacker_id");
      defender = addHuman("defender_id");
      game.addExecution(
        new SpawnExecution(gameID, attacker.info(), game.ref(10, 10)),
      );
      executeTicks(game, 2);
      conquerSquare(defender, 60, 10, 8);
      const airportCost = game
        .config()
        .unitInfo(UnitType.Airport)
        .cost(game, attacker);
      const strikeCost = game
        .config()
        .unitInfo(UnitType.Airstrike)
        .cost(game, attacker);
      attacker.addGold(airportCost + strikeCost);
      constructionExecution(game, attacker, 10, 10, UnitType.Airport);
      const goldBefore = attacker.gold();
      game.addExecution(new AirstrikeExecution(attacker, game.ref(60, 10)));
      executeTicks(game, 2);
      expect(attacker.units(UnitType.Airstrike)).toHaveLength(1);
      // Gold also trickles in each tick; the strike itself costs strikeCost.
      expect(attacker.gold()).toBeLessThan(goldBefore - strikeCost / 2n);
    });

    test("an alliance formed mid-flight spares the new ally", () => {
      const troopsBefore = defender.troops();
      launchAirstrike(inRange);
      attacker.createAllianceRequest(defender)!.accept();
      executeTicks(game, flightTicks(inRange) + 1);
      expect(defender.troops()).toBeGreaterThanOrEqual(troopsBefore);
    });
  });

  describe("state sync", () => {
    test("snapshot mid-flight restores and keeps ticking identically", async () => {
      constructionExecution(game, attacker, 10, 10, UnitType.Airport);
      launchAirstrike(inRange);
      executeTicks(game, 2);
      expect(attacker.units(UnitType.Airstrike)).toHaveLength(1);

      const { bytes, restored, again } = await roundTrip(game, MAP);
      expect(again).toEqual(bytes);

      const ticks = flightTicks(inRange) + 3;
      executeTicks(game, ticks);
      executeTicks(restored, ticks);
      expect(restored.player("defender_id").troops()).toBe(defender.troops());
      expect(restored.player("attacker_id").units(UnitType.Airstrike)).toEqual(
        [],
      );
      expect(snapshotGame(restored)).toEqual(snapshotGame(game));
    });

    test("two games running the same strike stay identical", async () => {
      const run = async () => {
        const g = await setup(MAP, { infiniteGold: true, instantBuild: true });
        for (const id of ["attacker_id", "defender_id"]) {
          g.addPlayer(new PlayerInfo(id, PlayerType.Human, null, id));
        }
        const a = g.player("attacker_id");
        const d = g.player("defender_id");
        g.addExecution(new SpawnExecution(gameID, a.info(), g.ref(10, 10)));
        executeTicks(g, 2);
        for (let y = 2; y <= 18; y++) {
          for (let x = 52; x <= 68; x++) d.conquer(g.ref(x, y));
        }
        d.setTroops(100_000);
        constructionExecution(g, a, 10, 10, UnitType.Airport);
        constructionExecution(g, a, 60, 10, UnitType.Airstrike, 2);
        executeTicks(g, 40);
        return snapshotGame(g);
      };
      expect(await run()).toEqual(await run());
    });
  });

  describe("config", () => {
    test("troop loss is proportional to land hit and capped at 20%", () => {
      const cfg = game.config();
      expect(cfg.airstrikeTroopLoss(0, 10, 100)).toBe(0);
      expect(cfg.airstrikeTroopLoss(1000, 0, 100)).toBe(0);
      // 5 of 1000 tiles hit → 1% loss.
      expect(cfg.airstrikeTroopLoss(10_000, 5, 1000)).toBe(100);
      // Whole territory in the blast → capped at 20%.
      expect(cfg.airstrikeTroopLoss(10_000, 400, 400)).toBe(2000);
    });

    test("flight path ends on the target, one step per tick", () => {
      const src = game.ref(10, 10);
      const dst = game.ref(60, 10);
      const path = flightPath(game, src, dst, 4);
      expect(path[path.length - 1]).toBe(dst);
      expect(path).toHaveLength(Math.ceil(50 / 4));
    });
  });
});
