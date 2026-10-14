import { GameType } from "@openfront/engine-api/game/GameTypes";
import { EventBus } from "@openfront/shared/EventBus";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/client/Utils", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../src/client/Utils")>();
  return { ...actual, translateText: (key: string) => key };
});

import { GameRightSidebar } from "../../src/client/hud/layers/GameRightSidebar";
import { ShowMatchEventLogEvent } from "../../src/client/hud/layers/MatchEventLogModal";
import { modalRouter } from "../../src/client/ModalRouter";
import "../../src/client/UserSettingModal";
import type { UserSettingModal } from "../../src/client/UserSettingModal";
import { UserSettings } from "../../src/client/UserSettings";
import type { GameView } from "../../src/client/view";

const clearSettings = () => {
  localStorage.clear();
  (
    UserSettings as unknown as { cache: Map<string, string | null> }
  ).cache.clear();
};

beforeEach(clearSettings);
afterEach(() => {
  document.body.innerHTML = "";
  clearSettings();
});

describe("event feed settings", () => {
  it("default to a visible ticker with every event that involves a person, and no sound", () => {
    const s = new UserSettings();
    expect(s.eventFeed()).toBe(true);
    expect(s.eventFeedDetail()).toBe("all");
    expect(s.eventFeedSound()).toBe(false);
  });

  it("persist, through the normal settings mechanism", () => {
    const s = new UserSettings();
    s.toggleEventFeed();
    s.setEventFeedDetail("major");
    s.toggleEventFeedSound();
    expect(localStorage.getItem("settings.eventFeed")).toBe("false");
    expect(localStorage.getItem("settings.eventFeedDetail")).toBe("major");
    expect(localStorage.getItem("settings.eventFeedSound")).toBe("true");
    // A fresh reader (another page load) sees them.
    (
      UserSettings as unknown as { cache: Map<string, string | null> }
    ).cache.clear();
    const again = new UserSettings();
    expect(again.eventFeed()).toBe(false);
    expect(again.eventFeedDetail()).toBe("major");
    expect(again.eventFeedSound()).toBe(true);
  });

  it("announce changes, so a ticker on screen follows them", () => {
    const heard: string[] = [];
    window.addEventListener(
      "event:user-settings-changed:settings.eventFeedDetail",
      () => heard.push("detail"),
    );
    new UserSettings().setEventFeedDetail("major");
    expect(heard).toEqual(["detail"]);
  });

  it("a stored value that is not one of the two falls back to all", () => {
    localStorage.setItem("settings.eventFeedDetail", "everything");
    expect(new UserSettings().eventFeedDetail()).toBe("all");
  });
});

describe("the settings menu", () => {
  type Modal = UserSettingModal & { updateComplete: Promise<unknown> };
  async function gameplay(): Promise<Modal> {
    modalRouter.register("settings", {
      tag: "user-setting",
      pageId: "page-settings",
    });
    const el = document.createElement("user-setting") as Modal;
    document.body.appendChild(el);
    await el.updateComplete;
    el.open({ tab: "gameplay" });
    await el.updateComplete;
    return el;
  }

  it("has the feed toggle, the detail choice and the sound toggle on the Gameplay tab", async () => {
    const el = await gameplay();
    expect(el.querySelector("#event-feed-toggle")).not.toBeNull();
    expect(el.querySelector("#event-feed-detail-select")).not.toBeNull();
    expect(el.querySelector("#event-feed-sound-toggle")).not.toBeNull();
  });

  it("changes the stored settings, and hides the choices that mean nothing with the feed off", async () => {
    const el = await gameplay();
    const settings = new UserSettings();

    el.querySelector("#event-feed-detail-select")!.dispatchEvent(
      new CustomEvent("change", { detail: { value: "major" } }),
    );
    expect(settings.eventFeedDetail()).toBe("major");
    el.querySelector("#event-feed-sound-toggle")!.dispatchEvent(
      new CustomEvent("change", { detail: { checked: true } }),
    );
    expect(settings.eventFeedSound()).toBe(true);

    el.querySelector("#event-feed-toggle")!.dispatchEvent(
      new CustomEvent("change", { detail: { checked: false } }),
    );
    await el.updateComplete;
    expect(settings.eventFeed()).toBe(false);
    expect(el.querySelector("#event-feed-detail-select")).toBeNull();
    expect(el.querySelector("#event-feed-sound-toggle")).toBeNull();
    expect(el.querySelector("#event-feed-toggle")).not.toBeNull();
  });
});

describe("the top bar's Events button", () => {
  it("opens the full log, and is there whatever the ticker setting is", async () => {
    new UserSettings().toggleEventFeed();
    const bus = new EventBus();
    const opened: boolean[] = [];
    bus.on(ShowMatchEventLogEvent, (e) => opened.push(e.visible));
    const sidebar = new GameRightSidebar();
    sidebar.game = {
      config: () => ({
        doomsdayClockConfig: () => undefined,
        overtimeConfig: () => ({ enabled: false, startMinutes: 30 }),
        gameConfig: () => ({ gameType: GameType.Public, maxTimerValue: null }),
        isReplay: () => false,
        listed: false,
        numSpawnPhaseTurns: () => 400,
      }),
      elapsedGameSeconds: () => 0,
      inSpawnPhase: () => false,
      myPlayer: () => undefined,
      ticks: () => 0,
    } as unknown as GameView;
    sidebar.eventBus = bus;
    document.body.appendChild(sidebar);
    sidebar.init();
    await sidebar.updateComplete;
    const button = sidebar.querySelector<HTMLElement>(
      "[data-match-events-button]",
    );
    expect(button).not.toBeNull();
    button!.click();
    expect(opened).toEqual([true]);
  });
});
