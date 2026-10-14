// @vitest-environment node
import {
  PlayerProfileSchema,
  PutUsernameResponseSchema,
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
    c: { discord: { id: "disc-3", username: "cat", verified: true } },
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

async function signIn(h: Harness, code: "a" | "b" | "c") {
  const { jar } = await completeLogin(h, "discord", code);
  const jwt = (await (await refresh(h, jar)).json()).jwt as string;
  const me = async () =>
    UserMeResponseSchema.parse(
      await (await call(h, "/users/@me", { bearer: jwt, origin: null })).json(),
    ).player;
  return { jar, jwt, me, publicId: (await me()).publicId };
}
type Account = Awaited<ReturnType<typeof signIn>>;

const put = (h: Harness, who: Account, body: Record<string, unknown>) =>
  call(h, "/users/@me/username", {
    method: "PUT",
    bearer: who.jwt,
    json: body,
  });

const args = (id: string) => [id, "--reason", "owner", "--yes"];
const grant = (h: Harness, who: Account) =>
  run(h, ["user:grant-bare-name", ...args(who.publicId)]);

describeDb("bare usernames: ordinary accounts", () => {
  it("an ordinary account still gets a numbered name, and is told nothing special", async () => {
    const h = await harness();
    const ann = await signIn(h, "a");
    expect((await ann.me()).bareUsernameEnabled).toBe(false);

    const res = await put(h, ann, { username: "Alphaz" });
    expect(res.status).toBe(200);
    const body = PutUsernameResponseSchema.parse(await res.json());
    expect(body.username).toMatch(/^Alphaz\.\d{4}$/);
    expect(body.discriminator).toMatch(/^\d{4}$/);
    expect(body.bareClaim).toBe("not_eligible");
    const me = await ann.me();
    expect(me.usernameDiscriminator).toBe(body.discriminator);
    expect(me.username).toBe(body.username);
  });

  it("cannot grant itself the entitlement, however the request is shaped", async () => {
    const h = await harness();
    const ann = await signIn(h, "a");
    for (const body of [
      { username: "Alphaz", bare: true },
      { username: "Alphaz", bareUsernameEnabled: true },
      { username: "Alphaz", bare_username_enabled: true, acceptSuffixed: true },
    ]) {
      await h.db.pool.query("UPDATE users SET next_username_change_at = NULL");
      const res = await put(h, ann, body);
      expect(
        PutUsernameResponseSchema.parse(await res.json()).username,
      ).toMatch(/^Alphaz\.\d{4}$/);
    }
    await call(h, "/users/@me", {
      method: "PUT",
      bearer: ann.jwt,
      json: { bareUsernameEnabled: true },
    });
    expect((await ann.me()).bareUsernameEnabled).toBe(false);
    expect(
      await rows(h, "SELECT 1 FROM users WHERE bare_username_enabled"),
    ).toHaveLength(0);
  });

  it("an admin role alone does not grant a bare name", async () => {
    const h = await harness();
    const ann = await signIn(h, "a");
    await run(h, [
      "user:role",
      ann.publicId,
      "admin",
      "--yes",
      "--reason",
      "x",
    ]);
    const res = await put(h, ann, { username: "Alphaz" });
    expect(PutUsernameResponseSchema.parse(await res.json()).username).toMatch(
      /^Alphaz\.\d{4}$/,
    );
    expect((await ann.me()).bareUsernameEnabled).toBe(false);
  });

  it("verified status alone does not grant a bare name", async () => {
    const h = await harness();
    const ann = await signIn(h, "a");
    await run(h, ["user:verify", ...args(ann.publicId)]);
    const res = await put(h, ann, { username: "Alphaz" });
    expect(PutUsernameResponseSchema.parse(await res.json()).username).toMatch(
      /^Alphaz\.\d{4}$/,
    );
    const me = await ann.me();
    expect(me.verified).toBe(true);
    expect(me.bareUsernameEnabled).toBe(false);
  });
});

describeDb("bare usernames: the entitlement and the claim", () => {
  it("an entitled account claims the bare name, and /users/@me and the profile report it", async () => {
    const h = await harness();
    const ann = await signIn(h, "a");
    await grant(h, ann);

    const res = await put(h, ann, { username: "Alphaz" });
    expect(res.status).toBe(200);
    expect(PutUsernameResponseSchema.parse(await res.json())).toMatchObject({
      username: "Alphaz",
      base: "Alphaz",
      discriminator: null,
      usernameStatus: "unclaimed",
      bareClaim: "claimed",
    });

    const me = await ann.me();
    expect(me).toMatchObject({
      username: "Alphaz",
      usernameBase: "Alphaz",
      usernameDiscriminator: null,
      // never faked as a premium or indefinite claim
      usernameStatus: "unclaimed",
      bareUsernameEnabled: true,
      verified: false,
    });
    const profile = PlayerProfileSchema.parse(
      await (
        await call(h, `/public/player/${ann.publicId}`, { origin: null })
      ).json(),
    );
    expect(profile.username).toBe("Alphaz");
    expect(profile.verified).toBe(false);
  });

  it("the grant clears the rename cooldown, so a recent numbered name does not block the claim", async () => {
    const h = await harness();
    const ann = await signIn(h, "a");
    await put(h, ann, { username: "Alphaz" }); // numbered, starts the cooldown
    expect((await put(h, ann, { username: "Alphaz" })).status).toBe(429);

    await grant(h, ann);
    const res = await put(h, ann, { username: "Alphaz" });
    expect(PutUsernameResponseSchema.parse(await res.json()).username).toBe(
      "Alphaz",
    );
    // and the cooldown applies again afterwards
    expect((await put(h, ann, { username: "Other" })).status).toBe(429);
  });

  it("bare names are unique, case-insensitively; nothing is taken from the holder", async () => {
    const h = await harness();
    const ann = await signIn(h, "a");
    const bob = await signIn(h, "b");
    await grant(h, ann);
    await grant(h, bob);
    await put(h, ann, { username: "Alphaz" });

    for (const name of ["Alphaz", "alphaz", "ALPHAZ"]) {
      const res = await put(h, bob, { username: name });
      expect(res.status, name).toBe(409);
      expect(await res.json()).toEqual({ code: "BARE_NAME_TAKEN", base: name });
    }
    expect((await ann.me()).username).toBe("Alphaz");
    expect((await bob.me()).username).toBeNull(); // nothing written, no cooldown spent

    // Saying yes to the numbered form gives the announced fallback.
    const fallback = await put(h, bob, {
      username: "Alphaz",
      acceptSuffixed: true,
    });
    const body = PutUsernameResponseSchema.parse(await fallback.json());
    expect(body.username).toMatch(/^Alphaz\.\d{4}$/);
    expect(body.bareClaim).toBe("unavailable");
    expect((await ann.me()).username).toBe("Alphaz");
  });

  it("re-saving the same bare name in another case is the holder's own change, not a collision", async () => {
    const h = await harness();
    const ann = await signIn(h, "a");
    await grant(h, ann);
    await put(h, ann, { username: "Alphaz" });
    await h.db.pool.query("UPDATE users SET next_username_change_at = NULL");
    const res = await put(h, ann, { username: "ALPHAZ" });
    expect(PutUsernameResponseSchema.parse(await res.json()).username).toBe(
      "ALPHAZ",
    );
  });

  it("the bare form is separate from numbered names: both can exist, neither is touched", async () => {
    const h = await harness();
    const ann = await signIn(h, "a");
    const bob = await signIn(h, "b");
    await put(h, bob, { username: "Alphaz" });
    const numbered = (await bob.me()).username;
    await grant(h, ann);
    await put(h, ann, { username: "Alphaz" });
    expect((await ann.me()).username).toBe("Alphaz");
    expect((await bob.me()).username).toBe(numbered);
  });
});

describeDb("bare usernames: admin commands", () => {
  it("need --yes and --reason", async () => {
    const h = await harness();
    const ann = await signIn(h, "a");
    for (const cmd of ["user:grant-bare-name", "user:revoke-bare-name"]) {
      const noYes = await run(h, [cmd, ann.publicId, "--reason", "x"]);
      expect(noYes.code, cmd).toBe(2);
      expect(noYes.err).toMatch(/--yes/);
      const noReason = await run(h, [cmd, ann.publicId, "--yes"]);
      expect(noReason.code, cmd).toBe(2);
      expect(noReason.err).toMatch(/--reason/);
    }
    expect(await rows(h, "SELECT 1 FROM admin_audit_log")).toHaveLength(0);
  });

  it("grant sets the flag and is audited; user:show says so", async () => {
    const h = await harness();
    const ann = await signIn(h, "a");
    expect((await run(h, ["user:show", ann.publicId])).out).toMatch(
      /bare name:\s+not entitled/,
    );
    const r = await grant(h, ann);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/may now claim a bare username/);
    expect(
      await rows(
        h,
        "SELECT actor, action, target_type, target_id, details FROM admin_audit_log",
      ),
    ).toEqual([
      {
        actor: "tester",
        action: "user:grant-bare-name",
        target_type: "user",
        target_id: ann.publicId,
        details: {
          from: false,
          bareUsernameEnabled: true,
          username: null,
          holdsBareName: false,
          reason: "owner",
        },
      },
    ]);
    expect((await run(h, ["user:show", ann.publicId])).out).toMatch(
      /bare name:\s+entitled/,
    );
  });

  it("revoke clears the flag, is audited, and keeps the held name (no silent rewrite)", async () => {
    const h = await harness();
    const ann = await signIn(h, "a");
    await grant(h, ann);
    await put(h, ann, { username: "Alphaz" });

    const r = await run(h, ["user:revoke-bare-name", ...args(ann.publicId)]);
    expect(r.out).toMatch(/keep holding the bare name "Alphaz"/);
    const audit = await rows(
      h,
      "SELECT action, details FROM admin_audit_log ORDER BY id",
    );
    expect(audit.map((a) => a.action)).toEqual([
      "user:grant-bare-name",
      "user:revoke-bare-name",
    ]);
    expect(audit[1].details).toEqual({
      from: true,
      bareUsernameEnabled: false,
      username: "Alphaz",
      holdsBareName: true,
      reason: "owner",
    });

    const me = await ann.me();
    expect(me).toMatchObject({
      username: "Alphaz",
      usernameDiscriminator: null,
      bareUsernameEnabled: false,
    });
    expect((await run(h, ["user:show", ann.publicId])).out).toMatch(
      /username:\s+Alphaz\s+\(bare name held\)/,
    );

    // Their next rename is an ordinary numbered one; nothing is appended before.
    await h.db.pool.query("UPDATE users SET next_username_change_at = NULL");
    const next = await put(h, ann, { username: "Alphaz" });
    expect(PutUsernameResponseSchema.parse(await next.json())).toMatchObject({
      discriminator: expect.stringMatching(/^\d{4}$/),
      bareClaim: "not_eligible",
    });
  });

  it("repeating a command changes and audits nothing", async () => {
    const h = await harness();
    const ann = await signIn(h, "a");
    await grant(h, ann);
    expect((await grant(h, ann)).out).toMatch(/already may claim/);
    await run(h, ["user:revoke-bare-name", ...args(ann.publicId)]);
    expect(
      (await run(h, ["user:revoke-bare-name", ...args(ann.publicId)])).out,
    ).toMatch(/already may not/);
    expect(await rows(h, "SELECT 1 FROM admin_audit_log")).toHaveLength(2);
    expect(
      (await run(h, ["user:grant-bare-name", ...args("nobody00000")])).err,
    ).toMatch(/no user with public id/);
  });
});

describeDb("bare usernames: verification stays independent", () => {
  it("a verified account holding its own bare name keeps the check at join", async () => {
    const h = await harness();
    const ann = await signIn(h, "a");
    await grant(h, ann);
    await put(h, ann, { username: "Alphaz" });
    await run(h, ["user:verify", ...args(ann.publicId)]);
    const me = await ann.me();
    expect(me).toMatchObject({ username: "Alphaz", verified: true });

    const ok = { verified: true };
    expect(resolveVerifiedJoin(ok, "Alphaz", me)).toBe("verified");
    expect(ok.verified).toBe(true);
  });

  it("a bare name without verification never earns the check, and another bare name cannot be borrowed", async () => {
    const h = await harness();
    const ann = await signIn(h, "a");
    const bob = await signIn(h, "b");
    await grant(h, ann);
    await grant(h, bob);
    await put(h, ann, { username: "Alphaz" });
    await put(h, bob, { username: "Bobby" });
    await run(h, ["user:verify", ...args(bob.publicId)]);

    // Unverified bare-name holder (also entitled): intent is dropped.
    const own = { verified: true };
    expect(resolveVerifiedJoin(own, "Alphaz", await ann.me())).toBe("custom");
    expect(own.verified).toBeUndefined();

    // A verified account joining under someone else's bare name.
    const borrowed = { verified: true };
    expect(resolveVerifiedJoin(borrowed, "Alphaz", await bob.me())).toBe(
      "custom",
    );
    expect(borrowed.verified).toBeUndefined();
  });
});
