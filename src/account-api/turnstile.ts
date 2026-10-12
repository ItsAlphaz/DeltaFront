import type { Logger } from "./logger";

/**
 * Cloudflare Turnstile verification, the server half of the bot check the
 * client runs before joining. The game server forwards the player's token
 * (first joins only: it is single use) and address to /join_verify, and this
 * asks Cloudflare whether the token is genuine.
 */

export type TurnstileVerdict =
  | { status: "ok" }
  | { status: "rejected"; reason: string }
  /** Cloudflare could not be asked: the caller answers 5xx and the game server fails open. */
  | { status: "unavailable"; reason: string };

export interface Turnstile {
  verify(token: string, ip: string): Promise<TurnstileVerdict>;
}

export const SITEVERIFY_URL =
  "https://challenges.cloudflare.com/turnstile/v0/siteverify";

export function createTurnstile(options: {
  /** null disables the check (dev only: config makes the secret mandatory elsewhere). */
  secret: string | null;
  fetchFn?: typeof fetch;
  log: Logger;
  url?: string;
}): Turnstile {
  const { secret, log } = options;
  const fetchFn = options.fetchFn ?? fetch;
  let warned = false;
  return {
    async verify(token, ip) {
      if (secret === null) {
        if (!warned) {
          warned = true;
          log.warn(
            "TURNSTILE_SECRET_KEY is not set: join tokens are NOT being verified (dev only)",
          );
        }
        return { status: "ok" };
      }
      try {
        const res = await fetchFn(options.url ?? SITEVERIFY_URL, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ secret, response: token, remoteip: ip }),
          signal: AbortSignal.timeout(4_000),
        });
        if (!res.ok)
          return {
            status: "unavailable",
            reason: `siteverify answered ${res.status}`,
          };
        const body = (await res.json()) as {
          success?: unknown;
          "error-codes"?: unknown;
        };
        if (body.success === true) return { status: "ok" };
        const codes = Array.isArray(body["error-codes"])
          ? body["error-codes"].join(",")
          : "";
        return {
          status: "rejected",
          reason: codes === "" ? "turnstile rejected the token" : codes,
        };
      } catch {
        return { status: "unavailable", reason: "siteverify unreachable" };
      }
    },
  };
}
