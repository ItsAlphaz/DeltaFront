// @vitest-environment node
import {
  GameXpResponseSchema,
  ProgressionConfigSchema,
  ProgressionMeSchema,
  PublicProgressSchema,
  UserMeResponseSchema,
  XpLeaderboardResponseSchema,
  type XpLeaderboardResponse,
} from "@openfront/shared/ApiSchemas";
import { levelFromRunXp, MAX_RUN_XP } from "@openfront/shared/ProgressionRules";
import { afterEach, expect, it } from "vitest";
import {
  buildRecord,
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

const ON = "accounts,store,inventory,clans,leaderboards,progression";
const harnesses: Harness[] = [];
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.close();
});

async function harness(features = ON) {
  const h = await startHarness({ features });
  harnesses.push(h);
  return h;
}

const q = async (h: Harness, sql: string, params: unknown[] = []) =>
  (await h.db.pool.query(sql, params)).rows;

const get = (h: Harness, who: TestUser | null, route: string) =>
  call(h, route, { bearer: who?.jwt, origin: null });
const send = (
  h: Harness,
  who: TestUser | null,
  method: string,
  route: string,
  json?: unknown,
  headers: Record<string, string> = {},
) => call(h, route, { method, bearer: who?.jwt, origin: null, json, headers });

/** Puts an account at a given run XP and prestige. */
async function seed(
  h: Harness,
  user: TestUser,
  runXp: number,
  prestige = 0,
  lifetime = runXp,
) {
  await q(
    h,
    `INSERT INTO user_progress (user_id, lifetime_xp, run_xp, prestige) VALUES ($1, $2, $3, $4)
     ON CONFLICT (user_id) DO UPDATE SET lifetime_xp = $2, run_xp = $3, prestige = $4`,
    [user.id, lifetime, runXp, prestige],
  );
}

let seq = 0;
const gameId = () => `ap${String(++seq).padStart(6, "0")}`;

function ffa(users: TestUser[]): GameSpec {
  return {
    allAct: true,
    players: users.map((user, i) =>
      i === 0 ? { user } : { user, fate: { killedAt: 4000 - i * 100 } },
    ),
  };
}

describeDb("/users/@me progression fields", () => {
  it("carries level, rank, title, hide-my-level and unclaimed rewards while progression is on", async () => {
    const h = await harness();
    const user = await makeUser(h);
    await seed(h, user, 7_270); // level 10
    await q(
      h,
      "INSERT INTO progression_rewards (user_id, key, kind, credits) VALUES ($1, 'level:p0:10', 'level_milestone', 500)",
      [user.id],
    );
    const res = await get(h, user, "/users/@me");
    expect(res.status).toBe(200);
    const body = UserMeResponseSchema.parse(await res.json());
    expect(body.player.progress).toMatchObject({
      level: 10,
      prestige: 0,
      xpInLevel: 0,
      xpForNext: 1200,
      lifetimeXp: 7_270,
      legend: false,
      canPrestige: false,
      rank: "private",
      title: null,
    });
    expect(body.player.levelHidden).toBe(false);
    expect(body.player.rewards).toEqual([
      {
        id: expect.any(String),
        currencyType: "soft",
        amount: "500",
        reason: "level_milestone",
        note: null,
      },
    ]);
  });

  it("starts a registered account at level 1, gives a guest no level, and is silent while progression is off", async () => {
    const h = await harness();
    const fresh = await makeUser(h);
    const guest = await makeUser(h, "guest");
    const progress = (await (await get(h, fresh, "/users/@me")).json()).player
      .progress;
    expect(progress).toMatchObject({ level: 1, xpInLevel: 0, xpForNext: 500 });
    expect(
      (await (await get(h, guest, "/users/@me")).json()).player.progress,
    ).toBeUndefined();

    const off = await harness("accounts");
    const user = await makeUser(off);
    const player = (await (await get(off, user, "/users/@me")).json()).player;
    expect(player.progress).toBeUndefined();
    expect(player.levelHidden).toBeUndefined();
    expect(player.rewards).toBeUndefined();
  });

  it("tells the game server nothing a client chose: the badge fields are the stored ones", async () => {
    const h = await harness();
    const user = await makeUser(h);
    await seed(h, user, MAX_RUN_XP, 10, 9_000_000);
    const progress = (await (await get(h, user, "/users/@me")).json()).player
      .progress;
    expect(progress).toMatchObject({
      level: 100,
      prestige: 10,
      legend: true,
      canPrestige: false,
      rank: "supreme_commander",
    });
  });
});

describeDb("GET /users/@me/xp/:gameId", () => {
  it("answers the XP of the caller's own game, and nothing about anyone else's", async () => {
    const h = await harness();
    const key = await createServerKey(h);
    const users = [];
    for (let i = 0; i < 6; i++) users.push(await makeUser(h));
    const id = gameId();
    await submitGame(h, key, buildRecord(id, ffa(users)));

    const res = await get(h, users[0], `/users/@me/xp/${id}`);
    expect(res.status).toBe(200);
    const body = GameXpResponseSchema.parse(await res.json());
    if (!body.eligible) throw new Error("expected eligible");
    expect(body.gameId).toBe(id);
    expect(body.breakdown.total).toBe(750);
    expect(body.breakdown.gamePermille).toBe(1000);
    expect(body.before).toMatchObject({ level: 1 });
    expect(body.after.rank).toBeDefined();

    expect((await get(h, users[0], "/users/@me/xp/zz999999")).status).toBe(404);
    expect((await get(h, users[0], "/users/@me/xp/not-an-id!!")).status).toBe(
      404,
    );
    const outsider = await makeUser(h);
    expect((await get(h, outsider, `/users/@me/xp/${id}`)).status).toBe(404);
    expect((await get(h, null, `/users/@me/xp/${id}`)).status).toBe(401);
  });

  it("explains an ineligible game, and a game from before progression", async () => {
    const h = await harness();
    const key = await createServerKey(h);
    const users = [];
    for (let i = 0; i < 4; i++) users.push(await makeUser(h));
    const priv = gameId();
    // a game that was too short to earn anything, even a reduced award
    await submitGame(
      h,
      key,
      buildRecord(priv, { ...ffa(users), durationSeconds: 60 }),
    );
    const res = GameXpResponseSchema.parse(
      await (await get(h, users[0], `/users/@me/xp/${priv}`)).json(),
    );
    expect(res).toEqual({
      gameId: priv,
      eligible: false,
      reason: "too_short",
    });

    const old = gameId();
    await submitGame(h, key, buildRecord(old, ffa(users)));
    await q(h, "UPDATE game_players SET xp_result = NULL");
    expect(
      await (await get(h, users[0], `/users/@me/xp/${old}`)).json(),
    ).toEqual({ gameId: old, eligible: false, reason: "before_progression" });
  });
});

describeDb("prestige", () => {
  const prestige = (h: Harness, who: TestUser, key = "key-0123456789") =>
    send(h, who, "POST", "/users/@me/prestige", undefined, {
      "Idempotency-Key": key,
    });

  it("is refused below level 100, with no idempotency key, and for a guest", async () => {
    const h = await harness();
    const user = await makeUser(h);
    await seed(h, user, MAX_RUN_XP - 1);
    expect((await prestige(h, user)).status).toBe(409);
    await seed(h, user, MAX_RUN_XP);
    expect((await send(h, user, "POST", "/users/@me/prestige")).status).toBe(
      400,
    );
    expect(
      (
        await send(h, user, "POST", "/users/@me/prestige", undefined, {
          "Idempotency-Key": "short",
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await send(h, null, "POST", "/users/@me/prestige", undefined, {
          "Idempotency-Key": "key-0123456789",
        })
      ).status,
    ).toBe(401);
    const guest = await makeUser(h, "guest");
    expect((await prestige(h, guest)).status).toBe(409);
    expect(
      (
        await q(h, "SELECT prestige FROM user_progress WHERE user_id = $1", [
          user.id,
        ])
      )[0].prestige,
    ).toBe(0);
  });

  it("resets the run and nothing else", async () => {
    const h = await harness();
    const key = await createServerKey(h);
    const players = [];
    for (let i = 0; i < 6; i++) players.push(await makeUser(h));
    const user = players[0];
    // an account with history: a game, Credits, a cosmetic, a clan, a role, season XP
    await submitGame(h, key, buildRecord(gameId(), ffa(players)));
    const [clan] = await q(
      h,
      "INSERT INTO clans (tag, name, created_by) VALUES ('KEEP', 'Keep', $1) RETURNING id",
      [user.id],
    );
    await q(
      h,
      "INSERT INTO clan_members (clan_id, user_id, role) VALUES ($1, $2, 'leader')",
      [clan.id, user.id],
    );
    await q(
      h,
      "INSERT INTO user_flares (user_id, flare, source) VALUES ($1, 'flag:delta_mark', 'admin')",
      [user.id],
    );
    await q(
      h,
      "UPDATE users SET verified = true, bare_username_enabled = true, role = 'mod' WHERE id = $1",
      [user.id],
    );
    const [season] = await q(
      h,
      "INSERT INTO seasons (number, name, starts_at, ends_at) VALUES (1, 'S', now() - interval '1 day', now() + interval '1 day') RETURNING id",
    );
    await q(
      h,
      "INSERT INTO user_season_progress (season_id, user_id, xp) VALUES ($1, $2, 4321)",
      [season.id, user.id],
    );
    await seed(h, user, MAX_RUN_XP, 2, 700_000);

    const before = {
      credits: await creditsOf(h, user),
      games: await q(
        h,
        "SELECT count(*)::int AS n FROM game_players WHERE user_id = $1",
        [user.id],
      ),
      aggregates: await q(
        h,
        "SELECT count(*)::int AS n FROM player_stat_aggregates WHERE user_id = $1",
        [user.id],
      ),
      ledger: await q(
        h,
        "SELECT count(*)::int AS n FROM xp_ledger WHERE user_id = $1",
        [user.id],
      ),
    };
    const res = await prestige(h, user);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.progress).toMatchObject({
      prestige: 3,
      level: 1,
      xpInLevel: 0,
      lifetimeXp: 700_000,
      legend: false,
      canPrestige: false,
    });
    expect(body.rewards).toEqual([
      expect.objectContaining({ amount: "1000", reason: "prestige" }),
    ]);

    const [row] = await q(
      h,
      "SELECT run_xp::int AS run, lifetime_xp::int AS life, prestige FROM user_progress WHERE user_id = $1",
      [user.id],
    );
    expect(row).toEqual({ run: 0, life: 700_000, prestige: 3 });
    expect(await creditsOf(h, user)).toBe(before.credits);
    expect(
      await q(
        h,
        "SELECT count(*)::int AS n FROM game_players WHERE user_id = $1",
        [user.id],
      ),
    ).toEqual(before.games);
    expect(
      await q(
        h,
        "SELECT count(*)::int AS n FROM player_stat_aggregates WHERE user_id = $1",
        [user.id],
      ),
    ).toEqual(before.aggregates);
    expect(
      await q(
        h,
        "SELECT count(*)::int AS n FROM xp_ledger WHERE user_id = $1",
        [user.id],
      ),
    ).toEqual(before.ledger);
    expect(
      (await q(h, "SELECT 1 FROM clan_members WHERE user_id = $1", [user.id]))
        .length,
    ).toBe(1);
    expect(
      (
        await q(
          h,
          "SELECT 1 FROM user_flares WHERE user_id = $1 AND revoked_at IS NULL",
          [user.id],
        )
      ).length,
    ).toBe(1);
    expect(
      (
        await q(
          h,
          "SELECT verified, bare_username_enabled, role FROM users WHERE id = $1",
          [user.id],
        )
      )[0],
    ).toEqual({
      verified: true,
      bare_username_enabled: true,
      role: "mod",
    });
    expect(
      (
        await q(
          h,
          "SELECT xp::int AS xp FROM user_season_progress WHERE user_id = $1",
          [user.id],
        )
      )[0].xp,
    ).toBe(4321);
    // and the badge reflects it at once
    const me = (await (await get(h, user, "/users/@me")).json()).player
      .progress;
    expect(me).toMatchObject({ prestige: 3, level: 1 });
  });

  it("answers a repeated request with the same result and a second key with a refusal", async () => {
    const h = await harness();
    const user = await makeUser(h);
    await seed(h, user, MAX_RUN_XP);
    const first = await prestige(h, user, "same-key-12345");
    const again = await prestige(h, user, "same-key-12345");
    expect(first.status).toBe(200);
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual(await first.json());
    expect((await prestige(h, user, "other-key-12345")).status).toBe(409);
    expect(
      (
        await q(h, "SELECT prestige FROM user_progress WHERE user_id = $1", [
          user.id,
        ])
      )[0].prestige,
    ).toBe(1);
    expect(
      await q(h, "SELECT 1 FROM prestige_events WHERE user_id = $1", [user.id]),
    ).toHaveLength(1);
    expect(
      await q(
        h,
        "SELECT 1 FROM progression_rewards WHERE user_id = $1 AND kind = 'prestige'",
        [user.id],
      ),
    ).toHaveLength(1);
  });

  it("prestiges once however many requests race", async () => {
    const h = await harness();
    const user = await makeUser(h);
    await seed(h, user, MAX_RUN_XP);
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        prestige(h, user, `race-key-${i}-xxxx`),
      ),
    );
    const statuses = results.map((r) => r.status).sort();
    expect(statuses).toEqual([200, 409, 409, 409, 409, 409, 409, 409]);
    expect(
      (
        await q(h, "SELECT prestige FROM user_progress WHERE user_id = $1", [
          user.id,
        ])
      )[0].prestige,
    ).toBe(1);
    // the same key racing with itself is all successes, one prestige
    const user2 = await makeUser(h);
    await seed(h, user2, MAX_RUN_XP);
    const same = await Promise.all(
      Array.from({ length: 5 }, () => prestige(h, user2, "shared-key-1234")),
    );
    expect(same.map((r) => r.status)).toEqual([200, 200, 200, 200, 200]);
    expect(
      (
        await q(h, "SELECT prestige FROM user_progress WHERE user_id = $1", [
          user2.id,
        ])
      )[0].prestige,
    ).toBe(1);
  });

  it("stops at Prestige 10: that is Legend", async () => {
    const h = await harness();
    const user = await makeUser(h);
    await seed(h, user, MAX_RUN_XP, 9, 3_000_000);
    expect((await prestige(h, user, "to-ten-key-123")).status).toBe(200);
    expect(
      (
        await q(h, "SELECT prestige FROM user_progress WHERE user_id = $1", [
          user.id,
        ])
      )[0].prestige,
    ).toBe(10);
    await seed(h, user, MAX_RUN_XP, 10, 3_600_000);
    expect((await prestige(h, user, "beyond-key-123")).status).toBe(409);
    const progress = (await (await get(h, user, "/users/@me")).json()).player
      .progress;
    expect(progress).toMatchObject({ legend: true, canPrestige: false });
  });

  it("is refused for a banned account, and a client cannot choose the level", async () => {
    const h = await harness();
    const user = await makeUser(h);
    await seed(h, user, 100);
    // a forged body or header changes nothing: the level is read from the database
    const res = await send(
      h,
      user,
      "POST",
      "/users/@me/prestige",
      { level: 100, runXp: MAX_RUN_XP },
      { "Idempotency-Key": "forged-key-123", "X-Level": "100" },
    );
    expect(res.status).toBe(409);
    await seed(h, user, MAX_RUN_XP);
    await q(h, "INSERT INTO bans (user_id, category) VALUES ($1, 'cheating')", [
      user.id,
    ]);
    expect((await prestige(h, user, "banned-key-123")).status).toBe(403);
  });
});

describeDb("reward claims", () => {
  async function reward(
    h: Harness,
    user: TestUser,
    credits = 250,
    key = "level:p0:5",
  ) {
    const [row] = await q(
      h,
      "INSERT INTO progression_rewards (user_id, key, kind, credits) VALUES ($1, $2, 'level_milestone', $3) RETURNING id::text AS id",
      [user.id, key, credits],
    );
    return row.id as string;
  }

  it("pays the stored amount once and writes a ledger row", async () => {
    const h = await harness();
    const user = await makeUser(h);
    const id = await reward(h, user);
    const before = await creditsOf(h, user);
    const res = await send(h, user, "POST", `/rewards/${id}/claim`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      currency: { soft: before + 250, hard: 0 },
    });
    expect(await creditsOf(h, user)).toBe(before + 250);
    expect(
      await q(
        h,
        "SELECT delta::int AS d, reason, ref_type, ref_id FROM currency_ledger WHERE reason = 'progression_reward'",
      ),
    ).toEqual([
      { d: 250, reason: "progression_reward", ref_type: "reward", ref_id: id },
    ]);
    expect((await send(h, user, "POST", `/rewards/${id}/claim`)).status).toBe(
      404,
    );
    expect(await creditsOf(h, user)).toBe(before + 250);
  });

  it("pays a reward once however many claims race, and never someone else's", async () => {
    const h = await harness();
    const user = await makeUser(h);
    const other = await makeUser(h);
    const id = await reward(h, user);
    const before = await creditsOf(h, user);
    const results = await Promise.all([
      ...Array.from({ length: 6 }, () =>
        send(h, user, "POST", `/rewards/${id}/claim`),
      ),
      send(h, user, "POST", "/rewards/claim-all"),
    ]);
    expect(
      results.filter((r) => r.status === 200).length,
    ).toBeGreaterThanOrEqual(1);
    expect(await creditsOf(h, user)).toBe(before + 250);
    expect(
      await q(
        h,
        "SELECT 1 FROM currency_ledger WHERE reason = 'progression_reward'",
      ),
    ).toHaveLength(1);

    const theirs = await reward(h, user, 100, "level:p0:10");
    expect(
      (await send(h, other, "POST", `/rewards/${theirs}/claim`)).status,
    ).toBe(404);
    expect((await send(h, user, "POST", "/rewards/abc/claim")).status).toBe(
      404,
    );
    expect(
      (await send(h, null, "POST", `/rewards/${theirs}/claim`)).status,
    ).toBe(401);
    expect(await creditsOf(h, other)).toBe(0);
  });

  it("claims everything pending at once, and succeeds with nothing pending", async () => {
    const h = await harness();
    const user = await makeUser(h);
    const a = await reward(h, user, 100, "a");
    const b = await reward(h, user, 200, "b");
    const res = await send(h, user, "POST", "/rewards/claim-all");
    const body = await res.json();
    expect(body.claimed.map((c: { id: string }) => c.id).sort()).toEqual(
      [a, b].sort(),
    );
    expect(body.currency).toEqual({ soft: 300, hard: 0 });
    const empty = await send(h, user, "POST", "/rewards/claim-all");
    expect(await empty.json()).toEqual({
      claimed: [],
      currency: { soft: 300, hard: 0 },
    });
    // the rewards list the account page reads is now empty
    expect(
      (await (await get(h, user, "/users/@me")).json()).player.rewards,
    ).toEqual([]);
  });
});

describeDb("titles", () => {
  it("accepts a title the account holds and refuses the rest", async () => {
    const h = await harness();
    const user = await makeUser(h);
    await seed(h, user, 34_210); // level 25: Veteran
    const put = (title: unknown) =>
      send(h, user, "PUT", "/users/@me/title", { title });
    expect((await put("veteran")).status).toBe(200);
    expect((await put("elite")).status).toBe(400);
    expect((await put("prestige:1")).status).toBe(400);
    expect((await put("<script>")).status).toBe(400);
    expect((await put(5)).status).toBe(400);
    const me = (await (await get(h, user, "/users/@me")).json()).player
      .progress;
    expect(me.title).toBe("veteran");
    expect((await put(null)).status).toBe(200);
    expect(
      (await (await get(h, user, "/users/@me")).json()).player.progress.title,
    ).toBeNull();
  });

  it("stops showing a title the account no longer holds", async () => {
    const h = await harness();
    const user = await makeUser(h);
    await seed(h, user, 34_210);
    await send(h, user, "PUT", "/users/@me/title", { title: "veteran" });
    await seed(h, user, 1_000, 0, 34_210); // an admin took the XP back
    await q(
      h,
      "UPDATE user_progress SET display_title = 'veteran' WHERE user_id = $1",
      [user.id],
    );
    expect(
      (await (await get(h, user, "/users/@me")).json()).player.progress.title,
    ).toBeNull();
  });

  it("needs a signed-in account", async () => {
    const h = await harness();
    expect(
      (await send(h, null, "PUT", "/users/@me/title", { title: null })).status,
    ).toBe(401);
  });
});

describeDb("public progress and config", () => {
  it("shows another player's level, but not a hidden one, a guest's or a stranger's", async () => {
    const h = await harness();
    const user = await makeUser(h);
    await seed(h, user, 7_270 + 100);
    const res = await call(h, `/public/player/${user.publicId}/progress`, {
      origin: null,
    });
    expect(res.status).toBe(200);
    const body = PublicProgressSchema.parse(await res.json());
    expect(body).toMatchObject({
      prestige: 0,
      level: 10,
      xpInLevel: 100,
      xpForNext: 1200,
      rank: "private",
      season: null,
    });
    await q(h, "UPDATE users SET level_hidden = true WHERE id = $1", [user.id]);
    expect(
      (
        await call(h, `/public/player/${user.publicId}/progress`, {
          origin: null,
        })
      ).status,
    ).toBe(404);
    const guest = await makeUser(h, "guest");
    expect(
      (
        await call(h, `/public/player/${guest.publicId}/progress`, {
          origin: null,
        })
      ).status,
    ).toBe(404);
    expect(
      (await call(h, "/public/player/Nobody12345/progress", { origin: null }))
        .status,
    ).toBe(404);
    expect(
      (await call(h, "/public/player/!!/progress", { origin: null })).status,
    ).toBe(404);
  });

  it("serves the whole curve, ranks, milestones and the running season", async () => {
    const h = await harness();
    const res = await call(h, "/public/progression/config", { origin: null });
    expect(res.headers.get("cache-control")).toContain("max-age=60");
    const config = ProgressionConfigSchema.parse(await res.json());
    expect(config.maxLevel).toBe(100);
    expect(config.maxPrestige).toBe(10);
    expect(config.levels).toHaveLength(100);
    expect(config.levels[0]).toMatchObject({
      level: 1,
      xpToNext: 500,
      cumulativeXp: 0,
    });
    expect(config.levels[99]).toMatchObject({
      level: 100,
      xpToNext: 0,
      cumulativeXp: 524_810,
    });
    expect(config.levels.find((l) => l.level === 5)?.caps).toBe(250);
    expect(config.prestige?.caps).toBe(1000);
    expect(config.ranks?.[0]).toEqual({ key: "recruit", fromLevel: 1 });
    expect(config.milestones?.map((m) => m.level)).toEqual([
      5, 10, 25, 50, 75, 100,
    ]);
    expect(config.season).toBeNull();
    expect(config.flares.map((f) => f.level)).toEqual([10, 50, 75]);

    await q(
      h,
      "INSERT INTO seasons (number, name, starts_at, ends_at) VALUES (4, 'Winter', now() - interval '1 day', now() + interval '30 days')",
    );
    const withSeason = ProgressionConfigSchema.parse(
      await (
        await call(h, "/public/progression/config", { origin: null })
      ).json(),
    );
    expect(withSeason.season).toMatchObject({
      number: 4,
      name: "Winter",
      maxLevel: 50,
      xpPerLevel: 2000,
    });
    expect(withSeason.season?.rewards).toHaveLength(10);
  });
});

describeDb("GET /progression/me", () => {
  it("summarises the account page: progress, challenges, season track and history", async () => {
    const h = await harness();
    const key = await createServerKey(h);
    const users = [];
    for (let i = 0; i < 6; i++) users.push(await makeUser(h));
    await q(
      h,
      "INSERT INTO seasons (number, name, starts_at, ends_at) VALUES (1, 'Opening', '2023-11-01', '2023-12-01')",
    );
    await submitGame(h, key, buildRecord(gameId(), ffa(users)));
    // the test game ended in November 2023; read the account page as of then
    const res = await get(h, users[0], "/progression/me");
    expect(res.status).toBe(200);
    const body = ProgressionMeSchema.parse(await res.json());
    expect(body.progress.lifetimeXp).toBeGreaterThanOrEqual(750);
    expect(body.rank).toBe(body.progress.level < 10 ? "recruit" : "private");
    expect(body.nextMilestone?.level).toBe(5);
    expect(body.challenges.daily.items).toHaveLength(3);
    expect(body.challenges.weekly.items).toHaveLength(3);
    expect(body.challenges.daily.periodKey).toMatch(/^d:\d{4}-\d{2}-\d{2}$/);
    expect(body.history[0]).toMatchObject({ source: expect.any(String) });
    expect(body.history.length).toBeGreaterThanOrEqual(1);
    expect(body.titles).toEqual([]);
    expect(body.selectedTitle).toBeNull();
    expect(body.levelHidden).toBe(false);
    // no season is running now (the test season is in the past)
    expect(body.season).toBeNull();
    expect((await get(h, null, "/progression/me")).status).toBe(401);
  });

  it("lists the running season's track with what is unlocked and claimable", async () => {
    const h = await harness();
    const user = await makeUser(h);
    const [season] = await q(
      h,
      "INSERT INTO seasons (number, name, starts_at, ends_at) VALUES (1, 'Now', now() - interval '1 day', now() + interval '30 days') RETURNING id::text AS id",
    );
    await q(
      h,
      "INSERT INTO user_season_progress (season_id, user_id, xp) VALUES ($1, $2, 8100)",
      [season.id, user.id],
    );
    const [reward] = await q(
      h,
      "INSERT INTO progression_rewards (user_id, key, kind, credits, season_id) VALUES ($1, $2, 'season_track', 100, $3) RETURNING id::text AS id",
      [user.id, `season:${season.id}:level:5`, season.id],
    );
    const body = ProgressionMeSchema.parse(
      await (await get(h, user, "/progression/me")).json(),
    );
    expect(body.season).toMatchObject({
      number: 1,
      xp: 8100,
      level: 5,
      maxLevel: 50,
    });
    expect(body.seasonTrack).toHaveLength(10);
    expect(body.seasonTrack[0]).toMatchObject({
      level: 5,
      unlocked: true,
      claimed: false,
      rewardId: reward.id,
    });
    expect(body.seasonTrack[1]).toMatchObject({
      level: 10,
      unlocked: false,
      rewardId: null,
    });
  });
});

describeDb("XP leaderboards", () => {
  async function board(h: Harness, route: string) {
    const res = await call(h, route, { origin: null });
    return {
      status: res.status,
      body: (res.status === 200
        ? XpLeaderboardResponseSchema.parse(await res.json())
        : await res.json()) as XpLeaderboardResponse,
    };
  }

  it("ranks by lifetime XP with ties sharing a rank, and lists only accounts that may be listed", async () => {
    const h = await harness();
    const [a, b, c, banned, guest] = await Promise.all([
      makeUser(h),
      makeUser(h),
      makeUser(h),
      makeUser(h),
      makeUser(h, "guest"),
    ]);
    await seed(h, a, 5_000, 0, 5_000);
    await seed(h, b, 9_000, 1, 534_000);
    await seed(h, c, 5_000, 0, 5_000);
    await seed(h, banned, 50_000, 0, 50_000);
    await seed(h, guest, 60_000, 0, 60_000);
    await q(h, "INSERT INTO bans (user_id, category) VALUES ($1, 'x')", [
      banned.id,
    ]);
    const { status, body } = await board(h, "/leaderboard/xp");
    expect(status).toBe(200);
    expect(body.players.map((p) => [p.playerId, p.rank, p.xp])).toEqual([
      [b.publicId, 1, 534_000],
      ...[a, c]
        .sort((x, y) => (x.publicId < y.publicId ? -1 : 1))
        .map((u) => [u.publicId, 2, 5_000] as [string, number, number]),
    ]);
    expect(body.players[0]).toMatchObject({
      prestige: 1,
      level: levelFromRunXp(9_000),
      legend: false,
    });
  });

  it("pages, and refuses pages out of bounds", async () => {
    const h = await harness();
    const users = [];
    for (let i = 0; i < 3; i++) {
      const u = await makeUser(h);
      await seed(h, u, 100 + i, 0, 100 + i);
      users.push(u);
    }
    expect(
      (await board(h, "/leaderboard/xp?page=1")).body.players,
    ).toHaveLength(3);
    expect((await board(h, "/leaderboard/xp?page=2")).status).toBe(400);
    expect((await board(h, "/leaderboard/xp?page=0")).status).toBe(400);
    expect((await board(h, "/leaderboard/xp?page=21")).status).toBe(400);
    expect((await board(h, "/leaderboard/xp?page=abc")).status).toBe(400);
  });

  it("shows the running season live, and an archived one from its stored final ranks", async () => {
    const h = await harness();
    const [a, b] = await Promise.all([makeUser(h), makeUser(h)]);
    const [old] = await q(
      h,
      "INSERT INTO seasons (number, name, starts_at, ends_at, archived_at) VALUES (1, 'Old', '2023-01-01', '2023-02-01', now()) RETURNING id",
    );
    const [cur] = await q(
      h,
      "INSERT INTO seasons (number, name, starts_at, ends_at) VALUES (2, 'Now', now() - interval '1 day', now() + interval '10 days') RETURNING id",
    );
    await q(
      h,
      "INSERT INTO user_season_progress (season_id, user_id, xp, final_rank) VALUES ($1, $2, 900, 2), ($1, $3, 1100, 1)",
      [old.id, a.id, b.id],
    );
    await q(
      h,
      "INSERT INTO user_season_progress (season_id, user_id, xp) VALUES ($1, $2, 700), ($1, $3, 300)",
      [cur.id, a.id, b.id],
    );
    const current = await board(h, "/leaderboard/season");
    expect(current.body.season).toEqual({
      number: 2,
      name: "Now",
      archived: false,
    });
    expect(current.body.players.map((p) => [p.playerId, p.rank, p.xp])).toEqual(
      [
        [a.publicId, 1, 700],
        [b.publicId, 2, 300],
      ],
    );
    expect(current.body.seasons).toEqual([
      { number: 2, name: "Now" },
      { number: 1, name: "Old" },
    ]);
    const archived = await board(h, "/leaderboard/season?season=1");
    expect(archived.body.season).toEqual({
      number: 1,
      name: "Old",
      archived: true,
    });
    expect(
      archived.body.players.map((p) => [p.playerId, p.rank, p.xp]),
    ).toEqual([
      [b.publicId, 1, 1100],
      [a.publicId, 2, 900],
    ]);
    expect((await board(h, "/leaderboard/season?season=9")).status).toBe(404);
  });

  it("has an empty board with no seasons", async () => {
    const h = await harness();
    const { status, body } = await board(h, "/leaderboard/season");
    expect(status).toBe(200);
    expect(body.players).toEqual([]);
  });
});

describeDb("clan XP and level badges in lists", () => {
  it("shows the clan's total XP, each member's contribution and level", async () => {
    const h = await harness();
    const key = await createServerKey(h);
    const users = [];
    for (let i = 0; i < 6; i++) users.push(await makeUser(h));
    const [clan] = await q(
      h,
      "INSERT INTO clans (tag, name, created_by) VALUES ('DLT', 'Delta', $1) RETURNING id",
      [users[0].id],
    );
    await q(
      h,
      "INSERT INTO clan_members (clan_id, user_id, role) VALUES ($1, $2, 'leader'), ($1, $3, 'member')",
      [clan.id, users[0].id, users[3].id],
    );
    const spec = ffa(users);
    spec.players[0].clanTag = "DLT";
    spec.players[3].clanTag = "DLT";
    await submitGame(h, key, buildRecord(gameId(), spec));

    const info = await (await get(h, users[0], "/clans/DLT")).json();
    expect(info.xp).toBe(75 + 20);
    const members = await (await get(h, users[0], "/clans/DLT/members")).json();
    const leader = members.results.find(
      (m: { role: string }) => m.role === "leader",
    );
    expect(leader).toMatchObject({ xp: 75, prestige: 0, legend: false });
    expect(leader.level).toBeGreaterThanOrEqual(2);
    const member = members.results.find(
      (m: { role: string }) => m.role === "member",
    );
    expect(member.xp).toBe(20);

    // with progression off the clan pages carry none of it
    const off = await harness("accounts,clans");
    const lead = await makeUser(off);
    await q(
      off,
      "INSERT INTO clans (id, tag, name, created_by) VALUES (1, 'OFF', 'Off', $1)",
      [lead.id],
    );
    await q(
      off,
      "INSERT INTO clan_members (clan_id, user_id, role) VALUES (1, $1, 'leader')",
      [lead.id],
    );
    expect(
      (await (await get(off, lead, "/clans/OFF")).json()).xp,
    ).toBeUndefined();
    expect(
      (await (await get(off, lead, "/clans/OFF/members")).json()).results[0]
        .level,
    ).toBeUndefined();
  });

  it("adds the level badge fields to the basic player leaderboard rows", async () => {
    const h = await harness();
    const key = await createServerKey(h);
    const [a, b] = [await makeUser(h), await makeUser(h)];
    for (let i = 0; i < 10; i++) {
      await submitGame(
        h,
        key,
        buildRecord(gameId(), {
          allAct: true,
          players: [{ user: a }, { user: b, fate: { killedAt: 3000 } }],
        }),
      );
    }
    const { rebuildLeaderboard } =
      await import("../../src/account-api/jobs/leaderboard");
    await rebuildLeaderboard(h.db.pool);
    const rows = (
      await (
        await call(h, "/leaderboard/players?page=1&period=all", {
          origin: null,
        })
      ).json()
    ).players;
    expect(rows.length).toBe(2);
    for (const row of rows) {
      expect(row.level).toBeGreaterThanOrEqual(1);
      expect(row.prestige).toBe(0);
      expect(row.legend).toBe(false);
    }
  });
});

describeDb("progression off", () => {
  it("answers 404 on every progression route and awards nothing", async () => {
    const h = await harness("accounts,leaderboards");
    const user = await makeUser(h);
    for (const [method, route] of [
      ["GET", "/progression/me"],
      ["GET", "/users/@me/xp/abcdef12"],
      ["POST", "/users/@me/prestige"],
      ["PUT", "/users/@me/title"],
      ["GET", "/leaderboard/xp"],
      ["GET", "/leaderboard/season"],
      ["POST", "/rewards/claim-all"],
      ["POST", "/rewards/1/claim"],
      ["GET", `/public/player/${user.publicId}/progress`],
      ["GET", "/public/progression/config"],
    ] as const) {
      const res = await send(
        h,
        user,
        method,
        route,
        method === "GET" ? undefined : {},
      );
      expect(res.status, `${method} ${route}`).toBe(404);
    }
  });
});
