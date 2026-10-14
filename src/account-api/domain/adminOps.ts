import { staffRoleOf } from "@openfront/shared/Permissions";
import type { PoolClient } from "pg";
import type { Catalog } from "../catalog/load";
import { grantFlare, revokeFlare } from "../repo/inventory";
import { revokeAllForUser } from "../repo/sessions";
import type { Db } from "../repo/users";
import { ACCOUNT_RULES } from "./constants";
import { adjustWallet } from "./economy";
import { displayUsername } from "./usernames";

/**
 * The privileged account operations, in ONE place.
 *
 * The admin CLI and the `/admin` HTTP API both call these, so a rule cannot
 * drift between the two surfaces. Each function does its change AND writes its
 * audit row on the transaction it is given (the caller wraps it in
 * `withTransaction`), so a change is never recorded without its log entry and
 * the log never records a change that did not happen.
 *
 * Deliberately policy-free: whether the ACTOR may do this to THIS target is the
 * caller's decision (the HTTP layer asks Permissions.ts; the CLI is the
 * operator on the server). Everything here only validates the operation itself.
 */

/** Who is acting, as the audit log records it. */
export interface AuditContext {
  /** Human-readable: the OS user for the CLI, the account's public id for web and game. */
  actor: string;
  source: "cli" | "web" | "game";
  /** The acting account, when there is one. */
  actorUserId?: string | null;
  /** The acting account's role at the time (a snapshot: roles change). */
  actorRole?: string | null;
}

/** A refused operation. `code` is stable for the API; `message` is for a person. */
export class AdminOpError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = "AdminOpError";
  }
}

/** Writes one audit row. Returns its id. Never put a secret or a token in `details`. */
export async function writeAudit(
  db: Db,
  ctx: AuditContext,
  action: string,
  targetType: string | null,
  targetId: string | null,
  details: Record<string, unknown> = {},
): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO admin_audit_log
       (actor, action, target_type, target_id, details, actor_user_id, actor_role, source)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id::text AS id`,
    [
      ctx.actor,
      action,
      targetType,
      targetId,
      details,
      ctx.actorUserId ?? null,
      ctx.actorRole ?? null,
      ctx.source,
    ],
  );
  return rows[0].id;
}

export interface TargetUser {
  id: string;
  publicId: string;
  role: string | null;
}

/** The account with this public id; throws `NOT_FOUND`. */
export async function targetUser(
  db: Db,
  publicId: string,
): Promise<TargetUser> {
  const { rows } = await db.query<{
    id: string;
    public_id: string;
    role: string | null;
  }>("SELECT id, public_id, role FROM users WHERE public_id = $1", [publicId]);
  if (rows.length === 0)
    throw new AdminOpError(
      "NOT_FOUND",
      `no user with public id ${publicId}`,
      404,
    );
  return { id: rows[0].id, publicId: rows[0].public_id, role: rows[0].role };
}

// --------------------------------------------------------------- verification

/** Sets the blue check. Returns false when it already was that way (nothing changes, nothing is logged). */
export async function setVerified(
  db: Db,
  ctx: AuditContext,
  publicId: string,
  verified: boolean,
  reason: string,
): Promise<boolean> {
  const user = await targetUser(db, publicId);
  const before = await db.query<{ verified: boolean }>(
    "SELECT verified FROM users WHERE id = $1 FOR UPDATE",
    [user.id],
  );
  if (before.rows[0].verified === verified) return false;
  await db.query("UPDATE users SET verified = $2 WHERE id = $1", [
    user.id,
    verified,
  ]);
  await writeAudit(
    db,
    ctx,
    verified ? "user:verify" : "user:unverify",
    "user",
    publicId,
    { from: before.rows[0].verified, verified, reason },
  );
  return true;
}

// ------------------------------------------------------------- bare usernames

export interface BareNameOutcome {
  holdsBare: boolean;
  name: string | null;
}

/**
 * Grants or revokes the bare-username entitlement. Null when it already was
 * that way. A grant also clears the rename cooldown so the first bare claim is
 * not blocked by a recent change; a revoke leaves the held name as it is.
 */
export async function setBareNameEntitlement(
  db: Db,
  ctx: AuditContext,
  publicId: string,
  grant: boolean,
  reason: string,
): Promise<BareNameOutcome | null> {
  const user = await targetUser(db, publicId);
  const before = await db.query<{
    bare_username_enabled: boolean;
    username_base: string | null;
    username_discriminator: string | null;
  }>(
    `SELECT bare_username_enabled, username_base::text AS username_base, username_discriminator
       FROM users WHERE id = $1 FOR UPDATE`,
    [user.id],
  );
  const current = before.rows[0];
  if (current.bare_username_enabled === grant) return null;
  await db.query(
    grant
      ? "UPDATE users SET bare_username_enabled = true, next_username_change_at = NULL WHERE id = $1"
      : "UPDATE users SET bare_username_enabled = false WHERE id = $1",
    [user.id],
  );
  const holdsBare =
    current.username_base !== null && current.username_discriminator === null;
  await writeAudit(
    db,
    ctx,
    grant ? "user:grant-bare-name" : "user:revoke-bare-name",
    "user",
    publicId,
    {
      from: current.bare_username_enabled,
      bareUsernameEnabled: grant,
      username: displayUsername(
        current.username_base,
        current.username_discriminator,
      ),
      holdsBareName: holdsBare,
      reason,
    },
  );
  return { holdsBare, name: current.username_base };
}

// ----------------------------------------------------------------------- roles

/** The roles the column accepts, as the operator spells them ("none" clears it). */
export const ROLE_VALUES = [
  "owner",
  "admin",
  "mod",
  "flagged",
  "none",
] as const;

/**
 * Sets an account's role. `owner` is capped (ACCOUNT_RULES.maxOwners) and is the
 * only role the HTTP API never assigns (the CLI does). Returns the previous
 * role, or null when nothing changed.
 */
export async function setRole(
  db: Db,
  ctx: AuditContext,
  publicId: string,
  role: (typeof ROLE_VALUES)[number],
  reason: string,
): Promise<{ from: string } | null> {
  const user = await targetUser(db, publicId);
  const before = await db.query<{ role: string | null }>(
    "SELECT role FROM users WHERE id = $1 FOR UPDATE",
    [user.id],
  );
  const from = before.rows[0]?.role ?? "none";
  if (from === role) return null;
  const assigned = staffRoleOf(role);
  if (assigned === "owner") {
    const owners = await db.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM users WHERE role IN ('owner', 'root') AND id <> $1",
      [user.id],
    );
    if (owners.rows[0].n >= ACCOUNT_RULES.maxOwners) {
      throw new AdminOpError(
        "OWNER_LIMIT",
        `there are already ${owners.rows[0].n} owner(s); the limit is ${ACCOUNT_RULES.maxOwners} (ACCOUNT_RULES.maxOwners)`,
        409,
      );
    }
  }
  if (from === "owner" || from === "root") {
    const owners = await db.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM users WHERE role IN ('owner', 'root') AND id <> $1",
      [user.id],
    );
    if (owners.rows[0].n === 0) {
      throw new AdminOpError(
        "LAST_OWNER",
        "that would leave the project with no owner: make another account owner first",
        409,
      );
    }
  }
  await db.query("UPDATE users SET role = $2 WHERE id = $1", [
    user.id,
    role === "none" ? null : role,
  ]);
  await writeAudit(db, ctx, "user:role", "user", publicId, {
    from,
    role,
    reason,
  });
  return { from };
}

// ---------------------------------------------------------------------- bans

export async function banUser(
  db: Db,
  ctx: AuditContext,
  publicId: string,
  input: { category: string; reason: string; days: number | null },
): Promise<{ sessionsRevoked: number }> {
  const user = await targetUser(db, publicId);
  await db.query(
    `INSERT INTO bans (user_id, category, reason, expires_at)
     VALUES ($1, $2, $3, CASE WHEN $4::int IS NULL THEN NULL ELSE now() + ($4::int || ' days')::interval END)`,
    [user.id, input.category.trim(), input.reason, input.days],
  );
  // Signing out everywhere makes the ban take effect on the next request.
  const revoked = await revokeAllForUser(db, user.id, "banned");
  await writeAudit(db, ctx, "user:ban", "user", publicId, {
    category: input.category,
    reason: input.reason,
    days: input.days,
    sessionsRevoked: revoked,
  });
  return { sessionsRevoked: revoked };
}

export async function unbanUser(
  db: Db,
  ctx: AuditContext,
  publicId: string,
  reason: string,
): Promise<number> {
  const user = await targetUser(db, publicId);
  const r = await db.query(
    "UPDATE bans SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL",
    [user.id],
  );
  await writeAudit(db, ctx, "user:unban", "user", publicId, {
    reason,
    bansRevoked: r.rowCount,
  });
  return r.rowCount ?? 0;
}

export async function revokeSessions(
  db: Db,
  ctx: AuditContext,
  publicId: string,
  reason: string,
): Promise<number> {
  const user = await targetUser(db, publicId);
  const n = await revokeAllForUser(db, user.id, "admin_revoke");
  await writeAudit(db, ctx, "user:revoke-sessions", "user", publicId, {
    reason,
    sessionsRevoked: n,
  });
  return n;
}

// -------------------------------------------------------------------- credits

/**
 * Grants (positive) or deducts (negative) Credits. The audit row goes first
 * because its id is what the ledger row points back to; a refusal throws, which
 * rolls the audit row back too (nothing happened).
 */
export async function adjustCredits(
  db: PoolClient,
  ctx: AuditContext,
  publicId: string,
  signedAmount: number,
  reason: string,
): Promise<{ before: string; after: string }> {
  const amount = Math.abs(signedAmount);
  if (!Number.isInteger(signedAmount) || amount < 1) {
    throw new AdminOpError(
      "INVALID_AMOUNT",
      "the amount must be a positive whole number",
    );
  }
  if (amount > ACCOUNT_RULES.adminMaxCreditsPerCommand) {
    throw new AdminOpError(
      "AMOUNT_TOO_LARGE",
      `at most ${ACCOUNT_RULES.adminMaxCreditsPerCommand.toLocaleString("en-US")} Credits per command`,
    );
  }
  const user = await targetUser(db, publicId);
  const { rows } = await db.query<{ deleted_at: Date | null }>(
    // No row lock here: a purchase takes the wallet lock first and then needs
    // this row (foreign keys), so holding the user row while waiting for the
    // wallet would deadlock with it.
    "SELECT deleted_at FROM users WHERE id = $1",
    [user.id],
  );
  if (rows[0].deleted_at !== null) {
    throw new AdminOpError("DELETED", `${publicId} is a deleted account`);
  }
  const grant = signedAmount > 0;
  const logId = await writeAudit(
    db,
    ctx,
    grant ? "wallet:grant" : "wallet:revoke",
    "user",
    publicId,
    { amount, reason },
  );
  const result = await adjustWallet(db, user.id, signedAmount, logId);
  if (result.kind !== "adjusted") {
    throw new AdminOpError(
      result.kind === "insufficient" ? "INSUFFICIENT" : "WALLET_MAX",
      result.kind === "insufficient"
        ? `${publicId} has only ${result.balance} Credits: cannot deduct ${amount}`
        : "that would take the balance past the wallet maximum",
      409,
    );
  }
  await db.query(
    "UPDATE admin_audit_log SET details = details || $2::jsonb WHERE id = $1",
    [
      logId,
      {
        before: result.before,
        after: result.after,
        ledgerId: result.ledgerId,
      },
    ],
  );
  return { before: String(result.before), after: String(result.after) };
}

// ---------------------------------------------------------------------- items

function checkFlare(catalog: Catalog, flare: string): void {
  if (!catalog.validFlares.has(flare)) {
    throw new AdminOpError(
      "NOT_IN_CATALOG",
      `${flare} is not an item in the catalog`,
    );
  }
  if (catalog.defaultFlares.includes(flare)) {
    throw new AdminOpError(
      "DEFAULT_ITEM",
      `${flare} is a default item: every account already owns it`,
    );
  }
}

export async function grantItem(
  db: Db,
  ctx: AuditContext,
  catalog: Catalog,
  publicId: string,
  flare: string,
): Promise<"granted" | "restored" | "already_owned"> {
  checkFlare(catalog, flare);
  const user = await targetUser(db, publicId);
  const { rows } = await db.query<{ deleted_at: Date | null }>(
    "SELECT deleted_at FROM users WHERE id = $1 FOR UPDATE",
    [user.id],
  );
  if (rows[0].deleted_at !== null) {
    throw new AdminOpError("DELETED", `${publicId} is a deleted account`);
  }
  const outcome = await grantFlare(db, user.id, flare);
  await writeAudit(db, ctx, "item:grant", "user", publicId, {
    flare,
    result: outcome,
  });
  return outcome;
}

export async function revokeItem(
  db: Db,
  ctx: AuditContext,
  catalog: Catalog,
  publicId: string,
  flare: string,
  reason: string,
): Promise<"revoked" | "not_owned"> {
  if (catalog.defaultFlares.includes(flare)) {
    throw new AdminOpError(
      "DEFAULT_ITEM",
      `${flare} is a default item owned by every account: it cannot be revoked per account (remove it from defaultFlares in the catalog instead)`,
    );
  }
  const user = await targetUser(db, publicId);
  const outcome = await revokeFlare(db, user.id, flare);
  await writeAudit(db, ctx, "item:revoke", "user", publicId, {
    flare,
    reason,
    result: outcome,
  });
  return outcome as "revoked" | "not_owned";
}
