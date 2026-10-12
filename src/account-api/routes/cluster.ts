import express, { type Router } from "express";
import { z } from "zod";
import { withTransaction } from "../db/tx";
import type { AppDeps } from "./common";
import { requireServerKey } from "./server";

/**
 * Server discovery (docs/MultiServer.md): game servers check in every 10
 * seconds and the client reads the resulting list. The response schemas are
 * the ones the existing server and client already use.
 */

/** A server that has not checked in for this long is not offered to anyone (6 missed beats). */
export const CHECKIN_STALE_SECONDS = 60;

const HOSTLIKE = /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?(?::\d{1,5})?$/;
const hostlike = z.string().max(260).regex(HOSTLIKE);

const CheckinBody = z.object({
  site: hostlike,
  letter: z.string().regex(/^[a-z]$/),
  host: hostlike,
  // The client matches this against its own build; it must look like a commit.
  version: z.string().regex(/^[0-9a-f]{7,40}$/i),
  numWorkers: z.number().int().min(1).max(1024),
  liveGames: z.number().int().min(0).max(1_000_000),
  machine: z
    .string()
    .regex(/^[a-zA-Z0-9-]{1,63}$/)
    .optional(),
});

export function clusterRouter(deps: AppDeps): Router {
  const { pool } = deps;
  const router = express.Router();

  router.post(
    "/cluster/checkin",
    express.json({ limit: "16kb" }),
    requireServerKey(pool),
    async (req, res) => {
      const parsed = CheckinBody.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          error: "invalid_checkin",
          reason: z.prettifyError(parsed.error),
        });
        return;
      }
      const b = parsed.data;
      const outcome = await withTransaction(pool, async (db) => {
        const { rows } = await db.query<{
          host: string;
          num_workers: number;
          live_games: number;
          state: string;
        }>(
          "SELECT host, num_workers, live_games, state FROM game_servers WHERE site = $1 AND letter = $2 FOR UPDATE",
          [b.site, b.letter],
        );
        if (rows.length === 0) {
          // The first server to claim a letter owns it.
          await db.query(
            `INSERT INTO game_servers (site, letter, host, version, num_workers, live_games, machine)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [
              b.site,
              b.letter,
              b.host,
              b.version,
              b.numWorkers,
              b.liveGames,
              b.machine ?? null,
            ],
          );
          return { state: "open" as const };
        }
        const existing = rows[0];
        // A letter is bound to its host: a mistyped letter must not take
        // another server's games (game ids route to servers by their letter).
        if (existing.host !== b.host) {
          return {
            refused: "letter is registered to a different host",
            host: existing.host,
          };
        }
        // Game ids route to workers by hash of the id modulo the worker count,
        // so the count cannot change while games are running on the letter.
        if (existing.num_workers !== b.numWorkers && existing.live_games > 0) {
          return {
            refused: "worker count cannot change while games are live",
            host: existing.host,
          };
        }
        await db.query(
          `UPDATE game_servers
            SET version = $3, num_workers = $4, live_games = $5, machine = $6, last_checkin_at = now()
          WHERE site = $1 AND letter = $2`,
          [
            b.site,
            b.letter,
            b.version,
            b.numWorkers,
            b.liveGames,
            b.machine ?? null,
          ],
        );
        // The state is the operator's decision (admin CLI), never the server's.
        return { state: existing.state as "open" | "draining" | "fenced" };
      });
      if ("refused" in outcome) {
        res.status(409).json({ reason: outcome.refused, host: outcome.host });
        return;
      }
      res.json({ state: outcome.state });
    },
  );

  router.get("/cluster.json", async (req, res) => {
    const site = typeof req.query.site === "string" ? req.query.site : "";
    if (!HOSTLIKE.test(site) || site.length > 260) {
      res.status(400).json({ error: "invalid_site" });
      return;
    }
    const { rows } = await pool.query<{
      letter: string;
      host: string;
      num_workers: number;
      version: string;
      state: "open" | "draining" | "fenced";
      last_checkin_at: Date;
    }>(
      `SELECT letter, host, num_workers, version, state, last_checkin_at
         FROM game_servers
        WHERE site = $1 AND last_checkin_at > now() - ($2 || ' seconds')::interval
        ORDER BY letter`,
      [site, String(CHECKIN_STALE_SECONDS)],
    );
    // A site nobody has registered under (or whose servers have gone quiet)
    // answers 404: the client reads that as "no list", not as an outage.
    if (rows.length === 0) {
      res.status(404).json({ error: "unknown_site" });
      return;
    }
    // `latest` is the build new players should be on: what an open server runs.
    const open = rows.filter((r) => r.state === "open");
    const newest = open.sort(
      (a, b) => b.last_checkin_at.getTime() - a.last_checkin_at.getTime(),
    )[0];
    res.setHeader("Cache-Control", "public, max-age=5");
    res.json({
      ...(newest !== undefined ? { latest: newest.version } : {}),
      servers: Object.fromEntries(
        rows.map((r) => [
          r.letter,
          {
            host: r.host,
            numWorkers: r.num_workers,
            version: r.version,
            state: r.state,
          },
        ]),
      ),
    });
  });

  return router;
}
