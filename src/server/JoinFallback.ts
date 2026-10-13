import type { TokenPayload } from "@openfront/shared/ApiSchemas";

/**
 * What a first join may do when the bot check cannot be run (the account API
 * or Cloudflare is unreachable). Failing open for everyone is the easy choice
 * and the unsafe one: an outage, or an attacker who can cause one, would turn
 * the bot check off for the whole internet. The default outside dev is
 * therefore `registered`:
 *  - `open`: admit everyone (dev default; one unverified join per request);
 *  - `registered`: admit signed-in players (Discord/Google accounts are the
 *    anti-abuse signal, and the account can be banned), refuse guests with a
 *    explanatory refusal (CloseCode.VerificationUnavailable);
 *  - `closed`: admit nobody until the check works again.
 * Re-admits and Steam joins carry no token, so they never reach this choice.
 */
export const JOIN_FALLBACK_POLICIES = ["open", "registered", "closed"] as const;
export type JoinFallbackPolicy = (typeof JOIN_FALLBACK_POLICIES)[number];

/** Sign-in providers whose accounts count as "registered" for the fallback. */
const REGISTERED_PROVIDERS: ReadonlySet<string> = new Set([
  "discord",
  "google",
  "email",
  "steam",
]);

export function parseJoinFallback(
  raw: string | undefined,
  isDev: boolean,
): JoinFallbackPolicy {
  const value = raw?.trim();
  if (value === undefined || value === "") return isDev ? "open" : "registered";
  if ((JOIN_FALLBACK_POLICIES as readonly string[]).includes(value)) {
    return value as JoinFallbackPolicy;
  }
  throw new Error(
    `TURNSTILE_FALLBACK must be one of: ${JOIN_FALLBACK_POLICIES.join(", ")}`,
  );
}

export function joinFallbackDecision(
  policy: JoinFallbackPolicy,
  claims: TokenPayload | null,
): "admit" | "deny" {
  switch (policy) {
    case "open":
      return "admit";
    case "closed":
      return "deny";
    case "registered":
      return claims?.provider !== undefined &&
        REGISTERED_PROVIDERS.has(claims.provider)
        ? "admit"
        : "deny";
  }
}
