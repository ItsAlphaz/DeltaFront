import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { APP_VERSION } from "../../../src/client/AppVersion";
import { ClientEnv } from "../../../src/client/ClientEnv";
import { Footer } from "../../../src/client/components/Footer";

const SHA = "bf739f86c4e1d2a3b5c6d7e8f90123456789abcd";

// These mount tests set no BOOTSTRAP_CONFIG, so the footer has no commit to
// show and falls back to the version. The choice itself is covered in
// tests/client/GameVersion.test.ts.
const gameVersion = `v${APP_VERSION}`;

describe("page-footer version line", () => {
  let footer: Footer;

  beforeEach(() => {
    if (!customElements.get("page-footer")) {
      customElements.define("page-footer", Footer);
    }
    ClientEnv.reset();
  });

  afterEach(() => {
    footer?.remove();
    window.openfrontDesktop = undefined;
    delete (window as { BOOTSTRAP_CONFIG?: unknown }).BOOTSTRAP_CONFIG;
    ClientEnv.reset();
  });

  async function mount(): Promise<Footer> {
    footer = document.createElement("page-footer") as Footer;
    document.body.appendChild(footer);
    await footer.updateComplete;
    return footer;
  }

  it("renders the game version on the web, with no Steam subtext", async () => {
    window.openfrontDesktop = undefined;
    await mount();

    const line = footer.querySelector(".footer-version");
    expect(line?.textContent?.trim()).toBe(gameVersion);
  });

  it("appends the shell version inside the desktop shell", async () => {
    window.openfrontDesktop = {
      version: () => Promise.resolve("0.2.0"),
    };
    await mount();

    await vi.waitFor(async () => {
      await footer.updateComplete;
      const line = footer.querySelector(".footer-version");
      expect(line?.textContent?.trim()).toBe(`${gameVersion} (Steam v0.2.0)`);
    });
  });

  // End to end through the component: with a real BOOTSTRAP_CONFIG in the
  // page the footer names the commit, never the release version (the nav bar
  // under the logo is the half that shows the version).
  it("shows the short commit rather than the version", async () => {
    (window as { BOOTSTRAP_CONFIG?: unknown }).BOOTSTRAP_CONFIG = {
      gameEnv: "prod",
      numWorkers: 1,
      turnstileSiteKey: "1x00000000000000000000AA",
      jwtAudience: "openfront.io",
      instanceId: "test",
      gitCommit: SHA,
    };
    window.openfrontDesktop = undefined;
    await mount();

    const line = footer.querySelector(".footer-version");
    expect(line?.textContent?.trim()).toBe(SHA.slice(0, 7));
  });

  // The bridge lives in a separate private repo, so the footer must degrade to
  // the game version alone rather than render a broken label.
  it("falls back to the game version when the bridge rejects", async () => {
    window.openfrontDesktop = {
      version: () => Promise.reject(new Error("boom")),
    };
    await mount();

    await vi.waitFor(async () => {
      await footer.updateComplete;
      const line = footer.querySelector(".footer-version");
      expect(line?.textContent?.trim()).toBe(gameVersion);
    });
  });
});
