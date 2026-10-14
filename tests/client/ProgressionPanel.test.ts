import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/client/Utils", () => ({
  translateText: (key: string, params?: Record<string, string | number>) =>
    params ? `${key}:${JSON.stringify(params)}` : key,
}));
vi.mock("../../src/client/ProgressionApi", () => ({
  fetchProgressionMe: vi.fn(async () => false),
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

  it("draws the progression cards, not the identity (that is the account header's)", async () => {
    await mount(me());
    expect(q("[data-progression-challenges]")).not.toBeNull();
    expect(q("[data-progression-season]")).not.toBeNull();
    expect(q("[data-progression-rank]")).toBeNull();
    expect(q("[data-progression-milestone]")).toBeNull();
    expect(q("[data-progression-title]")).toBeNull();
    // each section is a card of its own, stacked
    expect(q("[data-progression-panel]")?.className).toContain("flex-col");
  });

  it("announces what it read, with the titles and the next milestone", async () => {
    panel = document.createElement("progression-panel") as ProgressionPanel;
    const loaded = vi.fn();
    panel.addEventListener("progression-loaded", (e) =>
      loaded((e as CustomEvent<ProgressionMe>).detail),
    );
    panel.load = vi.fn(async () => me());
    panel.now = () => NOW;
    document.body.appendChild(panel);
    await vi.waitFor(() => expect(loaded).toHaveBeenCalledTimes(1));
    const detail = loaded.mock.calls[0][0] as ProgressionMe;
    expect(detail.titles).toEqual(["veteran", "prestige:1"]);
    expect(detail.selectedTitle).toBe("veteran");
    expect(detail.nextMilestone?.level).toBe(50);
    // and again on a refresh
    await panel.refresh();
    expect(loaded).toHaveBeenCalledTimes(2);
  });

  it("announces nothing when the read fails", async () => {
    panel = document.createElement("progression-panel") as ProgressionPanel;
    const loaded = vi.fn();
    panel.addEventListener("progression-loaded", loaded);
    panel.load = vi.fn(async () => false as const);
    document.body.appendChild(panel);
    await vi.waitFor(() => expect(panel.load).toHaveBeenCalled());
    await panel.updateComplete;
    expect(loaded).not.toHaveBeenCalled();
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
    expect(weekly.querySelector("[data-progression-credits]")).not.toBeNull();
    expect(weekly.textContent).toContain('"credits":"150"');
    expect(
      weekly.querySelector("[data-xp-bar]")?.getAttribute("aria-valuenow"),
    ).toBe("40");
    expect(open.querySelector("[data-progression-credits]")).toBeNull();
  });

  it("heads the card with how many challenges are complete", async () => {
    await mount(me());
    const card = q("[data-progression-challenges]")!;
    expect(card.querySelector("h3")?.textContent).toContain(
      "progression.challenges_title",
    );
    // one of the four is done
    expect(q("[data-progression-total]")?.textContent).toBe(
      'progression.challenges_complete:{"done":1,"total":4}',
    );
  });

  it("counts none done, and all done", async () => {
    const data = me();
    for (const c of [
      ...data.challenges.daily.items,
      ...data.challenges.weekly.items,
    ]) {
      c.completed = false;
      c.progress = 0;
    }
    await mount(data);
    expect(q("[data-progression-total]")?.textContent).toContain('"done":0');
    for (const c of [
      ...data.challenges.daily.items,
      ...data.challenges.weekly.items,
    ]) {
      c.completed = true;
      c.progress = c.target;
    }
    // a fresh read, as the server would answer it
    (panel.load as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      structuredClone(data),
    );
    await panel.refresh();
    await panel.updateComplete;
    expect(q("[data-progression-total]")?.textContent).toContain('"done":4');
  });

  it("gives the daily and the weekly set each their own heading and reset timer", async () => {
    await mount(me());
    const daily = q('[data-progression-period="daily"]')!;
    const weekly = q('[data-progression-period="weekly"]')!;
    expect(daily.querySelector("h4")?.textContent).toContain(
      "progression.challenges_daily",
    );
    expect(weekly.querySelector("h4")?.textContent).toContain(
      "progression.challenges_weekly",
    );
    // 12h to the next UTC midnight, 5d 12h to the next Monday
    expect(
      daily.querySelector("[data-progression-resets]")?.textContent,
    ).toContain('"time":"12h 0m"');
    expect(
      weekly.querySelector("[data-progression-resets]")?.textContent,
    ).toContain('"time":"4d 12h"');
  });

  it("shows each row's name, count and a reward column of its own", async () => {
    await mount(me());
    const open = q('[data-progression-challenge="d_games_2"]')!;
    expect(open.textContent).toContain("progression.challenge_d_games_2");
    // progress / target over the bar, the reward in a separate column
    expect(open.querySelector("[data-progression-count]")?.textContent).toBe(
      "1 / 2",
    );
    const reward = open.querySelector("[data-progression-reward]")!;
    expect(reward.textContent).toContain('"xp":"200"');
    expect(reward.className).toContain("border-l");
    expect(reward.className).toContain("shrink-0");
    expect(reward.contains(open.querySelector("[data-xp-bar]"))).toBe(false);
    // a long name wraps inside its column instead of pushing the reward out
    const name = open.querySelector("span.min-w-0")!;
    expect(name.className).toContain("break-words");
  });

  it("marks a completed row and clamps its count", async () => {
    const data = me();
    data.challenges.daily.items[1].progress = 3;
    await mount(data);
    const done = q('[data-progression-challenge="d_win_1"]')!;
    expect(
      done.querySelector("[data-progression-count]")?.textContent,
    ).toContain("progression.challenge_completed");
    expect(
      done.querySelector("[data-xp-bar]")?.getAttribute("aria-valuenow"),
    ).toBe("100");
  });

  it("puts the Credits reward under the XP only where there is one", async () => {
    await mount(me());
    const weekly = q('[data-progression-challenge="w_wins_5"]')!;
    const reward = weekly.querySelector("[data-progression-reward]")!;
    const xp = reward.firstElementChild!;
    expect(xp.textContent).toContain("progression.xp_total");
    expect(reward.querySelector("credits-icon")).not.toBeNull();
    expect(
      [...reward.children].indexOf(
        reward.querySelector("[data-progression-credits]")!,
      ),
    ).toBe(1);
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
    expect(load).toHaveBeenCalledTimes(2);
  });
});
