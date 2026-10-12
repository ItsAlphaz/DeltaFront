import type { Pool, PoolClient } from "pg";

/**
 * Runs `fn` in one transaction: committed if it resolves, rolled back if it
 * throws (and the error is rethrown). The client is always returned to the
 * pool; if the rollback itself fails the connection is discarded rather than
 * reused in an unknown state.
 */
export async function withTransaction<T>(
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
