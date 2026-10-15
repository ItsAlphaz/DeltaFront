import type { GameStartInfo, Turn } from "@openfront/engine-api/Schemas";
import type { ReplayedSolo } from "@openfront/engine/WinnerReplay";
import { fork, type ChildProcess } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SOLO } from "./domain/constants";

export type { ReplayedSolo };

/**
 * Runs a singleplayer replay in a subprocess (soloReplayChild.ts), the one place
 * the account API loads the simulation. A replay is a whole game's worth of
 * computation, so it runs at the lowest CPU priority, first in line for the OOM
 * killer, with its own heap limit and a time limit, and the API process never
 * runs a line of it. Nothing about it is shared with the game server: this is its
 * own copy of the same engine code, started from the same release.
 */

const CHILD = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "soloReplayChild.ts",
);

/** Caps the child's heap, so a runaway replay dies on its own. */
const MAX_HEAP_MB = 2048;

/**
 * The flags the child starts with: the API's own (so it runs under the same
 * TypeScript loader, as the service does under tsx), the heap limit, and, when
 * the API was started some other way (a test runner), the tsx loader itself, so
 * the child can always read its own source.
 */
function childExecArgv(): string[] {
  const loaded = process.execArgv.some((arg) => arg.includes("tsx"));
  return [
    ...process.execArgv,
    ...(loaded ? [] : ["--import", "tsx"]),
    `--max-old-space-size=${MAX_HEAP_MB}`,
  ];
}

export interface SoloReplayRequest {
  gameStart: GameStartInfo;
  turns: Turn[];
}

export type SoloReplayResponse =
  | { ok: true; result: ReplayedSolo }
  // `timedOut`: it ran out of time, which a second try would only repeat.
  | { ok: false; error: string; timedOut?: boolean };

/** Replays a game: its result, or why it could not be (crashed, threw, timed out). */
export type SoloReplayer = (
  gameStart: GameStartInfo,
  turns: Turn[],
) => Promise<SoloReplayResponse>;

// The replays running now, so a shutdown can end them instead of leaving them behind.
const active = new Set<ChildProcess>();

/** Ends every replay in progress (the service is stopping); each resolves as failed. */
export function killSoloReplays(): void {
  for (const child of active) child.kill("SIGKILL");
}

export const replaySoloInChild: SoloReplayer = (gameStart, turns) =>
  new Promise((resolve) => {
    let response: SoloReplayResponse | null = null;
    const child = fork(CHILD, [], {
      // Structured clone: the stats carry bigints, which JSON cannot.
      serialization: "advanced",
      execArgv: childExecArgv(),
    });
    active.add(child);
    if (child.pid !== undefined) {
      try {
        os.setPriority(child.pid, os.constants.priority.PRIORITY_LOW);
      } catch {
        // not allowed here: it simply runs at normal priority
      }
    }
    // Settles exactly once: "exit" may never follow "error" (a failed spawn or send).
    let settled = false;
    const finish = (result: SoloReplayResponse) => {
      if (settled) return;
      settled = true;
      active.delete(child);
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish({ ok: false, error: "replay timed out", timedOut: true });
    }, SOLO.replayTimeoutMs);
    child.on("message", (msg: SoloReplayResponse) => {
      response = msg;
    });
    child.on("error", (error) => {
      child.kill("SIGKILL");
      finish({ ok: false, error: `replay process error: ${error.message}` });
    });
    child.on("exit", (code, signal) => {
      finish(
        response ?? {
          ok: false,
          error: `replay ended without a result (code ${code}, signal ${signal})`,
        },
      );
    });
    child.send({ gameStart, turns } satisfies SoloReplayRequest, (error) => {
      if (error === null) return;
      child.kill("SIGKILL");
      finish({ ok: false, error: `could not send the game: ${error.message}` });
    });
  });
