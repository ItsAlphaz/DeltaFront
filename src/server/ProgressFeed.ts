import {
  ACCOUNT_FEATURES,
  usesAccountApi,
} from "@openfront/shared/AccountFeatures";
import {
  GAMEPLAY_INTENTS,
  type LiveProgress,
  type LiveProgressPlayer,
} from "@openfront/shared/LiveProgress";
import type {
  AdminActionRecord,
  LiveStats,
} from "@openfront/shared/WireSchemas";
import { logger } from "./Logger";
import { ServerEnv } from "./ServerEnv";

const log = logger.child({ component: "ProgressFeed" });

/** Whether this server reports running games' progress to the account API. */
export function progressFeedEnabled(): boolean {
  return ACCOUNT_FEATURES.progression && usesAccountApi();
}

/**
 * What the game server alone knows about a running game's progression, kept as
 * the game goes: when each player was last agreed to be alive and first agreed
 * to be dead (an elimination falls between the two snapshots), who took a
 * gameplay action, and who ran staff commands. Everything comes from the
 * server's own state, never from a client's say-so: the snapshots are the
 * majority-voted live stats and the intents are the ones the server stamped.
 */
export class ProgressTracker {
  private readonly seen = new Map<
    string,
    { aliveAtTurn: number | null; deadAtTurn: number | null }
  >();
  private readonly acted = new Set<string>();
  private readonly adminSenders = new Set<string>();
  private observedTurn = -1;

  /** A stamped intent the server is relaying. */
  noteIntent(intent: { type: string; clientID?: string }): void {
    if (intent.clientID === undefined) return;
    if (GAMEPLAY_INTENTS.has(intent.type)) this.acted.add(intent.clientID);
    if (intent.type === "admin_command") {
      this.adminSenders.add(intent.clientID);
    }
  }

  /** The agreed snapshot; one per turn is read, later ones only move it forward. */
  observe(live: LiveStats): void {
    if (live.turn <= this.observedTurn) return;
    this.observedTurn = live.turn;
    for (const p of live.players) {
      const entry = this.seen.get(p.clientID) ?? {
        aliveAtTurn: null,
        deadAtTurn: null,
      };
      if (p.isAlive) entry.aliveAtTurn = live.turn;
      else entry.deadAtTurn ??= live.turn;
      this.seen.set(p.clientID, entry);
    }
  }

  /** The snapshot turn the last observation was read at, or -1. */
  get turn(): number {
    return this.observedTurn;
  }

  window(clientID: string): {
    aliveAtTurn: number | null;
    deadAtTurn: number | null;
  } {
    return this.seen.get(clientID) ?? { aliveAtTurn: null, deadAtTurn: null };
  }

  hasActed(clientID: string): boolean {
    return this.acted.has(clientID);
  }

  senders(): string[] {
    return [...this.adminSenders];
  }
}

export interface ProgressInput {
  gameID: string;
  turn: number;
  elapsedSeconds: number;
  config: LiveProgress["config"];
  adminActions: AdminActionRecord[];
  result: LiveProgress["result"];
  live: LiveStats | null;
  roster: ReadonlyArray<{
    clientID: string;
    persistentID: string | null;
    connected: boolean;
    leftTurn: number | null;
  }>;
}

/** The report for the account API, from the server's own facts. */
export function buildProgress(
  tracker: ProgressTracker,
  input: ProgressInput,
): LiveProgress {
  if (input.live !== null) tracker.observe(input.live);
  const stats = new Map(input.live?.players.map((p) => [p.clientID, p]) ?? []);
  const players: LiveProgressPlayer[] = input.roster.map((r) => {
    const stat = stats.get(r.clientID);
    const window = tracker.window(r.clientID);
    return {
      clientID: r.clientID,
      persistentID: r.persistentID,
      // Before the first agreed snapshot everyone is alive.
      alive: stat?.isAlive ?? true,
      killedBy: stat?.killedBy ?? null,
      aliveAtTurn: window.aliveAtTurn,
      deadAtTurn: window.deadAtTurn,
      connected: r.connected,
      leftTurn: r.leftTurn,
      acted: tracker.hasActed(r.clientID),
    };
  });
  return {
    gameID: input.gameID,
    turn: input.turn,
    elapsedSeconds: input.elapsedSeconds,
    config: input.config,
    adminActions: input.adminActions,
    adminSenders: tracker.senders(),
    result: input.result,
    players,
  };
}

/**
 * Sends a report to the account API (best effort: a missed one is replaced by
 * the next, and nothing waits on it). The API keeps it only in memory and never
 * turns it into XP.
 */
export async function postProgress(progress: LiveProgress): Promise<void> {
  if (!progressFeedEnabled()) return;
  try {
    const response = await fetch(
      `${ServerEnv.jwtIssuer()}/game/${progress.gameID}/progress`,
      {
        method: "POST",
        body: JSON.stringify(progress),
        headers: {
          "Content-Type": "application/json",
          "x-api-key": ServerEnv.apiKey(),
        },
        signal: AbortSignal.timeout(5_000),
      },
    );
    if (!response.ok) {
      log.debug(`progress not accepted: ${response.status}`, {
        gameID: progress.gameID,
      });
    }
  } catch (error) {
    log.debug(`progress not sent: ${error}`, { gameID: progress.gameID });
  }
}
