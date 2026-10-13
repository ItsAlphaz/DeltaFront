import { createHash } from "node:crypto";
import type { Logger } from "./logger";

/**
 * Cloudflare Turnstile verification, the server half of the bot check the
 * client runs before joining. The game server forwards the player's token
 * (first joins only: it is single use) and address to /join_verify, and this
 * asks Cloudflare whether the token is genuine.
 *
 * Three outcomes, never blurred:
 *  - `ok`: Cloudflare vouched for the token, it was solved on one of our
 *    hostnames for the action we expect, and we have not seen it before;
 *  - `rejected`: the token is bad (the player's problem, a closed connection);
 *  - `unavailable`: Cloudflare could not give an answer, or told us our own
 *    secret is wrong (our problem). The caller answers 5xx and the game server
 *    applies its fallback policy (src/server/JoinVerify.ts, joinFallback).
 */

export type TurnstileRejection =
  | "invalid" // Cloudflare says the token is wrong, expired or already used
  | "hostname" // solved on a page that is not ours
  | "action" // solved for a different action
  | "replayed"; // this API already accepted this exact token

export type TurnstileVerdict =
  | { status: "ok" }
  | { status: "rejected"; reason: TurnstileRejection; detail?: string }
  | { status: "unavailable"; reason: string };

export interface Turnstile {
  verify(token: string, ip: string): Promise<TurnstileVerdict>;
}

export const SITEVERIFY_URL =
  "https://challenges.cloudflare.com/turnstile/v0/siteverify";

/** The `action` the client sets when it renders the widget (TurnstileToken.ts). */
export const TURNSTILE_JOIN_ACTION = "join";

/** Error codes that mean Cloudflare (or our configuration) failed, not the player. */
const PROVIDER_ERROR_CODES = new Set([
  "internal-error",
  "missing-input-secret",
  "invalid-input-secret",
  "bad-request",
]);

const REPLAY_WINDOW_MS = 6 * 60_000; // longer than a token's 5 minute life
const REPLAY_CAPACITY = 20_000;

export interface TurnstileOptions {
  /** null disables the check (dev only: config makes the secret mandatory elsewhere). */
  secret: string | null;
  fetchFn?: typeof fetch;
  log: Logger;
  url?: string;
  /**
   * Hostnames a token may have been solved on (each also matches its
   * subdomains). null skips the check (dev, where the page is localhost).
   */
  allowedHostnames?: readonly string[] | null;
  /** The action a token must carry; null skips the check. */
  expectedAction?: string | null;
  timeoutMs?: number;
  now?: () => number;
}

export function hostnameAllowed(
  hostname: string,
  allowed: readonly string[],
): boolean {
  const host = hostname.toLowerCase();
  return allowed.some((a) => host === a || host.endsWith(`.${a}`));
}

export function createTurnstile(options: TurnstileOptions): Turnstile {
  const { secret, log } = options;
  const fetchFn = options.fetchFn ?? fetch;
  const now = options.now ?? Date.now;
  const timeoutMs = options.timeoutMs ?? 4_000;
  const allowedHostnames = options.allowedHostnames ?? null;
  const expectedAction = options.expectedAction ?? null;
  let warned = false;

  // Tokens this process has accepted, by hash, so a replay is refused even if
  // Cloudflare is unreachable on the second attempt. Cloudflare itself refuses
  // a second redemption; this is the second line, and it is per process.
  const accepted = new Map<string, number>();
  const hashOf = (token: string) =>
    createHash("sha256").update(token).digest("base64url");
  function remember(token: string): void {
    const t = now();
    if (accepted.size >= REPLAY_CAPACITY) {
      for (const [key, expires] of accepted) {
        if (expires <= t) accepted.delete(key);
      }
      // Still full: drop the oldest entry (Map keeps insertion order).
      if (accepted.size >= REPLAY_CAPACITY) {
        const oldest = accepted.keys().next();
        if (!oldest.done) accepted.delete(oldest.value);
      }
    }
    accepted.set(hashOf(token), t + REPLAY_WINDOW_MS);
  }
  function seenBefore(token: string): boolean {
    const key = hashOf(token);
    const expires = accepted.get(key);
    if (expires === undefined) return false;
    if (expires <= now()) {
      accepted.delete(key);
      return false;
    }
    return true;
  }

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
      if (seenBefore(token)) return { status: "rejected", reason: "replayed" };
      let body: {
        success?: unknown;
        "error-codes"?: unknown;
        hostname?: unknown;
        action?: unknown;
      };
      try {
        const res = await fetchFn(options.url ?? SITEVERIFY_URL, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ secret, response: token, remoteip: ip }),
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (!res.ok) {
          return {
            status: "unavailable",
            reason: `siteverify answered ${res.status}`,
          };
        }
        body = (await res.json()) as typeof body;
      } catch {
        return { status: "unavailable", reason: "siteverify unreachable" };
      }

      if (body.success !== true) {
        const codes = Array.isArray(body["error-codes"])
          ? body["error-codes"].filter(
              (c): c is string => typeof c === "string",
            )
          : [];
        const providerCode = codes.find((c) => PROVIDER_ERROR_CODES.has(c));
        if (providerCode !== undefined) {
          // Our secret is wrong or Cloudflare is failing: not the player's fault.
          log.error("Turnstile could not verify", { code: providerCode });
          return {
            status: "unavailable",
            reason: `siteverify error ${providerCode}`,
          };
        }
        return {
          status: "rejected",
          reason: "invalid",
          detail: codes.slice(0, 5).join(","),
        };
      }

      if (allowedHostnames !== null) {
        const hostname = typeof body.hostname === "string" ? body.hostname : "";
        if (!hostnameAllowed(hostname, allowedHostnames)) {
          return { status: "rejected", reason: "hostname" };
        }
      }
      if (expectedAction !== null && body.action !== expectedAction) {
        return { status: "rejected", reason: "action" };
      }
      remember(token);
      return { status: "ok" };
    },
  };
}
