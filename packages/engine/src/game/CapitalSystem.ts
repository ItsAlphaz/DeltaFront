import { TileRef } from "@openfront/engine-api/game/GameMap";
import { MessageType, PlayerType } from "@openfront/engine-api/game/GameTypes";
import {
  type CapitalEventKind,
  GameUpdateType,
} from "@openfront/engine-api/game/GameUpdates";
import {
  capitalBonusPercent,
  capturePairKey,
  captureTroopReward,
} from "@openfront/engine-lib/capital/CapitalRules";
import { renderNumber, renderTroops } from "@openfront/engine-lib/Format";
import { zInt, zTile } from "@openfront/engine-lib/snapshot/SnapshotType";
import { z } from "zod";
import type { Game, Player } from "./Game";

/**
 * The Capital System (docs/Capital.md): a seat of government for every human and
 * nation, what its capture costs the owner (CRISIS) and pays the captor, and the
 * way a human owner may found a replacement.
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
 * While a capital stands, gold income and troop regeneration get a small bonus
 * (a replacement ramps up to it). During CRISIS both are cut. PlayerExecution
 * applies the two percentages this class reports; nothing else reads them.
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
  /** Founded by the owner after losing a capital, not at the start of the game. */
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
  designated: z.array(zInt()),
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
  /** In the order the crises began. */
  private crises: CrisisRecord[] = [];
  private crisisByOwner = new Map<number, CrisisRecord>();
  /** smallIDs that have been given their founding capital. */
  private designated = new Set<number>();
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
    const capital = this.capitalOf(player);
    let percent = 100;
    if (capital !== null) {
      percent += capitalBonusPercent(
        this.mg.config().capitalSpec(),
        bonus,
        capital.replacement,
        this.mg.ticks() - capital.foundedTick,
      );
    }
    if (this.inCrisis(player)) {
      percent = Math.floor((percent * crisisPercent) / 100);
    }
    return percent;
  }

  // ---- Founding a replacement ----

  /** Why `player` cannot found a capital at `tile`, or null when it can. */
  foundBlock(player: Player, tile: TileRef): FoundBlock | null {
    if (!holdsCapital(player)) return "not_a_holder";
    if (this.mg.inSpawnPhase()) return "spawn_phase";
    if (!player.isAlive()) return "dead";
    if (this.capitalOf(player) !== null) return "has_capital";
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
    if (player.gold() < this.mg.config().capitalReplacementCost(player)) {
      return "gold";
    }
    return null;
  }

  /**
   * Founds a replacement capital, charging its cost. False (and nothing
   * charged) when it is not allowed: the caller is an execution fed by an
   * intent, so this is the one place the rules are enforced.
   */
  found(player: Player, tile: TileRef): boolean {
    if (this.foundBlock(player, tile) !== null) return false;
    player.removeGold(this.mg.config().capitalReplacementCost(player));
    this.designated.add(player.smallID());
    const capital = this.add(player, tile, true);
    this.mg.addUpdate({
      type: GameUpdateType.CapitalEvent,
      kind: "founded",
      tick: this.mg.ticks(),
      capitalId: capital.id,
      tile,
      owner: player.smallID(),
      captor: null,
      replacement: true,
      crisisEndTick: -1,
      rewardGold: 0n,
      rewardTroops: 0,
    });
    this.mg.displayMessage(
      "events_display.capital_founded",
      MessageType.CAPITAL_FOUNDED,
      player.id(),
    );
    return true;
  }

  // ---- The tick ----

  /** After every execution has run. Does nothing during the spawn phase. */
  tick(ticks: number): void {
    if (this.mg.inSpawnPhase()) return;
    this.designate();
    this.resolve(ticks);
    this.endCrises(ticks);
  }

  /** Founds the first capital of every holder that has spawned, once. */
  private designate(): void {
    for (const player of this.mg.allPlayers()) {
      if (!holdsCapital(player)) continue;
      if (this.designated.has(player.smallID())) continue;
      if (!player.hasSpawned() || !player.isAlive()) continue;
      this.designated.add(player.smallID());
      this.add(player, this.foundingTile(player), false);
    }
  }

  /** Where they spawned, or the first tile they still hold if that was lost. */
  private foundingTile(player: Player): TileRef {
    const spawn = player.spawnTile();
    if (spawn !== undefined && this.mg.owner(spawn) === player) return spawn;
    const [first] = player.tiles();
    if (first === undefined) throw new Error("a living player holds no tile");
    return first;
  }

  private add(player: Player, tile: TileRef, replacement: boolean) {
    const record: CapitalRecord = {
      id: this.nextId++,
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
    let h = this.nextId;
    for (const c of this.capitals) h += c.tile * 31 + c.owner * 7 + c.id;
    for (const c of this.crises) h += c.endTick * 13 + c.owner;
    return h;
  }

  snapshot(): CapitalSystemState {
    return {
      nextId: this.nextId,
      capitals: this.capitals.map((c) => ({ ...c })),
      crises: this.crises.map((c) => ({ ...c })),
      designated: [...this.designated],
      fallen: [...this.fallen],
      paid: [...this.paid],
      captures: [...this.captures],
    };
  }

  restoreSnapshot(s: CapitalSystemState): void {
    this.nextId = s.nextId;
    this.capitals = s.capitals.map((c) => ({ ...c }));
    this.capitalByOwner = new Map(this.capitals.map((c) => [c.owner, c]));
    this.crises = s.crises.map((c) => ({ ...c }));
    this.crisisByOwner = new Map(this.crises.map((c) => [c.owner, c]));
    this.designated = new Set(s.designated);
    this.fallen = new Map(s.fallen);
    this.paid = new Set(s.paid);
    this.captures = new Map(s.captures);
  }
}
