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
  it("has a dotted border and a sheen, behind the label and out of the way of clicks", async () => {
    const solo = (await mount()).querySelector<HTMLElement>(".solo-btn")!;
    expect(solo.textContent).toContain("main.solo");
    expect(solo.querySelector("svg.solo-dots rect")).not.toBeNull();
    expect(solo.querySelector(".solo-sheen")).not.toBeNull();
    // decorative: hidden from assistive tech
    expect(
      solo.querySelector("svg.solo-dots")!.getAttribute("aria-hidden"),
    ).toBe("true");
    expect(solo.querySelector(".solo-sheen")!.getAttribute("aria-hidden")).toBe(
      "true",
    );
  });

  it("keeps the hover colour #e5383bb0 and stays the one red call to action", async () => {
    const solo = (await mount()).querySelector<HTMLElement>(".solo-btn")!;
    expect(solo.className).toContain("hover:bg-[#e5383bb0]");
    expect(solo.className).toContain("bg-df-red");
    expect(solo.hasAttribute("disabled")).toBe(false);
    // only Solo has the effects: Create and Join stay plain
    expect(document.querySelectorAll(".solo-btn")).toHaveLength(1);
  });

  it("styles the dots dark red at rest and white on hover, and stills them for reduced motion", async () => {
    await mount();
    const css = document.getElementById("solo-button-styles")!.textContent!;
    expect(css).toMatch(
      /\.solo-btn \.solo-dots rect \{[^}]*stroke: color-mix\([^}]*var\(--color-df-red\)[^}]*black/,
    );
    expect(css).toMatch(
      /\.solo-btn:hover \.solo-dots rect \{[^}]*stroke: white/,
    );
    expect(css).toMatch(/prefers-reduced-motion: reduce[\s\S]*animation: none/);
  });

  it("adds its styles once however many selectors mount", async () => {
    await mount();
    await mount();
    expect(document.querySelectorAll("#solo-button-styles")).toHaveLength(1);
  });
});
