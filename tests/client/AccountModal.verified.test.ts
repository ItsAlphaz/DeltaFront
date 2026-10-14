import type { UserMeResponse } from "@openfront/shared/ApiSchemas";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Same boundaries as AccountModal.rendering.test.ts: the modal under test is
// the real one, everything it reaches over the network is stubbed.
vi.mock("../../src/client/Api", () => ({
  getUserMe: vi.fn(async () => false as const),
  invalidateUserMe: vi.fn(),
  fetchPlayerById: vi.fn(async () => null),
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
  userAuth: vi.fn(async () => false as const),
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

vi.stubGlobal("localStorage", {
  getItem: vi.fn(() => null),
  setItem: vi.fn(),
  removeItem: vi.fn(),
  clear: vi.fn(),
});

import { AccountModal } from "../../src/client/AccountModal";
import { userAuth } from "../../src/client/Auth";

const BADGE = 'svg[aria-label="username.verified_player"]';

function userMe(
  player: Partial<{
    username: string | null;
    usernameBase: string | null;
    usernameStatus: string;
    verified: boolean;
  }> = {},
): UserMeResponse {
  return {
    // A linked Google identity, shown in its own block under the status.
    user: { google: { email: "owner@example.com" } },
    player: {
      publicId: "9EKyqPa9rm",
      adfree: false,
      unlimitedRanked: false,
      canCreatePublicLobbies: false,
      achievements: { singleplayerMap: [], player: [] },
      friends: [],
      subscription: null,
      currency: { soft: 0, hard: 0 },
      usernameStatus: "unclaimed",
      ...player,
    },
  } as unknown as UserMeResponse;
}

describe("AccountModal — verified account status", () => {
  let modal: AccountModal;

  beforeEach(async () => {
    if (!customElements.get("account-modal")) {
      customElements.define("account-modal", AccountModal);
    }
    modal = document.createElement("account-modal") as AccountModal;
    modal.setAttribute("inline", "");
    document.body.appendChild(modal);
    await modal.updateComplete;
    vi.mocked(userAuth).mockResolvedValue(false);
  });

  afterEach(() => {
    document.body.removeChild(modal);
    vi.clearAllMocks();
    window.location.hash = "";
  });

  async function show(user: UserMeResponse, role?: string): Promise<void> {
    vi.mocked(userAuth).mockResolvedValue(
      role === undefined
        ? false
        : ({ jwt: "t", claims: { role } } as unknown as Awaited<
            ReturnType<typeof userAuth>
          >),
    );
    const internals = modal as unknown as {
      userMeResponse: UserMeResponse | null;
      isLoadingUser: boolean;
      loadRole(): Promise<void>;
    };
    internals.userMeResponse = user;
    internals.isLoadingUser = false;
    await internals.loadRole();
    modal.requestUpdate();
    await modal.updateComplete;
  }

  const status = () => modal.querySelector("#account-status");

  it("shows the check beside the username and a Verified label when player.verified is true", async () => {
    await show(userMe({ username: "Aydin.4821", verified: true }));

    const username = modal.querySelector("#account-username");
    expect(username?.textContent).toBe("Aydin.4821");
    // The check sits in the same row as the name.
    expect(username?.parentElement?.querySelector(BADGE)).not.toBeNull();
    expect(
      modal.querySelector("#account-verified-chip")?.textContent,
    ).toContain("account_modal.verified_label");
  });

  it("shows neither when player.verified is false or absent", async () => {
    for (const verified of [false, undefined]) {
      await show(userMe({ username: "Aydin.4821", verified }));
      expect(modal.querySelector("#account-username")?.textContent).toBe(
        "Aydin.4821",
      );
      expect(status()?.querySelector(BADGE)).toBeNull();
      expect(modal.querySelector("#account-verified-chip")).toBeNull();
    }
  });

  it("does not infer it from a dotless name or a premium status", async () => {
    await show(
      userMe({
        username: "RyanTheGreat",
        usernameBase: "RyanTheGreat",
        usernameStatus: "premium",
      }),
    );
    expect(modal.querySelector(BADGE)).toBeNull();
    expect(modal.querySelector("#account-verified-chip")).toBeNull();
  });

  it("an admin role alone is not verified: the Admin chip shows, the check does not", async () => {
    await show(userMe({ username: "Boss.0001", verified: false }), "admin");

    expect(modal.querySelector("#account-admin-chip")?.textContent).toContain(
      "account_modal.role_admin",
    );
    expect(modal.querySelector("#account-verified-chip")).toBeNull();
    expect(status()?.querySelector(BADGE)).toBeNull();
  });

  it("keeps verified, admin and the linked identity as three separate things", async () => {
    await show(userMe({ username: "Aydin.4821", verified: true }), "admin");

    expect(modal.querySelector("#account-verified-chip")).not.toBeNull();
    expect(modal.querySelector("#account-admin-chip")).not.toBeNull();
    // The sign-in identity is rendered outside the status block.
    expect(status()?.textContent).not.toContain("owner@example.com");
    expect(modal.textContent).toContain("account_modal.linked_account");
  });

  it("a non-admin role is not shown as Admin", async () => {
    await show(userMe({ username: "Mod.0002", verified: true }), "mod");
    expect(modal.querySelector("#account-admin-chip")).toBeNull();
  });

  it("a verified account with no username is told to set one, never offered a subscription", async () => {
    await show(userMe({ username: null, usernameBase: null, verified: true }));

    expect(modal.querySelector(BADGE)).not.toBeNull();
    const guidance = modal.querySelector("#account-verified-needs-username");
    expect(guidance?.textContent).toContain(
      "account_modal.verified_needs_username",
    );
    expect(modal.textContent).not.toMatch(/subscri|premium|store/i);

    guidance?.querySelector("button")?.click();
    expect(window.location.hash).toBe("#modal=change-username");
  });

  it("an ordinary unverified account with no username gets no status block", async () => {
    await show(userMe({ username: null, usernameBase: null }));
    expect(status()).toBeNull();
  });
});
