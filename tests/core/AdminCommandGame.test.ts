/**
 * A recorded admin_command runs through the real engine runner exactly as the
 * clients run it: the turn carries the stamped intent, the engine applies it. The
 * engine never asks who may send one (the game server decides that before it
 * relays; see tests/server/StaffIntents.test.ts), and the game that recorded one
 * is the game the API refuses to count (tests/account-api/adminApi.db.test.ts).
 */

import { GameMapType } from "@openfront/engine-api/game/GameTypes";
import {
  createGameRunner,
  type GameRunner,
} from "@openfront/engine/GameRunner";
import { loadMapFiles } from "@openfront/shared/GameMapLoader";
import { toWireGameStartInfo } from "@openfront/shared/SharedUtil";
import {
  config,
  human,
  mapLoader,
  spawnOnLand,
} from "../client/replay/util/ArchiveGame";

async function runner(): Promise<GameRunner> {
  const start = toWireGameStartInfo({
    gameID: "admincmd1",
    lobbyCreatedAt: 1_700_000_000_000,
    config: config({ gameMap: GameMapType.Onion, bots: 0 }),
    players: [human(1), human(2)],
  });
  const map = await loadMapFiles(
    mapLoader,
    start.config.gameMap,
    start.config.gameMapSize,
  );
  const r = await createGameRunner(start, undefined, map, () => {});
  let turn = 0;
  const play = (intents: Parameters<GameRunner["addTurn"]>[0]["intents"]) => {
    r.addTurn({ turnNumber: turn++, intents });
    expect(r.executeNextTick()).toBe(true);
  };
  // Both players spawn, then the spawn phase runs out.
  play([
    spawnOnLand(r.game, "client001", 1000),
    spawnOnLand(r.game, "client002", 90_000),
  ]);
  for (let i = 0; i < 400; i++) play([]);
  (r as unknown as { play: typeof play }).play = play;
  return r;
}
const playOf = (r: GameRunner) =>
  (r as unknown as { play: (i: unknown[]) => void }).play;

test("admin commands in a turn change the state on every client, and only the named player's", async () => {
  const r = await runner();
  const victim = r.game.playerByClientID("client002")!;
  const admin = r.game.playerByClientID("client001")!;
  const adminGold = admin.gold();

  playOf(r)([
    {
      type: "admin_command",
      command: "set_gold",
      target: victim.id(),
      amount: 5_000_000,
      clientID: "client001",
    },
  ]);
  // One tick of income may land on top; the set value is the floor.
  expect(victim.gold()).toBeGreaterThanOrEqual(5_000_000n);
  expect(victim.gold()).toBeLessThan(5_100_000n);
  expect(admin.gold() < adminGold + 1_000_000n).toBe(true);

  playOf(r)([
    {
      type: "admin_command",
      command: "set_troops",
      target: victim.id(),
      amount: 123_000,
      clientID: "client001",
    },
  ]);
  expect(victim.troops()).toBeGreaterThanOrEqual(123_000);
  expect(victim.troops()).toBeLessThan(130_000);
}, 60_000);

test("an eliminated player has no land and is dead", async () => {
  const r = await runner();
  const victim = r.game.playerByClientID("client002")!;
  expect(victim.isAlive()).toBe(true);
  playOf(r)([
    {
      type: "admin_command",
      command: "eliminate",
      target: victim.id(),
      clientID: "client001",
    },
  ]);
  for (let i = 0; i < 5; i++) playOf(r)([]);
  expect(victim.numTilesOwned()).toBe(0);
  expect(victim.isAlive()).toBe(false);
}, 60_000);

test("a forced win ends the game with that player as the winner", async () => {
  const r = await runner();
  const admin = r.game.playerByClientID("client001")!;
  expect(r.game.getWinner()).toBeNull();
  playOf(r)([
    {
      type: "admin_command",
      command: "force_win",
      target: admin.id(),
      clientID: "client001",
    },
  ]);
  expect(r.game.getWinner()).toBe(admin);
}, 60_000);
