// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  createOAuthProviders,
  DEFAULT_ENDPOINTS,
  OAuthExchangeError,
  pkceChallenge,
} from "../../src/account-api/auth/oauth/providers";

const oauth = {
  discord: { clientId: "d-id", clientSecret: "d-secret-XYZ" },
  google: { clientId: "g-id", clientSecret: "g-secret-XYZ" },
};

const json = (status: number, value: unknown) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });

describe("pkceChallenge", () => {
  it("is the S256 transform from RFC 7636", () => {
    // The RFC's own test vector.
    expect(pkceChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe(
      "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    );
  });
});

describe("createOAuthProviders", () => {
  it("offers only the providers with credentials", () => {
    expect(Object.keys(createOAuthProviders({ oauth }))).toEqual([
      "discord",
      "google",
    ]);
    expect(
      Object.keys(createOAuthProviders({ oauth: { ...oauth, google: null } })),
    ).toEqual(["discord"]);
    expect(
      Object.keys(
        createOAuthProviders({ oauth: { discord: null, google: null } }),
      ),
    ).toEqual([]);
  });

  it("builds authorize URLs with state, PKCE, scope and the callback", () => {
    const providers = createOAuthProviders({ oauth });
    const url = new URL(
      providers.google!.authorizeUrl({
        redirectUri: "https://api.x/cb",
        state: "S",
        codeVerifier: "V".repeat(43),
      }),
    );
    expect(`${url.origin}${url.pathname}`).toBe(
      DEFAULT_ENDPOINTS.google.authorize,
    );
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: "g-id",
      redirect_uri: "https://api.x/cb",
      response_type: "code",
      scope: "openid email profile",
      state: "S",
      code_challenge: pkceChallenge("V".repeat(43)),
      code_challenge_method: "S256",
    });
    const discord = new URL(
      providers.discord!.authorizeUrl({
        redirectUri: "https://api.x/cb",
        state: "S",
        codeVerifier: "V".repeat(43),
      }),
    );
    expect(discord.searchParams.get("scope")).toBe("identify email");
    expect(discord.toString()).not.toContain("d-secret-XYZ");
  });
});

describe("token and profile exchange", () => {
  const exchange = (
    fetchFn: typeof fetch,
    which: "discord" | "google" = "discord",
  ) =>
    createOAuthProviders({ oauth }, fetchFn)[which]!.exchange({
      code: "c",
      redirectUri: "https://api.x/cb",
      codeVerifier: "v".repeat(43),
    });

  it("maps a Discord account (a verified email is lower-cased; the profile keeps exactly what /users/@me needs)", async () => {
    const identity = await exchange((async (url: string) =>
      url.includes("oauth2/token")
        ? json(200, { access_token: "tok" })
        : json(200, {
            id: "42",
            username: "ann",
            global_name: "Ann",
            avatar: "av",
            discriminator: "0",
            email: "Ann@Example.COM",
            verified: true,
            flags: 1,
            locale: "en",
          })) as never);
    expect(identity).toEqual({
      provider: "discord",
      providerUserId: "42",
      email: "ann@example.com",
      emailVerified: true,
      displayName: "Ann",
      avatar: "av",
      profile: {
        id: "42",
        username: "ann",
        global_name: "Ann",
        avatar: "av",
        discriminator: "0",
      },
    });
  });

  it("never treats a Discord email as verified unless Discord says so", async () => {
    const fetchFn = (async (url: string) =>
      url.includes("oauth2/token")
        ? json(200, { access_token: "t" })
        : json(200, {
            id: "1",
            username: "u",
            email: "a@b.co",
            verified: false,
          })) as never;
    expect((await exchange(fetchFn)).emailVerified).toBe(false);
    const none = (async (url: string) =>
      url.includes("oauth2/token")
        ? json(200, { access_token: "t" })
        : json(200, { id: "1", username: "u" })) as never;
    expect(await exchange(none)).toMatchObject({
      email: null,
      emailVerified: false,
    });
  });

  it("maps a Google account", async () => {
    const identity = await exchange(
      (async (url: string) =>
        url.endsWith("/token")
          ? json(200, { access_token: "tok" })
          : json(200, {
              sub: "g1",
              email: "Me@Example.com",
              email_verified: true,
              name: "Me",
              picture: "p",
            })) as never,
      "google",
    );
    expect(identity).toEqual({
      provider: "google",
      providerUserId: "g1",
      email: "me@example.com",
      emailVerified: true,
      displayName: "Me",
      avatar: "p",
      profile: { email: "me@example.com" },
    });
  });

  it("sends the secret and PKCE verifier to the token endpoint only, and the access token to the profile endpoint only", async () => {
    const seen: Array<{ url: string; body: string; auth: string | null }> = [];
    await exchange((async (url: string, init: RequestInit) => {
      seen.push({
        url,
        body: String(init.body ?? ""),
        auth: new Headers(init.headers).get("authorization"),
      });
      return url.includes("oauth2/token")
        ? json(200, { access_token: "ACCESS" })
        : json(200, { id: "1", username: "u" });
    }) as never);
    const [token, profile] = seen;
    expect(token.url).toBe(DEFAULT_ENDPOINTS.discord.token);
    expect(new URLSearchParams(token.body).get("client_secret")).toBe(
      "d-secret-XYZ",
    );
    expect(new URLSearchParams(token.body).get("code_verifier")).toBe(
      "v".repeat(43),
    );
    expect(token.auth).toBeNull();
    expect(profile.url).toBe(DEFAULT_ENDPOINTS.discord.userinfo);
    expect(profile.body).toBe("");
    expect(profile.auth).toBe("Bearer ACCESS");
  });

  it("fails with a clear error, never containing a secret, when the provider misbehaves", async () => {
    const cases: Record<string, typeof fetch> = {
      "token refused": (async () =>
        json(400, {
          error: "invalid_grant",
          client_secret: "d-secret-XYZ",
        })) as never,
      "token unreachable": (async () => {
        throw new Error("connect ECONNREFUSED d-secret-XYZ");
      }) as never,
      "token malformed": (async () => json(200, { nope: true })) as never,
      "profile refused": (async (url: string) =>
        url.includes("oauth2/token")
          ? json(200, { access_token: "t" })
          : json(500, {})) as never,
      "profile malformed": (async (url: string) =>
        url.includes("oauth2/token")
          ? json(200, { access_token: "t" })
          : json(200, { username: "no id" })) as never,
      "profile unreachable": (async (url: string) => {
        if (url.includes("oauth2/token"))
          return json(200, { access_token: "t" });
        throw new Error("boom");
      }) as never,
    };
    for (const [why, fetchFn] of Object.entries(cases)) {
      const failure = exchange(fetchFn);
      await expect(failure, why).rejects.toBeInstanceOf(OAuthExchangeError);
      await expect(failure, why).rejects.not.toThrow(/d-secret-XYZ/);
    }
  });
});
