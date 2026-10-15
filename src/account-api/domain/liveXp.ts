import type { LiveXpResponse } from "@openfront/shared/ApiSchemas";
import type {
  LiveProgress,
  LiveProgressPlayer,
} from "@openfront/shared/LiveProgress";
import { adminCommandInvalidatesResult } from "@openfront/shared/Permissions";
import type { Pool } from "pg";
import { ACCOUNT_RULES, ECONOMY } from "./constants";
import { earlyAwardOf, priorGamesWith } from "./progression";
import { RESULT_GRACE_TURNS, winnerClientIds } from "./stats";
import {
  computeMatchXp,
  computeReducedXp,
  isFreeForAll,
  progressionEligibility,
  reducedReasonFor,
  repeatPermille,
  type MatchXpResult,
  type ProgressionEligibility,
  type ProgressionReason,
} from "./xp";

/**
 * A running game's progression. The game server reports what only it knows
 * (LiveProgress); this turns it into the XP a player stands at with the very
 * functions that decide the final award (`computeMatchXp`, `computeReducedXp`,
 * `progressionEligibility`), so there is one set of rules.
 *
 * Nothing in this file writes to the ledger. What it works out is a preview,
 * except for a player who has been eliminated, whose reduced award `earlyXp.ts`
 * pays from the very same assessment, once (the unique ledger key on user +
 * game). The stored game, when it arrives, adopts that payment, so a preview, a
 * death award and the stored game can come in any order without a double award.
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
  /** The accounts whose death award is already paid (or adopted): not attempted again. */
  finalized: Set<string>;
}

/** The running games the game servers have reported, by game code. */
export class LiveXpStore {
  private readonly games = new Map<string, LiveGame>();

  set(code: string, game: LiveGame): void {
    // A re-report keeps the per-player facts already read.
    const previous = this.games.get(code);
    if (previous !== undefined) {
      game.contexts = previous.contexts;
      game.finalized = previous.finalized;
    }
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
    finalized: new Set(),
  });
}

// ---------------------------------------------------------------- the rules

/**
 * Whether this player's elimination is one that counts for the player who made
 * it: they were seen alive at a snapshot at or after the elimination minimum,
 * so they fell after it. (The same two-minute rule as `validEliminations`;
 * between snapshots a player's death is only bounded, so an unsure one is not
 * counted: the award is final once paid, so it is never rounded up.)
 */
function validDeath(victim: LiveProgressPlayer): boolean {
  return (
    victim.aliveAtTurn !== null &&
    victim.aliveAtTurn >= ECONOMY.minEliminationTick
  );
}

/**
 * Whether the player left while still in the game, before the result: gone now
 * while the game is on, or gone from before the result was determined once it
 * is. The live twin of `playerProgressionOutcome`'s presence rule, from the same
 * roster facts. An eliminated player is never held to it.
 */
export function leftBeforeResult(
  player: LiveProgressPlayer,
  resultTurn: number | null,
): boolean {
  if (player.leftTurn === null || player.connected) return false;
  if (resultTurn === null) return true;
  return player.leftTurn + RESULT_GRACE_TURNS < resultTurn;
}

/**
 * Whether an eliminated player had left, for good, before their empire fell: gone
 * now, and gone since before a snapshot at which the empire was still alive. A
 * player who left in the few seconds before the snapshot that caught the death is
 * not held to it (the live report cannot tell which came first); the stored game
 * decides exactly, and can only agree.
 */
function leftWhileAliveLive(player: LiveProgressPlayer): boolean {
  return (
    !player.connected &&
    player.leftTurn !== null &&
    player.aliveAtTurn !== null &&
    player.leftTurn + RESULT_GRACE_TURNS < player.aliveAtTurn
  );
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

/** What a player's part in a reported game is, before any XP is worked out. */
export type LiveAssessment =
  | { kind: "none"; reason: string; alive: boolean }
  | {
      kind: "eliminated";
      me: LiveProgressPlayer;
      eligibility: ProgressionEligibility;
      reason: ProgressionReason;
      /** The eliminations that count (each human victim once, who fell after the minimum). */
      eliminations: number;
      settled: boolean;
    }
  | {
      kind: "forfeited";
      me: LiveProgressPlayer;
      eligibility: ProgressionEligibility;
    }
  | {
      kind: "playing";
      me: LiveProgressPlayer;
      eligibility: ProgressionEligibility;
      eliminations: number;
      /** The other accounts the player-count multiplier reads. */
      others: string[];
      participants: number;
      settled: boolean;
      victory: boolean;
      ffa: boolean;
    };

/**
 * The one reading of a reported game for one account, shared by the preview and
 * by the death award so they can never disagree: what the game pays, whether the
 * player is out, still playing or gone, and the counts the formulas read. Null
 * when the player is not in the report or not an account.
 */
export function assess(game: LiveGame, userId: string): LiveAssessment | null {
  const { progress } = game;
  const me = progress.players.find(
    (p) => p.persistentID?.toLowerCase() === userId,
  );
  const kind = game.users.get(userId);
  if (me === undefined || kind === undefined) return null;
  const alive = !me.eliminated;

  if (kind === "guest") return { kind: "none", reason: "guest", alive };

  const resultTurn = progress.result?.resultTurn ?? null;
  const settled = progress.result !== null;

  // How far the game progresses, from the facts the final rule reads. A game
  // still on is assumed to last the two minutes it needs: only the stored game
  // can say it did not (and then it pays the reduced award instead of nothing).
  const eligibility = progressionEligibility({
    source: "server",
    type: progress.config.gameType,
    rankedType: progress.config.rankedType,
    durationSeconds: settled
      ? progress.elapsedSeconds
      : Math.max(progress.elapsedSeconds, ACCOUNT_RULES.countedGameMinSeconds),
    accountHolders: game.users.size,
    adminModified: adminActionsInvalidate(progress.adminActions),
    listed: progress.config.listed,
  });
  if (eligibility.mode === "none") {
    return { kind: "none", reason: eligibility.reason, alive };
  }
  // A player who has not taken a gameplay action has earned nothing yet (the
  // stored game pays no one for sitting still).
  if (!me.acted) return { kind: "none", reason: "no_action", alive };

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

  // Out: a reduced award, secured at the death, whether they stay or go after
  // it. (Abandoning the game while still in it, and being eliminated without
  // them, is leaving.)
  if (me.eliminated && !leftWhileAliveLive(me)) {
    return {
      kind: "eliminated",
      me,
      eligibility,
      reason: reducedReasonFor(eligibility),
      eliminations: victims.size,
      settled,
    };
  }

  // Still in the game and gone before the result forfeits everything.
  if (me.eliminated || leftBeforeResult(me, resultTurn)) {
    return { kind: "forfeited", me, eligibility };
  }

  // The humans the player-count multiplier reads: accounts who took part and
  // stayed (or fell after the minimum, whether they stayed or not).
  const participants = progress.players.filter(
    (p) =>
      p.persistentID !== null &&
      game.users.has(p.persistentID.toLowerCase()) &&
      p.acted &&
      (p.eliminated
        ? !(
            p.deadAtTurn !== null && p.deadAtTurn < ECONOMY.minEliminationTick
          ) && !leftWhileAliveLive(p)
        : !leftBeforeResult(p, resultTurn)),
  );
  const winners =
    progress.result?.winner === undefined
      ? new Set<string>()
      : winnerClientIds(progress.result.winner);
  return {
    kind: "playing",
    me,
    eligibility,
    eliminations: victims.size,
    others: participants
      .map((p) => (p.persistentID as string).toLowerCase())
      .filter((id) => id !== userId),
    participants: participants.length,
    settled,
    victory: settled && winners.has(me.clientID),
    ffa: isFreeForAll({ gameMode: progress.config.gameMode }),
  };
}

/** The response for a death whose reduced award has been paid. */
export function finalResponse(
  gameCode: string,
  early: Awaited<ReturnType<typeof earlyAwardOf>> & object,
): LiveXpResponse {
  return {
    gameId: gameCode,
    status: "final",
    mode: "reduced",
    reason: null,
    total: early.xpAwarded,
    breakdown: early.result.breakdown,
    pending: [],
    alive: false,
    winner: false,
  };
}

/**
 * What the player's match XP stands at in a running (or just settled) game, or
 * null when the API has neither a report of the game nor a death award for the
 * player. A death that has been paid answers "final" whether or not the game is
 * still reported (the award is in the database, not in memory).
 */
export async function liveXpFor(
  pool: Pick<Pool, "query">,
  gameCode: string,
  userId: string,
  store: LiveXpStore = liveXpStore,
  now: number = Date.now(),
): Promise<LiveXpResponse | null> {
  const game = store.get(gameCode, now);
  const assessment = game === undefined ? null : assess(game, userId);
  // Out of the game, or the game is no longer reported: a paid death award is
  // the answer. (Only the database knows it after a restart.)
  if (assessment === null || assessment.kind === "eliminated") {
    const early = await earlyAwardOf(pool, userId, gameCode);
    if (early !== null) return finalResponse(gameCode, early);
  }
  if (game === undefined || assessment === null) return null;
  const base = { alive: assessment.kind !== "eliminated" };

  switch (assessment.kind) {
    case "none":
      return none(gameCode, assessment.reason, { alive: assessment.alive });
    case "forfeited":
      return {
        ...none(gameCode, "left_early", base),
        status: "forfeited",
        mode: assessment.eligibility.mode === "full" ? "full" : "reduced",
      };
    case "eliminated": {
      // Not paid yet (the report only just carried the death): the amount it
      // will be.
      const context = await contextFor(pool, game, userId, [], now);
      const computed = computeReducedXp({
        reason: assessment.reason,
        eliminations: assessment.eliminations,
        earnedToday: context.earnedToday,
      });
      return {
        gameId: gameCode,
        status: assessment.settled ? "settled" : "pending",
        mode: "reduced",
        reason: null,
        total: computed.breakdown.total,
        breakdown: previewBreakdown(computed),
        pending: [],
        alive: false,
        winner: false,
      };
    }
    case "playing":
      return playing(pool, game, gameCode, userId, assessment, now);
  }
}

/** The shape the stored result has, so the same panel reads both. */
function previewBreakdown(
  computed: MatchXpResult,
): LiveXpResponse["breakdown"] {
  return {
    leftEarly: false,
    time: 0,
    feats: 0,
    subscriberPermille: 1000,
    ...computed.breakdown,
  };
}

async function playing(
  pool: Pick<Pool, "query">,
  game: LiveGame,
  gameCode: string,
  userId: string,
  a: Extract<LiveAssessment, { kind: "playing" }>,
  now: number,
): Promise<LiveXpResponse> {
  const context = await contextFor(pool, game, userId, a.others, now);
  let computed: MatchXpResult;
  let pending: LiveXpResponse["pending"];
  if (a.eligibility.mode === "reduced") {
    computed = computeReducedXp({
      reason: a.eligibility.reason,
      eliminations: a.eliminations,
      earnedToday: context.earnedToday,
    });
    // Nothing competitive in a reduced game: nothing left to decide.
    pending = [];
  } else {
    computed = computeMatchXp({
      victory: a.victory,
      // The winner's place is settled; anyone else's still depends on the
      // finish, so it is not paid in the preview until the stored game says.
      place: a.victory && a.ffa ? 1 : null,
      humans: game.progress.players.length,
      eliminations: a.eliminations,
      eligibleHumans: Math.max(1, a.participants),
      repeatPermille: context.repeat,
      firstGameAvailable: context.firstGameAvailable,
      firstWinAvailable: context.firstWinAvailable,
      earnedToday: context.earnedToday,
    });
    pending = [];
    if (!a.victory) {
      if (a.ffa) pending.push("placement");
      if (!a.settled) pending.push("victory");
    }
    pending.push("challenges", "season");
  }
  return {
    gameId: gameCode,
    status: a.settled ? "settled" : "live",
    mode: a.eligibility.mode === "full" ? "full" : "reduced",
    reason: null,
    total: computed.breakdown.total,
    breakdown: previewBreakdown(computed),
    pending,
    alive: true,
    winner: a.victory,
  };
}
