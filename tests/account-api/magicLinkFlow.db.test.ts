// @vitest-environment node
import { afterEach, expect, it } from "vitest";
import Transport from "winston-transport";
import {
  runAdminCommand,
  type AdminIo,
} from "../../src/account-api/admin/commands";
import type { EmailMessage, Mailer } from "../../src/account-api/auth/email";
import { MailDeliveryError } from "../../src/account-api/auth/email";
import { hashToken } from "../../src/account-api/auth/magicLink";
import {
  runDeletions,
  runRetention,
} from "../../src/account-api/domain/lifecycle";
import { createLogger } from "../../src/account-api/logger";
import {
  call,
  completeLogin,
  CookieJar,
  createMockProviders,
  newGuest,
  refresh,
  startHarness,
  type Harness,
} from "./util/harness";
import { describeDb } from "./util/testDb";

const harnesses: Harness[] = [];
async function harness(options: Parameters<typeof startHarness>[0] = {}) {
  const h = await startHarness({ emailAuth: true, ...options });
  harnesses.push(h);
  return h;
}
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.close().catch(() => undefined);
});

/** A mailer that keeps what it was asked to send, and can be told to fail. */
function capture() {
  const sent: EmailMessage[] = [];
  const state = { fail: null as MailDeliveryError | null };
  const mailer: Mailer = {
    provider: "capture",
    async send(message) {
      if (state.fail !== null) throw state.fail;
      sent.push(message);
    },
  };
  const tokenOf = (i = sent.length - 1): string =>
    /token-login=([A-Za-z0-9_-]{43})/.exec(sent[i].text)![1];
  return { mailer, sent, state, tokenOf };
}

const ask = (
  h: Harness,
  email: unknown,
  jar?: CookieJar,
  extra: Record<string, unknown> = {},
) =>
  call(h, "/auth/magic-link", {
    method: "POST",
    jar,
    json: { email, redirectDomain: h.origin, ...extra },
  });
const use = (
  h: Harness,
  token: string,
  jar?: CookieJar,
  origin?: string | null,
) =>
  call(h, `/auth/login/token?login-token=${encodeURIComponent(token)}`, {
    jar,
    origin,
  });
const q = async (h: Harness, sql: string, params: unknown[] = []) =>
  (await h.db.pool.query(sql, params)).rows;

/** Asks for a link and uses it from `jar`: a complete email sign-in. */
async function signInWithEmail(
  h: Harness,
  m: ReturnType<typeof capture>,
  email: string,
  jar = new CookieJar(),
) {
  expect((await ask(h, email, jar)).status).toBe(204);
  const res = await use(h, m.tokenOf(), jar);
  expect(res.status).toBe(200);
  return { jar, res };
}
const meOf = async (h: Harness, jar: CookieJar) => {
  const r = await (await refresh(h, jar)).json();
  const res = await call(h, "/users/@me", { bearer: r.jwt, origin: null });
  return {
    jwt: r.jwt as string,
    status: res.status,
    body: res.status === 200 ? await res.json() : null,
  };
};

describeDb("requesting a link", () => {
  it("answers 204, sends one email to the normalised address, and the link carries a 43-character token in the fragment", async () => {
    const m = capture();
    const h = await harness({ mailer: m.mailer });
    const res = await ask(h, "  Ann.Smith@Example.COM ");
    expect(res.status).toBe(204);
    expect(await res.text()).toBe("");
    expect(m.sent).toHaveLength(1);
    expect(m.sent[0].to).toBe("ann.smith@example.com");
    const link = /https?:\/\/\S+/.exec(m.sent[0].text)![0];
    expect(link).toMatch(
      new RegExp(`^${h.origin}/#token-login\\?token-login=[A-Za-z0-9_-]{43}$`),
    );
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("rejects what is not an address with 400 and sends nothing", async () => {
    const m = capture();
    const h = await harness({ mailer: m.mailer });
    for (const email of [
      "",
      "ann",
      "ann@",
      "a@b",
      "ann@example.com,bob@example.com",
      5,
      null,
      ["ann@example.com"],
      { a: 1 },
      "ann@example.com\r\nBcc: x@y.co",
    ]) {
      const res = await ask(h, email);
      expect(res.status, JSON.stringify(email)).toBe(400);
      expect(await res.json()).toEqual({ code: "invalid_email" });
    }
    expect(
      (
        await call(h, "/auth/magic-link", {
          method: "POST",
          json: { redirectDomain: h.origin },
        })
      ).status,
    ).toBe(400);
    expect(m.sent).toHaveLength(0);
    expect(await q(h, "SELECT 1 FROM magic_link_tokens")).toHaveLength(0);
  });

  it("refuses a link that would point anywhere but an allowed origin (no open redirect), sending nothing", async () => {
    const m = capture();
    const h = await harness({ mailer: m.mailer });
    for (const redirectDomain of [
      "https://evil.example",
      "http://localhost:9000.evil.test",
      "http://localhost:9000/x",
      "//evil.example",
      "javascript:alert(1)",
      "localhost:9000@evil.example",
      "",
      5,
      null,
    ]) {
      const res = await ask(h, "ann@example.com", undefined, {
        redirectDomain,
      });
      expect(res.status, JSON.stringify(redirectDomain)).toBe(400);
      expect(await res.json()).toEqual({ code: "invalid_redirect_domain" });
    }
    expect(
      (
        await call(h, "/auth/magic-link", {
          method: "POST",
          json: { email: "ann@example.com" },
        })
      ).status,
    ).toBe(400);
    expect(m.sent).toHaveLength(0);
    // the bare host of an allowed origin is fine
    expect(
      (
        await ask(h, "ann@example.com", undefined, {
          redirectDomain: "localhost:9000",
        })
      ).status,
    ).toBe(204);
    expect(m.sent[0].text).toContain("http://localhost:9000/#token-login");
  });

  it("is a cookie-authenticated mutation: a foreign or missing Origin is refused", async () => {
    const m = capture();
    const h = await harness({ mailer: m.mailer });
    for (const origin of [
      "https://evil.example",
      null,
      "http://localhost:9000.evil.test",
    ]) {
      const res = await call(h, "/auth/magic-link", {
        method: "POST",
        origin,
        json: { email: "ann@example.com", redirectDomain: h.origin },
      });
      expect(res.status, String(origin)).toBe(403);
    }
    expect(m.sent).toHaveLength(0);
  });

  it("rejects malformed and oversized bodies without sending or storing anything", async () => {
    const m = capture();
    const h = await harness({ mailer: m.mailer });
    const raw = (body: string, type = "application/json") =>
      fetch(`${h.baseUrl}/auth/magic-link`, {
        method: "POST",
        headers: { "Content-Type": type, Origin: h.origin },
        body,
      });
    for (const body of [
      "{not json",
      "[]",
      '"x"',
      "null",
      JSON.stringify({
        email: "a@b.co",
        redirectDomain: h.origin,
        pad: "x".repeat(4000),
      }),
    ]) {
      expect(
        (await raw(body)).status,
        body.slice(0, 20),
      ).toBeGreaterThanOrEqual(400);
    }
    expect(
      (await raw("email=ann@example.com", "application/x-www-form-urlencoded"))
        .status,
    ).toBe(400);
    expect(m.sent).toHaveLength(0);
    expect(await q(h, "SELECT 1 FROM magic_link_tokens")).toHaveLength(0);
  });

  it("tells a stranger nothing about who has an account: the same answer for a known and an unknown address", async () => {
    const m = capture();
    const h = await harness({ mailer: m.mailer });
    await signInWithEmail(h, m, "known@example.com");
    const known = await ask(h, "known@example.com");
    const unknown = await ask(h, "stranger@example.com");
    expect(known.status).toBe(unknown.status);
    expect(await known.text()).toBe(await unknown.text());
    const strip = (r: Response) =>
      [...r.headers].filter(([k]) => !["date", "etag"].includes(k)).sort();
    expect(strip(known)).toEqual(strip(unknown));
    // and an address with a Discord account behind it is no different either
    const other = await ask(h, "stranger2@example.com");
    expect(other.status).toBe(204);
  });

  it("sends at most 3 links per address in 15 minutes and answers the same 204 when it stops, without sending", async () => {
    const m = capture();
    const h = await harness({ mailer: m.mailer });
    for (let i = 0; i < 3; i++)
      expect((await ask(h, "burst@example.com")).status).toBe(204);
    expect(m.sent).toHaveLength(3);
    const fourth = await ask(h, "burst@example.com");
    expect(fourth.status).toBe(204);
    expect(await fourth.text()).toBe("");
    expect(m.sent).toHaveLength(3);
    // another address is unaffected, and case does not dodge the limit
    expect((await ask(h, "other@example.com")).status).toBe(204);
    expect(m.sent).toHaveLength(4);
    await ask(h, "BURST@example.com");
    expect(m.sent).toHaveLength(4);
    // after the window the address may ask again
    await h.db.pool.query(
      "UPDATE magic_link_tokens SET created_at = now() - interval '16 minutes', expires_at = now() - interval '1 minute' WHERE email = 'burst@example.com'",
    );
    expect((await ask(h, "burst@example.com")).status).toBe(204);
    expect(m.sent).toHaveLength(5);
  });

  it("does not let concurrent requests slip past the per-address limit", async () => {
    const m = capture();
    const h = await harness({
      mailer: m.mailer,
      limits: { magicLinkRequest: { max: 1000, windowMs: 60_000 } },
    });
    const results = await Promise.all(
      Array.from({ length: 12 }, () => ask(h, "race@example.com")),
    );
    expect(results.every((r) => r.status === 204)).toBe(true);
    expect(m.sent).toHaveLength(3);
  });

  it("limits requests per client address with a 429", async () => {
    const m = capture();
    const h = await harness({
      mailer: m.mailer,
      limits: { magicLinkRequest: { max: 2, windowMs: 60_000 } },
    });
    expect((await ask(h, "a1@example.com")).status).toBe(204);
    expect((await ask(h, "a2@example.com")).status).toBe(204);
    const limited = await ask(h, "a3@example.com");
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).not.toBeNull();
    expect(m.sent).toHaveLength(2);
  });

  it("says so when delivery fails (503), leaves no link behind, and does not count the failure against the address", async () => {
    const m = capture();
    const h = await harness({ mailer: m.mailer });
    m.state.fail = new MailDeliveryError("resend answered 500", true);
    for (let i = 0; i < 5; i++) {
      const res = await ask(h, "down@example.com");
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ code: "delivery_failed" });
    }
    expect(await q(h, "SELECT 1 FROM magic_link_tokens")).toHaveLength(0);
    m.state.fail = null;
    expect((await ask(h, "down@example.com")).status).toBe(204);
    expect(m.sent).toHaveLength(1);
  });
});

describeDb("when email sign-in is off", () => {
  it("both routes are 404, nothing is stored, and there is no outbox", async () => {
    const m = capture();
    const h = await harness({ emailAuth: false, mailer: m.mailer });
    expect((await ask(h, "ann@example.com")).status).toBe(404);
    expect((await use(h, "A".repeat(43))).status).toBe(404);
    expect((await call(h, "/dev/email-outbox")).status).toBe(404);
    expect(m.sent).toHaveLength(0);
    expect(await q(h, "SELECT 1 FROM magic_link_tokens")).toHaveLength(0);
  });

  it("a deployment with Discord and Google only is unchanged: their sign-in still works", async () => {
    const mock = createMockProviders({
      d: {
        discord: {
          id: "d-off",
          username: "off",
          email: "off@example.com",
          verified: true,
        },
      },
    });
    const h = await harness({ emailAuth: false, fetchFn: mock.fetchFn });
    const { callback, jar } = await completeLogin(h, "discord", "d");
    expect(callback.status).toBe(302);
    expect((await meOf(h, jar)).status).toBe(200);
  });
});

describeDb("using a link", () => {
  it("signs in a new address: an account, one email identity, a session cookie, and the same cookie model as Discord and Google", async () => {
    const m = capture();
    const h = await harness({ mailer: m.mailer });
    const jar = new CookieJar();
    await ask(h, "New.Person@Example.com", jar);
    const res = await use(h, m.tokenOf(), jar);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ email: "new.person@example.com" });
    const cookie = res.headers
      .getSetCookie()
      .find((c) => c.startsWith("df_refresh="))!;
    expect(cookie).toMatch(/; HttpOnly/);
    expect(cookie).toMatch(/; SameSite=Lax/);
    expect(cookie).toMatch(/; Path=\//);
    expect(cookie).toMatch(/; Max-Age=2592000/);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const ids = await q(
      h,
      "SELECT provider, provider_user_id, email::text AS email, email_verified FROM auth_identities",
    );
    expect(ids).toEqual([
      {
        provider: "email",
        provider_user_id: "new.person@example.com",
        email: "new.person@example.com",
        email_verified: true,
      },
    ]);
    const me = await meOf(h, jar);
    expect(me.status).toBe(200);
    expect(me.body.user).toEqual({ email: "new.person@example.com" });
    expect((await q(h, "SELECT kind FROM users"))[0].kind).toBe("registered");
    expect(
      JSON.parse(Buffer.from(me.jwt.split(".")[1], "base64url").toString())
        .provider,
    ).toBe("email");
  });

  it("signing in again with the same address from another browser reaches the same account", async () => {
    const m = capture();
    const h = await harness({ mailer: m.mailer });
    const a = await signInWithEmail(h, m, "twice@example.com");
    const b = await signInWithEmail(h, m, "twice@example.com");
    expect((await meOf(h, a.jar)).body.player.publicId).toBe(
      (await meOf(h, b.jar)).body.player.publicId,
    );
    expect(await q(h, "SELECT 1 FROM users")).toHaveLength(1);
  });

  it("works once: a second use is `consumed`, an unknown token `invalid`, an old one `expired`", async () => {
    const m = capture();
    const h = await harness({ mailer: m.mailer });
    await ask(h, "once@example.com");
    const token = m.tokenOf();
    expect((await use(h, token)).status).toBe(200);
    const again = await use(h, token);
    expect(again.status).toBe(400);
    expect(await again.json()).toEqual({ code: "consumed" });
    expect(again.headers.getSetCookie()).toEqual([]);
    const unknown = await use(h, "Z".repeat(43));
    expect(unknown.status).toBe(400);
    expect(await unknown.json()).toEqual({ code: "invalid" });

    await ask(h, "late@example.com");
    const late = m.tokenOf();
    await h.db.pool.query(
      "UPDATE magic_link_tokens SET created_at = now() - interval '20 minutes', expires_at = now() - interval '1 second' WHERE token_hash = $1",
      [hashToken(late)],
    );
    const expired = await use(h, late);
    expect(expired.status).toBe(400);
    expect(await expired.json()).toEqual({ code: "expired" });
    expect(
      await q(
        h,
        "SELECT 1 FROM auth_identities WHERE provider_user_id = 'late@example.com'",
      ),
    ).toHaveLength(0);
  });

  it("a replay cannot win even when many requests carry the token at the same instant", async () => {
    const m = capture();
    const h = await harness({
      mailer: m.mailer,
      limits: { magicLinkConsume: { max: 1000, windowMs: 60_000 } },
    });
    await ask(h, "race@example.com");
    const token = m.tokenOf();
    const results = await Promise.all(
      Array.from({ length: 12 }, () => use(h, token)),
    );
    const codes = await Promise.all(
      results.map(async (r) =>
        r.status === 200 ? "ok" : (await r.json()).code,
      ),
    );
    expect(codes.filter((c) => c === "ok")).toHaveLength(1);
    expect(codes.filter((c) => c === "consumed").length).toBe(11);
    expect(await q(h, "SELECT 1 FROM users")).toHaveLength(1);
    expect(await q(h, "SELECT 1 FROM auth_identities")).toHaveLength(1);
  });

  it("malformed tokens are refused before the database is asked", async () => {
    const m = capture();
    const h = await harness({
      mailer: m.mailer,
      limits: { magicLinkConsume: { max: 1000, windowMs: 60_000 } },
    });
    for (const t of [
      "",
      "x",
      "A".repeat(42),
      "A".repeat(44),
      `${"A".repeat(42)}+`,
      "../".repeat(15),
      `${"A".repeat(41)}%00`,
      "A".repeat(5000),
    ]) {
      const res = await call(
        h,
        `/auth/login/token?login-token=${encodeURIComponent(t)}`,
      );
      expect(res.status, t.slice(0, 20)).toBe(400);
      expect(await res.json()).toEqual({ code: "invalid" });
    }
    for (const path of [
      "/auth/login/token",
      "/auth/login/token?login-token=a&login-token=b",
      "/auth/login/token?login-token[]=a",
    ]) {
      expect((await call(h, path)).status, path).toBe(400);
    }
  });

  it("refuses a foreign Origin, or none at all, without consuming the link (no login CSRF), and accepts the page's own", async () => {
    const m = capture();
    const h = await harness({ mailer: m.mailer });
    await ask(h, "origin@example.com");
    const token = m.tokenOf();
    for (const origin of [
      "https://evil.example",
      null,
      "http://localhost:9000.evil.test",
      "null",
    ]) {
      const res = await use(h, token, undefined, origin);
      expect(res.status, String(origin)).toBe(403);
      expect(await res.json()).toEqual({ code: "forbidden_origin" });
      expect(res.headers.getSetCookie()).toEqual([]);
    }
    expect(
      (await q(h, "SELECT consumed_at FROM magic_link_tokens"))[0].consumed_at,
    ).toBeNull();
    expect(await q(h, "SELECT 1 FROM users")).toHaveLength(0);
    expect((await use(h, token)).status).toBe(200);
  });

  it("limits attempts per client address with a 429", async () => {
    const h = await harness({
      mailer: capture().mailer,
      limits: { magicLinkConsume: { max: 3, windowMs: 60_000 } },
    });
    for (let i = 0; i < 3; i++)
      expect((await use(h, "A".repeat(43))).status).toBe(400);
    const limited = await use(h, "A".repeat(43));
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).not.toBeNull();
  });

  it("stores only the SHA-256 of the token: the raw token is nowhere in the database", async () => {
    const m = capture();
    const h = await harness({ mailer: m.mailer });
    await ask(h, "hash@example.com");
    const token = m.tokenOf();
    const [row] = await q(
      h,
      "SELECT encode(token_hash, 'hex') AS hash FROM magic_link_tokens",
    );
    expect(row.hash).toBe(hashToken(token).toString("hex"));
    await use(h, token);
    for (const table of [
      "magic_link_tokens",
      "auth_identities",
      "refresh_sessions",
      "oauth_states",
      "users",
      "admin_audit_log",
    ]) {
      const text = JSON.stringify(
        await q(h, `SELECT t::text AS row FROM ${table} t`),
      );
      expect(text, table).not.toContain(token);
    }
    // not even in a raw dump of the whole token row
    const dump = await q(h, "SELECT t::text AS row FROM magic_link_tokens t");
    expect(dump[0].row).not.toContain(token);
  });
});

describeDb("accounts: creation, upgrade and conflicts", () => {
  async function richGuest(h: Harness) {
    const guest = await newGuest(h);
    const [{ id, public_id }] = await q(
      h,
      "SELECT id, public_id FROM users WHERE kind = 'guest' ORDER BY created_at DESC LIMIT 1",
    );
    await h.db.pool.query(
      "INSERT INTO wallets (user_id, credits) VALUES ($1, 750) ON CONFLICT (user_id) DO UPDATE SET credits = 750",
      [id],
    );
    const purchase = (
      await q(
        h,
        "INSERT INTO purchases (user_id, kind, item_key, flares, price_credits, catalog_version) VALUES ($1, 'cosmetic', 'flag:delta_mark', ARRAY['flag:delta_mark'], 300, 'v') RETURNING id",
        [id],
      )
    )[0].id;
    await h.db.pool.query(
      "INSERT INTO user_flares (user_id, flare, source, purchase_id) VALUES ($1, 'flag:delta_mark', 'purchase', $2)",
      [id, purchase],
    );
    const gameId = (
      await q(
        h,
        "INSERT INTO games (game_code, source, type, started_at, ended_at, duration_s, human_players, counts_for_stats) VALUES ('mlgame0001','server','Public', now() - interval '10 minutes', now(), 600, 2, true) RETURNING id",
      )
    )[0].id;
    await h.db.pool.query(
      "INSERT INTO game_players (game_id, client_id, user_id, username, result, completed, credits_awarded) VALUES ($1, 'c1', $2, 'Guesty', 'victory', true, 100)",
      [gameId, id],
    );
    const clanId = (
      await q(
        h,
        "INSERT INTO clans (tag, name) VALUES ('MLT', 'Magic Link Team') RETURNING id",
      )
    )[0].id;
    await h.db.pool.query(
      "INSERT INTO clan_members (clan_id, user_id, role) VALUES ($1, $2, 'leader')",
      [clanId, id],
    );
    return { guest, id: id as string, publicId: public_id as string, clanId };
  }
  const snapshot = async (h: Harness, id: string) => ({
    users: await q(h, "SELECT id, public_id, kind FROM users WHERE id = $1", [
      id,
    ]),
    wallet: await q(
      h,
      "SELECT credits::int AS credits FROM wallets WHERE user_id = $1",
      [id],
    ),
    flares: await q(
      h,
      "SELECT flare FROM user_flares WHERE user_id = $1 AND revoked_at IS NULL",
      [id],
    ),
    purchases: await q(
      h,
      "SELECT item_key, price_credits::int AS p FROM purchases WHERE user_id = $1",
      [id],
    ),
    games: await q(
      h,
      "SELECT username, result, credits_awarded::int AS c FROM game_players WHERE user_id = $1",
      [id],
    ),
    clan: await q(
      h,
      "SELECT clan_id, role FROM clan_members WHERE user_id = $1",
      [id],
    ),
  });

  it("upgrades a guest in place: the same account, public id, Credits, items, purchases, stats and clan", async () => {
    const m = capture();
    const h = await harness({
      mailer: m.mailer,
      features: "accounts,inventory,clans",
    });
    const g = await richGuest(h);
    const before = await snapshot(h, g.id);
    expect(before.users[0].kind).toBe("guest");
    await ask(h, "upgrade@example.com", g.guest.jar);
    expect((await use(h, m.tokenOf(), g.guest.jar)).status).toBe(200);
    const after = await snapshot(h, g.id);
    expect(after.users[0].kind).toBe("registered");
    expect({
      ...after,
      users: after.users.map((u) => ({ ...u, kind: "x" })),
    }).toEqual({
      ...before,
      users: before.users.map((u) => ({ ...u, kind: "x" })),
    });
    expect(after.wallet[0].credits).toBe(750);
    expect(await q(h, "SELECT 1 FROM users")).toHaveLength(1);
    const me = await meOf(h, g.guest.jar);
    expect(me.body.player.publicId).toBe(g.publicId);
    expect(me.body.player.currency.soft).toBe(750);
    expect(me.body.player.flares).toContain("flag:delta_mark");
    expect(me.body.player.clans.map((c: { tag: string }) => c.tag)).toEqual([
      "MLT",
    ]);
    // the leaderboard history still names the same account
    expect((await q(h, "SELECT user_id FROM game_players"))[0].user_id).toBe(
      g.id,
    );
  });

  it("opening the link in another browser upgrades THAT browser's guest, not the one that asked", async () => {
    const m = capture();
    const h = await harness({ mailer: m.mailer });
    const asker = await richGuest(h);
    const phone = await newGuest(h);
    await ask(h, "cross@example.com", asker.guest.jar);
    expect((await use(h, m.tokenOf(), phone.jar)).status).toBe(200);
    expect(
      (await q(h, "SELECT kind FROM users WHERE id = $1", [asker.id]))[0].kind,
    ).toBe("guest");
    expect(
      await q(h, "SELECT 1 FROM auth_identities WHERE user_id = $1", [
        asker.id,
      ]),
    ).toHaveLength(0);
    expect((await meOf(h, phone.jar)).body.user.email).toBe(
      "cross@example.com",
    );
  });

  it("a guest opening a link for an address that already has an email account signs in to it and leaves the guest alone", async () => {
    const m = capture();
    const h = await harness({ mailer: m.mailer });
    const owner = await signInWithEmail(h, m, "owner@example.com");
    const ownerId = (await meOf(h, owner.jar)).body.player.publicId;
    const guest = await richGuest(h);
    await ask(h, "owner@example.com", guest.guest.jar);
    expect((await use(h, m.tokenOf(), guest.guest.jar)).status).toBe(200);
    expect((await meOf(h, guest.guest.jar)).body.player.publicId).toBe(ownerId);
    expect((await snapshot(h, guest.id)).wallet[0].credits).toBe(750); // untouched, not merged
    expect(
      (await q(h, "SELECT kind FROM users WHERE id = $1", [guest.id]))[0].kind,
    ).toBe("guest");
  });

  it("refuses an address that belongs to another account (a verified Discord or Google email), merging nothing", async () => {
    const m = capture();
    const mock = createMockProviders({
      d: {
        discord: {
          id: "d-1",
          username: "dee",
          email: "shared@example.com",
          verified: true,
        },
      },
      g: {
        google: {
          sub: "g-1",
          email: "gshared@example.com",
          email_verified: true,
        },
      },
    });
    const h = await harness({ mailer: m.mailer, fetchFn: mock.fetchFn });
    const discord = await completeLogin(h, "discord", "d");
    await completeLogin(h, "google", "g"); // a second account, holding gshared@example.com
    const discordMe = (await meOf(h, discord.jar)).body.player.publicId;
    const before = await q(h, "SELECT count(*)::int AS n FROM users");

    for (const email of ["shared@example.com", "gshared@example.com"]) {
      const guest = await richGuest(h);
      const snap = await snapshot(h, guest.id);
      await ask(h, email, guest.guest.jar);
      const res = await use(h, m.tokenOf(), guest.guest.jar);
      expect(res.status, email).toBe(400);
      expect(await res.json()).toEqual({ code: "email_exists" });
      expect(res.headers.getSetCookie()).toEqual([]);
      expect(await snapshot(h, guest.id)).toEqual(snap);
      expect(
        await q(h, "SELECT 1 FROM auth_identities WHERE user_id = $1", [
          guest.id,
        ]),
      ).toHaveLength(0);
      await h.db.pool.query(
        "DELETE FROM clan_members; DELETE FROM clans; DELETE FROM game_players; DELETE FROM games",
      );
    }
    expect((await meOf(h, discord.jar)).body.player.publicId).toBe(discordMe);
    expect((await q(h, "SELECT count(*)::int AS n FROM users"))[0].n).toBe(
      before[0].n + 2,
    );
    expect(
      await q(h, "SELECT 1 FROM auth_identities WHERE provider = 'email'"),
    ).toHaveLength(0);
    // the link was spent: the person must ask again (and is told to use the other method)
    expect(
      (
        await q(
          h,
          "SELECT count(*)::int AS n FROM magic_link_tokens WHERE consumed_at IS NOT NULL",
        )
      )[0].n,
    ).toBe(2);
  });

  it("a signed-in Discord account may add its own address, or another free one, and keeps everything", async () => {
    const m = capture();
    const mock = createMockProviders({
      d: {
        discord: {
          id: "d-2",
          username: "dee2",
          email: "mine@example.com",
          verified: true,
        },
      },
    });
    const h = await harness({ mailer: m.mailer, fetchFn: mock.fetchFn });
    const { jar } = await completeLogin(h, "discord", "d");
    const first = await meOf(h, jar);
    for (const email of ["mine@example.com", "another@example.com"]) {
      const j = jar;
      if (email === "another@example.com") {
        // a registered account holds one identity of each kind: remove the first to add a second
        await h.db.pool.query(
          "DELETE FROM auth_identities WHERE provider = 'email'",
        );
      }
      await ask(h, email, j);
      const res = await use(h, m.tokenOf(), j);
      expect(res.status, email).toBe(200);
      const me = await meOf(h, j);
      expect(me.body.player.publicId).toBe(first.body.player.publicId);
      expect(me.body.user.email).toBe(email);
      expect(me.body.user.discord).toBeDefined();
    }
    expect(await q(h, "SELECT 1 FROM users")).toHaveLength(1);
  });

  it("one email identity per account: adding a second address is refused", async () => {
    const m = capture();
    const h = await harness({ mailer: m.mailer });
    const { jar } = await signInWithEmail(h, m, "first@example.com");
    await ask(h, "second@example.com", jar);
    const res = await use(h, m.tokenOf(), jar);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ code: "email_exists" });
    expect(
      (await q(h, "SELECT provider_user_id FROM auth_identities")).map(
        (r) => r.provider_user_id,
      ),
    ).toEqual(["first@example.com"]);
  });

  it("adding an address must happen in the browser that asked: elsewhere the link is refused and still works afterwards", async () => {
    const m = capture();
    const mock = createMockProviders({
      d: { discord: { id: "d-3", username: "dee3", email: null } },
    });
    const h = await harness({ mailer: m.mailer, fetchFn: mock.fetchFn });
    const { jar } = await completeLogin(h, "discord", "d");
    await ask(h, "attach@example.com", jar);
    const token = m.tokenOf();
    for (const other of [new CookieJar(), (await newGuest(h)).jar]) {
      const res = await use(h, token, other);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ code: "wrong_browser" });
      expect(res.headers.getSetCookie()).toEqual([]);
    }
    expect(
      (await q(h, "SELECT consumed_at FROM magic_link_tokens"))[0].consumed_at,
    ).toBeNull();
    expect((await use(h, token, jar)).status).toBe(200);
    expect((await meOf(h, jar)).body.user.email).toBe("attach@example.com");
  });

  it("an email account may link Google later when the Google address is its own", async () => {
    const m = capture();
    const mock = createMockProviders({
      g: {
        google: { sub: "g-9", email: "dual@example.com", email_verified: true },
      },
    });
    const h = await harness({ mailer: m.mailer, fetchFn: mock.fetchFn });
    const { jar } = await signInWithEmail(h, m, "dual@example.com");
    const me = await meOf(h, jar);
    const start = await call(
      h,
      `/auth/link/google?redirect_uri=${encodeURIComponent(`${h.origin}/#x`)}`,
      { bearer: me.jwt, jar, origin: null },
    );
    expect(start.status).toBe(200);
    const url = new URL((await start.json()).url);
    const cb = await call(
      h,
      `/auth/callback/google?code=g&state=${url.searchParams.get("state")}`,
      { jar, origin: null },
    );
    expect(cb.status).toBe(302);
    expect(cb.headers.get("location")).not.toMatch(/login=/);
    const after = await meOf(h, jar);
    expect(after.body.user.email).toBe("dual@example.com");
    expect(after.body.user.google).toEqual({ email: "dual@example.com" });
    expect(await q(h, "SELECT 1 FROM users")).toHaveLength(1);
  });

  it("an account queued for deletion cannot sign in by link", async () => {
    const m = capture();
    const h = await harness({ mailer: m.mailer });
    const { jar } = await signInWithEmail(h, m, "leaving@example.com");
    expect(
      (await call(h, "/users/@me", { method: "DELETE", jar })).status,
    ).toBe(204);
    await ask(h, "leaving@example.com");
    const res = await use(h, m.tokenOf());
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ code: "deleted" });
    expect(res.headers.getSetCookie()).toEqual([]);
  });

  it("after the deletion has run, the address starts a brand new account", async () => {
    const m = capture();
    const h = await harness({ mailer: m.mailer });
    const { jar } = await signInWithEmail(h, m, "gone@example.com");
    const oldId = (await meOf(h, jar)).body.player.publicId;
    await call(h, "/users/@me", { method: "DELETE", jar });
    expect(
      await runDeletions(h.db.pool, new Date(Date.now() + 25 * 3_600_000)),
    ).toBe(1);
    expect(await q(h, "SELECT 1 FROM auth_identities")).toHaveLength(0);
    const { jar: jar2 } = await signInWithEmail(h, m, "gone@example.com");
    expect((await meOf(h, jar2)).body.player.publicId).not.toBe(oldId);
  });
});

describeDb("sessions after an emailed sign-in", () => {
  it("refresh keeps working, logout ends it, revoke-all ends every one", async () => {
    const m = capture();
    const h = await harness({ mailer: m.mailer });
    const a = await signInWithEmail(h, m, "sessions@example.com");
    expect((await refresh(h, a.jar)).status).toBe(200);
    expect((await refresh(h, a.jar)).status).toBe(200);
    const b = await signInWithEmail(h, m, "sessions@example.com");
    const stale = a.jar.clone(); // the cookie as it was before logging out
    expect(
      (await call(h, "/auth/logout", { method: "POST", jar: a.jar })).status,
    ).toBe(200);
    expect((await refresh(h, stale)).status).toBe(401);
    expect((await refresh(h, b.jar)).status).toBe(200);
    const c = await signInWithEmail(h, m, "sessions@example.com");
    const bBefore = b.jar.clone();
    const cBefore = c.jar.clone();
    expect(
      (await call(h, "/auth/revoke", { method: "POST", jar: c.jar })).status,
    ).toBe(200);
    for (const jar of [bBefore, cBefore])
      expect((await refresh(h, jar)).status).toBe(401);
  });

  it("a revoked session's access token stops working at once (the sid is the same family model)", async () => {
    const m = capture();
    const h = await harness({ mailer: m.mailer });
    const { jar } = await signInWithEmail(h, m, "sid@example.com");
    const { jwt } = await meOf(h, jar);
    expect(
      (await call(h, "/users/@me", { bearer: jwt, origin: null })).status,
    ).toBe(200);
    await call(h, "/auth/logout", { method: "POST", jar });
    expect(
      (await call(h, "/users/@me", { bearer: jwt, origin: null })).status,
    ).toBe(401);
  });

  it("signing in over an existing session replaces it and ends the old one", async () => {
    const m = capture();
    const mock = createMockProviders({
      d: { discord: { id: "d-4", username: "dee4", email: null } },
    });
    const h = await harness({ mailer: m.mailer, fetchFn: mock.fetchFn });
    const { jar } = await completeLogin(h, "discord", "d");
    const oldCookie = jar.get("df_refresh")!;
    await ask(h, "switch@example.com");
    expect((await use(h, m.tokenOf(), jar)).status).toBe(200);
    expect(jar.get("df_refresh")).not.toBe(oldCookie);
    const old = new CookieJar();
    old.set("df_refresh", oldCookie);
    expect((await refresh(h, old)).status).toBe(401);
  });

  it("a banned account can sign in but its token says banned (the game refuses it), as with Discord and Google", async () => {
    const m = capture();
    const h = await harness({ mailer: m.mailer });
    const { jar } = await signInWithEmail(h, m, "banned@example.com");
    const publicId = (await meOf(h, jar)).body.player.publicId;
    const io: AdminIo = {
      out: () => undefined,
      err: () => undefined,
      env: {},
      actor: "tester",
    };
    expect(
      await runAdminCommand(
        h.db.pool,
        [
          "user:ban",
          publicId,
          "--category",
          "test",
          "--reason",
          "test",
          "--yes",
        ],
        io,
      ),
    ).toBe(0);
    expect((await refresh(h, jar)).status).toBe(401); // the ban revoked every session
    const { jar: jar2 } = await signInWithEmail(h, m, "banned@example.com");
    const me = await meOf(h, jar2);
    expect(
      JSON.parse(Buffer.from(me.jwt.split(".")[1], "base64url").toString())
        .role,
    ).toBe("banned");
    expect(me.body.ban).not.toBeNull();
  });

  it("in staging and production the cookie is Secure", async () => {
    const m = capture();
    const h = await harness({
      env: "staging",
      mailer: m.mailer,
      origin: undefined,
    } as never);
    await ask(h, "secure@example.com");
    const res = await use(h, m.tokenOf());
    expect(res.status).toBe(200);
    expect(
      res.headers.getSetCookie().find((c) => c.startsWith("df_refresh=")),
    ).toMatch(/; Secure/);
  });
});

describeDb("privacy", () => {
  it("an address appears only in its owner's /users/@me: not in profiles, leaderboards, clans, feeds or the server list", async () => {
    const m = capture();
    const h = await harness({
      mailer: m.mailer,
      features: "accounts,leaderboards,clans,inventory,store",
    });
    const email = "private.person@example.com";
    const { jar } = await signInWithEmail(h, m, email);
    const me = await meOf(h, jar);
    expect(JSON.stringify(me.body)).toContain(email);
    const publicId = me.body.player.publicId;
    const [{ id }] = await q(h, "SELECT id FROM users WHERE public_id = $1", [
      publicId,
    ]);
    const clanId = (
      await q(
        h,
        "INSERT INTO clans (tag, name) VALUES ('PRV', 'Private Team') RETURNING id",
      )
    )[0].id;
    await h.db.pool.query(
      "INSERT INTO clan_members (clan_id, user_id, role) VALUES ($1, $2, 'leader')",
      [clanId, id],
    );
    const other = await newGuest(h);
    for (const path of [
      `/public/player/${publicId}`,
      `/player/${publicId}`,
      `/public/player/${publicId}/games`,
      "/leaderboard/players",
      "/clans",
      "/clans/PRV",
      "/clans/PRV/members",
      "/public/clans/leaderboard",
      "/public/clan/PRV/exists",
      "/cosmetics.json",
      "/news.json",
      "/cluster.json?site=example.com",
      "/.well-known/jwks.json",
    ]) {
      const res = await call(h, path, { bearer: other.jwt, origin: null });
      const text = await res.text();
      expect(text, path).not.toContain(email);
      expect(text, path).not.toContain("private.person");
    }
  });

  it("no log line holds an address, a token or a link, in any outcome", async () => {
    const lines: unknown[] = [];
    class Memory extends Transport {
      log(info: unknown, next: () => void) {
        lines.push(JSON.parse(JSON.stringify(info)));
        next();
      }
    }
    const m = capture();
    const h = await harness({
      env: "staging",
      mailer: m.mailer,
      log: createLogger("debug", [new Memory()]),
    });
    const email = "logged.person@example.com";
    await ask(h, email);
    const token = m.tokenOf();
    await use(h, token);
    await use(h, token); // consumed
    await use(h, "Q".repeat(43)); // invalid
    m.state.fail = new MailDeliveryError(
      `resend answered 500 for ${email}`,
      true,
    );
    await ask(h, "failed.person@example.com");
    await ask(h, "bad address");
    await new Promise((r) => setTimeout(r, 40));
    const text = JSON.stringify(lines);
    expect(lines.length).toBeGreaterThan(0);
    for (const secret of [
      token,
      "logged.person",
      "failed.person",
      "token-login=",
      "re_test_key_not_real",
    ]) {
      expect(text, secret).not.toContain(secret);
    }
    expect(text).toContain("magic link delivery failed");
  });
});

describeDb("dev delivery", () => {
  it("in dev the link can be read back from a loopback-only outbox, for the address asked about", async () => {
    const h = await harness();
    expect((await ask(h, "dev@example.com")).status).toBe(204);
    const res = await call(h, "/dev/email-outbox?email=dev@example.com", {
      origin: null,
    });
    expect(res.status).toBe(200);
    const { messages } = await res.json();
    expect(messages).toHaveLength(1);
    expect(messages[0].link).toMatch(
      /#token-login\?token-login=[A-Za-z0-9_-]{43}$/,
    );
    const token = /token-login=(.+)$/.exec(messages[0].link)![1];
    expect((await use(h, token)).status).toBe(200);
    expect(
      (
        await (
          await call(h, "/dev/email-outbox?email=other@example.com", {
            origin: null,
          })
        ).json()
      ).messages,
    ).toEqual([]);
  });

  it("in staging there is no outbox route, whatever the provider", async () => {
    const h = await harness({ env: "staging", mailer: capture().mailer });
    expect((await call(h, "/dev/email-outbox", { origin: null })).status).toBe(
      404,
    );
  });
});

describeDb("cleanup and operations", () => {
  it("the maintenance job deletes links a day after they expired (used or not) and keeps newer ones", async () => {
    const m = capture();
    const h = await harness({ mailer: m.mailer });
    for (const e of [
      "a@example.com",
      "b@example.com",
      "c@example.com",
      "d@example.com",
    ])
      await ask(h, e);
    await use(h, m.tokenOf(1));
    await h.db.pool.query(
      "UPDATE magic_link_tokens SET created_at = now() - interval '2 days', expires_at = now() - interval '2 days' + interval '15 minutes' WHERE email IN ('a@example.com', 'b@example.com')",
    );
    await h.db.pool.query(
      "UPDATE magic_link_tokens SET created_at = now() - interval '1 hour', expires_at = now() - interval '45 minutes' WHERE email = 'c@example.com'",
    );
    const result = await runRetention(h.db.pool, new Date());
    expect(result.magicLinks).toBe(2);
    expect(
      (
        await q(
          h,
          "SELECT email::text AS email FROM magic_link_tokens ORDER BY email",
        )
      ).map((r) => r.email),
    ).toEqual(["c@example.com", "d@example.com"]);
    expect((await runRetention(h.db.pool, new Date())).magicLinks).toBe(0);
  });

  it("deleting an account removes the pending links that would add an address to it", async () => {
    const m = capture();
    const mock = createMockProviders({
      d: { discord: { id: "d-5", username: "dee5", email: null } },
    });
    const h = await harness({ mailer: m.mailer, fetchFn: mock.fetchFn });
    const { jar } = await completeLogin(h, "discord", "d");
    await ask(h, "pending@example.com", jar);
    expect(
      await q(
        h,
        "SELECT 1 FROM magic_link_tokens WHERE link_user_id IS NOT NULL",
      ),
    ).toHaveLength(1);
    await call(h, "/users/@me", { method: "DELETE", jar });
    await runDeletions(h.db.pool, new Date(Date.now() + 25 * 3_600_000));
    expect(await q(h, "SELECT 1 FROM magic_link_tokens")).toHaveLength(0);
  });

  it("`email:status` prints counts and never a token or an address", async () => {
    const m = capture();
    const h = await harness({ mailer: m.mailer });
    await ask(h, "status.person@example.com");
    await ask(h, "status.two@example.com");
    await use(h, m.tokenOf(0));
    const out: string[] = [];
    const io: AdminIo = {
      out: (l) => out.push(l),
      err: (l) => out.push(l),
      env: {},
      actor: "tester",
    };
    expect(await runAdminCommand(h.db.pool, ["email:status"], io)).toBe(0);
    const text = out.join("\n");
    expect(text).toMatch(
      /1 pending, 0 expired unused, 1 used, 2 requested in the last hour/,
    );
    expect(text).not.toMatch(/status\.|@|[A-Za-z0-9_-]{43}/);
    expect(await q(h, "SELECT 1 FROM admin_audit_log")).toHaveLength(0);
  });
});
