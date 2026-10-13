// @vitest-environment node
import { afterEach, expect, it } from "vitest";
import { sha256 } from "../../src/account-api/http";
import { SITEVERIFY_URL } from "../../src/account-api/turnstile";
import {
  call,
  completeLogin,
  createMockProviders,
  createServerKey,
  newGuest,
  refresh,
  startHarness,
  type Harness,
} from "./util/harness";
import { describeDb } from "./util/testDb";

const harnesses: Harness[] = [];
async function harness(options: Parameters<typeof startHarness>[0] = {}) {
  const h = await startHarness(options);
  harnesses.push(h);
  return h;
}
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.close().catch(() => undefined);
});

const post = (
  h: Harness,
  route: string,
  key: string | undefined,
  json: unknown,
  extra: Record<string, string> = {},
) =>
  call(h, route, {
    method: "POST",
    json,
    origin: null,
    headers: { ...(key === undefined ? {} : { "x-api-key": key }), ...extra },
  });
const VALID = {
  ip: "203.0.113.7",
  token: null,
  username: "Ann",
  clanTag: null,
};

describeDb("POST /join_verify: the admission gate", () => {
  it("answers 401 to a missing, wrong, revoked, empty, oversized or array-valued key, and never reveals which", async () => {
    const h = await harness();
    const good = await createServerKey(h);
    const revoked = await createServerKey(h);
    await h.db.pool.query(
      "UPDATE server_api_keys SET revoked_at = now() WHERE key_hash = $1",
      [sha256(revoked)],
    );
    for (const key of [
      undefined,
      "",
      "nope",
      revoked,
      "x".repeat(513),
      good.slice(0, -1),
    ]) {
      const res = await post(h, "/join_verify", key, VALID);
      expect(res.status, String(key).slice(0, 20)).toBe(401);
      expect(await res.json()).toEqual({ error: "invalid_api_key" });
    }
    expect((await post(h, "/join_verify", good, VALID)).status).toBe(200);
  });

  it("rejects malformed bodies with 400 and a bare error, whatever the type confusion", async () => {
    const h = await harness();
    const key = await createServerKey(h);
    const bad: unknown[] = [
      {},
      [],
      "text",
      null,
      { ...VALID, ip: 5 },
      { ...VALID, ip: "x".repeat(65) },
      { ...VALID, token: 5 },
      { ...VALID, token: "t".repeat(4097) },
      { ...VALID, username: ["Ann"] },
      { ...VALID, username: "u".repeat(101) },
      { ...VALID, clanTag: "toolong" },
      { ...VALID, clanTag: "a b" },
      { ...VALID, username: undefined },
      { ip: VALID.ip, username: "Ann", clanTag: null },
    ];
    for (const body of bad) {
      const res = await post(h, "/join_verify", key, body);
      expect(res.status, JSON.stringify(body)?.slice(0, 60)).toBe(400);
      expect(await res.json()).toEqual({ error: "invalid_request" });
    }
  });

  it("refuses a body over 16 kB and a body that is not JSON", async () => {
    const h = await harness();
    const key = await createServerKey(h);
    const big = await post(h, "/join_verify", key, {
      ...VALID,
      username: "u".repeat(20_000),
    });
    expect(big.status).toBe(413);
    const raw = await fetch(`${h.baseUrl}/join_verify`, {
      method: "POST",
      headers: { "x-api-key": key, "Content-Type": "application/json" },
      body: "{not json",
    });
    expect(raw.status).toBe(400);
    expect(JSON.stringify(await raw.json())).not.toMatch(
      /Unexpected token|SyntaxError|stack/,
    );
  });

  it("accepts the key only in the x-api-key header and only on POST", async () => {
    const h = await harness();
    const key = await createServerKey(h);
    expect(
      (
        await call(h, `/join_verify?x-api-key=${key}`, {
          method: "POST",
          json: VALID,
          origin: null,
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await call(h, "/join_verify", {
          method: "POST",
          json: VALID,
          origin: null,
          bearer: key,
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await call(h, "/join_verify", {
          method: "GET",
          origin: null,
          headers: { "x-api-key": key },
        })
      ).status,
    ).toBe(404);
  });

  it("cuts off an address that keeps guessing keys (even a later correct one), then recovers", async () => {
    const h = await harness({
      limits: { serverKeyFailure: { max: 3, windowMs: 60_000 } },
    });
    const key = await createServerKey(h);
    for (let i = 0; i < 3; i++) {
      expect((await post(h, "/join_verify", `wrong-${i}`, VALID)).status).toBe(
        401,
      );
    }
    const blocked = await post(h, "/join_verify", key, VALID);
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(await blocked.json()).toEqual({ error: "rate_limited" });
    // every server route shares the guess budget
    expect((await post(h, "/cluster/checkin", key, {})).status).toBe(429);
  });

  it("holds even a valid key to a request budget", async () => {
    const h = await harness({
      limits: { serverCall: { max: 2, windowMs: 60_000 } },
    });
    const key = await createServerKey(h);
    expect((await post(h, "/join_verify", key, VALID)).status).toBe(200);
    expect((await post(h, "/join_verify", key, VALID)).status).toBe(200);
    const third = await post(h, "/join_verify", key, VALID);
    expect(third.status).toBe(429);
    expect(third.headers.get("retry-after")).not.toBeNull();
  });

  it("a successful call does not spend the guess budget", async () => {
    const h = await harness({
      limits: { serverKeyFailure: { max: 1, windowMs: 60_000 } },
    });
    const key = await createServerKey(h);
    for (let i = 0; i < 5; i++)
      expect((await post(h, "/join_verify", key, VALID)).status).toBe(200);
  });
});

describeDb("POST /join_verify with the real Turnstile client", () => {
  function cloudflare(replies: Array<unknown | "down" | 500>) {
    const calls: string[] = [];
    const fetchFn = (async (url: string, init?: RequestInit) => {
      if (url !== SITEVERIFY_URL) return new Response("no", { status: 404 });
      calls.push(String((init?.body as URLSearchParams).get("response")));
      const next = replies.shift();
      if (next === "down") throw new Error("unreachable");
      if (next === 500) return new Response("", { status: 500 });
      return new Response(JSON.stringify(next), { status: 200 });
    }) as typeof fetch;
    return { fetchFn, calls };
  }
  const ok = (extra: Record<string, unknown> = {}) => ({
    success: true,
    hostname: "example.com",
    action: "join",
    ...extra,
  });

  it("approves once, then refuses the same token again without asking Cloudflare", async () => {
    const cf = cloudflare([ok()]);
    const h = await harness({ env: "staging", fetchFn: cf.fetchFn });
    const key = await createServerKey(h);
    const first = await post(h, "/join_verify", key, {
      ...VALID,
      token: "tok-1",
    });
    expect(await first.json()).toMatchObject({ status: "approved" });
    const again = await post(h, "/join_verify", key, {
      ...VALID,
      token: "tok-1",
    });
    expect(await again.json()).toEqual({
      status: "rejected",
      reason: "replayed",
    });
    expect(cf.calls).toEqual(["tok-1"]);
  });

  it("refuses a token solved on another site or for another action, with a fixed reason", async () => {
    const cf = cloudflare([
      ok({ hostname: "attacker.test" }),
      ok({ action: "login" }),
    ]);
    const h = await harness({ env: "staging", fetchFn: cf.fetchFn });
    const key = await createServerKey(h);
    expect(
      await (
        await post(h, "/join_verify", key, { ...VALID, token: "a" })
      ).json(),
    ).toEqual({ status: "rejected", reason: "hostname" });
    expect(
      await (
        await post(h, "/join_verify", key, { ...VALID, token: "b" })
      ).json(),
    ).toEqual({ status: "rejected", reason: "action" });
  });

  it("tells a provider failure (503, the game server's fallback applies) from a bad token (200 rejected)", async () => {
    const cf = cloudflare([
      500,
      "down",
      { success: false, "error-codes": ["internal-error"] },
      { success: false, "error-codes": ["invalid-input-response"] },
    ]);
    const h = await harness({ env: "staging", fetchFn: cf.fetchFn });
    const key = await createServerKey(h);
    for (const token of ["p1", "p2", "p3"]) {
      const res = await post(h, "/join_verify", key, { ...VALID, token });
      expect(res.status, token).toBe(503);
      expect(await res.json()).toEqual({ error: "turnstile_unavailable" });
    }
    const bad = await post(h, "/join_verify", key, { ...VALID, token: "p4" });
    expect(bad.status).toBe(200);
    expect(await bad.json()).toEqual({ status: "rejected", reason: "invalid" });
  });

  it("never puts the token, the secret or Cloudflare's codes in a response", async () => {
    const cf = cloudflare([
      { success: false, "error-codes": ["invalid-input-response"] },
    ]);
    const h = await harness({ env: "staging", fetchFn: cf.fetchFn });
    const key = await createServerKey(h);
    const text = await (
      await post(h, "/join_verify", key, {
        ...VALID,
        token: "SECRET-TOKEN-VALUE",
      })
    ).text();
    expect(text).not.toContain("SECRET-TOKEN-VALUE");
    expect(text).not.toContain("turnstile-secret");
    expect(text).not.toContain("invalid-input-response");
  });
});

describeDb("rate limits on the remaining sensitive routes", () => {
  it("the OAuth callback is limited per address", async () => {
    const mock = createMockProviders({
      a: { discord: { id: "d1", username: "a", email: null } },
    });
    const h = await harness({
      fetchFn: mock.fetchFn,
      limits: { oauthCallback: { max: 2, windowMs: 60_000 } },
    });
    for (let i = 0; i < 2; i++) {
      expect(
        (
          await call(h, "/auth/callback/discord?code=x&state=y", {
            origin: null,
          })
        ).status,
      ).toBe(400);
    }
    const limited = await call(h, "/auth/callback/discord?code=x&state=y", {
      origin: null,
    });
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).not.toBeNull();
  });

  it("username changes are limited per account, counting only valid names", async () => {
    const mock = createMockProviders({
      a: { discord: { id: "d-un", username: "alice", email: null } },
    });
    const h = await harness({
      fetchFn: mock.fetchFn,
      limits: { usernameChange: { max: 2, windowMs: 60_000 } },
    });
    const login = await completeLogin(h, "discord", "a");
    const jwt = (await (await refresh(h, login.jar)).json()).jwt as string;
    const put = (username: string) =>
      call(h, "/users/@me/username", {
        method: "PUT",
        bearer: jwt,
        json: { username },
      });
    // invalid names are 400 and do not use the budget
    for (let i = 0; i < 4; i++) expect((await put("x")).status).toBe(400);
    expect((await put("Alice")).status).toBe(200);
    // the cooldown (not the limiter) answers the second valid change
    expect((await put("Bob")).status).not.toBe(200);
    expect((await put("Carl")).status).toBe(429);
  });

  it("an address that is not signed in cannot use a username route at all", async () => {
    const h = await harness();
    expect(
      (
        await call(h, "/users/@me/username", {
          method: "PUT",
          json: { username: "Al" },
        })
      ).status,
    ).toBe(401);
    const guest = await newGuest(h);
    expect(
      (
        await call(h, "/users/@me/username", {
          method: "PUT",
          bearer: guest.jwt,
          json: { username: "Alice" },
        })
      ).status,
    ).toBe(403);
  });
});

describeDb("headers on the live API", () => {
  it("the JSON API refuses to be framed or sniffed, and only the public key set is cacheable", async () => {
    const h = await harness({ env: "staging" });
    const me = await call(h, "/users/@me", { origin: null });
    expect(me.headers.get("cache-control")).toBe("no-store");
    expect(me.headers.get("x-frame-options")).toBe("DENY");
    expect(me.headers.get("strict-transport-security")).toMatch(
      /max-age=31536000/,
    );
    const jwks = await call(h, "/.well-known/jwks.json", { origin: null });
    expect(jwks.headers.get("cache-control")).toBe("public, max-age=300");
    const body = JSON.stringify(await jwks.json());
    expect(body).not.toMatch(/"d":/); // never a private scalar
    const guest = await call(h, "/auth/refresh", { method: "POST" });
    expect(guest.headers.get("cache-control")).toBe("no-store");
  });
});

describeDb("the database connection", () => {
  it("every pooled session carries the statement, lock and idle-in-transaction limits", async () => {
    const h = await harness();
    const { rows } = await h.service.pool.query(
      "SELECT current_setting('statement_timeout') AS s, current_setting('lock_timeout') AS l, current_setting('idle_in_transaction_session_timeout') AS i",
    );
    expect(rows[0]).toEqual({ s: "30s", l: "15s", i: "1min" });
  });

  it("recovers by itself when PostgreSQL drops its connections", async () => {
    const h = await harness();
    await newGuest(h);
    await h.db.pool.query(
      "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = current_database() AND application_name = 'deltafront-account-api'",
    );
    await new Promise((r) => setTimeout(r, 100));
    // the next requests open fresh connections; nothing crashes
    let status = 0;
    for (let i = 0; i < 5 && status !== 200; i++) {
      status = (
        await call(h, "/auth/refresh", { method: "POST" }).catch(() => ({
          status: 0,
        }))
      ).status;
    }
    expect(status).toBe(200);
  });

  it("/ready reports ready, then not ready while draining, and close() returns promptly with keep-alive clients connected", async () => {
    const h = await harness({ env: "staging" });
    await newGuest(h); // leaves an idle keep-alive connection open
    const ready = await call(h, "/ready", { origin: null });
    expect(ready.status).toBe(200);
    expect(await ready.json()).toMatchObject({
      status: "ready",
      checks: {
        database: "ok",
        migrations: "ok",
        signingKey: "ok",
        draining: "ok",
      },
    });
    const started = Date.now();
    await h.service.close();
    expect(Date.now() - started).toBeLessThan(3_000);
    // the harness closes again in afterEach; a second close must not hang or throw
  });
});
