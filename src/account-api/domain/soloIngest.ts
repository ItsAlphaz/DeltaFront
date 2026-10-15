import type { PartialGameRecord } from "@openfront/shared/WireSchemas";
import type { Pool } from "pg";
import { withTransaction } from "../db/tx";
import { awardSoloXp, type RewardEnv } from "./progression";
import type { SoloVerified } from "./soloVerify";
import { statsToJson } from "./stats";

/**
 * Storing a verified singleplayer match and paying its XP, in one transaction
 * keyed on the game's code: a repeat of a match that was already stored changes
 * nothing, and a failure leaves nothing behind, so the same match can simply be
 * tried again (domain/soloVerify.ts decides what is believed).
 *
 * What a solo match feeds, and what it does not:
 *   - it IS a game row (type Singleplayer, `counts_for_stats` false) with its
 *     player's row and XP result, so the XP history and "your XP" can read it;
 *   - it earns lifetime XP (level, rank, prestige) through `awardSoloXp`;
 *   - it never feeds the Public stats, Credits, the leaderboards, the clan
 *     threshold (`completed` is false), season XP, a challenge or clan XP.
 *
 * Nothing here is read from the browser's word except the player's display name
 * (already validated by the record schema). When the match happened is the time
 * the API received it, so a submission cannot choose which UTC day's soft cap it
 * falls under.
 */

export interface SoloIngestInput {
  /** The account that submitted it (the bearer's), never the record's persistentID. */
  userId: string;
  record: PartialGameRecord;
  verified: SoloVerified;
  /** When the submission was received. */
  receivedAt: Date;
  /** Present while the `progression` feature is on. */
  progression?: { validFlares: ReadonlySet<string> | null };
}

export type SoloIngestOutcome =
  /** Stored and paid (xpAwarded may be 0 when progression is off). */
  | { status: "stored"; xpAwarded: number }
  /** The game was already stored: nothing was changed. */
  | { status: "duplicate" }
  /** The account is not a live registered account any more. */
  | { status: "not_registered" };

export async function ingestSoloGame(
  pool: Pool,
  input: SoloIngestInput,
): Promise<SoloIngestOutcome> {
  const { record, verified } = input;
  const { info } = record;
  const config = info.config;
  const durationSeconds = Math.floor(verified.ticks / 10);
  const endedAt = input.receivedAt;
  const startedAt = new Date(endedAt.getTime() - durationSeconds * 1000);
  const result =
    verified.outcome === "victory" ? "victory" : ("defeat" as const);

  return withTransaction(pool, async (tx) => {
    const account = await tx.query<{ kind: string }>(
      `SELECT kind FROM users WHERE id = $1 AND deleted_at IS NULL FOR SHARE`,
      [input.userId],
    );
    if (account.rows.length === 0 || account.rows[0].kind !== "registered") {
      return { status: "not_registered" } as const;
    }
    const inserted = await tx.query<{ id: string }>(
      `INSERT INTO games
         (game_code, source, type, mode, difficulty, map, player_teams, ranked_type, public_game_type,
          started_at, ended_at, duration_s, human_players, winner, git_commit, server_letter,
          counts_for_stats, admin_modified)
       VALUES ($1, 'singleplayer', 'Singleplayer', $2, $3, $4, $5, NULL, NULL,
               $6, $7, $8, 1, $9, NULL, NULL, false, false)
       ON CONFLICT (game_code) DO NOTHING
       RETURNING id`,
      [
        info.gameID,
        config.gameMode ?? null,
        verified.setup.difficulty,
        config.gameMap,
        config.playerTeams === undefined ? null : String(config.playerTeams),
        startedAt,
        endedAt,
        Math.min(durationSeconds, 2_147_483_647),
        verified.winner === undefined ? null : JSON.stringify(verified.winner),
      ],
    );
    if (inserted.rows.length === 0) return { status: "duplicate" } as const;
    const gameId = inserted.rows[0].id;

    await tx.query(
      `INSERT INTO game_players
         (game_id, client_id, user_id, username, clan_tag, clan_id, result, completed, credits_awarded, stats)
       VALUES ($1, $2, $3, $4, NULL, NULL, $5, false, 0, $6::jsonb)`,
      [
        gameId,
        verified.clientID,
        input.userId,
        info.players[0].username,
        result,
        JSON.stringify(statsToJson(verified.stats ?? {})),
      ],
    );
    if (input.progression === undefined) {
      return { status: "stored", xpAwarded: 0 } as const;
    }
    const outcome = await awardSoloXp(tx, {
      userId: input.userId,
      gameCode: info.gameID,
      at: endedAt,
      verified,
      env: { validFlares: input.progression.validFlares },
    } satisfies Parameters<typeof awardSoloXp>[1] & { env: RewardEnv });
    await tx.query(
      `UPDATE game_players
          SET xp_result = $3::jsonb, xp_awarded = $4
        WHERE game_id = $1 AND client_id = $2`,
      [
        gameId,
        verified.clientID,
        JSON.stringify(outcome.result),
        outcome.xpAwarded,
      ],
    );
    return { status: "stored", xpAwarded: outcome.xpAwarded } as const;
  });
}
