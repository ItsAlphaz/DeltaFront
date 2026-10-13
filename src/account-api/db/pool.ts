import { Pool } from "pg";
import type { DatabaseConfig } from "../config";
import type { Logger } from "../logger";

/**
 * The PostgreSQL connection pool. PostgreSQL only: there is no fallback to
 * another database, and a missing or unreachable one is an error at startup.
 */
export const LOCK_TIMEOUT_MS = 15_000;
export const IDLE_IN_TRANSACTION_TIMEOUT_MS = 60_000;

export function createPool(config: DatabaseConfig, log: Logger): Pool {
  const pool = new Pool({
    connectionString: config.url,
    max: config.poolMax,
    application_name: "deltafront-account-api",
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
    // A runaway query must not hold a connection forever. Migrations lift
    // this for their own session (see migrator.ts).
    statement_timeout: config.statementTimeoutMs,
    // Fail a statement that waits on a lock instead of queueing every request
    // behind it, and drop a session that left a transaction open (a crashed
    // handler) so it cannot hold row locks. Both are session settings sent at
    // connect time; migrations lift them for their own transaction.
    options: `-c lock_timeout=${LOCK_TIMEOUT_MS} -c idle_in_transaction_session_timeout=${IDLE_IN_TRANSACTION_TIMEOUT_MS}`,
    // Notice a dead peer (a restarted PostgreSQL) promptly, so the pool drops
    // the connection and the next query opens a fresh one.
    keepAlive: true,
    keepAliveInitialDelayMillis: 10_000,
  });
  // An idle client dropping its connection emits here; without a listener it
  // would crash the process.
  pool.on("error", (err) => {
    log.error("idle database client error", { error: err.message });
  });
  return pool;
}
