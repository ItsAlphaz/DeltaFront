import {
  GameMode,
  HumansVsNations,
} from "@openfront/engine-api/game/GameTypes";
import type {
  ClanBan,
  ClanGame,
  ClanInfo,
  ClanJoinRequest,
  ClanLeaderboardEntry,
  ClanMember,
  ClanMemberStats,
} from "@openfront/shared/ClanApiSchemas";
import type { ClanRole, ReservedClanNames } from "../domain/clans";
import { CLAN_RULES } from "../domain/constants";
import { displayUsername } from "../domain/usernames";
import type { Db } from "./users";

/**
 * Reads for the clan routes. Every query takes the clan by its internal id
 * (looked up from the tag by the caller) and every row it returns names people
 * by `public_id` only: no user id, email or provider data leaves this module.
 */

export interface ClanRow {
  id: string;
  tag: string;
  name: string;
  description: string;
  discordUrl: string | null;
  isOpen: boolean;
  createdAt: Date;
  memberCount: number;
}

interface RawClan {
  id: string;
  tag: string;
  name: string;
  description: string;
  discord_url: string | null;
  is_open: boolean;
  created_at: Date;
  member_count: number;
}

const CLAN_COLUMNS = `c.id::text AS id, c.tag::text AS tag, c.name::text AS name, c.description,
       c.discord_url, c.is_open, c.created_at,
       (SELECT count(*)::int FROM clan_members m WHERE m.clan_id = c.id) AS member_count`;

const toRow = (r: RawClan): ClanRow => ({
  id: r.id,
  tag: r.tag,
  name: r.name,
  description: r.description,
  discordUrl: r.discord_url,
  isOpen: r.is_open,
  createdAt: r.created_at,
  memberCount: r.member_count,
});

/** The wire shape of a clan. The clan-currency balances are left out: V1 has none. */
export function toClanInfo(row: ClanRow): ClanInfo {
  return {
    name: row.name,
    tag: row.tag,
    description: row.description,
    discordUrl: row.discordUrl,
    isOpen: row.isOpen,
    createdAt: row.createdAt.toISOString(),
    memberCount: row.memberCount,
  };
}

/** A live (not disbanded) clan by its upper-case tag. */
export async function clanByTag(db: Db, tag: string): Promise<ClanRow | null> {
  const { rows } = await db.query<RawClan>(
    `SELECT ${CLAN_COLUMNS} FROM clans c WHERE c.tag = $1 AND c.disbanded_at IS NULL`,
    [tag],
  );
  return rows.length === 0 ? null : toRow(rows[0]);
}

const escapeLike = (s: string): string => s.replace(/[\\%_]/g, "\\$&");

/** Live clans, biggest first; `search` matches a tag prefix or part of a name. */
export async function browseClans(
  db: Db,
  search: string | null,
  page: number,
  limit: number,
): Promise<{ results: ClanRow[]; total: number }> {
  const params: unknown[] = [];
  let where = "c.disbanded_at IS NULL";
  if (search !== null) {
    params.push(escapeLike(search.toLowerCase()));
    where += ` AND (lower(c.tag::text) LIKE $1 || '%' OR lower(c.name::text) LIKE '%' || $1 || '%')`;
  }
  const total = await db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM clans c WHERE ${where}`,
    params,
  );
  const { rows } = await db.query<RawClan>(
    `SELECT ${CLAN_COLUMNS} FROM clans c WHERE ${where}
      ORDER BY member_count DESC, c.created_at DESC, c.id DESC
      LIMIT ${limit} OFFSET ${(page - 1) * limit}`,
    params,
  );
  return { results: rows.map(toRow), total: total.rows[0].n };
}

export interface MyClan {
  tag: string;
  name: string;
  role: ClanRole;
  joinedAt: string;
  memberCount: number;
}

/** The clans an account belongs to (at most one) and its pending join requests, for `/users/@me`. */
export async function clansOfUser(
  db: Db,
  userId: string,
): Promise<{
  clans: MyClan[];
  requests: Array<{ tag: string; name: string; createdAt: string }>;
}> {
  const [clans, requests] = await Promise.all([
    db.query<{
      tag: string;
      name: string;
      role: ClanRole;
      joined_at: Date;
      member_count: number;
    }>(
      `SELECT c.tag::text AS tag, c.name::text AS name, m.role, m.joined_at,
              (SELECT count(*)::int FROM clan_members x WHERE x.clan_id = c.id) AS member_count
         FROM clan_members m JOIN clans c ON c.id = m.clan_id
        WHERE m.user_id = $1 AND c.disbanded_at IS NULL
        ORDER BY c.tag`,
      [userId],
    ),
    db.query<{ tag: string; name: string; created_at: Date }>(
      `SELECT c.tag::text AS tag, c.name::text AS name, r.created_at
         FROM clan_join_requests r JOIN clans c ON c.id = r.clan_id
        WHERE r.user_id = $1 AND c.disbanded_at IS NULL
        ORDER BY r.created_at`,
      [userId],
    ),
  ]);
  return {
    clans: clans.rows.map((r) => ({
      tag: r.tag,
      name: r.name,
      role: r.role,
      joinedAt: r.joined_at.toISOString(),
      memberCount: r.member_count,
    })),
    requests: requests.rows.map((r) => ({
      tag: r.tag,
      name: r.name,
      createdAt: r.created_at.toISOString(),
    })),
  };
}

/** The role of `userId` in clan `clanId`, or null. */
export async function roleIn(
  db: Db,
  clanId: string,
  userId: string,
): Promise<ClanRole | null> {
  const { rows } = await db.query<{ role: ClanRole }>(
    "SELECT role FROM clan_members WHERE clan_id = $1 AND user_id = $2",
    [clanId, userId],
  );
  return rows.length === 0 ? null : rows[0].role;
}

// ------------------------------------------------------------- members

export type MemberSort =
  | "default"
  | "winsTotal"
  | "lossesTotal"
  | "winsFfa"
  | "lossesFfa"
  | "winsTeam"
  | "lossesTeam"
  | "winsHvn"
  | "lossesHvn"
  | "winsRanked"
  | "lossesRanked"
  | "wins1v1"
  | "losses1v1";

const SORTS: readonly MemberSort[] = [
  "default",
  "winsTotal",
  "lossesTotal",
  "winsFfa",
  "lossesFfa",
  "winsTeam",
  "lossesTeam",
  "winsHvn",
  "lossesHvn",
  "winsRanked",
  "lossesRanked",
  "wins1v1",
  "losses1v1",
];

export const isMemberSort = (value: unknown): value is MemberSort =>
  typeof value === "string" && (SORTS as readonly string[]).includes(value);

const emptyWL = () => ({ wins: 0, losses: 0 });

const blankStats = (): ClanMemberStats => ({
  total: emptyWL(),
  ffa: emptyWL(),
  team: emptyWL(),
  hvn: emptyWL(),
  duos: emptyWL(),
  trios: emptyWL(),
  quads: emptyWL(),
  "2": emptyWL(),
  "3": emptyWL(),
  "4": emptyWL(),
  "5": emptyWL(),
  "6": emptyWL(),
  "7": emptyWL(),
  // no ranked ladder in V1
  ranked: emptyWL(),
  "1v1": emptyWL(),
});

const TEAM_BUCKETS: Record<string, keyof ClanMemberStats> = {
  Duos: "duos",
  Trios: "trios",
  Quads: "quads",
  "2": "2",
  "3": "3",
  "4": "4",
  "5": "5",
  "6": "6",
  "7": "7",
};

/**
 * Win/loss counts per mode for each user, from counted public games only (the
 * same games the leaderboard and Credits use). Users with no games get zeros.
 */
export async function memberStatsFor(
  db: Db,
  userIds: string[],
): Promise<Map<string, ClanMemberStats>> {
  const out = new Map<string, ClanMemberStats>();
  for (const id of userIds) out.set(id, blankStats());
  if (userIds.length === 0) return out;
  const { rows } = await db.query<{
    user_id: string;
    mode: string | null;
    player_teams: string | null;
    result: string;
    n: number;
  }>(
    `SELECT p.user_id, g.mode, g.player_teams, p.result, count(*)::int AS n
       FROM game_players p JOIN games g ON g.id = p.game_id
      WHERE p.user_id = ANY($1::uuid[]) AND g.counts_for_stats AND g.type = 'Public'
        AND p.result IN ('victory', 'defeat')
      GROUP BY p.user_id, g.mode, g.player_teams, p.result`,
    [userIds],
  );
  for (const r of rows) {
    const stats = out.get(r.user_id);
    if (stats === undefined) continue;
    const side = r.result === "victory" ? "wins" : "losses";
    const add = (key: keyof ClanMemberStats) => {
      stats[key][side] += r.n;
    };
    add("total");
    if (r.player_teams === HumansVsNations) add("hvn");
    else if (r.mode === GameMode.FFA) add("ffa");
    else if (r.mode === GameMode.Team) add("team");
    const bucket =
      r.player_teams === null ? undefined : TEAM_BUCKETS[r.player_teams];
    if (bucket !== undefined) add(bucket);
  }
  return out;
}

const SORT_FIELD: Record<
  Exclude<MemberSort, "default">,
  [keyof ClanMemberStats, "wins" | "losses"]
> = {
  winsTotal: ["total", "wins"],
  lossesTotal: ["total", "losses"],
  winsFfa: ["ffa", "wins"],
  lossesFfa: ["ffa", "losses"],
  winsTeam: ["team", "wins"],
  lossesTeam: ["team", "losses"],
  winsHvn: ["hvn", "wins"],
  lossesHvn: ["hvn", "losses"],
  winsRanked: ["ranked", "wins"],
  lossesRanked: ["ranked", "losses"],
  wins1v1: ["1v1", "wins"],
  losses1v1: ["1v1", "losses"],
};

const ROLE_RANK: Record<ClanRole, number> = {
  leader: 0,
  officer: 1,
  member: 2,
};

/**
 * One page of a clan's members. The default order is leader, officers, then
 * members by join date; a stats sort orders by that statistic (ties by the
 * default order). Clans are small, so the page is cut after sorting.
 */
export async function membersPage(
  db: Db,
  clanId: string,
  opts: {
    page: number;
    limit: number;
    sort: MemberSort;
    order: "asc" | "desc" | null;
    search: string | null;
  },
): Promise<{ results: ClanMember[]; total: number }> {
  const params: unknown[] = [clanId];
  let where = "m.clan_id = $1 AND u.deleted_at IS NULL";
  if (opts.search !== null) {
    params.push(escapeLike(opts.search.toLowerCase()));
    where += ` AND (lower(coalesce(u.username_base, '')) LIKE '%' || $2 || '%' OR lower(u.public_id) LIKE '%' || $2 || '%')`;
  }
  const { rows } = await db.query<{
    user_id: string;
    public_id: string;
    username_base: string | null;
    username_discriminator: string | null;
    role: ClanRole;
    joined_at: Date;
  }>(
    `SELECT u.id AS user_id, u.public_id, u.username_base, u.username_discriminator, m.role, m.joined_at
       FROM clan_members m JOIN users u ON u.id = m.user_id
      WHERE ${where}`,
    params,
  );
  const stats = await memberStatsFor(
    db,
    rows.map((r) => r.user_id),
  );
  const byDefault = (a: (typeof rows)[number], b: (typeof rows)[number]) =>
    ROLE_RANK[a.role] - ROLE_RANK[b.role] ||
    a.joined_at.getTime() - b.joined_at.getTime() ||
    (a.public_id < b.public_id ? -1 : 1);
  const sorted = [...rows];
  if (opts.sort === "default") {
    sorted.sort(byDefault);
    if (opts.order === "desc") sorted.reverse();
  } else {
    const [key, side] = SORT_FIELD[opts.sort];
    const dir = opts.order === "asc" ? 1 : -1;
    sorted.sort(
      (a, b) =>
        dir *
          (stats.get(a.user_id)![key][side] -
            stats.get(b.user_id)![key][side]) || byDefault(a, b),
    );
  }
  const start = (opts.page - 1) * opts.limit;
  return {
    total: rows.length,
    results: sorted.slice(start, start + opts.limit).map((r) => ({
      role: r.role,
      joinedAt: r.joined_at.toISOString(),
      publicId: r.public_id,
      username: displayUsername(r.username_base, r.username_discriminator),
      stats: stats.get(r.user_id),
    })),
  };
}

export async function pendingRequestCount(
  db: Db,
  clanId: string,
): Promise<number> {
  const { rows } = await db.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM clan_join_requests WHERE clan_id = $1",
    [clanId],
  );
  return rows[0].n;
}

export async function requestsPage(
  db: Db,
  clanId: string,
  page: number,
  limit: number,
): Promise<{ results: ClanJoinRequest[]; total: number }> {
  const total = await pendingRequestCount(db, clanId);
  const { rows } = await db.query<{
    public_id: string;
    username_base: string | null;
    username_discriminator: string | null;
    created_at: Date;
  }>(
    `SELECT u.public_id, u.username_base, u.username_discriminator, r.created_at
       FROM clan_join_requests r JOIN users u ON u.id = r.user_id
      WHERE r.clan_id = $1
      ORDER BY r.created_at, u.public_id
      LIMIT ${limit} OFFSET ${(page - 1) * limit}`,
    [clanId],
  );
  return {
    total,
    results: rows.map((r) => ({
      publicId: r.public_id,
      username: displayUsername(r.username_base, r.username_discriminator),
      createdAt: r.created_at.toISOString(),
    })),
  };
}

export async function bansPage(
  db: Db,
  clanId: string,
  page: number,
  limit: number,
): Promise<{ results: ClanBan[]; total: number }> {
  const total = await db.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM clan_bans WHERE clan_id = $1",
    [clanId],
  );
  const { rows } = await db.query<{
    public_id: string;
    username_base: string | null;
    username_discriminator: string | null;
    by_public_id: string | null;
    by_base: string | null;
    by_discriminator: string | null;
    reason: string | null;
    created_at: Date;
  }>(
    `SELECT u.public_id, u.username_base, u.username_discriminator,
            b.public_id AS by_public_id, b.username_base AS by_base, b.username_discriminator AS by_discriminator,
            x.reason, x.created_at
       FROM clan_bans x JOIN users u ON u.id = x.user_id LEFT JOIN users b ON b.id = x.banned_by
      WHERE x.clan_id = $1
      ORDER BY x.created_at DESC, u.public_id
      LIMIT ${limit} OFFSET ${(page - 1) * limit}`,
    [clanId],
  );
  return {
    total: total.rows[0].n,
    results: rows.map((r) => ({
      publicId: r.public_id,
      username: displayUsername(r.username_base, r.username_discriminator),
      bannedBy: r.by_public_id ?? "",
      bannedByUsername: displayUsername(r.by_base, r.by_discriminator),
      reason: r.reason,
      createdAt: r.created_at.toISOString(),
    })),
  };
}

// ----------------------------------------------------------------- games

export type ClanGameFilterMode = "ffa" | "team" | "hvn" | "ranked";

/**
 * A page of the games the clan's members played under its tag, newest first
 * (keyset on the game id). A game appears once, with each clan player and
 * whether they won. A clan "wins" a game when any of its players did.
 */
export async function clanGamesPage(
  db: Db,
  clanId: string,
  filter: ClanGameFilterMode | undefined,
  before: string | null,
  limit: number,
): Promise<{ games: Array<ClanGame & { id: string }>; hasMore: boolean }> {
  const params: unknown[] = [clanId];
  const where = ["p.clan_id = $1"];
  if (before !== null) {
    params.push(before);
    where.push(`p.game_id < $${params.length}::bigint`);
  }
  switch (filter) {
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
    player_teams: string | null;
    ranked_type: string | null;
    human_players: number | null;
    players: Array<{
      publicId: string | null;
      username: string;
      result: string;
    }>;
  }>(
    `SELECT g.id::text AS id, g.game_code, g.started_at, g.duration_s, g.map, g.mode,
            g.player_teams, g.ranked_type, g.human_players,
            json_agg(json_build_object('publicId', u.public_id, 'username', p.username, 'result', p.result)
                     ORDER BY p.client_id) AS players
       FROM game_players p
       JOIN games g ON g.id = p.game_id
       LEFT JOIN users u ON u.id = p.user_id
      WHERE ${where.join(" AND ")}
      GROUP BY g.id
      ORDER BY g.id DESC
      LIMIT ${limit + 1}`,
    params,
  );
  const hasMore = rows.length > limit;
  return {
    hasMore,
    games: rows.slice(0, limit).map((r) => {
      const clanPlayers = r.players.filter((p) => p.publicId !== null);
      const won = clanPlayers.some((p) => p.result === "victory");
      const lost = clanPlayers.some((p) => p.result === "defeat");
      return {
        id: r.id,
        gameId: r.game_code,
        start: r.started_at.toISOString(),
        durationSeconds: Math.max(0, r.duration_s),
        map: (r.map ?? "").trim(),
        mode: r.mode ?? undefined,
        playerTeams: r.player_teams,
        rankedType: r.ranked_type ?? undefined,
        result: won ? "victory" : lost ? "defeat" : "incomplete",
        totalPlayers: r.human_players,
        clanPlayers: clanPlayers.map((p) => ({
          publicId: p.publicId!,
          username: p.username,
          won: p.result === "victory",
        })),
      };
    }),
  };
}

// ------------------------------------------------- tags and leaderboard

/**
 * Every tag nobody but its owner may wear: the reserved list, every live
 * clan's tag and every held tag (a disbanded clan's, until its hold ends).
 * This is what the game server's `/reserved_clan_tags` serves.
 */
export async function reservedTagList(
  db: Db,
  reserved: ReservedClanNames,
  now: Date = new Date(),
): Promise<string[]> {
  const { rows } = await db.query<{ tag: string }>(
    `SELECT tag::text AS tag FROM clans WHERE disbanded_at IS NULL
     UNION
     SELECT tag::text FROM clan_tag_holds WHERE reusable_after > $1`,
    [now],
  );
  return [
    ...new Set([...reserved.tags, ...rows.map((r) => r.tag.toUpperCase())]),
  ].sort();
}

/** Whether a tag is taken in any way (a clan, a hold, or the reserved list). */
export async function tagIsRegistered(
  db: Db,
  reserved: ReservedClanNames,
  tag: string,
  now: Date = new Date(),
): Promise<boolean> {
  if (reserved.tags.has(tag)) return true;
  const { rows } = await db.query(
    `SELECT 1 FROM clans WHERE tag = $1 AND disbanded_at IS NULL
     UNION ALL
     SELECT 1 FROM clan_tag_holds WHERE tag = $1 AND reusable_after > $2`,
    [tag, now],
  );
  return rows.length > 0;
}

/**
 * The clan board: for the counted public games of the last
 * `leaderboardDays` days, per clan with at least `leaderboardMinClanGames`
 * games. `games` is distinct games with a clan player, `wins` and `losses` are
 * games a clan player won or (with none winning) lost, `playerSessions` is the
 * clan players' appearances, and the weighted figures count those appearances
 * (a win by three members weighs three). Ordered by the weighted ratio.
 */
export async function clanLeaderboard(
  db: Db,
  now: Date = new Date(),
): Promise<{ start: Date; end: Date; clans: ClanLeaderboardEntry[] }> {
  const start = new Date(
    now.getTime() - CLAN_RULES.leaderboardDays * 86_400_000,
  );
  const { rows } = await db.query<{
    tag: string;
    games: number;
    wins: number;
    losses: number;
    sessions: number;
    w_wins: number;
    w_losses: number;
  }>(
    `WITH per_game AS (
       SELECT p.clan_id, p.game_id,
              count(*)::int AS sessions,
              count(*) FILTER (WHERE p.result = 'victory')::int AS won,
              count(*) FILTER (WHERE p.result = 'defeat')::int AS lost
         FROM game_players p JOIN games g ON g.id = p.game_id
        WHERE p.clan_id IS NOT NULL AND g.counts_for_stats AND g.type = 'Public'
          AND g.ended_at >= $1 AND g.ended_at <= $2
        GROUP BY p.clan_id, p.game_id)
     SELECT c.tag::text AS tag, count(*)::int AS games,
            count(*) FILTER (WHERE d.won > 0)::int AS wins,
            count(*) FILTER (WHERE d.won = 0 AND d.lost > 0)::int AS losses,
            sum(d.sessions)::int AS sessions,
            sum(d.won)::int AS w_wins, sum(d.lost)::int AS w_losses
       FROM per_game d JOIN clans c ON c.id = d.clan_id AND c.disbanded_at IS NULL
      GROUP BY c.id
     HAVING count(*) >= $3
      ORDER BY (sum(d.won)::float / greatest(sum(d.lost), 1)) DESC, count(*) DESC, c.tag
      LIMIT $4`,
    [
      start,
      now,
      CLAN_RULES.leaderboardMinClanGames,
      CLAN_RULES.leaderboardSize,
    ],
  );
  return {
    start,
    end: now,
    clans: rows.map((r) => ({
      clanTag: r.tag,
      games: r.games,
      wins: r.wins,
      losses: r.losses,
      playerSessions: r.sessions,
      weightedWins: r.w_wins,
      weightedLosses: r.w_losses,
      weightedWLRatio: r.w_wins / Math.max(1, r.w_losses),
    })),
  };
}
