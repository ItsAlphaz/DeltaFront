import { TileRef } from "@openfront/engine-api/game/GameMap";
import { Difficulty, UnitType } from "@openfront/engine-api/game/GameTypes";
import { TICKS_PER_MINUTE } from "@openfront/engine-lib/capital/CapitalRules";
import type { Game, Player } from "../../game/Game";

/** The most tiles a nation will test for an interior one: enough to find any, cheap to skip. */
const MAX_CANDIDATE_TILES = 4_000;

/**
 * How a nation invests before it buys its capital, by difficulty. It builds
 * cities first (they are the cheapest way to a bigger army and economy), then
 * saves; `saveFromMinute` is the latest it starts saving whatever it has built.
 * When it can pay is decided by its economy, not by a timetable: these only
 * decide how much it builds first.
 *
 * Measured in simulation (docs/CapitalBalance.md): a nation that saves from the
 * start and builds nothing is the weakest strategy in the game, and one that
 * builds a city or two first holds its own against one that never buys.
 */
const POLICY: Record<
  Difficulty,
  { citiesFirst: number; saveFromMinute: number }
> = {
  [Difficulty.Easy]: { citiesFirst: 2, saveFromMinute: 9 },
  [Difficulty.Medium]: { citiesFirst: 1, saveFromMinute: 8 },
  [Difficulty.Hard]: { citiesFirst: 1, saveFromMinute: 7 },
  [Difficulty.Impossible]: { citiesFirst: 1, saveFromMinute: 6 },
};

/** Incoming troops over its own, from which a nation under attack stops saving. */
const THREAT_RATIO = 0.35;

/** Whether a nation without a capital has built what it means to build first. */
export function readyToSave(mg: Game, player: Player): boolean {
  const capitals = mg.capitals();
  if (capitals === null) return false;
  // A nation that lost its capital has built what it meant to: it rebuys.
  if (capitals.hasLostCapital(player)) return true;
  const policy = POLICY[mg.config().gameConfig().difficulty];
  if (player.units(UnitType.City).length >= policy.citiesFirst) return true;
  return capitals.ticksSinceStart() >= policy.saveFromMinute * TICKS_PER_MINUTE;
}

function underAttack(player: Player): boolean {
  const troops = player.troops();
  if (troops <= 0) return true;
  const incoming = player
    .incomingAttacks()
    .reduce((sum, attack) => sum + attack.troops(), 0);
  return incoming / troops >= THREAT_RATIO;
}

/**
 * A nation without a capital that has built its first cities holds back what it
 * earns for one: it builds no more structures (defense posts under attack are
 * not held back) until it can pay, unless a real attack makes it spend.
 */
export function isSavingForCapital(mg: Game, player: Player): boolean {
  const capitals = mg.capitals();
  if (capitals === null || capitals.capitalOf(player) !== null) return false;
  // Already paid: the gold is spent, it waits for the building.
  if (capitals.buildingOf(player) !== null) return false;
  if (!player.isAlive() || !readyToSave(mg, player)) return false;
  return !underAttack(player);
}

/**
 * A nation without a capital buys one as soon as it has built its first cities
 * and can pay for it. Humans choose; a nation has no one to ask. A nation that
 * lost its capital buys another the same way once the wait after the fall is
 * over.
 *
 * It runs before the nation spends on structures, and structures hold back
 * while it saves (`isSavingForCapital`): a nation that put every spare coin into
 * a city each cycle would never hold the price of a capital.
 *
 * Stateless (and so nothing to snapshot): every input is read from the game, the
 * same on every client. The tile is the first interior one found, starting with
 * where the nation spawned.
 */
export function maybeFoundNationCapital(mg: Game, player: Player): boolean {
  const capitals = mg.capitals();
  if (capitals === null || capitals.capitalOf(player) !== null) return false;
  if (capitals.buildingOf(player) !== null) return false;
  if (!readyToSave(mg, player)) return false;

  const [anyTile] = player.tiles();
  const first = player.spawnTile() ?? anyTile;
  if (first === undefined) return false;
  // Anything but a problem with the tile (no gold yet, too soon after the fall,
  // not allowed at all) is settled without searching.
  const block = capitals.foundBlock(player, first);
  if (block === null) return capitals.found(player, first);
  if (block !== "tile" && block !== "not_owned" && block !== "border") {
    return false;
  }

  const tile = interiorTile(player, capitals.foundBlock.bind(capitals));
  return tile !== null && capitals.found(player, tile);
}

function interiorTile(
  player: Player,
  block: (player: Player, tile: TileRef) => string | null,
): TileRef | null {
  let seen = 0;
  for (const tile of player.tiles()) {
    if (++seen > MAX_CANDIDATE_TILES) break;
    if (block(player, tile) === null) return tile;
  }
  return null;
}
