import type { UserMeResponse } from "@openfront/shared/ApiSchemas";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/client/Utils", () => ({
  translateText: (key: string, params?: Record<string, string | number>) =>
    params ? `${key}:${JSON.stringify(params)}` : key,
  getDiscordAvatarUrl: vi.fn(() => null),
}));

import { render } from "lit";
import "../../src/client/components/AccountProfileHeader";
import type { AccountProfileHeader } from "../../src/client/components/AccountProfileHeader";
import { CurrencyDisplay } from "../../src/client/components/CurrencyDisplay";
import {
  ProfileCard,
  type ProfileCardProgress,
} from "../../src/client/components/ProfileCard";
import {
  claimOpening,
  PLAYED_OPEN_KEYS_KEPT,
} from "../../src/client/components/ProfileHeaderBase";
import { segmentedXpBar } from "../../src/client/components/XpBar";
import { countUp } from "../../src/client/utilities/CountUp";

if (!customElements.get("profile-card")) {
  customElements.define("profile-card", ProfileCard);
}
if (!customElements.get("currency-display")) {
  customElements.define("currency-display", CurrencyDisplay);
}

// The profile system's motion: the flourish another player's profile has
// always had (kept as it was) and the same bouncy feel on your own page, all of
// it subtle, none of it blocking, and none of it under reduced motion.

const PROGRESS: ProfileCardProgress = {
  prestige: 0,
  level: 12,
  legend: false,
  lifetimeXp: 9000,
  xpInLevel: 1000,
  xpForNext: 4000,
};
const LEGEND: ProfileCardProgress = {
  prestige: 10,
  level: 100,
  legend: true,
  lifetimeXp: 2_106_720,
  xpInLevel: 0,
  xpForNext: 0,
};

let keyCount = 0;
const freshKey = () => `anim-open-${++keyCount}`;

const rect = (x: number, y: number, w: number, h: number) =>
  ({
    x,
    y,
    left: x,
    top: y,
    width: w,
    height: h,
    right: x + w,
    bottom: y + h,
    toJSON() {},
  }) as DOMRect;

let els: HTMLElement[] = [];
beforeEach(() => {
  // jsdom lays nothing out: a 600x300 card with its avatar at the top left
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    function (this: HTMLElement) {
      if (this.matches("[data-ph-avatar]")) return rect(40, 40, 96, 96);
      if (this.matches("[data-ph-root]")) return rect(0, 0, 600, 300);
      return rect(0, 0, 0, 0);
    },
  );
});
afterEach(() => {
  for (const el of els) el.remove();
  els = [];
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function player(progress: ProfileCardProgress = PROGRESS) {
  return {
    publicId: "9EKyqPa9rm",
    username: "Alphaz",
    currency: { soft: 998_200, hard: 0 },
    progress,
  } as unknown as UserMeResponse["player"];
}

async function ownHeader(
  over: Partial<AccountProfileHeader> = {},
): Promise<{ el: AccountProfileHeader; root: HTMLElement }> {
  const el = document.createElement(
    "account-profile-header",
  ) as AccountProfileHeader;
  Object.assign(el, { player: player(), ...over });
  els.push(el);
  document.body.appendChild(el);
  await el.updateComplete;
  // the pulse is measured after the first render
  await new Promise((r) => setTimeout(r, 0));
  await el.updateComplete;
  return { el, root: el.querySelector<HTMLElement>("[data-ph-root]")! };
}

async function otherCard(over: Partial<ProfileCard> = {}) {
  const el = document.createElement("profile-card") as ProfileCard;
  Object.assign(el, {
    username: "Wonder",
    progress: PROGRESS,
    openKey: freshKey(),
    ...over,
  });
  els.push(el);
  document.body.appendChild(el);
  await el.updateComplete;
  await new Promise((r) => setTimeout(r, 0));
  await el.updateComplete;
  return { el, root: el.querySelector<HTMLElement>("[data-ph-root]")! };
}

const pulseOf = (el: Element) =>
  el.querySelector<HTMLElement>("[data-profile-pulse]");
const css = () => document.getElementById("profile-card-styles")!.textContent!;

describe("your own profile header opens the way another player's does", () => {
  it("plays the flourish once per opening: the intro class, and the pulse from behind the avatar", async () => {
    const { el, root } = await ownHeader({ openKey: freshKey() });
    expect(root.classList.contains("profile-card-intro")).toBe(true);
    const pulse = pulseOf(el)!;
    expect(pulse.dataset.profilePulse).toBe("blue");
    const svg = pulse.querySelector<SVGElement>("svg")!;
    // centred on the avatar (40 + 96/2, 40 + 96/2), reaching the far corner
    expect(svg.style.getPropertyValue("--cx")).toBe("88px");
    expect(svg.style.getPropertyValue("--cy")).toBe("88px");
    expect(svg.style.getPropertyValue("--reach")).toBe(
      `${Math.round(Math.hypot(600 - 88, 300 - 88) + 90)}px`,
    );
  });

  it("not again when the page is rebuilt for the same opening (a tab switch)", async () => {
    const key = freshKey();
    const first = await ownHeader({ openKey: key });
    expect(first.root.classList.contains("profile-card-intro")).toBe(true);
    const again = await ownHeader({ openKey: key });
    expect(again.root.classList.contains("profile-card-intro")).toBe(false);
    expect(pulseOf(again.el)).toBeNull();
    // a new opening plays it again
    const reopened = await ownHeader({ openKey: freshKey() });
    expect(reopened.root.classList.contains("profile-card-intro")).toBe(true);
  });

  it("a Legend's header pulses gold, edged in gold, as theirs does", async () => {
    const { el, root } = await ownHeader({
      player: player(LEGEND),
      openKey: freshKey(),
    });
    expect(root.classList.contains("profile-card-legend")).toBe(true);
    expect(pulseOf(el)!.dataset.profilePulse).toBe("gold");
  });

  it("never under reduced motion", async () => {
    vi.stubGlobal(
      "matchMedia",
      vi.fn((query: string) => ({ matches: query.includes("reduce") })),
    );
    const { el, root } = await ownHeader({ openKey: freshKey() });
    expect(root.classList.contains("profile-card-intro")).toBe(false);
    expect(pulseOf(el)).toBeNull();
  });

  it("never on a hidden page", async () => {
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    const { el, root } = await ownHeader({ openKey: freshKey() });
    expect(root.classList.contains("profile-card-intro")).toBe(false);
    expect(pulseOf(el)).toBeNull();
  });

  it("does not wait for the pulse: the card is interactive from the first frame", async () => {
    const { el } = await ownHeader({
      openKey: freshKey(),
      progression: {
        titles: ["veteran"],
        selectedTitle: null,
        nextMilestone: null,
      } as never,
    });
    const select = el.querySelector<HTMLSelectElement>(
      "[data-ph-title-select]",
    )!;
    // the layers that animate never take a click
    for (const layer of el.querySelectorAll("[data-profile-pulse], svg")) {
      expect(
        layer.classList.contains("pointer-events-none") ||
          layer.closest(".pointer-events-none") !== null,
      ).toBe(true);
    }
    const changed = vi.fn();
    el.addEventListener("title-change", changed);
    select.value = "veteran";
    select.dispatchEvent(new Event("change"));
    expect(changed).toHaveBeenCalledOnce();
  });

  it("hands its Credits the count-up only while the flourish plays", async () => {
    const playing = await ownHeader({ openKey: freshKey() });
    expect(
      (playing.el.querySelector("currency-display") as CurrencyDisplay).countIn,
    ).toBe(true);
    const again = await ownHeader({ openKey: "anim-never-played-twice" });
    const key = "anim-never-played-twice";
    expect(
      (again.el.querySelector("currency-display") as CurrencyDisplay).countIn,
    ).toBe(true);
    const repeat = await ownHeader({ openKey: key });
    expect(
      (repeat.el.querySelector("currency-display") as CurrencyDisplay).countIn,
    ).toBe(false);
  });
});

describe("another player's profile keeps its animations", () => {
  it("still opens with the flourish and the pulse from behind the avatar", async () => {
    const { el, root } = await otherCard();
    expect(root.classList.contains("profile-card-intro")).toBe(true);
    expect(pulseOf(el)!.dataset.profilePulse).toBe("blue");
  });

  it("still pulses gold for a Legend, and plays once per opening", async () => {
    const key = freshKey();
    const first = await otherCard({ progress: LEGEND, openKey: key });
    expect(pulseOf(first.el)!.dataset.profilePulse).toBe("gold");
    const again = await otherCard({ progress: LEGEND, openKey: key });
    expect(again.root.classList.contains("profile-card-intro")).toBe(false);
  });

  it("claims an opening for any key exactly once, and remembers only the latest", () => {
    const key = freshKey();
    expect(claimOpening(key)).toBe(true);
    expect(claimOpening(key)).toBe(false);
    // a card without a key plays every time
    expect(claimOpening(undefined)).toBe(true);
    expect(claimOpening(undefined)).toBe(true);
    // the oldest is let go after enough newer ones
    const oldest = freshKey();
    claimOpening(oldest);
    for (let i = 0; i < PLAYED_OPEN_KEYS_KEPT; i++) claimOpening(freshKey());
    expect(claimOpening(oldest)).toBe(true);
  });
});

describe("the animation hooks and the stylesheet", () => {
  it("gives the XP bar's segments an index, so they can fill one after another", () => {
    const host = document.createElement("div");
    render(segmentedXpBar(55), host);
    const segments = [
      ...host.querySelectorAll<HTMLElement>("[data-xp-segment]"),
    ];
    expect(segments.map((s) => s.style.getPropertyValue("--seg"))).toEqual(
      Array.from({ length: 10 }, (_, i) => String(i)),
    );
  });

  it("animates the avatar, the level chip, each bar segment and the figures", async () => {
    await otherCard();
    const sheet = css();
    expect(sheet).toMatch(
      /\.profile-card-intro \[data-ph-avatar-wrap\] \{\s*animation: profile-card-badge-in/,
    );
    expect(sheet).toMatch(
      /\.profile-card-intro \[data-ph-level-chip\] \{\s*animation: profile-card-chip-pop/,
    );
    // the segments fill in turn: a per-segment delay from --seg
    expect(sheet).toMatch(
      /\[data-xp-segment-fill\] \{[^}]*calc\(300ms \+ var\(--seg, 0\) \* 70ms\)/,
    );
    expect(sheet).toContain("@keyframes profile-card-bar-in");
    expect(sheet).toContain("@keyframes df-rise");
    expect(sheet).toContain("@keyframes profile-card-sheen");
    // the bounce: an easing that overshoots
    expect(sheet).toContain("cubic-bezier(0.2, 0.9, 0.3, 1.6)");
  });

  it("brings the Account page's sections in one after another, only while its opening plays", async () => {
    await otherCard();
    const sheet = css();
    expect(sheet).toMatch(
      /\.account-intro \.df-enter \{\s*animation: df-rise[^}]*var\(--i, 0\) \* 80ms/,
    );
  });

  it("switches every one of them off under reduced motion", async () => {
    await otherCard();
    const sheet = css();
    const block =
      /@media \(prefers-reduced-motion: reduce\) \{([\s\S]*)\}\s*$/.exec(
        sheet,
      )![1];
    for (const selector of [
      ".profile-card-intro [data-ph-avatar-wrap]",
      ".profile-card-intro [data-ph-level-chip]",
      ".profile-card-intro level-badge",
      ".profile-card-intro [data-xp-segment-fill]",
      ".profile-card-intro [data-ph-level-line]",
      ".profile-card-intro [data-ph-aside]",
      ".account-intro .df-enter",
      ".profile-prestige-button::before",
    ]) {
      expect(block, selector).toContain(selector);
    }
    expect(block).toContain("animation: none");
    expect(block).toContain(".profile-card-intro::after");
    expect(block).toContain(".profile-card-pulse");
  });

  it("only animates opacity and transforms, which cost no layout", async () => {
    await otherCard();
    const sheet = css();
    for (const name of [
      "profile-card-badge-in",
      "profile-card-chip-pop",
      "profile-card-bar-in",
      "df-rise",
    ]) {
      const body = new RegExp(`@keyframes ${name} \\{([^]*?)\\n\\}`).exec(
        sheet,
      )![1];
      expect(body, name).toMatch(/opacity|transform/);
      expect(body, name).not.toMatch(/width|height|margin|top|left/);
    }
  });
});

describe("the Credits count-up", () => {
  async function display(over: Partial<CurrencyDisplay>) {
    const el = document.createElement("currency-display") as CurrencyDisplay;
    Object.assign(el, over);
    els.push(el);
    document.body.appendChild(el);
    await el.updateComplete;
    return el;
  }

  it("eases the number up from 0 and ends on the real value", async () => {
    vi.useFakeTimers();
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) =>
      setTimeout(() => {
        now += 16;
        cb(now);
      }, 16),
    );
    vi.stubGlobal("cancelAnimationFrame", (id: number) => clearTimeout(id));

    const el = await display({ soft: 998_200, countIn: true, large: true });
    // it starts at 0, not at the balance
    expect(el.textContent).toContain("0");
    expect(el.textContent).not.toContain((998_200).toLocaleString());
    // part way: more than 0, less than the balance
    await vi.advanceTimersByTimeAsync(300);
    await el.updateComplete;
    const middle = Number((el.textContent ?? "").replace(/\D/g, ""));
    expect(middle).toBeGreaterThan(0);
    expect(middle).toBeLessThan(998_200);
    // and it ends exactly on it
    await vi.advanceTimersByTimeAsync(1200);
    await el.updateComplete;
    expect(el.textContent).toContain((998_200).toLocaleString());
  });

  it("shows the real value at once without countIn, and for a zero balance", async () => {
    const plain = await display({ soft: 998_200, large: true });
    expect(plain.textContent).toContain((998_200).toLocaleString());
    const zero = await display({ soft: 0, countIn: true });
    expect(zero.textContent).toContain("0");
  });

  it("shows the real value at once under reduced motion", async () => {
    vi.stubGlobal(
      "matchMedia",
      vi.fn((query: string) => ({ matches: query.includes("reduce") })),
    );
    const el = await display({ soft: 5_000, countIn: true });
    expect(el.textContent).toContain((5_000).toLocaleString());
  });

  it("follows a changed balance after the count-up is over", async () => {
    vi.stubGlobal(
      "matchMedia",
      vi.fn((query: string) => ({ matches: query.includes("reduce") })),
    );
    const el = await display({ soft: 100, countIn: true });
    el.soft = 450;
    await el.updateComplete;
    expect(el.textContent).toContain("450");
  });
});

describe("countUp", () => {
  it("reports whole numbers up to the target and then the target itself", () => {
    vi.useFakeTimers();
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) =>
      setTimeout(() => {
        now += 100;
        cb(now);
      }, 100),
    );
    vi.stubGlobal("cancelAnimationFrame", (id: number) => clearTimeout(id));
    const seen: number[] = [];
    countUp(1000, (v) => seen.push(v), 500);
    vi.advanceTimersByTime(1000);
    expect(seen[0]).toBe(0);
    expect(seen[seen.length - 1]).toBe(1000);
    expect(seen.every(Number.isInteger)).toBe(true);
    // never backwards, and never past the target
    for (let i = 1; i < seen.length; i++)
      expect(seen[i]).toBeGreaterThanOrEqual(seen[i - 1]);
    expect(Math.max(...seen)).toBe(1000);
  });

  it("stops where it is when cancelled", () => {
    vi.useFakeTimers();
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) =>
      setTimeout(() => {
        now += 100;
        cb(now);
      }, 100),
    );
    vi.stubGlobal("cancelAnimationFrame", (id: number) => clearTimeout(id));
    const seen: number[] = [];
    const stop = countUp(1000, (v) => seen.push(v), 1000);
    vi.advanceTimersByTime(300);
    stop();
    const count = seen.length;
    vi.advanceTimersByTime(2000);
    expect(seen).toHaveLength(count);
    expect(seen[seen.length - 1]).toBeLessThan(1000);
  });

  it("goes straight to the value for nothing to count, a bad value, or reduced motion", () => {
    for (const to of [0, -5, Number.NaN]) {
      const seen: number[] = [];
      countUp(to, (v) => seen.push(v));
      expect(seen).toEqual([to]);
    }
    vi.stubGlobal(
      "matchMedia",
      vi.fn((query: string) => ({ matches: query.includes("reduce") })),
    );
    const seen: number[] = [];
    countUp(500, (v) => seen.push(v));
    expect(seen).toEqual([500]);
  });

  it("eases from a starting value, up or down, ending exactly on the target", () => {
    vi.useFakeTimers();
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) =>
      setTimeout(() => {
        now += 100;
        cb(now);
      }, 100),
    );
    vi.stubGlobal("cancelAnimationFrame", (id: number) => clearTimeout(id));
    const up: number[] = [];
    countUp(1000, (v) => up.push(v), 500, 400);
    vi.advanceTimersByTime(1000);
    expect(up[0]).toBe(400);
    expect(up[up.length - 1]).toBe(1000);
    expect(Math.min(...up)).toBe(400);
    const down: number[] = [];
    countUp(100, (v) => down.push(v), 500, 900);
    vi.advanceTimersByTime(1000);
    expect(down[0]).toBe(900);
    expect(down[down.length - 1]).toBe(100);
    expect(Math.max(...down)).toBe(900);
  });

  it("has nothing to ease when it is already there", () => {
    const seen: number[] = [];
    countUp(500, (v) => seen.push(v), 900, 500);
    expect(seen).toEqual([500]);
  });
});
