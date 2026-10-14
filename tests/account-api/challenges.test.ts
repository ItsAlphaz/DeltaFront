// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  advance,
  challengeById,
  challengesFor,
  DAILY_POOLS,
  dailyKey,
  dailyResetsAt,
  WEEKLY_POOLS,
  weeklyKey,
  weeklyResetsAt,
  weekRange,
  type GameMetrics,
} from "../../src/account-api/domain/challenges";

const none: GameMetrics = {
  games: 0,
  top_half: 0,
  top_quarter: 0,
  wins: 0,
  eliminations: 0,
  survive_seconds: 0,
  structures: 0,
  gold_single_game: 0,
  alliances: 0,
};
const game = (over: Partial<GameMetrics>): GameMetrics => ({
  ...none,
  games: 1,
  ...over,
});

describe("challenge pools", () => {
  it("have three slots each, with unique ids and the right period", () => {
    expect(DAILY_POOLS).toHaveLength(3);
    expect(WEEKLY_POOLS).toHaveLength(3);
    const ids = [...DAILY_POOLS, ...WEEKLY_POOLS].flat().map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const c of DAILY_POOLS.flat()) {
      expect(c.period).toBe("daily");
      expect(c.credits).toBe(0);
    }
    for (const c of WEEKLY_POOLS.flat()) {
      expect(c.period).toBe("weekly");
      expect(c.credits).toBeGreaterThan(0);
    }
    DAILY_POOLS.forEach((pool, slot) =>
      pool.forEach((c) => expect(c.slot).toBe(slot)),
    );
    WEEKLY_POOLS.forEach((pool, slot) =>
      pool.forEach((c) => expect(c.slot).toBe(slot)),
    );
  });

  it("only use metrics that work on every map and mode", () => {
    const metrics = new Set(
      [...DAILY_POOLS, ...WEEKLY_POOLS].flat().map((c) => c.metric),
    );
    expect(metrics).not.toContain("transports");
    expect(metrics).not.toContain("clan_xp");
  });

  it("look up by id", () => {
    expect(challengeById("d_win_1")?.xp).toBe(400);
    expect(challengeById("w_wins_5")?.credits).toBe(150);
    expect(challengeById("nope")).toBeNull();
  });
});

describe("deterministic assignment", () => {
  const user = "11111111-2222-3333-4444-555555555555";

  it("gives the same player the same three challenges every time", () => {
    const a = challengesFor(user, "daily", "d:2026-10-14");
    const b = challengesFor(user, "daily", "d:2026-10-14");
    expect(a.map((c) => c.id)).toEqual(b.map((c) => c.id));
    expect(a).toHaveLength(3);
  });

  it("takes one challenge from each slot, so a period never repeats one", () => {
    for (let i = 0; i < 40; i++) {
      for (const period of ["daily", "weekly"] as const) {
        const key = period === "daily" ? `d:2026-10-${i}` : `w:2026-W${i}`;
        const picked = challengesFor(`u-${i}`, period, key);
        expect(picked.map((c) => c.slot)).toEqual([0, 1, 2]);
        expect(new Set(picked.map((c) => c.id)).size).toBe(3);
      }
    }
  });

  it("varies across players and across periods", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 60; i++) {
      seen.add(
        challengesFor(`user-${i}`, "daily", "d:2026-10-14")
          .map((c) => c.id)
          .join(","),
      );
    }
    expect(seen.size).toBeGreaterThan(5);
    const days = new Set<string>();
    for (let day = 1; day <= 28; day++) {
      days.add(
        challengesFor(
          user,
          "daily",
          `d:2026-10-${String(day).padStart(2, "0")}`,
        )
          .map((c) => c.id)
          .join(","),
      );
    }
    expect(days.size).toBeGreaterThan(3);
  });

  it("reaches every challenge in every pool across enough players", () => {
    const used = new Set<string>();
    for (let i = 0; i < 400; i++) {
      for (const c of challengesFor(`user-${i}`, "daily", "d:2026-10-14"))
        used.add(c.id);
      for (const c of challengesFor(`user-${i}`, "weekly", "w:2026-W42"))
        used.add(c.id);
    }
    const all = [...DAILY_POOLS, ...WEEKLY_POOLS].flat().map((c) => c.id);
    expect([...used].sort()).toEqual(all.sort());
  });
});

describe("periods are UTC", () => {
  it("names the day", () => {
    expect(dailyKey(new Date("2026-10-14T23:59:59.999Z"))).toBe("d:2026-10-14");
    expect(dailyKey(new Date("2026-10-15T00:00:00.000Z"))).toBe("d:2026-10-15");
    expect(dailyKey(new Date("2026-01-05T08:00:00Z"))).toBe("d:2026-01-05");
  });

  it("resets a day at the next UTC midnight", () => {
    expect(dailyResetsAt(new Date("2026-10-14T13:00:00Z")).toISOString()).toBe(
      "2026-10-15T00:00:00.000Z",
    );
    expect(dailyResetsAt(new Date("2026-12-31T23:00:00Z")).toISOString()).toBe(
      "2027-01-01T00:00:00.000Z",
    );
  });

  it("names the ISO week, Monday to Sunday", () => {
    // 2026-10-12 is a Monday
    expect(weeklyKey(new Date("2026-10-11T23:59:59Z"))).toBe("w:2026-W41");
    expect(weeklyKey(new Date("2026-10-12T00:00:00Z"))).toBe("w:2026-W42");
    expect(weeklyKey(new Date("2026-10-18T23:59:59Z"))).toBe("w:2026-W42");
    expect(weeklyKey(new Date("2026-10-19T00:00:00Z"))).toBe("w:2026-W43");
  });

  it("follows ISO rules across a year boundary", () => {
    // 2021-01-03 (Sunday) belongs to the last week of 2020
    expect(weeklyKey(new Date("2021-01-03T12:00:00Z"))).toBe("w:2020-W53");
    expect(weeklyKey(new Date("2021-01-04T00:00:00Z"))).toBe("w:2021-W01");
    // 2024-12-30 (Monday) is already week 1 of 2025
    expect(weeklyKey(new Date("2024-12-30T00:00:00Z"))).toBe("w:2025-W01");
    expect(weeklyKey(new Date("2024-12-29T23:59:59Z"))).toBe("w:2024-W52");
  });

  it("resets a week at the next Monday 00:00 UTC", () => {
    expect(weeklyResetsAt(new Date("2026-10-14T13:00:00Z")).toISOString()).toBe(
      "2026-10-19T00:00:00.000Z",
    );
    expect(weeklyResetsAt(new Date("2026-10-18T23:59:59Z")).toISOString()).toBe(
      "2026-10-19T00:00:00.000Z",
    );
    expect(weeklyResetsAt(new Date("2026-10-19T00:00:00Z")).toISOString()).toBe(
      "2026-10-26T00:00:00.000Z",
    );
  });

  it("turns a week key back into its range, and agrees with the key", () => {
    const range = weekRange("w:2026-W42");
    expect(range?.from.toISOString()).toBe("2026-10-12T00:00:00.000Z");
    expect(range?.to.toISOString()).toBe("2026-10-19T00:00:00.000Z");
    expect(weekRange("w:2025-W01")?.from.toISOString()).toBe(
      "2024-12-30T00:00:00.000Z",
    );
    expect(weekRange("nonsense")).toBeNull();
    for (const iso of [
      "2020-12-28",
      "2021-01-03",
      "2024-12-30",
      "2026-10-14",
      "2027-01-03",
    ]) {
      const at = new Date(`${iso}T10:00:00Z`);
      const r = weekRange(weeklyKey(at))!;
      expect(at >= r.from && at < r.to, iso).toBe(true);
    }
  });
});

describe("progress", () => {
  const def = (id: string) => challengeById(id)!;

  it("adds up totals and caps at the target", () => {
    const games2 = def("d_games_2");
    expect(advance(games2, 0, game({}), 0)).toBe(1);
    expect(advance(games2, 1, game({}), 0)).toBe(2);
    expect(advance(games2, 2, game({}), 0)).toBe(2);
  });

  it("keeps the best single value for 'in one game' challenges", () => {
    const survive = def("d_survive_15m");
    expect(advance(survive, 0, game({ survive_seconds: 600 }), 0)).toBe(600);
    expect(advance(survive, 600, game({ survive_seconds: 300 }), 0)).toBe(600);
    expect(advance(survive, 600, game({ survive_seconds: 5000 }), 0)).toBe(900);
    const gold = def("d_gold_500k");
    expect(advance(gold, 0, game({ gold_single_game: 120_000 }), 0)).toBe(
      120_000,
    );
  });

  it("counts the events the metric names", () => {
    expect(advance(def("d_win_1"), 0, game({ wins: 1 }), 0)).toBe(1);
    expect(advance(def("d_win_1"), 0, game({ wins: 0 }), 0)).toBe(0);
    expect(advance(def("d_elim_1"), 0, game({ eliminations: 3 }), 0)).toBe(1);
    expect(advance(def("w_elim_10"), 4, game({ eliminations: 3 }), 0)).toBe(7);
    expect(advance(def("d_build_10"), 4, game({ structures: 9 }), 0)).toBe(10);
    expect(advance(def("w_alliances_10"), 0, game({ alliances: 2 }), 0)).toBe(
      2,
    );
    expect(advance(def("d_top_half_2"), 0, game({ top_half: 1 }), 0)).toBe(1);
  });

  it("reads distinct maps from the stored games, never going down", () => {
    const maps = def("w_maps_5");
    expect(advance(maps, 0, game({}), 3)).toBe(3);
    expect(advance(maps, 4, game({}), 3)).toBe(4);
    expect(advance(maps, 4, game({}), 9)).toBe(5);
  });
});
