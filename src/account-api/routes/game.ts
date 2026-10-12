import { ID } from "@openfront/engine-api/Schemas";
import { GameRecordSchema } from "@openfront/shared/WireSchemas";
import express, { type Router } from "express";
import { gunzipSync, gzipSync } from "node:zlib";
import { z } from "zod";
import type { AppDeps } from "./common";
import { requireServerKey } from "./server";

/**
 * The game archive, store only (milestone M1): finished games are kept so
 * replays work. Nothing is derived from them yet; stats, Credits and
 * leaderboards arrive in M2 and read what is stored here.
 */
export function gameRouter(deps: AppDeps): Router {
  const { pool } = deps;
  const router = express.Router();

  router.post(
    "/game/:id",
    express.json({ limit: "100mb" }),
    requireServerKey(pool),
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
      const { info, gitCommit } = parsed.data;
      if (info.gameID !== id.data) {
        res.status(400).json({ error: "game_id_mismatch" });
        return;
      }
      const config = info.config as unknown as Record<string, unknown>;
      const text = (v: unknown): string | null =>
        v === undefined || v === null ? null : String(v);
      const raw = JSON.stringify(req.body);
      const inserted = await pool.query<{ id: string }>(
        `INSERT INTO games
         (game_code, source, type, mode, difficulty, map, player_teams, ranked_type, public_game_type,
          started_at, ended_at, duration_s, human_players, winner, git_commit, server_letter, counts_for_stats)
       VALUES ($1, 'server', $2, $3, $4, $5, $6, $7, $8, to_timestamp($9::double precision / 1000),
               to_timestamp($10::double precision / 1000), $11, $12, $13, $14, $15, false)
       ON CONFLICT (game_code) DO NOTHING
       RETURNING id`,
        [
          id.data,
          text(config.gameType),
          text(config.gameMode),
          text(config.difficulty),
          text(config.gameMap),
          text(config.playerTeams),
          text(config.rankedType),
          text(info.publicGameType),
          info.start,
          info.end,
          Math.max(0, Math.floor(info.duration)),
          info.players.length,
          info.winner === undefined ? null : JSON.stringify(info.winner),
          gitCommit,
          id.data.charAt(0).toLowerCase(),
        ],
      );
      // A repeat of an archived game is not an error (the server retries).
      if (inserted.rows.length > 0) {
        const gz = gzipSync(Buffer.from(raw, "utf8"));
        await pool.query(
          "INSERT INTO game_records (game_id, record_gz, bytes) VALUES ($1, $2, $3)",
          [inserted.rows[0].id, gz, gz.length],
        );
      }
      res.json({ ok: true });
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

  return router;
}
