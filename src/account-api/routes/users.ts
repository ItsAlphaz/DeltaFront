import type { UserMeResponse } from "@openfront/shared/ApiSchemas";
import express, { type Router } from "express";
import {
  activeBan,
  getUser,
  identitiesOf,
  type ActiveBan,
  type IdentityRow,
  type UserRow,
} from "../repo/users";
import { authenticate, type AppDeps } from "./common";

/**
 * The /users/@me body for milestone M1: who the account is, how it signs in,
 * and the safe defaults the schema requires. Everything that belongs to a
 * later milestone (stats, currency, inventory, clans, friends, progression)
 * is left out, or empty where the schema insists on a value, so the client
 * keeps those screens hidden.
 */
export function buildUserMe(
  user: UserRow,
  identities: IdentityRow[],
  ban: ActiveBan | null,
): UserMeResponse {
  const linked: UserMeResponse["user"] = {};
  for (const identity of identities) {
    if (identity.provider === "discord") {
      const p = identity.profile as {
        id?: string;
        username?: string;
        global_name?: string | null;
        avatar?: string | null;
        discriminator?: string;
      };
      linked.discord = {
        id: p.id ?? identity.providerUserId,
        username: p.username ?? identity.displayName ?? "",
        global_name: p.global_name ?? null,
        avatar: p.avatar ?? null,
        discriminator: p.discriminator ?? "0",
      };
    } else if (identity.provider === "google") {
      linked.google = { email: identity.email ?? "" };
    } else if (identity.provider === "email") {
      linked.email = identity.email ?? identity.providerUserId;
    }
  }
  return {
    user: linked,
    ban:
      ban === null
        ? null
        : {
            category: ban.category,
            reason: ban.reason,
            expiresAt: ban.expiresAt?.toISOString() ?? null,
          },
    player: {
      publicId: user.publicId,
      adfree: false,
      unlimitedRanked: false,
      canCreatePublicLobbies: false,
      // "trusted" needs account age and counted games (docs plan 14.6); there
      // are no games yet, so nobody is.
      trustTier: "untrusted",
      achievements: { singleplayerMap: [], player: [] },
      friends: [],
      subscription: null,
    },
  };
}

export function usersRouter(deps: AppDeps): Router {
  const router = express.Router();

  router.get("/users/@me", async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    const claims = await authenticate(req, deps);
    if (claims === null) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    const user = await getUser(deps.pool, claims.userId);
    if (user === null || user.deletedAt !== null) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    const [identities, ban] = await Promise.all([
      identitiesOf(deps.pool, user.id),
      activeBan(deps.pool, user.id),
    ]);
    res.json(buildUserMe(user, identities, ban));
  });

  return router;
}
