// @vitest-environment node
import {
  PlayerLeaderboardResponseSchema,
  PlayerProfileSchema,
  type PlayerLeaderboardEntry,
} from "@openfront/shared/ApiSchemas";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { ACCOUNT_RULES } from "../../src/account-api/domain/constants";
import {
  rebuildLeaderboard,
  startLeaderboardJob,
  type RebuildOptions,
} from "../../src/account-api/jobs/leaderboard";
import { silentLogger } from "../../src/account-api/logger";
import { buildRecord, makeUser, submitGame, type TestUser } from "./util/games";
import {
  call,
  createServerKey,
  startHarness,
  type Harness,
} from "./util/harness";
import { describeDb } from "./util/testDb";

const harnesses: Harness[] = [];
async function harness(features = "accounts,leaderboards"): Promise<Harness> {
  const h = await startHarness({ features });
  harnesses.push(h);
  return h;
}
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.close();
});

const MIN = ACCOUNT_RULES.leaderboardMinGames;
const SIZE = ACCOUNT_RULES.leaderboardPageSize;
const q = async (h: Harness, sql: string, params: unknown[] = []) =>
  (await h.db.pool.query(sql, params)).rows;

/** A rebuild that waits out the startup rebuild if it is still holding the lock. */
async function rebuild(h: Harness, options: RebuildOptions = {}) {
  for (let i = 0; i < 50; i++) {
    if (await rebuildLeaderboard(h.db.pool, options)) return;
    await new Promise((r) => setTimeout(r, 40));
  }
  throw new Error("could not rebuild");
}

interface Seed {
  userId: string;
  publicId: string;
  wins: number;
  losses: number;
  incomplete?: number;
}
let batch = 0;

/** Counted (or not) games for the given players, straight into the tables. */
async function seedGames(
  h: Harness,
  players: Seed[],
  options: { counted?: boolean; type?: string; daysAgo?: number } = {},
) {
  const prefix = `s${(++batch).toString(36)}`;
  const total = (p: Seed) => p.wins + p.losses + (p.incomplete ?? 0);
  const most = Math.max(...players.map(total));
  const ended = new Date(Date.now() - (options.daysAgo ?? 0) * 86_400_000);
  await h.db.pool.query(
    `WITH gs AS (
       INSERT INTO games (game_code, source, type, started_at, ended_at, duration_s, human_players, counts_for_stats)
       SELECT $1 || lpad(k::text, 4, '0'), 'server', $2, $3::timestamptz - interval '10 minutes', $3::timestamptz, 600, 2, $4
         FROM generate_series(1, $5) k
       RETURNING id, game_code)
     INSERT INTO game_players (game_id, client_id, user_id, username, result, completed)
     SELECT gs.id, 'seed' || p.ord, p.uid, 'seed',
            CASE WHEN k.n <= p.w THEN 'victory' WHEN k.n <= p.w + p.l THEN 'defeat' ELSE 'incomplete' END,
            false
       FROM gs
       CROSS JOIN LATERAL (SELECT substr(gs.game_code, length($1) + 1)::int AS n) k
       JOIN unnest($6::uuid[], $7::int[], $8::int[], $9::int[]) WITH ORDINALITY AS p(uid, w, l, inc, ord)
         ON k.n <= p.w + p.l + p.inc`,
    [
      prefix,
      options.type ?? "Public",
      ended.toISOString(),
      options.counted ?? true,
      most,
      players.map((p) => p.userId),
      players.map((p) => p.wins),
      players.map((p) => p.losses),
      players.map((p) => p.incomplete ?? 0),
    ],
  );
}

async function bulkUsers(h: Harness, count: number, kind = "registered") {
  const { rows } = await h.db.pool.query<{ id: string; public_id: string }>(
    `INSERT INTO users (public_id, kind)
     SELECT 'bulk' || lpad(i::text, 6, '0') || $2, $1 FROM generate_series(1, $3) i
     RETURNING id, public_id`,
    [kind, `${(++batch).toString(36)}`.slice(0, 4), count],
  );
  return rows.map((r) => ({ userId: r.id, publicId: r.public_id }));
}

const board = async (h: Harness, query = "") => {
  const res = await call(h, `/leaderboard/players${query}`, { origin: null });
  return {
    res,
    body: res.status === 200 ? await res.json() : await res.json(),
  };
};

/** What the order and ranks must be, worked out here from the raw numbers. */
function expected(players: Seed[]) {
  const rows = players
    .map((p) => {
      const games = p.wins + p.losses + (p.incomplete ?? 0);
      return { ...p, games, rate: p.wins / games };
    })
    .filter((p) => p.games >= MIN)
    .sort(
      (a, b) =>
        b.wins - a.wins ||
        b.rate - a.rate ||
        b.games - a.games ||
        (a.publicId < b.publicId ? -1 : 1),
    );
  return rows.map((r, i) => {
    const better = rows.filter(
      (o) => o.wins > r.wins || (o.wins === r.wins && o.rate > r.rate),
    ).length;
    return {
      publicId: r.publicId,
      rank: better + 1,
      position: i + 1,
      games: r.games,
      wins: r.wins,
      losses: r.losses,
      winRate: r.rate,
    };
  });
}

describeDb(
  "the basic player leaderboard: who is listed and in what order",
  () => {
    it("lists players by wins, then win rate, then games, then public id, with competition ranks", async () => {
      const h = await harness();
      const users = await bulkUsers(h, 8);
      const seeds: Seed[] = [
        { ...users[0], wins: 9, losses: 1 }, // 9 wins, 10 games, .90
        { ...users[1], wins: 9, losses: 1 }, // identical to users[0]: tie on every key but id
        { ...users[2], wins: 9, losses: 3 }, // 9 wins, 12 games, .75
        { ...users[3], wins: 9, losses: 0, incomplete: 3 }, // 9 wins, 12 games, .75: ties users[2] on wins+rate, same games
        { ...users[4], wins: 12, losses: 0 }, // most wins
        { ...users[5], wins: 5, losses: 5 },
        { ...users[6], wins: 5, losses: 5, incomplete: 2 }, // 5 wins, 12 games, .417: lower rate than users[5]
        { ...users[7], wins: 0, losses: 10 },
      ];
      await seedGames(h, seeds);
      await rebuild(h);
      const { res, body } = await board(h);
      expect(res.status).toBe(200);
      const parsed = PlayerLeaderboardResponseSchema.parse(body);
      const want = expected(seeds);
      expect(parsed.players.map((p) => p.playerId)).toEqual(
        want.map((w) => w.publicId),
      );
      expect(parsed.players.map((p) => p.rank)).toEqual(
        want.map((w) => w.rank),
      );
      for (const [i, p] of parsed.players.entries()) {
        expect(p).toMatchObject({
          games: want[i].games,
          wins: want[i].wins,
          losses: want[i].losses,
        });
        expect(p.winRate).toBeCloseTo(want[i].winRate, 10);
        expect(p.elo).toBeUndefined();
      }
      // 12 wins first; then the two 9-win/.75 players share rank 2 and the two 9-win/.90 players share rank 3? no: .90 beats .75
      expect(parsed.players.map((p) => p.rank)).toEqual(
        want.map((w) => w.rank),
      );
    });

    it("exact ties share a rank and are ordered by public id, never by row order", async () => {
      const h = await harness();
      const users = await bulkUsers(h, 4);
      // The first row inserted is deliberately the one that must sort last.
      const seeds: Seed[] = [
        { ...users[3], wins: 5, losses: 5 }, // 5 wins, 10 games, .5
        { ...users[2], wins: 5, losses: 5 }, // identical to the above
        { ...users[1], wins: 5, losses: 5, incomplete: 0 },
        { ...users[0], wins: 6, losses: 4 }, // best
      ];
      await seedGames(h, seeds);
      await rebuild(h);
      const { body } = await board(h);
      const ids = body.players.map((p: { playerId: string }) => p.playerId);
      expect(ids[0]).toBe(users[0].publicId);
      expect(body.players.map((p: { rank: number }) => p.rank)).toEqual([
        1, 2, 2, 2,
      ]);
      // public id ascending among the exact ties
      expect(ids.slice(1)).toEqual(
        [users[1].publicId, users[2].publicId, users[3].publicId].sort(),
      );

      // same wins but a lower win rate (more games): shares nothing, ranks after the ties
      const more = (await bulkUsers(h, 1))[0];
      await seedGames(h, [{ ...more, wins: 5, losses: 6 }]);
      await rebuild(h);
      const next = (await board(h)).body.players;
      expect(next.map((p: { rank: number }) => p.rank)).toEqual([
        1, 2, 2, 2, 5,
      ]);
      expect(next[4].playerId).toBe(more.publicId);
    });

    it("competition ranking skips: 1, 2, 2, 4", async () => {
      const h = await harness();
      const u = await bulkUsers(h, 4);
      await seedGames(h, [
        { ...u[0], wins: 10, losses: 0 },
        { ...u[1], wins: 8, losses: 2 },
        { ...u[2], wins: 8, losses: 2 },
        { ...u[3], wins: 7, losses: 3 },
      ]);
      await rebuild(h);
      expect(
        (await board(h)).body.players.map((p: { rank: number }) => p.rank),
      ).toEqual([1, 2, 2, 4]);
    });

    it("equal win rates written differently (1/2 and 2/4 style) are ties", async () => {
      const h = await harness();
      const u = await bulkUsers(h, 2);
      await seedGames(h, [
        { ...u[0], wins: 5, losses: 5 }, // 5/10
        { ...u[1], wins: 5, losses: 3, incomplete: 2 }, // 5/10
      ]);
      await rebuild(h);
      expect(
        (await board(h)).body.players.map((p: { rank: number }) => p.rank),
      ).toEqual([1, 1]);
    });

    it("lists a player only from the minimum number of counted games", async () => {
      const h = await harness();
      const u = await bulkUsers(h, 3);
      await seedGames(h, [
        { ...u[0], wins: 3, losses: MIN - 4 }, // MIN - 1 games
        { ...u[1], wins: 3, losses: MIN - 3 }, // exactly MIN
        { ...u[2], wins: 0, losses: 0, incomplete: MIN + 1 }, // listed with no wins
      ]);
      await rebuild(h);
      const ids = (await board(h)).body.players.map(
        (p: { playerId: string }) => p.playerId,
      );
      expect(ids).toEqual([u[1].publicId, u[2].publicId]);
      expect(MIN).toBe(10);
    });

    it("only counts counted, public, server games", async () => {
      const h = await harness();
      const u = await bulkUsers(h, 4);
      await seedGames(h, [{ ...u[0], wins: MIN, losses: 0 }], {
        counted: false,
      });
      await seedGames(h, [{ ...u[1], wins: MIN, losses: 0 }], {
        type: "Private",
      });
      await seedGames(h, [{ ...u[2], wins: MIN, losses: 0 }]);
      // a player who got there only by mixing counted with uncounted games
      await seedGames(h, [{ ...u[3], wins: MIN - 1, losses: 0 }]);
      await seedGames(h, [{ ...u[3], wins: 5, losses: 0 }], { counted: false });
      await rebuild(h);
      const players = (await board(h)).body.players;
      expect(players.map((p: { playerId: string }) => p.playerId)).toEqual([
        u[2].publicId,
      ]);
    });

    it("takes its numbers from the games the server stored through ingestion", async () => {
      const h = await harness();
      const key = await createServerKey(h);
      const a = await makeUser(h);
      const b = await makeUser(h);
      for (let i = 0; i < MIN; i++) {
        const aWins = i < 7;
        const res = await submitGame(
          h,
          key,
          buildRecord(`lb${String(i).padStart(6, "0")}`, {
            players: [{ user: aWins ? a : b }, { user: aWins ? b : a }],
          }),
        );
        expect(res.status).toBe(200);
      }
      await rebuild(h);
      const players = (await board(h)).body.players;
      expect(players).toHaveLength(2);
      expect(players[0]).toMatchObject({
        playerId: a.publicId,
        rank: 1,
        wins: 7,
        losses: 3,
        games: MIN,
      });
      expect(players[1]).toMatchObject({
        playerId: b.publicId,
        rank: 2,
        wins: 3,
        losses: 7,
        games: MIN,
      });
      expect(players[0].winRate).toBeCloseTo(0.7, 10);
    });

    it("the 30-day board only counts recent games", async () => {
      const h = await harness();
      const u = await bulkUsers(h, 2);
      await seedGames(h, [{ ...u[0], wins: MIN, losses: 0 }], { daysAgo: 40 });
      await seedGames(h, [{ ...u[1], wins: MIN, losses: 0 }], { daysAgo: 5 });
      await seedGames(h, [{ ...u[0], wins: 2, losses: 0 }], { daysAgo: 1 });
      await rebuild(h);
      const all = (await board(h, "?period=all")).body.players;
      const recent = (await board(h, "?period=30d")).body.players;
      expect(all.map((p: { playerId: string }) => p.playerId)).toEqual([
        u[0].publicId,
        u[1].publicId,
      ]);
      expect(all[0]).toMatchObject({ wins: MIN + 2, games: MIN + 2 });
      // u[0] has only 2 games in the window: not listed there
      expect(recent.map((p: { playerId: string }) => p.playerId)).toEqual([
        u[1].publicId,
      ]);
    });
  },
);

describeDb("who may appear", () => {
  async function listed(h: Harness): Promise<string[]> {
    return (await board(h)).body.players.map(
      (p: { playerId: string }) => p.playerId,
    );
  }

  it("deleted, deletion-queued, flagged and banned accounts are not listed, at once", async () => {
    const h = await harness();
    const u = await bulkUsers(h, 7);
    await seedGames(
      h,
      u.map((x) => ({ ...x, wins: MIN, losses: 0 })),
    );
    await rebuild(h);
    expect(await listed(h)).toHaveLength(7);

    // each change takes effect on the very next read, without waiting for a rebuild
    await h.db.pool.query("UPDATE users SET deleted_at = now() WHERE id = $1", [
      u[0].userId,
    ]);
    await h.db.pool.query(
      "UPDATE users SET deletion_requested_at = now() WHERE id = $1",
      [u[1].userId],
    );
    await h.db.pool.query("UPDATE users SET role = 'flagged' WHERE id = $1", [
      u[2].userId,
    ]);
    await h.db.pool.query(
      "INSERT INTO bans (user_id, category, reason) VALUES ($1, 'cheating', 'x')",
      [u[3].userId],
    );
    await h.db.pool.query(
      "INSERT INTO bans (user_id, category, reason, expires_at) VALUES ($1, 'cheating', 'x', now() + interval '1 day')",
      [u[4].userId],
    );
    expect(await listed(h)).toEqual([u[5].publicId, u[6].publicId].sort());

    // and they stay out after a rebuild
    await rebuild(h);
    expect(await listed(h)).toEqual([u[5].publicId, u[6].publicId].sort());
    expect(await q(h, "SELECT 1 FROM leaderboard_players")).toHaveLength(4); // 2 players x 2 periods
  });

  it("an expired or lifted ban, and a staff role other than flagged, do not hide a player", async () => {
    const h = await harness();
    const u = await bulkUsers(h, 3);
    await seedGames(
      h,
      u.map((x) => ({ ...x, wins: MIN, losses: 0 })),
    );
    await h.db.pool.query(
      "INSERT INTO bans (user_id, category, reason, expires_at) VALUES ($1, 'cheating', 'x', now() - interval '1 day')",
      [u[0].userId],
    );
    await h.db.pool.query(
      "INSERT INTO bans (user_id, category, reason, revoked_at) VALUES ($1, 'cheating', 'x', now())",
      [u[1].userId],
    );
    await h.db.pool.query("UPDATE users SET role = 'mod' WHERE id = $1", [
      u[2].userId,
    ]);
    await rebuild(h);
    expect(await listed(h)).toHaveLength(3);
  });

  it("a ban placed after the rebuild hides the player; lifting it brings them back", async () => {
    const h = await harness();
    const u = await bulkUsers(h, 2);
    await seedGames(
      h,
      u.map((x) => ({ ...x, wins: MIN, losses: 0 })),
    );
    await rebuild(h);
    const { rows } = await h.db.pool.query<{ id: string }>(
      "INSERT INTO bans (user_id, category, reason) VALUES ($1, 'cheating', 'x') RETURNING id",
      [u[0].userId],
    );
    expect(await listed(h)).toEqual([u[1].publicId]);
    await h.db.pool.query("UPDATE bans SET revoked_at = now() WHERE id = $1", [
      rows[0].id,
    ]);
    expect(await listed(h)).toHaveLength(2);
  });

  it("guests are listed (the plan excludes only flagged, banned and deleted accounts) and their stats are kept either way", async () => {
    const h = await harness();
    const guests = await bulkUsers(h, 1, "guest");
    const reg = await bulkUsers(h, 1);
    await seedGames(h, [
      { ...guests[0], wins: MIN, losses: 0 },
      { ...reg[0], wins: MIN, losses: 0 },
    ]);
    await rebuild(h);
    expect(await listed(h)).toHaveLength(2);
    expect(ACCOUNT_RULES.leaderboardIncludesGuests).toBe(true);

    // the switch: guests stay out of the board, and nothing is deleted from their record
    await rebuild(h, { includeGuests: false });
    expect(await listed(h)).toEqual([reg[0].publicId]);
    expect(
      await q(h, "SELECT 1 FROM game_players WHERE user_id = $1", [
        guests[0].userId,
      ]),
    ).toHaveLength(MIN);
  });

  it("a player with no games, or only unlisted games, is simply absent; an empty board is a valid page", async () => {
    const h = await harness();
    await bulkUsers(h, 3);
    await rebuild(h);
    const { res, body } = await board(h);
    expect(res.status).toBe(200);
    expect(body).toEqual({ players: [] });
    expect((await board(h, "?period=30d")).body).toEqual({ players: [] });
  });

  it("players without an account (null user) never appear", async () => {
    const h = await harness();
    const u = await bulkUsers(h, 1);
    await seedGames(h, [{ ...u[0], wins: MIN, losses: 0 }]);
    await h.db.pool.query("UPDATE game_players SET user_id = NULL");
    await rebuild(h);
    expect((await board(h)).body.players).toEqual([]);
  });
});

describeDb("pages", () => {
  async function many(h: Harness, count: number) {
    const users = await bulkUsers(h, count);
    // wins 0..9 repeating, so there are many ties across page boundaries
    const seeds: Seed[] = users.map((x, i) => ({
      ...x,
      wins: i % 10,
      losses: MIN - (i % 10),
      incomplete: i % 3,
    }));
    await seedGames(h, seeds);
    await rebuild(h);
    return seeds;
  }

  it("serves 50 rows per page; the pages together are the whole board, in order, with no repeats or gaps", async () => {
    const h = await harness();
    const seeds = await many(h, 130);
    const want = expected(seeds);
    const seen: string[] = [];
    const sizes: number[] = [];
    for (let page = 1; page <= 3; page++) {
      const { res, body } = await board(h, `?page=${page}`);
      expect(res.status).toBe(200);
      const parsed = PlayerLeaderboardResponseSchema.parse(body);
      sizes.push(parsed.players.length);
      seen.push(...parsed.players.map((p) => p.playerId));
    }
    expect(sizes).toEqual([SIZE, SIZE, 130 - 2 * SIZE]);
    expect(new Set(seen).size).toBe(130);
    expect(seen).toEqual(want.map((w) => w.publicId));
    // ranks never go backwards across a page boundary
    const ranks = (
      await Promise.all([1, 2, 3].map((p) => board(h, `?page=${p}`)))
    ).flatMap((r) => r.body.players.map((x: { rank: number }) => x.rank));
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
    expect(ranks).toEqual(want.map((w) => w.rank));
  });

  it("the first page is the default, for both periods", async () => {
    const h = await harness();
    await many(h, 60);
    const a = await board(h);
    const b = await board(h, "?page=1&period=all");
    expect(a.body).toEqual(b.body);
    expect(a.body.players).toHaveLength(SIZE);
    expect((await board(h, "?page=1&period=30d")).body.players).toHaveLength(
      SIZE,
    );
  });

  it("a page past the end is the 400 the client reads as 'no more pages', naming the real last page", async () => {
    const h = await harness();
    await many(h, 60);
    const { res, body } = await board(h, "?page=3");
    expect(res.status).toBe(400);
    expect(body.message).toBe("Page must be between 1 and 2");
    expect(body.message).toMatch(/^Page must be between \d+ and \d+$/);
  });

  it("the page count is capped no matter how big the board is", async () => {
    const h = await harness();
    await many(h, 20);
    const over = ACCOUNT_RULES.leaderboardMaxPages + 1;
    const { res, body } = await board(h, `?page=${over}`);
    expect(res.status).toBe(400);
    expect(body.message).toBe(
      `Page must be between 1 and ${ACCOUNT_RULES.leaderboardMaxPages}`,
    );
    expect((await board(h, "?page=999999")).res.status).toBe(400);
    expect((await board(h, "?page=1000000")).res.status).toBe(400); // too many digits is just invalid
  });

  it("page 0, negative, fractional, exponent, hex, empty and repeated page values are refused", async () => {
    const h = await harness();
    await many(h, 12);
    for (const query of [
      "?page=0",
      "?page=-1",
      "?page=1.5",
      "?page=1e2",
      "?page=0x10",
      "?page=",
      "?page=abc",
      "?page=1&page=2",
      "?page=%20",
      "?page=%00",
      "?page=1%20OR%201=1",
    ]) {
      const { res } = await board(h, query);
      expect(res.status, query).toBe(400);
    }
  });

  it("the page size cannot be chosen by the caller", async () => {
    const h = await harness();
    await many(h, 120);
    for (const query of [
      "?limit=1000",
      "?pageSize=1000",
      "?size=1000",
      "?per_page=1000",
      "?count=1000",
    ]) {
      const { res, body } = await board(h, query);
      expect(res.status, query).toBe(200);
      expect(body.players, query).toHaveLength(SIZE);
    }
  });

  it("an unknown or malicious period is refused before any query", async () => {
    const h = await harness();
    await many(h, 12);
    for (const period of [
      "7d",
      "ALL",
      "all%27%3B%20DROP%20TABLE%20users%3B--",
      "30d%20OR%201%3D1",
      "elo",
      "",
      "all&period=30d",
      "%00",
      "wins",
      "1",
    ]) {
      const { res } = await board(h, `?period=${period}`);
      expect(res.status, period).toBe(400);
    }
    // the data is intact
    expect(await q(h, "SELECT count(*)::int AS n FROM users")).toEqual([
      { n: 12 },
    ]);
  });

  it("sort and column parameters are ignored: the order is always the documented one", async () => {
    const h = await harness();
    const seeds = await many(h, 30);
    const want = expected(seeds).map((w) => w.publicId);
    for (const query of [
      "?sort=losses",
      "?sort=wins;DROP TABLE users",
      "?orderBy=games",
      "?order=asc",
      "?column=public_id",
      "?category=elo",
      "?sort[]=x",
    ]) {
      const { res, body } = await board(h, query);
      expect(res.status, query).toBe(200);
      expect(
        body.players.map((p: { playerId: string }) => p.playerId),
        query,
      ).toEqual(want);
    }
  });
});

describeDb("what a row exposes, and how it links to the profile", () => {
  it("rows carry the public id, the display name and the numbers, and nothing private", async () => {
    const h = await harness();
    const key = await createServerKey(h);
    const a = await makeUser(h);
    const b = await makeUser(h);
    await h.db.pool.query(
      `INSERT INTO auth_identities (user_id, provider, provider_user_id, email, display_name, profile)
       VALUES ($1, 'google', 'g-secret-sub', 'private@example.com', 'Private Person', '{}')`,
      [a.id],
    );
    await h.db.pool.query(
      "UPDATE users SET username_base = 'Champ', username_discriminator = '0042' WHERE id = $1",
      [a.id],
    );
    for (let i = 0; i < MIN; i++)
      await submitGame(
        h,
        key,
        buildRecord(`px${String(i).padStart(6, "0")}`, {
          players: [{ user: a }, { user: b }],
        }),
      );
    await rebuild(h);
    const res = await call(h, "/leaderboard/players", { origin: null });
    const text = await res.text();
    const parsed = PlayerLeaderboardResponseSchema.parse(JSON.parse(text));
    expect(parsed.players.map((p) => Object.keys(p).sort())).toEqual([
      [
        "accountUsername",
        "games",
        "losses",
        "playerId",
        "rank",
        "verified",
        "winRate",
        "wins",
      ],
      [
        "accountUsername",
        "games",
        "losses",
        "playerId",
        "rank",
        "verified",
        "winRate",
        "wins",
      ],
    ]);
    expect(parsed.players[0]).toMatchObject({
      playerId: a.publicId,
      accountUsername: "Champ.0042",
    });
    expect(parsed.players[1].accountUsername).toBeNull();
    for (const secret of [
      a.id,
      b.id,
      "private@example.com",
      "g-secret-sub",
      "Private Person",
      "google",
    ])
      expect(text).not.toContain(secret);
    expect(res.headers.get("cache-control")).toBe(
      `public, max-age=${ACCOUNT_RULES.leaderboardCacheSeconds}`,
    );
  });

  it("exposes the operator-verified flag, default false, without inferring it from the name", async () => {
    const h = await harness();
    const u = await bulkUsers(h, 2);
    await seedGames(h, [
      { ...u[0], wins: MIN, losses: 0 },
      { ...u[1], wins: MIN - 1, losses: 1 },
    ]);
    await rebuild(h);
    const names = (rows: PlayerLeaderboardEntry[]) =>
      Object.fromEntries(rows.map((r) => [r.playerId, r]));
    let players = names(
      PlayerLeaderboardResponseSchema.parse((await board(h)).body).players,
    );
    expect(players[u[0].publicId].verified).toBe(false);
    expect(players[u[1].publicId].verified).toBe(false);

    // A suffixed name that is verified by the operator; the other a dotless
    // name that is not. Only the column decides.
    await h.db.pool.query(
      "UPDATE users SET verified = true, username_base = 'Aydin', username_discriminator = '4821' WHERE id = $1",
      [u[0].userId],
    );
    await h.db.pool.query(
      "UPDATE users SET username_base = 'Plain', username_discriminator = '0001' WHERE id = $1",
      [u[1].userId],
    );
    players = names(
      PlayerLeaderboardResponseSchema.parse((await board(h)).body).players,
    );
    expect(players[u[0].publicId]).toMatchObject({
      accountUsername: "Aydin.4821",
      verified: true,
    });
    expect(players[u[1].publicId].verified).toBe(false);
  });

  it("a rename shows on the next read without a rebuild", async () => {
    const h = await harness();
    const u = await bulkUsers(h, 1);
    await seedGames(h, [{ ...u[0], wins: MIN, losses: 0 }]);
    await rebuild(h);
    expect((await board(h)).body.players[0].accountUsername).toBeNull();
    await h.db.pool.query(
      "UPDATE users SET username_base = 'Renamed', username_discriminator = '0007' WHERE id = $1",
      [u[0].userId],
    );
    expect((await board(h)).body.players[0].accountUsername).toBe(
      "Renamed.0007",
    );
  });

  it("every listed public id opens a valid public profile", async () => {
    const h = await harness();
    const u = await bulkUsers(h, 5);
    await seedGames(
      h,
      u.map((x, i) => ({ ...x, wins: MIN - i, losses: i })),
    );
    await rebuild(h);
    const players = (await board(h)).body.players;
    expect(players).toHaveLength(5);
    for (const p of players) {
      const profile = await call(h, `/public/player/${p.playerId}`, {
        origin: null,
      });
      expect(profile.status, p.playerId).toBe(200);
      PlayerProfileSchema.parse(await profile.json());
    }
  });
});

describeDb("only the server decides the board", () => {
  it("no request can write a leaderboard value, or any rank, score or position", async () => {
    const h = await harness();
    const u = await makeUser(h);
    const other = await bulkUsers(h, 1);
    await seedGames(h, [{ ...other[0], wins: MIN, losses: 0 }]);
    await rebuild(h);
    const before = await q(
      h,
      "SELECT * FROM leaderboard_players ORDER BY period, rank_pos",
    );
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      for (const route of [
        "/leaderboard/players",
        "/leaderboard/players?page=1",
        "/leaderboard",
        "/leaderboard/ranked",
        `/player/${other[0].publicId}`,
        "/users/@me",
      ]) {
        const res = await call(h, route, {
          method,
          bearer: u.jwt,
          origin: null,
          json: {
            rank: 1,
            wins: 9999,
            games: 9999,
            score: 9999,
            position: 1,
            playerId: u.publicId,
          },
        });
        expect([400, 401, 403, 404, 405], `${method} ${route}`).toContain(
          res.status,
        );
      }
    }
    expect(
      await q(h, "SELECT * FROM leaderboard_players ORDER BY period, rank_pos"),
    ).toEqual(before);
    expect(await q(h, "SELECT 1 FROM player_stat_aggregates")).toHaveLength(0);
  });

  it("only the rebuild job writes the table", () => {
    const root = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "../../src/account-api",
    );
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (
          full.endsWith(".ts") &&
          /(INSERT\s+INTO|UPDATE|DELETE\s+FROM|TRUNCATE)\s+(TABLE\s+)?leaderboard_players/i.test(
            fs.readFileSync(full, "utf8"),
          )
        )
          offenders.push(path.relative(root, full));
      }
    };
    walk(root);
    expect(offenders).toEqual(["jobs/leaderboard.ts"]);
  });

  it("the route builds its SQL from constants: no request value reaches query text", () => {
    const text = fs.readFileSync(
      path.resolve(
        path.dirname(fileURLToPath(import.meta.url)),
        "../../src/account-api/routes/leaderboard.ts",
      ),
      "utf8",
    );
    // every dynamic value goes through a $n parameter; the only interpolation is the fixed user filter
    const interpolations = [...text.matchAll(/\$\{([^}]+)\}/g)]
      .map((m) => m[1])
      .filter((x) => !/^(ACCOUNT_RULES|lastPage|LISTABLE_USER)/.test(x));
    expect(interpolations).toEqual([]);
  });
});

describeDb("rebuilding", () => {
  it("is repeatable: a second rebuild gives the same board", async () => {
    const h = await harness();
    const u = await bulkUsers(h, 6);
    await seedGames(
      h,
      u.map((x, i) => ({ ...x, wins: MIN - i, losses: i })),
    );
    await rebuild(h);
    const first = await q(
      h,
      "SELECT period, user_id, rank_pos, rank, games, wins, losses, win_rate FROM leaderboard_players ORDER BY period, rank_pos",
    );
    await rebuild(h);
    expect(
      await q(
        h,
        "SELECT period, user_id, rank_pos, rank, games, wins, losses, win_rate FROM leaderboard_players ORDER BY period, rank_pos",
      ),
    ).toEqual(first);
    expect(first).toHaveLength(12);
  });

  it("follows the games: a player climbs after more wins and a later rebuild", async () => {
    const h = await harness();
    const u = await bulkUsers(h, 2);
    await seedGames(h, [
      { ...u[0], wins: MIN, losses: 0 },
      { ...u[1], wins: MIN - 1, losses: 1 },
    ]);
    await rebuild(h);
    expect(
      (await board(h)).body.players.map(
        (p: { playerId: string }) => p.playerId,
      ),
    ).toEqual([u[0].publicId, u[1].publicId]);
    await seedGames(h, [{ ...u[1], wins: 5, losses: 0 }]);
    // not yet: the board is a snapshot until the next rebuild
    expect((await board(h)).body.players[0].playerId).toBe(u[0].publicId);
    await rebuild(h);
    expect((await board(h)).body.players[0].playerId).toBe(u[1].publicId);
  });

  it("only one instance rebuilds at a time: a second one skips instead of waiting", async () => {
    const h = await harness();
    const u = await bulkUsers(h, 1);
    await seedGames(h, [{ ...u[0], wins: MIN, losses: 0 }]);
    await rebuild(h);
    const holder = await h.db.pool.connect();
    try {
      await holder.query("BEGIN");
      await holder.query("SELECT pg_advisory_xact_lock($1::bigint)", [
        "7374410003",
      ]);
      expect(await rebuildLeaderboard(h.db.pool)).toBe(false);
      // the old board is still served meanwhile
      expect((await board(h)).body.players).toHaveLength(1);
      await holder.query("ROLLBACK");
    } finally {
      holder.release();
    }
    expect(await rebuildLeaderboard(h.db.pool)).toBe(true);
  });

  it("readers never see a half-built board while a rebuild runs", async () => {
    const h = await harness();
    const u = await bulkUsers(h, 60);
    await seedGames(
      h,
      u.map((x, i) => ({ ...x, wins: MIN - (i % 5), losses: i % 5 })),
    );
    await rebuild(h);
    let bad = 0;
    let reads = 0;
    const stop = { v: false };
    const reader = (async () => {
      while (!stop.v) {
        const { body } = await board(h);
        reads++;
        if (body.players.length !== SIZE) bad++;
      }
    })();
    for (let i = 0; i < 5; i++) await rebuild(h);
    stop.v = true;
    await reader;
    expect(reads).toBeGreaterThan(0);
    expect(bad).toBe(0);
  });

  it("the background job builds the board on its own", async () => {
    const h = await harness();
    const u = await bulkUsers(h, 1);
    await seedGames(h, [{ ...u[0], wins: MIN, losses: 0 }]);
    await h.db.pool.query("DELETE FROM leaderboard_players");
    const stop = startLeaderboardJob(h.db.pool, silentLogger as never);
    try {
      let rows: unknown[] = [];
      for (let i = 0; i < 50 && rows.length === 0; i++) {
        await new Promise((r) => setTimeout(r, 50));
        rows = await q(h, "SELECT 1 FROM leaderboard_players");
      }
      expect(rows.length).toBe(2);
    } finally {
      stop();
    }
  });
});

describeDb("the flag and the limits", () => {
  it("is not served unless the leaderboards feature is on", async () => {
    const off = await harness("accounts");
    expect(
      (await call(off, "/leaderboard/players", { origin: null })).status,
    ).toBe(404);
    const on = await harness("accounts,leaderboards");
    expect(
      (await call(on, "/leaderboard/players", { origin: null })).status,
    ).toBe(200);
  });

  it("is rate limited per address", async () => {
    const h = await startHarness({
      features: "accounts,leaderboards",
      limits: { publicRead: { max: 3, windowMs: 60_000 } },
    });
    harnesses.push(h);
    const statuses = [];
    for (let i = 0; i < 5; i++) statuses.push((await board(h)).res.status);
    expect(statuses).toEqual([200, 200, 200, 429, 429]);
  });

  it("works for a signed-out visitor and for a cross-origin page alike (public data)", async () => {
    const h = await harness();
    expect(
      (await call(h, "/leaderboard/players", { origin: null })).status,
    ).toBe(200);
    const res = await call(h, "/leaderboard/players", { origin: h.origin });
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe(h.origin);
  });
});
export type { TestUser };
