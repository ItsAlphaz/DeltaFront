/**
 * What became of the upload of a singleplayer match, per game: the one fact the
 * end screen cannot get from the server by asking (a match that never arrived
 * looks exactly like one still waiting there). LocalServer reports it as it
 * uploads; the end screen reads it and listens, so it can say "uploading",
 * "couldn't upload" (with a retry) or go on to ask how the match was verified.
 */

export type SoloUploadState =
  | { state: "uploading" }
  // The API has it (queued, or it already had it): its verification can be asked about.
  | { state: "queued" }
  // A guest: nothing to verify and no XP to earn.
  | { state: "ignored" }
  // Not accepted. `retryable`: trying again can work (no connection, a server
  // error, a busy queue, an expired session); otherwise the API refused it.
  | { state: "failed"; retryable: boolean; status: number | null };

const states = new Map<string, SoloUploadState>();
const listeners = new Map<string, Set<(s: SoloUploadState) => void>>();

export function reportSoloUpload(gameID: string, state: SoloUploadState): void {
  states.set(gameID, state);
  for (const listener of [...(listeners.get(gameID) ?? [])]) listener(state);
}

export function soloUploadOf(gameID: string): SoloUploadState | null {
  return states.get(gameID) ?? null;
}

/** Calls `listener` on every later change; returns the way to stop. */
export function onSoloUpload(
  gameID: string,
  listener: (s: SoloUploadState) => void,
): () => void {
  let set = listeners.get(gameID);
  if (set === undefined) listeners.set(gameID, (set = new Set()));
  set.add(listener);
  return () => {
    set.delete(listener);
    if (set.size === 0) listeners.delete(gameID);
  };
}

/** For tests. */
export function resetSoloUploads(): void {
  states.clear();
  listeners.clear();
}
