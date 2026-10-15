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
import { levelFraction } from "../../src/client/Progression";

// The nav's profile cluster: the avatar inside an XP ring (the progress to the
// next level, in red, around the picture), a small red "LV 23" badge on the
// ring's lower edge, the prestige emblem beside that badge for a prestiged
// player, and the chevron, all one button. The horizontal XP bar that used to
// hang under the avatar is gone.

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
const qs = (sel: string) => [...el.querySelectorAll<HTMLElement>(sel)];
// getAttribute, not className: an SVG element's className is not a string
const classes = (sel: string) =>
  (q(sel).getAttribute("class") ?? "").split(/\s+/);
// The ring's fill, as the style the browser draws: "stroke-dasharray: 25 100".
const fillStyle = () => q("[data-xp-ring-fill]").getAttribute("style") ?? "";
const dash = () => /stroke-dasharray:\s*([\d.]+) 100/.exec(fillStyle())?.[1];

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  el?.remove();
  vi.useRealTimers();
});

describe("desktop: the avatar sits inside the XP ring", () => {
  beforeEach(async () => {
    await mount("desktop", userMe());
  });

  it("is one button holding the cluster and the chevron", () => {
    const triggers = el.querySelectorAll("[data-account-trigger]");
    expect(triggers).toHaveLength(1);
    const trigger = triggers[0];
    expect(trigger.tagName).toBe("BUTTON");
    expect(trigger.contains(q("[data-account-cluster]"))).toBe(true);
    expect(trigger.contains(q("[data-xp-ring]"))).toBe(true);
    expect(trigger.contains(q("[data-account-avatar]"))).toBe(true);
    expect(trigger.contains(q("[data-account-level]"))).toBe(true);
    // still named, still a menu button
    expect(trigger.getAttribute("aria-haspopup")).toBe("menu");
    expect(trigger.getAttribute("aria-label")).toContain(
      "nav_account_menu.account_with_level",
    );
  });

  it("wraps the avatar: the ring and the picture are one box, the picture inset inside the ring's stroke", () => {
    const cluster = q("[data-account-cluster]");
    const ring = q("[data-xp-ring]");
    const face = q("[data-account-face]");
    // both are children of the cluster, the ring drawn over the whole box
    expect(ring.parentElement).toBe(cluster);
    expect(face.parentElement).toBe(cluster);
    expect(ring.getAttribute("class")).toContain("absolute");
    expect(ring.getAttribute("class")).toContain("inset-0");
    // the picture, the spinner and the person icon live inside the face
    for (const hook of [
      "[data-account-avatar]",
      "[data-account-spinner]",
      "[data-account-person-icon]",
    ]) {
      expect(face.querySelector(hook), hook).not.toBeNull();
    }
    // and the face is a circle clear of the ring's stroke: 38px ring, 3px
    // stroke, a hairline of air
    // laid inside the ring's box, not beside it
    expect(classes("[data-account-face]")).toContain("absolute");
    expect(classes("[data-account-face]")).toContain("inset-[4.5px]");
    expect(classes("[data-account-face]")).toContain("rounded-full");
    expect(classes("[data-account-cluster]")).toContain("h-[38px]");
    expect(classes("[data-account-cluster]")).toContain("w-[38px]");
    expect(ring.getAttribute("viewBox")).toBe("0 0 38 38");
  });

  it("is a dark track with a red fill, drawn clockwise from the top", () => {
    const track = q("[data-xp-ring-track]");
    const fill = q("[data-xp-ring-fill]");
    expect(track.getAttribute("class")).toContain("stroke-white/15");
    expect(fill.getAttribute("class")).toContain("stroke-df-red");
    // same circle, same stroke
    expect(fill.getAttribute("r")).toBe(track.getAttribute("r"));
    expect(fill.getAttribute("stroke-width")).toBe(
      track.getAttribute("stroke-width"),
    );
    // the path is normalised to 100 so the dash is the percentage
    expect(fill.getAttribute("pathLength")).toBe("100");
    // 12 o'clock is the start
    expect(q("[data-xp-ring] g").getAttribute("transform")).toBe(
      "rotate(-90 19 19)",
    );
  });

  it("the ring is decorative: it takes no clicks and is hidden from screen readers", () => {
    expect(q("[data-xp-ring]").getAttribute("aria-hidden")).toBe("true");
    expect(classes("[data-xp-ring]").join(" ")).toContain(
      "pointer-events-none",
    );
  });
});

describe("the ring's percentage is the progression's", () => {
  it("fills to xpInLevel / xpForNext, the fraction every progression panel uses", async () => {
    await mount("desktop", userMe());
    expect(dash()).toBe("25");
    expect(q("[data-xp-ring]").getAttribute("data-xp-ring-percent")).toBe("25");
    for (const [inLevel, forNext] of [
      [0, 500],
      [125, 500],
      [333, 1000],
      [999, 1000],
      [1000, 1000],
      [2100, 4200],
    ]) {
      await respond(userMe({ xpInLevel: inLevel, xpForNext: forNext }));
      const expected = levelFraction(inLevel, forNext) * 100;
      expect(Number(dash())).toBeCloseTo(expected, 5);
    }
  });

  it("is empty at the start of a level (and draws nothing at all, not a dot) and full at its end", async () => {
    await mount("desktop", userMe({ xpInLevel: 0 }));
    expect(dash()).toBe("0");
    expect(fillStyle()).toContain("opacity: 0");
    await respond(userMe({ xpInLevel: 1000 }));
    expect(dash()).toBe("100");
    expect(fillStyle()).toContain("opacity: 1");
  });

  it("is full at the top level, where there is no next level", async () => {
    await mount("desktop", userMe({ level: 100, xpInLevel: 0, xpForNext: 0 }));
    expect(dash()).toBe("100");
  });

  it("the tooltip says it in words, from the same numbers", async () => {
    await mount("desktop", userMe());
    expect(q("[data-account-cluster]").getAttribute("title")).toContain(
      'progression.xp_progress:{"current":"250","next":"1,000"}',
    );
  });
});

describe("the level badge", () => {
  it("reads the account's level, in a small red badge on the ring", async () => {
    await mount("desktop", userMe());
    const text = q("[data-account-level-text]");
    expect(text.textContent).toBe('progression.level_short:{"level":23}');
    expect(text.className).toContain("bg-df-red");
    // it sits on the ring's lower edge, inside the cluster, and takes no clicks
    expect(q("[data-account-cluster]").contains(text)).toBe(true);
    expect(classes("[data-account-level]")).toContain("absolute");
    expect(classes("[data-account-level]")).toContain("pointer-events-none");
  });

  it("follows the level: 1, 25 and 100", async () => {
    await mount("desktop", userMe({ level: 1 }));
    expect(q("[data-account-level-text]").textContent).toContain('"level":1}');
    await respond(userMe({ level: 25 }));
    expect(q("[data-account-level-text]").textContent).toContain('"level":25}');
    await respond(userMe({ level: 100, xpInLevel: 0, xpForNext: 0 }));
    expect(q("[data-account-level-text]").textContent).toContain(
      '"level":100}',
    );
  });

  it("has no prestige emblem until the player has prestiged", async () => {
    await mount("desktop", userMe());
    expect(el.querySelector("[data-account-prestige]")).toBeNull();
  });

  it("a prestiged player's emblem sits beside the badge, not on the ring", async () => {
    await mount("desktop", userMe({ prestige: 3 }));
    const mark = q("[data-account-prestige]");
    const badge = mark.querySelector("level-badge") as HTMLElement & {
      prestige: number;
      emblem: boolean;
      legend: boolean;
    };
    expect(badge.emblem).toBe(true);
    expect(badge.prestige).toBe(3);
    expect(badge.legend).toBe(false);
    // in the badge's row, so the ring itself is left clear
    expect(q("[data-account-level]").contains(mark)).toBe(true);
    expect(q("[data-xp-ring]").contains(mark)).toBe(false);
  });

  it("a Legend keeps its crown, and the trigger is still named Legend's level", async () => {
    await mount(
      "desktop",
      userMe({ level: 100, prestige: 10, legend: true, xpForNext: 0 }),
    );
    const badge = q("[data-account-prestige] level-badge") as HTMLElement & {
      legend: boolean;
    };
    expect(badge.legend).toBe(true);
    expect(q("[data-account-trigger]").getAttribute("aria-label")).toContain(
      "progression.legend",
    );
  });
});

describe("the old horizontal XP bar is gone", () => {
  for (const variant of ["desktop", "mobile"] as const) {
    it(`${variant}: nothing under the avatar, hidden or not`, async () => {
      await mount(variant, userMe());
      expect(el.querySelector("[data-account-xp-bar]")).toBeNull();
      expect(el.querySelector("[data-xp-bar]")).toBeNull();
      expect(el.querySelector("[data-xp-bar-fill]")).toBeNull();
      expect(el.querySelector("[role='progressbar']")).toBeNull();
      expect(el.innerHTML).not.toContain("h-[3px]");
    });
  }

  it("and the source no longer draws one in the nav", () => {
    const source = readFileSync(
      "src/client/components/NavAccountMenu.ts",
      "utf8",
    );
    expect(source).not.toContain("renderXpBar");
    expect(source).not.toContain("data-account-xp-bar");
    expect(source).not.toMatch(/\bxpBar\b/);
  });
});

describe("the pill", () => {
  it("is the same height as before with a level, keeps its outline and is not toggled by the plain-pill updater", async () => {
    await mount("desktop", userMe());
    const trigger = classes("[data-account-trigger]");
    expect(trigger).toContain("h-12");
    expect(trigger).toContain("rounded-full");
    expect(trigger).toContain("border");
    expect(trigger).toContain("border-white/20");
    // the imperative border toggle is for the plain pill only
    expect(
      q("[data-account-trigger]").hasAttribute("data-account-border"),
    ).toBe(false);
  });

  it("without a level it is the plain pill: no ring, no badge, the shorter height, the old updater hooks", async () => {
    await mount("desktop", userMe());
    for (const response of [
      userMe(null),
      false as const,
      userMe(null, false),
    ]) {
      await respond(response);
      expect(el.querySelector("[data-xp-ring]")).toBeNull();
      expect(el.querySelector("[data-account-cluster]")).toBeNull();
      expect(el.querySelector("[data-account-level]")).toBeNull();
      const trigger = classes("[data-account-trigger]");
      expect(trigger).toContain("h-10");
      expect(trigger).not.toContain("h-12");
      expect(
        q("[data-account-trigger]").hasAttribute("data-account-border"),
      ).toBe(true);
      // the plain pill's avatar is the bigger one
      expect(classes("[data-account-avatar]")).toContain("w-8");
    }
  });

  it("swaps between the two as the level arrives and goes", async () => {
    await mount("desktop", userMe(null));
    expect(classes("[data-account-trigger]")).toContain("h-10");
    await respond(userMe());
    expect(classes("[data-account-trigger]")).toContain("h-12");
    expect(el.querySelector("[data-xp-ring]")).not.toBeNull();
    await respond(userMe(null));
    expect(classes("[data-account-trigger]")).toContain("h-10");
    expect(el.querySelector("[data-xp-ring]")).toBeNull();
  });

  it("keeps everything the imperative updaters drive inside the trigger, with the ids they look them up by", async () => {
    await mount("desktop", userMe());
    const trigger = q("[data-account-trigger]");
    for (const hook of [
      "[data-account-avatar]",
      "[data-account-spinner]",
      "[data-account-person-icon]",
      "[data-account-signin-text]",
    ]) {
      expect(trigger.querySelector(hook), hook).not.toBeNull();
    }
    for (const id of [
      "nav-account-button",
      "nav-account-avatar",
      "nav-account-loading-spinner",
      "nav-account-person-icon",
      "nav-account-signin-text",
    ]) {
      expect(el.querySelector(`#${id}`), id).not.toBeNull();
    }
    // the sign-in label stays hidden: the ring cluster is the whole identity
    expect(classes("[data-account-signin-text]")).toContain("hidden");
  });
});

describe("the profile dropdown stays clickable", () => {
  it("a click on the picture, the ring, the level, the cluster or the chevron opens the menu", async () => {
    await mount("desktop", userMe());
    const trigger = q("[data-account-trigger]");
    const opened = vi.fn();
    trigger.addEventListener("click", opened);
    const chevron = trigger.querySelector("svg.w-3")!.parentElement!;
    for (const target of [
      q("[data-account-avatar]"),
      q("[data-account-face]"),
      q("[data-xp-ring]"),
      q("[data-account-level]"),
      q("[data-account-level-text]"),
      q("[data-account-cluster]"),
      chevron,
    ]) {
      target.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    }
    expect(opened).toHaveBeenCalledTimes(7);
  });

  it("clicking opens and closes the menu", async () => {
    await mount("desktop", userMe());
    expect(q("[data-account-trigger]").getAttribute("aria-expanded")).toBe(
      "false",
    );
    q("[data-xp-ring]").dispatchEvent(
      new MouseEvent("click", { bubbles: true }),
    );
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

  it("everything laid over the avatar takes no pointer events of its own", async () => {
    const waiting = userMe({ prestige: 2 });
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
    for (const sel of [
      "[data-xp-ring]",
      "[data-account-level]",
      "[data-account-attention]",
    ]) {
      expect(classes(sel), sel).toContain("pointer-events-none");
    }
    // the something-waiting dot is still there, on the cluster
    expect(
      q("[data-account-cluster]").contains(q("[data-account-attention]")),
    ).toBe(true);
    expect(q("[data-account-attention]").getAttribute("title")).toBe(
      "nav_account_menu.rewards_waiting",
    );
  });
});

describe("mobile", () => {
  beforeEach(async () => {
    await mount("mobile", userMe());
  });

  it("is the same cluster, smaller: a 32px ring around the avatar, the badge on its edge, no pill", () => {
    expect(el.querySelector("[data-account-cluster]")).not.toBeNull();
    expect(classes("[data-account-cluster]")).toContain("h-8");
    expect(classes("[data-account-cluster]")).toContain("w-8");
    expect(q("[data-xp-ring]").getAttribute("viewBox")).toBe("0 0 32 32");
    expect(Number(dash())).toBe(25);
    expect(q("[data-account-level-text]").textContent).toContain('"level":23}');
    expect(classes("[data-account-trigger]")).not.toContain("border");
    expect(classes("[data-account-trigger]")).toContain("h-10");
  });

  it("keeps the avatar's hooks (and no desktop ids) and opens the menu from the ring", () => {
    expect(el.querySelector("[data-account-avatar]")).not.toBeNull();
    expect(el.querySelector("#nav-account-avatar")).toBeNull();
    const opened = vi.fn();
    q("[data-account-trigger]").addEventListener("click", opened);
    q("[data-xp-ring]").dispatchEvent(
      new MouseEvent("click", { bubbles: true }),
    );
    expect(opened).toHaveBeenCalledTimes(1);
  });

  it("without a level it is just the avatar", async () => {
    await respond(userMe(null));
    expect(el.querySelector("[data-xp-ring]")).toBeNull();
    expect(classes("[data-account-avatar]")).toContain("w-8");
  });
});

describe("responsive layout", () => {
  it("the cluster has a fixed size and never shrinks, so a narrow bar cannot squash the ring", async () => {
    await mount("desktop", userMe());
    expect(classes("[data-account-cluster]")).toContain("shrink-0");
    await mount("mobile", userMe());
    expect(classes("[data-account-cluster]")).toContain("shrink-0");
  });

  it("does not make the nav wider or taller: the only fixed sizes are the ring's and the chevron's", async () => {
    await mount("desktop", userMe());
    const sized = qs("[data-account-trigger] *")
      .map((n) => n.getAttribute("class") ?? "")
      .join(" ")
      .split(/\s+/)
      .filter(
        (c) =>
          /^(w|min-w)-(?!2|3|4|5|8|\[)/.test(c) &&
          !c.startsWith("w-full") &&
          !c.startsWith("w-max"),
      );
    expect(sized).toEqual([]);
    // 48px pill, as with the old bar, and the 66px nav row has room for it
    expect(classes("[data-account-trigger]")).toContain("h-12");
  });

  it("the badge is centred on the ring and may overhang it without moving anything", async () => {
    await mount("desktop", userMe({ prestige: 4 }));
    const row = classes("[data-account-level]");
    // absolutely placed: it takes no room in the flow
    expect(row).toContain("absolute");
    expect(row).toContain("inset-x-0");
    expect(row).toContain("justify-center");
    // the text never wraps, whatever the translation
    expect(classes("[data-account-level-text]")).toContain("whitespace-nowrap");
  });

  it("sits in the desktop nav only from lg up and in the top bar below it", () => {
    const desktop = readFileSync(
      "src/client/components/DesktopNavBar.ts",
      "utf8",
    );
    expect(desktop).toContain('class="hidden lg:flex');
    expect(desktop).toContain('<nav-account-menu variant="desktop">');
    const play = readFileSync("src/client/components/PlayPage.ts", "utf8");
    expect(play).toContain('<nav-account-menu variant="mobile">');
  });
});

describe("the ring's motion", () => {
  it("eases to a new value when XP changes, on the same ring", async () => {
    await mount("desktop", userMe());
    const fill = q("[data-xp-ring-fill]");
    const cls = fill.getAttribute("class") ?? "";
    expect(cls).toContain("transition-[stroke-dasharray]");
    expect(cls).toContain("duration-700");
    expect(cls).toContain("ease-out");
    // the same element is updated in place, so the transition runs
    await respond(userMe({ xpInLevel: 600 }));
    expect(q("[data-xp-ring-fill]")).toBe(fill);
    expect(dash()).toBe("60");
  });

  it("does not ease under reduced motion", async () => {
    await mount("desktop", userMe());
    expect(q("[data-xp-ring-fill]").getAttribute("class")).toContain(
      "motion-reduce:transition-none",
    );
  });

  it("a level gained resets the ring without sweeping it backwards", async () => {
    await mount("desktop", userMe({ xpInLevel: 900 }));
    expect(q("[data-xp-ring-fill]").getAttribute("class")).toContain(
      "transition-[stroke-dasharray]",
    );
    await respond(userMe({ level: 24, xpInLevel: 10 }));
    // the new value is drawn at once for the moment the level is shown
    expect(q("[data-xp-ring-fill]").getAttribute("class")).not.toContain(
      "transition-[stroke-dasharray]",
    );
    expect(dash()).toBe("1");
    vi.advanceTimersByTime(800);
    await el.updateComplete;
    // and the easing is back for the next gain
    expect(q("[data-xp-ring-fill]").getAttribute("class")).toContain(
      "transition-[stroke-dasharray]",
    );
  });
});

describe("a level gained", () => {
  it("bounces the badge and pulses the ring once, then stops", async () => {
    await mount("desktop", userMe());
    expect(classes("[data-account-level]")).not.toContain("df-level-up");
    expect(classes("[data-xp-ring]")).not.toContain("df-ring-pulse");
    await respond(userMe({ level: 24, xpInLevel: 10 }));
    expect(classes("[data-account-level]")).toContain("df-level-up");
    expect(q("[data-account-level]").getAttribute("data-level-up")).toBe(
      "true",
    );
    expect(q("[data-xp-ring]").getAttribute("class")).toContain(
      "df-ring-pulse",
    );
    vi.advanceTimersByTime(800);
    await el.updateComplete;
    expect(classes("[data-account-level]")).not.toContain("df-level-up");
    expect(q("[data-account-level]").hasAttribute("data-level-up")).toBe(false);
    expect(q("[data-xp-ring]").getAttribute("class")).not.toContain(
      "df-ring-pulse",
    );
  });

  it("a prestige is a level gained too", async () => {
    await mount("desktop", userMe({ level: 100, prestige: 0 }));
    await respond(userMe({ level: 1, prestige: 1 }));
    expect(classes("[data-account-level]")).toContain("df-level-up");
    expect(q("[data-xp-ring]").getAttribute("class")).toContain(
      "df-ring-pulse",
    );
  });

  it("not for the first response a page sees, XP within a level, or a level lost", async () => {
    await mount("desktop", userMe());
    expect(classes("[data-account-level]")).not.toContain("df-level-up");
    await respond(userMe({ xpInLevel: 900 }));
    expect(classes("[data-account-level]")).not.toContain("df-level-up");
    expect(q("[data-xp-ring]").getAttribute("class")).not.toContain(
      "df-ring-pulse",
    );
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
    expect(q("[data-xp-ring]").getAttribute("class")).toContain(
      "df-ring-pulse",
    );
  });

  it("leaves no timer behind when the menu goes", async () => {
    await mount("desktop", userMe());
    await respond(userMe({ level: 24 }));
    el.remove();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("is switched off in the stylesheet under reduced motion: the pop, the bounce and the pulse", () => {
    const css = readFileSync("src/client/styles.css", "utf8");
    const block =
      /@media \(prefers-reduced-motion: reduce\) \{\s*\.df-xp-pop,\s*\.df-level-up,\s*\.df-ring-pulse \{\s*animation: none;/.exec(
        css,
      );
    expect(block).not.toBeNull();
    // and the pulse exists to be switched off
    expect(css).toContain("@keyframes df-ring-pulse");
    expect(css).toMatch(/\.df-ring-pulse \{\s*animation: df-ring-pulse/);
  });
});
