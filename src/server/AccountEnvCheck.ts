import {
  ACCOUNT_FEATURE_NAMES,
  ACCOUNT_FEATURES,
  unfinishedFeatures,
  usesAccountApi,
  type AccountFeatures,
} from "@openfront/shared/AccountFeatures";
import fs from "node:fs";
import path from "node:path";
import { JOIN_FALLBACK_POLICIES } from "./JoinFallback";

/**
 * The game server's startup check for account-backed operation.
 *
 * With any account feature on, the server calls the account API for join
 * verification, check-in and the game archive, and proves who it is with the
 * shared `API_KEY` header. A server without one would start fine and then be
 * refused on every call (joins fail open, public lobbies never open), which
 * is a confusing way to find out; so it refuses to start instead, saying what
 * is missing. The message names the variable, never its value.
 */

export class AccountEnvError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AccountEnvError";
  }
}

/** The key the dev script sets; fine locally, never acceptable on a deployed server. */
const DEV_KEY_MARKER = "WARNING_DEV_API_KEY";

/** `server:key:create` makes `dfk_` plus 43 characters; anything much shorter was not made by it. */
const MIN_KEY_LENGTH = 32;
const PLACEHOLDER_KEY = /change.?me|placeholder|example|your.?key|xxxx|secret/i;

export function assertAccountBackendEnv(options: {
  env?: Record<string, string | undefined>;
  features?: AccountFeatures;
  /** True for a local dev server, where the dev key is expected. */
  isDev: boolean;
}): void {
  const env = options.env ?? process.env;
  const features = options.features ?? ACCOUNT_FEATURES;
  if (!usesAccountApi(features)) return;

  const enabled = ACCOUNT_FEATURE_NAMES.filter((name) => features[name]).join(
    ", ",
  );
  const key = (env.API_KEY ?? "").trim();
  if (key === "") {
    throw new AccountEnvError(
      `API_KEY is required when account features are enabled (${enabled}): the game server authenticates its calls to the account API with it (join verification, check-in, game archive). Set API_KEY to a key registered with "npm run admin -- server:key:create".`,
    );
  }
  if (!options.isDev && key.includes(DEV_KEY_MARKER)) {
    throw new AccountEnvError(
      `API_KEY is the development placeholder key but this is not a dev server (account features enabled: ${enabled}). Set API_KEY to a real server key.`,
    );
  }
  if (options.isDev) return;

  // A deployed (staging or prod) server: every mistake below is reported at
  // once, by variable name only, so a bad value never reaches a log.
  const problems: string[] = [];
  if (key.length < MIN_KEY_LENGTH || PLACEHOLDER_KEY.test(key)) {
    problems.push(
      `API_KEY does not look like a key made by "server:key:create" (too short, or a placeholder)`,
    );
  }
  const domain = (env.DOMAIN ?? "").trim();
  // Staging may run on localhost (a production-like local stack); prod may not.
  if (domain === "" || (env.GAME_ENV === "prod" && domain === "localhost")) {
    problems.push("DOMAIN must be the public site domain, not localhost");
  }
  if (features.accounts && (env.TURNSTILE_SITE_KEY ?? "").trim() === "") {
    problems.push(
      "TURNSTILE_SITE_KEY is required (the client runs the bot check before joining)",
    );
  }
  const fallback = (env.TURNSTILE_FALLBACK ?? "").trim();
  if (
    fallback !== "" &&
    !(JOIN_FALLBACK_POLICIES as readonly string[]).includes(fallback)
  ) {
    problems.push(
      `TURNSTILE_FALLBACK must be one of: ${JOIN_FALLBACK_POLICIES.join(", ")}`,
    );
  }
  const unfinished = unfinishedFeatures(features);
  if (unfinished.length > 0) {
    problems.push(
      `DF_ACCOUNT_FEATURES enables ${unfinished.join(", ")}, which DeltaFront does not implement yet (only the launch features may run outside dev)`,
    );
  }
  if (problems.length > 0) {
    throw new AccountEnvError(
      `The game server's configuration is not safe to run:\n${problems.map((p) => `  - ${p}`).join("\n")}`,
    );
  }
}

/**
 * The client in `static/` was built with some DF_ACCOUNT_FEATURES
 * (scripts/writeBuildFeatures.ts records them in `account-features.txt`); the
 * server runs with its own. If they differ, the page shows features the
 * backend does not offer, or hides ones it does. Outside dev that is refused;
 * a missing record (a build from before this check) is refused in prod and
 * only reported in staging.
 */
export function assertBuildMatchesRuntime(options: {
  staticDir: string;
  features?: AccountFeatures;
  env: "dev" | "staging" | "prod";
  warn: (message: string) => void;
}): void {
  if (options.env === "dev") return;
  const features = options.features ?? ACCOUNT_FEATURES;
  const runtime = ACCOUNT_FEATURE_NAMES.filter((n) => features[n]);
  let recorded: string[];
  try {
    recorded = fs
      .readFileSync(
        path.join(options.staticDir, "account-features.txt"),
        "utf8",
      )
      .trim()
      .split(",")
      .filter((t) => t !== "");
  } catch {
    const message =
      "static/account-features.txt is missing: the client was not built with `npm run build-prod`, so its feature flags cannot be checked against this server";
    if (options.env === "prod") throw new AccountEnvError(message);
    options.warn(message);
    return;
  }
  const missing = runtime.filter((n) => !recorded.includes(n));
  const extra = recorded.filter((n) => !runtime.includes(n as never));
  if (missing.length > 0 || extra.length > 0) {
    throw new AccountEnvError(
      `The client was built with DF_ACCOUNT_FEATURES=${recorded.join(",") || "(none)"} but this server runs with ${runtime.join(",") || "(none)"}. Build and run with the same value (docker build --build-arg DF_ACCOUNT_FEATURES=...).`,
    );
  }
}
