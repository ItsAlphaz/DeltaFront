import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/client/Auth", () => ({ logOut: vi.fn() }));
vi.mock("../../src/client/CrazyGamesSDK", () => ({
  crazyGamesSDK: {
    isOnCrazyGames: () => false,
    getUserProfile: vi.fn(async () => null),
    showAuthPrompt: vi.fn(),
  },
}));
vi.mock("../../src/client/InGameModal", () => ({ showInGameConfirm: vi.fn() }));
vi.mock("../../src/client/Navigation", () => ({
  closeMobileSidebar: vi.fn(),
}));
vi.mock("../../src/client/Utils", () => ({
  translateText: (key: string, params?: Record<string, string | number>) =>
    params ? `${key}:${JSON.stringify(params)}` : key,
  copyToClipboard: vi.fn(),
  showToast: vi.fn(),
}));

import type { Progress, UserMeResponse } from "@openfront/shared/ApiSchemas";
import { readFileSync } from "node:fs";
import { NavAccountMenu } from "../../src/client/components/NavAccountMenu";

// The nav's profile cluster: the level badge and the avatar in a row, the XP bar
// in a row of its own under them with a gap (it used to be laid over the picture's
// bottom edge), and the chevron beside the pair, all one button.

const progress: Progress = {
  prestige: 0,
  level: 23,
  xpInLevel: 250,
  xpForNext: 1000,
  lifetimeXp: 50_000,
  legend: false,
  canPrestige: false,
};

// `over` adjusts the default level; null is an account with no level at all.
function userMe(
  over: Partial<Progress> | null = {},
  signedIn = true,
): UserMeResponse {
  return {
    user: signedIn ? { email: "player@example.com" } : {},
    player: {
      publicId: "p",
      ...(over === null ? {} : { progress: { ...progress, ...over } }),
    },
  } as unknown as UserMeResponse;
}

let el: NavAccountMenu;

async function mount(
  variant: "desktop" | "mobile",
  response: UserMeResponse | false,
): Promise<void> {
  el?.remove();
  if (!customElements.get("nav-account-menu")) {
    customElements.define("nav-account-menu", NavAccountMenu);
  }
  el = document.createElement("nav-account-menu") as NavAccountMenu;
  el.variant = variant;
  document.body.appendChild(el);
  document.dispatchEvent(
    new CustomEvent("userMeResponse", { detail: response }),
  );
  await el.updateComplete;
}
async function respond(response: UserMeResponse | false): Promise<void> {
  document.dispatchEvent(
    new CustomEvent("userMeResponse", { detail: response }),
  );
  await el.updateComplete;
}

const q = (sel: string) => el.querySelector<HTMLElement>(sel)!;
const classes = (sel: string) => q(sel).className.split(/\s+/);

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  el?.remove();
  vi.useRealTimers();
});

describe("desktop: the profile cluster", () => {
  beforeEach(async () => {
    await mount("desktop", userMe());
  });

  it("is one button holding the cluster and the chevron", () => {
    const triggers = el.querySelectorAll("[data-account-trigger]");
    expect(triggers).toHaveLength(1);
    const trigger = triggers[0];
    expect(trigger.tagName).toBe("BUTTON");
    expect(trigger.contains(q("[data-account-cluster]"))).toBe(true);
    expect(trigger.contains(q("[data-account-level]"))).toBe(true);
    expect(trigger.contains(q("[data-account-avatar]"))).toBe(true);
    expect(trigger.contains(q("[data-account-xp-bar]"))).toBe(true);
    expect(trigger.querySelectorAll("svg").length).toBeGreaterThanOrEqual(1);
    // still named, still a menu button
    expect(trigger.getAttribute("aria-haspopup")).toBe("menu");
    expect(trigger.getAttribute("aria-label")).toContain(
      "nav_account_menu.account_with_level",
    );
  });

  it("puts the level badge and the avatar in a row, and the XP bar in a row under it", () => {
    const cluster = q("[data-account-cluster]");
    const bar = q("[data-account-xp-bar]");
    const level = q("[data-account-level]");
    const avatar = q("[data-account-avatar]");
    const row = level.parentElement!;
    // the pair share a row; the bar is not in it
    expect(row.contains(avatar)).toBe(true);
    expect(row.contains(bar)).toBe(false);
    // the row and the bar are the cluster's two rows, the bar second
    expect([...cluster.children].filter((c) => c.tagName === "SPAN")).toEqual([
      row,
      bar,
    ]);
    expect(
      row.compareDocumentPosition(bar) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(classes("[data-account-cluster]")).toContain("flex-col");
  });

  it("keeps the bar clear of the picture: it is in the flow, with a gap, not laid over its edge", () => {
    const bar = classes("[data-account-xp-bar]");
    // the old bar was absolutely positioned at bottom-1, over the avatar's bottom
    expect(bar).not.toContain("absolute");
    expect(
      bar.some((c) => c.startsWith("bottom-") || c.startsWith("-bottom-")),
    ).toBe(false);
    // the gap between the row and the bar
    expect(classes("[data-account-cluster]")).toContain("gap-1.5");
    // inset a little, so it sits under the pair and not edge to edge
    expect(bar).toContain("mx-1");
    expect(bar).toContain("block");
  });

  it("makes the pill tall enough for the bar and its gap, no taller", () => {
    const trigger = classes("[data-account-trigger]");
    // 32px picture + 6px gap + 3px bar, with a little air: 48px
    expect(trigger).toContain("h-12");
    expect(trigger).not.toContain("h-10");
    expect(trigger).toContain("items-start");
    expect(trigger).toContain("pt-[3.5px]");
    // still a rounded pill with the same padding
    expect(trigger).toContain("rounded-full");
    expect(trigger).toContain("px-3");
  });

  it("lines the chevron up with the picture's row, not the bar", () => {
    const chevron = q("[data-account-trigger] > span.h-8");
    expect(chevron).not.toBeNull();
    expect(chevron.className).toContain("items-center");
    expect(chevron.querySelector("svg")).not.toBeNull();
    // beside the cluster, not inside it
    expect(q("[data-account-cluster]").contains(chevron)).toBe(false);
  });

  it("fills the bar to the level's progress", () => {
    const fill = q("[data-account-xp-bar] [data-xp-bar-fill]");
    expect(fill.style.width).toBe("25%");
    expect(
      q("[data-account-xp-bar] [data-xp-bar]").getAttribute("aria-valuenow"),
    ).toBe("25");
    expect(q("[data-account-xp-bar] [data-xp-bar]").className).toContain(
      "h-[3px]",
    );
  });

  it("keeps everything the imperative updaters drive inside the row", () => {
    const row = q("[data-account-level]").parentElement!;
    for (const hook of [
      "[data-account-avatar]",
      "[data-account-spinner]",
      "[data-account-person-icon]",
      "[data-account-email-badge]",
      "[data-account-signin-text]",
    ]) {
      expect(row.querySelector(hook), hook).not.toBeNull();
    }
    // and the ids the account button looks them up by
    for (const id of [
      "nav-account-button",
      "nav-account-avatar",
      "nav-account-loading-spinner",
      "nav-account-person-icon",
      "nav-account-email-badge",
      "nav-account-signin-text",
    ]) {
      expect(el.querySelector(`#${id}`), id).not.toBeNull();
    }
  });

  it("pins the email badge to the picture's corner, not the pill's", () => {
    const row = q("[data-account-level]").parentElement!;
    expect(row.className).toContain("relative");
    expect(q("[data-account-email-badge]").className).toContain(
      "bottom-0 right-0",
    );
  });
});

describe("desktop: the cluster is still all one click target", () => {
  it("a click on the picture, the level, the bar or the chevron opens the menu", async () => {
    await mount("desktop", userMe());
    const trigger = q("[data-account-trigger]");
    const opened = vi.fn();
    trigger.addEventListener("click", opened);
    for (const sel of [
      "[data-account-avatar]",
      "[data-account-level]",
      "[data-account-xp-bar]",
      "[data-account-cluster]",
      "[data-account-trigger] > span.h-8",
    ]) {
      q(sel).click();
    }
    expect(opened).toHaveBeenCalledTimes(5);
  });

  it("clicking opens and closes the menu", async () => {
    await mount("desktop", userMe());
    expect(q("[data-account-trigger]").getAttribute("aria-expanded")).toBe(
      "false",
    );
    q("[data-account-xp-bar]").click();
    await el.updateComplete;
    expect(q("[data-account-trigger]").getAttribute("aria-expanded")).toBe(
      "true",
    );
    q("[data-account-avatar]").click();
    await el.updateComplete;
    expect(q("[data-account-trigger]").getAttribute("aria-expanded")).toBe(
      "false",
    );
  });

  it("the bar takes no pointer events of its own: it never gets between a click and the button", async () => {
    await mount("desktop", userMe());
    expect(classes("[data-account-xp-bar]")).toContain("pointer-events-none");
    expect(q("[data-account-xp-bar]").getAttribute("aria-hidden")).toBe("true");
  });

  it("the something-waiting dot still sits on the picture and takes no clicks", async () => {
    const waiting = userMe();
    waiting.player.rewards = [
      {
        id: "1",
        currencyType: "soft",
        amount: "250",
        reason: "level_milestone",
        note: null,
      },
    ];
    await mount("desktop", waiting);
    const dot = q("[data-account-attention]");
    expect(dot.className).toContain("pointer-events-none");
    expect(q("[data-account-level]").parentElement!.contains(dot)).toBe(true);
  });
});

describe("desktop: without a level", () => {
  it("is the plain pill: no bar, no cluster gap, the shorter height", async () => {
    await mount("desktop", userMe());
    for (const response of [
      userMe(null),
      false as const,
      userMe(null, false),
    ]) {
      await respond(response);
      expect(el.querySelector("[data-account-xp-bar]")).toBeNull();
      expect(el.querySelector("[data-account-level]")).toBeNull();
      const trigger = classes("[data-account-trigger]");
      expect(trigger).toContain("h-10");
      expect(trigger).toContain("items-center");
      expect(trigger).not.toContain("h-12");
      expect(classes("[data-account-cluster]")).not.toContain("gap-1.5");
    }
  });

  it("grows to the cluster when the level arrives, and back when it goes", async () => {
    await mount("desktop", userMe(null));
    expect(classes("[data-account-trigger]")).toContain("h-10");
    await respond(userMe());
    expect(classes("[data-account-trigger]")).toContain("h-12");
    await respond(userMe(null));
    expect(classes("[data-account-trigger]")).toContain("h-10");
  });
});

describe("mobile", () => {
  beforeEach(async () => {
    await mount("mobile", userMe());
  });

  it("hangs the bar under the avatar with a gap, inset, as before in place and now clear of it", () => {
    const bar = classes("[data-account-xp-bar]");
    // five pixels clear of the picture's bottom edge (it was three)
    expect(bar).toContain("absolute");
    expect(bar).toContain("-bottom-2");
    expect(bar).toContain("left-1");
    expect(bar).toContain("right-1");
    expect(bar).not.toContain("-bottom-1.5");
    expect(bar).toContain("pointer-events-none");
  });

  it("keeps the level badge on the avatar's corner, and has no desktop cluster", () => {
    expect(classes("[data-account-level]")).toContain("absolute");
    expect(el.querySelector("[data-account-cluster]")).toBeNull();
    expect(q("[data-account-xp-bar] [data-xp-bar-fill]").style.width).toBe(
      "25%",
    );
  });

  it("sits in the avatar's own box, so the bar cannot push the top bar wider or taller", () => {
    const box = q("[data-account-level]").parentElement!;
    expect(box.className).toContain("relative");
    expect(box.className).toContain("w-8");
    expect(box.className).toContain("h-8");
    expect(box.contains(q("[data-account-xp-bar]"))).toBe(true);
  });
});

describe("it does not make the nav wider", () => {
  it("the cluster is the old pair's width: nothing in it is wider than the picture and the badge", async () => {
    await mount("desktop", userMe());
    // no fixed or minimum widths anywhere in the trigger
    const sized = [...q("[data-account-trigger]").querySelectorAll("*")]
      .map((n) => (n as HTMLElement).className)
      .filter((c) => typeof c === "string")
      .join(" ")
      .split(/\s+/)
      .filter(
        (c) => /^(w|min-w)-(?!2|3|4|5|8|\[)/.test(c) && !c.startsWith("w-full"),
      );
    expect(sized).toEqual([]);
    // the bar is as wide as the pair, less its inset, and cannot grow past it
    expect(classes("[data-account-xp-bar]")).not.toContain("w-full");
    expect(classes("[data-account-cluster]")).toContain("items-stretch");
  });
});

describe("the bar's fill", () => {
  it("eases to a new value when XP changes, on the same bar", async () => {
    await mount("desktop", userMe());
    const fill = q("[data-account-xp-bar] [data-xp-bar-fill]");
    expect(fill.className).toContain("transition-[width]");
    expect(fill.className).toContain("duration-700");
    expect(fill.className).toContain("ease-out");
    // the same element is updated in place, so the transition runs
    await respond(userMe({ xpInLevel: 600 }));
    const after = q("[data-account-xp-bar] [data-xp-bar-fill]");
    expect(after).toBe(fill);
    expect(fill.style.width).toBe("60%");
  });

  it("does not ease under reduced motion", async () => {
    await mount("desktop", userMe());
    expect(q("[data-account-xp-bar] [data-xp-bar-fill]").className).toContain(
      "motion-reduce:transition-none",
    );
  });

  it("is full at the top of the level track and empty at its start", async () => {
    await mount("desktop", userMe({ xpInLevel: 0 }));
    expect(q("[data-xp-bar-fill]").style.width).toBe("0%");
    await respond(userMe({ xpInLevel: 1000 }));
    expect(q("[data-xp-bar-fill]").style.width).toBe("100%");
  });
});

describe("a level gained", () => {
  it("bounces the badge once, then stops", async () => {
    await mount("desktop", userMe());
    expect(classes("[data-account-level]")).not.toContain("df-level-up");
    await respond(userMe({ level: 24, xpInLevel: 10 }));
    expect(classes("[data-account-level]")).toContain("df-level-up");
    expect(q("[data-account-level]").getAttribute("data-level-up")).toBe(
      "true",
    );
    vi.advanceTimersByTime(800);
    await el.updateComplete;
    expect(classes("[data-account-level]")).not.toContain("df-level-up");
    expect(q("[data-account-level]").hasAttribute("data-level-up")).toBe(false);
  });

  it("a prestige is a level gained too", async () => {
    await mount("desktop", userMe({ level: 100, prestige: 0 }));
    await respond(userMe({ level: 1, prestige: 1 }));
    expect(classes("[data-account-level]")).toContain("df-level-up");
  });

  it("not for the first response a page sees, XP within a level, or a level lost", async () => {
    await mount("desktop", userMe());
    expect(classes("[data-account-level]")).not.toContain("df-level-up");
    await respond(userMe({ xpInLevel: 900 }));
    expect(classes("[data-account-level]")).not.toContain("df-level-up");
    await respond(userMe({ level: 22 }));
    expect(classes("[data-account-level]")).not.toContain("df-level-up");
    // signing in after being signed out is not a level gained either
    await respond(false);
    await respond(userMe({ level: 40 }));
    expect(classes("[data-account-level]")).not.toContain("df-level-up");
  });

  it("works the same on the mobile top bar", async () => {
    await mount("mobile", userMe());
    await respond(userMe({ level: 24 }));
    expect(classes("[data-account-level]")).toContain("df-level-up");
  });

  it("leaves no timer behind when the menu goes", async () => {
    await mount("desktop", userMe());
    await respond(userMe({ level: 24 }));
    el.remove();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("is switched off in the stylesheet under reduced motion", () => {
    const css = readFileSync("src/client/styles.css", "utf8");
    const block =
      /@media \(prefers-reduced-motion: reduce\) \{\s*\.df-xp-pop,\s*\.df-level-up \{\s*animation: none;/.exec(
        css,
      );
    expect(block).not.toBeNull();
  });
});
