import { GameType } from "@openfront/engine-api/game/GameTypes";
import type { GameStartInfo, Winner } from "@openfront/engine-api/Schemas";
import type { PlayerStats } from "@openfront/engine-api/StatsSchemas";
import type { PartialGameRecord } from "@openfront/shared/WireSchemas";
import type { ReplayedSolo } from "../soloReplay";
import { ECONOMY, SOLO } from "./constants";
import type { SoloOutcome, SoloSetup } from "./solo";
import { winnerClientIds } from "./stats";
import { clientsWhoActed } from "./xp";

/**
 * Deciding whether a singleplayer match is believed, and what it was.
 *
 * A solo match is played entirely in a browser, so nothing in the record is
 * trusted: not the setup (tribes, nations, difficulty, the cheat switches), not
 * the winner, not the stats. What is trusted is the simulation. The API replays
 * the record's turns on its own engine (soloReplay.ts) and reads everything off
 * that replay:
 *
 *   - the setup is what the simulation ran with and contained;
 *   - the result is the one the simulation reached;
 *   - the record must reproduce the state hashes the browser recorded along the
 *     way, so turns or a setup that were changed after the fact do not replay.
 *
 * The record is also refused outright if it is not a solo match of one player,
 * is too long to replay, or carries a staff or host-only intent that only a game
 * server may send (a forced winner, resources, a kick): those are not a game
 * somebody played.
 */

/** Why a submission is not paid. A short code: it is stored and shown to the player as a generic line. */
export type SoloRejection =
  | "not_solo"
  | "malformed"
  | "too_long"
  | "forbidden_intent"
  | "desync"
  | "no_proof"
  | "not_spawned"
  | "no_action"
  | "no_result"
  | "verify_failed";

/** The intents a singleplayer match may contain: everything a player does, and pausing. */
const SOLO_INTENTS: ReadonlySet<string> = new Set([
  "attack",
  "cancel_attack",
  "spawn",
  "boat",
  "cancel_boat",
  "allianceRequest",
  "allianceReject",
  "allianceExtension",
  "breakAlliance",
  "targetPlayer",
  "emoji",
  "quick_chat",
  "donate_gold",
  "donate_troops",
  "build_unit",
  "upgrade_structure",
  "delete_unit",
  "embargo",
  "embargo_all",
  "move_warship",
  "toggle_pause",
]);

const SOLO_ID = /^[A-Za-z0-9]{8}$/;

/**
 * What is wrong with a submitted record before any replay is spent on it, or
 * null. Everything the replay will rely on that it cannot check itself is here.
 */
export function soloProblem(record: PartialGameRecord): SoloRejection | null {
  const { info } = record;
  if (info.config.gameType !== GameType.Singleplayer) return "not_solo";
  if (info.config.rankedType !== undefined) return "not_solo";
  if (info.players.length !== 1) return "not_solo";
  // A solo game's id is eight characters (a game server's are longer), so a
  // submission can never name a multiplayer game's id.
  if (!SOLO_ID.test(info.gameID)) return "malformed";
  if (!SOLO_ID.test(info.players[0].clientID)) return "malformed";
  if (info.num_turns > SOLO.maxTurns) return "too_long";
  if (record.turns.length > SOLO.maxTurns) return "too_long";
  const last = record.turns[record.turns.length - 1];
  if (last !== undefined && last.turnNumber >= SOLO.maxTurns) return "too_long";
  // Turns are in order and numbered from zero, the way the replay will read them.
  let previous = -1;
  for (const turn of record.turns) {
    if (turn.turnNumber <= previous) return "malformed";
    previous = turn.turnNumber;
    for (const intent of turn.intents) {
      if (!SOLO_INTENTS.has(intent.type)) return "forbidden_intent";
      if (intent.clientID !== info.players[0].clientID) {
        return "forbidden_intent";
      }
    }
  }
  return null;
}

/**
 * The start info the replay runs from: the record's own config and its player,
 * with nothing the browser could use to tilt it (no lobby creator, no friends,
 * no team slot, no purchased tribe names).
 */
export function soloGameStart(record: PartialGameRecord): GameStartInfo {
  const { info } = record;
  const player = info.players[0];
  return {
    gameID: info.gameID,
    lobbyCreatedAt: info.lobbyCreatedAt,
    config: info.config,
    players: [
      {
        clientID: player.clientID,
        username: player.username,
        clanTag: player.clanTag,
      },
    ],
  };
}

/** What a believed solo match was, as the replay found it. */
export interface SoloVerified {
  setup: SoloSetup;
  outcome: SoloOutcome;
  /** Game time under the stats minimum (two minutes). */
  short: boolean;
  /** Game ticks simulated, ten to a second. */
  ticks: number;
  /** The winner the simulation declared, if it did. */
  winner: Winner;
  /** The player's stats from the simulation (not the browser's). */
  stats: PlayerStats | undefined;
  clientID: string;
}

export type SoloVerdict =
  | { ok: true; verified: SoloVerified }
  | { ok: false; reason: SoloRejection };

/**
 * Whether a replayed solo match is believed, and what it was. `replay` is what
 * the engine found; `record` supplies only the turns (to see that the player
 * played) and the player's id.
 */
export function judgeSoloReplay(
  record: Pick<PartialGameRecord, "info" | "turns">,
  replay: ReplayedSolo,
): SoloVerdict {
  const clientID = record.info.players[0].clientID;
  const fail = (reason: SoloRejection): SoloVerdict => ({ ok: false, reason });
  // A replay that did not reproduce the recorded hashes is not the game that was
  // recorded; one with nothing to compare proves nothing.
  if (replay.hashes.mismatched > 0) return fail("desync");
  if (replay.hashes.checked === 0) return fail("no_proof");

  const human = replay.humans.find((h) => h.clientID === clientID);
  if (human === undefined || !human.spawned) return fail("not_spawned");
  // Played: at least one gameplay action in the part of the match that was
  // simulated (the replay stops at the result).
  const played = record.turns.filter((t) => t.turnNumber < replay.ticks);
  if (!clientsWhoActed(played).has(clientID)) return fail("no_action");

  const won = winnerClientIds(replay.winner).has(clientID);
  let outcome: SoloOutcome;
  if (won) outcome = "victory";
  else if (!human.alive) outcome = "eliminated";
  else if (replay.winner !== undefined) outcome = "defeat";
  // Still in it with no result: they left the match unfinished.
  else return fail("no_result");

  return {
    ok: true,
    verified: {
      setup: {
        tribes: replay.tribes,
        nations: replay.nations,
        instantBuild: replay.cheats.instantBuild,
        infiniteGold: replay.cheats.infiniteGold,
        infiniteTroops: replay.cheats.infiniteTroops,
        difficulty: replay.difficulty,
      },
      outcome,
      short: replay.ticks < ECONOMY.minEliminationTick,
      ticks: replay.ticks,
      winner: replay.winner,
      stats: replay.allPlayersStats[clientID],
      clientID,
    },
  };
}
