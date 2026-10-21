import { GameMapType, GameMode } from "@openfront/engine-api/game/GameTypes";
import { render } from "lit";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";

// The whole website (every page, modal and dialog) in the account pages'
// design: one theme block in styles.css, one header, one shell, one tab bar,
// the settings rows and the lobby panel the Solo and Create Lobby pages share.

import "../../src/client/components/baseComponents/Modal";
import type { OModal } from "../../src/client/components/baseComponents/Modal";
import "../../src/client/components/baseComponents/setting/SettingSlider";
import "../../src/client/components/baseComponents/setting/SettingToggle";
import {
  lobbyMapPreview,
  lobbySummaryRows,
} from "../../src/client/components/ui/LobbyPanel";
import { modalHeader } from "../../src/client/components/ui/ModalHeader";

const css = readFileSync("src/client/styles.css", "utf8");

let host: HTMLElement;
afterEach(() => host?.remove());
function mount(template: unknown): HTMLElement {
  host?.remove();
  host = document.createElement("div");
  document.body.append(host);
  render(template as never, host);
  return host;
}

describe("the website's theme", () => {
  // Everything under .df-home-shell reads the brand tokens, so one block
  // re-points them at the design system; the HUD sits outside the shell.
  const block = css.slice(css.indexOf(".df-home-shell,"));

  it("re-points the brand colours, radii and fonts at the design system", () => {
    for (const line of [
      "--color-df-bg: var(--color-ui-ground)",
      "--color-df-panel: var(--color-ui-surface)",
      "--color-df-red: var(--color-ui-accent)",
      "--color-df-text: var(--color-ui-text)",
      "--radius-lg: 10px",
      "--radius-2xl: 16px",
      "--font-sans: var(--font-ui)",
      "--font-display: var(--font-ui)",
    ]) {
      expect(block, line).toContain(line);
    }
  });

  it("covers the shadow hosts that would put the original values back", () => {
    // Tailwind writes the theme variables under :host as well; o-modal and
    // username-input adopt those styles, so their hosts get them explicitly.
    expect(block).toContain(".df-home-shell :is(o-modal, username-input)");
  });

  it("keeps the pixel face for the top nav alone", () => {
    expect(css).toContain('--font-pixel: "Pixelify Sans"');
    for (const file of ["DesktopNavBar", "MobileNavBar"]) {
      const source = readFileSync(`src/client/components/${file}.ts`, "utf8");
      expect(source).toContain("font-pixel");
      expect(source).not.toContain("font-display");
    }
  });

  it("keeps the homepage's design (pixel face, sharp corners) in the website's colours, while no page is open", () => {
    const home = css.slice(
      css.indexOf(".df-home-shell play-page username-input"),
      css.indexOf("@layer base"),
    );
    expect(css).toMatch(/:is\(\s*play-page,\s*news-box,\s*homepage-promos/);
    expect(home).toContain("--font-display: var(--font-pixel)");
    expect(home).toContain("--radius-sm: 2px");
    // no colour token is set here: the homepage reads the design system's
    expect(home).not.toContain("--color-");
    // and it has the design system's backdrop
    expect(css).not.toContain("body:not(.page-open) .df-backdrop");
  });

  it("gives every page the 1240px column", () => {
    const layout = readFileSync("src/client/components/MainLayout.ts", "utf8");
    expect(layout).toContain("in-[.page-open]:lg:max-w-[1240px]");
    expect(layout).not.toContain("page-wide");
  });
});

describe("modalHeader", () => {
  it("is the page header: a 44px back button with a label, and the page-title scale", () => {
    const back = vi.fn();
    const el = mount(
      modalHeader({ title: "Settings", onBack: back, ariaLabel: "Back" }),
    );
    const button = el.querySelector<HTMLButtonElement>("button")!;
    expect(button.getAttribute("aria-label")).toBe("Back");
    expect(button.className).toContain("h-11");
    expect(button.className).toContain("w-11");
    expect(button.className).toContain("rounded-ui-card");
    expect(el.querySelector(".ui-title")?.textContent).toBe("Settings");
    button.click();
    expect(back).toHaveBeenCalledOnce();
  });
});

describe("<o-modal>", () => {
  async function modal(tabs = [{ key: "a", label: "A" }]): Promise<OModal> {
    const el = document.createElement("o-modal") as OModal;
    el.inline = true;
    el.tabs = tabs;
    el.activeTab = "a";
    document.body.append(el);
    host = el;
    await el.updateComplete;
    return el;
  }

  it("uses the website's shell unless a page opts out", async () => {
    const el = await modal();
    expect(el.ui).toBe(true);
    const section = el.shadowRoot!.querySelector("section")!;
    expect(section.className).toContain("bg-ui-panel");
    expect(section.className).toContain("rounded-ui-modal");
  });

  it("draws its tabs as accent underline tabs, left-aligned and scrolling sideways", async () => {
    const el = await modal([
      { key: "a", label: "A" },
      { key: "b", label: "B" },
    ]);
    const list = el.shadowRoot!.querySelector('[role="tablist"]')!;
    expect(list.className).toContain("overflow-x-auto");
    expect(list.className).not.toContain("justify-center");
    const [first, second] = [...list.querySelectorAll("button")];
    expect(first.getAttribute("aria-selected")).toBe("true");
    expect(first.className).toContain("border-ui-accent");
    expect(second.className).toContain("border-transparent");
  });
});

describe("the settings rows", () => {
  it("a toggle is a real switch with the design's row and switch", async () => {
    const el = document.createElement("setting-toggle") as HTMLElement & {
      updateComplete: Promise<boolean>;
    };
    el.setAttribute("label", "Alert Frame");
    el.setAttribute("description", "Show the frame");
    host = el;
    document.body.append(el);
    await el.updateComplete;
    const input = el.querySelector<HTMLInputElement>("input")!;
    expect(input.getAttribute("role")).toBe("switch");
    expect(el.querySelector("label")!.className).toContain("rounded-ui-card");
    // its hidden input is positioned inside the row (see the switch row test in PageUi.test.ts)
    expect(el.querySelector("label")!.className).toMatch(
      /(^|\s)relative(\s|$)/,
    );
    expect(el.textContent).toContain("Alert Frame");
    expect(el.textContent).toContain("Show the frame");
  });

  it("a slider keeps its readout as the first span", async () => {
    const el = document.createElement("setting-slider") as HTMLElement & {
      updateComplete: Promise<boolean>;
      value: number;
    };
    el.setAttribute("label", "Volume");
    el.setAttribute("description", "How loud");
    el.value = 35;
    host = el;
    document.body.append(el);
    await el.updateComplete;
    expect(el.querySelector("span")!.textContent!.trim()).toBe("35%");
    expect(el.querySelector("span")!.className).toContain("ui-mono");
  });
});

describe("the lobby panel (Solo and Create Lobby)", () => {
  it("shows the picked map large, and the Random card as Random", () => {
    const el = mount(
      lobbyMapPreview({
        map: GameMapType.Africa,
        useRandom: false,
        mapImage: "/africa.webp",
      }),
    );
    expect(el.querySelector("img")?.getAttribute("src")).toBe("/africa.webp");
    expect(el.querySelector("[data-lobby-map-name]")?.textContent).toContain(
      "map.africa",
    );
    const random = mount(
      lobbyMapPreview({
        map: GameMapType.Africa,
        useRandom: true,
        mapImage: "/africa.webp",
      }),
    );
    expect(
      random.querySelector("[data-lobby-map-name]")?.textContent,
    ).toContain("map.random");
  });

  it("summarises difficulty, mode, population and what is on", () => {
    const rows = lobbySummaryRows({
      difficulty: "Hard",
      nations: 72,
      bots: 400,
      gameMode: GameMode.Team,
      rules: [true, false, true],
      limits: [false, false],
      disabledUnits: 3,
    });
    expect(rows.map((r) => r.value)).toEqual([
      "difficulty.hard",
      "game_mode.teams",
      "400 / 72",
      "2",
      "0",
      "3",
    ]);
  });

  it("has no difficulty to show without nations, and says none for no disabled units", () => {
    const rows = lobbySummaryRows({
      difficulty: "Easy",
      nations: 0,
      bots: 10,
      gameMode: GameMode.FFA,
      rules: [],
      limits: [],
      disabledUnits: 0,
    });
    expect(rows[0].value).toBe("—");
    expect(rows[5].value).toBe("common.none");
  });
});
