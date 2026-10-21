import {
  generateJoinCode,
  JOIN_CODE_ALPHABET,
  JOIN_CODE_LENGTH,
  joinCodeWorker,
  normalizeJoinCode,
} from "@openfront/shared/JoinCode";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GameManager } from "../../src/server/GameManager";
import { mockLogger } from "../util/GameServerHarness";

describe("join codes", () => {
  it("are four unambiguous characters whose first names the worker", () => {
    for (let worker = 0; worker < 8; worker++) {
      const code = generateJoinCode(worker)!;
      expect(code).toHaveLength(JOIN_CODE_LENGTH);
      expect(normalizeJoinCode(code)).toBe(code);
      expect(joinCodeWorker(code)).toBe(worker);
    }
    expect(JOIN_CODE_ALPHABET).not.toMatch(/[01OIL]/);
  });

  it("has no code for a worker past the alphabet", () => {
    expect(generateJoinCode(JOIN_CODE_ALPHABET.length)).toBeNull();
  });

  it("is read back case-insensitively, ignoring spaces and dashes", () => {
    expect(normalizeJoinCode(" ab-cd ")).toBe("ABCD");
    expect(normalizeJoinCode("a b c d")).toBe("ABCD");
  });

  it("is not made of a long lobby id, a short word, or banned characters", () => {
    expect(normalizeJoinCode("AB1D")).toBeNull();
    expect(normalizeJoinCode("ABC")).toBeNull();
    expect(normalizeJoinCode("ABCDE")).toBeNull();
    expect(normalizeJoinCode("aB3dE4fG")).toBeNull();
  });
});

describe("GameManager join codes", () => {
  let gm: GameManager;

  beforeEach(() => {
    vi.useFakeTimers();
    gm = new GameManager(mockLogger() as never);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("names the lobby it was minted for, on its worker", () => {
    gm.createGame("AAAAAAAAA1", undefined, "creator");
    const code = gm.mintJoinCode("AAAAAAAAA1", 1)!;
    expect(joinCodeWorker(code)).toBe(1);
    expect(gm.gameByJoinCode(code)?.gameInfo().gameID).toBe("AAAAAAAAA1");
    expect(gm.joinCodeOf("AAAAAAAAA1")).toBe(code);
  });

  it("gives a lobby one code, however often it is asked", () => {
    gm.createGame("AAAAAAAAA1", undefined, "creator");
    expect(gm.mintJoinCode("AAAAAAAAA1", 0)).toBe(
      gm.mintJoinCode("AAAAAAAAA1", 0),
    );
  });

  it("gives two live lobbies different codes", () => {
    gm.createGame("AAAAAAAAA1", undefined, "creator");
    gm.createGame("AAAAAAAAA2", undefined, "creator");
    expect(gm.mintJoinCode("AAAAAAAAA1", 0)).not.toBe(
      gm.mintJoinCode("AAAAAAAAA2", 0),
    );
  });

  it("has no code for a lobby that does not exist, nor a code nobody holds", () => {
    expect(gm.mintJoinCode("NOSUCHGAME", 0)).toBeNull();
    expect(gm.gameByJoinCode("ABCD")).toBeNull();
    expect(gm.joinCodeOf("NOSUCHGAME")).toBeNull();
  });
});
