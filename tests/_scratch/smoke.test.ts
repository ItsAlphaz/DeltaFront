import { writeFileSync } from "node:fs";
import { Difficulty } from "@openfront/engine-api/game/GameTypes";
import { S, runScenario } from "./harness";
test("smoke", async () => {
  const t0 = Date.now();
  const strat = [S.EARLY,S.CITY1,S.CITY2,S.MID9,S.LATE15,S.NEVER];
  const seats = Array.from({length: 18}, (_, i) => ({ strategy: strat[i % 6] }));
  const r = await runScenario({ seats, radius: 60, proposal: true, gameID: "s1", minutes: 15, difficulty: Difficulty.Medium, map: "world", randomSpawn: true });
  writeFileSync("/tmp/claude-1000/pt-out/smoke.json", JSON.stringify({ms: Date.now()-t0, bought: r.boughtAtMin, last: r.samples.filter(s=>[2,5,10,15].includes(s.min))}, null, 1));
}, 900_000);
