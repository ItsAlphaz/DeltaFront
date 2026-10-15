import type {
  ProgressionMe,
  UserMeResponse,
} from "@openfront/shared/ApiSchemas";
import { render } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/client/Utils", () => ({
  translateText: (key: string, params?: Record<string, string | number>) =>
    params ? `${key}:${JSON.stringify(params)}` : key,
  getDiscordAvatarUrl: vi.fn((d: { id: string; avatar: string | null }) =>
    d.avatar ? `https://cdn.example/${d.id}/${d.avatar}.png` : null,
  ),
}));

import {
  AccountProfileHeader,
  linkedHandle,
} from "../../src/client/components/AccountProfileHeader";
import { segmentedXpBar } from "../../src/client/components/XpBar";

type Player = UserMeResponse["player"];
type Identity = NonNullable<UserMeResponse["user"]>;

const PROGRESS = {
  prestige: 0,
  level: 1,
  xpInLevel: 0,
  xpForNext: 500,
  lifetimeXp: 0,
  legend: false,
  canPrestige: false,
};

function player(over: Record<string, unknown> = {}): Player {
  return {
    publicId: "9EKyqPa9rm",
    username: "Alphaz",
    verified: true,
    staffRole: "owner",
    clans: [{ tag: "DELTA" }],
    currency: { soft: 998_200, hard: 0 },
    progress: PROGRESS,
    ...over,
  } as unknown as Player;
}

const DISCORD = {
  id: "7",
  avatar: "abc",
  username: "i_alphaz",
  global_name: null,
  discriminator: "0",
};

function identity(over: Record<string, unknown> = {}): Identity {
  return { discord: DISCORD, ...over } as unknown as Identity;
}

function progression(over: Partial<ProgressionMe> = {}): ProgressionMe {
  return {
    progress: PROGRESS,
    rank: "recruit",
    nextMilestone: { level: 5, credits: 250, flare: null, title: null },
    season: null,
    seasonTrack: [],
    challenges: {
      daily: { periodKey: "d", resetsAt: "2026-10-15T00:00:00Z", items: [] },
      weekly: { periodKey: "w", resetsAt: "2026-10-19T00:00:00Z", items: [] },
    },
    titles: ["veteran", "prestige:1"],
    selectedTitle: null,
    history: [],
    levelHidden: false,
    ...over,
  };
}

let host: HTMLElement;
const onTitleChange = vi.fn();
const onPrestige = vi.fn();

async function mount(
  over: Partial<AccountProfileHeader> = {},
): Promise<HTMLElement> {
  const el = document.createElement(
    "account-profile-header",
  ) as AccountProfileHeader;
  Object.assign(el, {
    player: player(),
    identity: identity(),
    progression: progression(),
    prestigeable: true,
    ...over,
  });
  el.addEventListener("title-change", (e) =>
    onTitleChange((e as CustomEvent).detail),
  );
  el.addEventListener("prestige-request", () => onPrestige());
  host.replaceChildren(el);
  await el.updateComplete;
  return host;
}
const q = (sel: string) => host.querySelector(sel);
const text = (sel: string) => q(sel)?.textContent?.replace(/\s+/g, " ").trim();

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  vi.clearAllMocks();
});
afterEach(() => host.remove());

describe("account profile header: the one top card", () => {
  const bands = (card: Element) =>
    [...card.children]
      .map((c) =>
        c
          .getAttributeNames()
          .find((n) => /^data-ph-(identity|progression|title-row)$/.test(n)),
      )
      .filter((n) => n !== undefined);

  it("is a single card with an identity band, a progression band and a title band, in that order", async () => {
    await mount();
    const card = q("[data-account-header]")!;
    expect(bands(card)).toEqual([
      "data-ph-identity",
      "data-ph-progression",
      "data-ph-title-row",
    ]);
    // each band after the first sits under a full-width rule
    expect(q("[data-ph-progression]")?.className).toContain("border-t");
    expect(q("[data-ph-title-row]")?.className).toContain("border-t");
    // the hex pattern is behind everything, the card is the profile system's
    expect(card.hasAttribute("data-ph-root")).toBe(true);
    expect(card.querySelector(":scope > svg pattern")).not.toBeNull();
  });

  it("keeps the XP bar in its own band, never beside the avatar", async () => {
    await mount();
    const bar = q("[data-xp-bar]")!;
    expect(q("[data-ph-progression]")?.contains(bar)).toBe(true);
    expect(q("[data-ph-identity]")?.contains(bar)).toBe(false);
    expect(q("[data-ph-avatar]")?.parentElement?.contains(bar)).toBe(false);
  });

  it("separates the progression band from the identity: room under the avatar, a stronger rule, a shade of its own, room above the level", async () => {
    await mount();
    const identity = q("[data-ph-identity]")!.className;
    const band = q("[data-ph-progression]")!.className;
    // the identity band's bottom padding clears the chip overhanging the avatar
    expect(identity).toMatch(/\bpb-9\b/);
    expect(identity).toMatch(/\bsm:pb-10\b/);
    // the band: a stronger rule than the others, its own shade, real top room
    expect(band).toContain("border-white/15");
    expect(band).toContain("bg-black/25");
    expect(band).toMatch(/\bpt-7\b/);
    expect(band).toMatch(/\bsm:pt-8\b/);
    // and more air between its lines than before
    expect(band).toMatch(/\bgap-4\b/);
    expect(q("[data-ph-title-row]")!.className).toContain("border-white/10");
  });

  it("puts the band's lines in order: level, milestone and XP, then the bar", async () => {
    await mount();
    const band = q("[data-ph-progression]")!;
    const order = [
      "[data-ph-level-line]",
      "[data-ph-milestone]",
      "[data-xp-bar]",
    ].map((sel) => band.querySelector(sel)!);
    for (let i = 1; i < order.length; i++) {
      expect(
        order[i - 1].compareDocumentPosition(order[i]) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
    }
  });

  it("shows the identity alone when progression is off", async () => {
    await mount({ player: player({ progress: undefined }) });
    expect(q("[data-ph-identity]")).not.toBeNull();
    expect(q("[data-ph-progression]")).toBeNull();
    expect(q("[data-ph-title-row]")).toBeNull();
    expect(q("[data-ph-level-chip]")).toBeNull();
    expect(q("[data-xp-bar]")).toBeNull();
    expect(q("#account-username")?.textContent).toBe("Alphaz");
  });
});

describe("identity band", () => {
  it("shows the name, the clan tag, the linked handle and the avatar", async () => {
    await mount();
    expect(q("#account-username")?.textContent).toBe("Alphaz");
    expect(text("[data-ph-clan]")).toBe("[DELTA]");
    expect(text("[data-ph-handle]")).toBe("@i_alphaz");
    expect(q("[data-ph-handle]")?.getAttribute("data-ph-handle-kind")).toBe(
      "discord",
    );
    const img = q("[data-ph-avatar] img") as HTMLImageElement;
    expect(img.getAttribute("src")).toBe("https://cdn.example/7/abc.png");
  });

  it("keeps the clan tag and the linked handle out of the name and the status block", async () => {
    await mount();
    const status = q("#account-status")!;
    expect(status.contains(q("[data-ph-clan]"))).toBe(false);
    expect(status.contains(q("[data-ph-handle]"))).toBe(false);
    expect(q("#account-username")?.textContent).not.toContain("DELTA");
    // the sign-in identity never leaks into the verified / staff block
    expect(status.textContent).not.toContain("i_alphaz");
  });

  it("falls back to the initial when there is no avatar", async () => {
    await mount({
      identity: identity({ discord: { ...DISCORD, avatar: null } }),
    });
    expect(q("[data-ph-avatar] img")).toBeNull();
    expect(text("[data-ph-avatar]")).toBe("A");
  });

  it("uses a Steam avatar and persona for a Steam account", async () => {
    await mount({
      identity: {
        steam: {
          steamId: "1",
          personaName: "SnugglePuppy",
          avatarUrl: "https://cdn/x.jpg",
        },
      } as unknown as Identity,
    });
    expect(
      (q("[data-ph-avatar] img") as HTMLImageElement).getAttribute("src"),
    ).toBe("https://cdn/x.jpg");
    expect(text("[data-ph-handle]")).toBe("SnugglePuppy");
  });

  it("names the linked identity in the order discord, google, email, steam", async () => {
    expect(linkedHandle(identity({ google: { email: "a@b.c" } }))?.kind).toBe(
      "discord",
    );
    expect(
      linkedHandle({ google: { email: "a@b.c" } } as unknown as Identity),
    ).toEqual({ text: "a@b.c", kind: "google" });
    expect(linkedHandle({ email: "x@y.z" } as unknown as Identity)).toEqual({
      text: "x@y.z",
      kind: "email",
    });
    expect(linkedHandle(null)).toBeNull();
  });

  it("puts the check beside the name and the badges as chips under it", async () => {
    await mount();
    const username = q("#account-username")!;
    expect(
      username.parentElement?.querySelector(
        'svg[aria-label="username.verified_player"]',
      ),
    ).not.toBeNull();
    expect(text("#account-verified-chip")).toContain(
      "account_modal.verified_label",
    );
    expect(text("#account-staff-chip")).toContain("staff.owner");
    // the owner chip is the red one; the other roles are neutral
    expect(q("#account-staff-chip")?.className).toContain("border-df-red/50");
    await mount({ player: player({ staffRole: "mod" }) });
    expect(q("#account-staff-chip")?.className).not.toContain(
      "border-df-red/50",
    );
    expect(text("#account-staff-chip")).toContain("staff.mod");
  });

  it("shows neither chip for an ordinary account", async () => {
    await mount({ player: player({ verified: false, staffRole: undefined }) });
    expect(q("#account-verified-chip")).toBeNull();
    expect(q("#account-staff-chip")).toBeNull();
    expect(q("#account-status")?.querySelector("svg")).toBeNull();
  });

  it("tells a verified account with no username to set one", async () => {
    await mount({ player: player({ username: null, staffRole: undefined }) });
    expect(q("#account-username")).toBeNull();
    const guidance = q("#account-verified-needs-username")!;
    expect(guidance.textContent).toContain(
      "account_modal.verified_needs_username",
    );
    guidance.querySelector("button")!.click();
    expect(window.location.hash).toBe("#modal=change-username");
    window.location.hash = "";
  });

  it("shows the Credits balance with its label, as the big number of the card", async () => {
    await mount();
    const credits = q("[data-ph-aside=credits]")!;
    expect(credits.textContent).toContain("account_modal.credits_label");
    const display = credits.querySelector("currency-display") as unknown as {
      soft: number;
      hard: number;
      large: boolean;
    };
    expect(display.soft).toBe(998_200);
    expect(display.large).toBe(true);
  });
});

describe("progression band", () => {
  it("reads LEVEL · RANK, then the milestone and the XP, then the bar", async () => {
    await mount();
    const line = text("[data-ph-level-line]")!;
    expect(line).toContain('progression.level:{"level":1}');
    expect(line).toContain("progression.rank_recruit");
    expect(text("[data-ph-milestone]")).toBe(
      'progression.next_milestone:{"level":5,"credits":"250"}',
    );
    expect(text("[data-ph-xp-text]")).toBe(
      'progression.xp_progress:{"current":"0","next":"500"}',
    );
    const band = q("[data-ph-progression]")!;
    const order = [
      "[data-ph-level-line]",
      "[data-ph-milestone]",
      "[data-xp-bar]",
    ].map((sel) => band.querySelector(sel)!);
    for (let i = 1; i < order.length; i++) {
      expect(
        order[i - 1].compareDocumentPosition(order[i]) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
    }
  });

  it("puts the level on the avatar corner, with its full name for a screen reader", async () => {
    await mount({
      player: player({
        progress: { ...PROGRESS, level: 47, prestige: 2 },
      }),
    });
    const chip = q("[data-ph-level-chip]")!;
    expect(chip.textContent?.trim()).toBe("47");
    expect(chip.getAttribute("aria-label")).toContain("progression.level");
    expect(q("[data-ph-avatar]")?.parentElement?.contains(chip)).toBe(true);
  });

  it("draws the XP as a segmented bar that matches the level's progress", async () => {
    await mount({
      player: player({
        progress: { ...PROGRESS, level: 12, xpInLevel: 1000, xpForNext: 4000 },
      }),
    });
    const bar = q("[data-xp-bar]")!;
    expect(bar.hasAttribute("data-xp-segmented")).toBe(true);
    expect(bar.getAttribute("aria-valuenow")).toBe("25");
    expect(bar.getAttribute("aria-valuetext")).toBe(
      'progression.xp_progress:{"current":"1,000","next":"4,000"}',
    );
    expect(bar.querySelectorAll("[data-xp-segment]")).toHaveLength(10);
    // XP numbers are aligned on a shared figure grid and never wrap mid-number
    expect(q("[data-ph-xp-text]")?.className).toContain("tabular-nums");
  });

  it("shows prestige, and the emblem, once the player has prestiged", async () => {
    await mount({
      player: player({
        progress: { ...PROGRESS, level: 30, prestige: 3 },
      }),
    });
    expect(text("[data-ph-prestige]")).toBe(
      'progression.prestige:{"prestige":3}',
    );
    expect(q("[data-ph-emblem]")).not.toBeNull();
    await mount();
    expect(q("[data-ph-prestige]")).toBeNull();
    expect(q("[data-ph-emblem]")).toBeNull();
  });

  it("reads LEGEND, with a full bar and no next level", async () => {
    await mount({
      player: player({
        progress: {
          ...PROGRESS,
          level: 100,
          prestige: 10,
          legend: true,
          xpInLevel: 0,
          xpForNext: 0,
        },
      }),
      progression: progression({ nextMilestone: null }),
    });
    expect(text("[data-ph-level-line]")).toContain("progression.legend");
    expect(text("[data-ph-xp-text]")).toBe("progression.max_level");
    expect(q("[data-xp-bar]")?.getAttribute("aria-valuenow")).toBe("100");
    expect(q("[data-ph-milestone]")).toBeNull();
  });

  it("offers Prestige only at level 100 on a page that handles it", async () => {
    const ready = {
      ...PROGRESS,
      level: 100,
      xpForNext: 0,
      canPrestige: true,
    };
    await mount({ player: player({ progress: ready }) });
    const button = q("[data-ph-prestige-button]") as HTMLButtonElement | null;
    expect(button).not.toBeNull();
    button!.click();
    expect(onPrestige).toHaveBeenCalledTimes(1);

    await mount({ player: player({ progress: ready }), prestigeable: false });
    expect(q("[data-ph-prestige-button]")).toBeNull();
    await mount();
    expect(q("[data-ph-prestige-button]")).toBeNull();
  });
});

describe("display title", () => {
  const select = () => q("[data-ph-title-select]") as HTMLSelectElement;

  it("labels the choice and says where it shows", async () => {
    await mount();
    const row = q("[data-ph-title-row]")!;
    expect(row.textContent).toContain("progression.display_title");
    expect(row.textContent).toContain("progression.display_title_hint");
  });

  it("lists No title and each earned title, with the chosen one selected", async () => {
    await mount({ progression: progression({ selectedTitle: "veteran" }) });
    expect([...select().options].map((o) => o.value)).toEqual([
      "",
      "veteran",
      "prestige:1",
    ]);
    expect(select().selectedOptions[0].value).toBe("veteran");
    await mount();
    expect(select().selectedOptions[0].value).toBe("");
  });

  it("reports a choice, and No title as null", async () => {
    await mount();
    select().value = "prestige:1";
    select().dispatchEvent(new Event("change"));
    expect(onTitleChange).toHaveBeenLastCalledWith("prestige:1");
    select().value = "";
    select().dispatchEvent(new Event("change"));
    expect(onTitleChange).toHaveBeenLastCalledWith(null);
  });

  it("is disabled until the titles are known, and while one is being saved", async () => {
    await mount({ progression: null });
    expect(select().disabled).toBe(true);
    // the title already chosen still shows, from the account itself
    await mount({
      progression: null,
      player: player({ progress: { ...PROGRESS, title: "veteran" } }),
    });
    expect(select().disabled).toBe(true);
    await mount({ savingTitle: true });
    expect(select().disabled).toBe(true);
    await mount();
    expect(select().disabled).toBe(false);
  });
});

describe("responsive structure", () => {
  it("stacks the identity and Credits on a phone, side by side from sm", async () => {
    await mount();
    const band = q("[data-ph-identity]")!.className;
    expect(band).toContain("flex-col");
    expect(band).toContain("sm:flex-row");
    expect(band).toContain("sm:justify-between");
  });

  it("stacks the title label over its select on a phone, full width", async () => {
    await mount();
    const row = q("[data-ph-title-row]")!.className;
    expect(row).toContain("flex-col");
    expect(row).toContain("sm:flex-row");
    expect(q("[data-ph-title-select]")?.className).toContain("w-full");
    expect(q("[data-ph-title-select]")?.className).toContain("sm:w-64");
  });

  it("truncates a long name, clan tag and handle instead of widening the card", async () => {
    await mount({
      player: player({
        username: "A".repeat(80),
        clans: [{ tag: "LONGTAG" }],
      }),
      identity: identity({
        discord: { ...DISCORD, username: "x".repeat(80) },
      }),
    });
    expect(q("#account-username")?.className).toContain("truncate");
    expect(q("#account-username")?.className).toContain("min-w-0");
    expect(q("[data-ph-clan]")?.className).toContain("truncate");
    expect(q("[data-ph-handle]")?.className).toContain("truncate");
    // the column that holds them may shrink below its content
    expect(q("[data-ph-handle]")?.parentElement?.className).toContain(
      "min-w-0",
    );
    // the avatar and the Credits keep their size
    expect(q("[data-ph-avatar]")?.parentElement?.className).toContain(
      "shrink-0",
    );
    expect(q("[data-ph-aside=credits]")?.className).toContain("shrink-0");
  });

  it("lets the XP line wrap under the level instead of overflowing", async () => {
    await mount();
    const xpRow = q("[data-ph-xp-text]")!.parentElement!;
    expect(xpRow.className).toContain("flex-wrap");
    expect(q("[data-ph-xp-text]")?.className).toContain("shrink-0");
    expect(q("[data-ph-level-line]")?.className).toContain("break-words");
  });
});

describe("segmented XP bar", () => {
  function bar(percent: number, opts?: Parameters<typeof segmentedXpBar>[1]) {
    render(segmentedXpBar(percent, opts), host);
    return q("[data-xp-bar]")!;
  }
  const states = (el: Element) =>
    [...el.querySelectorAll("[data-xp-segment]")].map((s) =>
      s.getAttribute("data-filled"),
    );
  const widths = (el: Element) =>
    [...el.querySelectorAll<HTMLElement>("[data-xp-segment-fill]")].map(
      (f) => f.style.width,
    );

  it("is ten empty segments at zero", async () => {
    const el = bar(0);
    expect(states(el)).toEqual(Array(10).fill("empty"));
    expect(el.getAttribute("aria-valuenow")).toBe("0");
    expect(el.getAttribute("role")).toBe("progressbar");
  });

  it("fills whole segments, then part of the next one", async () => {
    const el = bar(55);
    expect(states(el)).toEqual([
      "full",
      "full",
      "full",
      "full",
      "full",
      "partial",
      "empty",
      "empty",
      "empty",
      "empty",
    ]);
    expect(widths(el)[5]).toBe("50%");
    expect(el.getAttribute("aria-valuenow")).toBe("55");
  });

  it("is full at 100 and clamps what is out of range", async () => {
    expect(states(bar(100))).toEqual(Array(10).fill("full"));
    expect(states(bar(250))).toEqual(Array(10).fill("full"));
    expect(states(bar(-5))).toEqual(Array(10).fill("empty"));
    expect(bar(Number.NaN).getAttribute("aria-valuenow")).toBe("0");
  });

  it("takes another segment count, and announces one value, not the pieces", async () => {
    const el = bar(50, { segments: 4, valueText: "half" });
    expect(states(el)).toEqual(["full", "full", "empty", "empty"]);
    expect(el.getAttribute("aria-valuetext")).toBe("half");
    expect(
      [...el.querySelectorAll("[data-xp-segment]")].every(
        (s) => s.getAttribute("role") === null,
      ),
    ).toBe(true);
  });
});
