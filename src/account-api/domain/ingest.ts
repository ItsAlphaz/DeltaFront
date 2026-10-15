import { GameType } from "@openfront/engine-api/game/GameTypes";
import { adminCommandInvalidatesResult } from "@openfront/shared/Permissions";
import type { GameRecord } from "@openfront/shared/WireSchemas";
import { gzipSync } from "node:zlib";
import type { Pool, PoolClient } from "pg";
import { withTransaction } from "../db/tx";
import { ACCOUNT_RULES } from "./constants";
import { applyGameReward, gameReward } from "./economy";
import {
  awardPlayerXp,
  completedByClient,
  countsAsParticipant,
  outcomesByClient,
  seasonAt,
  type GameXpContext,
} from "./progression";
import {
  countedVerdict,
  isCompleted,
  modeBucket,
  resultFor,
  statsToJson,
  sumPlayerStats,
  type GameResult,
  type StatsJson,
} from "./stats";
import {
  adminCommandSenders,
  clientsWhoActed,
  isFreeForAll,
  placements,
  progressionEligibility,
  type ProgressionEligibility,
} from "./xp";

/**
 * Turns a finished game, as the game server submits it, into stored stats and
 * Credits (docs/DeltaFrontAccountsPlan.md section 8.3). Everything happens in
 * one transaction keyed on the game's code: a repeat of a game that was
 * already ingested changes nothing, and a failure leaves nothing behind, so
 * the same record can simply be sent again.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface IngestOutcome {
  /** The game was already stored; nothing was changed. */
  duplicate: boolean;
}

/**
 * Values the schema allows but a real game cannot have. Returns what is wrong,
 * or null. The record is rejected whole: a server that sends one is broken.
 */
export function recordProblem(
  record: Pick<GameRecord, "info">,
  now: number,
): string | null {
  const { start, end, duration } = record.info;
  if (!Number.isSafeInteger(start) || start < 0) return "invalid start time";
  if (!Number.isSafeInteger(end) || end < start)
    return "end time is before the start time";
  if (end > now + ACCOUNT_RULES.maxFutureEndMs)
    return "end time is in the future";
  if (!Number.isFinite(duration) || duration > Number.MAX_SAFE_INTEGER)
    return "invalid duration";
  return null;
}

interface ResolvedPlayer {
  userId: string;
  kind: "guest" | "registered";
  clientID: string;
  username: string;
  clanTag: string | null;
  stats: StatsJson;
  result: GameResult;
}

/** The accounts among a record's players: live users whose id the record carries, each counted once. */
async function resolvePlayers(
  pool: Pick<Pool, "query">,
  record: GameRecord,
): Promise<ResolvedPlayer[]> {
  const candidates = record.info.players.filter(
    (p) => p.persistentID !== null && UUID.test(p.persistentID),
  );
  if (candidates.length === 0) return [];
  const { rows } = await pool.query<{
    id: string;
    kind: "guest" | "registered";
  }>(
    "SELECT id, kind FROM users WHERE id = ANY($1::uuid[]) AND deleted_at IS NULL",
    [candidates.map((p) => (p.persistentID as string).toLowerCase())],
  );
  const live = new Map(rows.map((r) => [r.id, r.kind]));
  const seen = new Set<string>();
  const resolved: ResolvedPlayer[] = [];
  for (const player of candidates) {
    const userId = (player.persistentID as string).toLowerCase();
    const kind = live.get(userId);
    if (kind === undefined || seen.has(userId)) continue;
    seen.add(userId);
    resolved.push({
      userId,
      kind,
      clientID: player.clientID,
      username: player.username,
      clanTag: player.clanTag,
      stats: statsToJson(player.stats),
      result: resultFor(player.clientID, record.info.winner),
    });
  }
  // A fixed order, so concurrent games that share players lock rows in the
  // same sequence and never deadlock.
  return resolved.sort((a, b) => (a.userId < b.userId ? -1 : 1));
}

async function addToAggregate(
  tx: PoolClient,
  userId: string,
  gameType: string,
  mode: string,
  difficulty: string,
  result: GameResult,
  stats: StatsJson,
): Promise<void> {
  const key = [userId, gameType, mode, difficulty];
  await tx.query(
    `INSERT INTO player_stat_aggregates (user_id, game_type, mode, difficulty)
     VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
    key,
  );
  const { rows } = await tx.query<{ stats: StatsJson }>(
    `SELECT stats FROM player_stat_aggregates
      WHERE user_id = $1 AND game_type = $2 AND mode = $3 AND difficulty = $4
        FOR UPDATE`,
    key,
  );
  await tx.query(
    `UPDATE player_stat_aggregates
        SET wins = wins + $5, losses = losses + $6, total = total + 1,
            stats = $7::jsonb, updated_at = now()
      WHERE user_id = $1 AND game_type = $2 AND mode = $3 AND difficulty = $4`,
    [
      ...key,
      result === "victory" ? 1 : 0,
      result === "defeat" ? 1 : 0,
      JSON.stringify(sumPlayerStats(rows[0].stats, stats)),
    ],
  );
}

/**
 * Whether staff commands made this game a test that counts for nothing (no
 * stats, Credits, leaderboard entry or clan threshold).
 *
 * Not every command does: the owner's in a public or listed game leave the
 * result intact (adminCommandInvalidatesResult). What was run comes from the
 * record's `adminActions`, which the game server stamped from the authenticated
 * connection and the game's own state, and the verdict is recomputed here from
 * each action's role and game kind, so a stored "does not invalidate" is never
 * taken on trust. Fails closed: an `admin_command` in the recorded turns that
 * the metadata does not account for (an older server, a damaged record) counts
 * as invalidating.
 */
export function isAdminModified(
  record: Pick<GameRecord, "turns"> & {
    info?: Pick<GameRecord["info"], "adminActions">;
  },
): boolean {
  let inTurns = 0;
  for (const turn of record.turns) {
    for (const intent of turn.intents) {
      if (intent.type === "admin_command") inTurns++;
    }
  }
  if (inTurns === 0) return false;
  const actions = record.info?.adminActions ?? [];
  const accounted = actions.reduce((n, a) => n + a.count, 0);
  if (accounted < inTurns) return true;
  return actions.some(
    (a) =>
      a.invalidatesResult ||
      adminCommandInvalidatesResult(a.role, {
        public: a.public,
        listed: a.listed,
      }),
  );
}

export interface IngestOptions {
  /**
   * Present while the `progression` feature is on: games award XP. Absent, a
   * game is stored exactly as before and its players' `xp_result` stays null.
   */
  progression?: {
    /** Catalog flares that can be granted as rewards; null with no catalog. */
    validFlares: ReadonlySet<string> | null;
  };
}

export async function ingestGameRecord(
  pool: Pool,
  record: GameRecord,
  rawJson: string,
  options: IngestOptions = {},
): Promise<IngestOutcome> {
  const { info, gitCommit } = record;
  const config = info.config as unknown as Record<string, unknown>;
  const text = (v: unknown): string | null =>
    v === undefined || v === null ? null : String(v);
  const type = text(config.gameType);
  const mode = text(config.gameMode);
  const difficulty = text(config.difficulty);
  const playerTeams = text(config.playerTeams);
  const rankedType = text(config.rankedType);
  const durationSeconds = Math.max(0, Math.floor(info.duration));

  const players = await resolvePlayers(pool, record);
  // A game in which staff testing commands changed the state is for testing: it
  // feeds no stats, no Credits, no leaderboard and no clan threshold, unless
  // every command was the owner's in a public or listed game. Its players still
  // earn XP, at the reduced rate (lifetime only). Decided here from what the
  // game server recorded (see isAdminModified), never from a client, and stored
  // so the panel can show it.
  const adminModified = isAdminModified(record);
  const verdict = countedVerdict({
    source: "server",
    type: type ?? undefined,
    rankedType,
    durationSeconds,
    accountHolders: players.length,
    adminModified,
  });
  const counted = verdict.counted;
  // How far the game advances progression: the stats rule decides "full"; a
  // private, unlisted, low-population or short game, or one staff commands
  // changed, is "reduced" instead of nothing.
  const eligibility = progressionEligibility({
    source: "server",
    type: type ?? undefined,
    rankedType,
    durationSeconds,
    accountHolders: players.length,
    adminModified,
    listed: info.listed ?? null,
  });
  const endedAt = new Date(info.end);

  return withTransaction(pool, async (tx) => {
    const inserted = await tx.query<{ id: string }>(
      `INSERT INTO games
         (game_code, source, type, mode, difficulty, map, player_teams, ranked_type, public_game_type,
          started_at, ended_at, duration_s, human_players, winner, git_commit, server_letter, counts_for_stats, admin_modified)
       VALUES ($1, 'server', $2, $3, $4, $5, $6, $7, $8, to_timestamp($9::double precision / 1000),
               to_timestamp($10::double precision / 1000), $11, $12, $13, $14, $15, $16, $17)
       ON CONFLICT (game_code) DO NOTHING
       RETURNING id`,
      [
        info.gameID,
        type,
        mode,
        difficulty,
        text(config.gameMap),
        playerTeams,
        rankedType,
        text(info.publicGameType),
        info.start,
        info.end,
        Math.min(durationSeconds, 2_147_483_647),
        info.players.length,
        info.winner === undefined ? null : JSON.stringify(info.winner),
        gitCommit,
        info.gameID.charAt(0).toLowerCase(),
        counted,
        adminModified,
      ],
    );
    // A repeat of a stored game (the server retried, or two submissions raced
    // and this one lost) is not an error and changes nothing.
    if (inserted.rows.length === 0) return { duplicate: true };
    const gameId = inserted.rows[0].id;

    const gz = gzipSync(Buffer.from(rawJson, "utf8"));
    await tx.query(
      `INSERT INTO game_records (game_id, record_gz, bytes, expires_at)
       VALUES ($1, $2, $3, now() + make_interval(days => $4))`,
      [gameId, gz, gz.length, ACCOUNT_RULES.gameRecordRetentionDays],
    );

    const aggregated =
      !adminModified &&
      (type === GameType.Private || (counted && type === GameType.Public));
    const xpContext =
      options.progression === undefined
        ? null
        : await buildXpContext(tx, {
            record,
            eligibility,
            players,
            endedAt,
            map: text(config.gameMap),
            isFfa: isFreeForAll(config),
            validFlares: options.progression.validFlares,
          });
    for (const player of players) {
      const completed = isCompleted(record, player.clientID, counted);
      if (aggregated && type !== null) {
        await addToAggregate(
          tx,
          player.userId,
          type,
          modeBucket(mode, playerTeams),
          difficulty ?? "",
          player.result,
          player.stats,
        );
      }
      const earned = adminModified
        ? 0
        : gameReward(completed, player.result === "victory");
      const granted =
        earned > 0
          ? await applyGameReward(
              tx,
              player.userId,
              info.gameID,
              endedAt,
              earned,
            )
          : 0;
      const stored = await tx.query<{ clan_id: string | null }>(
        `INSERT INTO game_players
           (game_id, client_id, user_id, username, clan_tag, clan_id, result, completed, credits_awarded, stats)
         VALUES ($1, $2, $3, $4, $5::text,
                 (SELECT c.id FROM clans c JOIN clan_members m ON m.clan_id = c.id
                   WHERE c.tag = $5::text::citext AND c.disbanded_at IS NULL AND m.user_id = $3::uuid),
                 $6, $7, $8, $9::jsonb)
         ON CONFLICT (game_id, client_id) DO NOTHING
         RETURNING clan_id::text AS clan_id`,
        [
          gameId,
          player.clientID,
          player.userId,
          player.username,
          player.clanTag,
          player.result,
          completed,
          granted,
          JSON.stringify(player.stats),
        ],
      );
      if (xpContext !== null && stored.rows.length > 0) {
        const outcome = await awardPlayerXp(tx, xpContext, gameId, {
          userId: player.userId,
          clientID: player.clientID,
          kind: player.kind,
          clanId: stored.rows[0].clan_id,
        });
        await tx.query(
          `UPDATE game_players
              SET xp_result = $5::jsonb,
                  xp_awarded = $3,
                  clan_xp = $4
            WHERE game_id = $1 AND client_id = $2`,
          [
            gameId,
            player.clientID,
            outcome.xpAwarded,
            outcome.clanXp,
            JSON.stringify(outcome.result),
          ],
        );
      }
    }
    return { duplicate: false };
  });
}

/**
 * Facts about the finished game that every player's XP reads, worked out once:
 * who completed it, who acted, who sent staff commands, the placements and the
 * season it counts for. Nothing here comes from a client.
 */
async function buildXpContext(
  tx: PoolClient,
  input: {
    record: GameRecord;
    eligibility: ProgressionEligibility;
    players: ResolvedPlayer[];
    endedAt: Date;
    map: string | null;
    isFfa: boolean;
    validFlares: ReadonlySet<string> | null;
  },
): Promise<GameXpContext> {
  const { record, eligibility, players } = input;
  // The completed-game rule is the Credits one: it says who stayed to the
  // result. XP reads it for the players still in the game; an eliminated player's
  // award does not depend on it (see playerIneligibleReason).
  const outcomes = outcomesByClient(
    record,
    players.map((p) => p.clientID),
    eligibility.mode !== "none",
  );
  const completed = completedByClient(outcomes);
  const acted = clientsWhoActed(record.turns);
  const eligible = players
    .filter((p) =>
      countsAsParticipant(
        record,
        completed.get(p.clientID) === true,
        acted.has(p.clientID),
        p.clientID,
      ),
    )
    .map((p) => ({ userId: p.userId, clientID: p.clientID }));
  return {
    record,
    gameCode: record.info.gameID,
    endedAt: input.endedAt,
    eligibility,
    isFfa: input.isFfa,
    placement: placements(record, input.isFfa),
    acted,
    adminSenders: adminCommandSenders(record.turns),
    outcomes,
    completed,
    eligible,
    map: input.map,
    // Only a full game counts for a season: reduced XP is lifetime XP only.
    season:
      eligibility.mode === "full" ? await seasonAt(tx, input.endedAt) : null,
    env: { validFlares: input.validFlares },
  };
}
