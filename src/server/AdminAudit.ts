/**
 * Reports what a staff member did inside a game to the account API's audit log
 * (POST /game_admin/audit, authenticated with the game server's API key), so
 * the in-game admin tools land in the same log as the CLI and the web panel.
 *
 * Best effort by design: a failure never blocks or undoes the action. It is
 * logged locally with the same fields, so nothing is lost if the API is down.
 * The report carries only identifiers, a command name and numbers: never a
 * token, the API key, or an address.
 */

import { ServerEnv } from "./ServerEnv";

export type GameAdminAction =
  | "game:kick"
  | "game:pause"
  | "game:command"
  | "game:force-end";

export interface AdminActionReport {
  gameID: string;
  actorPublicId: string;
  action: GameAdminAction;
  targetClientID?: string;
  targetPublicId?: string;
  details?: Record<string, string | number | boolean | null>;
}

export interface AdminAuditDeps {
  /** The account API's origin (the JWT issuer); the game server's own setting when absent. */
  apiBase?: string;
  /** The game server's API key; the game server's own setting when absent. */
  apiKey?: string;
  fetchFn?: typeof fetch;
  log: {
    info(message: string, meta?: object): unknown;
    warn(message: string, meta?: object): unknown;
  };
  timeoutMs?: number;
}

export async function reportAdminAction(
  report: AdminActionReport,
  deps: AdminAuditDeps,
): Promise<boolean> {
  // Always in the game server's own log, whatever the API does.
  deps.log.info("staff action", {
    action: report.action,
    gameID: report.gameID,
    actor: report.actorPublicId,
    target: report.targetPublicId ?? report.targetClientID,
    ...report.details,
  });
  try {
    // Resolved here, inside the guard: a missing setting must degrade to a
    // logged warning, never to a failed staff action.
    const apiBase = deps.apiBase ?? ServerEnv.jwtIssuer();
    const apiKey = deps.apiKey ?? ServerEnv.apiKey();
    const res = await (deps.fetchFn ?? fetch)(`${apiBase}/game_admin/audit`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
      },
      body: JSON.stringify(report),
      signal: AbortSignal.timeout(deps.timeoutMs ?? 5000),
    });
    if (!res.ok) {
      deps.log.warn("staff action audit was refused", {
        status: res.status,
        action: report.action,
        gameID: report.gameID,
      });
      return false;
    }
    return true;
  } catch (error) {
    deps.log.warn("staff action audit failed", {
      action: report.action,
      gameID: report.gameID,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}
