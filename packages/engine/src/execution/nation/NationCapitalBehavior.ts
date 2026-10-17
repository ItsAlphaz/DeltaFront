import { TileRef } from "@openfront/engine-api/game/GameMap";
import type { Game, Player } from "../../game/Game";

/** The most tiles a nation will test for an interior one: enough to find any, cheap to skip. */
const MAX_CANDIDATE_TILES = 4_000;

/**
 * A nation that has lost its capital founds a replacement as soon as it can pay
 * for one. Humans choose; a nation has no one to ask, and without this it would
 * go the rest of the game without the bonus a human can win back.
 *
 * It runs before the nation spends on structures: a nation that put every spare
 * coin into a city each cycle would never hold the price of a capital.
 *
 * Stateless (and so nothing to snapshot): every input is read from the game, the
 * same on every client. The tile is the first interior one found, starting with
 * where the nation spawned.
 */
export function maybeFoundNationCapital(mg: Game, player: Player): boolean {
  const capitals = mg.capitals();
  if (capitals === null || capitals.capitalOf(player) !== null) return false;

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
