import { appendFileSync, writeFileSync } from "node:fs";
import { Difficulty } from "@openfront/engine-api/game/GameTypes";
import { S, runScenario, type Bonuses } from "./harness";

const OUT = "/tmp/claude-1000/pt-out/";
const DESIGN = process.env.DESIGN ?? "";
const STRAIN = process.env.STRAIN ?? "prop";
const N = Number(process.env.N ?? 48);
const MIN = Number(process.env.MINUTES ?? 20);
const TAG = process.env.TAG ?? `${DESIGN}_${STRAIN}`;
const base = { income: 10, regen: 25, maxTroops: 10, atkLoss: 10 };
const DESIGNS: Record<string, Bonuses> = {
  P: base,
  Z: { income: 0, regen: 0, maxTroops: 0, atkLoss: 0 },
  F250: { ...base, maxTroops: 0, maxFlat: 250_000 },
  F400: { ...base, maxTroops: 0, maxFlat: 400_000 },
  D25: { ...base, discount: 25 },
  I50: { ...base, incomeFlat: 50 },
  F250D25: { ...base, maxTroops: 0, maxFlat: 250_000, discount: 25 },
  F250I50: { ...base, maxTroops: 0, maxFlat: 250_000, incomeFlat: 50 },
  F400D25: { ...base, maxTroops: 0, maxFlat: 400_000, discount: 25 },
  F150D25: { ...base, maxTroops: 0, maxFlat: 150_000, discount: 25 },
  D40: { ...base, discount: 40 },
  XL: { income: 20, regen: 50, maxTroops: 0, maxFlat: 800_000, discount: 40, incomeFlat: 100, atkLoss: 20 },
  L: { income: 10, regen: 40, maxTroops: 0, maxFlat: 600_000, discount: 30, incomeFlat: 50, atkLoss: 15 },
};
const STRAINS: Record<string, { strain: boolean; spec: { grace: number; per: number; cap: number } }> = {
  none: { strain: false, spec: { grace: 6000, per: 3, cap: 30 } },
  prop: { strain: true, spec: { grace: 6000, per: 3, cap: 30 } },
  gentle: { strain: true, spec: { grace: 9000, per: 2, cap: 20 } },
  steep: { strain: true, spec: { grace: 4800, per: 4, cap: 40 } },
};
const SETS: Record<string, typeof S[keyof typeof S][]> = {
  all: [S.EARLY, S.CITY1, S.CITY2, S.MID9, S.LATE15, S.NEVER],
  h2h: [S.CITY1, S.CITY2, S.MID9, S.NEVER],
  h2h3: [S.CITY1, S.MID9, S.LATE15, S.NEVER],
  five: [S.CITY1, S.CITY2, S.MID9, S.LATE15, S.NEVER],
};
const all = SETS[process.env.SET ?? "all"];

test.runIf(DESIGN !== "")("sweep cell", async () => {
  const file = `sim2-${TAG}.jsonl`;
  writeFileSync(OUT + file, "");
  const st = STRAINS[STRAIN];
  for (let seed = 1; seed <= N; seed++) {
    const seats = Array.from({ length: 18 }, (_, i) => ({ strategy: all[(i + seed) % all.length] }));
    const r = await runScenario({
      seats, radius: 0, proposal: true, gameID: `${TAG}${seed}`, minutes: MIN,
      sampleMins: MIN > 20 ? [10, 20, 30, 40] : [10, 20], difficulty: Difficulty.Medium,
      map: "world", randomSpawn: true, bonuses: DESIGNS[DESIGN], strain: st.strain, strainSpec: st.spec, gate: true,
    });
    appendFileSync(OUT + file, JSON.stringify({ seed, ...r }) + "\n");
  }
}, 7_200_000);
