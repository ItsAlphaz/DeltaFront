import type { Pool, PoolClient } from "pg";

/** PostgreSQL's "the other transaction won" errors: nothing was committed, so running again is safe. */
const RETRYABLE_CODES = new Set([
  "40P01", // deadlock_detected
  "40001", // serialization_failure
]);

export const MAX_TRANSACTION_ATTEMPTS = 3;

export function isRetryableTransactionError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string" &&
    RETRYABLE_CODES.has(error.code)
  );
}

/**
 * Runs `fn` in one transaction: committed if it resolves, rolled back if it
 * throws (and the error is rethrown). The client is always returned to the
 * pool; if the rollback itself fails the connection is discarded rather than
 * reused in an unknown state.
 *
 * A deadlock or serialization failure rolls the whole transaction back with
 * nothing committed, so it is retried (up to three attempts, after a short
 * random pause) on a fresh transaction. That is why `fn` must be safe to run
 * again: it should do its work through the client it is given and keep no
 * state outside the transaction that a second run would double. Every other
 * error is thrown immediately.
 */
export async function withTransaction<T>(
  pool: Pick<Pool, "connect">,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await runOnce(pool, fn);
    } catch (error) {
      if (
        attempt >= MAX_TRANSACTION_ATTEMPTS ||
        !isRetryableTransactionError(error)
      ) {
        throw error;
      }
      await new Promise((resolve) =>
        setTimeout(resolve, 10 + Math.random() * 40 * attempt),
      );
    }
  }
}

async function runOnce<T>(
  pool: Pick<Pool, "connect">,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  let discard = false;
  try {
    await client.query("BEGIN");
    try {
      const result = await fn(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {
        discard = true;
      }
      throw error;
    }
  } finally {
    client.release(discard);
  }
}
