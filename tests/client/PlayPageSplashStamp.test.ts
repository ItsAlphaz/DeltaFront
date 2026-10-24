import { afterEach, describe, expect, it, vi } from "vitest";

const { isOnCrazyGames } = vi.hoisted(() => ({
  isOnCrazyGames: vi.fn(() => false),
}));
vi.mock("../../src/client/CrazyGamesSDK", () => ({
  crazyGamesSDK: {
    isOnCrazyGames,
    getUsername: vi.fn(async () => null),
    getUserProfile: vi.fn(async () => null),
    showAuthPrompt: vi.fn(async () => null),
    addAuthListener: vi.fn(),
  },
}));
vi.mock("@openfront/shared/AssetUrls", () => ({
  assetUrl: (path: string) => path,
}));

// Rendering play-page mounts its children too (steam-wishlist, cosmetic
// background, …), and some reach for browser APIs jsdom doesn't ship.
vi.stubGlobal(
  "ResizeObserver",
  class {
    observe() {}
    unobserve() {}
    disconnect() {}
  },
);

import { BRAND } from "../../src/client/Branding";
import { PlayPage } from "../../src/client/components/PlayPage";

describe("the splash stamp on the play page", () => {
  let el: PlayPage;

  async function mount() {
    if (!customElements.get("play-page")) {
      customElements.define("play-page", PlayPage);
    }
    el = document.createElement("play-page") as PlayPage;
    document.body.appendChild(el);
    await el.updateComplete;
  }

  afterEach(() => {
    el?.remove();
    vi.restoreAllMocks();
  });

  it("is off by default, so the page has no stamp", async () => {
    expect(BRAND.splashStampEnabled).toBe(false);
    await mount();
    expect(el.querySelector("splash-stamp")).toBeNull();
  });

  it("comes back when the switch in Branding is turned on", async () => {
    const original = BRAND.splashStampEnabled;
    (BRAND as { splashStampEnabled: boolean }).splashStampEnabled = true;
    try {
      await mount();
      expect(el.querySelector("splash-stamp")).not.toBeNull();
    } finally {
      (BRAND as { splashStampEnabled: boolean }).splashStampEnabled = original;
    }
  });
});
