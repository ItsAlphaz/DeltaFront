import {
  AdminActionResultSchema,
  MODERATION_AUDIT_ACTIONS,
  type AdminAuditEntry,
  type AdminClanDetail,
  type AdminDashboard,
  type AdminUserDetail,
} from "@openfront/shared/AdminSchemas";
import {
  canActOnTarget,
  canChangeRole,
  hasPermission,
  permissionsOf,
  staffRoleOf,
  type Permission,
  type StaffRole,
} from "@openfront/shared/Permissions";
import type { Request, Response, Router } from "express";
import express from "express";
import { z } from "zod";
import { getBuildInfo } from "../buildInfo";
import { hasFlareShape, isWildcardFlare } from "../catalog/flares";
import { withTransaction } from "../db/tx";
import {
  AdminOpError,
  adjustCredits,
  banUser,
  grantItem,
  revokeItem,
  revokeSessions,
  setBareNameEntitlement,
  setRole,
  setVerified,
  unbanUser,
  writeAudit,
  type AuditContext,
} from "../domain/adminOps";
import * as clanOps from "../domain/clanOps";
import { ClanError } from "../domain/clanOps";
import { tagFromRoute } from "../domain/clans";
import { ACCOUNT_RULES } from "../domain/constants";
import { displayUsername } from "../domain/usernames";
import type { Readiness } from "../readiness";
import { clanByTag, clansOfUser } from "../repo/clans";
import { flareRowsOf } from "../repo/inventory";
import {
  activeBan,
  getUser,
  getUserByPublicId,
  type UserRow,
} from "../repo/users";
import { authenticate, jsonBody, type AppDeps } from "./common";

/**
 * The `/admin` API behind the web admin panel.
 *
 * Authorization is decided HERE, on every request, and nowhere else:
 *  - the bearer token must be valid and its session live (so a revoked session
 *    loses access at once, as everywhere else in this API);
 *  - the account's role is READ FROM THE DATABASE on each request, never from a
 *    token claim or from anything the client sends, so a demotion or a ban takes
 *    effect immediately;
 *  - then `hasPermission(role, permission)` (Permissions.ts, the one authority)
 *    must hold, else 403. No token or a bad one is 401. The panel hiding a
 *    button changes nothing here.
 *
 * Browsers authenticate with the Authorization header, not a cookie, so these
 * routes are not reachable by a cross-site form post (no CSRF surface); CORS
 * still limits readers to the allowed origins. Every change is one transaction
 * that also writes its audit row, takes a mandatory reason, and (when
 * destructive) an explicit `confirm: true`. Responses never carry a secret.
 */

const PUBLIC_ID = /^[A-Za-z0-9]{6,32}$/;

const Reason = z.string().trim().min(1).max(200);
const Confirm = z.boolean().optional();

interface Staff {
  user: UserRow;
  role: StaffRole;
  ctx: AuditContext;
}

type Handler<B> = (
  staff: Staff,
  body: B,
  req: Request,
  res: Response,
) => Promise<void>;

const ok = (message: string, changed?: boolean) =>
  AdminActionResultSchema.parse({ ok: true, message, changed });

const iso = (d: Date) => d.toISOString();

/** Keys never shown in an audit entry's details, whatever a writer put there. */
const SECRET_KEY =
  /token|secret|password|passwd|api[_-]?key|authorization|cookie/i;
function scrub(value: unknown, depth = 0): unknown {
  if (depth > 4 || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((v) => scrub(v, depth + 1));
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([k, v]) => [
      k,
      SECRET_KEY.test(k) ? "[redacted]" : scrub(v, depth + 1),
    ]),
  );
}

export function adminRouter(deps: AppDeps, readiness?: Readiness): Router {
  const { pool, limiters } = deps;
  const router = express.Router();
  const startedAt = Date.now();

  /** The acting staff account, or a response has been sent. */
  async function authorize(
    req: Request,
    res: Response,
    permission: Permission,
    kind: "read" | "write",
  ): Promise<Staff | null> {
    res.setHeader("Cache-Control", "no-store");
    const claims = await authenticate(req, deps);
    const user = claims === null ? null : await getUser(pool, claims.userId);
    if (
      user === null ||
      user.deletedAt !== null ||
      user.deletionRequestedAt !== null
    ) {
      res.status(401).json({ error: "unauthorized" });
      return null;
    }
    const role = staffRoleOf(user.role);
    if (role === null || !hasPermission(user.role, permission)) {
      res.status(403).json({ error: "forbidden" });
      return null;
    }
    if ((await activeBan(pool, user.id)) !== null) {
      res.status(403).json({ error: "forbidden" });
      return null;
    }
    const verdict = (
      kind === "read" ? limiters.adminRead : limiters.adminWrite
    ).hit(user.id);
    if (!verdict.allowed) {
      res.setHeader("Retry-After", String(verdict.retryAfterSeconds));
      res.status(429).json({ error: "rate_limited" });
      return null;
    }
    return {
      user,
      role,
      ctx: {
        actor: user.publicId,
        source: "web",
        actorUserId: user.id,
        actorRole: role,
      },
    };
  }

  /** One route: authorize, validate the body, run, and map failures to answers. */
  function route<B>(
    permission: Permission,
    kind: "read" | "write",
    schema: z.ZodType<B> | null,
    handler: Handler<B>,
  ) {
    return async (req: Request, res: Response): Promise<void> => {
      try {
        const staff = await authorize(req, res, permission, kind);
        if (staff === null) return;
        let body = undefined as B;
        if (schema !== null) {
          const parsed = schema.safeParse(req.body ?? {});
          if (!parsed.success) {
            res.status(400).json({
              error: "invalid_request",
              message: z.prettifyError(parsed.error),
            });
            return;
          }
          body = parsed.data;
        }
        await handler(staff, body, req, res);
      } catch (error) {
        if (error instanceof AdminOpError) {
          res
            .status(error.status)
            .json({ error: error.code, message: error.message });
          return;
        }
        if (error instanceof ClanError) {
          res
            .status(error.status)
            .json({ error: String(error.body.code ?? "refused") });
          return;
        }
        deps.log.error("admin route failed", {
          path: req.path,
          error: error instanceof Error ? error.message : String(error),
        });
        res.status(500).json({ error: "internal_error" });
      }
    };
  }

  const confirmed = (res: Response, confirm: boolean | undefined): boolean => {
    if (confirm === true) return true;
    res.status(400).json({
      error: "CONFIRMATION_REQUIRED",
      message: "this is destructive: repeat the request with confirm: true",
    });
    return false;
  };

  /** The account in the URL, or a 404 has been sent. */
  async function targetOf(
    req: Request,
    res: Response,
  ): Promise<UserRow | null> {
    const id = String(req.params.publicId);
    const user = PUBLIC_ID.test(id) ? await getUserByPublicId(pool, id) : null;
    if (user === null) {
      res.status(404).json({ error: "NOT_FOUND" });
      return null;
    }
    return user;
  }

  /** Whether the actor may take a moderation action on the target (never on oneself). */
  function mayActOn(
    staff: Staff,
    target: UserRow,
    res: Response,
    allowSelf = false,
  ): boolean {
    if (target.id === staff.user.id) {
      if (allowSelf) return true;
      res.status(403).json({
        error: "SELF_ACTION",
        message: "you cannot do this to your own account",
      });
      return false;
    }
    if (!canActOnTarget(staff.user.role, target.role)) {
      res.status(403).json({
        error: "TARGET_PROTECTED",
        message: "that account's role is equal to or above yours",
      });
      return false;
    }
    return true;
  }

  // ------------------------------------------------------------------- me

  router.get(
    "/admin/me",
    route("admin.panel.view", "read", null, async (staff, _b, _req, res) => {
      res.json({
        publicId: staff.user.publicId,
        role: staff.role,
        permissions: permissionsOf(staff.user.role),
      });
    }),
  );

  // ------------------------------------------------------------ dashboard

  router.get(
    "/admin/dashboard",
    route(
      "admin.dashboard.view",
      "read",
      null,
      async (_staff, _b, _req, res) => {
        const [counts, recent, bans, servers, health] = await Promise.all([
          pool.query<Record<string, number>>(
            `SELECT
               (SELECT count(*)::int FROM users WHERE kind = 'registered' AND deleted_at IS NULL) AS registered,
               (SELECT count(*)::int FROM users WHERE kind = 'guest' AND deleted_at IS NULL) AS guests,
               (SELECT count(*)::int FROM users WHERE created_at > now() - interval '24 hours') AS new24,
               (SELECT count(*)::int FROM users WHERE created_at > now() - interval '7 days') AS new7,
               (SELECT count(*)::int FROM users WHERE last_seen_at > now() - interval '5 minutes') AS active5,
               (SELECT COALESCE(sum(live_games), 0)::int FROM game_servers WHERE last_checkin_at > now() - interval '60 seconds') AS live_games,
               (SELECT count(*)::int FROM bans WHERE revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())) AS active_bans,
               (SELECT count(*)::int FROM clans WHERE disbanded_at IS NULL) AS clans`,
          ),
          pool.query<{
            public_id: string;
            kind: "guest" | "registered";
            role: string | null;
            verified: boolean;
            username_base: string | null;
            username_discriminator: string | null;
            created_at: Date;
          }>(
            `SELECT public_id, kind, role, verified, username_base::text AS username_base,
                    username_discriminator, created_at
               FROM users WHERE deleted_at IS NULL ORDER BY created_at DESC LIMIT 10`,
          ),
          pool.query<{
            public_id: string;
            username_base: string | null;
            username_discriminator: string | null;
            category: string;
            reason: string | null;
            created_at: Date;
            expires_at: Date | null;
          }>(
            `SELECT u.public_id, u.username_base::text AS username_base, u.username_discriminator,
                    b.category, b.reason, b.created_at, b.expires_at
               FROM bans b JOIN users u ON u.id = b.user_id
              ORDER BY b.created_at DESC LIMIT 10`,
          ),
          pool.query<{
            site: string;
            letter: string;
            version: string;
            num_workers: number;
            live_games: number;
            state: string;
            last_checkin_at: Date;
          }>(
            "SELECT site, letter, version, num_workers, live_games, state, last_checkin_at FROM game_servers ORDER BY site, letter",
          ),
          readiness?.check() ?? Promise.resolve(null),
        ]);
        const c = counts.rows[0];
        const build = getBuildInfo();
        const body: AdminDashboard = {
          version: build.version,
          commit: build.commit,
          uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
          health: {
            database: health?.checks.database === "fail" ? "error" : "ok",
            migrations: health?.checks.migrations === "fail" ? "pending" : "ok",
            signingKey: health?.checks.signingKey === "fail" ? "error" : "ok",
          },
          counts: {
            registeredUsers: c.registered,
            guests: c.guests,
            newUsers24h: c.new24,
            newUsers7d: c.new7,
            activeAccounts5m: c.active5,
            liveGames: c.live_games,
            activeBans: c.active_bans,
            clans: c.clans,
          },
          recentRegistrations: recent.rows.map((r) => ({
            publicId: r.public_id,
            username: displayUsername(
              r.username_base,
              r.username_discriminator,
            ),
            kind: r.kind,
            role: r.role,
            verified: r.verified,
            createdAt: iso(r.created_at),
          })),
          recentBans: bans.rows.map((r) => ({
            publicId: r.public_id,
            username: displayUsername(
              r.username_base,
              r.username_discriminator,
            ),
            category: r.category,
            reason: r.reason,
            createdAt: iso(r.created_at),
            expiresAt: r.expires_at === null ? null : iso(r.expires_at),
          })),
          servers: servers.rows.map((r) => ({
            site: r.site,
            letter: r.letter,
            version: r.version,
            numWorkers: r.num_workers,
            liveGames: r.live_games,
            state: r.state,
            lastCheckinAt: iso(r.last_checkin_at),
            online: Date.now() - r.last_checkin_at.getTime() < 60_000,
          })),
        };
        res.json(body);
      },
    ),
  );

  // ---------------------------------------------------------------- users

  router.get(
    "/admin/users",
    route("admin.users.view", "read", null, async (staff, _b, req, res) => {
      const q = String(req.query.q ?? "")
        .trim()
        .slice(0, 64);
      const canEmail = hasPermission(staff.user.role, "admin.users.view_email");
      const like = `%${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
      const { rows } = await pool.query<{
        public_id: string;
        kind: "guest" | "registered";
        role: string | null;
        verified: boolean;
        username_base: string | null;
        username_discriminator: string | null;
        created_at: Date;
        last_seen_at: Date;
        banned: boolean;
      }>(
        `SELECT u.public_id, u.kind, u.role, u.verified, u.username_base::text AS username_base,
                u.username_discriminator, u.created_at, u.last_seen_at,
                EXISTS (SELECT 1 FROM bans b WHERE b.user_id = u.id AND b.revoked_at IS NULL
                          AND (b.expires_at IS NULL OR b.expires_at > now())) AS banned
           FROM users u
          WHERE u.deleted_at IS NULL AND (
                $1 = ''
             OR u.public_id = $1
             OR u.id::text = $1
             OR u.username_base::text ILIKE $2
             OR EXISTS (SELECT 1 FROM auth_identities i WHERE i.user_id = u.id
                          AND (i.provider_user_id = $1 OR ($3 AND i.email = $1))))
          ORDER BY u.created_at DESC LIMIT 25`,
        [q, like, canEmail],
      );
      res.json({
        users: rows.map((r) => ({
          publicId: r.public_id,
          username: displayUsername(r.username_base, r.username_discriminator),
          kind: r.kind,
          role: r.role,
          verified: r.verified,
          createdAt: iso(r.created_at),
          lastSeenAt: iso(r.last_seen_at),
          banned: r.banned,
        })),
      });
    }),
  );

  router.get(
    "/admin/users/:publicId",
    route("admin.users.view", "read", null, async (staff, _b, req, res) => {
      const user = await targetOf(req, res);
      if (user === null) return;
      const canEmail = hasPermission(staff.user.role, "admin.users.view_email");
      const [wallet, sessions, identities, flares, myClans, bans, seen] =
        await Promise.all([
          pool.query<{ credits: string }>(
            "SELECT credits::text AS credits FROM wallets WHERE user_id = $1",
            [user.id],
          ),
          pool.query<{ n: number }>(
            "SELECT count(*)::int AS n FROM refresh_sessions WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > now()",
            [user.id],
          ),
          pool.query<{
            provider: string;
            provider_user_id: string;
            email: string | null;
            created_at: Date;
          }>(
            "SELECT provider, provider_user_id, email, created_at FROM auth_identities WHERE user_id = $1 ORDER BY id",
            [user.id],
          ),
          flareRowsOf(pool, user.id),
          clansOfUser(pool, user.id),
          pool.query<{
            category: string;
            reason: string | null;
            created_at: Date;
            expires_at: Date | null;
            revoked_at: Date | null;
          }>(
            "SELECT category, reason, created_at, expires_at, revoked_at FROM bans WHERE user_id = $1 ORDER BY created_at DESC LIMIT 20",
            [user.id],
          ),
          pool.query<{ last_seen_at: Date }>(
            "SELECT last_seen_at FROM users WHERE id = $1",
            [user.id],
          ),
        ]);
      const now = Date.now();
      const body: AdminUserDetail = {
        id: user.id,
        publicId: user.publicId,
        username: displayUsername(
          user.usernameBase,
          user.usernameDiscriminator,
        ),
        usernameBase: user.usernameBase,
        kind: user.kind,
        role: user.role,
        verified: user.verified,
        bareUsernameEnabled: user.bareUsernameEnabled,
        holdsBareName:
          user.usernameBase !== null && user.usernameDiscriminator === null,
        createdAt: iso(user.createdAt),
        lastSeenAt: iso(seen.rows[0].last_seen_at),
        deletionRequestedAt:
          user.deletionRequestedAt === null
            ? null
            : iso(user.deletionRequestedAt),
        credits: wallet.rows[0]?.credits ?? "0",
        liveSessions: sessions.rows[0].n,
        identities: identities.rows.map((i) => ({
          provider: i.provider,
          providerUserId: i.provider_user_id,
          ...(canEmail ? { email: i.email } : {}),
          createdAt: iso(i.created_at),
        })),
        items: flares.map((f) => ({
          flare: f.flare,
          source: f.source,
          grantedAt: iso(f.grantedAt),
          revokedAt: f.revokedAt === null ? null : iso(f.revokedAt),
        })),
        clans: myClans.clans.map((c) => ({
          tag: c.tag,
          name: c.name,
          role: c.role,
        })),
        bans: bans.rows.map((b) => ({
          category: b.category,
          reason: b.reason,
          createdAt: iso(b.created_at),
          expiresAt: b.expires_at === null ? null : iso(b.expires_at),
          revokedAt: b.revoked_at === null ? null : iso(b.revoked_at),
          active:
            b.revoked_at === null &&
            (b.expires_at === null || b.expires_at.getTime() > now),
        })),
      };
      res.json(body);
    }),
  );

  router.post(
    "/admin/users/:publicId/verified",
    jsonBody("4kb"),
    route(
      "admin.users.verify",
      "write",
      z.object({ verified: z.boolean(), reason: Reason }),
      async (staff, body, req, res) => {
        const user = await targetOf(req, res);
        if (user === null) return;
        const changed = await withTransaction(pool, (db) =>
          setVerified(db, staff.ctx, user.publicId, body.verified, body.reason),
        );
        res.json(
          ok(
            changed
              ? `${user.publicId} is now ${body.verified ? "verified" : "unverified"}`
              : `no change: already ${body.verified ? "verified" : "unverified"}`,
            changed,
          ),
        );
      },
    ),
  );

  router.post(
    "/admin/users/:publicId/bare-name",
    jsonBody("4kb"),
    route(
      "admin.users.bare_name",
      "write",
      z.object({ enabled: z.boolean(), reason: Reason }),
      async (staff, body, req, res) => {
        const user = await targetOf(req, res);
        if (user === null) return;
        const outcome = await withTransaction(pool, (db) =>
          setBareNameEntitlement(
            db,
            staff.ctx,
            user.publicId,
            body.enabled,
            body.reason,
          ),
        );
        res.json(
          ok(
            outcome === null
              ? "no change"
              : body.enabled
                ? "may now claim a bare username"
                : outcome.holdsBare
                  ? `may no longer claim one; keeps holding "${outcome.name}" until they rename`
                  : "may no longer claim a bare username",
            outcome !== null,
          ),
        );
      },
    ),
  );

  router.post(
    "/admin/users/:publicId/role",
    jsonBody("4kb"),
    route(
      "admin.users.role",
      "write",
      z.object({
        role: z.enum(["admin", "mod", "flagged", "none"]),
        reason: Reason,
        confirm: Confirm,
      }),
      async (staff, body, req, res) => {
        const user = await targetOf(req, res);
        if (user === null) return;
        const verdict = canChangeRole({
          actorRole: staff.user.role,
          actorPublicId: staff.user.publicId,
          targetPublicId: user.publicId,
          current: user.role,
          next: body.role,
        });
        if (!verdict.ok) {
          res.status(403).json({ error: verdict.code });
          return;
        }
        if (!confirmed(res, body.confirm)) return;
        const result = await withTransaction(pool, (db) =>
          setRole(db, staff.ctx, user.publicId, body.role, body.reason),
        );
        res.json(
          ok(
            result === null
              ? "no change"
              : `role changed from ${result.from} to ${body.role}`,
            result !== null,
          ),
        );
      },
    ),
  );

  router.post(
    "/admin/users/:publicId/credits",
    jsonBody("4kb"),
    route(
      "admin.wallet.grant",
      "write",
      z.object({
        amount: z
          .number()
          .int()
          .refine((n) => n !== 0, "amount must not be zero")
          .refine(
            (n) => Math.abs(n) <= ACCOUNT_RULES.adminMaxCreditsPerCommand,
            "amount is above the per-command limit",
          ),
        reason: Reason,
        confirm: Confirm,
      }),
      async (staff, body, req, res) => {
        const user = await targetOf(req, res);
        if (user === null) return;
        if (body.amount < 0 && !confirmed(res, body.confirm)) return;
        const result = await withTransaction(pool, (db) =>
          adjustCredits(db, staff.ctx, user.publicId, body.amount, body.reason),
        );
        res.json(
          ok(
            `${body.amount > 0 ? "granted" : "deducted"} ${Math.abs(body.amount)} Credits: ${result.before} -> ${result.after}`,
            true,
          ),
        );
      },
    ),
  );

  router.post(
    "/admin/users/:publicId/items",
    jsonBody("4kb"),
    route(
      "admin.inventory.grant",
      "write",
      z.object({
        flare: z
          .string()
          .max(120)
          .refine((f) => !isWildcardFlare(f), "wildcards are not allowed")
          .refine(hasFlareShape, "not a flare"),
        grant: z.boolean(),
        reason: Reason,
        confirm: Confirm,
      }),
      async (staff, body, req, res) => {
        const user = await targetOf(req, res);
        if (user === null) return;
        const catalog = deps.catalog;
        if (catalog === null) {
          res.status(409).json({ error: "CATALOG_UNAVAILABLE" });
          return;
        }
        if (!body.grant && !confirmed(res, body.confirm)) return;
        const result = await withTransaction(pool, (db) =>
          body.grant
            ? grantItem(db, staff.ctx, catalog, user.publicId, body.flare)
            : revokeItem(
                db,
                staff.ctx,
                catalog,
                user.publicId,
                body.flare,
                body.reason,
              ),
        );
        res.json(
          ok(
            `${body.flare}: ${result.replace("_", " ")}`,
            result !== "already_owned" && result !== "not_owned",
          ),
        );
      },
    ),
  );

  router.post(
    "/admin/users/:publicId/ban",
    jsonBody("4kb"),
    route(
      "admin.users.ban",
      "write",
      z.object({
        category: z.string().trim().min(1).max(40),
        reason: Reason,
        days: z.number().int().min(1).max(36500).nullable().optional(),
        confirm: Confirm,
      }),
      async (staff, body, req, res) => {
        const user = await targetOf(req, res);
        if (user === null || !mayActOn(staff, user, res)) return;
        if (!confirmed(res, body.confirm)) return;
        const result = await withTransaction(pool, (db) =>
          banUser(db, staff.ctx, user.publicId, {
            category: body.category,
            reason: body.reason,
            days: body.days ?? null,
          }),
        );
        res.json(
          ok(`banned; ${result.sessionsRevoked} session(s) revoked`, true),
        );
      },
    ),
  );

  router.post(
    "/admin/users/:publicId/unban",
    jsonBody("4kb"),
    route(
      "admin.users.ban",
      "write",
      z.object({ reason: Reason }),
      async (staff, body, req, res) => {
        const user = await targetOf(req, res);
        if (user === null || !mayActOn(staff, user, res)) return;
        const lifted = await withTransaction(pool, (db) =>
          unbanUser(db, staff.ctx, user.publicId, body.reason),
        );
        res.json(ok(`${lifted} ban(s) lifted`, lifted > 0));
      },
    ),
  );

  router.post(
    "/admin/users/:publicId/revoke-sessions",
    jsonBody("4kb"),
    route(
      "admin.users.sessions",
      "write",
      z.object({ reason: Reason, confirm: Confirm }),
      async (staff, body, req, res) => {
        const user = await targetOf(req, res);
        if (user === null || !mayActOn(staff, user, res)) return;
        if (!confirmed(res, body.confirm)) return;
        const n = await withTransaction(pool, (db) =>
          revokeSessions(db, staff.ctx, user.publicId, body.reason),
        );
        res.json(ok(`${n} session(s) revoked`, n > 0));
      },
    ),
  );

  router.get(
    "/admin/users/:publicId/audit",
    route(
      "admin.audit.view_moderation",
      "read",
      null,
      async (staff, _b, req, res) => {
        const user = await targetOf(req, res);
        if (user === null) return;
        res.json(await auditPage(staff, { target: user.publicId, limit: 50 }));
      },
    ),
  );

  // ---------------------------------------------------------------- clans

  router.get(
    "/admin/clans",
    route("admin.clans.view", "read", null, async (_staff, _b, req, res) => {
      const q = String(req.query.q ?? "")
        .trim()
        .slice(0, 40)
        .toLowerCase();
      const { rows } = await pool.query<{
        tag: string;
        name: string;
        is_open: boolean;
        members: number;
        created_at: Date;
      }>(
        `SELECT c.tag::text AS tag, c.name::text AS name, c.is_open, c.created_at,
                (SELECT count(*)::int FROM clan_members m WHERE m.clan_id = c.id) AS members
           FROM clans c
          WHERE c.disbanded_at IS NULL
            AND ($1 = '' OR lower(c.tag::text) = $1 OR lower(c.name::text) LIKE '%' || $2 || '%')
          ORDER BY c.created_at DESC LIMIT 50`,
        [q, q.replace(/[\\%_]/g, "")],
      );
      res.json({
        clans: rows.map((r) => ({
          tag: r.tag,
          name: r.name,
          isOpen: r.is_open,
          members: r.members,
          createdAt: iso(r.created_at),
        })),
      });
    }),
  );

  router.get(
    "/admin/clans/:tag",
    route("admin.clans.view", "read", null, async (_staff, _b, req, res) => {
      const tag = tagFromRoute(String(req.params.tag));
      const clan = tag === null ? null : await clanByTag(pool, tag);
      if (clan === null) {
        res.status(404).json({ error: "CLAN_NOT_FOUND" });
        return;
      }
      const [members, requests, bans, events] = await Promise.all([
        pool.query<{
          public_id: string;
          role: string;
          joined_at: Date;
          verified: boolean;
          urole: string | null;
          username_base: string | null;
          username_discriminator: string | null;
        }>(
          `SELECT u.public_id, m.role, m.joined_at, u.verified, u.role AS urole,
                  u.username_base::text AS username_base, u.username_discriminator
             FROM clan_members m JOIN users u ON u.id = m.user_id
            WHERE m.clan_id = $1
            ORDER BY (m.role = 'leader') DESC, (m.role = 'officer') DESC, m.joined_at`,
          [clan.id],
        ),
        pool.query<{ n: number }>(
          "SELECT count(*)::int AS n FROM clan_join_requests WHERE clan_id = $1",
          [clan.id],
        ),
        pool.query<{
          public_id: string;
          reason: string | null;
          created_at: Date;
          username_base: string | null;
          username_discriminator: string | null;
        }>(
          `SELECT u.public_id, x.reason, x.created_at, u.username_base::text AS username_base, u.username_discriminator
             FROM clan_bans x JOIN users u ON u.id = x.user_id
            WHERE x.clan_id = $1 ORDER BY x.created_at DESC LIMIT 50`,
          [clan.id],
        ),
        pool.query<{ action: string; created_at: Date }>(
          "SELECT action, created_at FROM clan_events WHERE clan_id = $1 ORDER BY id DESC LIMIT 15",
          [clan.id],
        ),
      ]);
      const body: AdminClanDetail = {
        tag: clan.tag,
        name: clan.name,
        isOpen: clan.isOpen,
        members: clan.memberCount,
        createdAt: iso(clan.createdAt),
        description: clan.description,
        pendingRequests: requests.rows[0].n,
        bans: bans.rows.map((b) => ({
          publicId: b.public_id,
          username: displayUsername(b.username_base, b.username_discriminator),
          reason: b.reason,
          createdAt: iso(b.created_at),
        })),
        membersList: members.rows.map((m) => ({
          publicId: m.public_id,
          username: displayUsername(m.username_base, m.username_discriminator),
          role: m.role,
          verified: m.verified,
          staffRole: staffRoleOf(m.urole),
          joinedAt: iso(m.joined_at),
        })),
        events: events.rows.map((e) => ({
          action: e.action,
          createdAt: iso(e.created_at),
        })),
      };
      res.json(body);
    }),
  );

  const clanAudit =
    (staff: Staff, action: string, tag: string, details: object) =>
    async (tx: Parameters<typeof writeAudit>[0]) => {
      await writeAudit(tx, staff.ctx, action, "clan", tag, { ...details });
    };

  const tagParam = (req: Request, res: Response): string | null => {
    const tag = tagFromRoute(String(req.params.tag));
    if (tag === null) {
      res.status(404).json({ error: "CLAN_NOT_FOUND" });
      return null;
    }
    return tag;
  };

  router.post(
    "/admin/clans",
    jsonBody("4kb"),
    route(
      "admin.clans.official",
      "write",
      z.object({
        name: z.string().max(80),
        tag: z.string().max(12),
        description: z.string().max(500).optional(),
        isOpen: z.boolean().optional(),
        reason: Reason,
      }),
      async (staff, body, _req, res) => {
        // The creator becomes the leader (hand it over with the transfer action).
        // Official clans skip the thresholds and may use reserved tags and
        // names; no match history is invented.
        const tag = await clanOps.createClan(
          pool,
          { id: staff.user.id, createdAt: staff.user.createdAt },
          {
            name: body.name,
            tag: body.tag,
            description: body.description,
            isOpen: body.isOpen,
          },
          deps.reserved,
          undefined,
          { bypassEligibility: true, bypassReserved: true },
        );
        await withTransaction(pool, (db) =>
          writeAudit(db, staff.ctx, "clan:create-official", "clan", tag, {
            name: body.name,
            reason: body.reason,
          }),
        );
        res.status(201).json(ok(`created ${tag}`, true));
      },
    ),
  );

  router.post(
    "/admin/clans/:tag/rename",
    jsonBody("4kb"),
    route(
      "admin.clans.manage",
      "write",
      z.object({ name: z.string().max(80), reason: Reason }),
      async (staff, body, req, res) => {
        const tag = tagParam(req, res);
        if (tag === null) return;
        await clanOps.adminRenameClan(
          pool,
          tag,
          body.name,
          body.reason,
          deps.reserved,
          clanAudit(staff, "clan:rename", tag, {
            name: body.name,
            reason: body.reason,
          }),
        );
        res.json(ok(`${tag} renamed`, true));
      },
    ),
  );

  router.post(
    "/admin/clans/:tag/tag",
    jsonBody("4kb"),
    route(
      "admin.clans.manage",
      "write",
      z.object({ tag: z.string().max(12), reason: Reason }),
      async (staff, body, req, res) => {
        const tag = tagParam(req, res);
        if (tag === null) return;
        const next = await clanOps.adminChangeTag(
          pool,
          tag,
          body.tag,
          body.reason,
          deps.reserved,
          {
            bypassReserved: hasPermission(
              staff.user.role,
              "admin.clans.official",
            ),
          },
          clanAudit(staff, "clan:retag", tag, {
            to: body.tag,
            reason: body.reason,
          }),
        );
        res.json(ok(`${tag} is now ${next}`, true));
      },
    ),
  );

  router.post(
    "/admin/clans/:tag/open",
    jsonBody("4kb"),
    route(
      "admin.clans.manage",
      "write",
      z.object({ isOpen: z.boolean(), reason: Reason }),
      async (staff, body, req, res) => {
        const tag = tagParam(req, res);
        if (tag === null) return;
        await clanOps.adminSetOpen(
          pool,
          tag,
          body.isOpen,
          body.reason,
          clanAudit(staff, "clan:set-open", tag, {
            isOpen: body.isOpen,
            reason: body.reason,
          }),
        );
        res.json(ok(`${tag} is now ${body.isOpen ? "open" : "closed"}`, true));
      },
    ),
  );

  router.post(
    "/admin/clans/:tag/transfer",
    jsonBody("4kb"),
    route(
      "admin.clans.manage",
      "write",
      z.object({
        targetPublicId: z.string().regex(PUBLIC_ID),
        reason: Reason,
        confirm: Confirm,
      }),
      async (staff, body, req, res) => {
        const tag = tagParam(req, res);
        if (tag === null || !confirmed(res, body.confirm)) return;
        await clanOps.adminTransferClan(
          pool,
          tag,
          body.targetPublicId,
          body.reason,
          clanAudit(staff, "clan:transfer", tag, {
            target: body.targetPublicId,
            reason: body.reason,
          }),
        );
        res.json(ok(`${tag} is now led by ${body.targetPublicId}`, true));
      },
    ),
  );

  router.post(
    "/admin/clans/:tag/members/:publicId/remove",
    jsonBody("4kb"),
    route(
      "admin.clans.manage",
      "write",
      z.object({ reason: Reason, confirm: Confirm }),
      async (staff, body, req, res) => {
        const tag = tagParam(req, res);
        if (tag === null || !confirmed(res, body.confirm)) return;
        const target = String(req.params.publicId);
        await clanOps.adminRemoveMember(
          pool,
          tag,
          target,
          body.reason,
          clanAudit(staff, "clan:member-remove", tag, {
            target,
            reason: body.reason,
          }),
        );
        res.json(ok(`${target} removed from ${tag}`, true));
      },
    ),
  );

  router.post(
    "/admin/clans/:tag/bans/:publicId",
    jsonBody("4kb"),
    route(
      "admin.clans.manage",
      "write",
      z.object({ ban: z.boolean(), reason: Reason, confirm: Confirm }),
      async (staff, body, req, res) => {
        const tag = tagParam(req, res);
        if (tag === null) return;
        const target = String(req.params.publicId);
        if (body.ban) {
          if (!confirmed(res, body.confirm)) return;
          await clanOps.adminBanMember(
            pool,
            tag,
            target,
            body.reason,
            clanAudit(staff, "clan:ban", tag, { target, reason: body.reason }),
          );
          res.json(ok(`${target} banned from ${tag}`, true));
        } else {
          await clanOps.adminUnbanMember(
            pool,
            tag,
            target,
            body.reason,
            clanAudit(staff, "clan:unban", tag, {
              target,
              reason: body.reason,
            }),
          );
          res.json(ok(`${target} may join ${tag} again`, true));
        }
      },
    ),
  );

  router.post(
    "/admin/clans/:tag/delete",
    jsonBody("4kb"),
    route(
      "admin.clans.delete",
      "write",
      z.object({ reason: Reason, confirm: Confirm }),
      async (staff, body, req, res) => {
        const tag = tagParam(req, res);
        if (tag === null || !confirmed(res, body.confirm)) return;
        const clan = await clanOps.adminRemoveClan(
          pool,
          tag,
          body.reason,
          (tx, c) =>
            clanAudit(staff, "clan:remove", tag, {
              name: c.name,
              members: c.memberCount,
              reason: body.reason,
            })(tx),
        );
        res.json(ok(`${tag} (${clan.name}) removed; its tag is held`, true));
      },
    ),
  );

  // ---------------------------------------------------------------- audit

  async function auditPage(
    staff: Staff,
    filter: {
      actor?: string;
      action?: string;
      target?: string;
      source?: string;
      before?: string;
      limit: number;
    },
  ): Promise<{ entries: AdminAuditEntry[]; nextBefore: string | null }> {
    const all = hasPermission(staff.user.role, "admin.audit.view");
    const where: string[] = [];
    const params: unknown[] = [];
    // A "?" in a clause is the next parameter (all "?" in one clause share it).
    const add = (sql: string, value: unknown) => {
      params.push(value);
      where.push(sql.split("?").join(`$${params.length}`));
    };
    // A moderator sees moderation actions only.
    if (!all) add("action = ANY(?)", [...MODERATION_AUDIT_ACTIONS]);
    if (filter.actor)
      add("(actor = ? OR actor_user_id::text = ?)", filter.actor);
    if (filter.action)
      add("action LIKE ?", `${filter.action.replace(/[\\%_]/g, "")}%`);
    if (filter.target) add("target_id = ?", filter.target);
    if (filter.source) add("source = ?", filter.source);
    if (filter.before && /^\d{1,18}$/.test(filter.before))
      add("id < ?::bigint", filter.before);
    const sql = where.join(" AND ");
    params.push(filter.limit + 1);
    const { rows } = await pool.query<{
      id: string;
      actor: string;
      actor_role: string | null;
      source: "cli" | "web" | "game";
      action: string;
      target_type: string | null;
      target_id: string | null;
      details: Record<string, unknown>;
      created_at: Date;
    }>(
      `SELECT id::text AS id, actor, actor_role, source, action, target_type, target_id, details, created_at
         FROM admin_audit_log
        ${sql === "" ? "" : `WHERE ${sql}`}
        ORDER BY id DESC LIMIT $${params.length}`,
      params,
    );
    const page = rows.slice(0, filter.limit);
    return {
      entries: page.map((r) => ({
        id: r.id,
        actor: r.actor,
        actorRole: r.actor_role,
        source: r.source,
        action: r.action,
        targetType: r.target_type,
        targetId: r.target_id,
        details: scrub(r.details) as Record<string, unknown>,
        createdAt: iso(r.created_at),
      })),
      nextBefore: rows.length > filter.limit ? page[page.length - 1].id : null,
    };
  }

  router.get(
    "/admin/audit",
    route(
      "admin.audit.view_moderation",
      "read",
      null,
      async (staff, _b, req, res) => {
        const str = (v: unknown) =>
          typeof v === "string" && v.trim() !== ""
            ? v.trim().slice(0, 80)
            : undefined;
        const limit = Math.min(
          100,
          Math.max(
            1,
            Number.parseInt(String(req.query.limit ?? "50"), 10) || 50,
          ),
        );
        res.json(
          await auditPage(staff, {
            actor: str(req.query.actor),
            action: str(req.query.action),
            target: str(req.query.target),
            source: str(req.query.source),
            before: str(req.query.before),
            limit,
          }),
        );
      },
    ),
  );

  // --------------------------------------------------------------- server

  router.get(
    "/admin/server",
    route("admin.server.view", "read", null, async (_staff, _b, _req, res) => {
      const [report, servers] = await Promise.all([
        readiness?.check() ?? Promise.resolve(null),
        pool.query<{
          site: string;
          letter: string;
          version: string;
          num_workers: number;
          live_games: number;
          state: string;
          last_checkin_at: Date;
        }>(
          "SELECT site, letter, version, num_workers, live_games, state, last_checkin_at FROM game_servers ORDER BY site, letter",
        ),
      ]);
      const build = getBuildInfo();
      res.json({
        version: build.version,
        commit: build.commit,
        environment: deps.config.env,
        uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
        readiness: {
          ready: report?.ready ?? true,
          checks: report?.checks ?? {},
        },
        features: Object.entries(deps.config.features)
          .filter(([, on]) => on === true)
          .map(([name]) => name),
        servers: servers.rows.map((r) => ({
          site: r.site,
          letter: r.letter,
          version: r.version,
          numWorkers: r.num_workers,
          liveGames: r.live_games,
          state: r.state,
          lastCheckinAt: iso(r.last_checkin_at),
          online: Date.now() - r.last_checkin_at.getTime() < 60_000,
        })),
      });
    }),
  );

  return router;
}
