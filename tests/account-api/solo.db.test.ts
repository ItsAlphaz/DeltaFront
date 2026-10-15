// @vitest-environment node
import {
  GameXpResponseSchema,
  ProgressionMeSchema,
  UserMeResponseSchema,
  XpHistoryEntrySchema,
} from "@openfront/shared/ApiSchemas";
import { gzipSync } from "node:zlib";
import { afterEach, expect, it } from "vitest";
import { SOLO } from "../../src/account-api/domain/constants";
import { createSoloWorker } from "../../src/account-api/jobs/solo";
import { silentLogger } from "../../src/account-api/logger";
import type { SoloReplayer } from "../../src/account-api/soloReplay";
import { creditsOf, makeUser, type TestUser } from "./util/games";
import { call, startHarness, type Harness } from "./util/harness";
import {
  gzipRecord,
  replayed,
  SOLO_CLIENT,
  soloRecord,
  stubReplayer,
  submitSolo,
  waitDecided,
  xpOf,
  type SoloRecordSpec,
} from "./util/solo";
import { describeDb } from "./util/testDb";

const ON = "accounts,store,inventory,clans,leaderboards,progression";
const harnesses: Harness[] = [];
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.close();
});

type ReplayAnswer = ReturnType<typeof replayed> | Error;
/** A harness whose solo replays answer from `answers` (by game id; a clean win otherwise). */
async function harness(features = ON) {
  const answers = new Map<string, ReplayAnswer>();
  const replayer = stubReplayer((id) => answers.get(id) ?? replayed());
  const h = await startHarness({ features, soloReplayer: replayer });
  harnesses.push(h);
  return { h, answers, replayer };
}

const q = async (h: Harness, sql: string, params: unknown[] = []) =>
  (await h.db.pool.query(sql, params)).rows;

/** Submits a solo match for `user` and waits for it to be decided. */
async function play(
  h: Harness,
  user: TestUser,
  spec: SoloRecordSpec = {},
  answers?: Map<string, ReplayAnswer>,
  answer?: ReplayAnswer,
) {
  const record = soloRecord(spec);
  const gameID = (record.info as { gameID: string }).gameID;
  if (answer !== undefined) answers?.set(gameID, answer);
  const res = await submitSolo(h, user, gzipRecord(record));
  expect([200, 202]).toContain(res.status);
  const decided = await waitDecided(h, gameID);
  return { gameID, decided, res };
}

const progressOf = async (h: Harness, user: TestUser) => {
  const [row] = await q(
    h,
    "SELECT lifetime_xp::int AS lifetime, run_xp::int AS run, prestige FROM user_progress WHERE user_id = $1",
    [user.id],
  );
  return row as { lifetime: number; run: number; prestige: number };
};
const ledgerOf = (h: Harness, user: TestUser) =>
  q(
    h,
    "SELECT delta::int AS delta, source, ref_id, reason, season_id FROM xp_ledger WHERE user_id = $1 ORDER BY id",
    [user.id],
  );
const gameXp = async (h: Harness, user: TestUser, gameID: string) => {
  const res = await xpOf(h, user, gameID);
  return { status: res.status, body: await res.json() };
};

describeDb("a solo match for XP: the upload", () => {
  it("is queued with 202, and only a registered, signed-in account may submit", async () => {
    const { h } = await harness();
    const user = await makeUser(h);
    const record = soloRecord();
    const gz = gzipRecord(record);
    const id = (record.info as { gameID: string }).gameID;

    // no session
    expect((await submitSolo(h, null, gz)).status).toBe(401);
    const ok = await submitSolo(h, user, gz);
    expect(ok.status).toBe(202);
    expect(await ok.json()).toEqual({ ok: true, status: "queued" });
    expect((await waitDecided(h, id)).status).toBe("paid");

    // a guest has a session and no XP to earn: told so, nothing kept
    const guest = await makeUser(h, "guest");
    const gres = await submitSolo(h, guest, gzipRecord(soloRecord()));
    expect(gres.status).toBe(200);
    expect(await gres.json()).toEqual({
      ok: true,
      status: "ignored",
      reason: "guest",
    });
    expect(
      await q(h, "SELECT 1 FROM solo_submissions WHERE user_id = $1", [
        guest.id,
      ]),
    ).toEqual([]);
  });

  it("refuses what is not a solo record, and says nothing about XP", async () => {
    const { h } = await harness();
    const user = await makeUser(h);
    const bad = async (body: Buffer | string, status: number) => {
      const res = await submitSolo(h, user, body);
      expect(res.status, String(status)).toBe(status);
      expect(JSON.stringify(await res.json())).not.toMatch(/\bxp\b/i);
    };
    await bad("not gzip at all", 400);
    await bad(gzipRecord("not an object"), 400);
    await bad(gzipRecord({ info: {}, turns: [] }), 400);
    // a multiplayer or ranked record
    await bad(gzipRecord(soloRecord({ claims: { gameType: "Public" } })), 400);
    // an id that could be a multiplayer game's
    await bad(gzipRecord(soloRecord({ gameID: "abCD1234ef" })), 400);
    // a staff command, forced winner and all
    await bad(
      gzipRecord(
        soloRecord({
          extraIntents: [
            {
              type: "admin_command",
              command: "force_win",
              target: SOLO_CLIENT,
              clientID: SOLO_CLIENT,
            },
          ],
        }),
      ),
      400,
    );
    // too many turns to replay
    await bad(gzipRecord(soloRecord({ turns: SOLO.maxTurns + 5 })), 400);
    expect(await q(h, "SELECT 1 FROM solo_submissions")).toEqual([]);
    expect(await q(h, "SELECT 1 FROM games")).toEqual([]);
  });

  it("takes the player from the session, never from the record", async () => {
    const { h } = await harness();
    const [me, other] = [await makeUser(h), await makeUser(h)];
    const { gameID } = await play(h, me, { persistentID: other.id });
    expect((await ledgerOf(h, me)).length).toBe(1);
    expect(await ledgerOf(h, other)).toEqual([]);
    const [row] = await q(
      h,
      "SELECT p.user_id::text AS user_id FROM game_players p JOIN games g ON g.id = p.game_id WHERE g.game_code = $1",
      [gameID],
    );
    expect(row.user_id).toBe(me.id);
  });

  it("is limited to a day's worth per account", async () => {
    const { h } = await harness();
    const user = await makeUser(h);
    // fill the day with decided rows
    for (let i = 0; i < SOLO.maxPerDay; i++) {
      await q(
        h,
        `INSERT INTO solo_submissions (game_code, user_id, status, finished_at, reason)
         VALUES ($1, $2, 'rejected', now(), 'desync')`,
        [`full${String(i).padStart(4, "0")}`, user.id],
      );
    }
    const res = await submitSolo(h, user, gzipRecord(soloRecord()));
    expect(res.status).toBe(429);
    // another account is not affected
    const other = await makeUser(h);
    expect((await submitSolo(h, other, gzipRecord(soloRecord()))).status).toBe(
      202,
    );
  });
});

describeDb("a solo match pays lifetime XP, and only lifetime XP", () => {
  it("writes the award to lifetime XP, run XP and the ledger: a full win is 350", async () => {
    const { h } = await harness();
    const user = await makeUser(h);
    const { gameID, decided } = await play(h, user);
    expect(decided.status).toBe("paid");
    expect(await progressOf(h, user)).toMatchObject({
      lifetime: 350,
      run: 350,
      prestige: 0,
    });
    expect(await ledgerOf(h, user)).toEqual([
      {
        delta: 350,
        source: "match",
        ref_id: gameID,
        reason: "solo",
        season_id: null,
      },
    ]);
    // the record that was stored for it
    const [game] = await q(
      h,
      `SELECT g.source, g.type, g.counts_for_stats, g.human_players, g.difficulty,
              p.result, p.completed, p.credits_awarded::int AS credits, p.xp_awarded::int AS xp, p.clan_xp::int AS clan_xp, p.clan_id
         FROM games g JOIN game_players p ON p.game_id = g.id WHERE g.game_code = $1`,
      [gameID],
    );
    expect(game).toEqual({
      source: "singleplayer",
      type: "Singleplayer",
      counts_for_stats: false,
      human_players: 1,
      difficulty: "Hard",
      result: "victory",
      completed: false,
      credits: 0,
      xp: 350,
      clan_xp: 0,
      clan_id: null,
    });
  });

  it("moves the level, the rank and a prestige that is ready", async () => {
    const { h } = await harness();
    const user = await makeUser(h);
    // 7,000 run XP is level 9 (Recruit); 350 more is level 10 (Private)
    await q(
      h,
      "INSERT INTO user_progress (user_id, lifetime_xp, run_xp, prestige) VALUES ($1, 7000, 7000, 0)",
      [user.id],
    );
    const me = async () =>
      UserMeResponseSchema.parse(
        await (
          await call(h, "/users/@me", { bearer: user.jwt, origin: null })
        ).json(),
      ).player.progress!;
    expect(await me()).toMatchObject({ level: 9, rank: "recruit" });
    await play(h, user);
    expect(await me()).toMatchObject({
      level: 10,
      rank: "private",
      lifetimeXp: 7350,
    });
    // a level-10 milestone reward unlocked, as for any other XP
    expect(
      await q(h, "SELECT key FROM progression_rewards WHERE user_id = $1", [
        user.id,
      ]),
    ).toEqual([{ key: "level:p0:10" }]);

    // 100 XP short of the last level, on the last prestige: solo XP takes it to a prestige that is ready
    const near = await makeUser(h);
    await q(
      h,
      "INSERT INTO user_progress (user_id, lifetime_xp, run_xp, prestige) VALUES ($1, 3000000, 524700, 9)",
      [near.id],
    );
    await play(h, near);
    const after = UserMeResponseSchema.parse(
      await (
        await call(h, "/users/@me", { bearer: near.jwt, origin: null })
      ).json(),
    ).player.progress!;
    expect(after).toMatchObject({ level: 100, canPrestige: true, prestige: 9 });
  });

  it("adds no season XP, no challenge progress and no clan XP", async () => {
    const { h } = await harness();
    const user = await makeUser(h);
    const [season] = await q(
      h,
      `INSERT INTO seasons (number, name, starts_at, ends_at)
       VALUES (1, 'Season', now() - interval '1 day', now() + interval '30 days') RETURNING id::text AS id`,
    );
    const [clan] = await q(
      h,
      `INSERT INTO clans (tag, name, created_by) VALUES ('DLT', 'Delta Test', $1) RETURNING id`,
      [user.id],
    );
    await q(
      h,
      "INSERT INTO clan_members (clan_id, user_id, role) VALUES ($1, $2, 'leader')",
      [clan.id, user.id],
    );
    // even a record that names the clan's tag gets nothing for it
    const record = soloRecord();
    (
      record.info as { players: Array<{ clanTag: string | null }> }
    ).players[0].clanTag = "DLT";
    const id = (record.info as { gameID: string }).gameID;
    await submitSolo(h, user, gzipRecord(record));
    await waitDecided(h, id);

    expect((await progressOf(h, user)).lifetime).toBe(350);
    // the season: not a row, not an amount on the ledger
    expect(
      await q(
        h,
        "SELECT xp FROM user_season_progress WHERE season_id = $1 AND user_id = $2",
        [season.id, user.id],
      ),
    ).toEqual([]);
    expect((await ledgerOf(h, user))[0].season_id).toBeNull();
    // the challenges
    expect(
      await q(h, "SELECT 1 FROM challenge_progress WHERE user_id = $1", [
        user.id,
      ]),
    ).toEqual([]);
    // the clan
    const [p] = await q(
      h,
      "SELECT p.clan_xp::int AS clan_xp, p.clan_id, p.clan_tag FROM game_players p JOIN games g ON g.id = p.game_id WHERE g.game_code = $1",
      [id],
    );
    expect(p).toEqual({ clan_xp: 0, clan_id: null, clan_tag: null });
    // and the stored result says so
    const { body } = await gameXp(h, user, id);
    expect(body.season).toBeNull();
    expect(body.challenges).toEqual([]);
  });

  it("feeds no stats, Credits, leaderboard, daily bonus or clan threshold", async () => {
    const { h } = await harness();
    const user = await makeUser(h);
    const before = await creditsOf(h, user);
    await play(h, user);
    expect(await creditsOf(h, user)).toBe(before);
    expect(
      await q(h, "SELECT 1 FROM player_stat_aggregates WHERE user_id = $1", [
        user.id,
      ]),
    ).toEqual([]);
    // the clan-creation threshold counts completed games: a solo match is not one
    expect(
      await q(
        h,
        "SELECT 1 FROM game_players WHERE user_id = $1 AND completed",
        [user.id],
      ),
    ).toEqual([]);
    // the day's first-game and first-win bonuses are not spent by it
    const [daily] = await q(
      h,
      "SELECT match_xp::int AS match_xp, first_game_ref, first_win_ref FROM xp_daily WHERE user_id = $1",
      [user.id],
    );
    expect(daily).toEqual({
      match_xp: 350,
      first_game_ref: null,
      first_win_ref: null,
    });
  });

  it("counts towards the daily soft cap like any other match XP", async () => {
    const { h } = await harness();
    const user = await makeUser(h);
    const today = new Date().toISOString().slice(0, 10);
    await q(
      h,
      "INSERT INTO xp_daily (user_id, day, match_xp) VALUES ($1, $2::date, 6000)",
      [user.id, today],
    );
    const { gameID } = await play(h, user);
    // over the line: a quarter of 350
    expect((await ledgerOf(h, user))[0].delta).toBe(87);
    const { body } = await gameXp(h, user, gameID);
    expect(body.breakdown.softCapped).toBe(true);
  });
});

describeDb("when a solo match happened is when it was received", () => {
  it("a record cannot pick the UTC day whose soft cap it falls under", async () => {
    const { h } = await harness();
    const user = await makeUser(h);
    const today = new Date().toISOString().slice(0, 10);
    // today's soft cap is spent; the record claims it ended three days ago
    await q(
      h,
      "INSERT INTO xp_daily (user_id, day, match_xp) VALUES ($1, $2::date, 6000)",
      [user.id, today],
    );
    const { gameID } = await play(h, user, {
      endMs: Date.now() - 3 * 86_400_000,
    });
    // paid at the soft-cap rate, as today's: not a fresh day's 350
    expect((await ledgerOf(h, user))[0].delta).toBe(87);
    const [daily] = await q(
      h,
      "SELECT day::text AS day FROM xp_daily WHERE user_id = $1 ORDER BY day",
      [user.id],
    );
    expect(daily.day).toBe(today);
    expect(
      await q(
        h,
        "SELECT 1 FROM xp_daily WHERE user_id = $1 AND day <> $2::date",
        [user.id, today],
      ),
    ).toEqual([]);
    // and the stored game is dated by receipt, not by the claim
    const [g] = await q(
      h,
      "SELECT ended_at::date::text AS day FROM games WHERE game_code = $1",
      [gameID],
    );
    expect(g.day).toBe(today);
  });
});

describeDb("a solo match is paid once", () => {
  it("a repeat of the same upload awards nothing more", async () => {
    const { h, replayer } = await harness();
    const user = await makeUser(h);
    const record = soloRecord();
    const gz = gzipRecord(record);
    const id = (record.info as { gameID: string }).gameID;
    expect((await submitSolo(h, user, gz)).status).toBe(202);
    await waitDecided(h, id);
    const again = await submitSolo(h, user, gz);
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ ok: true, status: "duplicate" });
    expect((await progressOf(h, user)).lifetime).toBe(350);
    expect(await ledgerOf(h, user)).toHaveLength(1);
    expect(replayer.calls).toEqual([id]);
  });

  it("still once after the submission row is gone (pruned), and for submissions that race", async () => {
    const { h } = await harness();
    const user = await makeUser(h);
    const record = soloRecord();
    const gz = gzipRecord(record);
    const id = (record.info as { gameID: string }).gameID;
    // two uploads at the same moment
    const both = await Promise.all([
      submitSolo(h, user, gz),
      submitSolo(h, user, gz),
    ]);
    expect(both.map((r) => r.status).sort()).toEqual([200, 202]);
    await waitDecided(h, id);
    await q(h, "DELETE FROM solo_submissions WHERE game_code = $1", [id]);
    const late = await submitSolo(h, user, gz);
    expect(await late.json()).toEqual({ ok: true, status: "duplicate" });
    expect((await progressOf(h, user)).lifetime).toBe(350);
    expect(await ledgerOf(h, user)).toHaveLength(1);
  });

  it("the database refuses a second payment for a game whatever the code does", async () => {
    const { h } = await harness();
    const user = await makeUser(h);
    const { gameID } = await play(h, user);
    await expect(
      q(
        h,
        `INSERT INTO xp_ledger (user_id, source, ref_type, ref_id, delta, lifetime_before, lifetime_after)
         VALUES ($1, 'match', 'game', $2, 350, 350, 700)`,
        [user.id, gameID],
      ),
    ).rejects.toThrow();
  });

  it("one account cannot take another's game code, and a code cannot be a multiplayer game's", async () => {
    const { h } = await harness();
    const [a, b] = [await makeUser(h), await makeUser(h)];
    const record = soloRecord();
    const id = (record.info as { gameID: string }).gameID;
    await submitSolo(h, a, gzipRecord(record));
    await waitDecided(h, id);
    const stolen = await submitSolo(h, b, gzipRecord(record));
    expect(await stolen.json()).toEqual({ ok: true, status: "duplicate" });
    expect(await ledgerOf(h, b)).toEqual([]);
  });
});

describeDb(
  "the setup is what the replay found, never what the record says",
  () => {
    it("a record that claims the best setup but replays as the worst earns the floor", async () => {
      const { h, answers } = await harness();
      const user = await makeUser(h);
      const { gameID } = await play(
        h,
        user,
        {
          claims: {
            bots: 400,
            nations: 400,
            difficulty: "Impossible",
            infiniteGold: false,
            infiniteTroops: false,
            instantBuild: false,
          },
        },
        answers,
        replayed({
          tribes: 2,
          nations: 0,
          difficulty: "Easy",
          cheats: {
            instantBuild: true,
            infiniteGold: true,
            infiniteTroops: true,
          },
        }),
      );
      // 350 x 0.10
      expect((await progressOf(h, user)).lifetime).toBe(35);
      const { body } = await gameXp(h, user, gameID);
      const parsed = GameXpResponseSchema.parse(body);
      expect(parsed.eligible && parsed.breakdown.solo).toMatchObject({
        multiplierPermille: 100,
        failed: 6,
        difficulty: "Easy",
        tribes: 2,
        nations: 0,
      });
      // and the game row says what was played, not what was claimed
      const [g] = await q(
        h,
        "SELECT difficulty FROM games WHERE game_code = $1",
        [gameID],
      );
      expect(g.difficulty).toBe("Easy");
    });

    it("each cheat the replay finds costs 0.20, wherever it was set", async () => {
      const { h, answers } = await harness();
      const user = await makeUser(h);
      const totals: Record<string, number> = {};
      for (const [name, cheats] of [
        [
          "instant",
          { instantBuild: true, infiniteGold: false, infiniteTroops: false },
        ],
        [
          "gold",
          { instantBuild: false, infiniteGold: true, infiniteTroops: false },
        ],
        [
          "troops",
          { instantBuild: false, infiniteGold: false, infiniteTroops: true },
        ],
      ] as const) {
        const { gameID } = await play(
          h,
          user,
          {},
          answers,
          replayed({ cheats }),
        );
        totals[name] = (await ledgerOf(h, user)).find(
          (l) => l.ref_id === gameID,
        )!.delta;
      }
      expect(totals).toEqual({ instant: 280, gold: 280, troops: 280 });
    });

    it("nothing outside the record's body can choose the multiplier: query, headers, extra fields", async () => {
      const { h, answers } = await harness();
      const user = await makeUser(h);
      const record = soloRecord();
      const id = (record.info as { gameID: string }).gameID;
      (record as Record<string, unknown>).soloMultiplier = 5000;
      (record as Record<string, unknown>).xp = 99999;
      (record.info as Record<string, unknown>).difficulty = "Impossible";
      answers.set(
        id,
        replayed({ difficulty: "Medium", tribes: 10, nations: 10 }),
      );
      const res = await fetch(
        `${h.baseUrl}/archive_singleplayer_game?difficulty=Impossible&multiplier=1&xp=99999`,
        {
          method: "POST",
          headers: {
            "Content-Encoding": "gzip",
            Authorization: `Bearer ${user.jwt}`,
            "X-Difficulty": "Impossible",
            "X-XP": "99999",
          },
          body: new Uint8Array(gzipRecord(record)),
        },
      );
      expect(res.status).toBe(202);
      await waitDecided(h, id);
      // three criteria missed (tribes, nations, difficulty): 350 x 0.40
      expect((await progressOf(h, user)).lifetime).toBe(140);
    });
  },
);

describeDb("what is not believed is not paid", () => {
  const refused = async (
    answer: ReplayAnswer,
    reason: string,
    spec: SoloRecordSpec = {},
  ) => {
    const { h, answers } = await harness();
    const user = await makeUser(h);
    const { gameID, decided } = await play(h, user, spec, answers, answer);
    expect(decided).toEqual({ status: "rejected", reason });
    expect(await ledgerOf(h, user)).toEqual([]);
    expect(await q(h, "SELECT 1 FROM games")).toEqual([]);
    // the record is dropped once decided
    const [row] = await q(
      h,
      "SELECT record_gz IS NULL AS gone FROM solo_submissions WHERE game_code = $1",
      [gameID],
    );
    expect(row.gone).toBe(true);
    return { h, user, gameID };
  };

  it("a record that does not reproduce its hashes", async () => {
    const { h, user, gameID } = await refused(
      replayed({ hashes: { checked: 5, mismatched: 2 } }),
      "desync",
    );
    // the player is told, in a reason the panel has words for
    const { status, body } = await gameXp(h, user, gameID);
    expect(status).toBe(200);
    expect(body).toEqual({
      gameId: gameID,
      eligible: false,
      reason: "solo_unverified",
    });
  });

  it("a record with nothing to compare", async () => {
    await refused(
      replayed({ hashes: { checked: 0, mismatched: 0 } }),
      "no_proof",
    );
  });

  it("a match left unfinished while still in it: leaving early", async () => {
    const { h, user, gameID } = await refused(
      replayed({ winner: undefined, tick: null }),
      "no_result",
    );
    expect((await gameXp(h, user, gameID)).body.reason).toBe("left_early");
  });

  it("a player who never took an action", async () => {
    const { h, user, gameID } = await refused(replayed(), "no_action", {
      idle: true,
    });
    expect((await gameXp(h, user, gameID)).body.reason).toBe("no_action");
  });

  it("a player who never spawned", async () => {
    const { h, user, gameID } = await refused(
      replayed({
        humans: [{ clientID: SOLO_CLIENT, spawned: false, alive: false }],
      }),
      "not_spawned",
    );
    expect((await gameXp(h, user, gameID)).body.reason).toBe("not_spawned");
  });

  it("an account that is gone by the time the replay finishes", async () => {
    const { h, answers } = await harness();
    const user = await makeUser(h);
    const record = soloRecord();
    const id = (record.info as { gameID: string }).gameID;
    answers.set(id, replayed());
    await submitSolo(h, user, gzipRecord(record));
    await waitDecided(h, id);
    expect((await ledgerOf(h, user)).length).toBe(1);
    // a different, deleted account
    const gone = await makeUser(h);
    await q(h, "UPDATE users SET deleted_at = now() WHERE id = $1", [gone.id]);
    // (a deleted account cannot even authenticate)
    expect((await submitSolo(h, gone, gzipRecord(soloRecord()))).status).toBe(
      401,
    );
  });
});

describeDb("how a match ends decides what it pays", () => {
  it("defeat 100, eliminated 25, short 25, all times the setup multiplier", async () => {
    const { h, answers } = await harness();
    const user = await makeUser(h);
    const cases = [
      // still in it, someone else won: completed match
      ["defeat", replayed({ winner: ["nation", "Rome"] }), 100],
      // lost every tile: a quarter of the completed match
      [
        "eliminated",
        replayed({
          winner: undefined,
          tick: null,
          humans: [{ clientID: SOLO_CLIENT, spawned: true, alive: false }],
        }),
        25,
      ],
      // won, but in under two minutes: reduced
      ["short win", replayed({ ticks: 900, tick: 900 }), 25],
    ] as const;
    for (const [name, answer, xp] of cases) {
      const { gameID } = await play(h, user, {}, answers, answer);
      const entry = (await ledgerOf(h, user)).find((l) => l.ref_id === gameID);
      expect(entry?.delta, name).toBe(xp);
      expect(entry?.reason, name).toBe("solo");
    }
    // and the breakdowns say why
    const rows = await q(
      h,
      "SELECT xp_result -> 'breakdown' ->> 'reducedReason' AS why FROM game_players WHERE user_id = $1 ORDER BY game_id",
      [user.id],
    );
    expect(rows.map((r) => r.why)).toEqual([null, "eliminated", "short_game"]);
  });
});

describeDb("the post-game breakdown", () => {
  it("lists the six criteria exactly as they were met, with the multiplier and total", async () => {
    const { h, answers } = await harness();
    const user = await makeUser(h);
    const { gameID } = await play(
      h,
      user,
      {},
      answers,
      // fails difficulty (Medium) only
      replayed({ difficulty: "Medium", tribes: 45, nations: 50 }),
    );
    const { status, body } = await gameXp(h, user, gameID);
    expect(status).toBe(200);
    const parsed = GameXpResponseSchema.parse(body);
    expect(parsed.eligible).toBe(true);
    if (!parsed.eligible) return;
    expect(parsed.mode).toBe("solo");
    expect(parsed.breakdown).toMatchObject({
      played: 100,
      win: 250,
      subtotal: 350,
      soloPermille: 800,
      total: 280,
      gamePermille: 1000,
    });
    expect(parsed.breakdown.solo).toEqual({
      multiplierPermille: 800,
      failed: 1,
      difficulty: "Medium",
      tribes: 45,
      nations: 50,
      criteria: [
        { key: "tribes", met: true },
        { key: "nations", met: true },
        { key: "instant_build", met: true },
        { key: "infinite_gold", met: true },
        { key: "infinite_troops", met: true },
        { key: "difficulty", met: false },
      ],
    });
    expect(parsed.season).toBeNull();
    expect(parsed.after.lifetimeXp).toBe(280);
  });

  it("is the same breakdown the XP history draws its line from", async () => {
    const { h, answers } = await harness();
    const user = await makeUser(h);
    await play(h, user, {}, answers, replayed({ tribes: 20 }));
    const res = await call(h, "/progression/me", {
      bearer: user.jwt,
      origin: null,
    });
    const me = ProgressionMeSchema.parse(await res.json());
    expect(me.history).toHaveLength(1);
    expect(me.history[0]).toMatchObject({
      amount: 280,
      source: "match",
      detail: "solo",
      solo: {
        difficulty: "Hard",
        tribes: 20,
        nations: 40,
        multiplierPermille: 800,
      },
    });
    expect(XpHistoryEntrySchema.safeParse(me.history[0]).success).toBe(true);
  });

  it("is not there yet while the replay is still running", async () => {
    // a replayer that waits to be released
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const replayer = stubReplayer(replayed());
    const slow: typeof replayer = Object.assign(
      async (...args: Parameters<typeof replayer>) => {
        await gate;
        return replayer(...args);
      },
      { calls: replayer.calls },
    );
    const h = await startHarness({ features: ON, soloReplayer: slow });
    harnesses.push(h);
    const user = await makeUser(h);
    const record = soloRecord();
    const id = (record.info as { gameID: string }).gameID;
    expect((await submitSolo(h, user, gzipRecord(record))).status).toBe(202);
    expect((await xpOf(h, user, id)).status).toBe(404);
    release();
    await waitDecided(h, id);
    expect((await xpOf(h, user, id)).status).toBe(200);
  });
});

describeDb("replays that fail for their own reasons", () => {
  it("are tried again, then refused as unverifiable, and never paid", async () => {
    const { h, answers, replayer } = await harness();
    const user = await makeUser(h);
    const record = soloRecord();
    const id = (record.info as { gameID: string }).gameID;
    answers.set(id, new Error("replay timed out"));
    await submitSolo(h, user, gzipRecord(record));
    const decided = await waitDecided(h, id);
    expect(decided).toEqual({ status: "rejected", reason: "verify_failed" });
    expect(replayer.calls.filter((c) => c === id)).toHaveLength(
      SOLO.maxAttempts,
    );
    expect(await ledgerOf(h, user)).toEqual([]);
  });

  it("a replay that works the second time pays once", async () => {
    let calls = 0;
    const replayer = stubReplayer(() =>
      ++calls === 1 ? new Error("crash") : replayed(),
    );
    const h = await startHarness({ features: ON, soloReplayer: replayer });
    harnesses.push(h);
    const user = await makeUser(h);
    const record = soloRecord();
    const id = (record.info as { gameID: string }).gameID;
    await submitSolo(h, user, gzipRecord(record));
    expect((await waitDecided(h, id)).status).toBe("paid");
    expect(await ledgerOf(h, user)).toHaveLength(1);
  });
});

describeDb("a replay that runs out of time", () => {
  it("is refused at once, not tried again: it would only run out again", async () => {
    const calls: string[] = [];
    const replayer: SoloReplayer = async (start) => {
      calls.push(start.gameID);
      return { ok: false, error: "replay timed out", timedOut: true };
    };
    const h = await startHarness({ features: ON, soloReplayer: replayer });
    harnesses.push(h);
    const user = await makeUser(h);
    const record = soloRecord();
    const id = (record.info as { gameID: string }).gameID;
    await submitSolo(h, user, gzipRecord(record));
    expect(await waitDecided(h, id)).toEqual({
      status: "rejected",
      reason: "verify_failed",
    });
    expect(calls).toEqual([id]);
  });
});

describeDb("the body is only read for an account that may upload", () => {
  it("answers a guest, a banned account and no session before reading what they sent", async () => {
    const { h } = await harness();
    const guest = await makeUser(h, "guest");
    const banned = await makeUser(h);
    await q(
      h,
      "INSERT INTO bans (user_id, category, reason) VALUES ($1, 'test', 'x')",
      [banned.id],
    );
    // a body that would be refused as "not gzip" (400) if it were read first
    const junk = Buffer.from("this is not a record");
    expect((await submitSolo(h, null, junk)).status).toBe(401);
    expect((await submitSolo(h, guest, junk)).status).toBe(200);
    expect((await submitSolo(h, banned, junk)).status).toBe(403);
  });

  it("refuses an upload that unpacks to more than the limit as it grows (413)", async () => {
    const { h } = await harness();
    const user = await makeUser(h);
    // a few hundred kilobytes of zeroes that unpack to far more than 32 MB
    const bomb = gzipSync(Buffer.alloc(SOLO.maxRecordBytes + 1024 * 1024));
    expect(bomb.length).toBeLessThan(200_000);
    const res = await submitSolo(h, user, bomb);
    expect(res.status).toBe(413);
    expect(await q(h, "SELECT 1 FROM solo_submissions")).toEqual([]);
  });
});

describeDb("the queue survives a restart", () => {
  it("takes a submission that was waiting, and one that was being replayed when the process died", async () => {
    // a harness with progression off has no worker of its own: the test drives one
    const { h } = await harness("accounts");
    const user = await makeUser(h);
    const replayer = stubReplayer(replayed());
    const worker = createSoloWorker(h.db.pool, {
      log: silentLogger,
      replayer,
      progression: { validFlares: null },
    });
    const waiting = soloRecord();
    const waitingId = (waiting.info as { gameID: string }).gameID;
    const crashed = soloRecord();
    const crashedId = (crashed.info as { gameID: string }).gameID;
    expect(
      await worker.submit({
        userId: user.id,
        gameCode: waitingId,
        gz: gzipRecord(waiting),
      }),
    ).toEqual({ status: "queued" });
    // a row that was running an hour ago
    await q(
      h,
      `INSERT INTO solo_submissions (game_code, user_id, record_gz, status, started_at)
       VALUES ($1, $2, $3, 'running', now() - interval '3 hours')`,
      [crashedId, user.id, gzipRecord(crashed)],
    );
    await worker.drain();
    const rows = await q(
      h,
      "SELECT status FROM solo_submissions ORDER BY created_at",
    );
    expect(rows.map((r) => r.status)).toEqual(["paid", "paid"]);
    expect(replayer.calls.sort()).toEqual([crashedId, waitingId].sort());
  });

  it("leaves a submission that is being replayed right now alone", async () => {
    const { h } = await harness("accounts");
    const user = await makeUser(h);
    const replayer = stubReplayer(replayed());
    const worker = createSoloWorker(h.db.pool, {
      log: silentLogger,
      replayer,
      progression: { validFlares: null },
    });
    const record = soloRecord();
    await q(
      h,
      `INSERT INTO solo_submissions (game_code, user_id, record_gz, status, started_at)
       VALUES ($1, $2, $3, 'running', now())`,
      [(record.info as { gameID: string }).gameID, user.id, gzipRecord(record)],
    );
    expect(await worker.runOnce()).toBe(false);
    expect(replayer.calls).toEqual([]);
  });

  it("prunes decided rows after the retention period", async () => {
    const { h } = await harness("accounts");
    const user = await makeUser(h);
    await q(
      h,
      `INSERT INTO solo_submissions (game_code, user_id, status, reason, finished_at) VALUES
         ('oldpaid1', $1, 'paid', NULL, now() - interval '40 days'),
         ('oldrej01', $1, 'rejected', 'desync', now() - interval '40 days'),
         ('freshrj1', $1, 'rejected', 'desync', now() - interval '1 day')`,
      [user.id],
    );
    // the worker prunes as it starts its loop
    const worker = createSoloWorker(h.db.pool, {
      log: silentLogger,
      replayer: stubReplayer(replayed()),
      progression: { validFlares: null },
      pollMs: 20,
    });
    worker.start();
    for (let i = 0; i < 100; i++) {
      const left = await q(h, "SELECT game_code FROM solo_submissions");
      if (left.length === 1) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    await worker.stop();
    expect(await q(h, "SELECT game_code FROM solo_submissions")).toEqual([
      { game_code: "freshrj1" },
    ]);
  });
});

describeDb("with progression off", () => {
  it("the route is not served: nothing is queued, nothing is paid", async () => {
    const { h } = await harness("accounts");
    const user = await makeUser(h);
    const res = await submitSolo(h, user, gzipRecord(soloRecord()));
    expect(res.status).toBe(404);
    expect(await q(h, "SELECT 1 FROM solo_submissions")).toEqual([]);
  });
});
