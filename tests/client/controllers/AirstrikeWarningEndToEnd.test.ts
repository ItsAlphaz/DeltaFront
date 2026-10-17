import type { GameUpdates } from "@openfront/engine-api/game/GameTypes";
import {
  AirstrikeUnitType,
  UnitType,
} from "@openfront/engine-api/game/GameTypes";
import { ConstructionExecution } from "@openfront/engine/execution/ConstructionExecution";
import type { Game, Player } from "@openfront/engine/game/Game";
import { EventBus } from "@openfront/shared/EventBus";
import { describe, expect, it } from "vitest";
import { AirstrikeAudioController } from "../../../src/client/controllers/AirstrikeAudioController";
import { PlaySoundEffectEvent } from "../../../src/client/sound/Sounds";
import {
  buildAirport,
  conquerSquare,
  makeWorld,
  STRIKES,
} from "../../airstrike/helpers";

/**
 * The warning, end to end: a real engine strike, its real updates, and the
 * controller that turns them into a siren. Nothing is hand-built, so a change
 * in what the engine sends (or to whom) shows up here.
 */
function listen(game: Game, me: Player) {
  const bus = new EventBus();
  const played: string[] = [];
  bus.on(PlaySoundEffectEvent, (e) => played.push(e.effect));
  let updates: GameUpdates | null = null;
  const created = new Map<number, number>();
  const controller = new AirstrikeAudioController(
    {
      ticks: () => game.ticks(),
      unit: (id: number) => {
        const u = game.units().find((x) => x.id() === id);
        if (u === undefined) return undefined;
        // What a UnitView adds to the engine's Unit.
        return Object.assign(Object.create(u), {
          createdAt: () => created.get(id) ?? game.ticks(),
          nukeState: () => ({ trajectory: [] }),
        });
      },
      units: () => [],
      myPlayer: () => me,
      updatesSinceLastTick: () => updates,
      owner: (t: number) => game.owner(t),
      x: (t: number) => game.x(t),
      y: (t: number) => game.y(t),
    } as never,
    bus,
    null,
  );
  return {
    played,
    step() {
      updates = game.executeNextTick();
      controller.tick();
    },
  };
}

async function world(type: AirstrikeUnitType) {
  const w = await makeWorld();
  conquerSquare(w.game, w.attacker, 20, 20, 5);
  conquerSquare(w.game, w.defender, 100, 20, 5);
  buildAirport(w.game, w.attacker, 20, 20);
  w.game.addExecution(
    new ConstructionExecution(w.attacker, type, w.game.ref(100, 20)),
  );
  return w;
}

describe("airstrike warning, engine to speaker", () => {
  for (const type of STRIKES) {
    it(`warns the targeted player once for a ${type}`, async () => {
      const { game, defender } = await world(type);
      const { played, step } = listen(game, defender);
      for (let i = 0; i < 12; i++) step();
      const warnings = played.filter(
        (p) => p === "airstrike-siren" || p === "airstrike-klaxon",
      );
      expect(warnings).toEqual([
        type === UnitType.StrafingRun ? "airstrike-klaxon" : "airstrike-siren",
      ]);
    });
  }

  it("does not warn the attacker", async () => {
    const { game, attacker } = await world(UnitType.BombingRun);
    const { played, step } = listen(game, attacker);
    for (let i = 0; i < 12; i++) step();
    expect(played).not.toContain("airstrike-siren");
  });
});
