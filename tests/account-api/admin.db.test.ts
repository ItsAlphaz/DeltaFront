// @vitest-environment node
import { UserMeResponseSchema } from "@openfront/shared/ApiSchemas";
import { afterEach, describe, expect, it } from "vitest";
import {
  ADMIN_COMMANDS,
  runAdminCommand,
  type AdminIo,
} from "../../src/account-api/admin/commands";
import { sha256 } from "../../src/account-api/http";
import {
  APP_ORIGIN,
  call,
  completeLogin,
  createMockProviders,
  decodeJwtPayload,
  newGuest,
  refresh,
  startHarness,
  type Harness,
} from "./util/harness";
import { describeDb } from "./util/testDb";

const harnesses: Harness[] = [];
async function harness(
  options: Parameters<typeof startHarness>[0] = {},
): Promise<Harness> {
  const h = await startHarness(options);
  harnesses.push(h);
  return h;
}
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.close();
});

function run(
  h: Harness,
  argv: string[],
  env: Record<string, string | undefined> = {},
) {
  const out: string[] = [];
  const err: string[] = [];
  const io: AdminIo = {
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    env,
    actor: "tester",
  };
  return runAdminCommand(h.db.pool, argv, io).then((code) => ({
    code,
    out: out.join("\n"),
    err: err.join("\n"),
  }));
}

const rows = async (h: Harness, sql: string, params: unknown[] = []) =>
  (await h.db.pool.query(sql, params)).rows;
const publicIdOf = async (h: Harness, jwt: string): Promise<string> =>
  UserMeResponseSchema.parse(
    await (await call(h, "/users/@me", { bearer: jwt, origin: null })).json(),
  ).player.publicId;

describeDb("admin: help and usage", () => {
  it("lists the commands", async () => {
    const h = await harness();
    for (const argv of [[], ["help"], ["--help"]]) {
      const r = await run(h, argv);
      expect(r.code).toBe(0);
      for (const c of ADMIN_COMMANDS) expect(r.out).toContain(c);
    }
  });

  it("rejects unknown commands and missing arguments with exit code 2", async () => {
    const h = await harness();
    expect((await run(h, ["user:explode"])).code).toBe(2);
    expect((await run(h, ["user:show"])).err).toMatch(/missing public id/);
    expect((await run(h, ["user:show", "nobody00000"])).err).toMatch(
      /no user with public id/,
    );
    expect(
      (await run(h, ["server:state", "x.com", "a", "sleeping", "--yes"])).err,
    ).toMatch(/state must be one of/);
  });

  it("destructive commands do nothing without --yes", async () => {
    const h = await harness();
    const { jar, jwt } = await newGuest(h);
    const id = await publicIdOf(h, jwt);
    for (const argv of [
      ["user:ban", id, "--category", "cheating"],
      ["user:revoke-sessions", id],
      ["user:role", id, "admin"],
      ["server:key:revoke", "1"],
      ["server:state", "x.com", "a", "fenced"],
    ]) {
      const r = await run(h, argv);
      expect(r.code, argv.join(" ")).toBe(2);
      expect(r.err).toMatch(/--yes/);
    }
    expect((await refresh(h, jar)).status).toBe(200); // still signed in
    expect(await rows(h, "SELECT 1 FROM bans")).toHaveLength(0);
    expect(await rows(h, "SELECT 1 FROM admin_audit_log")).toHaveLength(0);
  });
});

describeDb("admin: finding and inspecting users", () => {
  it("finds a user by public id, internal id, provider id and email, and shows their details", async () => {
    const mock = createMockProviders({
      c: {
        discord: {
          id: "disc-77",
          username: "ann",
          email: "ann@example.com",
          verified: true,
        },
      },
    });
    const h = await harness({ fetchFn: mock.fetchFn });
    const { jar } = await completeLogin(h, "discord", "c");
    const jwt = (await (await refresh(h, jar)).json()).jwt as string;
    const publicId = await publicIdOf(h, jwt);
    const uuid = (await rows(h, "SELECT id FROM users"))[0].id;

    for (const query of [publicId, uuid, "disc-77", "ann@example.com"]) {
      const r = await run(h, ["user:find", query]);
      expect(r.out, query).toContain(publicId);
      expect(r.out).toContain("registered");
      expect(r.out).toContain("discord");
    }
    expect((await run(h, ["user:find", "nobody"])).out).toBe(
      "no matching users",
    );

    const show = await run(h, ["user:show", publicId]);
    expect(show.code).toBe(0);
    expect(show.out).toContain(publicId);
    expect(show.out).toMatch(/kind:\s+registered/);
    expect(show.out).toMatch(/live sessions: 1/);
    expect(show.out).toContain("discord  disc-77  ann@example.com (verified)");
    expect(show.out).toContain("(none)"); // no bans
  });
});

describeDb("admin: bans", () => {
  it("a ban signs the player out, shows in /users/@me, puts role=banned in new tokens, and lifts cleanly", async () => {
    const mock = createMockProviders({
      c: {
        google: { sub: "g-ban", email: "b@example.com", email_verified: true },
      },
    });
    const h = await harness({ fetchFn: mock.fetchFn });
    const { jar } = await completeLogin(h, "google", "c");
    const before = jar.clone();
    const jwt = (await (await refresh(h, jar)).json()).jwt as string;
    const id = await publicIdOf(h, jwt);
    expect(decodeJwtPayload(jwt).role).toBeUndefined();

    const banned = await run(h, [
      "user:ban",
      id,
      "--category",
      "cheating",
      "--reason",
      "aimbot",
      "--days",
      "7",
      "--yes",
    ]);
    expect(banned.code).toBe(0);

    // Signed out everywhere, immediately.
    expect(
      (await call(h, "/users/@me", { bearer: jwt, origin: null })).status,
    ).toBe(401);
    expect((await refresh(h, before)).status).toBe(401);

    // They can sign in again, and are told why they are banned.
    const again = await completeLogin(h, "google", "c");
    const bannedJwt = (await (await refresh(h, again.jar)).json())
      .jwt as string;
    expect(decodeJwtPayload(bannedJwt).role).toBe("banned"); // the game server closes banned joins on this claim
    const me = UserMeResponseSchema.parse(
      await (
        await call(h, "/users/@me", { bearer: bannedJwt, origin: null })
      ).json(),
    );
    expect(me.ban).toMatchObject({ category: "cheating", reason: "aimbot" });
    expect(new Date(me.ban!.expiresAt!).getTime()).toBeGreaterThan(
      Date.now() + 6 * 86_400_000,
    );
    expect((await run(h, ["user:show", id])).out).toMatch(
      /ACTIVE\s+cheating\s+aimbot/,
    );

    const lifted = await run(h, ["user:unban", id]);
    expect(lifted.out).toBe(`1 ban(s) lifted for ${id}`);
    const freeJwt = (await (await refresh(h, again.jar)).json()).jwt as string;
    expect(decodeJwtPayload(freeJwt).role).toBeUndefined();
    expect(
      UserMeResponseSchema.parse(
        await (
          await call(h, "/users/@me", { bearer: freeJwt, origin: null })
        ).json(),
      ).ban,
    ).toBeNull();
  });

  it("an expired ban no longer counts", async () => {
    const mock = createMockProviders({
      c: {
        google: { sub: "g-exp", email: "e@example.com", email_verified: true },
      },
    });
    const h = await harness({ fetchFn: mock.fetchFn });
    const first = await completeLogin(h, "google", "c");
    const id = await publicIdOf(
      h,
      (await (await refresh(h, first.jar)).json()).jwt,
    );
    await run(h, [
      "user:ban",
      id,
      "--category",
      "spam",
      "--days",
      "1",
      "--yes",
    ]);
    await h.db.pool.query(
      "UPDATE bans SET expires_at = now() - interval '1 hour'",
    );

    const again = await completeLogin(h, "google", "c");
    const jwt = (await (await refresh(h, again.jar)).json()).jwt as string;
    expect(decodeJwtPayload(jwt).role).toBeUndefined();
    expect(
      UserMeResponseSchema.parse(
        await (
          await call(h, "/users/@me", { bearer: jwt, origin: null })
        ).json(),
      ).ban,
    ).toBeNull();
  });

  it("validates its arguments", async () => {
    const h = await harness();
    const { jwt } = await newGuest(h);
    const id = await publicIdOf(h, jwt);
    expect((await run(h, ["user:ban", id, "--yes"])).err).toMatch(
      /--category is required/,
    );
    expect(
      (
        await run(h, [
          "user:ban",
          id,
          "--category",
          "x",
          "--days",
          "0",
          "--yes",
        ])
      ).err,
    ).toMatch(/--days must be/);
    expect(
      (
        await run(h, [
          "user:ban",
          id,
          "--category",
          "x",
          "--days",
          "abc",
          "--yes",
        ])
      ).err,
    ).toMatch(/--days must be/);
    expect(await rows(h, "SELECT 1 FROM bans")).toHaveLength(0);
  });
});

describeDb("admin: sessions and roles", () => {
  it("revoke-sessions ends every session of the account", async () => {
    const h = await harness();
    const { jar, jwt } = await newGuest(h);
    const id = await publicIdOf(h, jwt);
    const r = await run(h, ["user:revoke-sessions", id, "--yes"]);
    expect(r.out).toMatch(/1 session\(s\) revoked/);
    expect((await refresh(h, jar)).status).toBe(401);
    expect(
      (await call(h, "/users/@me", { bearer: jwt, origin: null })).status,
    ).toBe(401);
  });

  it("sets a role that appears in the token, and rejects an unknown one", async () => {
    const h = await harness();
    const { jar, jwt } = await newGuest(h);
    const id = await publicIdOf(h, jwt);
    expect((await run(h, ["user:role", id, "superuser", "--yes"])).err).toMatch(
      /role must be one of/,
    );
    expect((await run(h, ["user:role", id, "mod", "--yes"])).code).toBe(0);
    expect(
      decodeJwtPayload((await (await refresh(h, jar)).json()).jwt).role,
    ).toBe("mod");
    await run(h, ["user:role", id, "none", "--yes"]);
    expect(
      decodeJwtPayload((await (await refresh(h, jar)).json()).jwt).role,
    ).toBeUndefined();
  });
});

describeDb("admin: server keys", () => {
  const probe = (h: Harness, key: string) =>
    call(h, "/join_verify", {
      method: "POST",
      json: { ip: "1.1.1.1", token: null, username: "Ann", clanTag: null },
      origin: null,
      headers: { "x-api-key": key },
    });

  it("creates a random key, shows it once, stores only its hash, and the API accepts it", async () => {
    const h = await harness();
    const r = await run(h, ["server:key:create", "blue"]);
    expect(r.code).toBe(0);
    const key = r.out.split("\n").find((l) => l.startsWith("dfk_"))!;
    expect(key.length).toBeGreaterThan(40);
    const stored = await rows(
      h,
      "SELECT name, encode(key_hash, 'hex') AS hash FROM server_api_keys",
    );
    expect(stored).toEqual([
      { name: "blue", hash: sha256(key).toString("hex") },
    ]);
    expect(JSON.stringify(stored)).not.toContain(key);
    expect((await probe(h, key)).status).toBe(200);
    // The listing never shows keys.
    expect((await run(h, ["server:key:list"])).out).not.toContain(key);
  });

  it("registers a key from the environment (how the dev setup works), idempotently, and refuses a short one", async () => {
    const h = await harness();
    const env = {
      API_KEY: "WARNING_DEV_API_KEY_DO_NOT_USE_IN_PRODUCTION",
      SHORT: "short",
    };
    expect(
      (await run(h, ["server:key:create", "dev", "--from-env", "API_KEY"], env))
        .out,
    ).toMatch(/registered key #\d+ "dev" from API_KEY/);
    expect(
      (await run(h, ["server:key:create", "dev", "--from-env", "API_KEY"], env))
        .out,
    ).toMatch(/already registered/);
    expect(await rows(h, "SELECT 1 FROM server_api_keys")).toHaveLength(1);
    expect((await probe(h, env.API_KEY)).status).toBe(200);
    expect(
      (await run(h, ["server:key:create", "x", "--from-env", "SHORT"], env))
        .err,
    ).toMatch(/at least 16 characters/);
    expect(
      (await run(h, ["server:key:create", "x", "--from-env", "MISSING"], env))
        .code,
    ).toBe(2);
  });

  it("revokes a key: the API stops accepting it at once", async () => {
    const h = await harness();
    const key = (await run(h, ["server:key:create", "old"])).out
      .split("\n")
      .find((l) => l.startsWith("dfk_"))!;
    const id = (await rows(h, "SELECT id FROM server_api_keys"))[0].id;
    expect((await probe(h, key)).status).toBe(200);
    expect(
      (await run(h, ["server:key:revoke", String(id), "--yes"])).code,
    ).toBe(0);
    expect((await probe(h, key)).status).toBe(401);
    expect(
      (await run(h, ["server:key:revoke", String(id), "--yes"])).err,
    ).toMatch(/no active key/);
    expect((await run(h, ["server:key:list"])).out).toMatch(/revoked/);
    expect((await run(h, ["server:key:revoke", "abc", "--yes"])).err).toMatch(
      /must be a number/,
    );
  });
});

describeDb("admin: audit log", () => {
  it("records every change with who did it and what", async () => {
    const h = await harness();
    const { jwt } = await newGuest(h);
    const id = await publicIdOf(h, jwt);
    await run(h, [
      "user:ban",
      id,
      "--category",
      "abuse",
      "--reason",
      "slurs",
      "--yes",
    ]);
    await run(h, ["user:unban", id]);
    await run(h, ["user:role", id, "flagged", "--yes"]);
    await run(h, ["server:key:create", "k"]);
    await run(h, ["user:find", id]); // reads are not audited
    const log = await rows(
      h,
      "SELECT actor, action, target_type, target_id, details FROM admin_audit_log ORDER BY id",
    );
    expect(log.map((l) => l.action)).toEqual([
      "user:ban",
      "user:unban",
      "user:role",
      "server:key:create",
    ]);
    expect(log.every((l) => l.actor === "tester")).toBe(true);
    expect(log[0]).toMatchObject({
      target_type: "user",
      target_id: id,
      details: { category: "abuse", reason: "slurs" },
    });
    // No key material in the log.
    expect(JSON.stringify(log)).not.toMatch(/dfk_/);
  });

  it("a failed command leaves nothing behind", async () => {
    const h = await harness();
    await run(h, ["user:ban", "ghost0000000", "--category", "x", "--yes"]);
    expect(await rows(h, "SELECT 1 FROM admin_audit_log")).toHaveLength(0);
  });
});

describe("the app origin used by tests", () => {
  it("is the allowed dev origin", () => {
    expect(APP_ORIGIN).toBe("http://localhost:9000");
  });
});
