import {
  PlayerGameModeFilterSchema,
  PlayerGameTypeFilterSchema,
  type PlayerProfile,
  type PublicPlayerGamesResponse,
} from "@openfront/shared/ApiSchemas";
import express, {
  type NextFunction,
  type Request,
  type Response,
  type Router,
} from "express";
import { ACCOUNT_RULES } from "../domain/constants";
import { buildStatsTree } from "../domain/stats";
import { displayUsername } from "../domain/usernames";
import { clientIp } from "../http";
import { aggregatesOf, historyPage, recentRowsOf } from "../repo/profile";
import { getUserByPublicId, identitiesOf, type UserRow } from "../repo/users";
import { authenticate, type AppDeps } from "./common";
import { linkedIdentities } from "./users";

const PUBLIC_ID = /^[A-Za-z0-9]{6,32}$/;
const CURSOR = /^[A-Za-z0-9_-]{1,64}$/;

/** A cursor is the id of the last game on the page; opaque to the client. */
function encodeCursor(gameId: string): string {
  return Buffer.from(JSON.stringify({ g: gameId }), "utf8").toString(
    "base64url",
  );
}

function decodeCursor(cursor: string): string | null {
  if (!CURSOR.test(cursor)) return null;
  try {
    const parsed = JSON.parse(
      Buffer.from(cursor, "base64url").toString("utf8"),
    ) as { g?: unknown };
    return typeof parsed.g === "string" && /^\d{1,18}$/.test(parsed.g)
      ? parsed.g
      : null;
  } catch {
    return null;
  }
}

/**
 * Player profiles and game history (docs/DeltaFrontAccountsPlan.md 8.4):
 *  - GET /public/player/:publicId        the profile, no sign-in needed;
 *  - GET /player/:publicId               the same, for a signed-in caller;
 *  - GET /public/player/:publicId/games  the player's games, newest first.
 * The stats are the stored aggregates, which only ingestion of a game
 * server's record ever writes.
 */
export function profileRouter(deps: AppDeps): Router {
  const { pool, limiters } = deps;
  const router = express.Router();

  const limited = (req: Request, res: Response, next: NextFunction): void => {
    const verdict = limiters.publicRead.hit(clientIp(req));
    if (!verdict.allowed) {
      res.setHeader("Retry-After", String(verdict.retryAfterSeconds));
      res.status(429).json({ error: "rate_limited" });
      return;
    }
    next();
  };

  async function findUser(publicId: string): Promise<UserRow | null> {
    if (!PUBLIC_ID.test(publicId)) return null;
    const user = await getUserByPublicId(pool, publicId);
    // An account that was deleted (or is queued for it) has no public page.
    return user === null ||
      user.deletedAt !== null ||
      user.deletionRequestedAt !== null
      ? null
      : user;
  }

  async function profileOf(user: UserRow): Promise<PlayerProfile> {
    const [identities, aggregates, recent] = await Promise.all([
      identitiesOf(pool, user.id),
      aggregatesOf(pool, user.id),
      recentRowsOf(pool, user.id),
    ]);
    const discord = linkedIdentities(identities).discord;
    return {
      createdAt: user.createdAt.toISOString(),
      ...(discord === undefined ? {} : { user: discord }),
      username: displayUsername(user.usernameBase, user.usernameDiscriminator),
      stats: buildStatsTree(aggregates, recent),
    } as unknown as PlayerProfile;
  }

  router.get("/public/player/:publicId", limited, async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    const user = await findUser(String(req.params.publicId));
    if (user === null) {
      res.status(404).json({ error: "player_not_found" });
      return;
    }
    res.json(await profileOf(user));
  });

  router.get("/player/:publicId", limited, async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    if ((await authenticate(req, deps)) === null) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    const user = await findUser(String(req.params.publicId));
    if (user === null) {
      res.status(404).json({ error: "player_not_found" });
      return;
    }
    res.json(await profileOf(user));
  });

  router.get("/public/player/:publicId/games", limited, async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    const user = await findUser(String(req.params.publicId));
    if (user === null) {
      res.status(404).json({ error: "player_not_found" });
      return;
    }
    const filter =
      req.query.filter === undefined
        ? undefined
        : PlayerGameModeFilterSchema.safeParse(req.query.filter);
    const type =
      req.query.type === undefined
        ? undefined
        : PlayerGameTypeFilterSchema.safeParse(req.query.type);
    if (filter?.success === false || type?.success === false) {
      res.status(400).json({ error: "invalid_filter" });
      return;
    }
    let before: string | null = null;
    if (req.query.cursor !== undefined) {
      before =
        typeof req.query.cursor === "string"
          ? decodeCursor(req.query.cursor)
          : null;
      if (before === null) {
        res.status(400).json({ error: "invalid_cursor" });
        return;
      }
    }
    const page = await historyPage(
      pool,
      user.id,
      { mode: filter?.data, type: type?.data },
      before,
      ACCOUNT_RULES.historyPageSize,
    );
    const last = page.games[page.games.length - 1];
    const body: PublicPlayerGamesResponse = {
      results: page.games.map(({ id: _id, ...game }) => game),
      nextCursor:
        page.hasMore && last !== undefined ? encodeCursor(last.id) : null,
    };
    res.json(body);
  });

  return router;
}
