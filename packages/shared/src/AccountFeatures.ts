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
    return { enabled: [], rejected: [`${raw.slice(0, 32)}…`] };
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
      .map((t) => JSON.stringify(t))
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

/**
 * The sign-in methods the client offers and the API accepts. Separate from
 * the feature flags: `accounts` says sign-in exists at all, this says which
 * ways in. V1 is guest (always available, no entry here), Discord and Google;
 * email magic links arrive in milestone M8 and Steam is not planned.
 * See docs/DeltaFrontAccountsPlan.md, decision D3.
 */
export const AUTH_PROVIDERS = Object.freeze({
  discord: true,
  google: true,
  email: false,
  steam: false,
} as const);

export type AuthProviderName = keyof typeof AUTH_PROVIDERS;
