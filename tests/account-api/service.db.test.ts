// @vitest-environment node
import net from "node:net";
import { afterAll, afterEach, expect, it } from "vitest";
import { loadConfig } from "../../src/account-api/config";
import { applyMigrations } from "../../src/account-api/db/migrator";
import { createPool } from "../../src/account-api/db/pool";
import { silentLogger } from "../../src/account-api/logger";
import {
  startAccountApi,
  StartupError,
  type RunningService,
} from "../../src/account-api/service";
import { makeWorkDir, runScript, startScript } from "./util/runScript";
import {
  createTestDatabase,
  describeDb,
  type TestDatabase,
} from "./util/testDb";

const work = makeWorkDir();
afterAll(() => work.remove());

const databases: TestDatabase[] = [];
let running: RunningService | null = null;
afterEach(async () => {
  await running?.close().catch(() => undefined);
  running = null;
  for (const db of databases.splice(0)) await db.drop();
});
async function freshDb(): Promise<TestDatabase> {
  const db = await createTestDatabase();
  databases.push(db);
  return db;
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address() as net.AddressInfo;
      s.close(() => resolve(port));
    });
  });
}

async function waitForHealth(
  port: number,
  output: () => string,
): Promise<Response> {
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      return await fetch(`http://127.0.0.1:${port}/health`);
    } catch (error) {
      if (Date.now() > deadline) {
        // The cause is just "connection refused" while it was starting; the
        // service's own output (above) is the useful part. ES2022's
        // { cause } is not available at this repo's compile target.
        // eslint-disable-next-line preserve-caught-error
        throw new Error(`service never answered:\n${output()}`);
      }
      await new Promise((r) => setTimeout(r, 250));
    }
  }
}

describeDb("the account API against PostgreSQL", () => {
  it("won't start on an empty database, and starts once it is migrated", async () => {
    const db = await freshDb();
    const config = {
      ...loadConfig({ GAME_ENV: "dev", DATABASE_URL: db.url }),
      port: 0,
    };

    const refused = createPool(config.database, silentLogger);
    await expect(
      startAccountApi(config, silentLogger, { pool: refused }),
    ).rejects.toThrow(
      /7 pending migration\(s\) \(next: 0001_init\.sql\); run "npm run account-api:migrate" first/,
    );

    const pool = createPool(config.database, silentLogger);
    await applyMigrations(pool);
    running = await startAccountApi(config, silentLogger, { pool });
    const res = await fetch(`http://127.0.0.1:${running.port}/health`);
    expect(await res.json()).toEqual({ status: "ok" });
  });

  it("rejects a wrong password with a clear startup error", async () => {
    const db = await freshDb();
    const url = new URL(db.url);
    url.password = "definitely-wrong";
    const config = {
      ...loadConfig({ GAME_ENV: "dev", DATABASE_URL: url.toString() }),
      port: 0,
    };
    const failure = startAccountApi(config, silentLogger);
    await expect(failure).rejects.toBeInstanceOf(StartupError);
    await expect(failure).rejects.toThrow(/cannot connect to PostgreSQL/);
  });
});

describeDb("npm run account-api:migrate and npm run start:account-api", () => {
  it("migrates, reports status, boots from the environment, and shuts down cleanly", async () => {
    const db = await freshDb();
    const env = { GAME_ENV: "dev", DATABASE_URL: db.url };

    const before = await runScript(
      work.dir,
      "src/account-api/migrate.ts",
      ["status"],
      env,
    );
    expect(before.code).toBe(0);
    expect(before.stdout).toContain("pending  0001_init");
    expect(before.stdout).toContain("pending  0002_leaderboard");

    // Booting before migrating fails clearly, with the fix in the message.
    const early = await runScript(work.dir, "src/account-api/index.ts", [], {
      ...env,
      API_PORT: String(await freePort()),
    });
    expect(early.code).toBe(1);
    expect(early.stderr).toContain('run "npm run account-api:migrate" first');

    const up = await runScript(work.dir, "src/account-api/migrate.ts", [], env);
    expect(up.code).toBe(0);
    expect(up.stdout).toContain(
      "applied 7 migration(s): 0001, 0002, 0003, 0004, 0005, 0006, 0007",
    );
    const again = await runScript(
      work.dir,
      "src/account-api/migrate.ts",
      [],
      env,
    );
    expect(again.stdout).toContain("database is up to date");
    const after = await runScript(
      work.dir,
      "src/account-api/migrate.ts",
      ["status"],
      env,
    );
    expect(after.stdout).toMatch(/applied\s+0001_init/);
    expect(after.stdout).toMatch(/applied\s+0002_leaderboard/);

    const port = await freePort();
    const service = startScript(work.dir, "src/account-api/index.ts", {
      ...env,
      API_PORT: String(port),
    });
    try {
      const health = await waitForHealth(port, service.output);
      expect(health.status).toBe(200);
      expect(await health.json()).toEqual({ status: "ok" });
      // The startup log shows the configuration without any password.
      expect(service.output()).toContain("account API listening");
      const { username, password } = new URL(db.url);
      expect(service.output()).not.toContain(`${username}:${password}@`);
      expect(service.output()).not.toContain(db.url);
    } finally {
      service.child.kill("SIGTERM");
    }
    expect(await service.exited).toBe(0);
  }, 120_000);
});
