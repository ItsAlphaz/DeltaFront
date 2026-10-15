import { ID, WinnerSchema } from "@openfront/engine-api/Schemas";
import { z } from "zod";
import { AdminActionRecordSchema } from "./WireSchemas";

/**
 * What a game server tells the account API about a running game so a player can
 * see their XP while they play: the facts only the server has (who is alive and
 * who eliminated whom, from the majority-voted live stats; who is connected and
 * who left, from its roster; who acted and who ran staff commands, from the
 * intents it stamps; and, once the game is settled, the result). The API turns
 * them into provisional XP with the very functions that decide the final award
 * and never writes a ledger row from them: only the archived game does.
 *
 * Nothing in it comes from a client message. A client's own live-stats vote only
 * counts if a majority of the game's IPs agree with it.
 */

/** What the player did that counts as playing: not spawning, chatting, emoji or host controls. */
export const GAMEPLAY_INTENTS: ReadonlySet<string> = new Set([
  "attack",
  "cancel_attack",
  "boat",
  "cancel_boat",
  "allianceRequest",
  "allianceReject",
  "allianceExtension",
  "breakAlliance",
  "targetPlayer",
  "donate_gold",
  "donate_troops",
  "build_unit",
  "upgrade_structure",
  "delete_unit",
  "embargo",
  "embargo_all",
  "move_warship",
]);

const Turn = z.number().int().nonnegative();

export const LiveProgressPlayerSchema = z.object({
  clientID: ID,
  // The account behind the connection (the user's UUID), null for none.
  persistentID: z.string().max(64).nullable(),
  alive: z.boolean(),
  // The human who eliminated them, when one did.
  killedBy: ID.nullable(),
  // The latest agreed snapshot turn they were alive at, and the first they were
  // seen dead at: their elimination fell between the two.
  aliveAtTurn: Turn.nullable(),
  deadAtTurn: Turn.nullable(),
  // Connected right now, and, when gone, the turn their connection was lost at
  // (PlayerRecord.leftTurn).
  connected: z.boolean(),
  leftTurn: Turn.nullable(),
  // Took at least one gameplay action.
  acted: z.boolean(),
});
export type LiveProgressPlayer = z.infer<typeof LiveProgressPlayerSchema>;

export const LiveProgressSchema = z.object({
  gameID: ID,
  // The agreed snapshot's turn, and how long the game has run, by the server's clock.
  turn: Turn,
  elapsedSeconds: z.number().nonnegative(),
  config: z.object({
    gameType: z.string().max(32),
    gameMode: z.string().max(32),
    rankedType: z.string().max(32).nullable(),
    listed: z.boolean().nullable(),
  }),
  // Staff commands relayed so far (see AdminActionRecordSchema), and who ran them.
  adminActions: AdminActionRecordSchema.array().max(64),
  adminSenders: ID.array().max(64),
  // Set once the server has settled the winner: the winner and the turn the
  // result was determined at (GameEndInfo.resultTurn).
  result: z.object({ winner: WinnerSchema, resultTurn: Turn }).nullable(),
  players: LiveProgressPlayerSchema.array().max(2048),
});
export type LiveProgress = z.infer<typeof LiveProgressSchema>;
