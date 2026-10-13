import { ACCOUNT_FEATURES } from "@openfront/shared/AccountFeatures";
import type { LitElement } from "lit";
import { afterEach, describe, expect, it } from "vitest";
import { DesktopNavBar } from "../../src/client/components/DesktopNavBar";
import { MobileNavBar } from "../../src/client/components/MobileNavBar";

if (!("ResizeObserver" in globalThis)) {
  class ResizeObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  Object.defineProperty(globalThis, "ResizeObserver", {
    value: ResizeObserverStub,
  });
}

async function mount<T extends LitElement>(element: T): Promise<T> {
  document.body.appendChild(element);
  await element.updateComplete;
  return element;
}

const only = (...on: Array<keyof typeof ACCOUNT_FEATURES>) => {
  for (const key of Object.keys(ACCOUNT_FEATURES) as Array<
    keyof typeof ACCOUNT_FEATURES
  >)
    ACCOUNT_FEATURES[key] = on.includes(key);
};
const item = (nav: Element, id: string) =>
  nav.querySelector(`[data-page="${id}"]`);

afterEach(() => document.body.replaceChildren());

describe("Leaderboard navigation", () => {
  it("shows LEADERBOARD in the desktop and mobile navigation when the leaderboards feature is on, and nothing else from the account product", async () => {
    only("leaderboards");
    for (const nav of [
      await mount(new DesktopNavBar()),
      await mount(new MobileNavBar()),
    ]) {
      expect(item(nav, "page-leaderboard")).not.toBeNull();
      for (const hidden of ["page-item-store", "page-inventory", "page-clan"])
        expect(item(nav, hidden), hidden).toBeNull();
    }
  });

  it("hides LEADERBOARD in both when the feature is off (what ships)", async () => {
    only();
    for (const nav of [
      await mount(new DesktopNavBar()),
      await mount(new MobileNavBar()),
    ])
      expect(item(nav, "page-leaderboard")).toBeNull();
  });

  it("does not depend on ranked, clans or sign-in being on", async () => {
    only("leaderboards", "accounts");
    const nav = await mount(new DesktopNavBar());
    expect(item(nav, "page-leaderboard")).not.toBeNull();
    expect(ACCOUNT_FEATURES.ranked).toBe(false);
  });
});
