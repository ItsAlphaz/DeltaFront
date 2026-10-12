/**
 * The owner-defined numbers of the DeltaFront account backend, in one place so
 * they can be rebalanced with a one-line change (docs/DeltaFrontAccountsPlan.md,
 * decisions D1 and D2). Nothing else in src/account-api may hard-code them.
 *
 * Changing a value changes future grants and checks only: past ledger rows and
 * clan memberships are never rewritten.
 *
 * M0 only defines the values. The logic that uses them arrives later:
 * Credits earning in M2, clan creation in M6.
 */

function deepFreeze<T extends object>(value: T): Readonly<T> {
  for (const v of Object.values(value)) {
    if (typeof v === "object" && v !== null) deepFreeze(v);
  }
  return Object.freeze(value);
}

/** D1: the single virtual currency and how gameplay earns it. */
export const ECONOMY = deepFreeze({
  currencyName: "Credits",
  /** Credits for each completed game (plan section 9.5 defines "completed"). */
  completedGameReward: 100,
  /** Additional Credits for winning a completed game. */
  winBonus: 250,
  /** The most Credits gameplay can pay one player per UTC day. */
  dailyGameplayCap: 1_000,
  /**
   * Game ticks (10 per second) a player must have survived for an elimination
   * to count as a completed game: 2 minutes.
   */
  minEliminationTick: 1_200,
} as const);

/** D2: who may create a clan, and the limits on clans. */
export const CLAN_RULES = deepFreeze({
  /** Minimum account age to create a clan. */
  createMinAccountAgeDays: 3,
  /** Completed games (the ECONOMY definition) needed to create a clan. */
  createMinCompletedGames: 10,
  /**
   * Clans a player can belong to at once. The database enforces 1 with a
   * UNIQUE index on clan_members(user_id): raising this later needs a
   * migration as well as a new number, so a race can never add a second.
   */
  maxClansPerMember: 1,
  /** Clans a player can own (lead) at once. */
  maxOwnedClans: 1,
  /** Pending join requests one player can have at a time. */
  maxPendingRequests: 3,
  /** Days a disbanded clan's tag stays unavailable. */
  disbandedTagHoldDays: 90,
  /** Days between clan renames. */
  nameChangeCooldownDays: 30,
} as const);
