import type {
  PutUsernameResponse,
  UserMeResponse,
} from "@openfront/shared/ApiSchemas";
import express, { type Router } from "express";
import { clearCookie, parseCookies, REFRESH_COOKIE } from "../auth/cookies";
import { ACCOUNT_RULES } from "../domain/constants";
import {
  checkUsernameBase,
  displayUsername,
  PutUsernameBody,
  randomDiscriminator,
} from "../domain/usernames";
import { clientIp, requireAllowedOrigin } from "../http";
import { creditsOf } from "../repo/profile";
import { liveSession, revokeAllForUser } from "../repo/sessions";
import {
  activeBan,
  getUser,
  identitiesOf,
  type ActiveBan,
  type IdentityRow,
  type UserRow,
} from "../repo/users";
import { authenticate, cookieSecure, type AppDeps } from "./common";

/** The linked sign-in identities in the shape `/users/@me` and profiles share. */
export function linkedIdentities(
  identities: IdentityRow[],
): UserMeResponse["user"] {
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
  return linked;
}

/**
 * The /users/@me body: who the account is, how it signs in, its username and
 * its Credits balance. Everything that belongs to a later milestone
 * (inventory, clans, friends, progression, premium currency) is left out, or
 * empty where the schema insists on a value, so the client keeps those
 * screens hidden.
 */
export function buildUserMe(
  user: UserRow,
  identities: IdentityRow[],
  ban: ActiveBan | null,
  credits: number,
): UserMeResponse {
  return {
    user: linkedIdentities(identities),
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
      username: displayUsername(user.usernameBase, user.usernameDiscriminator),
      usernameBase: user.usernameBase,
      usernameDiscriminator: user.usernameDiscriminator,
      usernameStatus: "unclaimed",
      nextUsernameChangeAt: user.nextUsernameChangeAt?.toISOString() ?? null,
      // Credits ride in the contract's "soft" slot; the premium slot stays 0.
      currency: { soft: credits, hard: 0 },
      achievements: { singleplayerMap: [], player: [] },
      friends: [],
      subscription: null,
    },
  };
}

/** Roles that cannot delete their own account through the public endpoint. */
const STAFF_ROLES = new Set(["root", "admin", "mod"]);

export function usersRouter(deps: AppDeps): Router {
  const { pool, config, limiters } = deps;
  const router = express.Router();

  router.get("/users/@me", async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    const claims = await authenticate(req, deps);
    if (claims === null) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    const user = await getUser(pool, claims.userId);
    if (user === null || user.deletedAt !== null) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    const [identities, ban, credits] = await Promise.all([
      identitiesOf(pool, user.id),
      activeBan(pool, user.id),
      creditsOf(pool, user.id),
    ]);
    res.json(buildUserMe(user, identities, ban, credits));
  });

  // Sets the account username: a base the player picks plus a random
  // four-digit suffix, at most once every cooldown period.
  router.put(
    "/users/@me/username",
    express.json({ limit: "2kb" }),
    async (req, res) => {
      res.setHeader("Cache-Control", "no-store");
      const claims = await authenticate(req, deps);
      const user = claims === null ? null : await getUser(pool, claims.userId);
      if (claims === null || user === null || user.deletedAt !== null) {
        res.status(401).json({ error: "unauthorized" });
        return;
      }
      if (user.kind === "guest") {
        res.status(403).json({ code: "LOGIN_REQUIRED" });
        return;
      }
      if ((await activeBan(pool, user.id)) !== null) {
        res.status(403).json({ code: "BANNED" });
        return;
      }
      const body = PutUsernameBody.safeParse(req.body);
      if (!body.success) {
        res.status(400).json({
          code: "USERNAME_INVALID",
          reason: "A username is required",
        });
        return;
      }
      const verdict = checkUsernameBase(body.data.username);
      if (!verdict.ok) {
        res.status(400).json({ code: verdict.code, reason: verdict.reason });
        return;
      }
      for (let attempt = 0; attempt < 20; attempt++) {
        const discriminator = randomDiscriminator();
        try {
          // One statement checks the cooldown and sets the name, so two
          // requests at once cannot both pass.
          const { rows } = await pool.query<{
            next_username_change_at: Date;
          }>(
            `UPDATE users
                SET username_base = $2, username_discriminator = $3,
                    next_username_change_at = now() + make_interval(days => $4)
              WHERE id = $1 AND deleted_at IS NULL
                AND (next_username_change_at IS NULL OR next_username_change_at <= now())
          RETURNING next_username_change_at`,
            [
              user.id,
              verdict.base,
              discriminator,
              ACCOUNT_RULES.usernameChangeCooldownDays,
            ],
          );
          if (rows.length === 0) {
            const current = await getUser(pool, user.id);
            const next = current?.nextUsernameChangeAt ?? null;
            const wait =
              next === null
                ? 1
                : Math.max(1, Math.ceil((next.getTime() - Date.now()) / 1000));
            res.setHeader("Retry-After", String(wait));
            res.status(429).json({
              code: "USERNAME_COOLDOWN",
              nextUsernameChangeAt: next?.toISOString() ?? null,
            });
            return;
          }
          const response: PutUsernameResponse = {
            username: `${verdict.base}.${discriminator}`,
            base: verdict.base,
            discriminator,
            usernameStatus: "unclaimed",
            nextUsernameChangeAt: rows[0].next_username_change_at.toISOString(),
          };
          res.json(response);
          return;
        } catch (error) {
          // base + suffix already taken: draw another suffix.
          if ((error as { code?: string }).code === "23505") continue;
          throw error;
        }
      }
      res.status(409).json({ code: "USERNAME_TAKEN" });
    },
  );

  // Queues the account for deletion (it runs after the delay, see
  // domain/lifecycle.ts) and signs every session out. Authenticated by the
  // refresh cookie, hence the origin check.
  router.delete(
    "/users/@me",
    requireAllowedOrigin(config.allowedOrigins),
    async (req, res) => {
      res.setHeader("Cache-Control", "no-store");
      const verdict = limiters.accountDeletion.hit(clientIp(req));
      if (!verdict.allowed) {
        res.setHeader("Retry-After", String(verdict.retryAfterSeconds));
        res.status(429).json({ message: "Too many requests" });
        return;
      }
      const presented = parseCookies(req.headers.cookie)[REFRESH_COOKIE];
      const session = presented ? await liveSession(pool, presented) : null;
      const user =
        session === null ? null : await getUser(pool, session.userId);
      if (user === null || user.deletedAt !== null) {
        res.status(401).json({ error: "unauthorized" });
        return;
      }
      if (user.role !== null && STAFF_ROLES.has(user.role)) {
        res.status(403).json({
          message: "Staff accounts cannot be deleted from here",
        });
        return;
      }
      await pool.query(
        `UPDATE users SET deletion_requested_at = COALESCE(deletion_requested_at, now())
          WHERE id = $1`,
        [user.id],
      );
      await revokeAllForUser(pool, user.id, "account_deletion");
      res.append(
        "Set-Cookie",
        clearCookie(REFRESH_COOKIE, { secure: cookieSecure(config) }),
      );
      res.status(204).end();
    },
  );

  return router;
}
