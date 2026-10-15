// @vitest-environment node
import { PlayerStatsTreeSchema } from "@openfront/shared/ApiSchemas";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ACCOUNT_RULES, ECONOMY } from "../../src/account-api/domain/constants";
import { clampToCap, gameReward } from "../../src/account-api/domain/economy";
import { recordProblem } from "../../src/account-api/domain/ingest";
import {
  buildRecentTree,
  buildStatsTree,
  countsForStats,
  isCompleted,
  modeBucket,
  RESULT_GRACE_TURNS,
  resultFor,
  statsToJson,
  sumPlayerStats,
  winnerClientIds,
  type CountedFacts,
} from "../../src/account-api/domain/stats";
import {
  checkUsernameBase,
  displayUsername,
} from "../../src/account-api/domain/usernames";
import {
  buildRecord,
  clientIdOf,
  type GameSpec,
  type PlayerSpec,
} from "./util/games";

const account = (n: number): PlayerSpec => ({
  user: { id: `00000000-0000-4000-8000-00000000000${n}` } as never,
});

/** Whether player 0 (or `who`) completed a game built from `spec`. */
function completed(spec: Partial<GameSpec>, who = 0, counted = true): boolean {
  const record = buildRecord("abCD1234", {
    players: [account(1), account(2)],
    ...spec,
  });
  return isCompleted(record, clientIdOf(who), counted);
}

const facts = (over: Partial<CountedFacts> = {}): CountedFacts => ({
  source: "server",
  type: "Public",
  rankedType: null,
  durationSeconds: 600,
  accountHolders: 2,
  ...over,
});

describe("winners and results", () => {
  it("reads the winning side of every winner shape", () => {
    expect([...winnerClientIds(["player", "pl000001"])]).toEqual(["pl000001"]);
    expect([
      ...winnerClientIds(["team", "Red", "pl000001", "pl000002"]),
    ]).toEqual(["pl000001", "pl000002"]);
    expect([...winnerClientIds(["nation", "Rome", "pl000003"])]).toEqual([
      "pl000003",
    ]);
    expect(winnerClientIds(undefined).size).toBe(0);
  });

  it("victory, defeat, and incomplete when nobody won", () => {
    expect(resultFor("pl000001", ["player", "pl000001"])).toBe("victory");
    expect(resultFor("pl000002", ["player", "pl000001"])).toBe("defeat");
    expect(resultFor("pl000002", ["team", "Red", "pl000001", "pl000002"])).toBe(
      "victory",
    );
    // the team's name is not a player
    expect(resultFor("Red", ["team", "Red", "pl000001"])).toBe("defeat");
    expect(resultFor("pl000001", ["nation", "Rome"])).toBe("defeat");
    expect(resultFor("pl000001", undefined)).toBe("incomplete");
  });
});

describe("which games count for stats", () => {
  it("a public game from a server with two account holders and at least two minutes", () => {
    expect(countsForStats(facts())).toBe(true);
    expect(countsForStats(facts({ durationSeconds: 120 }))).toBe(true);
  });

  it.each([
    ["a private game", { type: "Private" }],
    ["a singleplayer game", { type: "Singleplayer" }],
    ["a client-archived game", { source: "singleplayer" }],
    ["one account holder", { accountHolders: 1 }],
    ["no account holders", { accountHolders: 0 }],
    ["119 seconds", { durationSeconds: 119 }],
    ["a ranked game (no ranked bucket yet)", { rankedType: "1v1" }],
    ["an unknown game type", { type: undefined }],
  ] as Array<[string, Partial<CountedFacts>]>)("%s does not", (_name, over) => {
    expect(countsForStats(facts(over))).toBe(false);
  });
});

describe("the completed-game rule", () => {
  it("a survivor connected at the end completed it", () => {
    expect(completed({})).toBe(true);
  });

  it("a player eliminated after two minutes, still connected, completed it", () => {
    expect(
      completed(
        { players: [account(1), { ...account(2), fate: { killedAt: 3000 } }] },
        1,
      ),
    ).toBe(true);
  });

  it("the elimination tick is the boundary: 1,199 is too early, 1,200 counts", () => {
    const at = (killedAt: number) =>
      completed(
        { players: [account(1), { ...account(2), fate: { killedAt } }] },
        1,
      );
    expect(ECONOMY.minEliminationTick).toBe(1200);
    expect(at(ECONOMY.minEliminationTick - 1)).toBe(false);
    expect(at(ECONOMY.minEliminationTick)).toBe(true);
    expect(at(0)).toBe(false);
  });

  it("a player eliminated in the first two minutes did not", () => {
    expect(
      completed(
        { players: [account(1), { ...account(2), fate: { killedAt: 600 } }] },
        1,
      ),
    ).toBe(false);
  });

  it("a game that is not counted completes nothing", () => {
    expect(completed({}, 0, false)).toBe(false);
  });

  it("a game with no winner completes nothing, even for a survivor", () => {
    expect(completed({ winner: null })).toBe(false);
  });

  it("a player who never spawned (no land, not eliminated) did not", () => {
    expect(
      completed(
        { players: [account(1), { ...account(2), fate: "never-spawned" }] },
        1,
      ),
    ).toBe(false);
  });

  it("a survivor who ended with no land did not", () => {
    expect(
      completed(
        {
          players: [
            account(1),
            {
              ...account(2),
              stats: { finalTiles: "0" },
              fate: "never-spawned",
            },
          ],
        },
        1,
      ),
    ).toBe(false);
  });

  it("a stranger to the record completes nothing", () => {
    const record = buildRecord("abCD1234", {
      players: [account(1), account(2)],
    });
    expect(isCompleted(record, "nobody01", true)).toBe(false);
  });

  describe("connection", () => {
    it("disconnected before the end and never back: not completed", () => {
      expect(
        completed({
          lastTurn: 6000,
          disconnects: [
            { clientID: clientIdOf(0), turn: 5000, isDisconnected: true },
          ],
        }),
      ).toBe(false);
    });

    it("disconnected and reconnected before the end: completed", () => {
      expect(
        completed({
          lastTurn: 6000,
          disconnects: [
            { clientID: clientIdOf(0), turn: 5000, isDisconnected: true },
            { clientID: clientIdOf(0), turn: 5500, isDisconnected: false },
          ],
        }),
      ).toBe(true);
    });

    it("a disconnect after the end does not count against a survivor", () => {
      expect(
        completed({
          lastTurn: 6000,
          disconnects: [
            { clientID: clientIdOf(0), turn: 6001, isDisconnected: true },
          ],
        }),
      ).toBe(true);
    });

    it("someone else's disconnect is not yours", () => {
      expect(
        completed({
          lastTurn: 6000,
          disconnects: [
            { clientID: clientIdOf(1), turn: 100, isDisconnected: true },
          ],
        }),
      ).toBe(true);
    });

    it("an eliminated player must still be there at the end: gone before it is leaving early", () => {
      const players = [account(1), { ...account(2), fate: { killedAt: 3000 } }];
      // eliminated, then gone well before the end: left early
      expect(
        completed(
          {
            players,
            lastTurn: 6000,
            disconnects: [
              { clientID: clientIdOf(1), turn: 4000, isDisconnected: true },
            ],
          },
          1,
        ),
      ).toBe(false);
      // gone before even being eliminated: left early too
      expect(
        completed(
          {
            players,
            lastTurn: 6000,
            disconnects: [
              { clientID: clientIdOf(1), turn: 2000, isDisconnected: true },
            ],
          },
          1,
        ),
      ).toBe(false);
      // eliminated while briefly disconnected, back and staying: completed
      expect(
        completed(
          {
            players,
            lastTurn: 6000,
            disconnects: [
              { clientID: clientIdOf(1), turn: 2900, isDisconnected: true },
              { clientID: clientIdOf(1), turn: 3500, isDisconnected: false },
            ],
          },
          1,
        ),
      ).toBe(true);
    });

    it("disconnecting a moment before the end counts as gone after the result, not before it", () => {
      // the heartbeat notices a closed connection ~30s late, so a record without
      // the server's own roster allows RESULT_GRACE_TURNS of slack
      expect(
        completed({
          lastTurn: 6000,
          disconnects: [
            { clientID: clientIdOf(0), turn: 6000, isDisconnected: true },
          ],
        }),
      ).toBe(true);
      expect(
        completed({
          lastTurn: 6000,
          disconnects: [
            {
              clientID: clientIdOf(0),
              turn: 6000 - RESULT_GRACE_TURNS - 1,
              isDisconnected: true,
            },
          ],
        }),
      ).toBe(false);
    });

    it("within one turn the later intent wins", () => {
      expect(
        completed({
          lastTurn: 6000,
          disconnects: [
            { clientID: clientIdOf(0), turn: 3000, isDisconnected: true },
            { clientID: clientIdOf(0), turn: 3000, isDisconnected: false },
          ],
        }),
      ).toBe(true);
    });
  });

  it("a stored negative or absurd stat can not make a player look eliminated late", () => {
    // statsToJson turns values outside the believable range into 0
    expect(statsToJson({ killedAt: -5n }).killedAt).toBe("0");
    expect(statsToJson({ killedAt: 2n ** 60n }).killedAt).toBe("0");
  });
});

describe("Credits arithmetic", () => {
  it("pays nothing for a game that was not completed, 100 for a completed loss, 350 for a win", () => {
    expect(gameReward(false, false)).toBe(0);
    expect(gameReward(false, true)).toBe(0); // no win bonus without completing
    expect(gameReward(true, false)).toBe(ECONOMY.completedGameReward);
    expect(gameReward(true, true)).toBe(
      ECONOMY.completedGameReward + ECONOMY.winBonus,
    );
  });

  it("clamps to what is left of the day, never below zero", () => {
    const cap = ECONOMY.dailyGameplayCap;
    const win = ECONOMY.completedGameReward + ECONOMY.winBonus;
    expect(clampToCap(win, 0)).toBe(win);
    expect(clampToCap(win, cap - win)).toBe(win);
    expect(clampToCap(win, cap - win + 1)).toBe(win - 1);
    expect(clampToCap(win, cap - ECONOMY.completedGameReward)).toBe(
      ECONOMY.completedGameReward,
    );
    expect(clampToCap(win, cap)).toBe(0);
    expect(clampToCap(win, cap + 500)).toBe(0);
    expect(clampToCap(-5, 0)).toBe(0);
    expect(clampToCap(Number.NaN, 0)).toBe(0);
    expect(clampToCap(win, -400)).toBe(win);
  });

  afterEach(() => {
    vi.doUnmock("../../src/account-api/domain/constants");
    vi.resetModules();
  });

  it("a changed ECONOMY changes what is paid, so no value is hard-coded", async () => {
    vi.resetModules();
    vi.doMock(
      "../../src/account-api/domain/constants",
      async (importOriginal) => {
        const real =
          await importOriginal<
            typeof import("../../src/account-api/domain/constants")
          >();
        return {
          ...real,
          ECONOMY: {
            ...real.ECONOMY,
            completedGameReward: 7,
            winBonus: 11,
            dailyGameplayCap: 20,
          },
        };
      },
    );
    const changed = await import("../../src/account-api/domain/economy");
    expect(changed.gameReward(true, false)).toBe(7);
    expect(changed.gameReward(true, true)).toBe(18);
    expect(changed.gameReward(false, true)).toBe(0);
    expect(changed.clampToCap(18, 10)).toBe(10);
    expect(changed.clampToCap(18, 20)).toBe(0);
  });

  it("follows the constants (nothing is hard-coded)", () => {
    // The numbers come only from ECONOMY: a derived expectation, not literals.
    const rewards = [false, true].flatMap((won) => [gameReward(true, won)]);
    expect(rewards).toEqual([
      ECONOMY.completedGameReward,
      ECONOMY.completedGameReward + ECONOMY.winBonus,
    ]);
  });
});

describe("summing player stats", () => {
  it("adds element-wise and pads the shorter array with zeros", () => {
    const sum = sumPlayerStats(
      { attacks: ["1", "2"], gold: ["5"] },
      { attacks: ["10", "20", "30"], betrayals: "2" },
    );
    expect(sum.attacks).toEqual(["11", "22", "30"]);
    expect(sum.gold).toEqual(["5"]);
    expect(sum.betrayals).toBe("2");
  });

  it("adds keyed groups key by key", () => {
    const sum = sumPlayerStats(
      { boats: { trans: ["1", "1"] }, air: { bomb: ["2"] } },
      { boats: { trans: ["2"], trade: ["4"] }, air: { rckt: ["1"] } },
    );
    expect(sum.boats).toEqual({ trans: ["3", "1"], trade: ["4"] });
    expect(sum.air).toEqual({ bomb: ["2"], rckt: ["1"] });
  });

  it("keeps the largest single incoming attack as a maximum, not a sum", () => {
    const sum = sumPlayerStats(
      { attacks: ["1", "1", "0", "50"] },
      { attacks: ["1", "1", "0", "30"] },
    );
    expect(sum.attacks).toEqual(["2", "2", "0", "50"]);
  });

  it("works with nothing on either side, and leaves per-game values out", () => {
    expect(sumPlayerStats(undefined, undefined)).toEqual({});
    const sum = sumPlayerStats(
      {},
      { killedAt: "900", finalTiles: "5", spawnTile: 3, attacks: ["1"] },
    );
    expect(sum).toEqual({ attacks: ["1"] });
  });

  it("treats garbage as zero and saturates instead of overflowing", () => {
    const sum = sumPlayerStats(
      { attacks: ["-4", "abc", "9223372036854775807"] },
      { attacks: ["1", "1", "5"] },
    );
    expect(sum.attacks).toEqual(["1", "1", "9223372036854775807"]);
  });

  it("is associative over bigint-sized numbers", () => {
    const big = "9007199254740993"; // beyond Number's exact range
    expect(
      sumPlayerStats({ attacks: [big] }, { attacks: ["1"] }).attacks,
    ).toEqual(["9007199254740994"]);
  });

  it("statsToJson turns bigints into strings and drops undefined", () => {
    expect(
      statsToJson({
        attacks: [1n, 2n],
        killedAt: 7n,
        killedBy: null,
        x: undefined,
      }),
    ).toEqual({ attacks: ["1", "2"], killedAt: "7", killedBy: null });
    expect(statsToJson(undefined)).toEqual({});
  });
});

describe("the stats tree", () => {
  const row = (over: Record<string, unknown> = {}) => ({
    gameType: "Public",
    mode: "Free For All",
    difficulty: "Medium",
    wins: "2",
    losses: "1",
    total: "4",
    stats: { attacks: ["3"] },
    ...over,
  });

  it("nests type → mode → difficulty and parses with the client's schema", () => {
    const tree = buildStatsTree(
      [
        row(),
        row({ difficulty: "Hard", wins: "0" }),
        row({ gameType: "Private", mode: "Team" }),
      ],
      [
        {
          gameType: "Public",
          mode: "Free For All",
          difficulty: "Medium",
          won: true,
        },
      ],
    );
    const parsed = PlayerStatsTreeSchema.parse(tree);
    expect(parsed.Public?.["Free For All"]?.Medium?.wins).toBe(2n);
    expect(parsed.Public?.["Free For All"]?.Hard?.wins).toBe(0n);
    expect(parsed.Private?.Team?.Medium?.total).toBe(4n);
    expect(parsed.recent?.all).toEqual({ games: 1, wins: 1 });
  });

  it("leaves out rows the client would choke on", () => {
    const tree = buildStatsTree(
      [
        row({ mode: "Chaos" }),
        row({ difficulty: "Nightmare" }),
        row({ gameType: "Ranked" }),
        row(),
      ],
      [],
    );
    expect(() => PlayerStatsTreeSchema.parse(tree)).not.toThrow();
    expect(Object.keys(tree.Public ?? {})).toEqual(["Free For All"]);
    expect(Object.keys(tree.Public?.["Free For All"] ?? {})).toEqual([
      "Medium",
    ]);
    expect(tree.Ranked).toBeUndefined();
  });

  it("an empty player has an empty tree and zero recent games", () => {
    const tree = PlayerStatsTreeSchema.parse(buildStatsTree([], []));
    expect(tree.Public).toBeUndefined();
    expect(tree.recent?.all).toEqual({ games: 0, wins: 0 });
  });

  it("Humans Vs Nations is its own mode", () => {
    expect(modeBucket("Team", "Humans Vs Nations")).toBe("Humans Vs Nations");
    expect(modeBucket("Team", "Duos")).toBe("Team");
    expect(modeBucket("Free For All", null)).toBe("Free For All");
    const tree = buildStatsTree([row({ mode: "Humans Vs Nations" })], []);
    expect(
      PlayerStatsTreeSchema.parse(tree).Public?.["Humans Vs Nations"],
    ).toBeDefined();
  });

  it("recent windows cover the newest games per selection, at most the window size", () => {
    const rows = Array.from({ length: 130 }, (_v, i) => ({
      gameType: "Public",
      mode: "Free For All",
      difficulty: i % 2 === 0 ? "Easy" : "Hard",
      won: i < 10, // the ten newest are wins
    }));
    const recent = buildRecentTree(rows) as Record<string, any>;
    expect(recent.all).toEqual({ games: 100, wins: 10 });
    expect(recent.Public.all).toEqual({ games: 100, wins: 10 });
    expect(recent.Public["Free For All"].Easy).toEqual({ games: 65, wins: 5 });
    expect(recent.Private).toBeUndefined();
  });
});

describe("record sanity", () => {
  const now = Date.UTC(2024, 0, 1);
  const base = buildRecord("abCD1234", { players: [account(1), account(2)] });
  const withInfo = (info: Record<string, unknown>) =>
    ({ info: { ...base.info, ...info } }) as never;

  it("accepts a real game", () => {
    expect(recordProblem(base, now)).toBeNull();
  });

  it("refuses times that cannot be real", () => {
    expect(recordProblem(withInfo({ start: -5 }), now)).not.toBeNull();
    // a game whose start was never stamped (0) is odd but still stored
    expect(recordProblem(withInfo({ start: 0 }), now)).toBeNull();
    expect(recordProblem(withInfo({ start: 1.5 }), now)).not.toBeNull();
    expect(
      recordProblem(withInfo({ end: base.info.start - 1 }), now),
    ).not.toBeNull();
    expect(
      recordProblem(withInfo({ end: now + 3 * 86_400_000 }), now),
    ).not.toBeNull();
    expect(
      recordProblem(withInfo({ duration: Number.MAX_VALUE }), now),
    ).not.toBeNull();
  });
});

describe("usernames", () => {
  it("accepts ordinary names and tidies spaces", () => {
    expect(checkUsernameBase("Aydin")).toEqual({ ok: true, base: "Aydin" });
    expect(checkUsernameBase("  Delta   Front ")).toEqual({
      ok: true,
      base: "Delta Front",
    });
    expect(checkUsernameBase("José_99")).toMatchObject({ ok: true });
  });

  it("enforces 3 to 20 characters and no dots", () => {
    expect(checkUsernameBase("ab")).toMatchObject({
      ok: false,
      code: "USERNAME_INVALID",
    });
    expect(checkUsernameBase("a".repeat(21))).toMatchObject({ ok: false });
    expect(checkUsernameBase("a".repeat(20))).toMatchObject({ ok: true });
    expect(checkUsernameBase("no.dots")).toMatchObject({ ok: false });
    expect(checkUsernameBase("   ")).toMatchObject({ ok: false });
  });

  it("refuses characters the game cannot draw", () => {
    expect(checkUsernameBase("名前名前")).toMatchObject({
      ok: false,
      code: "USERNAME_INVALID",
    });
    expect(checkUsernameBase("a\u0000bc")).toMatchObject({ ok: false });
  });

  it("refuses profanity", () => {
    expect(checkUsernameBase("fuckyou")).toMatchObject({
      ok: false,
      code: "USERNAME_PROFANE",
    });
  });

  it("renders base and four-digit suffix", () => {
    expect(displayUsername("Ann", "0042")).toBe("Ann.0042");
    expect(displayUsername(null, null)).toBeNull();
  });
});

describe("the client's wording follows the rules", () => {
  const en = JSON.parse(
    fs.readFileSync(
      path.resolve(__dirname, "../../resources/lang/en.json"),
      "utf8",
    ),
  );

  it("names the currency Credits", () => {
    expect(ECONOMY.currencyName).toBe("Credits");
    expect(en.cosmetics.soft).toBe(ECONOMY.currencyName);
  });

  it("tells players the username lock is as long as the server enforces", () => {
    const days = `${ACCOUNT_RULES.usernameChangeCooldownDays}`;
    expect(en.account_modal.username_confirm_body).toContain(`${days} days`);
    expect(en.account_modal.username_confirm_case_only).toContain(
      `${days}-day`,
    );
  });
});
