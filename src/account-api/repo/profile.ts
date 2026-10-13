import type { PublicPlayerGameSchema } from "@openfront/shared/ApiSchemas";
import type { z } from "zod";
import { ACCOUNT_RULES } from "../domain/constants";
import {
  modeBucket,
  type AggregateRow,
  type RecentRow,
  type StatsJson,
} from "../domain/stats";
import type { Db } from "./users";

/** A player's stored aggregates, one row per (game type, mode, difficulty). */
export async function aggregatesOf(
  db: Db,
  userId: string,
): Promise<AggregateRow[]> {
  const { rows } = await db.query<{
    game_type: string;
    mode: string;
    difficulty: string;
    wins: string;
    losses: string;
    total: string;
    stats: StatsJson;
  }>(
    `SELECT game_type, mode, difficulty, wins::text AS wins, losses::text AS losses,
            total::text AS total, stats
       FROM player_stat_aggregates WHERE user_id = $1`,
    [userId],
  );
  return rows.map((r) => ({
    gameType: r.game_type,
    mode: r.mode,
    difficulty: r.difficulty,
    wins: r.wins,
    losses: r.losses,
    total: r.total,
    stats: r.stats,
  }));
}

/**
 * The newest games that feed the stats tree (counted Public games and
 * Private games), newest first, for the "recent" windows.
 */
export async function recentRowsOf(
  db: Db,
  userId: string,
): Promise<RecentRow[]> {
  const { rows } = await db.query<{
    type: string;
    mode: string | null;
    player_teams: string | null;
    difficulty: string | null;
    result: string;
  }>(
    `SELECT g.type, g.mode, g.player_teams, g.difficulty, p.result
       FROM game_players p JOIN games g ON g.id = p.game_id
      WHERE p.user_id = $1 AND (g.counts_for_stats OR g.type = 'Private')
      ORDER BY p.game_id DESC LIMIT $2`,
    [userId, ACCOUNT_RULES.recentLookupRows],
  );
  return rows.map((r) => ({
    gameType: r.type,
    mode: modeBucket(r.mode, r.player_teams),
    difficulty: r.difficulty ?? "",
    won: r.result === "victory",
  }));
}

export interface HistoryFilter {
  /** `ffa`, `team`, `hvn`, `ranked`: a mode bucket, resolved off the game's columns. */
  mode?: "ffa" | "team" | "hvn" | "ranked";
  /** `public`, `private`, `singleplayer`: the game's type. */
  type?: "public" | "private" | "singleplayer";
}

const TYPE_VALUES = {
  public: "Public",
  private: "Private",
  singleplayer: "Singleplayer",
} as const;

type HistoryGame = z.input<typeof PublicPlayerGameSchema>;

/**
 * One page of a player's games, newest first by game id (insertion order,
 * which never changes), strictly before `before`. Fetches one row more than
 * `limit` so the caller can tell whether another page exists.
 */
export async function historyPage(
  db: Db,
  userId: string,
  filter: HistoryFilter,
  before: string | null,
  limit: number,
): Promise<{ games: Array<HistoryGame & { id: string }>; hasMore: boolean }> {
  const where = ["p.user_id = $1"];
  const params: unknown[] = [userId];
  const add = (value: unknown): string => {
    params.push(value);
    return `$${params.length}`;
  };
  if (before !== null) where.push(`p.game_id < ${add(before)}::bigint`);
  if (filter.type !== undefined)
    where.push(`g.type = ${add(TYPE_VALUES[filter.type])}`);
  switch (filter.mode) {
    case "ranked":
      where.push("g.ranked_type IS NOT NULL");
      break;
    case "hvn":
      where.push(
        "g.ranked_type IS NULL AND g.player_teams = 'Humans Vs Nations'",
      );
      break;
    case "team":
      where.push(
        "g.ranked_type IS NULL AND g.mode = 'Team' AND g.player_teams IS DISTINCT FROM 'Humans Vs Nations'",
      );
      break;
    case "ffa":
      where.push("g.ranked_type IS NULL AND g.mode = 'Free For All'");
      break;
  }
  const { rows } = await db.query<{
    id: string;
    game_code: string;
    started_at: Date;
    duration_s: number;
    map: string | null;
    mode: string | null;
    type: string;
    player_teams: string | null;
    ranked_type: string | null;
    result: "victory" | "defeat" | "incomplete";
    human_players: number | null;
    username: string;
    clan_tag: string | null;
  }>(
    `SELECT p.game_id::text AS id, g.game_code, g.started_at, g.duration_s, g.map, g.mode, g.type,
            g.player_teams, g.ranked_type, p.result, g.human_players, p.username, p.clan_tag
       FROM game_players p JOIN games g ON g.id = p.game_id
      WHERE ${where.join(" AND ")}
      ORDER BY p.game_id DESC
      LIMIT ${add(limit + 1)}`,
    params,
  );
  const hasMore = rows.length > limit;
  return {
    hasMore,
    games: rows.slice(0, limit).map((r) => ({
      id: r.id,
      gameId: r.game_code,
      start: r.started_at.toISOString(),
      durationSeconds: Math.max(0, r.duration_s),
      map: (r.map ?? "").trim(),
      mode: r.mode ?? "",
      type: r.type,
      playerTeams: r.player_teams,
      rankedType: r.ranked_type ?? "",
      result: r.result,
      totalPlayers: r.human_players,
      username: r.username,
      clanTag: r.clan_tag,
    })),
  };
}

/** A player's Credits balance. A user without a wallet row (never expected) has none. */
export async function creditsOf(db: Db, userId: string): Promise<number> {
  const { rows } = await db.query<{ credits: string }>(
    "SELECT credits::text AS credits FROM wallets WHERE user_id = $1",
    [userId],
  );
  return rows.length === 0 ? 0 : Number(rows[0].credits);
}
