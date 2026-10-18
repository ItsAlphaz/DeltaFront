import { TileRef } from "@openfront/engine-api/game/GameMap";
import { MessageType, PlayerType } from "@openfront/engine-api/game/GameTypes";
import {
  GameUpdateType,
  InsurgencyPhase,
  InsurgencyRegionStatus,
  type InsurgencyView,
} from "@openfront/engine-api/game/GameUpdates";
import { renderNumber, renderTroops } from "@openfront/engine-lib/Format";
import {
  fillPermille,
  inBounds,
  isValidRegion,
  nextUnrest,
  occupationDefensePercent,
  recruitCost,
  regionBounds,
  regionGrid,
  regionLabel,
  regionOf,
  startingFunds,
  startingTroops,
  startingUnrest,
  strength,
  survivalDeadline,
  troopCapacity,
  unrestBand,
  unrestCap,
  type InsurgencySpec,
  type RegionGrid,
} from "@openfront/engine-lib/insurgency/InsurgencyRules";
import { zInt, zNum, zTile } from "@openfront/engine-lib/snapshot/SnapshotType";
import { z } from "zod";
import { AttackExecution } from "../execution/AttackExecution";
import type { Attack, Game, Player } from "./Game";

/**
 * The Insurgency System (docs/Insurgency.md): what a human whose capital has
 * fallen may do about it.
 *
 * ## What it is
 *
 * A small force and a small purse of their own, kept apart from the nation's
 * army and treasury, spent through five orders: recruit, found a base, launch
 * an uprising, gather intelligence, and (for the occupier) suppress a region.
 * The map is cut into regions; the land the player held when the capital fell
 * is their national regions, each with an unrest that rises where the occupier
 * is thin and falls where it is strong or suppressing.
 *
 * ## What it is not
 *
 * It moves no tile. An uprising is an ordinary AttackExecution with the
 * resistance's own troops, bounded to its region and seeded at one tile that has
 * to be won in combat like any other: the same troop losses, the same speed,
 * the same defender. Territory changes only by that combat.
 *
 * ## Where its state lives
 *
 * Here, owned by the game like the Capital System (one per game, only when the
 * match setting is on), and nowhere else: not on the players, not in a unit
 * type. The orders reach it as ordinary intents; every number they need is
 * checked here, on every client, identically, and a rejected order does
 * nothing. The client only draws what the engine reports (InsurgencyStateUpdate).
 *
 * ## A player with no land
 *
 * `isAlive()` stays "owns a tile", and everything that reads it keeps working.
 * What changes is that an insurgent who loses their last tile is not eliminated
 * (no gold stripped, no units deleted, no kill credited, no place stamped) while
 * their resistance lives: PlayerExecution and conquerPlayer ask `holdsLimbo`.
 * The elimination is done when the resistance ends with them still landless
 * (finalizeElimination), exactly once, crediting whoever took their last land.
 * If they win a tile back, they are simply alive again.
 *
 * ## Limits (spec section 11)
 *
 * One insurgency per player per match. Troops never come from nowhere: the
 * force is drawn from the army that fell, recruiting is paid for out of a
 * capped purse, total manpower is capped, an operation's survivors go back to
 * the pool and nothing else does. A region pays once, wins at most a bounded
 * share of time, and each hand-over of it lowers how restless it can get. The
 * whole thing freezes when the match ends.
 */

export type EndReason =
  | "exhausted"
  | "limbo_expired"
  | "survival_expired"
  | "match_over";

/** Why an order was refused. Nothing is charged for a refused order. */
export type Reject =
  | "inactive"
  | "region"
  | "not_occupied"
  | "unrest"
  | "funds"
  | "capacity"
  | "troops"
  | "limit"
  | "cooldown"
  | "tile"
  | "no_location"
  | "target"
  | "busy";

export interface RegionState {
  id: number;
  /** Tiles of it the owner held when the capital fell. */
  former: number;
  status: InsurgencyRegionStatus;
  unrest: number;
  flips: number;
  /** smallID of the player holding most of it, or -1. */
  occupier: number;
  cooldownUntil: number;
  /** The one-off payment for winning it back has been made. */
  rewarded: boolean;
  /** It has been won back at least once (so a later loss is a hand-over). */
  reclaimedOnce: boolean;
  /** The occupier has been warned it is volatile (re-armed when it settles). */
  warned: boolean;
}

export interface BaseState {
  id: number;
  region: number;
  tile: TileRef;
  foundedTick: number;
  integrity: number;
}

export interface Recruit {
  id: number;
  troops: number;
  arrives: number;
}

export interface Operation {
  id: number;
  region: number;
  seed: TileRef;
  committed: number;
  startTick: number;
  /** The uprising's attack, once it has been created (-1 before). */
  attackId: string | null;
  /** The owner's tiles in the region when it began. */
  startOwn: number;
}

export interface Suppression {
  id: number;
  occupier: number;
  region: number;
  troops: number;
  endTick: number;
}

export interface IntelReport {
  region: number;
  tick: number;
  unrest: number;
  garrison: number;
  occupier: number;
}

export interface Insurgency {
  owner: number;
  /** The player that captured the capital. */
  captor: number;
  capitalId: number;
  startTick: number;
  status: "active" | "ended";
  endReason: EndReason | "";
  endTick: number;
  startingTroops: number;
  capacity: number;
  fundsStart: bigint;
  funds: bigint;
  /** Gold moved from the owner's income into the purse so far. */
  diverted: bigint;
  /** In reserve, ready to commit. */
  available: number;
  recruits: Recruit[];
  regions: RegionState[];
  bases: BaseState[];
  ops: Operation[];
  suppressions: Suppression[];
  intel: IntelReport[];
  intelReadyTick: number;
  reclaimed: number;
  deadline: number;
  /** The tick the owner lost their last tile, or -1. */
  limboSince: number;
  limboDeadline: number;
  /** smallID of whoever took the owner's last land, or -1. */
  conqueror: number;
  warned: boolean;
  /** The landless player has been warned that their time to win land back is nearly up. */
  limboWarned: boolean;
  nextId: number;
}

/** A player the conquest of whom an insurgency may take over. */
interface PendingDeath {
  conqueror: number;
  army: number;
  profile: [number, number][];
}

interface LogEntry {
  tick: number;
  kind: string;
  owner: number;
  a: number;
  b: number;
}

const LOG_LIMIT = 200;

const RegionSchema = z.object({
  id: zInt(),
  former: zInt(),
  status: zInt(),
  unrest: zInt(),
  flips: zInt(),
  occupier: zInt(),
  cooldownUntil: zInt(),
  rewarded: z.boolean(),
  reclaimedOnce: z.boolean(),
  warned: z.boolean(),
});

export const InsurgencySystemStateSchema = z.object({
  list: z.array(
    z.object({
      owner: zInt(),
      captor: zInt(),
      capitalId: zInt(),
      startTick: zInt(),
      status: z.enum(["active", "ended"]),
      endReason: z.string(),
      endTick: zInt(),
      startingTroops: zNum(),
      capacity: zNum(),
      fundsStart: z.bigint(),
      funds: z.bigint(),
      diverted: z.bigint(),
      available: zNum(),
      recruits: z.array(
        z.object({ id: zInt(), troops: zNum(), arrives: zInt() }),
      ),
      regions: z.array(RegionSchema),
      bases: z.array(
        z.object({
          id: zInt(),
          region: zInt(),
          tile: zTile(),
          foundedTick: zInt(),
          integrity: zNum(),
        }),
      ),
      ops: z.array(
        z.object({
          id: zInt(),
          region: zInt(),
          seed: zTile(),
          committed: zNum(),
          startTick: zInt(),
          attackId: z.string().nullable(),
          startOwn: zInt(),
        }),
      ),
      suppressions: z.array(
        z.object({
          id: zInt(),
          occupier: zInt(),
          region: zInt(),
          troops: zNum(),
          endTick: zInt(),
        }),
      ),
      intel: z.array(
        z.object({
          region: zInt(),
          tick: zInt(),
          unrest: zInt(),
          garrison: zNum(),
          occupier: zInt(),
        }),
      ),
      intelReadyTick: zInt(),
      reclaimed: zInt(),
      deadline: zInt(),
      limboSince: zInt(),
      limboDeadline: zInt(),
      conqueror: zInt(),
      warned: z.boolean(),
      limboWarned: z.boolean(),
      nextId: zInt(),
    }),
  ),
  pending: z.array(
    z.object({
      owner: zInt(),
      conqueror: zInt(),
      army: zNum(),
      profile: z.array(z.tuple([zInt(), zInt()])),
    }),
  ),
  log: z.array(
    z.object({
      tick: zInt(),
      kind: z.string(),
      owner: zInt(),
      a: zNum(),
      b: zNum(),
    }),
  ),
  matchOverHandled: z.boolean(),
});
export type InsurgencySystemState = z.infer<typeof InsurgencySystemStateSchema>;

export class InsurgencySystem {
  /** In the order they began (the order is state: it is iterated every tick). */
  private list: Insurgency[] = [];
  private byOwner = new Map<number, Insurgency>();
  /** Players whose last land is being taken while an insurgency may take over. */
  private pending = new Map<number, PendingDeath>();
  private logEntries: LogEntry[] = [];
  /** Owners whose state changed since it was last sent to the clients. */
  private dirty = new Set<number>();
  /** owner smallID -> tick the state was last sent (delivery bookkeeping, not snapshotted). */
  private lastEmit = new Map<number, number>();
  private matchOverHandled = false;
  private gridCache: RegionGrid | null = null;

  constructor(private readonly mg: Game) {}

  // ---- Small helpers ----

  private spec(): InsurgencySpec {
    return this.mg.config().insurgencySpec();
  }

  private grid(): RegionGrid {
    this.gridCache ??= regionGrid(
      this.mg.width(),
      this.mg.height(),
      this.spec().regionShift,
    );
    return this.gridCache;
  }

  /** The label of a region, as the players see it ("C7"). */
  label(region: number): string {
    return regionLabel(this.grid(), region);
  }

  /** The player with this smallID, or null for none (-1), the unowned (0) or a stranger. */
  private player(smallID: number): Player | null {
    if (!(smallID > 0)) return null;
    const p = this.mg.playerBySmallID(smallID) as Player | undefined;
    return p !== undefined && p.isPlayer() ? p : null;
  }

  private logEvent(
    ins: Insurgency,
    kind: string,
    a: number = 0,
    b: number = 0,
  ): void {
    this.logEntries.push({
      tick: this.mg.ticks(),
      kind,
      owner: ins.owner,
      a,
      b,
    });
    if (this.logEntries.length > LOG_LIMIT) this.logEntries.shift();
    this.dirty.add(ins.owner);
  }

  /** Every resistance action recorded so far (bounded), for investigating abuse. */
  auditLog(): readonly LogEntry[] {
    return this.logEntries;
  }

  // ---- Queries ----

  of(player: Player): Insurgency | null {
    return this.byOwner.get(player.smallID()) ?? null;
  }

  /**
   * The extra defence percent the occupier has against `attacker`'s ordinary
   * attack on `tile`: 0 unless `attacker` has a running resistance and the tile
   * is held by the occupier of one of its occupied regions (docs/Insurgency.md).
   */
  occupationDefensePercent(attacker: Player, tile: TileRef): number {
    const ins = this.of(attacker);
    if (ins === null || ins.status !== "active") return 0;
    const region = this.region(
      ins,
      regionOf(this.grid(), this.mg.x(tile), this.mg.y(tile)),
    );
    if (region === null || region.status !== InsurgencyRegionStatus.Occupied) {
      return 0;
    }
    if (this.mg.map().ownerID(tile) !== region.occupier) return 0;
    return occupationDefensePercent(this.spec(), region.unrest);
  }

  /** The player has a resistance that is still going. */
  isActive(player: Player): boolean {
    return this.of(player)?.status === "active";
  }

  /**
   * The player owns no land but their resistance goes on (or is about to be
   * decided this very tick): PlayerExecution and conquerPlayer must not
   * eliminate them yet.
   */
  holdsLimbo(player: Player): boolean {
    return this.isActive(player) || this.pending.has(player.smallID());
  }

  /** 0 none (or over), 1 resisting with land, 2 resisting with none. */
  phaseOf(player: Player): number {
    const ins = this.of(player);
    if (ins === null || ins.status !== "active") return 0;
    return player.isAlive() ? 1 : 2;
  }

  /** Every resistance, running or over. */
  all(): readonly Insurgency[] {
    return this.list;
  }

  /** Troops in the field: the troops left in this resistance's uprisings. */
  private deployed(ins: Insurgency): number {
    const owner = this.player(ins.owner);
    if (owner === null) return 0;
    let total = 0;
    for (const op of ins.ops) {
      if (op.attackId === null) continue;
      const a = owner.outgoingAttacks().find((x) => x.id() === op.attackId);
      if (a !== undefined) total += a.troops();
    }
    return total;
  }

  private pendingTroops(ins: Insurgency): number {
    let total = 0;
    for (const r of ins.recruits) total += r.troops;
    return total;
  }

  /** Everything the resistance has: reserve, in the field, and on the way. */
  totalTroops(ins: Insurgency): number {
    return ins.available + this.deployed(ins) + this.pendingTroops(ins);
  }

  /** Where the resistance can gather and arrive: a base, or land of its own. */
  private hasLocation(ins: Insurgency): boolean {
    return ins.bases.length > 0 || (this.player(ins.owner)?.isAlive() ?? false);
  }

  // ---- Measuring regions ----

  private isHostile(ins: Insurgency, smallID: number): boolean {
    if (smallID === 0 || smallID === ins.owner) return false;
    const p = this.player(smallID);
    const owner = this.player(ins.owner);
    return p !== null && owner !== null && !p.isFriendly(owner);
  }

  private measure(ins: Insurgency, region: number) {
    const b = regionBounds(this.grid(), region);
    const map = this.mg.map();
    const width = this.mg.width();
    const hostileCache = new Map<number, boolean>();
    let own = 0;
    let hostile = 0;
    const holders = new Map<number, number>();
    for (let y = b.y0; y <= b.y1; y++) {
      for (let x = b.x0; x <= b.x1; x++) {
        const id = map.ownerID(y * width + x);
        if (id === 0) continue;
        if (id === ins.owner) {
          own++;
          continue;
        }
        let h = hostileCache.get(id);
        if (h === undefined) {
          h = this.isHostile(ins, id);
          hostileCache.set(id, h);
        }
        if (!h) continue;
        hostile++;
        holders.set(id, (holders.get(id) ?? 0) + 1);
      }
    }
    let primary = -1;
    let best = 0;
    for (const [id, n] of holders) {
      if (n > best || (n === best && id < primary)) {
        best = n;
        primary = id;
      }
    }
    return { own, hostile, primary, primaryTiles: best };
  }

  /** The player's tiles by region, as sorted [region, tiles] pairs. */
  private profile(owner: Player): [number, number][] {
    const grid = this.grid();
    const map = this.mg.map();
    const counts = new Map<number, number>();
    for (const t of owner.tiles()) {
      const r = regionOf(grid, map.x(t), map.y(t));
      counts.set(r, (counts.get(r) ?? 0) + 1);
    }
    return [...counts].sort((a, b) => a[0] - b[0]);
  }

  private classify(
    spec: InsurgencySpec,
    former: number,
    m: { own: number; hostile: number },
  ): InsurgencyRegionStatus {
    if (m.own * 100 >= former * spec.reclaimedPercent) {
      return InsurgencyRegionStatus.Held;
    }
    if (m.hostile * 100 >= former * spec.occupiedPercent) {
      return InsurgencyRegionStatus.Occupied;
    }
    return InsurgencyRegionStatus.Contested;
  }

  // ---- A conquest, and a capital's fall ----

  /**
   * `conqueror` is taking the last land of `conquered` (called by
   * conquerPlayer before the land moves). Returns whether the elimination
   * is put off: because the player has a resistance running, or because the
   * fall of their capital this tick is about to start one. If it turns out not
   * to, the end of the tick finalizes the elimination (resolvePending).
   */
  noteConquest(conquered: Player, conqueror: Player): boolean {
    if (conquered.type() !== PlayerType.Human) return false;
    const ins = this.byOwner.get(conquered.smallID());
    if (ins !== undefined) {
      if (ins.status !== "active") return false;
      ins.conqueror = conqueror.smallID();
      this.dirty.add(ins.owner);
      return true;
    }
    // Would the fall of their capital start one? A human with a capital
    // standing, an army to rise from and national land to rise on.
    const capitals = this.mg.capitals();
    if (capitals === null || capitals.capitalOf(conquered) === null) {
      return false;
    }
    const spec = this.spec();
    const army = conquered.troops();
    if (startingTroops(spec, army) === 0) return false;
    const profile = this.profile(conquered);
    if (!profile.some(([, n]) => n >= spec.minRegionTiles)) return false;
    this.pending.set(conquered.smallID(), {
      conqueror: conqueror.smallID(),
      army,
      profile,
    });
    return true;
  }

  /**
   * The capital of `owner` was captured by `captor`. Starts the owner's
   * resistance if they may have one (a human, once per match, with an army to
   * rise from and national land). Returns whether it started.
   */
  activate(
    owner: Player,
    captor: Player,
    capitalId: number,
    ticks: number,
  ): boolean {
    if (owner.type() !== PlayerType.Human) return false;
    if (this.byOwner.has(owner.smallID())) return false;
    const spec = this.spec();
    const pending = this.pending.get(owner.smallID());
    const army = pending?.army ?? owner.troops();
    const start = startingTroops(spec, army);
    if (start === 0) return false;
    const profile = pending?.profile ?? this.profile(owner);
    const national = profile.filter(([, n]) => n >= spec.minRegionTiles);
    if (national.length === 0) return false;

    const regions: RegionState[] = national.map(([id, former]) => ({
      id,
      former,
      status: InsurgencyRegionStatus.Held,
      unrest: 0,
      flips: 0,
      occupier: -1,
      cooldownUntil: 0,
      rewarded: false,
      reclaimedOnce: false,
      warned: false,
    }));
    const funds = startingFunds(spec, owner.goldEarned());
    const ins: Insurgency = {
      owner: owner.smallID(),
      captor: captor.smallID(),
      capitalId,
      startTick: ticks,
      status: "active",
      endReason: "",
      endTick: -1,
      startingTroops: start,
      capacity: troopCapacity(spec, start),
      fundsStart: funds,
      funds,
      diverted: 0n,
      available: start,
      recruits: [],
      regions,
      bases: [],
      ops: [],
      suppressions: [],
      intel: [],
      intelReadyTick: 0,
      reclaimed: 0,
      deadline: survivalDeadline(spec, ticks, 0),
      limboSince: -1,
      limboDeadline: -1,
      conqueror: pending?.conqueror ?? captor.smallID(),
      warned: false,
      limboWarned: false,
      nextId: 1,
    };
    this.list.push(ins);
    this.byOwner.set(ins.owner, ins);
    this.pending.delete(owner.smallID());

    // The resistance rises from the army that fell: it is taken from it, not
    // made. (The size was worked out from the army before this.)
    owner.removeTroops(Math.min(start, owner.troops()));

    // Which regions are already in enemy hands, and how restless they start.
    for (const r of regions) this.updateRegion(ins, r, ticks, true);

    this.logEvent(ins, "activate", start, Number(funds));
    this.mg.displayMessage(
      "events_display.insurgency_started",
      MessageType.INSURGENCY_STARTED,
      owner.id(),
      undefined,
      {
        troops: renderTroops(start),
        funds: renderNumber(funds),
      },
    );
    if (captor.type() === PlayerType.Human) {
      this.mg.displayMessage(
        "events_display.insurgency_started_occupier",
        MessageType.INSURGENCY_WARNING,
        captor.id(),
        undefined,
        { name: owner.displayName() },
      );
    }
    this.mg.matchEvents().insurgencyStarted(captor, owner);
    return true;
  }

  // ---- The orders ----

  private mine(player: Player): Insurgency | null {
    const ins = this.byOwner.get(player.smallID());
    if (ins === undefined || ins.status !== "active") return null;
    if (this.mg.getWinner() !== null) return null;
    return ins;
  }

  private region(ins: Insurgency, id: number): RegionState | null {
    if (!isValidRegion(this.grid(), id)) return null;
    return ins.regions.find((r) => r.id === id) ?? null;
  }

  /** Recruit `troops` more: paid for now, in the reserve when they arrive. */
  recruit(player: Player, troops: number): Reject | null {
    const ins = this.mine(player);
    if (ins === null) return "inactive";
    const spec = this.spec();
    if (!Number.isInteger(troops) || troops < spec.recruitMinTroops) {
      return "troops";
    }
    if (ins.recruits.length >= spec.maxPendingRecruits) return "limit";
    if (!this.hasLocation(ins)) return "no_location";
    if (this.totalTroops(ins) + troops > ins.capacity) return "capacity";
    const cost = recruitCost(spec, troops);
    if (ins.funds < cost) return "funds";
    ins.funds -= cost;
    ins.recruits.push({
      id: ins.nextId++,
      troops,
      arrives: this.mg.ticks() + spec.recruitTicks,
    });
    this.logEvent(ins, "recruit", troops, Number(cost));
    return null;
  }

  /** Found a base on enemy-held `tile` of a restless national region. */
  foundBase(player: Player, tile: TileRef): Reject | null {
    const ins = this.mine(player);
    if (ins === null) return "inactive";
    const spec = this.spec();
    if (!this.mg.isValidRef(tile) || !this.mg.isLand(tile)) return "tile";
    const holder = this.mg.map().ownerID(tile);
    if (!this.isHostile(ins, holder)) return "tile";
    const region = this.region(
      ins,
      regionOf(this.grid(), this.mg.x(tile), this.mg.y(tile)),
    );
    if (region === null) return "region";
    if (region.status !== InsurgencyRegionStatus.Occupied) {
      return "not_occupied";
    }
    if (region.unrest < spec.baseMinUnrest) return "unrest";
    if (ins.bases.some((b) => b.region === region.id)) return "busy";
    if (ins.bases.length >= spec.maxBases) return "limit";
    if (ins.funds < spec.baseCost) return "funds";
    ins.funds -= spec.baseCost;
    ins.bases.push({
      id: ins.nextId++,
      region: region.id,
      tile,
      foundedTick: this.mg.ticks(),
      integrity: 100,
    });
    this.logEvent(ins, "base", region.id, Number(spec.baseCost));
    return null;
  }

  /**
   * Launch an uprising in `region` with `troops` of the reserve. The attack it
   * starts is an ordinary one (see AttackExecution's ResistanceAttack): the
   * region falls only if the troops win it.
   */
  uprising(player: Player, regionId: number, troops: number): Reject | null {
    const ins = this.mine(player);
    if (ins === null) return "inactive";
    const spec = this.spec();
    const region = this.region(ins, regionId);
    if (region === null) return "region";
    if (region.status !== InsurgencyRegionStatus.Occupied) {
      return "not_occupied";
    }
    if (region.unrest < spec.uprisingMinUnrest) return "unrest";
    const now = this.mg.ticks();
    if (now < region.cooldownUntil) return "cooldown";
    if (ins.ops.some((o) => o.region === region.id)) return "busy";
    if (ins.ops.length >= spec.maxOperations) return "limit";
    if (!this.hasLocation(ins)) return "no_location";
    if (!Number.isInteger(troops) || troops < spec.uprisingMinTroops) {
      return "troops";
    }
    if (troops > ins.available) return "troops";
    if (ins.funds < spec.uprisingCost) return "funds";
    const occupier = this.player(region.occupier);
    if (occupier === null) return "not_occupied";
    const seed = this.seedFor(ins, region, occupier);
    if (seed === null) return "tile";

    ins.funds -= spec.uprisingCost;
    ins.available -= troops;
    const measure = this.measure(ins, region.id);
    const op: Operation = {
      id: ins.nextId++,
      region: region.id,
      seed,
      committed: troops,
      startTick: now,
      attackId: null,
      startOwn: measure.own,
    };
    ins.ops.push(op);
    this.mg.addExecution(
      new AttackExecution(troops, player, occupier.id(), null, false, {
        opId: op.id,
        seed,
        bounds: regionBounds(this.grid(), region.id),
      }),
    );
    this.logEvent(ins, "uprising", region.id, troops);
    if (occupier.type() === PlayerType.Human) {
      this.mg.displayMessage(
        "events_display.insurgency_uprising_occupier",
        MessageType.INSURGENCY_WARNING,
        occupier.id(),
        undefined,
        { name: player.displayName(), region: this.label(region.id) },
      );
    }
    this.mg.matchEvents().uprisingLaunched(player, occupier);
    return null;
  }

  /** Where an uprising in `region` breaks in: the occupier's land nearest a base, or the middle. */
  private seedFor(
    ins: Insurgency,
    region: RegionState,
    occupier: Player,
  ): TileRef | null {
    const b = regionBounds(this.grid(), region.id);
    const base = ins.bases.find((x) => x.region === region.id);
    const ax = base !== undefined ? this.mg.x(base.tile) : (b.x0 + b.x1) >> 1;
    const ay = base !== undefined ? this.mg.y(base.tile) : (b.y0 + b.y1) >> 1;
    const map = this.mg.map();
    const width = this.mg.width();
    let best: TileRef | null = null;
    let bestDist = Infinity;
    for (let y = b.y0; y <= b.y1; y++) {
      for (let x = b.x0; x <= b.x1; x++) {
        const t = y * width + x;
        if (map.ownerID(t) !== occupier.smallID()) continue;
        if (!map.isLand(t) || map.isImpassable(t)) continue;
        const d = (x - ax) * (x - ax) + (y - ay) * (y - ay);
        if (d < bestDist) {
          bestDist = d;
          best = t;
        }
      }
    }
    return best;
  }

  /** Spend funds to learn a region's precise unrest and garrison, for a while. */
  intel(player: Player, regionId: number): Reject | null {
    const ins = this.mine(player);
    if (ins === null) return "inactive";
    const spec = this.spec();
    const region = this.region(ins, regionId);
    if (region === null) return "region";
    if (region.status !== InsurgencyRegionStatus.Occupied) {
      return "not_occupied";
    }
    const now = this.mg.ticks();
    if (now < ins.intelReadyTick) return "cooldown";
    if (ins.funds < spec.intelCost) return "funds";
    const occupier = this.player(region.occupier);
    if (occupier === null) return "not_occupied";
    ins.funds -= spec.intelCost;
    ins.intelReadyTick = now + spec.intelCooldownTicks;
    const report: IntelReport = {
      region: region.id,
      tick: now,
      unrest: region.unrest,
      garrison: this.garrisonOf(ins, region, occupier),
      occupier: occupier.smallID(),
    };
    ins.intel = ins.intel.filter((r) => r.region !== region.id);
    ins.intel.push(report);
    this.logEvent(ins, "intel", region.id, Number(spec.intelCost));
    return null;
  }

  /**
   * The occupier's army spread evenly over its land: what its part of a region
   * holds. An estimate, as the engine's own combat treats a defender (troops
   * per tile).
   */
  private garrisonOf(
    ins: Insurgency,
    region: RegionState,
    occupier: Player,
  ): number {
    const tiles = Math.max(1, occupier.numTilesOwned());
    const here = Math.min(
      this.measureFor(ins, region.id, occupier.smallID()),
      tiles,
    );
    return Math.floor((occupier.troops() * here) / tiles);
  }

  /**
   * An occupier commits troops to suppress `regionId` of `target`'s resistance:
   * taken out of its army for the duration (so they are not attacking
   * anyone), most of them returned when it ends. It cools the region, wears
   * down bases and uprisings there, and costs the occupier its troops' time.
   */
  suppress(occupier: Player, target: Player, regionId: number): Reject | null {
    if (this.mg.getWinner() !== null) return "inactive";
    const ins = this.byOwner.get(target.smallID());
    if (ins === undefined || ins.status !== "active") return "target";
    if (occupier === target || occupier.isFriendly(target)) return "target";
    const spec = this.spec();
    const region = this.region(ins, regionId);
    if (region === null) return "region";
    if (region.status !== InsurgencyRegionStatus.Occupied) {
      return "not_occupied";
    }
    // It must be the occupier's own land that it suppresses.
    if (this.measureFor(ins, region.id, occupier.smallID()) < 1) {
      return "not_occupied";
    }
    if (
      ins.suppressions.some(
        (s) => s.region === region.id && s.occupier === occupier.smallID(),
      )
    ) {
      return "busy";
    }
    let running = 0;
    for (const other of this.list) {
      for (const s of other.suppressions) {
        if (s.occupier === occupier.smallID()) running++;
      }
    }
    if (running >= spec.suppressMax) return "limit";
    const troops = Math.max(
      spec.suppressMinTroops,
      Math.floor((occupier.troops() * spec.suppressPercent) / 100),
    );
    if (occupier.troops() < troops) return "troops";
    occupier.removeTroops(troops);
    ins.suppressions.push({
      id: ins.nextId++,
      occupier: occupier.smallID(),
      region: region.id,
      troops,
      endTick: this.mg.ticks() + spec.suppressTicks,
    });
    this.logEvent(ins, "suppress", region.id, troops);
    this.mg.displayMessage(
      "events_display.insurgency_suppressed",
      MessageType.INSURGENCY_WARNING,
      target.id(),
      undefined,
      { name: occupier.displayName(), region: this.label(region.id) },
    );
    return null;
  }

  /** The tiles `holder` has in a region. */
  private measureFor(_ins: Insurgency, region: number, holder: number): number {
    const b = regionBounds(this.grid(), region);
    const map = this.mg.map();
    const width = this.mg.width();
    let n = 0;
    for (let y = b.y0; y <= b.y1; y++) {
      for (let x = b.x0; x <= b.x1; x++) {
        if (map.ownerID(y * width + x) === holder) n++;
      }
    }
    return n;
  }

  // ---- From the uprising's attack ----

  /** The attack of an uprising was created: track it. False if the resistance is gone. */
  attachOperation(opId: number, attack: Attack): boolean {
    const owner = attack.attacker().smallID();
    const ins = this.byOwner.get(owner);
    if (ins === undefined || ins.status !== "active") return false;
    const op = ins.ops.find((o) => o.id === opId);
    if (op === undefined) return false;
    op.attackId = attack.id();
    this.dirty.add(owner);
    return true;
  }

  /** An uprising's survivors come home. */
  returnTroops(owner: Player, troops: number): void {
    const ins = this.byOwner.get(owner.smallID());
    if (ins === undefined || ins.status !== "active") return;
    ins.available += Math.max(0, Math.floor(troops));
    this.dirty.add(ins.owner);
  }

  /**
   * Part of the owner's gold income is diverted to the resistance, while it
   * has land to earn from and until the diverted total reaches its cap. It is
   * moved, never created. Returns what the owner keeps.
   */
  divertIncome(owner: Player, gold: bigint): bigint {
    const ins = this.byOwner.get(owner.smallID());
    if (ins === undefined || ins.status !== "active" || gold <= 0n) return gold;
    const spec = this.spec();
    const room = spec.incomeShareMax - ins.diverted;
    if (room <= 0n) return gold;
    let share = (gold * BigInt(spec.incomeSharePercent)) / 100n;
    if (share > room) share = room;
    if (share <= 0n) return gold;
    ins.diverted += share;
    ins.funds += share;
    this.dirty.add(ins.owner);
    return gold - share;
  }

  // ---- The tick ----

  /** After every execution has run, and before the match feed. */
  tick(ticks: number): void {
    if (this.mg.getWinner() !== null) {
      this.matchOver(ticks);
      return;
    }
    this.resolvePending();
    for (const ins of this.list) {
      if (ins.status === "active") this.step(ins, ticks);
    }
    this.emitDirty(ticks);
  }

  /** A conquest the resistance did not take over: the player dies as they would have. */
  private resolvePending(): void {
    for (const [small, p] of [...this.pending]) {
      this.pending.delete(small);
      const ins = this.byOwner.get(small);
      if (ins !== undefined && ins.status === "active") continue;
      const player = this.player(small);
      if (player !== null && !player.isAlive()) {
        this.mg.finalizeElimination(this.player(p.conqueror), player);
      }
    }
  }

  private step(ins: Insurgency, ticks: number): void {
    const spec = this.spec();
    this.arriveRecruits(ins, ticks);
    this.trackOperations(ins, ticks);
    this.expireSuppressions(ins, ticks);
    if (ticks % spec.unrestInterval === 0) this.updateRegions(ins, ticks);
    this.checkLife(ins, ticks);
    // The troops of an uprising change every tick.
    if (ins.ops.length > 0) this.dirty.add(ins.owner);
  }

  private arriveRecruits(ins: Insurgency, ticks: number): void {
    for (const r of [...ins.recruits]) {
      if (r.arrives > ticks) continue;
      ins.recruits = ins.recruits.filter((x) => x.id !== r.id);
      if (this.hasLocation(ins)) {
        ins.available += r.troops;
        this.logEvent(ins, "arrived", r.troops);
        this.mg.displayMessage(
          "events_display.insurgency_recruits_arrived",
          MessageType.INSURGENCY_ORDER,
          this.player(ins.owner)!.id(),
          undefined,
          { troops: renderTroops(r.troops) },
        );
      } else {
        // Nowhere to gather: they scatter. Capacity is freed with them.
        this.logEvent(ins, "recruits_lost", r.troops);
        this.mg.displayMessage(
          "events_display.insurgency_recruits_lost",
          MessageType.INSURGENCY_WARNING,
          this.player(ins.owner)!.id(),
          undefined,
          { troops: renderTroops(r.troops) },
        );
      }
    }
  }

  private trackOperations(ins: Insurgency, ticks: number): void {
    const owner = this.player(ins.owner);
    if (owner === null) return;
    for (const op of [...ins.ops]) {
      if (op.attackId === null) {
        // The attack never started (its order was refused as it began): the
        // troops were never sent and nothing happened, so nothing is spent.
        if (ticks - op.startTick > 5) {
          ins.available += op.committed;
          ins.funds += this.spec().uprisingCost;
          ins.ops = ins.ops.filter((o) => o.id !== op.id);
          this.logEvent(ins, "uprising_void", op.region, op.committed);
          this.mg.displayMessage(
            "events_display.insurgency_uprising_void",
            MessageType.INSURGENCY_WARNING,
            owner.id(),
            undefined,
            { region: this.label(op.region) },
          );
        }
        continue;
      }
      const attack = owner
        .outgoingAttacks()
        .find((a) => a.id() === op.attackId);
      if (attack !== undefined && attack.isActive()) continue;
      this.finishOperation(ins, op, ticks);
    }
  }

  private finishOperation(ins: Insurgency, op: Operation, ticks: number): void {
    ins.ops = ins.ops.filter((o) => o.id !== op.id);
    const region = this.region(ins, op.region);
    if (region !== null) {
      region.cooldownUntil = ticks + this.spec().regionCooldownTicks;
    }
    const own = this.measure(ins, op.region).own;
    const gained = Math.max(0, own - op.startOwn);
    this.logEvent(ins, "uprising_end", op.region, gained);
    this.mg.displayMessage(
      gained > 0
        ? "events_display.insurgency_uprising_won"
        : "events_display.insurgency_uprising_failed",
      MessageType.INSURGENCY_ORDER,
      this.player(ins.owner)!.id(),
      undefined,
      { region: this.label(op.region), tiles: gained },
    );
  }

  private expireSuppressions(ins: Insurgency, ticks: number): void {
    const spec = this.spec();
    for (const s of [...ins.suppressions]) {
      if (s.endTick > ticks) continue;
      ins.suppressions = ins.suppressions.filter((x) => x.id !== s.id);
      this.returnSuppressors(s, spec.suppressReturnPercent);
      this.dirty.add(ins.owner);
    }
  }

  private returnSuppressors(s: Suppression, percent: number): void {
    const occupier = this.player(s.occupier);
    if (occupier !== null) {
      occupier.addTroops(Math.floor((s.troops * percent) / 100));
    }
  }

  // ---- Regions ----

  private updateRegions(ins: Insurgency, ticks: number): void {
    const spec = this.spec();
    for (const region of ins.regions) {
      this.updateRegion(ins, region, ticks, false);
    }
    // Bases wear down under suppression, and are moot once their region is not occupied.
    for (const base of [...ins.bases]) {
      const region = this.region(ins, base.region);
      if (
        region === null ||
        region.status !== InsurgencyRegionStatus.Occupied
      ) {
        ins.bases = ins.bases.filter((b) => b.id !== base.id);
        continue;
      }
      if (this.isSuppressed(ins, base.region)) {
        base.integrity -= spec.suppressBaseDamage;
        if (base.integrity <= 0) this.destroyBase(ins, base);
      }
    }
    // An uprising in a suppressed region loses troops to it.
    const owner = this.player(ins.owner);
    if (owner !== null) {
      for (const op of ins.ops) {
        if (op.attackId === null || !this.isSuppressed(ins, op.region))
          continue;
        const attack = owner
          .outgoingAttacks()
          .find((a) => a.id() === op.attackId);
        if (attack !== undefined) {
          attack.setTroops(
            Math.floor(
              (attack.troops() * (100 - spec.suppressOpAttritionPercent)) / 100,
            ),
          );
        }
      }
    }
    this.dirty.add(ins.owner);
  }

  private isSuppressed(ins: Insurgency, region: number): boolean {
    return ins.suppressions.some((s) => s.region === region);
  }

  private destroyBase(ins: Insurgency, base: BaseState): void {
    ins.bases = ins.bases.filter((b) => b.id !== base.id);
    this.logEvent(ins, "base_lost", base.region);
    const owner = this.player(ins.owner);
    if (owner !== null) {
      this.mg.displayMessage(
        "events_display.insurgency_base_destroyed",
        MessageType.INSURGENCY_WARNING,
        owner.id(),
        undefined,
        { region: this.label(base.region) },
      );
    }
    for (const s of ins.suppressions) {
      if (s.region !== base.region) continue;
      const occupier = this.player(s.occupier);
      if (occupier !== null && occupier.type() === PlayerType.Human) {
        this.mg.displayMessage(
          "events_display.insurgency_base_destroyed_occupier",
          MessageType.INSURGENCY_ORDER,
          occupier.id(),
          undefined,
          { region: this.label(base.region) },
        );
      }
    }
  }

  private updateRegion(
    ins: Insurgency,
    region: RegionState,
    ticks: number,
    initial: boolean,
  ): void {
    const spec = this.spec();
    const m = this.measure(ins, region.id);
    const previous = region.status;
    const status = this.classify(spec, region.former, m);
    // Who held it until now: a region that has just been won back is named for
    // the player it was won from.
    const formerOccupier = region.occupier;
    region.occupier = m.primary;

    if (status === InsurgencyRegionStatus.Held) {
      if (previous === InsurgencyRegionStatus.Occupied) {
        this.regionReclaimed(ins, region, formerOccupier);
      }
      region.status = status;
      region.unrest = 0;
      region.warned = false;
      return;
    }

    if (status === InsurgencyRegionStatus.Occupied) {
      if (previous !== InsurgencyRegionStatus.Occupied) {
        // Taken from (or never held by) the owner: starts restless, capped by
        // how often it has changed hands.
        if (previous === InsurgencyRegionStatus.Held && region.reclaimedOnce) {
          region.flips += 1;
        }
        region.unrest = Math.min(
          unrestCap(spec, region.flips),
          startingUnrest(spec, region.former, this.grid().size ** 2),
        );
        region.status = status;
        return;
      }
      region.status = status;
      if (initial) return;
      const occupier = this.player(region.occupier);
      const fill =
        occupier === null
          ? 1000
          : fillPermille(
              occupier.troops(),
              this.mg.config().maxTroops(occupier),
            );
      region.unrest = nextUnrest(spec, {
        unrest: region.unrest,
        occupied: true,
        occupierFillPermille: fill,
        hasBase: ins.bases.some((b) => b.region === region.id),
        hasOperation: ins.ops.some((o) => o.region === region.id),
        suppressed: this.isSuppressed(ins, region.id),
        flips: region.flips,
      });
      this.warnOccupier(ins, region, occupier);
      return;
    }

    // Contested: neither side holds most of it. It keeps what it had.
    region.status = status;
  }

  /** The occupier hears once when a region becomes volatile, and again only after it has settled. */
  private warnOccupier(
    ins: Insurgency,
    region: RegionState,
    occupier: Player | null,
  ): void {
    const spec = this.spec();
    if (region.unrest < spec.volatileRearmAt) region.warned = false;
    if (region.unrest < spec.volatileAt || region.warned) return;
    region.warned = true;
    if (occupier !== null && occupier.type() === PlayerType.Human) {
      this.mg.displayMessage(
        region.unrest >= 100
          ? "events_display.insurgency_region_uprising"
          : "events_display.insurgency_region_volatile",
        MessageType.INSURGENCY_WARNING,
        occupier.id(),
        undefined,
        {
          region: this.label(region.id),
          name: this.player(ins.owner)?.displayName() ?? "",
        },
      );
    }
  }

  private regionReclaimed(
    ins: Insurgency,
    region: RegionState,
    formerOccupier: number,
  ): void {
    const spec = this.spec();
    region.flips += 1;
    region.reclaimedOnce = true;
    ins.bases = ins.bases.filter((b) => b.region !== region.id);
    let reward = 0n;
    if (!region.rewarded) {
      region.rewarded = true;
      ins.reclaimed += 1;
      ins.funds += spec.reclaimFunds;
      reward = spec.reclaimFunds;
      ins.deadline = survivalDeadline(spec, ins.startTick, ins.reclaimed);
      // Winning land back also shortens the CRISIS: the owner is recovering.
      const crisisOwner = this.player(ins.owner);
      if (
        crisisOwner !== null &&
        this.mg
          .capitals()
          ?.shortenCrisis(crisisOwner, spec.reclaimCrisisReductionTicks) ===
          true
      ) {
        this.mg.displayMessage(
          "events_display.insurgency_crisis_shortened",
          MessageType.INSURGENCY_ORDER,
          crisisOwner.id(),
          undefined,
          {
            region: this.label(region.id),
            seconds: Math.round(spec.reclaimCrisisReductionTicks / 10),
          },
        );
      }
    }
    this.logEvent(ins, "reclaimed", region.id, Number(reward));
    const owner = this.player(ins.owner);
    const occupier = this.player(formerOccupier);
    if (owner !== null) {
      this.mg.displayMessage(
        "events_display.insurgency_region_reclaimed",
        MessageType.INSURGENCY_ORDER,
        owner.id(),
        undefined,
        { region: this.label(region.id) },
      );
      this.mg.matchEvents().regionReclaimed(owner, occupier);
    }
  }

  // ---- Life and death ----

  private checkLife(ins: Insurgency, ticks: number): void {
    const spec = this.spec();
    const owner = this.player(ins.owner);
    if (owner === null) return;
    const alive = owner.isAlive();
    if (!alive && ins.limboSince < 0) {
      ins.limboSince = ticks;
      ins.limboDeadline = ticks + spec.limboTicks;
      ins.limboWarned = false;
      this.logEvent(ins, "limbo", ins.limboDeadline);
      this.mg.displayMessage(
        "events_display.insurgency_limbo",
        MessageType.INSURGENCY_WARNING,
        owner.id(),
        undefined,
        { minutes: Math.round(spec.limboTicks / 600) },
      );
    } else if (alive && ins.limboSince >= 0) {
      ins.limboSince = -1;
      ins.limboDeadline = -1;
      this.logEvent(ins, "restored");
      this.mg.displayMessage(
        "events_display.insurgency_restored",
        MessageType.INSURGENCY_ORDER,
        owner.id(),
      );
    }

    // No way left to raise a new force: nothing in the field, nothing coming,
    // and not the means to buy any.
    const exhausted =
      this.totalTroops(ins) === 0 &&
      (ins.funds < recruitCost(spec, spec.recruitMinTroops) ||
        !this.hasLocation(ins));
    if (!alive && exhausted) {
      this.end(ins, "exhausted", ticks);
      return;
    }
    if (!alive && ticks >= ins.limboDeadline) {
      this.end(ins, "limbo_expired", ticks);
      return;
    }
    if (ticks >= ins.deadline) {
      this.end(ins, "survival_expired", ticks);
      return;
    }
    if (
      !ins.limboWarned &&
      ins.limboSince >= 0 &&
      ins.limboDeadline - ticks <= spec.warnTicks
    ) {
      ins.limboWarned = true;
      this.mg.displayMessage(
        "events_display.insurgency_limbo_expiring",
        MessageType.INSURGENCY_WARNING,
        owner.id(),
        undefined,
        { seconds: Math.round((ins.limboDeadline - ticks) / 10) },
      );
    }
    if (!ins.warned && ins.deadline - ticks <= spec.warnTicks) {
      ins.warned = true;
      this.mg.displayMessage(
        "events_display.insurgency_expiring",
        MessageType.INSURGENCY_WARNING,
        owner.id(),
        undefined,
        { seconds: Math.round((ins.deadline - ticks) / 10) },
      );
    }
    if (exhausted && alive && ins.limboSince < 0) {
      // Land to stand on, but nothing left to fight with: it ends quietly.
      this.end(ins, "exhausted", ticks);
    }
  }

  /** The resistance is over. A player it was keeping alive without land is eliminated now. */
  private end(ins: Insurgency, reason: EndReason, ticks: number): void {
    if (ins.status === "ended") return;
    const owner = this.player(ins.owner);
    ins.status = "ended";
    ins.endReason = reason;
    ins.endTick = ticks;
    this.logEvent(ins, "end", 0, 0);

    // Uprisings in the field stand down; suppressing troops come home whole.
    if (owner !== null) {
      for (const op of ins.ops) {
        if (op.attackId === null) continue;
        owner
          .outgoingAttacks()
          .find((a) => a.id() === op.attackId)
          ?.executeRetreat();
      }
    }
    for (const s of ins.suppressions) this.returnSuppressors(s, 100);
    ins.ops = [];
    ins.bases = [];
    ins.recruits = [];
    ins.suppressions = [];
    ins.available = 0;

    if (owner !== null) {
      // Its land was exempt from the enclosure rule; now it is not.
      if (owner.isAlive()) this.mg.retryEnclosure(owner);
      this.mg.displayMessage(
        owner.isAlive()
          ? "events_display.insurgency_dissolved"
          : "events_display.insurgency_defeated",
        MessageType.INSURGENCY_ENDED,
        owner.id(),
      );
      this.mg.matchEvents().insurgencyEnded(owner, reason);
      if (!owner.isAlive()) {
        this.mg.finalizeElimination(this.player(ins.conqueror), owner);
      }
    }
    this.dirty.add(ins.owner);
  }

  /** The match has been decided: everything stands down, once. */
  private matchOver(ticks: number): void {
    if (this.matchOverHandled) return;
    this.matchOverHandled = true;
    for (const ins of this.list) {
      if (ins.status === "active") this.end(ins, "match_over", ticks);
    }
    this.emitDirty(ticks, true);
  }

  // ---- What the clients are told ----

  private emitDirty(ticks: number, force: boolean = false): void {
    for (const ins of this.list) {
      if (!this.dirty.has(ins.owner)) continue;
      const last = this.lastEmit.get(ins.owner);
      if (!force && last !== undefined && ticks - last < 5) continue;
      this.dirty.delete(ins.owner);
      this.lastEmit.set(ins.owner, ticks);
      this.mg.addUpdate({
        type: GameUpdateType.InsurgencyState,
        tick: ticks,
        view: this.view(ins),
      });
    }
  }

  view(ins: Insurgency): InsurgencyView {
    const spec = this.spec();
    const owner = this.player(ins.owner);
    const deployed = this.deployed(ins);
    const total = ins.available + deployed + this.pendingTroops(ins);
    const now = this.mg.ticks();
    return {
      owner: ins.owner,
      phase:
        ins.status === "ended"
          ? InsurgencyPhase.Ended
          : ins.limboSince >= 0
            ? InsurgencyPhase.Limbo
            : InsurgencyPhase.Field,
      endReason: ins.endReason,
      startTick: ins.startTick,
      deadline: ins.deadline,
      limboDeadline: ins.limboDeadline,
      startingTroops: ins.startingTroops,
      capacity: ins.capacity,
      available: ins.available,
      deployed,
      pending: ins.recruits.map((r) => ({
        troops: r.troops,
        arrives: r.arrives,
      })),
      funds: ins.funds,
      fundsStart: ins.fundsStart,
      strength: strength(total, ins.capacity),
      bases: ins.bases.map((b) => ({
        id: b.id,
        region: b.region,
        tile: b.tile,
        integrity: b.integrity,
      })),
      operations: ins.ops.map((o) => {
        const a =
          owner !== null && o.attackId !== null
            ? owner.outgoingAttacks().find((x) => x.id() === o.attackId)
            : undefined;
        return {
          id: o.id,
          region: o.region,
          committed: o.committed,
          troops: a?.troops() ?? 0,
          startTick: o.startTick,
        };
      }),
      regions: ins.regions.map((r) => ({
        id: r.id,
        former: r.former,
        status: r.status,
        band:
          r.status === InsurgencyRegionStatus.Occupied
            ? bandIndex(unrestBand(r.unrest))
            : 0,
        occupier: r.occupier,
        cooldownUntil: r.cooldownUntil,
        hasBase: ins.bases.some((b) => b.region === r.id),
        hasOperation: ins.ops.some((o) => o.region === r.id),
        suppressed: this.isSuppressed(ins, r.id),
        flips: r.flips,
        defense:
          r.status === InsurgencyRegionStatus.Occupied
            ? occupationDefensePercent(spec, r.unrest)
            : 0,
      })),
      // Precise only while fresh: a stale report is dropped from the view.
      intel: ins.intel
        .filter((i) => now - i.tick <= spec.intelFreshTicks)
        .map((i) => ({ ...i })),
      intelReadyTick: ins.intelReadyTick,
      suppressions: ins.suppressions.map((s) => ({
        region: s.region,
        occupier: s.occupier,
        endTick: s.endTick,
      })),
      reclaimed: ins.reclaimed,
    };
  }

  // ---- Hash and snapshots ----

  /** Folded into the game hash so a divergence here is caught at once. */
  hash(): number {
    let h = this.list.length * 7 + this.pending.size;
    for (const ins of this.list) {
      h += ins.owner * 31 + (ins.status === "active" ? 1 : 2);
      h += Math.floor(ins.available) + Number(ins.funds % 1_000_003n);
      for (const r of ins.regions) h += r.unrest * 3 + r.status + r.flips;
      h += ins.bases.length * 11 + ins.ops.length * 13 + ins.recruits.length;
    }
    return h;
  }

  snapshot(): InsurgencySystemState {
    return {
      list: this.list.map((i) => ({
        ...i,
        recruits: i.recruits.map((r) => ({ ...r })),
        regions: i.regions.map((r) => ({ ...r })),
        bases: i.bases.map((b) => ({ ...b })),
        ops: i.ops.map((o) => ({ ...o })),
        suppressions: i.suppressions.map((s) => ({ ...s })),
        intel: i.intel.map((x) => ({ ...x })),
      })),
      pending: [...this.pending].map(([owner, p]) => ({
        owner,
        conqueror: p.conqueror,
        army: p.army,
        profile: p.profile.map(([a, b]): [number, number] => [a, b]),
      })),
      log: this.logEntries.map((e) => ({ ...e })),
      matchOverHandled: this.matchOverHandled,
    };
  }

  restoreSnapshot(s: InsurgencySystemState): void {
    this.list = s.list.map((i) => ({
      ...i,
      endReason: i.endReason as EndReason | "",
      recruits: i.recruits.map((r) => ({ ...r })),
      regions: i.regions.map((r) => ({ ...r })),
      bases: i.bases.map((b) => ({ ...b })),
      ops: i.ops.map((o) => ({ ...o })),
      suppressions: i.suppressions.map((x) => ({ ...x })),
      intel: i.intel.map((x) => ({ ...x })),
    }));
    this.byOwner = new Map(this.list.map((i) => [i.owner, i]));
    this.pending = new Map(
      s.pending.map((p) => [
        p.owner,
        {
          conqueror: p.conqueror,
          army: p.army,
          profile: p.profile.map(([a, b]): [number, number] => [a, b]),
        },
      ]),
    );
    this.logEntries = s.log.map((e) => ({ ...e }));
    this.matchOverHandled = s.matchOverHandled;
    // Everything is sent again after a restore (and the throttle starts afresh:
    // `lastEmit` is delivery bookkeeping, not part of the game).
    this.lastEmit = new Map();
    this.dirty = new Set(this.list.map((i) => i.owner));
    this.gridCache = null;
  }
}

function bandIndex(band: ReturnType<typeof unrestBand>): number {
  switch (band) {
    case "stable":
      return 0;
    case "unsettled":
      return 1;
    case "unrestful":
      return 2;
    case "volatile":
      return 3;
    case "uprising":
      return 4;
  }
}

/** Whether `tile` lies in `region` (used by the client's map picking, mirrored here for tests). */
export function tileInRegion(
  grid: RegionGrid,
  region: number,
  x: number,
  y: number,
): boolean {
  return inBounds(regionBounds(grid, region), x, y);
}
