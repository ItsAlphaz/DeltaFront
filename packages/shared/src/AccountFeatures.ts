/**
 * Features that need an account backend (`api.<DOMAIN>`): the closed-source
 * Cloudflare Worker that upstream OpenFront runs for sign-in, stats, the
 * store, clans and matchmaking. DeltaFront has no such backend yet, so every
 * one of these is off and the UI that depends on it is hidden rather than left
 * to fail against a server that does not exist.
 *
 * Flip a flag to true only once a DeltaFront backend implements the endpoints
 * behind it (see docs/DeltaFrontServices.md). Client and server both read this
 * one object, so a feature is never on in the UI but off on the server.
 *
 * What the flags do NOT cover: solo play, private and public lobbies, the
 * simulation, settings, help and news. Those run without a backend.
 */
export interface AccountFeatures {
  /** Sign-in, profile, friends, XP/progression, account-linked prompts. */
  accounts: boolean;
  /** Store, inventory, cosmetics, purchases and subscriptions. */
  store: boolean;
  /** Ranked matchmaking queue (and the server's matchmaking check-in). */
  ranked: boolean;
  /** Clans, clan tags and clan pages. */
  clans: boolean;
  /** Player, clan and tribe leaderboards. */
  leaderboards: boolean;
}

export const ACCOUNT_FEATURES: AccountFeatures = {
  accounts: false,
  store: false,
  ranked: false,
  clans: false,
  leaderboards: false,
};

/** True when any feature that talks to the account API is switched on. */
export function usesAccountApi(
  features: AccountFeatures = ACCOUNT_FEATURES,
): boolean {
  return Object.values(features).some(Boolean);
}
