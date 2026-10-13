// @vitest-environment node
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  formatReport,
  runLaunchChecks,
  type LaunchReport,
} from "../../scripts/launch/launchCheck";
import { BRAND_OK, createFixture, SECRETS, type Fixture } from "./fixture";

let fx: Fixture;
beforeEach(() => {
  fx = createFixture();
});
afterEach(() => fx.remove());

const run = (
  extra: Partial<Parameters<typeof runLaunchChecks>[0]> = {},
  env: Record<string, string | undefined> = fx.env,
) =>
  runLaunchChecks({
    env,
    root: fx.root,
    database: false,
    brand: BRAND_OK,
    ...extra,
  });

const failing = (report: LaunchReport) =>
  report.results.filter((r) => r.status === "fail").map((r) => r.id);
const detailOf = (report: LaunchReport, id: string) =>
  report.results.find((r) => r.id === id)?.detail ?? "";

describe("npm run launch:check (offline checks)", () => {
  it("passes a complete launch-ready deployment", async () => {
    const report = await run();
    expect(failing(report)).toEqual([]);
    expect(report.failed).toBe(0);
    // OAuth can never be proven offline: it always says so.
    expect(report.results.find((r) => r.id === "oauth")?.status).toBe("warn");
    expect(formatReport(report)).toMatch(/Result: READY/);
  });

  it("fails when GAME_ENV is not prod (staging only with --allow-staging)", async () => {
    expect(failing(await run({}, { ...fx.env, GAME_ENV: "dev" }))).toContain(
      "env",
    );
    expect(
      failing(await run({}, { ...fx.env, GAME_ENV: undefined })),
    ).toContain("env");
    const staging = { ...fx.env, GAME_ENV: "staging" };
    expect(failing(await run({}, staging))).toContain("env");
    expect(failing(await run({ allowStaging: true }, staging))).not.toContain(
      "env",
    );
  });

  it("fails on missing production values, naming them but not their contents", async () => {
    const env = { ...fx.env };
    delete (env as Record<string, string | undefined>).DOMAIN;
    delete (env as Record<string, string | undefined>).DISCORD_CLIENT_SECRET;
    const report = await run({}, env);
    expect(failing(report)).toContain("config");
    expect(detailOf(report, "config")).toMatch(/DOMAIN is required/);
    expect(detailOf(report, "config")).toMatch(
      /DISCORD_CLIENT_ID and DISCORD_CLIENT_SECRET/,
    );
  });

  it("fails on a dev placeholder API key, wildcard or http origins and a localhost domain", async () => {
    const dev = await run(
      {},
      { ...fx.env, API_KEY: "WARNING_DEV_API_KEY_DO_NOT_USE_IN_PRODUCTION" },
    );
    expect(failing(dev)).toEqual(
      expect.arrayContaining(["dev-config", "game-server-env"]),
    );
    expect(
      failing(await run({}, { ...fx.env, ALLOWED_ORIGINS: "*" })),
    ).toContain("config");
    expect(
      failing(
        await run({}, { ...fx.env, ALLOWED_ORIGINS: "http://example.com" }),
      ),
    ).toContain("config");
    expect(
      failing(await run({}, { ...fx.env, DOMAIN: "localhost" })),
    ).toContain("config");
    expect(failing(await run({}, { ...fx.env, CSP_MODE: "off" }))).toContain(
      "dev-config",
    );
  });

  it("requires exactly the launch feature set", async () => {
    for (const value of [
      "accounts",
      "accounts,store,inventory,clans,leaderboards,payments",
      "accounts,store,inventory,clans,leaderboards,ranked",
      "accounts,store,inventory,clans,leaderbords",
      "",
    ]) {
      const report = await run({}, { ...fx.env, DF_ACCOUNT_FEATURES: value });
      expect(failing(report), value).toContain("features");
    }
  });

  it("fails when the client was built without the launch features", async () => {
    fs.writeFileSync(
      path.join(fx.root, "static/assets/index-abc.js"),
      'var f="accounts";',
    );
    expect(failing(await run())).toContain("client-flags");
    fs.rmSync(path.join(fx.root, "static"), { recursive: true });
    expect(failing(await run())).toContain("build");
  });

  it("finds the baked flags however the minifier quoted them", async () => {
    for (const quote of ["'", "`"]) {
      fs.writeFileSync(
        path.join(fx.root, "static/assets/index-abc.js"),
        `function f(){try{return ${quote}accounts,store,inventory,clans,leaderboards${quote}}catch{}}`,
      );
      expect(failing(await run()), quote).not.toContain("client-flags");
    }
  });

  it("fails if a secret value is in the built client, and never prints it", async () => {
    fs.writeFileSync(
      path.join(fx.root, "static/assets/leak.js"),
      `var f="accounts,store,inventory,clans,leaderboards";var k="${SECRETS.API_KEY}";var s="${SECRETS.TURNSTILE_SECRET_KEY}";var d="${SECRETS.DB_PASSWORD}"`,
    );
    const report = await run();
    expect(failing(report)).toContain("bundle-secrets");
    const detail = detailOf(report, "bundle-secrets");
    expect(detail).toMatch(/API_KEY appears in static\/assets\/leak\.js/);
    expect(detail).toMatch(/TURNSTILE_SECRET_KEY/);
    expect(detail).toMatch(/DATABASE_URL password/);
    for (const secret of Object.values(SECRETS)) {
      expect(JSON.stringify(report)).not.toContain(secret);
    }
  });

  it("fails if the built client names an OpenFront service", async () => {
    fs.writeFileSync(
      path.join(fx.root, "static/assets/api.js"),
      'var f="accounts,store,inventory,clans,leaderboards";fetch("https://api.openfront.io/users/@me")',
    );
    expect(failing(await run())).toContain("bundle-openfront");
  });

  it("fails placeholder or incomplete legal pages, in the source and in the build", async () => {
    const placeholder =
      "<p><!-- DELTAFRONT PLACEHOLDER --> not published yet</p>";
    fs.writeFileSync(
      path.join(fx.root, "resources/public/privacy-policy.html"),
      placeholder,
    );
    let report = await run();
    expect(failing(report)).toContain("legal:resources/public");
    expect(detailOf(report, "legal:resources/public")).toMatch(
      /privacy-policy\.html still carries/,
    );
    fs.writeFileSync(
      path.join(fx.root, "static/terms-of-service.html"),
      placeholder,
    );
    report = await run();
    expect(failing(report)).toEqual(
      expect.arrayContaining(["legal:resources/public", "legal:static"]),
    );
  });

  it("fails the upstream source link (AGPL section 13), Steam and ads leftovers", async () => {
    const upstream = await run({
      brand: {
        ...BRAND_OK,
        sourceRepoUrl: "https://github.com/openfrontio/OpenFrontIO",
      },
    });
    expect(failing(upstream)).toContain("branding");
    expect(detailOf(upstream, "branding")).toMatch(/AGPL-3\.0 section 13/);
    expect(
      failing(
        await run({ brand: { ...BRAND_OK, steamAppId: "480" as never } }),
      ),
    ).toContain("branding");
    expect(
      failing(await run({ brand: { ...BRAND_OK, adsEnabled: true } })),
    ).toContain("branding");
  });

  it("fails Cloudflare test keys and a fail-open Turnstile fallback", async () => {
    expect(
      failing(
        await run(
          {},
          { ...fx.env, TURNSTILE_SITE_KEY: "1x00000000000000000000AA" },
        ),
      ),
    ).toContain("turnstile");
    expect(
      failing(
        await run(
          {},
          {
            ...fx.env,
            TURNSTILE_SECRET_KEY: "1x0000000000000000000000000000000AA",
          },
        ),
      ),
    ).toContain("turnstile");
    const open = await run({}, { ...fx.env, TURNSTILE_FALLBACK: "open" });
    expect(detailOf(open, "turnstile")).toMatch(/lets everyone in/);
    expect(
      failing(await run({}, { ...fx.env, TURNSTILE_FALLBACK: "registered" })),
    ).toEqual([]);
    expect(
      failing(await run({}, { ...fx.env, TURNSTILE_FALLBACK: "closed" })),
    ).toEqual([]);
    expect(
      failing(await run({}, { ...fx.env, TURNSTILE_FALLBACK: "nope" })),
    ).toContain("turnstile");
  });

  it("fails a world-readable signing key, one inside the repository, and a missing one", async () => {
    fs.chmodSync(fx.keyPath, 0o644);
    expect(detailOf(await run(), "signing-key")).toMatch(
      /readable by other users/,
    );
    fs.chmodSync(fx.keyPath, 0o600);

    const inside = path.join(fx.root, "jwt.pem");
    fs.copyFileSync(fx.keyPath, inside);
    fs.chmodSync(inside, 0o600);
    expect(
      detailOf(
        await run({}, { ...fx.env, JWT_PRIVATE_KEY_PATH: inside }),
        "signing-key",
      ),
    ).toMatch(/inside the repository/);

    fs.writeFileSync(fx.keyPath, "not a key", { mode: 0o600 });
    expect(failing(await run())).toContain("signing-key");
    fs.rmSync(fx.keyPath);
    expect(failing(await run())).toContain("signing-key");
  });

  it("fails when the API does not know it is behind a proxy", async () => {
    const report = await run({}, { ...fx.env, TRUST_PROXY_HOPS: "0" });
    expect(failing(report)).toContain("proxy");
  });

  it("never prints a secret value, whatever fails", async () => {
    const hostile = {
      ...fx.env,
      DF_ACCOUNT_FEATURES: "accounts,payments",
      GAME_ENV: "dev",
      ALLOWED_ORIGINS: "*",
      TURNSTILE_FALLBACK: "open",
    };
    const report = await run({}, hostile);
    const text = formatReport(report) + JSON.stringify(report);
    for (const secret of Object.values(SECRETS))
      expect(text).not.toContain(secret);
    expect(text).not.toContain("BEGIN PRIVATE KEY");
  });

  it("does not modify anything on disk", async () => {
    const snapshot = () =>
      fs
        .readdirSync(fx.root, { recursive: true })
        .map(String)
        .sort()
        .map((f) => {
          const full = path.join(fx.root, f);
          return fs.statSync(full).isFile()
            ? `${f}:${fs.statSync(full).mtimeMs}`
            : f;
        });
    const before = snapshot();
    await run();
    await run({}, { ...fx.env, GAME_ENV: "dev" });
    expect(snapshot()).toEqual(before);
  });
});

describe("the real repository", () => {
  it("is reported as NOT READY today for the right reasons (placeholders and the upstream source link), unless those are done", async () => {
    const root = path.resolve(import.meta.dirname, "../..");
    const report = await runLaunchChecks({
      env: fx.env,
      root,
      database: false,
    });
    // The legal gate and the AGPL link are the owner's to finish; the check
    // must say so rather than pass silently.
    const html = fs.readFileSync(
      path.join(root, "resources/public/privacy-policy.html"),
      "utf8",
    );
    const legalDone = !html.includes("DELTAFRONT PLACEHOLDER");
    expect(failing(report).includes("legal:resources/public")).toBe(!legalDone);
    const brandMod = await import("../../src/client/Branding");
    const upstream = /github\.com\/openfrontio\//i.test(
      brandMod.BRAND.sourceRepoUrl,
    );
    expect(failing(report).includes("branding")).toBe(upstream);
  });
});

describe("placeholders copied from deploy/env", () => {
  it("fails on any value that is still CHANGE_ME, naming the variables and not the values", async () => {
    const report = await run(
      {},
      {
        ...fx.env,
        TURNSTILE_SECRET_KEY: "CHANGE_ME",
        GOOGLE_CLIENT_ID: "CHANGE_ME",
      },
    );
    expect(failing(report)).toContain("dev-config");
    expect(detailOf(report, "dev-config")).toMatch(
      /GOOGLE_CLIENT_ID, TURNSTILE_SECRET_KEY/,
    );
  });
});
