import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/client/Utils", () => ({
  translateText: (key: string, params?: Record<string, string | number>) =>
    params ? `${key}:${JSON.stringify(params)}` : key,
}));
vi.mock("../../src/client/Cosmetics", () => ({
  translateCosmetic: (prefix: string, name: string) => `${prefix}/${name}`,
}));
vi.mock("../../src/client/Api", () => ({
  claimReward: vi.fn(),
  invalidateUserMe: vi.fn(),
}));
vi.mock("../../src/client/InGameModal", () => ({
  showInGameAlert: vi.fn(async () => undefined),
}));
vi.mock("../../src/client/ProgressionApi", () => ({
  fetchProgressionTrack: vi.fn(async () => false),
}));

import type { ProgressionTrack } from "@openfront/shared/ApiSchemas";
import { LEVEL_MILESTONES } from "@openfront/shared/ProgressionRules";
import { showInGameAlert } from "../../src/client/InGameModal";
import "../../src/client/components/ProgressionTab";
import type { ProgressionTab } from "../../src/client/components/ProgressionTab";

/** The server's track for an account at `level`, with `claimed` / `ready` levels as given. */
function track(
  level: number,
  opts: {
    claimed?: number[];
    ready?: number[];
    xpInLevel?: number;
    xpForNext?: number;
    prestige?: number;
    wins?: number;
    prestigeHistory?: ProgressionTrack["prestigeHistory"];
  } = {},
): ProgressionTrack {
  return {
    progress: {
      prestige: opts.prestige ?? 0,
      level,
      xpInLevel: opts.xpInLevel ?? 1000,
      xpForNext: opts.xpForNext ?? 4000,
      lifetimeXp: 100_000,
      legend: false,
      canPrestige: level >= 100,
    },
    levels: LEVEL_MILESTONES.map((m) => ({
      level: m.level,
      credits: m.credits,
      title: m.title,
      flare: m.flare,
      unlocked: level >= m.level,
      claimed: opts.claimed?.includes(m.level) ?? false,
      rewardId: opts.ready?.includes(m.level) ? `r${m.level}` : null,
    })),
    prestigeHistory: opts.prestigeHistory ?? [],
    wins: opts.wins ?? 0,
  };
}

let tab: ProgressionTab;
const q = <T extends Element = HTMLElement>(sel: string) =>
  tab.querySelector<T>(sel);
const qa = (sel: string) => [...tab.querySelectorAll<HTMLElement>(sel)];

async function mount(
  data: ProgressionTrack | false,
  setup?: (t: ProgressionTab) => void,
) {
  tab = document.createElement("progression-tab") as ProgressionTab;
  tab.load = async () => data;
  setup?.(tab);
  document.body.appendChild(tab);
  await tab.updateComplete;
  await new Promise((resolve) => setTimeout(resolve, 0));
  await tab.updateComplete;
}

beforeEach(() => {
  vi.stubGlobal(
    "requestAnimationFrame",
    (fn: FrameRequestCallback) =>
      setTimeout(() => fn(0), 0) as unknown as number,
  );
});
afterEach(() => {
  tab?.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("the reward track", () => {
  it("draws all 100 levels, in order, as plain numbered nodes", async () => {
    await mount(track(12));
    const nodes = qa("[data-track-level]");
    expect(nodes).toHaveLength(100);
    expect(nodes.map((n) => Number(n.dataset.trackLevel))).toEqual(
      Array.from({ length: 100 }, (_, i) => i + 1),
    );
    expect(
      q("[data-track-level='1'] [data-track-circle]")?.textContent,
    ).toContain("1");
    expect(
      q("[data-track-level='100'] [data-track-circle]")?.textContent,
    ).toContain("100");
  });

  it("highlights the player's level, and only that one", async () => {
    await mount(track(12));
    const current = qa("[data-level-state='current']");
    expect(current).toHaveLength(1);
    expect(current[0].dataset.trackLevel).toBe("12");
    expect(
      current[0]
        .querySelector("[data-track-circle]")
        ?.getAttribute("aria-current"),
    ).toBe("step");
    expect(qa("[data-level-state='passed']")).toHaveLength(11);
    expect(qa("[data-level-state='locked']")).toHaveLength(88);
    expect(
      current[0].querySelector("[data-track-circle]")?.className,
    ).toContain("df-track-current");
  });

  it("shows progress to the next level: the XP, the strip and the marker", async () => {
    await mount(track(50, { xpInLevel: 500, xpForNext: 1000 }));
    expect(q("[data-track-xp]")?.textContent).toContain(
      'progression.xp_progress:{"current":"500","next":"1,000"}',
    );
    const bar = q("[data-track-bar]")!;
    const expected = ((49 + 0.5) / 99) * 100;
    expect(Number(bar.getAttribute("aria-valuenow"))).toBe(
      Math.round(expected),
    );
    // the fill eases in from nothing, then reads the same value
    await new Promise((resolve) => setTimeout(resolve, 5));
    await tab.updateComplete;
    expect(parseFloat(q("[data-track-fill]")!.style.width)).toBeCloseTo(
      expected,
      4,
    );
    expect(q("[data-track-you]")?.textContent).toContain('"level":50');
  });

  it("says max level instead of an XP figure at 100", async () => {
    await mount(track(100, { xpInLevel: 0, xpForNext: 0 }));
    expect(q("[data-track-xp]")?.textContent).toContain(
      "progression.max_level",
    );
    expect(q("[data-track-bar]")?.getAttribute("aria-valuenow")).toBe("100");
  });

  it("shows the authoritative reward on the levels that pay", async () => {
    await mount(track(1));
    const rewards = qa("[data-track-reward]");
    expect(rewards.map((r) => Number(r.dataset.trackReward))).toEqual([
      5, 10, 25, 50, 75, 100,
    ]);
    const credits = (level: number) =>
      q(`[data-track-reward='${level}'] [data-track-credits]`)?.textContent;
    expect(credits(5)).toContain('"credits":"250"');
    expect(credits(10)).toContain('"credits":"500"');
    expect(credits(25)).toContain('"credits":"750"');
    expect(credits(50)).toContain('"credits":"1,000"');
    expect(credits(75)).toContain('"credits":"1,500"');
    expect(credits(100)).toContain('"credits":"2,500"');
    // the cosmetics and titles the server lists
    expect(q("[data-track-reward='10'] [data-track-flare]")?.textContent).toBe(
      "flags/recruit_banner",
    );
    expect(q("[data-track-reward='50'] [data-track-flare]")?.textContent).toBe(
      "territory_patterns.pattern/officer_chevrons",
    );
    expect(q("[data-track-reward='75'] [data-track-flare]")?.textContent).toBe(
      "effects/colonel_wake",
    );
    expect(
      q("[data-track-reward='25'] [data-track-title]")?.textContent,
    ).toContain("progression.title_veteran");
    expect(q("[data-track-reward='5'] [data-track-flare]")).toBeNull();
    expect(q("[data-track-reward='5'] [data-track-title]")).toBeNull();
  });

  it("invents no reward on any other level", async () => {
    await mount(track(30));
    const plain = qa("[data-track-level]").filter(
      (n) =>
        !LEVEL_MILESTONES.some((m) => m.level === Number(n.dataset.trackLevel)),
    );
    expect(plain).toHaveLength(94);
    for (const node of plain) {
      expect(node.querySelector("[data-track-reward]")).toBeNull();
      expect(node.querySelector("credits-icon")).toBeNull();
      expect(node.dataset.rewardState).toBeUndefined();
      expect(node.querySelector("button")).toBeNull();
    }
    expect(qa("credits-icon")).toHaveLength(6);
  });

  it("marks a claimed reward, a ready one and a locked one apart", async () => {
    await mount(track(30, { claimed: [5], ready: [10, 25] }));
    const state = (level: number) =>
      q(`[data-track-reward='${level}']`)?.dataset.state;
    expect(state(5)).toBe("claimed");
    expect(state(10)).toBe("ready");
    expect(state(25)).toBe("ready");
    expect(state(50)).toBe("locked");
    expect(state(100)).toBe("locked");
    // claimed: no button, a check; ready: a claim button; locked: neither
    expect(q("[data-track-reward='5'] button")).toBeNull();
    expect(
      q("[data-track-reward='5'] [data-track-status]")?.textContent,
    ).toContain("progression.claimed");
    expect(q("[data-track-reward='10'] button")?.dataset.trackClaim).toBe(
      "r10",
    );
    expect(q("[data-track-reward='50'] button")).toBeNull();
    expect(
      q("[data-track-reward='50'] [data-track-status]")?.textContent,
    ).toContain("progression.locked");
    expect(q("[data-track-level='10']")?.dataset.rewardState).toBe("ready");
    expect(
      q("[data-track-level='10'] [data-track-circle]")?.className,
    ).toContain("df-track-ready");
    expect(qa("[data-track-claim]")).toHaveLength(2);
  });

  it("has no claim button for a level that is not reached, even if told otherwise", async () => {
    const data = track(8);
    data.levels[3].rewardId = "sneaky"; // level 50: not reached
    await mount(data);
    expect(q("[data-track-reward='50'] button")).toBeNull();
    expect(q("[data-track-reward='50']")?.dataset.state).toBe("locked");
  });

  it("explains the three states in a legend", async () => {
    await mount(track(1));
    const legend = q("[data-track-legend]")!.textContent!;
    expect(legend).toContain("progression.claimed");
    expect(legend).toContain("progression.track_ready");
    expect(legend).toContain("progression.locked");
  });
});

describe("claiming", () => {
  async function claimSetup(
    result: unknown,
    after: ProgressionTrack = track(30, { claimed: [10], ready: [] }),
  ) {
    const claim = vi.fn(async () => result);
    const loads = [track(30, { ready: [10] }), after];
    const load = vi.fn(async () => loads.shift() ?? after);
    const claimed = vi.fn();
    await mount(false, (t) => {
      t.load = load;
      t.claim = claim as never;
      t.addEventListener("progression-claimed", claimed);
    });
    return { claim, load, claimed };
  }

  it("goes through the existing reward claim with the server's reward id, then reads the track again", async () => {
    const { claim, load, claimed } = await claimSetup({
      currency: { soft: 500, hard: 0 },
    });
    q<HTMLButtonElement>("[data-track-claim='r10']")!.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await tab.updateComplete;
    expect(claim).toHaveBeenCalledTimes(1);
    expect(claim).toHaveBeenCalledWith("r10");
    expect(claimed).toHaveBeenCalledTimes(1);
    expect(load).toHaveBeenCalledTimes(2);
    // what the server now says: claimed, popped once, no button
    expect(q("[data-track-reward='10']")?.dataset.state).toBe("claimed");
    expect(q("[data-track-claim]")).toBeNull();
    expect(q("[data-track-level='10'] .df-claim-pop")).not.toBeNull();
  });

  it("sends one claim for a double click", async () => {
    let release!: (v: unknown) => void;
    const slow = new Promise((resolve) => {
      release = resolve;
    });
    const claim = vi.fn(() => slow);
    await mount(false, (t) => {
      t.load = async () => track(30, { ready: [10, 25] });
      t.claim = claim as never;
    });
    const button = q<HTMLButtonElement>("[data-track-claim='r10']")!;
    button.click();
    button.click();
    q<HTMLButtonElement>("[data-track-claim='r25']")!.click();
    await tab.updateComplete;
    expect(claim).toHaveBeenCalledTimes(1);
    expect(q<HTMLButtonElement>("[data-track-claim='r25']")!.disabled).toBe(
      true,
    );
    release({ currency: { soft: 1, hard: 0 } });
  });

  it("treats a reward claimed elsewhere as claimed: no error, no pop, the track is read again", async () => {
    const { claim, load } = await claimSetup("not_found");
    q<HTMLButtonElement>("[data-track-claim='r10']")!.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await tab.updateComplete;
    expect(claim).toHaveBeenCalledTimes(1);
    expect(load).toHaveBeenCalledTimes(2);
    expect(showInGameAlert).not.toHaveBeenCalled();
    expect(q("[data-track-reward='10']")?.dataset.state).toBe("claimed");
    expect(q(".df-claim-pop")).toBeNull();
  });

  it("says so when the claim fails, and leaves the reward claimable", async () => {
    const { claimed } = await claimSetup(false);
    q<HTMLButtonElement>("[data-track-claim='r10']")!.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await tab.updateComplete;
    expect(showInGameAlert).toHaveBeenCalledTimes(1);
    expect(claimed).not.toHaveBeenCalled();
    expect(q("[data-track-claim='r10']")).not.toBeNull();
  });

  it("keeps a claimed reward claimed after a refresh", async () => {
    await mount(track(30, { claimed: [5, 10] }));
    await tab.refresh();
    await tab.updateComplete;
    expect(q("[data-track-reward='5']")?.dataset.state).toBe("claimed");
    expect(q("[data-track-reward='10']")?.dataset.state).toBe("claimed");
    expect(qa("[data-track-claim]")).toHaveLength(0);
  });
});

describe("the prestige history", () => {
  it("says the player hasn't prestiged when they haven't", async () => {
    await mount(track(12));
    expect(q("[data-prestige-empty]")?.textContent).toContain(
      "progression.prestige_history_empty",
    );
    expect(qa("[data-prestige-event]")).toHaveLength(0);
  });

  it("lists each stored prestige, newest first, with its date and reward", async () => {
    await mount(
      track(3, {
        prestige: 2,
        prestigeHistory: [
          {
            prestige: 2,
            fromPrestige: 1,
            runXpBefore: 524_800,
            lifetimeXp: 1_100_000,
            at: "2026-09-02T10:00:00Z",
            credits: 1000,
            claimed: false,
          },
          {
            prestige: 1,
            fromPrestige: 0,
            runXpBefore: 524_800,
            lifetimeXp: 600_000,
            at: "2026-08-01T10:00:00Z",
            credits: 1000,
            claimed: true,
          },
        ],
      }),
    );
    const events = qa("[data-prestige-event]");
    expect(events.map((e) => e.dataset.prestigeEvent)).toEqual(["2", "1"]);
    expect(events[0].textContent).toContain('"rank":2');
    expect(events[0].textContent).toContain('"xp":"524,800"');
    expect(
      events[0].querySelector("[data-prestige-date]")?.textContent?.trim(),
    ).toBe(new Date("2026-09-02T10:00:00Z").toLocaleDateString());
    expect(
      events[0].querySelector("[data-prestige-reward]")?.textContent,
    ).toContain("progression.prestige_history_reward_waiting");
    expect(
      events[1].querySelector("[data-prestige-reward]")?.textContent,
    ).toContain("progression.prestige_history_reward_claimed");
    expect(q("[data-prestige-empty]")).toBeNull();
  });

  it("shows no reward line for a prestige with no reward row", async () => {
    await mount(
      track(3, {
        prestige: 1,
        prestigeHistory: [
          {
            prestige: 1,
            fromPrestige: 0,
            runXpBefore: 1,
            lifetimeXp: 1,
            at: "2026-08-01T10:00:00Z",
            credits: null,
            claimed: null,
          },
        ],
      }),
    );
    expect(q("[data-prestige-reward]")).toBeNull();
  });
});

describe("the win milestones", () => {
  it("lock every one at no wins", async () => {
    await mount(track(1, { wins: 0 }));
    const marks = qa("[data-win-milestone]");
    expect(marks.map((m) => m.dataset.winMilestone)).toEqual([
      "10",
      "25",
      "50",
      "75",
      "100",
    ]);
    expect(marks.every((m) => m.dataset.state === "locked")).toBe(true);
    expect(marks[0].dataset.current).toBe("true");
    expect(marks[0].textContent).toContain('"current":0,"target":10');
  });

  it("achieve the ones reached and show progress on the next", async () => {
    await mount(track(1, { wins: 30 }));
    const state = (n: number) =>
      q(`[data-win-milestone='${n}']`)?.dataset.state;
    expect([10, 25, 50, 75, 100].map(state)).toEqual([
      "achieved",
      "achieved",
      "locked",
      "locked",
      "locked",
    ]);
    expect(q("[data-win-milestone='50']")?.dataset.current).toBe("true");
    expect(q("[data-win-milestone='50']")?.textContent).toContain(
      '"current":30,"target":50',
    );
    expect(q("[data-win-milestone='10']")?.textContent).toContain(
      "progression.milestone_achieved",
    );
    expect(q("[data-milestones-total]")?.textContent).toContain('"count":"30"');
    expect(q("[data-win-milestone='100']")?.textContent).toContain(
      "progression.milestone_conqueror",
    );
  });

  it("achieve all of them at 100 wins", async () => {
    await mount(track(1, { wins: 100 }));
    expect(
      qa("[data-win-milestone]").every((m) => m.dataset.state === "achieved"),
    ).toBe(true);
    expect(qa("[data-current]")).toHaveLength(0);
  });
});

describe("the page", () => {
  it("has the three sections, in order, with a staggered entrance", async () => {
    await mount(track(12));
    const sections = qa("[data-progression-section]");
    expect(sections.map((s) => s.dataset.progressionSection)).toEqual([
      "track",
      "prestige",
      "milestones",
    ]);
    expect(
      sections.map((s) => Number(s.style.getPropertyValue("--i"))),
    ).toEqual([0, 1, 2]);
    expect(sections.every((s) => s.classList.contains("df-enter"))).toBe(true);
  });

  it("says when it cannot load, and while it loads", async () => {
    tab = document.createElement("progression-tab") as ProgressionTab;
    let finish!: (v: ProgressionTrack | false) => void;
    tab.load = () =>
      new Promise((resolve) => {
        finish = resolve;
      });
    document.body.appendChild(tab);
    await tab.updateComplete;
    expect(q("[data-progression-loading]")).not.toBeNull();
    finish(false);
    await new Promise((resolve) => setTimeout(resolve, 0));
    await tab.updateComplete;
    expect(q("[data-progression-failed]")).not.toBeNull();
    expect(q("[data-progression-tab]")).toBeNull();
  });
});

describe("scrolling the track", () => {
  // jsdom has no layout: give every node a position from its level, and the
  // scroller a width, so centring has something to work with.
  beforeEach(() => {
    vi.spyOn(HTMLElement.prototype, "offsetLeft", "get").mockImplementation(
      function (this: HTMLElement) {
        return Number(this.dataset.trackLevel ?? 0) * 100;
      },
    );
    vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(100);
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(500);
    vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockReturnValue(
      10_000,
    );
  });

  it("opens centred on the player's level", async () => {
    await mount(track(40));
    // node 40 starts at 4000 and is 100 wide: centred in 500 → 4000 - 200
    expect(q("[data-track-scroller]")!.scrollLeft).toBe(3800);
  });

  it("opens at the start for a new player", async () => {
    await mount(track(1));
    expect(q("[data-track-scroller]")!.scrollLeft).toBe(0);
  });

  it("moves with the arrows, most of a screenful at a time", async () => {
    await mount(track(1));
    const scroller = q("[data-track-scroller]")!;
    // a browser fires `scroll` after the move; jsdom does not
    const press = async (sel: string) => {
      q<HTMLButtonElement>(sel)!.click();
      scroller.dispatchEvent(new Event("scroll"));
      await tab.updateComplete;
    };
    await press("[data-track-next]");
    expect(scroller.scrollLeft).toBe(400);
    await press("[data-track-next]");
    expect(scroller.scrollLeft).toBe(800);
    await press("[data-track-prev]");
    expect(scroller.scrollLeft).toBe(400);
    await press("[data-track-prev]");
    expect(scroller.scrollLeft).toBe(0);
    expect(q<HTMLButtonElement>("[data-track-prev]")!.disabled).toBe(true);
  });

  it("disables the arrow that has nowhere to go", async () => {
    await mount(track(1));
    expect(q<HTMLButtonElement>("[data-track-prev]")!.disabled).toBe(true);
    expect(q<HTMLButtonElement>("[data-track-next]")!.disabled).toBe(false);
  });

  it("is a horizontal, swipeable strip that never widens the modal", async () => {
    await mount(track(1));
    const scroller = q("[data-track-scroller]")!;
    const cls = scroller.className;
    expect(cls).toContain("overflow-x-auto");
    expect(cls).toContain("min-w-0");
    expect(cls).toContain("touch-pan-x");
    expect(cls).toContain("snap-x");
    expect(cls).toContain("overscroll-x-contain");
    // the arrows are for pointers: a phone swipes
    expect(q("[data-track-prev]")!.className).toContain("hidden");
    expect(q("[data-track-prev]")!.className).toContain("sm:flex");
    // nodes keep their size however narrow the screen
    expect(
      qa("[data-track-level]").every((n) => n.className.includes("shrink-0")),
    ).toBe(true);
    expect(scroller.getAttribute("role")).toBe("list");
  });
});

describe("reduced motion", () => {
  const reduce = () =>
    vi.stubGlobal(
      "matchMedia",
      vi.fn((query: string) => ({ matches: query.includes("reduce") })),
    );

  it("plays no entrance", async () => {
    reduce();
    await mount(track(12), (t) => {
      t.openKey = "rm-1";
    });
    expect(
      q("[data-progression-tab]")!.classList.contains("account-intro"),
    ).toBe(false);
  });

  it("plays the entrance once per opening otherwise", async () => {
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({ matches: false })),
    );
    await mount(track(12), (t) => {
      t.openKey = "once-1";
    });
    expect(
      q("[data-progression-tab]")!.classList.contains("account-intro"),
    ).toBe(true);
    tab.remove();
    await mount(track(12), (t) => {
      t.openKey = "once-1";
    });
    expect(
      q("[data-progression-tab]")!.classList.contains("account-intro"),
    ).toBe(false);
  });

  it("jumps instead of gliding when the arrows are used", async () => {
    reduce();
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(500);
    vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockReturnValue(
      10_000,
    );
    await mount(track(1));
    const scroller = q("[data-track-scroller]")!;
    const glide = vi.fn();
    (scroller as unknown as { scrollTo: unknown }).scrollTo = glide;
    q<HTMLButtonElement>("[data-track-next]")!.click();
    expect(glide).not.toHaveBeenCalled();
    expect(scroller.scrollLeft).toBe(400);
  });

  it("glides when motion is fine", async () => {
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({ matches: false })),
    );
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(500);
    vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockReturnValue(
      10_000,
    );
    await mount(track(1));
    const scroller = q("[data-track-scroller]")!;
    const glide = vi.fn();
    (scroller as unknown as { scrollTo: unknown }).scrollTo = glide;
    q<HTMLButtonElement>("[data-track-next]")!.click();
    expect(glide).toHaveBeenCalledWith({ left: 400, behavior: "smooth" });
  });

  it("turns the bar's ease, and the pulses and the pop, off in CSS", async () => {
    await mount(track(12));
    expect(q("[data-track-fill]")!.className).toContain(
      "motion-reduce:transition-none",
    );
    const css = readFileSync("src/client/styles.css", "utf8");
    for (const name of ["df-track-current", "df-track-ready", "df-claim-pop"]) {
      expect(css).toContain(`@keyframes ${name}`);
    }
    expect(css).toMatch(
      /prefers-reduced-motion: reduce\) \{\s*\.df-track-current,\s*\.df-track-ready,\s*\.df-claim-pop \{\s*animation: none;/,
    );
  });
});
