import { createHmac, randomBytes } from "node:crypto";
import type { Pool } from "pg";
import { withTransaction } from "../db/tx";
import { sha256 } from "../http";
import type { Db } from "./users";

/** A refresh token lives 30 days from its last use. */
export const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/**
 * Two tabs can refresh at the same instant with the same cookie; the loser
 * presents a token the winner just replaced. Within this window that is
 * treated as a race, not theft.
 */
export const ROTATION_GRACE_MS = 10_000;

const ipHashKey = randomBytes(32);

/** A keyed hash of the address: stored for forensics, not reversible by brute force. */
export function hashIp(ip: string): Buffer {
  return createHmac("sha256", ipHashKey).update(ip).digest();
}

/** 256 random bits, base64url: the value of the refresh cookie. Only its SHA-256 is stored. */
export function newRefreshToken(): string {
  return randomBytes(32).toString("base64url");
}

export interface SessionContext {
  userAgent: string | null;
  ipHash: Buffer;
}

export interface CreatedSession {
  token: string;
  familyId: string;
}

export async function createSession(
  db: Db,
  userId: string,
  ctx: SessionContext,
  options: { familyId?: string; parentId?: string } = {},
): Promise<CreatedSession> {
  const token = newRefreshToken();
  const { rows } = await db.query<{ family_id: string }>(
    `INSERT INTO refresh_sessions (user_id, family_id, token_hash, parent_id, expires_at, user_agent, ip_hash)
     VALUES ($1, COALESCE($2::uuid, gen_random_uuid()), $3, $4, now() + ($5 || ' milliseconds')::interval, $6, $7)
     RETURNING family_id`,
    [
      userId,
      options.familyId ?? null,
      sha256(token),
      options.parentId ?? null,
      String(REFRESH_TTL_MS),
      ctx.userAgent?.slice(0, 512) ?? null,
      ctx.ipHash,
    ],
  );
  return { token, familyId: rows[0].family_id };
}

export type RotateResult =
  /** A new cookie value, and the family it continues. */
  | { kind: "rotated"; userId: string; familyId: string; token: string }
  /** A concurrent refresh already rotated this token: issue an access token, but no new cookie. */
  | { kind: "grace"; userId: string; familyId: string }
  /**
   * The session is dead. `reason` is for logs and tests only, never for the
   * client: unknown, deleted (account), revoked, expired, or reuse_detected (a
   * replaced token came back, so the whole family was just revoked).
   */
  | {
      kind: "invalid";
      reason: "unknown" | "deleted" | "revoked" | "expired" | "reuse_detected";
    };

/**
 * Exchanges a refresh token for its successor.
 *
 * Each token is single use. Presenting one that was already replaced is a
 * theft signal (the thief or the owner holds a stale copy), so after the
 * grace window the whole family is revoked and both must sign in again.
 */
export async function rotateSession(
  pool: Pick<Pool, "connect">,
  token: string,
  ctx: SessionContext,
  now: Date = new Date(),
): Promise<RotateResult> {
  return withTransaction(pool, async (db): Promise<RotateResult> => {
    const { rows } = await db.query<{
      id: string;
      user_id: string;
      family_id: string;
      expires_at: Date;
      revoked_at: Date | null;
      revoked_reason: string | null;
      user_agent: string | null;
      ip_hash: Buffer | null;
      deleted_at: Date | null;
    }>(
      `SELECT s.id, s.user_id, s.family_id, s.expires_at, s.revoked_at, s.revoked_reason,
              s.user_agent, s.ip_hash, u.deleted_at
         FROM refresh_sessions s JOIN users u ON u.id = s.user_id
        WHERE s.token_hash = $1
        FOR UPDATE OF s`,
      [sha256(token)],
    );
    if (rows.length === 0) return { kind: "invalid", reason: "unknown" };
    const row = rows[0];
    if (row.deleted_at !== null) return { kind: "invalid", reason: "deleted" };

    if (row.revoked_at !== null) {
      const sameClient =
        row.user_agent === (ctx.userAgent?.slice(0, 512) ?? null) &&
        row.ip_hash !== null &&
        row.ip_hash.equals(ctx.ipHash);
      const withinGrace =
        now.getTime() - row.revoked_at.getTime() <= ROTATION_GRACE_MS;
      if (
        row.revoked_reason === "rotated" &&
        withinGrace &&
        sameClient &&
        (await familyActive(db, row.family_id))
      ) {
        return { kind: "grace", userId: row.user_id, familyId: row.family_id };
      }
      if (row.revoked_reason === "rotated") {
        // A replaced token came back outside the race window: theft signal.
        await revokeFamily(db, row.family_id, "reuse_detected");
        return { kind: "invalid", reason: "reuse_detected" };
      }
      return { kind: "invalid", reason: "revoked" };
    }
    if (row.expires_at.getTime() <= now.getTime()) {
      return { kind: "invalid", reason: "expired" };
    }

    await db.query(
      "UPDATE refresh_sessions SET revoked_at = now(), revoked_reason = 'rotated', last_used_at = now() WHERE id = $1",
      [row.id],
    );
    const next = await createSession(db, row.user_id, ctx, {
      familyId: row.family_id,
      parentId: row.id,
    });
    return {
      kind: "rotated",
      userId: row.user_id,
      familyId: row.family_id,
      token: next.token,
    };
  });
}

async function familyActive(db: Db, familyId: string): Promise<boolean> {
  return isFamilyActive(db, familyId);
}

/** Whether any session in the family can still be refreshed. */
export async function isFamilyActive(
  db: Db,
  familyId: string,
): Promise<boolean> {
  const { rows } = await db.query(
    "SELECT 1 FROM refresh_sessions WHERE family_id = $1 AND revoked_at IS NULL AND expires_at > now() LIMIT 1",
    [familyId],
  );
  return rows.length > 0;
}

export async function revokeFamily(
  db: Db,
  familyId: string,
  reason: string,
): Promise<void> {
  await db.query(
    "UPDATE refresh_sessions SET revoked_at = now(), revoked_reason = $2 WHERE family_id = $1 AND revoked_at IS NULL",
    [familyId, reason],
  );
}

export async function revokeAllForUser(
  db: Db,
  userId: string,
  reason: string,
): Promise<number> {
  const { rowCount } = await db.query(
    "UPDATE refresh_sessions SET revoked_at = now(), revoked_reason = $2 WHERE user_id = $1 AND revoked_at IS NULL",
    [userId, reason],
  );
  return rowCount ?? 0;
}

/** Looks a refresh token up regardless of its state (for logout and revoke). */
export async function findSession(
  db: Db,
  token: string,
): Promise<{ userId: string; familyId: string } | null> {
  const { rows } = await db.query<{ user_id: string; family_id: string }>(
    "SELECT user_id, family_id FROM refresh_sessions WHERE token_hash = $1",
    [sha256(token)],
  );
  return rows.length === 0
    ? null
    : { userId: rows[0].user_id, familyId: rows[0].family_id };
}

/** The user and family of a refresh token that can still be used (not revoked, not expired). */
export async function liveSession(
  db: Db,
  token: string,
): Promise<{ userId: string; familyId: string } | null> {
  const { rows } = await db.query<{ user_id: string; family_id: string }>(
    `SELECT user_id, family_id FROM refresh_sessions
      WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > now()`,
    [sha256(token)],
  );
  return rows.length === 0
    ? null
    : { userId: rows[0].user_id, familyId: rows[0].family_id };
}
