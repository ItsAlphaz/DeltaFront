// @vitest-environment node
import { UserMeResponseSchema } from "@openfront/shared/ApiSchemas";
import { afterEach, describe, expect, it } from "vitest";
import { pkceChallenge } from "../../src/account-api/auth/oauth/providers";
import {
  ALLOWED_OUTBOUND_HOSTS,
  APP_ORIGIN,
  CookieJar,
  DISCORD_ID,
  DISCORD_SECRET,
  GOOGLE_ID,
  GOOGLE_SECRET,
  call,
  completeLogin,
  createMockProviders,
  decodeJwtPayload,
  newGuest,
  refresh,
  startHarness,
  type Harness,
  type MockAccount,
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

const count = async (h: Harness, sql: string): Promise<number> =>
  (await h.db.pool.query(sql)).rows[0].n;

type ProviderName = "discord" | "google";

/** What each provider says about "the same person", so one suite covers both. */
const PROVIDERS: Record<
  ProviderName,
  {
    clientId: string;
    secret: string;
    authorizeHost: string;
    scope: string;
    tokenUrl: string;
    account(id: string, email?: string | null, verified?: boolean): MockAccount;
    shape(me: ReturnType<typeof UserMeResponseSchema.parse>): void;
  }
> = {
  discord: {
    clientId: DISCORD_ID,
    secret: DISCORD_SECRET,
    authorizeHost: "https://discord.com/oauth2/authorize",
    scope: "identify email",
    tokenUrl: "https://discord.com/api/oauth2/token",
    account: (id, email = null, verified = true) => ({
      discord: {
        id,
        username: `user_${id}`,
        global_name: `Display ${id}`,
        avatar: "abc123",
        discriminator: "0",
        email,
        verified,
      },
    }),
    shape: (me) => {
      expect(me.user.discord).toMatchObject({
        avatar: "abc123",
        global_name: expect.stringContaining("Display"),
        discriminator: "0",
      });
      expect(me.user.google).toBeUndefined();
      expect(me.user.email).toBeUndefined();
    },
  },
  google: {
    clientId: GOOGLE_ID,
    secret: GOOGLE_SECRET,
    authorizeHost: "https://accounts.google.com/o/oauth2/v2/auth",
    scope: "openid email profile",
    tokenUrl: "https://oauth2.googleapis.com/token",
    account: (id, email = `${id}@example.com`, verified = true) => ({
      google: {
        sub: id,
        email,
        email_verified: verified,
        name: `Name ${id}`,
        picture: "https://example.com/p.png",
      },
    }),
    shape: (me) => {
      expect(me.user.google).toEqual({
        email: expect.stringMatching(/@example\.com$/),
      });
      expect(me.user.discord).toBeUndefined();
    },
  },
};

describe.each(Object.keys(PROVIDERS) as ProviderName[])(
  "%s sign-in",
  (name) => {
    const P = PROVIDERS[name];

    describeDb("the redirect to the provider", () => {
      it("sends the browser to the provider with state, PKCE and the API's own callback URL", async () => {
        const h = await harness();
        const jar = new CookieJar();
        const res = await call(
          h,
          `/auth/login/${name}?redirect_uri=${encodeURIComponent(`${APP_ORIGIN}/#modal=account`)}`,
          { jar, origin: null },
        );
        expect(res.status).toBe(302);
        const location = new URL(res.headers.get("location")!);
        expect(`${location.origin}${location.pathname}`).toBe(P.authorizeHost);
        const q = location.searchParams;
        expect(q.get("client_id")).toBe(P.clientId);
        expect(q.get("response_type")).toBe("code");
        expect(q.get("scope")).toBe(P.scope);
        expect(q.get("redirect_uri")).toBe(
          `http://localhost:8787/auth/callback/${name}`,
        );
        expect(q.get("code_challenge_method")).toBe("S256");
        const state = q.get("state")!;
        expect(state.length).toBeGreaterThanOrEqual(43);

        // The attempt is stored by the state's hash, with the PKCE verifier, and bound to this browser by a cookie.
        const row = (
          await h.db.pool.query(
            "SELECT state, provider, redirect_uri, pkce_verifier, link_user_id FROM oauth_states",
          )
        ).rows;
        expect(row).toHaveLength(1);
        expect(row[0].state).not.toBe(state);
        expect(row[0].provider).toBe(name);
        expect(row[0].redirect_uri).toBe(`${APP_ORIGIN}/#modal=account`);
        expect(row[0].link_user_id).toBeNull();
        expect(pkceChallenge(row[0].pkce_verifier)).toBe(
          q.get("code_challenge"),
        );
        const cookie = jar.raw.find((c) => c.startsWith("df_oauth="))!;
        expect(cookie).toContain(`df_oauth=${state}`);
        expect(cookie).toMatch(/HttpOnly/);
        expect(cookie).toMatch(/Path=\/auth\/callback/);
        expect(cookie).toMatch(/SameSite=Lax/);
        // The client secret never appears in what the browser is given.
        expect(res.headers.get("location")).not.toContain(P.secret);
        expect(cookie).not.toContain(P.secret);
      });

      it("refuses a redirect_uri that is not one of the allowed origins, and never redirects to it", async () => {
        const h = await harness();
        const bad = [
          "https://evil.example/",
          "http://localhost:9001/",
          `${APP_ORIGIN}.evil.example/`,
          "http://localhost:9000@evil.example/",
          "//evil.example/",
          "javascript:alert(1)",
          "data:text/html,hi",
          "ftp://localhost:9000/",
          `${APP_ORIGIN}\\@evil.example`,
          "",
          "not a url",
          `${APP_ORIGIN}/${"a".repeat(3000)}`,
        ];
        for (const redirectUri of bad) {
          const res = await call(
            h,
            `/auth/login/${name}?redirect_uri=${encodeURIComponent(redirectUri)}`,
            { origin: null },
          );
          expect(res.status, redirectUri.slice(0, 60)).toBe(400);
          expect(res.headers.get("location")).toBeNull();
          expect(await res.json()).toEqual({ error: "invalid_redirect_uri" });
        }
        expect(
          (await call(h, `/auth/login/${name}`, { origin: null })).status,
        ).toBe(400);
        expect(
          await count(h, "SELECT count(*)::int AS n FROM oauth_states"),
        ).toBe(0);
      });

      it("rate-limits starts", async () => {
        const h = await harness({
          limits: { oauthStart: { max: 2, windowMs: 60_000 } },
        });
        const go = () =>
          call(
            h,
            `/auth/login/${name}?redirect_uri=${encodeURIComponent(APP_ORIGIN + "/")}`,
            { origin: null },
          );
        expect((await go()).status).toBe(302);
        expect((await go()).status).toBe(302);
        expect((await go()).status).toBe(429);
      });

      it("an unconfigured provider sends the player back with a login error, not to a broken page", async () => {
        const h = await harness({ withoutProviders: [name] });
        const res = await call(
          h,
          `/auth/login/${name}?redirect_uri=${encodeURIComponent(`${APP_ORIGIN}/#modal=account`)}`,
          { origin: null },
        );
        expect(res.status).toBe(302);
        expect(res.headers.get("location")).toBe(
          `${APP_ORIGIN}/#modal=account&login=error`,
        );
        expect(
          await count(h, "SELECT count(*)::int AS n FROM oauth_states"),
        ).toBe(0);
      });
    });

    describeDb("the callback", () => {
      it("signs a new player in, persists the linked identity, and returns them to the page they were on", async () => {
        const mock = createMockProviders({
          code1: P.account(
            "1001",
            name === "discord" ? "a@example.com" : undefined,
          ),
        });
        const h = await harness({ fetchFn: mock.fetchFn });
        const { callback, jar } = await completeLogin(h, name, "code1");
        expect(callback.status).toBe(302);
        expect(callback.headers.get("location")).toBe(
          `${APP_ORIGIN}/#modal=account`,
        );
        expect(jar.get("df_refresh")).toBeTruthy();
        // The one-shot state cookie is cleared.
        expect(callback.headers.getSetCookie().join()).toMatch(
          /df_oauth=; .*Max-Age=0/,
        );

        // A registered user with exactly one persisted identity.
        const users = (await h.db.pool.query("SELECT id, kind FROM users"))
          .rows;
        expect(users).toEqual([{ id: expect.any(String), kind: "registered" }]);
        const ids = (
          await h.db.pool.query(
            "SELECT provider, provider_user_id, user_id, email_verified FROM auth_identities",
          )
        ).rows;
        expect(ids).toEqual([
          {
            provider: name,
            provider_user_id: "1001",
            user_id: users[0].id,
            email_verified: expect.any(Boolean),
          },
        ]);
        expect(await count(h, "SELECT count(*)::int AS n FROM wallets")).toBe(
          1,
        );
        expect(
          await count(h, "SELECT count(*)::int AS n FROM oauth_states"),
        ).toBe(0);

        // The new session works: refresh gives a token with the provider claim, and /users/@me is the signed-in shape.
        const res = await refresh(h, jar);
        expect(res.status).toBe(200);
        const { jwt } = await res.json();
        expect(decodeJwtPayload(jwt)).toMatchObject({ provider: name });
        const me = UserMeResponseSchema.parse(
          await (
            await call(h, "/users/@me", { bearer: jwt, origin: null })
          ).json(),
        );
        P.shape(me);
        expect(me.player.currency).toEqual({ soft: 0, hard: 0 });
      });

      it("upgrades a guest in place: same player, same session, nothing lost", async () => {
        const mock = createMockProviders({ up: P.account("2002") });
        const h = await harness({ fetchFn: mock.fetchFn });
        const guest = await newGuest(h);
        const guestMe = (await (
          await call(h, "/users/@me", { bearer: guest.jwt, origin: null })
        ).json()) as { player: { publicId: string } };
        const cookieBefore = guest.jar.get("df_refresh");

        const { callback } = await completeLogin(h, name, "up", {
          jar: guest.jar,
        });
        expect(callback.headers.get("location")).toBe(
          `${APP_ORIGIN}/#modal=account`,
        );
        expect(await count(h, "SELECT count(*)::int AS n FROM users")).toBe(1);
        expect(
          (await h.db.pool.query("SELECT kind FROM users")).rows[0].kind,
        ).toBe("registered");
        // The session did not change, so the player's open tabs keep working.
        expect(guest.jar.get("df_refresh")).toBe(cookieBefore);

        const next = await refresh(h, guest.jar);
        const { jwt } = await next.json();
        const me = UserMeResponseSchema.parse(
          await (
            await call(h, "/users/@me", { bearer: jwt, origin: null })
          ).json(),
        );
        expect(me.player.publicId).toBe(guestMe.player.publicId);
        P.shape(me);
      });

      it("signing in again from another browser reaches the same account", async () => {
        const mock = createMockProviders({ again: P.account("3003") });
        const h = await harness({ fetchFn: mock.fetchFn });
        const first = await completeLogin(h, name, "again");
        const second = await completeLogin(h, name, "again"); // a new, empty jar
        expect(second.callback.status).toBe(302);
        expect(await count(h, "SELECT count(*)::int AS n FROM users")).toBe(1);
        expect(
          await count(h, "SELECT count(*)::int AS n FROM auth_identities"),
        ).toBe(1);
        const a = decodeJwtPayload(
          (await (await refresh(h, first.jar)).json()).jwt,
        ).sub;
        const b = decodeJwtPayload(
          (await (await refresh(h, second.jar)).json()).jwt,
        ).sub;
        expect(a).toBe(b);
        // Two devices, two independent sessions.
        expect(
          await count(
            h,
            "SELECT count(DISTINCT family_id)::int AS n FROM refresh_sessions",
          ),
        ).toBe(2);
      });

      it("signing in as a different account replaces the browser's session, and ends the old one", async () => {
        const mock = createMockProviders({
          one: P.account("4001"),
          two: P.account("4002"),
        });
        const h = await harness({ fetchFn: mock.fetchFn });
        const first = await completeLogin(h, name, "one");
        const oldCookie = first.jar.clone();
        const second = await completeLogin(h, name, "two", { jar: first.jar });
        expect(second.callback.status).toBe(302);
        expect(await count(h, "SELECT count(*)::int AS n FROM users")).toBe(2);
        expect((await refresh(h, oldCookie)).status).toBe(401); // the previous account's session ended
        expect((await refresh(h, first.jar)).status).toBe(200);
      });

      it("two simultaneous first sign-ins of the same new identity make exactly one account", async () => {
        const mock = createMockProviders({ race: P.account("5005") });
        const h = await harness({ fetchFn: mock.fetchFn });
        const [a, b] = await Promise.all([
          completeLogin(h, name, "race"),
          completeLogin(h, name, "race"),
        ]);
        expect(a.callback.status).toBe(302);
        expect(b.callback.status).toBe(302);
        expect(await count(h, "SELECT count(*)::int AS n FROM users")).toBe(1);
        expect(
          await count(h, "SELECT count(*)::int AS n FROM auth_identities"),
        ).toBe(1);
      });
    });

    describeDb("state and CSRF protection", () => {
      const refusedWith400 = async (
        h: Harness,
        route: string,
        jar?: CookieJar,
      ) => {
        const res = await call(h, route, { jar, origin: null });
        expect(res.status).toBe(400);
        expect(res.headers.get("location")).toBeNull();
        expect(await res.json()).toEqual({ error: "invalid_state" });
        expect(res.headers.getSetCookie().join()).not.toMatch(
          /df_refresh=[^;]/,
        );
      };

      it("rejects a callback with no state, a wrong state, or no browser binding", async () => {
        const mock = createMockProviders({ c: P.account("6001") });
        const h = await harness({ fetchFn: mock.fetchFn });
        const real = await completeLogin(h, name, "c", {
          omitState: true,
          callbackParams: { code: "c" },
        }).catch(() => null);
        expect(real).not.toBeNull();
        expect(real!.callback.status).toBe(400);

        const jar = new CookieJar();
        const start = await call(
          h,
          `/auth/login/${name}?redirect_uri=${encodeURIComponent(APP_ORIGIN + "/")}`,
          { jar, origin: null },
        );
        const state = new URL(start.headers.get("location")!).searchParams.get(
          "state",
        )!;
        await refusedWith400(
          h,
          `/auth/callback/${name}?code=c&state=wrong`,
          jar.clone(),
        );
        // The right state, but from a browser that did not start the login (an attacker's link).
        await refusedWith400(
          h,
          `/auth/callback/${name}?code=c&state=${state}`,
          new CookieJar(),
        );
        await refusedWith400(h, `/auth/callback/${name}?code=c`, jar.clone());
        // No account was created by any of it.
        expect(await count(h, "SELECT count(*)::int AS n FROM users")).toBe(0);
      });

      it("a state can be used once", async () => {
        const mock = createMockProviders({ once: P.account("6002") });
        const h = await harness({ fetchFn: mock.fetchFn });
        const first = await completeLogin(h, name, "once");
        expect(first.callback.status).toBe(302);
        const replayJar = new CookieJar();
        replayJar.set("df_oauth", first.state);
        await refusedWith400(
          h,
          `/auth/callback/${name}?code=once&state=${first.state}`,
          replayJar,
        );
      });

      it("an expired state is refused", async () => {
        const mock = createMockProviders({ late: P.account("6003") });
        const h = await harness({ fetchFn: mock.fetchFn });
        const jar = new CookieJar();
        const start = await call(
          h,
          `/auth/login/${name}?redirect_uri=${encodeURIComponent(APP_ORIGIN + "/")}`,
          { jar, origin: null },
        );
        const state = new URL(start.headers.get("location")!).searchParams.get(
          "state",
        )!;
        await h.db.pool.query(
          "UPDATE oauth_states SET expires_at = now() - interval '1 second'",
        );
        await refusedWith400(
          h,
          `/auth/callback/${name}?code=late&state=${state}`,
          jar,
        );
      });

      it("a state started for one provider cannot be completed at the other", async () => {
        const other: ProviderName = name === "discord" ? "google" : "discord";
        const mock = createMockProviders({ x: P.account("6004") });
        const h = await harness({ fetchFn: mock.fetchFn });
        const jar = new CookieJar();
        const start = await call(
          h,
          `/auth/login/${name}?redirect_uri=${encodeURIComponent(APP_ORIGIN + "/")}`,
          { jar, origin: null },
        );
        const state = new URL(start.headers.get("location")!).searchParams.get(
          "state",
        )!;
        await refusedWith400(
          h,
          `/auth/callback/${other}?code=x&state=${state}`,
          jar,
        );
      });
    });

    describeDb("provider failures", () => {
      it("the player denying access returns them with login=cancel and creates nothing", async () => {
        const mock = createMockProviders({});
        const h = await harness({ fetchFn: mock.fetchFn });
        const { callback, jar } = await completeLogin(h, name, "", {
          callbackParams: { error: "access_denied" },
        });
        expect(callback.headers.get("location")).toBe(
          `${APP_ORIGIN}/#modal=account&login=cancel`,
        );
        expect(jar.get("df_refresh")).toBeUndefined();
        expect(await count(h, "SELECT count(*)::int AS n FROM users")).toBe(0);
      });

      it("any other provider error returns login=error", async () => {
        const h = await harness({ fetchFn: createMockProviders({}).fetchFn });
        const { callback } = await completeLogin(h, name, "", {
          callbackParams: { error: "server_error" },
        });
        expect(callback.headers.get("location")).toBe(
          `${APP_ORIGIN}/#modal=account&login=error`,
        );
      });

      it("a missing code, a refused code, a failing token endpoint and a failing profile endpoint all return login=error", async () => {
        const mock = createMockProviders({
          bad: { ...P.account("7001"), tokenError: 500 },
          noprofile: { ...P.account("7002"), profileError: 500 },
        });
        const h = await harness({ fetchFn: mock.fetchFn });
        const attempts: Array<Record<string, string>> = [
          {},
          { code: "unknown-code" },
          { code: "bad" },
          { code: "noprofile" },
        ];
        for (const callbackParams of attempts) {
          const { callback, jar } = await completeLogin(h, name, "", {
            callbackParams,
          });
          expect(callback.status, JSON.stringify(callbackParams)).toBe(302);
          expect(callback.headers.get("location")).toBe(
            `${APP_ORIGIN}/#modal=account&login=error`,
          );
          expect(jar.get("df_refresh")).toBeUndefined();
        }
        expect(await count(h, "SELECT count(*)::int AS n FROM users")).toBe(0);
      });

      it("keeps whatever else was in the page's fragment when adding the result", async () => {
        const h = await harness({ fetchFn: createMockProviders({}).fetchFn });
        const { callback } = await completeLogin(h, name, "", {
          redirectUri: `${APP_ORIGIN}/play?x=1#modal=account&tab=stats`,
          callbackParams: { error: "access_denied" },
        });
        expect(callback.headers.get("location")).toBe(
          `${APP_ORIGIN}/play?x=1#modal=account&tab=stats&login=cancel`,
        );
      });
    });

    describeDb("conflicting identities", () => {
      it("never merges accounts by email: a verified email already on another account is refused", async () => {
        const other: ProviderName = name === "discord" ? "google" : "discord";
        const OP = PROVIDERS[other];
        const mock = createMockProviders({
          first: OP.account("8001", "shared@example.com", true),
          second: P.account("8002", "shared@example.com", true),
        });
        const h = await harness({ fetchFn: mock.fetchFn });
        await completeLogin(h, other, "first");
        const { callback, jar } = await completeLogin(h, name, "second");
        expect(callback.headers.get("location")).toBe(
          `${APP_ORIGIN}/#modal=account&login=email_exists`,
        );
        expect(jar.get("df_refresh")).toBeUndefined();
        expect(await count(h, "SELECT count(*)::int AS n FROM users")).toBe(1);
        expect(
          await count(h, "SELECT count(*)::int AS n FROM auth_identities"),
        ).toBe(1);
      });

      it("an unverified email never causes a conflict", async () => {
        const other: ProviderName = name === "discord" ? "google" : "discord";
        const OP = PROVIDERS[other];
        const mock = createMockProviders({
          first: OP.account("8101", "same@example.com", true),
          second: P.account("8102", "same@example.com", false),
        });
        const h = await harness({ fetchFn: mock.fetchFn });
        await completeLogin(h, other, "first");
        const { callback } = await completeLogin(h, name, "second");
        expect(callback.headers.get("location")).toBe(
          `${APP_ORIGIN}/#modal=account`,
        );
        expect(await count(h, "SELECT count(*)::int AS n FROM users")).toBe(2);
      });

      it("an account queued for deletion cannot sign in", async () => {
        const mock = createMockProviders({ del: P.account("8201") });
        const h = await harness({ fetchFn: mock.fetchFn });
        await completeLogin(h, name, "del");
        await h.db.pool.query("UPDATE users SET deletion_requested_at = now()");
        const { callback, jar } = await completeLogin(h, name, "del");
        expect(callback.headers.get("location")).toBe(
          `${APP_ORIGIN}/#modal=account&login=deleted`,
        );
        expect(jar.get("df_refresh")).toBeUndefined();
      });

      it("a guest signing in with an identity that already has an account switches to that account and leaves the guest alone", async () => {
        const mock = createMockProviders({ owner: P.account("8301") });
        const h = await harness({ fetchFn: mock.fetchFn });
        await completeLogin(h, name, "owner");
        const guest = await newGuest(h);
        const guestSub = decodeJwtPayload(guest.jwt).sub;
        const { callback } = await completeLogin(h, name, "owner", {
          jar: guest.jar,
        });
        expect(callback.status).toBe(302);
        const sub = decodeJwtPayload(
          (await (await refresh(h, guest.jar)).json()).jwt,
        ).sub;
        expect(sub).not.toBe(guestSub);
        expect(await count(h, "SELECT count(*)::int AS n FROM users")).toBe(2); // the guest was not merged or deleted
      });
    });

    describeDb("secrets", () => {
      it("the client secret is only ever sent to the provider's token endpoint", async () => {
        const mock = createMockProviders({ s: P.account("9001") });
        const h = await harness({ fetchFn: mock.fetchFn });
        const { start, callback } = await completeLogin(h, name, "s");
        expect(start.headers.get("location")).not.toContain(P.secret);
        expect(callback.headers.get("location")).not.toContain(P.secret);
        for (const request of mock.requests) {
          const mentionsSecret =
            request.url.includes(P.secret) ||
            request.body.includes(P.secret) ||
            (request.authorization ?? "").includes(P.secret);
          expect(mentionsSecret, request.url).toBe(request.url === P.tokenUrl);
        }
        // The token exchange used PKCE and the exact callback URL.
        const token = mock.requests.find((r) => r.url === P.tokenUrl)!;
        const body = new URLSearchParams(token.body);
        expect(body.get("grant_type")).toBe("authorization_code");
        expect(body.get("redirect_uri")).toBe(
          `http://localhost:8787/auth/callback/${name}`,
        );
        expect(body.get("code_verifier")?.length).toBeGreaterThanOrEqual(43);
      });

      it("only ever talks to the provider (no unexpected hosts, never OpenFront)", async () => {
        const mock = createMockProviders({ n: P.account("9002") });
        const h = await harness({ fetchFn: mock.fetchFn });
        await completeLogin(h, name, "n");
        expect(mock.requests.length).toBeGreaterThan(0);
        for (const request of mock.requests) {
          const host = new URL(request.url).hostname;
          expect(ALLOWED_OUTBOUND_HOSTS.has(host), host).toBe(true);
          expect(host).not.toMatch(/openfront/i);
        }
      });
    });
  },
);

describe("linking a Google account to a signed-in player", () => {
  describeDb("GET /auth/link/google", () => {
    it("requires a signed-in session", async () => {
      const h = await harness();
      const res = await call(
        h,
        `/auth/link/google?redirect_uri=${encodeURIComponent(APP_ORIGIN + "/")}`,
        { origin: null },
      );
      expect(res.status).toBe(401);
    });

    it("returns the provider URL as JSON, bound to the account, and completes by adding the identity to it", async () => {
      const mock = createMockProviders({
        d: PROVIDERS.discord.account("1"),
        g: PROVIDERS.google.account("gsub-1", "me@example.com"),
      });
      const h = await harness({ fetchFn: mock.fetchFn });
      const { jar } = await completeLogin(h, "discord", "d");
      const jwt = (await (await refresh(h, jar)).json()).jwt as string;

      const res = await call(
        h,
        `/auth/link/google?redirect_uri=${encodeURIComponent(`${APP_ORIGIN}/#modal=account`)}`,
        { bearer: jwt, jar, origin: null },
      );
      expect(res.status).toBe(200);
      const { url } = (await res.json()) as { url: string };
      expect(new URL(url).origin + new URL(url).pathname).toBe(
        "https://accounts.google.com/o/oauth2/v2/auth",
      );
      const state = new URL(url).searchParams.get("state")!;
      expect(
        (await h.db.pool.query("SELECT link_user_id FROM oauth_states")).rows[0]
          .link_user_id,
      ).not.toBeNull();

      const callback = await call(
        h,
        `/auth/callback/google?code=g&state=${state}`,
        { jar, origin: null },
      );
      expect(callback.headers.get("location")).toBe(
        `${APP_ORIGIN}/#modal=account`,
      );
      expect(await count(h, "SELECT count(*)::int AS n FROM users")).toBe(1);
      expect(
        (
          await h.db.pool.query(
            "SELECT provider FROM auth_identities ORDER BY id",
          )
        ).rows.map((r) => r.provider),
      ).toEqual(["discord", "google"]);

      const fresh = (await (await refresh(h, jar)).json()).jwt as string;
      const me = UserMeResponseSchema.parse(
        await (
          await call(h, "/users/@me", { bearer: fresh, origin: null })
        ).json(),
      );
      expect(me.user.discord).toBeDefined();
      expect(me.user.google).toEqual({ email: "me@example.com" });
    });

    it("refuses to link an identity that already belongs to another account", async () => {
      const mock = createMockProviders({
        owner: PROVIDERS.google.account("gsub-2", "owner@example.com"),
        d: PROVIDERS.discord.account("2"),
      });
      const h = await harness({ fetchFn: mock.fetchFn });
      await completeLogin(h, "google", "owner");
      const { jar } = await completeLogin(h, "discord", "d");
      const jwt = (await (await refresh(h, jar)).json()).jwt as string;
      const { url } = (await (
        await call(
          h,
          `/auth/link/google?redirect_uri=${encodeURIComponent(APP_ORIGIN + "/#modal=account")}`,
          { bearer: jwt, jar, origin: null },
        )
      ).json()) as { url: string };
      const state = new URL(url).searchParams.get("state")!;
      const callback = await call(
        h,
        `/auth/callback/google?code=owner&state=${state}`,
        { jar, origin: null },
      );
      expect(callback.headers.get("location")).toBe(
        `${APP_ORIGIN}/#modal=account&login=email_exists`,
      );
      expect(
        await count(h, "SELECT count(*)::int AS n FROM auth_identities"),
      ).toBe(2);
    });

    it("validates the redirect_uri here too", async () => {
      const h = await harness();
      const { jwt } = await newGuest(h);
      const res = await call(
        h,
        `/auth/link/google?redirect_uri=${encodeURIComponent("https://evil.example/")}`,
        { bearer: jwt, origin: null },
      );
      expect(res.status).toBe(400);
    });

    it("has no Discord counterpart (the client contract has none)", async () => {
      const h = await harness();
      const { jwt } = await newGuest(h);
      const res = await call(
        h,
        `/auth/link/discord?redirect_uri=${encodeURIComponent(APP_ORIGIN + "/")}`,
        { bearer: jwt, origin: null },
      );
      expect(res.status).toBe(404);
    });
  });
});

describe("provider switches", () => {
  describeDb("providers the client contract does not offer", () => {
    it("Steam and email sign-in are not routed", async () => {
      const h = await harness();
      for (const provider of ["steam", "email", "github"]) {
        const res = await call(
          h,
          `/auth/login/${provider}?redirect_uri=${encodeURIComponent(APP_ORIGIN + "/")}`,
          { origin: null },
        );
        expect(res.status, provider).toBe(404);
      }
      for (const route of [
        "/auth/magic-link",
        "/auth/login/token?login-token=x",
        "/auth/steam",
        "/auth/crazygames",
      ]) {
        const res = await call(h, route, {
          method: route.includes("login/token") ? "GET" : "POST",
          origin: null,
        });
        expect(res.status, route).toBe(404);
      }
    });
  });
});
