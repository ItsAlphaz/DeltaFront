/**
 * Cookie parsing and serialisation. Small and strict on purpose: the API only
 * ever sets two cookies (the refresh token and the OAuth state binding) and
 * reads values it can validate.
 */

export const REFRESH_COOKIE = "df_refresh";
export const OAUTH_COOKIE = "df_oauth";

export const REFRESH_COOKIE_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

export function parseCookies(
  header: string | undefined,
): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const name = part.slice(0, eq).trim();
    const raw = part.slice(eq + 1).trim();
    if (name === "" || name in out) continue;
    try {
      out[name] = decodeURIComponent(raw);
    } catch {
      // A malformed value is treated as absent.
    }
  }
  return out;
}

export interface CookieOptions {
  maxAgeSeconds: number;
  /** Secure everywhere except plain-http dev. */
  secure: boolean;
  path?: string;
}

/** HttpOnly, SameSite=Lax, host-only (no Domain), optionally Secure. */
export function serializeCookie(
  name: string,
  value: string,
  options: CookieOptions,
): string {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    `Path=${options.path ?? "/"}`,
    `Max-Age=${options.maxAgeSeconds}`,
    "HttpOnly",
    "SameSite=Lax",
  ];
  if (options.secure) parts.push("Secure");
  return parts.join("; ");
}

export function clearCookie(
  name: string,
  options: Pick<CookieOptions, "secure" | "path">,
): string {
  return serializeCookie(name, "", { maxAgeSeconds: 0, ...options });
}
