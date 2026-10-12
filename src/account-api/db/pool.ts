import { Pool } from "pg";
import type { DatabaseConfig } from "../config";
import type { Logger } from "../logger";

/**
 * The PostgreSQL connection pool. PostgreSQL only: there is no fallback to
 * another database, and a missing or unreachable one is an error at startup.
 */
export function createPool(config: DatabaseConfig, log: Logger): Pool {
  const pool = new Pool({
    connectionString: config.url,
    max: config.poolMax,
    application_name: "deltafront-account-api",
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
    // A runaway query must not hold a connection forever. Migrations lift
    // this for their own session (see migrator.ts).
    statement_timeout: 30_000,
  });
  // An idle client dropping its connection emits here; without a listener it
  // would crash the process.
  pool.on("error", (err) => {
    log.error("idle database client error", { error: err.message });
  });
  return pool;
}
