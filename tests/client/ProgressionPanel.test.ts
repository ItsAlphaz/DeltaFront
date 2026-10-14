import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/client/Utils", () => ({
  translateText: (key: string, params?: Record<string, string | number>) =>
    params ? `${key}:${JSON.stringify(params)}` : key,
}));
vi.mock("../../src/client/ProgressionApi", () => ({
  fetchProgressionMe: vi.fn(async () => false),
  putDisplayTitle: vi.fn(async () => true),
}));

import type { ProgressionMe } from "@openfront/shared/ApiSchemas";
import "../../src/client/components/ProgressionPanel";
import {
  compactDuration,
  type ProgressionPanel,
} from "../../src/client/components/ProgressionPanel";

const NOW = Date.parse("2026-10-14T12:00:00Z");

function me(over: Partial<ProgressionMe> = {}): ProgressionMe {
  return {
    progress: {
      prestige: 0,
      level: 47,
      xpInLevel: 1000,
      xpForNext: 4000,
      lifetimeXp: 100_000,
      legend: false,
      canPrestige: false,
    },
    rank: "lieutenant",
    nextMilestone: { level: 50, credits: 1000, flare: null, title: "elite" },
    season: {
      number: 1,
      name: "Opening",
      startsAt: "2026-10-01T00:00:00Z",
      endsAt: "2026-10-26T12:00:00Z",
      xp: 7850,
      level: 4,
      maxLevel: 50,
      xpPerLevel: 2000,
    },
    seasonTrack: [
      {
        level: 5,
        credits: 100,
        title: null,
        flare: null,
        unlocked: false,
        claimed: false,
        rewardId: null,
      },
    ],
    challenges: {
      daily: {
        periodKey: "d:2026-10-14",
        resetsAt: "2026-10-15T00:00:00Z",
        items: [
          {
            id: "d_games_2",
            period: "daily",
            slot: 0,
            metric: "games",
            target: 2,
            progress: 1,
            xp: 200,
            credits: 0,
            completed: false,
          },
          {
            id: "d_win_1",
            period: "daily",
            slot: 1,
            metric: "wins",
            target: 1,
            progress: 1,
            xp: 400,
            credits: 0,
            completed: true,
          },
          {
            id: "d_elim_1",
            period: "daily",
            slot: 2,
            metric: "eliminations",
            target: 1,
            progress: 0,
            xp: 250,
            credits: 0,
            completed: false,
          },
        ],
      },
      weekly: {
        periodKey: "w:2026-W42",
        resetsAt: "2026-10-19T00:00:00Z",
        items: [
          {
            id: "w_wins_5",
            period: "weekly",
            slot: 1,
            metric: "wins",
            target: 5,
            progress: 2,
            xp: 2000,
            credits: 150,
            completed: false,
          },
        ],
      },
    },
    titles: ["veteran", "prestige:1"],
    selectedTitle: "veteran",
    history: [
      { amount: 620, source: "match", at: "2026-10-14T10:00:00Z" },
      {
        amount: 31,
        source: "match",
        detail: "private_game",
        at: "2026-10-14T09:30:00Z",
      },
      {
        amount: 25,
        source: "match",
        detail: "public_too_few_humans",
        at: "2026-10-14T09:20:00Z",
      },
      {
        amount: 25,
        source: "match",
        detail: "unlisted_game",
        at: "2026-10-14T09:10:00Z",
      },
      { amount: -50, source: "admin_revoke", at: "2026-10-14T09:00:00Z" },
    ],
    levelHidden: false,
    ...over,
  };
}

let panel: ProgressionPanel;

async function mount(
  data: ProgressionMe | false,
  extra: Partial<ProgressionPanel> = {},
) {
  panel = document.createElement("progression-panel") as ProgressionPanel;
  panel.load = vi.fn(async () => data);
  panel.now = () => NOW;
  Object.assign(panel, extra);
  document.body.appendChild(panel);
  await vi.waitFor(() => expect(panel.load).toHaveBeenCalled());
  await panel.updateComplete;
  return panel;
}
const q = (sel: string) => panel.querySelector(sel);

beforeEach(() => {
  document.body.innerHTML = "";
});
afterEach(() => panel?.remove());

describe("compactDuration", () => {
  it("shows the two largest units, and at least a minute", () => {
    expect(compactDuration(12 * 60_000)).toBe("12m");
    expect(compactDuration(5 * 3_600_000 + 20 * 60_000)).toBe("5h 20m");
    expect(compactDuration(2 * 86_400_000 + 3 * 3_600_000)).toBe("2d 3h");
    expect(compactDuration(0)).toBe("1m");
    expect(compactDuration(-5)).toBe("1m");
  });
});

describe("<progression-panel>", () => {
  it("draws nothing while the section is off or has failed to load", async () => {
    await mount(false);
    expect(panel.querySelector("[data-progression-panel]")).toBeNull();
  });

  it("shows the rank, the next milestone and the chosen title", async () => {
    await mount(me());
    expect(q("[data-progression-rank]")?.textContent).toBe(
      "progression.rank_lieutenant",
    );
    expect(q("[data-progression-milestone]")?.textContent).toContain(
      '"level":50',
    );
    const select = q("[data-progression-title]") as HTMLSelectElement;
    expect([...select.options].map((o) => o.value)).toEqual([
      "",
      "veteran",
      "prestige:1",
    ]);
    expect(select.selectedOptions[0].value).toBe("veteran");
  });

  it("saves a title choice and tells the page", async () => {
    const saveTitle = vi.fn(async () => true);
    await mount(me(), { saveTitle });
    const changed = vi.fn();
    panel.addEventListener("title-changed", changed);
    const select = q("[data-progression-title]") as HTMLSelectElement;
    select.value = "prestige:1";
    select.dispatchEvent(new Event("change"));
    await vi.waitFor(() =>
      expect(saveTitle).toHaveBeenCalledWith("prestige:1"),
    );
    await vi.waitFor(() => expect(changed).toHaveBeenCalled());
    select.value = "";
    select.dispatchEvent(new Event("change"));
    await vi.waitFor(() => expect(saveTitle).toHaveBeenCalledWith(null));
  });

  it("lists the season with its XP and when it ends", async () => {
    await mount(me());
    const season = q("[data-progression-season]")!;
    expect(season.textContent).toContain('"name":"Opening","level":4');
    expect(season.textContent).toContain('"time":"12d 0h"');
    expect(q("[data-progression-open-track]")).not.toBeNull();
    expect(q("[data-progression-track-badge]")).toBeNull();
  });

  it("badges the track button with the rewards waiting to be claimed", async () => {
    const data = me();
    data.seasonTrack[0] = {
      ...data.seasonTrack[0],
      unlocked: true,
      rewardId: "9",
    };
    await mount(data);
    expect(q("[data-progression-track-badge]")?.textContent).toBe("1");
  });

  it("leaves the season out between seasons", async () => {
    await mount(me({ season: null, seasonTrack: [] }));
    expect(q("[data-progression-season]")).toBeNull();
    expect(q("[data-progression-challenges]")).not.toBeNull();
  });

  it("shows each daily and weekly challenge with its progress, XP and reset time", async () => {
    await mount(me());
    const daily = q('[data-progression-period="daily"]')!;
    expect(daily.querySelectorAll("[data-progression-challenge]")).toHaveLength(
      3,
    );
    expect(daily.textContent).toContain('"time":"12h 0m"');
    const done = q('[data-progression-challenge="d_win_1"]')!;
    expect(done.getAttribute("data-complete")).toBe("true");
    const open = q('[data-progression-challenge="d_games_2"]')!;
    expect(open.getAttribute("data-complete")).toBeNull();
    expect(
      open.querySelector("[data-xp-bar]")?.getAttribute("aria-valuenow"),
    ).toBe("50");
    const weekly = q('[data-progression-challenge="w_wins_5"]')!;
    expect(weekly.textContent).toContain("progression.credits");
    expect(
      weekly.querySelector("[data-xp-bar]")?.getAttribute("aria-valuenow"),
    ).toBe("40");
    expect(open.textContent).not.toContain("progression.credits");
  });

  it("lists recent XP, a revoke as a negative amount", async () => {
    await mount(me());
    const history = q("[data-progression-history]")!;
    expect(history.textContent).toContain("progression.history_match");
    expect(history.textContent).toContain(
      'progression.history_plus:{"xp":"620"}',
    );
    expect(history.textContent).toContain("progression.history_admin_revoke");
    expect(history.textContent).toContain(
      'progression.history_minus:{"xp":"50"}',
    );
    // a reduced match says why, in words, never an internal name
    expect(history.textContent).toContain("progression.history_match_private");
    expect(history.textContent).toContain("progression.history_match_low_pop");
    expect(history.textContent).toContain("progression.history_match_unlisted");
    expect(history.textContent).not.toContain("private_game");
    expect(history.textContent).not.toContain("reduced");
  });

  it("refresh() reads it again", async () => {
    await mount(me());
    const load = panel.load as ReturnType<typeof vi.fn>;
    load.mockResolvedValueOnce(me({ selectedTitle: null }));
    await panel.refresh();
    await panel.updateComplete;
    expect((q("[data-progression-title]") as HTMLSelectElement).value).toBe("");
  });
});
