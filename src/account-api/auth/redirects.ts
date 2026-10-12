/**
 * Where a sign-in may send the browser afterwards, and how results travel
 * back. The client sends `redirect_uri` as the full URL of the page the player
 * was on; it is only ever used if its origin is one of ALLOWED_ORIGINS, so the
 * API cannot be used as an open redirect.
 */

const MAX_REDIRECT_LENGTH = 2048;

export function validateRedirectUri(
  raw: unknown,
  allowedOrigins: readonly string[],
): string | null {
  if (typeof raw !== "string" || raw === "" || raw.length > MAX_REDIRECT_LENGTH)
    return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  // user:pass@host tricks: the origin must be exactly an allowed one, and
  // credentials in the URL are never legitimate.
  if (url.username !== "" || url.password !== "") return null;
  if (!allowedOrigins.includes(url.origin)) return null;
  // Control characters and backslashes are how parsers get confused into
  // different hosts; none belongs in a page URL we would redirect to.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f\\]/.test(raw)) return null;
  return url.toString();
}

export type LoginResult =
  | "email_exists"
  | "deleted"
  | "error"
  | "no_account"
  | "cancel";

/** Adds `login=<result>` to the URL's fragment, keeping whatever else is there (`#modal=account`). */
export function withLoginResult(
  redirectUri: string,
  result: LoginResult,
): string {
  const url = new URL(redirectUri);
  const params = new URLSearchParams(
    url.hash.startsWith("#") ? url.hash.slice(1) : url.hash,
  );
  params.set("login", result);
  url.hash = params.toString();
  return url.toString();
}
