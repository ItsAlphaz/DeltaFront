import type { Pool } from "pg";
import { withTransaction } from "../db/tx";
import { createUser, getUser, type Db } from "../repo/users";

/**
 * The one funnel every sign-in method ends in (docs/DeltaFrontAccountsPlan.md
 * 7.3). Discord and Google use it in V1; email magic links will use it
 * unchanged in M8.
 */

export interface ProviderIdentity {
  provider: "discord" | "google" | "email" | "steam";
  /** Discord id, Google sub, lower-cased email, or SteamID64. */
  providerUserId: string;
  email: string | null;
  /** Only a verified email is ever used to detect an account clash. */
  emailVerified: boolean;
  displayName: string | null;
  avatar: string | null;
  profile: Record<string, unknown>;
}

export interface SignInContext {
  /** The user behind the current session, if any (a guest is upgraded in place). */
  currentUserId: string | null;
  /** Set when a signed-in user is linking this provider rather than signing in. */
  linkUserId: string | null;
}

export type SignInResult =
  | {
      outcome: "signed_in" | "created" | "upgraded_guest" | "linked";
      userId: string;
    }
  /** The identity (or its verified email) already belongs to a different account. We never merge. */
  | { outcome: "email_exists" }
  /** The account is queued for deletion. */
  | { outcome: "deleted" };

/** Which account an outcome signs the browser in as. */
export function signedInUser(result: SignInResult): string | null {
  return "userId" in result ? result.userId : null;
}

export async function completeSignIn(
  pool: Pick<Pool, "connect">,
  identity: ProviderIdentity,
  ctx: SignInContext,
): Promise<SignInResult> {
  // Two simultaneous callbacks for the same new identity: the loser hits the
  // UNIQUE (provider, provider_user_id) constraint and retries once, finding
  // the winner's row.
  for (let attempt = 0; ; attempt++) {
    try {
      return await withTransaction(pool, (db) =>
        signInInTransaction(db, identity, ctx),
      );
    } catch (error) {
      if ((error as { code?: string }).code === "23505" && attempt < 1)
        continue;
      throw error;
    }
  }
}

/**
 * The sign-in decision itself, for a caller that needs it in a transaction of
 * its own (the magic link consumes its token in the same one).
 */
export async function signInInTransaction(
  db: Db,
  identity: ProviderIdentity,
  ctx: SignInContext,
): Promise<SignInResult> {
  const existing = await db.query<{
    id: string;
    user_id: string;
    deleted_at: Date | null;
    deletion_requested_at: Date | null;
  }>(
    `SELECT i.id, i.user_id, u.deleted_at, u.deletion_requested_at
       FROM auth_identities i JOIN users u ON u.id = i.user_id
      WHERE i.provider = $1 AND i.provider_user_id = $2
      FOR UPDATE OF i`,
    [identity.provider, identity.providerUserId],
  );

  if (existing.rows.length > 0) {
    const row = existing.rows[0];
    if (row.deleted_at !== null || row.deletion_requested_at !== null)
      return { outcome: "deleted" };
    // Linking an identity that is already someone else's.
    if (ctx.linkUserId !== null && ctx.linkUserId !== row.user_id)
      return { outcome: "email_exists" };
    await db.query(
      `UPDATE auth_identities
          SET email = $2, email_verified = $3, display_name = $4, avatar = $5, profile = $6, last_login_at = now()
        WHERE id = $1`,
      [
        row.id,
        identity.email,
        identity.emailVerified,
        identity.displayName,
        identity.avatar,
        identity.profile,
      ],
    );
    return {
      outcome: ctx.linkUserId !== null ? "linked" : "signed_in",
      userId: row.user_id,
    };
  }

  // A new identity.
  const target = ctx.linkUserId ?? ctx.currentUserId;
  if (await emailBelongsToAnotherAccount(db, identity, target))
    return { outcome: "email_exists" };

  if (ctx.linkUserId !== null) {
    const user = await getUser(db, ctx.linkUserId);
    if (
      user === null ||
      user.deletedAt !== null ||
      user.deletionRequestedAt !== null
    ) {
      return { outcome: "deleted" };
    }
    // One identity of each kind per account.
    const same = await db.query(
      "SELECT 1 FROM auth_identities WHERE user_id = $1 AND provider = $2",
      [user.id, identity.provider],
    );
    if (same.rows.length > 0) return { outcome: "email_exists" };
    await insertIdentity(db, user.id, identity);
    await db.query("UPDATE users SET kind = 'registered' WHERE id = $1", [
      user.id,
    ]);
    return { outcome: "linked", userId: user.id };
  }

  if (ctx.currentUserId !== null) {
    const current = await getUser(db, ctx.currentUserId);
    if (
      current !== null &&
      current.kind === "guest" &&
      current.deletedAt === null
    ) {
      // The guest keeps everything they have done so far.
      await insertIdentity(db, current.id, identity);
      await db.query("UPDATE users SET kind = 'registered' WHERE id = $1", [
        current.id,
      ]);
      return { outcome: "upgraded_guest", userId: current.id };
    }
  }

  const user = await createUser(db, "registered");
  await insertIdentity(db, user.id, identity);
  return { outcome: "created", userId: user.id };
}

async function emailBelongsToAnotherAccount(
  db: Db,
  identity: ProviderIdentity,
  ownerUserId: string | null,
): Promise<boolean> {
  if (identity.email === null || !identity.emailVerified) return false;
  const { rows } = await db.query(
    `SELECT 1 FROM auth_identities
      WHERE email = $1 AND email_verified AND ($2::uuid IS NULL OR user_id <> $2::uuid) LIMIT 1`,
    [identity.email, ownerUserId],
  );
  return rows.length > 0;
}

async function insertIdentity(
  db: Db,
  userId: string,
  identity: ProviderIdentity,
): Promise<void> {
  await db.query(
    `INSERT INTO auth_identities
       (user_id, provider, provider_user_id, email, email_verified, display_name, avatar, profile)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      userId,
      identity.provider,
      identity.providerUserId,
      identity.email,
      identity.emailVerified,
      identity.displayName,
      identity.avatar,
      identity.profile,
    ],
  );
}
