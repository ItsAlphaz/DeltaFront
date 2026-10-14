import { customAlphabet } from "nanoid";
import type { Pool, PoolClient } from "pg";

/** Anything that can run a query: a pool or a client inside a transaction. */
export type Db = Pick<Pool | PoolClient, "query">;

export interface UserRow {
  id: string;
  publicId: string;
  kind: "guest" | "registered";
  role: string | null;
  createdAt: Date;
  deletionRequestedAt: Date | null;
  deletedAt: Date | null;
  usernameBase: string | null;
  usernameDiscriminator: string | null;
  nextUsernameChangeAt: Date | null;
  /** Operator-granted blue check; set only by the admin CLI. */
  verified: boolean;
  /** Entitled to claim a bare username; set only by the admin CLI. */
  bareUsernameEnabled: boolean;
}

// Letters and digits only (the users.public_id CHECK); 10 characters is ~60
// bits, and the column is UNIQUE, so a collision is retried, never silent.
const publicIdAlphabet = customAlphabet(
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789",
  10,
);

const COLUMNS = `id, public_id, kind, role, created_at, deletion_requested_at, deleted_at,
  username_base::text AS username_base, username_discriminator, next_username_change_at,
  verified, bare_username_enabled`;

interface RawUser {
  id: string;
  public_id: string;
  kind: "guest" | "registered";
  role: string | null;
  created_at: Date;
  deletion_requested_at: Date | null;
  deleted_at: Date | null;
  username_base: string | null;
  username_discriminator: string | null;
  next_username_change_at: Date | null;
  verified: boolean;
  bare_username_enabled: boolean;
}

function toUser(row: RawUser): UserRow {
  return {
    id: row.id,
    publicId: row.public_id,
    kind: row.kind,
    role: row.role,
    createdAt: row.created_at,
    deletionRequestedAt: row.deletion_requested_at,
    deletedAt: row.deleted_at,
    usernameBase: row.username_base,
    usernameDiscriminator: row.username_discriminator,
    nextUsernameChangeAt: row.next_username_change_at,
    verified: row.verified,
    bareUsernameEnabled: row.bare_username_enabled,
  };
}

/** The user with this public id, or null. */
export async function getUserByPublicId(
  db: Db,
  publicId: string,
): Promise<UserRow | null> {
  const { rows } = await db.query<RawUser>(
    `SELECT ${COLUMNS} FROM users WHERE public_id = $1`,
    [publicId],
  );
  return rows.length === 0 ? null : toUser(rows[0]);
}

/** Creates a user and their (empty) wallet. */
export async function createUser(
  db: Db,
  kind: "guest" | "registered",
): Promise<UserRow> {
  for (let attempt = 0; ; attempt++) {
    try {
      const { rows } = await db.query<RawUser>(
        `INSERT INTO users (public_id, kind) VALUES ($1, $2) RETURNING ${COLUMNS}`,
        [publicIdAlphabet(), kind],
      );
      const user = toUser(rows[0]);
      await db.query("INSERT INTO wallets (user_id) VALUES ($1)", [user.id]);
      return user;
    } catch (error) {
      // public_id collision: another try with a fresh id.
      if ((error as { code?: string }).code === "23505" && attempt < 5)
        continue;
      throw error;
    }
  }
}

export async function getUser(db: Db, id: string): Promise<UserRow | null> {
  const { rows } = await db.query<RawUser>(
    `SELECT ${COLUMNS} FROM users WHERE id = $1`,
    [id],
  );
  return rows.length === 0 ? null : toUser(rows[0]);
}

export interface ActiveBan {
  category: string;
  reason: string | null;
  expiresAt: Date | null;
}

export async function activeBan(
  db: Db,
  userId: string,
): Promise<ActiveBan | null> {
  const { rows } = await db.query<{
    category: string;
    reason: string | null;
    expires_at: Date | null;
  }>(
    `SELECT category, reason, expires_at FROM bans
      WHERE user_id = $1 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())
      ORDER BY created_at DESC LIMIT 1`,
    [userId],
  );
  return rows.length === 0
    ? null
    : {
        category: rows[0].category,
        reason: rows[0].reason,
        expiresAt: rows[0].expires_at,
      };
}

/** The `role` claim: a ban wins over a staff role. */
export function roleClaim(user: UserRow, ban: ActiveBan | null): string | null {
  return ban !== null ? "banned" : user.role;
}

export interface IdentityRow {
  provider: string;
  providerUserId: string;
  email: string | null;
  emailVerified: boolean;
  displayName: string | null;
  avatar: string | null;
  profile: Record<string, unknown>;
}

export async function identitiesOf(
  db: Db,
  userId: string,
): Promise<IdentityRow[]> {
  const { rows } = await db.query<{
    provider: string;
    provider_user_id: string;
    email: string | null;
    email_verified: boolean;
    display_name: string | null;
    avatar: string | null;
    profile: Record<string, unknown>;
  }>(
    `SELECT provider, provider_user_id, email, email_verified, display_name, avatar, profile
       FROM auth_identities WHERE user_id = $1 ORDER BY id`,
    [userId],
  );
  return rows.map((r) => ({
    provider: r.provider,
    providerUserId: r.provider_user_id,
    email: r.email,
    emailVerified: r.email_verified,
    displayName: r.display_name,
    avatar: r.avatar,
    profile: r.profile,
  }));
}

export async function touchLastSeen(db: Db, userId: string): Promise<void> {
  await db.query("UPDATE users SET last_seen_at = now() WHERE id = $1", [
    userId,
  ]);
}
