import type { Pool } from "pg";
import type { KeyRing } from "./auth/keys";
import { loadMigrationFiles, migrationStatus } from "./db/migrator";

/**
 * Readiness, as opposed to liveness (`/health`, which only says the process
 * answers). A load balancer or supervisor that wants to know whether to send
 * traffic asks `/ready`: is PostgreSQL reachable, are the migrations current,
 * is there a signing key, and is the process not shutting down?
 *
 * The answer names each check "ok" or "fail" and nothing more: no version
 * numbers, file names, hosts or error text leave the process (the details go
 * to the log).
 */

export type CheckState = "ok" | "fail" | "off";

export interface ReadinessReport {
  ready: boolean;
  checks: {
    database: CheckState;
    migrations: CheckState;
    signingKey: CheckState;
    draining: CheckState;
  };
}

export interface Readiness {
  check(): Promise<ReadinessReport>;
  /** Called when shutdown begins: from then on the answer is "not ready". */
  startDraining(): void;
}

export function createReadiness(options: {
  pool: Pick<Pool, "query">;
  /** Present when sign-in is on; null means no signing key is needed. */
  keys: Pick<KeyRing, "jwks"> | null;
  log: { warn: (message: string, meta?: object) => unknown };
  now?: () => number;
  /** A probe hammering the endpoint costs at most one check per this long. */
  cacheMs?: number;
  /** Per-check ceiling, so a hung database answers "fail" instead of hanging the probe. */
  timeoutMs?: number;
}): Readiness {
  const files = loadMigrationFiles();
  const now = options.now ?? Date.now;
  const cacheMs = options.cacheMs ?? 2_000;
  const timeoutMs = options.timeoutMs ?? 2_500;
  let draining = false;
  let cached: { at: number; report: Promise<ReadinessReport> } | null = null;

  const withTimeout = <T>(work: Promise<T>): Promise<T> =>
    Promise.race([
      work,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("timed out")), timeoutMs).unref(),
      ),
    ]);

  async function run(): Promise<ReadinessReport> {
    let database: CheckState = "ok";
    let migrations: CheckState = "ok";
    try {
      await withTimeout(options.pool.query("SELECT 1"));
    } catch (error) {
      database = "fail";
      migrations = "fail";
      options.log.warn("readiness: database check failed", {
        error: error instanceof Error ? error.message : "unknown",
      });
    }
    if (database === "ok") {
      try {
        const status = await withTimeout(
          migrationStatus(options.pool as Pool, files),
        );
        if (status.pending.length > 0) {
          migrations = "fail";
          options.log.warn("readiness: migrations are not current", {
            pending: status.pending.length,
          });
        }
      } catch (error) {
        migrations = "fail";
        options.log.warn("readiness: migration check failed", {
          error: error instanceof Error ? error.message : "unknown",
        });
      }
    }
    const signingKey: CheckState =
      options.keys === null
        ? "off"
        : options.keys.jwks().keys.length > 0
          ? "ok"
          : "fail";
    const checks = {
      database,
      migrations,
      signingKey,
      draining: draining ? ("fail" as const) : ("ok" as const),
    };
    return {
      ready: Object.values(checks).every((c) => c !== "fail"),
      checks,
    };
  }

  return {
    check() {
      // Draining is checked on every call, never from the cache.
      if (draining) {
        return Promise.resolve({
          ready: false,
          checks: {
            database: "off",
            migrations: "off",
            signingKey: "off",
            draining: "fail",
          },
        });
      }
      if (cached === null || now() - cached.at >= cacheMs) {
        cached = { at: now(), report: run() };
      }
      return cached.report;
    },
    startDraining() {
      draining = true;
    },
  };
}
