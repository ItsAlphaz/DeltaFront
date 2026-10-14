// @vitest-environment node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Pool } from "pg";
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { loadConfig } from "../../src/account-api/config";
import {
  ADVISORY_LOCK_KEY,
  applyMigrations,
  loadMigrationFiles,
  MigrationError,
  migrationStatus,
  type MigrationFile,
} from "../../src/account-api/db/migrator";
import { createPool } from "../../src/account-api/db/pool";
import { withTransaction } from "../../src/account-api/db/tx";
import { silentLogger } from "../../src/account-api/logger";
import {
  createTestDatabase,
  describeDb,
  type TestDatabase,
} from "./util/testDb";

const M0_TABLES = [
  "admin_audit_log",
  "auth_identities",
  "bans",
  "clan_bans",
  "clan_events",
  "clan_join_requests",
  "clan_members",
  "clan_tag_holds",
  "clans",
  "currency_ledger",
  "game_players",
  "game_records",
  "game_servers",
  "games",
  "oauth_states",
  "player_stat_aggregates",
  "purchases",
  "refresh_sessions",
  "server_api_keys",
  "user_flares",
  "users",
  "wallets",
];

const tempDirs: string[] = [];
function migrationDir(files: Record<string, string>): MigrationFile[] {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "df-mig-"));
  tempDirs.push(dir);
  for (const [name, sql] of Object.entries(files))
    fs.writeFileSync(path.join(dir, name), sql);
  return loadMigrationFiles(dir);
}
afterAll(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

const tablesOf = async (pool: Pool): Promise<string[]> =>
  (
    await pool.query<{ table_name: string }>(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name",
    )
  ).rows.map((r) => r.table_name);

/** A fresh, empty database for the duration of one test. */
const databases: TestDatabase[] = [];
async function freshDb(): Promise<TestDatabase> {
  const db = await createTestDatabase();
  databases.push(db);
  return db;
}
afterEach(async () => {
  for (const db of databases.splice(0)) await db.drop();
});

const PROGRESSION_TABLES = [
  "challenge_progress",
  "prestige_events",
  "progression_rewards",
  "seasons",
  "user_progress",
  "user_season_progress",
  "xp_daily",
  "xp_ledger",
];

describeDb("applying the shipped migrations to PostgreSQL", () => {
  it("builds the whole M0 schema on an empty database, and records it", async () => {
    const { pool } = await freshDb();
    const { applied } = await applyMigrations(pool, {
      log: silentLogger as never,
    });
    expect(applied).toEqual([
      "0001",
      "0002",
      "0003",
      "0004",
      "0005",
      "0006",
      "0007",
    ]);

    expect(await tablesOf(pool)).toEqual(
      [
        ...M0_TABLES,
        "leaderboard_players",
        "magic_link_tokens",
        "schema_migrations",
        ...PROGRESSION_TABLES,
      ].sort(),
    );
    const files = loadMigrationFiles();
    const rows = (
      await pool.query(
        "SELECT version, name, checksum FROM schema_migrations ORDER BY version",
      )
    ).rows;
    expect(rows).toEqual([
      { version: "0001", name: "init", checksum: files[0].checksum },
      { version: "0002", name: "leaderboard", checksum: files[1].checksum },
      { version: "0003", name: "magic_links", checksum: files[2].checksum },
      {
        version: "0004",
        name: "verified_accounts",
        checksum: files[3].checksum,
      },
      {
        version: "0005",
        name: "bare_usernames",
        checksum: files[4].checksum,
      },
      {
        version: "0006",
        name: "staff_roles",
        checksum: files[5].checksum,
      },
      {
        version: "0007",
        name: "progression",
        checksum: files[6].checksum,
      },
    ]);
  });

  it("is idempotent: a second run applies nothing", async () => {
    const { pool } = await freshDb();
    await applyMigrations(pool);
    const second = await applyMigrations(pool);
    expect(second.applied).toEqual([]);
    expect(
      (await pool.query("SELECT count(*)::int AS n FROM schema_migrations"))
        .rows[0].n,
    ).toBe(7);
  });

  it("works through the service's own pool (createPool) too", async () => {
    const db = await freshDb();
    const config = loadConfig({
      GAME_ENV: "dev",
      DATABASE_URL: db.url,
      DATABASE_POOL_MAX: "3",
    });
    const pool = createPool(config.database, silentLogger);
    try {
      expect((await applyMigrations(pool)).applied).toEqual([
        "0001",
        "0002",
        "0003",
        "0004",
        "0005",
        "0006",
        "0007",
      ]);
      // createPool caps statements at 30 s so a runaway query cannot hold a connection.
      expect(
        (await pool.query("SHOW statement_timeout")).rows[0].statement_timeout,
      ).toBe("30s");
      expect(
        (await pool.query("SHOW application_name")).rows[0].application_name,
      ).toBe("deltafront-account-api");
    } finally {
      await pool.end();
    }
  });

  it("migrationStatus is read-only: it neither creates the history table nor applies anything", async () => {
    const { pool } = await freshDb();
    const before = await migrationStatus(pool);
    expect(before.applied).toEqual([]);
    expect(before.pending.map((m) => m.version)).toEqual([
      "0001",
      "0002",
      "0003",
      "0004",
      "0005",
      "0006",
      "0007",
    ]);
    expect(await tablesOf(pool)).toEqual([]);

    await applyMigrations(pool);
    const after = await migrationStatus(pool);
    expect(after.applied.map((m) => m.version)).toEqual([
      "0001",
      "0002",
      "0003",
      "0004",
      "0005",
      "0006",
      "0007",
    ]);
    expect(after.pending).toEqual([]);
  });
});

describeDb("0007 progression constraints", () => {
  it("lets the ledger and ownership take the new values, and still refuse anything else", async () => {
    const { pool } = await freshDb();
    await applyMigrations(pool);
    const [{ id }] = (
      await pool.query(
        "INSERT INTO users (public_id, kind) VALUES ('Mig0007abc', 'registered') RETURNING id",
      )
    ).rows;
    await pool.query("INSERT INTO wallets (user_id) VALUES ($1)", [id]);
    const ledger = (reason: string, ref: string) =>
      pool.query(
        `INSERT INTO currency_ledger (user_id, delta, balance_after, reason, ref_type, ref_id)
         VALUES ($1, 5, 5, $2, 'reward', $3)`,
        [id, reason, ref],
      );
    await ledger("progression_reward", "1");
    await ledger("admin_grant", "x");
    await expect(ledger("bogus", "2")).rejects.toThrow(
      /currency_ledger_reason_check/,
    );
    // the same reward cannot be paid twice
    await expect(ledger("progression_reward", "1")).rejects.toThrow(
      /currency_ledger_progression_reward_once/,
    );
    const flare = (source: string) =>
      pool.query(
        "INSERT INTO user_flares (user_id, flare, source) VALUES ($1, $2, $3)",
        [id, `flag:${source}`, source],
      );
    await flare("reward");
    await flare("admin");
    await flare("purchase");
    await expect(flare("bogus")).rejects.toThrow(/user_flares_source_check/);
    // the old game-reward rule is untouched
    await expect(
      pool.query(
        "INSERT INTO currency_ledger (user_id, delta, balance_after, reason) VALUES ($1, 5, 5, 'game_reward')",
        [id],
      ),
    ).rejects.toThrow();
  });

  it("keeps lifetime XP at or above the run's, and prestige in range", async () => {
    const { pool } = await freshDb();
    await applyMigrations(pool);
    const [{ id }] = (
      await pool.query(
        "INSERT INTO users (public_id, kind) VALUES ('Mig0007xyz', 'registered') RETURNING id",
      )
    ).rows;
    const insert = (lifetime: number, run: number, prestige: number) =>
      pool.query(
        "INSERT INTO user_progress (user_id, lifetime_xp, run_xp, prestige) VALUES ($1, $2, $3, $4) ON CONFLICT (user_id) DO UPDATE SET lifetime_xp = $2, run_xp = $3, prestige = $4",
        [id, lifetime, run, prestige],
      );
    await insert(100, 100, 10);
    await expect(insert(50, 100, 0)).rejects.toThrow();
    await expect(insert(100, 100, 11)).rejects.toThrow();
    await expect(insert(-1, 0, 0)).rejects.toThrow();
  });
});

describeDb("migration safety", () => {
  it("refuses a migration that was edited after it was applied", async () => {
    const { pool } = await freshDb();
    await applyMigrations(pool, {
      files: migrationDir({ "0001_a.sql": "CREATE TABLE a (id int);" }),
    });
    const edited = migrationDir({
      "0001_a.sql": "CREATE TABLE a (id int, extra int);",
    });
    await expect(applyMigrations(pool, { files: edited })).rejects.toThrow(
      /0001_a\.sql was changed after it was applied/,
    );
    await expect(migrationStatus(pool, edited)).rejects.toBeInstanceOf(
      MigrationError,
    );
  });

  it("refuses a database that is ahead of the code", async () => {
    const { pool } = await freshDb();
    await applyMigrations(pool, {
      files: migrationDir({
        "0001_a.sql": "CREATE TABLE a (id int);",
        "0002_b.sql": "CREATE TABLE b (id int);",
      }),
    });
    const older = migrationDir({ "0001_a.sql": "CREATE TABLE a (id int);" });
    await expect(applyMigrations(pool, { files: older })).rejects.toThrow(
      /migration 0002_b, which this version of the code does not have/,
    );
  });

  it("applies later migrations incrementally and leaves earlier ones alone", async () => {
    const { pool } = await freshDb();
    const first = migrationDir({ "0001_a.sql": "CREATE TABLE a (id int);" });
    expect((await applyMigrations(pool, { files: first })).applied).toEqual([
      "0001",
    ]);
    const both = migrationDir({
      "0001_a.sql": "CREATE TABLE a (id int);",
      "0002_b.sql": "CREATE TABLE b (id int);",
    });
    expect((await applyMigrations(pool, { files: both })).applied).toEqual([
      "0002",
    ]);
    expect(await tablesOf(pool)).toEqual(["a", "b", "schema_migrations"]);
  });

  it("rolls a failed migration back completely and records nothing, so a retry works", async () => {
    const { pool } = await freshDb();
    const broken = migrationDir({
      "0001_a.sql": "CREATE TABLE a (id int);",
      "0002_b.sql":
        "CREATE TABLE b (id int); INSERT INTO b VALUES ('not a number');",
    });
    await expect(applyMigrations(pool, { files: broken })).rejects.toThrow(
      /0002_b\.sql failed/,
    );
    // 0001 stands; nothing of 0002 (not even its CREATE TABLE) remains.
    expect(await tablesOf(pool)).toEqual(["a", "schema_migrations"]);
    expect(
      (await pool.query("SELECT version FROM schema_migrations")).rows,
    ).toEqual([{ version: "0001" }]);

    const fixed = migrationDir({
      "0001_a.sql": "CREATE TABLE a (id int);",
      "0002_b.sql": "CREATE TABLE b (id int);",
    });
    expect((await applyMigrations(pool, { files: fixed })).applied).toEqual([
      "0002",
    ]);
  });

  it("two simultaneous runs apply each migration exactly once", async () => {
    const { pool } = await freshDb();
    const results = await Promise.all([
      applyMigrations(pool),
      applyMigrations(pool),
      applyMigrations(pool),
    ]);
    expect(results.flatMap((r) => r.applied)).toEqual([
      "0001",
      "0002",
      "0003",
      "0004",
      "0005",
      "0006",
      "0007",
    ]);
    expect(
      (await pool.query("SELECT count(*)::int AS n FROM schema_migrations"))
        .rows[0].n,
    ).toBe(7);
  });

  it("gives up with a clear message when another run holds the lock too long", async () => {
    const { pool } = await freshDb();
    const holder = await pool.connect();
    try {
      await holder.query("SELECT pg_advisory_lock($1::bigint)", [
        ADVISORY_LOCK_KEY,
      ]);
      await expect(
        applyMigrations(pool, { lockTimeoutMs: 400 }),
      ).rejects.toThrow(/another migration run has held the lock/);
    } finally {
      await holder.query("SELECT pg_advisory_unlock($1::bigint)", [
        ADVISORY_LOCK_KEY,
      ]);
      holder.release();
    }
    expect((await applyMigrations(pool)).applied).toEqual([
      "0001",
      "0002",
      "0003",
      "0004",
      "0005",
      "0006",
      "0007",
    ]);
  });
});

describeDb("withTransaction", () => {
  it("commits on success and rolls back on error, returning the connection either way", async () => {
    const { pool } = await freshDb();
    await pool.query("CREATE TABLE t (n int)");
    await withTransaction(pool, (c) => c.query("INSERT INTO t VALUES (1)"));
    await expect(
      withTransaction(pool, async (c) => {
        await c.query("INSERT INTO t VALUES (2)");
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect((await pool.query("SELECT n FROM t ORDER BY n")).rows).toEqual([
      { n: 1 },
    ]);
    expect(pool.idleCount).toBe(pool.totalCount);
  });
});

/**
 * The schema's own rules: the constraints that keep the later milestones'
 * invariants (one clan per player, no double Credits, no negative balances)
 * true even if application code has a bug.
 */
describeDb("schema constraints", () => {
  let db: TestDatabase;
  let pool: Pool;
  beforeAll(async () => {
    db = await createTestDatabase();
    pool = db.pool;
    await applyMigrations(pool);
  });
  afterAll(async () => {
    await db.drop();
  });

  let counter = 0;
  const newUser = async (kind = "registered"): Promise<string> => {
    counter += 1;
    const { rows } = await pool.query<{ id: string }>(
      "INSERT INTO users (public_id, kind) VALUES ($1, $2) RETURNING id",
      [`user${String(counter).padStart(6, "0")}`, kind],
    );
    return rows[0].id;
  };
  const newClan = async (
    tag: string,
    name: string,
    leader: string,
  ): Promise<number> => {
    const { rows } = await pool.query<{ id: number }>(
      "INSERT INTO clans (tag, name, created_by) VALUES ($1, $2, $3) RETURNING id",
      [tag, name, leader],
    );
    await pool.query(
      "INSERT INTO clan_members (clan_id, user_id, role) VALUES ($1, $2, 'leader')",
      [rows[0].id, leader],
    );
    return rows[0].id;
  };
  /** The SQLSTATE of a failing statement. */
  const sqlState = async (
    text: string,
    params: unknown[] = [],
  ): Promise<string> => {
    try {
      await pool.query(text, params);
    } catch (error) {
      return (error as { code: string }).code;
    }
    return "ok";
  };
  const UNIQUE = "23505";
  const CHECK = "23514";

  it("users: unique public_id, valid kind, and a username is a base plus a discriminator", async () => {
    const id = await newUser();
    const { rows } = await pool.query(
      "SELECT public_id FROM users WHERE id = $1",
      [id],
    );
    expect(
      await sqlState(
        "INSERT INTO users (public_id, kind) VALUES ($1, 'guest')",
        [rows[0].public_id],
      ),
    ).toBe(UNIQUE);
    expect(
      await sqlState(
        "INSERT INTO users (public_id, kind) VALUES ('abcdef12', 'admin')",
      ),
    ).toBe(CHECK);
    expect(
      await sqlState(
        "INSERT INTO users (public_id, kind) VALUES ('short', 'guest')",
      ),
    ).toBe(CHECK);
    // a discriminator needs a base; a base without one is a BARE name (0005),
    // unique among bare names and case-insensitively, separate from "Ann.0042"
    expect(
      await sqlState(
        "INSERT INTO users (public_id, kind, username_discriminator) VALUES ('nobase01', 'guest', '0042')",
      ),
    ).toBe(CHECK);
    expect(
      await sqlState(
        "INSERT INTO users (public_id, kind, username_base) VALUES ('bare0001', 'registered', 'Ann')",
      ),
    ).toBe("ok");
    expect(
      await sqlState(
        "INSERT INTO users (public_id, kind, username_base) VALUES ('bare0002', 'registered', 'ANN')",
      ),
    ).toBe(UNIQUE);
    expect(
      await sqlState(
        "INSERT INTO users (public_id, kind, username_base, username_discriminator) VALUES ('ann00001', 'registered', 'Ann', '0042')",
      ),
    ).toBe("ok");
    // names are case-insensitive: the same base with the same discriminator is taken
    expect(
      await sqlState(
        "INSERT INTO users (public_id, kind, username_base, username_discriminator) VALUES ('ann00002', 'registered', 'ANN', '0042')",
      ),
    ).toBe(UNIQUE);
    expect(
      await sqlState(
        "INSERT INTO users (public_id, kind, username_base, username_discriminator) VALUES ('ann00003', 'registered', 'Ann', '0043')",
      ),
    ).toBe("ok");
  });

  it("one currency: a wallet never goes negative", async () => {
    const id = await newUser();
    expect(
      await sqlState("INSERT INTO wallets (user_id, credits) VALUES ($1, -1)", [
        id,
      ]),
    ).toBe(CHECK);
    expect(
      await sqlState("INSERT INTO wallets (user_id) VALUES ($1)", [id]),
    ).toBe("ok");
    expect(
      await sqlState(
        "UPDATE wallets SET credits = credits - 1 WHERE user_id = $1",
        [id],
      ),
    ).toBe(CHECK);
    expect(
      (await pool.query("SELECT credits FROM wallets WHERE user_id = $1", [id]))
        .rows[0].credits,
    ).toBe("0");
  });

  it("the ledger rejects a zero change, and a game can pay a player only once", async () => {
    const id = await newUser();
    const reward = (
      game: string,
      day: string | null = "2026-10-12",
      ref: string | null = game,
    ) =>
      sqlState(
        "INSERT INTO currency_ledger (user_id, delta, balance_after, reason, ref_type, ref_id, reward_day) VALUES ($1, 100, 100, 'game_reward', $2, $3, $4)",
        [id, ref === null ? null : "game", ref, day],
      );
    expect(
      await sqlState(
        "INSERT INTO currency_ledger (user_id, delta, balance_after, reason) VALUES ($1, 0, 0, 'admin_grant')",
        [id],
      ),
    ).toBe(CHECK);
    expect(
      await sqlState(
        "INSERT INTO currency_ledger (user_id, delta, balance_after, reason) VALUES ($1, 5, 5, 'lottery')",
        [id],
      ),
    ).toBe(CHECK);
    expect(
      await sqlState(
        "INSERT INTO currency_ledger (user_id, delta, balance_after, reason) VALUES ($1, 5, 5, 'admin_grant')",
        [id],
      ),
    ).toBe("ok");
    expect(await reward("GAME0001")).toBe("ok");
    expect(await reward("GAME0001")).toBe(UNIQUE);
    expect(await reward("GAME0002")).toBe("ok");
    // a reward must say which game and which UTC day it counts towards
    expect(await reward("GAME0003", null)).toBe(CHECK);
    expect(await reward("GAME0004", "2026-10-12", null)).toBe(CHECK);
  });

  it("clans: a live tag or name is unique, case-insensitively, and disbanding frees it", async () => {
    const a = await newUser();
    const b = await newUser();
    const first = await newClan("ALPHA", "Alpha Wing", a);
    expect(
      await sqlState(
        "INSERT INTO clans (tag, name) VALUES ('ALPHA', 'Other Name')",
      ),
    ).toBe(UNIQUE);
    expect(
      await sqlState(
        "INSERT INTO clans (tag, name) VALUES ('BRAVO', 'ALPHA WING')",
      ),
    ).toBe(UNIQUE);
    expect(
      await sqlState("INSERT INTO clans (tag, name) VALUES ('alpha', 'Lower')"),
    ).toBe(CHECK);
    expect(
      await sqlState("INSERT INTO clans (tag, name) VALUES ('A', 'Short Tag')"),
    ).toBe(CHECK);
    expect(
      await sqlState(
        "INSERT INTO clans (tag, name) VALUES ('TOOLONG', 'Long Tag')",
      ),
    ).toBe(CHECK);
    expect(
      await sqlState(
        `INSERT INTO clans (tag, name) VALUES ('NAME1', '${"x".repeat(36)}')`,
      ),
    ).toBe(CHECK);
    await pool.query("UPDATE clans SET disbanded_at = now() WHERE id = $1", [
      first,
    ]);
    expect(
      await sqlState(
        "INSERT INTO clans (tag, name, created_by) VALUES ('ALPHA', 'Alpha Wing', $1)",
        [b],
      ),
    ).toBe("ok");
  });

  it("clans: a player is in one clan at a time, and a clan has exactly one leader", async () => {
    const [x, y, z] = [await newUser(), await newUser(), await newUser()];
    const one = await newClan("ONEX", "Clan One", x);
    const two = await newClan("TWOY", "Clan Two", y);
    // x already belongs to a clan (decision D2)
    expect(
      await sqlState(
        "INSERT INTO clan_members (clan_id, user_id, role) VALUES ($1, $2, 'member')",
        [two, x],
      ),
    ).toBe(UNIQUE);
    // a second leader in the same clan
    expect(
      await sqlState(
        "INSERT INTO clan_members (clan_id, user_id, role) VALUES ($1, $2, 'leader')",
        [one, z],
      ),
    ).toBe(UNIQUE);
    expect(
      await sqlState(
        "INSERT INTO clan_members (clan_id, user_id, role) VALUES ($1, $2, 'owner')",
        [one, z],
      ),
    ).toBe(CHECK);
    expect(
      await sqlState(
        "INSERT INTO clan_members (clan_id, user_id, role) VALUES ($1, $2, 'officer')",
        [one, z],
      ),
    ).toBe("ok");
    // leaving frees the player to join elsewhere
    await pool.query("DELETE FROM clan_members WHERE user_id = $1", [z]);
    expect(
      await sqlState(
        "INSERT INTO clan_members (clan_id, user_id, role) VALUES ($1, $2, 'member')",
        [two, z],
      ),
    ).toBe("ok");
  });

  it("clans: a join request is unique per clan and player", async () => {
    const [owner, joiner] = [await newUser(), await newUser()];
    const clan = await newClan("REQS", "Requests", owner);
    expect(
      await sqlState(
        "INSERT INTO clan_join_requests (clan_id, user_id) VALUES ($1, $2)",
        [clan, joiner],
      ),
    ).toBe("ok");
    expect(
      await sqlState(
        "INSERT INTO clan_join_requests (clan_id, user_id) VALUES ($1, $2)",
        [clan, joiner],
      ),
    ).toBe(UNIQUE);
  });

  it("games: the game code is unique, and records and players go with their game", async () => {
    const user = await newUser();
    const insertGame = (code: string) =>
      pool.query<{ id: string }>(
        "INSERT INTO games (game_code, source, type, started_at, ended_at, duration_s, human_players) VALUES ($1, 'server', 'Public', now(), now(), 600, 2) RETURNING id",
        [code],
      );
    const game = (await insertGame("ABCD1234")).rows[0].id;
    await expect(insertGame("ABCD1234")).rejects.toMatchObject({
      code: UNIQUE,
    });
    expect(
      await sqlState(
        "INSERT INTO games (game_code, source, type, started_at, ended_at, duration_s, human_players) VALUES ('XYZ99999', 'server', 'Ranked', now(), now(), 1, 1)",
      ),
    ).toBe(CHECK);
    await pool.query(
      "INSERT INTO game_records (game_id, record_gz, bytes) VALUES ($1, '\\x1f8b', 2)",
      [game],
    );
    await pool.query(
      "INSERT INTO game_players (game_id, client_id, user_id, username, result, completed) VALUES ($1, 'c1', $2, 'Ann', 'victory', true)",
      [game, user],
    );
    expect(
      await sqlState(
        "INSERT INTO game_players (game_id, client_id, username, result, completed) VALUES ($1, 'c1', 'Dup', 'defeat', false)",
        [game],
      ),
    ).toBe(UNIQUE);
    expect(
      await sqlState(
        "INSERT INTO game_players (game_id, client_id, username, result, completed) VALUES ($1, 'c2', 'Bob', 'won', false)",
        [game],
      ),
    ).toBe(CHECK);

    // deleting an account keeps the game history, anonymised; deleting a game removes what hangs off it
    await pool.query("DELETE FROM users WHERE id = $1", [user]);
    expect(
      (
        await pool.query(
          "SELECT user_id FROM game_players WHERE game_id = $1",
          [game],
        )
      ).rows,
    ).toEqual([{ user_id: null }]);
    await pool.query("DELETE FROM games WHERE id = $1", [game]);
    expect(
      (
        await pool.query(
          "SELECT count(*)::int AS n FROM game_players WHERE game_id = $1",
          [game],
        )
      ).rows[0].n,
    ).toBe(0);
    expect(
      (
        await pool.query(
          "SELECT count(*)::int AS n FROM game_records WHERE game_id = $1",
          [game],
        )
      ).rows[0].n,
    ).toBe(0);
  });

  it("an account's own data goes with it", async () => {
    const id = await newUser();
    await pool.query("INSERT INTO wallets (user_id) VALUES ($1)", [id]);
    await pool.query(
      "INSERT INTO auth_identities (user_id, provider, provider_user_id) VALUES ($1, 'discord', $2)",
      [id, `d-${id}`],
    );
    await pool.query(
      "INSERT INTO refresh_sessions (user_id, family_id, token_hash, expires_at) VALUES ($1, gen_random_uuid(), decode('aa', 'hex'), now() + interval '30 days')",
      [id],
    );
    await pool.query(
      "INSERT INTO user_flares (user_id, flare, source) VALUES ($1, 'flag:delta_mark', 'admin')",
      [id],
    );
    await pool.query("DELETE FROM users WHERE id = $1", [id]);
    for (const table of [
      "wallets",
      "auth_identities",
      "refresh_sessions",
      "user_flares",
    ]) {
      expect(
        (
          await pool.query(
            `SELECT count(*)::int AS n FROM ${table} WHERE user_id = $1`,
            [id],
          )
        ).rows[0].n,
        table,
      ).toBe(0);
    }
  });

  it("identities: one per provider per account, and a provider identity belongs to one account", async () => {
    const [a, b] = [await newUser(), await newUser()];
    const link = (user: string, provider: string, pid: string) =>
      sqlState(
        "INSERT INTO auth_identities (user_id, provider, provider_user_id) VALUES ($1, $2, $3)",
        [user, provider, pid],
      );
    expect(await link(a, "google", "g-1")).toBe("ok");
    expect(await link(b, "google", "g-1")).toBe(UNIQUE);
    expect(await link(a, "google", "g-2")).toBe(UNIQUE);
    expect(await link(a, "discord", "d-1")).toBe("ok");
    expect(await link(a, "myspace", "m-1")).toBe(CHECK);
  });

  it("game servers: letters are a-z and state is open, draining or fenced", async () => {
    const insert = (letter: string, state: string) =>
      sqlState(
        "INSERT INTO game_servers (site, letter, host, version, num_workers, state) VALUES ('example.com', $1, 'h', 'v', 2, $2)",
        [letter, state],
      );
    expect(await insert("a", "open")).toBe("ok");
    expect(await insert("a", "open")).toBe(UNIQUE);
    expect(await insert("B", "open")).toBe(CHECK);
    expect(await insert("b", "closed")).toBe(CHECK);
  });
});
