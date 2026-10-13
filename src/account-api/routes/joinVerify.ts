import { ClanTagSchema } from "@openfront/engine-api/Schemas";
import { censorPlayer } from "@openfront/shared/Censor";
import express, { type Router } from "express";
import { z } from "zod";
import type { AppDeps } from "./common";
import { requireServerKey } from "./server";

const Body = z.object({
  ip: z.string().max(64),
  // null means "an already-admitted player reconnecting": their single-use
  // Turnstile token is spent, so only the name is checked. The game server
  // never forwards a first join with a null token (planJoinVerify).
  token: z.string().max(4096).nullable(),
  username: z.string().max(100),
  // As on the wire: 2 to 5 letters and digits, or none.
  clanTag: ClanTagSchema,
});

/**
 * POST /join_verify: the production admission gate the game server calls for
 * every first join. Answers whether the Turnstile token is genuine and
 * returns the display-ready name (a banned name as its deterministic shadow
 * name, a banned clan tag as null, a surviving tag upper-cased).
 */
export function joinVerifyRouter(deps: AppDeps): Router {
  const router = express.Router();
  router.post(
    "/join_verify",
    express.json({ limit: "16kb" }),
    requireServerKey(deps.pool, deps.limiters),
    async (req, res) => {
      const parsed = Body.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "invalid_request" });
        return;
      }
      const { ip, token, username, clanTag } = parsed.data;
      if (token !== null) {
        const verdict = await deps.turnstile.verify(token, ip);
        if (verdict.status === "rejected") {
          // The reason is a fixed code (never the token); Cloudflare's own
          // error codes stay in the log.
          deps.log.info("join_verify: token rejected", {
            reason: verdict.reason,
            detail: verdict.detail,
          });
          res.json({ status: "rejected", reason: verdict.reason });
          return;
        }
        if (verdict.status === "unavailable") {
          // The game server decides what an unverified join may do
          // (src/server/JoinVerify.ts, joinFallback); this only reports it.
          deps.log.warn("Turnstile unavailable", { reason: verdict.reason });
          res.status(503).json({ error: "turnstile_unavailable" });
          return;
        }
      }
      const screened = censorPlayer(username, clanTag);
      res.json({
        status: "approved",
        username: screened.username,
        clanTag: screened.clanTag,
      });
    },
  );
  return router;
}
