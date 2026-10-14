import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@lit-labs/virtualizer/virtualize.js", async () => {
  const { html } = await import("lit");
  return {
    virtualize: vi.fn(() => html``),
  };
});

const loadModalMock = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("../../src/client/LazyModals", () => ({ loadModal: loadModalMock }));

vi.mock("../../src/client/Utils", () => ({
  translateText: vi.fn((key: string) => {
    const translations: Record<string, string> = {
      "leaderboard_modal.win_score_tooltip":
        "Weighted wins based on clan participation and match difficulty",
      "leaderboard_modal.loss_score_tooltip":
        "Weighted losses based on clan participation and match difficulty",
      "leaderboard_modal.title": "Leaderboard",
      "leaderboard_modal.ranked_tab": "Ranked",
      "leaderboard_modal.ranked_2v2_tab": "2v2 Ranked",
      "leaderboard_modal.ranked_no_stats": "No ranked games on this ladder",
      "leaderboard_modal.clans_tab": "Clans",
      "leaderboard_modal.refresh_time": "Refreshed every 1 hour",
      "leaderboard_modal.error": "Something went wrong",
      "leaderboard_modal.rank": "Rank",
      "leaderboard_modal.basic_tab": "Players",
      "leaderboard_modal.basic_no_stats": "No players are listed yet",
      "leaderboard_modal.period_all": "All time",
      "leaderboard_modal.period_30d": "Last 30 days",
      "leaderboard_modal.refresh_time_basic": "Refreshed every 5 minutes",
      "leaderboard_modal.wins": "Wins",
      "leaderboard_modal.win_rate": "Win rate",
      "leaderboard_modal.tribes_tab": "Tribes",
      "leaderboard_modal.ranked_ffa_tab": "FFA Ranked",
      "leaderboard_modal.clan": "Clan",
      "leaderboard_modal.games": "Games",
      "leaderboard_modal.win_score": "Win Score",
      "leaderboard_modal.loss_score": "Loss Score",
      "leaderboard_modal.win_loss_ratio": "W/L",
      "leaderboard_modal.ratio": "Ratio",
      "leaderboard_modal.elo": "Elo",
      "leaderboard_modal.player": "Player",
      "common.loading": "Loading",
      "leaderboard_modal.try_again": "Try Again",
      "leaderboard_modal.no_data_yet": "No data yet",
      "leaderboard_modal.no_stats": "No stats",
      "leaderboard_modal.your_ranking": "Your ranking",
      "common.close": "Close",
    };
    return translations[key] || key;
  }),
}));

vi.mock("../../src/client/Api", async () => {
  // Share the real end-of-list matcher so this mock cannot drift from it.
  const { isPageBoundsMessage } = await vi.importActual<
    typeof import("../../src/client/Api")
  >("../../src/client/Api");
  const getApiBase = () => "http://localhost:3000";
  return {
    getApiBase: vi.fn(getApiBase),
    getUserMe: vi.fn(async () => false),
    isPageBoundsMessage,
    // Mirrors the control flow of the real fetchPlayerLeaderboard.
    fetchPlayerLeaderboard: vi.fn(async (page: number) => {
      const url = new URL(`${getApiBase()}/leaderboard/ranked`);
      url.searchParams.set("page", String(page));
      const res = await fetch(url.toString(), {
        headers: { Accept: "application/json" },
      });
      if (!res.ok) {
        if (res.status === 400) {
          const body = await res.json().catch(() => null);
          if (isPageBoundsMessage(body)) return "reached_limit";
        }
        return false;
      }
      return res.json();
    }),
    // Mirrors the control flow of the real fetchBasicPlayerLeaderboard.
    fetchBasicPlayerLeaderboard: vi.fn(
      async (page: number, period: string = "all") => {
        const url = new URL(`${getApiBase()}/leaderboard/players`);
        url.searchParams.set("page", String(page));
        url.searchParams.set("period", period);
        const res = await fetch(url.toString(), {
          headers: { Accept: "application/json" },
        });
        if (!res.ok) {
          if (res.status === 400) {
            const body = await res.json().catch(() => null);
            if (isPageBoundsMessage(body)) return "reached_limit";
          }
          return false;
        }
        return res.json();
      },
    ),
    // Mirrors the real fetchTribeLeaderboard: page 1, plus page 2 only when
    // page 1 came back exactly full.
    fetchTribeLeaderboard: vi.fn(async () => {
      const load = async (page: number) => {
        const url = new URL(`${getApiBase()}/leaderboard/tribes`);
        url.searchParams.set("page", String(page));
        const res = await fetch(url.toString(), {
          headers: { Accept: "application/json" },
        });
        return res.ok ? res.json() : false;
      };
      const first = await load(1);
      if (first === false || first.tribes.length < 50) return first;
      const second = await load(2);
      if (second === false) return first;
      return { ...first, tribes: [...first.tribes, ...second.tribes] };
    }),
  };
});

vi.mock("../../src/client/ClanApi", () => {
  const getApiBase = () => "http://localhost:3000";
  return {
    fetchClanLeaderboard: vi.fn(async () => {
      const res = await fetch(`${getApiBase()}/public/clans/leaderboard`, {
        headers: { Accept: "application/json" },
      });
      if (!res.ok) return false;
      return res.json();
    }),
  };
});

const jsonRes = (data: any, ok = true, status = 200) => ({
  ok,
  status,
  json: async () => data,
});

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: any) => {
      const url =
        typeof input === "string" ? input : (input?.url ?? String(input));

      if (url.includes("/public/clans/leaderboard")) {
        return jsonRes({ start: "...", end: "...", clans: [] });
      }
      if (url.includes("/leaderboard/ranked")) {
        return jsonRes({ "1v1": [], "2v2": [] });
      }
      if (url.includes("/leaderboard/tribes")) {
        return jsonRes({
          windowDays: 30,
          start: "2026-06-27",
          end: "2026-07-27",
          tribes: [],
        });
      }
      return jsonRes({}, false, 404);
    }),
  );
});

import { RankedType } from "@openfront/engine-api/game/GameTypes";
import { ACCOUNT_FEATURES } from "@openfront/shared/AccountFeatures";
import "../../src/client/components/baseComponents/Modal";
import { LeaderboardModal } from "../../src/client/LeaderboardModal";

describe("LeaderboardModal", () => {
  let modal: LeaderboardModal;
  const awaitChildUpdate = async (selector: string) => {
    const el = modal.querySelector(selector) as {
      updateComplete?: Promise<unknown>;
    } | null;
    if (el?.updateComplete) {
      await el.updateComplete;
    }
  };
  const getClanTable = () =>
    modal.querySelector("leaderboard-clan-table") as {
      loadClanLeaderboard: () => Promise<void>;
      updateComplete: Promise<unknown>;
    } | null;
  const getPlayerList = () =>
    modal.querySelector("leaderboard-player-list") as {
      loadPlayerLeaderboard: (reset?: boolean) => Promise<void>;
      updateComplete: Promise<unknown>;
      rankedType: RankedType;
      playerData: Array<Record<string, unknown>>;
      currentUserEntry?: { playerId: string } | null;
      showStickyUser: boolean;
    } | null;
  // The list element is shared by both ladder tabs; the modal drives which
  // ladder it shows off the active tab.
  const showLadder = async (tab: string) => {
    (modal as unknown as { activeTab: string }).activeTab = tab;
    await modal.updateComplete;
    const playerList = getPlayerList()!;
    await playerList.updateComplete;
    return playerList;
  };

  beforeEach(async () => {
    vi.stubGlobal("fetch", vi.fn());
    if (!customElements.get("leaderboard-modal")) {
      customElements.define("leaderboard-modal", LeaderboardModal);
    }
    modal = document.createElement("leaderboard-modal") as LeaderboardModal;
    document.body.appendChild(modal);
    await modal.updateComplete;
  });

  afterEach(() => {
    document.body.removeChild(modal);
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  describe("Tooltip Implementation - Issue #2508", () => {
    it("should render Win Score and Loss Score columns with title attributes", async () => {
      // Mock fetch to return sample clan leaderboard data
      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          start: "2025-01-01T00:00:00Z",
          end: "2025-01-07T23:59:59Z",
          clans: [
            {
              clanTag: "[TEST]",
              games: 10,
              wins: 8,
              losses: 2,
              playerSessions: 25,
              weightedWins: 8.5,
              weightedLosses: 1.5,
              weightedWLRatio: 5.67,
            },
            {
              clanTag: "[DEMO]",
              games: 8,
              wins: 6,
              losses: 2,
              playerSessions: 20,
              weightedWins: 6.0,
              weightedLosses: 2.0,
              weightedWLRatio: 3.0,
            },
          ],
        }),
      });

      (modal as unknown as { activeTab: string }).activeTab = "clans";
      const clanTable = getClanTable();
      expect(clanTable).toBeTruthy();
      await clanTable!.loadClanLeaderboard();
      await clanTable!.updateComplete;

      const allHeaders = modal.querySelectorAll("th");
      let winScoreHeader: Element | null = null;
      let lossScoreHeader: Element | null = null;

      // Find the headers by their text content and title attribute
      allHeaders.forEach((th) => {
        const title = th.getAttribute("title");
        if (title?.includes("Weighted wins")) {
          winScoreHeader = th;
        } else if (title?.includes("Weighted losses")) {
          lossScoreHeader = th;
        }
      });

      // Assert that headers exist with correct tooltip text
      expect(winScoreHeader).toBeTruthy();
      expect(lossScoreHeader).toBeTruthy();

      expect(winScoreHeader!.getAttribute("title")).toBe(
        "Weighted wins based on clan participation and match difficulty",
      );
      expect(lossScoreHeader!.getAttribute("title")).toBe(
        "Weighted losses based on clan participation and match difficulty",
      );
    });

    it("should use translateText for tooltip internationalization", async () => {
      // Verify translation keys are correct
      const { translateText } = await import("../../src/client/Utils");

      expect(translateText("leaderboard_modal.win_score_tooltip")).toBe(
        "Weighted wins based on clan participation and match difficulty",
      );
      expect(translateText("leaderboard_modal.loss_score_tooltip")).toBe(
        "Weighted losses based on clan participation and match difficulty",
      );
    });
  });

  describe("Player Data Mapping", () => {
    it("should map ranked leaderboard data and set current user entry", async () => {
      const { getUserMe } = await import("../../src/client/Api");
      (getUserMe as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        player: { publicId: "player-2" },
      });

      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          "1v1": [
            {
              rank: 1,
              elo: 1200,
              peakElo: 1300,
              wins: 6,
              losses: 4,
              total: 10,
              public_id: "player-1",
              accountUsername: "alpha.4821",
            },
            {
              rank: 2,
              elo: 1100,
              peakElo: 1250,
              wins: 4,
              losses: 6,
              total: 10,
              public_id: "player-2",
              accountUsername: null,
            },
          ],
          "2v2": [],
        }),
      });

      const playerList = getPlayerList();
      expect(playerList).toBeTruthy();
      await playerList!.loadPlayerLeaderboard(true);
      await playerList!.updateComplete;

      const playerData = playerList!.playerData;

      expect(playerData).toHaveLength(2);
      expect(playerData[0]).toEqual(
        expect.objectContaining({
          playerId: "player-1",
          accountUsername: "alpha.4821",
          elo: 1200,
          games: 10,
          wins: 6,
          losses: 4,
          winRate: 0.6,
        }),
      );
      // No account username: the player-name component displays public_id.
      expect(playerData[1]).toEqual(
        expect.objectContaining({
          playerId: "player-2",
          accountUsername: null,
          winRate: 0.4,
        }),
      );
      expect(playerList!.currentUserEntry?.playerId).toBe("player-2");
      expect(modal.textContent).toContain("player-2");
    });

    // The pinned "your ranking" row has to stay inside the table — its column
    // widths come from the table's own colgroup, so anything rendered outside
    // it goes out of alignment the moment the modal is resized. The cell count
    // is what breaks if a column is added to the header and not the footer.
    it("pins the user row as a tfoot inside the table", async () => {
      const { getUserMe } = await import("../../src/client/Api");
      (getUserMe as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        player: { publicId: "player-1" },
      });

      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
        jsonRes({
          "1v1": [
            {
              rank: 1,
              elo: 1200,
              peakElo: 1300,
              wins: 6,
              losses: 4,
              total: 10,
              public_id: "player-1",
              accountUsername: "alpha.4821",
            },
          ],
          "2v2": [],
        }),
      );

      const playerList = getPlayerList()!;
      await playerList.loadPlayerLeaderboard(true);
      // jsdom has no layout, so the scroll-position check that normally drives
      // this always concludes the user's own row is on screen. Force it on.
      playerList.showStickyUser = true;
      await playerList.updateComplete;

      const table = modal.querySelector("leaderboard-player-list table")!;
      const tfoot = table.querySelector(":scope > tfoot");
      expect(tfoot).toBeTruthy();
      expect(tfoot!.querySelectorAll("td")).toHaveLength(
        table.querySelectorAll("thead th").length,
      );
    });

    // opacity leaves the row in flow: hiding it that way reserved a row of
    // blank space at the end of the table.
    it("removes the pinned row from the table when it is not showing", async () => {
      const { getUserMe } = await import("../../src/client/Api");
      (getUserMe as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        player: { publicId: "player-1" },
      });

      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
        jsonRes({
          "1v1": [
            {
              rank: 1,
              elo: 1200,
              peakElo: 1300,
              wins: 6,
              losses: 4,
              total: 10,
              public_id: "player-1",
              accountUsername: "alpha.4821",
            },
          ],
          "2v2": [],
        }),
      );

      const playerList = getPlayerList()!;
      await playerList.loadPlayerLeaderboard(true);
      playerList.showStickyUser = false;
      await playerList.updateComplete;

      expect(playerList.currentUserEntry?.playerId).toBe("player-1");
      expect(
        modal.querySelector("leaderboard-player-list table tfoot"),
      ).toBeNull();
    });
  });

  describe("Player Pagination", () => {
    const rankedPage = (count: number, startRank: number) => ({
      "1v1": Array.from({ length: count }, (_, i) => ({
        rank: startRank + i,
        elo: 2000 - (startRank + i),
        peakElo: 2000,
        wins: 5,
        losses: 5,
        total: 10,
        public_id: `player-${startRank + i}`,
        accountUsername: null,
      })),
      "2v2": [],
    });

    // The body the API actually sends for a page past the end.
    const pastEnd = jsonRes(
      { error: "Bad request", message: "Page must be between 1 and 2" },
      false,
      400,
    );

    it("stops paging past the last page without showing an error", async () => {
      const fetchMock = global.fetch as ReturnType<typeof vi.fn>;
      fetchMock
        .mockResolvedValueOnce(jsonRes(rankedPage(50, 1)))
        .mockResolvedValueOnce(pastEnd);

      const playerList = getPlayerList()!;
      await playerList.loadPlayerLeaderboard(true);
      await playerList.updateComplete;
      expect(playerList.playerData).toHaveLength(50);

      await playerList.loadPlayerLeaderboard();
      await playerList.updateComplete;

      expect(playerList.playerData).toHaveLength(50);
      expect(modal.textContent).not.toContain("Try Again");

      // The end of the list is sticky: no further requests are made.
      const callCount = fetchMock.mock.calls.length;
      await playerList.loadPlayerLeaderboard();
      expect(fetchMock.mock.calls.length).toBe(callCount);
    });

    it("stops paging on a short page", async () => {
      const fetchMock = global.fetch as ReturnType<typeof vi.fn>;
      fetchMock.mockResolvedValueOnce(jsonRes(rankedPage(20, 1)));

      const playerList = getPlayerList()!;
      await playerList.loadPlayerLeaderboard(true);
      await playerList.updateComplete;

      const callCount = fetchMock.mock.calls.length;
      await playerList.loadPlayerLeaderboard();
      expect(fetchMock.mock.calls.length).toBe(callCount);
      expect(modal.textContent).not.toContain("Try Again");
    });

    // Only the page-bounds 400 means "end of data".
    it.each([
      ["500", jsonRes({}, false, 500)],
      ["unrelated 400", jsonRes({ error: "Bad request" }, false, 400)],
      [
        "400 mentioning a page",
        jsonRes(
          { error: "Bad request", message: "Invalid page parameter" },
          false,
          400,
        ),
      ],
    ])("shows Try Again when a page genuinely fails (%s)", async (_, bad) => {
      const fetchMock = global.fetch as ReturnType<typeof vi.fn>;
      fetchMock
        .mockResolvedValueOnce(jsonRes(rankedPage(50, 1)))
        .mockResolvedValueOnce(bad);

      const playerList = getPlayerList()!;
      await playerList.loadPlayerLeaderboard(true);
      await playerList.updateComplete;

      await playerList.loadPlayerLeaderboard();
      await playerList.updateComplete;

      expect(modal.textContent).toContain("Try Again");
    });
  });

  // 1v1 and 2v2 are independent ladders returned by one request: same player,
  // own rank and elo on each, own end of list.
  describe("Ranked ladders", () => {
    const entry = (rank: number, publicId: string, elo: number) => ({
      rank,
      elo,
      peakElo: elo,
      wins: 1,
      losses: 1,
      total: 2,
      public_id: publicId,
      accountUsername: publicId,
    });

    it("ranks a player separately on each ladder", async () => {
      const { getUserMe } = await import("../../src/client/Api");
      (getUserMe as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        player: { publicId: "player-2" },
      });

      const fetchMock = global.fetch as ReturnType<typeof vi.fn>;
      fetchMock.mockResolvedValueOnce(
        jsonRes({
          "1v1": [entry(1, "player-1", 1200), entry(2, "player-2", 1100)],
          "2v2": [entry(1, "player-2", 1500), entry(2, "player-3", 1400)],
        }),
      );

      const playerList = getPlayerList()!;
      await playerList.loadPlayerLeaderboard(true);
      await playerList.updateComplete;

      expect(playerList.rankedType).toBe(RankedType.OneVOne);
      expect(playerList.playerData.map((p) => p.playerId)).toEqual([
        "player-1",
        "player-2",
      ]);
      expect(playerList.playerData[1].elo).toBe(1100);
      expect(playerList.currentUserEntry?.playerId).toBe("player-2");

      // One request filled both ladders, so switching tabs must not refetch.
      const callCount = fetchMock.mock.calls.length;
      const twoVTwo = await showLadder("players2v2");

      expect(twoVTwo.rankedType).toBe(RankedType.TwoVTwo);
      expect(twoVTwo.playerData.map((p) => p.playerId)).toEqual([
        "player-2",
        "player-3",
      ]);
      // Same player, other ladder: rank 1 at 1500 rather than rank 2 at 1100.
      expect(twoVTwo.playerData[0].rank).toBe(1);
      expect(twoVTwo.playerData[0].elo).toBe(1500);
      expect(twoVTwo.currentUserEntry?.playerId).toBe("player-2");
      expect(fetchMock.mock.calls.length).toBe(callCount);
    });

    it("shows the FFA ladder from the same request", async () => {
      const fetchMock = global.fetch as ReturnType<typeof vi.fn>;
      fetchMock.mockResolvedValueOnce(
        jsonRes({
          "1v1": [entry(1, "player-1", 1200)],
          "2v2": [],
          ffa: [entry(1, "player-4", 1300), entry(2, "player-1", 1250)],
        }),
      );

      const playerList = getPlayerList()!;
      await playerList.loadPlayerLeaderboard(true);
      const callCount = fetchMock.mock.calls.length;
      const ffa = await showLadder("playersFfa");

      expect(ffa.rankedType).toBe(RankedType.FreeForAll);
      expect(ffa.playerData.map((p) => p.playerId)).toEqual([
        "player-4",
        "player-1",
      ]);
      expect(fetchMock.mock.calls.length).toBe(callCount);
    });

    it("shows an empty FFA ladder when the API has none", async () => {
      // An API deployed before ranked FFA omits the key.
      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
        jsonRes({ "1v1": [entry(1, "player-1", 1200)], "2v2": [] }),
      );

      const playerList = getPlayerList()!;
      await playerList.loadPlayerLeaderboard(true);
      const ffa = await showLadder("playersFfa");

      expect(ffa.playerData).toEqual([]);
      expect(modal.textContent).toContain("No ranked games on this ladder");
    });

    // The 2v2 board starts empty and has no backfill, so an empty ladder is a
    // normal state rather than a failure.
    it("shows a no data state for an empty ladder", async () => {
      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
        jsonRes({ "1v1": [entry(1, "player-1", 1200)], "2v2": [] }),
      );

      const playerList = getPlayerList()!;
      await playerList.loadPlayerLeaderboard(true);
      await showLadder("players2v2");

      expect(modal.textContent).toContain("No data yet");
      expect(modal.textContent).toContain("No ranked games on this ladder");
      expect(
        modal.querySelector(
          "leaderboard-player-list[data-board='ranked'] table",
        ),
      ).toBeNull();
    });

    it("pages the ladders independently", async () => {
      const fetchMock = global.fetch as ReturnType<typeof vi.fn>;
      fetchMock.mockResolvedValueOnce(
        jsonRes({
          "1v1": Array.from({ length: 50 }, (_, i) =>
            entry(i + 1, `solo-${i + 1}`, 2000 - i),
          ),
          // Short page: the younger ladder ends first.
          "2v2": [entry(1, "duo-1", 1500)],
        }),
      );

      const playerList = getPlayerList()!;
      await playerList.loadPlayerLeaderboard(true);
      await playerList.updateComplete;
      expect(playerList.playerData).toHaveLength(50);

      fetchMock.mockResolvedValueOnce(
        jsonRes({ "1v1": [entry(51, "solo-51", 1900)], "2v2": [] }),
      );
      await playerList.loadPlayerLeaderboard();
      await playerList.updateComplete;

      expect(playerList.playerData).toHaveLength(51);
      expect(fetchMock.mock.calls[1][0]).toContain("page=2");

      // The exhausted ladder keeps its row and stops asking for pages.
      const twoVTwo = await showLadder("players2v2");
      expect(twoVTwo.playerData.map((p) => p.playerId)).toEqual(["duo-1"]);

      const callCount = fetchMock.mock.calls.length;
      await twoVTwo.loadPlayerLeaderboard();
      expect(fetchMock.mock.calls.length).toBe(callCount);
    });

    it("selects the 2v2 ladder from its tab", async () => {
      // The tab click also prefetches the clan and tribe tabs, so route by
      // URL: a blanket resolved value would feed them ladder-shaped JSON and
      // crash their renders after the test ends.
      (global.fetch as ReturnType<typeof vi.fn>).mockImplementation(
        async (input: any) => {
          const url =
            typeof input === "string" ? input : (input?.url ?? String(input));
          if (url.includes("/leaderboard/ranked")) {
            return jsonRes({ "1v1": [], "2v2": [] });
          }
          return jsonRes({}, false, 404);
        },
      );

      modal.inline = true;
      await modal.updateComplete;
      const oModal = modal.querySelector("o-modal");
      await (oModal as unknown as { updateComplete: Promise<unknown> })
        .updateComplete;
      const tab = oModal!.shadowRoot!.querySelector(
        'button[role="tab"][data-key="players2v2"]',
      );
      expect(tab).toBeTruthy();

      tab!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      expect((modal as unknown as { activeTab: string }).activeTab).toBe(
        "players2v2",
      );
      await modal.updateComplete;
      expect(getPlayerList()!.rankedType).toBe(RankedType.TwoVTwo);
    });
  });

  describe("Basic players board", () => {
    const basicEntry = (
      rank: number,
      id: string,
      wins: number,
      games = 12,
    ) => ({
      rank,
      playerId: id,
      accountUsername: id === "anon" ? null : `${id}.0001`,
      games,
      wins,
      losses: games - wins,
      winRate: wins / games,
    });
    const getBasicList = () =>
      modal.querySelector("leaderboard-player-list[data-board='basic']") as
        | (HTMLElement & {
            loadPlayerLeaderboard: (reset?: boolean) => Promise<void>;
            ensureLoaded: () => Promise<void>;
            updateComplete: Promise<unknown>;
            playerData: Array<Record<string, unknown>>;
            currentUserEntry?: { playerId: string } | null;
            period: string;
            basic: boolean;
            hasMore?: boolean;
          })
        | null;
    const fetchMock = () => global.fetch as ReturnType<typeof vi.fn>;
    const urlsCalled = () =>
      fetchMock().mock.calls.map((c) => String(c[0])) as string[];
    const loaded = async (players: unknown[]) => {
      fetchMock().mockResolvedValueOnce(jsonRes({ players }));
      const list = getBasicList()!;
      await list.loadPlayerLeaderboard(true);
      await list.updateComplete;
      return list;
    };

    it("is the first tab, ahead of the ranked ladders", () => {
      const tabs = (
        modal as unknown as { modalConfig(): { tabs: { key: string }[] } }
      ).modalConfig().tabs;
      expect(tabs.map((t) => t.key)).toEqual([
        "basic",
        "xp",
        "season",
        "players",
        "players2v2",
        "playersFfa",
        "clans",
        "tribes",
      ]);
    });

    it("lists the rows in the order the server sent, with wins and no Elo column", async () => {
      await loaded([
        basicEntry(1, "ann", 11),
        basicEntry(2, "bob", 9),
        basicEntry(2, "cy", 9),
        basicEntry(4, "dee", 5),
      ]);
      const list = getBasicList()!;
      await list.updateComplete;
      expect(list.playerData.map((p) => p.playerId)).toEqual([
        "ann",
        "bob",
        "cy",
        "dee",
      ]);
      const headers = [...list.querySelectorAll("thead th")].map((th) =>
        th.textContent!.trim(),
      );
      expect(headers).toEqual(["Rank", "Player", "Games", "Wins", "Win rate"]);
      expect(headers).not.toContain("Elo");
      const rows = [...list.querySelectorAll("tbody tr")];
      expect(rows).toHaveLength(4);
      // numeric ranks: the tied pair shows rank 2 twice, then 4
      expect(
        rows.map((r) => r.querySelector("td")!.textContent!.trim()),
      ).toEqual(["👑", "🥈", "🥈", "4"]);
      expect(rows[0].textContent).toContain("11");
      expect(rows[0].textContent).toContain("91.7%");
    });

    it("gives each row the player's account name, or null so their public id is shown", async () => {
      const list = await loaded([
        basicEntry(1, "ann", 10),
        basicEntry(2, "anon", 9),
      ]);
      const names = [...list.querySelectorAll("player-name")].map((el) => {
        const e = el as HTMLElement & {
          username?: string | null;
          publicId?: string;
        };
        return [e.publicId, e.username];
      });
      expect(names).toEqual([
        ["ann", "ann.0001"],
        ["anon", null],
      ]);
    });

    it("clicking a player opens their public profile through the profile modal", async () => {
      const opened: string[] = [];
      const fake = document.createElement(
        "player-profile-modal",
      ) as HTMLElement & {
        openFromLeaderboard: (id: string) => void;
      };
      fake.openFromLeaderboard = (id) => opened.push(id);
      document.body.appendChild(fake);
      const list = await loaded([
        basicEntry(1, "ann", 10),
        basicEntry(2, "bob", 9),
      ]);
      const names = [...list.querySelectorAll("player-name")] as Array<
        HTMLElement & { onNameClick?: () => void }
      >;
      names[1].onNameClick!();
      await vi.waitFor(() => expect(opened).toEqual(["bob"]));
      expect(loadModalMock).toHaveBeenCalledWith("player-profile-modal");
      fake.remove();
    });

    it("pins the signed-in player's own row when they are on the board", async () => {
      const { getUserMe } = await import("../../src/client/Api");
      (getUserMe as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        player: { publicId: "bob" },
      });
      const list = await loaded([
        basicEntry(1, "ann", 11),
        basicEntry(2, "bob", 9),
      ]);
      expect(list.currentUserEntry?.playerId).toBe("bob");
    });

    it("asks the API for the first page of the all-time board, and the 30-day board on request", async () => {
      const list = await loaded([basicEntry(1, "ann", 11)]);
      expect(urlsCalled()[0]).toContain(
        "/leaderboard/players?page=1&period=all",
      );
      fetchMock().mockResolvedValueOnce(
        jsonRes({ players: [basicEntry(1, "bob", 10)] }),
      );
      (list.querySelector("[data-period='30d']") as HTMLButtonElement).click();
      await vi.waitFor(() => {
        expect(
          urlsCalled().some(
            (u) => u.includes("period=30d") && u.includes("page=1"),
          ),
        ).toBe(true);
      });
      await list.updateComplete;
      await vi.waitFor(() => {
        expect(list.playerData.map((p) => p.playerId)).toEqual(["bob"]);
      });
      expect(
        list.querySelector("[data-period='30d']")!.getAttribute("aria-pressed"),
      ).toBe("true");
      expect(
        list.querySelector("[data-period='all']")!.getAttribute("aria-pressed"),
      ).toBe("false");
    });

    it("pages on scroll: the next page is requested with the next number and rows are not repeated", async () => {
      const page1 = Array.from({ length: 50 }, (_, i) =>
        basicEntry(i + 1, `p${i + 1}`, 60 - i),
      );
      const list = await loaded(page1);
      expect(list.playerData).toHaveLength(50);
      fetchMock().mockResolvedValueOnce(
        jsonRes({
          // a repeated row (a rebuild moved someone) is not shown twice
          players: [
            page1[49],
            basicEntry(51, "p51", 5),
            basicEntry(52, "p52", 4),
          ],
        }),
      );
      await list.loadPlayerLeaderboard();
      await list.updateComplete;
      expect(urlsCalled()[urlsCalled().length - 1]).toContain("page=2");
      const ids = list.playerData.map((p) => p.playerId as string);
      expect(ids).toHaveLength(52);
      expect(new Set(ids).size).toBe(52);
      // the short second page ends the board: no third request
      const calls = fetchMock().mock.calls.length;
      await list.loadPlayerLeaderboard();
      expect(fetchMock().mock.calls.length).toBe(calls);
    });

    it("stops quietly at the page limit the server reports", async () => {
      const page1 = Array.from({ length: 50 }, (_, i) =>
        basicEntry(i + 1, `p${i + 1}`, 60 - i),
      );
      const list = await loaded(page1);
      fetchMock().mockResolvedValueOnce(
        jsonRes({ message: "Page must be between 1 and 1" }, false, 400),
      );
      await list.loadPlayerLeaderboard();
      await list.updateComplete;
      expect(list.playerData).toHaveLength(50);
      expect(list.textContent).not.toContain("Something went wrong");
    });

    it("shows a loading state while the first page is in flight", async () => {
      let release!: (v: unknown) => void;
      fetchMock().mockReturnValueOnce(new Promise((r) => (release = r)));
      const list = getBasicList()!;
      const pending = list.loadPlayerLeaderboard(true);
      await list.updateComplete;
      expect(list.textContent).toContain("Loading");
      expect(list.querySelector("table")).toBeNull();
      // the period switch is still there
      expect(list.querySelector("[data-period='all']")).not.toBeNull();
      release(jsonRes({ players: [] }));
      await pending;
    });

    it("shows an empty state, not an error, for a board with nobody on it", async () => {
      const list = await loaded([]);
      await list.updateComplete;
      expect(list.textContent).toContain("No data yet");
      expect(list.textContent).toContain("No players are listed yet");
      expect(list.textContent).not.toContain("Something went wrong");
      expect(list.querySelector("table")).toBeNull();
    });

    it("shows an error state with a retry when the API fails, and retry loads the board", async () => {
      fetchMock().mockResolvedValueOnce(jsonRes({}, false, 500));
      const list = getBasicList()!;
      await list.loadPlayerLeaderboard(true);
      await list.updateComplete;
      expect(list.textContent).toContain("Something went wrong");
      fetchMock().mockResolvedValueOnce(
        jsonRes({ players: [basicEntry(1, "ann", 10)] }),
      );
      const retry = [...list.querySelectorAll("button")].find((b) =>
        b.textContent!.includes("Try Again"),
      )!;
      retry.click();
      await vi.waitFor(() => expect(list.playerData).toHaveLength(1));
      await list.updateComplete;
      expect(list.textContent).not.toContain("Something went wrong");
    });

    it("an answer that does not match the contract is an error, not a crash", async () => {
      fetchMock().mockResolvedValueOnce(jsonRes({ players: "nope" }));
      const list = getBasicList()!;
      await list.loadPlayerLeaderboard(true);
      await list.updateComplete;
      expect(list.textContent).toContain("Something went wrong");
    });

    it("ignores a slow answer for the period the player has already left", async () => {
      let slow!: (v: unknown) => void;
      fetchMock().mockReturnValueOnce(new Promise((r) => (slow = r)));
      const list = getBasicList()!;
      const first = list.loadPlayerLeaderboard(true); // all time, never answers yet
      fetchMock().mockResolvedValueOnce(
        jsonRes({ players: [basicEntry(1, "recent", 10)] }),
      );
      (list.querySelector("[data-period='30d']") as HTMLButtonElement).click();
      await vi.waitFor(() =>
        expect(list.playerData.map((p) => p.playerId)).toEqual(["recent"]),
      );
      slow(jsonRes({ players: [basicEntry(1, "stale", 99)] }));
      await first;
      await list.updateComplete;
      expect(list.playerData.map((p) => p.playerId)).toEqual(["recent"]);
    });
  });

  describe("Feature gating of the tabs", () => {
    const rebuild = async () => {
      document.body.removeChild(modal);
      modal = document.createElement("leaderboard-modal") as LeaderboardModal;
      document.body.appendChild(modal);
      await modal.updateComplete;
    };
    const tabKeys = () =>
      (modal as unknown as { modalConfig(): { tabs: { key: string }[] } })
        .modalConfig()
        .tabs.map((t) => t.key);

    it("with only the leaderboards feature, just the basic board exists: no ranked, clan or tribe tab or element", async () => {
      Object.assign(ACCOUNT_FEATURES, {
        ranked: false,
        clans: false,
        tribes: false,
        progression: false,
      });
      await rebuild();
      expect(tabKeys()).toEqual(["basic"]);
      expect(
        modal.querySelector("leaderboard-player-list[data-board='ranked']"),
      ).toBeNull();
      expect(modal.querySelector("leaderboard-clan-table")).toBeNull();
      expect(modal.querySelector("leaderboard-tribe-table")).toBeNull();
      expect(
        modal.querySelector("leaderboard-player-list[data-board='basic']"),
      ).not.toBeNull();
      expect(modal.textContent).not.toMatch(/Ranked|Clans|Tribes/);
    });

    it("each extra feature adds exactly its own tabs", async () => {
      Object.assign(ACCOUNT_FEATURES, {
        ranked: true,
        clans: false,
        tribes: false,
        progression: false,
      });
      await rebuild();
      expect(tabKeys()).toEqual([
        "basic",
        "players",
        "players2v2",
        "playersFfa",
      ]);
      Object.assign(ACCOUNT_FEATURES, {
        ranked: false,
        clans: true,
        tribes: false,
        progression: false,
      });
      await rebuild();
      expect(tabKeys()).toEqual(["basic", "clans"]);
      Object.assign(ACCOUNT_FEATURES, {
        ranked: false,
        clans: false,
        tribes: true,
        progression: false,
      });
      await rebuild();
      expect(tabKeys()).toEqual(["basic", "tribes"]);
    });

    it("progression adds the lifetime XP and season tabs, right after the basic board, and nothing else", async () => {
      Object.assign(ACCOUNT_FEATURES, {
        ranked: false,
        clans: false,
        tribes: false,
        progression: true,
      });
      await rebuild();
      expect(tabKeys()).toEqual(["basic", "xp", "season"]);
      expect(modal.querySelectorAll("leaderboard-xp-table")).toHaveLength(2);
      Object.assign(ACCOUNT_FEATURES, { progression: false });
      await rebuild();
      expect(tabKeys()).toEqual(["basic"]);
      expect(modal.querySelector("leaderboard-xp-table")).toBeNull();
    });

    it("opening the board loads only the basic board, and never calls a ranked, clan or tribe endpoint", async () => {
      Object.assign(ACCOUNT_FEATURES, {
        ranked: false,
        clans: false,
        tribes: false,
        progression: false,
      });
      await rebuild();
      const fetchMock = global.fetch as ReturnType<typeof vi.fn>;
      fetchMock.mockImplementation(async () => jsonRes({ players: [] }));
      (modal as unknown as { onOpen(): void }).onOpen();
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
      await new Promise((r) => setTimeout(r, 30));
      const urls = fetchMock.mock.calls.map((c) => String(c[0]));
      expect(urls.every((u) => u.includes("/leaderboard/players"))).toBe(true);
    });

    it("a link to a ranked tab falls back to the basic board when ranked is off", async () => {
      Object.assign(ACCOUNT_FEATURES, {
        ranked: false,
        clans: false,
        tribes: false,
        progression: false,
      });
      await rebuild();
      (modal as unknown as { activeTab: string }).activeTab = "";
      const tabs = tabKeys();
      expect(tabs.includes("players")).toBe(false);
      expect(tabs[0]).toBe("basic");
    });
  });

  describe("Modal Functionality", () => {
    it("should initialize with default state", () => {
      expect(modal).toBeTruthy();
      // The basic players board comes first.
      expect((modal as unknown as { activeTab: string }).activeTab).toBe(
        "basic",
      );
    });

    it("should be a custom element", () => {
      expect(modal).toBeInstanceOf(LeaderboardModal);
      expect(modal.tagName.toLowerCase()).toBe("leaderboard-modal");
    });

    it("should close on Escape when open", async () => {
      const mockModalEl = { open: vi.fn(), close: vi.fn() };
      Object.defineProperty(modal, "modalEl", {
        get: () => mockModalEl,
        configurable: true,
      });
      (modal as unknown as { onOpen: () => void }).onOpen = vi.fn();

      modal.open();
      expect((modal as unknown as { isModalOpen: boolean }).isModalOpen).toBe(
        true,
      );

      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
      // handleKeyDown awaits confirmBeforeClose() before closing, so the close
      // is deferred to a later microtask — flush it before asserting.
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect((modal as unknown as { isModalOpen: boolean }).isModalOpen).toBe(
        false,
      );
      expect(mockModalEl.close).toHaveBeenCalled();
    });
  });

  describe("Modal Interaction", () => {
    it("should switch to clans tab and request clan leaderboard data", async () => {
      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          start: "2025-01-01T00:00:00Z",
          end: "2025-01-07T23:59:59Z",
          clans: [],
        }),
      });

      modal.inline = true;
      await modal.updateComplete;
      const oModal = modal.querySelector("o-modal");
      await (oModal as unknown as { updateComplete: Promise<unknown> })
        .updateComplete;
      const tab = oModal!.shadowRoot!.querySelector(
        'button[role="tab"][data-key="clans"]',
      );
      expect(tab).toBeTruthy();

      tab!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      expect((modal as unknown as { activeTab: string }).activeTab).toBe(
        "clans",
      );
      expect(global.fetch).toHaveBeenCalledWith(
        "http://localhost:3000/public/clans/leaderboard",
        { headers: { Accept: "application/json" } },
      );
      await Promise.resolve();
      await modal.updateComplete;
      await awaitChildUpdate("leaderboard-clan-table");
    });

    it("should render a no data state for empty clan leaderboard", async () => {
      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          start: "2025-01-01T00:00:00Z",
          end: "2025-01-07T23:59:59Z",
          clans: [],
        }),
      });

      (modal as unknown as { activeTab: string }).activeTab = "clans";
      const clanTable = getClanTable();
      expect(clanTable).toBeTruthy();
      await clanTable!.loadClanLeaderboard();
      await clanTable!.updateComplete;

      expect(modal.textContent).toContain("No data yet");
      expect(modal.textContent).toContain("No stats");
    });

    it("should render an error state when clan leaderboard fails", async () => {
      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: false,
        status: 500,
        json: async () => ({}),
      });

      (modal as unknown as { activeTab: string }).activeTab = "clans";
      const clanTable = getClanTable();
      expect(clanTable).toBeTruthy();
      await clanTable!.loadClanLeaderboard();
      await clanTable!.updateComplete;

      expect(modal.textContent).toContain("Something went wrong");
      expect(modal.textContent).toContain("Try Again");
    });
  });
});
