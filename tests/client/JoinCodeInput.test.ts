import { describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  resolveJoinCode: vi.fn(),
  fetchJoinCode: vi.fn(async () => null),
}));

vi.mock("../../src/client/Api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/client/Api")>()),
  resolveJoinCode: api.resolveJoinCode,
  fetchJoinCode: api.fetchJoinCode,
}));

import { JoinLobbyModal } from "../../src/client/JoinLobbyModal";

describe("JoinLobbyModal join code", () => {
  const modalWith = (typed: string) => {
    const modal = new JoinLobbyModal();
    Object.defineProperty(modal, "lobbyIdInput", {
      value: { value: typed },
    });
    (modal as any).startTrackingLobby = vi.fn();
    (modal as any).resetTrackingState = vi.fn();
    (modal as any).showMessage = vi.fn();
    (modal as any).checkActiveLobby = vi.fn().mockResolvedValue(true);
    (modal as any).checkArchivedGame = vi.fn();
    return modal;
  };

  it("joins the lobby a four-character code names", async () => {
    api.resolveJoinCode.mockResolvedValue("AbCd12345");
    const modal = modalWith(" k7m2 ");
    await (modal as any).enterLobbyFromInput(false);
    expect(api.resolveJoinCode).toHaveBeenCalledWith("K7M2");
    expect((modal as any).checkActiveLobby).toHaveBeenCalledWith(
      "AbCd12345",
      false,
    );
  });

  it("says the lobby was not found when the code names none", async () => {
    api.resolveJoinCode.mockResolvedValue(null);
    const modal = modalWith("K7M2");
    await (modal as any).enterLobbyFromInput(false);
    expect((modal as any).showMessage).toHaveBeenCalledWith(
      expect.any(String),
      "red",
    );
    expect((modal as any).checkActiveLobby).not.toHaveBeenCalled();
  });

  it("still joins by the long lobby id", async () => {
    api.resolveJoinCode.mockClear();
    const modal = modalWith("AbCd1234");
    await (modal as any).enterLobbyFromInput(false);
    expect(api.resolveJoinCode).not.toHaveBeenCalled();
    expect((modal as any).checkActiveLobby).toHaveBeenCalledWith(
      "AbCd1234",
      false,
    );
  });
});
