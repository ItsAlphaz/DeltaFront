import express, {
  type NextFunction,
  type Request,
  type Response,
} from "express";
import type { Pool } from "pg";
import type { KeyRing } from "../auth/keys";
import type { OAuthProviders } from "../auth/oauth/providers";
import {
  TokenError,
  type AccessClaims,
  type TokenService,
} from "../auth/tokens";
import type { Catalog } from "../catalog/load";
import type { AccountApiConfig } from "../config";
import type { ReservedClanNames } from "../domain/clans";
import type { Limiters } from "../limits";
import type { Logger } from "../logger";
import { isFamilyActive } from "../repo/sessions";
import type { Turnstile } from "../turnstile";

/** Everything the routes need, passed in so tests can substitute any of it. */
export interface AppDeps {
  config: AccountApiConfig;
  log: Logger;
  pool: Pool;
  keys: KeyRing;
  tokens: TokenService;
  limiters: Limiters;
  providers: OAuthProviders;
  turnstile: Turnstile;
  /** The cosmetic catalog; null when no feature uses it. */
  catalog: Catalog | null;
  /** Reserved clan tags and names (clans/reserved.json). */
  reserved: ReservedClanNames;
}

/** Cookies are Secure everywhere except plain-http dev. */
export const cookieSecure = (config: AccountApiConfig): boolean =>
  config.env !== "dev";

/**
 * Who a request is, from its bearer token: a valid signature, issuer,
 * audience and expiry, from a session that has not been revoked. Returns null
 * for anything else; callers answer 401.
 *
 * The session check is what makes logout, revoke-all and bans take effect at
 * once rather than when the 15-minute token expires: `sid` names the refresh
 * family the token was issued from, and a token whose family is dead is
 * refused.
 */
export async function authenticate(
  req: Request,
  deps: Pick<AppDeps, "pool" | "tokens">,
): Promise<AccessClaims | null> {
  const header = req.headers.authorization;
  if (typeof header !== "string" || !header.startsWith("Bearer ")) return null;
  const token = header.slice("Bearer ".length).trim();
  if (token === "") return null;
  let claims: AccessClaims;
  try {
    claims = await deps.tokens.verify(token);
  } catch (error) {
    if (error instanceof TokenError) return null;
    throw error;
  }
  if (claims.sid === null || !(await isFamilyActive(deps.pool, claims.sid)))
    return null;
  return claims;
}

/** express.json, but a malformed body is the caller's mistake (400), not ours (500). */
export function jsonBody(limit: string) {
  const parse = express.json({ limit });
  return (req: Request, res: Response, next: NextFunction): void => {
    parse(req, res, (error?: unknown) => {
      if (error !== undefined && error !== null) {
        res.status(400).json({ reason: "Invalid request" });
        return;
      }
      next();
    });
  };
}
