import { usesAccountApi } from "@openfront/shared/AccountFeatures";
import fs from "node:fs";
import type { Server } from "node:http";
import path from "node:path";
import type { Pool } from "pg";
import { createApp } from "./app";
import { createEphemeralKeyRing, loadKeyRing, type KeyRing } from "./auth/keys";
import {
  createOAuthProviders,
  type OAuthEndpoints,
  type OAuthProviderId,
} from "./auth/oauth/providers";
import { TokenService } from "./auth/tokens";
import type { AccountApiConfig } from "./config";
import { describeConfig } from "./config";
import { loadMigrationFiles, migrationStatus } from "./db/migrator";
import { createPool } from "./db/pool";
import { createLimiters, type RateLimit, type RateLimitName } from "./limits";
import type { Logger } from "./logger";
import type { AppDeps } from "./routes/common";
import { createTurnstile, type Turnstile } from "./turnstile";

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

/** Replaceable pieces, for tests and for running against stand-in providers. */
export interface ServiceOverrides {
  pool?: Pool;
  keys?: KeyRing;
  fetchFn?: typeof fetch;
  oauthEndpoints?: Partial<Record<OAuthProviderId, OAuthEndpoints>>;
  turnstile?: Turnstile;
  limits?: Partial<Record<RateLimitName, RateLimit>>;
}

/** Where a dev run keeps its generated signing key (gitignored). */
export const DEV_KEY_DIR = ".account-api-dev";

export async function buildBackend(
  config: AccountApiConfig,
  log: Logger,
  pool: Pool,
  overrides: ServiceOverrides = {},
): Promise<AppDeps> {
  const keys =
    overrides.keys ??
    (config.features.accounts
      ? await loadKeyRing({
          privateKeyPath: config.jwt.privateKeyPath,
          previousPublicKeyPath: config.jwt.previousPublicKeyPath,
          devKeyDir: config.env === "dev" ? path.resolve(DEV_KEY_DIR) : null,
        })
      : // Sign-in is off, so nothing is signed; this key is never published.
        await createEphemeralKeyRing());
  return {
    config,
    log,
    pool,
    keys,
    // `iss` and `aud` are what the client and the game server check: the API's
    // public origin and the site's domain.
    tokens: new TokenService(keys, config.publicOrigin, config.domain),
    limiters: createLimiters(overrides.limits),
    providers: createOAuthProviders(
      config,
      overrides.fetchFn,
      overrides.oauthEndpoints,
    ),
    turnstile:
      overrides.turnstile ??
      createTurnstile({
        secret: config.turnstileSecret,
        fetchFn: overrides.fetchFn,
        log,
      }),
  };
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
  overrides: ServiceOverrides = {},
): Promise<RunningService> {
  checkSecretFiles(config);
  const pool = overrides.pool ?? createPool(config.database, log);
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

    const backend = usesAccountApi(config.features)
      ? await buildBackend(config, log, pool, overrides)
      : undefined;
    const app = createApp({ config, log, backend });
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
