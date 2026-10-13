import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isClanTagRegistered } from "../../src/server/ClanTagCheck";

vi.mock("../../src/server/ServerEnv", () => ({
  ServerEnv: {
    jwtIssuer: () => "http://api.test",
    apiKey: () => "server-key",
  },
}));

describe("isClanTagRegistered", () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("asks the API about the upper-case tag with the server key", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ registered: true }),
    });
    expect(await isClanTagRegistered("abc")).toBe(true);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("http://api.test/reserved_clan_tags/ABC");
    expect(init.headers["x-api-key"]).toBe("server-key");
  });

  it("answers false for a tag nobody has", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ registered: false }),
    });
    expect(await isClanTagRegistered("ZQX")).toBe(false);
  });

  it("encodes anything odd in the tag, so it cannot change the path", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ registered: false }),
    });
    await isClanTagRegistered("../x?y#z");
    expect(fetchMock.mock.calls[0][0]).toBe(
      `http://api.test/reserved_clan_tags/${encodeURIComponent("../X?Y#Z")}`,
    );
  });

  it("is null, not a guess, when the API cannot be asked", async () => {
    fetchMock.mockRejectedValue(new Error("down"));
    expect(await isClanTagRegistered("ABC")).toBeNull();
    fetchMock.mockResolvedValue({ ok: false, status: 401 });
    expect(await isClanTagRegistered("ABC")).toBeNull();
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({}) });
    expect(await isClanTagRegistered("ABC")).toBeNull();
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ registered: "yes" }),
    });
    expect(await isClanTagRegistered("ABC")).toBeNull();
  });
});
