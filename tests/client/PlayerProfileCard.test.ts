import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

const fetchPublicPlayerProfileMock = vi.hoisted(() => vi.fn());
const fetchPublicPlayerProgressMock = vi.hoisted(() => vi.fn());

vi.mock("../../src/client/Utils", () => ({
  translateText: vi.fn((key: string) => key),
  copyToClipboard: vi.fn(),
  getDiscordAvatarUrl: vi.fn(() => null),
}));
vi.mock("../../src/client/Api", () => ({
  fetchPublicPlayerProfile: fetchPublicPlayerProfileMock,
  // The profile card's game history asks for a page of games when it opens.
  fetchPublicPlayerGames: vi.fn(async () => ({
    results: [],
    nextCursor: null,
  })),
}));
vi.mock("../../src/client/ProgressionApi", () => ({
  fetchPublicPlayerProgress: fetchPublicPlayerProgressMock,
}));
vi.mock(
  "../../src/client/components/baseComponents/stats/PlayerStatsTree",
  () => {
    class FakePlayerStatsTreeView extends HTMLElement {}
    if (!customElements.get("player-stats-tree-view")) {
      customElements.define("player-stats-tree-view", FakePlayerStatsTreeView);
    }
    return { PlayerStatsTreeView: FakePlayerStatsTreeView };
  },
);

import { modalRouter } from "../../src/client/ModalRouter";
import { initNavigation } from "../../src/client/Navigation";
import { PlayerProfileModal } from "../../src/client/PlayerProfileModal";

// Another player's Stats page opens on the same profile header your own Account
// page has: the avatar with the level chip, the clan, the name and its badges,
// the lifetime XP, LEVEL · RANK and the segmented XP bar, with the stats right
// under it and the Stats / Games / Clans tabs still working.

const PROGRESS = {
  prestige: 0,
  level: 1,
  lifetimeXp: 25,
  legend: false,
  xpInLevel: 25,
  xpForNext: 500,
  rank: "recruit",
  title: null,
  season: null,
};

describe("another player's profile page", () => {
  let modal: PlayerProfileModal;
  let playPage: HTMLElement;

  beforeAll(() => {
    playPage = document.createElement("div");
    playPage.id = "page-play";
    document.body.appendChild(playPage);
    initNavigation();
  });
  afterAll(() => playPage.remove());

  beforeEach(async () => {
    fetchPublicPlayerProfileMock.mockReset();
    fetchPublicPlayerProgressMock.mockReset();
    vi.stubGlobal("localStorage", { getItem: vi.fn(() => null) });
    history.replaceState(null, "", "/");
    modalRouter.register("profile", {
      tag: "player-profile-modal",
      pageId: "page-profile",
    });
    if (!customElements.get("player-profile-modal")) {
      customElements.define("player-profile-modal", PlayerProfileModal);
    }
    modal = document.createElement(
      "player-profile-modal",
    ) as PlayerProfileModal;
    modal.id = "page-profile";
    modal.setAttribute("inline", "");
    modal.className = "hidden page-content";
    document.body.appendChild(modal);
    await modal.updateComplete;
  });

  afterEach(() => {
    window.showPage?.("page-play");
    modal.remove();
    history.replaceState(null, "", "/");
    vi.unstubAllGlobals();
  });

  async function open(
    profile: Record<string, unknown> = {},
    progress: Record<string, unknown> | false = PROGRESS,
  ) {
    fetchPublicPlayerProfileMock.mockResolvedValue({
      createdAt: "2026-01-01T00:00:00.000Z",
      stats: { Public: {} },
      username: "CptMendoYen.5807",
      verified: true,
      staffRole: "owner",
      clans: [{ tag: "DELTA" }],
      ...profile,
    });
    fetchPublicPlayerProgressMock.mockResolvedValue(progress);
    history.replaceState(null, "", "/#modal=profile&publicID=HA5YVqg83y");
    expect(modalRouter.routeFromHash()).toBe(true);
    await vi.waitFor(async () => {
      await modal.updateComplete;
      expect(modal.querySelector("profile-card [data-ph-root]")).not.toBeNull();
    });
  }
  const q = (sel: string) => modal.querySelector<HTMLElement>(sel);

  it("heads the stats with the shared profile header", async () => {
    await open();
    const card = q("profile-card")!;
    expect(card.querySelector("[data-ph-identity]")).not.toBeNull();
    expect(card.querySelector("[data-ph-progression]")).not.toBeNull();
    expect(card.querySelector("[data-xp-segmented]")).not.toBeNull();
    expect(card.querySelector("[data-ph-level-chip]")?.textContent).toBe("1");
    expect(card.querySelector("[data-ph-lifetime]")?.textContent).toBe("25");
    expect(card.querySelector("[data-ph-rank]")?.textContent).toBe(
      "progression.rank_recruit",
    );
    expect(card.querySelector("[data-ph-clan]")?.textContent).toBe("[DELTA]");
    // the stats come right under it
    expect(
      card.compareDocumentPosition(q("player-stats-tree-view")!) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("shows the name, discriminator, verified check and staff badge in the card", async () => {
    await open();
    const card = q("profile-card")!;
    expect(card.querySelector("[data-ph-name]")?.textContent).toBe(
      "CptMendoYen.5807",
    );
    expect(
      card.querySelector('svg[aria-label="username.verified_player"]'),
    ).not.toBeNull();
    expect(
      card
        .querySelector("[data-ph-chip=staff]")
        ?.getAttribute("data-staff-role"),
    ).toBe("owner");
    expect(card.querySelector("[data-ph-chip=verified]")).not.toBeNull();
  });

  it("shows no badge for an ordinary player, and never a private control", async () => {
    await open({
      username: "Plain.0001",
      verified: false,
      staffRole: undefined,
    });
    const card = q("profile-card")!;
    expect(card.querySelector("[data-ph-chip]")).toBeNull();
    expect(card.querySelector("select")).toBeNull();
    expect(card.querySelector("button")).toBeNull();
    expect(card.querySelector("currency-display")).toBeNull();
    expect(card.querySelector("[data-ph-title-row]")).toBeNull();
  });

  it("shows the title the player made public", async () => {
    await open({}, { ...PROGRESS, title: "veteran" });
    expect(q("profile-card [data-ph-title]")?.textContent).toBe(
      "★ progression.title_veteran",
    );
  });

  it("leaves the card out while progression is off, and keeps the stats", async () => {
    fetchPublicPlayerProfileMock.mockResolvedValue({
      createdAt: "2026-01-01T00:00:00.000Z",
      stats: { Public: {} },
    });
    fetchPublicPlayerProgressMock.mockResolvedValue(false);
    history.replaceState(null, "", "/#modal=profile&publicID=HA5YVqg83y");
    modalRouter.routeFromHash();
    await vi.waitFor(async () => {
      await modal.updateComplete;
      expect(q("player-stats-tree-view")).not.toBeNull();
    });
    expect(q("profile-card")).toBeNull();
  });

  it("opens the card with its flourish once, and not again on a tab switch", async () => {
    // each test has its own modal: name this opening apart from the others
    (modal as unknown as { openCount: number }).openCount = 500;
    await open();
    const card = q("profile-card")!;
    expect(
      card
        .querySelector("[data-ph-root]")
        ?.classList.contains("profile-card-intro"),
    ).toBe(true);
    modal.setActiveTab("games");
    await modal.updateComplete;
    modal.setActiveTab("stats");
    await vi.waitFor(() =>
      expect(q("profile-card [data-ph-root]")).not.toBeNull(),
    );
    expect(
      q("profile-card [data-ph-root]")!.classList.contains(
        "profile-card-intro",
      ),
    ).toBe(false);
  });

  it("still has its Stats, Games and Clans tabs", async () => {
    await open();
    const tabs = (
      modal as unknown as { modalConfig(): { tabs: { key: string }[] } }
    )
      .modalConfig()
      .tabs.map((t) => t.key);
    expect(tabs).toEqual(["stats", "games", "clans"]);
    modal.setActiveTab("clans");
    await modal.updateComplete;
    expect(q("profile-card")).toBeNull();
    modal.setActiveTab("stats");
    await vi.waitFor(() => expect(q("profile-card")).not.toBeNull());
  });
});
