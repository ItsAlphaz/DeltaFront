// @vitest-environment node
import { Difficulty } from "@openfront/engine-api/game/GameTypes";
import { PartialGameRecordSchema } from "@openfront/shared/WireSchemas";
import { describe, expect, it } from "vitest";
import {
  PERMILLE,
  PROGRESSION,
  SOLO,
} from "../../src/account-api/domain/constants";
import {
  computeSoloXp,
  difficultyAboveMedium,
  SOLO_CRITERIA,
  soloCriteria,
  soloMultiplier,
  type SoloSetup,
} from "../../src/account-api/domain/solo";
import {
  judgeSoloReplay,
  soloGameStart,
  soloProblem,
} from "../../src/account-api/domain/soloVerify";
import { progressionEligibility } from "../../src/account-api/domain/xp";
import { replayed, SOLO_CLIENT, soloRecord } from "./util/solo";

// The rules of solo XP, with no database: the setup multiplier, the award
// built on it, the eligibility of a solo game, and what a replay has to show
// before a match is believed.

/** A setup that meets every criterion. */
const FULL: SoloSetup = {
  tribes: 40,
  nations: 40,
  instantBuild: false,
  infiniteGold: false,
  infiniteTroops: false,
  difficulty: Difficulty.Hard,
};
const permille = (over: Partial<SoloSetup>) =>
  soloMultiplier({ ...FULL, ...over }).permille;
const failedKeys = (over: Partial<SoloSetup>) =>
  soloCriteria({ ...FULL, ...over })
    .filter((c) => !c.met)
    .map((c) => c.key);

describe("the solo multiplier: all six criteria met", () => {
  it("is 1.00x for more than 30 tribes and nations, no cheats, above Medium", () => {
    const m = soloMultiplier(FULL);
    expect(m.permille).toBe(1000);
    expect(m.failed).toBe(0);
    expect(m.criteria.map((c) => c.key)).toEqual([...SOLO_CRITERIA]);
    expect(m.criteria.every((c) => c.met)).toBe(true);
  });

  it("any difficulty above Medium is enough: Hard and Impossible", () => {
    expect(permille({ difficulty: Difficulty.Hard })).toBe(1000);
    expect(permille({ difficulty: Difficulty.Impossible })).toBe(1000);
  });
});

describe("the solo multiplier: each criterion on its own costs 0.20", () => {
  it("exactly 30 tribes fails: it must be MORE than 30", () => {
    expect(permille({ tribes: 30 })).toBe(800);
    expect(failedKeys({ tribes: 30 })).toEqual(["tribes"]);
    expect(permille({ tribes: 31 })).toBe(1000);
    expect(permille({ tribes: 0 })).toBe(800);
  });

  it("exactly 30 nations fails", () => {
    expect(permille({ nations: 30 })).toBe(800);
    expect(failedKeys({ nations: 30 })).toEqual(["nations"]);
    expect(permille({ nations: 31 })).toBe(1000);
  });

  it("instant build fails", () => {
    expect(permille({ instantBuild: true })).toBe(800);
    expect(failedKeys({ instantBuild: true })).toEqual(["instant_build"]);
  });

  it("infinite gold fails", () => {
    expect(permille({ infiniteGold: true })).toBe(800);
    expect(failedKeys({ infiniteGold: true })).toEqual(["infinite_gold"]);
  });

  it("infinite troops fails", () => {
    expect(permille({ infiniteTroops: true })).toBe(800);
    expect(failedKeys({ infiniteTroops: true })).toEqual(["infinite_troops"]);
  });

  it("Medium fails: it must be ABOVE Medium", () => {
    expect(permille({ difficulty: Difficulty.Medium })).toBe(800);
    expect(failedKeys({ difficulty: Difficulty.Medium })).toEqual([
      "difficulty",
    ]);
  });

  it("below Medium fails too", () => {
    expect(permille({ difficulty: Difficulty.Easy })).toBe(800);
    expect(failedKeys({ difficulty: Difficulty.Easy })).toEqual(["difficulty"]);
  });

  it("a difficulty the game does not have is not above Medium", () => {
    expect(difficultyAboveMedium("Nightmare")).toBe(false);
    expect(difficultyAboveMedium("")).toBe(false);
    expect(permille({ difficulty: "hard" })).toBe(800); // not the engine's value
  });
});

describe("the solo multiplier: failures stack, never to zero", () => {
  const miss = (n: number): Partial<SoloSetup> => {
    const all: Partial<SoloSetup> = {
      tribes: 30,
      nations: 30,
      instantBuild: true,
      infiniteGold: true,
      infiniteTroops: true,
      difficulty: Difficulty.Easy,
    };
    // the first n of the six, in the order the criteria are listed
    const order = [
      "tribes",
      "nations",
      "instantBuild",
      "infiniteGold",
      "infiniteTroops",
      "difficulty",
    ] as const;
    return Object.fromEntries(order.slice(0, n).map((k) => [k, all[k]]));
  };

  it("one missed is 0.80x, two 0.60x, three 0.40x, four 0.20x", () => {
    expect([1, 2, 3, 4].map((n) => permille(miss(n)))).toEqual([
      800, 600, 400, 200,
    ]);
    expect(
      [1, 2, 3, 4].map((n) => soloMultiplier({ ...FULL, ...miss(n) }).failed),
    ).toEqual([1, 2, 3, 4]);
  });

  it("five or six missed is the 0.10x floor, not 0 or less", () => {
    expect(permille(miss(5))).toBe(SOLO.floorPermille);
    expect(permille(miss(6))).toBe(SOLO.floorPermille);
    expect(SOLO.floorPermille).toBe(100);
    expect(soloMultiplier({ ...FULL, ...miss(6) }).failed).toBe(6);
  });

  it("the worked examples", () => {
    // A: 40 tribes, 40 nations, no cheats, Hard
    expect(permille({})).toBe(1000);
    // B: 25 tribes
    expect(permille({ tribes: 25 })).toBe(800);
    // C: 25 tribes, 20 nations, infinite gold, Medium
    expect(
      permille({
        tribes: 25,
        nations: 20,
        infiniteGold: true,
        difficulty: Difficulty.Medium,
      }),
    ).toBe(200);
    // D: fails every condition: raw -0.20, clamped
    expect(permille(miss(6))).toBe(100);
  });

  it("is a whole number of permille, so the arithmetic is exact", () => {
    for (let n = 0; n <= 6; n++) {
      expect(Number.isInteger(permille(miss(n)))).toBe(true);
    }
    expect(SOLO.penaltyPermille).toBe(200);
  });
});

describe("the award: the normal lines times the setup multiplier", () => {
  const xp = (over: Partial<Parameters<typeof computeSoloXp>[0]> = {}) =>
    computeSoloXp({
      outcome: "victory",
      short: false,
      setup: FULL,
      earnedToday: 0,
      ...over,
    });

  it("a win at 1.00x is a completed match plus the victory", () => {
    const r = xp();
    expect(r.breakdown).toMatchObject({
      played: PROGRESSION.completedMatch,
      win: PROGRESSION.victory,
      subtotal: 350,
      soloPermille: 1000,
      total: 350,
    });
    expect(r.flags).toEqual(["solo"]);
  });

  it("the worked example: 100 + 250, one criterion missed (0.80x), is 280", () => {
    const r = xp({ setup: { ...FULL, difficulty: Difficulty.Medium } });
    expect(r.breakdown.subtotal).toBe(350);
    expect(r.breakdown.soloPermille).toBe(800);
    expect(r.breakdown.total).toBe(280);
    expect(
      r.breakdown.solo.criteria.find((c) => c.key === "difficulty")?.met,
    ).toBe(false);
  });

  it("a fully failed setup still pays: 350 x 0.10 = 35", () => {
    const r = xp({
      setup: {
        tribes: 0,
        nations: 0,
        instantBuild: true,
        infiniteGold: true,
        infiniteTroops: true,
        difficulty: Difficulty.Easy,
      },
    });
    expect(r.breakdown.soloPermille).toBe(100);
    expect(r.breakdown.total).toBe(35);
    expect(r.flags).toContain("solo_floor");
  });

  it("a match decided against a player still in it pays the completed match only", () => {
    const r = xp({ outcome: "defeat" });
    expect(r.breakdown).toMatchObject({ win: 0, subtotal: 100, total: 100 });
    expect(r.breakdown.reducedReason).toBeUndefined();
  });

  it("an elimination is reduced like a multiplayer death: a quarter of the completed match, no victory", () => {
    const r = xp({ outcome: "eliminated" });
    expect(r.breakdown).toMatchObject({
      win: 0,
      subtotal: 100,
      gamePermille: PROGRESSION.reducedPermille,
      reducedReason: "eliminated",
      total: 25,
    });
    expect(r.flags).toEqual(["solo", "reduced"]);
    // and the setup multiplier scales it: 100 x 0.25 x 0.80 = 20
    expect(
      xp({
        outcome: "eliminated",
        setup: { ...FULL, tribes: 10 },
      }).breakdown.total,
    ).toBe(20);
  });

  it("a short match is reduced, not nothing: even a win loses its victory line", () => {
    const r = xp({ short: true });
    expect(r.breakdown).toMatchObject({
      win: 0,
      subtotal: 100,
      reducedReason: "short_game",
      total: 25,
    });
    // a short elimination is a short game (the game's own reason wins)
    expect(
      xp({ short: true, outcome: "eliminated" }).breakdown.reducedReason,
    ).toBe("short_game");
    expect(r.breakdown.total).toBeGreaterThan(0);
  });

  it("has no placement, elimination XP, first-game or first-win bonus, player-count or repeat factor", () => {
    const b = xp().breakdown;
    expect(b).toMatchObject({
      placement: 0,
      eliminations: 0,
      eliminationCount: 0,
      firstGame: 0,
      firstWin: 0,
      playerCount: 0,
      repeatPermille: PERMILLE,
    });
  });

  it("is cut by the per-match cap and the daily soft cap, like every other award", () => {
    // the daily soft cap: over 6,000 a day is paid at a quarter
    const softly = xp({ earnedToday: PROGRESSION.dailySoftCap });
    expect(softly.breakdown.softCapped).toBe(true);
    expect(softly.breakdown.total).toBe(Math.floor(350 / 4));
    expect(softly.flags).toContain("soft_cap");
    // never above the per-match cap
    expect(xp().breakdown.total).toBeLessThanOrEqual(PROGRESSION.matchXpCap);
  });

  it("rounds down to whole XP", () => {
    // 100 x 0.25 x 0.60 = 15; 100 x 0.25 x 0.10 = 2.5 -> 2
    expect(
      xp({
        outcome: "eliminated",
        setup: { ...FULL, tribes: 1, nations: 1 },
      }).breakdown.total,
    ).toBe(Math.floor((100 * 250 * 600) / 1_000_000));
    expect(
      xp({
        outcome: "eliminated",
        setup: {
          tribes: 1,
          nations: 1,
          instantBuild: true,
          infiniteGold: true,
          infiniteTroops: true,
          difficulty: Difficulty.Easy,
        },
      }).breakdown.total,
    ).toBe(2);
  });
});

describe("a solo game's eligibility", () => {
  const facts = {
    type: "Singleplayer",
    rankedType: null,
    durationSeconds: 600,
    accountHolders: 1,
  };

  it("is 'solo' for a game that came through the solo intake", () => {
    expect(
      progressionEligibility({ ...facts, source: "singleplayer" }),
    ).toEqual({
      mode: "solo",
      reason: "solo",
    });
  });

  it("is never paid when it comes from anywhere else: a game server does not submit a singleplayer game", () => {
    expect(progressionEligibility({ ...facts, source: "server" })).toEqual({
      mode: "none",
      reason: "singleplayer",
    });
  });

  it("leaves the multiplayer rules as they were", () => {
    const pub = {
      source: "server" as const,
      type: "Public",
      rankedType: null,
      durationSeconds: 600,
      accountHolders: 6,
    };
    expect(progressionEligibility(pub).mode).toBe("full");
    expect(progressionEligibility({ ...pub, accountHolders: 1 }).mode).toBe(
      "reduced",
    );
    expect(progressionEligibility({ ...pub, durationSeconds: 30 }).mode).toBe(
      "reduced",
    );
    expect(progressionEligibility({ ...pub, type: "Private" }).mode).toBe(
      "reduced",
    );
    expect(progressionEligibility({ ...pub, rankedType: "1v1" }).mode).toBe(
      "none",
    );
  });
});

describe("what a submitted record must be before any replay is spent on it", () => {
  const problem = (spec: Parameters<typeof soloRecord>[0]) =>
    soloProblem(PartialGameRecordSchema.parse(soloRecord(spec)));

  it("accepts a solo record", () => {
    expect(problem({})).toBeNull();
  });

  it("is a singleplayer game of one player, never a multiplayer or ranked one", () => {
    expect(problem({ claims: { gameType: "Public" } })).toBe("not_solo");
    expect(problem({ claims: { gameType: "Private" } })).toBe("not_solo");
    expect(problem({ players: 2 })).toBe("not_solo");
  });

  it("has an eight-character id, so it cannot name a multiplayer game", () => {
    expect(problem({ gameID: "abCD1234ef" })).toBe("malformed");
    expect(problem({ gameID: "abCD1234" })).toBeNull();
  });

  it("is not longer than a replay is willing to run", () => {
    expect(problem({ turns: SOLO.maxTurns + 1 })).toBe("too_long");
    expect(problem({ turns: SOLO.maxTurns })).toBeNull();
  });

  it("carries only what a player can send: no staff command, kick, host or server intent", () => {
    for (const intent of [
      { type: "admin_command", command: "force_win", target: SOLO_CLIENT },
      { type: "kick_player", targetClientID: SOLO_CLIENT },
      { type: "update_game_config", config: { infiniteGold: true } },
      { type: "toggle_game_start_timer" },
      { type: "mark_disconnected", isDisconnected: true },
    ]) {
      expect(
        problem({ extraIntents: [{ ...intent, clientID: SOLO_CLIENT }] }),
        String((intent as { type: string }).type),
      ).toBe("forbidden_intent");
    }
    // pausing and every action of play are fine
    expect(
      problem({
        extraIntents: [
          { type: "toggle_pause", paused: true, clientID: SOLO_CLIENT },
        ],
      }),
    ).toBeNull();
  });

  it("has every intent from its own player", () => {
    expect(
      problem({
        extraIntents: [
          {
            type: "emoji",
            recipient: "AllPlayers",
            emoji: 0,
            clientID: "other001",
          },
        ],
      }),
    ).toBe("forbidden_intent");
  });
});

describe("the replay's start info", () => {
  it("is the record's own config and player, with nothing the browser could tilt it by", () => {
    const record = PartialGameRecordSchema.parse(
      soloRecord({ claims: { bots: 7 } }),
    );
    const start = soloGameStart(record);
    expect(start.gameID).toBe(record.info.gameID);
    expect(start.config.bots).toBe(7);
    expect(start.players).toEqual([
      { clientID: SOLO_CLIENT, username: "Solo1", clanTag: null },
    ]);
    expect(start.tribes).toBeUndefined();
  });
});

describe("what a replay must show before a match is believed", () => {
  const record = PartialGameRecordSchema.parse(soloRecord());
  const judge = (over: Parameters<typeof replayed>[0] = {}) =>
    judgeSoloReplay(record, replayed(over));

  it("believes a replay that reproduces the recorded hashes and ends in a win", () => {
    const v = judge();
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.verified.outcome).toBe("victory");
    expect(v.verified.short).toBe(false);
    expect(v.verified.setup).toEqual({
      tribes: 40,
      nations: 40,
      instantBuild: false,
      infiniteGold: false,
      infiniteTroops: false,
      difficulty: "Hard",
    });
  });

  it("refuses a record whose hashes the replay did not reproduce", () => {
    expect(judge({ hashes: { checked: 5, mismatched: 1 } })).toEqual({
      ok: false,
      reason: "desync",
    });
  });

  it("refuses a record with nothing to compare: a game too short to carry a hash proves nothing", () => {
    expect(judge({ hashes: { checked: 0, mismatched: 0 } })).toEqual({
      ok: false,
      reason: "no_proof",
    });
  });

  it("refuses a player who never spawned, or who the replay does not know", () => {
    expect(
      judge({
        humans: [{ clientID: SOLO_CLIENT, spawned: false, alive: false }],
      }),
    ).toEqual({ ok: false, reason: "not_spawned" });
    expect(judge({ humans: [] })).toEqual({ ok: false, reason: "not_spawned" });
  });

  it("refuses a player who never acted", () => {
    const idle = PartialGameRecordSchema.parse(soloRecord({ idle: true }));
    expect(judgeSoloReplay(idle, replayed())).toEqual({
      ok: false,
      reason: "no_action",
    });
  });

  it("only counts what was played before the result", () => {
    // the one attack is on turn 1; a replay that stopped at tick 1 never reached it
    expect(judge({ ticks: 1, tick: 1 })).toEqual({
      ok: false,
      reason: "no_action",
    });
  });

  it("an alive player with no result left the match unfinished: nothing", () => {
    expect(judge({ winner: undefined, tick: null })).toEqual({
      ok: false,
      reason: "no_result",
    });
  });

  it("a player still in a match someone else won is a defeat, with the match completed", () => {
    const v = judge({ winner: ["nation", "Rome"] });
    expect(v.ok && v.verified.outcome).toBe("defeat");
  });

  it("a player who lost every tile is eliminated, whether or not the match went on", () => {
    const humans = [{ clientID: SOLO_CLIENT, spawned: true, alive: false }];
    expect(
      (
        judge({ humans, winner: undefined, tick: null }) as {
          verified: { outcome: string };
        }
      ).verified.outcome,
    ).toBe("eliminated");
    expect(
      (
        judge({ humans, winner: ["nation", "Rome"] }) as {
          verified: { outcome: string };
        }
      ).verified.outcome,
    ).toBe("eliminated");
  });

  it("a match under two minutes of game time is short", () => {
    const v = judge({ ticks: 1199, tick: 1199 });
    // (the record's only action is at turn 1, inside the played part)
    expect(v.ok && v.verified.short).toBe(true);
    expect(
      (judge({ ticks: 1200, tick: 1200 }) as { verified: { short: boolean } })
        .verified.short,
    ).toBe(false);
  });
});

describe("the browser's word about the setup is never used", () => {
  // The record claims the best setup (400 tribes, 400 nations, Impossible, no
  // cheats); the replay found the worst. The award follows the replay.
  const record = PartialGameRecordSchema.parse(
    soloRecord({
      claims: {
        bots: 400,
        nations: 400,
        difficulty: "Impossible",
        infiniteGold: false,
        infiniteTroops: false,
        instantBuild: false,
      },
    }),
  );

  it("the tribe and nation counts, the difficulty and the cheat switches come from the replay", () => {
    const v = judgeSoloReplay(
      record,
      replayed({
        tribes: 3,
        nations: 0,
        difficulty: "Easy",
        cheats: {
          instantBuild: true,
          infiniteGold: true,
          infiniteTroops: true,
        },
      }),
    );
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.verified.setup).toEqual({
      tribes: 3,
      nations: 0,
      instantBuild: true,
      infiniteGold: true,
      infiniteTroops: true,
      difficulty: "Easy",
    });
    expect(soloMultiplier(v.verified.setup).permille).toBe(SOLO.floorPermille);
  });

  it("and the winner comes from the replay: a record that says the player won does not make it so", () => {
    const claimed = PartialGameRecordSchema.parse(
      soloRecord({ winner: ["player", SOLO_CLIENT] }),
    );
    const v = judgeSoloReplay(
      claimed,
      replayed({ winner: ["nation", "Rome"] }),
    );
    expect(v.ok && v.verified.outcome).toBe("defeat");
  });
});
