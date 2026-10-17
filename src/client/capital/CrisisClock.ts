/**
 * The arithmetic behind the CRISIS indicator, kept apart from the component so
 * it can be tested without a browser. Everything is derived from the engine's
 * own ticks (10 a second): the client never keeps a countdown of its own, so
 * the time shown is the match's time. It holds while the game is paused, runs
 * on while a menu is open, and is right again after a reconnect.
 */

export const TICKS_PER_SECOND = 10;

/**
 * The big announcement is for a crisis that has just begun. A client that
 * rejoins replays the match from the start, passing every old crisis on the
 * way, and must not play them all back: it shows the indicator for one still
 * running and nothing for the rest. This many ticks (3 s) after the capture
 * counts as just begun.
 */
export const ANNOUNCE_WINDOW_TICKS = 30;

/** The indicator pulses once when this many seconds are left... */
export const WARN_AT_SECONDS = 60;
/** ...and turns urgent (no screen-wide flashing) at this many. */
export const URGENT_AT_SECONDS = 10;

/** How long the "crisis over" state stays on screen. */
export const OVER_VISIBLE_MS = 8_000;

/** Whole seconds left, rounded up so "00:00" only ever means over. */
export function secondsLeft(endTick: number, nowTick: number): number {
  if (endTick < 0) return 0;
  return Math.max(0, Math.ceil((endTick - nowTick) / TICKS_PER_SECOND));
}

/** `3:00` as "03:00": minutes and seconds, minutes at least two digits. */
export function formatCountdown(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const m = Math.floor(s / 60);
  const rest = s % 60;
  return `${String(m).padStart(2, "0")}:${String(rest).padStart(2, "0")}`;
}

/** The share of the crisis still to run, 1 at the start and 0 when over. */
export function remainingFraction(
  startTick: number,
  endTick: number,
  nowTick: number,
): number {
  const total = endTick - startTick;
  if (startTick < 0 || total <= 0) return 0;
  return Math.min(1, Math.max(0, (endTick - nowTick) / total));
}

export type CrisisLevel = "running" | "warning" | "urgent" | "over";

/** How the indicator should look for this many seconds left. */
export function crisisLevel(seconds: number, over: boolean): CrisisLevel {
  if (over) return "over";
  if (seconds <= URGENT_AT_SECONDS) return "urgent";
  if (seconds <= WARN_AT_SECONDS) return "warning";
  return "running";
}

/**
 * Whether to play the announcement for a crisis the client has just noticed:
 * only a live, recent one. Never while the game is catching up to the server
 * (joining late, reconnecting), whatever the age of the crisis.
 */
export function shouldAnnounce(opts: {
  catchingUp: boolean;
  startTick: number;
  nowTick: number;
}): boolean {
  if (opts.catchingUp) return false;
  const age = opts.nowTick - opts.startTick;
  return age >= 0 && age <= ANNOUNCE_WINDOW_TICKS;
}

/**
 * A warning threshold crossed between two readings, or null. Only a downward
 * crossing seen in order counts: the first reading never fires (a client that
 * rejoins with 30 s left must not be told that 60 s just passed), and neither
 * does one that jumps a long way at once while catching up.
 */
export function crossedThreshold(
  previous: number | null,
  current: number,
): "warn" | "urgent" | null {
  if (previous === null) return null;
  if (previous > URGENT_AT_SECONDS && current <= URGENT_AT_SECONDS) {
    return "urgent";
  }
  if (previous > WARN_AT_SECONDS && current <= WARN_AT_SECONDS) {
    return "warn";
  }
  return null;
}
