import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ClientEnv } from "../../src/client/ClientEnv";

vi.mock("../../src/client/LobbySocket", () => ({
  PublicLobbySocket: class {
    start(): void {}
    stop(): void {}
  },
}));

// Registers <game-mode-selector> as a side effect.
import "../../src/client/GameModeSelector";

beforeEach(() => {
  window.BOOTSTRAP_CONFIG = {
    gameEnv: "dev",
    numWorkers: 1,
    turnstileSiteKey: "",
    jwtAudience: "test",
    instanceId: "test",
    gitCommit: "test",
  };
  ClientEnv.reset();
});

afterEach(() => {
  document.body.innerHTML = "";
  document.getElementById("solo-button-styles")?.remove();
  window.BOOTSTRAP_CONFIG = undefined;
  ClientEnv.reset();
});

async function mount() {
  const selector = document.createElement(
    "game-mode-selector",
  ) as HTMLElement & {
    updateComplete: Promise<unknown>;
  };
  document.body.appendChild(selector);
  await selector.updateComplete;
  return selector;
}

describe("the Solo button's effects", () => {
  it("has a sheen behind the label, out of the way of clicks, and no border lines", async () => {
    const solo = (await mount()).querySelector<HTMLElement>(".solo-btn")!;
    expect(solo.textContent).toContain("main.solo");
    expect(solo.querySelector(".solo-sheen")).not.toBeNull();
    expect(solo.querySelector(".solo-sheen")!.getAttribute("aria-hidden")).toBe(
      "true",
    );
    expect(solo.querySelector("svg")).toBeNull();
  });

  it("keeps the hover colour #e5383bb0 and stays the one red call to action", async () => {
    const solo = (await mount()).querySelector<HTMLElement>(".solo-btn")!;
    expect(solo.className).toContain("hover:bg-[#e5383bb0]");
    expect(solo.className).toContain("bg-df-red");
    expect(solo.hasAttribute("disabled")).toBe(false);
    // only Solo has the effects: Create and Join stay plain
    expect(document.querySelectorAll(".solo-btn")).toHaveLength(1);
  });

  it("has no border lines in its styles, and stills the sheen for reduced motion", async () => {
    await mount();
    const css = document.getElementById("solo-button-styles")!.textContent!;
    expect(css).not.toMatch(/solo-dashes|solo-dots|stroke/);
    expect(css).toMatch(/prefers-reduced-motion: reduce[\s\S]*animation: none/);
  });

  it("eases the glow and the label shadow in and out instead of snapping", async () => {
    await mount();
    const css = document.getElementById("solo-button-styles")!.textContent!;
    expect(css).toMatch(
      /\.solo-btn \{[^}]*transition: box-shadow 550ms[^}]*text-shadow 550ms/,
    );
    // a rest shadow of the same shape as the hover one, so it interpolates
    expect(css).toMatch(
      /\.solo-btn \{[^}]*box-shadow: 0 10px 34px -16px[^}]*0%/,
    );
    expect(css).toMatch(/\.solo-btn \{[^}]*text-shadow: 0 0 14px[^}]*0%/);
    // an animation on the box-shadow would override the transition
    expect(css).not.toMatch(/solo-breathe/);
    expect(css).not.toMatch(/\.solo-btn(:hover)?\s*\{[^}]*animation:/);
  });

  it("never changes the button's size", async () => {
    await mount();
    const css = document.getElementById("solo-button-styles")!.textContent!;
    expect(css).not.toMatch(
      /scale\(|translateY\(|letter-spacing|padding|width: calc\(100%[^)]*\)\s*;\s*height: calc\(100% [^;]*\+/,
    );
    expect(css).not.toMatch(/\.solo-btn(:hover|:active)\s*\{[^}]*transform/);
  });

  it("adds its styles once however many selectors mount", async () => {
    await mount();
    await mount();
    expect(document.querySelectorAll("#solo-button-styles")).toHaveLength(1);
  });
});
