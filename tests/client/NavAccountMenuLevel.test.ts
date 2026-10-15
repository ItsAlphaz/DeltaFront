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
import { NavAccountMenu } from "../../src/client/components/NavAccountMenu";

const progress: Progress = {
  prestige: 1,
  level: 23,
  xpInLevel: 250,
  xpForNext: 1000,
  lifetimeXp: 50_000,
  legend: false,
  canPrestige: false,
};

function userMe(opts: {
  progress?: Progress;
  signedIn?: boolean;
}): UserMeResponse {
  return {
    user: opts.signedIn === false ? {} : { email: "player@example.com" },
    player: {
      publicId: "p",
      ...(opts.progress ? { progress: opts.progress } : {}),
    },
  } as unknown as UserMeResponse;
}

describe("nav-account-menu level", () => {
  let el: NavAccountMenu;

  beforeEach(() => {
    if (!customElements.get("nav-account-menu")) {
      customElements.define("nav-account-menu", NavAccountMenu);
    }
  });

  afterEach(() => {
    el?.remove();
  });

  async function mount(
    variant: "desktop" | "mobile",
    response: UserMeResponse | false,
  ): Promise<void> {
    el?.remove();
    el = document.createElement("nav-account-menu") as NavAccountMenu;
    el.variant = variant;
    document.body.appendChild(el);
    document.dispatchEvent(
      new CustomEvent("userMeResponse", { detail: response }),
    );
    await el.updateComplete;
  }

  for (const variant of ["desktop", "mobile"] as const) {
    it(`shows the level badge, the prestige emblem and the XP ring on the ${variant} trigger`, async () => {
      await mount(variant, userMe({ progress }));
      const level = el.querySelector("[data-account-level]");
      expect(level).not.toBeNull();
      expect(
        level!.querySelector("[data-account-level-text]")?.textContent,
      ).toBe('progression.level_short:{"level":23}');
      const emblem = level!.querySelector("level-badge") as HTMLElement & {
        level: number;
        prestige: number;
        emblem: boolean;
      };
      expect(emblem.level).toBe(23);
      expect(emblem.prestige).toBe(1);
      expect(emblem.emblem).toBe(true);
      // the ring fills to the level's progress (250 of 1,000)
      const fill = el.querySelector("[data-xp-ring-fill]");
      expect(fill?.getAttribute("style")).toContain("stroke-dasharray: 25 100");
      expect(el.querySelector("[data-account-xp-bar]")).toBeNull();
    });
  }

  for (const variant of ["desktop", "mobile"] as const) {
    it(`names the level in the ${variant} trigger's accessible name`, async () => {
      // The trigger's aria-label is its whole accessible name, so the badge
      // inside it is only heard if the label says the level.
      await mount(variant, userMe({ progress }));
      const trigger = el.querySelector("[data-account-trigger]")!;
      expect(trigger.getAttribute("aria-label")).toBe(
        `nav_account_menu.account_with_level:${JSON.stringify({
          level:
            'progression.level:{"level":23}, progression.prestige:{"prestige":1}',
        })}`,
      );
      await mount(variant, userMe({}));
      expect(
        el.querySelector("[data-account-trigger]")!.getAttribute("aria-label"),
      ).toBe("main.account");
    });
  }

  it("hides everything when /users/@me has no progress", async () => {
    await mount("desktop", userMe({}));
    expect(el.querySelector("[data-account-level]")).toBeNull();
    expect(el.querySelector("[data-xp-ring]")).toBeNull();
  });

  it("hides the level for a signed-out session", async () => {
    await mount("desktop", userMe({ progress, signedIn: false }));
    expect(el.querySelector("[data-account-level]")).toBeNull();
    await mount("desktop", false);
    expect(el.querySelector("[data-account-level]")).toBeNull();
  });

  for (const variant of ["desktop", "mobile"] as const) {
    it(`flags something waiting on the ${variant} trigger: rewards to claim, or a prestige`, async () => {
      await mount(variant, userMe({ progress }));
      expect(el.querySelector("[data-account-attention]")).toBeNull();

      const withRewards = userMe({ progress });
      withRewards.player.rewards = [
        {
          id: "1",
          currencyType: "soft",
          amount: "250",
          reason: "level_milestone",
          note: null,
        },
      ];
      await mount(variant, withRewards);
      expect(
        el.querySelector("[data-account-attention]")?.getAttribute("title"),
      ).toBe("nav_account_menu.rewards_waiting");

      await mount(
        variant,
        userMe({ progress: { ...progress, level: 100, canPrestige: true } }),
      );
      expect(
        el.querySelector("[data-account-attention]")?.getAttribute("title"),
      ).toBe("nav_account_menu.prestige_ready");
    });
  }
});
