// @vitest-environment node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { withTransaction } from "../../src/account-api/db/tx";
import { ECONOMY } from "../../src/account-api/domain/constants";
import { applyGameReward } from "../../src/account-api/domain/economy";
import {
  buildRecord,
  clientIdOf,
  creditsOf,
  DEFAULT_END_MS,
  makeUser,
  submitGame,
  userMe,
  type TestUser,
} from "./util/games";
import {
  call,
  createServerKey,
  startHarness,
  type Harness,
} from "./util/harness";
import { describeDb } from "./util/testDb";

const harnesses: Harness[] = [];
async function harness(): Promise<Harness> {
  const h = await startHarness();
  harnesses.push(h);
  return h;
}
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.close();
});

const DAY = 86_400_000;
const WIN = ECONOMY.completedGameReward + ECONOMY.winBonus;
let seq = 0;
const gameId = () => `gm${String(++seq).padStart(6, "0")}`;

async function setup(count = 2) {
  const h = await harness();
  const key = await createServerKey(h);
  const users: TestUser[] = [];
  for (let i = 0; i < count; i++) users.push(await makeUser(h));
  return { h, key, users };
}

const q = async (h: Harness, sql: string, params: unknown[] = []) =>
  (await h.db.pool.query(sql, params)).rows;

const count = async (h: Harness, table: string) =>
  Number((await q(h, `SELECT count(*) AS n FROM ${table}`))[0].n);

describeDb("ingesting a finished game: stats and Credits", () => {
  it("a qualifying public game pays 350 to the winner and 100 to the other completed player, and stores the game", async () => {
    const { h, key, users } = await setup();
    const [a, b] = users;
    const id = gameId();
    const res = await submitGame(
      h,
      key,
      buildRecord(id, {
        players: [
          { user: a },
          { user: b, fate: { killedAt: ECONOMY.minEliminationTick + 800 } },
        ],
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });

    expect(await creditsOf(h, a)).toBe(WIN);
    expect(await creditsOf(h, b)).toBe(ECONOMY.completedGameReward);

    const [game] = await q(
      h,
      "SELECT counts_for_stats, human_players, type, winner FROM games WHERE game_code = $1",
      [id],
    );
    expect(game).toMatchObject({
      counts_for_stats: true,
      human_players: 2,
      type: "Public",
      winner: ["player", clientIdOf(0)],
    });

    const players = await q(
      h,
      `SELECT user_id, client_id, result, completed, credits_awarded::int AS credits
         FROM game_players ORDER BY client_id`,
    );
    expect(players).toEqual([
      {
        user_id: a.id,
        client_id: clientIdOf(0),
        result: "victory",
        completed: true,
        credits: WIN,
      },
      {
        user_id: b.id,
        client_id: clientIdOf(1),
        result: "defeat",
        completed: true,
        credits: ECONOMY.completedGameReward,
      },
    ]);

    const ledger = await q(
      h,
      "SELECT user_id, delta::int AS delta, balance_after::int AS balance_after, reason, ref_type, ref_id, reward_day::text AS day FROM currency_ledger ORDER BY delta DESC",
    );
    expect(ledger).toEqual([
      {
        user_id: a.id,
        delta: WIN,
        balance_after: WIN,
        reason: "game_reward",
        ref_type: "game",
        ref_id: id,
        day: "2023-11-14",
      },
      {
        user_id: b.id,
        delta: ECONOMY.completedGameReward,
        balance_after: ECONOMY.completedGameReward,
        reason: "game_reward",
        ref_type: "game",
        ref_id: id,
        day: "2023-11-14",
      },
    ]);
  });

  it("a completed loss pays the base reward, never the win bonus", async () => {
    const { h, key, users } = await setup();
    await submitGame(
      h,
      key,
      buildRecord(gameId(), {
        players: [{ user: users[0] }, { user: users[1] }],
      }),
    );
    expect(await creditsOf(h, users[1])).toBe(ECONOMY.completedGameReward);
  });

  it("a player eliminated in the first two minutes gets nothing, but the game and the loss are recorded", async () => {
    const { h, key, users } = await setup();
    const [a, b] = users;
    await submitGame(
      h,
      key,
      buildRecord(gameId(), {
        players: [
          { user: a },
          { user: b, fate: { killedAt: ECONOMY.minEliminationTick - 1 } },
        ],
      }),
    );
    expect(await creditsOf(h, b)).toBe(0);
    expect(await creditsOf(h, a)).toBe(WIN);
    const [row] = await q(
      h,
      "SELECT result, completed, credits_awarded::int AS c FROM game_players WHERE user_id = $1",
      [b.id],
    );
    expect(row).toEqual({ result: "defeat", completed: false, c: 0 });
    const [agg] = await q(
      h,
      "SELECT wins::int, losses::int, total::int FROM player_stat_aggregates WHERE user_id = $1",
      [b.id],
    );
    expect(agg).toEqual({ wins: 0, losses: 1, total: 1 });
  });

  it("a player who disconnected for good before the end gets nothing", async () => {
    const { h, key, users } = await setup();
    await submitGame(
      h,
      key,
      buildRecord(gameId(), {
        players: [{ user: users[0] }, { user: users[1] }],
        lastTurn: 6000,
        disconnects: [
          { clientID: clientIdOf(1), turn: 4000, isDisconnected: true },
        ],
      }),
    );
    expect(await creditsOf(h, users[1])).toBe(0);
    expect(await creditsOf(h, users[0])).toBe(WIN);
  });

  it("a game with no winner is stored and counted but pays nothing", async () => {
    const { h, key, users } = await setup();
    await submitGame(
      h,
      key,
      buildRecord(gameId(), {
        players: [{ user: users[0] }, { user: users[1] }],
        winner: null,
      }),
    );
    expect(await creditsOf(h, users[0])).toBe(0);
    expect(await creditsOf(h, users[1])).toBe(0);
    const rows = await q(
      h,
      "SELECT result, completed FROM game_players ORDER BY client_id",
    );
    expect(rows).toEqual([
      { result: "incomplete", completed: false },
      { result: "incomplete", completed: false },
    ]);
    const [agg] = await q(
      h,
      "SELECT wins::int, losses::int, total::int FROM player_stat_aggregates WHERE user_id = $1",
      [users[0].id],
    );
    expect(agg).toEqual({ wins: 0, losses: 0, total: 1 });
  });

  it("a game under two minutes is stored but counts for nothing", async () => {
    const { h, key, users } = await setup();
    await submitGame(
      h,
      key,
      buildRecord(gameId(), {
        players: [{ user: users[0] }, { user: users[1] }],
        durationSeconds: 119,
      }),
    );
    expect(
      (await q(h, "SELECT counts_for_stats FROM games"))[0].counts_for_stats,
    ).toBe(false);
    expect(await creditsOf(h, users[0])).toBe(0);
    expect(await count(h, "player_stat_aggregates")).toBe(0);
    expect(await count(h, "game_players")).toBe(2); // still in their history
  });

  it("exactly two minutes counts", async () => {
    const { h, key, users } = await setup();
    await submitGame(
      h,
      key,
      buildRecord(gameId(), {
        players: [{ user: users[0] }, { user: users[1] }],
        durationSeconds: 120,
        lastTurn: 1300,
      }),
    );
    expect(await creditsOf(h, users[0])).toBe(WIN);
  });

  it("one account holder among the players is not enough, even if others are anonymous", async () => {
    const { h, key, users } = await setup(1);
    await submitGame(
      h,
      key,
      buildRecord(gameId(), { players: [{ user: users[0] }, { user: null }] }),
    );
    expect(
      (await q(h, "SELECT counts_for_stats, human_players FROM games"))[0],
    ).toEqual({
      counts_for_stats: false,
      human_players: 2,
    });
    expect(await creditsOf(h, users[0])).toBe(0);
    expect(await count(h, "player_stat_aggregates")).toBe(0);
  });

  it("the same account in two slots counts as one account holder", async () => {
    const { h, key, users } = await setup(1);
    await submitGame(
      h,
      key,
      buildRecord(gameId(), {
        players: [{ user: users[0] }, { user: users[0] }],
      }),
    );
    expect(
      (await q(h, "SELECT counts_for_stats FROM games"))[0].counts_for_stats,
    ).toBe(false);
    expect(await count(h, "game_players")).toBe(1);
    expect(await creditsOf(h, users[0])).toBe(0);
  });

  it("a private game is stored and in history, pays nothing, and is not a counted game", async () => {
    const { h, key, users } = await setup();
    await submitGame(
      h,
      key,
      buildRecord(gameId(), {
        type: "Private",
        players: [{ user: users[0] }, { user: users[1] }],
      }),
    );
    expect((await q(h, "SELECT counts_for_stats, type FROM games"))[0]).toEqual(
      { counts_for_stats: false, type: "Private" },
    );
    expect(await creditsOf(h, users[0])).toBe(0);
    expect(await count(h, "currency_ledger")).toBe(0);
    const rows = await q(
      h,
      "SELECT game_type, wins::int, total::int FROM player_stat_aggregates ORDER BY user_id",
    );
    expect(rows).toEqual([
      { game_type: "Private", wins: expect.any(Number), total: 1 },
      { game_type: "Private", wins: expect.any(Number), total: 1 },
    ]);
    expect(await count(h, "game_players")).toBe(2);
  });

  it("a ranked game is not a counted game (there is no ranked bucket yet)", async () => {
    const { h, key, users } = await setup();
    const record = buildRecord(gameId(), {
      players: [{ user: users[0] }, { user: users[1] }],
    });
    (record.info.config as unknown as Record<string, unknown>).rankedType =
      "1v1";
    await submitGame(h, key, record);
    expect(
      (await q(h, "SELECT counts_for_stats FROM games"))[0].counts_for_stats,
    ).toBe(false);
    expect(await creditsOf(h, users[0])).toBe(0);
  });

  it("guests are account holders and earn Credits too", async () => {
    const h = await harness();
    const key = await createServerKey(h);
    const g1 = await makeUser(h, "guest");
    const g2 = await makeUser(h, "guest");
    await submitGame(
      h,
      key,
      buildRecord(gameId(), { players: [{ user: g1 }, { user: g2 }] }),
    );
    expect(await creditsOf(h, g1)).toBe(WIN);
    expect(await creditsOf(h, g2)).toBe(ECONOMY.completedGameReward);
  });

  it("players without an account, or with a deleted one, are skipped", async () => {
    const { h, key, users } = await setup(3);
    await h.db.pool.query("UPDATE users SET deleted_at = now() WHERE id = $1", [
      users[2].id,
    ]);
    await submitGame(
      h,
      key,
      buildRecord(gameId(), {
        players: [
          { user: users[0] },
          { user: users[1] },
          { user: null },
          { user: users[2] },
        ],
      }),
    );
    expect(await count(h, "game_players")).toBe(2);
    expect(await creditsOf(h, users[2])).toBe(0);
    expect(
      (await q(h, "SELECT human_players FROM games"))[0].human_players,
    ).toBe(4);
  });

  it("team and nation winners map to results", async () => {
    const { h, key, users } = await setup(3);
    await submitGame(
      h,
      key,
      buildRecord(gameId(), {
        mode: "Team",
        players: [{ user: users[0] }, { user: users[1] }, { user: users[2] }],
        winner: ["team", "Red", clientIdOf(0), clientIdOf(1)],
      }),
    );
    expect(
      await q(h, "SELECT result FROM game_players ORDER BY client_id"),
    ).toEqual([
      { result: "victory" },
      { result: "victory" },
      { result: "defeat" },
    ]);
    expect(await creditsOf(h, users[0])).toBe(WIN);
    expect(await creditsOf(h, users[1])).toBe(WIN);
    expect(await creditsOf(h, users[2])).toBe(ECONOMY.completedGameReward);

    await submitGame(
      h,
      key,
      buildRecord(gameId(), {
        mode: "Team",
        playerTeams: "Humans Vs Nations",
        players: [{ user: users[0] }, { user: users[1] }],
        winner: ["nation", "Nations"],
      }),
    );
    const hvn = await q(
      h,
      "SELECT mode, wins::int, losses::int FROM player_stat_aggregates WHERE mode = 'Humans Vs Nations' ORDER BY user_id",
    );
    expect(hvn).toHaveLength(2);
    for (const row of hvn) expect(row).toMatchObject({ wins: 0, losses: 1 });
  });

  describe("the aggregates", () => {
    it("add up across games, per type, mode and difficulty", async () => {
      const { h, key, users } = await setup();
      const [a, b] = users;
      await submitGame(
        h,
        key,
        buildRecord(gameId(), {
          players: [
            { user: a, stats: { attacks: ["10", "5", "0"], gold: ["7"] } },
            { user: b },
          ],
        }),
      );
      await submitGame(
        h,
        key,
        buildRecord(gameId(), {
          players: [
            { user: b },
            {
              user: a,
              stats: {
                attacks: ["1", "1"],
                gold: ["3", "4"],
                units: { city: ["2"] },
              },
            },
          ],
        }),
      );
      await submitGame(
        h,
        key,
        buildRecord(gameId(), {
          difficulty: "Hard",
          players: [{ user: a }, { user: b }],
        }),
      );

      const rows = await q(
        h,
        `SELECT game_type, mode, difficulty, wins::int, losses::int, total::int, stats
           FROM player_stat_aggregates WHERE user_id = $1 ORDER BY difficulty`,
        [a.id],
      );
      expect(rows).toHaveLength(2);
      const [hard, medium] = rows;
      expect(hard).toMatchObject({
        game_type: "Public",
        mode: "Free For All",
        difficulty: "Hard",
        wins: 1,
        losses: 0,
        total: 1,
      });
      expect(medium).toMatchObject({
        difficulty: "Medium",
        wins: 1,
        losses: 1,
        total: 2,
      });
      expect(medium.stats.attacks).toEqual(["11", "6", "0"]);
      expect(medium.stats.gold).toEqual(["10", "4"]);
      expect(medium.stats.units).toEqual({ city: ["2"] });
      // per-game facts are not summed into the totals
      expect(medium.stats.killedAt).toBeUndefined();
      expect(medium.stats.finalTiles).toBeUndefined();
    });

    it("the per-game stats are kept on the player's row, as strings", async () => {
      const { h, key, users } = await setup();
      await submitGame(
        h,
        key,
        buildRecord(gameId(), {
          players: [
            { user: users[0] },
            { user: users[1], fate: { killedAt: 2500 } },
          ],
        }),
      );
      const [row] = await q(
        h,
        "SELECT stats FROM game_players WHERE user_id = $1",
        [users[1].id],
      );
      expect(row.stats).toMatchObject({
        attacks: ["100", "40", "0"],
        killedAt: "2500",
      });
    });

    it("values outside what a game can produce are stored as zero, not as negatives or overflow", async () => {
      const { h, key, users } = await setup();
      await submitGame(
        h,
        key,
        buildRecord(gameId(), {
          players: [
            {
              user: users[0],
              stats: { gold: ["-5", "99999999999999999999999"] },
            },
            { user: users[1] },
          ],
        }),
      );
      const [row] = await q(
        h,
        "SELECT stats FROM player_stat_aggregates WHERE user_id = $1",
        [users[0].id],
      );
      expect(row.stats.gold).toEqual(["0", "0"]);
    });
  });
});

describeDb("the daily cap", () => {
  /** A game between a and b that a loses or wins, ending at `endMs`. */
  const play = (
    h: Harness,
    key: string,
    a: TestUser,
    b: TestUser,
    aWins: boolean,
    endMs = DEFAULT_END_MS,
  ) =>
    submitGame(
      h,
      key,
      buildRecord(gameId(), {
        players: [{ user: aWins ? a : b }, { user: aWins ? b : a }],
        endMs,
      }),
    );

  it("holds at 1,000 a day and the last grant is partial: 900 earned + a 350 win pays 100", async () => {
    const { h, key, users } = await setup(12);
    const [a, ...others] = users;
    // nine completed losses: 9 x 100 = 900 Credits
    for (let i = 0; i < 9; i++) await play(h, key, a, others[i], false);
    expect(await creditsOf(h, a)).toBe(9 * ECONOMY.completedGameReward);
    expect(9 * ECONOMY.completedGameReward).toBe(900);

    await play(h, key, a, others[9], true); // would be worth 350
    expect(await creditsOf(h, a)).toBe(ECONOMY.dailyGameplayCap);
    const [last] = await q(
      h,
      "SELECT credits_awarded::int AS c, completed, result FROM game_players WHERE user_id = $1 ORDER BY game_id DESC LIMIT 1",
      [a.id],
    );
    // the grant was clamped; the win itself is recorded in full
    expect(last).toEqual({ c: 100, completed: true, result: "victory" });
    const [agg] = await q(
      h,
      "SELECT wins::int, losses::int, total::int FROM player_stat_aggregates WHERE user_id = $1",
      [a.id],
    );
    expect(agg).toEqual({ wins: 1, losses: 9, total: 10 });

    // once the cap is reached, more games pay nothing but still count
    await play(h, key, a, others[10], true);
    expect(await creditsOf(h, a)).toBe(ECONOMY.dailyGameplayCap);
    const [after] = await q(
      h,
      "SELECT credits_awarded::int AS c, completed FROM game_players WHERE user_id = $1 ORDER BY game_id DESC LIMIT 1",
      [a.id],
    );
    expect(after).toEqual({ c: 0, completed: true });
    expect(
      (
        await q(
          h,
          "SELECT total::int FROM player_stat_aggregates WHERE user_id = $1",
          [a.id],
        )
      )[0].total,
    ).toBe(11);
    // the ledger holds only what was paid
    expect(
      Number(
        (
          await q(
            h,
            "SELECT sum(delta) AS s FROM currency_ledger WHERE user_id = $1",
            [a.id],
          )
        )[0].s,
      ),
    ).toBe(ECONOMY.dailyGameplayCap);
  });

  it("the cap is per UTC day: the next day can earn again, up to the cap again", async () => {
    const { h, key, users } = await setup(3);
    const [a, b, c] = users;
    const day1 = Date.UTC(2023, 10, 14, 12);
    const day2 = day1 + DAY;
    for (let i = 0; i < 3; i++)
      await play(h, key, a, b, true, day1 + i * 60_000); // 3 x 350 = 1050 -> capped
    expect(await creditsOf(h, a)).toBe(ECONOMY.dailyGameplayCap);
    await play(h, key, a, c, true, day2);
    expect(await creditsOf(h, a)).toBe(ECONOMY.dailyGameplayCap + WIN);
    const days = await q(
      h,
      "SELECT reward_day::text AS day, sum(delta)::int AS total FROM currency_ledger WHERE user_id = $1 GROUP BY reward_day ORDER BY reward_day",
      [a.id],
    );
    expect(days).toEqual([
      { day: "2023-11-14", total: ECONOMY.dailyGameplayCap },
      { day: "2023-11-15", total: WIN },
    ]);
  });

  it("the UTC day boundary is the game's end time: 23:59:59.999Z is one day, 00:00:00.000Z the next", async () => {
    const { h, key, users } = await setup(3);
    const [a, b, c] = users;
    const midnight = Date.UTC(2023, 10, 15);
    // fill 14 Nov with three wins (capped) ending at the last millisecond of it
    for (let i = 0; i < 3; i++) await play(h, key, a, b, true, midnight - 1);
    expect(await creditsOf(h, a)).toBe(ECONOMY.dailyGameplayCap);
    // a game ending exactly at midnight belongs to 15 Nov
    await play(h, key, a, c, true, midnight);
    expect(await creditsOf(h, a)).toBe(ECONOMY.dailyGameplayCap + WIN);
  });

  it("a game submitted late counts towards the day it ended on, not the day it arrived", async () => {
    const { h, key, users } = await setup(2);
    const [a, b] = users;
    const yesterday = Date.now() - DAY;
    await play(h, key, a, b, true, yesterday);
    const [row] = await q(
      h,
      "SELECT reward_day::text AS day FROM currency_ledger WHERE user_id = $1",
      [a.id],
    );
    expect(row.day).toBe(new Date(yesterday).toISOString().slice(0, 10));
  });

  it("concurrent games for one player never pay past the cap", async () => {
    const { h, key, users } = await setup(9);
    const [a, ...others] = users;
    const results = await Promise.all(
      others.slice(0, 8).map((o) => play(h, key, a, o, true)),
    );
    for (const r of results) expect(r.status).toBe(200);
    expect(await creditsOf(h, a)).toBe(ECONOMY.dailyGameplayCap);
    expect(
      Number(
        (
          await q(
            h,
            "SELECT sum(delta) AS s FROM currency_ledger WHERE user_id = $1",
            [a.id],
          )
        )[0].s,
      ),
    ).toBe(ECONOMY.dailyGameplayCap);
    expect(
      (
        await q(
          h,
          "SELECT total::int FROM player_stat_aggregates WHERE user_id = $1",
          [a.id],
        )
      )[0].total,
    ).toBe(8);
    // no concurrent update lost another's statistics
    const [agg] = await q(
      h,
      "SELECT stats FROM player_stat_aggregates WHERE user_id = $1",
      [a.id],
    );
    expect(agg.stats.attacks).toEqual(["800", "320", "0"]);
  });

  it("many games between the same few players run without deadlocks", async () => {
    const { h, key, users } = await setup(3);
    const results = await Promise.all(
      Array.from({ length: 12 }, (_v, i) =>
        submitGame(
          h,
          key,
          buildRecord(gameId(), {
            // rotate the order players appear in, to provoke lock-order trouble
            players: [users[i % 3], users[(i + 1) % 3], users[(i + 2) % 3]].map(
              (user) => ({ user }),
            ),
          }),
        ),
      ),
    );
    for (const r of results) expect(r.status).toBe(200);
    for (const u of users) {
      expect(
        (
          await q(
            h,
            "SELECT total::int FROM player_stat_aggregates WHERE user_id = $1",
            [u.id],
          )
        )[0].total,
      ).toBe(12);
      expect(await creditsOf(h, u)).toBeLessThanOrEqual(
        ECONOMY.dailyGameplayCap,
      );
    }
  });
});

describeDb("repeats and retries", () => {
  it("the same record twice changes nothing the second time", async () => {
    const { h, key, users } = await setup();
    const record = buildRecord(gameId(), {
      players: [{ user: users[0] }, { user: users[1] }],
    });
    expect((await submitGame(h, key, record)).status).toBe(200);
    const snapshot = async () => ({
      credits: [await creditsOf(h, users[0]), await creditsOf(h, users[1])],
      games: await count(h, "games"),
      players: await count(h, "game_players"),
      ledger: await count(h, "currency_ledger"),
      aggregates: await q(
        h,
        "SELECT user_id, wins::int, losses::int, total::int, stats FROM player_stat_aggregates ORDER BY user_id",
      ),
    });
    const first = await snapshot();
    expect((await submitGame(h, key, record)).status).toBe(200);
    expect((await submitGame(h, key, record)).status).toBe(200);
    expect(await snapshot()).toEqual(first);
    expect(first.credits).toEqual([WIN, ECONOMY.completedGameReward]);
  });

  it("concurrent identical submissions are applied exactly once", async () => {
    const { h, key, users } = await setup();
    const record = buildRecord(gameId(), {
      players: [{ user: users[0] }, { user: users[1] }],
    });
    const results = await Promise.all(
      Array.from({ length: 10 }, () => submitGame(h, key, record)),
    );
    for (const r of results) expect(r.status).toBe(200);
    expect(await creditsOf(h, users[0])).toBe(WIN);
    expect(await creditsOf(h, users[1])).toBe(ECONOMY.completedGameReward);
    expect(await count(h, "games")).toBe(1);
    expect(await count(h, "game_records")).toBe(1);
    expect(await count(h, "game_players")).toBe(2);
    expect(await count(h, "currency_ledger")).toBe(2);
    expect(
      (
        await q(
          h,
          "SELECT total::int FROM player_stat_aggregates WHERE user_id = $1",
          [users[0].id],
        )
      )[0].total,
    ).toBe(1);
  });

  it("a submission that fails halfway leaves nothing behind, and sending it again works", async () => {
    const { h, key, users } = await setup();
    const record = buildRecord(gameId(), {
      players: [{ user: users[0] }, { user: users[1] }],
    });
    // Break the last write of the transaction (the second player's row).
    await h.db.pool.query(`
      CREATE FUNCTION fail_second() RETURNS trigger AS $$
      BEGIN
        IF NEW.user_id = '${users[1].id}' THEN RAISE EXCEPTION 'simulated interruption'; END IF;
        RETURN NEW;
      END $$ LANGUAGE plpgsql;
      CREATE TRIGGER fail_second BEFORE INSERT ON game_players
        FOR EACH ROW EXECUTE FUNCTION fail_second();
    `);
    const failed = await submitGame(h, key, record);
    expect(failed.status).toBe(500);
    for (const table of [
      "games",
      "game_records",
      "game_players",
      "player_stat_aggregates",
      "currency_ledger",
    ])
      expect(await count(h, table), table).toBe(0);
    expect(await creditsOf(h, users[0])).toBe(0);
    expect(await creditsOf(h, users[1])).toBe(0);

    await h.db.pool.query("DROP TRIGGER fail_second ON game_players");
    expect((await submitGame(h, key, record)).status).toBe(200);
    expect(await creditsOf(h, users[0])).toBe(WIN);
    expect(await creditsOf(h, users[1])).toBe(ECONOMY.completedGameReward);
    expect(await count(h, "game_players")).toBe(2);
  });

  it("the database refuses to pay one game to one player twice, whatever the application does", async () => {
    const { h, users } = await setup(1);
    const pay = (amount: number) =>
      withTransaction(h.db.pool, (tx) =>
        applyGameReward(
          tx,
          users[0].id,
          "gmDup0001",
          new Date(DEFAULT_END_MS),
          amount,
        ),
      );
    expect(await pay(100)).toBe(100);
    expect(await pay(100)).toBe(0);
    expect(await creditsOf(h, users[0])).toBe(100);
    await expect(
      h.db.pool.query(
        `INSERT INTO currency_ledger (user_id, delta, balance_after, reason, ref_type, ref_id, reward_day)
         VALUES ($1, 5, 105, 'game_reward', 'game', 'gmDup0001', '2023-11-14')`,
        [users[0].id],
      ),
    ).rejects.toThrow(/currency_ledger_game_reward_once|duplicate key/);
  });
});

describeDb("wallet safety", () => {
  it("applyGameReward ignores zero, negative and non-finite amounts", async () => {
    const { h, users } = await setup(1);
    const pay = (amount: number, game: string) =>
      withTransaction(h.db.pool, (tx) =>
        applyGameReward(
          tx,
          users[0].id,
          game,
          new Date(DEFAULT_END_MS),
          amount,
        ),
      );
    expect(await pay(0, "gmNeg0001")).toBe(0);
    expect(await pay(-50, "gmNeg0002")).toBe(0);
    expect(await pay(Number.NaN, "gmNeg0003")).toBe(0);
    expect(await pay(Number.POSITIVE_INFINITY, "gmNeg0004")).toBe(0);
    expect(await pay(ECONOMY.dailyGameplayCap * 5, "gmNeg0005")).toBe(
      ECONOMY.dailyGameplayCap,
    );
    expect(await creditsOf(h, users[0])).toBe(ECONOMY.dailyGameplayCap);
    expect(await count(h, "currency_ledger")).toBe(1);
  });

  it("the database itself refuses a negative balance", async () => {
    const { h, users } = await setup(1);
    await expect(
      h.db.pool.query("UPDATE wallets SET credits = -1 WHERE user_id = $1", [
        users[0].id,
      ]),
    ).rejects.toThrow(/credits_check|check constraint/);
  });

  it("ingestion never debits: balances only go up, and the premium currency stays 0", async () => {
    const { h, key, users } = await setup();
    const seen: number[] = [];
    for (let i = 0; i < 4; i++) {
      await submitGame(
        h,
        key,
        buildRecord(gameId(), {
          players: [{ user: users[0] }, { user: users[1] }],
        }),
      );
      seen.push(await creditsOf(h, users[0]));
    }
    expect([...seen].sort((x, y) => x - y)).toEqual(seen);
    expect(Math.min(...seen)).toBeGreaterThanOrEqual(0);
    const me = await userMe(h, users[0]);
    expect(me.body.player.currency).toEqual({ soft: seen[3], hard: 0 });
    expect(
      await q(h, "SELECT 1 FROM currency_ledger WHERE delta <= 0"),
    ).toHaveLength(0);
  });

  it("only the Credits module writes wallets and the ledger", () => {
    const root = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "../../src/account-api",
    );
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (full.endsWith(".ts")) {
          const text = fs.readFileSync(full, "utf8");
          if (
            /UPDATE\s+wallets|INSERT\s+INTO\s+currency_ledger|DELETE\s+FROM\s+(wallets|currency_ledger)/i.test(
              text,
            )
          )
            offenders.push(path.relative(root, full));
        }
      }
    };
    walk(root);
    expect(offenders).toEqual(["domain/economy.ts"]);
  });
});

describeDb("only a game server can submit results", () => {
  it("a missing, wrong or revoked key is refused and stores nothing", async () => {
    const { h, key, users } = await setup();
    const record = buildRecord(gameId(), {
      players: [{ user: users[0] }, { user: users[1] }],
    });
    const revoked = await createServerKey(h);
    await h.db.pool.query(
      "UPDATE server_api_keys SET revoked_at = now() WHERE key_hash = (SELECT key_hash FROM server_api_keys ORDER BY id DESC LIMIT 1)",
    );
    for (const bad of [undefined, "", "not-a-key", revoked, key + "x"])
      expect((await submitGame(h, bad, record)).status, String(bad)).toBe(401);
    expect(await count(h, "games")).toBe(0);
    expect(await creditsOf(h, users[0])).toBe(0);
    expect((await submitGame(h, key, record)).status).toBe(200);
  });

  it("a signed-in player's own token is not a server key, and a browser origin is refused even with a real key", async () => {
    const { h, key, users } = await setup();
    const record = buildRecord(gameId(), {
      players: [{ user: users[0] }, { user: users[1] }],
    });
    // The player's access token, as a bearer and in the key header.
    for (const headers of [
      { authorization: `Bearer ${users[0].jwt}` } as Record<string, string>,
      { "x-api-key": users[0].jwt },
    ]) {
      const res = await call(h, `/game/${record.info.gameID}`, {
        method: "POST",
        json: record,
        origin: null,
        headers,
      });
      expect(res.status).toBe(401);
    }
    // A page on the site (or anywhere) posting with a leaked key
    for (const origin of [h.origin, "https://evil.example"]) {
      const res = await call(h, `/game/${record.info.gameID}`, {
        method: "POST",
        json: record,
        origin,
        headers: { "x-api-key": key },
      });
      expect(res.status).toBe(403);
    }
    expect(await count(h, "games")).toBe(0);
    expect(await creditsOf(h, users[0])).toBe(0);
  });

  it("no endpoint lets a player change a stat or a balance", async () => {
    const { h, users } = await setup(1);
    const before = await creditsOf(h, users[0]);
    for (const [method, route] of [
      ["POST", "/game/gmSelf001"],
      ["PUT", "/users/@me"],
      ["PATCH", "/users/@me"],
      ["POST", "/users/@me/currency"],
      ["PUT", "/player/" + users[0].publicId],
      ["POST", "/player/" + users[0].publicId],
      ["POST", "/rewards/claim-all"],
      ["POST", "/archive_singleplayer_game"],
    ] as const) {
      const res = await call(h, route, {
        method,
        bearer: users[0].jwt,
        origin: null,
        json: { credits: 999999, soft: 999999, wins: 99 },
      });
      expect([401, 403, 404, 405], `${method} ${route}`).toContain(res.status);
    }
    expect(await creditsOf(h, users[0])).toBe(before);
    expect(await count(h, "player_stat_aggregates")).toBe(0);
  });

  it("malformed records are refused", async () => {
    const { h, key, users } = await setup();
    const good = () =>
      buildRecord(gameId(), {
        players: [{ user: users[0] }, { user: users[1] }],
      });
    const attempt = async (record: unknown, id?: string) =>
      (
        await submitGame(
          h,
          key,
          record,
          id ??
            (record as { info?: { gameID?: string } })?.info?.gameID ??
            "gmBad0001",
        )
      ).status;

    expect(await attempt({})).toBe(400);
    expect(await attempt({ nope: true }, "gmBad0002")).toBe(400);
    expect(await attempt(null, "gmBad0003")).toBe(400);
    expect(await attempt([], "gmBad0004")).toBe(400);
    expect(await attempt("text", "gmBad0005")).toBe(400);

    const mismatch = good();
    expect(await attempt(mismatch, "gmOther001")).toBe(400);

    const noPlayers = good() as unknown as { info: Record<string, unknown> };
    delete noPlayers.info.players;
    expect(await attempt(noPlayers, noPlayers.info.gameID as string)).toBe(400);

    const badId = good();
    (badId.info.players[0] as unknown as { clientID: string }).clientID =
      "no spaces!";
    expect(await attempt(badId)).toBe(400);

    const badStat = good();
    (
      badStat.info.players[0].stats as unknown as Record<string, unknown>
    ).attacks = "many";
    expect(await attempt(badStat)).toBe(400);

    const badWinner = good();
    (badWinner.info as unknown as Record<string, unknown>).winner = [
      "somebody",
      "pl000001",
    ];
    expect(await attempt(badWinner)).toBe(400);

    const future = good();
    future.info.end = Date.now() + 10 * DAY;
    expect(await attempt(future)).toBe(400);

    const backwards = good();
    backwards.info.end = backwards.info.start - 1;
    expect(await attempt(backwards)).toBe(400);

    const negativeDuration = good();
    negativeDuration.info.duration = -3;
    expect(await attempt(negativeDuration)).toBe(400);

    expect(await count(h, "games")).toBe(0);
    expect(await count(h, "currency_ledger")).toBe(0);
  });

  it("a body that is not JSON is a 400, not a crash", async () => {
    const { h, key } = await setup(0);
    for (const body of ["{not json", "", "\u0000"]) {
      const res = await fetch(`${h.baseUrl}/game/gmText0001`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": key },
        body,
      });
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.status).toBeLessThan(500);
    }
    // and the service is still up
    expect((await call(h, "/health", { origin: null })).status).toBe(200);
  });

  it("the archive still hands out replays without the players' account ids", async () => {
    const { h, key, users } = await setup();
    const record = buildRecord(gameId(), {
      players: [{ user: users[0] }, { user: users[1] }],
    });
    await submitGame(h, key, record);
    const res = await call(h, `/game/${record.info.gameID}`, { origin: null });
    const text = await res.text();
    expect(res.status).toBe(200);
    expect(text).not.toContain(users[0].id);
    expect(text).not.toContain(users[1].id);
  });
});
