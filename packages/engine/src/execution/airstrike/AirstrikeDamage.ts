import { TileRef } from "@openfront/engine-api/game/GameMap";
import { Structures, TerraNullius } from "@openfront/engine-api/game/GameTypes";
import {
  alongTrack,
  Corridor,
  corridorEdge,
  crossTrack,
} from "@openfront/engine-lib/airstrike/AirstrikeGeometry";
import { airstrikeTroopLoss } from "@openfront/engine-lib/airstrike/AirstrikeRules";
import type { AirstrikeSpec } from "@openfront/engine-lib/configuration/Config";
import { Game, Player, Unit } from "../../game/Game";

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

/**
 * Kills troops of every victim owning land in `tiles`, in proportion to the
 * share of their land hit. Returns the smallIDs of the players whose land was hit.
 */
export function applyTroopDamage(
  game: Game,
  attacker: Player,
  tiles: readonly TileRef[],
  spec: AirstrikeSpec,
  totals: DamageTotal[],
): number[] {
  // Map insertion order = tile scan order, so the result is deterministic.
  const hitPerPlayer = new Map<Player, number>();
  for (const tile of tiles) {
    const owner = game.owner(tile);
    if (!isAirstrikeVictim(attacker, owner)) continue;
    hitPerPlayer.set(owner, (hitPerPlayer.get(owner) ?? 0) + 1);
  }
  const affected: number[] = [];
  for (const [victim, hit] of hitPerPlayer) {
    const killed = victim.removeTroops(
      airstrikeTroopLoss(spec, victim.troops(), hit, victim.numTilesOwned()),
    );
    // The victim now holds a grudge, as after any attack on them.
    victim.updateRelation(attacker, -50);
    affected.push(victim.smallID());
    if (killed > 0) addDamage(totals, victim.smallID(), killed, 0);
  }
  return affected;
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
