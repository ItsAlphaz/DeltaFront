// @vitest-environment node
import { afterAll, describe, expect, it } from "vitest";
import { makeWorkDir, runScript } from "./util/runScript";

/**
 * The real entry points, run as processes, with a clean environment and an
 * empty working directory (so neither the host shell nor a developer's .env
 * can change the outcome). These need no database.
 */

const work = makeWorkDir();
afterAll(() => work.remove());

const run = (script: string, args: string[], env: Record<string, string>) =>
  runScript(work.dir, script, args, env);

describe("npm run start:account-api", () => {
  it("fails clearly, with exit code 1, when GAME_ENV is missing", async () => {
    const { code, stderr } = await run("src/account-api/index.ts", [], {});
    expect(code).toBe(1);
    expect(stderr).toContain("Invalid account API configuration");
    expect(stderr).toContain(
      "GAME_ENV is required and must be one of: dev, staging, prod",
    );
    expect(stderr).not.toMatch(/\n\s+at /); // no stack trace for a configuration error
  }, 60_000);

  it("lists every missing setting for a production environment, without printing secrets", async () => {
    const { code, stderr } = await run("src/account-api/index.ts", [], {
      GAME_ENV: "prod",
      DF_ACCOUNT_FEATURES: "accounts",
      DISCORD_CLIENT_SECRET: "must-not-appear-in-output",
    });
    expect(code).toBe(1);
    for (const name of [
      "DOMAIN",
      "API_PUBLIC_ORIGIN",
      "ALLOWED_ORIGINS",
      "DATABASE_URL",
      "JWT_PRIVATE_KEY_PATH",
      "DISCORD_CLIENT_ID",
    ]) {
      expect(stderr, name).toContain(name);
    }
    expect(stderr).not.toContain("must-not-appear-in-output");
  }, 60_000);

  it("fails clearly when PostgreSQL is unreachable (there is no fallback database)", async () => {
    const { code, stderr } = await run("src/account-api/index.ts", [], {
      GAME_ENV: "dev",
      DATABASE_URL: "postgres://nobody:pw-should-not-print@127.0.0.1:1/none",
    });
    expect(code).toBe(1);
    expect(stderr).toMatch(/cannot connect to PostgreSQL/);
    expect(stderr).not.toContain("pw-should-not-print");
  }, 60_000);

  it("refuses an unknown feature name in production rather than starting with it off", async () => {
    const { code, stderr } = await run("src/account-api/index.ts", [], {
      GAME_ENV: "prod",
      DOMAIN: "example.com",
      API_PUBLIC_ORIGIN: "https://api.example.com",
      ALLOWED_ORIGINS: "https://example.com",
      DATABASE_URL: "postgres://u:p@127.0.0.1:1/none",
      DF_ACCOUNT_FEATURES: "acounts",
    });
    expect(code).toBe(1);
    expect(stderr).toContain('DF_ACCOUNT_FEATURES: unknown feature "acounts"');
  }, 60_000);
});

describe("npm run account-api:migrate", () => {
  it("fails clearly without DATABASE_URL", async () => {
    const { code, stderr } = await run("src/account-api/migrate.ts", [], {});
    expect(code).toBe(1);
    expect(stderr).toContain("DATABASE_URL is required");
  }, 60_000);

  it("rejects an unknown command", async () => {
    const { code, stderr } = await run(
      "src/account-api/migrate.ts",
      ["drop"],
      {},
    );
    expect(code).toBe(2);
    expect(stderr).toContain('unknown command "drop"');
  }, 60_000);
});

describe("npm run admin", () => {
  it("prints the commands without needing a database", async () => {
    for (const args of [[], ["help"], ["--help"]]) {
      const { code, stdout } = await run(
        "src/account-api/admin/cli.ts",
        args,
        {},
      );
      expect(code).toBe(0);
      expect(stdout).toContain("user:ban <publicId>");
      expect(stdout).toContain("server:key:create <name>");
    }
  }, 60_000);

  it("a real command needs DATABASE_URL, and says so without a stack trace", async () => {
    const { code, stderr } = await run(
      "src/account-api/admin/cli.ts",
      ["user:find", "x"],
      {},
    );
    expect(code).toBe(1);
    expect(stderr).toContain("DATABASE_URL is required");
    expect(stderr).not.toMatch(/\n\s+at /);
  }, 60_000);
});
