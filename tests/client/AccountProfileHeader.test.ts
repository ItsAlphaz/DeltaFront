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
  accountProfileHeader,
  linkedHandle,
  type AccountProfileHeaderProps,
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

function mount(over: Partial<AccountProfileHeaderProps> = {}): HTMLElement {
  render(
    accountProfileHeader({
      player: player(),
      identity: identity(),
      progression: progression(),
      prestigeable: true,
      onTitleChange,
      onPrestige,
      ...over,
    }),
    host,
  );
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
  it("is a single card with an identity band, a progression band and a title band, in that order", () => {
    mount();
    const card = q("[data-account-header]")!;
    expect(
      [...card.children].map((c) =>
        c.getAttributeNames().find((n) => n.startsWith("data-account-")),
      ),
    ).toEqual([
      "data-account-identity",
      "data-account-progression",
      "data-account-title-row",
    ]);
    // each band after the first sits under a full-width rule
    expect(q("[data-account-progression]")?.className).toContain("border-t");
    expect(q("[data-account-title-row]")?.className).toContain("border-t");
  });

  it("keeps the XP bar in its own band, never beside the avatar", () => {
    mount();
    const bar = q("[data-xp-bar]")!;
    expect(q("[data-account-progression]")?.contains(bar)).toBe(true);
    expect(q("[data-account-identity]")?.contains(bar)).toBe(false);
    expect(q("[data-account-avatar]")?.parentElement?.contains(bar)).toBe(
      false,
    );
    // padded on every side, with space between the lines inside the band
    expect(q("[data-account-progression]")?.className).toMatch(/\bp-5\b/);
    expect(q("[data-account-progression]")?.className).toMatch(/\bgap-3\b/);
  });

  it("shows the identity alone when progression is off", () => {
    mount({ player: player({ progress: undefined }) });
    expect(q("[data-account-identity]")).not.toBeNull();
    expect(q("[data-account-progression]")).toBeNull();
    expect(q("[data-account-title-row]")).toBeNull();
    expect(q("[data-account-level-chip]")).toBeNull();
    expect(q("[data-xp-bar]")).toBeNull();
    expect(q("#account-username")?.textContent).toBe("Alphaz");
  });
});

describe("identity band", () => {
  it("shows the name, the clan tag, the linked handle and the avatar", () => {
    mount();
    expect(q("#account-username")?.textContent).toBe("Alphaz");
    expect(text("[data-account-clan]")).toBe("[DELTA]");
    expect(text("[data-account-handle]")).toBe("@i_alphaz");
    expect(
      q("[data-account-handle]")?.getAttribute("data-account-handle-kind"),
    ).toBe("discord");
    const img = q("[data-account-avatar] img") as HTMLImageElement;
    expect(img.getAttribute("src")).toBe("https://cdn.example/7/abc.png");
  });

  it("keeps the clan tag and the linked handle out of the name and the status block", () => {
    mount();
    const status = q("#account-status")!;
    expect(status.contains(q("[data-account-clan]"))).toBe(false);
    expect(status.contains(q("[data-account-handle]"))).toBe(false);
    expect(q("#account-username")?.textContent).not.toContain("DELTA");
    // the sign-in identity never leaks into the verified / staff block
    expect(status.textContent).not.toContain("i_alphaz");
  });

  it("falls back to the initial when there is no avatar", () => {
    mount({ identity: identity({ discord: { ...DISCORD, avatar: null } }) });
    expect(q("[data-account-avatar] img")).toBeNull();
    expect(text("[data-account-avatar]")).toBe("A");
  });

  it("uses a Steam avatar and persona for a Steam account", () => {
    mount({
      identity: {
        steam: {
          steamId: "1",
          personaName: "SnugglePuppy",
          avatarUrl: "https://cdn/x.jpg",
        },
      } as unknown as Identity,
    });
    expect(
      (q("[data-account-avatar] img") as HTMLImageElement).getAttribute("src"),
    ).toBe("https://cdn/x.jpg");
    expect(text("[data-account-handle]")).toBe("SnugglePuppy");
  });

  it("names the linked identity in the order discord, google, email, steam", () => {
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

  it("puts the check beside the name and the badges as chips under it", () => {
    mount();
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
    mount({ player: player({ staffRole: "mod" }) });
    expect(q("#account-staff-chip")?.className).not.toContain(
      "border-df-red/50",
    );
    expect(text("#account-staff-chip")).toContain("staff.mod");
  });

  it("shows neither chip for an ordinary account", () => {
    mount({ player: player({ verified: false, staffRole: undefined }) });
    expect(q("#account-verified-chip")).toBeNull();
    expect(q("#account-staff-chip")).toBeNull();
    expect(q("#account-status")?.querySelector("svg")).toBeNull();
  });

  it("tells a verified account with no username to set one", () => {
    mount({ player: player({ username: null, staffRole: undefined }) });
    expect(q("#account-username")).toBeNull();
    const guidance = q("#account-verified-needs-username")!;
    expect(guidance.textContent).toContain(
      "account_modal.verified_needs_username",
    );
    guidance.querySelector("button")!.click();
    expect(window.location.hash).toBe("#modal=change-username");
    window.location.hash = "";
  });

  it("shows the Credits balance with its label, as the big number of the card", () => {
    mount();
    const credits = q("[data-account-credits]")!;
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
  it("reads LEVEL · RANK, then the milestone and the XP, then the bar", () => {
    mount();
    const line = text("[data-account-level-line]")!;
    expect(line).toContain('progression.level:{"level":1}');
    expect(line).toContain("progression.rank_recruit");
    expect(text("[data-account-milestone]")).toBe(
      'progression.next_milestone:{"level":5,"credits":"250"}',
    );
    expect(text("[data-account-xp-text]")).toBe(
      'progression.xp_progress:{"current":"0","next":"500"}',
    );
    const band = q("[data-account-progression]")!;
    const order = [
      "[data-account-level-line]",
      "[data-account-milestone]",
      "[data-xp-bar]",
    ].map((sel) => band.querySelector(sel)!);
    for (let i = 1; i < order.length; i++) {
      expect(
        order[i - 1].compareDocumentPosition(order[i]) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
    }
  });

  it("puts the level on the avatar corner, with its full name for a screen reader", () => {
    mount({
      player: player({
        progress: { ...PROGRESS, level: 47, prestige: 2 },
      }),
    });
    const chip = q("[data-account-level-chip]")!;
    expect(chip.textContent?.trim()).toBe("47");
    expect(chip.getAttribute("aria-label")).toContain("progression.level");
    expect(q("[data-account-avatar]")?.parentElement?.contains(chip)).toBe(
      true,
    );
  });

  it("draws the XP as a segmented bar that matches the level's progress", () => {
    mount({
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
    expect(q("[data-account-xp-text]")?.className).toContain("tabular-nums");
  });

  it("shows prestige, and the emblem, once the player has prestiged", () => {
    mount({
      player: player({
        progress: { ...PROGRESS, level: 30, prestige: 3 },
      }),
    });
    expect(text("[data-account-prestige]")).toBe(
      'progression.prestige:{"prestige":3}',
    );
    expect(q("[data-account-emblem]")).not.toBeNull();
    mount();
    expect(q("[data-account-prestige]")).toBeNull();
    expect(q("[data-account-emblem]")).toBeNull();
  });

  it("reads LEGEND, with a full bar and no next level", () => {
    mount({
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
    expect(text("[data-account-level-line]")).toContain("progression.legend");
    expect(text("[data-account-xp-text]")).toBe("progression.max_level");
    expect(q("[data-xp-bar]")?.getAttribute("aria-valuenow")).toBe("100");
    expect(q("[data-account-milestone]")).toBeNull();
  });

  it("offers Prestige only at level 100 on a page that handles it", () => {
    const ready = {
      ...PROGRESS,
      level: 100,
      xpForNext: 0,
      canPrestige: true,
    };
    mount({ player: player({ progress: ready }) });
    const button = q(
      "[data-account-prestige-button]",
    ) as HTMLButtonElement | null;
    expect(button).not.toBeNull();
    button!.click();
    expect(onPrestige).toHaveBeenCalledTimes(1);

    mount({ player: player({ progress: ready }), prestigeable: false });
    expect(q("[data-account-prestige-button]")).toBeNull();
    mount();
    expect(q("[data-account-prestige-button]")).toBeNull();
  });
});

describe("display title", () => {
  const select = () => q("[data-account-title]") as HTMLSelectElement;

  it("labels the choice and says where it shows", () => {
    mount();
    const row = q("[data-account-title-row]")!;
    expect(row.textContent).toContain("progression.display_title");
    expect(row.textContent).toContain("progression.display_title_hint");
  });

  it("lists No title and each earned title, with the chosen one selected", () => {
    mount({ progression: progression({ selectedTitle: "veteran" }) });
    expect([...select().options].map((o) => o.value)).toEqual([
      "",
      "veteran",
      "prestige:1",
    ]);
    expect(select().selectedOptions[0].value).toBe("veteran");
    mount();
    expect(select().selectedOptions[0].value).toBe("");
  });

  it("reports a choice, and No title as null", () => {
    mount();
    select().value = "prestige:1";
    select().dispatchEvent(new Event("change"));
    expect(onTitleChange).toHaveBeenLastCalledWith("prestige:1");
    select().value = "";
    select().dispatchEvent(new Event("change"));
    expect(onTitleChange).toHaveBeenLastCalledWith(null);
  });

  it("is disabled until the titles are known, and while one is being saved", () => {
    mount({ progression: null });
    expect(select().disabled).toBe(true);
    // the title already chosen still shows, from the account itself
    mount({
      progression: null,
      player: player({ progress: { ...PROGRESS, title: "veteran" } }),
    });
    expect(select().disabled).toBe(true);
    mount({ savingTitle: true });
    expect(select().disabled).toBe(true);
    mount();
    expect(select().disabled).toBe(false);
  });
});

describe("responsive structure", () => {
  it("stacks the identity and Credits on a phone, side by side from sm", () => {
    mount();
    const band = q("[data-account-identity]")!.className;
    expect(band).toContain("flex-col");
    expect(band).toContain("sm:flex-row");
    expect(band).toContain("sm:justify-between");
  });

  it("stacks the title label over its select on a phone, full width", () => {
    mount();
    const row = q("[data-account-title-row]")!.className;
    expect(row).toContain("flex-col");
    expect(row).toContain("sm:flex-row");
    expect(q("[data-account-title]")?.className).toContain("w-full");
    expect(q("[data-account-title]")?.className).toContain("sm:w-64");
  });

  it("truncates a long name, clan tag and handle instead of widening the card", () => {
    mount({
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
    expect(q("[data-account-clan]")?.className).toContain("truncate");
    expect(q("[data-account-handle]")?.className).toContain("truncate");
    // the column that holds them may shrink below its content
    expect(q("[data-account-handle]")?.parentElement?.className).toContain(
      "min-w-0",
    );
    // the avatar and the Credits keep their size
    expect(q("[data-account-avatar]")?.parentElement?.className).toContain(
      "shrink-0",
    );
    expect(q("[data-account-credits]")?.className).toContain("shrink-0");
  });

  it("lets the XP line wrap under the level instead of overflowing", () => {
    mount();
    const xpRow = q("[data-account-xp-text]")!.parentElement!;
    expect(xpRow.className).toContain("flex-wrap");
    expect(q("[data-account-xp-text]")?.className).toContain("shrink-0");
    expect(q("[data-account-level-line]")?.className).toContain("break-words");
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

  it("is ten empty segments at zero", () => {
    const el = bar(0);
    expect(states(el)).toEqual(Array(10).fill("empty"));
    expect(el.getAttribute("aria-valuenow")).toBe("0");
    expect(el.getAttribute("role")).toBe("progressbar");
  });

  it("fills whole segments, then part of the next one", () => {
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

  it("is full at 100 and clamps what is out of range", () => {
    expect(states(bar(100))).toEqual(Array(10).fill("full"));
    expect(states(bar(250))).toEqual(Array(10).fill("full"));
    expect(states(bar(-5))).toEqual(Array(10).fill("empty"));
    expect(bar(Number.NaN).getAttribute("aria-valuenow")).toBe("0");
  });

  it("takes another segment count, and announces one value, not the pieces", () => {
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
