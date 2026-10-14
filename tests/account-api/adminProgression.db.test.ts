// @vitest-environment node
import { afterEach, expect, it } from "vitest";
import {
  runAdminCommand,
  type AdminIo,
} from "../../src/account-api/admin/commands";
import { archiveDueSeasons } from "../../src/account-api/domain/progressionOps";
import { makeUser, type TestUser } from "./util/games";
import { call, startHarness, type Harness } from "./util/harness";
import { describeDb } from "./util/testDb";

const FEATURES = "accounts,store,inventory,clans,leaderboards,progression";
const REASON = "testing the progression tools";

const harnesses: Harness[] = [];
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.close();
});
async function harness(features = FEATURES) {
  const h = await startHarness({ features });
  harnesses.push(h);
  return h;
}

const q = async (h: Harness, sql: string, params: unknown[] = []) =>
  (await h.db.pool.query(sql, params)).rows;

async function account(
  h: Harness,
  role: string | null = null,
  kind: "guest" | "registered" = "registered",
): Promise<TestUser> {
  const u = await makeUser(h, kind);
  if (role !== null) {
    await q(h, "UPDATE users SET role = $2 WHERE id = $1", [u.id, role]);
  }
  return u;
}

const get = (h: Harness, who: TestUser | null, route: string) =>
  call(h, route, { bearer: who?.jwt, origin: null });
const send = (
  h: Harness,
  who: TestUser | null,
  method: string,
  route: string,
  json?: Record<string, unknown>,
) =>
  call(h, route, {
    method,
    bearer: who?.jwt,
    origin: null,
    json: method === "GET" ? undefined : (json ?? {}),
  });

async function seed(h: Harness, user: TestUser, run: number, life = run) {
  await q(
    h,
    `INSERT INTO user_progress (user_id, lifetime_xp, run_xp) VALUES ($1, $2, $3)
     ON CONFLICT (user_id) DO UPDATE SET lifetime_xp = $2, run_xp = $3`,
    [user.id, life, run],
  );
}

const progress = async (h: Harness, user: TestUser) =>
  (
    await q(
      h,
      "SELECT lifetime_xp::int AS life, run_xp::int AS run, prestige FROM user_progress WHERE user_id = $1",
      [user.id],
    )
  )[0];

function cli(h: Harness, argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const io: AdminIo = {
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    env: {},
    actor: "operator",
  };
  return runAdminCommand(h.db.pool, argv, io).then((code) => ({
    code,
    out: out.join("\n"),
    err: err.join("\n"),
  }));
}

describeDb("who may use the XP tools", () => {
  it("lets a mod look, an admin grant and revoke, and only the owner set XP and run seasons", async () => {
    const h = await harness();
    const mod = await account(h, "mod");
    const admin = await account(h, "admin");
    const owner = await account(h, "owner");
    const target = await account(h);
    await seed(h, target, 1000);
    const view = `/admin/users/${target.publicId}/progression`;
    const history = `/admin/users/${target.publicId}/xp-history`;
    const xp = `/admin/users/${target.publicId}/xp`;
    const grant = { action: "grant", amount: 10, reason: REASON };
    const revoke = {
      action: "revoke",
      amount: 10,
      reason: REASON,
      confirm: true,
    };
    const set = { action: "set", amount: 50, reason: REASON, confirm: true };

    expect((await get(h, mod, view)).status).toBe(200);
    expect((await get(h, mod, history)).status).toBe(403);
    expect((await send(h, mod, "POST", xp, grant)).status).toBe(403);
    expect((await get(h, mod, "/admin/seasons")).status).toBe(403);

    expect((await get(h, admin, history)).status).toBe(200);
    expect((await send(h, admin, "POST", xp, grant)).status).toBe(200);
    expect((await send(h, admin, "POST", xp, revoke)).status).toBe(200);
    expect((await send(h, admin, "POST", xp, set)).status).toBe(403);
    expect((await get(h, admin, "/admin/seasons")).status).toBe(403);
    expect(
      (
        await send(
          h,
          admin,
          "POST",
          `/admin/users/${target.publicId}/season-reset`,
          { reason: REASON, confirm: true },
        )
      ).status,
    ).toBe(403);

    expect((await send(h, owner, "POST", xp, set)).status).toBe(200);
    expect((await get(h, owner, "/admin/seasons")).status).toBe(200);

    const nobody = await account(h);
    expect((await get(h, nobody, view)).status).toBe(403);
    expect((await get(h, null, view)).status).toBe(401);
    expect((await send(h, nobody, "POST", xp, grant)).status).toBe(403);
  });

  it("never lets staff change their own XP, or that of an account at or above their role", async () => {
    const h = await harness();
    const admin = await account(h, "admin");
    const otherAdmin = await account(h, "admin");
    const owner = await account(h, "owner");
    const user = await account(h);
    const post = (who: TestUser, target: TestUser) =>
      send(h, who, "POST", `/admin/users/${target.publicId}/xp`, {
        action: "grant",
        amount: 5,
        reason: REASON,
      });
    expect((await post(admin, admin)).status).toBe(403);
    expect((await post(owner, owner)).status).toBe(403);
    expect((await post(admin, otherAdmin)).status).toBe(403);
    expect((await post(admin, owner)).status).toBe(403);
    expect((await post(owner, admin)).status).toBe(200);
    expect((await post(admin, user)).status).toBe(200);
    expect(await progress(h, owner)).toBeUndefined();
    expect(await progress(h, otherAdmin)).toBeUndefined();
  });
});

describeDb("granting, revoking and setting XP", () => {
  const xpRoute = (u: TestUser) => `/admin/users/${u.publicId}/xp`;

  it("grants XP with a reason, an audit row, a ledger row that points at it, and before/after", async () => {
    const h = await harness();
    const admin = await account(h, "admin");
    const target = await account(h);
    await seed(h, target, 2_400, 2_400);
    const res = await send(h, admin, "POST", xpRoute(target), {
      action: "grant",
      amount: 100,
      reason: REASON,
    });
    expect(res.status).toBe(200);
    expect(await progress(h, target)).toEqual({
      life: 2_500,
      run: 2_500,
      prestige: 0,
    });

    const [audit] = await q(
      h,
      "SELECT id::text AS id, actor, actor_role, source, action, target_id, details FROM admin_audit_log WHERE action = 'xp:grant'",
    );
    expect(audit).toMatchObject({
      actor: admin.publicId,
      actor_role: "admin",
      source: "web",
      target_id: target.publicId,
    });
    expect(audit.details).toMatchObject({
      amount: 100,
      reason: REASON,
      before: { lifetimeXp: 2_400, runXp: 2_400, level: 4 },
      after: { lifetimeXp: 2_500, runXp: 2_500, level: 5 },
    });
    const [ledger] = await q(
      h,
      "SELECT delta::int AS delta, source, ref_type, ref_id, reason, actor FROM xp_ledger WHERE user_id = $1",
      [target.id],
    );
    expect(ledger).toEqual({
      delta: 100,
      source: "admin_grant",
      ref_type: "admin",
      ref_id: audit.id,
      reason: REASON,
      actor: admin.id,
    });
    // reaching level 5 by a grant unlocks the milestone like any other way
    expect(
      await q(h, "SELECT key FROM progression_rewards WHERE user_id = $1", [
        target.id,
      ]),
    ).toEqual([{ key: "level:p0:5" }]);
  });

  it("needs a reason, a sane amount and a registered account", async () => {
    const h = await harness();
    const admin = await account(h, "admin");
    const target = await account(h);
    const guest = await account(h, null, "guest");
    const post = (who: TestUser, body: Record<string, unknown>) =>
      send(h, who, "POST", xpRoute(who === admin ? target : target), body);
    expect((await post(admin, { action: "grant", amount: 5 })).status).toBe(
      400,
    );
    expect(
      (await post(admin, { action: "grant", amount: 5, reason: "  " })).status,
    ).toBe(400);
    expect(
      (await post(admin, { action: "grant", amount: 0, reason: REASON }))
        .status,
    ).toBe(400);
    expect(
      (await post(admin, { action: "grant", amount: -5, reason: REASON }))
        .status,
    ).toBe(400);
    expect(
      (await post(admin, { action: "grant", amount: 100_001, reason: REASON }))
        .status,
    ).toBe(400);
    expect(
      (await post(admin, { action: "grant", amount: 1.5, reason: REASON }))
        .status,
    ).toBe(400);
    expect(
      (await post(admin, { action: "nope", amount: 5, reason: REASON })).status,
    ).toBe(400);
    expect(
      (
        await send(h, admin, "POST", xpRoute(guest), {
          action: "grant",
          amount: 5,
          reason: REASON,
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await send(h, admin, "POST", "/admin/users/Nobody12345/xp", {
          action: "grant",
          amount: 5,
          reason: REASON,
        })
      ).status,
    ).toBe(404);
    expect(await q(h, "SELECT 1 FROM xp_ledger")).toHaveLength(0);
    expect(
      await q(h, "SELECT 1 FROM admin_audit_log WHERE action LIKE 'xp:%'"),
    ).toHaveLength(0);
    expect(
      (await post(admin, { action: "grant", amount: 100_000, reason: REASON }))
        .status,
    ).toBe(200);
  });

  it("revokes only what the run holds, asks for confirmation, and keeps unlocked rewards", async () => {
    const h = await harness();
    const admin = await account(h, "admin");
    const target = await account(h);
    await seed(h, target, 3_000, 9_000);
    await q(
      h,
      "INSERT INTO progression_rewards (user_id, key, kind, credits) VALUES ($1, 'level:p0:5', 'level_milestone', 250)",
      [target.id],
    );
    const body = { action: "revoke", amount: 500, reason: REASON };
    expect((await send(h, admin, "POST", xpRoute(target), body)).status).toBe(
      400,
    );
    expect(
      (
        await send(h, admin, "POST", xpRoute(target), {
          ...body,
          confirm: true,
        })
      ).status,
    ).toBe(200);
    expect(await progress(h, target)).toEqual({
      life: 8_500,
      run: 2_500,
      prestige: 0,
    });
    // more than the run holds is refused, not clamped
    const tooMuch = await send(h, admin, "POST", xpRoute(target), {
      ...body,
      amount: 2_501,
      confirm: true,
    });
    expect(tooMuch.status).toBe(409);
    expect((await tooMuch.json()).error).toBe("INSUFFICIENT");
    expect(await progress(h, target)).toEqual({
      life: 8_500,
      run: 2_500,
      prestige: 0,
    });
    expect(
      await q(h, "SELECT 1 FROM progression_rewards WHERE user_id = $1", [
        target.id,
      ]),
    ).toHaveLength(1);
    const [ledger] = await q(
      h,
      "SELECT delta::int AS delta, source FROM xp_ledger WHERE user_id = $1",
      [target.id],
    );
    expect(ledger).toEqual({ delta: -500, source: "admin_revoke" });
  });

  it("sets the run XP, moving lifetime XP by the difference", async () => {
    const h = await harness();
    const owner = await account(h, "owner");
    const target = await account(h);
    await seed(h, target, 3_000, 9_000);
    const set = (amount: number) =>
      send(h, owner, "POST", xpRoute(target), {
        action: "set",
        amount,
        reason: REASON,
        confirm: true,
      });
    expect((await set(1_000)).status).toBe(200);
    expect(await progress(h, target)).toEqual({
      life: 7_000,
      run: 1_000,
      prestige: 0,
    });
    expect((await set(1_000)).status).toBe(409);
    expect((await set(20_000)).status).toBe(200);
    expect(await progress(h, target)).toEqual({
      life: 26_000,
      run: 20_000,
      prestige: 0,
    });
    expect((await set(524_811)).status).toBe(400);
    expect((await set(-1)).status).toBe(400);
    expect((await set(524_810)).status).toBe(200);
    expect(
      await q(
        h,
        "SELECT source FROM xp_ledger WHERE user_id = $1 ORDER BY id",
        [target.id],
      ),
    ).toEqual([
      { source: "admin_set" },
      { source: "admin_set" },
      { source: "admin_set" },
    ]);
  });

  it("counts for the running season only when asked", async () => {
    const h = await harness();
    const owner = await account(h, "owner");
    const target = await account(h);
    const [season] = await q(
      h,
      "INSERT INTO seasons (number, name, starts_at, ends_at) VALUES (1, 'Now', now() - interval '1 day', now() + interval '9 days') RETURNING id::text AS id",
    );
    const grant = (extra: Record<string, unknown>) =>
      send(h, owner, "POST", xpRoute(target), {
        action: "grant",
        amount: 300,
        reason: REASON,
        ...extra,
      });
    await grant({});
    expect(
      await q(h, "SELECT 1 FROM user_season_progress WHERE user_id = $1", [
        target.id,
      ]),
    ).toHaveLength(0);
    await grant({ countsForSeason: true });
    expect(
      (
        await q(
          h,
          "SELECT xp::int AS xp FROM user_season_progress WHERE season_id = $1 AND user_id = $2",
          [season.id, target.id],
        )
      )[0].xp,
    ).toBe(300);
  });

  it("reads back an account's progression and its XP history, newest first, in pages", async () => {
    const h = await harness();
    const admin = await account(h, "admin");
    const target = await account(h);
    for (let i = 0; i < 27; i++) {
      await send(h, admin, "POST", xpRoute(target), {
        action: "grant",
        amount: i + 1,
        reason: REASON,
      });
    }
    const view = await (
      await get(h, admin, `/admin/users/${target.publicId}/progression`)
    ).json();
    expect(view).toMatchObject({
      registered: true,
      lifetimeXp: 378,
      runXp: 378,
      level: 1,
      rank: "recruit",
      prestige: 0,
      season: null,
    });
    expect(view.challenges).toHaveLength(6); // assigned, none started
    expect(
      view.challenges.every((c: { progress: number }) => c.progress === 0),
    ).toBe(true);
    const first = await (
      await get(h, admin, `/admin/users/${target.publicId}/xp-history`)
    ).json();
    expect(first.entries).toHaveLength(25);
    expect(first.hasMore).toBe(true);
    expect(first.entries[0]).toMatchObject({
      amount: 27,
      source: "admin_grant",
      reason: REASON,
      actor: admin.publicId,
      lifetimeAfter: 378,
    });
    const second = await (
      await get(h, admin, `/admin/users/${target.publicId}/xp-history?page=2`)
    ).json();
    expect(second.entries).toHaveLength(2);
    expect(second.hasMore).toBe(false);
  });
});

describeDb("seasons", () => {
  const body = (over: Record<string, unknown> = {}) => ({
    name: "Season One",
    startsAt: "2030-01-01T00:00:00.000Z",
    endsAt: "2030-03-01T00:00:00.000Z",
    ...over,
  });

  it("are created by the owner, numbered in order, and refuse to overlap", async () => {
    const h = await harness();
    const owner = await account(h, "owner");
    expect(
      (await send(h, owner, "POST", "/admin/seasons", body())).status,
    ).toBe(201);
    expect(
      (
        await send(
          h,
          owner,
          "POST",
          "/admin/seasons",
          body({
            name: "Two",
            startsAt: "2030-03-01T00:00:00.000Z",
            endsAt: "2030-05-01T00:00:00.000Z",
          }),
        )
      ).status,
    ).toBe(201);
    const overlap = await send(
      h,
      owner,
      "POST",
      "/admin/seasons",
      body({
        name: "Bad",
        startsAt: "2030-02-01T00:00:00.000Z",
        endsAt: "2030-04-01T00:00:00.000Z",
      }),
    );
    expect(overlap.status).toBe(409);
    expect((await overlap.json()).error).toBe("OVERLAP");
    const list = (await (await get(h, owner, "/admin/seasons")).json()).seasons;
    expect(
      list.map((s: { number: number; name: string }) => [s.number, s.name]),
    ).toEqual([
      [2, "Two"],
      [1, "Season One"],
    ]);
    expect(
      (await send(h, owner, "POST", "/admin/seasons", body({ name: "" })))
        .status,
    ).toBe(400);
    expect(
      (
        await send(
          h,
          owner,
          "POST",
          "/admin/seasons",
          body({ endsAt: "2029-01-01T00:00:00.000Z" }),
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await send(
          h,
          owner,
          "POST",
          "/admin/seasons",
          body({ rewardFlares: { "12": "flag:delta_mark" } }),
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await send(
          h,
          owner,
          "POST",
          "/admin/seasons",
          body({
            startsAt: "2031-01-01T00:00:00.000Z",
            endsAt: "2031-02-01T00:00:00.000Z",
            rewardFlares: { "40": "flag:nonexistent" },
          }),
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await send(
          h,
          owner,
          "POST",
          "/admin/seasons",
          body({
            startsAt: "2031-01-01T00:00:00.000Z",
            endsAt: "2031-02-01T00:00:00.000Z",
            rewardFlares: { "40": "flag:delta_mark" },
          }),
        )
      ).status,
    ).toBe(201);
    expect(
      await q(
        h,
        "SELECT action FROM admin_audit_log WHERE action LIKE 'season:%' ORDER BY id",
      ),
    ).toEqual([
      { action: "season:create" },
      { action: "season:create" },
      { action: "season:create" },
    ]);
  });

  it("can be edited until archived, and a started season keeps its start", async () => {
    const h = await harness();
    const owner = await account(h, "owner");
    await send(h, owner, "POST", "/admin/seasons", body());
    const [future] = await q(
      h,
      "SELECT id::text AS id FROM seasons WHERE number = 1",
    );
    const patch = (id: string, json: Record<string, unknown>) =>
      send(h, owner, "PATCH", `/admin/seasons/${id}`, json);
    expect(
      (
        await patch(future.id, {
          name: "Renamed",
          endsAt: "2030-04-01T00:00:00.000Z",
        })
      ).status,
    ).toBe(200);
    expect(
      (await q(h, "SELECT name FROM seasons WHERE id = $1", [future.id]))[0]
        .name,
    ).toBe("Renamed");
    const [started] = await q(
      h,
      "INSERT INTO seasons (number, name, starts_at, ends_at) VALUES (9, 'Live', now() - interval '2 days', now() + interval '5 days') RETURNING id::text AS id",
    );
    const moved = await patch(started.id, {
      startsAt: "2000-01-01T00:00:00.000Z",
    });
    expect(moved.status).toBe(409);
    expect((await patch(started.id, { name: "Live 2" })).status).toBe(200);
    // growing into the next season is refused
    expect(
      (
        await patch(future.id, {
          startsAt: "2029-12-01T00:00:00.000Z",
          endsAt: "2030-04-01T00:00:00.000Z",
        })
      ).status,
    ).toBe(200);
    const [old] = await q(
      h,
      "INSERT INTO seasons (number, name, starts_at, ends_at, archived_at) VALUES (3, 'Done', '2020-01-01', '2020-02-01', now()) RETURNING id::text AS id",
    );
    expect((await patch(old.id, { name: "Nope" })).status).toBe(409);
    expect((await patch("999999", { name: "Nope" })).status).toBe(404);
    expect((await patch("abc", { name: "Nope" })).status).toBe(404);
  });

  it("close a running season now: final level and rank stored, nothing deleted", async () => {
    const h = await harness();
    const owner = await account(h, "owner");
    const [a, b, c, banned] = await Promise.all([
      account(h),
      account(h),
      account(h),
      account(h),
    ]);
    const [season] = await q(
      h,
      "INSERT INTO seasons (number, name, starts_at, ends_at) VALUES (1, 'Live', now() - interval '2 days', now() + interval '5 days') RETURNING id::text AS id",
    );
    await q(
      h,
      "INSERT INTO user_season_progress (season_id, user_id, xp) VALUES ($1, $2, 2000), ($1, $3, 100000), ($1, $4, 2000), ($1, $5, 500000)",
      [season.id, a.id, b.id, c.id, banned.id],
    );
    await q(h, "INSERT INTO bans (user_id, category) VALUES ($1, 'x')", [
      banned.id,
    ]);
    // not confirmed: nothing happens
    const url = `/admin/seasons/${season.id}/close`;
    expect((await send(h, owner, "POST", url, { reason: REASON })).status).toBe(
      400,
    );
    expect(
      (await send(h, owner, "POST", url, { reason: REASON, confirm: true }))
        .status,
    ).toBe(200);
    const rows = await q(
      h,
      "SELECT user_id, xp::int AS xp, final_level, final_rank FROM user_season_progress WHERE season_id = $1 ORDER BY xp DESC",
      [season.id],
    );
    expect(rows).toHaveLength(4);
    const byUser = new Map(rows.map((r) => [r.user_id, r]));
    expect(byUser.get(b.id)).toMatchObject({ final_level: 50, final_rank: 1 });
    expect(byUser.get(banned.id)).toMatchObject({
      final_level: 50,
      final_rank: null,
    });
    expect(
      [byUser.get(a.id)!.final_rank, byUser.get(c.id)!.final_rank].sort(),
    ).toEqual([2, 3]);
    expect(byUser.get(a.id)!.final_level).toBe(2);
    const [row] = await q(
      h,
      "SELECT archived_at IS NOT NULL AS archived, ends_at <= now() AS over FROM seasons WHERE id = $1",
      [season.id],
    );
    expect(row).toEqual({ archived: true, over: true });
    expect(
      (await send(h, owner, "POST", url, { reason: REASON, confirm: true }))
        .status,
    ).toBe(409);
    expect(
      await q(
        h,
        "SELECT action FROM admin_audit_log WHERE action = 'season:close'",
      ),
    ).toHaveLength(1);
  });

  it("let the owner reset one player's season XP, recording what it was", async () => {
    const h = await harness();
    const owner = await account(h, "owner");
    const target = await account(h);
    const route = `/admin/users/${target.publicId}/season-reset`;
    expect(
      (await send(h, owner, "POST", route, { reason: REASON, confirm: true }))
        .status,
    ).toBe(409); // no season
    const [season] = await q(
      h,
      "INSERT INTO seasons (number, name, starts_at, ends_at) VALUES (1, 'Live', now() - interval '1 day', now() + interval '5 days') RETURNING id::text AS id",
    );
    await q(
      h,
      "INSERT INTO user_season_progress (season_id, user_id, xp) VALUES ($1, $2, 4000)",
      [season.id, target.id],
    );
    expect(
      (await send(h, owner, "POST", route, { reason: REASON })).status,
    ).toBe(400);
    expect(
      (await send(h, owner, "POST", route, { reason: REASON, confirm: true }))
        .status,
    ).toBe(200);
    expect(
      (
        await q(
          h,
          "SELECT xp::int AS xp FROM user_season_progress WHERE user_id = $1",
          [target.id],
        )
      )[0].xp,
    ).toBe(0);
    const [audit] = await q(
      h,
      "SELECT details FROM admin_audit_log WHERE action = 'season:reset-user'",
    );
    expect(audit.details).toMatchObject({
      before: 4000,
      after: 0,
      reason: REASON,
    });
  });
});

describeDb("the season closing job", () => {
  const NOW = new Date("2030-06-01T12:00:00Z");

  it("waits out the late-result grace period, then archives once", async () => {
    const h = await harness();
    const [early] = await q(
      h,
      "INSERT INTO seasons (number, name, starts_at, ends_at) VALUES (1, 'Ended', '2030-04-01', '2030-06-01T11:45:00Z') RETURNING id::text AS id",
    );
    const [live] = await q(
      h,
      "INSERT INTO seasons (number, name, starts_at, ends_at) VALUES (2, 'Live', '2030-06-01T11:45:00Z', '2030-08-01') RETURNING id::text AS id",
    );
    const user = await account(h);
    await q(
      h,
      "INSERT INTO user_season_progress (season_id, user_id, xp) VALUES ($1, $2, 6000)",
      [early.id, user.id],
    );
    // 15 minutes after the end: still inside the 30 minute grace
    expect(await archiveDueSeasons(h.db.pool, NOW)).toEqual([]);
    expect(
      (
        await q(h, "SELECT archived_at FROM seasons WHERE id = $1", [early.id])
      )[0].archived_at,
    ).toBeNull();
    // a game that ended in the window can still count during the grace period
    const later = new Date(NOW.getTime() + 20 * 60_000);
    expect(await archiveDueSeasons(h.db.pool, later)).toEqual([1]);
    const [row] = await q(
      h,
      "SELECT final_level, final_rank FROM user_season_progress WHERE season_id = $1",
      [early.id],
    );
    expect(row).toEqual({ final_level: 4, final_rank: 1 });
    expect(
      (
        await q(h, "SELECT archived_at FROM seasons WHERE id = $1", [live.id])
      )[0].archived_at,
    ).toBeNull();
    // running again changes nothing
    const [{ archived_at }] = await q(
      h,
      "SELECT archived_at FROM seasons WHERE id = $1",
      [early.id],
    );
    expect(await archiveDueSeasons(h.db.pool, later)).toEqual([]);
    expect(
      (
        await q(h, "SELECT archived_at FROM seasons WHERE id = $1", [early.id])
      )[0].archived_at,
    ).toEqual(archived_at);
    // the archived season's data is still there
    expect(
      await q(h, "SELECT 1 FROM user_season_progress WHERE season_id = $1", [
        early.id,
      ]),
    ).toHaveLength(1);
  });

  it("is safe to run from several places at once", async () => {
    const h = await harness();
    await q(
      h,
      "INSERT INTO seasons (number, name, starts_at, ends_at) VALUES (1, 'A', '2030-01-01', '2030-02-01'), (2, 'B', '2030-02-01', '2030-03-01')",
    );
    const results = await Promise.all([
      archiveDueSeasons(h.db.pool, NOW),
      archiveDueSeasons(h.db.pool, NOW),
      archiveDueSeasons(h.db.pool, NOW),
    ]);
    expect(results.flat().sort()).toEqual([1, 2]);
    expect(
      (
        await q(
          h,
          "SELECT count(*)::int AS n FROM seasons WHERE archived_at IS NOT NULL",
        )
      )[0].n,
    ).toBe(2);
  });
});

describeDb("the CLI", () => {
  it("shows, grants, revokes and sets XP, and manages seasons, with the audit trail", async () => {
    const h = await harness();
    const target = await account(h);
    await seed(h, target, 600, 600);
    expect(
      (await cli(h, ["xp:grant", target.publicId, "400", "--reason", REASON]))
        .code,
    ).toBe(0);
    expect((await progress(h, target)).run).toBe(1_000);
    const noYes = await cli(h, [
      "xp:revoke",
      target.publicId,
      "100",
      "--reason",
      REASON,
    ]);
    expect(noYes.code).not.toBe(0);
    expect(
      (
        await cli(h, [
          "xp:revoke",
          target.publicId,
          "100",
          "--reason",
          REASON,
          "--yes",
        ])
      ).code,
    ).toBe(0);
    expect((await progress(h, target)).run).toBe(900);
    expect(
      (
        await cli(h, [
          "xp:set",
          target.publicId,
          "5000",
          "--reason",
          REASON,
          "--yes",
        ])
      ).code,
    ).toBe(0);
    const shown = await cli(h, ["xp:show", target.publicId]);
    expect(shown.out).toContain("run 5000".replace("run", "this run"));
    expect(shown.out).toContain("level 7");
    expect((await cli(h, ["xp:grant", target.publicId, "5"])).code).not.toBe(0); // no reason
    expect(
      (await cli(h, ["xp:grant", target.publicId, "-5", "--reason", REASON]))
        .code,
    ).not.toBe(0);
    expect(
      await q(
        h,
        "SELECT action, source FROM admin_audit_log WHERE action LIKE 'xp:%' ORDER BY id",
      ),
    ).toEqual([
      { action: "xp:grant", source: "cli" },
      { action: "xp:revoke", source: "cli" },
      { action: "xp:set", source: "cli" },
    ]);

    const created = await cli(h, [
      "season:create",
      "--name",
      "CLI Season",
      "--start",
      "2031-01-01",
      "--end",
      "2031-03-01",
    ]);
    expect(created.code).toBe(0);
    expect((await cli(h, ["season:list"])).out).toContain("CLI Season");
    expect(
      (
        await cli(h, [
          "season:create",
          "--name",
          "Overlap",
          "--start",
          "2031-02-01",
          "--end",
          "2031-04-01",
        ])
      ).code,
    ).not.toBe(0);
    expect(
      (await cli(h, ["season:close", "1", "--reason", REASON])).code,
    ).not.toBe(0);
    // a season that has not begun cannot be closed
    expect(
      (await cli(h, ["season:close", "1", "--reason", REASON, "--yes"])).code,
    ).not.toBe(0);
    await q(
      h,
      "UPDATE seasons SET starts_at = now() - interval '1 day' WHERE number = 1",
    );
    expect(
      (await cli(h, ["season:close", "1", "--reason", REASON, "--yes"])).code,
    ).toBe(0);
    expect((await cli(h, ["season:list"])).out).toContain("archived");
    expect(
      (await cli(h, ["season:close", "99", "--reason", REASON, "--yes"])).code,
    ).not.toBe(0);
  });
});

describeDb("with progression off", () => {
  it("answers 404 on every admin XP and season route", async () => {
    const h = await harness("accounts");
    const owner = await account(h, "owner");
    const target = await account(h);
    for (const [method, route] of [
      ["GET", `/admin/users/${target.publicId}/progression`],
      ["GET", `/admin/users/${target.publicId}/xp-history`],
      ["POST", `/admin/users/${target.publicId}/xp`],
      ["POST", `/admin/users/${target.publicId}/season-reset`],
      ["GET", "/admin/seasons"],
      ["POST", "/admin/seasons"],
      ["PATCH", "/admin/seasons/1"],
      ["POST", "/admin/seasons/1/close"],
    ] as const) {
      expect(
        (await send(h, owner, method, route)).status,
        `${method} ${route}`,
      ).toBe(404);
    }
  });
});
