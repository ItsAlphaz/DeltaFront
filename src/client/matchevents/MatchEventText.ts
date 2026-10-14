import { PlayerType } from "@openfront/engine-api/game/GameTypes";
import {
  matchEventCategory,
  type MatchEvent,
  type MatchEventCategory,
  type MatchEventSeverity,
} from "@openfront/engine-api/game/MatchEvents";
import type { StaffRoleWire } from "@openfront/shared/WireSchemas";
import type { MatchLogEntry } from "./MatchEventLog";

/**
 * Turns a structured match event into something to show: which sentence
 * (a translation key and its plain parameters) and who the players in it are.
 *
 * The engine's events carry player ids and numbers. Names, clan tags and badges
 * are looked up here, at display time, from the view the rest of the HUD uses
 * (PlayerView), so the feed follows the Anonymous Names setting like every other
 * surface: under it a player has its generated name, no clan tag and no badges,
 * and nothing is left over from the real name.
 */

/** What the feed needs to know about a player; PlayerView and the replay's view provide it. */
export interface MatchPlayerView {
  isPlayer(): boolean;
  /**
   * The plain name, without the clan tag: the engine's displayName() already has
   * the tag in it, and the chip draws the tag as its own element.
   */
  name(): string;
  clanTag(): string | null;
  type(): PlayerType;
  /** The staff badge to draw; already null under anonymous names. */
  staffBadgeRole(): StaffRoleWire | null;
  /** The verified check; already false under anonymous names. */
  showsVerifiedBadge(): boolean;
  territoryColor?(): { toHex(): string } | undefined;
}

export interface MatchPlayerLookup {
  playerBySmallID(
    id: number,
  ): MatchPlayerView | { isPlayer(): boolean } | undefined;
}

/** A player as one line shows them. */
export interface PlayerSlot {
  id: number;
  name: string;
  clan: string | null;
  staff: StaffRoleWire | null;
  verified: boolean;
  type: PlayerType;
  color: string | null;
}

export function resolvePlayer(
  lookup: MatchPlayerLookup,
  id: number | null,
): PlayerSlot | null {
  if (id === null) return null;
  const p = lookup.playerBySmallID(id);
  if (p === undefined || !p.isPlayer() || !("displayName" in p)) return null;
  const view = p as MatchPlayerView;
  const color = view.territoryColor?.();
  return {
    id,
    name: view.name(),
    clan: view.clanTag(),
    staff: view.staffBadgeRole(),
    verified: view.showsVerifiedBadge(),
    type: view.type(),
    color: color === undefined ? null : color.toHex(),
  };
}

/** "[DELTA] Alphaz": the plain-text form of a player, for labels and logs. */
export function slotText(slot: PlayerSlot): string {
  return slot.clan === null ? slot.name : `[${slot.clan}] ${slot.name}`;
}

export type MatchEventIcon =
  | "eliminated"
  | "crown"
  | "alliance"
  | "alliance_broken"
  | "territory"
  | "flag"
  | "admin";

export interface DescribedEvent {
  /** Translation key of the sentence. */
  key: string;
  /** Parameters of the sentence that are not players ({percent}, {count}, {team}). */
  params: Record<string, string | number>;
  /** The players in the sentence, by the placeholder they fill ({actor}, {target}). */
  slots: { actor?: PlayerSlot; target?: PlayerSlot };
  /** Collapsed runs say how many ("×4") when the sentence does not. */
  repeat: number;
  severity: MatchEventSeverity;
  category: MatchEventCategory;
  icon: MatchEventIcon;
  /** The staff role of whoever used admin tools, when it may be shown. */
  role: StaffRoleWire | null;
}

function teamName(team: string, translate: (key: string) => string): string {
  const key = `team_colors.${team.toLowerCase()}`;
  const text = translate(key);
  return text === key ? team : text;
}

/**
 * The sentence for an entry. `translate` is only used for the team name; the
 * sentence itself is translated when it is drawn (MatchEventLine).
 */
export function describeEvent(
  entry: MatchLogEntry,
  lookup: MatchPlayerLookup,
  translate: (key: string) => string = (k) => k,
): DescribedEvent {
  const e: MatchEvent = entry.event;
  const actor = resolvePlayer(lookup, e.actor) ?? undefined;
  const target = resolvePlayer(lookup, e.target) ?? undefined;
  const base = {
    slots: { actor, target },
    repeat: entry.count,
    severity: e.severity,
    category: matchEventCategory(e.type),
    role: null as StaffRoleWire | null,
  };

  switch (e.type) {
    case "game_started":
      return {
        ...base,
        key: "match_events.game_started",
        params: {},
        icon: "flag",
      };
    case "game_ending":
      if (actor !== undefined) {
        return {
          ...base,
          key: "match_events.game_ending_player",
          params: {},
          icon: "flag",
        };
      }
      return e.meta.team !== undefined
        ? {
            ...base,
            key: "match_events.game_ending_team",
            params: { team: teamName(e.meta.team, translate) },
            icon: "flag",
          }
        : {
            ...base,
            key: "match_events.game_ending_none",
            params: {},
            icon: "flag",
          };
    case "player_eliminated":
      if (entry.count > 1) {
        return {
          ...base,
          key:
            actor === undefined
              ? "match_events.tribes_eliminated"
              : "match_events.tribes_eliminated_by",
          params: { count: entry.count },
          slots: { actor },
          repeat: 1,
          icon: "eliminated",
        };
      }
      return {
        ...base,
        key:
          actor === undefined
            ? "match_events.eliminated"
            : "match_events.eliminated_by",
        params: {},
        icon: "eliminated",
      };
    case "largest_nation_changed":
      return actor !== undefined
        ? {
            ...base,
            key: "match_events.largest_nation",
            params: {},
            icon: "crown",
          }
        : {
            ...base,
            key: "match_events.largest_nation_team",
            params: { team: teamName(e.meta.team ?? "", translate) },
            icon: "crown",
          };
    case "alliance_formed":
      return {
        ...base,
        key: "match_events.alliance_formed",
        params: {},
        icon: "alliance",
      };
    case "alliance_broken":
      return {
        ...base,
        key:
          e.meta.cause === "expired"
            ? "match_events.alliance_ended"
            : "match_events.alliance_broken_by",
        params: {},
        icon: "alliance_broken",
      };
    case "major_territory_loss":
      return {
        ...base,
        key: "match_events.territory_loss",
        params: { percent: e.meta.percent ?? 0 },
        slots: { target },
        icon: "territory",
      };
    case "admin_action": {
      const command = e.meta.command;
      if (command === "eliminate") {
        return {
          ...base,
          key: "match_events.admin_eliminated",
          params: {},
          icon: "admin",
        };
      }
      if (command === "force_win") {
        const self = actor !== undefined && actor.id === target?.id;
        return {
          ...base,
          key: self
            ? "match_events.admin_forced_win"
            : "match_events.admin_forced_win_for",
          params: {},
          icon: "admin",
        };
      }
      // The role is the staff badge's: hidden together with it (anonymous names).
      const role = actor?.staff ?? null;
      return {
        ...base,
        key:
          role === null
            ? "match_events.admin_used"
            : "match_events.admin_used_as",
        params: {},
        role,
        icon: "admin",
      };
    }
  }
}

/**
 * Whether a person is involved in the event, as opposed to tribes and nations
 * only. Events with nobody named (the match starting) count as theirs.
 */
export function involvesHuman(
  event: MatchEvent,
  lookup: MatchPlayerLookup,
): boolean {
  const ids = [event.actor, event.target].filter(
    (id): id is number => id !== null,
  );
  if (ids.length === 0) return true;
  return ids.some((id) => resolvePlayer(lookup, id)?.type === PlayerType.Human);
}
