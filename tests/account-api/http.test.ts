// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  clearCookie,
  parseCookies,
  serializeCookie,
} from "../../src/account-api/auth/cookies";
import {
  validateRedirectUri,
  withLoginResult,
} from "../../src/account-api/auth/redirects";
import { sha256 } from "../../src/account-api/http";
import {
  createLimiters,
  RATE_LIMITS,
  RateLimiter,
} from "../../src/account-api/limits";

describe("cookies", () => {
  it("parses a Cookie header, ignoring junk and keeping the first of a repeated name", () => {
    expect(parseCookies("a=1; b=two%20words; a=2; =x; broken; c=")).toEqual({
      a: "1",
      b: "two words",
      c: "",
    });
    expect(parseCookies(undefined)).toEqual({});
    expect(parseCookies("bad=%E0%A4%A")).toEqual({});
  });

  it("serializes HttpOnly, SameSite=Lax, host-only cookies, Secure on request", () => {
    const dev = serializeCookie("df_refresh", "tok", {
      maxAgeSeconds: 60,
      secure: false,
    });
    expect(dev).toBe(
      "df_refresh=tok; Path=/; Max-Age=60; HttpOnly; SameSite=Lax",
    );
    expect(
      serializeCookie("df_refresh", "tok", { maxAgeSeconds: 60, secure: true }),
    ).toMatch(/; Secure$/);
    expect(
      serializeCookie("df_oauth", "s", {
        maxAgeSeconds: 600,
        secure: true,
        path: "/auth/callback",
      }),
    ).toContain("Path=/auth/callback");
    expect(dev).not.toMatch(/Domain=/);
  });

  it("clears a cookie by expiring it", () => {
    expect(clearCookie("df_refresh", { secure: true })).toMatch(
      /^df_refresh=; Path=\/; Max-Age=0; HttpOnly; SameSite=Lax; Secure$/,
    );
  });

  it("encodes values safely", () => {
    expect(
      serializeCookie("n", "a b;c=d", { maxAgeSeconds: 1, secure: false }),
    ).toContain("n=a%20b%3Bc%3Dd;");
  });
});

describe("redirect validation (no open redirects)", () => {
  const allowed = ["http://localhost:9000", "https://example.com"];

  it("accepts the full URL of a page on an allowed origin, fragment and query included", () => {
    expect(
      validateRedirectUri("http://localhost:9000/#modal=account", allowed),
    ).toBe("http://localhost:9000/#modal=account");
    expect(
      validateRedirectUri("https://example.com/play?x=1#a=b", allowed),
    ).toBe("https://example.com/play?x=1#a=b");
    expect(validateRedirectUri("https://example.com", allowed)).toBe(
      "https://example.com/",
    );
  });

  it("refuses everything else", () => {
    const bad: unknown[] = [
      "https://evil.example/",
      "https://example.com.evil.example/",
      "https://evil.example/https://example.com/",
      "https://example.com@evil.example/",
      "https://user:pass@example.com/",
      "http://example.com/", // wrong scheme for that origin
      "https://example.com:8443/",
      "//example.com/",
      "/relative",
      "example.com",
      "javascript:alert(1)",
      "data:text/html,x",
      "file:///etc/passwd",
      "https://example.com/\\@evil.example",
      "https://example.com/\u0000",
      "https://example.com/\n",
      "https://example.com/" + "a".repeat(2100),
      "",
      "  ",
      undefined,
      null,
      42,
      ["https://example.com/"],
      { href: "https://example.com/" },
    ];
    for (const value of bad)
      expect(
        validateRedirectUri(value, allowed),
        String(value).slice(0, 50),
      ).toBeNull();
  });

  it("allows nothing when no origin is allowed", () => {
    expect(validateRedirectUri("https://example.com/", [])).toBeNull();
  });

  it("adds a login result to the fragment without losing what is there", () => {
    expect(withLoginResult("http://localhost:9000/", "error")).toBe(
      "http://localhost:9000/#login=error",
    );
    expect(
      withLoginResult("http://localhost:9000/#modal=account", "cancel"),
    ).toBe("http://localhost:9000/#modal=account&login=cancel");
    expect(
      withLoginResult("http://localhost:9000/p?q=1#a=1&login=old", "deleted"),
    ).toBe("http://localhost:9000/p?q=1#a=1&login=deleted");
    expect(
      withLoginResult("http://localhost:9000/#a=%20b", "email_exists"),
    ).toBe("http://localhost:9000/#a=+b&login=email_exists");
  });
});

describe("rate limiter", () => {
  it("allows up to the maximum per window, then reports how long to wait", () => {
    let now = 1_000_000;
    const limiter = new RateLimiter({ max: 3, windowMs: 60_000 }, () => now);
    expect([1, 2, 3].map(() => limiter.hit("ip").allowed)).toEqual([
      true,
      true,
      true,
    ]);
    const fourth = limiter.hit("ip");
    expect(fourth).toEqual({ allowed: false, retryAfterSeconds: 60 });
    now += 45_000;
    expect(limiter.hit("ip").retryAfterSeconds).toBe(15);
  });

  it("counts each key separately and resets after the window", () => {
    let now = 0;
    const limiter = new RateLimiter({ max: 1, windowMs: 1000 }, () => now);
    expect(limiter.hit("a").allowed).toBe(true);
    expect(limiter.hit("b").allowed).toBe(true);
    expect(limiter.hit("a").allowed).toBe(false);
    now += 1001;
    expect(limiter.hit("a").allowed).toBe(true);
  });

  it("forgets expired entries so memory stays bounded", () => {
    let now = 0;
    const limiter = new RateLimiter({ max: 1, windowMs: 10 }, () => now);
    for (let i = 0; i < 10_050; i++) limiter.hit(`k${i}`);
    now += 100;
    limiter.hit("fresh");
    expect(
      (limiter as unknown as { hits: Map<string, unknown> }).hits.size,
    ).toBeLessThan(10);
  });

  it("ships the documented defaults, overridable per limiter", () => {
    expect(RATE_LIMITS.guestCreation).toEqual({ max: 10, windowMs: 3_600_000 });
    expect(RATE_LIMITS.oauthStart).toEqual({ max: 30, windowMs: 60_000 });
    const limiters = createLimiters({
      guestCreation: { max: 1, windowMs: 1000 },
    });
    expect(limiters.guestCreation.hit("x").allowed).toBe(true);
    expect(limiters.guestCreation.hit("x").allowed).toBe(false);
    expect(limiters.oauthStart.hit("x").allowed).toBe(true);
  });
});

describe("sha256", () => {
  it("hashes to 32 raw bytes", () => {
    expect(sha256("abc").toString("hex")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });
});
