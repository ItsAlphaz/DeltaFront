import {
  ADMIN_COMMANDS,
  type AdminCommand,
} from "@openfront/engine-api/AdminCommands";

/**
 * DeltaFront's staff roles and permissions: the ONE authority.
 *
 * Nothing else in the project may decide what a role can do by comparing a role
 * string. The account API, the game server and the client (to hide what a
 * player may not use) all ask `hasPermission`. The API and the game server are
 * the enforcement points; the client only chooses what to draw.
 *
 * Model
 *  - `users.role` stores one of `owner`, `admin`, `mod`, `flagged` or nothing.
 *    `flagged` is a moderation state, not a staff role. `root` is upstream's
 *    super-admin role and is read as `owner`.
 *  - A staff role owns an explicit set of permissions (no "level >= n" maths),
 *    so a role that does not nest (support, developer, tournament staff) is one
 *    more entry in ROLE_GRANTS and nothing else.
 *  - Verification (`users.verified`) and the bare-username entitlement
 *    (`users.bare_username_enabled`) are not roles and grant no permission.
 */

/** The staff roles, most powerful first. */
export const STAFF_ROLES = ["owner", "admin", "mod"] as const;
export type StaffRole = (typeof STAFF_ROLES)[number];

/** What `users.role` may hold. `flagged` is a moderation state. */
export const ASSIGNABLE_ROLES = ["owner", "admin", "mod", "flagged"] as const;
export type AssignableRole = (typeof ASSIGNABLE_ROLES)[number];

/**
 * The staff role a stored or claimed role string means, or null for everyone
 * else (no role, `flagged`, `banned`, anything unknown). `root` is the
 * upstream spelling of owner.
 */
export function staffRoleOf(role: string | null | undefined): StaffRole | null {
  switch (role) {
    case "owner":
    case "root":
      return "owner";
    case "admin":
      return "admin";
    case "mod":
      return "mod";
    default:
      return null;
  }
}

// ---------------------------------------------------------------- permissions

/** Every permission, grouped by area. A new one is a new line here and in a role's grants. */
export const PERMISSIONS = [
  // Web admin panel
  "admin.panel.view",
  "admin.dashboard.view",
  "admin.users.view",
  "admin.users.view_email",
  "admin.users.ban",
  "admin.users.sessions",
  "admin.users.verify",
  "admin.users.bare_name",
  "admin.users.role",
  "admin.roles.manage_admins",
  "admin.wallet.grant",
  "admin.inventory.grant",
  "admin.clans.view",
  "admin.clans.manage",
  "admin.clans.official",
  "admin.clans.delete",
  "admin.audit.view",
  "admin.audit.view_moderation",
  "admin.server.view",
  "admin.server.manage",
  // In-game admin
  "game.admin.panel",
  "game.admin.spectate",
  "game.admin.kick",
  "game.admin.pause",
  "game.admin.kill",
  "game.admin.nations",
  "game.admin.debug",
  "game.admin.resources",
  "game.admin.force_end",
  "game.admin.impersonate_ai",
] as const;
export type Permission = (typeof PERMISSIONS)[number];

const MOD_GRANTS: readonly Permission[] = [
  "admin.panel.view",
  "admin.dashboard.view",
  "admin.users.view",
  "admin.users.ban",
  "admin.clans.view",
  "admin.audit.view_moderation",
  "game.admin.panel",
  "game.admin.spectate",
  "game.admin.kick",
  "game.admin.nations",
];

// Operational powers. What an admin lacks is owner-only on purpose: managing
// admins, arbitrary game state (resources, forcing an ending, playing as an
// AI), clan deletion, and server management.
const ADMIN_GRANTS: readonly Permission[] = [
  ...MOD_GRANTS,
  "admin.users.view_email",
  "admin.users.sessions",
  "admin.users.verify",
  "admin.users.bare_name",
  "admin.users.role",
  "admin.wallet.grant",
  "admin.inventory.grant",
  "admin.clans.manage",
  "admin.clans.official",
  "admin.audit.view",
  "admin.server.view",
  "game.admin.pause",
  "game.admin.kill",
  "game.admin.debug",
];

/** The owner holds everything, including whatever is added later. */
const OWNER_GRANTS: readonly Permission[] = PERMISSIONS;

export const ROLE_GRANTS: Readonly<Record<StaffRole, ReadonlySet<Permission>>> =
  {
    owner: new Set(OWNER_GRANTS),
    admin: new Set(ADMIN_GRANTS),
    mod: new Set(MOD_GRANTS),
  };

/** What can ask for permissions: a role string, or anything carrying one. */
export type RoleSubject =
  | string
  | null
  | undefined
  | { role?: string | null; staffRole?: string | null };

function subjectRole(subject: RoleSubject): string | null {
  if (subject === null || subject === undefined) return null;
  if (typeof subject === "string") return subject;
  return subject.staffRole ?? subject.role ?? null;
}

/** Whether the subject's role holds `permission`. False for everyone who is not staff. */
export function hasPermission(
  subject: RoleSubject,
  permission: Permission,
): boolean {
  const role = staffRoleOf(subjectRole(subject));
  return role !== null && ROLE_GRANTS[role].has(permission);
}

/** Every permission the subject holds, for the client to decide what to draw. */
export function permissionsOf(subject: RoleSubject): Permission[] {
  const role = staffRoleOf(subjectRole(subject));
  return role === null
    ? []
    : PERMISSIONS.filter((p) => ROLE_GRANTS[role].has(p));
}

/** Whether the role is any staff role (can open the admin panel). */
export function isStaff(subject: RoleSubject): boolean {
  return staffRoleOf(subjectRole(subject)) !== null;
}

// -------------------------------------------------------------- role changes

export type RoleChange =
  | { ok: true }
  | {
      ok: false;
      code:
        | "FORBIDDEN"
        | "SELF_CHANGE"
        | "OWNER_VIA_CLI_ONLY"
        | "TARGET_PROTECTED"
        | "ROLE_NOT_ASSIGNABLE";
    };

/** The roles an admin or owner may hand out through the API (never owner). */
export const API_ASSIGNABLE_ROLES = [
  "admin",
  "mod",
  "flagged",
  "none",
] as const;

/**
 * Whether `actor` may change an account from `current` to `next` ("none"
 * clears the role) through the web or HTTP API.
 *
 *  - needs `admin.users.role`;
 *  - nobody changes their own role here;
 *  - `owner` is never assigned over HTTP: it is created by the operator with the
 *    CLI, so a stolen session cannot mint owners;
 *  - owners and the legacy `root` are never touched here either;
 *  - only an owner (`admin.roles.manage_admins`) may grant, take away or change
 *    an admin's role; an admin may manage `mod`, `flagged` and no role.
 *
 * The CLI is the operator and is not bound by this (it enforces the owner cap).
 */
export function canChangeRole(input: {
  actorRole: string | null | undefined;
  actorPublicId: string;
  targetPublicId: string;
  current: string | null | undefined;
  next: string;
}): RoleChange {
  const { actorRole, current, next } = input;
  if (!hasPermission(actorRole, "admin.users.role"))
    return { ok: false, code: "FORBIDDEN" };
  if (input.actorPublicId === input.targetPublicId)
    return { ok: false, code: "SELF_CHANGE" };
  if (next === "owner" || next === "root")
    return { ok: false, code: "OWNER_VIA_CLI_ONLY" };
  if (!(API_ASSIGNABLE_ROLES as readonly string[]).includes(next))
    return { ok: false, code: "ROLE_NOT_ASSIGNABLE" };
  const currentStaff = staffRoleOf(current);
  if (currentStaff === "owner") return { ok: false, code: "TARGET_PROTECTED" };
  const touchesAdmin = currentStaff === "admin" || next === "admin";
  if (touchesAdmin && !hasPermission(actorRole, "admin.roles.manage_admins"))
    return { ok: false, code: "TARGET_PROTECTED" };
  return { ok: true };
}

/**
 * Whether `actor` may take a moderation or account action on a target holding
 * `targetRole`: nobody acts on an account of equal or higher staff standing
 * (an admin cannot ban an owner or another admin; a mod cannot act on staff).
 * Owners may act on anyone but another owner.
 */
export function canActOnTarget(
  actorRole: string | null | undefined,
  targetRole: string | null | undefined,
): boolean {
  const actor = staffRoleOf(actorRole);
  if (actor === null) return false;
  const target = staffRoleOf(targetRole);
  if (target === null) return true;
  const rank = { owner: 3, admin: 2, mod: 1 } as const;
  return rank[actor] > rank[target];
}

// ---------------------------------------------------------------- badges

/** What to say about a staff role, for a tooltip and an accessible label. */
export const STAFF_BADGE_LABELS: Readonly<Record<StaffRole, string>> = {
  owner: "DeltaFront Owner",
  admin: "DeltaFront Administrator",
  mod: "DeltaFront Moderator",
};

// ----------------------------------------------------------- game commands

export { ADMIN_COMMANDS, type AdminCommand };

/** The permission each command needs. The game server checks it before relaying the intent. */
export const ADMIN_COMMAND_PERMISSION: Readonly<
  Record<AdminCommand, Permission>
> = {
  give_gold: "game.admin.resources",
  take_gold: "game.admin.resources",
  set_gold: "game.admin.resources",
  give_troops: "game.admin.resources",
  take_troops: "game.admin.resources",
  set_troops: "game.admin.resources",
  eliminate: "game.admin.kill",
  force_win: "game.admin.force_end",
};
