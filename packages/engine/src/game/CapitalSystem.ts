import { TileRef } from "@openfront/engine-api/game/GameMap";
import { MessageType, PlayerType } from "@openfront/engine-api/game/GameTypes";
import {
  type CapitalEventKind,
  GameUpdateType,
} from "@openfront/engine-api/game/GameUpdates";
import {
  capitalStrengthPercent,
  capturePairKey,
  captureTroopReward,
  scaleBonus,
  strainPercent,
  strainStartTick,
} from "@openfront/engine-lib/capital/CapitalRules";
import { renderNumber, renderTroops } from "@openfront/engine-lib/Format";
import { zInt, zTile } from "@openfront/engine-lib/snapshot/SnapshotType";
import { z } from "zod";
import type { Game, Player } from "./Game";

/**
 * The Capital System (docs/Capital.md): a seat of government every human and
 * nation buys (nobody starts with one), what its capture costs the owner
 * (CRISIS) and pays the captor, and the strain a nation without one comes under.
 *
 * ## Where its state lives
 *
 * Here, owned by the game like MatchEvents (one per game, only when the match
 * setting is on), not on the players or in a new unit type. A capital is a
 * place and an id, not a building, so it adds nothing to the unit wire enum,
 * the stats arrays or the sprite atlas. Everything is an integer, a tile or a
 * smallID, so it snapshots and hashes exactly.
 *
 * ## How a capital falls
 *
 * Once per tick, after every execution has run, each capital is compared with
 * who holds its tile. Polling the tile (rather than hooking the conquest) means
 * one rule covers every way land changes hands: an attack, a landing, an
 * enclosed pocket being absorbed, a small nation being annexed whole.
 *
 *  - held by an enemy player  -> CAPTURED: the owner enters CRISIS, the captor is
 *    paid (once per owner/captor pair, ever), the feed and both players hear of it;
 *  - held by a friend, or by no one (nuked, rotted, relinquished) -> DESTROYED:
 *    the capital is gone with no reward and no CRISIS.
 *
 * The capital is removed in the same call that reports its fall, so one capital
 * can produce exactly one event and one payment however the tile later moves.
 * Taking the tile back does not restore it: a replacement is a new capital, a
 * new id, a new cycle, and its capture pays the reduced replacement reward at
 * most once per captor.
 *
 * ## What it does to the economy
 *
 * While a capital stands, gold income and troop regeneration get a bonus (every
 * capital ramps up to it). Without one, once the opening grace is over, both
 * are cut by the strain, a slow and separate penalty from CRISIS: a nation in
 * CRISIS is never also strained. During CRISIS both are halved. PlayerExecution
 * applies the two percentages this class reports; the rest of a capital's
 * bonuses (troop cap, cheaper structures, fewer attacking losses) are asked for
 * through `strengthOf`.
 */

/** Percent factor of a player's gold income / troop regeneration. */
export type EconomyPercent = number;

export interface CapitalRecord {
  /** Never reused: it names one ownership cycle. */
  readonly id: number;
  /** smallID of the owner. */
  readonly owner: number;
  readonly tile: TileRef;
  readonly foundedTick: number;
  /** Bought by an owner who had lost a capital before (the first is not a replacement). */
  readonly replacement: boolean;
}

/** A capital that has been bought and is being built: it gives nothing yet. */
export interface CapitalBuildRecord {
  /** The id the capital will have when it stands. */
  readonly id: number;
  /** smallID of the owner. */
  readonly owner: number;
  readonly tile: TileRef;
  readonly startTick: number;
  readonly endTick: number;
  readonly replacement: boolean;
}

export interface CrisisRecord {
  readonly owner: number;
  readonly startTick: number;
  readonly endTick: number;
  /** The capital whose fall started it. */
  readonly capitalId: number;
  /** smallID of the captor. */
  readonly captor: number;
  /** The end has been announced (once). */
  ended: boolean;
}

/** Why a player cannot found a capital right now. */
export type FoundBlock =
  | "not_a_holder"
  | "spawn_phase"
  | "dead"
  | "has_capital"
  | "building"
  | "too_soon"
  | "gold"
  | "tile"
  | "not_owned"
  | "border";

export const CapitalSystemStateSchema = z.object({
  nextId: zInt(),
  capitals: z.array(
    z.object({
      id: zInt(),
      owner: zInt(),
      tile: zTile(),
      foundedTick: zInt(),
      replacement: z.boolean(),
    }),
  ),
  building: z.array(
    z.object({
      id: zInt(),
      owner: zInt(),
      tile: zTile(),
      startTick: zInt(),
      endTick: zInt(),
      replacement: z.boolean(),
    }),
  ),
  crises: z.array(
    z.object({
      owner: zInt(),
      startTick: zInt(),
      endTick: zInt(),
      capitalId: zInt(),
      captor: zInt(),
      ended: z.boolean(),
    }),
  ),
  /** The tick the match left its spawn phase (-1 before). */
  startTick: zInt(),
  fallen: z.array(z.tuple([zInt(), zInt()])),
  paid: z.array(z.string()),
  captures: z.array(z.tuple([zInt(), zInt()])),
});
export type CapitalSystemState = z.infer<typeof CapitalSystemStateSchema>;

/** Humans and nations have a capital; tribes (bots) are fill and have none. */
export function holdsCapital(player: Player): boolean {
  return (
    player.type() === PlayerType.Human || player.type() === PlayerType.Nation
  );
}

export class CapitalSystem {
  private nextId = 1;
  /** In founding order (the order is state: it is iterated every tick). */
  private capitals: CapitalRecord[] = [];
  /** owner smallID -> its standing capital; kept in step with `capitals`. */
  private capitalByOwner = new Map<number, CapitalRecord>();
  /** Capitals being built, in the order they were bought (the order is state). */
  private building: CapitalBuildRecord[] = [];
  private buildingByOwner = new Map<number, CapitalBuildRecord>();
  /** In the order the crises began. */
  private crises: CrisisRecord[] = [];
  private crisisByOwner = new Map<number, CrisisRecord>();
  /** The tick the match left its spawn phase: where the strain's grace begins. */
  private startTick = -1;
  /** owner smallID -> tick its latest capital fell or was destroyed. */
  private fallen = new Map<number, number>();
  /** `owner:captor` pairs a capture has already been paid for. */
  private paid = new Set<string>();
  /** captor smallID -> capitals it has captured (paid or not). */
  private captures = new Map<number, number>();

  constructor(private readonly mg: Game) {}

  // ---- Queries ----

  capitalOf(player: Player): CapitalRecord | null {
    return this.capitalByOwner.get(player.smallID()) ?? null;
  }

  /** The capital the player is building, or null. */
  buildingOf(player: Player): CapitalBuildRecord | null {
    return this.buildingByOwner.get(player.smallID()) ?? null;
  }

  /** The tile of the player's capital, or -1 for none (a wire-safe "no"). */
  capitalTileOf(player: Player): number {
    return this.capitalOf(player)?.tile ?? -1;
  }

  /** The player's latest crisis (running or over), or null if it never had one. */
  crisisOf(player: Player): CrisisRecord | null {
    return this.crisisByOwner.get(player.smallID()) ?? null;
  }

  inCrisis(player: Player): boolean {
    const crisis = this.crisisOf(player);
    return crisis !== null && this.mg.ticks() < crisis.endTick;
  }

  /** How many capitals `captor` has captured. */
  capturesBy(captor: Player): number {
    return this.captures.get(captor.smallID()) ?? 0;
  }

  /** Whether `captor` has been paid for capturing a capital of `owner`. */
  hasBeenPaid(owner: Player, captor: Player): boolean {
    return this.paid.has(capturePairKey(owner.smallID(), captor.smallID()));
  }

  /**
   * How much of its bonuses the player's capital gives: 0 with none, else 50 to
   * 100 as it ramps in. The one number every bonus is scaled by.
   */
  strengthOf(player: Player): number {
    const capital = this.capitalOf(player);
    if (capital === null) return 0;
    return capitalStrengthPercent(
      this.mg.config().capitalSpec(),
      this.mg.ticks() - capital.foundedTick,
    );
  }

  /**
   * The tick the strain of having no capital begins for the player, or -1 when
   * it has one or cannot hold one. Counted from the start of the match, or from
   * the end of its last CRISIS (or loss) so a fallen capital is given time to
   * be rebought; never from the CRISIS itself.
   */
  strainStartOf(player: Player): number {
    if (this.startTick < 0 || !holdsCapital(player)) return -1;
    if (this.capitalOf(player) !== null) return -1;
    return strainStartTick(
      this.mg.config().capitalSpec(),
      this.strainSince(player),
    );
  }

  /** Percent of income and troop regeneration the player's strain takes now. */
  strainOf(player: Player): number {
    if (this.startTick < 0 || !holdsCapital(player)) return 0;
    if (this.capitalOf(player) !== null || this.inCrisis(player)) return 0;
    return strainPercent(
      this.mg.config().capitalSpec(),
      this.strainSince(player),
      this.mg.ticks(),
    );
  }

  /** Whether the player has lost a capital this match (captured or destroyed). */
  hasLostCapital(player: Player): boolean {
    return this.fallen.has(player.smallID());
  }

  /** Ticks since the match left its spawn phase (0 during it). */
  ticksSinceStart(): number {
    return this.startTick < 0 ? 0 : this.mg.ticks() - this.startTick;
  }

  private strainSince(player: Player): number {
    const crisis = this.crisisOf(player);
    const fell = this.fallen.get(player.smallID());
    // The later of the match's start, the last CRISIS's end and the last loss:
    // a capital destroyed after an old CRISIS restarts the grace too.
    return Math.max(this.startTick, crisis?.endTick ?? -1, fell ?? -1);
  }

  /** Percent of normal gold income the player earns now (100 = normal). */
  incomePercent(player: Player): EconomyPercent {
    const spec = this.mg.config().capitalSpec();
    return this.economyPercent(
      player,
      spec.bonusIncomePercent,
      spec.crisisIncomePercent,
    );
  }

  /** Percent of normal troop regeneration the player gets now (100 = normal). */
  regenPercent(player: Player): EconomyPercent {
    const spec = this.mg.config().capitalSpec();
    return this.economyPercent(
      player,
      spec.bonusRegenPercent,
      spec.crisisRegenPercent,
    );
  }

  private economyPercent(
    player: Player,
    bonus: number,
    crisisPercent: number,
  ): EconomyPercent {
    let percent = 100;
    if (this.capitalOf(player) !== null) {
      percent += scaleBonus(bonus, this.strengthOf(player));
    } else {
      percent -= this.strainOf(player);
    }
    if (this.inCrisis(player)) {
      percent = Math.floor((percent * crisisPercent) / 100);
    }
    return percent;
  }

  // ---- Buying a capital ----

  /** Why `player` cannot found a capital at `tile`, or null when it can. */
  foundBlock(player: Player, tile: TileRef): FoundBlock | null {
    if (!holdsCapital(player)) return "not_a_holder";
    if (this.mg.inSpawnPhase()) return "spawn_phase";
    if (!player.isAlive()) return "dead";
    if (this.capitalOf(player) !== null) return "has_capital";
    if (this.buildingOf(player) !== null) return "building";
    // Only a replacement waits: the first capital can be bought as soon as the
    // player can pay (a player that never had one has no fall on record).
    const fell = this.fallen.get(player.smallID());
    const spec = this.mg.config().capitalSpec();
    if (
      fell !== undefined &&
      this.mg.ticks() - fell < spec.replacementDelayTicks
    ) {
      return "too_soon";
    }
    if (!this.mg.isValidRef(tile) || !this.mg.isLand(tile)) return "tile";
    if (this.mg.owner(tile) !== player) return "not_owned";
    // Not on the front: a capital on the border would fall to the first push.
    if (player.borderTiles().has(tile)) return "border";
    if (player.gold() < this.mg.config().capitalCost(player)) {
      return "gold";
    }
    return null;
  }

  /**
   * Buys a capital, charging its cost. False (and nothing charged) when it is
   * not allowed: the caller is an execution fed by an intent, so this is the one
   * place the rules are enforced.
   */
  found(player: Player, tile: TileRef): boolean {
    if (this.foundBlock(player, tile) !== null) return false;
    player.removeGold(this.mg.config().capitalCost(player));
    const replacement = this.fallen.has(player.smallID());
    const duration = this.mg.config().capitalBuildTicks();
    const now = this.mg.ticks();
    const build: CapitalBuildRecord = {
      id: this.nextId++,
      owner: player.smallID(),
      tile,
      startTick: now,
      endTick: now + duration,
      replacement,
    };
    if (duration <= 0) {
      this.complete(build, player);
      return true;
    }
    this.building.push(build);
    this.buildingByOwner.set(build.owner, build);
    this.emitBuild("building", build);
    this.mg.displayMessage(
      "events_display.capital_building",
      MessageType.CAPITAL_FOUNDED,
      player.id(),
      undefined,
      { seconds: Math.ceil(duration / 10) },
    );
    return true;
  }

  /** The construction is over: the capital stands. */
  private complete(build: CapitalBuildRecord, player: Player): void {
    const capital = this.add(player, build.tile, build.replacement, build.id);
    this.emit("founded", capital, null, -1, 0n, 0);
    this.mg.displayMessage(
      "events_display.capital_founded",
      MessageType.CAPITAL_FOUNDED,
      player.id(),
    );
  }

  /** Builds that are finished or lost, once per tick. */
  private advanceBuilds(ticks: number): void {
    for (const build of [...this.building]) {
      const owner = this.mg.playerBySmallID(build.owner);
      const holds =
        owner.isPlayer() &&
        owner.isAlive() &&
        this.mg.owner(build.tile) === owner;
      if (!holds) {
        this.dropBuild(build);
        this.emitBuild("cancelled", build);
        if (owner.isPlayer() && owner.isAlive()) {
          this.mg.displayMessage(
            "events_display.capital_build_lost",
            MessageType.CAPITAL_LOST,
            owner.id(),
          );
        }
      } else if (ticks >= build.endTick) {
        this.dropBuild(build);
        this.complete(build, owner);
      }
    }
  }

  private dropBuild(build: CapitalBuildRecord): void {
    this.building = this.building.filter((b) => b.id !== build.id);
    this.buildingByOwner.delete(build.owner);
  }

  // ---- The tick ----

  /** After every execution has run. Does nothing during the spawn phase. */
  tick(ticks: number): void {
    if (this.mg.inSpawnPhase()) return;
    if (this.startTick < 0) this.startTick = ticks;
    this.advanceBuilds(ticks);
    this.resolve(ticks);
    this.endCrises(ticks);
  }

  private add(
    player: Player,
    tile: TileRef,
    replacement: boolean,
    id: number = this.nextId++,
  ) {
    const record: CapitalRecord = {
      id,
      owner: player.smallID(),
      tile,
      foundedTick: this.mg.ticks(),
      replacement,
    };
    this.capitals.push(record);
    this.capitalByOwner.set(record.owner, record);
    return record;
  }

  /** Compares every capital with who holds its tile. */
  private resolve(ticks: number): void {
    for (const capital of [...this.capitals]) {
      const owner = this.mg.playerBySmallID(capital.owner);
      if (!owner.isPlayer()) continue;
      const holder = this.mg.owner(capital.tile);
      if (holder === owner) continue;
      if (holder.isPlayer() && !holder.isFriendly(owner)) {
        this.capture(capital, owner, holder, ticks);
      } else {
        this.destroy(capital, owner, ticks);
      }
    }
  }

  private remove(capital: CapitalRecord, ticks: number): void {
    this.capitals = this.capitals.filter((c) => c.id !== capital.id);
    this.capitalByOwner.delete(capital.owner);
    this.fallen.set(capital.owner, ticks);
  }

  private destroy(capital: CapitalRecord, owner: Player, ticks: number): void {
    this.remove(capital, ticks);
    this.emit("destroyed", capital, null, -1, 0n, 0);
    if (owner.isAlive()) {
      this.mg.displayMessage(
        "events_display.capital_destroyed",
        MessageType.CAPITAL_LOST,
        owner.id(),
      );
    }
  }

  private capture(
    capital: CapitalRecord,
    owner: Player,
    captor: Player,
    ticks: number,
  ): void {
    this.remove(capital, ticks);
    const spec = this.mg.config().capitalSpec();

    // One payment per owner/captor pair, ever: a rebuilt capital taken again by
    // the same player, or a pair trading a capital back and forth, pays nothing.
    const key = capturePairKey(owner.smallID(), captor.smallID());
    let rewardGold = 0n;
    let rewardTroops = 0;
    if (!this.paid.has(key)) {
      this.paid.add(key);
      rewardGold = capital.replacement
        ? spec.captureGoldReplacement
        : spec.captureGold;
      rewardTroops = captureTroopReward(
        spec,
        this.mg.config().maxTroops(captor),
        captor.troops(),
      );
      captor.addGold(rewardGold);
      captor.addTroops(rewardTroops);
      // The same once-per-pair rule pays XP: only a paid capture is recorded.
      this.mg.stats().recordCapitalCapture(captor, owner, ticks);
    }
    this.captures.set(captor.smallID(), this.capturesBy(captor) + 1);

    // The fall of a capital may start the owner's resistance (a human with an
    // army to rise from and national land). That also keeps them in the game
    // with no land, so they have a crisis to live through.
    const resisting =
      this.mg.insurgency()?.activate(owner, captor, capital.id, ticks) ?? false;

    // A player with no land left and no resistance has nothing to be in crisis over.
    let crisisEnd = -1;
    if (owner.isAlive() || resisting) {
      crisisEnd = ticks + this.mg.config().crisisDurationTicks();
      this.crises = this.crises.filter((c) => c.owner !== capital.owner);
      const crisis: CrisisRecord = {
        owner: capital.owner,
        startTick: ticks,
        endTick: crisisEnd,
        capitalId: capital.id,
        captor: captor.smallID(),
        ended: false,
      };
      this.crises.push(crisis);
      this.crisisByOwner.set(capital.owner, crisis);
    }

    this.emit("captured", capital, captor, crisisEnd, rewardGold, rewardTroops);
    this.mg.matchEvents().capitalCaptured(captor, owner, capital.replacement);
    this.mg.displayMessage(
      rewardGold > 0n || rewardTroops > 0
        ? "events_display.capital_captured_reward"
        : "events_display.capital_captured_unpaid",
      MessageType.CAPITAL_CAPTURED,
      captor.id(),
      rewardGold,
      {
        name: owner.displayName(),
        gold: renderNumber(rewardGold),
        troops: renderTroops(rewardTroops),
      },
      undefined,
      owner.id(),
    );
    this.mg.displayMessage(
      "events_display.capital_lost",
      MessageType.CAPITAL_LOST,
      owner.id(),
      undefined,
      {
        name: captor.displayName(),
        minutes: Math.round(this.mg.config().crisisDurationTicks() / 600),
      },
      undefined,
      captor.id(),
    );
  }

  private emitBuild(kind: CapitalEventKind, build: CapitalBuildRecord): void {
    this.mg.addUpdate({
      type: GameUpdateType.CapitalEvent,
      kind,
      tick: this.mg.ticks(),
      capitalId: build.id,
      tile: build.tile,
      owner: build.owner,
      captor: null,
      replacement: build.replacement,
      crisisEndTick: -1,
      rewardGold: 0n,
      rewardTroops: 0,
      completeTick: build.endTick,
    });
  }

  private emit(
    kind: CapitalEventKind,
    capital: CapitalRecord,
    captor: Player | null,
    crisisEndTick: number,
    rewardGold: bigint,
    rewardTroops: number,
  ): void {
    this.mg.addUpdate({
      type: GameUpdateType.CapitalEvent,
      kind,
      tick: this.mg.ticks(),
      capitalId: capital.id,
      tile: capital.tile,
      owner: capital.owner,
      captor: captor === null ? null : captor.smallID(),
      replacement: capital.replacement,
      crisisEndTick,
      rewardGold,
      rewardTroops,
    });
  }

  /** Announces each crisis's end once. The crisis never eliminates anyone. */
  private endCrises(ticks: number): void {
    for (const crisis of this.crises) {
      if (crisis.ended || ticks < crisis.endTick) continue;
      crisis.ended = true;
      const owner = this.mg.playerBySmallID(crisis.owner);
      if (owner.isPlayer() && owner.isAlive()) {
        this.mg.displayMessage(
          "events_display.crisis_ended",
          MessageType.CRISIS_ENDED,
          owner.id(),
        );
      }
    }
  }

  // ---- Hash and snapshots ----

  /** Folded into the game hash so a divergence here is caught at once. */
  hash(): number {
    let h = this.nextId + this.startTick;
    for (const c of this.capitals) h += c.tile * 31 + c.owner * 7 + c.id;
    for (const c of this.crises) h += c.endTick * 13 + c.owner;
    for (const b of this.building) h += b.tile * 17 + b.endTick + b.owner * 5;
    return h;
  }

  snapshot(): CapitalSystemState {
    return {
      nextId: this.nextId,
      capitals: this.capitals.map((c) => ({ ...c })),
      building: this.building.map((b) => ({ ...b })),
      crises: this.crises.map((c) => ({ ...c })),
      startTick: this.startTick,
      fallen: [...this.fallen],
      paid: [...this.paid],
      captures: [...this.captures],
    };
  }

  restoreSnapshot(s: CapitalSystemState): void {
    this.nextId = s.nextId;
    this.capitals = s.capitals.map((c) => ({ ...c }));
    this.capitalByOwner = new Map(this.capitals.map((c) => [c.owner, c]));
    this.building = s.building.map((b) => ({ ...b }));
    this.buildingByOwner = new Map(this.building.map((b) => [b.owner, b]));
    this.crises = s.crises.map((c) => ({ ...c }));
    this.crisisByOwner = new Map(this.crises.map((c) => [c.owner, c]));
    this.startTick = s.startTick;
    this.fallen = new Map(s.fallen);
    this.paid = new Set(s.paid);
    this.captures = new Map(s.captures);
  }
}
