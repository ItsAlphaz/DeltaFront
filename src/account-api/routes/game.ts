import { ID } from "@openfront/engine-api/Schemas";
import { GameRecordSchema } from "@openfront/shared/WireSchemas";
import express, { type Router } from "express";
import { gunzipSync } from "node:zlib";
import { z } from "zod";
import { ingestGameRecord, recordProblem } from "../domain/ingest";
import type { AppDeps } from "./common";
import { requireServerKey } from "./server";

/**
 * The game archive and what it feeds (milestone M2). A finished game arrives
 * from a game server (never a browser), is stored for replays, and is turned
 * into stats and Credits in the same transaction (domain/ingest.ts). Readers
 * get the record back with the players' account ids removed.
 */
export function gameRouter(deps: AppDeps): Router {
  const { pool, log } = deps;
  const router = express.Router();

  // Result submission is server-to-server. Browsers always add an Origin
  // header (and cannot remove it), and a game server never does, so a request
  // that has one is refused before anything else is looked at.
  const serverOnly = (
    req: express.Request,
    res: express.Response,
    next: express.NextFunction,
  ): void => {
    if (req.headers.origin !== undefined) {
      res.status(403).json({ error: "browser_not_allowed" });
      return;
    }
    next();
  };

  router.post(
    "/game/:id",
    serverOnly,
    requireServerKey(pool),
    express.json({ limit: "100mb" }),
    async (req, res) => {
      const id = ID.safeParse(req.params.id);
      if (!id.success) {
        res.status(400).json({ error: "invalid_game_id" });
        return;
      }
      const parsed = GameRecordSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          error: "invalid_record",
          reason: z.prettifyError(parsed.error).slice(0, 500),
        });
        return;
      }
      if (parsed.data.info.gameID !== id.data) {
        res.status(400).json({ error: "game_id_mismatch" });
        return;
      }
      const problem = recordProblem(parsed.data, Date.now());
      if (problem !== null) {
        res.status(400).json({ error: "invalid_record", reason: problem });
        return;
      }
      try {
        const outcome = await ingestGameRecord(
          pool,
          parsed.data,
          JSON.stringify(req.body),
        );
        if (outcome.duplicate)
          log.info("game record repeated", { id: id.data });
        res.json({ ok: true });
      } catch (error) {
        // Nothing was stored (one transaction), so the server can send it again.
        log.error("game ingestion failed", {
          id: id.data,
          error: error instanceof Error ? error.message : String(error),
        });
        res.status(500).json({ error: "ingest_failed" });
      }
    },
  );

  router.get("/game/:id", async (req, res) => {
    const id = ID.safeParse(req.params.id);
    if (!id.success) {
      res.status(400).json({ error: "invalid_game_id" });
      return;
    }
    const { rows } = await pool.query<{ record_gz: Buffer }>(
      `SELECT r.record_gz FROM games g JOIN game_records r ON r.game_id = g.id WHERE g.game_code = $1`,
      [id.data],
    );
    if (rows.length === 0) {
      res.status(404).json({ error: "game_not_found" });
      return;
    }
    const record = JSON.parse(
      gunzipSync(rows[0].record_gz).toString("utf8"),
    ) as {
      info: {
        players: Array<{ persistentID: string | null }>;
        reports?: unknown;
      };
    };
    // Readers never see who the players are in the account system: the
    // persistent ID is the account's identity.
    for (const player of record.info.players) player.persistentID = null;
    delete record.info.reports;
    res.setHeader("Cache-Control", "public, max-age=300");
    res.json(record);
  });

  // A body that is not JSON, or is too large, is the sender's mistake.
  router.use(
    (
      err: unknown,
      _req: express.Request,
      res: express.Response,
      next: express.NextFunction,
    ) => {
      const status = (err as { status?: number }).status;
      if (typeof status === "number" && status >= 400 && status < 500) {
        res.status(status).json({ error: "invalid_body" });
        return;
      }
      next(err);
    },
  );

  return router;
}
