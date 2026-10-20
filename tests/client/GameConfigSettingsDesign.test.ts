import {
  Difficulty,
  GameMapType,
  GameMode,
  UnitType,
} from "@openfront/engine-api/game/GameTypes";
import { html } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/client/TerrainMapFileLoader", () => ({
  terrainMapFileLoader: {
    getMapData: vi.fn(() => ({
      webpPath: "/m.webp",
      manifest: async () => ({ name: "World", nations: [] }),
    })),
  },
}));

import "../../src/client/components/GameConfigSettings";
import type {
  GameConfigSettings,
  GameConfigSettingsData,
} from "../../src/client/components/GameConfigSettings";

// The lobby's settings in the account pages' design (components/ui/PageUi.ts):
// jump links, difficulty and mode as pickers, population sliders, rules as a
// switch list, limits as value rows, units as chips.

function settings(
  over: Partial<GameConfigSettingsData> = {},
): GameConfigSettingsData {
  return {
    map: { selected: GameMapType.World, useRandom: false },
    difficulty: { selected: Difficulty.Easy, disabled: false },
    gameMode: { selected: GameMode.FFA },
    teamCount: { selected: 2 },
    options: {
      titleKey: "game_settings.options",
      bots: {
        value: 400,
        labelKey: "game_settings.bots",
        disabledKey: "common.disabled",
      },
      nations: {
        value: 72,
        defaultValue: 72,
        labelKey: "game_settings.nations",
        disabledKey: "common.disabled",
      },
      toggles: [
        { labelKey: "game_settings.instant_build", checked: true },
        { labelKey: "game_settings.random_spawn", checked: false },
      ],
      inputCards: [
        html`<input-card .labelKey=${"host_modal.start_delay"}></input-card>`,
      ],
    },
    unitTypes: {
      titleKey: "game_settings.disable_units",
      disabledUnits: [UnitType.Warship],
    },
    ...over,
  };
}

globalThis.IntersectionObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords() {
    return [];
  }
} as unknown as typeof IntersectionObserver;

let el: GameConfigSettings;
async function mount(data = settings()) {
  el = document.createElement("game-config-settings") as GameConfigSettings;
  el.settings = data;
  document.body.append(el);
  await el.updateComplete;
  return el;
}
afterEach(() => el?.remove());

describe("<game-config-settings> in the account pages' design", () => {
  it("has jump links to Map, Difficulty & Mode, Population, Rules, Limits and Units", async () => {
    await mount();
    const keys = [...el.querySelectorAll("[data-config-jump]")].map((b) =>
      b.getAttribute("data-config-jump"),
    );
    expect(keys).toEqual([
      "map",
      "difficulty",
      "population",
      "rules",
      "limits",
      "units",
    ]);
    for (const key of keys) {
      expect(
        el.querySelector(`[data-config-section="${key}"]`) !== null,
        String(key),
      ).toBe(true);
    }
  });

  it("a jump link marks itself current and scrolls its section into view", async () => {
    await mount();
    const target = el.querySelector<HTMLElement>(
      '[data-config-section="rules"]',
    )!;
    target.scrollIntoView = vi.fn();
    const link = el.querySelector<HTMLButtonElement>(
      '[data-config-jump="rules"]',
    )!;
    link.click();
    await el.updateComplete;
    expect(link.getAttribute("aria-current")).toBe("true");
    expect(target.scrollIntoView).toHaveBeenCalled();
  });

  it("difficulty and mode are pickers: the selected one has the accent border", async () => {
    await mount();
    const section = el.querySelector('[data-config-section="difficulty"]')!;
    const pressed = [
      ...section.querySelectorAll("button[aria-pressed='true']"),
    ];
    expect(pressed).toHaveLength(2);
    for (const b of pressed) expect(b.className).toContain("border-ui-accent");
  });

  it("rules are a list of switches, and a switch reports the toggle", async () => {
    await mount();
    const events: unknown[] = [];
    el.addEventListener("option-toggle-changed", (e) =>
      events.push((e as CustomEvent).detail),
    );
    const rows = el.querySelectorAll(
      '[data-config-section="rules"] [data-ui="switch-row"]',
    );
    expect(rows).toHaveLength(2);
    const input =
      rows[1].querySelector<HTMLInputElement>("input[role=switch]")!;
    input.checked = true;
    input.dispatchEvent(new Event("change", { bubbles: true }));
    expect(events).toEqual([
      { labelKey: "game_settings.random_spawn", checked: true },
    ]);
  });

  it("units are chips: a disabled unit is the selected, struck-through one", async () => {
    await mount();
    const chips = [
      ...el.querySelectorAll('[data-config-section="units"] [data-ui="chip"]'),
    ];
    expect(chips.length).toBeGreaterThan(5);
    const selected = chips.filter(
      (c) => c.getAttribute("aria-pressed") === "true",
    );
    expect(selected).toHaveLength(1);
    expect(selected[0].className).toContain("line-through");
    const events: unknown[] = [];
    el.addEventListener("unit-toggle-changed", (e) =>
      events.push((e as CustomEvent).detail),
    );
    (
      chips.find(
        (c) => c.getAttribute("aria-pressed") === "false",
      ) as HTMLElement
    ).click();
    expect(events).toHaveLength(1);
  });

  it("renders no coloured icon squares next to section headings", async () => {
    await mount();
    for (const heading of el.querySelectorAll("[data-config-section] h3")) {
      expect(heading.previousElementSibling).toBeNull();
    }
    expect(el.innerHTML).not.toMatch(/bg-(orange|teal|purple|green)-500\/20/);
  });
});
