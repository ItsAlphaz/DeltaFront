import {
  ACCOUNT_FEATURES,
  usesAccountApi,
} from "@openfront/shared/AccountFeatures";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import newsFallback from "../resources/news.json";
import { getNews, getStreams } from "../src/client/Api";
import { userAuth } from "../src/client/Auth";
import { BRAND } from "../src/client/Branding";
import { ClientEnv } from "../src/client/ClientEnv";
import "../src/client/components/DesktopNavBar";
import "../src/client/components/MobileNavBar";
import "../src/client/components/PlayPage";
import { fetchCosmetics } from "../src/client/Cosmetics";
import { archive } from "../src/server/Archive";
import { fetchCustomTribes } from "../src/server/CustomTribes";

// DeltaFront ships with no account backend. These pin what that means: the
// features that need one are off, the UI that leads to them is gone, and none
// of it reaches for a service that is not there. tests/setup.ts turns every
// flag ON before each test (the inherited suite tests the full product), so
// each block here switches them off itself.

type Mountable = HTMLElement & { updateComplete: Promise<unknown> };

const ALL_OFF = {
  accounts: false,
  store: false,
  inventory: false,
  ranked: false,
  clans: false,
  leaderboards: false,
  payments: false,
  friends: false,
  progression: false,
  tribes: false,
  trustedLobbies: false,
};

function featuresOff(): void {
  Object.assign(ACCOUNT_FEATURES, ALL_OFF);
}

async function mount(tag: string): Promise<Mountable> {
  const el = document.createElement(tag) as Mountable;
  document.body.appendChild(el);
  await el.updateComplete;
  return el;
}

const page = (root: ParentNode, id: string) =>
  root.querySelector(`[data-page="${id}"]`);

globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

describe("what DeltaFront ships with", () => {
  it("has every account-backend feature off", () => {
    // Captured by tests/setup.ts before it turns the flags on for the suite.
    const shipped = (globalThis as Record<string, unknown>)
      .__SHIPPED_ACCOUNT_FEATURES__;
    expect(shipped).toEqual(ALL_OFF);
  });

  it("has no ad provider and no Steam app configured", () => {
    expect(BRAND.adsEnabled).toBe(false);
    expect(BRAND.steamAppId).toBeNull();
  });

  it("usesAccountApi is true as soon as any one feature is on", () => {
    expect(usesAccountApi(ALL_OFF)).toBe(false);
    for (const key of Object.keys(ALL_OFF)) {
      expect(usesAccountApi({ ...ALL_OFF, [key]: true })).toBe(true);
    }
  });
});

describe("navigation without an account backend", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    window.currentPageId = "page-play";
    featuresOff();
  });

  it("desktop nav keeps Play and the utility icons, drops the rest", async () => {
    const nav = await mount("desktop-nav-bar");
    expect(page(nav, "page-play")).not.toBeNull();
    for (const hidden of [
      "page-item-store",
      "page-inventory",
      "page-leaderboard",
      "page-clan",
    ]) {
      expect(page(nav, hidden), hidden).toBeNull();
    }
    expect(nav.querySelector("nav-account-menu")).toBeNull();
    // Settings, help and news live in <nav-utility-icons>, which needs no backend.
    expect(nav.querySelector("nav-utility-icons")).not.toBeNull();
  });

  it("mobile drawer drops the same items", async () => {
    const nav = await mount("mobile-nav-bar");
    expect(page(nav, "page-play")).not.toBeNull();
    for (const hidden of [
      "page-item-store",
      "page-inventory",
      "page-leaderboard",
      "page-clan",
    ]) {
      expect(page(nav, hidden), hidden).toBeNull();
    }
  });

  it("mobile top bar has no sign-in control", async () => {
    const play = await mount("play-page");
    expect(play.querySelector("nav-account-menu")).toBeNull();
  });

  it("brings each item back with its own feature", async () => {
    const cases: Array<[keyof typeof ALL_OFF, string[]]> = [
      ["store", ["page-item-store"]],
      ["inventory", ["page-inventory"]],
      ["leaderboards", ["page-leaderboard"]],
      ["clans", ["page-clan"]],
    ];
    for (const [feature, pages] of cases) {
      featuresOff();
      ACCOUNT_FEATURES[feature] = true;
      document.body.innerHTML = "";
      const nav = await mount("desktop-nav-bar");
      for (const id of pages) expect(page(nav, id), id).not.toBeNull();
    }
    featuresOff();
    ACCOUNT_FEATURES.accounts = true;
    document.body.innerHTML = "";
    const nav = await mount("desktop-nav-bar");
    expect(nav.querySelector("nav-account-menu")).not.toBeNull();
  });
});

describe("client requests without an account backend", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    featuresOff();
    fetchMock = vi.fn(async () => {
      throw new Error("unexpected network request");
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("news is the bundled file, with no request", async () => {
    expect(await getNews()).toEqual(newsFallback);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("the streams feed is the bundled empty feed, with no request", async () => {
    const feed = await getStreams();
    expect(feed.featured).toEqual([]);
    expect(feed.live).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("there is no cosmetics catalog, and none is requested", async () => {
    expect(await fetchCosmetics()).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("nobody is signed in, and no session refresh is attempted", async () => {
    expect(await userAuth()).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("news is requested from the backend again once any feature is on", async () => {
    // getApiBase() needs an audience before it can build the URL.
    (window as unknown as { BOOTSTRAP_CONFIG: unknown }).BOOTSTRAP_CONFIG = {
      gameEnv: "prod",
      turnstileSiteKey: "x",
      jwtAudience: "deltafront.example",
      gitCommit: "abc",
    };
    ClientEnv.reset();
    ACCOUNT_FEATURES.store = true;
    await getNews();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe(
      "https://api.deltafront.example/news.json",
    );
    delete (window as unknown as { BOOTSTRAP_CONFIG?: unknown })
      .BOOTSTRAP_CONFIG;
    ClientEnv.reset();
  });
});

describe("server without an account backend", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("starts games with no purchased tribe names, and asks nobody", async () => {
    featuresOff();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    expect(
      await fetchCustomTribes([{ clientId: "c1", publicId: "p1" }]),
    ).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not try to archive finished games", async () => {
    featuresOff();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    // Never reaches validation: the guard comes first, so any record will do.
    await archive({} as never);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
