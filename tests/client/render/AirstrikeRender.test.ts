/**
 * Client-side pieces of the airstrike visuals: the plane sprite heading, the
 * target rings, and the engine-to-renderer impact events.
 */
import { UnitType } from "@openfront/engine-api/game/GameTypes";
import {
  AirstrikeImpactPhase,
  GameUpdateType,
} from "@openfront/engine-api/game/GameUpdates";
import { describe, expect, it } from "vitest";
import { extractNukeTelegraphs } from "../../../src/client/render/frame/derive/NukeTelegraphs";
import { planeHeadingByte } from "../../../src/client/render/gl/passes/UnitPass";
import type { UnitState } from "../../../src/client/render/types";
import {
  AIRCRAFT_TYPES,
  AIRSTRIKE_TELEGRAPH_RADII,
  UT_BOMBING_RUN,
  UT_ROCKET_STRIKE,
  UT_STRAFING_RUN,
} from "../../../src/client/render/types";
import { GameView } from "../../../src/client/view";
import { makeWorld } from "../../airstrike/helpers";

describe("planeHeadingByte", () => {
  it("turns a nose-up sprite to face the flight direction", () => {
    expect(planeHeadingByte(0, -1)).toBe(0); // north
    expect(planeHeadingByte(1, 0)).toBe(64); // east
    expect(planeHeadingByte(0, 1)).toBe(128); // south
    expect(planeHeadingByte(-1, 0)).toBe(192); // west
  });

  it("leaves a stationary plane unrotated", () => {
    expect(planeHeadingByte(0, 0)).toBe(0);
  });

  it("is independent of the vector's length", () => {
    expect(planeHeadingByte(2, 0)).toBe(planeHeadingByte(1, 0));
    expect(planeHeadingByte(-7, -7)).toBe(planeHeadingByte(-1, -1));
  });

  it("stays within a byte for diagonals", () => {
    for (const [dx, dy] of [
      [1, 1],
      [-1, 1],
      [-1, -1],
      [1, -1],
    ]) {
      const b = planeHeadingByte(dx, dy);
      expect(b).toBeGreaterThanOrEqual(0);
      expect(b).toBeLessThan(256);
    }
    expect(planeHeadingByte(1, 1)).toBe(96);
    expect(planeHeadingByte(-1, 1)).toBe(160);
  });
});

describe("airstrike target rings", () => {
  it("draws a ring for bombing and rocket strikes, none for strafing", () => {
    expect(AIRSTRIKE_TELEGRAPH_RADII[UT_BOMBING_RUN]).toBe(10);
    expect(AIRSTRIKE_TELEGRAPH_RADII[UT_ROCKET_STRIKE]).toBe(4);
    expect(AIRSTRIKE_TELEGRAPH_RADII[UT_STRAFING_RUN]).toBeUndefined();
  });

  it("matches the engine's telegraphRadius for every strike", async () => {
    const { game } = await makeWorld();
    for (const type of [
      UnitType.BombingRun,
      UnitType.RocketStrike,
      UnitType.StrafingRun,
    ]) {
      const engine = game.config().airstrikeSpec(type).telegraphRadius;
      const client = AIRSTRIKE_TELEGRAPH_RADII[type];
      expect(client, type).toBe(engine > 0 ? engine : undefined);
    }
  });

  it("knows all three strikes are aircraft", () => {
    expect([...AIRCRAFT_TYPES].sort()).toEqual(
      [UT_BOMBING_RUN, UT_ROCKET_STRIKE, UT_STRAFING_RUN].sort(),
    );
  });

  it("extracts a ring at the target of a flying bomber and rocket only", () => {
    const plane = (id: number, unitType: string): UnitState =>
      ({
        id,
        unitType,
        ownerID: 1,
        isActive: true,
        waitTicks: 0,
        targetTile: 305,
      }) as UnitState;
    const rings = extractNukeTelegraphs(
      new Map([
        [1, plane(1, UT_BOMBING_RUN)],
        [2, plane(2, UT_ROCKET_STRIKE)],
        [3, plane(3, UT_STRAFING_RUN)],
      ]),
      100,
    );
    expect(rings).toHaveLength(2);
    expect(rings.map((r) => [r.x, r.y, r.outerRadius]).sort()).toEqual([
      [5, 3, 10],
      [5, 3, 4],
    ]);
  });
});

describe("GameView airstrike impact events", () => {
  it("maps engine impacts to renderer events with tile coordinates", () => {
    const width = 100;
    const events = {
      deadUnits: [],
      conquestEvents: [],
      bonusEvents: [],
      airstrikeImpacts: [] as unknown[],
    };
    const fake = {
      _frame: { events },
      _myPlayer: null,
      _players: new Map(),
      _map: {
        x: (t: number) => t % width,
        y: (t: number) => Math.floor(t / width),
      },
    };
    const build = (
      GameView.prototype as unknown as {
        buildFrameEvents(gu: unknown): void;
      }
    ).buildFrameEvents;

    const update = (phase: AirstrikeImpactPhase, from: number, to: number) => ({
      type: GameUpdateType.AirstrikeImpact,
      strikeType: UnitType.RocketStrike,
      attackerID: 1,
      phase,
      from,
      to,
      radius: 4,
      affected: [2],
    });
    const gu = {
      updates: {
        [GameUpdateType.AirstrikeImpact]: [
          update(AirstrikeImpactPhase.RocketRelease, 1203, 1213),
          update(AirstrikeImpactPhase.RocketImpact, 1213, 1213),
        ],
      },
    };
    build.call(fake, gu);

    expect(events.airstrikeImpacts).toEqual([
      {
        phase: AirstrikeImpactPhase.RocketRelease,
        strikeType: UnitType.RocketStrike,
        fromX: 3,
        fromY: 12,
        toX: 13,
        toY: 12,
        radius: 4,
      },
      {
        phase: AirstrikeImpactPhase.RocketImpact,
        strikeType: UnitType.RocketStrike,
        fromX: 13,
        fromY: 12,
        toX: 13,
        toY: 12,
        radius: 4,
      },
    ]);

    // The next tick starts clean.
    build.call(fake, { updates: {} });
    expect(events.airstrikeImpacts).toEqual([]);
  });
});
