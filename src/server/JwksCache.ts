import {
  createLocalJWKSet,
  errors,
  type JSONWebKeySet,
  type JWTVerifyGetKey,
} from "jose";
import { z } from "zod";

/**
 * The game server's view of the account API's signing keys.
 *
 * It replaces "cache keys[0] forever", which broke on the first key rotation.
 * What it does instead:
 *  - keeps every key of the published JWKS and picks by the token's `kid`, so
 *    the current and the previous key both verify during a rotation;
 *  - never fetches on the join path once it has keys: an entry older than
 *    `maxAgeMs` is refreshed in the background and the join keeps using the
 *    keys it has;
 *  - fetches again (once, shared by every caller) when a token names a `kid` it
 *    does not know, at most once per `unknownKidCooldownMs`, so a forged `kid`
 *    cannot turn into a request flood against the API;
 *  - fails closed when it holds no keys, or when the keys it holds are older
 *    than `staleLimitMs` and the API cannot be reached to renew them: a key the
 *    API has withdrawn must not stay trusted indefinitely.
 */

const JwksSchema = z.object({
  keys: z
    .array(
      z.object({
        alg: z.literal("EdDSA"),
        crv: z.literal("Ed25519"),
        kty: z.literal("OKP"),
        kid: z.string().min(1).max(128),
        x: z.string().min(1).max(128),
      }),
    )
    .min(1)
    .max(8),
});

export interface JwksCacheOptions {
  url: string;
  fetchFn?: typeof fetch;
  now?: () => number;
  /** Age after which a background refresh starts. */
  maxAgeMs?: number;
  /** Age after which the cached keys are no longer trusted. */
  staleLimitMs?: number;
  /** Minimum gap between refreshes triggered by an unknown `kid`. */
  unknownKidCooldownMs?: number;
  /** Minimum gap after a failed fetch before the next attempt. */
  retryAfterFailureMs?: number;
  timeoutMs?: number;
  log?: (event: string, fields?: Record<string, unknown>) => void;
}

export interface JwksCache {
  /** A key resolver for `jwtVerify`. */
  getKey: JWTVerifyGetKey;
  /** Fetches now (start-up warm-up); resolves false instead of throwing. */
  refresh(): Promise<boolean>;
  /** For tests and diagnostics: the kids currently held. */
  kids(): string[];
}

export class JwksUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JwksUnavailableError";
  }
}

export function createJwksCache(options: JwksCacheOptions): JwksCache {
  const fetchFn = options.fetchFn ?? fetch;
  const now = options.now ?? Date.now;
  const maxAgeMs = options.maxAgeMs ?? 10 * 60_000;
  const staleLimitMs = options.staleLimitMs ?? 60 * 60_000;
  const unknownKidCooldownMs = options.unknownKidCooldownMs ?? 30_000;
  const retryAfterFailureMs = options.retryAfterFailureMs ?? 5_000;
  const timeoutMs = options.timeoutMs ?? 5_000;
  const log = options.log ?? (() => {});

  let resolver: JWTVerifyGetKey | null = null;
  let kidList: string[] = [];
  let fetchedAt = 0;
  let lastAttemptAt = Number.NEGATIVE_INFINITY;
  let lastFailed = false;
  let lastUnknownKidRefreshAt = Number.NEGATIVE_INFINITY;
  let inFlight: Promise<boolean> | null = null;

  async function fetchKeys(): Promise<boolean> {
    lastAttemptAt = now();
    try {
      const response = await fetchFn(options.url, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) throw new Error(`status ${response.status}`);
      const parsed = JwksSchema.safeParse(await response.json());
      if (!parsed.success) throw new Error("malformed key set");
      const set: JSONWebKeySet = { keys: parsed.data.keys };
      resolver = createLocalJWKSet(set);
      kidList = parsed.data.keys.map((k) => k.kid);
      fetchedAt = now();
      lastFailed = false;
      log("jwks_refreshed", { keys: kidList.length });
      return true;
    } catch (e) {
      lastFailed = true;
      log("jwks_refresh_failed", {
        reason: e instanceof Error ? e.message : "unknown",
      });
      return false;
    }
  }

  /** One fetch at a time; everyone who asks meanwhile shares its answer. */
  function refresh(): Promise<boolean> {
    inFlight ??= fetchKeys().finally(() => {
      inFlight = null;
    });
    return inFlight;
  }

  const backoffActive = () =>
    lastFailed && now() - lastAttemptAt < retryAfterFailureMs;

  const getKey: JWTVerifyGetKey = async (header, token) => {
    if (resolver === null) {
      if (!backoffActive()) await refresh();
      if (resolver === null) {
        throw new JwksUnavailableError("signing keys are not available");
      }
    }
    const age = now() - fetchedAt;
    if (age > staleLimitMs) {
      // Too old to trust: renew synchronously, and fail if that is impossible.
      if (!backoffActive()) await refresh();
      if (now() - fetchedAt > staleLimitMs) {
        throw new JwksUnavailableError("signing keys are stale");
      }
    } else if (age > maxAgeMs && !backoffActive()) {
      void refresh(); // background: this join keeps the keys it has
    }
    try {
      return await resolver!(header, token);
    } catch (e) {
      if (
        !(e instanceof errors.JWKSNoMatchingKey) ||
        now() - lastUnknownKidRefreshAt < unknownKidCooldownMs
      ) {
        throw e;
      }
      // A kid we have never seen: the API may have rotated. Look once.
      lastUnknownKidRefreshAt = now();
      await refresh();
      return resolver!(header, token);
    }
  };

  return { getKey, refresh, kids: () => [...kidList] };
}
