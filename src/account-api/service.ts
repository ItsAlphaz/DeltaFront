import fs from "node:fs";
import type { Server } from "node:http";
import type { Pool } from "pg";
import { createApp } from "./app";
import type { AccountApiConfig } from "./config";
import { describeConfig } from "./config";
import { loadMigrationFiles, migrationStatus } from "./db/migrator";
import { createPool } from "./db/pool";
import type { Logger } from "./logger";

export interface RunningService {
  server: Server;
  pool: Pool;
  /** The port actually bound (differs from config.port when that was 0). */
  port: number;
  close(): Promise<void>;
}

export class StartupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StartupError";
  }
}

/** Key files named in the configuration must exist, so a bad path fails at boot, not at the first sign-in. */
export function checkSecretFiles(config: AccountApiConfig): void {
  for (const [name, file] of [
    ["JWT_PRIVATE_KEY_PATH", config.jwt.privateKeyPath],
    ["JWT_PREVIOUS_PUBLIC_KEY_PATH", config.jwt.previousPublicKeyPath],
  ] as const) {
    if (file === null) continue;
    try {
      fs.accessSync(file, fs.constants.R_OK);
    } catch {
      throw new StartupError(`${name} points to a file that cannot be read`);
    }
  }
}

/**
 * Starts the service: checks the key files, connects to PostgreSQL, refuses to
 * run against a database whose migrations are not current, and listens.
 * Migrations are never applied implicitly; run `npm run account-api:migrate`
 * first (a deploy step).
 */
export async function startAccountApi(
  config: AccountApiConfig,
  log: Logger,
  options: { pool?: Pool } = {},
): Promise<RunningService> {
  checkSecretFiles(config);
  const pool = options.pool ?? createPool(config.database, log);
  try {
    try {
      await pool.query("SELECT 1");
    } catch (error) {
      throw new StartupError(
        `cannot connect to PostgreSQL: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const status = await migrationStatus(pool, loadMigrationFiles());
    if (status.pending.length > 0) {
      throw new StartupError(
        `the database has ${status.pending.length} pending migration(s) (next: ${status.pending[0].fileName}); run "npm run account-api:migrate" first`,
      );
    }
    for (const warning of config.warnings) log.warn(warning);

    const app = createApp({ config, log });
    const server = await new Promise<Server>((resolve, reject) => {
      const s = app.listen(config.port, () => resolve(s));
      s.once("error", reject);
    });
    const address = server.address();
    const port =
      typeof address === "object" && address !== null
        ? address.port
        : config.port;
    log.info("account API listening", { port, config: describeConfig(config) });

    return {
      server,
      pool,
      port,
      close: async () => {
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await pool.end();
      },
    };
  } catch (error) {
    await pool.end().catch(() => undefined);
    throw error;
  }
}
