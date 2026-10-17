import {
  Cell,
  MessageType,
  UnitType,
} from "@openfront/engine-api/game/GameTypes";
import {
  AirstrikeImpactPhase,
  GameUpdateType,
} from "@openfront/engine-api/game/GameUpdates";
import { EventBus } from "@openfront/shared/EventBus";
import { beforeEach, describe, expect, it } from "vitest";
import {
  AirstrikeAudioController,
  FIRE_INTERVAL_TICKS,
  FLYBY_LEAD_STEPS,
  WARNING_INTERVAL_TICKS,
  WHISTLE_LEAD_STEPS,
} from "../../../src/client/controllers/AirstrikeAudioController";
import {
  type CueOptions,
  PlaySoundEffectEvent,
} from "../../../src/client/sound/Sounds";

const W = 1000;
const ME = 7;
const ENEMY = 9;
const OTHER = 11;

describe("AirstrikeAudioController", () => {
  let bus: EventBus;
  let played: { effect: string; options?: CueOptions }[];
  let tick: number;
  let units: Map<number, any>;
  let updates: Record<number, unknown[]>;
  let owners: Map<number, number>;
  let screen: [Cell, Cell] | null;
  let controller: AirstrikeAudioController;

  const player = (sid: number) => ({
    smallID: () => sid,
    isPlayer: () => true,
  });
  const names = () => played.map((p) => p.effect);
  const tile = (x: number, y: number) => y * W + x;

  /** A plane of `owner` flying `trajectory` tiles; `at` is its current index. */
  function plane(
    id: number,
    type: UnitType,
    owner: number,
    trajectory: number[],
    at: number,
    createdAt = -1,
  ) {
    return {
      id: () => id,
      type: () => type,
      isActive: () => true,
      createdAt: () => createdAt,
      owner: () => player(owner),
      tile: () => trajectory[at],
      targetTile: () => trajectory[trajectory.length - 1],
      nukeState: () => ({
        trajectory: trajectory.map((t) => ({ tile: t, targetable: true })),
      }),
    };
  }

  function step(extra: Record<number, unknown[]> = {}, ...planes: any[]) {
    tick++;
    for (const p of planes) units.set(p.id(), p);
    updates = {
      [GameUpdateType.Unit]: planes.map((p) => ({
        id: p.id(),
        unitType: p.type(),
      })),
      ...extra,
    };
    controller.tick();
  }

  function build(view = true) {
    controller = new AirstrikeAudioController(
      {
        ticks: () => tick,
        unit: (id: number) => units.get(id),
        units: () => [...units.values()],
        myPlayer: () => player(ME),
        updatesSinceLastTick: () => updates,
        owner: (t: number) =>
          owners.has(t)
            ? player(owners.get(t)!)
            : { isPlayer: () => false, smallID: () => 0 },
        x: (t: number) => t % W,
        y: (t: number) => Math.floor(t / W),
      } as any,
      bus,
      view ? { screenBoundingRect: () => screen! } : null,
    );
  }

  beforeEach(() => {
    bus = new EventBus();
    played = [];
    bus.on(PlaySoundEffectEvent, (e) =>
      played.push({ effect: e.effect, options: e.options }),
    );
    tick = 100;
    units = new Map();
    updates = {};
    owners = new Map();
    // On screen: x 0..200, y 0..200.
    screen = [new Cell(0, 0), new Cell(200, 200)];
    build();
  });

  const impact = (
    phase: AirstrikeImpactPhase,
    attackerID: number,
    affected: number[],
    over: Record<string, unknown> = {},
  ) => ({
    phase,
    attackerID,
    affected,
    strikeType: UnitType.BombingRun,
    from: tile(100, 100),
    to: tile(100, 100),
    radius: 10,
    killed: 5000,
    cityLevel: 0,
    levels: 0,
    ...over,
  });

  describe("warnings", () => {
    // A plane just launched, far from the end of its line.
    const FAR = Array.from({ length: 41 }, (_, i) => tile(10 + i, 10));
    const inbound = (unitID: number, playerID = ME) => ({
      unitID,
      playerID,
      messageType: MessageType.AIRSTRIKE_INBOUND,
    });

    it("sounds the air-raid siren for a bombing run or rocket strike inbound on me", () => {
      units.set(1, plane(1, UnitType.BombingRun, ENEMY, FAR, 0));
      step({ [GameUpdateType.UnitIncoming]: [inbound(1)] });
      expect(names()).toEqual(["airstrike-siren"]);
      // Not panned: it is for me, wherever I am looking.
      expect(played[0].options).toBeUndefined();
    });

    it("sounds the klaxon for a strafing run", () => {
      units.set(1, plane(1, UnitType.StrafingRun, ENEMY, FAR, 0));
      step({ [GameUpdateType.UnitIncoming]: [inbound(1)] });
      expect(names()).toEqual(["airstrike-klaxon"]);
    });

    it("warns once for several strikes, not again until the interval has passed", () => {
      units.set(1, plane(1, UnitType.BombingRun, ENEMY, FAR, 0));
      units.set(2, plane(2, UnitType.RocketStrike, ENEMY, FAR, 0));
      step({ [GameUpdateType.UnitIncoming]: [inbound(1), inbound(2)] });
      tick += WARNING_INTERVAL_TICKS - 2;
      step({ [GameUpdateType.UnitIncoming]: [inbound(2)] });
      expect(names()).toEqual(["airstrike-siren"]);
      tick += 2;
      step({ [GameUpdateType.UnitIncoming]: [inbound(2)] });
      expect(names()).toEqual(["airstrike-siren", "airstrike-siren"]);
    });

    it("never warns a player who is not the target", () => {
      units.set(1, plane(1, UnitType.BombingRun, ENEMY, FAR, 0));
      step({ [GameUpdateType.UnitIncoming]: [inbound(1, OTHER)] });
      expect(names()).toEqual([]);
    });
  });

  describe("the aircraft", () => {
    const line = (n: number) =>
      Array.from({ length: n + 1 }, (_, i) => tile(10 + i * 2, 50));

    it("plays the take-off for my own strike, not an enemy's, once for several", () => {
      const path = line(40);
      step(
        {},
        plane(1, UnitType.BombingRun, ME, path, 0, tick + 1),
        plane(2, UnitType.StrafingRun, ME, path, 0, tick + 1),
      );
      expect(names().filter((n) => n === "airstrike-launch")).toHaveLength(1);
      played = [];
      units.clear();
      tick += 20;
      step({}, plane(3, UnitType.RocketStrike, ENEMY, path, 0, tick + 1));
      expect(names()).not.toContain("airstrike-launch");
    });

    it("roars overhead as it nears the end of its line, and whistles bombs down, once each", () => {
      const path = line(40);
      owners.set(path[path.length - 1], ENEMY);
      for (let at = 0; at <= 40; at++) {
        step({}, plane(1, UnitType.BombingRun, ME, path, at));
        const left = 40 - at;
        if (left === FLYBY_LEAD_STEPS)
          expect(names()).toContain("airstrike-flyby");
        if (left === FLYBY_LEAD_STEPS + 1) {
          expect(names()).not.toContain("airstrike-flyby");
        }
        if (left === WHISTLE_LEAD_STEPS) {
          expect(names()).toContain("airstrike-bomb-fall");
        }
      }
      expect(names().filter((n) => n === "airstrike-flyby")).toHaveLength(1);
      expect(names().filter((n) => n === "airstrike-bomb-fall")).toHaveLength(
        1,
      );
    });

    it("whistles only for bombs", () => {
      const path = line(40);
      for (let at = 0; at <= 40; at++) {
        step({}, plane(1, UnitType.StrafingRun, ME, path, at));
      }
      expect(names()).toContain("airstrike-flyby");
      expect(names()).not.toContain("airstrike-bomb-fall");
    });

    it("is heard by the target's owner, not by a stranger looking elsewhere", () => {
      const path = Array.from({ length: 41 }, (_, i) => tile(500 + i, 500));
      owners.set(path[40], ME);
      for (let at = 0; at <= 40; at++) {
        step({}, plane(1, UnitType.BombingRun, ENEMY, path, at));
      }
      expect(names()).toContain("airstrike-flyby");

      played = [];
      units.clear();
      owners.set(path[40], OTHER);
      for (let at = 0; at <= 40; at++) {
        step({}, plane(2, UnitType.BombingRun, ENEMY, path, at));
      }
      expect(names()).toEqual([]);
    });
  });

  describe("impacts", () => {
    it.each([
      [AirstrikeImpactPhase.BombImpact, "airstrike-bomb"],
      [AirstrikeImpactPhase.RocketRelease, "airstrike-rocket"],
      [AirstrikeImpactPhase.RocketImpact, "airstrike-rocket-hit"],
      [AirstrikeImpactPhase.StrafeBurst, "airstrike-strafe"],
    ] as const)("phase %i plays %s when I am hit", (phase, cue) => {
      step({ [GameUpdateType.AirstrikeImpact]: [impact(phase, ENEMY, [ME])] });
      expect(names()[0]).toBe(cue);
    });

    it("plays for my own strikes too, and for a strike on my screen", () => {
      step({
        [GameUpdateType.AirstrikeImpact]: [
          impact(AirstrikeImpactPhase.BombImpact, ME, [ENEMY]),
        ],
      });
      expect(names()[0]).toBe("airstrike-bomb");
      expect(played[0].options?.gain).toBe(1);
      played = [];
      tick += 50;
      step({
        [GameUpdateType.AirstrikeImpact]: [
          impact(AirstrikeImpactPhase.BombImpact, ENEMY, [OTHER]),
        ],
      });
      // A bystander hears what is on screen, quieter.
      expect(names()[0]).toBe("airstrike-bomb");
      expect(played[0].options?.gain).toBeLessThan(1);
    });

    it("stays silent for a strike that neither involves me nor is on my screen", () => {
      step({
        [GameUpdateType.AirstrikeImpact]: [
          impact(AirstrikeImpactPhase.BombImpact, ENEMY, [OTHER], {
            to: tile(800, 800),
          }),
        ],
      });
      expect(names()).toEqual([]);
    });

    it("hears my own strike off screen, quieter, panned to its side", () => {
      step({
        [GameUpdateType.AirstrikeImpact]: [
          impact(AirstrikeImpactPhase.BombImpact, ME, [ENEMY], {
            to: tile(900, 100),
          }),
        ],
      });
      expect(played[0].options?.gain).toBe(0.6);
      expect(played[0].options?.pan).toBeGreaterThan(0.5);
    });

    it("pans a sound to where it is on screen", () => {
      step({
        [GameUpdateType.AirstrikeImpact]: [
          impact(AirstrikeImpactPhase.BombImpact, ME, [ENEMY], {
            to: tile(10, 100),
          }),
        ],
      });
      expect(played[0].options?.pan).toBeLessThan(-0.5);
    });

    it("deepens the blast over a city garrison", () => {
      step({
        [GameUpdateType.AirstrikeImpact]: [
          impact(AirstrikeImpactPhase.BombImpact, ME, [ENEMY], {
            cityLevel: 3,
          }),
        ],
      });
      expect(played[0].options?.rate).toBeLessThan(1);
    });

    it("plays the BRRRT on every burst of a strafing run, but once for two at once", () => {
      const burst = () => impact(AirstrikeImpactPhase.StrafeBurst, ENEMY, [ME]);
      step({ [GameUpdateType.AirstrikeImpact]: [burst(), burst()] });
      expect(names().filter((n) => n === "airstrike-strafe")).toHaveLength(1);
      for (let k = 0; k < 3; k++) {
        tick += 4; // bursts are ~5 ticks apart
        step({ [GameUpdateType.AirstrikeImpact]: [burst()] });
      }
      expect(names().filter((n) => n === "airstrike-strafe")).toHaveLength(4);
    });

    it("leaves a fire crackling after damage, not after a strike on empty land, at most once per interval", () => {
      step({
        [GameUpdateType.AirstrikeImpact]: [
          impact(AirstrikeImpactPhase.BombImpact, ENEMY, [ME], {
            killed: 0,
            levels: 0,
          }),
        ],
      });
      expect(names()).not.toContain("airstrike-fire");
      tick += 10;
      step({
        [GameUpdateType.AirstrikeImpact]: [
          impact(AirstrikeImpactPhase.BombImpact, ENEMY, [ME]),
        ],
      });
      expect(names()).toContain("airstrike-fire");
      tick += FIRE_INTERVAL_TICKS - 5;
      step({
        [GameUpdateType.AirstrikeImpact]: [
          impact(AirstrikeImpactPhase.RocketImpact, ENEMY, [ME]),
        ],
      });
      expect(names().filter((n) => n === "airstrike-fire")).toHaveLength(1);
    });
  });

  it("with no camera, plays only what involves me, unpanned", () => {
    build(false);
    step({
      [GameUpdateType.AirstrikeImpact]: [
        impact(AirstrikeImpactPhase.BombImpact, ENEMY, [OTHER]),
        impact(AirstrikeImpactPhase.RocketImpact, ENEMY, [ME]),
      ],
    });
    expect(names()[0]).toBe("airstrike-rocket-hit");
    expect(played[0].options?.pan).toBeUndefined();
  });
});
