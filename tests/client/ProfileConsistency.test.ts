import type { UserMeResponse } from "@openfront/shared/ApiSchemas";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/client/Utils", () => ({
  translateText: (key: string, params?: Record<string, string | number>) =>
    params ? `${key}:${JSON.stringify(params)}` : key,
  getDiscordAvatarUrl: vi.fn(() => null),
}));

import "../../src/client/components/AccountProfileHeader";
import type { AccountProfileHeader } from "../../src/client/components/AccountProfileHeader";
import {
  ProfileCard,
  type ProfileCardProgress,
} from "../../src/client/components/ProfileCard";
import { PH_SPACING } from "../../src/client/components/ProfileHeaderView";

if (!customElements.get("profile-card")) {
  customElements.define("profile-card", ProfileCard);
}

// Your own Account page and another player's Stats page are two views of one
// profile system: the same bands, avatar, name, badges, LEVEL · RANK line and
// segmented XP bar, at the same spacing. What is private to you (Credits, the
// title select, the linked handle, Prestige, the linked accounts) stays on your
// page; what is public stays public.

const PROGRESS: ProfileCardProgress = {
  prestige: 2,
  level: 47,
  legend: false,
  lifetimeXp: 212_400,
  xpInLevel: 1490,
  xpForNext: 2410,
  title: "veteran",
};

let host: HTMLElement;
beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
});
afterEach(() => host.remove());

interface Shown {
  el: HTMLElement;
  root: HTMLElement;
  q: (sel: string) => HTMLElement | null;
  text: (sel: string) => string | undefined;
}

async function shown(el: HTMLElement & { updateComplete: Promise<boolean> }) {
  host.replaceChildren(el);
  await el.updateComplete;
  const root = el.querySelector<HTMLElement>("[data-ph-root]")!;
  return {
    el,
    root,
    q: (sel) => el.querySelector<HTMLElement>(sel),
    text: (sel) =>
      el.querySelector(sel)?.textContent?.replace(/\s+/g, " ").trim(),
  } satisfies Shown;
}

/** Another player's card, as the Stats page draws it. */
async function otherPlayer(over: Partial<ProfileCard> = {}) {
  const card = document.createElement("profile-card") as ProfileCard;
  Object.assign(card, {
    username: "CptMendoYen.5807",
    clanTag: "DELTA",
    progress: PROGRESS,
    verified: true,
    staffRole: "owner",
    ...over,
  });
  return shown(card);
}

/** Your own header, as the Account page draws it. */
async function ownPage(over: Partial<AccountProfileHeader> = {}) {
  const header = document.createElement(
    "account-profile-header",
  ) as AccountProfileHeader;
  Object.assign(header, {
    player: {
      publicId: "9EKyqPa9rm",
      username: "CptMendoYen.5807",
      verified: true,
      staffRole: "owner",
      clans: [{ tag: "DELTA" }],
      currency: { soft: 997_800, hard: 0 },
      progress: { ...PROGRESS, canPrestige: false },
    } as unknown as UserMeResponse["player"],
    identity: {
      discord: {
        id: "7",
        avatar: null,
        username: "i_alphaz",
        global_name: null,
        discriminator: "0",
      },
    } as unknown as UserMeResponse["user"],
    progression: {
      titles: ["veteran"],
      selectedTitle: "veteran",
      nextMilestone: { level: 50, credits: 1000, flare: null, title: null },
    } as never,
    ...over,
  });
  return shown(header);
}

describe("another player's profile uses the same system as yours", () => {
  it("draws the same bands, in the same order, from the same pieces", async () => {
    const other = await otherPlayer();
    const own = await ownPage();
    const bands = (root: HTMLElement) =>
      [...root.children]
        .map((c) =>
          c
            .getAttributeNames()
            .find((n) => /^data-ph-(identity|progression|title-row)$/.test(n)),
        )
        .filter((n) => n !== undefined);
    // yours has a title band as well; theirs is the first two
    expect(bands(other.root)).toEqual([
      "data-ph-identity",
      "data-ph-progression",
    ]);
    expect(bands(own.root)).toEqual([
      "data-ph-identity",
      "data-ph-progression",
      "data-ph-title-row",
    ]);
    for (const view of [other, own]) {
      expect(view.q("[data-ph-avatar-wrap]")).not.toBeNull();
      expect(view.q("[data-ph-level-chip]")).not.toBeNull();
      expect(view.q("[data-ph-clan]")).not.toBeNull();
      expect(view.q("[data-ph-name]")).not.toBeNull();
      expect(view.q("[data-ph-level-line]")).not.toBeNull();
      expect(view.q("[data-ph-xp-text]")).not.toBeNull();
      // the same segmented bar, with the same ten segments
      expect(view.q("[data-xp-bar]")?.hasAttribute("data-xp-segmented")).toBe(
        true,
      );
      expect(view.root.querySelectorAll("[data-xp-segment]")).toHaveLength(10);
    }
  });

  it("gives the bands the same spacing, rule and shade", async () => {
    const other = await otherPlayer();
    const own = await ownPage();
    for (const sel of ["[data-ph-identity]", "[data-ph-progression]"]) {
      expect(other.q(sel)!.className).toBe(own.q(sel)!.className);
    }
    expect(other.q("[data-ph-progression]")!.className).toContain(
      PH_SPACING.progression,
    );
    expect(other.q("[data-ph-identity]")!.className).toContain(
      PH_SPACING.identity,
    );
    // and the card itself: one border, one panel
    expect(other.root.className).toContain("rounded-xl");
    expect(other.root.className).toContain("bg-df-panel");
    expect(other.root.className).toContain("border-white/10");
    for (const cls of other.root.className
      .split(/\s+/)
      .filter((c) => /^(rounded|bg-|border)/.test(c))) {
      expect(own.root.className).toContain(cls);
    }
  });

  it("says the same things about the same player", async () => {
    const other = await otherPlayer();
    const own = await ownPage();
    for (const sel of [
      "[data-ph-level-line]",
      "[data-ph-rank]",
      "[data-ph-prestige]",
      "[data-ph-xp-text]",
      "[data-ph-level-chip]",
      "[data-ph-clan]",
      "[data-ph-name]",
      "[data-ph-chip=verified]",
      "[data-ph-chip=staff]",
    ]) {
      expect(other.text(sel), sel).toBeDefined();
      expect(other.text(sel), sel).toBe(own.text(sel));
    }
    expect(other.q("[data-xp-bar]")!.getAttribute("aria-valuenow")).toBe(
      own.q("[data-xp-bar]")!.getAttribute("aria-valuenow"),
    );
  });

  it("shows the level on the avatar, the level and rank in words, and the lifetime XP", async () => {
    const other = await otherPlayer();
    expect(other.text("[data-ph-level-chip]")).toBe("47");
    expect(other.text("[data-ph-level-line]")).toContain(
      'progression.level:{"level":47}',
    );
    expect(other.text("[data-ph-rank]")).toBe("progression.rank_lieutenant");
    expect(other.text("[data-ph-prestige]")).toBe(
      'progression.prestige:{"prestige":2}',
    );
    expect(other.text("[data-ph-aside=lifetime]")).toContain(
      "profile_card.lifetime_xp",
    );
    expect(other.text("[data-ph-lifetime]")).toBe("212,400");
    expect(other.q("level-badge")).not.toBeNull();
  });

  it("shows the clan, the name with its discriminator, and the badges", async () => {
    const other = await otherPlayer();
    expect(other.text("[data-ph-clan]")).toBe("[DELTA]");
    // one run of text, the discriminator muted inside it
    expect(other.q("[data-ph-name]")!.textContent).toBe("CptMendoYen.5807");
    expect(other.q("[data-ph-name] span")!.textContent).toBe(".5807");
    expect(other.q("[data-ph-name] span")!.className).toContain(
      "text-white/40",
    );
    // the check and the staff badge beside the name, and a chip each under it
    const row = other.q("[data-ph-name]")!.parentElement!;
    expect(
      row.querySelector('svg[aria-label="username.verified_player"]'),
    ).not.toBeNull();
    expect(row.querySelector("svg[data-staff-role=owner]")).not.toBeNull();
    expect(other.text("[data-ph-chip=verified]")).toContain(
      "account_modal.verified_label",
    );
    expect(
      other.q("[data-ph-chip=staff]")!.getAttribute("data-staff-role"),
    ).toBe("owner");
  });

  it("shows the title the player chose to show, and nothing without one", async () => {
    const other = await otherPlayer();
    expect(other.text("[data-ph-title]")).toBe("★ progression.title_veteran");
    const without = await otherPlayer({
      progress: { ...PROGRESS, title: null },
    });
    expect(without.q("[data-ph-title]")).toBeNull();
  });

  it("says how far to the next level, under the level line", async () => {
    const other = await otherPlayer();
    expect(other.text("[data-ph-to-next]")).toBe(
      'profile_card.to_next:{"xp":"920","level":48}',
    );
    // at the end of the track there is no next level to say
    const legend = await otherPlayer({
      progress: {
        prestige: 10,
        level: 100,
        legend: true,
        lifetimeXp: 1,
        xpInLevel: 0,
        xpForNext: 0,
      },
    });
    expect(legend.q("[data-ph-to-next]")).toBeNull();
    // and without the level's XP (an older endpoint) there is nothing to count
    const bare = await otherPlayer({
      progress: { prestige: 0, level: 5, legend: false, lifetimeXp: 9 },
    });
    expect(bare.q("[data-ph-to-next]")).toBeNull();
  });

  it("shows the running season under the level, as before", async () => {
    const other = await otherPlayer({
      progress: {
        ...PROGRESS,
        season: { name: "Opening", level: 18, xp: 7850 },
      },
    });
    expect(other.text("[data-ph-season]")).toContain(
      'progression.profile_season:{"name":"Opening","level":18,"xp":"7,850"}',
    );
  });

  it("shows neither badge nor chip for an ordinary player", async () => {
    const other = await otherPlayer({ verified: false, staffRole: undefined });
    expect(other.q("[data-ph-chip]")).toBeNull();
    expect(other.q("svg[data-staff-role]")).toBeNull();
    expect(other.q('svg[aria-label="username.verified_player"]')).toBeNull();
    expect(other.q("[data-ph-name]")!.textContent).toBe("CptMendoYen.5807");
  });

  it("leaves a bare name whole, with no discriminator", async () => {
    const other = await otherPlayer({ username: "Alphaz" });
    expect(other.q("[data-ph-name]")!.textContent).toBe("Alphaz");
    expect(other.q("[data-ph-name] span")).toBeNull();
  });

  it("draws a Legend the same way yours is: gold, a full bar, no next level", async () => {
    const legend: ProfileCardProgress = {
      prestige: 10,
      level: 100,
      legend: true,
      lifetimeXp: 2_106_720,
      xpInLevel: 0,
      xpForNext: 0,
    };
    const other = await otherPlayer({ progress: legend });
    const own = await ownPage({
      player: {
        ...((await ownPage()).el as AccountProfileHeader).player!,
        progress: legend,
      } as never,
    });
    for (const view of [other, own]) {
      expect(view.root.classList.contains("profile-card-legend")).toBe(true);
      expect(view.q("[data-xp-bar]")!.getAttribute("aria-valuenow")).toBe(
        "100",
      );
      expect(view.text("[data-ph-xp-text]")).toBe("progression.max_level");
      expect(view.text("[data-ph-level-line]")).toContain("progression.legend");
    }
  });
});

describe("what is private stays on your page", () => {
  it("another player's profile has no title select, no Credits, no handle, no links", async () => {
    const other = await otherPlayer({ prestigeable: false });
    expect(other.q("[data-ph-title-select]")).toBeNull();
    expect(other.q("[data-ph-title-row]")).toBeNull();
    expect(other.q("[data-ph-aside=credits]")).toBeNull();
    expect(other.q("currency-display")).toBeNull();
    expect(other.q("[data-ph-handle]")).toBeNull();
    expect(other.q("[data-ph-milestone]")).toBeNull();
    expect(other.q("select")).toBeNull();
    expect(other.q("button")).toBeNull();
    // none of the ids the Account page's own code looks for
    for (const id of [
      "account-status",
      "account-username",
      "account-verified-chip",
      "account-staff-chip",
    ]) {
      expect(other.el.querySelector(`#${id}`)).toBeNull();
    }
  });

  it("only your own card offers Prestige", async () => {
    const ready = {
      ...PROGRESS,
      level: 100,
      xpInLevel: 0,
      xpForNext: 0,
      canPrestige: true,
    };
    const stranger = await otherPlayer({ progress: ready });
    expect(stranger.q("[data-ph-prestige-button]")).toBeNull();
    const yours = await otherPlayer({ progress: ready, prestigeable: true });
    expect(yours.q("[data-ph-prestige-button]")).not.toBeNull();
  });

  it("your page keeps them: Credits, the handle, the title select, the milestone", async () => {
    const own = await ownPage();
    expect(own.q("[data-ph-aside=credits] currency-display")).not.toBeNull();
    expect(own.text("[data-ph-handle]")).toBe("@i_alphaz");
    expect(own.q("[data-ph-title-select]")).not.toBeNull();
    expect(own.q("[data-ph-milestone]")).not.toBeNull();
    expect(own.q("[data-ph-aside=lifetime]")).toBeNull();
    expect(own.q("#account-status")).not.toBeNull();
  });
});

describe("responsive, for both", () => {
  it("stacks the identity and its aside on a phone, side by side from sm", async () => {
    for (const view of [await otherPlayer(), await ownPage()]) {
      const band = view.q("[data-ph-identity]")!.className;
      expect(band).toContain("flex-col");
      expect(band).toContain("sm:flex-row");
      expect(band).toContain("sm:justify-between");
    }
  });

  it("truncates a long name and clan tag instead of widening the card", async () => {
    const other = await otherPlayer({
      username: `${"A".repeat(80)}.5807`,
      clanTag: "LONGTAG",
    });
    expect(other.q("[data-ph-name]")!.className).toContain("truncate");
    expect(other.q("[data-ph-name]")!.className).toContain("min-w-0");
    expect(other.q("[data-ph-clan]")!.className).toContain("truncate");
    expect(other.q("[data-ph-avatar-wrap]")!.className).toContain("shrink-0");
    expect(other.q("[data-ph-aside]")!.className).toContain("shrink-0");
    // the column that holds the name may shrink below its content
    expect(
      other.q("[data-ph-name]")!.closest(".min-w-0.flex-1"),
    ).not.toBeNull();
  });

  it("lets the level line and XP figure wrap on a narrow card", async () => {
    const other = await otherPlayer();
    expect(other.q("[data-ph-level-line]")!.className).toContain("break-words");
    expect(other.q("[data-ph-xp-text]")!.parentElement!.className).toContain(
      "flex-wrap",
    );
    expect(other.q("[data-ph-xp-text]")!.className).toContain("shrink-0");
  });
});
