import type { AdminCommand } from "../AdminCommands";

/**
 * Match events: the structured, public "what just happened" feed of a game
 * (an elimination, a new largest nation, an alliance formed or ended, a big
 * territory loss, a staff action).
 *
 * The engine derives them from authoritative simulation state, so every client
 * (and a replay that re-runs the record) sees the same events on the same tick.
 * Nobody can submit one: there is no intent for it. The staff `admin_command`
 * intent is the only thing a client sends that can cause one, and the game
 * server authorizes that before it relays it.
 *
 * An event carries ids and numbers, never display text. Names, clan tags and
 * badges are looked up when it is shown (anonymous names included), and the
 * wording belongs to the display layer.
 */

export const MATCH_EVENT_TYPES = [
  "game_started",
  "game_ending",
  "player_eliminated",
  "largest_nation_changed",
  "alliance_formed",
  "alliance_broken",
  "major_territory_loss",
  "admin_action",
] as const;
export type MatchEventType = (typeof MATCH_EVENT_TYPES)[number];

/** Least to most important. */
export const MATCH_EVENT_SEVERITIES = ["normal", "major", "critical"] as const;
export type MatchEventSeverity = (typeof MATCH_EVENT_SEVERITIES)[number];

/** The filters of the full event log (besides "all"). */
export const MATCH_EVENT_CATEGORIES = [
  "combat",
  "diplomacy",
  "territory",
  "system",
] as const;
export type MatchEventCategory = (typeof MATCH_EVENT_CATEGORIES)[number];

/** Share of its peak territory a player has lost; each fires once per player. */
export const TERRITORY_LOSS_MILESTONES = [25, 50, 75] as const;

export function matchEventCategory(type: MatchEventType): MatchEventCategory {
  switch (type) {
    case "player_eliminated":
      return "combat";
    case "alliance_formed":
    case "alliance_broken":
      return "diplomacy";
    case "largest_nation_changed":
    case "major_territory_loss":
      return "territory";
    case "game_started":
    case "game_ending":
    case "admin_action":
      return "system";
  }
}

/** Why an alliance ended: `broken` by `actor`, or it ran out. */
export type AllianceEndCause = "broken" | "expired";

export interface MatchEventMeta {
  /** player_eliminated: what the victim was. A tribe is `bot`; nations count as players. */
  targetKind?: "player" | "bot";
  /** alliance_broken. `expired` has no culprit: actor and target are just the two sides. */
  cause?: AllianceEndCause;
  /** major_territory_loss: the milestone crossed (25, 50 or 75), whole percent of the peak. */
  percent?: number;
  /** largest_nation_changed: the new leader's share of the map's land, whole percent. */
  share?: number;
  /** largest_nation_changed in team games (actor is null) and game_ending when a team won. */
  team?: string;
  /** admin_action: which staff command ran. */
  command?: AdminCommand;
}

export interface MatchEvent {
  /** Counts up from 0 within a game, so a replayed or re-delivered event can be recognised. */
  seq: number;
  tick: number;
  type: MatchEventType;
  severity: MatchEventSeverity;
  /** smallID of the player who did it, or null when there is no (reliable) one. */
  actor: number | null;
  /** smallID of the player it happened to, or null. */
  target: number | null;
  meta: MatchEventMeta;
}
