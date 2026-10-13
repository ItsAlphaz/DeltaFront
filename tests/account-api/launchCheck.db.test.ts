// @vitest-environment node
import { afterEach, beforeEach, expect, it } from "vitest";
import {
  runLaunchChecks,
  type LaunchReport,
} from "../../scripts/launch/launchCheck";
import { applyMigrations } from "../../src/account-api/db/migrator";
import { createPool } from "../../src/account-api/db/pool";
import { sha256 } from "../../src/account-api/http";
import { silentLogger } from "../../src/account-api/logger";
import {
  BRAND_OK,
  createFixture,
  SECRETS,
  type Fixture,
} from "../launch/fixture";
import {
  createTestDatabase,
  describeDb,
  type TestDatabase,
} from "./util/testDb";

describeDb("npm run launch:check (database checks, read-only)", () => {
  let db: TestDatabase;
  let fx: Fixture;

  // A fresh database each time: the checks look at migration state.
  beforeEach(async () => {
    fx = createFixture();
    db = await createTestDatabase();
  });
  afterEach(async () => {
    fx.remove();
    await db?.drop();
  });

  const check = (env: Record<string, string> = {}): Promise<LaunchReport> =>
    runLaunchChecks({
      env: { ...fx.env, DATABASE_URL: db.url, ...env },
      root: fx.root,
      brand: BRAND_OK,
    });
  const failing = (r: LaunchReport) =>
    r.results.filter((x) => x.status === "fail").map((x) => x.id);
  const detail = (r: LaunchReport, id: string) =>
    r.results.find((x) => x.id === id)?.detail ?? "";

  async function migrate(): Promise<void> {
    const pool = createPool(
      { url: db.url, poolMax: 2, statementTimeoutMs: 30_000 },
      silentLogger,
    );
    await applyMigrations(pool);
    await pool.end();
  }

  it("an unmigrated database fails, and the check does not create anything", async () => {
    const report = await check();
    expect(failing(report)).toEqual(
      expect.arrayContaining(["migrations", "server-key"]),
    );
    expect(detail(report, "migrations")).toMatch(
      /pending.*account-api:migrate/,
    );
    const { rows } = await db.pool.query(
      "SELECT to_regclass('schema_migrations') AS t",
    );
    expect(rows[0].t).toBeNull();
  });

  it("a migrated database with no registered server key fails", async () => {
    await migrate();
    const report = await check();
    expect(failing(report)).toEqual(["server-key"]);
    expect(detail(report, "server-key")).toMatch(
      /no server API key is registered/,
    );
  });

  it("passes when migrations are current and the game server's key is registered", async () => {
    await migrate();
    await db.pool.query(
      "INSERT INTO server_api_keys (name, key_hash) VALUES ('launch', $1)",
      [sha256(SECRETS.API_KEY)],
    );
    const report = await check();
    expect(failing(report)).toEqual([]);
    expect(report.results.find((r) => r.id === "migrations")?.status).toBe(
      "pass",
    );
    expect(report.results.find((r) => r.id === "server-key")?.status).toBe(
      "pass",
    );
  });

  it("fails when API_KEY is not one of the registered keys, or the dev key is still active", async () => {
    await migrate();
    await db.pool.query("UPDATE server_api_keys SET revoked_at = now()");
    await db.pool.query(
      "INSERT INTO server_api_keys (name, key_hash) VALUES ('other', $1)",
      [sha256("dfk_some-other-key-0123456789abcdefghijk")],
    );
    expect(detail(await check(), "server-key")).toMatch(
      /does not match any active registered server key/,
    );

    await db.pool.query(
      "INSERT INTO server_api_keys (name, key_hash) VALUES ('mine', $1)",
      [sha256(SECRETS.API_KEY)],
    );
    await db.pool.query(
      "INSERT INTO server_api_keys (name, key_hash) VALUES ('dev', $1)",
      [sha256("WARNING_DEV_API_KEY_DO_NOT_USE_IN_PRODUCTION")],
    );
    expect(detail(await check(), "server-key")).toMatch(
      /development placeholder key is registered/,
    );
  });

  it("an unreachable database fails without printing the connection string or password", async () => {
    const url = `postgres://df:${SECRETS.DB_PASSWORD}@127.0.0.1:1/nothing`;
    const report = await check({ DATABASE_URL: url });
    expect(failing(report)).toContain("database");
    const text = JSON.stringify(report);
    expect(text).not.toContain(SECRETS.DB_PASSWORD);
    expect(text).not.toContain(url);
  });

  it("warns about a remote database without TLS, and not about a local one", async () => {
    const remote = `postgres://df:${SECRETS.DB_PASSWORD}@db.internal.invalid:5432/x`;
    const report = await check({ DATABASE_URL: remote });
    expect(report.results.find((r) => r.id === "database-tls")?.status).toBe(
      "warn",
    );
    expect(JSON.stringify(report)).not.toContain(SECRETS.DB_PASSWORD);
    const secure = await check({ DATABASE_URL: `${remote}?sslmode=require` });
    expect(secure.results.find((r) => r.id === "database-tls")).toBeUndefined();
    expect(
      (await check()).results.find((r) => r.id === "database-tls"),
    ).toBeUndefined();
  });

  it("the database session is read-only", async () => {
    await migrate();
    const before = (
      await db.pool.query("SELECT count(*)::int AS n FROM server_api_keys")
    ).rows[0].n;
    await check();
    const after = (
      await db.pool.query("SELECT count(*)::int AS n FROM server_api_keys")
    ).rows[0].n;
    expect(after).toBe(before);
    const { rows } = await db.pool.query(
      "SELECT count(*)::int AS n FROM pg_stat_activity WHERE application_name = '' AND datname = current_database() AND state = 'idle in transaction'",
    );
    expect(rows[0].n).toBe(0);
  });
});
