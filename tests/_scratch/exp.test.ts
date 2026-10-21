import { appendFileSync, writeFileSync } from "node:fs";
import { Difficulty } from "@openfront/engine-api/game/GameTypes";
import { S, runScenario, type Strategy } from "./harness";

const OUT = "/tmp/claude-1000/pt-out/";
const EXP = process.env.EXP ?? "";
const N = Number(process.env.N ?? 40);
const all = [S.EARLY, S.CITY1, S.CITY2, S.MID9, S.LATE15, S.NEVER];
const DIFF: Record<string, Difficulty> = { Easy: Difficulty.Easy, Medium: Difficulty.Medium, Hard: Difficulty.Hard, Impossible: Difficulty.Impossible };
const COMMIT: Record<string, number> = { Easy: 5400, Medium: 4200, Hard: 3000, Impossible: 2400 };

function log(file: string, o: unknown) {
  appendFileSync(OUT + file, JSON.stringify(o) + "\n");
}

// A: the strategies against each other (18 nations, world map)
async function expStrategies(tag: string, o: { bonuses?: any; strain?: boolean; proposal?: boolean; startGold?: bigint }) {
  const file = `sim-${tag}.jsonl`;
  writeFileSync(OUT + file, "");
  for (let seed = 1; seed <= N; seed++) {
    const seats = Array.from({ length: 18 }, (_, i) => ({ strategy: all[(i + seed) % 6] }));
    const r = await runScenario({ seats, radius: 0, proposal: o.proposal ?? true, gameID: `${tag}${seed}`, minutes: Number(process.env.MINUTES ?? 20), sampleMins: process.env.MINUTES ? [10, 20, 30, 40] : undefined, difficulty: Difficulty.Medium, map: "world", randomSpawn: true, bonuses: o.bonuses, strain: o.strain, startGold: o.startGold });
    log(file, { seed, ...r });
  }
}

// E1: each strategy alone on the map: the pure economy, no war and no conquest gold
async function expTiming() {
  const file = "sim-timing.jsonl";
  writeFileSync(OUT + file, "");
  for (const s of all) for (let seed = 1; seed <= 3; seed++) {
    const r = await runScenario({ seats: [{ strategy: s }], radius: 0, proposal: true, gameID: `t${seed}`, minutes: 12, difficulty: Difficulty.Medium, map: "world", randomSpawn: true, sampleMins: [2, 4, 6, 8, 10, 12] });
    log(file, { strat: s.label, seed, ...r });
  }
}

// D: the AI by difficulty: baseline (free capital) vs proposed policies
async function expAI(tag: string, proposal: boolean, preCities: number) {
  for (const d of Object.keys(DIFF)) {
    const file = `sim-${tag}-${d}.jsonl`;
    writeFileSync(OUT + file, "");
    const strat: Strategy = { label: tag, preCities, commitTick: COMMIT[d] };
    for (let seed = 1; seed <= N; seed++) {
      const seats = Array.from({ length: 18 }, () => ({ strategy: strat }));
      const r = await runScenario({ seats, radius: 0, proposal, gameID: `${tag}${d}${seed}`, minutes: 20, difficulty: DIFF[d], map: "world", randomSpawn: true });
      log(file, { seed, ...r });
    }
  }
}

test.runIf(EXP === "A")("strategies", () => expStrategies("A", {}), 3_600_000);
test.runIf(EXP === "Anobonus")("strategies, no bonuses", () => expStrategies("Anobonus", { bonuses: { income: 0, regen: 0, maxTroops: 0, atkLoss: 0 } }), 3_600_000);
test.runIf(EXP === "Adouble")("strategies, doubled bonuses", () => expStrategies("Adouble", { bonuses: { income: 20, regen: 50, maxTroops: 20, atkLoss: 20 } }), 3_600_000);
test.runIf(EXP === "Anostrain")("strategies, no strain", () => expStrategies("Anostrain", { strain: false }), 3_600_000);
test.runIf(EXP === "Abaseline")("baseline free capital", () => expStrategies("Abaseline", { proposal: false }), 3_600_000);
test.runIf(EXP === "timing")("timing", () => expTiming(), 3_600_000);
test.runIf(EXP === "Dbase")("AI baseline", () => expAI("Dbase", false, 0), 3_600_000);
test.runIf(EXP === "Dpure")("AI pure saving", () => expAI("Dpure", true, 0), 3_600_000);
test.runIf(EXP === "Dbal")("AI balanced", () => expAI("Dbal", true, 1), 3_600_000);
test.runIf(EXP === "Abig")("strategies, strong bonuses", () => expStrategies("Abig", { bonuses: { income: 20, regen: 40, maxTroops: 30, atkLoss: 20 } }), 3_600_000);
test.runIf(EXP === "Agrant350")("strategies, 350K grant", () => expStrategies("Agrant350", { startGold: 350_000n }), 3_600_000);

async function expLong() {
  const file = "sim-long.jsonl";
  writeFileSync(OUT + file, "");
  const strat: Strategy = { label: "Dlong", preCities: 0, commitTick: 99999 };
  for (const [d, n] of [["Medium", 6], ["Hard", 2]] as const) for (let seed = 1; seed <= n; seed++) {
    const seats = Array.from({ length: 18 }, () => ({ strategy: strat }));
    const r = await runScenario({ seats, radius: 0, proposal: false, gameID: `long${d}${seed}`, minutes: 40, difficulty: DIFF[d], map: "world", randomSpawn: true, sampleMins: [20, 30, 40] });
    log(file, { d, seed, ...r });
  }
}
test.runIf(EXP === "long")("long baseline games", () => expLong(), 3_600_000);
