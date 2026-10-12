import type { NextFunction, Request, Response } from "express";
import type { Pool } from "pg";
import { sha256 } from "../http";

/**
 * Authentication for the game servers' calls (check-in, join verification,
 * game archive): the `x-api-key` header must hash to a key in
 * `server_api_keys` that has not been revoked. Keys are minted with
 * `npm run admin -- server:key:create` and only their SHA-256 is stored.
 */
export function requireServerKey(pool: Pick<Pool, "query">) {
  return async (
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> => {
    const key = req.headers["x-api-key"];
    if (typeof key !== "string" || key === "" || key.length > 512) {
      res.status(401).json({ error: "invalid_api_key" });
      return;
    }
    const { rows } = await pool.query(
      "SELECT 1 FROM server_api_keys WHERE key_hash = $1 AND revoked_at IS NULL",
      [sha256(key)],
    );
    if (rows.length === 0) {
      res.status(401).json({ error: "invalid_api_key" });
      return;
    }
    next();
  };
}
