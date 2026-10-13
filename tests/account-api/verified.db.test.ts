// @vitest-environment node
import {
  PlayerProfileSchema,
  UserMeResponseSchema,
} from "@openfront/shared/ApiSchemas";
import { afterEach, expect, it } from "vitest";
import {
  runAdminCommand,
  type AdminIo,
} from "../../src/account-api/admin/commands";
import { resolveVerifiedJoin } from "../../src/server/Privilege";
import {
  call,
  completeLogin,
  createMockProviders,
  newGuest,
  refresh,
  startHarness,
  type Harness,
} from "./util/harness";
import { describeDb } from "./util/testDb";

const harnesses: Harness[] = [];
async function harness(): Promise<Harness> {
  const mock = createMockProviders({
    a: { discord: { id: "disc-1", username: "ann", verified: true } },
    b: { discord: { id: "disc-2", username: "bob", verified: true } },
  });
  const h = await startHarness({ fetchFn: mock.fetchFn });
  harnesses.push(h);
  return h;
}
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.close();
});

function run(h: Harness, argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const io: AdminIo = {
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    env: {},
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

const me = async (h: Harness, jwt: string) =>
  UserMeResponseSchema.parse(
    await (await call(h, "/users/@me", { bearer: jwt, origin: null })).json(),
  ).player;

const profileOf = async (h: Harness, publicId: string) =>
  PlayerProfileSchema.parse(
    await (
      await call(h, `/public/player/${publicId}`, { origin: null })
    ).json(),
  );

/** A signed-in (registered) account with a chosen username. */
async function account(h: Harness, code: "a" | "b", base: string) {
  const { jar } = await completeLogin(h, "discord", code);
  const jwt = (await (await refresh(h, jar)).json()).jwt as string;
  const put = await call(h, "/users/@me/username", {
    method: "PUT",
    bearer: jwt,
    json: { username: base, acceptSuffixed: true },
  });
  expect(put.status).toBe(200);
  const player = await me(h, jwt);
  return { jar, jwt, player };
}

const verifyArgs = (id: string) => [id, "--reason", "owner", "--yes"];

describeDb("verified accounts: default and storage", () => {
  it("every account starts unverified, in the database and in every response", async () => {
    const h = await harness();
    const guest = await newGuest(h);
    const guestMe = await me(h, guest.jwt);
    expect(guestMe.verified).toBe(false);
    const reg = await account(h, "a", "Ann");
    expect(reg.player.verified).toBe(false);
    expect((await profileOf(h, reg.player.publicId)).verified).toBe(false);
    expect(await rows(h, "SELECT verified FROM users")).toEqual([
      { verified: false },
      { verified: false },
    ]);
  });

  it("the column is NOT NULL with a false default (forward-only migration 0004)", async () => {
    const h = await harness();
    const [col] = await rows(
      h,
      `SELECT is_nullable, column_default FROM information_schema.columns
        WHERE table_name = 'users' AND column_name = 'verified'`,
    );
    expect(col).toEqual({ is_nullable: "NO", column_default: "false" });
    expect(
      await rows(
        h,
        "SELECT version FROM schema_migrations WHERE version = '0004'",
      ),
    ).toHaveLength(1);
  });
});

describeDb("verified accounts: admin commands", () => {
  it("user:verify and user:unverify need --yes and --reason", async () => {
    const h = await harness();
    const { player } = await account(h, "a", "Ann");
    for (const cmd of ["user:verify", "user:unverify"]) {
      const noYes = await run(h, [cmd, player.publicId, "--reason", "owner"]);
      expect(noYes.code, cmd).toBe(2);
      expect(noYes.err).toMatch(/--yes/);
      const noReason = await run(h, [cmd, player.publicId, "--yes"]);
      expect(noReason.code, cmd).toBe(2);
      expect(noReason.err).toMatch(/--reason/);
    }
    expect(await rows(h, "SELECT 1 FROM users WHERE verified")).toHaveLength(0);
    expect(await rows(h, "SELECT 1 FROM admin_audit_log")).toHaveLength(0);
  });

  it("user:verify sets the flag, audits it, and shows it everywhere it is exposed", async () => {
    const h = await harness();
    const { jwt, player } = await account(h, "a", "Ann");
    const r = await run(h, ["user:verify", ...verifyArgs(player.publicId)]);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/is now verified/);

    expect((await me(h, jwt)).verified).toBe(true);
    expect((await profileOf(h, player.publicId)).verified).toBe(true);
    expect((await run(h, ["user:show", player.publicId])).out).toMatch(
      /verified:\s+yes/,
    );
    expect(
      await rows(
        h,
        "SELECT actor, action, target_type, target_id, details FROM admin_audit_log",
      ),
    ).toEqual([
      {
        actor: "tester",
        action: "user:verify",
        target_type: "user",
        target_id: player.publicId,
        details: { from: false, verified: true, reason: "owner" },
      },
    ]);
  });

  it("user:unverify clears the flag and audits it", async () => {
    const h = await harness();
    const { jwt, player } = await account(h, "a", "Ann");
    await run(h, ["user:verify", ...verifyArgs(player.publicId)]);
    const r = await run(h, ["user:unverify", ...verifyArgs(player.publicId)]);
    expect(r.out).toMatch(/is now unverified/);
    expect((await me(h, jwt)).verified).toBe(false);
    expect((await profileOf(h, player.publicId)).verified).toBe(false);
    const audit = await rows(
      h,
      "SELECT action, details FROM admin_audit_log ORDER BY id",
    );
    expect(audit.map((a) => a.action)).toEqual([
      "user:verify",
      "user:unverify",
    ]);
    expect(audit[1].details).toEqual({
      from: true,
      verified: false,
      reason: "owner",
    });
  });

  it("repeating a command changes and audits nothing", async () => {
    const h = await harness();
    const { player } = await account(h, "a", "Ann");
    await run(h, ["user:verify", ...verifyArgs(player.publicId)]);
    const again = await run(h, ["user:verify", ...verifyArgs(player.publicId)]);
    expect(again.out).toMatch(/already verified/);
    const none = await run(h, ["user:unverify", ...verifyArgs("nobody00000")]);
    expect(none.err).toMatch(/no user with public id/);
    expect(await rows(h, "SELECT 1 FROM admin_audit_log")).toHaveLength(1);
  });

  it("only the named account is verified, and the admin role does not imply it", async () => {
    const h = await harness();
    const ann = await account(h, "a", "Ann");
    const bob = await account(h, "b", "Bob");
    await run(h, [
      "user:role",
      ann.player.publicId,
      "admin",
      "--yes",
      "--reason",
      "owner",
    ]);
    expect((await me(h, ann.jwt)).verified).toBe(false);

    await run(h, ["user:verify", ...verifyArgs(bob.player.publicId)]);
    expect((await me(h, bob.jwt)).verified).toBe(true);
    expect((await me(h, ann.jwt)).verified).toBe(false);

    // Taking the role away does not touch verification either.
    await run(h, [
      "user:role",
      bob.player.publicId,
      "none",
      "--yes",
      "--reason",
      "owner",
    ]);
    expect((await me(h, bob.jwt)).verified).toBe(true);
  });
});

describeDb("verified accounts: sessions and login", () => {
  it("survives token refresh, session revocation and a fresh sign-in", async () => {
    const h = await harness();
    const first = await account(h, "a", "Ann");
    const id = first.player.publicId;
    await run(h, ["user:verify", ...verifyArgs(id)]);

    const refreshed = (await (await refresh(h, first.jar)).json()).jwt;
    expect((await me(h, refreshed)).verified).toBe(true);

    await run(h, ["user:revoke-sessions", id, "--reason", "test", "--yes"]);
    expect((await refresh(h, first.jar)).status).toBe(401);

    const again = await completeLogin(h, "discord", "a");
    const jwt = (await (await refresh(h, again.jar)).json()).jwt;
    const player = await me(h, jwt);
    expect(player.publicId).toBe(id);
    expect(player.verified).toBe(true);
  });
});

describeDb("verified accounts: the client cannot grant it", () => {
  it("no request body, query or username update sets verified", async () => {
    const h = await harness();
    const { jar, jwt, player } = await account(h, "a", "Ann");
    await call(h, "/users/@me/username", {
      method: "PUT",
      bearer: jwt,
      json: { username: "Annie", acceptSuffixed: true, verified: true },
    });
    await call(h, "/auth/refresh", {
      method: "POST",
      jar,
      json: { verified: true },
    });
    await call(h, "/users/@me?verified=true", { bearer: jwt, origin: null });
    await call(h, "/users/@me", {
      method: "PUT",
      bearer: jwt,
      json: { verified: true },
    });
    expect((await me(h, jwt)).verified).toBe(false);
    expect(await rows(h, "SELECT 1 FROM users WHERE verified")).toHaveLength(0);
    expect((await profileOf(h, player.publicId)).verified).toBe(false);
  });
});

// The game server decides from the account API's own /users/@me answer. These
// feed that real answer to the join decision.
describeDb("verified accounts: join decision on the real /users/@me", () => {
  it("keeps the check only for a verified account joining under its own name", async () => {
    const h = await harness();
    const { jwt, player } = await account(h, "a", "Ann");
    const name = player.username!;

    // Not verified yet: the client's intent alone is refused.
    const spoof = { verified: true };
    expect(resolveVerifiedJoin(spoof, name, await me(h, jwt))).toBe("custom");
    expect(spoof.verified).toBeUndefined();

    await run(h, ["user:verify", ...verifyArgs(player.publicId)]);
    const verifiedMe = await me(h, jwt);

    const ok = { verified: true };
    expect(resolveVerifiedJoin(ok, name, verifiedMe)).toBe("verified");
    expect(ok.verified).toBe(true);

    // The check vouches for the account's own name, not any name.
    for (const other of ["Barack Obama", "Ann", "ann.9999"]) {
      const c = { verified: true };
      expect(resolveVerifiedJoin(c, other, verifiedMe), other).toBe("custom");
      expect(c.verified).toBeUndefined();
    }

    // No intent, no check (the toggle stays the player's choice).
    const noIntent = {} as { verified?: boolean };
    expect(resolveVerifiedJoin(noIntent, name, verifiedMe)).toBe("custom");

    // Unverified again: refused again.
    await run(h, ["user:unverify", ...verifyArgs(player.publicId)]);
    const revoked = { verified: true };
    expect(resolveVerifiedJoin(revoked, name, await me(h, jwt))).toBe("custom");
  });
});
