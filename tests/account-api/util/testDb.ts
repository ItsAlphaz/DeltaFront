import { randomBytes } from "node:crypto";
import { Pool } from "pg";
import { describe } from "vitest";

/**
 * Support for the database-backed account API tests.
 *
 * They need a real PostgreSQL (there is no in-memory stand-in: the schema uses
 * PostgreSQL features). Point DATABASE_URL_TEST at any database on a server
 * where the user may create databases, e.g.
 *
 *   docker run --rm -p 5432:5432 -e POSTGRES_PASSWORD=test postgres:17
 *   DATABASE_URL_TEST=postgres://postgres:test@localhost:5432/postgres \
 *     npm run test:account-api
 *
 * Each test file creates its own empty database and drops it afterwards, so
 * files never see each other's data and can run in parallel.
 *
 * Without DATABASE_URL_TEST the database tests are skipped, which keeps plain
 * `npm test` free of any dependency. `npm run test:account-api` sets
 * ACCOUNT_API_REQUIRE_DB=1 and fails instead of skipping, so a misconfigured
 * run can never look green.
 */

const rawTestUrl = process.env.DATABASE_URL_TEST?.trim();
export const databaseUrlTest =
  rawTestUrl === undefined || rawTestUrl === "" ? null : rawTestUrl;
export const dbTestsEnabled = databaseUrlTest !== null;

if (!dbTestsEnabled && process.env.ACCOUNT_API_REQUIRE_DB === "1") {
  throw new Error(
    "DATABASE_URL_TEST is not set: the account API database tests need a PostgreSQL server (see tests/account-api/util/testDb.ts)",
  );
}

/** `describe` that is skipped when there is no test database. */
export const describeDb = describe.skipIf(!dbTestsEnabled);

export interface TestDatabase {
  /** Connection string for the fresh database. */
  url: string;
  pool: Pool;
  drop(): Promise<void>;
}

const quote = (name: string) => `"${name.replace(/"/g, '""')}"`;

export async function createTestDatabase(): Promise<TestDatabase> {
  if (databaseUrlTest === null) throw new Error("no DATABASE_URL_TEST");
  const name = `df_acct_${randomBytes(6).toString("hex")}`;
  const admin = new Pool({ connectionString: databaseUrlTest, max: 1 });
  try {
    await admin.query(`CREATE DATABASE ${quote(name)}`);
  } finally {
    await admin.end();
  }
  const url = new URL(databaseUrlTest);
  url.pathname = `/${name}`;
  const pool = new Pool({ connectionString: url.toString(), max: 8 });
  return {
    url: url.toString(),
    pool,
    drop: async () => {
      await pool.end();
      const cleanup = new Pool({ connectionString: databaseUrlTest, max: 1 });
      try {
        await cleanup.query(
          `DROP DATABASE IF EXISTS ${quote(name)} WITH (FORCE)`,
        );
      } finally {
        await cleanup.end();
      }
    },
  };
}
