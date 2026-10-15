import { ACCOUNT_FEATURES } from "@openfront/shared/AccountFeatures";
import {
  type GameXpResponse,
  GameXpResponseSchema,
  type LiveXpResponse,
  LiveXpResponseSchema,
  type PrestigeResponse,
  PrestigeResponseSchema,
  type ProgressionConfig,
  ProgressionConfigSchema,
  type ProgressionMe,
  ProgressionMeSchema,
  type PublicProgress,
  PublicProgressSchema,
  type XpLeaderboardResponse,
  XpLeaderboardResponseSchema,
} from "@openfront/shared/ApiSchemas";
// ApiBase rather than Api: this module is imported by in-game UI (WinModal)
// whose tests stub Api wholesale.
import { getApiBase } from "./ApiBase";
import { getAuthHeader } from "./Auth";

// Player levels / XP. Every helper here fails closed: progression is purely
// cosmetic, so any error hides the UI rather than surfacing a failure.

export type GameXpFetchResult =
  | { status: "ok"; data: GameXpResponse }
  // 404 (not processed yet, or progression off) or a transient failure —
  // worth asking again while the caller is still polling.
  | { status: "pending" }
  // A conclusion: signed out, or a body we cannot read. Stop asking.
  | { status: "unavailable" };

// The request's own timeout, plus the caller's signal when there is one, so
// aborting cancels a request already in flight rather than leaving it to run
// to its timeout. Without AbortSignal.any (older browsers), just the timeout.
function requestSignal(signal: AbortSignal | undefined): AbortSignal {
  const timeout = AbortSignal.timeout(10_000);
  if (signal === undefined || typeof AbortSignal.any !== "function") {
    return timeout;
  }
  return AbortSignal.any([signal, timeout]);
}

// GET /users/@me/xp/:gameId — the XP the caller earned in one game.
export async function fetchMyGameXp(
  gameId: string,
  signal?: AbortSignal,
): Promise<GameXpFetchResult> {
  if (!ACCOUNT_FEATURES.progression) return { status: "unavailable" };
  try {
    const authorization = await getAuthHeader();
    if (authorization === "") return { status: "unavailable" };
    const res = await fetch(
      `${getApiBase()}/users/@me/xp/${encodeURIComponent(gameId)}`,
      {
        headers: { Accept: "application/json", Authorization: authorization },
        signal: requestSignal(signal),
      },
    );
    if (res.status === 404) return { status: "pending" };
    if (res.status === 401 || res.status === 403) {
      return { status: "unavailable" };
    }
    if (!res.ok) {
      console.warn("fetchMyGameXp: unexpected status", res.status);
      return { status: "pending" };
    }
    const parsed = GameXpResponseSchema.safeParse(await res.json());
    if (!parsed.success) {
      console.warn("fetchMyGameXp: Zod validation failed", parsed.error);
      return { status: "unavailable" };
    }
    return { status: "ok", data: parsed.data };
  } catch (err) {
    // The caller gave up: not a failure worth a warning.
    if (signal?.aborted) return { status: "pending" };
    console.warn("fetchMyGameXp: request failed", err);
    return { status: "pending" };
  }
}

// How often a running game's XP preview is read again: the server's own report
// moves every ten seconds (its agreed live stats), so asking faster would only
// repeat the answer.
export const LIVE_XP_POLL_MS = 5_000;
// Once the player is out, the server's confirmation (and the reduced award it
// pays) is what is waited for, a few seconds away: look more often.
export const OUT_XP_POLL_MS = 2_000;

export type LiveXpFetchResult =
  | { status: "ok"; data: LiveXpResponse }
  // 404: the game is not reported (yet, or any more: it was stored) or a
  // transient failure. Ask again while the game is on.
  | { status: "none" }
  // A conclusion: signed out, progression off, or a body we cannot read.
  | { status: "unavailable" };

// GET /users/@me/xp/live/:gameId — what the caller's XP stands at in a game
// that is still running (a preview: only the stored game awards XP).
export async function fetchLiveXp(
  gameId: string,
  signal?: AbortSignal,
): Promise<LiveXpFetchResult> {
  if (!ACCOUNT_FEATURES.progression) return { status: "unavailable" };
  try {
    const authorization = await getAuthHeader();
    if (authorization === "") return { status: "unavailable" };
    const res = await fetch(
      `${getApiBase()}/users/@me/xp/live/${encodeURIComponent(gameId)}`,
      {
        headers: { Accept: "application/json", Authorization: authorization },
        signal: requestSignal(signal),
      },
    );
    if (res.status === 404) return { status: "none" };
    if (res.status === 401 || res.status === 403) {
      return { status: "unavailable" };
    }
    if (!res.ok) return { status: "none" };
    const parsed = LiveXpResponseSchema.safeParse(await res.json());
    if (!parsed.success) {
      console.warn("fetchLiveXp: Zod validation failed", parsed.error);
      return { status: "unavailable" };
    }
    return { status: "ok", data: parsed.data };
  } catch (err) {
    if (!signal?.aborted) console.warn("fetchLiveXp: request failed", err);
    return { status: "none" };
  }
}

// How long the first, quicker looks for a finished game's XP last.
const FAST_POLL_WINDOW_MS = 12_000;

export interface PollGameXpOptions {
  intervalMs?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  // Injectable for tests.
  fetcher?: (
    gameId: string,
    signal?: AbortSignal,
  ) => Promise<GameXpFetchResult>;
}

/**
 * Asks for a game's XP until it is processed, the deadline passes, or the
 * caller aborts. Resolves to the response, or null when there is nothing to
 * show (timed out, signed out, unreadable, aborted) — never a zero.
 */
export async function pollGameXp(
  gameId: string,
  opts: PollGameXpOptions = {},
): Promise<GameXpResponse | null> {
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const fetcher = opts.fetcher ?? fetchMyGameXp;
  const startedAt = Date.now();
  const deadline = startedAt + timeoutMs;
  for (;;) {
    // The result is usually stored within a moment of the game being settled:
    // look every second at first, then ease off. An explicit interval is kept.
    const intervalMs =
      opts.intervalMs ??
      (Date.now() - startedAt < FAST_POLL_WINDOW_MS ? 1_000 : 3_000);
    if (opts.signal?.aborted) return null;
    const result = await fetcher(gameId, opts.signal);
    if (opts.signal?.aborted) return null;
    if (result.status === "ok") return result.data;
    if (result.status === "unavailable") return null;
    if (Date.now() + intervalMs > deadline) return null;
    const signal = opts.signal;
    await new Promise<void>((resolve) => {
      // Whichever fires first tears down the other, so a long poll never
      // piles one abort listener per wait onto the caller's signal.
      const onAbort = () => {
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      }, intervalMs);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }
}

// GET /public/player/:publicId/progress — another player's level. False on a
// 404 (unknown player, progression off) and every other failure.
export async function fetchPublicPlayerProgress(
  publicId: string,
): Promise<PublicProgress | false> {
  if (!ACCOUNT_FEATURES.progression) return false;
  try {
    const res = await fetch(
      `${getApiBase()}/public/player/${encodeURIComponent(publicId)}/progress`,
      {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(10_000),
      },
    );
    if (res.status === 404) return false;
    if (!res.ok) {
      console.warn("fetchPublicPlayerProgress: unexpected status", res.status);
      return false;
    }
    const parsed = PublicProgressSchema.safeParse(await res.json());
    if (!parsed.success) {
      console.warn(
        "fetchPublicPlayerProgress: Zod validation failed",
        parsed.error,
      );
      return false;
    }
    return parsed.data;
  } catch (err) {
    console.warn("fetchPublicPlayerProgress: request failed", err);
    return false;
  }
}

// POST /users/@me/prestige — the opt-in reset at level 100. The caller keeps
// one idempotency key until a prestige succeeds, so a retried request (a
// slow network, a lost response) prestiges once. Unlike the reads above this
// does surface failure: the player asked for it and must be told why.
// - "refused": the server says the player can't prestige (409), usually an
//   earlier prestige whose answer never arrived.
// - "signed_out": no session to send, or the server rejected it (401/403).
// - "failed": anything else. It may or may not have gone through, and a
//   retry with the same key finds out.
export type PrestigeFailure = "refused" | "signed_out" | "failed";

export type PrestigeResult =
  | { ok: true; data: PrestigeResponse }
  | { ok: false; reason: PrestigeFailure };

export async function prestigeMe(
  idempotencyKey: string,
): Promise<PrestigeResult> {
  if (!ACCOUNT_FEATURES.progression) return { ok: false, reason: "failed" };
  try {
    const authorization = await getAuthHeader();
    if (authorization === "") return { ok: false, reason: "signed_out" };
    const res = await fetch(`${getApiBase()}/users/@me/prestige`, {
      method: "POST",
      headers: {
        Accept: "application/json",
        Authorization: authorization,
        "Idempotency-Key": idempotencyKey,
      },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      console.warn("prestigeMe: unexpected status", res.status);
      if (res.status === 409) return { ok: false, reason: "refused" };
      if (res.status === 401 || res.status === 403) {
        return { ok: false, reason: "signed_out" };
      }
      return { ok: false, reason: "failed" };
    }
    const parsed = PrestigeResponseSchema.safeParse(await res.json());
    if (!parsed.success) {
      console.warn("prestigeMe: Zod validation failed", parsed.error);
      return { ok: false, reason: "failed" };
    }
    return { ok: true, data: parsed.data };
  } catch (err) {
    console.warn("prestigeMe: request failed", err);
    return { ok: false, reason: "failed" };
  }
}

// The server's max-age for the config: a deploy that changes it has to reach
// open tabs within this.
const PROGRESSION_CONFIG_TTL_MS = 60_000;

let progressionConfig: {
  request: Promise<ProgressionConfig | false>;
  at: number;
} | null = null;

// GET /public/progression/config — the level curve, and whether progression is
// on at all (404 when it is off). Memoised for as long as the server says it
// stays fresh; a failure is not, so a later caller can try again.
export function fetchProgressionConfig(): Promise<ProgressionConfig | false> {
  if (!ACCOUNT_FEATURES.progression) return Promise.resolve(false);
  if (
    progressionConfig !== null &&
    Date.now() - progressionConfig.at < PROGRESSION_CONFIG_TTL_MS
  ) {
    return progressionConfig.request;
  }
  const request = (async (): Promise<ProgressionConfig | false> => {
    try {
      const res = await fetch(`${getApiBase()}/public/progression/config`, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) return false;
      const parsed = ProgressionConfigSchema.safeParse(await res.json());
      if (!parsed.success) {
        console.warn(
          "fetchProgressionConfig: Zod validation failed",
          parsed.error,
        );
        return false;
      }
      return parsed.data;
    } catch (err) {
      console.warn("fetchProgressionConfig: request failed", err);
      return false;
    }
  })();
  const entry = { request, at: Date.now() };
  progressionConfig = entry;
  void request.then((config) => {
    if (progressionConfig !== entry) return;
    // Fresh from the response, like the server's max-age.
    if (config === false) progressionConfig = null;
    else entry.at = Date.now();
  });
  return request;
}

// GET /progression/me — everything the account page shows about progression:
// challenges, the season and its track, titles and recent XP. False when it is
// off, signed out or fails (the section is then left out).
export async function fetchProgressionMe(): Promise<ProgressionMe | false> {
  if (!ACCOUNT_FEATURES.progression) return false;
  try {
    const authorization = await getAuthHeader();
    if (authorization === "") return false;
    const res = await fetch(`${getApiBase()}/progression/me`, {
      headers: { Accept: "application/json", Authorization: authorization },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return false;
    const parsed = ProgressionMeSchema.safeParse(await res.json());
    if (!parsed.success) {
      console.warn("fetchProgressionMe: Zod validation failed", parsed.error);
      return false;
    }
    return parsed.data;
  } catch (err) {
    console.warn("fetchProgressionMe: request failed", err);
    return false;
  }
}

// PUT /users/@me/title — chooses the title shown beside the player's name
// (null clears it). True when the server accepted it.
export async function putDisplayTitle(title: string | null): Promise<boolean> {
  if (!ACCOUNT_FEATURES.progression) return false;
  try {
    const authorization = await getAuthHeader();
    if (authorization === "") return false;
    const res = await fetch(`${getApiBase()}/users/@me/title`, {
      method: "PUT",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        Authorization: authorization,
      },
      body: JSON.stringify({ title }),
      signal: AbortSignal.timeout(10_000),
    });
    return res.ok;
  } catch (err) {
    console.warn("putDisplayTitle: request failed", err);
    return false;
  }
}

// A page past the end of a board is a 400 with this message (the same wording
// the other leaderboards use).
const PAGE_BOUNDS = /^Page must be between \d+ and \d+$/;

async function fetchBoard(
  path: string,
  page: number,
  extra: Record<string, string> = {},
): Promise<XpLeaderboardResponse | "reached_limit" | false> {
  if (!ACCOUNT_FEATURES.progression) return false;
  try {
    const url = new URL(`${getApiBase()}${path}`);
    url.searchParams.set("page", String(page));
    for (const [k, v] of Object.entries(extra)) url.searchParams.set(k, v);
    const res = await fetch(url.toString(), {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      if (res.status === 400) {
        const body = (await res.json().catch(() => null)) as {
          message?: unknown;
        } | null;
        if (
          typeof body?.message === "string" &&
          PAGE_BOUNDS.test(body.message)
        ) {
          return "reached_limit";
        }
      }
      return false;
    }
    const parsed = XpLeaderboardResponseSchema.safeParse(await res.json());
    if (!parsed.success) {
      console.warn("fetchBoard: Zod validation failed", parsed.error);
      return false;
    }
    return parsed.data;
  } catch (err) {
    console.warn("fetchBoard: request failed", err);
    return false;
  }
}

// GET /leaderboard/xp — lifetime XP.
export function fetchXpLeaderboard(page: number) {
  return fetchBoard("/leaderboard/xp", page);
}

// GET /leaderboard/season — the running season, or `season` (a number) for an
// archived one.
export function fetchSeasonLeaderboard(page: number, season?: number) {
  return fetchBoard(
    "/leaderboard/season",
    page,
    season === undefined ? {} : { season: String(season) },
  );
}
