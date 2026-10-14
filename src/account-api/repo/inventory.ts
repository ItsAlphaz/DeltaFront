import type { Catalog } from "../catalog/load";
import type { Db } from "./users";

/**
 * Ownership of cosmetics (`user_flares`). Rows are written only by the admin
 * commands in this milestone (and by purchases from M5); no route lets a
 * browser add one. The primary key `(user_id, flare)` is what makes a flare
 * unable to be owned twice.
 */

export interface FlareRow {
  flare: string;
  source: string;
  grantedAt: Date;
  revokedAt: Date | null;
}

/** The flares the account owns now (revoked ones excluded), sorted. */
export async function activeFlaresOf(
  db: Db,
  userId: string,
): Promise<string[]> {
  const { rows } = await db.query<{ flare: string }>(
    "SELECT flare FROM user_flares WHERE user_id = $1 AND revoked_at IS NULL ORDER BY flare",
    [userId],
  );
  return rows.map((r) => r.flare);
}

/** Every row, revoked included, for the admin to inspect. */
export async function flareRowsOf(db: Db, userId: string): Promise<FlareRow[]> {
  const { rows } = await db.query<{
    flare: string;
    source: string;
    granted_at: Date;
    revoked_at: Date | null;
  }>(
    "SELECT flare, source, granted_at, revoked_at FROM user_flares WHERE user_id = $1 ORDER BY flare",
    [userId],
  );
  return rows.map((r) => ({
    flare: r.flare,
    source: r.source,
    grantedAt: r.granted_at,
    revokedAt: r.revoked_at,
  }));
}

export type GrantResult = "granted" | "restored" | "already_owned";

/**
 * Gives the account a flare, by the admin (the default), as a progression
 * reward, or as the result of a purchase (`purchaseId`). Granting what it already owns changes nothing; a
 * previously revoked flare comes back (one row per account and flare, ever).
 */
export async function grantFlare(
  db: Db,
  userId: string,
  flare: string,
  how:
    | { source: "admin" }
    | { source: "reward" }
    | { source: "purchase"; purchaseId: string } = {
    source: "admin",
  },
): Promise<GrantResult> {
  const purchaseId = how.source === "purchase" ? how.purchaseId : null;
  const { rows } = await db.query<{ inserted: boolean }>(
    `INSERT INTO user_flares (user_id, flare, source, purchase_id)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (user_id, flare) DO UPDATE
        SET revoked_at = NULL, granted_at = now(), source = $3, purchase_id = $4
      WHERE user_flares.revoked_at IS NOT NULL
     RETURNING (xmax = 0) AS inserted`,
    [userId, flare, how.source, purchaseId],
  );
  if (rows.length === 0) return "already_owned";
  return rows[0].inserted ? "granted" : "restored";
}

export type RevokeResult = "revoked" | "not_owned";

/** Takes a flare away (the row is kept, marked revoked, so the history survives). */
export async function revokeFlare(
  db: Db,
  userId: string,
  flare: string,
): Promise<RevokeResult> {
  const { rowCount } = await db.query(
    "UPDATE user_flares SET revoked_at = now() WHERE user_id = $1 AND flare = $2 AND revoked_at IS NULL",
    [userId, flare],
  );
  return (rowCount ?? 0) > 0 ? "revoked" : "not_owned";
}

/**
 * What `/users/@me` reports as `flares`: the free items everyone owns plus
 * what the account was given, minus anything the catalog no longer defines
 * (an item removed after it was granted is simply not reported, and a stored
 * wildcard or malformed string can never reach the game server).
 */
export function reportedFlares(catalog: Catalog, owned: string[]): string[] {
  const out = new Set<string>(catalog.defaultFlares);
  for (const flare of owned) {
    if (catalog.validFlares.has(flare)) out.add(flare);
  }
  return [...out].sort();
}
