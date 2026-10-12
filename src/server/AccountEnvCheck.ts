import {
  ACCOUNT_FEATURE_NAMES,
  ACCOUNT_FEATURES,
  usesAccountApi,
  type AccountFeatures,
} from "@openfront/shared/AccountFeatures";

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
}
