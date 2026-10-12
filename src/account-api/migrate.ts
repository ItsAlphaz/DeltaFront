// Loaded first so .env is in process.env before anything reads it.
import "dotenv/config";

import { ConfigError, loadDatabaseConfig } from "./config";
import {
  applyMigrations,
  loadMigrationFiles,
  MigrationError,
  migrationStatus,
} from "./db/migrator";
import { createPool } from "./db/pool";
import { createLogger } from "./logger";

/**
 * `npm run account-api:migrate`          apply every pending migration
 * `npm run account-api:migrate -- status` list applied and pending migrations
 *
 * Needs only DATABASE_URL, so it can run in a deploy step before the service
 * (and its other settings) exist.
 */
async function main(): Promise<number> {
  const command = process.argv[2] ?? "up";
  if (command !== "up" && command !== "status") {
    console.error(`unknown command "${command}" (use "up" or "status")`);
    return 2;
  }
  const log = createLogger("info");
  const pool = createPool(loadDatabaseConfig(), log);
  try {
    const files = loadMigrationFiles();
    if (command === "status") {
      const status = await migrationStatus(pool, files);
      for (const m of status.applied) {
        console.log(
          `applied  ${m.version}_${m.name}  ${m.appliedAt.toISOString()}`,
        );
      }
      for (const m of status.pending) {
        console.log(`pending  ${m.version}_${m.name}`);
      }
      return 0;
    }
    const { applied } = await applyMigrations(pool, { files, log });
    console.log(
      applied.length === 0
        ? "database is up to date"
        : `applied ${applied.length} migration(s): ${applied.join(", ")}`,
    );
    return 0;
  } finally {
    await pool.end();
  }
}

main().then(
  (code) => process.exit(code),
  (error) => {
    if (error instanceof ConfigError || error instanceof MigrationError) {
      console.error(error.message);
    } else {
      console.error("migration failed:", error);
    }
    process.exit(1);
  },
);
