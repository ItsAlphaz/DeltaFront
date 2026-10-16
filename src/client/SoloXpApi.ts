import { ACCOUNT_FEATURES } from "@openfront/shared/AccountFeatures";
import {
  type GameXpResponse,
  type SoloStatusResponse,
  SoloStatusResponseSchema,
} from "@openfront/shared/ApiSchemas";
import { getApiBase } from "./ApiBase";
import { getAuthHeader } from "./Auth";
import { onSoloUpload, soloUploadOf, type SoloUploadState } from "./SoloUpload";

/**
 * A singleplayer match's XP, from the end screen's side.
 *
 * It has its own endpoint (`GET /users/@me/solo/:gameId`) and its own states,
 * and does not use the multiplayer XP routes: a solo match has no live preview
 * and no game server, and the multiplayer route answers 404 both for a match
 * that is waiting and for one that was never received. The poll reads two
 * things, what the API says (queued, verifying, paid, refused) and what became
 * of the upload (LocalServer reports it, SoloUpload), and every path out of it
 * is a conclusion:
 *
 *   uploading ──▶ queued ──▶ verifying ──▶ result (paid, or refused with a reason)
 *        │           │            │
 *        ▼           ▼            ▼
 *     failed      failed       failed      upload / unsupported / unreachable /
 *   (retryable)  (it never     (the API      timeout / verify_failed / signed_out
 *                 arrived)      gave up)
 *
 * It never loops forever (a deadline), stops on the first conclusion, ignores
 * a transient error until there have been several in a row, treats a 404 (an API
 * without the route) as permanent after a second look, and stops the moment its
 * signal is aborted.
 */

export type SoloFetchResult =
  | { status: "ok"; data: SoloStatusResponse }
  // 404: this API has no such route (an older one, or progression off)
  | { status: "missing" }
  // signed out, or a body we cannot read: asking again will not help
  | { status: "unavailable" }
  // a network failure or a server error: worth asking again
  | { status: "error" };

function requestSignal(signal: AbortSignal | undefined): AbortSignal {
  const timeout = AbortSignal.timeout(10_000);
  if (signal === undefined || typeof AbortSignal.any !== "function") {
    return timeout;
  }
  return AbortSignal.any([signal, timeout]);
}

// GET /users/@me/solo/:gameId
export async function fetchSoloStatus(
  gameId: string,
  signal?: AbortSignal,
): Promise<SoloFetchResult> {
  if (!ACCOUNT_FEATURES.progression) return { status: "missing" };
  try {
    const authorization = await getAuthHeader();
    if (authorization === "") return { status: "unavailable" };
    const res = await fetch(
      `${getApiBase()}/users/@me/solo/${encodeURIComponent(gameId)}`,
      {
        headers: { Accept: "application/json", Authorization: authorization },
        signal: requestSignal(signal),
      },
    );
    if (res.status === 404) return { status: "missing" };
    if (res.status === 401 || res.status === 403) {
      return { status: "unavailable" };
    }
    if (!res.ok) return { status: "error" };
    const parsed = SoloStatusResponseSchema.safeParse(await res.json());
    if (!parsed.success) {
      console.warn("fetchSoloStatus: Zod validation failed", parsed.error);
      return { status: "unavailable" };
    }
    return { status: "ok", data: parsed.data };
  } catch (err) {
    if (!signal?.aborted) console.warn("fetchSoloStatus: request failed", err);
    return { status: "error" };
  }
}

export type SoloPhase = "uploading" | "queued" | "verifying";

export type SoloFailure =
  // The match did not reach the API (a failed upload, or one the API says it never had)
  | "upload"
  // The API refused the upload itself: it will refuse it again
  | "refused_upload"
  // This API has no solo route
  | "unsupported"
  // The API could not be reached, several times running
  | "unreachable"
  // It took longer than the poll waits
  | "timeout"
  // The API tried to replay the match and could not (a fault on its side)
  | "verify_failed"
  | "signed_out";

export type SoloPollOutcome =
  // The match was decided: paid, or refused with a reason the panel has words for
  | { kind: "result"; data: GameXpResponse }
  | { kind: "failed"; failure: SoloFailure; retryable: boolean }
  | { kind: "aborted" };

/** How long a match may take to be verified before the poll says so (the API's own replay limit is 15 minutes). */
export const SOLO_POLL_TIMEOUT_MS = 10 * 60_000;
/** The first, quicker looks. */
const FAST_WINDOW_MS = 12_000;
/** How long the API may say "unknown" for a match that was uploaded before it is called lost. */
export const SOLO_UNKNOWN_GRACE_MS = 20_000;
/** Failures to reach the API in a row before the poll gives up. */
const MAX_CONSECUTIVE_ERRORS = 6;
/** 404s in a row (the route is not there) before the poll gives up. */
const MAX_MISSING = 2;

export interface PollSoloOptions {
  signal?: AbortSignal;
  /** Called when what the match is waiting for changes. */
  onPhase?: (phase: SoloPhase) => void;
  timeoutMs?: number;
  intervalMs?: number;
  // Injectable for tests.
  fetcher?: (gameId: string, signal?: AbortSignal) => Promise<SoloFetchResult>;
  uploadOf?: (gameId: string) => SoloUploadState | null;
  now?: () => number;
}

/**
 * Follows a solo match from upload to result. Resolves to a conclusion: never
 * to "nothing", never after the signal is aborted, never later than the
 * deadline.
 */
export async function pollSoloXp(
  gameId: string,
  opts: PollSoloOptions = {},
): Promise<SoloPollOutcome> {
  const fetcher = opts.fetcher ?? fetchSoloStatus;
  const uploadOf = opts.uploadOf ?? soloUploadOf;
  const now = opts.now ?? Date.now;
  const startedAt = now();
  const deadline = startedAt + (opts.timeoutMs ?? SOLO_POLL_TIMEOUT_MS);
  let phase: SoloPhase | null = null;
  const setPhase = (next: SoloPhase) => {
    if (phase === next) return;
    phase = next;
    opts.onPhase?.(next);
  };
  let errors = 0;
  let missing = 0;
  let unknownSince: number | null = null;

  for (;;) {
    if (opts.signal?.aborted) return { kind: "aborted" };
    if (now() >= deadline) {
      return { kind: "failed", failure: "timeout", retryable: true };
    }
    const upload = uploadOf(gameId);
    if (upload?.state === "failed") {
      const permanent = upload.status === 404;
      return {
        kind: "failed",
        failure: permanent
          ? "unsupported"
          : upload.retryable
            ? "upload"
            : "refused_upload",
        retryable: upload.retryable,
      };
    }
    if (upload?.state === "ignored") {
      return {
        kind: "result",
        data: { gameId, eligible: false, reason: "guest" },
      };
    }
    let waitMs =
      opts.intervalMs ?? (now() - startedAt < FAST_WINDOW_MS ? 1_000 : 3_000);
    if (upload?.state === "uploading") {
      setPhase("uploading");
    } else {
      const res = await fetcher(gameId, opts.signal);
      if (opts.signal?.aborted) return { kind: "aborted" };
      if (res.status === "unavailable") {
        return { kind: "failed", failure: "signed_out", retryable: false };
      }
      if (res.status === "missing") {
        if (++missing >= MAX_MISSING) {
          return { kind: "failed", failure: "unsupported", retryable: false };
        }
      } else if (res.status === "error") {
        if (++errors >= MAX_CONSECUTIVE_ERRORS) {
          return { kind: "failed", failure: "unreachable", retryable: true };
        }
        // back off a little more with each one
        waitMs = Math.min(10_000, waitMs * (errors + 1));
      } else {
        errors = 0;
        missing = 0;
        const data = res.data;
        if (data.status === "paid" && data.result !== undefined) {
          return { kind: "result", data: data.result };
        }
        if (data.status === "rejected") {
          if (data.reason === "verify_failed" || data.result === undefined) {
            return {
              kind: "failed",
              failure: "verify_failed",
              retryable: false,
            };
          }
          return { kind: "result", data: data.result };
        }
        if (data.status === "verifying" || data.status === "paid") {
          unknownSince = null;
          setPhase("verifying");
        } else if (data.status === "queued") {
          unknownSince = null;
          setPhase("queued");
        } else {
          // The API has nothing from us for this game. Right after an upload
          // that can be a moment; for long it means the match never arrived.
          unknownSince ??= now();
          if (now() - unknownSince > SOLO_UNKNOWN_GRACE_MS) {
            return { kind: "failed", failure: "upload", retryable: true };
          }
          setPhase(upload?.state === "queued" ? "queued" : "uploading");
        }
      }
    }
    await wait(waitMs, gameId, opts.signal);
  }
}

// Waits `ms`, or until aborted, or until the upload's state changes (so a
// failed upload is reported at once, not at the next look).
function wait(
  ms: number,
  gameId: string,
  signal: AbortSignal | undefined,
): Promise<void> {
  return new Promise<void>((resolve) => {
    const done = () => {
      clearTimeout(timer);
      stop();
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    const stop = onSoloUpload(gameId, done);
    signal?.addEventListener("abort", done, { once: true });
  });
}
