// @vitest-environment node
import { GameXpResponseSchema } from "@openfront/shared/ApiSchemas";
import { afterEach, expect, it } from "vitest";
import {
  buildRecord,
  clientIdOf,
  creditsOf,
  makeUser,
  submitGame,
  type GameSpec,
  type TestUser,
} from "./util/games";
import {
  call,
  createServerKey,
  startHarness,
  type Harness,
} from "./util/harness";
import { describeDb } from "./util/testDb";

const FEATURES = "accounts,store,inventory,clans,leaderboards,progression";
const harnesses: Harness[] = [];
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.close();
});

let seq = 0;
const gameId = () => `rd${String(++seq).padStart(6, "0")}`;

async function setup(players = 6) {
  const h = await startHarness({ features: FEATURES });
  harnesses.push(h);
  const key = await createServerKey(h);
  const users: TestUser[] = [];
  for (let i = 0; i < players; i++) users.push(await makeUser(h));
  return { h, key, users };
}

const q = async (h: Harness, sql: string, params: unknown[] = []) =>
  (await h.db.pool.query(sql, params)).rows;

/** Six players; the winner eliminated the second (who lasted 50 minutes). */
function ffa6(users: TestUser[], over: Partial<GameSpec> = {}): GameSpec {
  return {
    allAct: true,
    players: [
      {
        user: users[0],
        stats: { kills: [{ victim: clientIdOf(1), tick: "30000" }] },
      },
      { user: users[1], fate: { killedAt: 30000 } },
      { user: users[2], fate: { killedAt: 5000 } },
      { user: users[3], fate: { killedAt: 4000 } },
      { user: users[4], fate: { killedAt: 3000 } },
      { user: users[5], fate: { killedAt: 2000 } },
    ],
    ...over,
  };
}

async function play(h: Harness, key: string, spec: GameSpec, id = gameId()) {
  const res = await submitGame(h, key, buildRecord(id, spec));
  expect(res.status).toBe(200);
  return id;
}

async function resultOf(h: Harness, id: string, user: TestUser) {
  const rows = await q(
    h,
    `SELECT p.xp_awarded::int AS xp, p.clan_xp::int AS clan_xp, p.xp_result
       FROM game_players p JOIN games g ON g.id = p.game_id
      WHERE g.game_code = $1 AND p.user_id = $2`,
    [id, user.id],
  );
  return rows[0] as { xp: number; clan_xp: number; xp_result: any };
}

const progressOf = async (h: Harness, user: TestUser) =>
  (
    await q(
      h,
      "SELECT lifetime_xp::int AS life, run_xp::int AS run FROM user_progress WHERE user_id = $1",
      [user.id],
    )
  )[0] ?? null;

const ledgerRows = (h: Harness, user: TestUser) =>
  q(
    h,
    `SELECT source, delta::int AS delta, reason, season_id, season_delta::int AS season_delta
       FROM xp_ledger WHERE user_id = $1 ORDER BY id`,
    [user.id],
  );

async function runningSeason(h: Harness) {
  const [row] = await q(
    h,
    `INSERT INTO seasons (number, name, starts_at, ends_at)
     VALUES (1, 'Opening', '2023-11-01', '2023-12-01') RETURNING id::text AS id`,
  );
  return row.id as string;
}

// ---------------------------------------------------------------------------

describeDb("a reduced game: private, unlisted and low-population", () => {
  it("pays a private game completed-match and elimination XP at a quarter: 125 x 0.25 = 31", async () => {
    const { h, key, users } = await setup();
    const id = await play(h, key, ffa6(users, { type: "Private" }));
    const winner = await resultOf(h, id, users[0]);
    expect(winner.xp).toBe(31);
    expect(winner.xp_result).toMatchObject({
      eligible: true,
      mode: "reduced",
      breakdown: {
        played: 100,
        eliminations: 25,
        eliminationCount: 1,
        subtotal: 125,
        gamePermille: 250,
        reducedReason: "private_game",
        total: 31,
      },
    });
    expect(winner.xp_result.flags).toContain("reduced");
    // everyone else completed it too: 100 x 0.25
    for (const user of users.slice(1)) {
      expect((await resultOf(h, id, user)).xp).toBe(25);
    }
  });

  it("tells an unlisted lobby from a listed one", async () => {
    const { h, key, users } = await setup();
    const unlisted = await play(
      h,
      key,
      ffa6(users, { type: "Private", listed: false }),
    );
    expect(
      (await resultOf(h, unlisted, users[0])).xp_result.breakdown.reducedReason,
    ).toBe("unlisted_game");
    const listed = await play(
      h,
      key,
      ffa6(users, { type: "Private", listed: true }),
    );
    expect(
      (await resultOf(h, listed, users[0])).xp_result.breakdown.reducedReason,
    ).toBe("private_game");
  });

  it("pays a public game short of humans a reduced award instead of nothing", async () => {
    const { h, key, users } = await setup(1);
    const id = await play(h, key, {
      allAct: true,
      players: [{ user: users[0] }, { user: null }],
    });
    const result = await resultOf(h, id, users[0]);
    expect(result.xp).toBe(25);
    expect(result.xp_result).toMatchObject({
      eligible: true,
      mode: "reduced",
      breakdown: { reducedReason: "public_too_few_humans", total: 25 },
    });
    // ...but the same account in a full game is still paid in full
    const { h: h2, key: key2, users: users2 } = await setup();
    const full = await play(h2, key2, ffa6(users2));
    expect((await resultOf(h2, full, users2[0])).xp_result.mode).toBe("full");
  });

  it("gives no placement, victory, first-game or first-win XP, and spends none of the day's bonuses", async () => {
    const { h, key, users } = await setup();
    const id = await play(h, key, ffa6(users, { type: "Private" }));
    const winner = (await resultOf(h, id, users[0])).xp_result.breakdown;
    expect(winner).toMatchObject({
      placement: 0,
      win: 0,
      firstGame: 0,
      firstWin: 0,
    });
    expect(
      await q(
        h,
        "SELECT first_game_ref, first_win_ref FROM xp_daily WHERE user_id = $1",
        [users[0].id],
      ),
    ).toEqual([{ first_game_ref: null, first_win_ref: null }]);
    // the bonuses are still there for the day's first FULL game
    const full = await play(h, key, ffa6(users));
    expect(
      (await resultOf(h, full, users[0])).xp_result.breakdown,
    ).toMatchObject({ firstGame: 100, firstWin: 150 });
  });

  it("counts only valid eliminations: a victim who lasted two minutes, at most six", async () => {
    const { h, key, users } = await setup();
    const id = await play(
      h,
      key,
      ffa6(users, {
        type: "Private",
        players: [
          {
            user: users[0],
            stats: {
              kills: [
                { victim: clientIdOf(1), tick: "30000" }, // counts
                { victim: clientIdOf(2), tick: "300" }, // died at 30s: no
              ],
            },
          },
          { user: users[1], fate: { killedAt: 30000 } },
          { user: users[2], fate: { killedAt: 300 } },
          { user: users[3], fate: { killedAt: 4000 } },
        ],
        allAct: true,
      }),
    );
    expect((await resultOf(h, id, users[0])).xp_result.breakdown).toMatchObject(
      { eliminationCount: 1, eliminations: 25, total: 31 },
    );
  });

  it("adds lifetime XP only: no season XP, no season leaderboard entry", async () => {
    const { h, key, users } = await setup();
    const season = await runningSeason(h);
    const id = await play(h, key, ffa6(users, { type: "Private" }));
    expect(
      await q(h, "SELECT 1 FROM user_season_progress WHERE season_id = $1", [
        season,
      ]),
    ).toHaveLength(0);
    expect((await resultOf(h, id, users[0])).xp_result.season).toBeNull();
    expect(await ledgerRows(h, users[0])).toEqual([
      {
        source: "match",
        delta: 31,
        reason: "private_game",
        season_id: null,
        season_delta: 0,
      },
    ]);
    expect((await progressOf(h, users[0])).life).toBe(31);
    // the season board does not list the player (the endpoint reads the live season,
    // which is not running now, so ask for it by number)
    await q(h, "UPDATE seasons SET archived_at = now() WHERE id = $1", [
      season,
    ]);
    await q(
      h,
      "UPDATE user_season_progress SET final_rank = 1 WHERE season_id = $1",
      [season],
    );
    const board = await (
      await call(h, "/leaderboard/season?season=1", { origin: null })
    ).json();
    expect(board.players).toEqual([]);
  });

  it("does not progress daily or weekly challenges", async () => {
    const { h, key, users } = await setup();
    // several reduced games would complete "finish 2 games" if they counted
    for (let i = 0; i < 4; i++) {
      await play(h, key, ffa6(users, { type: "Private" }));
    }
    expect(
      await q(h, "SELECT 1 FROM challenge_progress WHERE user_id = $1", [
        users[0].id,
      ]),
    ).toHaveLength(0);
    expect(
      (await ledgerRows(h, users[0])).filter((r) => r.source !== "match"),
    ).toEqual([]);
    const result = (
      await resultOf(
        h,
        await play(h, key, ffa6(users, { type: "Private" })),
        users[0],
      )
    ).xp_result;
    expect(result.challenges).toEqual([]);
  });

  it("gives no clan XP", async () => {
    const { h, key, users } = await setup();
    const [clan] = await q(
      h,
      "INSERT INTO clans (tag, name, created_by) VALUES ('DLT', 'Delta', $1) RETURNING id",
      [users[0].id],
    );
    await q(
      h,
      "INSERT INTO clan_members (clan_id, user_id, role) VALUES ($1, $2, 'leader')",
      [clan.id, users[0].id],
    );
    const spec = ffa6(users, { type: "Private" });
    spec.players[0].clanTag = "DLT";
    const id = await play(h, key, spec);
    const winner = await resultOf(h, id, users[0]);
    expect(winner.xp).toBe(31);
    expect(winner.clan_xp).toBe(0);
    const info = await (
      await call(h, "/clans/DLT", { bearer: users[0].jwt, origin: null })
    ).json();
    expect(info.xp).toBe(0);
  });

  it("still earns a level-milestone reward when the reduced XP carries the player across a level", async () => {
    const { h, key, users } = await setup();
    // 2,440 run XP is level 4; 31 more crosses level 5 (2,460)
    await q(
      h,
      "INSERT INTO user_progress (user_id, lifetime_xp, run_xp) VALUES ($1, 2440, 2440)",
      [users[0].id],
    );
    const id = await play(h, key, ffa6(users, { type: "Private" }));
    expect((await resultOf(h, id, users[0])).xp_result.levelsReached).toEqual([
      { prestige: 0, level: 5 },
    ]);
    expect(
      await q(
        h,
        "SELECT key FROM progression_rewards WHERE user_id = $1 AND kind = 'level_milestone'",
        [users[0].id],
      ),
    ).toEqual([{ key: "level:p0:5" }]);
  });

  it("still counts towards the daily soft cap, at the reduced rate", async () => {
    const { h, key, users } = await setup();
    await q(
      h,
      "INSERT INTO xp_daily (user_id, day, match_xp) VALUES ($1, '2023-11-14', 6000)",
      [users[0].id],
    );
    const id = await play(h, key, ffa6(users, { type: "Private" }));
    // 31 over the limit is paid a quarter: 7
    const result = await resultOf(h, id, users[0]);
    expect(result.xp).toBe(7);
    expect(result.xp_result.breakdown.softCapped).toBe(true);
    expect(
      (
        await q(
          h,
          "SELECT match_xp::int AS xp FROM xp_daily WHERE user_id = $1",
          [users[0].id],
        )
      )[0].xp,
    ).toBe(6007);
  });

  it("is applied once however often the game is submitted", async () => {
    const { h, key, users } = await setup();
    const id = await play(h, key, ffa6(users, { type: "Private" }));
    const again = await submitGame(
      h,
      key,
      buildRecord(id, ffa6(users, { type: "Private" })),
    );
    expect(again.status).toBe(200);
    expect(await ledgerRows(h, users[0])).toHaveLength(1);
    expect((await progressOf(h, users[0])).life).toBe(31);
  });

  it("is still refused to guests, leavers, players who did not act, and the game's admin actor", async () => {
    const { h, key, users } = await setup(4);
    const guest = await makeUser(h, "guest");
    const id = await play(h, key, {
      type: "Private",
      players: [
        { user: users[0], acts: true },
        { user: users[1], acts: false, fate: { killedAt: 30000 } },
        { user: users[2], acts: true, fate: { killedAt: 30000 } },
        { user: guest, acts: true, fate: { killedAt: 30000 } },
      ],
      disconnects: [
        { clientID: clientIdOf(2), turn: 100, isDisconnected: true },
      ],
    });
    expect((await resultOf(h, id, users[0])).xp_result.mode).toBe("reduced");
    expect((await resultOf(h, id, users[1])).xp_result).toEqual({
      eligible: false,
      reason: "no_action",
    });
    expect((await resultOf(h, id, users[2])).xp_result).toEqual({
      eligible: false,
      reason: "left_early",
    });
    expect((await resultOf(h, id, guest)).xp_result).toEqual({
      eligible: false,
      reason: "guest",
    });

    // the owner who used a command in a low-population public game
    await q(h, "UPDATE users SET role = 'owner' WHERE id = $1", [users[3].id]);
    const owner = await play(h, key, {
      allAct: true,
      players: [{ user: users[3] }, { user: null }],
      extraIntents: [
        {
          type: "admin_command",
          command: "give_gold",
          target: clientIdOf(0),
          amount: 1,
          clientID: clientIdOf(0),
        },
      ],
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
    });
    expect((await resultOf(h, owner, users[3])).xp_result).toEqual({
      eligible: false,
      reason: "admin_actor",
    });
  });
});

describeDb("games that earn nothing at all", () => {
  it("a game staff tests changed pays 0, even a private one", async () => {
    const { h, key, users } = await setup();
    const id = await play(
      h,
      key,
      ffa6(users, {
        type: "Private",
        extraIntents: [
          {
            type: "admin_command",
            command: "give_gold",
            target: clientIdOf(1),
            amount: 1,
            clientID: clientIdOf(1),
          },
        ],
        adminActions: [
          {
            command: "give_gold",
            role: "admin",
            public: false,
            listed: false,
            invalidatesResult: true,
            count: 1,
          },
        ],
      }),
    );
    for (const user of users) {
      expect((await resultOf(h, id, user)).xp_result).toEqual({
        eligible: false,
        reason: "admin_modified",
      });
    }
    expect(await progressOf(h, users[0])).toBeNull();
  });

  it("a singleplayer record pays 0 (it is never treated as a private game)", async () => {
    const { h, key, users } = await setup();
    const id = await play(h, key, ffa6(users, { type: "Singleplayer" }));
    expect((await resultOf(h, id, users[0])).xp_result).toEqual({
      eligible: false,
      reason: "singleplayer",
    });
    expect(await progressOf(h, users[0])).toBeNull();
  });

  it("a game with no winner, or one eliminated early, pays 0", async () => {
    const { h, key, users } = await setup();
    const id = await play(
      h,
      key,
      ffa6(users, { type: "Private", winner: null }),
    );
    expect((await resultOf(h, id, users[0])).xp_result).toEqual({
      eligible: false,
      reason: "no_winner",
    });
  });
});

describeDb("what the player is told", () => {
  it("answers a reduced game as an eligible result with its reason, not as ineligible", async () => {
    const { h, key, users } = await setup();
    const id = await play(h, key, ffa6(users, { type: "Private" }));
    const res = await call(h, `/users/@me/xp/${id}`, {
      bearer: users[0].jwt,
      origin: null,
    });
    const body = GameXpResponseSchema.parse(await res.json());
    if (!body.eligible) throw new Error("a reduced game is eligible");
    expect(body.mode).toBe("reduced");
    expect(body.breakdown.reducedReason).toBe("private_game");
    expect(body.breakdown.total).toBe(31);
    expect(body.challenges).toEqual([]);
    expect(body.season).toBeNull();
  });

  it("shows the reason on the XP history, and a staff note never reaches the player", async () => {
    const { h, key, users } = await setup();
    await play(h, key, ffa6(users, { type: "Private" }));
    await play(h, key, ffa6(users));
    // a staff correction carries a private note
    await q(
      h,
      `INSERT INTO xp_ledger (user_id, delta, lifetime_after, run_after, prestige, source, reason)
       VALUES ($1, -5, 1, 1, 0, 'admin_revoke', 'internal note: suspected abuse')`,
      [users[0].id],
    );
    const me = await (
      await call(h, "/progression/me", { bearer: users[0].jwt, origin: null })
    ).json();
    const history = me.history as Array<{
      amount: number;
      source: string;
      detail: string | null;
    }>;
    expect(history.find((e) => e.detail === "private_game")?.amount).toBe(31);
    expect(
      history.find((e) => e.source === "match" && e.detail === null),
    ).toBeDefined();
    expect(JSON.stringify(me)).not.toContain("suspected abuse");
    expect(await creditsOf(h, users[0])).toBeGreaterThanOrEqual(0);
  });
});
