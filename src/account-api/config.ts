import {
  ACCOUNT_FEATURE_NAMES,
  ACCOUNT_FEATURES_ENV,
  AUTH_PROVIDERS,
  resolveAccountFeatures,
  usesAccountApi,
  type AccountFeatures,
} from "@openfront/shared/AccountFeatures";
import { z } from "zod";

/**
 * Environment parsing and validation for the account API.
 *
 * Everything the service reads from the environment is declared here, checked
 * once at startup, and reported all together: a deployment with three
 * mistakes sees three messages, not one at a time. Messages name variables and
 * never print their values, so a bad secret cannot leak into a log.
 *
 * What is required depends on the environment (GAME_ENV, the same variable the
 * game server uses) and on which features are switched on
 * (DF_ACCOUNT_FEATURES): dev is forgiving, staging and prod are not.
 */

export type AccountApiEnv = "dev" | "staging" | "prod";

export interface OAuthCredentials {
  clientId: string;
  clientSecret: string;
}

export interface DatabaseConfig {
  /** Contains the password: never log it (use describeConfig). */
  url: string;
  poolMax: number;
}

export interface AccountApiConfig {
  env: AccountApiEnv;
  /** The site the API serves, e.g. `example.com`; the JWT audience. */
  domain: string;
  port: number;
  /** Where browsers reach this API; the JWT issuer (`https://api.<domain>`). */
  publicOrigin: string;
  /** Origins allowed to call the API from a browser (CORS and CSRF checks). */
  allowedOrigins: string[];
  database: DatabaseConfig;
  logLevel: "error" | "warn" | "info" | "debug";
  /**
   * How many reverse proxies sit in front of the API (nginx = 1). Decides
   * which X-Forwarded-For entry is the client address for rate limits and for
   * the IP the game server's Turnstile check forwards. 0 trusts no header.
   */
  trustProxyHops: number;
  /** Cloudflare Turnstile secret for /join_verify; null skips the check (dev only). */
  turnstileSecret: string | null;
  features: AccountFeatures;
  jwt: {
    privateKeyPath: string | null;
    previousPublicKeyPath: string | null;
  };
  oauth: {
    discord: OAuthCredentials | null;
    google: OAuthCredentials | null;
  };
  /** Non-fatal findings (only produced in dev; staging and prod fail instead). */
  warnings: string[];
}

/** Thrown for any invalid configuration; `issues` has one line per problem. */
export class ConfigError extends Error {
  constructor(readonly issues: string[]) {
    super(
      `Invalid account API configuration:\n${issues
        .map((issue) => `  - ${issue}`)
        .join("\n")}`,
    );
    this.name = "ConfigError";
  }
}

export const DEFAULT_API_PORT = 8787;
const DEFAULT_POOL_MAX = 10;
const DEV_ALLOWED_ORIGIN = "http://localhost:9000";

type Env = Record<string, string | undefined>;

const trimmed = (env: Env, name: string): string | undefined => {
  const value = env[name]?.trim();
  return value === undefined || value === "" ? undefined : value;
};

const HOSTNAME =
  /^(localhost|([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z][a-z0-9-]*[a-z0-9])$/;

/** A bare origin (`https://host[:port]`): no path, query or trailing slash. */
function parseOrigin(value: string): URL | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    if (url.origin !== value) return null;
    return url;
  } catch {
    return null;
  }
}

/** The one environment variable a database command (migrate) needs. */
export function loadDatabaseConfig(env: Env = process.env): DatabaseConfig {
  const issues: string[] = [];
  const database = parseDatabase(env, issues);
  if (issues.length > 0 || database === null) throw new ConfigError(issues);
  return database;
}

function parseDatabase(env: Env, issues: string[]): DatabaseConfig | null {
  let url: string | null = null;
  const rawUrl = trimmed(env, "DATABASE_URL");
  if (rawUrl === undefined) {
    issues.push(
      "DATABASE_URL is required (a postgres:// connection string; there is no fallback database)",
    );
  } else if (!/^postgres(ql)?:\/\//.test(rawUrl)) {
    issues.push(
      "DATABASE_URL must be a PostgreSQL connection string starting with postgres:// or postgresql://",
    );
  } else {
    try {
      new URL(rawUrl);
      url = rawUrl;
    } catch {
      issues.push("DATABASE_URL is not a valid connection URL");
    }
  }

  let poolMax = DEFAULT_POOL_MAX;
  const rawPool = trimmed(env, "DATABASE_POOL_MAX");
  if (rawPool !== undefined) {
    const parsed = z.coerce.number().int().min(1).max(100).safeParse(rawPool);
    if (parsed.success && /^\d+$/.test(rawPool)) poolMax = parsed.data;
    else issues.push("DATABASE_POOL_MAX must be an integer from 1 to 100");
  }
  return url === null ? null : { url, poolMax };
}

function parseOAuth(
  env: Env,
  provider: "DISCORD" | "GOOGLE",
  issues: string[],
): OAuthCredentials | null {
  const idName = `${provider}_CLIENT_ID`;
  const secretName = `${provider}_CLIENT_SECRET`;
  const clientId = trimmed(env, idName);
  const clientSecret = trimmed(env, secretName);
  if (clientId === undefined && clientSecret === undefined) return null;
  if (clientId === undefined || clientSecret === undefined) {
    issues.push(
      `${idName} and ${secretName} must be set together (only ${
        clientId === undefined ? secretName : idName
      } is set)`,
    );
    return null;
  }
  return { clientId, clientSecret };
}

export function loadConfig(env: Env = process.env): AccountApiConfig {
  const issues: string[] = [];
  const warnings: string[] = [];

  // GAME_ENV decides how strict everything else is, so it has no default: a
  // production deployment that forgets it must not quietly run as dev.
  const gameEnv = z
    .enum(["dev", "staging", "prod"])
    .safeParse(trimmed(env, "GAME_ENV"));
  if (!gameEnv.success) {
    throw new ConfigError([
      "GAME_ENV is required and must be one of: dev, staging, prod",
    ]);
  }
  const mode = gameEnv.data;
  const strict = mode !== "dev";

  // The same flag value the client build bakes in.
  const featureResult = resolveAccountFeatures(env[ACCOUNT_FEATURES_ENV]);
  if (featureResult.rejected.length > 0) {
    const message = `${ACCOUNT_FEATURES_ENV}: unknown feature ${featureResult.rejected
      .map((t) => JSON.stringify(t))
      .join(", ")} (known: ${ACCOUNT_FEATURE_NAMES.join(", ")})`;
    // Refuse to start rather than run with a feature silently off because of
    // a typo; in dev it is only a warning.
    (strict ? issues : warnings).push(message);
  }
  const features = featureResult.features;

  // DOMAIN
  let domain = "localhost";
  const rawDomain = trimmed(env, "DOMAIN");
  if (rawDomain === undefined) {
    if (strict) issues.push("DOMAIN is required (e.g. example.com)");
  } else if (!HOSTNAME.test(rawDomain)) {
    issues.push(
      "DOMAIN must be a bare lowercase hostname such as example.com (no scheme, port or path)",
    );
  } else if (strict && rawDomain === "localhost") {
    issues.push(`DOMAIN must not be localhost when GAME_ENV=${mode}`);
  } else {
    domain = rawDomain;
  }

  // API_PORT
  let port = DEFAULT_API_PORT;
  const rawPort = trimmed(env, "API_PORT");
  if (rawPort !== undefined) {
    const parsed = z.coerce.number().int().min(1).max(65535).safeParse(rawPort);
    if (parsed.success && /^\d+$/.test(rawPort)) port = parsed.data;
    else issues.push("API_PORT must be an integer from 1 to 65535");
  }

  // API_PUBLIC_ORIGIN: the JWT issuer. The client derives the same value
  // (`https://api.<domain>`, or http://localhost:8787 for a localhost site) to
  // check tokens, so outside dev it is not free-form.
  const expectedOrigin =
    domain === "localhost"
      ? `http://localhost:${port}`
      : `https://api.${domain}`;
  let publicOrigin = expectedOrigin;
  const rawOrigin = trimmed(env, "API_PUBLIC_ORIGIN");
  if (rawOrigin === undefined) {
    if (strict) {
      issues.push(`API_PUBLIC_ORIGIN is required (expected ${expectedOrigin})`);
    }
  } else if (parseOrigin(rawOrigin) === null) {
    issues.push(
      "API_PUBLIC_ORIGIN must be an origin such as https://api.example.com (no path or trailing slash)",
    );
  } else if (strict && rawOrigin !== expectedOrigin) {
    issues.push(
      `API_PUBLIC_ORIGIN must be ${expectedOrigin}: the client checks every token's issuer against https://api.<DOMAIN>`,
    );
  } else {
    publicOrigin = rawOrigin;
  }

  // ALLOWED_ORIGINS
  const allowedOrigins: string[] = [];
  const rawAllowed = trimmed(env, "ALLOWED_ORIGINS");
  if (rawAllowed === undefined) {
    if (strict) {
      issues.push("ALLOWED_ORIGINS is required (comma-separated site origins)");
    } else {
      allowedOrigins.push(DEV_ALLOWED_ORIGIN);
    }
  } else {
    for (const part of rawAllowed.split(",")) {
      const origin = part.trim();
      if (origin === "") continue;
      const url = parseOrigin(origin);
      if (url === null) {
        issues.push(
          `ALLOWED_ORIGINS has an invalid origin ${JSON.stringify(origin)} (wildcards, paths and trailing slashes are not allowed)`,
        );
      } else if (strict && url.protocol !== "https:") {
        issues.push(
          `ALLOWED_ORIGINS must use https when GAME_ENV=${mode}: ${origin}`,
        );
      } else if (!allowedOrigins.includes(origin)) {
        allowedOrigins.push(origin);
      }
    }
    if (
      allowedOrigins.length === 0 &&
      !issues.some((i) => i.startsWith("ALLOWED_ORIGINS"))
    ) {
      issues.push("ALLOWED_ORIGINS must list at least one origin");
    }
  }

  const database = parseDatabase(env, issues);

  // LOG_LEVEL
  const logLevel = z
    .enum(["error", "warn", "info", "debug"])
    .default("info")
    .safeParse(trimmed(env, "LOG_LEVEL"));
  if (!logLevel.success) {
    issues.push("LOG_LEVEL must be one of: error, warn, info, debug");
  }

  // TRUST_PROXY_HOPS
  let trustProxyHops = 0;
  const rawHops = trimmed(env, "TRUST_PROXY_HOPS");
  if (rawHops !== undefined) {
    if (/^[0-5]$/.test(rawHops)) trustProxyHops = Number(rawHops);
    else issues.push("TRUST_PROXY_HOPS must be an integer from 0 to 5");
  }

  const turnstileSecret = trimmed(env, "TURNSTILE_SECRET_KEY") ?? null;

  // Signing keys and sign-in providers
  const jwt = {
    privateKeyPath: trimmed(env, "JWT_PRIVATE_KEY_PATH") ?? null,
    previousPublicKeyPath: trimmed(env, "JWT_PREVIOUS_PUBLIC_KEY_PATH") ?? null,
  };
  if (jwt.previousPublicKeyPath !== null && jwt.privateKeyPath === null) {
    issues.push(
      "JWT_PREVIOUS_PUBLIC_KEY_PATH is set without JWT_PRIVATE_KEY_PATH",
    );
  }
  const oauth = {
    discord: parseOAuth(env, "DISCORD", issues),
    google: parseOAuth(env, "GOOGLE", issues),
  };

  // What the enabled features need. Only enforced outside dev: a developer can
  // run with features on and no providers to work on one thing at a time.
  if (strict && features.accounts) {
    if (jwt.privateKeyPath === null) {
      issues.push(
        "JWT_PRIVATE_KEY_PATH is required when the accounts feature is enabled",
      );
    }
    if (turnstileSecret === null) {
      issues.push(
        "TURNSTILE_SECRET_KEY is required when the accounts feature is enabled (players are verified with Cloudflare Turnstile at join)",
      );
    }
    for (const [provider, creds, label] of [
      ["discord", oauth.discord, "DISCORD"],
      ["google", oauth.google, "GOOGLE"],
    ] as const) {
      if (AUTH_PROVIDERS[provider] && creds === null) {
        issues.push(
          `${label}_CLIENT_ID and ${label}_CLIENT_SECRET are required when the accounts feature is enabled (sign-in with ${provider} is on)`,
        );
      }
    }
  }
  // Any feature that talks to the API needs somewhere to keep its data. This
  // is already guaranteed by DATABASE_URL being required above; the check is
  // kept so a future change that makes the database optional cannot lose it.
  if (
    usesAccountApi(features) &&
    database === null &&
    !issues.some((i) => i.startsWith("DATABASE_URL"))
  ) {
    issues.push("DATABASE_URL is required when any account feature is enabled");
  }

  if (issues.length > 0 || database === null || !logLevel.success) {
    throw new ConfigError(issues);
  }
  return {
    env: mode,
    domain,
    port,
    publicOrigin,
    allowedOrigins,
    database,
    logLevel: logLevel.data,
    trustProxyHops,
    turnstileSecret,
    features,
    jwt,
    oauth,
    warnings,
  };
}

/**
 * A copy of the configuration that is safe to log: secrets and the database
 * password are replaced by whether they are set.
 */
export function describeConfig(
  config: AccountApiConfig,
): Record<string, unknown> {
  let databaseHost = "?";
  try {
    const url = new URL(config.database.url);
    databaseHost = `${url.hostname}${url.port ? `:${url.port}` : ""}${url.pathname}`;
  } catch {
    // Unreachable for a config from loadConfig.
  }
  return {
    env: config.env,
    domain: config.domain,
    port: config.port,
    publicOrigin: config.publicOrigin,
    allowedOrigins: config.allowedOrigins,
    database: { host: databaseHost, poolMax: config.database.poolMax },
    logLevel: config.logLevel,
    trustProxyHops: config.trustProxyHops,
    turnstile: config.turnstileSecret === null ? "unset" : "set",
    features: ACCOUNT_FEATURE_NAMES.filter((name) => config.features[name]),
    jwt: {
      privateKey: config.jwt.privateKeyPath === null ? "unset" : "set",
      previousPublicKey:
        config.jwt.previousPublicKeyPath === null ? "unset" : "set",
    },
    oauth: {
      discord: config.oauth.discord === null ? "unset" : "set",
      google: config.oauth.google === null ? "unset" : "set",
    },
  };
}
