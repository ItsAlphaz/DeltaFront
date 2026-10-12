import { UnitType } from "@openfront/engine-api/game/GameTypes";
import {
  AirstrikeImpactPhase,
  GameUpdateType,
} from "@openfront/engine-api/game/GameUpdates";
import { ConstructionExecution } from "@openfront/engine/execution/ConstructionExecution";
import {
  afterLoss,
  buildAirport,
  collect,
  conquerRect,
  conquerSquare,
  flightLength,
  levelOf,
  makeWorld,
  planeOf,
  run,
  startStrike,
  World,
} from "./helpers";

const T = UnitType.StrafingRun;
const START = 1_000_000;

/** Attacker with an airport at (20, 100); strafe through the target (100, 100). */
async function arena(
  opts: Parameters<typeof makeWorld>[0] = {},
): Promise<World> {
  const w = await makeWorld(opts);
  conquerSquare(w.game, w.attacker, 20, 100, 5);
  buildAirport(w.game, w.attacker, 20, 100);
  return w;
}

/** The defender holds a strip that covers the whole 41 x 5 corridor. */
function strip(w: World, troops = START) {
  conquerRect(w.game, w.defender, 60, 95, 140, 105);
  w.defender.setTroops(troops);
}

/** Defender troops after each of `ticks` ticks (index i = after tick i + 1). */
function troopsPerTick(w: World, ticks: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < ticks; i++) {
    w.game.executeNextTick();
    out.push(w.defender.troops());
  }
  return out;
}

/** The 5% a burst takes, applied n times. */
function afterBursts(n: number): number {
  let t = START;
  for (let i = 0; i < n; i++) t = afterLoss(t, 500);
  return t;
}

describe("Strafing Run", () => {
  test("the plane flies through the target and out past the far end of the corridor", async () => {
    const w = await arena();
    strip(w);
    const src = w.game.ref(20, 100);
    // 80 tiles to the target + 20 corridor half-length + 8 exit = 108 at 2/tick.
    expect(flightLength(w.game, src, w.game.ref(100, 100), T)).toBe(54);
    const plane = startStrike(w.game, w.attacker, T, 100, 100);
    run(w.game, 40); // over the target
    expect(plane.isActive()).toBe(true);
    expect(w.game.x(plane.tile())).toBe(100);
    run(w.game, 13);
    expect(plane.isActive()).toBe(true);
    expect(w.game.x(plane.tile())).toBe(126);
    run(w.game, 1);
    expect(plane.isActive()).toBe(false);
    expect(plane.reachedTarget()).toBe(true);
    expect(w.game.x(plane.tile())).toBe(128);
  });

  test("damage lands in four timed bursts, 5% of troops each", async () => {
    const w = await arena();
    strip(w);
    startStrike(w.game, w.attacker, T, 100, 100);
    const troops = troopsPerTick(w, 54);
    // Bursts fire as the plane clears each 10-tile segment: ticks 35, 40, 45, 50.
    expect(troops[33]).toBe(START);
    expect(troops[34]).toBe(afterBursts(1));
    expect(troops[38]).toBe(afterBursts(1));
    expect(troops[39]).toBe(afterBursts(2));
    expect(troops[43]).toBe(afterBursts(2));
    expect(troops[44]).toBe(afterBursts(3));
    expect(troops[48]).toBe(afterBursts(3));
    expect(troops[49]).toBe(afterBursts(4));
    expect(troops[53]).toBe(afterBursts(4));
  });

  test("each burst is announced with its segment", async () => {
    const w = await arena();
    strip(w);
    startStrike(w.game, w.attacker, T, 100, 100);
    const bursts = collect(w.game, GameUpdateType.AirstrikeImpact, 54);
    expect(bursts).toHaveLength(4);
    for (const b of bursts) {
      expect(b.phase).toBe(AirstrikeImpactPhase.StrafeBurst);
      expect(b.radius).toBe(2);
      expect(b.affected).toEqual([w.defender.smallID()]);
    }
    expect(w.game.x(bursts[0].from)).toBe(80);
    expect(w.game.x(bursts[0].to)).toBe(90);
    expect(w.game.x(bursts[3].to)).toBe(120);
  });

  test("only the 5-wide corridor is hit", async () => {
    const w = await arena({ extra: ["beside_id"] });
    strip(w);
    const beside = w.game.player("beside_id");
    // Just outside the corridor (corridor rows are y 98..102).
    conquerRect(w.game, beside, 80, 103, 120, 106);
    beside.setTroops(START);
    startStrike(w.game, w.attacker, T, 100, 100);
    run(w.game, 60);
    expect(beside.troops()).toBe(START);
    expect(w.defender.troops()).toBe(afterBursts(4));
  });

  test("a vertical approach strafes along the vertical line", async () => {
    const w = await makeWorld();
    conquerSquare(w.game, w.attacker, 100, 20, 5);
    buildAirport(w.game, w.attacker, 100, 20);
    conquerRect(w.game, w.defender, 95, 60, 105, 140);
    w.defender.setTroops(START);
    startStrike(w.game, w.attacker, T, 100, 100);
    run(w.game, 60);
    expect(w.defender.troops()).toBe(afterBursts(4));
  });

  test("every player under the corridor is hit, and warned", async () => {
    const w = await arena({ extra: ["second_id"] });
    const second = w.game.player("second_id");
    conquerRect(w.game, w.defender, 80, 95, 99, 105);
    conquerRect(w.game, second, 100, 95, 120, 105);
    w.defender.setTroops(START);
    second.setTroops(START);
    w.game.addExecution(
      new ConstructionExecution(w.attacker, T, w.game.ref(100, 100)),
    );
    const incoming = collect(w.game, GameUpdateType.UnitIncoming, 4);
    expect(incoming.map((i) => i.playerID).sort()).toEqual(
      [w.defender.smallID(), second.smallID()].sort(),
    );
    run(w.game, 60);
    // The defender holds the first two segments, the other player the last two.
    expect(w.defender.troops()).toBe(afterBursts(2));
    expect(second.troops()).toBe(afterBursts(2));
  });

  test("a plane destroyed mid-run keeps the bursts already delivered and drops no more", async () => {
    const w = await arena();
    strip(w);
    const plane = startStrike(w.game, w.attacker, T, 100, 100);
    run(w.game, 41); // bursts 1 and 2 have landed (ticks 35 and 40)
    expect(w.defender.troops()).toBe(afterBursts(2));
    plane.delete(true, w.defender);
    run(w.game, 30);
    expect(w.defender.troops()).toBe(afterBursts(2));
    expect(planeOf(w.attacker, T)).toBeUndefined();
  });

  test("an alliance formed mid-pass spares the later bursts only", async () => {
    const w = await arena();
    strip(w);
    startStrike(w.game, w.attacker, T, 100, 100);
    run(w.game, 42);
    expect(w.defender.troops()).toBe(afterBursts(2));
    w.attacker.createAllianceRequest(w.defender)!.accept();
    run(w.game, 20);
    expect(w.defender.troops()).toBe(afterBursts(2));
  });

  test("an ally under the corridor is never hit", async () => {
    const w = await arena({ extra: ["ally_id"] });
    const ally = w.game.player("ally_id");
    conquerRect(w.game, ally, 60, 95, 140, 105);
    ally.setTroops(START);
    w.attacker.createAllianceRequest(ally)!.accept();
    conquerRect(w.game, w.defender, 100, 95, 140, 105); // hostile land beyond the ally's
    conquerRect(w.game, ally, 80, 95, 99, 105);
    w.defender.setTroops(START);
    startStrike(w.game, w.attacker, T, 100, 100);
    run(w.game, 60);
    expect(ally.troops()).toBe(START);
    expect(w.defender.troops()).toBeLessThan(START);
  });

  test("hits at most one structure: the first under the centreline", async () => {
    const w = await arena();
    strip(w);
    const first = w.defender.buildUnit(UnitType.City, w.game.ref(90, 100), {});
    const second = w.defender.buildUnit(
      UnitType.Factory,
      w.game.ref(105, 100),
      {},
    );
    startStrike(w.game, w.attacker, T, 100, 100);
    run(w.game, 60);
    expect(first.isActive()).toBe(false);
    expect(second.isActive()).toBe(true);
  });

  test("a structure more than 1.5 tiles off the centreline is spared", async () => {
    const w = await arena();
    strip(w);
    const off = w.defender.buildUnit(UnitType.City, w.game.ref(95, 102), {});
    const close = w.defender.buildUnit(
      UnitType.Factory,
      w.game.ref(115, 101),
      {},
    );
    startStrike(w.game, w.attacker, T, 100, 100);
    run(w.game, 60);
    expect(off.isActive()).toBe(true);
    expect(close.isActive()).toBe(false);
  });

  test("an allied structure first under the centreline is skipped for the next hostile one", async () => {
    const w = await arena({ extra: ["ally_id"] });
    strip(w);
    const ally = w.game.player("ally_id");
    ally.conquer(w.game.ref(85, 100));
    w.attacker.createAllianceRequest(ally)!.accept();
    const allied = ally.buildUnit(UnitType.City, w.game.ref(85, 100), {});
    const hostile = w.defender.buildUnit(
      UnitType.City,
      w.game.ref(95, 100),
      {},
    );
    startStrike(w.game, w.attacker, T, 100, 100);
    run(w.game, 60);
    expect(allied.isActive()).toBe(true);
    expect(hostile.isActive()).toBe(false);
  });

  test("structures take less punishment than from bombs: a level-3 city loses one level", async () => {
    const w = await arena();
    strip(w);
    const city = w.defender.buildUnit(UnitType.City, w.game.ref(100, 100), {});
    city.increaseLevel();
    city.increaseLevel();
    startStrike(w.game, w.attacker, T, 100, 100);
    run(w.game, 60);
    expect(levelOf(city)).toBe(2);
  });

  test("never destroys land", async () => {
    const w = await arena();
    strip(w);
    const tiles = w.defender.numTilesOwned();
    startStrike(w.game, w.attacker, T, 100, 100);
    run(w.game, 60);
    expect(w.defender.numTilesOwned()).toBe(tiles);
  });

  test("a corridor running off the map edge is clipped without error", async () => {
    const w = await arena();
    conquerRect(w.game, w.defender, 150, 95, 199, 105);
    w.defender.setTroops(START);
    const plane = startStrike(w.game, w.attacker, T, 190, 100);
    run(w.game, 120);
    expect(plane.isActive()).toBe(false);
    expect(plane.reachedTarget()).toBe(true);
    expect(w.game.x(plane.tile())).toBe(199);
    expect(w.defender.troops()).toBeLessThan(START);
    expect(planeOf(w.attacker, T)).toBeUndefined();
  });
});
