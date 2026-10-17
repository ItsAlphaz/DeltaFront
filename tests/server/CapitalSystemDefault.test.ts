import { GameType } from "@openfront/engine-api/game/GameTypes";
import { describe, expect, it } from "vitest";
import { GameManager } from "../../src/server/GameManager";
import { zeroCounters } from "../../src/server/telemetry/MatchTelemetry";
import { cid, mockLogger } from "../util/GameServerHarness";

const telemetry = {
  emit: () => "enqueued" as const,
  counters: zeroCounters,
  stop: () => {},
};

// The Capital System is on by default in Create Match (docs/Capital.md). The
// Create Match screen shows it on from the first moment, and the host may not
// touch a setting before starting, so the server's own default has to match.
describe("a new private lobby's Capital System default", () => {
  it("is on for a bare private lobby (create_game with no body)", () => {
    const manager = new GameManager(mockLogger(), telemetry);
    const game = manager.createGame(cid("bare"), undefined)!;
    expect(game.gameInfo().gameConfig?.capitalSystem).toEqual({
      enabled: true,
    });
  });

  it("is absent (off) for a game created with a config of its own", () => {
    const manager = new GameManager(mockLogger(), telemetry);
    const game = manager.createGame(cid("given"), {
      gameType: GameType.Private,
    })!;
    expect(game.gameInfo().gameConfig?.capitalSystem).toBeUndefined();
  });

  it("is absent (off) for a public game, so public matches play as before", () => {
    const manager = new GameManager(mockLogger(), telemetry);
    const game = manager.createGame(
      cid("public"),
      { gameType: GameType.Public },
      undefined,
      undefined,
      "ffa" as never,
    )!;
    expect(game.gameInfo().gameConfig?.capitalSystem).toBeUndefined();
  });
});
