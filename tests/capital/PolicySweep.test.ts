import {
  Difficulty,
  Nation,
  PlayerInfo,
  PlayerType,
  UnitType,
} from "@openfront/engine-api/game/GameTypes";
import { NationExecution } from "@openfront/engine/execution/NationExecution";
import { appendFileSync, writeFileSync } from "node:fs";
import { setup } from "../util/Setup";
import { UseRealAttackLogic } from "../util/TestConfig";

/**
 * The final nation policy, end to end, on the real v0.8.0 rules (no patches):
 * 18 nations on the world map, every one on the same difficulty, 20 minutes. It
 * reports when each nation bought its capital, and how many survived and built.
 * Skipped unless asked for (it plays hundreds of matches):
 *
 *   POLICY_SWEEP=1 DIFFICULTY=Medium GAMES=24 npx vitest tests/capital/PolicySweep.test.ts --run
 *
 * One JSON line per match goes to POLICY_OUT (default /tmp/capital-policy-<difficulty>.jsonl).
 * docs/CapitalBalance.md quotes the numbers.
 */
const ON = process.env.POLICY_SWEEP === "1";
const LEVELS: Record<string, Difficulty> = {
  Easy: Difficulty.Easy,
  Medium: Difficulty.Medium,
  Hard: Difficulty.Hard,
  Impossible: Difficulty.Impossible,
};
const NAME = process.env.DIFFICULTY ?? "Medium";
const GAMES = Number(process.env.GAMES ?? 24);
const MINUTES = Number(process.env.MINUTES ?? 20);
const OUT = process.env.POLICY_OUT ?? `/tmp/capital-policy-${NAME}.jsonl`;

describe.runIf(ON)("the nation capital policy, end to end", () => {
  test(`${NAME}: ${GAMES} matches of 18 nations`, async () => {
    writeFileSync(OUT, "");
    for (let seed = 1; seed <= GAMES; seed++) {
      const nations = Array.from(
        { length: 18 },
        (_, i) =>
          new Nation(
            undefined,
            new PlayerInfo(`N${i}`, PlayerType.Nation, null, `N${i}`),
          ),
      );
      const game = await setup(
        "world",
        { capitalSystem: { enabled: true }, difficulty: LEVELS[NAME] },
        [],
        undefined,
        UseRealAttackLogic,
        false,
        nations,
      );
      for (const n of nations) {
        game.addExecution(new NationExecution(`policy${NAME}${seed}`, n));
      }
      for (let t = 0; t < 40; t++) game.executeNextTick();
      game.endSpawnPhase();
      const start = game.ticks();
      const bought = new Map<string, number>();
      const samples: unknown[] = [];
      for (let t = 1; t <= MINUTES * 600; t++) {
        game.executeNextTick();
        for (const p of game.allPlayers()) {
          if (p.type() !== PlayerType.Nation || bought.has(p.name())) continue;
          if (game.capitals()!.capitalOf(p) !== null) {
            bought.set(p.name(), (game.ticks() - start) / 600);
          }
        }
        if (t % 600 === 0 && [10, 20].includes(t / 600)) {
          for (const p of game.allPlayers()) {
            if (p.type() !== PlayerType.Nation) continue;
            samples.push({
              min: t / 600,
              name: p.name(),
              alive: p.isAlive(),
              tiles: p.numTilesOwned(),
              cities: p.units(UnitType.City).length,
              posts: p.units(UnitType.DefensePost).length,
              ports: p.units(UnitType.Port).length,
              capital: game.capitals()!.capitalOf(p) !== null,
              firstBuy: bought.get(p.name()) ?? null,
            });
          }
        }
      }
      appendFileSync(
        OUT,
        JSON.stringify({ seed, bought: [...bought], samples }) + "\n",
      );
    }
  }, 7_200_000);
});
