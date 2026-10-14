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

const BADGE = 'svg[aria-label="username.verified_player"]';

function userMe(
  player: Partial<{
    username: string | null;
    usernameBase: string | null;
    usernameStatus: string;
    verified: boolean;
    staffRole: "owner" | "admin" | "mod";
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
  });

  afterEach(() => {
    document.body.removeChild(modal);
    vi.clearAllMocks();
    window.location.hash = "";
  });

  async function show(user: UserMeResponse): Promise<void> {
    const internals = modal as unknown as {
      userMeResponse: UserMeResponse | null;
      isLoadingUser: boolean;
    };
    internals.userMeResponse = user;
    internals.isLoadingUser = false;
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
    await show(
      userMe({ username: "Boss.0001", verified: false, staffRole: "admin" }),
    );

    expect(modal.querySelector("#account-staff-chip")?.textContent).toContain(
      "staff.admin",
    );
    expect(modal.querySelector("#account-verified-chip")).toBeNull();
    expect(status()?.querySelector(BADGE)).toBeNull();
  });

  it("keeps verified, admin and the linked identity as three separate things", async () => {
    await show(
      userMe({ username: "Aydin.4821", verified: true, staffRole: "admin" }),
    );

    expect(modal.querySelector("#account-verified-chip")).not.toBeNull();
    expect(modal.querySelector("#account-staff-chip")).not.toBeNull();
    // The sign-in identity is rendered outside the status block: under the
    // name in the header, and as a row of the Linked accounts card.
    expect(status()?.textContent).not.toContain("owner@example.com");
    expect(
      modal.querySelector("[data-account-handle]")?.textContent?.trim(),
    ).toBe("owner@example.com");
    expect(
      modal.querySelector('[data-linked-provider="google"]')?.textContent,
    ).toContain("owner@example.com");
  });

  it("each staff role gets its own chip and badge, never another role's", async () => {
    for (const role of ["owner", "admin", "mod"] as const) {
      await show(userMe({ username: "Staff.0002", staffRole: role }));
      const chip = modal.querySelector("#account-staff-chip");
      expect(chip?.getAttribute("data-staff-role")).toBe(role);
      expect(chip?.textContent).toContain(`staff.${role}`);
      // the badge beside the name and the one inside the chip
      expect(status()?.querySelectorAll("svg[data-staff-role]")).toHaveLength(
        2,
      );
      expect(
        [...(status()?.querySelectorAll("svg[data-staff-role]") ?? [])].every(
          (el) => el.getAttribute("data-staff-role") === role,
        ),
      ).toBe(true);
    }
  });

  it("a staff badge shows without verification, and verification shows without a staff role", async () => {
    await show(
      userMe({ username: "A.0001", staffRole: "owner", verified: false }),
    );
    expect(modal.querySelector("#account-verified-chip")).toBeNull();
    expect(modal.querySelector("#account-staff-chip")).not.toBeNull();
    await show(userMe({ username: "B.0001", verified: true }));
    expect(modal.querySelector("#account-staff-chip")).toBeNull();
    expect(modal.querySelector("#account-verified-chip")).not.toBeNull();
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
