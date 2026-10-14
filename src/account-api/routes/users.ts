import type {
  PutUsernameResponse,
  UserMeResponse,
} from "@openfront/shared/ApiSchemas";
import { staffRoleOf, type StaffRole } from "@openfront/shared/Permissions";
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
import { clansOfUser, type MyClan } from "../repo/clans";
import { activeFlaresOf, reportedFlares } from "../repo/inventory";
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
 * its Credits balance and, once the catalog is in use, the cosmetics it owns
 * (`flares`). Everything that belongs to a later milestone (clans, friends,
 * progression, premium currency) is left out, or
 * empty where the schema insists on a value, so the client keeps those
 * screens hidden.
 */
export function buildUserMe(
  user: UserRow,
  identities: IdentityRow[],
  ban: ActiveBan | null,
  credits: number,
  /** The cosmetics the account owns; absent while no feature uses the catalog. */
  flares?: string[],
  /** The account's clan memberships and pending requests; absent while clans are off. */
  clans?: {
    clans: MyClan[];
    requests: Array<{ tag: string; name: string; createdAt: string }>;
  },
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
      // Decided by the database alone (admin CLI user:verify); the game server
      // reads it from here at join (resolveVerifiedJoin).
      verified: user.verified,
      ...(staffRoleOf(user.role) === null
        ? {}
        : { staffRole: staffRoleOf(user.role) as StaffRole }),
      bareUsernameEnabled: user.bareUsernameEnabled,
      nextUsernameChangeAt: user.nextUsernameChangeAt?.toISOString() ?? null,
      // Credits ride in the contract's "soft" slot; the premium slot stays 0.
      currency: { soft: credits, hard: 0 },
      ...(flares === undefined ? {} : { flares }),
      ...(clans === undefined
        ? {}
        : { clans: clans.clans, clanRequests: clans.requests }),
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
    const [identities, ban, credits, owned, clans] = await Promise.all([
      identitiesOf(pool, user.id),
      activeBan(pool, user.id),
      creditsOf(pool, user.id),
      deps.catalog === null ? undefined : activeFlaresOf(pool, user.id),
      config.features.clans ? clansOfUser(pool, user.id) : undefined,
    ]);
    const flares =
      deps.catalog === null || owned === undefined
        ? undefined
        : reportedFlares(deps.catalog, owned);
    res.json(buildUserMe(user, identities, ban, credits, flares, clans));
  });

  // Sets the account username, at most once every cooldown period: a base the
  // player picks plus a random four-digit suffix, or, for an account the
  // operator entitled to one (users.bare_username_enabled), the bare name.
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
      // Counted once the name is valid: typos are not attempts.
      const limit = limiters.usernameChange.hit(user.id);
      if (!limit.allowed) {
        res.setHeader("Retry-After", String(limit.retryAfterSeconds));
        res.status(429).json({ code: "RATE_LIMITED" });
        return;
      }
      // The 429 for a rename inside the cooldown (two requests at once, or a
      // rename on another device).
      const rejectCooldown = async (): Promise<void> => {
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
      };

      // "unavailable" is the one bareClaim value a client must announce: an
      // entitled account was given the numbered form because the bare name is
      // held by someone else.
      let bareClaim: PutUsernameResponse["bareClaim"] = "not_eligible";

      // An account the operator entitled to a bare name gets one: the name as
      // typed, no discriminator, unique among bare names (case-insensitively).
      // The entitlement is re-checked inside the UPDATE, so a revoke that lands
      // between the read above and this write cannot be raced.
      if (user.bareUsernameEnabled) {
        try {
          const { rows } = await pool.query<{
            next_username_change_at: Date;
          }>(
            `UPDATE users
                SET username_base = $2, username_discriminator = NULL,
                    next_username_change_at = now() + make_interval(days => $3)
              WHERE id = $1 AND deleted_at IS NULL AND bare_username_enabled
                AND (next_username_change_at IS NULL OR next_username_change_at <= now())
          RETURNING next_username_change_at`,
            [user.id, verdict.base, ACCOUNT_RULES.usernameChangeCooldownDays],
          );
          if (rows.length > 0) {
            const response: PutUsernameResponse = {
              username: verdict.base,
              base: verdict.base,
              discriminator: null,
              usernameStatus: "unclaimed",
              nextUsernameChangeAt:
                rows[0].next_username_change_at.toISOString(),
              bareClaim: "claimed",
            };
            res.json(response);
            return;
          }
          // Nothing written: still cooling down, or the entitlement was just
          // withdrawn (then this is an ordinary rename below).
          if ((await getUser(pool, user.id))?.bareUsernameEnabled === true) {
            await rejectCooldown();
            return;
          }
        } catch (error) {
          const e = error as { code?: string; constraint?: string };
          if (
            e.code !== "23505" ||
            e.constraint !== "users_bare_username_unique"
          )
            throw error;
          // Another account holds this bare name. Nothing is taken from them:
          // ask first (the client's existing dialog), or give the numbered form
          // when the client already said yes.
          if (body.data.acceptSuffixed !== true) {
            res
              .status(409)
              .json({ code: "BARE_NAME_TAKEN", base: verdict.base });
            return;
          }
          bareClaim = "unavailable";
        }
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
            await rejectCooldown();
            return;
          }
          const response: PutUsernameResponse = {
            username: `${verdict.base}.${discriminator}`,
            base: verdict.base,
            discriminator,
            usernameStatus: "unclaimed",
            nextUsernameChangeAt: rows[0].next_username_change_at.toISOString(),
            bareClaim,
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
      // A ban is not escaped by deleting the account (the sign-in identities
      // would go and the player could return as someone new): the request waits
      // until the ban ends.
      if ((await activeBan(pool, user.id)) !== null) {
        res.status(403).json({
          message:
            "An account with an active ban cannot be deleted until the ban ends",
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
