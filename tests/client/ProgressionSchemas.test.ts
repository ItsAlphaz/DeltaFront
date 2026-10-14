import {
  GameXpResponseSchema,
  ProgressionConfigSchema,
  PublicProgressSchema,
  UserMeResponseSchema,
} from "@openfront/shared/ApiSchemas";
import { describe, expect, it } from "vitest";

const progress = {
  prestige: 2,
  level: 37,
  xpInLevel: 120,
  xpForNext: 900,
  lifetimeXp: 123456,
  legend: false,
  canPrestige: false,
};

function userMe(player: Record<string, unknown> = {}) {
  return {
    user: { email: "player@example.com" },
    player: {
      publicId: "abc",
      adfree: false,
      unlimitedRanked: false,
      canCreatePublicLobbies: false,
      achievements: { singleplayerMap: [] },
      friends: [],
      subscription: null,
      ...player,
    },
  };
}

const eligible = {
  gameId: "gABCDEFGHI",
  eligible: true,
  breakdown: {
    leftEarly: false,
    played: 50,
    time: 30,
    placement: 40,
    win: 100,
    firstGame: 0,
    feats: 0,
    subtotal: 220,
    gamePermille: 1250,
    subscriberPermille: 1000,
    total: 275,
  },
  before: { prestige: 0, level: 4, xpInLevel: 300, xpForNext: 400 },
  after: { ...progress, prestige: 0, level: 5, xpInLevel: 175, xpForNext: 450 },
  levelsReached: [{ prestige: 0, level: 5 }],
};

describe("UserMeResponseSchema progress", () => {
  it("parses a response from an API that predates progression", () => {
    const parsed = UserMeResponseSchema.safeParse(userMe());
    expect(parsed.success).toBe(true);
    expect(parsed.data?.player.progress).toBeUndefined();
  });

  it("parses progress when present", () => {
    const parsed = UserMeResponseSchema.parse(userMe({ progress }));
    expect(parsed.player.progress).toEqual(progress);
  });

  it("drops a malformed progress object but still parses the profile", () => {
    const parsed = UserMeResponseSchema.safeParse(
      userMe({ progress: { level: "ten" } }),
    );
    expect(parsed.success).toBe(true);
    expect(parsed.data?.player.progress).toBeUndefined();
    expect(parsed.data?.player.publicId).toBe("abc");
  });

  it("drops a non-object progress value but still parses the profile", () => {
    const parsed = UserMeResponseSchema.safeParse(userMe({ progress: "x" }));
    expect(parsed.success).toBe(true);
    expect(parsed.data?.player.progress).toBeUndefined();
  });
});

describe("GameXpResponseSchema", () => {
  it("parses an eligible result", () => {
    const parsed = GameXpResponseSchema.parse(eligible);
    expect(parsed.eligible).toBe(true);
    if (!parsed.eligible) throw new Error("expected eligible");
    expect(parsed.breakdown.total).toBe(275);
    expect(parsed.levelsReached).toEqual([{ prestige: 0, level: 5 }]);
  });

  it("defaults a missing levelsReached to none", () => {
    const rest: Record<string, unknown> = { ...eligible };
    delete rest.levelsReached;
    const parsed = GameXpResponseSchema.parse(rest);
    if (!parsed.eligible) throw new Error("expected eligible");
    expect(parsed.levelsReached).toEqual([]);
  });

  it("parses every documented ineligible reason", () => {
    for (const reason of [
      "not_spawned",
      "too_short",
      "no_action",
      "custom_settings",
      "too_few_humans",
      "daily_cap",
      "unverified",
    ]) {
      const parsed = GameXpResponseSchema.parse({
        gameId: "g",
        eligible: false,
        reason,
      });
      expect(parsed).toEqual({ gameId: "g", eligible: false, reason });
    }
  });

  it("keeps an unknown ineligible reason instead of failing the parse", () => {
    const parsed = GameXpResponseSchema.safeParse({
      gameId: "g",
      eligible: false,
      reason: "something_new_next_year",
    });
    expect(parsed.success).toBe(true);
  });

  it("reads a breakdown stored under the first XP rules", () => {
    // Rows scored before `played` and `leftEarly` existed lack both.
    const v1: Record<string, unknown> = { ...eligible.breakdown };
    delete v1.played;
    delete v1.leftEarly;
    const parsed = GameXpResponseSchema.parse({ ...eligible, breakdown: v1 });
    if (!parsed.eligible) throw new Error("expected eligible");
    expect(parsed.breakdown).toEqual({
      // the fields later rules added read as "none"
      eliminations: 0,
      eliminationCount: 0,
      firstWin: 0,
      repeatPermille: 1000,
      playerCount: 0,
      capped: false,
      softCapped: false,
      ...eligible.breakdown,
      played: 0,
      leftEarly: false,
    });
  });

  it("rejects an eligible result with no breakdown", () => {
    const parsed = GameXpResponseSchema.safeParse({
      gameId: "g",
      eligible: true,
    });
    expect(parsed.success).toBe(false);
  });
});

describe("public progression schemas", () => {
  it("parses public progress", () => {
    const data = { prestige: 10, level: 100, lifetimeXp: 9e6, legend: true };
    expect(PublicProgressSchema.parse(data)).toEqual(data);
  });

  it("parses the progression config", () => {
    const data = {
      version: 1,
      maxLevel: 100,
      maxPrestige: 10,
      levels: [
        { level: 1, xpToNext: 100, cumulativeXp: 0 },
        { level: 2, xpToNext: 150, cumulativeXp: 100 },
      ],
    };
    // An API from before the rewards: still parses, with no flares.
    expect(ProgressionConfigSchema.parse(data)).toEqual({
      ...data,
      flares: [],
    });
  });

  it("parses the config's rewards: Caps, Plutonium, prestige and flares", () => {
    const data = {
      version: 3,
      formula: 2,
      maxLevel: 100,
      maxPrestige: 10,
      levels: [
        { level: 1, xpToNext: 150, cumulativeXp: 0, caps: 0, plutonium: 0 },
        {
          level: 20,
          xpToNext: 910,
          cumulativeXp: 9000,
          caps: 50,
          plutonium: 25,
        },
      ],
      levelRewards: {
        capsBands: [{ fromLevel: 2, toLevel: 25, caps: 50 }],
        plutonium: { fromLevel: 20, everyLevels: 10, amount: 25 },
      },
      prestige: { caps: 2500 },
      flares: [
        {
          kind: "level",
          level: 50,
          prestige: null,
          flareName: "effect:firebird_trail",
          cosmetic: { type: "effect", name: "firebird_trail", url: null },
        },
        {
          kind: "prestige",
          level: null,
          prestige: 5,
          flareName: "effect:solar_corona",
          cosmetic: { type: "effect", name: "solar_corona", url: null },
        },
        {
          kind: "legend",
          level: null,
          prestige: null,
          flareName: "title:legend",
          cosmetic: null,
        },
      ],
    };
    const parsed = ProgressionConfigSchema.parse(data);
    expect(parsed.prestige).toEqual({ caps: 2500 });
    expect(parsed.levels[1]).toMatchObject({ caps: 50, plutonium: 25 });
    expect(parsed.levelRewards?.plutonium.everyLevels).toBe(10);
    expect(parsed.flares).toEqual(data.flares);
  });

  it("drops a malformed flare or reward block, not the config", () => {
    const parsed = ProgressionConfigSchema.parse({
      version: 3,
      maxLevel: 100,
      maxPrestige: 10,
      levels: [{ level: 1, xpToNext: 150, cumulativeXp: 0, caps: "lots" }],
      levelRewards: { capsBands: "none" },
      prestige: { caps: "2500" },
      flares: [
        { kind: "prestige", prestige: 5 },
        {
          kind: "a-kind-from-the-future",
          level: null,
          prestige: null,
          flareName: "flag:x",
          cosmetic: { type: "flag" },
        },
      ],
    });
    expect(parsed.levels[0].caps).toBeUndefined();
    expect(parsed.levelRewards).toBeUndefined();
    expect(parsed.prestige).toBeUndefined();
    // The unknown kind is kept (nothing matches it); its malformed cosmetic
    // reads as none.
    expect(parsed.flares).toEqual([
      {
        kind: "a-kind-from-the-future",
        level: null,
        prestige: null,
        flareName: "flag:x",
        cosmetic: null,
      },
    ]);
  });

  it("reads flares that aren't a list as none", () => {
    const parsed = ProgressionConfigSchema.parse({
      version: 3,
      maxLevel: 100,
      maxPrestige: 10,
      levels: [],
      flares: { nope: true },
    });
    expect(parsed.flares).toEqual([]);
  });
});

describe("progression response schemas added with seasons and challenges", () => {
  it("parses an old XP result (no challenges, season or flags) and a new one", () => {
    const old = GameXpResponseSchema.parse(eligible);
    if (!old.eligible) throw new Error("expected eligible");
    expect(old.challenges).toBeUndefined();
    expect(old.season).toBeUndefined();
    const next = GameXpResponseSchema.parse({
      ...eligible,
      challenges: [{ id: "d_win_1", period: "daily", xp: 400 }],
      season: { number: 1, name: "Opening", xp: 100, level: 1, added: 100 },
      flags: ["soft_cap"],
    });
    if (!next.eligible) throw new Error("expected eligible");
    expect(next.challenges).toEqual([
      { id: "d_win_1", period: "daily", xp: 400, credits: 0 },
    ]);
    expect(next.season?.name).toBe("Opening");
    expect(next.flags).toEqual(["soft_cap"]);
  });

  it("drops a malformed challenge list instead of failing the whole result", () => {
    const parsed = GameXpResponseSchema.parse({
      ...eligible,
      challenges: "no",
    });
    if (!parsed.eligible) throw new Error("expected eligible");
    expect(parsed.challenges).toBeUndefined();
  });

  it("reads public progress with a rank, a title and a season", () => {
    const parsed = PublicProgressSchema.parse({
      prestige: 1,
      level: 50,
      lifetimeXp: 200_000,
      legend: false,
      rank: "captain",
      title: "veteran",
      season: { number: 2, name: "Winter", level: 7, xp: 12_000 },
    });
    expect(parsed.rank).toBe("captain");
    expect(parsed.season?.level).toBe(7);
    // a response without them still parses
    expect(
      PublicProgressSchema.parse({
        prestige: 0,
        level: 1,
        lifetimeXp: 0,
        legend: false,
      }).season,
    ).toBeUndefined();
  });
});

describe("reduced XP results", () => {
  it("reads the mode and the reason, and an old result without them", () => {
    const reduced = GameXpResponseSchema.parse({
      ...eligible,
      mode: "reduced",
      breakdown: { ...eligible.breakdown, reducedReason: "private_game" },
    });
    if (!reduced.eligible) throw new Error("expected eligible");
    expect(reduced.mode).toBe("reduced");
    expect(reduced.breakdown.reducedReason).toBe("private_game");
    const old = GameXpResponseSchema.parse(eligible);
    if (!old.eligible) throw new Error("expected eligible");
    expect(old.mode).toBeUndefined();
    expect(old.breakdown.reducedReason).toBeUndefined();
    // an unknown mode from a newer API does not fail the result
    const future = GameXpResponseSchema.parse({ ...eligible, mode: "bonus" });
    if (!future.eligible) throw new Error("expected eligible");
    expect(future.mode).toBeUndefined();
  });
});
