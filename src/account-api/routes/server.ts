import express, {
  type NextFunction,
  type Request,
  type Response,
  type Router,
} from "express";
import type { Pool } from "pg";
import { tagFromRoute, type ReservedClanNames } from "../domain/clans";
import { clientIp, sha256 } from "../http";
import type { Limiters } from "../limits";
import { reservedTagList, tagIsRegistered } from "../repo/clans";

/**
 * Authentication for the game servers' calls (check-in, join verification,
 * game archive): the `x-api-key` header must hash to a key in
 * `server_api_keys` that has not been revoked. Keys are minted with
 * `npm run admin -- server:key:create` and only their SHA-256 is stored.
 *
 * With `limiters`, a client address that keeps presenting wrong keys is cut
 * off with 429 before any lookup (a guess budget), and a valid key is held to
 * a generous request budget (a leaked key cannot be used to hammer the API
 * unnoticed).
 */
export function requireServerKey(
  pool: Pick<Pool, "query">,
  limiters?: Pick<Limiters, "serverCall" | "serverKeyFailure">,
) {
  const tooMany = (res: Response, retryAfterSeconds: number): void => {
    res.setHeader("Retry-After", String(retryAfterSeconds));
    res.status(429).json({ error: "rate_limited" });
  };
  return async (
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> => {
    const ip = clientIp(req);
    const blocked = limiters?.serverKeyFailure.isExhausted(ip);
    if (blocked !== undefined && !blocked.allowed) {
      tooMany(res, blocked.retryAfterSeconds);
      return;
    }
    const key = req.headers["x-api-key"];
    let valid = false;
    if (typeof key === "string" && key !== "" && key.length <= 512) {
      const { rows } = await pool.query(
        "SELECT 1 FROM server_api_keys WHERE key_hash = $1 AND revoked_at IS NULL",
        [sha256(key)],
      );
      valid = rows.length > 0;
    }
    if (!valid) {
      limiters?.serverKeyFailure.hit(ip);
      res.status(401).json({ error: "invalid_api_key" });
      return;
    }
    const verdict = limiters?.serverCall.hit(ip);
    if (verdict !== undefined && !verdict.allowed) {
      tooMany(res, verdict.retryAfterSeconds);
      return;
    }
    next();
  };
}

/**
 * The game server's other lookups, which have nothing to list yet:
 *  - the registered clan tags: the reserved list, every live clan's tag and
 *    every held tag (milestone M6), which the server's privilege refresher
 *    requires alongside the cosmetic catalog;
 *  - the pool of purchased tribe names (`{ tribes: [] }`; custom tribe names
 *    are not part of V1).
 */
export function serverLookupsRouter(
  pool: Pick<Pool, "query">,
  reserved: ReservedClanNames,
  limiters?: Pick<Limiters, "serverCall" | "serverKeyFailure">,
): Router {
  const router = express.Router();
  const serverOnly = requireServerKey(pool, limiters);

  router.get("/reserved_clan_tags", serverOnly, async (_req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.json(await reservedTagList(pool, reserved));
  });

  // Whether one tag is registered right now (a live clan, a held tag or the
  // reserved list): the game server asks this for a tag a player wears but
  // does not own, so a clan created since its last refresh is protected too.
  router.get("/reserved_clan_tags/:tag", serverOnly, async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    const tag = tagFromRoute(String(req.params.tag));
    res.json({
      registered: tag !== null && (await tagIsRegistered(pool, reserved, tag)),
    });
  });

  router.post("/custom_tribes", serverOnly, (_req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.json({ tribes: [] });
  });

  return router;
}
