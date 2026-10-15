import type {
  LiveXpResponse,
  LiveXpStatus,
} from "@openfront/shared/ApiSchemas";
import type {
  LiveProgress,
  LiveProgressPlayer,
} from "@openfront/shared/LiveProgress";
import { adminCommandInvalidatesResult } from "@openfront/shared/Permissions";
import type { Pool } from "pg";
import { ACCOUNT_RULES, ECONOMY } from "./constants";
import { priorGamesWith } from "./progression";
import { RESULT_GRACE_TURNS, winnerClientIds } from "./stats";
import {
  computeMatchXp,
  computeReducedXp,
  isFreeForAll,
  progressionEligibility,
  repeatPermille,
  type MatchXpResult,
} from "./xp";

/**
 * A running game's progression, as a preview. The game server reports what only
 * it knows (LiveProgress); this turns it into the XP a player stands at with the
 * very functions that decide the final award (`computeMatchXp`,
 * `computeReducedXp`, `progressionEligibility`), so there is one set of rules.
 *
 * Nothing here is ever written to the ledger. The stored game, once it arrives,
 * is the only thing that awards XP, exactly once (the unique ledger key on
 * user + game), so a preview, a settled preview and the stored game can be shown
 * in any order without a double award.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** How long a game's last report is kept without another one (a game that never finished). */
export const LIVE_TTL_MS = 60 * 60_000;
/** How many running games are kept at once: the oldest report goes first. */
export const LIVE_MAX_GAMES = 500;
/** How long a player's worked-out preview is reused (their day's XP rarely moves). */
const CONTEXT_TTL_MS = 30_000;

interface PlayerContext {
  at: number;
  earnedToday: number;
  firstGameAvailable: boolean;
  firstWinAvailable: boolean;
  repeat: number;
}

export interface LiveGame {
  progress: LiveProgress;
  receivedAt: number;
  /** The account holders among the players: user id -> kind. */
  users: ReadonlyMap<string, "guest" | "registered">;
  /** Per player: the daily and repeated-opponent facts, read once and reused briefly. */
  contexts: Map<string, PlayerContext>;
}

/** The running games the game servers have reported, by game code. */
export class LiveXpStore {
  private readonly games = new Map<string, LiveGame>();

  set(code: string, game: LiveGame): void {
    // A re-report keeps the per-player facts already read.
    const previous = this.games.get(code);
    if (previous !== undefined) game.contexts = previous.contexts;
    this.games.delete(code);
    this.games.set(code, game);
    while (this.games.size > LIVE_MAX_GAMES) {
      const oldest = this.games.keys().next().value;
      if (oldest === undefined) break;
      this.games.delete(oldest);
    }
  }

  get(code: string, now: number): LiveGame | undefined {
    const game = this.games.get(code);
    if (game === undefined) return undefined;
    if (now - game.receivedAt > LIVE_TTL_MS) {
      this.games.delete(code);
      return undefined;
    }
    return game;
  }

  delete(code: string): void {
    this.games.delete(code);
  }

  clear(): void {
    this.games.clear();
  }

  get size(): number {
    return this.games.size;
  }
}

/** The process's running games. */
export const liveXpStore = new LiveXpStore();

/** Whether the staff commands run so far make the game a test (the live twin of isAdminModified). */
export function adminActionsInvalidate(
  actions: LiveProgress["adminActions"],
): boolean {
  return actions.some(
    (a) =>
      a.invalidatesResult ||
      adminCommandInvalidatesResult(a.role, {
        public: a.public,
        listed: a.listed,
      }),
  );
}

/**
 * Takes a game server's report: finds which of its players are accounts (the
 * same rule as ingestion: live users, each once) and keeps it for the previews.
 */
export async function acceptProgress(
  pool: Pick<Pool, "query">,
  progress: LiveProgress,
  store: LiveXpStore = liveXpStore,
  now: number = Date.now(),
): Promise<void> {
  const candidates = [
    ...new Set(
      progress.players
        .map((p) => p.persistentID)
        .filter((id): id is string => id !== null && UUID.test(id))
        .map((id) => id.toLowerCase()),
    ),
  ];
  const users = new Map<string, "guest" | "registered">();
  if (candidates.length > 0) {
    const { rows } = await pool.query<{
      id: string;
      kind: "guest" | "registered";
    }>(
      "SELECT id, kind FROM users WHERE id = ANY($1::uuid[]) AND deleted_at IS NULL",
      [candidates],
    );
    for (const row of rows) users.set(row.id, row.kind);
  }
  store.set(progress.gameID, {
    progress,
    receivedAt: now,
    users,
    contexts: new Map(),
  });
}

// ---------------------------------------------------------------- the rules

/**
 * Whether this player's elimination is one that counts for the player who made
 * it: they were seen alive at a snapshot at or after the elimination minimum,
 * so they fell after it. (The same two-minute rule as `validEliminations`;
 * between snapshots a player's death is only bounded, so an unsure one is not
 * counted yet.)
 */
function validDeath(victim: LiveProgressPlayer): boolean {
  return (
    victim.aliveAtTurn !== null &&
    victim.aliveAtTurn >= ECONOMY.minEliminationTick
  );
}

/** Eliminated in the first two minutes, for certain: a free kill, not a game played. */
function eliminatedEarly(player: LiveProgressPlayer): boolean {
  return (
    player.deadAtTurn !== null && player.deadAtTurn < ECONOMY.minEliminationTick
  );
}

/**
 * Whether the player left before the result: gone now while the game is on, or
 * gone from before the result was determined once it is. The live twin of
 * `playerProgressionOutcome`'s presence rule, from the same roster facts.
 */
export function leftBeforeResult(
  player: LiveProgressPlayer,
  resultTurn: number | null,
): boolean {
  if (player.leftTurn === null || player.connected) return false;
  if (resultTurn === null) return true;
  return player.leftTurn + RESULT_GRACE_TURNS < resultTurn;
}

const none = (
  gameId: string,
  reason: string,
  extra: Partial<LiveXpResponse> = {},
): LiveXpResponse => ({
  gameId,
  status: "none",
  mode: null,
  reason,
  total: 0,
  breakdown: null,
  pending: [],
  alive: true,
  winner: false,
  ...extra,
});

async function contextFor(
  pool: Pick<Pool, "query">,
  game: LiveGame,
  userId: string,
  others: readonly string[],
  now: number,
): Promise<PlayerContext> {
  const cached = game.contexts.get(userId);
  if (cached !== undefined && now - cached.at < CONTEXT_TTL_MS) return cached;
  const day = new Date(now).toISOString().slice(0, 10);
  const { rows } = await pool.query<{
    match_xp: string;
    first_game_ref: string | null;
    first_win_ref: string | null;
  }>(
    `SELECT match_xp::text AS match_xp, first_game_ref, first_win_ref
       FROM xp_daily WHERE user_id = $1 AND day = $2::date`,
    [userId, day],
  );
  const daily = rows[0];
  const context: PlayerContext = {
    at: now,
    earnedToday: daily === undefined ? 0 : Number(daily.match_xp),
    firstGameAvailable: daily === undefined || daily.first_game_ref === null,
    firstWinAvailable: daily === undefined || daily.first_win_ref === null,
    repeat: repeatPermille(
      await priorGamesWith(pool, userId, others, new Date(now), "0"),
    ),
  };
  game.contexts.set(userId, context);
  return context;
}

/**
 * What the player's match XP stands at in a running (or just settled) game, or
 * null when the API has no report of the game or the player is not in it.
 */
export async function liveXpFor(
  pool: Pick<Pool, "query">,
  gameCode: string,
  userId: string,
  store: LiveXpStore = liveXpStore,
  now: number = Date.now(),
): Promise<LiveXpResponse | null> {
  const game = store.get(gameCode, now);
  if (game === undefined) return null;
  const { progress } = game;
  const me = progress.players.find(
    (p) => p.persistentID?.toLowerCase() === userId,
  );
  const kind = game.users.get(userId);
  if (me === undefined || kind === undefined) return null;

  const resultTurn = progress.result?.resultTurn ?? null;
  const base = { alive: me.alive };

  if (kind === "guest") return none(gameCode, "guest", base);

  // How far the game progresses, from the facts the final rule reads. A game
  // is assumed to last the two minutes it needs: only the stored game can say
  // it did not.
  const eligibility = progressionEligibility({
    source: "server",
    type: progress.config.gameType,
    rankedType: progress.config.rankedType,
    durationSeconds: Math.max(
      progress.elapsedSeconds,
      ACCOUNT_RULES.countedGameMinSeconds,
    ),
    accountHolders: game.users.size,
    adminModified: adminActionsInvalidate(progress.adminActions),
    listed: progress.config.listed,
  });
  if (eligibility.mode === "none") {
    return none(gameCode, eligibility.reason, base);
  }
  if (progress.adminSenders.includes(me.clientID)) {
    return none(gameCode, "admin_actor", base);
  }
  if (eliminatedEarly(me)) return none(gameCode, "eliminated_early", base);

  // Leaving before the result forfeits everything.
  if (leftBeforeResult(me, resultTurn)) {
    return {
      ...none(gameCode, "left_early", base),
      status: "forfeited",
      mode: eligibility.mode,
    };
  }

  // The eliminations that count: each human victim once, who fell after the minimum.
  const victims = new Set<string>();
  for (const other of progress.players) {
    if (
      other.clientID !== me.clientID &&
      other.killedBy === me.clientID &&
      validDeath(other)
    ) {
      victims.add(other.clientID);
    }
  }

  // The humans the player-count multiplier reads: accounts who took part and
  // have not left before the result.
  const participants = progress.players.filter(
    (p) =>
      p.persistentID !== null &&
      game.users.has(p.persistentID.toLowerCase()) &&
      p.acted &&
      !eliminatedEarly(p) &&
      !leftBeforeResult(p, resultTurn),
  );
  const others = participants
    .map((p) => (p.persistentID as string).toLowerCase())
    .filter((id) => id !== userId);

  const winners =
    progress.result?.winner === undefined
      ? new Set<string>()
      : winnerClientIds(progress.result.winner);
  const settled = progress.result !== null;
  const victory = settled && winners.has(me.clientID);
  const ffa = isFreeForAll({ gameMode: progress.config.gameMode });

  const context = await contextFor(pool, game, userId, others, now);

  let computed: MatchXpResult;
  let pending: LiveXpResponse["pending"];
  if (eligibility.mode === "reduced") {
    computed = computeReducedXp({
      reason: eligibility.reason,
      eliminations: victims.size,
      earnedToday: context.earnedToday,
    });
    // Nothing competitive in a reduced game: nothing left to decide.
    pending = [];
  } else {
    computed = computeMatchXp({
      victory,
      // The winner's place is settled; anyone else's still depends on the
      // finish, so it is not paid in the preview until the stored game says.
      place: victory && ffa ? 1 : null,
      humans: progress.players.length,
      eliminations: victims.size,
      eligibleHumans: Math.max(1, participants.length),
      repeatPermille: context.repeat,
      firstGameAvailable: context.firstGameAvailable,
      firstWinAvailable: context.firstWinAvailable,
      earnedToday: context.earnedToday,
    });
    pending = [];
    if (!victory) {
      if (ffa) pending.push("placement");
      if (!settled && me.alive) pending.push("victory");
    }
    pending.push("challenges", "season");
  }

  let status: LiveXpStatus;
  if (settled) status = "settled";
  else if (!me.alive) status = "pending";
  else status = "live";

  return {
    gameId: gameCode,
    status,
    mode: eligibility.mode,
    reason: null,
    total: computed.breakdown.total,
    // The shape the stored result has, so the same panel reads both.
    breakdown: {
      leftEarly: false,
      time: 0,
      feats: 0,
      subscriberPermille: 1000,
      ...computed.breakdown,
    },
    pending,
    alive: me.alive,
    winner: victory,
  };
}
