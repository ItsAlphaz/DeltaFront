import {
  canPrestige,
  CONQUEROR_WINS,
  earnedTitles,
  isLegend,
  isTitleId,
  LEVEL_MILESTONES,
  levelFromRunXp,
  levelsBetween,
  MAX_LEVEL,
  MAX_PRESTIGE,
  MAX_RUN_XP,
  progressState,
  RANK_KEYS,
  rankForLevel,
  runProgress,
  SEASON_MAX_LEVEL,
  SEASON_TRACK,
  seasonLevel,
  seasonXpForLevel,
  trackRewardsBetween,
  xpForLevel,
  xpToNext,
} from "@openfront/shared/ProgressionRules";
import { describe, expect, it } from "vitest";

describe("the level curve", () => {
  it("matches the approved sample thresholds", () => {
    // [level, XP to the next level, run XP at which the level is reached]
    const samples: Array<[number, number, number]> = [
      [1, 500, 0],
      [2, 580, 500],
      [5, 810, 2_460],
      [10, 1_200, 7_270],
      [20, 2_050, 23_060],
      [25, 2_500, 34_210],
      [50, 5_020, 126_000],
      [75, 7_970, 285_900],
      [90, 9_950, 419_060],
      [99, 11_210, 513_600],
    ];
    for (const [level, toNext, reach] of samples) {
      expect(xpToNext(level), `xpToNext(${level})`).toBe(toNext);
      expect(xpForLevel(level), `xpForLevel(${level})`).toBe(reach);
    }
    expect(xpForLevel(100)).toBe(524_810);
    expect(MAX_RUN_XP).toBe(524_810);
  });

  it("is the approved formula, in whole numbers", () => {
    for (let level = 1; level < MAX_LEVEL; level++) {
      const n = level - 1;
      const exact = (10_000 + 1_500 * n + 7 * n * n) / 200;
      // round half up, then times ten
      expect(xpToNext(level)).toBe(Math.floor(exact + 0.5) * 10);
    }
  });

  it("only gets harder, one level at a time, and has nothing beyond 100", () => {
    for (let level = 1; level < MAX_LEVEL - 1; level++) {
      expect(xpToNext(level + 1)).toBeGreaterThan(xpToNext(level));
    }
    expect(xpToNext(100)).toBe(0);
    expect(xpToNext(0)).toBe(0);
    expect(xpToNext(101)).toBe(0);
    expect(xpToNext(2.5)).toBe(0);
  });

  it("puts every level boundary on exactly the right XP", () => {
    for (let level = 1; level <= MAX_LEVEL; level++) {
      const at = xpForLevel(level);
      expect(levelFromRunXp(at), `at ${level}`).toBe(level);
      if (level > 1) {
        expect(levelFromRunXp(at - 1), `just before ${level}`).toBe(level - 1);
      }
      if (level < MAX_LEVEL) {
        expect(levelFromRunXp(xpForLevel(level + 1) - 1)).toBe(level);
      }
    }
  });

  it("clamps at level 100 and at nonsense input", () => {
    expect(levelFromRunXp(MAX_RUN_XP)).toBe(100);
    expect(levelFromRunXp(MAX_RUN_XP * 10)).toBe(100);
    expect(levelFromRunXp(-5)).toBe(1);
    expect(levelFromRunXp(NaN)).toBe(1);
    expect(levelFromRunXp(Infinity)).toBe(1);
  });

  it("reports XP into the level and to the next, and nothing at 100", () => {
    expect(runProgress(0)).toEqual({ level: 1, xpInLevel: 0, xpForNext: 500 });
    expect(runProgress(499)).toEqual({
      level: 1,
      xpInLevel: 499,
      xpForNext: 500,
    });
    expect(runProgress(500)).toEqual({
      level: 2,
      xpInLevel: 0,
      xpForNext: 580,
    });
    expect(runProgress(MAX_RUN_XP)).toEqual({
      level: 100,
      xpInLevel: 0,
      xpForNext: 0,
    });
    expect(runProgress(MAX_RUN_XP + 99_999)).toEqual({
      level: 100,
      xpInLevel: 0,
      xpForNext: 0,
    });
  });

  it("lists every level a gain crosses, including several at once", () => {
    expect(levelsBetween(0, 499)).toEqual([]);
    expect(levelsBetween(499, 500)).toEqual([2]);
    expect(levelsBetween(0, 2_460)).toEqual([2, 3, 4, 5]);
    expect(levelsBetween(xpForLevel(99), MAX_RUN_XP)).toEqual([100]);
    expect(levelsBetween(MAX_RUN_XP, MAX_RUN_XP)).toEqual([]);
  });

  it("makes level 100 a long way off: about 525k XP", () => {
    expect(MAX_RUN_XP).toBeGreaterThan(500_000);
    expect(MAX_RUN_XP).toBeLessThan(550_000);
  });
});

describe("military ranks", () => {
  it("maps every boundary to the approved rank", () => {
    const expected: Array<[number, string]> = [
      [1, "recruit"],
      [9, "recruit"],
      [10, "private"],
      [19, "private"],
      [20, "corporal"],
      [29, "corporal"],
      [30, "sergeant"],
      [39, "sergeant"],
      [40, "lieutenant"],
      [49, "lieutenant"],
      [50, "captain"],
      [59, "captain"],
      [60, "major"],
      [74, "major"],
      [75, "colonel"],
      [89, "colonel"],
      [90, "general"],
      [99, "general"],
      [100, "supreme_commander"],
    ];
    for (const [level, rank] of expected) {
      expect(rankForLevel(level), `level ${level}`).toBe(rank);
    }
  });

  it("uses every rank exactly once across 1..100, and survives bad input", () => {
    const seen = new Set<string>();
    for (let level = 1; level <= MAX_LEVEL; level++)
      seen.add(rankForLevel(level));
    expect([...seen].sort()).toEqual([...RANK_KEYS].sort());
    expect(rankForLevel(0)).toBe("recruit");
    expect(rankForLevel(-3)).toBe("recruit");
    expect(rankForLevel(1000)).toBe("supreme_commander");
    expect(rankForLevel(NaN)).toBe("recruit");
  });
});

describe("prestige and Legend", () => {
  it("allows prestige only at level 100 with ranks left", () => {
    expect(canPrestige(0, 99)).toBe(false);
    expect(canPrestige(0, 100)).toBe(true);
    expect(canPrestige(9, 100)).toBe(true);
    expect(canPrestige(MAX_PRESTIGE, 100)).toBe(false);
  });

  it("is Legend only at the last prestige and level 100", () => {
    expect(isLegend(MAX_PRESTIGE, 100)).toBe(true);
    expect(isLegend(MAX_PRESTIGE, 99)).toBe(false);
    expect(isLegend(9, 100)).toBe(false);
  });

  it("builds the state the account page shows", () => {
    expect(progressState({ runXp: 0, lifetimeXp: 0, prestige: 0 })).toEqual({
      prestige: 0,
      level: 1,
      xpInLevel: 0,
      xpForNext: 500,
      lifetimeXp: 0,
      legend: false,
      canPrestige: false,
    });
    const top = progressState({
      runXp: MAX_RUN_XP,
      lifetimeXp: 5_000_000,
      prestige: MAX_PRESTIGE,
    });
    expect(top.legend).toBe(true);
    expect(top.canPrestige).toBe(false);
    expect(top.lifetimeXp).toBe(5_000_000);
  });
});

describe("seasons", () => {
  it("is level 1..50 at 2,000 XP a level", () => {
    expect(seasonLevel(0)).toBe(1);
    expect(seasonLevel(1_999)).toBe(1);
    expect(seasonLevel(2_000)).toBe(2);
    expect(seasonLevel(97_999)).toBe(49);
    expect(seasonLevel(98_000)).toBe(SEASON_MAX_LEVEL);
    expect(seasonLevel(10_000_000)).toBe(SEASON_MAX_LEVEL);
    expect(seasonLevel(-1)).toBe(1);
    expect(seasonLevel(NaN)).toBe(1);
    expect(seasonXpForLevel(50)).toBe(98_000);
    expect(seasonXpForLevel(1)).toBe(0);
  });

  it("pays the free track, 2,600 Credits in all, on the levels crossed", () => {
    expect(SEASON_TRACK.reduce((sum, r) => sum + r.credits, 0)).toBe(2_600);
    expect(trackRewardsBetween(0, 7_999)).toEqual([]);
    expect(trackRewardsBetween(0, 8_000).map((r) => r.level)).toEqual([5]);
    expect(trackRewardsBetween(7_999, 98_000).map((r) => r.level)).toEqual([
      5, 10, 15, 20, 25, 30, 35, 40, 45, 50,
    ]);
    expect(trackRewardsBetween(98_000, 200_000)).toEqual([]);
  });
});

describe("milestones and titles", () => {
  it("has the approved milestone levels", () => {
    expect(LEVEL_MILESTONES.map((m) => m.level)).toEqual([
      5, 10, 25, 50, 75, 100,
    ]);
  });

  it("computes titles from facts, including the ones an admin could take away", () => {
    const none = earnedTitles({
      prestige: 0,
      level: 24,
      countedWins: CONQUEROR_WINS - 1,
      seasons: [],
    });
    expect(none).toEqual([]);

    const mid = earnedTitles({
      prestige: 0,
      level: 50,
      countedWins: CONQUEROR_WINS,
      seasons: [{ number: 1, xp: 48_000 }],
    });
    expect(mid).toEqual(["veteran", "elite", "conqueror", "season_veteran:1"]);

    const legend = earnedTitles({
      prestige: MAX_PRESTIGE,
      level: 100,
      countedWins: 0,
      seasons: [{ number: 2, xp: 98_000 }],
    });
    expect(legend).toContain("supreme_commander");
    expect(legend).toContain("prestige:10");
    expect(legend).toContain("legend");
    expect(legend).toContain("season_elite:2");
    expect(legend.filter((t) => t.startsWith("prestige:"))).toHaveLength(10);
  });

  it("counts a prestiged player as having reached level 100", () => {
    const titles = earnedTitles({
      prestige: 1,
      level: 1,
      countedWins: 0,
      seasons: [],
    });
    expect(titles).toEqual([
      "veteran",
      "elite",
      "supreme_commander",
      "prestige:1",
    ]);
  });

  it("only accepts well-formed title ids", () => {
    for (const ok of [
      "veteran",
      "legend",
      "prestige:1",
      "prestige:10",
      "season_veteran:3",
    ]) {
      expect(isTitleId(ok), ok).toBe(true);
    }
    for (const bad of [
      "",
      "Veteran",
      "prestige:0",
      "prestige:11",
      "season_elite:0",
      "season_elite:",
      "admin",
      "<b>x</b>",
      null,
      5,
    ]) {
      expect(isTitleId(bad), String(bad)).toBe(false);
    }
  });
});
