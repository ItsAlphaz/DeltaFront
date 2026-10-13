/**
 * The owner-defined numbers of the DeltaFront account backend, in one place so
 * they can be rebalanced with a one-line change (docs/DeltaFrontAccountsPlan.md,
 * decisions D1 and D2). Nothing else in src/account-api may hard-code them.
 *
 * Changing a value changes future grants and checks only: past ledger rows and
 * clan memberships are never rewritten.
 *
 * The Credits logic that uses ECONOMY is domain/economy.ts and
 * domain/stats.ts (milestone M2); clan creation will use CLAN_RULES in M6.
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
  /** Clan names are this many characters (after whitespace is collapsed). */
  nameMinLength: 3,
  nameMaxLength: 35,
  /** The longest clan description. */
  descriptionMaxLength: 200,
  /** The longest reason attached to a clan ban. */
  banReasonMaxLength: 200,
  /** Rows per page when the caller does not say, and the most it may ask for. */
  defaultPageSize: 20,
  maxPageSize: 50,
  /** The furthest page any clan list serves. */
  maxPage: 1_000,
  /** Games per page of a clan's game history. */
  gamesPageSize: 20,
  /** Days the clan leaderboard looks back. */
  leaderboardDays: 30,
  /** Counted public games a clan needs in that window to be listed. */
  leaderboardMinClanGames: 1,
  /** Clans the leaderboard lists. */
  leaderboardSize: 50,
} as const);

/**
 * How profiles, game history and the account lifecycle behave (docs plan
 * sections 8 and 14). Not owner decisions like the two above, but kept here so
 * every number a route or job depends on can be found in one file.
 */
export const ACCOUNT_RULES = deepFreeze({
  /** Days between self-service username changes. */
  usernameChangeCooldownDays: 7,
  /** A game counts for stats and Credits only with at least this many account holders in it. */
  countedGameMinAccountHolders: 2,
  /** ...and only if it lasted at least this long (seconds). */
  countedGameMinSeconds: 120,
  /** Hours between asking to delete an account and the deletion running. */
  deletionDelayHours: 24,
  /** Days a guest with no games, purchases or clan must be unseen to be removed. */
  guestIdleDays: 30,
  /** Games per window of the "recent" win rate on a profile. */
  recentWindowGames: 100,
  /** How many of a player's newest games the recent windows are computed from. */
  recentLookupRows: 1_000,
  /** Games per page of a player's game history. */
  historyPageSize: 20,
  /**
   * A record claiming to have ended more than this long after it arrives is
   * malformed (clock skew between a game server and the API is minutes, not
   * days). It also stops a forged `end` from picking the day a reward counts for.
   */
  maxFutureEndMs: 24 * 60 * 60 * 1000,
  /** Largest value kept for any single game statistic (JavaScript's safe integer). */
  maxStatValue: 9_007_199_254_740_991,
  /** Counted games a player needs in a leaderboard period to be listed. */
  leaderboardMinGames: 10,
  /** Rows per leaderboard page, and the most pages served (a hard server-side cap). */
  leaderboardPageSize: 50,
  leaderboardMaxPages: 20,
  /** The shorter leaderboard period, in days. */
  leaderboardRecentDays: 30,
  /** How often the leaderboard table is rebuilt from the stored games. */
  leaderboardRebuildMs: 5 * 60 * 1000,
  /** Seconds a leaderboard page may be cached by browsers and proxies. */
  leaderboardCacheSeconds: 60,
  /**
   * Whether guest accounts are listed. The plan excludes only flagged, banned
   * and deleted accounts, so guests are (their stats are kept either way).
   */
  leaderboardIncludesGuests: true,
  /** Largest Credits balance a wallet may reach; far above the cap can ever pay. */
  maxWalletCredits: 9_007_199_254_740_991,
  /** The most Credits one admin command may grant or deduct. */
  adminMaxCreditsPerCommand: 1_000_000_000,
} as const);
