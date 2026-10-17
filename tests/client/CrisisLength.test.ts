import type { GameConfig } from "@openfront/engine-api/Schemas";
import { render } from "lit";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { testGameConfig } from "../util/Wire";

vi.mock("../../src/client/Cosmetics", () => ({
  getPlayerCosmetics: vi.fn(async () => ({})),
}));

vi.mock("../../src/client/CrazyGamesSDK", () => ({
  crazyGamesSDK: {
    isOnCrazyGames: vi.fn(() => false),
    requestMidgameAd: vi.fn(async () => {}),
  },
}));

vi.mock("../../src/client/TerrainMapFileLoader", () => ({
  terrainMapFileLoader: { getMapData: vi.fn() },
}));

// The desktop bridge is absent in jsdom; mock it like HostLobbyModal.test.ts.
vi.mock("../../src/client/DesktopPresence", () => ({
  desktopPresence: {
    isAvailable: vi.fn(() => false),
    openInviteDialog: vi.fn(async () => true),
    set: vi.fn(),
    consumePendingInvite: vi.fn(async () => null),
    subscribeInvites: vi.fn(() => () => undefined),
  },
}));

// Side-effect imports so the custom elements register.
import "../../src/client/components/GameConfigSettings";
import { HostLobbyModal } from "../../src/client/HostLobbyModal";
import "../../src/client/SinglePlayerModal";
import { notableLobbySettings } from "../../src/client/utilities/LobbySettingsSummary";
import { translateText } from "../../src/client/Utils";

// A CRISIS lasts 3 or 5 minutes, chosen when the match is set up (docs/Capital.md).
// The Capital System is on by default, with the shorter CRISIS; the engine
// already reads `capitalSystem.crisisMinutes`, and these tests pin that Solo
// and Create Match can set it, and that the default match is unchanged.

function soloModal(): any {
  return document.createElement("single-player-modal") as any;
}

async function soloConfig(modal: any): Promise<GameConfig> {
  const events: any[] = [];
  modal.addEventListener("join-lobby", (e: Event) =>
    events.push((e as CustomEvent).detail),
  );
  await modal.startGame();
  expect(events).toHaveLength(1);
  return events[0].gameStartInfo.config;
}

const pick = (modal: any, minutes: number) =>
  modal.handleConfigCrisisMinutesSelected(
    new CustomEvent("crisis-minutes-selected", { detail: { minutes } }),
  );

const toggleCapital = (modal: any, checked: boolean) =>
  modal.handleConfigOptionToggleChanged(
    new CustomEvent("option-toggle-changed", {
      detail: { labelKey: "game_settings.capital_system", checked },
    }),
  );

describe("the CRISIS length in Solo", () => {
  it("is not sent for a default match: the config is what it always was", async () => {
    const config = await soloConfig(soloModal());
    expect(config.capitalSystem).toEqual({ enabled: true });
  });

  it("sends 5 minutes when it is chosen", async () => {
    const modal = soloModal();
    pick(modal, 5);
    const config = await soloConfig(modal);
    expect(config.capitalSystem).toEqual({ enabled: true, crisisMinutes: 5 });
  });

  it("goes back to the default when 3 is chosen again", async () => {
    const modal = soloModal();
    pick(modal, 5);
    pick(modal, 3);
    const config = await soloConfig(modal);
    expect(config.capitalSystem).toEqual({ enabled: true });
  });

  it("does not leak a chosen length into a match without the Capital System", async () => {
    const modal = soloModal();
    pick(modal, 5);
    toggleCapital(modal, false);
    const config = await soloConfig(modal);
    expect(config.capitalSystem).toBeUndefined();
  });

  it("counts as a changed option only while the system is on", () => {
    const modal = soloModal();
    expect(modal.hasOptionsChanged()).toBe(false);
    pick(modal, 5);
    expect(modal.hasOptionsChanged()).toBe(true);
    pick(modal, 3);
    expect(modal.hasOptionsChanged()).toBe(false);
    pick(modal, 5);
    toggleCapital(modal, false);
    // Off is itself a change from the default, whatever length was chosen.
    expect(modal.hasOptionsChanged()).toBe(true);
  });
});

describe("the CRISIS length in Create Match", () => {
  async function sentConfig(
    modal: any,
  ): Promise<NonNullable<GameConfig["capitalSystem"]>> {
    modal.constructUrl = async () => "https://example.test/";
    modal.updateLobbyHistory = () => {};
    const sent: any[] = [];
    modal.addEventListener("update-game-config", (e: Event) =>
      sent.push((e as CustomEvent).detail.config),
    );
    await modal.putGameConfig();
    expect(sent).toHaveLength(1);
    return sent[0].capitalSystem;
  }

  const choose = (modal: any, minutes: number) =>
    modal.handleConfigCrisisMinutesSelected(
      new CustomEvent("crisis-minutes-selected", { detail: { minutes } }),
    );

  it("leaves the default length out of the config it sends", async () => {
    const modal = new HostLobbyModal() as any;
    expect(await sentConfig(modal)).toEqual({ enabled: true });
  });

  it("sends 5 minutes when the host chooses it, and tells the server at once", async () => {
    const modal = new HostLobbyModal() as any;
    modal.constructUrl = async () => "https://example.test/";
    modal.updateLobbyHistory = () => {};
    const sent: any[] = [];
    modal.addEventListener("update-game-config", (e: Event) =>
      sent.push((e as CustomEvent).detail.config),
    );
    choose(modal, 5);
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0].capitalSystem).toEqual({ enabled: true, crisisMinutes: 5 });
  });

  it("goes back to 3 minutes by leaving it out (the server replaces the whole object)", async () => {
    const modal = new HostLobbyModal() as any;
    modal.crisisMinutes = 5;
    modal.constructUrl = async () => "https://example.test/";
    modal.updateLobbyHistory = () => {};
    const sent: any[] = [];
    modal.addEventListener("update-game-config", (e: Event) =>
      sent.push((e as CustomEvent).detail.config),
    );
    choose(modal, 3);
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0].capitalSystem).toEqual({ enabled: true });
  });

  it("sends no length when the Capital System is off", async () => {
    const modal = new HostLobbyModal() as any;
    modal.crisisMinutes = 5;
    modal.capitalSystem = false;
    expect(await sentConfig(modal)).toEqual({ enabled: false });
  });
});

describe("the Capital System card's CRISIS length choice", () => {
  function card(toggle: Record<string, unknown>) {
    const settings = document.createElement("game-config-settings") as any;
    const container = document.createElement("div");
    document.body.append(container);
    render(settings.renderCapitalSystemToggle(toggle), container);
    return { settings, container };
  }

  it("offers 3 and 5 minutes, with the current one selected, while the system is on", () => {
    const { container } = card({
      labelKey: "game_settings.capital_system",
      checked: true,
      crisisMinutes: 5,
    });
    const select = container.querySelector<HTMLSelectElement>(
      "select[data-crisis-minutes]",
    )!;
    expect(select).not.toBeNull();
    const options = [...select.options];
    expect(options.map((o) => o.value)).toEqual(["3", "5"]);
    expect(options.find((o) => o.selected)?.value).toBe("5");
  });

  it("is not offered while the system is off", () => {
    const { container } = card({
      labelKey: "game_settings.capital_system",
      checked: false,
      crisisMinutes: 3,
    });
    expect(container.querySelector("select")).toBeNull();
  });

  it("announces the choice, and changing it does not flip the card", () => {
    const { settings, container } = card({
      labelKey: "game_settings.capital_system",
      checked: true,
      crisisMinutes: 3,
    });
    const chosen: number[] = [];
    const toggled: unknown[] = [];
    settings.addEventListener("crisis-minutes-selected", (e: Event) =>
      chosen.push((e as CustomEvent).detail.minutes),
    );
    settings.addEventListener("option-toggle-changed", (e: Event) =>
      toggled.push((e as CustomEvent).detail),
    );
    // The card's own click flips the toggle; the select must not reach it.
    settings.addEventListener("click", () => {});
    const select = container.querySelector<HTMLSelectElement>("select")!;
    select.addEventListener("click", (e) => e.stopPropagation(), true);
    select.value = "5";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    select.click();
    expect(chosen).toEqual([5]);
    expect(toggled).toEqual([]);
  });

  it("reads anything but 5 as the default", () => {
    const { settings, container } = card({
      labelKey: "game_settings.capital_system",
      checked: true,
      crisisMinutes: 5,
    });
    const chosen: number[] = [];
    settings.addEventListener("crisis-minutes-selected", (e: Event) =>
      chosen.push((e as CustomEvent).detail.minutes),
    );
    const select = container.querySelector<HTMLSelectElement>("select")!;
    select.innerHTML = '<option value="4" selected>4</option>';
    select.dispatchEvent(new Event("change", { bubbles: true }));
    expect(chosen).toEqual([3]);
  });
});

describe("the lobby summary", () => {
  const base = (capitalSystem: GameConfig["capitalSystem"]): GameConfig => ({
    ...testGameConfig(),
    capitalSystem,
  });

  const capitalItem = (c: GameConfig) =>
    notableLobbySettings(c, null).find((i) => /capital/i.test(i.label));

  // (translateText gives back the key in tests, so these compare keys.)
  const enabled = translateText("common.enabled");

  it("says nothing extra for the default 3-minute CRISIS", () => {
    const item = capitalItem(base({ enabled: true }))!;
    expect(item).toBeDefined();
    expect(item.value).toBe(enabled);
    expect(capitalItem(base({ enabled: true, crisisMinutes: 3 }))!.value).toBe(
      enabled,
    );
  });

  it("says when the CRISIS is the long one", () => {
    const item = capitalItem(base({ enabled: true, crisisMinutes: 5 }))!;
    expect(item.value).not.toBe(enabled);
    expect(item.value).toContain("long_crisis");
  });

  it("has English text for what it shows, with the minutes filled in", () => {
    const en = JSON.parse(
      readFileSync(resolve(__dirname, "../../resources/lang/en.json"), "utf8"),
    );
    expect(en.game_settings.capital_system_long_crisis).toContain("{minutes}");
    expect(en.game_settings.crisis_length_option).toContain("{minutes}");
    expect(en.game_settings.crisis_length).toBeTruthy();
  });

  it("lists nothing for a match without the Capital System", () => {
    expect(capitalItem(base({ enabled: false }))).toBeUndefined();
    expect(capitalItem(base(undefined))).toBeUndefined();
  });
});
