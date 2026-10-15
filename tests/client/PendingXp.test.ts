import type { GameXpResponse } from "@openfront/shared/ApiSchemas";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/client/Api", () => ({
  getUserMe: vi.fn(async () => ({ user: {}, player: { publicId: "me" } })),
  invalidateUserMe: vi.fn(),
}));
vi.mock("../../src/client/Utils", () => ({
  translateText: (key: string, params?: Record<string, string | number>) =>
    params ? `${key}:${JSON.stringify(params)}` : key,
  showToast: vi.fn(),
}));

import { getUserMe, invalidateUserMe } from "../../src/client/Api";
import { refreshNav, resolvePendingXp } from "../../src/client/PendingXp";
import {
  clearPendingXp,
  PENDING_XP_MAX_AGE_MS,
  readPendingXp,
  rememberPendingXp,
} from "../../src/client/PendingXpStore";

// A player who left a game before seeing its XP (a winner from "You won", a tab
// closed) is told what it came to the next time the page loads.

const NOW = 1_700_000_000_000;
const eligible = (total: number): GameXpResponse =>
  ({
    gameId: "gOLD00001",
    eligible: true,
    breakdown: { total },
  }) as never;

beforeEach(() => {
  window.localStorage.clear();
  history.replaceState(null, "", "/");
  vi.mocked(getUserMe).mockClear();
  vi.mocked(invalidateUserMe).mockClear();
});
afterEach(() => {
  window.localStorage.clear();
  history.replaceState(null, "", "/");
});

describe("remembering a game", () => {
  it("keeps the game and when, and gives it back", () => {
    rememberPendingXp("gOLD00001", NOW);
    expect(readPendingXp(NOW + 1_000)).toEqual({
      gameId: "gOLD00001",
      at: NOW,
    });
  });

  it("keeps only the latest game", () => {
    rememberPendingXp("gOLD00001", NOW);
    rememberPendingXp("gOLD00002", NOW + 5);
    expect(readPendingXp(NOW + 10)?.gameId).toBe("gOLD00002");
  });

  it("forgets on request, and when it is too old to be worth asking about", () => {
    rememberPendingXp("gOLD00001", NOW);
    expect(readPendingXp(NOW + PENDING_XP_MAX_AGE_MS + 1)).toBeNull();
    clearPendingXp();
    expect(readPendingXp(NOW)).toBeNull();
  });

  it("reads nothing from damaged or foreign storage", () => {
    for (const raw of [
      "not json",
      "{}",
      '{"gameId":5,"at":"x"}',
      "null",
      "[]",
    ]) {
      window.localStorage.setItem("df.pendingXp", raw);
      expect(readPendingXp(NOW)).toBeNull();
    }
  });

  it("survives storage that throws", () => {
    const getItem = vi
      .spyOn(Storage.prototype, "getItem")
      .mockImplementation(() => {
        throw new Error("blocked");
      });
    const setItem = vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation(() => {
        throw new Error("blocked");
      });
    expect(() => rememberPendingXp("gOLD00001", NOW)).not.toThrow();
    expect(readPendingXp(NOW)).toBeNull();
    getItem.mockRestore();
    setItem.mockRestore();
  });
});

describe("telling a player what a game they left came to", () => {
  const deps = (result: GameXpResponse | null) => ({
    poll: vi.fn(async () => result),
    refreshUser: vi.fn(async () => {}),
    toast: vi.fn(),
    now: () => NOW,
  });

  it("says what was awarded and brings the nav up to date", async () => {
    rememberPendingXp("gOLD00001", NOW - 60_000);
    const d = deps(eligible(425));
    expect(await resolvePendingXp(d)).toBe("awarded");
    expect(d.poll).toHaveBeenCalledWith("gOLD00001", { timeoutMs: 45_000 });
    expect(d.toast).toHaveBeenCalledWith(
      'progression.toast_awarded:{"xp":"425"}',
      "green",
    );
    expect(d.refreshUser).toHaveBeenCalledOnce();
    // told once
    expect(readPendingXp(NOW)).toBeNull();
  });

  it("says what was forfeited", async () => {
    rememberPendingXp("gOLD00001", NOW - 60_000);
    const d = deps({
      gameId: "gOLD00001",
      eligible: false,
      reason: "left_early",
    });
    expect(await resolvePendingXp(d)).toBe("forfeited");
    expect(d.toast).toHaveBeenCalledWith("progression.toast_forfeited", "red");
    expect(d.refreshUser).not.toHaveBeenCalled();
    expect(readPendingXp(NOW)).toBeNull();
  });

  it("says nothing about a game that paid nothing for another reason, and forgets it", async () => {
    rememberPendingXp("gOLD00001", NOW - 60_000);
    const d = deps({
      gameId: "gOLD00001",
      eligible: false,
      reason: "private_game",
    });
    expect(await resolvePendingXp(d)).toBe("nothing");
    expect(d.toast).not.toHaveBeenCalled();
    expect(readPendingXp(NOW)).toBeNull();
  });

  it("gives up quietly when the XP never turns up", async () => {
    rememberPendingXp("gOLD00001", NOW - 60_000);
    const d = deps(null);
    expect(await resolvePendingXp(d)).toBe("nothing");
    expect(d.toast).not.toHaveBeenCalled();
    expect(readPendingXp(NOW)).toBeNull();
  });

  it("does nothing, and asks nothing, when no game was remembered", async () => {
    const d = deps(eligible(1));
    expect(await resolvePendingXp(d)).toBe("nothing");
    expect(d.poll).not.toHaveBeenCalled();
  });

  it("does nothing for a game too old to ask about", async () => {
    rememberPendingXp("gOLD00001", NOW - PENDING_XP_MAX_AGE_MS - 1);
    const d = deps(eligible(1));
    expect(await resolvePendingXp(d)).toBe("nothing");
    expect(d.poll).not.toHaveBeenCalled();
    expect(readPendingXp(NOW)).toBeNull();
  });

  it("does nothing on a game page: the XP is still being played for there", async () => {
    rememberPendingXp("gOLD00001", NOW - 1_000);
    history.replaceState(null, "", "/w1/game/gOLD00001");
    const d = deps(eligible(1));
    expect(await resolvePendingXp(d)).toBe("nothing");
    expect(d.poll).not.toHaveBeenCalled();
    // and it is kept for later
    expect(readPendingXp(NOW)?.gameId).toBe("gOLD00001");
  });

  it("refreshes the signed-in account so the nav's level and bar catch up", async () => {
    rememberPendingXp("gOLD00001", NOW - 60_000);
    const seen: unknown[] = [];
    const onUserMe = (e: Event) => seen.push((e as CustomEvent).detail);
    document.addEventListener("userMeResponse", onUserMe);
    const result = await resolvePendingXp({
      poll: vi.fn(async () => eligible(100)),
      toast: vi.fn(),
      now: () => NOW,
    });
    document.removeEventListener("userMeResponse", onUserMe);
    expect(result).toBe("awarded");
    expect(invalidateUserMe).toHaveBeenCalled();
    expect(getUserMe).toHaveBeenCalled();
    expect(seen).toEqual([{ user: {}, player: { publicId: "me" } }]);
  });

  it("does not announce a failed read of the account as a sign-out", async () => {
    rememberPendingXp("gOLD00001", NOW - 60_000);
    vi.mocked(getUserMe).mockResolvedValueOnce(false);
    const seen: unknown[] = [];
    const onUserMe = (e: Event) => seen.push((e as CustomEvent).detail);
    document.addEventListener("userMeResponse", onUserMe);
    await resolvePendingXp({
      poll: vi.fn(async () => eligible(100)),
      toast: vi.fn(),
      now: () => NOW,
    });
    document.removeEventListener("userMeResponse", onUserMe);
    expect(seen).toEqual([]);
  });
});

describe("catching the nav up", () => {
  it("re-reads the account and tells the nav, which reads that broadcast", async () => {
    const seen: unknown[] = [];
    const listen = (e: Event) => seen.push((e as CustomEvent).detail);
    document.addEventListener("userMeResponse", listen);
    try {
      await refreshNav();
    } finally {
      document.removeEventListener("userMeResponse", listen);
    }
    expect(invalidateUserMe).toHaveBeenCalledTimes(1);
    expect(getUserMe).toHaveBeenCalledTimes(1);
    expect(seen).toEqual([{ user: {}, player: { publicId: "me" } }]);
  });

  it("says nothing when the account cannot be read", async () => {
    vi.mocked(getUserMe).mockResolvedValueOnce(false);
    const listen = vi.fn();
    document.addEventListener("userMeResponse", listen);
    try {
      await refreshNav();
    } finally {
      document.removeEventListener("userMeResponse", listen);
    }
    expect(listen).not.toHaveBeenCalled();
  });
});
