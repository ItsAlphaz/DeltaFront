import type { Turn } from "@openfront/engine-api/Schemas";
import { decompressGameRecord } from "@openfront/shared/SharedUtil";
import {
  PartialGameRecordSchema,
  type GameRecord,
  type PartialGameRecord,
} from "@openfront/shared/WireSchemas";
import { gunzipSync } from "node:zlib";
import type { Pool } from "pg";
import { SOLO } from "../domain/constants";
import { ingestSoloGame } from "../domain/soloIngest";
import {
  judgeSoloReplay,
  soloGameStart,
  soloProblem,
  type SoloRejection,
} from "../domain/soloVerify";
import type { Logger } from "../logger";
import {
  killSoloReplays,
  replaySoloInChild,
  type SoloReplayer,
} from "../soloReplay";

/**
 * Singleplayer matches, from upload to XP.
 *
 * A browser uploads its record (routes/solo.ts), which `submit` keeps in
 * `solo_submissions`; the worker takes them oldest first, replays each on the
 * server's engine in a subprocess (soloReplay.ts), and either pays it
 * (domain/soloIngest.ts) or refuses it with a short reason. A queued submission
 * survives a restart, one that was being replayed when the process died is taken
 * again, and a submission is paid at most once whatever happens (the game's code
 * is unique in the games table and the XP ledger).
 */

/** A stuck "running" row is taken again after this long (the replay's own limit, and a margin). */
const STALE_RUNNING_SECONDS = SOLO.replayTimeoutMs / 1000 + 5 * 60;
/** How often decided rows are pruned. */
const PRUNE_EVERY_MS = 60 * 60 * 1000;

export type SubmitOutcome =
  | { status: "queued" }
  /** The game was already submitted (or stored): nothing was added. */
  | { status: "duplicate" }
  /** This account has submitted as many as it may in a day. */
  | { status: "limit" }
  /** The queue is full: try again later. */
  | { status: "busy" };

export interface SoloWorkerOptions {
  log: Pick<Logger, "info" | "warn" | "error">;
  /** Present while the `progression` feature is on: what a paid match awards. */
  progression: { validFlares: ReadonlySet<string> | null };
  /** Runs a replay; the subprocess one by default. */
  replayer?: SoloReplayer;
  now?: () => Date;
  /** How often the loop looks for work when nothing woke it. */
  pollMs?: number;
}

export interface SoloWorker {
  submit(input: {
    userId: string;
    gameCode: string;
    gz: Buffer;
  }): Promise<SubmitOutcome>;
  /** Starts taking submissions. */
  start(): void;
  /** Stops taking new ones and waits for the one in hand. */
  stop(): Promise<void>;
  /** Takes and decides one waiting submission; false when there was none. */
  runOnce(): Promise<boolean>;
  /** Decides everything waiting (tests, and a deploy that wants the queue empty). */
  drain(): Promise<void>;
}

interface Claimed {
  game_code: string;
  user_id: string;
  record_gz: Buffer | null;
  attempts: number;
}

/** Unpacks and validates a stored submission. Throws nothing: null is "not a record". */
export function readSubmission(gz: Buffer): PartialGameRecord | null {
  try {
    const json = gunzipSync(gz, { maxOutputLength: SOLO.maxRecordBytes });
    const parsed = PartialGameRecordSchema.safeParse(
      JSON.parse(json.toString("utf8")),
    );
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function createSoloWorker(
  pool: Pool,
  options: SoloWorkerOptions,
): SoloWorker {
  const { log } = options;
  const replayer = options.replayer ?? replaySoloInChild;
  const now = options.now ?? (() => new Date());
  const pollMs = options.pollMs ?? SOLO.pollMs;
  let running = false;
  let stopping = false;
  let timer: NodeJS.Timeout | null = null;
  let current: Promise<unknown> | null = null;
  let wake: (() => void) | null = null;
  let lastPruned = 0;

  async function submit(input: {
    userId: string;
    gameCode: string;
    gz: Buffer;
  }): Promise<SubmitOutcome> {
    // Already paid (the submission row may have been pruned since).
    const stored = await pool.query(
      "SELECT 1 FROM games WHERE game_code = $1",
      [input.gameCode],
    );
    if (stored.rows.length > 0) return { status: "duplicate" };
    const counts = await pool.query<{ mine: string; queued: string }>(
      `SELECT count(*) FILTER (WHERE user_id = $1 AND created_at > now() - interval '24 hours')::text AS mine,
              count(*) FILTER (WHERE status IN ('pending', 'running'))::text AS queued
         FROM solo_submissions`,
      [input.userId],
    );
    if (Number(counts.rows[0].mine) >= SOLO.maxPerDay) {
      return { status: "limit" };
    }
    if (Number(counts.rows[0].queued) >= SOLO.maxQueued) {
      return { status: "busy" };
    }
    const inserted = await pool.query(
      `INSERT INTO solo_submissions (game_code, user_id, record_gz, status)
       VALUES ($1, $2, $3, 'pending') ON CONFLICT (game_code) DO NOTHING`,
      [input.gameCode, input.userId, input.gz],
    );
    if ((inserted.rowCount ?? 0) === 0) return { status: "duplicate" };
    wake?.();
    return { status: "queued" };
  }

  async function claim(): Promise<Claimed | null> {
    const { rows } = await pool.query<Claimed>(
      `UPDATE solo_submissions
          SET status = 'running', started_at = now()
        WHERE game_code = (
          SELECT game_code FROM solo_submissions
           WHERE status = 'pending'
              OR (status = 'running' AND started_at < now() - make_interval(secs => $1))
           ORDER BY created_at
           LIMIT 1
             FOR UPDATE SKIP LOCKED)
        RETURNING game_code, user_id::text AS user_id, record_gz, attempts`,
      [STALE_RUNNING_SECONDS],
    );
    return rows[0] ?? null;
  }

  const decide = (
    gameCode: string,
    status: "paid" | "rejected",
    reason: string | null,
  ) =>
    pool.query(
      `UPDATE solo_submissions
          SET status = $2, reason = $3, record_gz = NULL, finished_at = now()
        WHERE game_code = $1`,
      [gameCode, status, reason],
    );

  const reject = async (job: Claimed, reason: SoloRejection | "no_account") => {
    log.info("solo match refused", { gameCode: job.game_code, reason });
    await decide(job.game_code, "rejected", reason);
  };

  async function process(job: Claimed): Promise<void> {
    const record =
      job.record_gz === null ? null : readSubmission(job.record_gz);
    if (record === null) return reject(job, "malformed");
    const problem = soloProblem(record);
    if (problem !== null) return reject(job, problem);
    if (record.info.gameID !== job.game_code) return reject(job, "malformed");

    const turns: Turn[] = decompressGameRecord(
      record as unknown as GameRecord,
    ).turns;
    const replay = await replayer(soloGameStart(record), turns);
    if (!replay.ok && stopping) {
      // The service is stopping and ended the replay: not the match's doing, so
      // it goes back in the line untouched.
      await pool.query(
        `UPDATE solo_submissions SET status = 'pending', started_at = NULL WHERE game_code = $1`,
        [job.game_code],
      );
      return;
    }
    if (!replay.ok) {
      // The replay itself failed (a crash, a timeout, the engine threw): try
      // again a couple of times, then say so. This is not a verdict on the match.
      const attempts = job.attempts + 1;
      log.warn("solo replay failed", {
        gameCode: job.game_code,
        attempts,
        error: replay.error.slice(0, 300),
      });
      // A replay that ran out of time would only run out again.
      if (replay.timedOut === true || attempts >= SOLO.maxAttempts) {
        return reject(job, "verify_failed");
      }
      await pool.query(
        // to the back of the line, so a failing one does not hold the others up
        `UPDATE solo_submissions
            SET status = 'pending', attempts = $2, started_at = NULL, created_at = now()
          WHERE game_code = $1`,
        [job.game_code, attempts],
      );
      return;
    }
    const verdict = judgeSoloReplay(record, replay.result);
    if (!verdict.ok) return reject(job, verdict.reason);

    const outcome = await ingestSoloGame(pool, {
      userId: job.user_id,
      record,
      verified: verdict.verified,
      receivedAt: now(),
      progression: options.progression,
    });
    if (outcome.status === "not_registered") return reject(job, "no_account");
    log.info("solo match paid", {
      gameCode: job.game_code,
      outcome: verdict.verified.outcome,
      xp: outcome.status === "stored" ? outcome.xpAwarded : 0,
      duplicate: outcome.status === "duplicate",
    });
    await decide(job.game_code, "paid", null);
  }

  async function runOnce(): Promise<boolean> {
    const job = await claim();
    if (job === null) return false;
    try {
      await process(job);
    } catch (error) {
      // Not the match's fault (the database, a bug): leave it to be taken again.
      log.error("solo match failed", {
        gameCode: job.game_code,
        error: error instanceof Error ? error.message : String(error),
      });
      await pool
        .query(
          `UPDATE solo_submissions SET status = 'pending', started_at = NULL WHERE game_code = $1 AND status = 'running'`,
          [job.game_code],
        )
        .catch(() => undefined);
      throw error;
    }
    return true;
  }

  async function prune(): Promise<void> {
    await pool.query(
      `DELETE FROM solo_submissions
        WHERE status IN ('paid', 'rejected')
          AND finished_at < now() - make_interval(days => $1)`,
      [SOLO.retentionDays],
    );
  }

  async function loop(): Promise<void> {
    while (running) {
      let worked = false;
      try {
        if (Date.now() - lastPruned > PRUNE_EVERY_MS) {
          lastPruned = Date.now();
          await prune();
        }
        current = runOnce();
        worked = (await current) as boolean;
      } catch {
        // already logged; wait before looking again so a persistent fault does not spin
      } finally {
        current = null;
      }
      if (!running) return;
      if (worked) continue;
      await new Promise<void>((resolve) => {
        wake = resolve;
        timer = setTimeout(resolve, pollMs);
        timer.unref();
      });
      wake = null;
    }
  }

  return {
    submit,
    runOnce,
    start() {
      if (running) return;
      running = true;
      void loop();
    },
    async stop() {
      running = false;
      stopping = true;
      if (timer !== null) clearTimeout(timer);
      wake?.();
      // A replay in progress is ended (it is taken again, untouched, by the next
      // instance) rather than waited for: it can run for many minutes.
      killSoloReplays();
      await Promise.resolve(current).catch(() => undefined);
    },
    async drain() {
      while (await runOnce());
    },
  };
}
