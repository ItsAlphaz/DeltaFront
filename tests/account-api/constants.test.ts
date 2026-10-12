// @vitest-environment node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CLAN_RULES, ECONOMY } from "../../src/account-api/domain/constants";

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

describe("the owner-defined constants (docs/DeltaFrontAccountsPlan.md D1, D2)", () => {
  it("Credits: 100 per completed game, 250 win bonus, 1,000 a day", () => {
    expect(ECONOMY.currencyName).toBe("Credits");
    expect(ECONOMY.completedGameReward).toBe(100);
    expect(ECONOMY.winBonus).toBe(250);
    expect(ECONOMY.dailyGameplayCap).toBe(1000);
    expect(ECONOMY.minEliminationTick).toBe(1200);
  });

  it("clan creation: account at least 3 days old, at least 10 completed games, one clan at a time", () => {
    expect(CLAN_RULES.createMinAccountAgeDays).toBe(3);
    expect(CLAN_RULES.createMinCompletedGames).toBe(10);
    expect(CLAN_RULES.maxClansPerMember).toBe(1);
    expect(CLAN_RULES.maxOwnedClans).toBe(1);
    expect(CLAN_RULES.maxPendingRequests).toBe(3);
    expect(CLAN_RULES.disbandedTagHoldDays).toBe(90);
    expect(CLAN_RULES.nameChangeCooldownDays).toBe(30);
  });

  it("can not be changed at runtime", () => {
    expect(Object.isFrozen(ECONOMY)).toBe(true);
    expect(Object.isFrozen(CLAN_RULES)).toBe(true);
    expect(() => {
      (ECONOMY as { winBonus: number }).winBonus = 1;
    }).toThrow(TypeError);
    expect(() => {
      (
        CLAN_RULES as { createMinCompletedGames: number }
      ).createMinCompletedGames = 0;
    }).toThrow(TypeError);
    expect(ECONOMY.winBonus).toBe(250);
  });

  it("the rebalancing values are small enough to reason about: a win pays the bonus plus the base, within the cap", () => {
    expect(ECONOMY.completedGameReward + ECONOMY.winBonus).toBeLessThanOrEqual(
      ECONOMY.dailyGameplayCap,
    );
  });
});

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(path.join(ROOT, dir), {
    withFileTypes: true,
  })) {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) sourceFiles(rel, out);
    else if (rel.endsWith(".ts")) out.push(rel);
  }
  return out;
}

describe("the constants are loaded centrally", () => {
  const CONSTANTS_FILE = "src/account-api/domain/constants.ts";
  const files = sourceFiles("src/account-api").filter(
    (f) => f !== CONSTANTS_FILE,
  );

  it("only constants.ts defines ECONOMY and CLAN_RULES", () => {
    for (const file of files) {
      const text = fs.readFileSync(path.join(ROOT, file), "utf8");
      expect(text, file).not.toMatch(
        /\b(export\s+)?const\s+(ECONOMY|CLAN_RULES)\b/,
      );
    }
    const own = fs.readFileSync(path.join(ROOT, CONSTANTS_FILE), "utf8");
    expect(own).toMatch(/export const ECONOMY\b/);
    expect(own).toMatch(/export const CLAN_RULES\b/);
  });

  const TOPIC =
    /(reward|bonus|cap|credit|completed|account.?age|min.?age|clan)/i;
  const NUMBER = /(?<![\w.])(100|250|1000|1_000|1200|1_200|3|10)(?![\w.])/;

  // A heuristic, not a proof: a line that talks about rewards, bonuses, caps,
  // credits, completed games, account age or clans and also contains one of the
  // owner's numbers is probably restating a rule that belongs in constants.ts.
  it("no other source file restates a reward or clan number", () => {
    const offenders: string[] = [];
    for (const file of files) {
      fs.readFileSync(path.join(ROOT, file), "utf8")
        .split("\n")
        .forEach((line, index) => {
          const code = line.trim();
          if (/^(\/\/|\/\*|\*)/.test(code)) return;
          const stripped = code
            .replace(/\/\/.*$/, "")
            .replace(/(["'`])(?:\\.|(?!\1).)*\1/g, '""');
          if (TOPIC.test(stripped) && NUMBER.test(stripped)) {
            offenders.push(`${file}:${index + 1}: ${code}`);
          }
        });
    }
    expect(offenders).toEqual([]);
  });

  it("the check can see a violation (it would catch a hard-coded reward)", () => {
    for (const line of [
      "const reward = completed ? 100 : 0;",
      "if (wins > 0) credits += 250;",
      "const dailyCap = 1_000;",
      "if (accountAgeDays < 3) throw new Error();",
      "completedGames >= 10",
    ]) {
      expect(TOPIC.test(line) && NUMBER.test(line), line).toBe(true);
    }
  });
});
