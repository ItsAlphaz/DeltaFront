import { describe, expect, it } from "vitest";
import {
  ANNOUNCE_WINDOW_TICKS,
  crisisLevel,
  crossedThreshold,
  formatCountdown,
  remainingFraction,
  secondsLeft,
  shouldAnnounce,
} from "../../../src/client/capital/CrisisClock";

describe("CrisisClock", () => {
  describe("secondsLeft", () => {
    it("counts whole seconds from the match's ticks, rounding up", () => {
      expect(secondsLeft(1_800, 0)).toBe(180);
      expect(secondsLeft(1_800, 1)).toBe(180); // 179.9 s still reads 180
      expect(secondsLeft(1_800, 10)).toBe(179);
      expect(secondsLeft(1_800, 1_799)).toBe(1);
      expect(secondsLeft(1_800, 1_800)).toBe(0);
    });
    it("is never negative, and 0 for no crisis", () => {
      expect(secondsLeft(1_800, 5_000)).toBe(0);
      expect(secondsLeft(-1, 100)).toBe(0);
    });
    it("shows the configured length, not an example", () => {
      expect(secondsLeft(3_000, 0)).toBe(300); // the five-minute crisis
      expect(secondsLeft(1_800, 0)).toBe(180); // the three-minute one
    });
  });

  describe("formatCountdown", () => {
    it.each([
      [180, "03:00"],
      [300, "05:00"],
      [61, "01:01"],
      [60, "01:00"],
      [59, "00:59"],
      [10, "00:10"],
      [0, "00:00"],
      [-4, "00:00"],
    ])("%i s is %s", (seconds, text) => {
      expect(formatCountdown(seconds)).toBe(text);
    });
  });

  describe("remainingFraction", () => {
    it("is 1 at the start, falls evenly and is 0 at the end", () => {
      expect(remainingFraction(100, 1_900, 100)).toBe(1);
      expect(remainingFraction(100, 1_900, 1_000)).toBeCloseTo(0.5);
      expect(remainingFraction(100, 1_900, 1_900)).toBe(0);
    });
    it("stays inside 0..1 and is 0 without a crisis", () => {
      expect(remainingFraction(100, 1_900, 50)).toBe(1);
      expect(remainingFraction(100, 1_900, 9_000)).toBe(0);
      expect(remainingFraction(-1, -1, 5)).toBe(0);
    });
  });

  describe("crisisLevel", () => {
    it("steps up as time runs out", () => {
      expect(crisisLevel(180, false)).toBe("running");
      expect(crisisLevel(61, false)).toBe("running");
      expect(crisisLevel(60, false)).toBe("warning");
      expect(crisisLevel(11, false)).toBe("warning");
      expect(crisisLevel(10, false)).toBe("urgent");
      expect(crisisLevel(1, false)).toBe("urgent");
    });
    it("is over once the crisis is", () => {
      expect(crisisLevel(0, true)).toBe("over");
    });
  });

  describe("shouldAnnounce", () => {
    it("announces a crisis that has just begun, live", () => {
      expect(
        shouldAnnounce({ catchingUp: false, startTick: 500, nowTick: 500 }),
      ).toBe(true);
      expect(
        shouldAnnounce({
          catchingUp: false,
          startTick: 500,
          nowTick: 500 + ANNOUNCE_WINDOW_TICKS,
        }),
      ).toBe(true);
    });
    it("does not announce an old one, as when a client rejoins mid-crisis", () => {
      expect(
        shouldAnnounce({
          catchingUp: false,
          startTick: 500,
          nowTick: 500 + ANNOUNCE_WINDOW_TICKS + 1,
        }),
      ).toBe(false);
    });
    it("never announces while the game is catching up", () => {
      expect(
        shouldAnnounce({ catchingUp: true, startTick: 500, nowTick: 500 }),
      ).toBe(false);
    });
    it("does not announce a crisis from the future", () => {
      expect(
        shouldAnnounce({ catchingUp: false, startTick: 900, nowTick: 500 }),
      ).toBe(false);
    });
  });

  describe("crossedThreshold", () => {
    it("fires once on the way down past 60 and past 10", () => {
      expect(crossedThreshold(61, 60)).toBe("warn");
      expect(crossedThreshold(60, 59)).toBeNull();
      expect(crossedThreshold(11, 10)).toBe("urgent");
      expect(crossedThreshold(10, 9)).toBeNull();
    });
    it("never fires on the first reading (a rejoining client)", () => {
      expect(crossedThreshold(null, 30)).toBeNull();
      expect(crossedThreshold(null, 5)).toBeNull();
    });
    it("reports the later threshold when a jump crosses both", () => {
      expect(crossedThreshold(90, 5)).toBe("urgent");
    });
    it("does not fire when time goes up or stays above", () => {
      expect(crossedThreshold(100, 90)).toBeNull();
      expect(crossedThreshold(30, 100)).toBeNull();
    });
  });
});
