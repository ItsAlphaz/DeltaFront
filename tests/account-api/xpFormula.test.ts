// @vitest-environment node
import { describe, expect, it } from "vitest";
import { PROGRESSION } from "../../src/account-api/domain/constants";
import { countedVerdict } from "../../src/account-api/domain/stats";
import {
  adminCommandSenders,
  applySoftCap,
  clientsWhoActed,
  computeMatchXp,
  computeReducedXp,
  placements,
  placementXp,
  playerCountPermille,
  progressionEligibility,
  repeatPermille,
  validEliminations,
  type MatchXpInput,
} from "../../src/account-api/domain/xp";
import { buildRecord } from "./util/games";

const base: MatchXpInput = {
  victory: false,
  place: null,
  humans: 10,
  eliminations: 0,
  eligibleHumans: 10,
  repeatPermille: 1000,
  firstGameAvailable: false,
  firstWinAvailable: false,
  earnedToday: 0,
};
const xp = (over: Partial<MatchXpInput>) =>
  computeMatchXp({ ...base, ...over }).breakdown;

describe("match XP lines", () => {
  it("pays 100 for a completed match and nothing else for a plain finish", () => {
    const b = xp({});
    expect(b).toMatchObject({
      played: 100,
      placement: 0,
      win: 0,
      eliminations: 0,
      firstGame: 0,
      firstWin: 0,
      subtotal: 100,
      total: 100,
    });
  });

  it("pays the highest placement tier only (10 humans: top 1, top 3, top 5)", () => {
    expect(placementXp(1, 10)).toBe(150);
    expect(placementXp(2, 10)).toBe(100);
    expect(placementXp(3, 10)).toBe(100);
    expect(placementXp(4, 10)).toBe(50);
    expect(placementXp(5, 10)).toBe(50);
    expect(placementXp(6, 10)).toBe(0);
    // small games round up: two humans, first place is every tier at once
    expect(placementXp(1, 2)).toBe(150);
    expect(placementXp(2, 2)).toBe(0);
    expect(placementXp(0, 10)).toBe(0);
  });

  it("pays 250 for a victory", () => {
    expect(xp({ victory: true }).win).toBe(250);
    expect(xp({ victory: false }).win).toBe(0);
  });

  it("pays 25 per elimination and counts at most six", () => {
    expect(xp({ eliminations: 2 })).toMatchObject({
      eliminations: 50,
      eliminationCount: 2,
    });
    expect(xp({ eliminations: 6 }).eliminations).toBe(150);
    expect(xp({ eliminations: 40 })).toMatchObject({
      eliminations: 150,
      eliminationCount: 6,
    });
    expect(xp({ eliminations: -3 }).eliminations).toBe(0);
  });

  it("pays the daily first-game and first-win bonuses only when available", () => {
    expect(xp({ firstGameAvailable: true }).firstGame).toBe(100);
    expect(xp({ firstGameAvailable: false }).firstGame).toBe(0);
    // the win bonus needs a win
    expect(xp({ firstWinAvailable: true, victory: false }).firstWin).toBe(0);
    expect(xp({ firstWinAvailable: true, victory: true }).firstWin).toBe(150);
    const r = computeMatchXp({
      ...base,
      victory: true,
      firstGameAvailable: true,
      firstWinAvailable: true,
    });
    expect(r.usedFirstGame).toBe(true);
    expect(r.usedFirstWin).toBe(true);
  });

  it("matches the worked examples: a 700 XP win, and the same win in a 20-human game", () => {
    const win = {
      victory: true,
      place: 1,
      humans: 10,
      eliminations: 2,
      firstWinAvailable: true,
    };
    // 100 + 150 + 250 + 50 + 150 = 700 at 1.0x (9 eligible humans)
    expect(xp({ ...win, eligibleHumans: 9 }).total).toBe(700);
    // 700 x 1.15 = 805
    expect(xp({ ...win, humans: 20, eligibleHumans: 20 }).total).toBe(805);
  });
});

describe("the player-count multiplier", () => {
  it("has every band, on both sides of every edge", () => {
    const expected: Array<[number, number]> = [
      [0, 100],
      [1, 100],
      [2, 100],
      [3, 500],
      [5, 500],
      [6, 1000],
      [15, 1000],
      [16, 1150],
      [30, 1150],
      [31, 1250],
      [150, 1250],
    ];
    for (const [players, permille] of expected) {
      expect(playerCountPermille(players), `${players} players`).toBe(permille);
    }
  });

  it("scales the whole subtotal", () => {
    expect(xp({ eligibleHumans: 2 }).total).toBe(10); // 100 x 0.1
    expect(xp({ eligibleHumans: 4 }).total).toBe(50);
    expect(xp({ eligibleHumans: 40 }).total).toBe(125);
  });

  it("makes a two-player farm worth very little and refuses the daily bonuses", () => {
    const r = computeMatchXp({
      ...base,
      victory: true,
      place: 1,
      humans: 2,
      eliminations: 1,
      eligibleHumans: 2,
      firstGameAvailable: true,
      firstWinAvailable: true,
    });
    // (100 + 150 + 250 + 25) x 0.1 = 52, and no bonus was spent
    expect(r.breakdown.total).toBe(52);
    expect(r.breakdown.firstGame + r.breakdown.firstWin).toBe(0);
    expect(r.usedFirstGame).toBe(false);
    expect(r.usedFirstWin).toBe(false);
    expect(r.flags).toContain("tiny_win");
    expect(r.breakdown.total).toBeLessThanOrEqual(77);
  });

  it("lets a 3-player game use the daily bonuses (0.5x)", () => {
    const r = computeMatchXp({
      ...base,
      eligibleHumans: 3,
      firstGameAvailable: true,
    });
    expect(r.usedFirstGame).toBe(true);
    expect(r.breakdown.total).toBe(100); // (100 + 100) x 0.5
  });
});

describe("repeated opponents", () => {
  it("is 1x for a small group of strangers, and for any large group", () => {
    expect(repeatPermille([])).toBe(1000);
    expect(repeatPermille([0, 1, 2, 4])).toBe(1000);
    expect(repeatPermille(Array(16).fill(20))).toBe(1000);
  });

  it("halves when more than half the others are familiar (5+ shared games)", () => {
    expect(repeatPermille([5, 5, 5, 0, 0])).toBe(500);
    expect(repeatPermille([5, 5, 0, 0])).toBe(1000); // exactly half is not more than half
    expect(repeatPermille([9, 9, 9, 9, 0])).toBe(500);
  });

  it("quarters when more than half are very familiar (10+ shared games)", () => {
    expect(repeatPermille([10, 12, 11, 0])).toBe(250);
    expect(repeatPermille([10, 10, 0, 0])).toBe(1000); // exactly half again
  });

  it("applies to the award and is flagged for review", () => {
    const r = computeMatchXp({ ...base, repeatPermille: 500 });
    expect(r.breakdown.total).toBe(50);
    expect(r.flags).toContain("repeat_group");
  });
});

describe("caps", () => {
  it("never pays more than 1,250 in a match, and flags it", () => {
    // not reachable with the real lines; the cap is a tripwire, so force it
    const r = computeMatchXp({
      ...base,
      victory: true,
      place: 1,
      eliminations: 6,
      eligibleHumans: 40,
      firstGameAvailable: true,
      firstWinAvailable: true,
    });
    // (100 + 150 + 250 + 150 + 100 + 150) x 1.25 = 1125 < cap
    expect(r.breakdown.total).toBe(1125);
    expect(r.breakdown.capped).toBe(false);
    expect(PROGRESSION.matchXpCap).toBe(1250);
  });

  it("pays in full up to 6,000 a day and a quarter above it, splitting the game that crosses", () => {
    expect(applySoftCap(500, 0)).toEqual({ paid: 500, softCapped: false });
    expect(applySoftCap(500, 5_500)).toEqual({ paid: 500, softCapped: false });
    // 200 left in full, the other 300 at 25%
    expect(applySoftCap(500, 5_800)).toEqual({
      paid: 200 + 75,
      softCapped: true,
    });
    expect(applySoftCap(500, 6_000)).toEqual({ paid: 125, softCapped: true });
    expect(applySoftCap(500, 90_000)).toEqual({ paid: 125, softCapped: true });
    // never a hard stop
    expect(applySoftCap(100, 6_000).paid).toBeGreaterThan(0);
  });

  it("reports the soft cap in the breakdown and the flags", () => {
    const r = computeMatchXp({ ...base, earnedToday: 6_000 });
    expect(r.breakdown.softCapped).toBe(true);
    expect(r.breakdown.total).toBe(25);
    expect(r.flags).toContain("soft_cap");
  });
});

describe("reading a game record", () => {
  const ffa = (players: Parameters<typeof buildRecord>[1]["players"]) =>
    buildRecord("gm000001", { players, allAct: true });

  it("orders winner, survivors by land, then the eliminated by how long they lasted", () => {
    const record = ffa([
      { user: null },
      { user: null, stats: { finalTiles: "400" } },
      { user: null, fate: { killedAt: 5000 } },
      { user: null, fate: { killedAt: 3000 } },
      { user: null, fate: "never-spawned" },
    ]);
    const table = placements(record, true);
    expect([...table.placeOf!.values()]).toEqual([1, 2, 3, 4, 5]);
    expect(table.humans).toBe(5);
  });

  it("lets ties share the better place", () => {
    const record = ffa([
      { user: null },
      { user: null, fate: { killedAt: 3000 } },
      { user: null, fate: { killedAt: 3000 } },
      { user: null, fate: { killedAt: 1500 } },
    ]);
    expect([...placements(record, true).placeOf!.values()]).toEqual([
      1, 2, 2, 4,
    ]);
  });

  it("has no placement in team games", () => {
    expect(
      placements(ffa([{ user: null }, { user: null }]), false).placeOf,
    ).toBeNull();
  });

  it("counts only gameplay intents as acting, and finds staff commands", () => {
    const record = buildRecord("gm000002", {
      players: [{ user: null }, { user: null }, { user: null }],
      allAct: false,
      extraIntents: [
        { type: "attack", targetID: null, troops: null, clientID: "pl000001" },
        {
          type: "emoji",
          recipient: "AllPlayers",
          emoji: 1,
          clientID: "pl000002",
        },
        {
          type: "admin_command",
          command: "give_gold",
          target: "pl000003",
          amount: 1,
          clientID: "pl000003",
        },
      ],
    });
    expect([...clientsWhoActed(record.turns)]).toEqual(["pl000001"]);
    expect([...adminCommandSenders(record.turns)]).toEqual(["pl000003"]);
  });

  it("counts an elimination once per victim who lasted two minutes, never a fresh spawn or yourself", () => {
    const record = buildRecord("gm000003", {
      players: [
        {
          user: null,
          stats: {
            kills: [
              { victim: "pl000002", tick: "3000" },
              { victim: "pl000002", tick: "3001" }, // the same victim again
              { victim: "pl000003", tick: "300" }, // lasted 30 seconds
              { victim: "pl000001", tick: "100" }, // yourself
              { victim: "nobody", tick: "4000" }, // not a player of this game
              { victim: "pl000004", tick: "5000" },
            ],
          },
        },
        { user: null, fate: { killedAt: 3000 } },
        { user: null, fate: { killedAt: 300 } },
        { user: null, fate: { killedAt: 5000 } },
      ],
    });
    expect(validEliminations(record, "pl000001")).toBe(2);
    expect(validEliminations(record, "pl000002")).toBe(0);
  });
});

describe("one eligibility rule for the game", () => {
  const facts = {
    source: "server" as const,
    type: "Public",
    rankedType: null,
    durationSeconds: 600,
    accountHolders: 4,
  };

  it("counts a public, long enough game with enough account holders", () => {
    expect(countedVerdict(facts)).toEqual({ counted: true, reason: null });
  });

  it("says why a game does not count", () => {
    expect(countedVerdict({ ...facts, type: "Private" }).reason).toBe(
      "private_game",
    );
    expect(countedVerdict({ ...facts, rankedType: "1v1" }).reason).toBe(
      "ranked",
    );
    expect(countedVerdict({ ...facts, adminModified: true }).reason).toBe(
      "admin_modified",
    );
    expect(countedVerdict({ ...facts, accountHolders: 1 }).reason).toBe(
      "too_few_humans",
    );
    expect(countedVerdict({ ...facts, durationSeconds: 90 }).reason).toBe(
      "too_short",
    );
    expect(countedVerdict({ ...facts, source: "singleplayer" }).reason).toBe(
      "not_server",
    );
  });
});

describe("how far a game advances progression", () => {
  const facts = {
    source: "server" as const,
    type: "Public",
    rankedType: null,
    durationSeconds: 600,
    accountHolders: 4,
  };
  const model = (over: Record<string, unknown>) =>
    progressionEligibility({ ...facts, ...over } as never);

  it("is full for a qualifying public game, and only then", () => {
    expect(model({})).toEqual({ mode: "full", reason: "normal_public" });
  });

  it("is reduced for a public game short of humans, a private one and an unlisted one", () => {
    expect(model({ accountHolders: 1 })).toEqual({
      mode: "reduced",
      reason: "public_too_few_humans",
    });
    expect(model({ type: "Private" })).toEqual({
      mode: "reduced",
      reason: "private_game",
    });
    expect(model({ type: "Private", listed: true })).toEqual({
      mode: "reduced",
      reason: "private_game",
    });
    expect(model({ type: "Private", listed: false })).toEqual({
      mode: "reduced",
      reason: "unlisted_game",
    });
  });

  it("is none for singleplayer, ranked, a staff test, and a game that was too short", () => {
    expect(model({ source: "singleplayer" })).toEqual({
      mode: "none",
      reason: "singleplayer",
    });
    expect(model({ type: "Singleplayer" })).toEqual({
      mode: "none",
      reason: "singleplayer",
    });
    expect(model({ rankedType: "1v1" })).toEqual({
      mode: "none",
      reason: "ranked",
    });
    expect(model({ adminModified: true })).toEqual({
      mode: "none",
      reason: "admin_modified",
    });
    // a staff test is none whatever kind of game it was
    expect(model({ adminModified: true, type: "Private" }).mode).toBe("none");
    expect(model({ durationSeconds: 90 })).toEqual({
      mode: "none",
      reason: "too_short",
    });
    // even a reduced award needs a game that lasted
    expect(model({ type: "Private", durationSeconds: 90 })).toEqual({
      mode: "none",
      reason: "too_short",
    });
    expect(model({ accountHolders: 1, durationSeconds: 90 }).mode).toBe("none");
  });

  it("agrees with the stats rule: full exactly when the game counts", () => {
    for (const type of ["Public", "Private"]) {
      for (const accountHolders of [0, 1, 2, 9]) {
        for (const durationSeconds of [30, 120, 900]) {
          const f = { ...facts, type, accountHolders, durationSeconds };
          expect(progressionEligibility(f).mode === "full").toBe(
            countedVerdict(f).counted,
          );
        }
      }
    }
  });
});

describe("the reduced award", () => {
  const reduced = (eliminations: number, earnedToday = 0) =>
    computeReducedXp({
      reason: "private_game",
      eliminations,
      earnedToday,
    });

  it("is completed match plus eliminations at a quarter, rounded down", () => {
    expect(reduced(0).breakdown.total).toBe(25); // 100 x 0.25
    expect(reduced(1).breakdown.total).toBe(31); // 125 x 0.25 = 31.25
    expect(reduced(2).breakdown.total).toBe(37); // 150 x 0.25 = 37.5
    expect(reduced(6).breakdown.total).toBe(62); // 250 x 0.25
    expect(reduced(40).breakdown.total).toBe(62); // six at most
  });

  it("pays nothing else: no placement, victory, bonus, or player-count factor", () => {
    const r = reduced(1);
    expect(r.breakdown).toMatchObject({
      placement: 0,
      win: 0,
      firstGame: 0,
      firstWin: 0,
      subtotal: 125,
      gamePermille: 250,
      repeatPermille: 1000,
      reducedReason: "private_game",
    });
    expect(r.usedFirstGame).toBe(false);
    expect(r.usedFirstWin).toBe(false);
    expect(r.flags).toContain("reduced");
  });

  it("still meets the daily soft cap", () => {
    expect(reduced(1, 6_000).breakdown.total).toBe(7); // 31 at a quarter
    expect(reduced(1, 6_000).flags).toContain("soft_cap");
  });
});
