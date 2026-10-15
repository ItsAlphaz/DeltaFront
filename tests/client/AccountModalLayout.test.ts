import type {
  ProgressionMe,
  UserMeResponse,
} from "@openfront/shared/ApiSchemas";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The Account page as a whole: the header card, the progression cards, the
// Linked accounts card, and the other tabs. Same boundaries as
// AccountModal.rendering.test.ts: the modal is the real one, everything it
// reaches over the network is stubbed. Every sign-in method is on, as there
// (what DeltaFront ships is pinned in AuthProviderGating.test.ts).
vi.mock("@openfront/shared/AccountFeatures", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@openfront/shared/AccountFeatures")
  >()),
  AUTH_PROVIDERS: { discord: true, google: true, email: true, steam: true },
}));

vi.mock("../../src/client/Api", () => ({
  getUserMe: vi.fn(async () => false as const),
  invalidateUserMe: vi.fn(),
  fetchPlayerById: vi.fn(async () => null),
  fetchPublicPlayerGames: vi.fn(async () => ({
    results: [],
    nextCursor: null,
  })),
  setMarketingConsent: vi.fn(async () => true),
  getApiBase: vi.fn(() => ""),
}));

vi.mock("../../src/client/Auth", () => ({
  discordLogin: vi.fn(),
  googleLogin: vi.fn(),
  linkGoogle: vi.fn(async () => true),
  linkSteam: vi.fn(async () => true),
  steamLogin: vi.fn(),
  logOut: vi.fn(async () => true),
  reauthAfterCrazyGamesChange: vi.fn(async () => false),
  sendMagicLink: vi.fn(async () => true),
  requestMagicLink: vi.fn(async () => ({ status: "sent" })),
  getAuthHeader: vi.fn(async () => "Bearer test-token"),
}));

vi.mock("../../src/client/Utils", () => ({
  translateText: vi.fn((key: string) => key),
  showToast: vi.fn(),
  getDiscordAvatarUrl: vi.fn(() => null),
  copyToClipboard: vi.fn(),
  getMapName: vi.fn((m: string) => m),
  renderDuration: vi.fn(() => ""),
}));
vi.mock("@openfront/engine-lib/Format", () => ({
  renderNumber: vi.fn((n: number) => String(n)),
}));

vi.mock("../../src/client/CrazyGamesSDK", () => ({
  crazyGamesSDK: {
    isOnCrazyGames: vi.fn(() => false),
    getUserProfile: vi.fn(async () => null),
    showAuthPrompt: vi.fn(async () => null),
    isAvailable: false,
  },
}));

vi.mock("../../src/client/Cosmetics", () => ({
  fetchCosmetics: vi.fn(async () => null),
  translateCosmetic: vi.fn((v: unknown) => v),
}));

vi.mock("../../src/client/ProgressionApi", () => ({
  fetchProgressionMe: vi.fn(async () => false),
  putDisplayTitle: vi.fn(async () => true),
}));

vi.stubGlobal("localStorage", {
  getItem: vi.fn(() => null),
  setItem: vi.fn(),
  removeItem: vi.fn(),
  clear: vi.fn(),
});

import { AccountModal } from "../../src/client/AccountModal";
import { invalidateUserMe } from "../../src/client/Api";
import { linkGoogle, linkSteam } from "../../src/client/Auth";
import {
  fetchProgressionMe,
  putDisplayTitle,
} from "../../src/client/ProgressionApi";

const PROGRESS = {
  prestige: 0,
  level: 1,
  xpInLevel: 0,
  xpForNext: 500,
  lifetimeXp: 0,
  legend: false,
  canPrestige: false,
};

const DISCORD = {
  id: "7",
  avatar: null,
  username: "i_alphaz",
  global_name: null,
  discriminator: "0",
};

function challenge(
  id: string,
  period: "daily" | "weekly",
  over: Record<string, unknown> = {},
) {
  return {
    id,
    period,
    slot: 0,
    metric: "games",
    target: 3,
    progress: 0,
    xp: 300,
    credits: 0,
    completed: false,
    ...over,
  };
}

function progression(): ProgressionMe {
  return {
    progress: PROGRESS,
    rank: "recruit",
    nextMilestone: { level: 5, credits: 250, flare: null, title: null },
    season: null,
    seasonTrack: [],
    challenges: {
      daily: {
        periodKey: "d:2026-10-14",
        resetsAt: "2099-01-01T00:00:00Z",
        items: [
          challenge("d_games_3", "daily"),
          challenge("d_win_1", "daily", { target: 1, completed: true }),
        ],
      },
      weekly: {
        periodKey: "w:2026-W42",
        resetsAt: "2099-01-05T00:00:00Z",
        items: [challenge("w_games_15", "weekly", { xp: 1500, credits: 100 })],
      },
    },
    titles: ["veteran"],
    selectedTitle: null,
    history: [],
    levelHidden: false,
  };
}

function userMe(
  user: Record<string, unknown>,
  player: Record<string, unknown> = {},
): UserMeResponse {
  return {
    user,
    player: {
      publicId: "9EKyqPa9rm",
      username: "Alphaz",
      adfree: false,
      unlimitedRanked: false,
      canCreatePublicLobbies: false,
      achievements: { singleplayerMap: [], player: [] },
      friends: [],
      subscription: null,
      currency: { soft: 998_200, hard: 0 },
      progress: PROGRESS,
      ...player,
    },
  } as unknown as UserMeResponse;
}

let openings = 1000;

describe("AccountModal — the redesigned Account page", () => {
  let modal: AccountModal;

  beforeEach(async () => {
    vi.mocked(fetchProgressionMe).mockResolvedValue(progression());
    if (!customElements.get("account-modal")) {
      customElements.define("account-modal", AccountModal);
    }
    modal = document.createElement("account-modal") as AccountModal;
    modal.setAttribute("inline", "");
    document.body.appendChild(modal);
    await modal.updateComplete;
  });

  afterEach(() => {
    document.body.removeChild(modal);
    vi.clearAllMocks();
    delete (window as { openfrontDesktop?: unknown }).openfrontDesktop;
  });

  async function show(me: UserMeResponse): Promise<void> {
    const internals = modal as unknown as {
      userMeResponse: UserMeResponse | null;
      isLoadingUser: boolean;
    };
    internals.userMeResponse = me;
    internals.isLoadingUser = false;
    modal.requestUpdate();
    await modal.updateComplete;
    await (
      modal.querySelector("account-profile-header") as {
        updateComplete: Promise<unknown>;
      } | null
    )?.updateComplete;
  }
  const settled = async () => {
    // the panel's own fetch, then the modal re-rendering with its answer
    await vi.waitFor(() =>
      expect(modal.querySelector("[data-progression-panel]")).not.toBeNull(),
    );
    await modal.updateComplete;
  };
  const q = (sel: string) => modal.querySelector(sel);
  const position = (sel: string) => {
    const el = q(sel);
    expect(el, sel).not.toBeNull();
    return el!;
  };
  const before = (a: string, b: string) =>
    expect(
      position(a).compareDocumentPosition(position(b)) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();

  it("stacks the header card, the challenges and the linked accounts, in that order", async () => {
    await show(userMe({ google: { email: "me@example.com" } }));
    await settled();
    before("[data-account-header]", "[data-progression-challenges]");
    before("[data-progression-challenges]", "[data-linked-accounts]");
    // one header, one challenges card, one linked-accounts card
    expect(modal.querySelectorAll("[data-account-header]")).toHaveLength(1);
    expect(modal.querySelectorAll("[data-linked-accounts]")).toHaveLength(1);
    // the old compact profile row and "connected as" card are gone
    expect(q("profile-card")).toBeNull();
    expect(modal.textContent).not.toContain("account_modal.connected_as");
  });

  it("shows the real progression data in the header and the challenges", async () => {
    await show(
      userMe(
        { google: { email: "me@example.com" } },
        {
          progress: {
            ...PROGRESS,
            level: 12,
            xpInLevel: 1000,
            xpForNext: 4000,
          },
        },
      ),
    );
    await settled();
    expect(q("[data-ph-level-line]")?.textContent).toContain(
      "progression.rank_",
    );
    expect(q("[data-ph-level-chip]")?.textContent?.trim()).toBe("12");
    expect(q("[data-xp-bar]")?.getAttribute("aria-valuenow")).toBe("25");
    expect(q("[data-ph-aside=credits] currency-display")).not.toBeNull();
    // the panel's three challenges, one done
    expect(modal.querySelectorAll("[data-progression-challenge]")).toHaveLength(
      3,
    );
    expect(q("[data-progression-total]")?.textContent).toBe(
      "progression.challenges_complete",
    );
    expect(q("[data-progression-credits]")).not.toBeNull();
  });

  it("gives the header the titles and the milestone once the panel has read them", async () => {
    // hold the first read back, to see the page before it has answered
    let answer!: (me: ProgressionMe) => void;
    vi.mocked(fetchProgressionMe).mockReturnValueOnce(
      new Promise<ProgressionMe>((resolve) => (answer = resolve)),
    );
    await show(userMe({ google: { email: "me@example.com" } }));
    const select = () => q("[data-ph-title-select]") as HTMLSelectElement;
    // nothing to choose from yet, and no milestone; the level is already there
    expect(select().disabled).toBe(true);
    expect(q("[data-ph-milestone]")).toBeNull();
    expect(q("[data-ph-level-line]")).not.toBeNull();
    expect(q("[data-progression-panel]")).toBeNull();

    answer(progression());
    await vi.waitFor(() => expect(select().disabled).toBe(false));
    expect([...select().options].map((o) => o.value)).toEqual(["", "veteran"]);
    expect(q("[data-ph-milestone]")).not.toBeNull();
    expect(q("[data-progression-panel]")).not.toBeNull();
  });

  describe("choosing a title", () => {
    async function open() {
      await show(userMe({ google: { email: "me@example.com" } }));
      await settled();
      await vi.waitFor(() =>
        expect(
          (q("[data-ph-title-select]") as HTMLSelectElement).disabled,
        ).toBe(false),
      );
    }
    const choose = (value: string) => {
      const select = q("[data-ph-title-select]") as HTMLSelectElement;
      select.value = value;
      select.dispatchEvent(new Event("change"));
    };

    it("saves it, then reads the progression and the account again", async () => {
      await open();
      vi.mocked(fetchProgressionMe).mockClear();
      choose("veteran");
      await vi.waitFor(() =>
        expect(putDisplayTitle).toHaveBeenCalledWith("veteran"),
      );
      await vi.waitFor(() => expect(fetchProgressionMe).toHaveBeenCalled());
      await vi.waitFor(() => expect(invalidateUserMe).toHaveBeenCalled());
    });

    it("sends No title as null", async () => {
      await open();
      choose("veteran");
      await vi.waitFor(() => expect(putDisplayTitle).toHaveBeenCalled());
      await vi.waitFor(() =>
        expect(
          (q("[data-ph-title-select]") as HTMLSelectElement).disabled,
        ).toBe(false),
      );
      choose("");
      await vi.waitFor(() =>
        expect(putDisplayTitle).toHaveBeenLastCalledWith(null),
      );
    });

    it("reads nothing again when the save is refused", async () => {
      await open();
      vi.mocked(putDisplayTitle).mockResolvedValueOnce(false);
      vi.mocked(fetchProgressionMe).mockClear();
      choose("veteran");
      await vi.waitFor(() => expect(putDisplayTitle).toHaveBeenCalled());
      await new Promise((r) => setTimeout(r, 0));
      expect(fetchProgressionMe).not.toHaveBeenCalled();
      expect(invalidateUserMe).not.toHaveBeenCalled();
    });
  });

  describe("Linked accounts", () => {
    const row = (provider: string) => q(`[data-linked-provider="${provider}"]`);
    const button = (key: string) =>
      [...modal.querySelectorAll("button")].find(
        (b) => b.textContent?.trim() === key,
      );

    it("lists a Google account with its email and a Linked mark", async () => {
      await show(userMe({ google: { email: "me@example.com" } }));
      const google = row("google")!;
      expect(google.textContent).toContain("account_modal.provider_google");
      expect(google.textContent).toContain("me@example.com");
      expect(
        google.querySelector("[data-linked-status]")?.textContent,
      ).toContain("account_modal.link_status_linked");
      expect(google.querySelector("img")).not.toBeNull();
      expect(q("[data-linked-accounts] h3")?.textContent).toContain(
        "account_modal.linked_accounts_heading",
      );
      // already linked: no second Google button
      expect(button("account_modal.link_google")).toBeUndefined();
    });

    it("offers Steam to a Google-primary account, with the permanence warning", async () => {
      await show(userMe({ google: { email: "me@example.com" } }));
      const link = button("account_modal.link_steam")!;
      expect(link).toBeTruthy();
      expect(q("[data-linked-accounts]")?.textContent).toContain(
        "account_modal.link_steam_permanent",
      );
      link.click();
      await vi.waitFor(() => expect(linkSteam).toHaveBeenCalledTimes(1));
    });

    it("lists Discord and offers Google to a Discord-only account", async () => {
      await show(userMe({ discord: DISCORD }));
      expect(row("discord")?.textContent).toContain("@i_alphaz");
      expect(row("google")).toBeNull();
      const link = button("account_modal.link_google")!;
      expect(link).toBeTruthy();
      link.click();
      await vi.waitFor(() => expect(linkGoogle).toHaveBeenCalledTimes(1));
    });

    it("lists every linked provider, and offers nothing that is linked", async () => {
      await show(
        userMe({
          discord: DISCORD,
          google: { email: "me@example.com" },
          steam: {
            steamId: "76561198000000001",
            personaName: "SnugglePuppy",
            avatarUrl: "https://cdn/x.jpg",
          },
        }),
      );
      expect(
        [...modal.querySelectorAll("[data-linked-provider]")].map((r) =>
          r.getAttribute("data-linked-provider"),
        ),
      ).toEqual(["discord", "google", "steam"]);
      expect(row("steam")?.querySelector("steam-user-header")).not.toBeNull();
      expect(modal.querySelectorAll("steam-user-header")).toHaveLength(1);
      expect(button("account_modal.link_google")).toBeUndefined();
      expect(button("account_modal.link_steam")).toBeUndefined();
    });

    it("lists an email account and offers Google", async () => {
      await show(userMe({ email: "mail@example.com" }));
      expect(row("email")?.textContent).toContain("mail@example.com");
      expect(button("account_modal.link_google")).toBeTruthy();
    });

    it("has no unlink control anywhere", async () => {
      await show(
        userMe({
          google: { email: "me@example.com" },
          steam: { steamId: "1", personaName: "S", avatarUrl: null },
        }),
      );
      const text = q("[data-linked-accounts]")?.textContent ?? "";
      expect(text.toLowerCase()).not.toContain("unlink");
    });

    it("hides the Steam button inside the desktop shell, but not a linked Steam row", async () => {
      (window as { openfrontDesktop?: unknown }).openfrontDesktop = {};
      await show(userMe({ discord: DISCORD }));
      expect(button("account_modal.link_steam")).toBeUndefined();
      // the Google button says it opens the website
      expect(button("account_modal.link_google_on_web")).toBeTruthy();
      await show(
        userMe({
          discord: DISCORD,
          steam: { steamId: "1", personaName: "S", avatarUrl: null },
        }),
      );
      expect(row("steam")).not.toBeNull();
    });
  });

  it("keeps the identity, Credits and linked accounts when progression is off", async () => {
    await show(
      userMe({ google: { email: "me@example.com" } }, { progress: undefined }),
    );
    expect(q("[data-ph-identity]")).not.toBeNull();
    expect(q("[data-ph-progression]")).toBeNull();
    expect(q("[data-ph-title-row]")).toBeNull();
    expect(q("progression-panel")).toBeNull();
    expect(q("[data-linked-accounts]")).not.toBeNull();
    expect(q("[data-ph-aside=credits] currency-display")).not.toBeNull();
    expect(fetchProgressionMe).not.toHaveBeenCalled();
  });

  describe("the Account page's entrance", () => {
    // a fresh opening of the modal, as onOpen counts them
    // (each test gets its own modal, so name the opening from a shared count)
    const reopen = () => {
      (modal as unknown as { openCount: number }).openCount = ++openings;
    };
    const sections = () => [...modal.querySelectorAll(".df-enter")];
    const page = () => q(".flex.flex-col.gap-6")!;

    it("brings the sections in one after another, once per opening", async () => {
      reopen();
      await show(userMe({ google: { email: "me@example.com" } }));
      await settled();
      expect(page().classList.contains("account-intro")).toBe(true);
      // the header first, then the challenges, then the linked accounts
      const index = (el: Element) =>
        Number((el as HTMLElement).style.getPropertyValue("--i"));
      expect(index(q("account-profile-header")!)).toBe(0);
      expect(index(q("[data-progression-challenges]")!)).toBe(1);
      expect(index(q("[data-linked-accounts]")!)).toBe(4);
      expect(sections().length).toBeGreaterThan(5);
      // the rows within a card come in after it, in order
      const rows = [...modal.querySelectorAll("[data-progression-challenge]")];
      // two daily rows, then the weekly one after the three daily slots
      expect(rows.map(index)).toEqual([2, 3, 5]);
    });

    it("not again when you come back to the Account tab", async () => {
      reopen();
      await show(userMe({ google: { email: "me@example.com" } }));
      await settled();
      expect(page().classList.contains("account-intro")).toBe(true);
      // the same opening: Stats, then back. (Rendered again, in place.)
      modal.setActiveTab("stats");
      await modal.updateComplete;
      modal.setActiveTab("account");
      await modal.updateComplete;
      await settled();
      expect(page().classList.contains("account-intro")).toBe(false);
      // sections are still there and still ordered; they just do not animate
      expect(q("[data-account-header]")).not.toBeNull();
    });

    it("plays again for the next opening", async () => {
      reopen();
      await show(userMe({ google: { email: "me@example.com" } }));
      await settled();
      reopen();
      modal.requestUpdate();
      await modal.updateComplete;
      expect(page().classList.contains("account-intro")).toBe(true);
    });

    it("never under reduced motion, or on a hidden page", async () => {
      vi.stubGlobal(
        "matchMedia",
        vi.fn((query: string) => ({ matches: query.includes("reduce") })),
      );
      reopen();
      await show(userMe({ google: { email: "me@example.com" } }));
      expect(page().classList.contains("account-intro")).toBe(false);
      vi.unstubAllGlobals();
      vi.stubGlobal("localStorage", {
        getItem: vi.fn(() => null),
        setItem: vi.fn(),
        removeItem: vi.fn(),
        clear: vi.fn(),
      });
      const hidden = vi
        .spyOn(document, "visibilityState", "get")
        .mockReturnValue("hidden");
      reopen();
      modal.requestUpdate();
      await modal.updateComplete;
      expect(page().classList.contains("account-intro")).toBe(false);
      hidden.mockRestore();
    });

    it("drops the entrance once it has landed, so nothing keeps animating", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout"] });
      try {
        reopen();
        await show(userMe({ google: { email: "me@example.com" } }));
        expect(page().classList.contains("account-intro")).toBe(true);
        vi.advanceTimersByTime(1900);
        await modal.updateComplete;
        expect(page().classList.contains("account-intro")).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("the Account, Stats and Games tabs", () => {
    const tabs = () =>
      (
        modal as unknown as {
          modalConfig(): { tabs?: { key: string }[] };
        }
      )
        .modalConfig()
        .tabs?.map((t) => t.key);

    it("offers all three, and the Account tab is the page", async () => {
      await show(userMe({ google: { email: "me@example.com" } }));
      expect(tabs()).toEqual(
        expect.arrayContaining(["account", "stats", "games"]),
      );
      expect(q("[data-account-header]")).not.toBeNull();
    });

    it("moves to Stats (the full profile card, no header) and back", async () => {
      await show(userMe({ google: { email: "me@example.com" } }));
      modal.setActiveTab("stats");
      await modal.updateComplete;
      expect(q("profile-card")).not.toBeNull();
      expect(q("[data-account-header]")).toBeNull();
      expect(q("[data-linked-accounts]")).toBeNull();
      modal.setActiveTab("account");
      await modal.updateComplete;
      expect(q("[data-account-header]")).not.toBeNull();
      expect(q("profile-card")).toBeNull();
    });

    it("moves to Games (the history list) and back", async () => {
      await show(userMe({ google: { email: "me@example.com" } }));
      modal.setActiveTab("games");
      await modal.updateComplete;
      expect(q("player-game-history-view")).not.toBeNull();
      expect(q("[data-account-header]")).toBeNull();
      modal.setActiveTab("account");
      await modal.updateComplete;
      expect(q("[data-account-header]")).not.toBeNull();
    });
  });
});
