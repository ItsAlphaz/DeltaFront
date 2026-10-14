import {
  usesAccountApi,
  usesCosmeticCatalog,
} from "@openfront/shared/AccountFeatures";
import fs from "node:fs";
import type { Server } from "node:http";
import path from "node:path";
import type { Pool } from "pg";
import { createApp } from "./app";
import { createMailer, type Mailer } from "./auth/email";
import { createEphemeralKeyRing, loadKeyRing, type KeyRing } from "./auth/keys";
import {
  createOAuthProviders,
  type OAuthEndpoints,
  type OAuthProviderId,
} from "./auth/oauth/providers";
import { TokenService } from "./auth/tokens";
import { loadCatalog } from "./catalog/load";
import type { AccountApiConfig } from "./config";
import { describeConfig } from "./config";
import { loadMigrationFiles, migrationStatus } from "./db/migrator";
import { createPool } from "./db/pool";
import { loadReservedClanNames } from "./domain/clans";
import { runMaintenance } from "./domain/lifecycle";
import { startLeaderboardJob } from "./jobs/leaderboard";
import { startSeasonJob } from "./jobs/seasons";
import { createLimiters, type RateLimit, type RateLimitName } from "./limits";
import type { Logger } from "./logger";
import { createReadiness } from "./readiness";
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
  /** Replace the configured email delivery (tests). */
  mailer?: Mailer;
  limits?: Partial<Record<RateLimitName, RateLimit>>;
  /** Read the cosmetic catalog from here instead of `src/account-api/catalog`. */
  catalogDir?: string;
}

/** How often the deletion and guest-cleanup jobs run. */
const MAINTENANCE_INTERVAL_MS = 10 * 60 * 1000;

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
    mailer: overrides.mailer ?? createMailer(config.email, overrides.fetchFn),
    // Checked once, here: a catalog with a mistake in it stops the API from
    // starting (CatalogError) instead of failing when a player opens a page.
    catalog: usesCosmeticCatalog(config.features)
      ? loadCatalog({
          publicOrigin: config.publicOrigin,
          dir: overrides.catalogDir,
        })
      : null,
    // The reserved clan tags and names, checked once like the catalog.
    reserved: loadReservedClanNames(),
    turnstile:
      overrides.turnstile ??
      createTurnstile({
        secret: config.turnstileSecret,
        allowedHostnames: config.turnstileHostnames,
        expectedAction: config.turnstileAction,
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
    const readiness = createReadiness({
      pool,
      keys:
        backend !== undefined && config.features.accounts ? backend.keys : null,
      log,
    });
    const app = createApp({ config, log, backend, readiness });
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

    // Deletions and idle-guest cleanup. Only a deployment with sign-in has
    // anything to do; the timer never keeps the process alive.
    let stopLeaderboard: (() => void) | null = null;
    if (backend !== undefined && config.features.leaderboards)
      stopLeaderboard = startLeaderboardJob(pool, log);
    let stopSeasons: (() => void) | null = null;
    if (
      backend !== undefined &&
      config.features.progression &&
      config.features.accounts
    )
      stopSeasons = startSeasonJob(pool, log);
    let maintenance: NodeJS.Timeout | null = null;
    if (backend !== undefined && config.features.accounts) {
      maintenance = setInterval(
        () => void runMaintenance(pool, log),
        MAINTENANCE_INTERVAL_MS,
      );
      maintenance.unref();
    }

    return {
      server,
      pool,
      port,
      close: async () => {
        // Draining: /ready turns 503 so a proxy stops sending traffic, new
        // connections are refused, idle keep-alive connections are closed at
        // once, and requests in flight get `shutdownTimeoutMs` to finish
        // before their connections are cut. Only then is the pool closed.
        readiness.startDraining();
        if (maintenance !== null) clearInterval(maintenance);
        stopLeaderboard?.();
        stopSeasons?.();
        const closed = new Promise<void>((resolve) =>
          server.close(() => resolve()),
        );
        server.closeIdleConnections();
        const cutoff = setTimeout(() => {
          log.warn("shutdown: cutting connections that did not finish in time");
          server.closeAllConnections();
        }, config.shutdownTimeoutMs);
        try {
          await closed;
        } finally {
          clearTimeout(cutoff);
        }
        await pool.end();
      },
    };
  } catch (error) {
    await pool.end().catch(() => undefined);
    throw error;
  }
}
