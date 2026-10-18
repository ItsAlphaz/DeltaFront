import { GameUpdates } from "@openfront/engine-api/game/GameTypes";
import {
  GameUpdateType,
  InsurgencyRegionStatus,
  type InsurgencyView,
} from "@openfront/engine-api/game/GameUpdates";
import { INSURGENCY_SPEC } from "@openfront/engine-lib/insurgency/InsurgencyRules";
import { AttackExecution } from "@openfront/engine/execution/AttackExecution";
import { PlayerExecution } from "@openfront/engine/execution/PlayerExecution";
import type { Game, Player } from "@openfront/engine/game/Game";
import type { Insurgency } from "@openfront/engine/game/InsurgencySystem";
import {
  FullStrengthConfig,
  buyCapital,
  capitalWorld,
  human,
  run,
} from "../capital/helpers";
import { setup } from "../util/Setup";

export { capitalWorld, human, run };

export interface InsurgentWorld {
  game: Game;
  /** The player whose capital falls and who resists. */
  alice: Player;
  /** Holds the next region over; takes alice's capital. */
  bob: Player;
  /** A bystander, for friendly/other cases. */
  carol: Player;
}

/** Fills the inclusive rectangle for `player`. */
export function rect(
  game: Game,
  player: Player,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): void {
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) player.conquer(game.ref(x, y));
  }
}

/**
 * alice holds region 0 (the top-left 32 x 32), bob region 1 beside it, carol
 * region 8 below; each has an army of a million (100,000 shown) and the
 * Capital System is on. Everyone has bought a capital.
 */
export async function insurgentWorld(
  config: Parameters<typeof setup>[1] = {},
  configClass?: Parameters<typeof setup>[4],
): Promise<InsurgentWorld> {
  const game = await setup(
    "big_plains",
    { capitalSystem: { enabled: true }, ...config },
    [human("alice"), human("bob"), human("carol")],
    undefined,
    configClass ?? FullStrengthConfig,
  );
  const alice = game.player("alice");
  const bob = game.player("bob");
  const carol = game.player("carol");
  rect(game, alice, 0, 0, 31, 31);
  alice.setSpawnTile(game.ref(16, 16));
  rect(game, bob, 32, 0, 63, 31);
  bob.setSpawnTile(game.ref(48, 16));
  rect(game, carol, 0, 32, 31, 63);
  carol.setSpawnTile(game.ref(16, 48));
  for (const p of [alice, bob, carol]) p.setTroops(1_000_000);
  game.executeNextTick();
  for (const p of [alice, bob, carol]) buyCapital(game, p); // the capitals are bought
  return { game, alice, bob, carol };
}

/** Bob takes alice's capital: her resistance begins. Returns the tick's updates. */
export function captureCapital(w: InsurgentWorld): GameUpdates {
  const tile = w.game.capitals()!.capitalOf(w.alice)!.tile;
  w.bob.conquer(tile);
  return w.game.executeNextTick();
}

/** The resistance of `player`, which must exist. */
export function resistance(game: Game, player: Player): Insurgency {
  const ins = game.insurgency()!.of(player);
  if (ins === null) throw new Error(`${player.name()} has no resistance`);
  return ins;
}

/** Runs to just past the next unrest update (or `updates` of them), returning every tick's updates. */
export function runToUpdate(game: Game, updates = 1): GameUpdates[] {
  const all: GameUpdates[] = [];
  for (let i = 0; i < updates; i++) {
    while (game.ticks() % INSURGENCY_SPEC.unrestInterval !== 0) {
      all.push(game.executeNextTick());
    }
    all.push(game.executeNextTick());
  }
  return all;
}

/** Bob takes the top `rows` rows of region 0 (alice keeps the rest), then the update sees it. */
export function occupyRegion0(w: InsurgentWorld, rows = 22): GameUpdates[] {
  rect(w.game, w.bob, 0, 0, 31, rows - 1);
  return runToUpdate(w.game);
}

/** The regions' state as the engine keeps it. */
export function regionOf(game: Game, player: Player, id = 0) {
  const r = resistance(game, player).regions.find((x) => x.id === id);
  if (r === undefined) throw new Error(`no region ${id}`);
  return r;
}

/** The latest InsurgencyState view sent for `owner` in these updates, if any. */
export function viewIn(
  updates: GameUpdates[],
  owner: number,
): InsurgencyView | undefined {
  let found: InsurgencyView | undefined;
  for (const u of updates) {
    for (const s of u[GameUpdateType.InsurgencyState]) {
      if (s.view.owner === owner) found = s.view;
    }
  }
  return found;
}

/** Makes region 0 restless enough for any order (the natural climb is tested separately). */
export function makeRestless(game: Game, player: Player, unrest = 100): void {
  regionOf(game, player).unrest = unrest;
}

/** The economy runs (a world built without spawns has none). */
export function startEconomy(game: Game, ...players: Player[]): void {
  for (const p of players) game.addExecution(new PlayerExecution(p));
}

/**
 * alice holds a small patch (64 tiles: under the 100 at which an attacked
 * player is annexed whole) with her capital in it; bob is beside her with a
 * big land. Everyone has an army of a million, and the economy runs.
 */
export async function annexable() {
  const game = await setup(
    "big_plains",
    { capitalSystem: { enabled: true } },
    [human("alice"), human("bob"), human("carol")],
    undefined,
    FullStrengthConfig,
  );
  const alice = game.player("alice");
  const bob = game.player("bob");
  const carol = game.player("carol");
  rect(game, alice, 0, 0, 7, 7);
  alice.setSpawnTile(game.ref(4, 4));
  rect(game, bob, 8, 0, 60, 20);
  bob.setSpawnTile(game.ref(30, 10));
  rect(game, carol, 100, 100, 130, 130);
  carol.setSpawnTile(game.ref(115, 115));
  for (const p of [alice, bob, carol]) p.setTroops(1_000_000);
  alice.addGold(1_000_000n);
  startEconomy(game, alice, bob, carol);
  game.executeNextTick();
  for (const p of [alice, bob, carol]) buyCapital(game, p);
  return { game, alice, bob, carol };
}

/** bob attacks alice with everything, and wins her land in one go. */
export function annex(w: Awaited<ReturnType<typeof annexable>>) {
  w.game.addExecution(
    new AttackExecution(w.bob.troops(), w.bob, w.alice.id(), null),
  );
  return [
    w.game.executeNextTick(),
    w.game.executeNextTick(),
    ...run(w.game, 40),
  ];
}

export { InsurgencyRegionStatus, INSURGENCY_SPEC as SPEC };
