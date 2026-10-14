/**
 * Abuse limits (docs/DeltaFrontAccountsPlan.md section 14.3). In memory, which
 * is right for one API instance; a second instance would need a shared store.
 */

import { CLAN_RULES } from "./domain/constants";

const DAY_MS = 86_400_000;

export interface RateLimit {
  max: number;
  windowMs: number;
}

/** The defaults. Overridable per limiter so tests and dev can loosen them. */
export const RATE_LIMITS = Object.freeze({
  /** New guest accounts: 10 an hour per client address. */
  guestCreation: { max: 10, windowMs: 60 * 60 * 1000 },
  /** Starting a Discord or Google sign-in. */
  oauthStart: { max: 30, windowMs: 60 * 1000 },
  /** Refreshes that present a cookie: generous, they are the normal heartbeat. */
  refresh: { max: 120, windowMs: 60 * 1000 },
  /** Public profile and game-history reads, per client address. */
  publicRead: { max: 240, windowMs: 60 * 1000 },
  /** Store purchases, per account (plan section 14.3). */
  purchase: { max: 20, windowMs: 60 * 1000 },
  /** Clan changes (create, join, manage), per account (plan section 14.3). */
  clanWrite: { max: 20, windowMs: 60_000 },
  /** Account deletion requests, per client address. */
  accountDeletion: { max: 5, windowMs: 60 * 60 * 1000 },
  /** OAuth callbacks (a state that checks out is single use; this caps guessing), per client address. */
  oauthCallback: { max: 60, windowMs: 60 * 1000 },
  /** Account username changes, per account (the 30 day cooldown is the real limit). */
  usernameChange: { max: 5, windowMs: 60 * 60 * 1000 },
  /** Clan creation, per account (plan section 14.3). */
  clanCreate: { max: CLAN_RULES.createsPerDay, windowMs: DAY_MS },
  /** Calls from game servers with a valid key (join verification, check-in, archive), per client address. */
  serverCall: { max: 1200, windowMs: 60 * 1000 },
  /** Emailed sign-in links requested (M8), per client address; the per-email limit is in the database. */
  magicLinkRequest: { max: 10, windowMs: 60 * 60 * 1000 },
  /** Emailed sign-in links used (M8), per client address. */
  magicLinkConsume: { max: 10, windowMs: 60 * 1000 },
  /** Prestige, reward claims and title changes, per account. */
  progressionWrite: { max: 30, windowMs: 60 * 1000 },
  /** Admin API reads, per staff account. */
  adminRead: { max: 300, windowMs: 60 * 1000 },
  /** Admin API changes, per staff account. */
  adminWrite: { max: 60, windowMs: 60 * 1000 },
  /** Wrong or missing server keys, per client address: a guess budget, not a request budget. */
  serverKeyFailure: { max: 30, windowMs: 60 * 1000 },
} as const satisfies Record<string, RateLimit>);

export type RateLimitName = keyof typeof RATE_LIMITS;

export interface LimitResult {
  allowed: boolean;
  /** Seconds until the window resets, when not allowed. */
  retryAfterSeconds: number;
}

/** A fixed-window counter per key. */
export class RateLimiter {
  private readonly hits = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private readonly limit: RateLimit,
    private readonly now: () => number = Date.now,
  ) {}

  /** Counts one hit for `key` and says whether it is within the limit. */
  hit(key: string): LimitResult {
    const now = this.now();
    if (this.hits.size > 10_000) this.sweep(now);
    let entry = this.hits.get(key);
    if (entry === undefined || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + this.limit.windowMs };
      this.hits.set(key, entry);
    }
    entry.count += 1;
    if (entry.count > this.limit.max) {
      return {
        allowed: false,
        retryAfterSeconds: Math.max(1, Math.ceil((entry.resetAt - now) / 1000)),
      };
    }
    return { allowed: true, retryAfterSeconds: 0 };
  }

  /** Whether `key` has already used up its budget, without counting a hit. */
  isExhausted(key: string): LimitResult {
    const now = this.now();
    const entry = this.hits.get(key);
    if (
      entry === undefined ||
      entry.resetAt <= now ||
      entry.count < this.limit.max
    ) {
      return { allowed: true, retryAfterSeconds: 0 };
    }
    return {
      allowed: false,
      retryAfterSeconds: Math.max(1, Math.ceil((entry.resetAt - now) / 1000)),
    };
  }

  private sweep(now: number): void {
    for (const [key, entry] of this.hits)
      if (entry.resetAt <= now) this.hits.delete(key);
  }
}

export type Limiters = Record<RateLimitName, RateLimiter>;

export function createLimiters(
  overrides: Partial<Record<RateLimitName, RateLimit>> = {},
  now: () => number = Date.now,
): Limiters {
  const make = (name: RateLimitName) =>
    new RateLimiter(overrides[name] ?? RATE_LIMITS[name], now);
  return {
    guestCreation: make("guestCreation"),
    oauthStart: make("oauthStart"),
    refresh: make("refresh"),
    publicRead: make("publicRead"),
    purchase: make("purchase"),
    clanWrite: make("clanWrite"),
    accountDeletion: make("accountDeletion"),
    oauthCallback: make("oauthCallback"),
    usernameChange: make("usernameChange"),
    clanCreate: make("clanCreate"),
    magicLinkRequest: make("magicLinkRequest"),
    magicLinkConsume: make("magicLinkConsume"),
    serverCall: make("serverCall"),
    serverKeyFailure: make("serverKeyFailure"),
    progressionWrite: make("progressionWrite"),
    adminRead: make("adminRead"),
    adminWrite: make("adminWrite"),
  };
}
