import { describe, expect, it, vi } from "vitest";

vi.mock("../../src/client/Cosmetics", () => ({
  translateCosmetic: (prefix: string, name: string) => `${prefix}/${name}`,
}));

import type { LevelTrackEntry } from "@openfront/shared/ApiSchemas";
import {
  LEVEL_MILESTONES,
  WIN_MILESTONES,
} from "@openfront/shared/ProgressionRules";
import {
  centerScrollLeft,
  flareLabel,
  levelPercent,
  levelState,
  nextWinMilestone,
  rewardState,
  trackPercent,
  winMilestones,
} from "../../src/client/ProgressionTrack";

const entry = (over: Partial<LevelTrackEntry> = {}): LevelTrackEntry => ({
  level: 10,
  credits: 500,
  title: null,
  flare: null,
  unlocked: false,
  claimed: false,
  rewardId: null,
  ...over,
});

describe("the state of a level", () => {
  it("is the player's, behind them or ahead", () => {
    expect(levelState(12, 12)).toBe("current");
    expect(levelState(11, 12)).toBe("passed");
    expect(levelState(13, 12)).toBe("locked");
  });
});

describe("the state of a reward", () => {
  it("is locked until the level is reached, whatever else the row says", () => {
    expect(rewardState(entry())).toBe("locked");
    expect(rewardState(entry({ rewardId: "7" }))).toBe("locked");
  });

  it("is ready when reached and the server has a reward to claim", () => {
    expect(rewardState(entry({ unlocked: true, rewardId: "7" }))).toBe("ready");
  });

  it("is claimed once paid, and never ready again", () => {
    expect(rewardState(entry({ unlocked: true, claimed: true }))).toBe(
      "claimed",
    );
    expect(
      rewardState(entry({ unlocked: true, claimed: true, rewardId: "7" })),
    ).toBe("claimed");
  });

  it("is only reached when there is nothing to claim: no button, no claim", () => {
    expect(rewardState(entry({ unlocked: true }))).toBe("reached");
  });
});

describe("where the marker sits on the track", () => {
  const at = (level: number, xpInLevel: number, xpForNext: number) =>
    trackPercent({ level, xpInLevel, xpForNext });

  it("starts empty at level 1 and ends full at level 100", () => {
    expect(at(1, 0, 1000)).toBe(0);
    expect(at(100, 0, 0)).toBe(100);
  });

  it("moves through a level as its XP fills", () => {
    const half = at(1, 500, 1000);
    expect(half).toBeCloseTo(50 / 99, 5);
    expect(at(50, 0, 1000)).toBeCloseTo((49 / 99) * 100, 5);
    expect(at(50, 500, 1000)).toBeGreaterThan(at(50, 0, 1000));
  });

  it("never leaves 0..100 for a surprising value", () => {
    expect(at(0, -5, 10)).toBe(0);
    expect(at(500, 0, 10)).toBe(100);
    expect(at(10, 99999, 10)).toBeLessThanOrEqual(100);
  });

  it("puts the first and last levels at the ends of the strip", () => {
    expect(levelPercent(1)).toBe(0);
    expect(levelPercent(100)).toBe(100);
    expect(levelPercent(50)).toBeCloseTo((49 / 99) * 100, 5);
  });
});

describe("centring the track", () => {
  it("scrolls a node to the middle, and never before the start", () => {
    expect(centerScrollLeft(1000, 100, 500)).toBe(800);
    expect(centerScrollLeft(50, 100, 500)).toBe(0);
  });
});

describe("the win milestones", () => {
  it("are 10, 25, 50, 75 and 100", () => {
    expect(WIN_MILESTONES).toEqual([10, 25, 50, 75, 100]);
  });

  it("are all locked at no wins, with no progress", () => {
    const all = winMilestones(0);
    expect(all.every((m) => !m.achieved && m.progress === 0)).toBe(true);
    expect(nextWinMilestone(0)?.target).toBe(10);
  });

  it("achieve at exactly their target, not before", () => {
    const at = (n: number) =>
      winMilestones(n)
        .filter((m) => m.achieved)
        .map((m) => m.target);
    expect(at(9)).toEqual([]);
    expect(at(10)).toEqual([10]);
    expect(at(74)).toEqual([10, 25, 50]);
    expect(at(100)).toEqual([10, 25, 50, 75, 100]);
    expect(at(5000)).toEqual([10, 25, 50, 75, 100]);
  });

  it("show progress towards each, capped at the target", () => {
    const by = Object.fromEntries(
      winMilestones(30).map((m) => [m.target, m.progress]),
    );
    expect(by).toEqual({ 10: 10, 25: 25, 50: 30, 75: 30, 100: 30 });
    expect(nextWinMilestone(30)?.target).toBe(50);
    expect(nextWinMilestone(100)).toBeNull();
  });

  it("treat a bad count as none", () => {
    expect(winMilestones(Number.NaN).some((m) => m.achieved)).toBe(false);
    expect(winMilestones(-3).some((m) => m.achieved)).toBe(false);
  });
});

describe("the rewards the track shows", () => {
  it("are the milestone levels, and only those", () => {
    expect(LEVEL_MILESTONES.map((m) => m.level)).toEqual([
      5, 10, 25, 50, 75, 100,
    ]);
  });
});

describe("naming a cosmetic", () => {
  it("uses the group its kind belongs to", () => {
    expect(flareLabel("flag:recruit_banner")).toBe("flags/recruit_banner");
    expect(flareLabel("pattern:officer_chevrons:ash")).toBe(
      "territory_patterns.pattern/officer_chevrons",
    );
    expect(flareLabel("effect:colonel_wake")).toBe("effects/colonel_wake");
    expect(flareLabel("crown:laurel")).toBe("crowns/laurel");
  });
});
