import express, {
  type NextFunction,
  type Request,
  type Response,
  type Router,
} from "express";
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

/**
 * The game server's other lookups, which have nothing to list yet:
 *  - the registered clan tags (`[]` until clans exist, milestone M6), which the
 *    server's privilege refresher requires alongside the cosmetic catalog;
 *  - the pool of purchased tribe names (`{ tribes: [] }`; custom tribe names
 *    are not part of V1).
 */
export function serverLookupsRouter(pool: Pick<Pool, "query">): Router {
  const router = express.Router();
  const serverOnly = requireServerKey(pool);

  router.get("/reserved_clan_tags", serverOnly, (_req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.json([]);
  });

  router.post("/custom_tribes", serverOnly, (_req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.json({ tribes: [] });
  });

  return router;
}
