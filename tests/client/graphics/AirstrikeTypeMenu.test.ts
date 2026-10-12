import { UnitType } from "@openfront/engine-api/game/GameTypes";
import { EventBus } from "@openfront/shared/EventBus";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../../../src/client/hud/layers/AirstrikeTypeMenu";
import type { AirstrikeTypeMenu } from "../../../src/client/hud/layers/AirstrikeTypeMenu";
import {
  AirstrikeBlockedEvent,
  CloseAirstrikeMenuEvent,
  ShowAirstrikeMenuEvent,
} from "../../../src/client/InputHandler";
import { BuildUnitIntentEvent } from "../../../src/client/Transport";
import type { UIState } from "../../../src/client/UIState";
import type { GameView } from "../../../src/client/view";

const TARGET = 4242;

type StrikeType =
  | typeof UnitType.BombingRun
  | typeof UnitType.RocketStrike
  | typeof UnitType.StrafingRun;

/** What the (mock) engine answers for each strike type at the target. */
interface Answer {
  canBuild: boolean;
  cost: bigint;
}

describe("AirstrikeTypeMenu", () => {
  let menu: AirstrikeTypeMenu;
  let eventBus: EventBus;
  let uiState: UIState;
  let intents: BuildUnitIntentEvent[];
  let closes: CloseAirstrikeMenuEvent["reason"][];
  let blocked: AirstrikeBlockedEvent[];
  let answers: Map<StrikeType, Answer>;
  let disabled: Set<string>;
  let alive: boolean;

  const flush = async () => {
    for (let i = 0; i < 4; i++) {
      await Promise.resolve();
      await menu.updateComplete;
    }
  };

  const key = (code: string, init: KeyboardEventInit = {}) => {
    const e = new KeyboardEvent("keydown", {
      code,
      bubbles: true,
      cancelable: true,
      ...init,
    });
    window.dispatchEvent(e);
    return e;
  };

  const open = async () => {
    eventBus.emit(new ShowAirstrikeMenuEvent(TARGET, 200, 150));
    await flush();
  };

  const radios = () =>
    Array.from(menu.querySelectorAll<HTMLElement>("[role=radio]"));
  const checkedIndex = () =>
    radios().findIndex((r) => r.getAttribute("aria-checked") === "true");

  beforeEach(() => {
    localStorage.clear();
    answers = new Map<StrikeType, Answer>([
      [UnitType.BombingRun, { canBuild: true, cost: 1_000_000n }],
      [UnitType.RocketStrike, { canBuild: true, cost: 1_500_000n }],
      [UnitType.StrafingRun, { canBuild: true, cost: 750_000n }],
    ]);
    disabled = new Set();
    alive = true;
    intents = [];
    closes = [];
    blocked = [];

    const me = {
      isAlive: () => alive,
      smallID: () => 1,
      isFriendly: () => false,
      gold: () => 10_000_000n,
      units: () => [],
      buildables: vi.fn(async (_tile: number, types: readonly StrikeType[]) =>
        types.map((type) => ({ type, ...answers.get(type)! })),
      ),
    };
    const game = {
      myPlayer: () => me,
      inSpawnPhase: () => false,
      isSpawnImmunityActive: () => false,
      isLand: () => true,
      isImpassable: () => false,
      owner: () => ({ isPlayer: () => true, smallID: () => 2 }),
      ticks: () => 0,
      config: () => ({
        airportRange: () => 400,
        AirportCooldown: () => 200,
        msPerTick: () => 100,
        isUnitDisabled: (type: string) => disabled.has(type),
      }),
    } as unknown as GameView;

    eventBus = new EventBus();
    uiState = {
      attackRatio: 20,
      ghostStructure: UnitType.Airstrike,
      rocketDirectionUp: true,
      upgradeMultiplier: 1,
      airstrikeTarget: null,
      airstrikeType: UnitType.BombingRun,
    };
    eventBus.on(BuildUnitIntentEvent, (e) => intents.push(e));
    eventBus.on(CloseAirstrikeMenuEvent, (e) => closes.push(e.reason));
    eventBus.on(AirstrikeBlockedEvent, (e) => blocked.push(e));

    menu = document.createElement("airstrike-type-menu") as AirstrikeTypeMenu;
    menu.game = game;
    menu.eventBus = eventBus;
    menu.uiState = uiState;
    document.body.appendChild(menu);
    menu.init();
  });

  afterEach(() => {
    menu.remove();
    document.body.innerHTML = "";
    vi.restoreAllMocks();
  });

  it("renders nothing until it is asked to open", async () => {
    await flush();
    expect(menu.querySelector("[role=dialog]")).toBeNull();
    expect(uiState.airstrikeTarget).toBeNull();
  });

  it("opens with the three strike types and records the target", async () => {
    await open();
    expect(menu.querySelector("[role=dialog]")).not.toBeNull();
    expect(radios()).toHaveLength(3);
    expect(uiState.airstrikeTarget).toBe(TARGET);
    expect(checkedIndex()).toBe(0);
    // Nothing is sent just by opening.
    expect(intents).toEqual([]);
  });

  it("arrow keys move the selection and skip strikes that cannot launch", async () => {
    answers.set(UnitType.RocketStrike, { canBuild: false, cost: 1_500_000n });
    disabled.add(UnitType.RocketStrike);
    await open();

    key("ArrowDown");
    await flush();
    expect(uiState.airstrikeType).toBe(UnitType.StrafingRun);
    expect(checkedIndex()).toBe(2);

    key("ArrowUp");
    await flush();
    expect(uiState.airstrikeType).toBe(UnitType.BombingRun);
  });

  it("shows the reason on a strike that cannot launch", async () => {
    answers.set(UnitType.RocketStrike, { canBuild: false, cost: 1_500_000n });
    disabled.add(UnitType.RocketStrike);
    await open();
    const rocket = radios()[1];
    expect(rocket.getAttribute("aria-disabled")).toBe("true");
    expect(radios()[0].getAttribute("aria-disabled")).toBe("false");
  });

  it("digit keys only select; they never launch", async () => {
    await open();
    key("Digit3");
    await flush();
    expect(uiState.airstrikeType).toBe(UnitType.StrafingRun);
    key("Numpad2");
    await flush();
    expect(uiState.airstrikeType).toBe(UnitType.RocketStrike);
    expect(intents).toEqual([]);
    expect(uiState.airstrikeTarget).toBe(TARGET);
  });

  it("Enter launches the selected strike exactly once", async () => {
    await open();
    key("Digit2");
    await flush();
    key("Enter");
    key("Enter");
    await flush();

    expect(intents).toHaveLength(1);
    expect(intents[0].unit).toBe(UnitType.RocketStrike);
    expect(intents[0].tile).toBe(TARGET);
    expect(closes).toEqual(["launched"]);
    expect(uiState.airstrikeTarget).toBeNull();
    expect(menu.querySelector("[role=dialog]")).toBeNull();
    expect(localStorage.getItem("airstrike.lastType")).toBe(
      UnitType.RocketStrike,
    );
  });

  it("Escape closes only the menu and keeps the Airstrike ghost", async () => {
    await open();
    key("Escape");
    await flush();
    expect(closes).toEqual(["escape"]);
    expect(uiState.airstrikeTarget).toBeNull();
    expect(uiState.ghostStructure).toBe(UnitType.Airstrike);
    expect(intents).toEqual([]);
    expect(menu.querySelector("[role=dialog]")).toBeNull();
  });

  it("a pointer press outside the menu closes it", async () => {
    await open();
    document.body.dispatchEvent(
      new MouseEvent("pointerdown", { bubbles: true }),
    );
    await flush();
    expect(closes).toEqual(["outside"]);
    expect(uiState.airstrikeTarget).toBeNull();
  });

  it("a pointer press inside the menu does not close it", async () => {
    await open();
    menu
      .querySelector("[role=dialog]")!
      .dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
    await flush();
    expect(closes).toEqual([]);
    expect(menu.querySelector("[role=dialog]")).not.toBeNull();
  });

  it("refuses to launch when the target became invalid at confirm time", async () => {
    await open();
    // The menu looked launchable; the engine now says no.
    answers.set(UnitType.BombingRun, { canBuild: false, cost: 1_000_000n });
    key("Enter");
    await flush();

    expect(intents).toEqual([]);
    expect(blocked).toHaveLength(1);
    expect(blocked[0].tile).toBe(TARGET);
    // Still open, so the player can pick another strike or cancel.
    expect(uiState.airstrikeTarget).toBe(TARGET);
    expect(menu.querySelector("[role=dialog]")).not.toBeNull();
  });

  it("does not launch a strike already known to be blocked", async () => {
    answers.set(UnitType.BombingRun, { canBuild: false, cost: 1_000_000n });
    disabled.add(UnitType.BombingRun);
    await open();
    key("Enter");
    await flush();
    expect(intents).toEqual([]);
    expect(blocked).toHaveLength(1);
  });

  it("the wheel steps through the strikes", async () => {
    await open();
    const dialog = menu.querySelector("[role=dialog]")!;
    dialog.dispatchEvent(
      new WheelEvent("wheel", { deltaY: 100, bubbles: true, cancelable: true }),
    );
    await flush();
    expect(uiState.airstrikeType).toBe(UnitType.RocketStrike);
    dialog.dispatchEvent(
      new WheelEvent("wheel", {
        deltaY: -100,
        bubbles: true,
        cancelable: true,
      }),
    );
    await flush();
    expect(uiState.airstrikeType).toBe(UnitType.BombingRun);
  });

  it("closes itself when the ghost changes or the player dies", async () => {
    await open();
    uiState.ghostStructure = UnitType.City;
    menu.tick();
    await flush();
    expect(closes).toEqual(["ghost_changed"]);
    expect(uiState.airstrikeTarget).toBeNull();
    expect(menu.querySelector("[role=dialog]")).toBeNull();

    uiState.ghostStructure = UnitType.Airstrike;
    await open();
    alive = false;
    menu.tick();
    await flush();
    expect(closes).toEqual(["ghost_changed", "ghost_changed"]);
  });

  it("closes without a second close event when told to hide", async () => {
    await open();
    eventBus.emit(new CloseAirstrikeMenuEvent("map_click"));
    await flush();
    expect(menu.querySelector("[role=dialog]")).toBeNull();
    // Only the event we emitted ourselves.
    expect(closes).toEqual(["map_click"]);
  });

  it("stops listening to the keyboard once closed", async () => {
    await open();
    key("Escape");
    await flush();
    key("Enter");
    await flush();
    expect(intents).toEqual([]);
  });

  it("swallows other keys while open so build keybinds do not fire behind it", async () => {
    await open();
    const seen = vi.fn();
    const bubble = (e: Event) => seen(e);
    document.addEventListener("keydown", bubble);
    key("KeyA");
    document.removeEventListener("keydown", bubble);
    expect(seen).not.toHaveBeenCalled();
  });

  it("remembers the last launched type across sessions", async () => {
    await open();
    key("Digit3");
    await flush();
    key("Enter");
    await flush();
    expect(localStorage.getItem("airstrike.lastType")).toBe(
      UnitType.StrafingRun,
    );

    uiState.airstrikeType = UnitType.BombingRun;
    menu.init();
    expect(uiState.airstrikeType).toBe(UnitType.StrafingRun);
  });
});
