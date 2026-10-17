import { TileRef } from "@openfront/engine-api/game/GameMap";
import {
  Structures,
  TerraNullius,
  UnitType,
} from "@openfront/engine-api/game/GameTypes";
import {
  alongTrack,
  Corridor,
  corridorEdge,
  crossTrack,
} from "@openfront/engine-lib/airstrike/AirstrikeGeometry";
import {
  airstrikeArmyLoss,
  airstrikeTroopLoss,
} from "@openfront/engine-lib/airstrike/AirstrikeRules";
import {
  AIRSTRIKE_CITY_AREA_RADIUS,
  type AirstrikeSpec,
} from "@openfront/engine-lib/configuration/Config";
import { Attack, Game, Player, Unit } from "../../game/Game";

/** Damage dealt to one player so far: [smallID, troops killed, structure levels removed]. */
export type DamageTotal = [smallID: number, killed: number, levels: number];

/**
 * Whether an airstrike by `attacker` may hurt `owner` right now.
 *
 * The one gate for every troop and structure effect of every strike type:
 * the attacker's own players, allies and teammates (disconnected ones too, as
 * for nukes) and unowned land are never hurt, even inside the area of effect.
 */
export function isAirstrikeVictim(
  attacker: Player,
  owner: Player | TerraNullius,
): owner is Player {
  return (
    owner.isPlayer() && owner !== attacker && !attacker.isFriendly(owner, true)
  );
}

export function addDamage(
  totals: DamageTotal[],
  smallID: number,
  killed: number,
  levels: number,
): void {
  const existing = totals.find((t) => t[0] === smallID);
  if (existing === undefined) {
    totals.push([smallID, killed, levels]);
  } else {
    existing[1] += killed;
    existing[2] += levels;
  }
}

/** What one strike application did to troops. */
export interface TroopDamage {
  /** smallIDs of the players whose land was hit. */
  affected: number[];
  /** Troops killed, garrisons and attacks together. */
  killed: number;
  /** Highest level of a victim city whose garrison took the city bonus (0: none). */
  cityLevel: number;
}

/**
 * The highest level of each victim's finished cities within
 * AIRSTRIKE_CITY_AREA_RADIUS of any tile of the area. One number per victim, so
 * several cities in reach still give one city bonus, never one per city.
 */
export function victimCityLevels(
  game: Game,
  attacker: Player,
  tiles: readonly TileRef[],
): Map<Player, number> {
  const levels = new Map<Player, number>();
  if (tiles.length === 0) return levels;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const t of tiles) {
    const x = game.x(t);
    const y = game.y(t);
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  const cx = Math.round((minX + maxX) / 2);
  const cy = Math.round((minY + maxY) / 2);
  const halfW = (maxX - minX) / 2 + 1;
  const halfH = (maxY - minY) / 2 + 1;
  const reach =
    Math.sqrt(halfW * halfW + halfH * halfH) + AIRSTRIKE_CITY_AREA_RADIUS;
  const r2 = AIRSTRIKE_CITY_AREA_RADIUS * AIRSTRIKE_CITY_AREA_RADIUS;
  for (const { unit } of game.nearbyUnits(
    game.ref(cx, cy),
    reach,
    UnitType.City,
  )) {
    if (!unit.isActive() || unit.isUnderConstruction()) continue;
    const owner = unit.owner();
    if (!isAirstrikeVictim(attacker, owner)) continue;
    const ux = game.x(unit.tile());
    const uy = game.y(unit.tile());
    let near = false;
    for (const t of tiles) {
      const dx = game.x(t) - ux;
      const dy = game.y(t) - uy;
      if (dx * dx + dy * dy <= r2) {
        near = true;
        break;
      }
    }
    if (!near) continue;
    levels.set(owner, Math.max(levels.get(owner) ?? 0, unit.level()));
  }
  return levels;
}

/** The troop losses a strike application would cause right now (reads only). */
export interface TroopDamagePlan {
  /** Victims in tile scan order: land hit, city bonus level, garrison deaths. */
  victims: {
    victim: Player;
    hit: number;
    cityLevel: number;
    garrison: number;
  }[];
  /** Victims' attacks whose front runs through the area, and their deaths. */
  attacks: { victim: Player; attack: Attack; deaths: number }[];
}

/**
 * What a strike on `tiles` would kill, without changing anything: the share of
 * each victim's garrison (times the city bonus when one of their cities is in
 * reach) and the share of each of their attacks whose front runs through the
 * area. The strike itself (`applyTroopDamage`) and the nation AI's estimate
 * both use it, so the AI values a strike exactly as it will land.
 */
export function planTroopDamage(
  game: Game,
  attacker: Player,
  tiles: readonly TileRef[],
  spec: AirstrikeSpec,
): TroopDamagePlan {
  // Map insertion order = tile scan order, so the result is deterministic.
  const hitPerPlayer = new Map<Player, number>();
  for (const tile of tiles) {
    const owner = game.owner(tile);
    if (!isAirstrikeVictim(attacker, owner)) continue;
    hitPerPlayer.set(owner, (hitPerPlayer.get(owner) ?? 0) + 1);
  }
  const plan: TroopDamagePlan = { victims: [], attacks: [] };
  if (tiles.length === 0) return plan;
  const area = new Set(tiles);
  const cities = victimCityLevels(game, attacker, tiles);
  for (const [victim, hit] of hitPerPlayer) {
    const cityLevel = cities.get(victim) ?? 0;
    plan.victims.push({
      victim,
      hit,
      cityLevel,
      garrison: airstrikeTroopLoss(
        spec,
        victim.troops(),
        hit,
        victim.numTilesOwned(),
        cityLevel,
      ),
    });
  }

  // Armies: an attack stands on its front, the tiles it is fighting over,
  // which belong to whoever it attacks. So the players whose attacks can be in
  // the area are those owning land in it or next to it (the attacker's land
  // borders its front), in tile scan order.
  const armies = new Set<Player>(hitPerPlayer.keys());
  for (const tile of tiles) {
    for (const n of game.neighbors(tile)) {
      const owner = game.owner(n);
      if (isAirstrikeVictim(attacker, owner)) armies.add(owner);
    }
  }
  for (const victim of armies) {
    // Attacks in id order, so the result never depends on creation order.
    const attacks = victim
      .outgoingAttacks()
      .filter((a) => a.isActive())
      .sort((a, b) => (a.id() < b.id() ? -1 : a.id() > b.id() ? 1 : 0));
    for (const attack of attacks) {
      const front = attack.borderTiles();
      let hitFront = 0;
      for (const t of front) if (area.has(t)) hitFront++;
      const deaths = airstrikeArmyLoss(
        spec,
        attack.troops(),
        hitFront,
        front.size,
      );
      if (deaths > 0) plan.attacks.push({ victim, attack, deaths });
    }
  }
  return plan;
}

/** Troops a plan would kill in all. */
export function plannedKills(plan: TroopDamagePlan): number {
  let sum = 0;
  for (const v of plan.victims) sum += v.garrison;
  for (const a of plan.attacks) sum += a.deaths;
  return sum;
}

/**
 * Kills troops of every victim owning land in `tiles`, as `planTroopDamage`
 * says: their garrison, and each of their attacks whose front runs through the
 * area.
 */
export function applyTroopDamage(
  game: Game,
  attacker: Player,
  tiles: readonly TileRef[],
  spec: AirstrikeSpec,
  totals: DamageTotal[],
): TroopDamage {
  const plan = planTroopDamage(game, attacker, tiles, spec);
  const result: TroopDamage = { affected: [], killed: 0, cityLevel: 0 };
  const armyKilled = new Map<Player, number>();
  for (const { victim, attack, deaths } of plan.attacks) {
    const removed = Math.min(deaths, attack.troops());
    attack.setTroops(attack.troops() - removed);
    armyKilled.set(victim, (armyKilled.get(victim) ?? 0) + removed);
  }
  const reported = new Set<Player>();
  for (const { victim, cityLevel, garrison } of plan.victims) {
    const removed = victim.removeTroops(garrison);
    const killed = removed + (armyKilled.get(victim) ?? 0);
    reported.add(victim);
    // The victim now holds a grudge, as after any attack on them.
    victim.updateRelation(attacker, -50);
    result.affected.push(victim.smallID());
    if (killed > 0) {
      addDamage(totals, victim.smallID(), killed, 0);
      result.killed += killed;
      if (removed > 0) result.cityLevel = Math.max(result.cityLevel, cityLevel);
    }
  }
  // Players hit only in their attacks (none of their land in the area).
  for (const [victim, killed] of armyKilled) {
    if (reported.has(victim)) continue;
    victim.updateRelation(attacker, -50);
    result.affected.push(victim.smallID());
    addDamage(totals, victim.smallID(), killed, 0);
    result.killed += killed;
  }
  return result;
}

/**
 * Hostile structures within `radius` of `center`, nearest first (ties by id).
 * Friendly structures are dropped here, before any per-strike limit applies,
 * so they can never use up the one structure a rocket or strafing run may hit.
 */
export function structureCandidates(
  game: Game,
  attacker: Player,
  center: TileRef,
  radius: number,
): Unit[] {
  return game
    .nearbyUnits(center, radius, Structures.types, undefined, true)
    .filter(({ unit }) => isAirstrikeVictim(attacker, unit.owner()))
    .sort((a, b) => a.distSquared - b.distSquared || a.unit.id() - b.unit.id())
    .map(({ unit }) => unit);
}

/**
 * The hostile structure a strafing run's burst hits: the first, along the
 * flight direction, inside the burst's segment and within `structureRadius`
 * of the centreline.
 */
export function strafeStructureCandidate(
  game: Game,
  attacker: Player,
  corridor: Corridor,
  burst: number,
  spec: AirstrikeSpec,
): Unit | null {
  const lo = corridorEdge(corridor, burst);
  const hi = corridorEdge(corridor, burst + 1);
  const isLast = burst === corridor.bursts - 1;
  const midS = (lo + hi) / 2;
  const mid = game.ref(
    Math.min(
      game.width() - 1,
      Math.max(0, Math.round(corridor.sx + corridor.ux * midS)),
    ),
    Math.min(
      game.height() - 1,
      Math.max(0, Math.round(corridor.sy + corridor.uy * midS)),
    ),
  );
  const reach = (hi - lo) / 2 + corridor.halfWidth + 2;
  let best: { unit: Unit; along: number } | null = null;
  for (const { unit } of game.nearbyUnits(
    mid,
    reach,
    Structures.types,
    undefined,
    true,
  )) {
    if (!isAirstrikeVictim(attacker, unit.owner())) continue;
    const along = alongTrack(game, corridor, unit.tile());
    if (along < lo || (isLast ? along > hi : along >= hi)) continue;
    if (crossTrack(game, corridor, unit.tile()) > spec.structureRadius)
      continue;
    if (
      best === null ||
      along < best.along ||
      (along === best.along && unit.id() < best.unit.id())
    ) {
      best = { unit, along };
    }
  }
  return best?.unit ?? null;
}

/**
 * Removes `spec.structureLevels` levels from up to `spec.maxStructures` of the
 * given (hostile, ordered) structures through the existing level-loss path:
 * a structure at level 0 is destroyed like any other (stats, rails, owner).
 */
export function applyStructureDamage(
  attacker: Player,
  structures: readonly Unit[],
  spec: AirstrikeSpec,
  totals: DamageTotal[],
): { levels: number; destroyed: number; affected: number[] } {
  let levels = 0;
  let destroyed = 0;
  const affected: number[] = [];
  for (const unit of structures.slice(0, spec.maxStructures)) {
    const owner = unit.owner();
    let removed = 0;
    while (removed < spec.structureLevels && unit.isActive()) {
      unit.decreaseLevel(attacker);
      removed++;
    }
    if (removed === 0) continue;
    levels += removed;
    if (!unit.isActive()) destroyed++;
    affected.push(owner.smallID());
    addDamage(totals, owner.smallID(), 0, removed);
  }
  return { levels, destroyed, affected };
}
