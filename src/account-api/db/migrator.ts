import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Pool, PoolClient } from "pg";
import type { Logger } from "../logger";

/**
 * Forward-only SQL migrations for PostgreSQL.
 *
 * Migrations are `src/account-api/migrations/NNNN_name.sql`, numbered from
 * 0001 with no gaps. Each one runs in its own transaction together with the
 * row that records it in `schema_migrations`, so a failed migration leaves no
 * trace and the next run retries it. Applied migrations are never edited: the
 * SHA-256 of each file is stored and a changed file is an error, as is a
 * database that has migrations this code does not know (it was migrated by a
 * newer version). Only one migration run proceeds at a time (an advisory
 * lock), so two deploys cannot race.
 *
 * Statements that cannot run inside a transaction (CREATE INDEX CONCURRENTLY)
 * are not supported; add them as a reviewed exception when one is needed.
 */

export const MIGRATIONS_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "migrations",
);

/** Arbitrary but fixed: the advisory lock that serialises migration runs. */
export const ADVISORY_LOCK_KEY = "7374410001";

const FILE_NAME = /^(\d{4})_([a-z0-9][a-z0-9_]*)\.sql$/;

export class MigrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MigrationError";
  }
}

export interface MigrationFile {
  version: string;
  name: string;
  fileName: string;
  sql: string;
  checksum: string;
}

export interface AppliedMigration {
  version: string;
  name: string;
  checksum: string;
  appliedAt: Date;
}

export interface MigrationStatus {
  applied: AppliedMigration[];
  /** On disk, not yet applied, in order. */
  pending: MigrationFile[];
}

export function checksumOf(sql: string): string {
  return createHash("sha256").update(sql, "utf8").digest("hex");
}

/** Reads and validates the migration files in `dir`. */
export function loadMigrationFiles(
  dir: string = MIGRATIONS_DIR,
): MigrationFile[] {
  const files: MigrationFile[] = [];
  for (const fileName of fs.readdirSync(dir).sort()) {
    if (fileName.startsWith(".")) continue;
    const match = FILE_NAME.exec(fileName);
    if (match === null) {
      throw new MigrationError(
        `${fileName}: migration files must be named NNNN_description.sql (lowercase, digits and underscores)`,
      );
    }
    const sql = fs.readFileSync(path.join(dir, fileName), "utf8");
    if (sql.trim() === "") {
      throw new MigrationError(`${fileName}: migration is empty`);
    }
    files.push({
      version: match[1],
      name: match[2],
      fileName,
      sql,
      checksum: checksumOf(sql),
    });
  }
  files.forEach((file, index) => {
    const expected = String(index + 1).padStart(4, "0");
    if (file.version !== expected) {
      throw new MigrationError(
        `${file.fileName}: expected version ${expected} (versions start at 0001 and have no gaps or duplicates)`,
      );
    }
  });
  return files;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Waits for the migration lock on this session; throws if another run holds it too long. */
async function acquireLock(
  client: PoolClient,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { rows } = await client.query<{ locked: boolean }>(
      "SELECT pg_try_advisory_lock($1::bigint) AS locked",
      [ADVISORY_LOCK_KEY],
    );
    if (rows[0].locked) return;
    if (Date.now() >= deadline) {
      throw new MigrationError(
        `another migration run has held the lock for more than ${Math.round(timeoutMs / 1000)}s`,
      );
    }
    await sleep(250);
  }
}

async function ensureTable(client: PoolClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    text PRIMARY KEY,
      name       text NOT NULL,
      checksum   text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);
}

async function readApplied(client: PoolClient): Promise<AppliedMigration[]> {
  const { rows } = await client.query<{
    version: string;
    name: string;
    checksum: string;
    applied_at: Date;
  }>(
    "SELECT version, name, checksum, applied_at FROM schema_migrations ORDER BY version",
  );
  return rows.map((row) => ({
    version: row.version,
    name: row.name,
    checksum: row.checksum,
    appliedAt: row.applied_at,
  }));
}

/**
 * Checks the database's history against the files and returns what is
 * pending. Throws if a recorded migration was edited, is unknown to this code,
 * or the history is not a prefix of the files.
 */
function reconcile(
  applied: AppliedMigration[],
  files: MigrationFile[],
): MigrationStatus {
  applied.forEach((row, index) => {
    const file = files[index];
    if (file === undefined || file.version !== row.version) {
      throw new MigrationError(
        `the database has migration ${row.version}_${row.name}, which this version of the code does not have (was it migrated by a newer version?)`,
      );
    }
    if (file.checksum !== row.checksum) {
      throw new MigrationError(
        `${file.fileName} was changed after it was applied; applied migrations must never be edited (add a new migration instead)`,
      );
    }
  });
  return { applied, pending: files.slice(applied.length) };
}

export interface MigrateOptions {
  files?: MigrationFile[];
  log?: Pick<Logger, "info">;
  /** How long to wait for another run to finish. Default 60 s. */
  lockTimeoutMs?: number;
}

/**
 * Applies every pending migration, in order. Returns the versions applied
 * (empty when the database is already current, so it is safe to run twice).
 */
export async function applyMigrations(
  pool: Pick<Pool, "connect">,
  options: MigrateOptions = {},
): Promise<{ applied: string[] }> {
  const files = options.files ?? loadMigrationFiles();
  const client = await pool.connect();
  const applied: string[] = [];
  try {
    await acquireLock(client, options.lockTimeoutMs ?? 60_000);
    try {
      await ensureTable(client);
      const { pending } = reconcile(await readApplied(client), files);
      for (const file of pending) {
        options.log?.info(`applying migration ${file.fileName}`);
        try {
          await client.query("BEGIN");
          // Migrations may be slow (index builds); lift the pool's per-statement cap.
          await client.query("SET LOCAL statement_timeout = 0");
          await client.query(file.sql);
          await client.query(
            "INSERT INTO schema_migrations (version, name, checksum) VALUES ($1, $2, $3)",
            [file.version, file.name, file.checksum],
          );
          await client.query("COMMIT");
        } catch (error) {
          await client.query("ROLLBACK").catch(() => undefined);
          const reason = error instanceof Error ? error.message : String(error);
          throw new MigrationError(`${file.fileName} failed: ${reason}`);
        }
        applied.push(file.version);
      }
    } finally {
      await client
        .query("SELECT pg_advisory_unlock($1::bigint)", [ADVISORY_LOCK_KEY])
        .catch(() => undefined);
    }
  } finally {
    client.release();
  }
  return { applied };
}

/** What has been applied and what is pending. Read-only: it creates nothing. */
export async function migrationStatus(
  pool: Pick<Pool, "connect">,
  files: MigrationFile[] = loadMigrationFiles(),
): Promise<MigrationStatus> {
  const client = await pool.connect();
  try {
    const { rows } = await client.query<{ exists: boolean }>(
      "SELECT to_regclass('schema_migrations') IS NOT NULL AS exists",
    );
    const applied = rows[0].exists ? await readApplied(client) : [];
    return reconcile(applied, files);
  } finally {
    client.release();
  }
}
