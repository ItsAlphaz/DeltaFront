import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/client/ClientEnv", () => ({
  ClientEnv: { jwtAudience: () => "localhost" },
}));

// fetchPlayerLeaderboard is unauthenticated; Auth is only mocked because
// Api.ts imports it at module scope.
vi.mock("../../src/client/Auth", () => ({
  getAuthHeader: vi.fn(async () => ""),
  getPlayToken: vi.fn(async () => null),
  logOut: vi.fn(async () => {}),
  userAuth: vi.fn(async () => false),
}));

import { PlayerLeaderboardResponseSchema } from "@openfront/shared/ApiSchemas";
import {
  fetchBasicPlayerLeaderboard,
  fetchPlayerLeaderboard,
} from "../../src/client/Api";

const entry = (rank: number) => ({
  rank,
  elo: 1500,
  peakElo: 1600,
  wins: 10,
  losses: 5,
  total: 15,
  public_id: `player-${rank}`,
  accountUsername: "alpha.0001",
});

const res = (body: unknown, ok = true, status = 200) => ({
  ok,
  status,
  statusText: ok ? "OK" : "Error",
  json: async () => body,
});

beforeEach(() => {
  // Short-circuits getApiBase before it reads localStorage.
  process.env.API_DOMAIN = "api.test";
  vi.stubGlobal("fetch", vi.fn());
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("fetchPlayerLeaderboard", () => {
  it("returns the parsed page", async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      res({ "1v1": [entry(1)], "2v2": [] }),
    );

    const result = await fetchPlayerLeaderboard(1);
    expect(result).not.toBe(false);
    expect(result).not.toBe("reached_limit");
    expect((result as { "1v1": unknown[] })["1v1"]).toHaveLength(1);
  });

  it("requests the page it was asked for", async () => {
    const fetchMock = global.fetch as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValueOnce(res({ "1v1": [], "2v2": [] }));

    await fetchPlayerLeaderboard(3);
    expect(String(fetchMock.mock.calls[0][0])).toContain("page=3");
  });

  it("reports a page past the end as reached_limit", async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      res(
        { error: "Bad request", message: "Page must be between 1 and 2" },
        false,
        400,
      ),
    );

    expect(await fetchPlayerLeaderboard(3)).toBe("reached_limit");
  });

  // The bounds are open so a dynamic page cap keeps matching.
  it("accepts any numeric bounds in the message", async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      res(
        { error: "Bad request", message: "Page must be between 1 and 137" },
        false,
        400,
      ),
    );

    expect(await fetchPlayerLeaderboard(200)).toBe("reached_limit");
  });

  // Anything looser than the exact page-bounds wording would hide real errors.
  it.each([
    ["a 500", res({}, false, 500)],
    ["a 400 with no message", res({ error: "Bad request" }, false, 400)],
    [
      "an unrelated 400 mentioning a page",
      res(
        { error: "Bad request", message: "Invalid page parameter" },
        false,
        400,
      ),
    ],
    [
      "a 400 with a non-string message",
      res({ error: "Bad request", message: { page: 3 } }, false, 400),
    ],
    [
      "a 400 that only embeds the bounds phrase",
      res(
        {
          error: "Bad request",
          message: "Upstream rejected the query: Page must be between 1 and 2",
        },
        false,
        400,
      ),
    ],
    [
      "a 400 with the phrase but no bounds",
      res(
        { error: "Bad request", message: "Page must be between" },
        false,
        400,
      ),
    ],
  ])("returns false for %s", async (_label, response) => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(response);
    expect(await fetchPlayerLeaderboard(3)).toBe(false);
  });

  it("returns false when the error body is not JSON", async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: false,
      status: 400,
      statusText: "Bad Request",
      json: async () => {
        throw new SyntaxError("Unexpected token <");
      },
    });

    expect(await fetchPlayerLeaderboard(3)).toBe(false);
  });

  it("returns false when the payload fails validation", async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      res({ "1v1": [{ rank: "first" }] }),
    );

    expect(await fetchPlayerLeaderboard(1)).toBe(false);
  });

  it("returns false when the request throws", async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new TypeError("network down"),
    );

    expect(await fetchPlayerLeaderboard(1)).toBe(false);
  });
});

const basic = (rank: number) => ({
  rank,
  playerId: `player-${rank}`,
  accountUsername: null,
  games: 12,
  wins: 9,
  losses: 3,
  winRate: 0.75,
});

describe("fetchBasicPlayerLeaderboard", () => {
  const fetchMock = () => global.fetch as ReturnType<typeof vi.fn>;

  it("returns the parsed page, with no Elo on the rows", async () => {
    fetchMock().mockResolvedValueOnce(res({ players: [basic(1), basic(2)] }));
    const result = await fetchBasicPlayerLeaderboard(1);
    expect(result).not.toBe(false);
    expect(result).not.toBe("reached_limit");
    const { players } = result as { players: Array<{ elo?: number }> };
    expect(players).toHaveLength(2);
    expect(players[0].elo).toBeUndefined();
  });

  it("asks for the page and the period it was given (all time by default)", async () => {
    fetchMock().mockResolvedValue(res({ players: [] }));
    await fetchBasicPlayerLeaderboard(3);
    await fetchBasicPlayerLeaderboard(2, "30d");
    const urls = fetchMock().mock.calls.map((c) => new URL(String(c[0])));
    expect(urls[0].pathname).toBe("/leaderboard/players");
    expect(urls[0].searchParams.get("page")).toBe("3");
    expect(urls[0].searchParams.get("period")).toBe("all");
    expect(urls[1].searchParams.get("page")).toBe("2");
    expect(urls[1].searchParams.get("period")).toBe("30d");
    // public data: no credentials sent
    expect(fetchMock().mock.calls[0][1]).toEqual({
      headers: { Accept: "application/json" },
    });
  });

  it("reports a page past the end as reached_limit", async () => {
    fetchMock().mockResolvedValueOnce(
      res({ message: "Page must be between 1 and 2" }, false, 400),
    );
    expect(await fetchBasicPlayerLeaderboard(3)).toBe("reached_limit");
  });

  it("treats other 400s, server errors and non-JSON bodies as a failure", async () => {
    fetchMock().mockResolvedValueOnce(
      res({ message: "Invalid period" }, false, 400),
    );
    expect(await fetchBasicPlayerLeaderboard(1)).toBe(false);
    fetchMock().mockResolvedValueOnce(res({}, false, 500));
    expect(await fetchBasicPlayerLeaderboard(1)).toBe(false);
    fetchMock().mockResolvedValueOnce({
      ok: false,
      status: 400,
      statusText: "Bad",
      json: async () => {
        throw new Error("not json");
      },
    });
    expect(await fetchBasicPlayerLeaderboard(1)).toBe(false);
  });

  it("returns false when the payload fails validation, or the request throws", async () => {
    fetchMock().mockResolvedValueOnce(res({ players: [{ rank: "one" }] }));
    expect(await fetchBasicPlayerLeaderboard(1)).toBe(false);
    fetchMock().mockRejectedValueOnce(new Error("offline"));
    expect(await fetchBasicPlayerLeaderboard(1)).toBe(false);
  });
});

describe("PlayerLeaderboardEntrySchema", () => {
  it("accepts a ranked row (with elo) and a basic row (without)", () => {
    const ranked = { ...basic(1), elo: 1500 };
    const parsed = PlayerLeaderboardResponseSchema.parse({
      players: [ranked, basic(2)],
    });
    expect(parsed.players[0].elo).toBe(1500);
    expect(parsed.players[1].elo).toBeUndefined();
  });

  it("still rejects a row missing the fields every board needs", () => {
    expect(
      PlayerLeaderboardResponseSchema.safeParse({
        players: [{ rank: 1, playerId: "x" }],
      }).success,
    ).toBe(false);
  });
});
