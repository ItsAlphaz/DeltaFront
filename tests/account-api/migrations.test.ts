// @vitest-environment node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  checksumOf,
  loadMigrationFiles,
  MigrationError,
  MIGRATIONS_DIR,
} from "../../src/account-api/db/migrator";

/** Every table plan section 6 puts in the first migration (magic_link_tokens is M8, leaderboard_players is M3). */
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
function dirWith(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "df-migrations-"));
  tempDirs.push(dir);
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), content);
  }
  return dir;
}
afterEach(() => {
  for (const dir of tempDirs.splice(0))
    fs.rmSync(dir, { recursive: true, force: true });
});

describe("the shipped migrations", () => {
  const files = loadMigrationFiles(MIGRATIONS_DIR);

  it("are valid, numbered from 0001 with no gaps", () => {
    expect(files.length).toBeGreaterThanOrEqual(1);
    expect(files.map((f) => f.version)).toEqual(
      files.map((_, i) => String(i + 1).padStart(4, "0")),
    );
    expect(files[0].fileName).toBe("0001_init.sql");
  });

  it("have a stable checksum per file", () => {
    for (const file of files) {
      expect(file.checksum).toMatch(/^[0-9a-f]{64}$/);
      expect(file.checksum).toBe(checksumOf(file.sql));
    }
    expect(checksumOf("a")).not.toBe(checksumOf("b"));
  });

  it("0001 creates exactly the M0 tables from the plan", () => {
    const created = [
      ...files[0].sql.matchAll(/^CREATE TABLE (\w+)\s*\(/gm),
    ].map((m) => m[1]);
    expect([...created].sort()).toEqual([...M0_TABLES].sort());
  });

  it("0001 leaves out what later milestones own", () => {
    const sql = files[0].sql.replace(/^\s*--.*$/gm, "");
    // Magic-link email sign-in is M8 (decisions D3/D4, migration 0003); the leaderboard table is M3.
    expect(sql).not.toMatch(/magic_link_tokens/);
    expect(sql).not.toMatch(/leaderboard_players/);
    // One currency (D1): no premium balance anywhere.
    expect(sql).not.toMatch(/\bhard\b|plutonium|caps\b/i);
    // PostgreSQL only.
    expect(sql).not.toMatch(/sqlite|AUTOINCREMENT|PRAGMA/i);
  });

  it("0002 adds only the derived leaderboard table, with one row per position", () => {
    expect(files[1].fileName).toBe("0002_leaderboard.sql");
    const sql = files[1].sql.replace(/^\s*--.*$/gm, "");
    expect(
      [...sql.matchAll(/^CREATE TABLE (\w+)\s*\(/gm)].map((m) => m[1]),
    ).toEqual(["leaderboard_players"]);
    expect(sql).toMatch(/CREATE UNIQUE INDEX leaderboard_players_position_idx/);
    // nothing for later milestones
    expect(sql).not.toMatch(/inventory|purchases|clans|friends/i);
  });

  it("0003 adds only the magic-link table: a hashed token as the key, an expiry, a rate-limit index, no raw token column", () => {
    expect(files[2].fileName).toBe("0003_magic_links.sql");
    const sql = files[2].sql.replace(/^\s*--.*$/gm, "");
    expect(
      [...sql.matchAll(/^CREATE TABLE (\w+)\s*\(/gm)].map((m) => m[1]),
    ).toEqual(["magic_link_tokens"]);
    expect(sql).toMatch(/token_hash\s+bytea PRIMARY KEY/);
    expect(sql).toMatch(/expires_at\s+timestamptz NOT NULL/);
    expect(sql).toMatch(/consumed_at\s+timestamptz/);
    expect(sql).toMatch(
      /CREATE INDEX magic_link_tokens_email_created_idx\s+ON magic_link_tokens \(email, created_at\)/,
    );
    expect(sql).toMatch(/CREATE INDEX magic_link_tokens_expires_idx/);
    expect(sql).not.toMatch(/\btoken\s+(text|varchar)/i);
    expect(sql).not.toMatch(/ALTER TABLE|DROP /i); // no change to the account or session tables
  });

  it("0004 adds only users.verified: not null, false by default, nothing dropped", () => {
    expect(files[3].fileName).toBe("0004_verified_accounts.sql");
    const sql = files[3].sql.replace(/^\s*--.*$/gm, "").trim();
    expect(sql).toBe(
      "ALTER TABLE users ADD COLUMN verified boolean NOT NULL DEFAULT false;",
    );
  });

  it("0005 adds the bare-username entitlement (false by default) and the bare-name uniqueness, rewriting no username", () => {
    expect(files[4].fileName).toBe("0005_bare_usernames.sql");
    const sql = files[4].sql.replace(/^\s*--.*$/gm, "");
    expect(sql).toMatch(
      /ALTER TABLE users ADD COLUMN bare_username_enabled boolean NOT NULL DEFAULT false;/,
    );
    expect(sql).toMatch(
      /CREATE UNIQUE INDEX users_bare_username_unique\s+ON users \(username_base\)\s+WHERE username_discriminator IS NULL AND username_base IS NOT NULL;/,
    );
    // Existing names are never rewritten, and nothing is dropped but the old
    // base-and-discriminator-together CHECK.
    expect(sql).not.toMatch(/UPDATE users|DROP TABLE|DROP COLUMN/i);
  });

  it("0001 encodes the owner's one-clan rule and the single-currency wallet", () => {
    const sql = files[0].sql;
    expect(sql).toMatch(/UNIQUE \(user_id\)/); // clan_members: one clan at a time
    expect(sql).toMatch(
      /credits\s+bigint NOT NULL DEFAULT 0 CHECK \(credits >= 0\)/,
    );
  });
});

describe("loadMigrationFiles", () => {
  it("reads files in version order", () => {
    const dir = dirWith({
      "0002_b.sql": "SELECT 2;",
      "0001_a.sql": "SELECT 1;",
    });
    expect(loadMigrationFiles(dir).map((f) => [f.version, f.name])).toEqual([
      ["0001", "a"],
      ["0002", "b"],
    ]);
  });

  it("ignores dotfiles", () => {
    const dir = dirWith({ "0001_a.sql": "SELECT 1;", ".DS_Store": "x" });
    expect(loadMigrationFiles(dir)).toHaveLength(1);
  });

  it("rejects badly named files", () => {
    for (const name of [
      "init.sql",
      "1_init.sql",
      "0001-init.sql",
      "0001_Init.sql",
      "0001_init.SQL",
      "0001_init.sql.bak",
      "0001_.sql",
    ]) {
      const dir = dirWith({ [name]: "SELECT 1;" });
      expect(() => loadMigrationFiles(dir), name).toThrow(MigrationError);
    }
  });

  it("rejects a gap, a duplicate and a file that does not start at 0001", () => {
    expect(() =>
      loadMigrationFiles(
        dirWith({ "0001_a.sql": "SELECT 1;", "0003_c.sql": "SELECT 3;" }),
      ),
    ).toThrow(/expected version 0002/);
    expect(() =>
      loadMigrationFiles(
        dirWith({ "0001_a.sql": "SELECT 1;", "0001_b.sql": "SELECT 2;" }),
      ),
    ).toThrow(/expected version 0002/);
    expect(() =>
      loadMigrationFiles(dirWith({ "0002_b.sql": "SELECT 2;" })),
    ).toThrow(/expected version 0001/);
  });

  it("rejects an empty migration", () => {
    expect(() => loadMigrationFiles(dirWith({ "0001_a.sql": "  \n" }))).toThrow(
      /empty/,
    );
  });
});
