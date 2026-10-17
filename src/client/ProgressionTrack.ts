import type { LevelTrackEntry, Progress } from "@openfront/shared/ApiSchemas";
import { WIN_MILESTONES } from "@openfront/shared/ProgressionRules";
import { translateCosmetic } from "./Cosmetics";
import { levelFraction, MAX_LEVEL } from "./Progression";

// Pure helpers behind the Progression tab (components/ProgressionTab.ts): what
// state a level or a reward is in, where the track's marker sits, which win
// milestones are reached. No DOM and no fetches, so the rules are testable on
// their own. Every fact comes from GET /progression/track; nothing here decides
// what a level pays or whether a reward can be claimed (the server does).

/** A plain level: behind the player, the player's, or ahead. */
export type LevelState = "passed" | "current" | "locked";

export function levelState(level: number, currentLevel: number): LevelState {
  if (level === currentLevel) return "current";
  return level < currentLevel ? "passed" : "locked";
}

/**
 * A reward level's reward:
 *  - ready: reached, and the server has a reward to claim;
 *  - claimed: paid;
 *  - reached: reached, with nothing to claim (no reward row was ever written for
 *    this run, e.g. the XP was set by staff);
 *  - locked: not reached yet.
 */
export type RewardState = "ready" | "claimed" | "reached" | "locked";

export function rewardState(entry: LevelTrackEntry): RewardState {
  if (!entry.unlocked) return "locked";
  if (entry.claimed) return "claimed";
  return entry.rewardId !== null ? "ready" : "reached";
}

/** How far along the whole 1..100 track the player is, as a percentage. */
export function trackPercent(
  progress: Pick<Progress, "level" | "xpInLevel" | "xpForNext">,
): number {
  const level = Math.min(MAX_LEVEL, Math.max(1, Math.floor(progress.level)));
  if (level >= MAX_LEVEL) return 100;
  const done =
    level - 1 + levelFraction(progress.xpInLevel, progress.xpForNext);
  return Math.min(100, Math.max(0, (done / (MAX_LEVEL - 1)) * 100));
}

/** Where a level sits along the strip, 0..100. */
export function levelPercent(level: number): number {
  const clamped = Math.min(MAX_LEVEL, Math.max(1, level));
  return ((clamped - 1) / (MAX_LEVEL - 1)) * 100;
}

/** The scroll position that puts a node in the middle of the viewport (never negative). */
export function centerScrollLeft(
  nodeLeft: number,
  nodeWidth: number,
  viewWidth: number,
): number {
  return Math.max(0, nodeLeft - (viewWidth - nodeWidth) / 2);
}

export interface WinMilestone {
  target: number;
  achieved: boolean;
  /** Wins counted towards it, never past the target. */
  progress: number;
}

/** The lifetime-win milestones and where the player stands on each. */
export function winMilestones(wins: number): WinMilestone[] {
  const count = Number.isFinite(wins) ? Math.max(0, Math.floor(wins)) : 0;
  return WIN_MILESTONES.map((target) => ({
    target,
    achieved: count >= target,
    progress: Math.min(count, target),
  }));
}

/** The first milestone not reached yet, or null once all are. */
export function nextWinMilestone(wins: number): WinMilestone | null {
  return winMilestones(wins).find((m) => !m.achieved) ?? null;
}

/** A reward's cosmetic, named for the player ("flag:recruit_banner" → "Recruit Banner"). */
export function flareLabel(flare: string): string {
  const at = flare.indexOf(":");
  const kind = at === -1 ? "" : flare.slice(0, at);
  const name = at === -1 ? flare : flare.slice(at + 1);
  // A pattern's flare is `pattern:<name>:<palette>`; only the name is shown.
  const bare = name.split(":")[0];
  if (kind === "pattern") {
    return translateCosmetic("territory_patterns.pattern", bare);
  }
  if (kind === "crown") return translateCosmetic("crowns", bare);
  if (kind === "effect") return translateCosmetic("effects", bare);
  return translateCosmetic("flags", bare);
}
