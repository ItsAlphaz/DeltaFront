import { createHash, randomBytes } from "node:crypto";
import type { Pool } from "pg";
import { withTransaction } from "../db/tx";
import { ACCOUNT_RULES } from "../domain/constants";
import { MailDeliveryError, magicLinkMessage, type Mailer } from "./email";
import { signInInTransaction, type SignInResult } from "./signIn";

/**
 * Email magic-link sign-in (milestone M8; docs/DeltaFrontAccountsPlan.md 7.4).
 *
 * A request stores the SHA-256 of a 256-bit random token and emails the link;
 * the link carries the token in the URL *fragment* (`/#token-login?token-login=`),
 * which browsers never send to a server, so it cannot reach an access log.
 * Using the link consumes the token in the same transaction that signs the
 * account in, so a token is accepted once and a failure leaves it unused.
 *
 * The request never looks at whether an account exists for the address: that
 * is only decided when the link is used, so nothing a caller sees depends on
 * who has signed up.
 */

/** A token is 32 random bytes in base64url: exactly 43 characters. */
export const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export function newMagicToken(): string {
  return randomBytes(32).toString("base64url");
}

export const hashToken = (token: string): Buffer =>
  createHash("sha256").update(token, "utf8").digest();

// ---------------------------------------------------------------- addresses

const LOCAL =
  /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*$/;
const LABEL = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;

/**
 * The canonical (lower-case) form of an address, or null if it is not one we
 * will send to. Deliberately conservative: ASCII only, one `@`, a dotted
 * domain with a letters-only top level, no IP literals, no comments or quoted
 * local parts. An address that passes is stored and compared in this form.
 */
export function normalizeEmail(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const value = raw.trim();
  if (value.length < 6 || value.length > 254) return null;
  const at = value.indexOf("@");
  if (at <= 0 || at !== value.lastIndexOf("@")) return null;
  const local = value.slice(0, at);
  const domain = value.slice(at + 1).toLowerCase();
  if (local.length > 64 || !LOCAL.test(local)) return null;
  const labels = domain.split(".");
  if (labels.length < 2 || !labels.every((l) => LABEL.test(l))) return null;
  if (!/^[a-z]{2,63}$/.test(labels[labels.length - 1])) return null;
  return `${local.toLowerCase()}@${domain}`;
}

/**
 * The site origin a link may point at: exactly one of ALLOWED_ORIGINS. The
 * client sends its own origin (`https://example.com`); a bare host is accepted
 * and tried as https then http. Anything else (a path, a look-alike, another
 * site) is null, so the API can never be made to email a link to somewhere it
 * does not vouch for.
 */
export function validateRedirectDomain(
  raw: unknown,
  allowedOrigins: readonly string[],
): string | null {
  if (typeof raw !== "string" || raw === "" || raw.length > 255) return null;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000- \u007f\\@]/.test(raw)) return null;
  const candidates = raw.includes("://")
    ? [raw]
    : [`https://${raw}`, `http://${raw}`];
  for (const candidate of candidates) {
    if (allowedOrigins.includes(candidate)) return candidate;
  }
  return null;
}

/** The link in the email. The token is in the fragment, never the query. */
export function magicLinkUrl(origin: string, token: string): string {
  return `${origin}/#token-login?token-login=${token}`;
}

// ------------------------------------------------------------------ request

export type RequestOutcome =
  | { kind: "sent" }
  /** The address already received its share of links; nothing was sent (and the caller says nothing). */
  | { kind: "throttled" }
  | { kind: "delivery_failed"; transient: boolean };

export interface RequestInput {
  email: string;
  redirectOrigin: string;
  /** A registered account that asked while signed in: the link adds the address to it. */
  linkUserId: string | null;
  ipHash: Buffer;
}

export async function requestMagicLink(
  deps: {
    pool: Pick<Pool, "connect" | "query">;
    mailer: Mailer;
    log: { warn: (message: string, meta?: object) => unknown };
  },
  input: RequestInput,
): Promise<RequestOutcome> {
  const token = newMagicToken();
  const tokenHash = hashToken(token);

  const stored = await withTransaction(deps.pool, async (db) => {
    // Serialise requests for one address, so three at once cannot all pass the count.
    await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 7))", [
      input.email,
    ]);
    const { rows } = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM magic_link_tokens
        WHERE email = $1 AND created_at > now() - make_interval(mins => $2)`,
      [input.email, ACCOUNT_RULES.magicLinkPerEmailWindowMinutes],
    );
    if (rows[0].n >= ACCOUNT_RULES.magicLinkPerEmail) return false;
    await db.query(
      `INSERT INTO magic_link_tokens
         (token_hash, email, redirect_domain, link_user_id, expires_at, request_ip_hash)
       VALUES ($1, $2, $3, $4, now() + make_interval(mins => $5), $6)`,
      [
        tokenHash,
        input.email,
        input.redirectOrigin,
        input.linkUserId,
        ACCOUNT_RULES.magicLinkTtlMinutes,
        input.ipHash,
      ],
    );
    return true;
  });
  if (!stored) return { kind: "throttled" };

  try {
    await deps.mailer.send(
      magicLinkMessage({
        to: input.email,
        link: magicLinkUrl(input.redirectOrigin, token),
        ttlMinutes: ACCOUNT_RULES.magicLinkTtlMinutes,
      }),
    );
  } catch (error) {
    // A link nobody received must not count against the address or linger.
    await deps.pool
      .query("DELETE FROM magic_link_tokens WHERE token_hash = $1", [tokenHash])
      .catch(() => undefined);
    const transient =
      error instanceof MailDeliveryError ? error.transient : true;
    deps.log.warn("magic link delivery failed", {
      provider: deps.mailer.provider,
      transient,
      reason: error instanceof Error ? error.message : "unknown",
    });
    return { kind: "delivery_failed", transient };
  }
  return { kind: "sent" };
}

// ------------------------------------------------------------------ consume

export type ConsumeFailure =
  | "invalid"
  | "consumed"
  | "expired"
  /** The address already belongs to another account (we never merge). */
  | "email_exists"
  /** The account is queued for deletion. */
  | "deleted"
  /** The link adds an address to an account, and this browser is not signed in to it. */
  | "wrong_browser";

export type ConsumeOutcome =
  | { ok: true; email: string; result: SignInResult & { userId: string } }
  | { ok: false; code: ConsumeFailure };

interface TokenRow {
  email: string;
  link_user_id: string | null;
  expires_at: Date;
  consumed_at: Date | null;
}

/**
 * Uses a link. `currentUserId` is the account behind this browser's refresh
 * cookie, if any (a guest is upgraded in place).
 */
export async function consumeMagicLink(
  pool: Pick<Pool, "connect">,
  token: string,
  currentUserId: string | null,
): Promise<ConsumeOutcome> {
  if (!TOKEN_PATTERN.test(token)) return { ok: false, code: "invalid" };
  const tokenHash = hashToken(token);
  // Two simultaneous sign-ins creating the same new identity: the loser hits
  // the unique constraint, which rolls back its whole transaction (including
  // the consumption), and tries once more.
  for (let attempt = 0; ; attempt++) {
    try {
      return await withTransaction(pool, async (db) => {
        const { rows } = await db.query<TokenRow>(
          `SELECT email::text AS email, link_user_id, expires_at, consumed_at
             FROM magic_link_tokens WHERE token_hash = $1 FOR UPDATE`,
          [tokenHash],
        );
        if (rows.length === 0) return { ok: false, code: "invalid" } as const;
        const row = rows[0];
        if (row.consumed_at !== null)
          return { ok: false, code: "consumed" } as const;
        if (row.expires_at.getTime() <= Date.now())
          return { ok: false, code: "expired" } as const;
        // Adding an address to an account must be done from that account's own
        // browser: otherwise anyone who can get a signed-in person to open a
        // link they requested would sign that person in as the requester. The
        // link is left unused so it still works from the right browser.
        if (row.link_user_id !== null && row.link_user_id !== currentUserId)
          return { ok: false, code: "wrong_browser" } as const;

        await db.query(
          "UPDATE magic_link_tokens SET consumed_at = now() WHERE token_hash = $1",
          [tokenHash],
        );
        const result = await signInInTransaction(
          db,
          {
            provider: "email",
            providerUserId: row.email,
            email: row.email,
            emailVerified: true,
            displayName: null,
            avatar: null,
            profile: {},
          },
          { currentUserId, linkUserId: row.link_user_id },
        );
        if (result.outcome === "email_exists")
          return { ok: false, code: "email_exists" } as const;
        if (result.outcome === "deleted")
          return { ok: false, code: "deleted" } as const;
        return { ok: true, email: row.email, result } as const;
      });
    } catch (error) {
      if ((error as { code?: string }).code === "23505" && attempt < 1)
        continue;
      throw error;
    }
  }
}

/** Link rows that no longer matter: expired (so also used) a retention period ago. */
export async function pruneMagicLinks(
  pool: Pick<Pool, "query">,
  now: Date = new Date(),
): Promise<number> {
  const cutoff = new Date(
    now.getTime() - ACCOUNT_RULES.magicLinkRetentionHours * 3_600_000,
  );
  const { rowCount } = await pool.query(
    "DELETE FROM magic_link_tokens WHERE expires_at < $1",
    [cutoff],
  );
  return rowCount ?? 0;
}
