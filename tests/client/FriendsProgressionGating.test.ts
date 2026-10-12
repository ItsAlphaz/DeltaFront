import { ACCOUNT_FEATURES } from "@openfront/shared/AccountFeatures";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  acceptFriendRequest,
  deleteFriendRequest,
  fetchFriendRequests,
  fetchFriends,
  removeFriend,
  sendFriendRequest,
} from "../../src/client/FriendsApi";
import {
  fetchMyGameXp,
  fetchProgressionConfig,
  fetchPublicPlayerProgress,
  pollGameXp,
  prestigeMe,
} from "../../src/client/ProgressionApi";

vi.mock("../../src/client/Auth", () => ({
  getAuthHeader: vi.fn(async () => "Bearer t"),
}));
vi.mock("../../src/client/Api", () => ({
  getApiBase: vi.fn(() => "http://api.test"),
}));
vi.mock("../../src/client/ApiBase", () => ({
  getApiBase: vi.fn(() => "http://api.test"),
}));

// Friends and progression have no DeltaFront backend yet (later milestones). With
// their features off the client must not even try: no request, and the failure
// answers the UI already knows how to render (nothing).
describe("friends and progression make no requests while their features are off", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn(async () => new Response("{}", { status: 404 }));
    vi.stubGlobal("fetch", fetchMock);
    ACCOUNT_FEATURES.friends = false;
    ACCOUNT_FEATURES.progression = false;
  });
  afterEach(() => vi.unstubAllGlobals());

  it("friends", async () => {
    expect(await fetchFriendRequests()).toBe(false);
    expect(await fetchFriends(1, 20)).toBe(false);
    for (const result of [
      await sendFriendRequest("x"),
      await acceptFriendRequest("x"),
      await deleteFriendRequest("x"),
      await removeFriend("x"),
    ]) {
      expect(result).toBe("request_failed");
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("progression", async () => {
    expect(await fetchMyGameXp("g1")).toEqual({ status: "unavailable" });
    expect(await pollGameXp("g1")).toBeNull();
    expect(await fetchPublicPlayerProgress("p")).toBe(false);
    expect(await prestigeMe("key")).toEqual({ ok: false, reason: "failed" });
    expect(await fetchProgressionConfig()).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("and ask the backend again once the feature is on", async () => {
    ACCOUNT_FEATURES.friends = true;
    ACCOUNT_FEATURES.progression = true;
    await fetchFriends(1, 20);
    await fetchPublicPlayerProgress("p");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[0][0])).toContain("/friends");
    expect(String(fetchMock.mock.calls[1][0])).toContain(
      "/public/player/p/progress",
    );
  });
});
