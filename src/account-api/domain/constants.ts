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

/**
 * How XP is earned (the approved progression plan, docs/Progression.md). Every
 * multiplier is a whole number in permille (1000 = 1x) so the arithmetic is
 * exact; the level curve and the ranks are shared rules (ProgressionRules.ts).
 * Changing a value changes future awards only: each game stores its own
 * breakdown and the XP ledger is never rewritten.
 */
/** The unit of every XP multiplier: 1,000 permille is 1x. */
export const PERMILLE = 1_000;

export const PROGRESSION = deepFreeze({
  /** XP for a completed (eligible) game. */
  completedMatch: 100,
  /** FFA placement: the highest tier a finish qualifies for (no stacking). */
  placementTopHalf: 50,
  placementTopQuarter: 100,
  placementTopTenth: 150,
  /** XP for winning. */
  victory: 250,
  /** XP for each elimination, and how many count in one game. */
  eliminationXp: 25,
  maxEliminations: 6,
  /** UTC-daily bonuses: the first eligible game, and the first eligible win. */
  firstGameBonus: 100,
  firstWinBonus: 150,
  /** A game with a smaller player-count multiplier than this cannot use a daily bonus. */
  dailyBonusMinPermille: 500,
  /** The most match XP one game can pay (a tripwire: the real maximum is 1,125). */
  matchXpCap: 1_250,
  /** Match XP per UTC day paid in full; above it XP is paid at the soft rate. */
  dailySoftCap: 6_000,
  softCapRatePermille: 250,
  /**
   * Eligible humans -> multiplier. A game with `players <= upTo` uses the first
   * band that fits; anything larger uses the last.
   */
  playerCountBands: [
    { upTo: 2, permille: 100 },
    { upTo: 5, permille: 500 },
    { upTo: 15, permille: 1_000 },
    { upTo: 30, permille: 1_150 },
    { upTo: Number.MAX_SAFE_INTEGER, permille: 1_250 },
  ],
  /** Reserved for ranked games (they do not count yet, so it never applies). */
  rankedPermille: 1_100,
  /** Repeated opponents: games both completed in the window, among a small group. */
  repeat: {
    windowHours: 24,
    /** Only checked when this many other eligible players or fewer took part. */
    maxOthers: 15,
    /** Shared prior games that make an opponent "familiar", and "very familiar". */
    sharedLow: 5,
    sharedHigh: 10,
    /** The multiplier when more than half the others are familiar / very familiar. */
    lowPermille: 500,
    highPermille: 250,
  },
  /** Clan XP is this share of the member's match XP, on top of their own. */
  clanXpPermille: 100,
  /** The most XP one admin command may grant or take. */
  adminMaxXpPerCommand: 100_000,
  /** A finished season waits this long for late game results before it is archived. */
  seasonGraceMinutes: 30,
  /** How often the season job looks for a season to archive. */
  seasonJobMs: 5 * 60 * 1000,
  /** Rows of recent XP history on the account page. */
  historyRows: 20,
  /** Rows of an admin's XP history page. */
  adminHistoryPageSize: 25,
  /** Prestige confirmation keys are this long at most. */
  idempotencyKeyMaxLength: 100,
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
  /** Clans one account can create per day (rate limit, plan section 14.3). */
  createsPerDay: 3,
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
  /** Days a stored game record (full replay data) is kept before it is pruned. */
  gameRecordRetentionDays: 60,
  /** Days a signed-out, rotated or expired refresh session row is kept (reuse detection needs it for its token's life). */
  deadSessionRetentionDays: 30,
  /** What an erased account's name becomes in the game history other players still see. */
  deletedPlayerName: "Deleted player",
  /** Minutes an emailed sign-in link stays valid (M8). */
  magicLinkTtlMinutes: 15,
  /** Links one email address may be sent in `magicLinkPerEmailWindowMinutes`; further requests are answered the same and send nothing. */
  magicLinkPerEmail: 3,
  magicLinkPerEmailWindowMinutes: 15,
  /** Hours a used or expired link row is kept before the maintenance job deletes it. */
  magicLinkRetentionHours: 24,
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
  /**
   * Accounts that may hold the owner role at once. Owner is created only with
   * the CLI on the server (never over HTTP) and the CLI refuses past this.
   */
  maxOwners: 3,
} as const);
