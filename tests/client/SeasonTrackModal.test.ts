import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/client/Utils", () => ({
  translateText: (key: string, params?: Record<string, string | number>) =>
    params ? `${key}:${JSON.stringify(params)}` : key,
}));

const { claimReward, claimAllRewards, invalidateUserMe, fetchProgressionMe } =
  vi.hoisted(() => ({
    claimReward: vi.fn(async () => ({ currency: { soft: 1, hard: 0 } })),
    claimAllRewards: vi.fn(async () => ({
      claimed: [],
      currency: { soft: 1, hard: 0 },
    })),
    invalidateUserMe: vi.fn(),
    fetchProgressionMe: vi.fn(),
  }));
vi.mock("../../src/client/Api", () => ({
  claimReward,
  claimAllRewards,
  invalidateUserMe,
}));
vi.mock("../../src/client/ProgressionApi", () => ({ fetchProgressionMe }));

import type { ProgressionMe } from "@openfront/shared/ApiSchemas";
import { SeasonTrackModal } from "../../src/client/SeasonTrackModal";

if (!customElements.get("season-track-modal")) {
  customElements.define("season-track-modal", SeasonTrackModal);
}

function me(track: ProgressionMe["seasonTrack"], xp = 8100): ProgressionMe {
  return {
    progress: {
      prestige: 0,
      level: 10,
      xpInLevel: 0,
      xpForNext: 1200,
      lifetimeXp: 7270,
      legend: false,
      canPrestige: false,
    },
    rank: "private",
    nextMilestone: null,
    season: {
      number: 2,
      name: "Winter",
      startsAt: "2026-10-01T00:00:00Z",
      endsAt: "2099-01-01T00:00:00Z",
      xp,
      level: 5,
      maxLevel: 50,
      xpPerLevel: 2000,
    },
    seasonTrack: track,
    challenges: {
      daily: { periodKey: "d", resetsAt: "2099-01-01T00:00:00Z", items: [] },
      weekly: { periodKey: "w", resetsAt: "2099-01-01T00:00:00Z", items: [] },
    },
    titles: [],
    selectedTitle: null,
    history: [],
    levelHidden: false,
  };
}
const entry = (
  level: number,
  over: Partial<ProgressionMe["seasonTrack"][number]> = {},
): ProgressionMe["seasonTrack"][number] => ({
  level,
  credits: 100,
  title: null,
  flare: null,
  unlocked: false,
  claimed: false,
  rewardId: null,
  ...over,
});

let modal: SeasonTrackModal;
async function openWith(data: ProgressionMe | false) {
  fetchProgressionMe.mockResolvedValue(data);
  modal = document.createElement("season-track-modal") as SeasonTrackModal;
  modal.setAttribute("inline", "");
  document.body.appendChild(modal);
  await modal.updateComplete;
  modal.open();
  await vi.waitFor(() => expect(fetchProgressionMe).toHaveBeenCalled());
  await new Promise((r) => setTimeout(r, 0));
  await modal.updateComplete;
  return modal;
}
const q = (sel: string) => modal.querySelector(sel);

beforeEach(() => {
  document.body.innerHTML = "";
  vi.clearAllMocks();
});
afterEach(() => modal?.remove());

describe("<season-track-modal>", () => {
  it("shows the running season with every level of the free track", async () => {
    await openWith(
      me([
        entry(5, { unlocked: true, claimed: true }),
        entry(10, { unlocked: false }),
        entry(25, { title: "veteran", credits: 250 }),
      ]),
    );
    expect(q("[data-season-summary]")?.textContent).toContain("Winter");
    expect(q("[data-season-summary]")?.textContent).toContain('"level":5');
    expect(q("[data-season-level='5']")?.getAttribute("data-state")).toBe(
      "claimed",
    );
    expect(q("[data-season-level='10']")?.getAttribute("data-state")).toBe(
      "locked",
    );
    expect(q("[data-season-level='25']")?.textContent).toContain(
      'progression.title_season_veteran:{"season":"2"}',
    );
  });

  it("claims one unlocked reward, then reads the track again", async () => {
    await openWith(me([entry(5, { unlocked: true, rewardId: "41" })]));
    (q("[data-season-claim='41']") as HTMLButtonElement).click();
    await vi.waitFor(() => expect(claimReward).toHaveBeenCalledWith("41"));
    await vi.waitFor(() => expect(invalidateUserMe).toHaveBeenCalled());
    await vi.waitFor(() => expect(fetchProgressionMe).toHaveBeenCalledTimes(2));
    expect(claimAllRewards).not.toHaveBeenCalled();
  });

  it("offers Claim all only when several are waiting", async () => {
    await openWith(me([entry(5, { unlocked: true, rewardId: "1" })]));
    expect(q("[data-season-claim-all]")).toBeNull();
    modal.remove();
    await openWith(
      me([
        entry(5, { unlocked: true, rewardId: "1" }),
        entry(10, { unlocked: true, rewardId: "2" }),
      ]),
    );
    (q("[data-season-claim-all]") as HTMLButtonElement).click();
    await vi.waitFor(() => expect(claimAllRewards).toHaveBeenCalled());
  });

  it("says so when no season is running, and when it can't load", async () => {
    const none = me([]);
    none.season = null;
    await openWith(none);
    expect(q("[data-season-none]")).not.toBeNull();
    modal.remove();
    await openWith(false);
    expect(q("[data-season-failed]")).not.toBeNull();
  });
});
