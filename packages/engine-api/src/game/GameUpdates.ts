import { AllPlayersStats, ClientID, Winner } from "../Schemas";
import { TileRef } from "./GameMap";
import {
  EmojiMessage,
  GameUpdates,
  Gold,
  MessageType,
  NameViewData,
  NukeState,
  PlayerID,
  PlayerType,
  SamLauncherState,
  Team,
  Tick,
  TrainType,
  TransportShipState,
  UnitType,
  WarshipState,
} from "./GameTypes";
import type { MatchEvent } from "./MatchEvents";

export interface GameUpdateViewData {
  tick: number;
  updates: GameUpdates;
  /**
   * Packed tile updates as `[tileRef, state]` uint32 pairs.
   *
   * `tileRef` is a `TileRef` (fits in uint32), and `state` is the packed per-tile
   * state (`uint16`) stored in a `uint32` lane.
   */
  packedTileUpdates: Uint32Array;
  /**
   * Optional packed motion plan records.
   *
   * When present, this buffer is expected to be transferred worker -> main
   * (similar to `packedTileUpdates`) to avoid structured-clone copies.
   */
  packedMotionPlans?: Uint32Array;
  /**
   * Packed per-player numeric stats as
   * `[smallID, tilesOwned, gold, troops, goldEarned]`
   * float64 quints — the fields that change for nearly every alive player
   * every tick. They travel here (transferred, not structured-cloned) instead
   * of in `PlayerUpdate` object diffs, which only carry them on a player's
   * first emission. Gold is exact in a float64 (game values stay far below
   * 2^53). Absent when no player's stats changed.
   */
  packedPlayerUpdates?: Float64Array;
  /**
   * Packed attack troop-count changes as
   * `[ownerSmallID, direction, index, troops]` float64 quads, where
   * `direction` is 0 for the owner's outgoingAttacks and 1 for
   * incomingAttacks, and `index` addresses that array. Troop counts change
   * every tick for every active attack, so they travel here instead of
   * re-sending whole attack arrays in PlayerUpdate diffs; the arrays
   * themselves are only resent when membership/order/retreating changes —
   * which also guarantees the receiver's indexes line up (see
   * packAttackTroopDeltas). Absent when no attack troop count changed.
   */
  packedAttackUpdates?: Float64Array;
  /**
   * Name placement per player. Only present on ticks where the worker
   * recomputed placements (spawn ticks, the first ticks, every 30th tick,
   * spawn end) — between those the values wouldn't change, so the record is
   * omitted instead of re-cloned every tick. Consumers keep the last applied
   * values.
   */
  playerNameViewData?: Record<string, NameViewData>;
  tickExecutionDuration?: number;
  pendingTurns?: number;
  /**
   * Packed tile refs that were inside a nuke blast radius this tick.
   * Used by the renderer to mark nukeable layer tiles as destroyed.
   * Absent when no nukes detonated.
   */
  packedNukeImpacts?: Uint32Array;
}

/**
 * Direction lane of a `packedAttackUpdates` quad: which of the owner's attack
 * arrays the index addresses. Encoder (PlayerImpl.toUpdate →
 * packAttackTroopDeltas) and decoder (client GameView.update) must both use
 * these.
 */
export const ATTACK_DELTA_OUTGOING = 0;
export const ATTACK_DELTA_INCOMING = 1;

export interface ErrorUpdate {
  errMsg: string;
  stack?: string;
}

export enum GameUpdateType {
  // Tile updates are delivered via `packedTileUpdates` on the outer GameUpdateViewData.
  Tile,
  Unit,
  Player,
  DisplayEvent,
  DisplayChatEvent,
  AllianceRequest,
  AllianceRequestReply,
  BrokeAlliance,
  AllianceExpired,
  AllianceExtension,
  TargetPlayer,
  Emoji,
  Win,
  Hash,
  UnitIncoming,
  BonusEvent,
  RailroadDestructionEvent,
  RailroadConstructionEvent,
  RailroadSnapEvent,
  ConquestEvent,
  EmbargoEvent,
  SpawnPhaseEnd,
  GamePaused,
  DonateEvent,
  AirstrikeImpact,
  MatchEvent,
  // Appended: the enum's order is the structured-clone key order of GameUpdates.
  CapitalEvent,
  InsurgencyState,
}

export type GameUpdate =
  | UnitUpdate
  | PlayerUpdate
  | AllianceRequestUpdate
  | AllianceRequestReplyUpdate
  | BrokeAllianceUpdate
  | AllianceExpiredUpdate
  | DisplayMessageUpdate
  | DisplayChatMessageUpdate
  | TargetPlayerUpdate
  | EmojiUpdate
  | WinUpdate
  | HashUpdate
  | UnitIncomingUpdate
  | AllianceExtensionUpdate
  | BonusEventUpdate
  | RailroadConstructionUpdate
  | RailroadDestructionUpdate
  | RailroadSnapUpdate
  | ConquestUpdate
  | EmbargoUpdate
  | SpawnPhaseEndUpdate
  | GamePausedUpdate
  | DonateEventUpdate
  | AirstrikeImpactUpdate
  | MatchEventUpdate
  | CapitalEventUpdate
  | InsurgencyStateUpdate;

export interface BonusEventUpdate {
  type: GameUpdateType.BonusEvent;
  player: PlayerID;
  tile: TileRef;
  gold: number;
  troops: number;
}

export interface RailroadConstructionUpdate {
  type: GameUpdateType.RailroadConstructionEvent;
  id: number;
  tiles: TileRef[];
}

export interface RailroadDestructionUpdate {
  type: GameUpdateType.RailroadDestructionEvent;
  id: number;
}

export interface RailroadSnapUpdate {
  type: GameUpdateType.RailroadSnapEvent;
  originalId: number;
  newId1: number;
  newId2: number;
  tiles1: TileRef[];
  tiles2: TileRef[];
}

export interface ConquestUpdate {
  type: GameUpdateType.ConquestEvent;
  conquerorId: PlayerID;
  conqueredId: PlayerID;
  gold: Gold;
}

export interface DonateEventUpdate {
  type: GameUpdateType.DonateEvent;
  donationType: "troops" | "gold";
  senderId: PlayerID;
  recipientId: PlayerID;
  amount: bigint;
}

/** What happened to a capital (docs/Capital.md). */
export type CapitalEventKind =
  /** A capital was bought and its construction began (it stands at `completeTick`). */
  | "building"
  /** Its construction finished: the capital stands and gives its bonuses. */
  | "founded"
  /** Its construction was lost with the land it was on (nothing is refunded). */
  | "cancelled"
  /** An enemy captured it. The owner is in CRISIS and the captor was paid (once per pair). */
  | "captured"
  /** It was lost without a captor (nuked, rotted away, taken by a friend, its owner died). */
  | "destroyed";

/**
 * A capital changed hands or was founded or lost. One update per event, created
 * exactly once by the engine for a given capital (a capital is removed in the
 * same call that reports its fall), so a client may play a sequence per update
 * without guarding against repeats.
 */
export interface CapitalEventUpdate {
  type: GameUpdateType.CapitalEvent;
  kind: CapitalEventKind;
  tick: Tick;
  /** Never reused, so it names one ownership cycle. */
  capitalId: number;
  tile: TileRef;
  /** smallID of the player the capital belonged to. */
  owner: number;
  /** captured: smallID of the player that took it; otherwise null. */
  captor: number | null;
  replacement: boolean;
  /** captured: the tick the owner's CRISIS ends; otherwise -1. */
  crisisEndTick: number;
  /** captured: what the captor was paid. Zero when it had already been paid for this owner. */
  rewardGold: Gold;
  rewardTroops: number;
  /** building: the tick the capital will stand. */
  completeTick?: Tick;
}

// ---- The insurgency (docs/Insurgency.md) ----
//
// The engine owns every number here. The update is what the Resistance Command
// panel draws, so a client shows state and never works any of it out: costs,
// limits, cooldowns and odds are all decided (and re-checked on every order) by
// the simulation. It is sent when something changes, at most a few times a
// second, and rebuilt in full on a reconnect (the client replays the match).

/** Where a region of the owner's former land stands. */
export enum InsurgencyRegionStatus {
  /** The owner holds it again. */
  Held = 0,
  /** Hostile players hold it: the resistance's ground. */
  Occupied = 1,
  /** Neither side holds most of it (unclaimed, ruined). */
  Contested = 2,
}

export interface InsurgencyRegionView {
  id: number;
  /** Tiles of it the owner held when its capital fell. */
  former: number;
  status: InsurgencyRegionStatus;
  /** 0 stable, 1 unsettled, 2 unrestful, 3 volatile, 4 uprising. */
  band: number;
  /** smallID of the player holding most of it, or -1. */
  occupier: number;
  /** An uprising may not start here before this tick. */
  cooldownUntil: number;
  hasBase: boolean;
  hasOperation: boolean;
  suppressed: boolean;
  /** Times it has changed hands. */
  flips: number;
  /** Occupied: the extra defence percent the occupier has against ordinary attacks here (by unrest band). */
  defense: number;
}

export interface InsurgencyBaseView {
  id: number;
  region: number;
  tile: TileRef;
  /** 0..100: a suppressed base loses it and is destroyed at 0. */
  integrity: number;
}

export interface InsurgencyOperationView {
  id: number;
  region: number;
  /** Troops sent. */
  committed: number;
  /** Troops it has left. */
  troops: number;
  startTick: Tick;
}

/** What a gathered report said, precise while it is fresh. */
export interface InsurgencyIntelView {
  region: number;
  tick: Tick;
  unrest: number;
  /** The garrison estimated from the occupier's troop density. */
  garrison: number;
  occupier: number;
}

export interface InsurgencySuppressionView {
  region: number;
  occupier: number;
  endTick: Tick;
}

export enum InsurgencyPhase {
  /** The owner still has land. */
  Field = 0,
  /** The owner has no land: they fight on from the resistance alone, for a while. */
  Limbo = 1,
  Ended = 2,
}

export interface InsurgencyView {
  /** smallID of the player the resistance belongs to. */
  owner: number;
  phase: InsurgencyPhase;
  /** Why it ended ("" while it runs). */
  endReason: string;
  startTick: Tick;
  /** It dissolves at this tick unless it earns more time. */
  deadline: Tick;
  /** With no land: the tick the owner is eliminated unless they win some back, else -1. */
  limboDeadline: Tick;
  startingTroops: number;
  capacity: number;
  /** In reserve, ready to commit. */
  available: number;
  /** In uprisings now. */
  deployed: number;
  pending: { troops: number; arrives: Tick }[];
  funds: Gold;
  fundsStart: Gold;
  /** 0..100 */
  strength: number;
  bases: InsurgencyBaseView[];
  operations: InsurgencyOperationView[];
  regions: InsurgencyRegionView[];
  intel: InsurgencyIntelView[];
  /** The next report may be ordered from this tick. */
  intelReadyTick: Tick;
  suppressions: InsurgencySuppressionView[];
  /** Regions it has won back. */
  reclaimed: number;
}

export interface InsurgencyStateUpdate {
  type: GameUpdateType.InsurgencyState;
  tick: Tick;
  view: InsurgencyView;
}

/**
 * Something worth a line in the match feed happened (see MatchEvents.ts). Derived
 * from simulation state, identical on every client and in a replay.
 */
export interface MatchEventUpdate {
  type: GameUpdateType.MatchEvent;
  event: MatchEvent;
}

/** The moment an airstrike's effect lands; positioned in simulation time. */
export enum AirstrikeImpactPhase {
  BombImpact = 0,
  RocketRelease = 1,
  RocketImpact = 2,
  StrafeBurst = 3,
}

export interface AirstrikeImpactUpdate {
  type: GameUpdateType.AirstrikeImpact;
  strikeType: UnitType;
  /** smallID of the attacker. */
  attackerID: number;
  phase: AirstrikeImpactPhase;
  /** Release point, burst segment start or impact centre. */
  from: TileRef;
  /** Impact centre or burst segment end. */
  to: TileRef;
  /** Blast radius, or corridor half-width. */
  radius: number;
  /** smallIDs of the players that lost troops or structure levels. */
  affected: number[];
  /**
   * Troops this application killed (garrisons and attacks), exactly as the
   * simulation removed them. Presentation only (casualty numbers).
   */
  killed: number;
  /** Highest level of a victim city whose garrison took the city bonus (0: none). */
  cityLevel: number;
  /** Structure levels this application removed. */
  levels: number;
}

export interface UnitUpdate {
  type: GameUpdateType.Unit;
  unitType: UnitType;
  troops: number;
  id: number;
  ownerID: number;
  lastOwnerID?: number;
  // TODO: make these tilerefs
  pos: TileRef;
  lastPos: TileRef;
  isActive: boolean;
  reachedTarget: boolean;
  warshipState?: WarshipState;
  transportShipState?: TransportShipState;
  nukeState?: NukeState;
  targetable: boolean;
  markedForDeletion: number | false;
  targetUnitId?: number; // Only for trade ships
  targetTile?: TileRef; // Only for nukes
  health?: number;
  underConstruction?: boolean;
  missileTimerQueue: number[];
  level: number;
  hasTrainStation: boolean;
  trainType?: TrainType; // Only for trains
  loaded?: boolean; // Only for trains
  samUpgrade?: SamLauncherState;
}

export interface AttackUpdate {
  attackerID: number;
  targetID: number;
  troops: number;
  id: string;
  retreating: boolean;
}

/**
 * Player snapshot delivered worker -> main thread.
 *
 * Only `type` and `id` are guaranteed. Every other field is omitted when its
 * value matches the previous emission for the same player. The first emission
 * for a player always includes all fields; consumers must handle subsequent
 * partial updates by merging into local state, not overwriting.
 *
 * When adding a field here, also wire it into diffPlayerUpdate() and
 * applyStateUpdate() in PlayerStateUpdate.ts — otherwise it is only ever sent on
 * the first emission and later changes are silently dropped.
 */
export interface PlayerUpdate {
  type: GameUpdateType.Player;
  id: PlayerID;
  nameViewData?: NameViewData;
  clientID?: ClientID | null;
  name?: string;
  displayName?: string;
  clanTag?: string | null;
  nationFlag?: string | null;
  team?: Team;
  smallID?: number;
  playerType?: PlayerType;
  isAlive?: boolean;
  isDisconnected?: boolean;
  killedBy?: ClientID | null;
  deathPosition?: number | null;
  tilesOwned?: number;
  gold?: Gold;
  /** Cumulative ship-trade revenue (changes only on arrivals, so it diffs). */
  tradeGold?: Gold;
  /** Cumulative train revenue: own trains + external stops at own stations. */
  trainGold?: Gold;
  /** Cumulative piracy revenue: captured-ship payouts. */
  piracyGold?: Gold;
  /** Cumulative gold received from all sources (workers, trade, ...). */
  goldEarned?: Gold;
  troops?: number;
  allies?: number[];
  embargoes?: Set<PlayerID>;
  isTraitor?: boolean;
  traitorRemainingTicks?: number;
  inDoomsdayClock?: boolean;
  isDecaying?: boolean;
  markedDoomsdayClockTick?: number;
  targets?: number[];
  outgoingEmojis?: EmojiMessage[];
  outgoingAttacks?: AttackUpdate[];
  incomingAttacks?: AttackUpdate[];
  outgoingAllianceRequests?: PlayerID[];
  alliances?: AllianceView[];
  hasSpawned?: boolean;
  spawnTile?: TileRef;
  betrayals?: number;
  lastDeleteUnitTick?: Tick;
  isLobbyCreator?: boolean;
  /**
   * Capital System (absent when it is off): the tile of this player's capital,
   * or -1 when it has none. `-1` rather than undefined because undefined means
   * "unchanged" in a partial update.
   */
  capitalTile?: number;
  /** A standing capital is a replacement (it starts weaker and ramps up). */
  capitalIsReplacement?: boolean;
  /** CRISIS window of this player's latest capital fall, or -1 for none. */
  crisisStartTick?: number;
  crisisEndTick?: number;
  /**
   * Insurgency (absent when the Capital System is off): 0 none (or over), 1 a
   * resistance with the player still holding land, 2 a resistance with none.
   */
  insurgency?: number;
  /**
   * Capital System (absent when it is off): the tick the player's standing
   * capital was bought, or -1 when it has none. The client works out how far
   * the capital's bonuses have ramped in from it.
   */
  capitalFoundedTick?: number;
  /**
   * Capital System (absent when it is off): the tick strain begins for a
   * player with no capital (its cost is in docs/Capital.md), or -1 while it
   * has one, is in CRISIS, or cannot hold one. Never the CRISIS window.
   */
  strainStartTick?: number;
  /**
   * Capital System (absent when it is off): where a capital is being built and
   * when its construction began and will end, or -1 for none. The capital
   * gives nothing (and `capitalTile` stays -1) until it ends.
   */
  capitalBuildTile?: number;
  capitalBuildStartTick?: number;
  capitalBuildEndTick?: number;
}

export interface AllianceView {
  id: number;
  other: PlayerID;
  createdAt: Tick;
  expiresAt: Tick;
  hasExtensionRequest: boolean;
}

export interface AllianceRequestUpdate {
  type: GameUpdateType.AllianceRequest;
  requestorID: number;
  recipientID: number;
  createdAt: Tick;
}

export interface AllianceRequestReplyUpdate {
  type: GameUpdateType.AllianceRequestReply;
  request: AllianceRequestUpdate;
  accepted: boolean;
}

export interface BrokeAllianceUpdate {
  type: GameUpdateType.BrokeAlliance;
  traitorID: number;
  betrayedID: number;
  allianceID: number;
}

export interface AllianceExpiredUpdate {
  type: GameUpdateType.AllianceExpired;
  player1ID: number;
  player2ID: number;
}

export interface AllianceExtensionUpdate {
  type: GameUpdateType.AllianceExtension;
  playerID: number;
  allianceID: number;
}

export interface TargetPlayerUpdate {
  type: GameUpdateType.TargetPlayer;
  playerID: number;
  targetID: number;
}

export interface EmojiUpdate {
  type: GameUpdateType.Emoji;
  emoji: EmojiMessage;
}

export interface DisplayMessageUpdate {
  type: GameUpdateType.DisplayEvent;
  message: string;
  messageType: MessageType;
  goldAmount?: bigint;
  playerID: number | null;
  params?: Record<string, string | number>;
  unitID?: number;
  focusPlayerID?: number;
}

export type DisplayChatMessageUpdate = {
  type: GameUpdateType.DisplayChatEvent;
  key: string;
  category: string;
  target: string | undefined;
  playerID: number | null;
  isFrom: boolean;
  recipient: string;
};

export interface WinUpdate {
  type: GameUpdateType.Win;
  allPlayersStats: AllPlayersStats;
  winner: Winner;
}

export interface HashUpdate {
  type: GameUpdateType.Hash;
  tick: Tick;
  hash: number;
}

export interface UnitIncomingUpdate {
  type: GameUpdateType.UnitIncoming;
  unitID: number;
  message: string;
  messageType: MessageType;
  playerID: number;
  /** Translation params when `message` is a translation key. */
  params?: Record<string, string | number>;
}

export interface EmbargoUpdate {
  type: GameUpdateType.EmbargoEvent;
  event: "start" | "stop";
  playerID: number;
  embargoedID: number;
}

export interface SpawnPhaseEndUpdate {
  type: GameUpdateType.SpawnPhaseEnd;
  startTick: Tick;
}

export interface GamePausedUpdate {
  type: GameUpdateType.GamePaused;
  paused: boolean;
}
