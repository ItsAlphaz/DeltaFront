// @vitest-environment node
import {
  TokenPayloadSchema,
  UserMeResponseSchema,
} from "@openfront/shared/ApiSchemas";
import { base64urlToUuid } from "@openfront/shared/Base64";
import { SignJWT, generateKeyPair } from "jose";
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import {
  createEphemeralKeyRing,
  createKeyRing,
} from "../../src/account-api/auth/keys";
import { TokenService } from "../../src/account-api/auth/tokens";
import { createSession, hashIp } from "../../src/account-api/repo/sessions";
import {
  APP_ORIGIN,
  CookieJar,
  call,
  decodeJwtPayload,
  newGuest,
  refresh,
  removeTempKeyFiles,
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
afterAll(removeTempKeyFiles);

const rowCount = async (h: Harness, table: string): Promise<number> =>
  (await h.db.pool.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n;

describeDb("guest sessions", () => {
  it("a first refresh with no cookie creates a guest account and a usable access token", async () => {
    const h = await harness();
    const jar = new CookieJar();
    const res = await call(h, "/auth/refresh", { method: "POST", jar });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = (await res.json()) as { jwt: string; expiresIn: number };
    expect(body.expiresIn).toBe(900);

    // A real, backend-issued account: one guest user with a wallet and one session.
    const users = (
      await h.db.pool.query("SELECT id, kind, public_id FROM users")
    ).rows;
    expect(users).toHaveLength(1);
    expect(users[0].kind).toBe("guest");
    expect(await rowCount(h, "wallets")).toBe(1);
    expect(await rowCount(h, "refresh_sessions")).toBe(1);

    // The token carries exactly the claims the client and game server read.
    const claims = decodeJwtPayload(body.jwt);
    const parsed = TokenPayloadSchema.parse(claims);
    expect(parsed.sub).toBe(users[0].id);
    expect(base64urlToUuid(claims.sub as string)).toBe(users[0].id);
    expect(parsed.iss).toBe("http://localhost:8787");
    expect(parsed.aud).toBe("localhost");
    expect(parsed.provider).toBe("guest");
    expect(parsed.role).toBeUndefined();
    expect(parsed.exp - parsed.iat).toBe(900);
    expect(typeof claims.jti).toBe("string");
  });

  it("sets an HttpOnly, SameSite=Lax, host-only refresh cookie (Secure only outside plain-http dev) and stores only its hash", async () => {
    const h = await harness();
    const jar = new CookieJar();
    await call(h, "/auth/refresh", { method: "POST", jar });
    const cookie = jar.raw.find((c) => c.startsWith("df_refresh="))!;
    expect(cookie).toMatch(/; HttpOnly/);
    expect(cookie).toMatch(/; SameSite=Lax/);
    expect(cookie).toMatch(/; Path=\//);
    expect(cookie).toMatch(/; Max-Age=2592000/);
    expect(cookie).not.toMatch(/Domain=/i);
    expect(cookie).not.toMatch(/Secure/); // dev serves plain http

    const token = jar.get("df_refresh")!;
    expect(token.length).toBeGreaterThanOrEqual(43);
    const stored = (
      await h.db.pool.query(
        "SELECT encode(token_hash, 'hex') AS hash FROM refresh_sessions",
      )
    ).rows[0].hash;
    expect(stored).not.toContain(token);
    expect(stored).toHaveLength(64);
  });

  it("marks the cookie Secure in staging and production environments", async () => {
    const h = await harness({ env: "staging" });
    const jar = new CookieJar();
    const res = await call(h, "/auth/refresh", {
      method: "POST",
      jar,
      origin: "https://example.com",
    });
    expect(res.status).toBe(200);
    const cookie = jar.raw.find((c) => c.startsWith("df_refresh="))!;
    expect(cookie).toMatch(/; Secure/);
    expect(cookie).toMatch(/; HttpOnly/);
    expect(cookie).toMatch(/; SameSite=Lax/);
    // The token's issuer and audience are what the client derives for that site.
    const claims = decodeJwtPayload((await res.json()).jwt);
    expect(claims.iss).toBe("https://api.example.com");
    expect(claims.aud).toBe("example.com");
  });

  it("refreshing keeps the same player and does not create another", async () => {
    const h = await harness();
    const { jar, jwt } = await newGuest(h);
    const first = decodeJwtPayload(jwt);
    for (let i = 0; i < 3; i++) {
      const res = await refresh(h, jar);
      expect(res.status).toBe(200);
      expect(decodeJwtPayload((await res.json()).jwt).sub).toBe(first.sub);
    }
    expect(await rowCount(h, "users")).toBe(1);
    expect(await rowCount(h, "wallets")).toBe(1);
  });

  it("the guest's /users/@me is the guest shape, and it parses as the client's schema", async () => {
    const h = await harness();
    const { jwt } = await newGuest(h);
    const res = await call(h, "/users/@me", { bearer: jwt, origin: null });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const me = UserMeResponseSchema.parse(await res.json());
    expect(me.user).toEqual({}); // no linked identity: the client treats it as not signed in
    expect(me.ban).toBeNull();
    expect(me.player.publicId).toMatch(/^[A-Za-z0-9]{10}$/);
    expect(me.player).toMatchObject({
      adfree: false,
      unlimitedRanked: false,
      canCreatePublicLobbies: false,
      trustTier: "untrusted",
      friends: [],
      subscription: null,
      achievements: { singleplayerMap: [], player: [] },
    });
    // Milestone M2 adds the Credits balance and the (unset) username.
    expect(me.player.currency).toEqual({ soft: 0, hard: 0 });
    expect(me.player.username).toBeNull();
    // Nothing from later milestones.
    for (const key of [
      "rewards",
      "progress",
      "clans",
      "clanRequests",
      "flares",
    ]) {
      expect(me.player, key).not.toHaveProperty(key);
    }
  });
});

describeDb("refresh-token rotation", () => {
  it("every refresh replaces the cookie, and the old one stops working after the race window", async () => {
    const h = await harness();
    const { jar } = await newGuest(h);
    const old = jar.get("df_refresh")!;
    const res = await refresh(h, jar);
    expect(res.status).toBe(200);
    const next = jar.get("df_refresh")!;
    expect(next).not.toBe(old);

    const rows = (
      await h.db.pool.query(
        "SELECT revoked_reason, parent_id IS NOT NULL AS has_parent, family_id FROM refresh_sessions ORDER BY created_at",
      )
    ).rows;
    expect(rows).toHaveLength(2);
    expect(rows[0].revoked_reason).toBe("rotated");
    expect(rows[1].has_parent).toBe(true);
    expect(rows[0].family_id).toBe(rows[1].family_id);

    // Replay the old token well after the race window: theft signal.
    await h.db.pool.query(
      "UPDATE refresh_sessions SET revoked_at = now() - interval '1 minute' WHERE revoked_reason = 'rotated'",
    );
    const replay = new CookieJar();
    replay.set("df_refresh", old);
    const bad = await refresh(h, replay);
    expect(bad.status).toBe(401);
    // The whole family is revoked, including the legitimate successor.
    expect(
      (
        await h.db.pool.query(
          "SELECT count(*)::int AS n FROM refresh_sessions WHERE revoked_at IS NULL",
        )
      ).rows[0].n,
    ).toBe(0);
    expect(
      (
        await h.db.pool.query(
          "SELECT revoked_reason FROM refresh_sessions WHERE revoked_reason = 'reuse_detected'",
        )
      ).rows.length,
    ).toBeGreaterThan(0);
    const legit = await refresh(h, jar);
    expect(legit.status).toBe(401);
  });

  it("two tabs refreshing with the same cookie at once is a race, not theft", async () => {
    const h = await harness();
    const { jar } = await newGuest(h);
    const tabA = jar.clone();
    const tabB = jar.clone();
    const first = await refresh(h, tabA); // wins and rotates
    expect(first.status).toBe(200);
    const second = await refresh(h, tabB); // presents the replaced token, same browser
    expect(second.status).toBe(200);
    // No second Set-Cookie: it must not overwrite the winner's successor.
    expect(second.headers.getSetCookie()).toEqual([]);
    expect(decodeJwtPayload((await second.json()).jwt).provider).toBe("guest");
    // The winner's cookie still works.
    expect((await refresh(h, tabA)).status).toBe(200);
  });

  it("a replaced token presented by a different client within the window is still treated as theft", async () => {
    const h = await harness();
    const { jar } = await newGuest(h);
    const stolen = jar.clone();
    await refresh(h, jar);
    const thief = await refresh(h, stolen, { userAgent: "somebody-else/9" });
    expect(thief.status).toBe(401);
    expect(
      (
        await h.db.pool.query(
          "SELECT count(*)::int AS n FROM refresh_sessions WHERE revoked_at IS NULL",
        )
      ).rows[0].n,
    ).toBe(0);
  });

  it("an unknown or garbage cookie is a dead session: 401 and the cookie is cleared", async () => {
    const h = await harness();
    const jar = new CookieJar();
    jar.set("df_refresh", "not-a-real-token");
    const res = await refresh(h, jar);
    expect(res.status).toBe(401);
    expect(res.headers.getSetCookie().join()).toMatch(
      /df_refresh=; .*Max-Age=0/,
    );
    expect(jar.get("df_refresh")).toBeUndefined();
    // With the cookie gone, the next refresh is a visitor again and gets a fresh guest.
    expect((await refresh(h, jar)).status).toBe(200);
    expect(await rowCount(h, "users")).toBe(1);
  });

  it("an expired session is rejected", async () => {
    const h = await harness();
    const { jar } = await newGuest(h);
    await h.db.pool.query(
      "UPDATE refresh_sessions SET expires_at = now() - interval '1 second'",
    );
    const res = await refresh(h, jar);
    expect(res.status).toBe(401);
  });

  it("a session of a deleted account is rejected", async () => {
    const h = await harness();
    const { jar } = await newGuest(h);
    await h.db.pool.query("UPDATE users SET deleted_at = now()");
    expect((await refresh(h, jar)).status).toBe(401);
  });
});

describeDb("logout and revoke", () => {
  it("logout revokes the session: its cookie and its access token both stop working", async () => {
    const h = await harness();
    const { jar, jwt } = await newGuest(h);
    expect(
      (await call(h, "/users/@me", { bearer: jwt, origin: null })).status,
    ).toBe(200);

    const stale = jar.clone();
    const out = await call(h, "/auth/logout", { method: "POST", jar });
    expect(out.status).toBe(200);
    expect(out.headers.getSetCookie().join()).toMatch(
      /df_refresh=; .*Max-Age=0/,
    );

    expect((await refresh(h, stale)).status).toBe(401); // the cookie is dead
    // The access token is still cryptographically valid for 15 minutes, but its
    // session is gone, so the API (and the game server's /users/@me lookup) refuses it.
    expect(
      (await call(h, "/users/@me", { bearer: jwt, origin: null })).status,
    ).toBe(401);
  });

  it("logout without a session is harmless", async () => {
    const h = await harness();
    const res = await call(h, "/auth/logout", { method: "POST" });
    expect(res.status).toBe(200);
  });

  it("revoke-all signs the account out everywhere", async () => {
    const h = await harness();
    const a = await newGuest(h);
    const userId = decodeJwtPayload(a.jwt).sub as string;
    const uuid = base64urlToUuid(userId);
    // A second device: another session for the same account.
    const second = await createSession(h.db.pool, uuid, {
      userAgent: "phone",
      ipHash: hashIp("1.2.3.4"),
    });
    const phone = new CookieJar();
    phone.set("df_refresh", second.token);
    const phoneAccess = await refresh(h, phone);
    expect(phoneAccess.status).toBe(200);
    const phoneJwt = (await phoneAccess.json()).jwt as string;

    const before = a.jar.clone(); // the browser's cookie before the response clears it
    const res = await call(h, "/auth/revoke", { method: "POST", jar: a.jar });
    expect(res.status).toBe(200);
    expect((await res.json()).revoked).toBeGreaterThanOrEqual(2);

    expect((await refresh(h, before)).status).toBe(401);
    expect((await refresh(h, phone)).status).toBe(401);
    expect(
      (await call(h, "/users/@me", { bearer: a.jwt, origin: null })).status,
    ).toBe(401);
    expect(
      (await call(h, "/users/@me", { bearer: phoneJwt, origin: null })).status,
    ).toBe(401);
  });

  it("revoke-all with no session is refused", async () => {
    const h = await harness();
    expect((await call(h, "/auth/revoke", { method: "POST" })).status).toBe(
      401,
    );
  });
});

describeDb("access-token validation (/users/@me)", () => {
  let h: Harness;
  let jwt: string;
  beforeAll(async () => {
    h = await startHarness();
    jwt = (await newGuest(h)).jwt;
  });
  afterAll(async () => {
    await h.close();
  });

  const me = (token?: string) =>
    call(h, "/users/@me", { bearer: token, origin: null });

  it("accepts a valid token", async () => {
    expect((await me(jwt)).status).toBe(200);
  });

  it("401 with no credentials, a malformed header, or garbage", async () => {
    expect((await me()).status).toBe(401);
    expect(
      (
        await call(h, "/users/@me", {
          headers: { Authorization: "Basic abc" },
          origin: null,
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await call(h, "/users/@me", {
          headers: { Authorization: "Bearer " },
          origin: null,
        })
      ).status,
    ).toBe(401);
    expect((await me("not.a.jwt")).status).toBe(401);
    expect((await me("x")).status).toBe(401);
  });

  it("401 for a token whose signature was tampered with", async () => {
    const [head, payload, sig] = jwt.split(".");
    const tamperedPayload = Buffer.from(
      JSON.stringify({
        ...decodeJwtPayload(jwt),
        sub: "AAAAAAAAAAAAAAAAAAAAAA",
      }),
    ).toString("base64url");
    expect((await me(`${head}.${tamperedPayload}.${sig}`)).status).toBe(401);
    expect(
      (await me(`${head}.${payload}.${sig.slice(0, -4)}AAAA`)).status,
    ).toBe(401);
  });

  it("401 for a token signed by a different key (forged)", async () => {
    const forged = new TokenService(
      await createEphemeralKeyRing(),
      h.config.publicOrigin,
      h.config.domain,
    );
    const claims = decodeJwtPayload(jwt);
    const { jwt: fake } = await forged.issue({
      userId: base64urlToUuid(claims.sub as string),
      role: null,
      provider: "guest",
      sid: claims.sid as string,
    });
    expect((await me(fake)).status).toBe(401);
  });

  it("401 for the wrong issuer or audience, even when signed by our key", async () => {
    const claims = decodeJwtPayload(jwt);
    const args = {
      userId: base64urlToUuid(claims.sub as string),
      role: null,
      provider: "guest",
      sid: claims.sid as string,
    };
    const wrongIssuer = await new TokenService(
      h.keys,
      "https://api.evil.example",
      h.config.domain,
    ).issue(args);
    const wrongAudience = await new TokenService(
      h.keys,
      h.config.publicOrigin,
      "evil.example",
    ).issue(args);
    expect((await me(wrongIssuer.jwt)).status).toBe(401);
    expect((await me(wrongAudience.jwt)).status).toBe(401);
  });

  it("401 for an expired token", async () => {
    const claims = decodeJwtPayload(jwt);
    const expired = await h.keys.sign(
      {
        ...claims,
        jti: "expired-one",
        iat: undefined,
        exp: undefined,
      } as never,
      -30,
    );
    expect((await me(expired)).status).toBe(401);
  });

  it("401 for an unsigned (alg none) token", async () => {
    const claims = decodeJwtPayload(jwt);
    const b64 = (v: unknown) =>
      Buffer.from(JSON.stringify(v)).toString("base64url");
    const none = `${b64({ alg: "none", typ: "JWT" })}.${b64(claims)}.`;
    expect((await me(none)).status).toBe(401);
  });

  it("401 for a token signed with an algorithm other than EdDSA", async () => {
    const { privateKey } = await generateKeyPair("ES256");
    const claims = decodeJwtPayload(jwt);
    const es = await new SignJWT(claims)
      .setProtectedHeader({ alg: "ES256" })
      .sign(privateKey);
    expect((await me(es)).status).toBe(401);
  });

  it("401, not 500, for a validly signed token whose subject is malformed", async () => {
    const claims = decodeJwtPayload(jwt);
    for (const sub of ["not-a-base64-uuid!", "", "AAAA"]) {
      const bad = await h.keys.sign(
        {
          ...claims,
          jti: "bad-sub",
          sub,
          iat: undefined,
          exp: undefined,
        } as never,
        300,
      );
      expect((await me(bad)).status, `sub "${sub}"`).toBe(401);
    }
  });

  it("401 for a validly signed token that names no live session", async () => {
    const claims = decodeJwtPayload(jwt);
    const noSid = await h.tokens.issue({
      userId: base64urlToUuid(claims.sub as string),
      role: null,
      provider: "guest",
      sid: "00000000-0000-4000-8000-000000000000",
    });
    expect((await me(noSid.jwt)).status).toBe(401);
    const missing = await h.keys.sign(
      {
        ...claims,
        jti: "no-sid",
        sid: undefined,
        iat: undefined,
        exp: undefined,
      } as never,
      300,
    );
    expect((await me(missing)).status).toBe(401);
  });
});

describeDb("the signing keys (JWKS)", () => {
  it("publishes only public keys, current first, with the shape the game server requires", async () => {
    const h = await harness();
    const res = await call(h, "/.well-known/jwks.json", { origin: null });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toMatch(/public/);
    const body = (await res.json()) as { keys: Array<Record<string, unknown>> };
    expect(body.keys).toHaveLength(1);
    expect(body.keys[0]).toMatchObject({
      kty: "OKP",
      crv: "Ed25519",
      alg: "EdDSA",
      use: "sig",
    });
    expect(typeof body.keys[0].x).toBe("string");
    expect(typeof body.keys[0].kid).toBe("string");
    for (const secret of ["d", "p", "q", "k"])
      expect(body.keys[0]).not.toHaveProperty(secret);
    expect(JSON.stringify(body)).not.toMatch(/PRIVATE KEY/);
  });

  it("verifies a token the API issued, using only the published key", async () => {
    const h = await harness();
    const { jwt } = await newGuest(h);
    const jwks = (await (
      await call(h, "/.well-known/jwks.json", { origin: null })
    ).json()) as { keys: Array<{ kid: string; x: string }> };
    const verifier = await createKeyRing(
      (await import("node:crypto")).createPublicKey({
        key: { kty: "OKP", crv: "Ed25519", x: jwks.keys[0].x },
        format: "jwk",
      }) as never,
    );
    const payload = await verifier.verify(
      jwt,
      h.config.publicOrigin,
      h.config.domain,
    );
    expect(payload.sub).toBeTruthy();
  });
});

describeDb("origins, CORS and abuse limits", () => {
  it("refuses cookie-authenticated requests without an allowed Origin (CSRF)", async () => {
    const h = await harness();
    const { jar } = await newGuest(h);
    for (const route of ["/auth/refresh", "/auth/logout", "/auth/revoke"]) {
      for (const origin of [
        null,
        "https://evil.example",
        "http://localhost:9001",
        "null",
      ]) {
        const res = await call(h, route, {
          method: "POST",
          jar: jar.clone(),
          origin,
        });
        expect(res.status, `${route} from ${origin}`).toBe(403);
      }
    }
    // Nothing happened to the session.
    expect((await refresh(h, jar)).status).toBe(200);
  });

  it("answers an allowed origin with credentialed CORS headers, and others with none", async () => {
    const h = await harness();
    const ok = await call(h, "/.well-known/jwks.json", { origin: APP_ORIGIN });
    expect(ok.headers.get("access-control-allow-origin")).toBe(APP_ORIGIN);
    expect(ok.headers.get("access-control-allow-credentials")).toBe("true");
    expect(ok.headers.get("vary")).toMatch(/Origin/);
    const bad = await call(h, "/.well-known/jwks.json", {
      origin: "https://evil.example",
    });
    expect(bad.headers.get("access-control-allow-origin")).toBeNull();
    expect(bad.headers.get("access-control-allow-credentials")).toBeNull();
  });

  it("answers a preflight for an allowed origin only", async () => {
    const h = await harness();
    const pre = await call(h, "/users/@me", {
      method: "OPTIONS",
      origin: APP_ORIGIN,
      headers: {
        "Access-Control-Request-Method": "GET",
        "Access-Control-Request-Headers": "authorization",
      },
    });
    expect(pre.status).toBe(204);
    expect(pre.headers.get("access-control-allow-origin")).toBe(APP_ORIGIN);
    expect(pre.headers.get("access-control-allow-headers")).toBe(
      "authorization",
    );
    expect(pre.headers.get("access-control-allow-methods")).toMatch(/GET/);
    const bad = await call(h, "/users/@me", {
      method: "OPTIONS",
      origin: "https://evil.example",
    });
    expect(bad.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("limits new guest accounts per address, but not refreshes of an existing session", async () => {
    const h = await harness({
      limits: { guestCreation: { max: 2, windowMs: 60_000 } },
    });
    const first = await newGuest(h);
    await newGuest(h);
    const limited = await call(h, "/auth/refresh", { method: "POST" });
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(await rowCount(h, "users")).toBe(2);
    // An existing session keeps refreshing.
    expect((await refresh(h, first.jar)).status).toBe(200);
  });
});

describeDb("feature flags decide what is served", () => {
  it("with accounts off, no auth endpoint exists", async () => {
    const h = await harness({ features: "" });
    for (const [method, route] of [
      ["POST", "/auth/refresh"],
      ["GET", "/users/@me"],
      ["GET", "/.well-known/jwks.json"],
      [
        "GET",
        "/auth/login/discord?redirect_uri=http%3A%2F%2Flocalhost%3A9000%2F",
      ],
      ["POST", "/join_verify"],
    ] as const) {
      expect(
        (await call(h, route, { method, origin: null })).status,
        route,
      ).toBe(404);
    }
  });

  it("another feature alone exposes discovery but still no sign-in", async () => {
    const h = await harness({ features: "leaderboards" });
    expect((await call(h, "/auth/refresh", { method: "POST" })).status).toBe(
      404,
    );
    expect(
      (await call(h, "/.well-known/jwks.json", { origin: null })).status,
    ).toBe(404);
    // The server list is there (a bad request, not a 404 route).
    expect((await call(h, "/cluster.json", { origin: null })).status).toBe(400);
  });
});
