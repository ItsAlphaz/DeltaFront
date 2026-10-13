import {
  ACCOUNT_FEATURE_NAMES,
  describeRejectedToken,
  LAUNCH_FEATURES,
  LAUNCH_FEATURES_VALUE,
  parseEmailAuthFlag,
  resolveAccountFeatures,
} from "@openfront/shared/AccountFeatures";
import {
  LEGAL_PAGE_FILES,
  legalPageProblems,
  type LegalPageKind,
} from "@openfront/shared/LegalPages";
import { createHash } from "node:crypto";
import dns from "node:dns";
import fs from "node:fs";
import path from "node:path";
import { Pool } from "pg";
import { loadKeyRing } from "../../src/account-api/auth/keys";
import { loadCatalog } from "../../src/account-api/catalog/load";
import {
  ConfigError,
  describeConfig,
  loadConfig,
  senderAddress,
  type AccountApiConfig,
} from "../../src/account-api/config";
import {
  loadMigrationFiles,
  migrationStatus,
} from "../../src/account-api/db/migrator";
import { loadReservedClanNames } from "../../src/account-api/domain/clans";
import { BRAND } from "../../src/client/Branding";
import {
  AccountEnvError,
  assertAccountBackendEnv,
} from "../../src/server/AccountEnvCheck";
import { parseJoinFallback } from "../../src/server/JoinFallback";

/**
 * `npm run launch:check`: is this deployment safe to open to the public?
 *
 * It reads the environment (and `.env`) the services will run with, the built
 * client, the legal pages and, when DATABASE_URL is set, the database, and
 * reports each finding as pass, warn or fail. It changes nothing: the
 * database connection is read-only, nothing is written, no service is
 * started. It prints names and verdicts only, never a secret value, and every
 * message is written to be safe to paste into a ticket.
 *
 * It does NOT prove that sign-in with Discord or Google works against the real
 * providers, or that Cloudflare accepts your Turnstile keys: those need the
 * real services (docs/Deployment.md, "Live verification").
 */

export type CheckStatus = "pass" | "warn" | "fail" | "skip";

export interface CheckResult {
  id: string;
  title: string;
  status: CheckStatus;
  detail?: string;
}

export interface LaunchReport {
  env: string;
  results: CheckResult[];
  failed: number;
  warned: number;
}

export interface LaunchCheckOptions {
  env: Record<string, string | undefined>;
  /** The repository root (where `src/`, `static/` and `resources/` are). */
  root: string;
  /** Run the read-only database checks (default: when DATABASE_URL is set). */
  database?: boolean;
  /** Also ask the running public endpoints (GET only). */
  probe?: boolean;
  /** Accept GAME_ENV=staging (a rehearsal) instead of requiring prod. */
  allowStaging?: boolean;
  fetchFn?: typeof fetch;
  /** DNS TXT lookup for the sender-domain check of `--probe` (default: the system resolver). */
  resolveTxt?: (name: string) => Promise<string[][]>;
  /** The branding to judge; the real one unless a test supplies another. */
  brand?: Pick<typeof BRAND, "sourceRepoUrl" | "steamAppId" | "adsEnabled">;
}

const DEV_API_KEY = "WARNING_DEV_API_KEY_DO_NOT_USE_IN_PRODUCTION";
/** Cloudflare's published always-pass / always-fail test keys: not a real bot check. */
const TURNSTILE_TEST_KEY = /^[123]x0{4,}/i;
const UPSTREAM_REPO = /github\.com\/openfrontio\//i;
const OPENFRONT_HOST = /openfront\.(io|dev)\b|api\.openfront|openfrontio\.com/i;

const sha256 = (value: string) =>
  createHash("sha256").update(value, "utf8").digest();

function result(
  id: string,
  title: string,
  status: CheckStatus,
  detail?: string,
): CheckResult {
  return { id, title, status, detail };
}

/** Files under `dir` (recursively) whose extension is in `exts`, skipping `skipDirs` and huge files. */
function textFiles(
  dir: string,
  exts: RegExp,
  skipDirs: ReadonlySet<string> = new Set(["maps", "node_modules"]),
): string[] {
  const out: string[] = [];
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (!skipDirs.has(entry.name)) stack.push(full);
      } else if (
        exts.test(entry.name) &&
        fs.statSync(full).size < 40 * 1024 * 1024
      ) {
        out.push(full);
      }
    }
  }
  return out;
}

export async function runLaunchChecks(
  options: LaunchCheckOptions,
): Promise<LaunchReport> {
  const { env, root } = options;
  const results: CheckResult[] = [];
  const add = (r: CheckResult) => results.push(r);
  const staticDir = path.join(root, "static");

  // ------------------------------------------------------------ environment
  const gameEnv = env.GAME_ENV?.trim();
  if (gameEnv === "prod") {
    add(result("env", "GAME_ENV is prod", "pass"));
  } else if (gameEnv === "staging" && options.allowStaging) {
    add(
      result(
        "env",
        "GAME_ENV is staging (rehearsal)",
        "warn",
        "the public launch needs GAME_ENV=prod",
      ),
    );
  } else {
    add(
      result(
        "env",
        "GAME_ENV is prod",
        "fail",
        `GAME_ENV is ${gameEnv === undefined || gameEnv === "" ? "not set" : JSON.stringify(gameEnv)}; a launch runs with GAME_ENV=prod`,
      ),
    );
  }

  // The account API's own validation: every missing or unsafe value at once.
  let config: AccountApiConfig | null = null;
  try {
    config = loadConfig(env);
    add(result("config", "account API configuration is valid", "pass"));
    for (const w of config.warnings) add(result("config-warning", w, "warn"));
  } catch (error) {
    add(
      result(
        "config",
        "account API configuration is valid",
        "fail",
        error instanceof ConfigError
          ? error.issues.join("; ")
          : "the configuration could not be read",
      ),
    );
  }

  // The game server's own start-up validation (same variables, its side).
  try {
    assertAccountBackendEnv({
      env,
      features: resolveAccountFeatures(env.DF_ACCOUNT_FEATURES).features,
      isDev: false,
    });
    add(
      result("game-server-env", "game server configuration is valid", "pass"),
    );
  } catch (error) {
    add(
      result(
        "game-server-env",
        "game server configuration is valid",
        "fail",
        error instanceof AccountEnvError
          ? error.message.replace(/\n\s*-\s*/g, "; ").replace(/^[^:]*:\s*/, "")
          : "the configuration could not be read",
      ),
    );
  }

  // ----------------------------------------------------------- feature flags
  const resolved = resolveAccountFeatures(env.DF_ACCOUNT_FEATURES);
  const enabled = ACCOUNT_FEATURE_NAMES.filter((n) => resolved.features[n]);
  const missing = LAUNCH_FEATURES.filter((n) => !resolved.features[n]);
  const extra = enabled.filter(
    (n) => !(LAUNCH_FEATURES as readonly string[]).includes(n),
  );
  if (
    resolved.rejected.length === 0 &&
    missing.length === 0 &&
    extra.length === 0
  ) {
    add(
      result(
        "features",
        `DF_ACCOUNT_FEATURES is exactly the launch set`,
        "pass",
        LAUNCH_FEATURES_VALUE,
      ),
    );
  } else {
    const parts = [
      missing.length > 0 ? `missing: ${missing.join(", ")}` : "",
      extra.length > 0 ? `not for launch: ${extra.join(", ")}` : "",
      resolved.rejected.length > 0
        ? `unknown: ${resolved.rejected.map(describeRejectedToken).join(", ")}`
        : "",
    ].filter(Boolean);
    add(
      result(
        "features",
        "DF_ACCOUNT_FEATURES is exactly the launch set",
        "fail",
        `${parts.join("; ")}. Set DF_ACCOUNT_FEATURES=${LAUNCH_FEATURES_VALUE} for the client build, the game server and the account API.`,
      ),
    );
  }

  // ------------------------------------------------------------ dev leftovers
  const devLeftovers: string[] = [];
  const apiKey = env.API_KEY?.trim() ?? "";
  if (apiKey.includes("WARNING_DEV_API_KEY"))
    devLeftovers.push("API_KEY is the development placeholder");
  const origins = (env.ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean);
  if (origins.some((o) => /localhost|127\.0\.0\.1|^http:/i.test(o))) {
    devLeftovers.push("ALLOWED_ORIGINS lists a local or non-https origin");
  }
  if ((env.DOMAIN ?? "").trim() === "localhost")
    devLeftovers.push("DOMAIN is localhost");
  if (env.CDN_BASE && /localhost/.test(env.CDN_BASE))
    devLeftovers.push("CDN_BASE is local");
  if (env.CSP_MODE === "off")
    devLeftovers.push("CSP_MODE=off disables the Content-Security-Policy");
  // A value copied from deploy/env/*.example and never filled in.
  const unfilled = Object.entries(env)
    .filter(([, value]) => typeof value === "string" && /CHANGE_ME/.test(value))
    .map(([name]) => name)
    .sort();
  if (unfilled.length > 0) {
    devLeftovers.push(
      `still the CHANGE_ME placeholder: ${unfilled.join(", ")}`,
    );
  }
  add(
    devLeftovers.length === 0
      ? result("dev-config", "no development-only configuration", "pass")
      : result(
          "dev-config",
          "no development-only configuration",
          "fail",
          devLeftovers.join("; "),
        ),
  );
  if (env.CSP_MODE === "report-only") {
    add(
      result(
        "csp",
        "Content-Security-Policy is enforced",
        "warn",
        "CSP_MODE=report-only reports violations but does not block them",
      ),
    );
  }
  if ((env.LOG_LEVEL ?? "info") === "debug") {
    add(
      result(
        "log-level",
        "log level is not debug",
        "warn",
        "debug logs every request",
      ),
    );
  }

  // ------------------------------------------------------------------ proxy
  if (config !== null && config.trustProxyHops < 1) {
    add(
      result(
        "proxy",
        "the API knows it is behind a reverse proxy",
        "fail",
        "TRUST_PROXY_HOPS is 0: every client would share the proxy's address, so one person's guest-creation or sign-in limit would apply to everyone. Set TRUST_PROXY_HOPS=1 behind nginx.",
      ),
    );
  } else if (config !== null) {
    add(result("proxy", "the API knows it is behind a reverse proxy", "pass"));
  }

  // ----------------------------------------------------------------- Turnstile
  const turnstileProblems: string[] = [];
  const secret = env.TURNSTILE_SECRET_KEY?.trim() ?? "";
  const siteKey = env.TURNSTILE_SITE_KEY?.trim() ?? "";
  if (secret === "" || siteKey === "")
    turnstileProblems.push(
      "TURNSTILE_SECRET_KEY and TURNSTILE_SITE_KEY must both be set",
    );
  if (TURNSTILE_TEST_KEY.test(secret) || TURNSTILE_TEST_KEY.test(siteKey)) {
    turnstileProblems.push(
      "a Cloudflare test key is configured: it always passes (or always fails) and is not a bot check",
    );
  }
  try {
    const policy = parseJoinFallback(env.TURNSTILE_FALLBACK, false);
    if (policy === "open") {
      turnstileProblems.push(
        "TURNSTILE_FALLBACK=open lets everyone in when Cloudflare is unreachable",
      );
    }
  } catch {
    turnstileProblems.push(
      "TURNSTILE_FALLBACK is not one of open, registered, closed",
    );
  }
  add(
    turnstileProblems.length === 0
      ? result(
          "turnstile",
          "Turnstile is configured for production",
          "pass",
          `fallback: ${parseJoinFallback(env.TURNSTILE_FALLBACK, false)}`,
        )
      : result(
          "turnstile",
          "Turnstile is configured for production",
          "fail",
          turnstileProblems.join("; "),
        ),
  );

  // ---------------------------------------------------------------- OAuth
  if (config !== null) {
    const configured = (["discord", "google"] as const).filter(
      (p) => config!.oauth[p] !== null,
    );
    add(
      configured.length === 2
        ? result(
            "oauth",
            "Discord and Google sign-in are configured",
            "warn",
            `credentials are present, but this check cannot prove the providers accept them. Redirect URIs to register: ${config.publicOrigin}/auth/callback/discord and ${config.publicOrigin}/auth/callback/google. Do one real sign-in per provider before announcing (docs/Deployment.md).`,
          )
        : result(
            "oauth",
            "Discord and Google sign-in are configured",
            "fail",
            `missing: ${(["discord", "google"] as const).filter((p) => !configured.includes(p)).join(", ")}`,
          ),
    );
  }

  // --------------------------------------------------------- email sign-in
  const emailFlag = parseEmailAuthFlag(env.DF_EMAIL_AUTH);
  const emailEnabled = emailFlag.enabled;
  if (emailFlag.invalid) {
    add(
      result(
        "email",
        "email sign-in is configured",
        "fail",
        "DF_EMAIL_AUTH must be 1, true, 0 or false (or unset)",
      ),
    );
  } else if (!emailEnabled) {
    add(
      result(
        "email",
        "email sign-in is off",
        "pass",
        "no mail provider is needed",
      ),
    );
  } else if (config === null) {
    add(
      result(
        "email",
        "email sign-in is configured",
        "skip",
        "the configuration is invalid",
      ),
    );
  } else {
    const problems: string[] = [];
    const e = config.email;
    if (e.provider === null || e.provider === "dev") {
      problems.push(
        "EMAIL_PROVIDER is not a real provider (resend or postmark): the dev provider keeps links in memory and delivers nothing",
      );
    }
    const sender = e.from === null ? null : senderAddress(e.from);
    if (sender === null)
      problems.push("EMAIL_FROM is not a valid sender address");
    else if (
      /@(example\.(com|org|net)|localhost|test|invalid|yourdomain|your-domain)\b/i.test(
        sender,
      )
    ) {
      problems.push(
        "EMAIL_FROM is a placeholder domain: use an address on a domain you have verified with the provider",
      );
    }
    if (e.apiKey === null) problems.push("EMAIL_API_KEY is not set");
    else if (
      /change_?me|your[-_ ]?key|placeholder|test[-_]?key|not[-_]?real|xxxx/i.test(
        e.apiKey,
      )
    ) {
      problems.push("EMAIL_API_KEY looks like a placeholder");
    }
    // The emailed link points at the origin the browser sent; it must be this site, over https.
    const siteOrigin = `https://${config.domain}`;
    if (!config.allowedOrigins.includes(siteOrigin)) {
      problems.push(
        `${siteOrigin} is not in ALLOWED_ORIGINS, so the sign-in link would be refused`,
      );
    }
    const built = readBuiltEmailFlag(staticDir);
    if (built !== null && !built) {
      problems.push(
        "the client in static/ was built with email sign-in off: rebuild with DF_EMAIL_AUTH=1 (docker build --build-arg DF_EMAIL_AUTH=1)",
      );
    }
    add(
      problems.length === 0
        ? result(
            "email",
            "email sign-in is configured for production",
            "warn",
            `provider ${e.provider}, sender configured. This check cannot prove the provider delivers: send yourself a link from the real site and check it arrives in the inbox, not spam (docs/Deployment.md, "Email sign-in").`,
          )
        : result(
            "email",
            "email sign-in is configured for production",
            "fail",
            problems.join("\n"),
          ),
    );
  }
  if (!emailEnabled) {
    const built = readBuiltEmailFlag(staticDir);
    if (built === true) {
      add(
        result(
          "email-build",
          "the client matches the email setting",
          "fail",
          "the client in static/ offers email sign-in but DF_EMAIL_AUTH is off: the button would answer 404. Rebuild without it, or turn it on.",
        ),
      );
    }
  }

  // --------------------------------------------------------------- signing key
  if (config !== null && config.jwt.privateKeyPath !== null) {
    const keyPath = config.jwt.privateKeyPath;
    const problems: string[] = [];
    try {
      const mode = fs.statSync(keyPath).mode;
      if ((mode & 0o077) !== 0)
        problems.push(
          "the private key file is readable by other users (chmod 600)",
        );
      if (!path.relative(root, path.resolve(keyPath)).startsWith("..")) {
        problems.push(
          "the private key file is inside the repository directory (keep it outside, e.g. /etc/deltafront)",
        );
      }
    } catch {
      problems.push("the private key file cannot be read");
    }
    let kids = "";
    if (
      problems.length === 0 ||
      !problems.includes("the private key file cannot be read")
    ) {
      try {
        const ring = await loadKeyRing({
          privateKeyPath: keyPath,
          previousPublicKeyPath: config.jwt.previousPublicKeyPath,
          devKeyDir: null,
        });
        kids = ring
          .jwks()
          .keys.map((k) => k.kid.slice(0, 8))
          .join(", ");
      } catch (error) {
        problems.push(
          error instanceof Error ? error.message : "the signing key is invalid",
        );
      }
    }
    add(
      problems.length === 0
        ? result(
            "signing-key",
            "the signing key loads and is private",
            "pass",
            `published key ids: ${kids}`,
          )
        : result(
            "signing-key",
            "the signing key loads and is private",
            "fail",
            problems.join("; "),
          ),
    );
  }

  // ------------------------------------------------------- catalog and clans
  if (config !== null) {
    try {
      const catalog = loadCatalog({ publicOrigin: config.publicOrigin });
      add(
        result(
          "catalog",
          "the cosmetic catalog is valid",
          "pass",
          `${catalog.validFlares.size} cosmetics, version ${catalog.version.slice(0, 8)}`,
        ),
      );
    } catch (error) {
      add(
        result(
          "catalog",
          "the cosmetic catalog is valid",
          "fail",
          error instanceof Error ? error.message : "invalid",
        ),
      );
    }
  }
  try {
    loadReservedClanNames();
    add(
      result(
        "reserved-clans",
        "the reserved clan tags and names are valid",
        "pass",
      ),
    );
  } catch (error) {
    add(
      result(
        "reserved-clans",
        "the reserved clan tags and names are valid",
        "fail",
        error instanceof Error ? error.message : "invalid",
      ),
    );
  }

  // -------------------------------------------------------------- legal pages
  for (const dir of [path.join(root, "resources/public"), staticDir]) {
    const label = path.relative(root, dir);
    if (dir === staticDir && !fs.existsSync(dir)) continue;
    const problems: string[] = [];
    for (const [kind, file] of Object.entries(LEGAL_PAGE_FILES) as Array<
      [LegalPageKind, string]
    >) {
      let html: string;
      try {
        html = fs.readFileSync(path.join(dir, file), "utf8");
      } catch {
        problems.push(`${file} is missing`);
        continue;
      }
      for (const p of legalPageProblems(kind, html, new Date(), {
        emailAuth: emailEnabled,
      }))
        problems.push(`${file} ${p}`);
    }
    add(
      problems.length === 0
        ? result(
            `legal:${label}`,
            `Terms and Privacy pages are final (${label})`,
            "pass",
          )
        : result(
            `legal:${label}`,
            `Terms and Privacy pages are final (${label})`,
            "fail",
            problems.join("\n"),
          ),
    );
  }

  // ---------------------------------------------------------------- branding
  const brand = options.brand ?? BRAND;
  const brandProblems: string[] = [];
  if (UPSTREAM_REPO.test(brand.sourceRepoUrl)) {
    brandProblems.push(
      "BRAND.sourceRepoUrl still points at the upstream OpenFront repository; AGPL-3.0 section 13 requires offering players the source of YOUR modified version (publish it and set the URL in src/client/Branding.ts)",
    );
  }
  if (brand.steamAppId !== null)
    brandProblems.push(
      "BRAND.steamAppId is set but DeltaFront has no Steam build",
    );
  if (brand.adsEnabled)
    brandProblems.push("BRAND.adsEnabled is on but no ad provider is wired");
  add(
    brandProblems.length === 0
      ? result(
          "branding",
          "branding and AGPL source link are launch-ready",
          "pass",
        )
      : result(
          "branding",
          "branding and AGPL source link are launch-ready",
          "fail",
          brandProblems.join("; "),
        ),
  );

  // ----------------------------------------------------------- built client
  if (!fs.existsSync(path.join(staticDir, "index.html"))) {
    add(
      result(
        "build",
        "the production client is built",
        "fail",
        "static/index.html is missing: run the production build with DF_ACCOUNT_FEATURES set",
      ),
    );
  } else {
    const assets = textFiles(
      path.join(staticDir, "assets"),
      /\.(js|css|html|json|txt)$/,
    );
    const html = path.join(staticDir, "index.html");
    const files = [...assets, html];

    // The minifier may quote the baked string with ", ' or a backtick. The
    // build also records the value in account-features.txt; this checks the
    // bundle itself, which is what players run.
    const quoted = ['"', "'", "`"].map(
      (q) => `${q}${LAUNCH_FEATURES_VALUE}${q}`,
    );
    const withFlags = files.filter((f) => {
      const text = fs.readFileSync(f, "utf8");
      return quoted.some((q) => text.includes(q));
    });
    add(
      withFlags.length > 0
        ? result(
            "client-flags",
            "the client was built with the launch features",
            "pass",
          )
        : result(
            "client-flags",
            "the client was built with the launch features",
            "fail",
            `no built file contains DF_ACCOUNT_FEATURES=${LAUNCH_FEATURES_VALUE}: rebuild with the variable set (docker build --build-arg DF_ACCOUNT_FEATURES=...)`,
          ),
    );

    const secrets: Array<[string, string]> = [];
    const addSecret = (name: string, value: string | undefined) => {
      if (value !== undefined && value.trim().length >= 8)
        secrets.push([name, value.trim()]);
    };
    addSecret("API_KEY", env.API_KEY);
    addSecret("TURNSTILE_SECRET_KEY", env.TURNSTILE_SECRET_KEY);
    addSecret("DISCORD_CLIENT_SECRET", env.DISCORD_CLIENT_SECRET);
    addSecret("GOOGLE_CLIENT_SECRET", env.GOOGLE_CLIENT_SECRET);
    addSecret("EMAIL_API_KEY", env.EMAIL_API_KEY);
    try {
      addSecret(
        "DATABASE_URL password",
        decodeURIComponent(new URL(env.DATABASE_URL ?? "").password),
      );
    } catch {
      // no database URL to scan for
    }
    const leaked: string[] = [];
    const upstream: string[] = [];
    for (const file of files) {
      const text = fs.readFileSync(file, "utf8");
      for (const [name, value] of secrets) {
        if (text.includes(value))
          leaked.push(`${name} appears in ${path.relative(root, file)}`);
      }
      if (text.includes("BEGIN PRIVATE KEY"))
        leaked.push(`a private key appears in ${path.relative(root, file)}`);
      if (/\.(js|html)$/.test(file) && OPENFRONT_HOST.test(text)) {
        upstream.push(path.relative(root, file));
      }
    }
    add(
      leaked.length === 0
        ? result(
            "bundle-secrets",
            "no secret is in the built client",
            "pass",
            `${files.length} files scanned`,
          )
        : result(
            "bundle-secrets",
            "no secret is in the built client",
            "fail",
            leaked.join("; "),
          ),
    );
    add(
      upstream.length === 0
        ? result(
            "bundle-openfront",
            "the built client names no OpenFront service",
            "pass",
          )
        : result(
            "bundle-openfront",
            "the built client names no OpenFront service",
            "fail",
            `${upstream.join(", ")} mention an OpenFront host`,
          ),
    );
  }

  // --------------------------------------------------------------- database
  const wantDb = options.database ?? (env.DATABASE_URL ?? "").trim() !== "";
  if (!wantDb) {
    add(
      result(
        "database",
        "database checks",
        "skip",
        "DATABASE_URL is not set or --no-database was given",
      ),
    );
  } else if (config === null) {
    add(
      result(
        "database",
        "database checks",
        "skip",
        "the configuration is invalid",
      ),
    );
  } else {
    await databaseChecks(config, env, apiKey, add);
  }

  // ------------------------------------------------------------------ probe
  if (options.probe && config !== null) {
    await probeChecks(config, options.fetchFn ?? fetch, add);
    if (emailEnabled) await senderDomainChecks(config, options.resolveTxt, add);
  }

  const failed = results.filter((r) => r.status === "fail").length;
  const warned = results.filter((r) => r.status === "warn").length;
  return { env: gameEnv ?? "unset", results, failed, warned };
}

async function databaseChecks(
  config: AccountApiConfig,
  _env: Record<string, string | undefined>,
  apiKey: string,
  add: (r: CheckResult) => void,
): Promise<void> {
  const target = describeConfig(config).database as { host: string };
  // Read-only session: this check cannot change anything even by mistake.
  const pool = new Pool({
    connectionString: config.database.url,
    max: 1,
    connectionTimeoutMillis: 8_000,
    options: "-c default_transaction_read_only=on -c statement_timeout=15000",
  });
  pool.on("error", () => undefined);

  try {
    const url = new URL(config.database.url);
    const local =
      ["localhost", "127.0.0.1", "::1", ""].includes(url.hostname) ||
      url.hostname.startsWith("/");
    const ssl = url.searchParams.get("sslmode");
    if (
      !local &&
      !["require", "verify-ca", "verify-full"].includes(ssl ?? "")
    ) {
      add(
        result(
          "database-tls",
          "the database connection is encrypted",
          "warn",
          "the database is on another host but DATABASE_URL has no sslmode=require",
        ),
      );
    }
  } catch {
    // already reported by the configuration check
  }
  try {
    try {
      await pool.query("SELECT 1");
    } catch (error) {
      add(
        result(
          "database",
          "PostgreSQL is reachable",
          "fail",
          `cannot connect to ${target.host}: ${error instanceof Error ? error.message.replace(/postgres(ql)?:\/\/\S+/g, "[url]") : "unknown error"}`,
        ),
      );
      return;
    }
    add(result("database", "PostgreSQL is reachable", "pass", target.host));

    try {
      const status = await migrationStatus(pool as never, loadMigrationFiles());
      add(
        status.pending.length === 0
          ? result(
              "migrations",
              "migrations are current",
              "pass",
              `${status.applied.length} applied`,
            )
          : result(
              "migrations",
              "migrations are current",
              "fail",
              `${status.pending.length} pending (next: ${status.pending[0].fileName}); run npm run account-api:migrate`,
            ),
      );
    } catch (error) {
      add(
        result(
          "migrations",
          "migrations are current",
          "fail",
          error instanceof Error ? error.message : "unreadable",
        ),
      );
    }

    try {
      const keys = await pool.query<{ n: string }>(
        "SELECT count(*) AS n FROM server_api_keys WHERE revoked_at IS NULL",
      );
      const active = Number(keys.rows[0].n);
      const mine =
        apiKey === ""
          ? 0
          : (
              await pool.query(
                "SELECT 1 FROM server_api_keys WHERE key_hash = $1 AND revoked_at IS NULL",
                [sha256(apiKey)],
              )
            ).rows.length;
      const dev = (
        await pool.query(
          "SELECT 1 FROM server_api_keys WHERE key_hash = $1 AND revoked_at IS NULL",
          [sha256(DEV_API_KEY)],
        )
      ).rows.length;
      const problems: string[] = [];
      if (active === 0)
        problems.push(
          "no server API key is registered (npm run admin -- server:key:create)",
        );
      else if (mine === 0)
        problems.push(
          "API_KEY does not match any active registered server key",
        );
      if (dev > 0)
        problems.push(
          "the development placeholder key is registered and active: revoke it",
        );
      add(
        problems.length === 0
          ? result(
              "server-key",
              "the game server's API key is registered",
              "pass",
            )
          : result(
              "server-key",
              "the game server's API key is registered",
              "fail",
              problems.join("; "),
            ),
      );
    } catch {
      add(
        result(
          "server-key",
          "the game server's API key is registered",
          "fail",
          "server_api_keys cannot be read (are migrations applied?)",
        ),
      );
    }
  } finally {
    await pool.end().catch(() => undefined);
  }
}

async function probeChecks(
  config: AccountApiConfig,
  fetchFn: typeof fetch,
  add: (r: CheckResult) => void,
): Promise<void> {
  const get = async (url: string) => {
    try {
      return await fetchFn(url, {
        signal: AbortSignal.timeout(8_000),
        redirect: "manual",
      });
    } catch {
      return null;
    }
  };
  const health = await get(`${config.publicOrigin}/health`);
  add(
    health?.ok
      ? result("probe-health", "the API answers /health", "pass")
      : result(
          "probe-health",
          "the API answers /health",
          "fail",
          `${config.publicOrigin}/health did not answer 200`,
        ),
  );
  const ready = await get(`${config.publicOrigin}/ready`);
  add(
    ready?.ok
      ? result(
          "probe-ready",
          "the API is ready (database, migrations, signing key)",
          "pass",
        )
      : result(
          "probe-ready",
          "the API is ready (database, migrations, signing key)",
          "fail",
          `${config.publicOrigin}/ready answered ${ready?.status ?? "nothing"}`,
        ),
  );
  const jwks = await get(`${config.publicOrigin}/.well-known/jwks.json`);
  const keyCount = await (async (): Promise<number> => {
    try {
      return ((await jwks?.json()) as { keys?: unknown[] }).keys?.length ?? 0;
    } catch {
      return 0;
    }
  })();
  add(
    keyCount > 0
      ? result(
          "probe-jwks",
          "the signing keys are published",
          "pass",
          `${keyCount} key(s)`,
        )
      : result(
          "probe-jwks",
          "the signing keys are published",
          "fail",
          "the key set is empty or unreachable",
        ),
  );
  const site = await get(`https://${config.domain}/`);
  const csp = site?.headers.get("content-security-policy") ?? "";
  add(
    site?.ok &&
      csp !== "" &&
      site.headers.get("strict-transport-security") !== null
      ? result("probe-site", "the site is served with CSP and HSTS", "pass")
      : result(
          "probe-site",
          "the site is served with CSP and HSTS",
          "fail",
          `https://${config.domain}/ answered ${site?.status ?? "nothing"}${csp === "" ? ", with no Content-Security-Policy" : ""}`,
        ),
  );
}

/** What the build recorded about email sign-in (static/account-features.txt line 2), or null if there is no build. */
function readBuiltEmailFlag(staticDir: string): boolean | null {
  try {
    const lines = fs
      .readFileSync(path.join(staticDir, "account-features.txt"), "utf8")
      .split("\n");
    return lines.some((l) => l.trim() === "email-auth=on");
  } catch {
    return null;
  }
}

/**
 * Whether the sender's domain publishes the records that keep a login email
 * out of spam: SPF and DMARC (DKIM's selector is the provider's, so it can
 * only be checked in the provider's dashboard). Warnings: they depend on DNS
 * the operator controls and on the provider.
 */
async function senderDomainChecks(
  config: AccountApiConfig,
  resolve: ((name: string) => Promise<string[][]>) | undefined,
  add: (r: CheckResult) => void,
): Promise<void> {
  const lookup = resolve ?? ((name: string) => dns.promises.resolveTxt(name));
  const domain =
    config.email.from === null
      ? null
      : senderAddress(config.email.from)?.split("@")[1];
  if (domain === undefined || domain === null) return;
  const txt = async (name: string): Promise<string[]> => {
    try {
      return (await lookup(name)).map((parts) => parts.join(""));
    } catch {
      return [];
    }
  };
  const spf = (await txt(domain)).some((r) =>
    r.toLowerCase().startsWith("v=spf1"),
  );
  const dmarc = (await txt(`_dmarc.${domain}`)).some((r) =>
    r.toLowerCase().startsWith("v=dmarc1"),
  );
  const missing = [spf ? "" : "SPF", dmarc ? "" : "DMARC"].filter(Boolean);
  add(
    missing.length === 0
      ? result(
          "email-dns",
          `the sender domain publishes SPF and DMARC`,
          "pass",
          domain,
        )
      : result(
          "email-dns",
          "the sender domain publishes SPF and DMARC",
          "warn",
          `${domain} has no ${missing.join(" or ")} record: sign-in emails are likely to land in spam. Add what the provider tells you, and check DKIM in its dashboard.`,
        ),
  );
}

export function formatReport(report: LaunchReport): string {
  const mark: Record<CheckStatus, string> = {
    pass: "PASS",
    warn: "WARN",
    fail: "FAIL",
    skip: "SKIP",
  };
  const lines = [`DeltaFront launch check (GAME_ENV=${report.env})`, ""];
  for (const r of report.results) {
    lines.push(`  ${mark[r.status]}  ${r.title}`);
    for (const line of (r.detail ?? "").split("\n")) {
      if (line !== "") lines.push(`        ${line}`);
    }
  }
  lines.push("");
  lines.push(
    report.failed === 0
      ? `Result: READY${report.warned > 0 ? ` (${report.warned} warning${report.warned === 1 ? "" : "s"} to read)` : ""}`
      : `Result: NOT READY - ${report.failed} check${report.failed === 1 ? "" : "s"} failed${report.warned > 0 ? `, ${report.warned} warning${report.warned === 1 ? "" : "s"}` : ""}`,
  );
  return lines.join("\n");
}
