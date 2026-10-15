import { PartialGameRecordSchema } from "@openfront/shared/WireSchemas";
import express, { type Router } from "express";
import { gzipSync } from "node:zlib";
import { z } from "zod";
import { SOLO } from "../domain/constants";
import { soloProblem } from "../domain/soloVerify";
import { clientIp } from "../http";
import { activeBan, getUser } from "../repo/users";
import { authenticate, type AppDeps } from "./common";

/**
 * Where a browser hands in a singleplayer match for XP: `POST /archive_singleplayer_game`
 * (the client's long-standing upload, bearer token, a gzipped record).
 *
 * The upload is not believed: it is checked for shape here, kept, and replayed on
 * the server's own engine by the solo worker (jobs/solo.ts), which pays what the
 * replay finds, not what the record says. The response only says whether it was
 * taken: it never carries XP, and nothing in the request can choose an amount, a
 * setup, a difficulty or an account (the player is the bearer's).
 *
 *   200 {status:"duplicate"}   already submitted or stored
 *   200 {status:"ignored"}     an account that cannot earn XP (a guest)
 *   202 {status:"queued"}      accepted; the XP follows (GET /users/@me/xp/:gameId)
 *   400                        not a solo record
 *   401/403                    no session / banned
 *   413                        too large
 *   429/503                    too many today or too many waiting: try again later
 */
export function soloRouter(deps: AppDeps): Router {
  const { pool, limiters, solo, log } = deps;
  const router = express.Router();

  /**
   * Who may upload, decided BEFORE the body is read: an upload from nobody, a
   * guest, a banned account or one over its limit is refused without the API
   * reading (and unpacking) up to the size limit of it.
   */
  const gate = async (
    req: express.Request,
    res: express.Response,
    next: express.NextFunction,
  ): Promise<void> => {
    res.setHeader("Cache-Control", "no-store");
    if (!solo) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const claims = await authenticate(req, deps);
    const user = claims === null ? null : await getUser(pool, claims.userId);
    if (user === null || user.deletedAt !== null) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    const verdict = limiters.soloSubmit.hit(user.id);
    if (!verdict.allowed) {
      res.setHeader("Retry-After", String(verdict.retryAfterSeconds));
      res.status(429).json({ error: "rate_limited" });
      return;
    }
    // Guests have a session too, but no XP to earn: say so, so the client
    // does not keep trying.
    if (user.kind !== "registered") {
      res.json({ ok: true, status: "ignored", reason: "guest" });
      return;
    }
    if ((await activeBan(pool, user.id)) !== null) {
      res.status(403).json({ error: "banned" });
      return;
    }
    res.locals.soloUserId = user.id;
    next();
  };

  router.post(
    "/archive_singleplayer_game",
    gate,
    // The parser unpacks the gzip body and counts what it unpacks to against
    // the limit, so a small upload that inflates to a huge one is refused
    // (413) as it grows, not after it is in memory.
    express.raw({ type: () => true, limit: SOLO.maxRecordBytes }),
    async (req, res) => {
      const userId = res.locals.soloUserId as string;
      if (!solo) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      const json = req.body;
      if (!Buffer.isBuffer(json) || json.length === 0) {
        res.status(400).json({ error: "invalid_record", reason: "empty" });
        return;
      }
      let body: unknown;
      try {
        body = JSON.parse(json.toString("utf8"));
      } catch {
        res.status(400).json({ error: "invalid_record", reason: "not json" });
        return;
      }
      const parsed = PartialGameRecordSchema.safeParse(body);
      if (!parsed.success) {
        res.status(400).json({
          error: "invalid_record",
          reason: z.prettifyError(parsed.error).slice(0, 500),
        });
        return;
      }
      const problem = soloProblem(parsed.data);
      if (problem !== null) {
        res.status(400).json({ error: "invalid_record", reason: problem });
        return;
      }
      try {
        const outcome = await solo.submit({
          userId,
          gameCode: parsed.data.info.gameID,
          // kept compressed: the queue holds it until it is decided
          gz: gzipSync(json),
        });
        switch (outcome.status) {
          case "queued":
            res.status(202).json({ ok: true, status: "queued" });
            return;
          case "duplicate":
            res.json({ ok: true, status: "duplicate" });
            return;
          case "limit":
            res.setHeader("Retry-After", "3600");
            res.status(429).json({ error: "daily_limit" });
            return;
          case "busy":
            res.setHeader("Retry-After", "60");
            res.status(503).json({ error: "busy" });
            return;
        }
      } catch (error) {
        log.error("solo submission failed", {
          ip: clientIp(req),
          error: error instanceof Error ? error.message : String(error),
        });
        res.status(500).json({ error: "submit_failed" });
      }
    },
  );

  return router;
}
