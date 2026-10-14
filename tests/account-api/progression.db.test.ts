// @vitest-environment node
import { afterEach, expect, it } from "vitest";
import { challengesFor } from "../../src/account-api/domain/challenges";
import { ECONOMY } from "../../src/account-api/domain/constants";
import {
  buildRecord,
  clientIdOf,
  creditsOf,
  DEFAULT_END_MS,
  makeUser,
  submitGame,
  type GameSpec,
  type TestUser,
} from "./util/games";
import { createServerKey, startHarness, type Harness } from "./util/harness";
import { describeDb } from "./util/testDb";

const FEATURES = "accounts,store,inventory,clans,leaderboards,progression";
const DAY = 86_400_000;

const harnesses: Harness[] = [];
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.close();
});

let seq = 0;
const gameId = () => `px${String(++seq).padStart(6, "0")}`;

async function setup(players = 6, kind: "guest" | "registered" = "registered") {
  const h = await startHarness({ features: FEATURES });
  harnesses.push(h);
  const key = await createServerKey(h);
  const users: TestUser[] = [];
  for (let i = 0; i < players; i++) users.push(await makeUser(h, kind));
  return { h, key, users };
}

const q = async (h: Harness, sql: string, params: unknown[] = []) =>
  (await h.db.pool.query(sql, params)).rows;

/** Six players: a winner, a runner-up with less land, and four eliminated at 5000..2000 ticks. */
function ffa6(users: TestUser[], over: Partial<GameSpec> = {}): GameSpec {
  return {
    allAct: true,
    players: [
      { user: users[0] },
      { user: users[1], stats: { finalTiles: "400" } },
      { user: users[2], fate: { killedAt: 5000 } },
      { user: users[3], fate: { killedAt: 4000 } },
      { user: users[4], fate: { killedAt: 3000 } },
      { user: users[5], fate: { killedAt: 2000 } },
    ],
    ...over,
  };
}

async function play(
  h: Harness,
  key: string,
  spec: GameSpec,
  id: string = gameId(),
) {
  const res = await submitGame(h, key, buildRecord(id, spec));
  expect(res.status).toBe(200);
  return id;
}

async function progressOf(h: Harness, user: TestUser) {
  const rows = await q(
    h,
    `SELECT lifetime_xp::int AS lifetime, run_xp::int AS run, prestige
       FROM user_progress WHERE user_id = $1`,
    [user.id],
  );
  return rows[0] ?? null;
}

async function resultOf(h: Harness, id: string, user: TestUser) {
  const rows = await q(
    h,
    `SELECT p.xp_awarded::int AS xp, p.clan_xp::int AS clan_xp, p.xp_result
       FROM game_players p JOIN games g ON g.id = p.game_id
      WHERE g.game_code = $1 AND p.user_id = $2`,
    [id, user.id],
  );
  return rows[0] as { xp: number; clan_xp: number; xp_result: any } | undefined;
}

/** The XP the challenges a game completed paid (they differ per account). */
const challengeXp = (result: { challenges: Array<{ xp: number }> }) =>
  result.challenges.reduce((sum, c) => sum + c.xp, 0);

const ledgerCount = async (h: Harness, user: TestUser, source = "match") =>
  Number(
    (
      await q(
        h,
        "SELECT count(*) AS n FROM xp_ledger WHERE user_id = $1 AND source = $2",
        [user.id, source],
      )
    )[0].n,
  );

describeDb("XP from a finished game", () => {
  it("pays each player by placement, win and the daily bonuses, and stores the breakdown", async () => {
    const { h, key, users } = await setup();
    const id = await play(h, key, ffa6(users));

    // completed 100 + placement + victory 250 + first game 100 + first win 150
    const expected = [750, 300, 250, 200, 200, 200];
    for (let i = 0; i < 6; i++) {
      const r = await resultOf(h, id, users[i]);
      expect(r?.xp, `player ${i + 1}`).toBe(expected[i]);
      expect((await progressOf(h, users[i]))?.lifetime).toBe(
        expected[i] + challengeXp(r!.xp_result),
      );
      expect(await ledgerCount(h, users[i])).toBe(1);
    }
    const winner = (await resultOf(h, id, users[0]))!.xp_result;
    expect(winner.eligible).toBe(true);
    expect(winner.breakdown).toMatchObject({
      played: 100,
      placement: 150,
      win: 250,
      firstGame: 100,
      firstWin: 150,
      subtotal: 750,
      gamePermille: 1000,
      repeatPermille: 1000,
      playerCount: 6,
      total: 750,
    });
    expect(winner.before).toMatchObject({
      prestige: 0,
      level: 1,
      xpInLevel: 0,
    });
    // the match's 750, plus whatever challenges it completed for this account
    const total = 750 + challengeXp(winner);
    expect(winner.after).toMatchObject({
      prestige: 0,
      lifetimeXp: total,
      legend: false,
      canPrestige: false,
    });
    expect(winner.after.level).toBeGreaterThanOrEqual(2);
    expect(winner.levelsReached[0]).toEqual({ prestige: 0, level: 2 });
  });

  it("awards a game exactly once however often it is submitted", async () => {
    const { h, key, users } = await setup();
    const id = await play(h, key, ffa6(users));
    const again = await submitGame(h, key, buildRecord(id, ffa6(users)));
    expect(again.status).toBe(200);
    for (const user of users) {
      expect(await ledgerCount(h, user)).toBe(1);
    }
    const [match] = await q(
      h,
      "SELECT delta::int AS d FROM xp_ledger WHERE user_id = $1 AND source = 'match'",
      [users[0].id],
    );
    expect(match.d).toBe(750);
    expect((await resultOf(h, id, users[0]))?.xp).toBe(750);
  });

  it("refuses to pay a game twice even if the game row is gone (the ledger is unique)", async () => {
    const { h, key, users } = await setup();
    const id = await play(h, key, ffa6(users));
    await expect(
      q(
        h,
        `INSERT INTO xp_ledger (user_id, delta, lifetime_after, run_after, prestige, source, ref_type, ref_id)
         VALUES ($1, 5, 5, 5, 0, 'match', 'game', $2)`,
        [users[0].id, id],
      ),
    ).rejects.toThrow(/xp_ledger_award_once/);
  });

  it("pays nothing for private games, and says why", async () => {
    const { h, key, users } = await setup();
    const id = await play(h, key, ffa6(users, { type: "Private" }));
    for (const user of users) {
      expect(await progressOf(h, user)).toBeNull();
      expect((await resultOf(h, id, user))?.xp_result).toEqual({
        eligible: false,
        reason: "private_game",
      });
    }
  });

  it("pays nothing for a game staff tests changed, but counts an owner's commands in a public game", async () => {
    const { h, key, users } = await setup();
    const command = (clientID: string) => ({
      type: "admin_command",
      command: "give_gold",
      target: clientID,
      amount: 1000,
      clientID,
    });
    // a plain admin's command in a public game: the game is a test
    await q(h, "UPDATE users SET role = 'admin' WHERE id = $1", [users[5].id]);
    const tested = await play(
      h,
      key,
      ffa6(users, {
        extraIntents: [command(clientIdOf(5))],
        adminActions: [
          {
            command: "give_gold",
            role: "admin",
            public: true,
            listed: false,
            invalidatesResult: true,
            count: 1,
          },
        ],
      }),
    );
    expect((await resultOf(h, tested, users[0]))?.xp_result).toEqual({
      eligible: false,
      reason: "admin_modified",
    });
    expect(await progressOf(h, users[0])).toBeNull();

    // the owner's command in a public game keeps the result: everyone else is
    // paid, the owner (who used the command) is not
    await q(h, "UPDATE users SET role = 'owner' WHERE id = $1", [users[5].id]);
    const counted = await play(
      h,
      key,
      ffa6(users, {
        extraIntents: [command(clientIdOf(5))],
        adminActions: [
          {
            command: "give_gold",
            role: "owner",
            public: true,
            listed: false,
            invalidatesResult: false,
            count: 1,
          },
        ],
      }),
    );
    const [game] = await q(
      h,
      "SELECT counts_for_stats, admin_modified FROM games WHERE game_code = $1",
      [counted],
    );
    expect(game).toEqual({ counts_for_stats: true, admin_modified: false });
    expect((await resultOf(h, counted, users[0]))?.xp).toBe(750);
    expect((await resultOf(h, counted, users[0]))?.xp_result.flags).toContain(
      "admin_counted",
    );
    expect((await resultOf(h, counted, users[5]))?.xp_result).toEqual({
      eligible: false,
      reason: "admin_actor",
    });
    expect(await progressOf(h, users[5])).toBeNull();
    // ...and the Credits side is untouched by progression
    expect(await creditsOf(h, users[0])).toBeGreaterThan(0);
  });

  it("pays nothing when too few accounts played, and nothing to a player who did not act", async () => {
    const { h, key, users } = await setup(2);
    const solo = await play(h, key, {
      allAct: true,
      players: [{ user: users[0] }, { user: null }],
    });
    expect((await resultOf(h, solo, users[0]))?.xp_result).toEqual({
      eligible: false,
      reason: "too_few_humans",
    });

    const idle = await play(h, key, {
      players: [
        { user: users[0], acts: true },
        { user: users[1], acts: false, fate: { killedAt: 3000 } },
      ],
    });
    expect((await resultOf(h, idle, users[1]))?.xp_result).toEqual({
      eligible: false,
      reason: "no_action",
    });
    expect((await resultOf(h, idle, users[0]))?.xp_result.eligible).toBe(true);
  });

  it("gives early leavers nothing and does not let them raise the player count", async () => {
    const { h, key, users } = await setup(6);
    const id = await play(
      h,
      key,
      ffa6(users, {
        // players 3..6 drop out and never reconnect before they are eliminated
        disconnects: [2, 3, 4, 5].map((i) => ({
          clientID: clientIdOf(i),
          turn: 100,
          isDisconnected: true,
        })),
      }),
    );
    for (const i of [2, 3, 4, 5]) {
      expect((await resultOf(h, id, users[i]))?.xp_result).toEqual({
        eligible: false,
        reason: "left_early",
      });
      expect(await progressOf(h, users[i])).toBeNull();
    }
    // two eligible humans are left: x0.1, no daily bonus spent
    const winner = (await resultOf(h, id, users[0]))!;
    expect(winner.xp_result.breakdown.playerCount).toBe(2);
    expect(winner.xp_result.breakdown.gamePermille).toBe(100);
    expect(winner.xp_result.breakdown.firstGame).toBe(0);
    expect(winner.xp).toBe(Math.floor((100 + 150 + 250) * 0.1));
  });

  it("classifies why a player did not complete: eliminated early, never spawned, no winner", async () => {
    const { h, key, users } = await setup(4);
    const id = await play(h, key, {
      allAct: true,
      players: [
        { user: users[0] },
        { user: users[1] },
        { user: users[2], fate: { killedAt: ECONOMY.minEliminationTick - 1 } },
        { user: users[3], fate: "never-spawned" },
      ],
    });
    expect((await resultOf(h, id, users[2]))?.xp_result.reason).toBe(
      "eliminated_early",
    );
    expect((await resultOf(h, id, users[3]))?.xp_result.reason).toBe(
      "not_spawned",
    );
    const noWinner = await play(h, key, {
      allAct: true,
      winner: null,
      players: users.map((user) => ({ user })),
    });
    expect((await resultOf(h, noWinner, users[0]))?.xp_result.reason).toBe(
      "no_winner",
    );
  });

  it("lets guests raise the player count but earn nothing themselves", async () => {
    const h = await startHarness({ features: FEATURES });
    harnesses.push(h);
    const key = await createServerKey(h);
    const reg = await makeUser(h, "registered");
    const g1 = await makeUser(h, "guest");
    const g2 = await makeUser(h, "guest");
    const id = await play(h, key, {
      allAct: true,
      players: [{ user: reg }, { user: g1 }, { user: g2 }],
    });
    expect((await resultOf(h, id, g1))?.xp_result).toEqual({
      eligible: false,
      reason: "guest",
    });
    expect(await progressOf(h, g1)).toBeNull();
    const r = (await resultOf(h, id, reg))!;
    expect(r.xp_result.breakdown.playerCount).toBe(3);
    expect(r.xp_result.breakdown.gamePermille).toBe(500);
  });

  it("pays the elimination XP for victims who lasted two minutes, at most six", async () => {
    const { h, key, users } = await setup(4);
    const id = await play(h, key, {
      allAct: true,
      players: [
        {
          user: users[0],
          stats: {
            kills: [
              { victim: clientIdOf(1), tick: "3000" },
              { victim: clientIdOf(2), tick: "300" },
            ],
          },
        },
        { user: users[1], fate: { killedAt: 3000 } },
        { user: users[2], fate: { killedAt: 300 } },
        { user: users[3], fate: { killedAt: 2500 } },
      ],
    });
    const win = (await resultOf(h, id, users[0]))!.xp_result;
    expect(win.breakdown.eliminationCount).toBe(1);
    expect(win.breakdown.eliminations).toBe(25);
  });

  it("uses the player-count multiplier bands on a real game", async () => {
    const { h, key, users } = await setup(16);
    const id = await play(h, key, {
      allAct: true,
      players: users.map((user, i) =>
        i === 0 ? { user } : { user, fate: { killedAt: 3000 + i } },
      ),
    });
    const winner = (await resultOf(h, id, users[0]))!;
    expect(winner.xp_result.breakdown.gamePermille).toBe(1150);
    // 100 + 150 + 250 + 100 + 150 = 750 x 1.15
    expect(winner.xp).toBe(862);
  });
});

describeDb("daily bonuses and the daily soft cap", () => {
  it("pays the first-game and first-win bonuses once per UTC day, and again the next day", async () => {
    const { h, key, users } = await setup();
    const first = await play(h, key, ffa6(users));
    const second = await play(h, key, ffa6(users));
    expect(
      (await resultOf(h, first, users[0]))?.xp_result.breakdown,
    ).toMatchObject({
      firstGame: 100,
      firstWin: 150,
    });
    expect(
      (await resultOf(h, second, users[0]))?.xp_result.breakdown,
    ).toMatchObject({
      firstGame: 0,
      firstWin: 0,
      total: 500,
    });
    const next = await play(
      h,
      key,
      ffa6(users, { endMs: DEFAULT_END_MS + DAY }),
    );
    expect(
      (await resultOf(h, next, users[0]))?.xp_result.breakdown,
    ).toMatchObject({
      firstGame: 100,
      firstWin: 150,
    });
  });

  it("spends the first-win bonus only on a win", async () => {
    const { h, key, users } = await setup();
    const id = await play(h, key, ffa6(users));
    expect(
      (await resultOf(h, id, users[3]))?.xp_result.breakdown,
    ).toMatchObject({
      firstGame: 100,
      firstWin: 0,
    });
    const days = await q(
      h,
      "SELECT first_game_ref, first_win_ref FROM xp_daily WHERE user_id = $1",
      [users[3].id],
    );
    expect(days[0]).toEqual({ first_game_ref: id, first_win_ref: null });
    const won = await q(
      h,
      "SELECT first_win_ref FROM xp_daily WHERE user_id = $1",
      [users[0].id],
    );
    expect(won[0].first_win_ref).toBe(id);
  });

  it("splits a game that crosses the 6,000 XP daily limit and pays a quarter above it", async () => {
    const { h, key, users } = await setup();
    await q(
      h,
      "INSERT INTO xp_daily (user_id, day, match_xp, first_game_ref, first_win_ref) VALUES ($1, '2023-11-14', 5900, 'x', 'y')",
      [users[0].id],
    );
    const id = await play(h, key, ffa6(users));
    // 100 + 150 + 250 = 500 base: 100 in full, 400 at 25%
    const r = (await resultOf(h, id, users[0]))!;
    expect(r.xp).toBe(100 + 100);
    expect(r.xp_result.breakdown).toMatchObject({
      softCapped: true,
      total: 200,
    });
    expect(r.xp_result.flags).toContain("soft_cap");
    const [day] = await q(
      h,
      "SELECT match_xp::int AS xp FROM xp_daily WHERE user_id = $1",
      [users[0].id],
    );
    expect(day.xp).toBe(6_100);
  });
});

describeDb("repeated opponents", () => {
  it("quarters or halves the award once the same small group keeps playing each other", async () => {
    const { h, key, users } = await setup(3);
    const trio: GameSpec = {
      allAct: true,
      players: [
        { user: users[0] },
        { user: users[1], fate: { killedAt: 4000 } },
        { user: users[2], fate: { killedAt: 3000 } },
      ],
    };
    const ids: string[] = [];
    for (let i = 0; i < 7; i++) {
      ids.push(
        await play(h, key, { ...trio, endMs: DEFAULT_END_MS + i * 60_000 }),
      );
    }
    const factor = async (i: number) =>
      (await resultOf(h, ids[i], users[0]))!.xp_result.breakdown.repeatPermille;
    // games 1..5 had fewer than 5 earlier games together; the 6th has 5
    for (const i of [0, 1, 2, 3, 4])
      expect(await factor(i), `game ${i + 1}`).toBe(1000);
    expect(await factor(5)).toBe(500);
    expect(await factor(6)).toBe(500);
    expect((await resultOf(h, ids[5], users[0]))!.xp_result.flags).toContain(
      "repeat_group",
    );
  });

  it("ignores games from more than a day ago", async () => {
    const { h, key, users } = await setup(3);
    const trio: GameSpec = {
      allAct: true,
      players: [
        { user: users[0] },
        { user: users[1], fate: { killedAt: 4000 } },
        { user: users[2], fate: { killedAt: 3000 } },
      ],
    };
    for (let i = 0; i < 6; i++) {
      await play(h, key, {
        ...trio,
        endMs: DEFAULT_END_MS - 3 * DAY + i * 60_000,
      });
    }
    const id = await play(h, key, trio);
    expect(
      (await resultOf(h, id, users[0]))!.xp_result.breakdown.repeatPermille,
    ).toBe(1000);
  });
});

describeDb("concurrent ingestion", () => {
  it("applies games that share players at the same time without deadlock or lost XP", async () => {
    const { h, key, users } = await setup(8);
    const specs: GameSpec[] = [0, 1, 2, 3].map((n) => ({
      allAct: true,
      players: users.map((user, i) =>
        i === n ? { user } : { user, fate: { killedAt: 3000 + i * 10 } },
      ),
    }));
    const responses = await Promise.all(
      specs.map((spec) => submitGame(h, key, buildRecord(gameId(), spec))),
    );
    expect(responses.map((r) => r.status)).toEqual([200, 200, 200, 200]);
    for (const user of users) {
      const sum = await q(
        h,
        `SELECT COALESCE(sum(delta), 0)::int AS total,
                count(*) FILTER (WHERE source = 'match')::int AS games
           FROM xp_ledger WHERE user_id = $1`,
        [user.id],
      );
      const progress = await progressOf(h, user);
      expect(sum[0].games).toBe(4);
      // match, challenge and every other award add up to the account's total
      expect(progress.lifetime).toBe(sum[0].total);
    }
    // the daily bonuses were spent exactly once each, whichever game got them
    const bonuses = await q(
      h,
      `SELECT count(*)::int AS n FROM game_players
        WHERE user_id = $1 AND (xp_result -> 'breakdown' ->> 'firstGame')::int > 0`,
      [users[0].id],
    );
    expect(bonuses[0].n).toBe(1);
  });
});

describeDb("levels, milestones and rewards", () => {
  it("crosses several levels at once and unlocks the milestone Credits to claim", async () => {
    const { h, key, users } = await setup();
    // 2,200 run XP: level 4; a 750 XP game takes it past 2,460 (level 5)
    await q(
      h,
      "INSERT INTO user_progress (user_id, lifetime_xp, run_xp) VALUES ($1, 2200, 2200)",
      [users[0].id],
    );
    const id = await play(h, key, ffa6(users));
    const after = (await resultOf(h, id, users[0]))!.xp_result;
    expect(after.before.level).toBe(4);
    expect(after.after.level).toBeGreaterThanOrEqual(5);
    expect(after.levelsReached[0]).toEqual({ prestige: 0, level: 5 });
    const rewards = await q(
      h,
      `SELECT key, kind, credits::int AS credits, claimed_at FROM progression_rewards
        WHERE user_id = $1 AND kind = 'level_milestone'`,
      [users[0].id],
    );
    expect(rewards).toEqual([
      {
        key: "level:p0:5",
        kind: "level_milestone",
        credits: 250,
        claimed_at: null,
      },
    ]);
  });

  it("stops at level 100 but keeps counting lifetime XP", async () => {
    const { h, key, users } = await setup();
    await q(
      h,
      "INSERT INTO user_progress (user_id, lifetime_xp, run_xp, prestige) VALUES ($1, 600000, 524800, 3)",
      [users[0].id],
    );
    const id = await play(h, key, ffa6(users));
    const after = (await resultOf(h, id, users[0]))!.xp_result.after;
    expect(after).toMatchObject({
      level: 100,
      prestige: 3,
      canPrestige: true,
      legend: false,
    });
    // match XP (750) and any challenge XP all count towards the lifetime total
    expect(after.lifetimeXp).toBeGreaterThanOrEqual(600_750);
    const progress = await progressOf(h, users[0]);
    expect(progress.run).toBe(524_810);
    expect(progress.lifetime).toBe(after.lifetimeXp);
  });
});

describeDb("clan XP", () => {
  it("records 10% of a member's match XP for the clan they were in, on top of their own", async () => {
    const { h, key, users } = await setup();
    const [clan] = await q(
      h,
      `INSERT INTO clans (tag, name, created_by) VALUES ('DLT', 'Delta Test', $1) RETURNING id`,
      [users[0].id],
    );
    await q(
      h,
      "INSERT INTO clan_members (clan_id, user_id, role) VALUES ($1, $2, 'leader'), ($1, $3, 'member')",
      [clan.id, users[0].id, users[3].id],
    );
    const spec = ffa6(users);
    spec.players[0].clanTag = "DLT";
    spec.players[3].clanTag = "DLT";
    // claims a clan they are not a member of: no clan XP
    spec.players[1].clanTag = "DLT";
    const id = await play(h, key, spec);
    const winner = (await resultOf(h, id, users[0]))!;
    expect(winner.xp).toBe(750);
    expect(winner.clan_xp).toBe(75);
    expect((await resultOf(h, id, users[3]))!.clan_xp).toBe(20);
    expect((await resultOf(h, id, users[1]))!.clan_xp).toBe(0);
    expect((await resultOf(h, id, users[2]))!.clan_xp).toBe(0);
    // personal XP is untouched by it: the match XP is paid in full
    expect(await ledgerCount(h, users[0])).toBe(1);
    const [ledger] = await q(
      h,
      "SELECT delta::int AS delta FROM xp_ledger WHERE user_id = $1 AND source = 'match'",
      [users[0].id],
    );
    expect(ledger.delta).toBe(750);
  });
});

describeDb("seasons", () => {
  async function season(
    h: Harness,
    over: { start?: string; end?: string; archived?: boolean } = {},
  ) {
    const [row] = await q(
      h,
      `INSERT INTO seasons (number, name, starts_at, ends_at, archived_at)
       VALUES ((SELECT COALESCE(max(number), 0) + 1 FROM seasons), 'Season', $1, $2, $3)
       RETURNING id::text AS id`,
      [
        over.start ?? "2023-11-01T00:00:00Z",
        over.end ?? "2023-12-01T00:00:00Z",
        over.archived === true ? new Date() : null,
      ],
    );
    return row.id as string;
  }

  it("adds a game's XP to the season it ended in", async () => {
    const { h, key, users } = await setup();
    const id = await season(h);
    const game = await play(h, key, ffa6(users));
    const [row] = await q(
      h,
      "SELECT xp::int AS xp FROM user_season_progress WHERE season_id = $1 AND user_id = $2",
      [id, users[0].id],
    );
    // the match's XP, plus whatever the game's challenges paid, all count for the season
    const ledger = await q(
      h,
      "SELECT source, season_id::text AS season_id, season_delta::int AS d FROM xp_ledger WHERE user_id = $1 ORDER BY id",
      [users[0].id],
    );
    expect(ledger[0]).toEqual({ source: "match", season_id: id, d: 750 });
    const total = ledger.reduce((sum, r) => sum + r.d, 0);
    expect(row.xp).toBe(total);
    const result = (await resultOf(h, game, users[0]))!.xp_result;
    expect(result.season).toMatchObject({
      number: 1,
      xp: total,
      level: Math.min(50, 1 + Math.floor(total / 2000)),
      added: total,
    });
  });

  it("ignores a game outside the season window, or after the season was archived", async () => {
    const { h, key, users } = await setup();
    await season(h, {
      start: "2023-12-01T00:00:00Z",
      end: "2024-01-01T00:00:00Z",
    });
    await season(h, {
      start: "2023-10-01T00:00:00Z",
      end: "2023-11-30T00:00:00Z",
      archived: true,
    });
    const game = await play(h, key, ffa6(users));
    expect(
      await q(h, "SELECT 1 FROM user_season_progress WHERE user_id = $1", [
        users[0].id,
      ]),
    ).toHaveLength(0);
    expect((await resultOf(h, game, users[0]))!.xp_result.season).toBeNull();
    // lifetime XP is unaffected
    expect((await progressOf(h, users[0])).lifetime).toBeGreaterThanOrEqual(
      750,
    );
    const [match] = await q(
      h,
      "SELECT delta::int AS d, season_id FROM xp_ledger WHERE user_id = $1 AND source = 'match'",
      [users[0].id],
    );
    expect(match).toEqual({ d: 750, season_id: null });
  });

  it("unlocks the free track's Credits as season levels are reached, once", async () => {
    const { h, key, users } = await setup();
    const id = await season(h);
    // 7,500 season XP: a 750 game crosses season level 5 (8,000)
    await q(
      h,
      "INSERT INTO user_season_progress (season_id, user_id, xp) VALUES ($1, $2, 7500)",
      [id, users[0].id],
    );
    await play(h, key, ffa6(users));
    await play(h, key, ffa6(users));
    const rewards = await q(
      h,
      "SELECT key, credits::int AS credits FROM progression_rewards WHERE user_id = $1 AND kind = 'season_track'",
      [users[0].id],
    );
    expect(rewards).toEqual([{ key: `season:${id}:level:5`, credits: 100 }]);
  });
});

describeDb("challenges", () => {
  it("advances the assigned daily and weekly challenges and pays a completed one once", async () => {
    const { h, key, users } = await setup();
    const user = users[0];
    const day = challengesFor(user.id, "daily", "d:2023-11-14");
    const slotA = day[0]; // finish 2 or 3 games
    const specs = [0, 1, 2].map(
      (i): GameSpec => ({ ...ffa6(users), endMs: DEFAULT_END_MS + i * 60_000 }),
    );
    const ids: string[] = [];
    for (const spec of specs) ids.push(await play(h, key, spec));

    const progress = await q(
      h,
      "SELECT challenge_id, progress::int AS progress, completed_at IS NOT NULL AS done FROM challenge_progress WHERE user_id = $1 AND period_key = 'd:2023-11-14' AND challenge_id = $2",
      [user.id, slotA.id],
    );
    expect(progress).toEqual([
      { challenge_id: slotA.id, progress: slotA.target, done: true },
    ]);
    const ledger = await q(
      h,
      "SELECT ref_id, delta::int AS delta FROM xp_ledger WHERE user_id = $1 AND source = 'daily_challenge' AND ref_id = $2",
      [user.id, `d:2023-11-14:${slotA.id}`],
    );
    expect(ledger).toEqual([
      { ref_id: `d:2023-11-14:${slotA.id}`, delta: slotA.xp },
    ]);
    // the game that completed it reports it
    const completing = ids[slotA.target - 1];
    const result = (await resultOf(h, completing, user))!.xp_result;
    expect(result.challenges).toEqual(
      expect.arrayContaining([
        { id: slotA.id, period: "daily", xp: slotA.xp, credits: 0 },
      ]),
    );
    // a completed challenge is not advanced or paid again by later games
    await play(h, key, { ...ffa6(users), endMs: DEFAULT_END_MS + 5 * 60_000 });
    expect(
      await ledgerCount(h, user, "daily_challenge"),
    ).toBeGreaterThanOrEqual(1);
    const paid = await q(
      h,
      "SELECT count(*)::int AS n FROM xp_ledger WHERE user_id = $1 AND ref_id = $2",
      [user.id, `d:2023-11-14:${slotA.id}`],
    );
    expect(paid[0].n).toBe(1);
  });

  it("starts fresh on the next UTC day, and records no row until there is progress", async () => {
    const { h, key, users } = await setup();
    expect(
      await q(h, "SELECT 1 FROM challenge_progress WHERE user_id = $1", [
        users[0].id,
      ]),
    ).toHaveLength(0);
    await play(h, key, ffa6(users));
    const first = await q(
      h,
      "SELECT DISTINCT period_key FROM challenge_progress WHERE user_id = $1 ORDER BY 1",
      [users[0].id],
    );
    expect(first.map((r) => r.period_key)).toEqual([
      "d:2023-11-14",
      "w:2023-W46",
    ]);
    await play(h, key, ffa6(users, { endMs: DEFAULT_END_MS + DAY }));
    const keys = await q(
      h,
      "SELECT DISTINCT period_key FROM challenge_progress WHERE user_id = $1 ORDER BY 1",
      [users[0].id],
    );
    expect(keys.map((r) => r.period_key)).toEqual([
      "d:2023-11-14",
      "d:2023-11-15",
      "w:2023-W46",
    ]);
  });

  it("does not advance a challenge for a game that earned no XP", async () => {
    const { h, key, users } = await setup();
    await play(h, key, ffa6(users, { type: "Private" }));
    expect(
      await q(h, "SELECT 1 FROM challenge_progress WHERE user_id = $1", [
        users[0].id,
      ]),
    ).toHaveLength(0);
  });
});

describeDb("progression off", () => {
  it("stores games exactly as before and writes no XP", async () => {
    const h = await startHarness({
      features: "accounts,store,inventory,clans,leaderboards",
    });
    harnesses.push(h);
    const key = await createServerKey(h);
    const users = [];
    for (let i = 0; i < 6; i++) users.push(await makeUser(h));
    const id = gameId();
    await submitGame(h, key, buildRecord(id, ffa6(users)));
    expect(await q(h, "SELECT 1 FROM user_progress")).toHaveLength(0);
    expect(await q(h, "SELECT 1 FROM xp_ledger")).toHaveLength(0);
    const rows = await q(
      h,
      "SELECT xp_result, xp_awarded::int AS xp FROM game_players WHERE user_id = $1",
      [users[0].id],
    );
    expect(rows).toEqual([{ xp_result: null, xp: 0 }]);
    expect(await creditsOf(h, users[0])).toBeGreaterThan(0);
  });
});
