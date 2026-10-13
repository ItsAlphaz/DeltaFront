import { GameEnv } from "@openfront/shared/configuration/Env";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearAppShellContentCache,
  contentSecurityPolicyFor,
  renderHtmlContent,
} from "../../src/server/RenderHtml";
import {
  applyCommonSecurityHeaders,
  buildContentSecurityPolicy,
  inlineScriptHashes,
} from "../../src/server/SecurityHeaders";
import { ServerEnv } from "../../src/server/ServerEnv";

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const INDEX = path.join(ROOT, "index.html");

const base = {
  apiOrigin: "https://api.example.com",
  domains: ["example.com"],
  cdnBase: "",
  googleAnalytics: false,
  cloudflareAnalytics: false,
  upgradeInsecure: true,
};

const directive = (policy: string, name: string): string[] =>
  (policy
    .split("; ")
    .find((d) => d.startsWith(`${name} `))
    ?.split(" ")
    .slice(1) ?? []) as string[];

describe("the app shell's Content-Security-Policy", () => {
  let html: string;
  beforeEach(async () => {
    vi.stubEnv("INSTANCE_LETTER", "a");
    vi.stubEnv("NUM_WORKERS", "1");
    vi.stubEnv("TURNSTILE_SITE_KEY", "test-key");
    vi.stubEnv("DOMAIN", "example.com");
    vi.stubEnv("GOOGLE_ANALYTICS_ID", "G-ABCD1234");
    vi.stubEnv("CLOUDFLARE_ANALYTICS_TOKEN", "a".repeat(32));
    html = await renderHtmlContent(INDEX);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    clearAppShellContentCache();
  });

  it("lists the hash of every inline script in the real page, and allows no unsafe script execution", () => {
    const policy = buildContentSecurityPolicy({ ...base, html });
    const scriptSrc = directive(policy, "script-src");
    const hashes = inlineScriptHashes(html);
    expect(hashes.length).toBeGreaterThanOrEqual(5);
    for (const hash of hashes) expect(scriptSrc).toContain(hash);
    expect(scriptSrc).not.toContain("'unsafe-inline'");
    expect(scriptSrc).not.toContain("'unsafe-eval'");
    expect(scriptSrc).not.toContain("*");
    expect(scriptSrc).not.toContain("https:");
  });

  it("does not cover an inline script that is not in the page (an injected one cannot run)", () => {
    const policy = buildContentSecurityPolicy({ ...base, html });
    const injected = inlineScriptHashes("<script>alert(1)</script>");
    expect(injected).toHaveLength(1);
    expect(policy).not.toContain(injected[0]);
  });

  it("ignores non-executable blocks and external scripts when hashing", () => {
    expect(
      inlineScriptHashes(
        '<script type="application/json">{"a":1}</script><script src="/x.js"></script><script type="module" src="/m.js"></script>',
      ),
    ).toEqual([]);
    expect(inlineScriptHashes('<script type="module">1</script>')).toHaveLength(
      1,
    );
  });

  it("allows what the game needs: Turnstile, the account API, game sockets, Discord avatars", () => {
    const policy = buildContentSecurityPolicy({ ...base, html });
    expect(directive(policy, "script-src")).toContain(
      "https://challenges.cloudflare.com",
    );
    expect(directive(policy, "frame-src")).toEqual([
      "https://challenges.cloudflare.com",
    ]);
    const connect = directive(policy, "connect-src");
    expect(connect).toEqual(
      expect.arrayContaining([
        "'self'",
        "https://api.example.com",
        "wss://example.com",
        "wss://*.example.com",
        "https://challenges.cloudflare.com",
      ]),
    );
    expect(directive(policy, "img-src")).toEqual(
      expect.arrayContaining([
        "'self'",
        "data:",
        "blob:",
        "https://cdn.discordapp.com",
        "https://api.example.com",
      ]),
    );
    expect(directive(policy, "worker-src")).toEqual(
      expect.arrayContaining(["'self'", "blob:"]),
    );
  });

  it("forbids plugins, framing by others, base-tag and form hijacking", () => {
    const policy = buildContentSecurityPolicy({ ...base, html });
    expect(directive(policy, "object-src")).toEqual(["'none'"]);
    expect(directive(policy, "frame-ancestors")).toEqual(["'self'"]);
    expect(directive(policy, "base-uri")).toEqual(["'self'"]);
    expect(directive(policy, "form-action")).toEqual(["'self'"]);
    expect(directive(policy, "default-src")).toEqual(["'self'"]);
    expect(policy).toContain("upgrade-insecure-requests");
  });

  it("every external script the page can load is covered by script-src", () => {
    const policy = buildContentSecurityPolicy({
      ...base,
      html,
      googleAnalytics: true,
      cloudflareAnalytics: true,
    });
    const scriptSrc = directive(policy, "script-src");
    const origins = new Set<string>();
    for (const m of html.matchAll(/\bsrc\s*=\s*["'](https:\/\/[^"']+)["']/g)) {
      origins.add(new URL(m[1]).origin);
    }
    for (const m of html.matchAll(/\.src\s*=\s*["'](https:\/\/[^"']+)["']/g)) {
      origins.add(new URL(m[1]).origin);
    }
    expect(origins.size).toBeGreaterThanOrEqual(3);
    for (const origin of origins) expect(scriptSrc, origin).toContain(origin);
  });

  it("adds analytics hosts only when the deployment enabled them", () => {
    const off = buildContentSecurityPolicy({ ...base, html });
    expect(off).not.toMatch(
      /googletagmanager|google-analytics|cloudflareinsights/,
    );
    const on = buildContentSecurityPolicy({
      ...base,
      html,
      googleAnalytics: true,
      cloudflareAnalytics: true,
    });
    expect(on).toContain("https://www.googletagmanager.com");
    expect(on).toContain("https://static.cloudflareinsights.com");
  });

  it("names no OpenFront host and keeps a CDN origin when one is configured", () => {
    const policy = buildContentSecurityPolicy({
      ...base,
      html,
      cdnBase: "https://cdn.example.com",
    });
    expect(policy).not.toMatch(/openfront/i);
    expect(directive(policy, "script-src")).toContain(
      "https://cdn.example.com",
    );
    expect(directive(policy, "img-src")).toContain("https://cdn.example.com");
  });

  it("a local stack gets no upgrade-insecure-requests and may use plain websockets", () => {
    const policy = buildContentSecurityPolicy({
      ...base,
      html,
      apiOrigin: "http://localhost:8787",
      domains: ["localhost"],
      upgradeInsecure: false,
    });
    expect(policy).not.toContain("upgrade-insecure-requests");
    expect(directive(policy, "connect-src")).toContain("ws://localhost:*");
  });

  it("is applied outside dev, skipped in dev and when switched off", () => {
    const env = vi.spyOn(ServerEnv, "env");
    env.mockReturnValue(GameEnv.Prod);
    expect(contentSecurityPolicyFor(html)).toContain("script-src");
    env.mockReturnValue(GameEnv.Dev);
    expect(contentSecurityPolicyFor(html)).toBeNull();
    env.mockReturnValue(GameEnv.Prod);
    vi.stubEnv("CSP_MODE", "off");
    expect(contentSecurityPolicyFor(html)).toBeNull();
    expect(ServerEnv.cspMode()).toBe("off");
    vi.stubEnv("CSP_MODE", "report-only");
    expect(ServerEnv.cspMode()).toBe("report-only");
    vi.stubEnv("CSP_MODE", "bogus");
    expect(ServerEnv.cspMode()).toBe("enforce");
  });

  it("the page no longer loads the CrazyGames SDK unconditionally", async () => {
    const raw = await fs.readFile(INDEX, "utf8");
    expect(raw).not.toMatch(/<script[^>]+src="https:\/\/sdk\.crazygames/);
  });
});

describe("common security headers", () => {
  function headersFor(hsts: boolean): Map<string, string> {
    const headers = new Map<string, string>();
    applyCommonSecurityHeaders(
      { setHeader: (k: string, v: string) => headers.set(k, v) } as never,
      { hsts },
    );
    return headers;
  }

  it("sets nosniff, a referrer policy, framing, permissions and opener protection", () => {
    const h = headersFor(false);
    expect(h.get("X-Content-Type-Options")).toBe("nosniff");
    expect(h.get("Referrer-Policy")).toBe("strict-origin-when-cross-origin");
    expect(h.get("X-Frame-Options")).toBe("SAMEORIGIN");
    expect(h.get("Permissions-Policy")).toMatch(/camera=\(\)/);
    expect(h.get("Cross-Origin-Opener-Policy")).toBe(
      "same-origin-allow-popups",
    );
    expect(h.has("Strict-Transport-Security")).toBe(false);
  });

  it("sends HSTS only when asked", () => {
    expect(headersFor(true).get("Strict-Transport-Security")).toMatch(
      /max-age=31536000; includeSubDomains/,
    );
  });
});
