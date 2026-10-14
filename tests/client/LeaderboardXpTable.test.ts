import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/client/Utils", () => ({
  translateText: (key: string, params?: Record<string, string | number>) =>
    params ? `${key}:${JSON.stringify(params)}` : key,
}));
const { fetchXpLeaderboard, fetchSeasonLeaderboard } = vi.hoisted(() => ({
  fetchXpLeaderboard: vi.fn(),
  fetchSeasonLeaderboard: vi.fn(),
}));
vi.mock("../../src/client/ProgressionApi", () => ({
  fetchXpLeaderboard,
  fetchSeasonLeaderboard,
}));

import type { XpLeaderboardEntry } from "@openfront/shared/ApiSchemas";
import "../../src/client/components/leaderboard/LeaderboardXpTable";
import type { LeaderboardXpTable } from "../../src/client/components/leaderboard/LeaderboardXpTable";

const row = (
  rank: number,
  name: string,
  xp: number,
  level = 12,
): XpLeaderboardEntry => ({
  rank,
  playerId: `id${rank}`,
  accountUsername: name,
  prestige: 0,
  level,
  legend: false,
  xp,
});

let table: LeaderboardXpTable;
async function mount(mode: "lifetime" | "season") {
  table = document.createElement("leaderboard-xp-table") as LeaderboardXpTable;
  table.mode = mode;
  document.body.appendChild(table);
  await table.updateComplete;
  await table.ensureLoaded();
  await table.updateComplete;
  return table;
}

beforeEach(() => {
  document.body.innerHTML = "";
  vi.clearAllMocks();
});
afterEach(() => table?.remove());

describe("<leaderboard-xp-table>", () => {
  it("lists lifetime XP with a level badge and rank on every row", async () => {
    fetchXpLeaderboard.mockResolvedValue({
      players: [row(1, "ann", 9000, 40), row(2, "bob", 500)],
    });
    await mount("lifetime");
    const rows = table.querySelectorAll("[data-xp-row]");
    expect(rows).toHaveLength(2);
    expect(rows[0].querySelector("level-badge")).not.toBeNull();
    expect(rows[0].textContent).toContain("progression.rank_lieutenant");
    expect(rows[0].textContent).toContain("9,000");
    expect(fetchSeasonLeaderboard).not.toHaveBeenCalled();
  });

  it("asks for the next page and appends it, stopping at the end", async () => {
    fetchXpLeaderboard
      .mockResolvedValueOnce({ players: [row(1, "ann", 9000)] })
      .mockResolvedValueOnce({ players: [row(2, "bob", 500)] })
      .mockResolvedValueOnce("reached_limit");
    await mount("lifetime");
    (table.querySelector("[data-xp-more]") as HTMLButtonElement).click();
    await vi.waitFor(() =>
      expect(table.querySelectorAll("[data-xp-row]")).toHaveLength(2),
    );
    expect(fetchXpLeaderboard).toHaveBeenLastCalledWith(2);
    (table.querySelector("[data-xp-more]") as HTMLButtonElement).click();
    await vi.waitFor(() =>
      expect(table.querySelector("[data-xp-more]")).toBeNull(),
    );
    expect(table.querySelectorAll("[data-xp-row]")).toHaveLength(2);
  });

  it("shows the running season's name, and lets an archived one be picked", async () => {
    fetchSeasonLeaderboard
      .mockResolvedValueOnce({
        players: [row(1, "ann", 700)],
        season: { number: 2, name: "Winter", archived: false },
        seasons: [
          { number: 2, name: "Winter" },
          { number: 1, name: "Opening" },
        ],
      })
      .mockResolvedValueOnce({
        players: [row(1, "bob", 1100)],
        season: { number: 1, name: "Opening", archived: true },
        seasons: [
          { number: 2, name: "Winter" },
          { number: 1, name: "Opening" },
        ],
      });
    await mount("season");
    expect(table.querySelector("[data-xp-season-name]")?.textContent).toContain(
      "Winter",
    );
    const picker = table.querySelector(
      "[data-xp-season-picker]",
    ) as HTMLSelectElement;
    picker.value = "1";
    picker.dispatchEvent(new Event("change"));
    await vi.waitFor(() =>
      expect(
        table.querySelector("[data-xp-season-name]")?.textContent,
      ).toContain("Opening"),
    );
    expect(fetchSeasonLeaderboard).toHaveBeenLastCalledWith(1, 1);
    expect(table.querySelector("[data-xp-season-name]")?.textContent).toContain(
      "progression.season_archived",
    );
    expect(table.querySelector("[data-xp-row] ")?.textContent).toContain(
      "1,100",
    );
  });

  it("says so when there is nothing yet, or the request fails", async () => {
    fetchXpLeaderboard.mockResolvedValue({ players: [] });
    await mount("lifetime");
    expect(table.querySelector("[data-xp-empty]")).not.toBeNull();
    table.remove();
    fetchXpLeaderboard.mockResolvedValue(false);
    await mount("lifetime");
    expect(table.querySelector("[data-xp-error]")).not.toBeNull();
  });
});
