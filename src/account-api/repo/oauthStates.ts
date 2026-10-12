import { randomBytes } from "node:crypto";
import { sha256 } from "../http";
import type { Db } from "./users";

/** A sign-in attempt must finish within 10 minutes. */
export const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

export interface OAuthStateRecord {
  provider: string;
  redirectUri: string;
  pkceVerifier: string;
  linkUserId: string | null;
}

/** The state value is 256 random bits; only its hash is stored. */
export function newOAuthState(): string {
  return randomBytes(32).toString("base64url");
}

export function newPkceVerifier(): string {
  return randomBytes(48).toString("base64url");
}

const key = (state: string) => sha256(state).toString("hex");

export async function saveOAuthState(
  db: Db,
  state: string,
  record: OAuthStateRecord,
): Promise<void> {
  await db.query(
    `INSERT INTO oauth_states (state, provider, redirect_uri, pkce_verifier, link_user_id, expires_at)
     VALUES ($1, $2, $3, $4, $5, now() + ($6 || ' milliseconds')::interval)`,
    [
      key(state),
      record.provider,
      record.redirectUri,
      record.pkceVerifier,
      record.linkUserId,
      String(OAUTH_STATE_TTL_MS),
    ],
  );
  // Housekeeping: abandoned attempts do not pile up.
  await db.query(
    "DELETE FROM oauth_states WHERE expires_at < now() - interval '1 hour'",
  );
}

/**
 * Takes a state: it can be used exactly once, and only before it expires.
 * Returns null for an unknown, used or expired state.
 */
export async function consumeOAuthState(
  db: Db,
  state: string,
): Promise<OAuthStateRecord | null> {
  const { rows } = await db.query<{
    provider: string;
    redirect_uri: string;
    pkce_verifier: string;
    link_user_id: string | null;
    expires_at: Date;
  }>(
    "DELETE FROM oauth_states WHERE state = $1 RETURNING provider, redirect_uri, pkce_verifier, link_user_id, expires_at",
    [key(state)],
  );
  if (rows.length === 0 || rows[0].expires_at.getTime() <= Date.now())
    return null;
  return {
    provider: rows[0].provider,
    redirectUri: rows[0].redirect_uri,
    pkceVerifier: rows[0].pkce_verifier,
    linkUserId: rows[0].link_user_id,
  };
}
