import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { APP_VERSION } from "../../src/client/AppVersion";
import { ClientEnv } from "../../src/client/ClientEnv";
import {
  composeBuildLabel,
  currentBuildLabel,
  renderNavVersion,
  taggedGameVersion,
} from "../../src/client/GameVersion";

const SHA = "bf739f86c4e1d2a3b5c6d7e8f90123456789abcd";

// The footer names the BUILD (the commit), the nav bar names the RELEASE (the
// version from package.json). They are separate pieces of information.
describe("composeBuildLabel", () => {
  it("shows the 7-char commit", () => {
    expect(composeBuildLabel("0.1.0", SHA)).toBe("bf739f8");
  });

  it("lowercases an upper-cased commit", () => {
    expect(composeBuildLabel("0.1.0", SHA.toUpperCase())).toBe("bf739f8");
  });

  it("accepts a commit already abbreviated by the deploy pipeline", () => {
    expect(composeBuildLabel("0.1.0", "bf739f86c4e1")).toBe("bf739f8");
  });

  // "DEV" is what the local dev server injects, and "desktop" is what an
  // Electron shell predating OPE-358 injects. Neither is a sha.
  it.each(["DEV", "desktop"])("passes through a non-sha commit (%s)", (c) => {
    expect(composeBuildLabel("0.1.0", c)).toBe(c);
  });

  it("never shows the version while a commit is known", () => {
    expect(composeBuildLabel("0.1.0", SHA)).not.toContain("0.1.0");
  });

  // Unreachable in a live client, but the label must never come back blank.
  it("falls back to the tagged version when there is no commit at all", () => {
    expect(composeBuildLabel("0.1.0", "")).toBe("v0.1.0");
  });
});

describe("currentBuildLabel", () => {
  beforeEach(() => {
    ClientEnv.reset();
  });

  afterEach(() => {
    delete (window as { BOOTSTRAP_CONFIG?: unknown }).BOOTSTRAP_CONFIG;
    ClientEnv.reset();
  });

  it("reads the commit out of BOOTSTRAP_CONFIG", () => {
    (window as { BOOTSTRAP_CONFIG?: unknown }).BOOTSTRAP_CONFIG = {
      gameEnv: "prod",
      numWorkers: 1,
      turnstileSiteKey: "1x00000000000000000000AA",
      jwtAudience: "openfront.io",
      instanceId: "test",
      gitCommit: SHA,
    };

    expect(currentBuildLabel()).toBe("bf739f8");
  });

  // A cosmetic label must never be what takes the page down: ClientEnv.get()
  // throws outright when BOOTSTRAP_CONFIG is absent.
  it("does not throw when BOOTSTRAP_CONFIG is absent", () => {
    expect(() => currentBuildLabel()).not.toThrow();
    expect(currentBuildLabel()).toBe(taggedGameVersion(APP_VERSION));
  });
});

// The nav bar under the logo shows the version and never a commit (OPE-387):
// a sha under the logo reads as a broken label on the main menu.
describe("taggedGameVersion", () => {
  it("shows the version when the build was tagged", () => {
    expect(taggedGameVersion("v0.33.18")).toBe("v0.33.18");
  });

  it("adds the v when the tag was written without one", () => {
    expect(taggedGameVersion("0.33.18")).toBe("v0.33.18");
  });

  it("tolerates surrounding whitespace", () => {
    expect(taggedGameVersion("  v0.33.18\n")).toBe("v0.33.18");
  });
});

describe("renderNavVersion", () => {
  beforeEach(() => {
    ClientEnv.reset();
    document.body.innerHTML = "";
  });

  afterEach(() => {
    delete (window as { BOOTSTRAP_CONFIG?: unknown }).BOOTSTRAP_CONFIG;
    ClientEnv.reset();
    document.body.innerHTML = "";
  });

  const setBootstrap = () => {
    (window as { BOOTSTRAP_CONFIG?: unknown }).BOOTSTRAP_CONFIG = {
      gameEnv: "prod",
      numWorkers: 1,
      turnstileSiteKey: "1x00000000000000000000AA",
      jwtAudience: "openfront.io",
      instanceId: "test",
      gitCommit: SHA,
    };
  };

  // The regression this pins: with a real commit sitting in BOOTSTRAP_CONFIG
  // the nav bar still shows the version. Swapping the helper for
  // currentBuildLabel turns this red.
  it("stamps the version, not the commit, onto both nav bars", () => {
    setBootstrap();
    document.body.innerHTML = `
      <span id="game-version"></span>
      <span class="game-version-display"></span>
    `;

    expect(renderNavVersion()).toBe(2);
    for (const el of document.querySelectorAll(
      "#game-version, .game-version-display",
    )) {
      expect(el.textContent).toBe(`v${APP_VERSION}`);
      expect(el.textContent).toMatch(/^v\d+\.\d+\.\d+$/);
    }
  });

  it("reports zero when the markup carries no version element", () => {
    setBootstrap();
    document.body.innerHTML = '<span id="something-else"></span>';

    expect(renderNavVersion()).toBe(0);
  });
});
