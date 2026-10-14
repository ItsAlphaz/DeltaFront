// @vitest-environment node
import { afterEach, expect, it } from "vitest";
import {
  runAdminCommand,
  type AdminIo,
} from "../../src/account-api/admin/commands";
import { ACCOUNT_RULES } from "../../src/account-api/domain/constants";
import { isAdminModified } from "../../src/account-api/domain/ingest";
import { rebuildLeaderboard } from "../../src/account-api/jobs/leaderboard";
import {
  buildRecord,
  clientIdOf,
  creditsOf,
  makeUser,
  submitGame,
  type TestUser,
} from "./util/games";
import {
  call,
  createServerKey,
  startHarness,
  type Harness,
} from "./util/harness";
import { describeDb } from "./util/testDb";

const FEATURES = "accounts,store,inventory,clans,leaderboards";

const harnesses: Harness[] = [];
async function harness(
  options: Parameters<typeof startHarness>[0] = {},
): Promise<Harness> {
  const h = await startHarness({ features: FEATURES, ...options });
  harnesses.push(h);
  return h;
}
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.close();
});

const rows = async (h: Harness, sql: string, params: unknown[] = []) =>
  (await h.db.pool.query(sql, params)).rows;

/** An account with a live session; `role` is written to the database, never to the token. */
async function account(
  h: Harness,
  role: string | null = null,
  extra: { verified?: boolean; bare?: boolean } = {},
): Promise<TestUser> {
  const u = await makeUser(h, "registered");
  await h.db.pool.query(
    "UPDATE users SET role = $2, verified = $3, bare_username_enabled = $4 WHERE id = $1",
    [u.id, role, extra.verified ?? false, extra.bare ?? false],
  );
  return u;
}

const get = (h: Harness, who: TestUser | null, route: string) =>
  call(h, route, { bearer: who?.jwt, origin: null });
const post = (
  h: Harness,
  who: TestUser | null,
  route: string,
  json: Record<string, unknown>,
) => call(h, route, { method: "POST", bearer: who?.jwt, origin: null, json });

const REASON = "testing the staff tools";

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

describeDb("admin API: who may call it", () => {
  const ENDPOINTS: Array<[string, string]> = [
    ["GET", "/admin/me"],
    ["GET", "/admin/dashboard"],
    ["GET", "/admin/users"],
    ["GET", "/admin/clans"],
    ["GET", "/admin/audit"],
    ["GET", "/admin/server"],
    ["POST", "/admin/users/AAAAAAAAAA/verified"],
    ["POST", "/admin/clans"],
  ];
  const hit = (
    h: Harness,
    who: TestUser | null,
    [method, route]: [string, string],
  ) => (method === "GET" ? get(h, who, route) : post(h, who, route, {}));

  it("no token is 401 on every endpoint", async () => {
    const h = await harness();
    for (const e of ENDPOINTS) {
      expect(
        (await hit(h, null, e as [string, string])).status,
        e.join(" "),
      ).toBe(401);
    }
  });

  it("an ordinary account is 403 on every endpoint, however it is dressed", async () => {
    const h = await harness();
    const accounts = {
      plain: await account(h),
      verified: await account(h, null, { verified: true }),
      bare: await account(h, null, { bare: true }),
      both: await account(h, null, { verified: true, bare: true }),
      flagged: await account(h, "flagged"),
    };
    for (const [name, who] of Object.entries(accounts)) {
      for (const e of ENDPOINTS) {
        expect(
          (await hit(h, who, e as [string, string])).status,
          `${name} ${e.join(" ")}`,
        ).toBe(403);
      }
    }
  });

  it("the role is read from the database, not from the token: a token that claims owner is still 403", async () => {
    const h = await harness();
    const u = await account(h, null);
    const { jwt } = await h.tokens.issue({
      userId: u.id,
      role: "owner",
      provider: "discord",
      sid: (
        await h.db.pool.query(
          "SELECT family_id FROM refresh_sessions WHERE user_id = $1 LIMIT 1",
          [u.id],
        )
      ).rows[0].family_id,
    });
    const res = await call(h, "/admin/me", { bearer: jwt, origin: null });
    expect(res.status).toBe(403);
  });

  it("a request body or query cannot assert a role", async () => {
    const h = await harness();
    const u = await account(h);
    const res = await call(h, "/admin/users?role=owner&staffRole=owner", {
      bearer: u.jwt,
      origin: null,
      headers: { "x-role": "owner" },
    });
    expect(res.status).toBe(403);
  });

  it("answers staff with their role and permissions", async () => {
    const h = await harness();
    const mod = await account(h, "mod");
    const owner = await account(h, "owner");
    const m = await (await get(h, mod, "/admin/me")).json();
    expect(m).toMatchObject({ publicId: mod.publicId, role: "mod" });
    expect(m.permissions).toContain("admin.users.ban");
    expect(m.permissions).not.toContain("admin.users.verify");
    const o = await (await get(h, owner, "/admin/me")).json();
    expect(o.role).toBe("owner");
    expect(o.permissions).toContain("game.admin.force_end");
  });

  it("access follows the database at once: a demotion, a ban or a revoked session ends it", async () => {
    const h = await harness();
    const admin = await account(h, "admin");
    expect((await get(h, admin, "/admin/me")).status).toBe(200);

    await h.db.pool.query("UPDATE users SET role = NULL WHERE id = $1", [
      admin.id,
    ]);
    expect((await get(h, admin, "/admin/me")).status).toBe(403);

    await h.db.pool.query("UPDATE users SET role = 'admin' WHERE id = $1", [
      admin.id,
    ]);
    expect((await get(h, admin, "/admin/me")).status).toBe(200);
    await h.db.pool.query(
      "INSERT INTO bans (user_id, category, reason) VALUES ($1, 'test', 'x')",
      [admin.id],
    );
    expect((await get(h, admin, "/admin/me")).status).toBe(403);

    const other = await account(h, "owner");
    await cli(h, [
      "user:revoke-sessions",
      other.publicId,
      "--reason",
      "t",
      "--yes",
    ]);
    expect((await get(h, other, "/admin/me")).status).toBe(401);
  });

  it("is rate limited per staff account", async () => {
    const h = await harness({
      limits: { adminRead: { max: 3, windowMs: 60_000 } },
    });
    const mod = await account(h, "mod");
    const statuses: number[] = [];
    for (let i = 0; i < 5; i++)
      statuses.push((await get(h, mod, "/admin/me")).status);
    expect(statuses).toEqual([200, 200, 200, 429, 429]);
  });
});

describeDb("admin API: a moderator", () => {
  it("can look accounts up and ban, but not change what the account is or owns", async () => {
    const h = await harness();
    const mod = await account(h, "mod");
    const target = await account(h);
    expect((await get(h, mod, "/admin/dashboard")).status).toBe(200);
    const found = await (
      await get(h, mod, `/admin/users?q=${target.publicId}`)
    ).json();
    expect(found.users[0].publicId).toBe(target.publicId);
    const detail = await (
      await get(h, mod, `/admin/users/${target.publicId}`)
    ).json();
    expect(detail.publicId).toBe(target.publicId);

    for (const [route, body] of [
      [
        `/admin/users/${target.publicId}/verified`,
        { verified: true, reason: REASON },
      ],
      [
        `/admin/users/${target.publicId}/bare-name`,
        { enabled: true, reason: REASON },
      ],
      [
        `/admin/users/${target.publicId}/role`,
        { role: "mod", reason: REASON, confirm: true },
      ],
      [
        `/admin/users/${target.publicId}/credits`,
        { amount: 10, reason: REASON },
      ],
      [
        `/admin/users/${target.publicId}/items`,
        { flare: "flag:delta_mark", grant: true, reason: REASON },
      ],
      [
        `/admin/users/${target.publicId}/revoke-sessions`,
        { reason: REASON, confirm: true },
      ],
      ["/admin/clans", { name: "Nope Clan", tag: "NOPE", reason: REASON }],
    ] as const) {
      expect((await post(h, mod, route, body)).status, route).toBe(403);
    }
    expect((await get(h, mod, "/admin/server")).status).toBe(403);
    expect(
      await rows(
        h,
        "SELECT 1 FROM users WHERE verified OR bare_username_enabled",
      ),
    ).toHaveLength(0);

    const ban = await post(h, mod, `/admin/users/${target.publicId}/ban`, {
      category: "cheating",
      reason: REASON,
      confirm: true,
    });
    expect(ban.status).toBe(200);
    expect(
      await rows(h, "SELECT 1 FROM bans WHERE user_id = $1", [target.id]),
    ).toHaveLength(1);
  });

  it("cannot act on staff of equal or higher standing, nor on itself", async () => {
    const h = await harness();
    const mod = await account(h, "mod");
    for (const role of ["mod", "admin", "owner"]) {
      const staff = await account(h, role);
      const res = await post(h, mod, `/admin/users/${staff.publicId}/ban`, {
        category: "x",
        reason: REASON,
        confirm: true,
      });
      expect(res.status, role).toBe(403);
    }
    expect(
      (
        await post(h, mod, `/admin/users/${mod.publicId}/ban`, {
          category: "x",
          reason: REASON,
          confirm: true,
        })
      ).status,
    ).toBe(403);
  });

  it("sees moderation actions in the audit log and nothing else", async () => {
    const h = await harness();
    const mod = await account(h, "mod");
    const admin = await account(h, "admin");
    const target = await account(h);
    await post(h, admin, `/admin/users/${target.publicId}/verified`, {
      verified: true,
      reason: REASON,
    });
    await post(h, mod, `/admin/users/${target.publicId}/ban`, {
      category: "cheating",
      reason: REASON,
      confirm: true,
    });
    const seen = await (await get(h, mod, "/admin/audit")).json();
    expect(seen.entries.map((e: { action: string }) => e.action)).toEqual([
      "user:ban",
    ]);
    const full = await (await get(h, admin, "/admin/audit")).json();
    expect(full.entries.map((e: { action: string }) => e.action)).toEqual([
      "user:ban",
      "user:verify",
    ]);
  });

  it("does not see account e-mail addresses; an admin does", async () => {
    const h = await harness();
    const mod = await account(h, "mod");
    const admin = await account(h, "admin");
    const target = await account(h);
    await h.db.pool.query(
      `INSERT INTO auth_identities (user_id, provider, provider_user_id, email)
       VALUES ($1, 'google', 'g-123', 'private@example.com')`,
      [target.id],
    );
    const asMod = await (
      await get(h, mod, `/admin/users/${target.publicId}`)
    ).text();
    expect(asMod).not.toContain("private@example.com");
    const asAdmin = await (
      await get(h, admin, `/admin/users/${target.publicId}`)
    ).text();
    expect(asAdmin).toContain("private@example.com");
    // Searching by e-mail works only for roles that may see it.
    expect(
      (await (await get(h, mod, "/admin/users?q=private@example.com")).json())
        .users,
    ).toHaveLength(0);
    expect(
      (await (await get(h, admin, "/admin/users?q=private@example.com")).json())
        .users,
    ).toHaveLength(1);
  });
});

describeDb("admin API: an administrator", () => {
  it("verifies, grants a bare name, adjusts Credits and items, each audited with who, as what and from where", async () => {
    const h = await harness();
    const admin = await account(h, "admin");
    const target = await account(h);
    const id = target.publicId;

    expect(
      (
        await post(h, admin, `/admin/users/${id}/verified`, {
          verified: true,
          reason: REASON,
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await post(h, admin, `/admin/users/${id}/bare-name`, {
          enabled: true,
          reason: REASON,
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await post(h, admin, `/admin/users/${id}/credits`, {
          amount: 250,
          reason: REASON,
        })
      ).status,
    ).toBe(200);
    expect(await creditsOf(h, target)).toBe(250);
    expect(
      (
        await post(h, admin, `/admin/users/${id}/items`, {
          flare: "flag:delta_mark",
          grant: true,
          reason: REASON,
        })
      ).status,
    ).toBe(200);

    const detail = await (await get(h, admin, `/admin/users/${id}`)).json();
    expect(detail).toMatchObject({
      verified: true,
      bareUsernameEnabled: true,
      credits: "250",
    });
    expect(detail.items.map((i: { flare: string }) => i.flare)).toContain(
      "flag:delta_mark",
    );

    const log = await rows(
      h,
      "SELECT actor, actor_role, actor_user_id, source, action, target_id, details FROM admin_audit_log ORDER BY id",
    );
    expect(log.map((r) => r.action)).toEqual([
      "user:verify",
      "user:grant-bare-name",
      "wallet:grant",
      "item:grant",
    ]);
    for (const r of log) {
      expect(r).toMatchObject({
        actor: admin.publicId,
        actor_role: "admin",
        actor_user_id: admin.id,
        source: "web",
        target_id: id,
      });
    }
    expect(log[0].details).toMatchObject({ reason: REASON, verified: true });
  });

  it("every change needs a reason, and destructive ones an explicit confirmation", async () => {
    const h = await harness();
    const admin = await account(h, "admin");
    const target = await account(h);
    const id = target.publicId;
    expect(
      (await post(h, admin, `/admin/users/${id}/verified`, { verified: true }))
        .status,
    ).toBe(400);
    expect(
      (
        await post(h, admin, `/admin/users/${id}/verified`, {
          verified: true,
          reason: "  ",
        })
      ).status,
    ).toBe(400);
    const noConfirm = await post(
      h,
      admin,
      `/admin/users/${id}/revoke-sessions`,
      { reason: REASON },
    );
    expect(noConfirm.status).toBe(400);
    expect((await noConfirm.json()).error).toBe("CONFIRMATION_REQUIRED");
    expect(
      (
        await post(h, admin, `/admin/users/${id}/ban`, {
          category: "x",
          reason: REASON,
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await post(h, admin, `/admin/users/${id}/credits`, {
          amount: -5,
          reason: REASON,
        })
      ).status,
    ).toBe(400);
    expect(await rows(h, "SELECT 1 FROM admin_audit_log")).toHaveLength(0);
    // A grant of Credits is not destructive; the deduction is.
    await post(h, admin, `/admin/users/${id}/credits`, {
      amount: 20,
      reason: REASON,
    });
    expect(
      (
        await post(h, admin, `/admin/users/${id}/credits`, {
          amount: -5,
          reason: REASON,
          confirm: true,
        })
      ).status,
    ).toBe(200);
    expect(await creditsOf(h, target)).toBe(15);
  });

  it("limits one command's Credits, as the CLI does", async () => {
    const h = await harness();
    const admin = await account(h, "admin");
    const target = await account(h);
    const res = await post(
      h,
      admin,
      `/admin/users/${target.publicId}/credits`,
      {
        amount: ACCOUNT_RULES.adminMaxCreditsPerCommand + 1,
        reason: REASON,
      },
    );
    expect(res.status).toBe(400);
  });

  it("can manage moderators, but cannot make an admin or an owner, nor touch one", async () => {
    const h = await harness();
    const admin = await account(h, "admin");
    const owner = await account(h, "owner");
    const otherAdmin = await account(h, "admin");
    const target = await account(h);
    const role = (who: TestUser, role: string) =>
      post(h, admin, `/admin/users/${who.publicId}/role`, {
        role,
        reason: REASON,
        confirm: true,
      });

    expect((await role(target, "mod")).status).toBe(200);
    expect(
      (
        await h.db.pool.query("SELECT role FROM users WHERE id = $1", [
          target.id,
        ])
      ).rows[0].role,
    ).toBe("mod");
    expect((await role(target, "none")).status).toBe(200);
    expect((await role(target, "admin")).status).toBe(403);
    expect((await role(target, "owner" as never)).status).toBe(400);
    expect((await role(otherAdmin, "mod")).status).toBe(403);
    expect((await role(owner, "mod")).status).toBe(403);
    expect((await role(admin, "mod")).status).toBe(403); // not even oneself
    // Nothing above reached the database.
    expect(
      (
        await h.db.pool.query("SELECT role FROM users WHERE id = ANY($1)", [
          [owner.id, otherAdmin.id, admin.id],
        ])
      ).rows
        .map((r) => r.role)
        .sort(),
    ).toEqual(["admin", "admin", "owner"]);
  });

  it("cannot ban an admin or an owner, but can ban an ordinary account", async () => {
    const h = await harness();
    const admin = await account(h, "admin");
    const body = { category: "x", reason: REASON, confirm: true };
    for (const role of ["admin", "owner"]) {
      const staff = await account(h, role);
      expect(
        (await post(h, admin, `/admin/users/${staff.publicId}/ban`, body))
          .status,
      ).toBe(403);
    }
    const target = await account(h);
    expect(
      (await post(h, admin, `/admin/users/${target.publicId}/ban`, body))
        .status,
    ).toBe(200);
  });

  it("cannot delete a clan or read the server page: those are the owner's", async () => {
    const h = await harness();
    const admin = await account(h, "admin");
    expect(
      (
        await post(h, admin, "/admin/clans", {
          name: "Official",
          tag: "OFCL",
          reason: REASON,
        })
      ).status,
    ).toBe(201);
    expect(
      (
        await post(h, admin, "/admin/clans/OFCL/delete", {
          reason: REASON,
          confirm: true,
        })
      ).status,
    ).toBe(403);
    expect((await get(h, admin, "/admin/server")).status).toBe(200);
    expect(
      await rows(h, "SELECT 1 FROM clans WHERE disbanded_at IS NULL"),
    ).toHaveLength(1);
  });
});

describeDb("admin API: the owner", () => {
  it("can make and unmake admins, but never another owner or itself", async () => {
    const h = await harness();
    const owner = await account(h, "owner");
    const target = await account(h);
    const set = (who: TestUser, role: string) =>
      post(h, owner, `/admin/users/${who.publicId}/role`, {
        role,
        reason: REASON,
        confirm: true,
      });
    expect((await set(target, "admin")).status).toBe(200);
    expect((await set(target, "none")).status).toBe(200);
    expect((await set(target, "owner")).status).toBe(400); // not even a value the API accepts
    const second = await account(h, "owner");
    expect((await set(second, "admin")).status).toBe(403);
    expect((await set(owner, "mod")).status).toBe(403);
    const log = await rows(
      h,
      "SELECT actor_role, action FROM admin_audit_log ORDER BY id",
    );
    expect(log).toEqual([
      { actor_role: "owner", action: "user:role" },
      { actor_role: "owner", action: "user:role" },
    ]);
  });

  it("can delete a clan, view the server page and the whole audit log", async () => {
    const h = await harness();
    const owner = await account(h, "owner");
    await post(h, owner, "/admin/clans", {
      name: "Doomed",
      tag: "DOOM",
      reason: REASON,
    });
    expect(
      (
        await post(h, owner, "/admin/clans/DOOM/delete", {
          reason: REASON,
          confirm: true,
        })
      ).status,
    ).toBe(200);
    expect(
      await rows(h, "SELECT 1 FROM clans WHERE disbanded_at IS NULL"),
    ).toHaveLength(0);
    const server = await (await get(h, owner, "/admin/server")).json();
    expect(server).toMatchObject({ environment: "dev" });
    expect(server.features).toContain("clans");
    const audit = await (await get(h, owner, "/admin/audit")).json();
    expect(audit.entries.map((e: { action: string }) => e.action)).toEqual([
      "clan:remove",
      "clan:create-official",
    ]);
  });

  it("sees a dashboard with real numbers", async () => {
    const h = await harness();
    const owner = await account(h, "owner");
    await account(h);
    await account(h);
    const d = await (await get(h, owner, "/admin/dashboard")).json();
    expect(d.counts.registeredUsers).toBe(3);
    expect(d.counts.newUsers24h).toBe(3);
    expect(d.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(d.recentRegistrations).toHaveLength(3);
    expect(d.health).toEqual({
      database: "ok",
      migrations: "ok",
      signingKey: "ok",
    });
  });
});

describeDb("admin API: nothing secret leaves it", () => {
  it("responses and audit details carry no token, session, key or hash material", async () => {
    const h = await harness();
    const owner = await account(h, "owner");
    const target = await account(h);
    await post(h, owner, `/admin/users/${target.publicId}/ban`, {
      category: "x",
      reason: REASON,
      confirm: true,
    });
    await createServerKey(h);
    const texts = [
      await (await get(h, owner, `/admin/users/${target.publicId}`)).text(),
      await (await get(h, owner, "/admin/audit")).text(),
      await (await get(h, owner, "/admin/dashboard")).text(),
      await (await get(h, owner, "/admin/server")).text(),
      await (await get(h, owner, "/admin/users")).text(),
    ];
    for (const text of texts) {
      expect(text).not.toContain(owner.jwt);
      expect(text).not.toContain(target.jwt);
      expect(text).not.toMatch(
        /key_hash|refresh_token|token_hash|df_refresh|password|PRIVATE KEY/i,
      );
      expect(text).not.toMatch(/dfk_|test-server-key/);
    }
  });

  it("a secret-looking key in an audit row's details is redacted when shown", async () => {
    const h = await harness();
    const owner = await account(h, "owner");
    await h.db.pool.query(
      `INSERT INTO admin_audit_log (actor, action, details)
       VALUES ('x', 'test:secret', '{"token": "abc", "api_key": "def", "nested": {"password": "p"}, "ok": "fine"}')`,
    );
    const body = await (await get(h, owner, "/admin/audit?action=test")).json();
    expect(body.entries[0].details).toEqual({
      token: "[redacted]",
      api_key: "[redacted]",
      nested: { password: "[redacted]" },
      ok: "fine",
    });
  });
});

describeDb("official clans", () => {
  const create = (h: Harness, who: TestUser, name: string, tag: string) =>
    post(h, who, "/clans", { name, tag });

  it("ordinary accounts are held to the age and games rules, whatever else they hold", async () => {
    const h = await harness();
    for (const extra of [
      {},
      { verified: true },
      { bare: true },
      { verified: true, bare: true },
    ]) {
      const u = await account(h, null, extra);
      // Old enough, but no completed games.
      await h.db.pool.query(
        "UPDATE users SET created_at = now() - interval '30 days' WHERE id = $1",
        [u.id],
      );
      const res = await create(
        h,
        u,
        `Clan ${Math.random().toString(36).slice(2, 8)}`,
        "ABC",
      );
      expect(res.status, JSON.stringify(extra)).toBe(403);
      expect((await res.json()).code).toBe("NOT_ENOUGH_GAMES");
    }
    const fresh = await account(h);
    expect((await create(h, fresh, "Fresh Clan", "FRSH")).status).toBe(403);
    // Moderators are not clan staff either.
    const mod = await account(h, "mod");
    expect((await create(h, mod, "Mod Clan", "MODC")).status).toBe(403);
  });

  it("an admin or owner creates a clan at once, with no fake match history", async () => {
    const h = await harness();
    for (const role of ["admin", "owner"]) {
      const u = await account(h, role);
      const res = await create(
        h,
        u,
        `${role} Clan`,
        role === "admin" ? "ADM" : "OWN",
      );
      expect(res.status, role).toBe(201);
    }
    expect(await rows(h, "SELECT 1 FROM game_players")).toHaveLength(0);
    expect(await rows(h, "SELECT 1 FROM clans")).toHaveLength(2);
  });

  it("the owner can create DeltaFront / DELTA, which are reserved for everyone else", async () => {
    const h = await harness();
    const owner = await account(h, "owner");
    const res = await post(h, owner, "/admin/clans", {
      name: "DeltaFront",
      tag: "DELTA",
      reason: "the official clan",
    });
    expect(res.status).toBe(201);
    const clan = await rows(
      h,
      "SELECT tag::text AS tag, name::text AS name FROM clans",
    );
    expect(clan).toEqual([{ tag: "DELTA", name: "DeltaFront" }]);
    expect((await rows(h, "SELECT role FROM clan_members"))[0].role).toBe(
      "leader",
    );
    expect(
      (await rows(h, "SELECT action, target_id FROM admin_audit_log"))[0],
    ).toEqual({
      action: "clan:create-official",
      target_id: "DELTA",
    });

    // The same name and tag stay reserved for an ordinary account.
    const plain = await account(h);
    await h.db.pool.query(
      "UPDATE users SET created_at = now() - interval '30 days' WHERE id = $1",
      [plain.id],
    );
    const taken = await create(h, plain, "DeltaFront Two", "DELTA");
    expect(taken.status).not.toBe(201);
  });

  it("an admin can rename, retag, close, transfer and remove members; the panel's actions are audited", async () => {
    const h = await harness();
    const admin = await account(h, "admin");
    const member = await account(h);
    await post(h, admin, "/admin/clans", {
      name: "Alpha Wing",
      tag: "ALPH",
      reason: REASON,
    });
    const clanId = (await rows(h, "SELECT id FROM clans"))[0].id;
    await h.db.pool.query(
      "INSERT INTO clan_members (clan_id, user_id, role) VALUES ($1, $2, 'member')",
      [clanId, member.id],
    );

    expect(
      (
        await post(h, admin, "/admin/clans/ALPH/rename", {
          name: "Alpha Wing Two",
          reason: REASON,
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await post(h, admin, "/admin/clans/ALPH/tag", {
          tag: "AWNG",
          reason: REASON,
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await post(h, admin, "/admin/clans/AWNG/open", {
          isOpen: false,
          reason: REASON,
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await post(
          h,
          admin,
          `/admin/clans/AWNG/members/${member.publicId}/remove`,
          { reason: REASON },
        )
      ).status,
    ).toBe(400); // needs confirm
    expect(
      (
        await post(
          h,
          admin,
          `/admin/clans/AWNG/members/${member.publicId}/remove`,
          { reason: REASON, confirm: true },
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await post(h, admin, `/admin/clans/AWNG/bans/${member.publicId}`, {
          ban: true,
          reason: REASON,
          confirm: true,
        })
      ).status,
    ).toBe(200);
    const detail = await (await get(h, admin, "/admin/clans/AWNG")).json();
    expect(detail).toMatchObject({
      tag: "AWNG",
      name: "Alpha Wing Two",
      isOpen: false,
    });
    expect(detail.bans).toHaveLength(1);
    const actions = (
      await rows(h, "SELECT action FROM admin_audit_log ORDER BY id")
    ).map((r) => r.action);
    expect(actions).toEqual([
      "clan:create-official",
      "clan:rename",
      "clan:retag",
      "clan:set-open",
      "clan:member-remove",
      "clan:ban",
    ]);
  });
});

describeDb("owner assignment (CLI)", () => {
  it("the operator can make an owner, and show says so", async () => {
    const h = await harness();
    const u = await account(h);
    const r = await cli(h, [
      "user:role",
      u.publicId,
      "owner",
      "--reason",
      "owner",
      "--yes",
    ]);
    expect(r.code).toBe(0);
    expect(
      (await rows(h, "SELECT role FROM users WHERE id = $1", [u.id]))[0].role,
    ).toBe("owner");
    expect((await cli(h, ["user:show", u.publicId])).out).toMatch(
      /role: owner/,
    );
    const entry = (
      await rows(h, "SELECT actor_role, source, details FROM admin_audit_log")
    )[0];
    expect(entry).toMatchObject({ actor_role: "operator", source: "cli" });
    expect(entry.details).toMatchObject({ from: "none", role: "owner" });
    // And the new owner reaches the panel with the token it already had.
    expect((await get(h, u, "/admin/me")).status).toBe(200);
  });

  it(`never more than ${ACCOUNT_RULES.maxOwners} owners`, async () => {
    const h = await harness();
    for (let i = 0; i < ACCOUNT_RULES.maxOwners; i++) {
      const u = await account(h);
      expect(
        (
          await cli(h, [
            "user:role",
            u.publicId,
            "owner",
            "--reason",
            "t",
            "--yes",
          ])
        ).code,
      ).toBe(0);
    }
    const extra = await account(h);
    const r = await cli(h, [
      "user:role",
      extra.publicId,
      "owner",
      "--reason",
      "t",
      "--yes",
    ]);
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/limit is/);
    expect(
      (await rows(h, "SELECT role FROM users WHERE id = $1", [extra.id]))[0]
        .role,
    ).toBeNull();
  });

  it("the last owner cannot be demoted: another account must be made owner first", async () => {
    const h = await harness();
    const a = await account(h);
    await cli(h, ["user:role", a.publicId, "owner", "--reason", "t", "--yes"]);
    const demote = await cli(h, [
      "user:role",
      a.publicId,
      "admin",
      "--reason",
      "t",
      "--yes",
    ]);
    expect(demote.code).toBe(2);
    expect(demote.err).toMatch(/no owner/);
    const b = await account(h);
    await cli(h, ["user:role", b.publicId, "owner", "--reason", "t", "--yes"]);
    expect(
      (
        await cli(h, [
          "user:role",
          a.publicId,
          "admin",
          "--reason",
          "t",
          "--yes",
        ])
      ).code,
    ).toBe(0);
  });

  it("an unknown role is refused, and the owner role is not offered over HTTP", async () => {
    const h = await harness();
    const u = await account(h);
    expect(
      (
        await cli(h, [
          "user:role",
          u.publicId,
          "superuser",
          "--reason",
          "t",
          "--yes",
        ])
      ).err,
    ).toMatch(/role must be one of: owner, admin, mod, flagged, none/);
    const owner = await account(h, "owner");
    const res = await post(h, owner, `/admin/users/${u.publicId}/role`, {
      role: "owner",
      reason: REASON,
      confirm: true,
    });
    expect(res.status).toBe(400);
  });
});

describeDb("badges: the API says what is true, and only that", () => {
  const me = async (h: Harness, who: TestUser) =>
    (await (await get(h, who, "/users/@me")).json()).player;
  const profile = async (h: Harness, who: TestUser) =>
    await (
      await call(h, `/public/player/${who.publicId}`, { origin: null })
    ).json();

  it("/users/@me and the public profile carry the staff role and verification as separate facts", async () => {
    const h = await harness();
    const cases: Array<[string | null, boolean, string | undefined]> = [
      ["owner", true, "owner"],
      ["owner", false, "owner"],
      ["admin", false, "admin"],
      ["mod", true, "mod"],
      ["root", false, "owner"],
      [null, true, undefined],
      [null, false, undefined],
      ["flagged", false, undefined],
    ];
    for (const [role, verified, staffRole] of cases) {
      const u = await account(h, role, { verified });
      const own = await me(h, u);
      expect(own.staffRole, `${role}/${verified}`).toBe(staffRole);
      expect(own.verified).toBe(verified);
      const pub = await profile(h, u);
      expect(pub.staffRole).toBe(staffRole);
      expect(pub.verified).toBe(verified);
    }
  });

  it("a bare username does not make a staff badge, and a staff role does not make a bare username", async () => {
    const h = await harness();
    const bare = await account(h, null, { bare: true });
    const admin = await account(h, "admin");
    expect((await me(h, bare)).staffRole).toBeUndefined();
    expect((await me(h, admin)).bareUsernameEnabled).toBe(false);
  });

  it("the leaderboard and the clan member list carry the badges too", async () => {
    const h = await harness();
    const owner = await account(h, "owner", { verified: true });
    const plain = await account(h);
    const key = await createServerKey(h);
    // Two accounts in counted games so both reach the board.
    for (let g = 0; g < ACCOUNT_RULES.leaderboardMinGames; g++) {
      await submitGame(
        h,
        key,
        buildRecord(`bd${String(g).padStart(6, "0")}`, {
          players: [{ user: owner }, { user: plain }],
        }),
      );
    }
    await rebuildLeaderboard(h.db.pool);
    const board = await (
      await call(h, "/leaderboard/players", { origin: null })
    ).json();
    const ownerRow = board.players.find(
      (p: { playerId: string }) => p.playerId === owner.publicId,
    );
    const plainRow = board.players.find(
      (p: { playerId: string }) => p.playerId === plain.publicId,
    );
    expect(ownerRow).toMatchObject({ staffRole: "owner", verified: true });
    expect(plainRow.staffRole).toBeUndefined();
    expect(plainRow.verified).toBe(false);

    await post(h, owner, "/clans", { name: "Staff Clan", tag: "STFF" });
    const members = await (await get(h, owner, "/clans/STFF/members")).json();
    expect(members.results[0]).toMatchObject({
      publicId: owner.publicId,
      staffRole: "owner",
      verified: true,
    });
  });
});

describeDb("games with admin commands never count", () => {
  const admin = (clientID: string) => ({
    type: "admin_command",
    command: "give_gold",
    target: clientID,
    amount: 1000,
    clientID,
  });

  it("recognises an admin command anywhere in the recorded turns", () => {
    const clean = buildRecord("ab000001", {
      players: [{ user: null }, { user: null }],
    });
    expect(isAdminModified(clean)).toBe(false);
    clean.turns[1].intents.push(admin(clientIdOf(0)) as never);
    expect(isAdminModified(clean)).toBe(true);
  });

  it("the game is stored as admin-modified and feeds no stats, no Credits, no leaderboard", async () => {
    const h = await harness();
    const key = await createServerKey(h);
    const a = await makeUser(h);
    const b = await makeUser(h);

    // A control game, identical but for the command: it counts.
    const control = buildRecord("ct000001", {
      players: [{ user: a }, { user: b }],
    });
    expect((await submitGame(h, key, control)).status).toBeLessThan(300);
    const creditsAfterControl = await creditsOf(h, a);
    expect(creditsAfterControl).toBeGreaterThan(0);

    const tested = buildRecord("ad000001", {
      players: [{ user: a }, { user: b }],
    });
    tested.turns[1].intents.push(admin(clientIdOf(0)) as never);
    expect((await submitGame(h, key, tested)).status).toBeLessThan(300);

    const games = await rows(
      h,
      "SELECT game_code, counts_for_stats, admin_modified FROM games ORDER BY game_code",
    );
    expect(games).toEqual([
      { game_code: "ad000001", counts_for_stats: false, admin_modified: true },
      { game_code: "ct000001", counts_for_stats: true, admin_modified: false },
    ]);
    // No Credits, no completed game for the clan threshold, no aggregate from it.
    expect(await creditsOf(h, a)).toBe(creditsAfterControl);
    const completed = await rows(
      h,
      `SELECT g.game_code, count(*) FILTER (WHERE gp.completed)::int AS completed, sum(gp.credits_awarded)::int AS credits
         FROM game_players gp JOIN games g ON g.id = gp.game_id GROUP BY g.game_code ORDER BY g.game_code`,
    );
    expect(completed).toEqual([
      { game_code: "ad000001", completed: 0, credits: 0 },
      { game_code: "ct000001", completed: 2, credits: expect.any(Number) },
    ]);
    const total = await rows(
      h,
      "SELECT sum(total)::int AS total FROM player_stat_aggregates WHERE user_id = $1",
      [a.id],
    );
    expect(total[0].total).toBe(1); // the control game only
  });

  it("an admin-modified PRIVATE game is not aggregated either", async () => {
    const h = await harness();
    const key = await createServerKey(h);
    const a = await makeUser(h);
    const b = await makeUser(h);
    const priv = buildRecord("pv000001", {
      players: [{ user: a }, { user: b }],
      type: "Private",
    });
    expect((await submitGame(h, key, priv)).status).toBeLessThan(300);
    const tested = buildRecord("pv000002", {
      players: [{ user: a }, { user: b }],
      type: "Private",
    });
    tested.turns[1].intents.push(admin(clientIdOf(0)) as never);
    await submitGame(h, key, tested);
    const total = await rows(
      h,
      "SELECT sum(total)::int AS total FROM player_stat_aggregates WHERE user_id = $1",
      [a.id],
    );
    expect(total[0].total).toBe(1);
  });
});

describeDb("the game server's staff audit report", () => {
  const body = {
    gameID: "abcd1234",
    actorPublicId: "XXXXXXXXXX",
    action: "game:command",
    details: { command: "give_gold", amount: 500 },
  };
  const report = (
    h: Harness,
    key: string | undefined,
    json: unknown,
    origin: string | null = null,
  ) =>
    call(h, "/game_admin/audit", {
      method: "POST",
      json,
      origin,
      headers: key === undefined ? {} : { "x-api-key": key },
    });

  it("needs a registered server key and refuses browsers", async () => {
    const h = await harness();
    const key = await createServerKey(h);
    expect((await report(h, undefined, body)).status).toBe(401);
    expect((await report(h, "wrong-key-wrong-key", body)).status).toBe(401);
    expect((await report(h, key, body, h.origin)).status).toBe(403);
    expect(await rows(h, "SELECT 1 FROM admin_audit_log")).toHaveLength(0);
  });

  it("writes a game-sourced audit row with the account's current role, and only known actions", async () => {
    const h = await harness();
    const key = await createServerKey(h);
    const owner = await account(h, "owner");
    const res = await report(h, key, {
      ...body,
      actorPublicId: owner.publicId,
      targetClientID: "victim00",
    });
    expect(res.status).toBe(204);
    const entry = (
      await rows(
        h,
        "SELECT actor, actor_role, actor_user_id, source, action, target_type, target_id, details FROM admin_audit_log",
      )
    )[0];
    expect(entry).toMatchObject({
      actor: owner.publicId,
      actor_role: "owner",
      actor_user_id: owner.id,
      source: "game",
      action: "game:command",
      target_type: "game",
      target_id: "abcd1234",
    });
    expect(entry.details).toMatchObject({
      gameID: "abcd1234",
      command: "give_gold",
      amount: 500,
      targetClientID: "victim00",
    });
    expect((await report(h, key, { ...body, action: "user:ban" })).status).toBe(
      400,
    );
    expect(
      (await report(h, key, { ...body, details: { token: { nested: 1 } } }))
        .status,
    ).toBe(400);
  });

  it("notes when the account is no longer staff", async () => {
    const h = await harness();
    const key = await createServerKey(h);
    const demoted = await account(h);
    await report(h, key, { ...body, actorPublicId: demoted.publicId });
    const entry = (
      await rows(h, "SELECT actor_role, details FROM admin_audit_log")
    )[0];
    expect(entry.actor_role).toBeNull();
    expect(entry.details.actorNoLongerStaff).toBe(true);
  });
});
