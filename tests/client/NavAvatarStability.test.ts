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
let avatarUrl = "https://cdn.test/a.png";
vi.mock("../../src/client/Utils", () => ({
  translateText: (key: string, params?: Record<string, string | number>) =>
    params ? `${key}:${JSON.stringify(params)}` : key,
  copyToClipboard: vi.fn(),
  showToast: vi.fn(),
  getDiscordAvatarUrl: () => avatarUrl,
}));

import type { Progress, UserMeResponse } from "@openfront/shared/ApiSchemas";
import { readFileSync } from "node:fs";
import { NavAccountMenu } from "../../src/client/components/NavAccountMenu";
import { updateAccountNavButton } from "../../src/client/NavAccountButton";

// The nav's picture, in the ring. It is shown once it has loaded (the person
// icon stands in until then, and if it fails), and it is the same element, with
// the same address, however often the account refreshes: an XP gain or a level
// animates the ring and the badge, never the picture.

const progress: Progress = {
  prestige: 0,
  level: 3,
  xpInLevel: 100,
  xpForNext: 700,
  lifetimeXp: 1000,
  legend: false,
  canPrestige: false,
};

function userMe(over: Partial<Progress> | null = {}): UserMeResponse {
  return {
    user: {
      discord: { id: "1", avatar: "abc", username: "a", discriminator: "0" },
    },
    player: {
      publicId: "p",
      ...(over === null ? {} : { progress: { ...progress, ...over } }),
    },
  } as unknown as UserMeResponse;
}

let el: NavAccountMenu;

/** What Main does: the nav's picture first, then the broadcast the menu re-renders on. */
async function respond(response: UserMeResponse | false): Promise<void> {
  updateAccountNavButton(response);
  document.dispatchEvent(
    new CustomEvent("userMeResponse", { detail: response }),
  );
  await el.updateComplete;
  // the update the first render's own seed schedules
  await Promise.resolve();
}

async function mount(variant: "desktop" | "mobile" = "desktop") {
  if (!customElements.get("nav-account-menu")) {
    customElements.define("nav-account-menu", NavAccountMenu);
  }
  el = document.createElement("nav-account-menu") as NavAccountMenu;
  el.variant = variant;
  document.body.appendChild(el);
  await el.updateComplete;
}

const q = <T extends HTMLElement = HTMLElement>(sel: string) =>
  el.querySelector<T>(sel)!;
const img = () => q<HTMLImageElement>("[data-account-avatar]");
const shown = (node: HTMLElement) => !node.classList.contains("hidden");
const load = () => img().dispatchEvent(new Event("load"));

/** Counts every write to the picture's address. */
function watchSrc(node: HTMLImageElement) {
  const writes: string[] = [];
  const observer = new MutationObserver((records) => {
    for (let i = 0; i < records.length; i++) {
      writes.push(String(node.getAttribute("src")));
    }
  });
  observer.observe(node, { attributes: true, attributeFilter: ["src"] });
  return { writes, flush: () => observer.takeRecords().length };
}

beforeEach(() => {
  avatarUrl = "https://cdn.test/a.png";
  vi.useFakeTimers();
});
afterEach(() => {
  el?.remove();
  vi.useRealTimers();
  delete (HTMLImageElement.prototype as { complete?: boolean }).complete;
});

describe("the nav picture while it loads", () => {
  it("shows the person icon, not a spinner or a blank, until the picture has loaded, then the picture", async () => {
    await mount();
    await respond(userMe());
    expect(shown(q("[data-account-spinner]"))).toBe(false);
    expect(shown(img())).toBe(false);
    expect(shown(q("[data-account-person-icon]"))).toBe(true);
    load();
    expect(shown(img())).toBe(true);
    expect(shown(q("[data-account-person-icon]"))).toBe(false);
    expect(img().getAttribute("src")).toBe("https://cdn.test/a.png");
  });

  it("shows a cached picture at once", async () => {
    Object.defineProperty(HTMLImageElement.prototype, "complete", {
      configurable: true,
      get: () => true,
    });
    Object.defineProperty(HTMLImageElement.prototype, "naturalWidth", {
      configurable: true,
      get: () => 64,
    });
    try {
      await mount();
      await respond(userMe());
      expect(shown(img())).toBe(true);
      expect(shown(q("[data-account-person-icon]"))).toBe(false);
    } finally {
      delete (HTMLImageElement.prototype as { naturalWidth?: number })
        .naturalWidth;
    }
  });

  it("a picture that fails to load leaves the person icon, and never a loading state", async () => {
    await mount();
    await respond(userMe());
    img().dispatchEvent(new Event("error"));
    expect(shown(img())).toBe(false);
    expect(shown(q("[data-account-person-icon]"))).toBe(true);
    expect(shown(q("[data-account-spinner]"))).toBe(false);
    // and a refresh afterwards does not bring the broken picture back
    await respond(userMe({ xpInLevel: 200 }));
    expect(shown(q("[data-account-person-icon]"))).toBe(true);
  });

  it("is never left spinning: once the account has resolved the spinner is gone, with or without a picture", async () => {
    await mount();
    for (const response of [userMe(), userMe(null), false as const]) {
      await respond(response);
      expect(shown(q("[data-account-spinner]"))).toBe(false);
    }
  });

  it("the same on the mobile top bar", async () => {
    await mount("mobile");
    await respond(userMe());
    expect(shown(q("[data-account-spinner]"))).toBe(false);
    expect(shown(img())).toBe(false);
    load();
    expect(shown(img())).toBe(true);
  });
});

describe("the nav picture stays put", () => {
  it("is the same element when the level arrives after the picture was set up (the plain pill becomes the ring)", async () => {
    // the first answer carries no level, the next does: the old markup was
    // replaced here and its fresh picture sat on its spinner for good
    await mount();
    await respond(userMe(null));
    const before = img();
    load();
    await respond(userMe());
    expect(img()).toBe(before);
    expect(q("[data-xp-ring]")).not.toBeNull();
    expect(shown(img())).toBe(true);
    expect(shown(q("[data-account-spinner]"))).toBe(false);
  });

  it("an XP gain animates the ring and leaves the picture alone", async () => {
    await mount();
    await respond(userMe());
    load();
    const before = img();
    const watch = watchSrc(before);
    await respond(userMe({ xpInLevel: 400 }));
    expect(img()).toBe(before);
    expect(watch.flush()).toBe(0);
    expect(shown(img())).toBe(true);
    // the ring moved
    expect(q("[data-xp-ring-fill]").getAttribute("style")).toContain(
      "stroke-dasharray: 57.14",
    );
  });

  it("a level gained pops the badge and pulses the ring, and leaves the picture alone", async () => {
    await mount();
    await respond(userMe());
    load();
    const before = img();
    const watch = watchSrc(before);
    await respond(userMe({ level: 4, xpInLevel: 10 }));
    expect(q("[data-account-level]").className).toContain("df-level-up");
    expect(q("[data-xp-ring]").getAttribute("class")).toContain(
      "df-ring-pulse",
    );
    expect(img()).toBe(before);
    expect(watch.flush()).toBe(0);
    expect(shown(img())).toBe(true);
  });

  it("many refreshes with the same address never write it again or hide the picture", async () => {
    await mount();
    await respond(userMe());
    load();
    const before = img();
    const watch = watchSrc(before);
    for (let i = 0; i < 5; i++) {
      await respond(userMe({ xpInLevel: 100 + i }));
      expect(shown(img())).toBe(true);
    }
    // opening the menu re-renders the trigger too
    q("[data-account-trigger]").click();
    await el.updateComplete;
    expect(img()).toBe(before);
    expect(shown(img())).toBe(true);
    expect(watch.flush()).toBe(0);
  });

  it("a different address does update it, and waits for it to load", async () => {
    await mount();
    await respond(userMe());
    load();
    avatarUrl = "https://cdn.test/b.png";
    await respond(userMe());
    expect(img().getAttribute("src")).toBe("https://cdn.test/b.png");
    expect(shown(img())).toBe(false);
    expect(shown(q("[data-account-person-icon]"))).toBe(true);
    load();
    expect(shown(img())).toBe(true);
  });

  it("the ring still eases, and still does not under reduced motion", async () => {
    await mount();
    await respond(userMe());
    const fill = q("[data-xp-ring-fill]");
    const cls = fill.getAttribute("class") ?? "";
    expect(cls).toContain("transition-[stroke-dasharray]");
    expect(cls).toContain("motion-reduce:transition-none");
    await respond(userMe({ xpInLevel: 350 }));
    expect(q("[data-xp-ring-fill]")).toBe(fill);
    expect(fill.getAttribute("style")).toContain("stroke-dasharray: 50 100");
    const css = readFileSync("src/client/styles.css", "utf8");
    expect(css).toMatch(
      /prefers-reduced-motion: reduce\) \{\s*\.df-xp-pop,\s*\.df-level-up,\s*\.df-ring-pulse \{\s*animation: none;/,
    );
  });
});

describe("the picture's classes are fixed", () => {
  it("none of the elements the updater drives has a class that comes from a changing binding", async () => {
    // a class rewritten by a render would drop the `hidden` the updater put on
    const source = readFileSync(
      "src/client/components/NavAccountMenu.ts",
      "utf8",
    );
    const block = source.slice(
      source.indexOf("private renderIdentityIcons"),
      source.indexOf("private renderTrigger"),
    );
    for (const m of block.matchAll(/class="([^"]*)"/g)) {
      expect(m[1], m[1]).not.toContain("${");
    }
  });
});
