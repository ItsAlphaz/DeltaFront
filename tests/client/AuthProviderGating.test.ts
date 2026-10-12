import type { UserMeResponse } from "@openfront/shared/ApiSchemas";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// What the sign-in screens offer follows AUTH_PROVIDERS (the shipped value is
// Discord and Google only, decision D3). The real constant is frozen, so these
// tests swap in a mutable one to prove the gating is the only reason Steam and
// email are hidden, and that turning them on again needs no other change.
const { providers } = vi.hoisted(() => ({
  providers: { discord: true, google: true, email: false, steam: false },
}));
vi.mock("@openfront/shared/AccountFeatures", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@openfront/shared/AccountFeatures")
  >()),
  AUTH_PROVIDERS: providers,
}));

vi.mock("../../src/client/Api", () => ({
  getUserMe: vi.fn(async () => false as const),
  invalidateUserMe: vi.fn(),
  fetchPlayerById: vi.fn(async () => null),
  setMarketingConsent: vi.fn(async () => true),
  deleteAccount: vi.fn(async () => ({ ok: true })),
  getIdentityTokenAudiences: vi.fn(async () => []),
  getApiBase: vi.fn(() => ""),
}));
vi.mock("../../src/client/Auth", () => ({
  discordLogin: vi.fn(),
  googleLogin: vi.fn(),
  linkGoogle: vi.fn(async () => true),
  linkSteam: vi.fn(async () => true),
  steamLogin: vi.fn(),
  logOut: vi.fn(async () => true),
  clearLocalSession: vi.fn(),
  reauthAfterCrazyGamesChange: vi.fn(async () => false),
  sendMagicLink: vi.fn(async () => true),
  getAuthHeader: vi.fn(async () => "Bearer t"),
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

import { ACCOUNT_FEATURES } from "@openfront/shared/AccountFeatures";
import { AccountModal } from "../../src/client/AccountModal";
import "../../src/client/components/AccountSettingsPanel";
import type { AccountSettingsPanel } from "../../src/client/components/AccountSettingsPanel";

function userMe(user: UserMeResponse["user"]): UserMeResponse {
  return {
    user,
    player: {
      publicId: "p",
      adfree: false,
      unlimitedRanked: false,
      canCreatePublicLobbies: false,
      achievements: { singleplayerMap: [], player: [] },
      friends: [],
      subscription: null,
    },
  };
}

const discordUser = {
  discord: {
    id: "1",
    avatar: null,
    username: "p",
    global_name: null,
    discriminator: "0",
  },
};

beforeEach(() => {
  Object.assign(providers, {
    discord: true,
    google: true,
    email: false,
    steam: false,
  });
});

describe("the sign-in screen follows AUTH_PROVIDERS", () => {
  let modal: AccountModal;

  beforeEach(async () => {
    if (!customElements.get("account-modal"))
      customElements.define("account-modal", AccountModal);
    modal = document.createElement("account-modal") as AccountModal;
    modal.setAttribute("inline", "");
    document.body.appendChild(modal);
    await modal.updateComplete;
  });
  afterEach(() => {
    modal.remove();
    vi.clearAllMocks();
  });

  async function showSignIn(): Promise<string> {
    const m = modal as unknown as {
      userMeResponse: UserMeResponse | false;
      isLoadingUser: boolean;
    };
    m.userMeResponse = false;
    m.isLoadingUser = false;
    modal.requestUpdate();
    await modal.updateComplete;
    return modal.textContent ?? "";
  }

  it("as shipped: Discord and Google only. No Steam button, no email field, no 'or' divider", async () => {
    const text = await showSignIn();
    expect(text).toContain("main.login_discord");
    expect(text).toContain("main.login_google");
    expect(text).not.toContain("main.login_steam");
    expect(text).not.toContain("account_modal.get_magic_link");
    expect(text).not.toContain("account_modal.or");
    expect(modal.querySelector('input[type="email"]')).toBeNull();
  });

  it("each provider appears only when enabled", async () => {
    providers.discord = false;
    let text = await showSignIn();
    expect(text).not.toContain("main.login_discord");
    expect(text).toContain("main.login_google");

    Object.assign(providers, { discord: true, google: false });
    text = await showSignIn();
    expect(text).toContain("main.login_discord");
    expect(text).not.toContain("main.login_google");
  });

  it("turning email and Steam on brings back the magic-link field, its divider and the Steam button (the client code is intact)", async () => {
    Object.assign(providers, { email: true, steam: true });
    const text = await showSignIn();
    expect(text).toContain("main.login_steam");
    expect(text).toContain("account_modal.get_magic_link");
    expect(text).toContain("account_modal.or");
    expect(modal.querySelector('input[type="email"]')).not.toBeNull();
  });
});

describe("a signed-in account offers only the linking methods that exist", () => {
  let modal: AccountModal;
  beforeEach(async () => {
    if (!customElements.get("account-modal"))
      customElements.define("account-modal", AccountModal);
    modal = document.createElement("account-modal") as AccountModal;
    modal.setAttribute("inline", "");
    document.body.appendChild(modal);
    await modal.updateComplete;
    const m = modal as unknown as {
      userMeResponse: UserMeResponse;
      isLoadingUser: boolean;
    };
    m.userMeResponse = userMe(discordUser);
    m.isLoadingUser = false;
  });
  afterEach(() => modal.remove());

  const text = async () => {
    modal.requestUpdate();
    await modal.updateComplete;
    return modal.textContent ?? "";
  };

  it("as shipped: Google can be linked, Steam cannot (there is no Steam sign-in)", async () => {
    const t = await text();
    expect(t).toContain("account_modal.link_google");
    expect(t).not.toContain("account_modal.link_steam");
  });

  it("with Steam on, the Steam link returns", async () => {
    providers.steam = true;
    expect(await text()).toContain("account_modal.link_steam");
  });
});

describe("the account modal's friends tab follows the friends feature", () => {
  let modal: AccountModal;
  beforeEach(async () => {
    if (!customElements.get("account-modal"))
      customElements.define("account-modal", AccountModal);
    modal = document.createElement("account-modal") as AccountModal;
    modal.setAttribute("inline", "");
    document.body.appendChild(modal);
    await modal.updateComplete;
    const m = modal as unknown as {
      userMeResponse: UserMeResponse;
      isLoadingUser: boolean;
    };
    m.userMeResponse = userMe(discordUser);
    m.isLoadingUser = false;
  });
  afterEach(() => modal.remove());

  const tabs = () =>
    (
      (
        modal as unknown as { modalConfig(): { tabs?: Array<{ key: string }> } }
      ).modalConfig().tabs ?? []
    ).map((t) => t.key);

  it("has no friends tab while the feature is off", () => {
    ACCOUNT_FEATURES.friends = false;
    expect(tabs()).toEqual(["account", "stats", "games"]);
  });

  it("has it when the feature is on", () => {
    ACCOUNT_FEATURES.friends = true;
    expect(tabs()).toContain("friends");
  });
});

describe("account settings offer only the sign-in methods this deployment has", () => {
  let panel: AccountSettingsPanel;
  beforeEach(async () => {
    panel = document.createElement(
      "account-settings-panel",
    ) as AccountSettingsPanel;
    // An account with no email yet, so the "attach one" controls would show.
    panel.user = {};
    panel.player = {
      ...userMe({}).player,
      marketingConsent: { consented: "no_response", hasEmail: false },
    };
    document.body.appendChild(panel);
    await panel.updateComplete;
  });
  afterEach(() => panel.remove());

  async function render(): Promise<void> {
    panel.requestUpdate();
    await panel.updateComplete;
  }

  it("as shipped: Google can be linked; there is no magic-link field", async () => {
    await render();
    expect(panel.textContent).toContain("account_modal.link_google");
    expect(panel.querySelector('input[type="email"]')).toBeNull();
    expect(panel.textContent).not.toContain("account_modal.get_magic_link");
    expect(panel.textContent).not.toContain("account_modal.or");
  });

  it("with email on, the field returns, with the divider between the two ways", async () => {
    providers.email = true;
    await render();
    expect(panel.querySelector('input[type="email"]')).not.toBeNull();
    expect(panel.textContent).toContain("account_modal.or");
    expect(panel.textContent).toContain("account_modal.link_google");
  });

  it("offers nothing when neither method is available", async () => {
    Object.assign(providers, { email: false, google: false });
    await render();
    expect(panel.querySelector('input[type="email"]')).toBeNull();
    expect(panel.textContent).not.toContain("account_modal.link_google");
  });

  it("does not offer Google to an account that already has it", async () => {
    panel.user = { google: { email: "a@b.co" } };
    await render();
    expect(panel.textContent).not.toContain("account_modal.link_google");
  });
});
