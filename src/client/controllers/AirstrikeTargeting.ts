import { TileRef } from "@openfront/engine-api/game/GameMap";
import {
  AirstrikeUnitType,
  UnitType,
} from "@openfront/engine-api/game/GameTypes";
import {
  AirstrikeBlockReason,
  pickAirstrikeAirport,
} from "@openfront/engine-lib/airstrike/AirstrikeRules";
import { translateText } from "../Utils";
import { GameView, PlayerView } from "../view";

/**
 * Why `type` cannot be launched at `tile`, or null if it can.
 *
 * The engine's buildable answer (`canBuild`) is authoritative; this only
 * explains a "no" to the player, using the same shared rule the engine uses
 * (engine-lib `pickAirstrikeAirport`) on what the client can see.
 */
export function airstrikeBlockReason(
  game: GameView,
  me: PlayerView,
  type: AirstrikeUnitType,
  tile: TileRef,
  canBuild: boolean,
  cost: bigint,
): AirstrikeBlockReason | null {
  if (canBuild) return null;
  if (game.config().isUnitDisabled(type)) return "disabled";
  if (game.isSpawnImmunityActive()) return "spawn_immunity";
  if (!game.isLand(tile) || game.isImpassable(tile)) return "invalid_terrain";
  const owner = game.owner(tile);
  if (
    !owner.isPlayer() ||
    owner.smallID() === me.smallID() ||
    me.isFriendly(owner)
  ) {
    return "not_hostile";
  }
  const pick = pickAirstrikeAirport(
    game,
    tile,
    me.units(UnitType.Airport).map((a) => ({
      tile: a.tile(),
      active: a.isActive(),
      underConstruction: a.isUnderConstruction(),
      inCooldown: a.isInCooldown(),
    })),
    game.config().airportRange(),
  );
  if (pick.reason !== null) return pick.reason;
  if (me.gold() < cost) return "not_enough_gold";
  // The engine refused for a reason the client cannot see (e.g. an AFK ally).
  return "not_hostile";
}

/** Seconds until the soonest in-range rearming airport can launch again. */
export function airportRearmSeconds(
  game: GameView,
  me: PlayerView,
  tile: TileRef,
): number {
  const range2 = game.config().airportRange() ** 2;
  const cooldown = game.config().AirportCooldown();
  let soonest = Infinity;
  for (const airport of me.units(UnitType.Airport)) {
    if (!airport.isActive() || !airport.isInCooldown()) continue;
    if (game.euclideanDistSquared(airport.tile(), tile) > range2) continue;
    const readyAt = airport.missileTimerQueue()[0] + cooldown;
    soonest = Math.min(soonest, readyAt - game.ticks());
  }
  if (!Number.isFinite(soonest)) return 0;
  return Math.max(1, Math.ceil(soonest / (1000 / game.config().msPerTick())));
}

/** The player-facing text for a block reason. */
export function airstrikeReasonText(
  game: GameView,
  me: PlayerView,
  reason: AirstrikeBlockReason,
  tile: TileRef,
): string {
  return translateText(`airstrike_menu.reason.${reason}`, {
    seconds:
      reason === "airport_rearming" ? airportRearmSeconds(game, me, tile) : 0,
  });
}
