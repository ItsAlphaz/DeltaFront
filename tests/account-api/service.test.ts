// @vitest-environment node
import type { Pool } from "pg";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/account-api/app";
import {
  loadConfig,
  type AccountApiConfig,
} from "../../src/account-api/config";
import { loadMigrationFiles } from "../../src/account-api/db/migrator";
import { silentLogger } from "../../src/account-api/logger";
import {
  checkSecretFiles,
  startAccountApi,
  StartupError,
  type RunningService,
} from "../../src/account-api/service";

const config = (extra: Partial<AccountApiConfig> = {}): AccountApiConfig => ({
  ...loadConfig({
    GAME_ENV: "dev",
    DATABASE_URL: "postgres://u:p@localhost:5432/df",
  }),
  port: 0,
  ...extra,
});

/**
 * Just enough of a pool for the startup checks: whether the history table
 * exists and what it records. The real thing is exercised against PostgreSQL
 * in tests/account-api/db.
 */
function fakePool(options: {
  connectError?: Error;
  applied?: "all" | "none";
}): { pool: Pool; ended: () => boolean } {
  const files = loadMigrationFiles();
  let ended = false;
  const pool = {
    query: async () => {
      if (options.connectError) throw options.connectError;
      return { rows: [{ "?column?": 1 }] };
    },
    connect: async () => ({
      query: async (sql: string) => {
        if (sql.includes("to_regclass")) {
          return { rows: [{ exists: options.applied === "all" }] };
        }
        return {
          rows: files.map((f) => ({
            version: f.version,
            name: f.name,
            checksum: f.checksum,
            applied_at: new Date(),
          })),
        };
      },
      release: () => undefined,
    }),
    end: async () => {
      ended = true;
    },
  } as unknown as Pool;
  return { pool, ended: () => ended };
}

let running: RunningService | null = null;
afterEach(async () => {
  await running?.close().catch(() => undefined);
  running = null;
});

describe("the account API skeleton", () => {
  it("boots with valid configuration and a current database, and answers /health", async () => {
    const { pool } = fakePool({ applied: "all" });
    running = await startAccountApi(config(), silentLogger, { pool });
    expect(running.port).toBeGreaterThan(0);

    const health = await fetch(`http://127.0.0.1:${running.port}/health`);
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ status: "ok" });
    expect(health.headers.get("x-content-type-options")).toBe("nosniff");
    expect(health.headers.get("x-powered-by")).toBeNull();
  });

  it("serves no account endpoints yet: everything else is a JSON 404", async () => {
    const { pool } = fakePool({ applied: "all" });
    running = await startAccountApi(config(), silentLogger, { pool });
    for (const route of [
      "/users/@me",
      "/auth/refresh",
      "/cosmetics.json",
      "/leaderboard/players",
      "/clans",
      "/.well-known/jwks.json",
    ]) {
      const res = await fetch(`http://127.0.0.1:${running.port}${route}`);
      expect(res.status, route).toBe(404);
      expect(await res.json(), route).toEqual({ error: "not_found" });
    }
  });

  it("refuses to start while migrations are pending, and says what to run", async () => {
    const { pool, ended } = fakePool({ applied: "none" });
    await expect(
      startAccountApi(config(), silentLogger, { pool }),
    ).rejects.toThrow(/pending migration.*npm run account-api:migrate/);
    expect(ended()).toBe(true);
  });

  it("refuses to start when PostgreSQL cannot be reached", async () => {
    const { pool, ended } = fakePool({
      connectError: new Error("ECONNREFUSED"),
    });
    const failure = startAccountApi(config(), silentLogger, { pool });
    await expect(failure).rejects.toBeInstanceOf(StartupError);
    await expect(failure).rejects.toThrow(
      /cannot connect to PostgreSQL: ECONNREFUSED/,
    );
    expect(ended()).toBe(true);
  });

  it("closing releases the port and the pool", async () => {
    const { pool, ended } = fakePool({ applied: "all" });
    const service = await startAccountApi(config(), silentLogger, { pool });
    const { port } = service;
    await service.close();
    expect(ended()).toBe(true);
    await expect(fetch(`http://127.0.0.1:${port}/health`)).rejects.toThrow();
  });

  it("answers an unexpected error with a bare 500, never a stack trace", async () => {
    const logged: unknown[] = [];
    const app = createApp({
      config: config(),
      log: {
        ...silentLogger,
        error: ((...args: unknown[]) => logged.push(args)) as never,
      },
      mount: (a) =>
        a.get("/boom", () => {
          throw new Error("secret internal detail");
        }),
    });
    const server = await new Promise<import("node:http").Server>((resolve) => {
      const s = app.listen(0, () => resolve(s));
    });
    try {
      const { port } = server.address() as { port: number };
      const res = await fetch(`http://127.0.0.1:${port}/boom`);
      expect(res.status).toBe(500);
      const body = await res.text();
      expect(JSON.parse(body)).toEqual({ error: "internal_error" });
      expect(body).not.toContain("secret internal detail");
      // The detail goes to the log, not the client.
      expect(JSON.stringify(logged)).toContain("secret internal detail");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe("checkSecretFiles", () => {
  it("passes when no key files are configured", () => {
    expect(() => checkSecretFiles(config())).not.toThrow();
  });

  it("names the variable, not the path, when a configured key file is unreadable", () => {
    const missing = config({
      jwt: {
        privateKeyPath: "/nonexistent/private.pem",
        previousPublicKeyPath: null,
      },
    });
    expect(() => checkSecretFiles(missing)).toThrow(
      "JWT_PRIVATE_KEY_PATH points to a file that cannot be read",
    );
    const previous = config({
      jwt: {
        privateKeyPath: null,
        previousPublicKeyPath: "/nonexistent/old.pem",
      },
    });
    expect(() => checkSecretFiles(previous)).toThrow(
      /JWT_PREVIOUS_PUBLIC_KEY_PATH/,
    );
  });
});
