import { z } from "zod";
import { PERMISSIONS } from "./Permissions";

/**
 * The `/admin` API's response shapes (account API <-> web admin panel).
 *
 * Nothing here carries a secret: no token, no session id, no password, no
 * server API key, no key material. Account e-mail appears only for a role that
 * holds `admin.users.view_email` (the field is simply absent otherwise).
 */

const StaffRoleSchema = z.enum(["owner", "admin", "mod"]);

export const AdminMeSchema = z.object({
  publicId: z.string(),
  role: StaffRoleSchema,
  // Plain strings: a newer API may add permissions this client does not know.
  permissions: z.array(z.string()),
});
export type AdminMe = z.infer<typeof AdminMeSchema>;

export const KNOWN_PERMISSIONS: ReadonlySet<string> = new Set(PERMISSIONS);

const UserBriefSchema = z.object({
  publicId: z.string(),
  username: z.string().nullable(),
  kind: z.enum(["guest", "registered"]),
  role: z.string().nullable(),
  verified: z.boolean(),
  createdAt: z.iso.datetime(),
});
export type AdminUserBrief = z.infer<typeof UserBriefSchema>;

export const AdminUserListSchema = z.object({
  users: z.array(
    UserBriefSchema.extend({
      lastSeenAt: z.iso.datetime(),
      banned: z.boolean(),
    }),
  ),
});
export type AdminUserList = z.infer<typeof AdminUserListSchema>;

export const AdminDashboardSchema = z.object({
  version: z.string(),
  commit: z.string().nullable(),
  uptimeSeconds: z.number(),
  health: z.object({
    database: z.enum(["ok", "error"]),
    migrations: z.enum(["ok", "pending", "error"]),
    signingKey: z.enum(["ok", "error"]),
  }),
  counts: z.object({
    registeredUsers: z.number(),
    guests: z.number(),
    newUsers24h: z.number(),
    newUsers7d: z.number(),
    // Accounts seen in the last five minutes: the API does not track
    // connections, so this approximates "online".
    activeAccounts5m: z.number(),
    liveGames: z.number(),
    activeBans: z.number(),
    clans: z.number(),
  }),
  recentRegistrations: z.array(UserBriefSchema),
  recentBans: z.array(
    z.object({
      publicId: z.string(),
      username: z.string().nullable(),
      category: z.string(),
      reason: z.string().nullable(),
      createdAt: z.iso.datetime(),
      expiresAt: z.iso.datetime().nullable(),
    }),
  ),
  servers: z.array(
    z.object({
      site: z.string(),
      letter: z.string(),
      version: z.string(),
      numWorkers: z.number(),
      liveGames: z.number(),
      state: z.string(),
      lastCheckinAt: z.iso.datetime(),
      online: z.boolean(),
    }),
  ),
});
export type AdminDashboard = z.infer<typeof AdminDashboardSchema>;

export const AdminUserDetailSchema = UserBriefSchema.extend({
  id: z.string(),
  usernameBase: z.string().nullable(),
  bareUsernameEnabled: z.boolean(),
  holdsBareName: z.boolean(),
  lastSeenAt: z.iso.datetime(),
  deletionRequestedAt: z.iso.datetime().nullable(),
  credits: z.string(),
  liveSessions: z.number(),
  identities: z.array(
    z.object({
      provider: z.string(),
      providerUserId: z.string(),
      // Only for roles that hold admin.users.view_email.
      email: z.string().nullable().optional(),
      createdAt: z.iso.datetime(),
    }),
  ),
  items: z.array(
    z.object({
      flare: z.string(),
      source: z.string(),
      grantedAt: z.iso.datetime(),
      revokedAt: z.iso.datetime().nullable(),
    }),
  ),
  clans: z.array(
    z.object({ tag: z.string(), name: z.string(), role: z.string() }),
  ),
  bans: z.array(
    z.object({
      category: z.string(),
      reason: z.string().nullable(),
      createdAt: z.iso.datetime(),
      expiresAt: z.iso.datetime().nullable(),
      revokedAt: z.iso.datetime().nullable(),
      active: z.boolean(),
    }),
  ),
});
export type AdminUserDetail = z.infer<typeof AdminUserDetailSchema>;

export const AdminClanBriefSchema = z.object({
  tag: z.string(),
  name: z.string(),
  isOpen: z.boolean(),
  members: z.number(),
  createdAt: z.iso.datetime(),
});
export const AdminClanListSchema = z.object({
  clans: z.array(AdminClanBriefSchema),
});
export type AdminClanList = z.infer<typeof AdminClanListSchema>;

export const AdminClanDetailSchema = AdminClanBriefSchema.extend({
  description: z.string(),
  pendingRequests: z.number(),
  bans: z.array(
    z.object({
      publicId: z.string(),
      username: z.string().nullable(),
      reason: z.string().nullable(),
      createdAt: z.iso.datetime(),
    }),
  ),
  membersList: z.array(
    z.object({
      publicId: z.string(),
      username: z.string().nullable(),
      role: z.string(),
      verified: z.boolean(),
      staffRole: StaffRoleSchema.nullable(),
      joinedAt: z.iso.datetime(),
    }),
  ),
  events: z.array(
    z.object({ action: z.string(), createdAt: z.iso.datetime() }),
  ),
});
export type AdminClanDetail = z.infer<typeof AdminClanDetailSchema>;

export const AdminAuditEntrySchema = z.object({
  id: z.string(),
  actor: z.string(),
  actorRole: z.string().nullable(),
  source: z.enum(["cli", "web", "game"]),
  action: z.string(),
  targetType: z.string().nullable(),
  targetId: z.string().nullable(),
  details: z.record(z.string(), z.unknown()),
  createdAt: z.iso.datetime(),
});
export type AdminAuditEntry = z.infer<typeof AdminAuditEntrySchema>;

export const AdminAuditListSchema = z.object({
  entries: z.array(AdminAuditEntrySchema),
  // Pass back as `before` for the next (older) page; null on the last page.
  nextBefore: z.string().nullable(),
});
export type AdminAuditList = z.infer<typeof AdminAuditListSchema>;

export const AdminServerInfoSchema = z.object({
  version: z.string(),
  commit: z.string().nullable(),
  environment: z.string(),
  uptimeSeconds: z.number(),
  readiness: z.object({
    ready: z.boolean(),
    checks: z.record(z.string(), z.string()),
  }),
  features: z.array(z.string()),
  servers: AdminDashboardSchema.shape.servers,
});
export type AdminServerInfo = z.infer<typeof AdminServerInfoSchema>;

/** The answer to a change: what is now true, in words the panel can show. */
export const AdminActionResultSchema = z.object({
  ok: z.literal(true),
  message: z.string(),
  changed: z.boolean().optional(),
});
export type AdminActionResult = z.infer<typeof AdminActionResultSchema>;

/** The error body: a stable code, and a message a person can read. */
export const AdminErrorSchema = z.object({
  error: z.string(),
  message: z.string().optional(),
});
export type AdminError = z.infer<typeof AdminErrorSchema>;

/** Actions the moderation-only audit view may show (a mod sees these and nothing else). */
export const MODERATION_AUDIT_ACTIONS: readonly string[] = [
  "user:ban",
  "user:unban",
  "user:revoke-sessions",
  "game:kick",
];
