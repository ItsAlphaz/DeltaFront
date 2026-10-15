/**
 * A game whose XP has not been seen yet, remembered across page loads. The game
 * server stores a game's XP as soon as its result is settled, whether or not the
 * player stays to watch: a winner can leave from "You won" and a player can close
 * the tab. So the page remembers the game it was playing (while the XP preview
 * says there is XP at stake) and the next page load looks the result up in the
 * background (see PendingXp.ts). Kept apart from that so the in-game UI imports
 * only this small, dependency-free part.
 */

const KEY = "df.pendingXp";
/** A game older than this is not worth asking about. */
export const PENDING_XP_MAX_AGE_MS = 2 * 60 * 60_000;

interface Pending {
  gameId: string;
  at: number;
}

function storage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/** Remember that this game has XP the player has not seen settled. */
export function rememberPendingXp(gameId: string, now = Date.now()): void {
  const pending: Pending = { gameId, at: now };
  try {
    storage()?.setItem(KEY, JSON.stringify(pending));
  } catch {
    // Storage unavailable: the player simply won't get the background toast.
  }
}

export function clearPendingXp(): void {
  try {
    storage()?.removeItem(KEY);
  } catch {
    // Nothing to clear.
  }
}

export function readPendingXp(now = Date.now()): Pending | null {
  let raw: string | null;
  try {
    raw = storage()?.getItem(KEY) ?? null;
  } catch {
    return null;
  }
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<Pending>;
    if (
      typeof parsed.gameId !== "string" ||
      typeof parsed.at !== "number" ||
      now - parsed.at > PENDING_XP_MAX_AGE_MS
    ) {
      return null;
    }
    return { gameId: parsed.gameId, at: parsed.at };
  } catch {
    return null;
  }
}
