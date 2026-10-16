import type { GameXpResponse } from "@openfront/shared/ApiSchemas";
import {
  progressState,
  rankForLevel,
} from "@openfront/shared/ProgressionRules";
import type { Pool } from "pg";

/**
 * Where a singleplayer match stands for its player, for
 * `GET /users/@me/solo/:gameId`: the one place that says whether it was never
 * received, is waiting, is being replayed, was paid (with the award) or was
 * refused (with why). Read from the submission row and the stored game, never
 * from a client.
 */

export type SoloStatus =
  /** No submission from this account for this game: it was never received (or was pruned and never paid). */
  | { status: "unknown" }
  | { status: "queued" }
  | { status: "verifying" }
  | { status: "paid"; result: GameXpResponse }
  | { status: "rejected"; reason: string; result: GameXpResponse };

/** The wire form of an eligible stored result, with the rank of the level it reached. */
export function eligibleXpBody(gameId: string, stored: object): GameXpResponse {
  const after = (stored as { after: ReturnType<typeof progressState> }).after;
  return {
    ...stored,
    gameId,
    after: { ...after, rank: rankForLevel(after.level) },
  } as unknown as GameXpResponse;
}

/**
 * Why a refused match earned nothing, as the reason the XP panel has words for.
 * Only the causes a player can understand get words of their own; everything
 * about the record or the replay is "solo_unverified".
 */
export function soloRefusalReason(code: string | null): string {
  switch (code) {
    case "no_result":
      return "left_early";
    case "no_action":
      return "no_action";
    case "not_spawned":
      return "not_spawned";
    default:
      return "solo_unverified";
  }
}

export async function soloStatusFor(
  db: Pick<Pool, "query">,
  userId: string,
  gameCode: string,
): Promise<SoloStatus> {
  const stored = await db.query<{ xp_result: Record<string, unknown> | null }>(
    `SELECT p.xp_result FROM game_players p JOIN games g ON g.id = p.game_id
      WHERE g.game_code = $1 AND p.user_id = $2 AND g.source = 'singleplayer'`,
    [gameCode, userId],
  );
  if (stored.rows.length > 0) {
    const result = stored.rows[0].xp_result;
    if (result?.eligible === true) {
      return { status: "paid", result: eligibleXpBody(gameCode, result) };
    }
    return {
      status: "paid",
      result: {
        gameId: gameCode,
        eligible: false,
        reason: String(result?.reason ?? "before_progression"),
      },
    };
  }
  const sub = await db.query<{ status: string; reason: string | null }>(
    "SELECT status, reason FROM solo_submissions WHERE game_code = $1 AND user_id = $2",
    [gameCode, userId],
  );
  if (sub.rows.length === 0) return { status: "unknown" };
  switch (sub.rows[0].status) {
    case "pending":
      return { status: "queued" };
    case "rejected":
      return {
        status: "rejected",
        reason: sub.rows[0].reason ?? "verify_failed",
        result: {
          gameId: gameCode,
          eligible: false,
          reason: soloRefusalReason(sub.rows[0].reason),
        },
      };
    // running, and a paid row whose game is not readable yet
    default:
      return { status: "verifying" };
  }
}
