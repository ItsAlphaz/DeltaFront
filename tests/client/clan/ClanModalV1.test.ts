import { ACCOUNT_FEATURES } from "@openfront/shared/AccountFeatures";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  apiMockFactory,
  authMockFactory,
  clanApiMockFactory,
  crazyGamesSdkMockFactory,
  flushAsync,
  getElState,
  setElState,
  stubGameEnv,
  stubLocalStorage,
  utilsMockFactory,
  virtualizerMockFactory,
} from "./ClanModalTestUtils";

vi.mock("@lit-labs/virtualizer/virtualize.js", () => virtualizerMockFactory());
vi.mock("../../../src/client/Api", () => apiMockFactory());
vi.mock("../../../src/client/ClanApi", () => clanApiMockFactory());
vi.mock("../../../src/client/Utils", () => utilsMockFactory());
vi.mock("../../../src/client/Auth", () => authMockFactory());
vi.mock("../../../src/client/CrazyGamesSDK", () => crazyGamesSdkMockFactory());

stubLocalStorage();

import { getUserMe } from "../../../src/client/Api";
import { ClanModal } from "../../../src/client/ClanModal";

const asMock = (fn: unknown) => fn as ReturnType<typeof vi.fn>;
const tabKeys = (modal: ClanModal): string[] =>
  (modal as unknown as { modalConfig(): { tabs: Array<{ key: string }> } })
    .modalConfig()
    .tabs.map((t) => t.key);

const REGISTERED = { discord: { id: "1", username: "u" } };

describe("the clan modal as DeltaFront ships it", () => {
  let modal: ClanModal;

  beforeEach(async () => {
    stubGameEnv("dev");
    if (!customElements.get("clan-modal")) {
      customElements.define("clan-modal", ClanModal);
    }
    asMock(getUserMe).mockResolvedValue({
      user: REGISTERED,
      player: { publicId: "me", clans: [], clanRequests: [] },
    } as never);
    ACCOUNT_FEATURES.payments = false;
    modal = document.createElement("clan-modal") as ClanModal;
    modal.setAttribute("inline", "");
    document.body.appendChild(modal);
    await modal.updateComplete;
  });
  afterEach(() => {
    modal.remove();
    asMock(getUserMe).mockReset();
  });

  it("has My Clans and Browse, and no Map tab (there is no map service)", async () => {
    modal.open();
    await flushAsync(modal);
    expect(tabKeys(modal)).toEqual(["my-clans", "browse"]);
    expect(getElState(modal, "activeTab")).toBe("my-clans");
    expect(modal.querySelector("clan-map-view")).toBeNull();
  });

  it("hides the Donations tab without payments, and shows it with them", async () => {
    setElState(modal, "view", "detail");
    setElState(modal, "selectedClanTag", "TST");
    expect(tabKeys(modal)).toEqual(["overview", "members", "game-history"]);
    ACCOUNT_FEATURES.payments = true;
    expect(tabKeys(modal)).toEqual([
      "overview",
      "members",
      "game-history",
      "donations",
    ]);
  });

  it("offers Create clan to a signed-in player with no clan, on the empty My Clans page", async () => {
    modal.open();
    await flushAsync(modal);
    const start = modal.querySelector<HTMLButtonElement>(
      "[data-create-clan-start]",
    );
    expect(start).not.toBeNull();
    start!.click();
    await flushAsync(modal);
    expect(getElState(modal, "activeTab")).toBe("browse");
    await vi.waitFor(() =>
      expect(modal.querySelector("clan-create-form")).not.toBeNull(),
    );
  });

  it("does not offer Create clan to a player who is already in a clan", async () => {
    asMock(getUserMe).mockResolvedValue({
      user: REGISTERED,
      player: {
        publicId: "me",
        clans: [
          {
            tag: "TST",
            name: "Test Clan",
            role: "member",
            joinedAt: "2024-01-01T00:00:00Z",
            memberCount: 2,
          },
        ],
        clanRequests: [],
      },
    } as never);
    modal.open();
    await flushAsync(modal);
    modal.setActiveTab("browse");
    await flushAsync(modal);
    await vi.waitFor(() =>
      expect(modal.querySelector("clan-browse-view input")).not.toBeNull(),
    );
    expect(modal.querySelector("[data-create-clan-start]")).toBeNull();
  });

  it("does not offer Create clan to someone signed out", async () => {
    asMock(getUserMe).mockResolvedValue({ user: {}, player: {} } as never);
    modal.open();
    await flushAsync(modal);
    expect(modal.querySelector("[data-create-clan-start]")).toBeNull();
    modal.setActiveTab("browse");
    await flushAsync(modal);
    await vi.waitFor(() =>
      expect(modal.querySelector("clan-browse-view input")).not.toBeNull(),
    );
    expect(modal.querySelector("[data-create-clan-start]")).toBeNull();
  });

  it("after a clan is created: refreshes the player, tells the username tag picker and opens the new clan", async () => {
    modal.open();
    await flushAsync(modal);
    modal.setActiveTab("browse");
    await flushAsync(modal);
    await vi.waitFor(() =>
      expect(modal.querySelector("clan-browse-view")).not.toBeNull(),
    );
    const joined = vi.fn();
    window.addEventListener("clan-joined", joined);
    asMock(getUserMe).mockResolvedValue({
      user: REGISTERED,
      player: {
        publicId: "me",
        clans: [
          {
            tag: "WLF",
            name: "Wolves",
            role: "leader",
            joinedAt: "2024-01-01T00:00:00Z",
            memberCount: 1,
          },
        ],
        clanRequests: [],
      },
    } as never);
    modal.querySelector("clan-browse-view")!.dispatchEvent(
      new CustomEvent("clan-created", {
        detail: {
          clan: {
            name: "Wolves",
            tag: "WLF",
            description: "",
            isOpen: true,
            memberCount: 1,
          },
        },
        bubbles: true,
        composed: true,
      }),
    );
    await vi.waitFor(() => expect(joined).toHaveBeenCalled());
    window.removeEventListener("clan-joined", joined);
    expect((joined.mock.calls[0][0] as CustomEvent).detail).toEqual({
      tag: "WLF",
    });
    await vi.waitFor(() =>
      expect(getElState(modal, "selectedClanTag")).toBe("WLF"),
    );
  });
});
