// @vitest-environment node
import {
  AUTH_PROVIDERS,
  buildTimeEmailAuth,
  parseEmailAuthFlag,
} from "@openfront/shared/AccountFeatures";
import { describe, expect, it } from "vitest";
import {
  createDevMailer,
  createMailer,
  magicLinkMessage,
  MailDeliveryError,
  POSTMARK_URL,
  RESEND_URL,
} from "../../src/account-api/auth/email";
import {
  hashToken,
  magicLinkUrl,
  newMagicToken,
  normalizeEmail,
  TOKEN_PATTERN,
  validateRedirectDomain,
} from "../../src/account-api/auth/magicLink";
import {
  ConfigError,
  describeConfig,
  loadConfig,
} from "../../src/account-api/config";

const DB = "postgres://dfuser:db-password-123@db.internal:5432/deltafront";
const dev = (extra: Record<string, string> = {}) => ({
  GAME_ENV: "dev",
  DATABASE_URL: DB,
  DF_ACCOUNT_FEATURES: "accounts",
  ...extra,
});
const prod = (extra: Record<string, string | undefined> = {}) => ({
  GAME_ENV: "prod",
  DOMAIN: "example.com",
  API_PUBLIC_ORIGIN: "https://api.example.com",
  ALLOWED_ORIGINS: "https://example.com",
  DATABASE_URL: DB,
  DF_ACCOUNT_FEATURES: "accounts",
  JWT_PRIVATE_KEY_PATH: "/run/secrets/jwt.pem",
  TURNSTILE_SECRET_KEY: "turnstile-secret-value",
  DISCORD_CLIENT_ID: "d",
  DISCORD_CLIENT_SECRET: "discord-secret-value",
  GOOGLE_CLIENT_ID: "g",
  GOOGLE_CLIENT_SECRET: "google-secret-value",
  ...extra,
});
const issuesOf = (env: Record<string, string | undefined>): string[] => {
  try {
    loadConfig(env);
  } catch (e) {
    expect(e).toBeInstanceOf(ConfigError);
    return (e as ConfigError).issues;
  }
  throw new Error("expected a rejection");
};

describe("the provider switch", () => {
  it("is off unless DF_EMAIL_AUTH says 1 or true, and the shipped value is off", () => {
    expect(AUTH_PROVIDERS).toMatchObject({
      discord: true,
      google: true,
      email: false,
      steam: false,
    });
    for (const on of ["1", "true", "TRUE", " 1 ", "True"]) {
      expect(parseEmailAuthFlag(on)).toEqual({ enabled: true, invalid: false });
    }
    for (const off of [undefined, null, "", "0", "false", " "]) {
      expect(parseEmailAuthFlag(off)).toEqual({
        enabled: false,
        invalid: false,
      });
    }
    for (const typo of ["yes", "on", "enabled", "2", true, 1]) {
      expect(parseEmailAuthFlag(typo)).toEqual({
        enabled: false,
        invalid: true,
      });
    }
  });

  it("bakes only 1 or empty into the client, and stops a production build on a typo", () => {
    expect(buildTimeEmailAuth("true", true)).toBe("1");
    expect(buildTimeEmailAuth(undefined, true)).toBe("");
    expect(() => buildTimeEmailAuth("yes", true)).toThrow(/DF_EMAIL_AUTH/);
    expect(buildTimeEmailAuth("yes", false)).toBe("");
    expect(buildTimeEmailAuth("sk_live_secret", false)).toBe("");
  });
});

describe("email configuration", () => {
  it("needs nothing when email sign-in is off, even in production", () => {
    const config = loadConfig(prod());
    expect(config.email).toEqual({
      enabled: false,
      provider: null,
      from: null,
      apiKey: null,
    });
    // stray settings are ignored, not required and not validated
    expect(loadConfig(prod({ EMAIL_PROVIDER: "bogus" })).email.enabled).toBe(
      false,
    );
  });

  it("dev defaults to the in-memory provider, needing no sender or key", () => {
    expect(loadConfig(dev({ DF_EMAIL_AUTH: "1" })).email).toEqual({
      enabled: true,
      provider: "dev",
      from: null,
      apiKey: null,
    });
  });

  it("outside dev it requires a real provider, a sender and a key, all at once", () => {
    const issues = issuesOf(prod({ DF_EMAIL_AUTH: "1" })).join("\n");
    expect(issues).toMatch(/EMAIL_PROVIDER is required/);
    const noKey = issuesOf(
      prod({ DF_EMAIL_AUTH: "1", EMAIL_PROVIDER: "resend" }),
    ).join("\n");
    expect(noKey).toMatch(/EMAIL_FROM is required/);
    expect(noKey).toMatch(/EMAIL_API_KEY is required/);
  });

  it("refuses the dev provider anywhere but dev, in staging as well as production", () => {
    for (const GAME_ENV of ["prod", "staging"]) {
      expect(
        issuesOf(
          prod({ GAME_ENV, DF_EMAIL_AUTH: "1", EMAIL_PROVIDER: "dev" }),
        ).join(),
      ).toMatch(/EMAIL_PROVIDER=dev .* refused/);
    }
  });

  it("refuses unknown providers, malformed senders, placeholder keys and a missing accounts feature", () => {
    const base = {
      DF_EMAIL_AUTH: "1",
      EMAIL_FROM: "login@example.com",
      EMAIL_API_KEY: "re_real_key_abc",
    };
    expect(
      issuesOf(prod({ ...base, EMAIL_PROVIDER: "mailgun" })).join(),
    ).toMatch(/must be one of: dev, resend, postmark/);
    for (const bad of [
      "not an address",
      "a@b",
      "<>",
      "x@@y.com",
      "Name <a@b.co",
      "a b@c.com",
    ]) {
      expect(
        issuesOf(
          prod({ ...base, EMAIL_PROVIDER: "resend", EMAIL_FROM: bad }),
        ).join(),
        bad,
      ).toMatch(/EMAIL_FROM must be an address/);
    }
    expect(
      issuesOf(
        prod({
          ...base,
          EMAIL_PROVIDER: "postmark",
          EMAIL_API_KEY: "CHANGE_ME",
        }),
      ).join(),
    ).toMatch(/CHANGE_ME placeholder/);
    expect(
      issuesOf(
        prod({
          ...base,
          EMAIL_PROVIDER: "resend",
          DF_ACCOUNT_FEATURES: "store",
        }),
      ).join(),
    ).toMatch(/needs DF_ACCOUNT_FEATURES to include accounts/);
    expect(issuesOf(prod({ DF_EMAIL_AUTH: "yes" })).join()).toMatch(
      /DF_EMAIL_AUTH must be 1, true, 0 or false/,
    );
  });

  it("accepts a complete production setup for either provider and never describes the key", () => {
    for (const EMAIL_PROVIDER of ["resend", "postmark"]) {
      const config = loadConfig(
        prod({
          DF_EMAIL_AUTH: "1",
          EMAIL_PROVIDER,
          EMAIL_FROM: "DeltaFront <login@example.com>",
          EMAIL_API_KEY: "re_super_secret_value_123",
        }),
      );
      expect(config.email.enabled).toBe(true);
      const text = JSON.stringify(describeConfig(config));
      expect(text).not.toContain("re_super_secret_value_123");
      expect(text).not.toContain("login@example.com");
    }
  });
});

describe("addresses", () => {
  it("normalises to lower case and trims", () => {
    expect(normalizeEmail("  Ann.Smith+Game@Example.COM ")).toBe(
      "ann.smith+game@example.com",
    );
    expect(normalizeEmail("a_b-c@sub.example.co.uk")).toBe(
      "a_b-c@sub.example.co.uk",
    );
  });

  it("refuses anything that is not a plain ASCII address", () => {
    for (const bad of [
      undefined,
      null,
      5,
      {},
      [],
      "",
      "ann",
      "ann@",
      "@example.com",
      "ann@example",
      "ann@@example.com",
      "ann@example.com@evil.com",
      "a n@example.com",
      "ann@exa mple.com",
      "ann@example.c",
      "ann@example.123",
      "ann@[127.0.0.1]",
      "ann@127.0.0.1",
      '"ann"@example.com',
      "ann..smith@example.com",
      ".ann@example.com",
      "ann.@example.com",
      "ann@-example.com",
      "ann@example-.com",
      "ann@exämple.com",
      "änn@example.com",
      "ann@example.com\r\nBcc: victim@example.com",

      "a".repeat(65) + "@example.com",
      `ann@${"a".repeat(64)}.com`,
      `${"a".repeat(250)}@e.co`,
      "ann@example.com,bob@example.com",
      "ann@example.com;bob@example.com",
    ]) {
      expect(normalizeEmail(bad), JSON.stringify(bad)).toBeNull();
    }
  });
});

describe("where a link may point", () => {
  const allowed = ["https://example.com", "http://localhost:9000"];
  it("accepts exactly an allowed origin, or its bare host", () => {
    expect(validateRedirectDomain("https://example.com", allowed)).toBe(
      "https://example.com",
    );
    expect(validateRedirectDomain("example.com", allowed)).toBe(
      "https://example.com",
    );
    expect(validateRedirectDomain("http://localhost:9000", allowed)).toBe(
      "http://localhost:9000",
    );
    expect(validateRedirectDomain("localhost:9000", allowed)).toBe(
      "http://localhost:9000",
    );
  });

  it("refuses every look-alike, path, credential trick and non-string", () => {
    for (const bad of [
      undefined,
      5,
      {},
      "",
      "https://evil.example",
      "https://example.com.evil.test",
      "https://evil.example/https://example.com",
      "https://example.com/",
      "https://example.com/path",
      "https://example.com?x=1",
      "https://example.com#x",
      "https://user@example.com",
      "https://example.com@evil.test",
      "https://example.com\\@evil.test",
      "//example.com",
      "javascript:alert(1)",
      "http://example.com",
      "https://EXAMPLE.com",
      "example.com/x",
      "https://example.com:443",
      "example.com\r\nX: y",
      " https://example.com",
      "https://exam ple.com",
      "x".repeat(300),
    ]) {
      expect(
        validateRedirectDomain(bad, allowed),
        JSON.stringify(bad),
      ).toBeNull();
    }
    expect(validateRedirectDomain("https://example.com", [])).toBeNull();
  });

  it("puts the token in the fragment, never the query", () => {
    const token = newMagicToken();
    const url = new URL(magicLinkUrl("https://example.com", token));
    expect(url.search).toBe("");
    expect(url.hash).toBe(`#token-login?token-login=${token}`);
  });
});

describe("tokens", () => {
  it("are 256 random bits in 43 URL-safe characters, and hash to 32 bytes", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const t = newMagicToken();
      expect(t).toMatch(TOKEN_PATTERN);
      seen.add(t);
    }
    expect(seen.size).toBe(200);
    expect(hashToken("a")).toHaveLength(32);
    expect(hashToken("a").equals(hashToken("a"))).toBe(true);
    expect(hashToken("a").equals(hashToken("b"))).toBe(false);
  });

  it("the pattern refuses everything that is not exactly a token", () => {
    for (const bad of [
      "",
      "x",
      "x".repeat(42),
      "x".repeat(44),
      `${"x".repeat(42)}+`,
      `${"x".repeat(42)} `,
      `${"x".repeat(42)}\n`,
      `${"x".repeat(41)}%00`,
      "../".repeat(15),
    ]) {
      expect(TOKEN_PATTERN.test(bad), JSON.stringify(bad)).toBe(false);
    }
  });
});

describe("the email", () => {
  const link = "https://example.com/#token-login?token-login=" + "A".repeat(43);
  it("holds the link once, says when it expires, and carries no other link or tracker", () => {
    const m = magicLinkMessage({ to: "ann@example.com", link, ttlMinutes: 15 });
    expect(m.subject).toBe("Your DeltaFront sign-in link");
    expect(m.text.split(link).length - 1).toBe(1);
    expect(m.text).toMatch(/expires in 15 minutes/);
    expect(m.html).toContain(`href="${link}"`);
    expect(m.html).not.toMatch(/<img|<script|<iframe|pixel|track/i);
    expect(
      [...m.html.matchAll(/https?:\/\/[^"<\s]+/g)].every((x) => x[0] === link),
    ).toBe(true);
  });

  it("escapes the link in the HTML", () => {
    const m = magicLinkMessage({
      to: "a@b.co",
      link: 'https://x.test/"><script>alert(1)</script>',
      ttlMinutes: 15,
    });
    expect(m.html).not.toContain("<script>");
  });
});

describe("delivery adapters", () => {
  const message = magicLinkMessage({
    to: "ann@example.com",
    link: "https://example.com/#token-login?token-login=" + "B".repeat(43),
    ttlMinutes: 15,
  });
  type Call = {
    url: string;
    headers: Record<string, string>;
    body: Record<string, unknown>;
  };
  function stub(status = 200, json: unknown = {}) {
    const calls: Call[] = [];
    const fetchFn = (async (url: string, init: RequestInit) => {
      calls.push({
        url,
        headers: init.headers as Record<string, string>,
        body: JSON.parse(String(init.body)),
      });
      return new Response(JSON.stringify(json), { status });
    }) as unknown as typeof fetch;
    return { fetchFn, calls };
  }
  const config = (provider: "resend" | "postmark") => ({
    enabled: true,
    provider,
    from: "DeltaFront <login@example.com>",
    apiKey: "key-123456",
  });

  it("Resend: one authenticated JSON call to its API", async () => {
    const { fetchFn, calls } = stub(200, { id: "x" });
    await createMailer(config("resend"), fetchFn)!.send(message);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(RESEND_URL);
    expect(calls[0].headers.Authorization).toBe("Bearer key-123456");
    expect(calls[0].body).toMatchObject({
      from: "DeltaFront <login@example.com>",
      to: ["ann@example.com"],
      subject: message.subject,
      text: message.text,
    });
  });

  it("Postmark: its token header, tracking off, and a rejected message is an error even on 200", async () => {
    const ok = stub(200, { ErrorCode: 0 });
    await createMailer(config("postmark"), ok.fetchFn)!.send(message);
    expect(ok.calls[0].url).toBe(POSTMARK_URL);
    expect(ok.calls[0].headers["X-Postmark-Server-Token"]).toBe("key-123456");
    expect(ok.calls[0].body).toMatchObject({
      From: "DeltaFront <login@example.com>",
      To: "ann@example.com",
      TrackOpens: false,
      TrackLinks: "None",
    });
    const rejected = stub(200, {
      ErrorCode: 406,
      Message: "ann@example.com is inactive",
    });
    await expect(
      createMailer(config("postmark"), rejected.fetchFn)!.send(message),
    ).rejects.toMatchObject({ transient: false });
  });

  it("distinguishes a passing failure from a final one, and leaks neither the key, the address nor the body", async () => {
    for (const provider of ["resend", "postmark"] as const) {
      for (const [status, transient] of [
        [429, true],
        [500, true],
        [503, true],
        [400, false],
        [401, false],
        [422, false],
      ] as const) {
        const { fetchFn } = stub(status, {
          message: "ann@example.com key-123456",
        });
        const error = await createMailer(config(provider), fetchFn)!
          .send(message)
          .catch((e: Error) => e);
        expect(error).toBeInstanceOf(MailDeliveryError);
        expect(
          (error as MailDeliveryError).transient,
          `${provider} ${status}`,
        ).toBe(transient);
        expect(String(error)).not.toMatch(/ann@example|key-123456/);
      }
      const down = (async () => {
        throw new Error("connect ECONNREFUSED ann@example.com");
      }) as unknown as typeof fetch;
      const e = await createMailer(config(provider), down)!
        .send(message)
        .catch((x: Error) => x);
      expect((e as MailDeliveryError).transient).toBe(true);
      expect(String(e)).not.toContain("ann@example");
    }
  });

  it("is absent when email sign-in is off, and refuses a real provider without its settings", () => {
    expect(
      createMailer({
        enabled: false,
        provider: null,
        from: null,
        apiKey: null,
      }),
    ).toBeNull();
    expect(() =>
      createMailer({
        enabled: true,
        provider: "resend",
        from: null,
        apiKey: null,
      }),
    ).toThrow();
  });

  it("the dev mailer keeps the newest messages in memory and can be filtered by address", async () => {
    const mailer = createDevMailer(2);
    for (const to of ["a@x.co", "b@x.co", "a@x.co"]) {
      await mailer.send(
        magicLinkMessage({
          to,
          link: `https://example.com/#token-login?token-login=${"C".repeat(43)}`,
          ttlMinutes: 15,
        }),
      );
    }
    expect(mailer.outbox()).toHaveLength(2);
    expect(mailer.outbox("A@X.co").map((e) => e.to)).toEqual(["a@x.co"]);
    expect(mailer.outbox()[0].link).toMatch(
      /^https:\/\/example\.com\/#token-login/,
    );
    mailer.clear();
    expect(mailer.outbox()).toEqual([]);
  });
});
