/**
 * Features that need an account backend (`api.<DOMAIN>`): the closed-source
 * Cloudflare Worker that upstream OpenFront runs for sign-in, stats, the
 * store, clans and matchmaking. DeltaFront's own backend (src/account-api,
 * docs/DeltaFrontAccountsPlan.md) is built milestone by milestone, so every
 * one of these is off by default and the UI that depends on it is hidden
 * rather than left to fail against a server that does not exist.
 *
 * A flag is turned on only once the backend implements the endpoints behind
 * it (see docs/DeltaFrontServices.md). Client and server both read this one
 * object, so a feature is never on in the UI but off on the server.
 *
 * What the flags do NOT cover: solo play, private and public lobbies, the
 * simulation, settings, help and news. Those run without a backend.
 *
 * Turning flags on, for development, staging and the eventual public launch,
 * is done with the DF_ACCOUNT_FEATURES environment variable (see
 * `parseAccountFeatureOverride`); with it unset every flag is off.
 */
export interface AccountFeatures {
  /** Sign-in, profile, usernames, account settings, account-linked prompts. */
  accounts: boolean;
  /**
   * The store page: buying cosmetics with Credits (milestone M5). Off until
   * purchases exist, so the page is never shown with nothing to buy.
   */
  store: boolean;
  /**
   * The DeltaFront cosmetic catalog and the inventory page: what a player
   * owns, and equipping it. Needs `accounts` (ownership belongs to an
   * account). The game server checks every equipped cosmetic against it.
   */
  inventory: boolean;
  /** Ranked matchmaking queue (and the server's matchmaking check-in). */
  ranked: boolean;
  /** Clans, clan tags and clan pages. */
  clans: boolean;
  /** Player and clan leaderboards. */
  leaderboards: boolean;
  /**
   * Real money and the premium ("hard") currency: currency packs,
   * subscriptions, Stripe and Steam checkout, creator codes, the lobby queue,
   * clan donations.
   */
  payments: boolean;
  /** Friends list and friend requests. */
  friends: boolean;
  /** XP, levels, prestige, reward claims and the achievements UI. */
  progression: boolean;
  /** Custom (purchasable) tribe names and the tribe leaderboard. */
  tribes: boolean;
  /** The trusted-accounts-only public lobby rotation (needs `accounts`). */
  trustedLobbies: boolean;
}

export type AccountFeatureName = keyof AccountFeatures;

/** Every flag, in the order the docs list them. The only source of names. */
export const ACCOUNT_FEATURE_NAMES = [
  "accounts",
  "store",
  "inventory",
  "ranked",
  "clans",
  "leaderboards",
  "payments",
  "friends",
  "progression",
  "tribes",
  "trustedLobbies",
] as const satisfies readonly AccountFeatureName[];

// A new key in AccountFeatures that is missing from the list above fails the
// build here, so a flag can never exist without being switchable.
const _ALL_FEATURES_LISTED: Exclude<
  AccountFeatureName,
  (typeof ACCOUNT_FEATURE_NAMES)[number]
> extends never
  ? true
  : false = true;
void _ALL_FEATURES_LISTED;

/** Every feature off: what DeltaFront ships with and what an unset or unusable override means. */
export function allFeaturesOff(): AccountFeatures {
  return {
    accounts: false,
    store: false,
    inventory: false,
    ranked: false,
    clans: false,
    leaderboards: false,
    payments: false,
    friends: false,
    progression: false,
    tribes: false,
    trustedLobbies: false,
  };
}

/**
 * How a rejected token is named in a message. A plausible typo of a feature
 * name is echoed (it is what the operator needs to see); anything else is
 * only counted, because a value pasted into the wrong variable may be a secret.
 */
export function describeRejectedToken(token: string): string {
  return /^[A-Za-z][A-Za-z0-9_-]{0,31}$/.test(token)
    ? JSON.stringify(token)
    : `<${token.length} characters, not a feature name>`;
}

/** The environment variable that switches features on (comma-separated flag names). */
export const ACCOUNT_FEATURES_ENV = "DF_ACCOUNT_FEATURES";

/** A longer value is not something an operator wrote: it is ignored whole. */
const MAX_OVERRIDE_LENGTH = 512;

const KNOWN_FEATURES: ReadonlySet<string> = new Set(ACCOUNT_FEATURE_NAMES);

export interface AccountFeatureOverride {
  /** The flags the value switches on, each once, in the order the docs list them. */
  enabled: AccountFeatureName[];
  /** Tokens that were not enabled because they are not flag names, or the whole value if it was unusable. */
  rejected: string[];
}

/**
 * Reads a DF_ACCOUNT_FEATURES value: a comma-separated list of flag names,
 * e.g. `accounts,leaderboards`.
 *
 * It can only ever switch known flags ON, and fails towards off:
 *  - unset, empty or all-whitespace means nothing is enabled;
 *  - a token must match a flag name exactly (case-sensitive), so a typo
 *    enables nothing (it is reported in `rejected`, never guessed at);
 *  - surrounding whitespace and empty tokens (`a,,b`, a trailing comma) are
 *    tolerated;
 *  - there is no wildcard such as `all`, and no way to switch a flag off;
 *  - a value that is not a string, or is absurdly long, is rejected whole.
 */
export function parseAccountFeatureOverride(
  raw: unknown,
): AccountFeatureOverride {
  if (raw === undefined || raw === null) {
    return { enabled: [], rejected: [] };
  }
  if (typeof raw !== "string") {
    return { enabled: [], rejected: [String(raw)] };
  }
  if (raw.length > MAX_OVERRIDE_LENGTH) {
    return { enabled: [], rejected: [raw.slice(0, 64)] };
  }
  const requested = new Set<string>();
  const rejected: string[] = [];
  for (const token of raw.split(",")) {
    const name = token.trim();
    if (name === "") continue;
    if (KNOWN_FEATURES.has(name)) requested.add(name);
    else rejected.push(name);
  }
  return {
    enabled: ACCOUNT_FEATURE_NAMES.filter((name) => requested.has(name)),
    rejected,
  };
}

/** The feature set a DF_ACCOUNT_FEATURES value selects, with the tokens it could not use. */
export function resolveAccountFeatures(raw: unknown): {
  features: AccountFeatures;
  rejected: string[];
} {
  const { enabled, rejected } = parseAccountFeatureOverride(raw);
  const features = allFeaturesOff();
  for (const name of enabled) features[name] = true;
  return { features, rejected };
}

/**
 * The override as this process sees it. Written as the bare expression
 * `process.env.DF_ACCOUNT_FEATURES` because Vite replaces exactly that text
 * in the client bundle (vite.config.ts `define`); on the server it is the real
 * environment. Anywhere neither applies (a browser build without the define)
 * the reference throws and the answer is "unset": all off.
 */
function readEnvOverride(): string | undefined {
  try {
    return process.env.DF_ACCOUNT_FEATURES;
  } catch {
    return undefined;
  }
}

const initial = resolveAccountFeatures(readEnvOverride());
if (initial.rejected.length > 0) {
  console.warn(
    `${ACCOUNT_FEATURES_ENV}: ignoring ${initial.rejected
      .map(describeRejectedToken)
      .join(", ")} (known features: ${ACCOUNT_FEATURE_NAMES.join(", ")})`,
  );
}

export const ACCOUNT_FEATURES: AccountFeatures = initial.features;

/**
 * True when the cosmetic catalog is in use: the inventory, the store, or the
 * game server's cosmetic and clan-tag checks (which read the catalog too).
 */
export function usesCosmeticCatalog(
  features: AccountFeatures = ACCOUNT_FEATURES,
): boolean {
  return features.inventory || features.store || features.clans;
}

/** True when any feature that talks to the account API is switched on. */
export function usesAccountApi(
  features: AccountFeatures = ACCOUNT_FEATURES,
): boolean {
  return Object.values(features).some(Boolean);
}

/** The environment variable that switches email magic-link sign-in on (`1` or `true`). */
export const EMAIL_AUTH_ENV = "DF_EMAIL_AUTH";

/**
 * Reads a DF_EMAIL_AUTH value. Email sign-in is a separate switch from the
 * feature flags (it also needs a mail provider, see src/account-api/auth/
 * email.ts), and it fails towards off: only `1` and `true` (any case, padded
 * with spaces) turn it on. `invalid` is anything else that was set, so a
 * typo such as `yes` is reported by the servers instead of silently meaning
 * "off" or "on".
 */
export function parseEmailAuthFlag(raw: unknown): {
  enabled: boolean;
  invalid: boolean;
} {
  if (raw === undefined || raw === null)
    return { enabled: false, invalid: false };
  if (typeof raw !== "string") return { enabled: false, invalid: true };
  const value = raw.trim().toLowerCase();
  if (value === "" || value === "0" || value === "false")
    return { enabled: false, invalid: false };
  if (value === "1" || value === "true")
    return { enabled: true, invalid: false };
  return { enabled: false, invalid: true };
}

/**
 * The value the client build bakes in for `process.env.DF_EMAIL_AUTH`
 * (vite.config.ts): `"1"` or `""`, never the raw text. A production build
 * refuses a value that is neither on nor off.
 */
export function buildTimeEmailAuth(
  raw: string | undefined,
  production: boolean,
): "1" | "" {
  const { enabled, invalid } = parseEmailAuthFlag(raw);
  if (invalid && production) {
    throw new Error(
      `${EMAIL_AUTH_ENV} must be 1, true, 0 or false (or unset). The build was stopped so the client does not ship with email sign-in silently off.`,
    );
  }
  return enabled ? "1" : "";
}

/**
 * Read as the bare expression `process.env.DF_EMAIL_AUTH` for the same reason
 * as readEnvOverride: Vite replaces exactly that text in the client bundle.
 */
function readEmailAuthEnv(): string | undefined {
  try {
    return process.env.DF_EMAIL_AUTH;
  } catch {
    return undefined;
  }
}

/**
 * The sign-in methods the client offers and the API accepts. Separate from
 * the feature flags: `accounts` says sign-in exists at all, this says which
 * ways in. Guest (always available, no entry here), Discord and Google are
 * on; `email` (magic links, milestone M8) is on only when DF_EMAIL_AUTH says
 * so, for the client build, the game server and the account API alike; Steam
 * is not planned. See docs/DeltaFrontAccountsPlan.md, decision D3 and M8.
 */
export const AUTH_PROVIDERS = Object.freeze({
  discord: true,
  google: true,
  email: parseEmailAuthFlag(readEmailAuthEnv()).enabled,
  steam: false,
});

export type AuthProviderName = keyof typeof AUTH_PROVIDERS;

/**
 * The public-launch profile: the flags a production deployment turns on, and
 * the value to set `DF_ACCOUNT_FEATURES` to, for the client build, the game
 * server and the account API alike (docs/Deployment.md). Everything else in
 * `AccountFeatures` has no backend yet, so it stays off: a flag outside this
 * set would show an unfinished feature, so outside dev both servers refuse to
 * start with one (`unfinishedFeatures`) and `npm run launch:check` fails.
 */
export const LAUNCH_FEATURES = [
  "accounts",
  "store",
  "inventory",
  "clans",
  "leaderboards",
] as const satisfies readonly AccountFeatureName[];

/** `accounts,store,inventory,clans,leaderboards`, the string deployments set. */
export const LAUNCH_FEATURES_VALUE = LAUNCH_FEATURES.join(",");

/** The enabled flags that are not part of the launch profile (to refuse outside dev). */
export function unfinishedFeatures(
  features: AccountFeatures,
): AccountFeatureName[] {
  const launch: readonly string[] = LAUNCH_FEATURES;
  return ACCOUNT_FEATURE_NAMES.filter(
    (name) => features[name] && !launch.includes(name),
  );
}

/**
 * The value the client build bakes in for `process.env.DF_ACCOUNT_FEATURES`
 * (vite.config.ts): the known feature names, normalised, and nothing else, so
 * no stray text from the environment can reach the browser bundle. A
 * production build refuses an unknown name instead of quietly building with a
 * feature off.
 */
export function buildTimeFeatureList(
  raw: string | undefined,
  production: boolean,
): string {
  const { enabled, rejected } = parseAccountFeatureOverride(raw);
  if (rejected.length > 0 && production) {
    throw new Error(
      `${ACCOUNT_FEATURES_ENV}: unknown feature ${rejected
        .map(describeRejectedToken)
        .join(
          ", ",
        )} (known: ${ACCOUNT_FEATURE_NAMES.join(", ")}). The build was stopped so the client does not ship with a feature silently off.`,
    );
  }
  return enabled.join(",");
}
