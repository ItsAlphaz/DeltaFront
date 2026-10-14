import { ID } from "@openfront/engine-api/Schemas";
import { staffRoleOf } from "@openfront/shared/Permissions";
import express, { type Router } from "express";
import { z } from "zod";
import { withTransaction } from "../db/tx";
import { writeAudit } from "../domain/adminOps";
import type { AppDeps } from "./common";
import { requireServerKey } from "./server";

/**
 * Where the game server reports what a staff member did inside a game
 * (kicks, pauses, admin commands), so the in-game admin tools land in the same
 * audit log as the CLI and the web panel.
 *
 * Server-to-server only: a valid game-server API key, and never a browser. The
 * body carries no secret by construction (a fixed set of fields), and `details`
 * is a small bag of numbers and short strings.
 */

/** Everything a game server may report; anything else is refused. */
export const GAME_ADMIN_ACTIONS = [
  "game:kick",
  "game:pause",
  "game:command",
  "game:force-end",
] as const;

const Body = z.object({
  gameID: ID,
  actorPublicId: z.string().regex(/^[A-Za-z0-9]{6,32}$/),
  action: z.enum(GAME_ADMIN_ACTIONS),
  targetClientID: z.string().max(16).optional(),
  targetPublicId: z
    .string()
    .regex(/^[A-Za-z0-9]{6,32}$/)
    .optional(),
  details: z
    .record(
      z.string().max(40),
      z.union([z.string().max(100), z.number(), z.boolean(), z.null()]),
    )
    .refine((d) => Object.keys(d).length <= 12, "too many details")
    .optional(),
});

export function gameAdminRouter(deps: AppDeps): Router {
  const { pool } = deps;
  const router = express.Router();

  router.post(
    "/game_admin/audit",
    (req, res, next) => {
      // A browser always sends an Origin header; a game server never does.
      if (req.headers.origin !== undefined) {
        res.status(403).json({ error: "browser_not_allowed" });
        return;
      }
      next();
    },
    requireServerKey(pool, deps.limiters),
    express.json({ limit: "8kb" }),
    async (req, res) => {
      const parsed = Body.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "invalid_request" });
        return;
      }
      const b = parsed.data;
      await withTransaction(pool, async (db) => {
        const { rows } = await db.query<{ id: string; role: string | null }>(
          "SELECT id, role FROM users WHERE public_id = $1",
          [b.actorPublicId],
        );
        const actor = rows[0];
        const role = staffRoleOf(actor?.role);
        await writeAudit(
          db,
          {
            actor: b.actorPublicId,
            source: "game",
            actorUserId: actor?.id ?? null,
            actorRole: role,
          },
          b.action,
          b.targetPublicId === undefined ? "game" : "user",
          b.targetPublicId ?? b.gameID,
          {
            gameID: b.gameID,
            ...(b.targetClientID === undefined
              ? {}
              : { targetClientID: b.targetClientID }),
            ...b.details,
            // The role the game server acted on may be older than the database's.
            ...(role === null ? { actorNoLongerStaff: true } : {}),
          },
        );
      });
      res.status(204).end();
    },
  );

  return router;
}
