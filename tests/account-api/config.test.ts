// @vitest-environment node
import {
  ACCOUNT_FEATURE_NAMES,
  allFeaturesOff,
} from "@openfront/shared/AccountFeatures";
import { describe, expect, it } from "vitest";
import {
  ConfigError,
  describeConfig,
  loadConfig,
  loadDatabaseConfig,
} from "../../src/account-api/config";

const DB = "postgres://dfuser:db-password-123@db.internal:5432/deltafront";

const dev = (extra: Record<string, string> = {}) => ({
  GAME_ENV: "dev",
  DATABASE_URL: DB,
  ...extra,
});

/** A complete, valid production environment with accounts enabled. */
const prodWithAccounts = (extra: Record<string, string | undefined> = {}) => ({
  GAME_ENV: "prod",
  DOMAIN: "example.com",
  API_PUBLIC_ORIGIN: "https://api.example.com",
  ALLOWED_ORIGINS: "https://example.com",
  DATABASE_URL: DB,
  DF_ACCOUNT_FEATURES: "accounts",
  JWT_PRIVATE_KEY_PATH: "/run/secrets/jwt.pem",
  TURNSTILE_SECRET_KEY: "turnstile-secret-value",
  DISCORD_CLIENT_ID: "discord-id",
  DISCORD_CLIENT_SECRET: "discord-secret-value",
  GOOGLE_CLIENT_ID: "google-id",
  GOOGLE_CLIENT_SECRET: "google-secret-value",
  ...extra,
});

function issuesOf(env: Record<string, string | undefined>): string[] {
  try {
    loadConfig(env);
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigError);
    return (error as ConfigError).issues;
  }
  throw new Error("expected the configuration to be rejected");
}

describe("loadConfig: valid configurations", () => {
  it("a minimal dev environment works and fills in safe defaults", () => {
    const config = loadConfig(dev());
    expect(config).toMatchObject({
      env: "dev",
      domain: "localhost",
      port: 8787,
      publicOrigin: "http://localhost:8787",
      allowedOrigins: ["http://localhost:9000"],
      database: { url: DB, poolMax: 10 },
      logLevel: "info",
      jwt: { privateKeyPath: null, previousPublicKeyPath: null },
      oauth: { discord: null, google: null },
      warnings: [],
    });
    expect(config.features).toEqual(allFeaturesOff());
  });

  it("a complete production environment with accounts enabled works", () => {
    const config = loadConfig(prodWithAccounts());
    expect(config.env).toBe("prod");
    expect(config.domain).toBe("example.com");
    expect(config.publicOrigin).toBe("https://api.example.com");
    expect(config.allowedOrigins).toEqual(["https://example.com"]);
    expect(config.features.accounts).toBe(true);
    expect(config.oauth.discord).toEqual({
      clientId: "discord-id",
      clientSecret: "discord-secret-value",
    });
    expect(config.oauth.google?.clientId).toBe("google-id");
  });

  it("staging is as strict as production", () => {
    const config = loadConfig(
      prodWithAccounts({
        GAME_ENV: "staging",
        DOMAIN: "staging.example.com",
        API_PUBLIC_ORIGIN: "https://api.staging.example.com",
        ALLOWED_ORIGINS: "https://staging.example.com",
      }),
    );
    expect(config.env).toBe("staging");
    expect(
      issuesOf({ GAME_ENV: "staging", DATABASE_URL: DB }).join("\n"),
    ).toMatch(/DOMAIN is required/);
  });

  it("production defaults stay disabled: with no feature variable every flag is off and no secrets are needed", () => {
    const config = loadConfig({
      GAME_ENV: "prod",
      DOMAIN: "example.com",
      API_PUBLIC_ORIGIN: "https://api.example.com",
      ALLOWED_ORIGINS: "https://example.com",
      DATABASE_URL: DB,
    });
    expect(config.features).toEqual(allFeaturesOff());
    expect(config.jwt.privateKeyPath).toBeNull();
    expect(config.oauth).toEqual({ discord: null, google: null });
  });

  it("DF_ACCOUNT_FEATURES switches on exactly the named features", () => {
    const config = loadConfig(
      dev({ DF_ACCOUNT_FEATURES: "accounts, leaderboards" }),
    );
    expect(ACCOUNT_FEATURE_NAMES.filter((n) => config.features[n])).toEqual([
      "accounts",
      "leaderboards",
    ]);
  });

  it("accepts several allowed origins, trimmed and de-duplicated", () => {
    const config = loadConfig(
      prodWithAccounts({
        ALLOWED_ORIGINS:
          " https://example.com , https://www.example.com,https://example.com ",
      }),
    );
    expect(config.allowedOrigins).toEqual([
      "https://example.com",
      "https://www.example.com",
    ]);
  });

  it("treats blank variables as unset", () => {
    const config = loadConfig(
      dev({
        API_PORT: "  ",
        DATABASE_POOL_MAX: "",
        LOG_LEVEL: "",
        DF_ACCOUNT_FEATURES: "",
      }),
    );
    expect(config.port).toBe(8787);
    expect(config.database.poolMax).toBe(10);
    expect(config.logLevel).toBe("info");
  });

  it("reads port, pool size and log level", () => {
    const config = loadConfig(
      dev({ API_PORT: "9100", DATABASE_POOL_MAX: "25", LOG_LEVEL: "debug" }),
    );
    expect(config).toMatchObject({
      port: 9100,
      publicOrigin: "http://localhost:9100",
      database: { poolMax: 25 },
      logLevel: "debug",
    });
  });
});

describe("loadConfig: invalid configurations fail clearly", () => {
  it("requires GAME_ENV, with no default, so production cannot quietly run as dev", () => {
    for (const env of [
      {},
      { GAME_ENV: "" },
      { GAME_ENV: "production" },
      { GAME_ENV: "DEV" },
    ]) {
      expect(issuesOf({ ...env, DATABASE_URL: DB })).toEqual([
        "GAME_ENV is required and must be one of: dev, staging, prod",
      ]);
    }
  });

  it("requires DATABASE_URL, and there is no fallback database", () => {
    const [issue] = issuesOf({ GAME_ENV: "dev" });
    expect(issue).toMatch(/DATABASE_URL is required/);
    expect(issue).toMatch(/no fallback database/);
  });

  it("only accepts PostgreSQL connection strings", () => {
    for (const url of [
      "sqlite:///tmp/df.db",
      "file:./df.sqlite",
      "mysql://u:p@h/db",
      "/var/lib/df.db",
      "deltafront.db",
      "postgres//missing-colon",
    ]) {
      expect(
        issuesOf({ GAME_ENV: "dev", DATABASE_URL: url }).join("\n"),
        url,
      ).toMatch(/DATABASE_URL must be a PostgreSQL connection string/);
    }
    expect(() =>
      loadConfig({ GAME_ENV: "dev", DATABASE_URL: "postgresql://u:p@h/db" }),
    ).not.toThrow();
  });

  it("reports every problem at once", () => {
    const issues = issuesOf({
      GAME_ENV: "prod",
      DOMAIN: "not a domain",
      API_PORT: "99999",
      LOG_LEVEL: "loud",
    });
    expect(issues.length).toBeGreaterThanOrEqual(5);
    const text = issues.join("\n");
    for (const name of [
      "DOMAIN",
      "API_PORT",
      "API_PUBLIC_ORIGIN",
      "ALLOWED_ORIGINS",
      "DATABASE_URL",
      "LOG_LEVEL",
    ]) {
      expect(text, name).toContain(name);
    }
  });

  it("formats the error as one line per problem", () => {
    try {
      loadConfig({ GAME_ENV: "prod" });
      throw new Error("expected failure");
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      const e = error as ConfigError;
      expect(e.name).toBe("ConfigError");
      expect(e.message.startsWith("Invalid account API configuration:\n")).toBe(
        true,
      );
      for (const issue of e.issues) expect(e.message).toContain(`  - ${issue}`);
    }
  });

  it("rejects bad ports and pool sizes", () => {
    for (const port of ["0", "65536", "-1", "80.5", "abc", "1e3", "8 080"]) {
      expect(issuesOf(dev({ API_PORT: port })).join(), port).toMatch(
        /API_PORT/,
      );
    }
    for (const max of ["0", "101", "-3", "2.5", "many"]) {
      expect(issuesOf(dev({ DATABASE_POOL_MAX: max })).join(), max).toMatch(
        /DATABASE_POOL_MAX/,
      );
    }
  });

  it("rejects a bad DOMAIN, and localhost outside dev", () => {
    for (const domain of [
      "http://example.com",
      "example.com:8080",
      "example.com/path",
      "Example.COM",
      "exa mple.com",
      "-bad.com",
      "single",
    ]) {
      expect(issuesOf(dev({ DOMAIN: domain })).join(), domain).toMatch(
        /DOMAIN must be a bare/,
      );
    }
    expect(issuesOf(prodWithAccounts({ DOMAIN: "localhost" })).join()).toMatch(
      /DOMAIN must not be localhost/,
    );
  });

  it("outside dev, API_PUBLIC_ORIGIN must be the exact origin the client expects", () => {
    expect(
      issuesOf(
        prodWithAccounts({ API_PUBLIC_ORIGIN: "https://api.other.com" }),
      ).join(),
    ).toMatch(/API_PUBLIC_ORIGIN must be https:\/\/api\.example\.com/);
    expect(
      issuesOf(
        prodWithAccounts({ API_PUBLIC_ORIGIN: "https://api.example.com/" }),
      ).join(),
    ).toMatch(/API_PUBLIC_ORIGIN must be an origin/);
    expect(
      issuesOf(prodWithAccounts({ API_PUBLIC_ORIGIN: undefined })).join(),
    ).toMatch(/API_PUBLIC_ORIGIN is required/);
  });

  it("rejects wildcard, path, trailing-slash and non-https allowed origins outside dev", () => {
    for (const origin of [
      "*",
      "https://example.com/",
      "https://example.com/app",
      "example.com",
      "ftp://example.com",
    ]) {
      expect(
        issuesOf(prodWithAccounts({ ALLOWED_ORIGINS: origin })).join(),
        origin,
      ).toMatch(/ALLOWED_ORIGINS has an invalid origin/);
    }
    expect(
      issuesOf(
        prodWithAccounts({ ALLOWED_ORIGINS: "http://example.com" }),
      ).join(),
    ).toMatch(/ALLOWED_ORIGINS must use https/);
    expect(
      issuesOf(prodWithAccounts({ ALLOWED_ORIGINS: " , " })).join(),
    ).toMatch(/ALLOWED_ORIGINS must list at least one origin/);
    expect(
      issuesOf(prodWithAccounts({ ALLOWED_ORIGINS: undefined })).join(),
    ).toMatch(/ALLOWED_ORIGINS is required/);
  });

  it("dev may use http origins but still no wildcard", () => {
    expect(
      loadConfig(
        dev({ ALLOWED_ORIGINS: "http://localhost:9000,http://127.0.0.1:9000" }),
      ).allowedOrigins,
    ).toHaveLength(2);
    expect(issuesOf(dev({ ALLOWED_ORIGINS: "*" })).join()).toMatch(
      /invalid origin/,
    );
  });

  it("rejects an invalid LOG_LEVEL", () => {
    expect(issuesOf(dev({ LOG_LEVEL: "verbose" })).join()).toMatch(
      /LOG_LEVEL must be one of/,
    );
  });
});

describe("loadConfig: feature flags", () => {
  it("an unknown feature is a startup failure outside dev (a typo must not silently leave a feature off)", () => {
    const text = issuesOf(
      prodWithAccounts({ DF_ACCOUNT_FEATURES: "accounts,stroe" }),
    ).join();
    expect(text).toMatch(/DF_ACCOUNT_FEATURES: unknown feature "stroe"/);
    expect(text).toContain("known: accounts, store");
  });

  it("in dev an unknown feature is only a warning, and enables nothing", () => {
    const config = loadConfig(
      dev({ DF_ACCOUNT_FEATURES: "accounts,stroe,all" }),
    );
    expect(config.features).toEqual({ ...allFeaturesOff(), accounts: true });
    expect(config.warnings).toHaveLength(1);
    expect(config.warnings[0]).toMatch(/"stroe", "all"/);
  });

  it("a feature variable of only unknown names enables nothing anywhere", () => {
    expect(
      loadConfig(dev({ DF_ACCOUNT_FEATURES: "everything" })).features,
    ).toEqual(allFeaturesOff());
  });
});

describe("loadConfig: secrets required by enabled features", () => {
  it("accounts in production requires the signing key and both providers' credentials, naming each variable", () => {
    const text = issuesOf(
      prodWithAccounts({
        JWT_PRIVATE_KEY_PATH: undefined,
        DISCORD_CLIENT_ID: undefined,
        DISCORD_CLIENT_SECRET: undefined,
        GOOGLE_CLIENT_ID: undefined,
        GOOGLE_CLIENT_SECRET: undefined,
      }),
    ).join("\n");
    expect(text).toMatch(
      /JWT_PRIVATE_KEY_PATH is required when the accounts feature is enabled/,
    );
    expect(text).toMatch(
      /DISCORD_CLIENT_ID and DISCORD_CLIENT_SECRET are required/,
    );
    expect(text).toMatch(
      /GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are required/,
    );
  });

  it("accounts in production requires the Turnstile secret too (players are verified at join)", () => {
    expect(
      issuesOf(prodWithAccounts({ TURNSTILE_SECRET_KEY: undefined })).join(),
    ).toMatch(
      /TURNSTILE_SECRET_KEY is required when the accounts feature is enabled/,
    );
  });

  it("in dev the Turnstile secret is optional (the check is then skipped, with a warning from the service)", () => {
    expect(
      loadConfig(dev({ DF_ACCOUNT_FEATURES: "accounts" })).turnstileSecret,
    ).toBeNull();
    expect(loadConfig(dev({ TURNSTILE_SECRET_KEY: "s" })).turnstileSecret).toBe(
      "s",
    );
  });

  it("TRUST_PROXY_HOPS is 0 to 5 and defaults to trusting no forwarded header", () => {
    expect(loadConfig(dev()).trustProxyHops).toBe(0);
    expect(loadConfig(dev({ TRUST_PROXY_HOPS: "1" })).trustProxyHops).toBe(1);
    for (const bad of ["6", "-1", "1.5", "x", "true"]) {
      expect(issuesOf(dev({ TRUST_PROXY_HOPS: bad })).join(), bad).toMatch(
        /TRUST_PROXY_HOPS must be an integer from 0 to 5/,
      );
    }
  });

  it("each missing production secret is reported on its own", () => {
    expect(
      issuesOf(prodWithAccounts({ JWT_PRIVATE_KEY_PATH: undefined })),
    ).toHaveLength(1);
    expect(
      issuesOf(prodWithAccounts({ DISCORD_CLIENT_SECRET: undefined })).join(),
    ).toMatch(
      /DISCORD_CLIENT_ID and DISCORD_CLIENT_SECRET must be set together/,
    );
    expect(
      issuesOf(prodWithAccounts({ GOOGLE_CLIENT_ID: undefined })).join(),
    ).toMatch(/GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be set together/);
  });

  it("without the accounts feature, production needs none of them", () => {
    expect(() =>
      loadConfig(
        prodWithAccounts({
          DF_ACCOUNT_FEATURES: "leaderboards",
          JWT_PRIVATE_KEY_PATH: undefined,
          DISCORD_CLIENT_ID: undefined,
          DISCORD_CLIENT_SECRET: undefined,
          GOOGLE_CLIENT_ID: undefined,
          GOOGLE_CLIENT_SECRET: undefined,
        }),
      ),
    ).not.toThrow();
  });

  it("dev with accounts enabled does not require providers or a key", () => {
    expect(() =>
      loadConfig(dev({ DF_ACCOUNT_FEATURES: "accounts" })),
    ).not.toThrow();
  });

  it("half a credential pair is an error in every environment", () => {
    expect(issuesOf(dev({ DISCORD_CLIENT_ID: "only-id" })).join()).toMatch(
      /DISCORD_CLIENT_ID and DISCORD_CLIENT_SECRET must be set together \(only DISCORD_CLIENT_ID is set\)/,
    );
    expect(
      issuesOf(dev({ GOOGLE_CLIENT_SECRET: "only-secret" })).join(),
    ).toMatch(/only GOOGLE_CLIENT_SECRET is set/);
  });

  it("a previous signing key needs a current one", () => {
    expect(
      issuesOf(dev({ JWT_PREVIOUS_PUBLIC_KEY_PATH: "/k/old.pem" })).join(),
    ).toMatch(
      /JWT_PREVIOUS_PUBLIC_KEY_PATH is set without JWT_PRIVATE_KEY_PATH/,
    );
  });

  it("never prints a secret or the database password in an error", () => {
    const secrets = [
      "super-secret-db-pass",
      "top-secret-discord-value",
      "top-secret-google-value",
    ];
    const issues = issuesOf({
      GAME_ENV: "prod",
      DF_ACCOUNT_FEATURES: "accounts",
      DATABASE_URL: `postgres://u:${secrets[0]}@h/db`,
      DISCORD_CLIENT_SECRET: secrets[1],
      GOOGLE_CLIENT_ID: "g",
      GOOGLE_CLIENT_SECRET: secrets[2],
      API_PORT: "bad",
    });
    const text = issues.join("\n");
    for (const secret of secrets) expect(text).not.toContain(secret);
    // Even a rejected DATABASE_URL is not echoed back.
    const bad = issuesOf({
      GAME_ENV: "dev",
      DATABASE_URL: "sqlite://user:hunter2@host/x",
    }).join();
    expect(bad).not.toContain("hunter2");
  });
});

describe("describeConfig", () => {
  it("is safe to log: no password, secret or key path", () => {
    const config = loadConfig(prodWithAccounts());
    const text = JSON.stringify(describeConfig(config));
    for (const secret of [
      "db-password-123",
      "discord-secret-value",
      "google-secret-value",
      "discord-id",
      "google-id",
      "/run/secrets/jwt.pem",
      "dfuser",
    ]) {
      expect(text, secret).not.toContain(secret);
    }
    expect(describeConfig(config)).toMatchObject({
      env: "prod",
      domain: "example.com",
      database: { host: "db.internal:5432/deltafront", poolMax: 10 },
      features: ["accounts"],
      turnstile: "set",
      trustProxyHops: 0,
      jwt: { privateKey: "set", previousPublicKey: "unset" },
      oauth: { discord: "set", google: "set" },
    });
  });
});

describe("loadDatabaseConfig", () => {
  it("needs only DATABASE_URL, so migrations can run before the rest exists", () => {
    expect(loadDatabaseConfig({ DATABASE_URL: DB })).toEqual({
      url: DB,
      poolMax: 10,
      statementTimeoutMs: 30_000,
    });
  });

  it("fails clearly without it", () => {
    expect(() => loadDatabaseConfig({})).toThrow(/DATABASE_URL is required/);
    expect(() => loadDatabaseConfig({ DATABASE_URL: "sqlite://x" })).toThrow(
      ConfigError,
    );
  });
});

describe("loadConfig: M7 production rules", () => {
  it("Turnstile hostnames default to the site's domain in production and are unchecked in dev", () => {
    expect(loadConfig(prodWithAccounts()).turnstileHostnames).toEqual([
      "example.com",
    ]);
    expect(loadConfig(dev()).turnstileHostnames).toBeNull();
    expect(loadConfig(prodWithAccounts()).turnstileAction).toBe("join");
  });

  it("TURNSTILE_ALLOWED_HOSTNAMES is a validated list, and never includes localhost outside dev", () => {
    expect(
      loadConfig(
        prodWithAccounts({
          TURNSTILE_ALLOWED_HOSTNAMES: "Example.com, play.example.org",
        }),
      ).turnstileHostnames,
    ).toEqual(["example.com", "play.example.org"]);
    for (const bad of ["https://example.com", "exa mple.com", ",", "a/b"]) {
      expect(
        issuesOf(prodWithAccounts({ TURNSTILE_ALLOWED_HOSTNAMES: bad })),
        bad,
      ).toContain(
        "TURNSTILE_ALLOWED_HOSTNAMES must be a comma-separated list of bare hostnames such as example.com",
      );
    }
    expect(
      issuesOf(prodWithAccounts({ TURNSTILE_ALLOWED_HOSTNAMES: "localhost" })),
    ).toEqual([expect.stringContaining("must not include localhost")]);
  });

  it("TURNSTILE_ACTION is validated", () => {
    expect(
      issuesOf(prodWithAccounts({ TURNSTILE_ACTION: "bad action!" })),
    ).toEqual([expect.stringContaining("TURNSTILE_ACTION")]);
  });

  it("outside dev, only the launch features may be enabled", () => {
    const launch = "accounts,store,inventory,clans,leaderboards";
    expect(
      loadConfig(prodWithAccounts({ DF_ACCOUNT_FEATURES: launch })).features,
    ).toMatchObject({ accounts: true, clans: true, payments: false });
    for (const name of [
      "ranked",
      "payments",
      "friends",
      "progression",
      "tribes",
      "trustedLobbies",
    ]) {
      for (const env of ["prod", "staging"]) {
        expect(
          issuesOf(
            prodWithAccounts({
              GAME_ENV: env,
              DF_ACCOUNT_FEATURES: `${launch},${name}`,
            }),
          ).join("\n"),
          `${env}:${name}`,
        ).toContain(`enables ${name}`);
      }
      // dev stays free to work on any of them
      expect(() =>
        loadConfig(dev({ DF_ACCOUNT_FEATURES: name })),
      ).not.toThrow();
    }
  });

  it("describeConfig never contains a secret", () => {
    const text = JSON.stringify(describeConfig(loadConfig(prodWithAccounts())));
    for (const secret of [
      "turnstile-secret-value",
      "discord-secret-value",
      "google-secret-value",
      "db-password-123",
    ]) {
      expect(text).not.toContain(secret);
    }
  });
});
