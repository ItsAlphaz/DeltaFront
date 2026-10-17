import { EventBus } from "@openfront/shared/EventBus";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MouseUpEvent } from "../../../src/client/InputHandler";
import {
  TilePicker,
  type PickRequest,
} from "../../../src/client/resistance/TilePicker";
import type { UIState } from "../../../src/client/UIState";
import type { GameView } from "../../../src/client/view";

describe("TilePicker", () => {
  let bus: EventBus;
  let ui: UIState;
  let picker: TilePicker;
  let me: object | null;
  let picked: number[];
  let reasons: Record<number, string | null>;
  let request: PickRequest;

  const hint = () => document.querySelector(".tile-picker-hint");
  const message = () => hint()?.querySelector(".msg")?.textContent;
  /** The tile under a screen point: x + y * 100, valid inside a 100 x 100 map. */
  const click = (x: number, y: number) => bus.emit(new MouseUpEvent(x, y));

  beforeEach(() => {
    bus = new EventBus();
    ui = {
      attackRatio: 20,
      ghostStructure: null,
      rocketDirectionUp: true,
      upgradeMultiplier: 1,
      airstrikeTarget: null,
      airstrikeType: "Bombing Run" as never,
    };
    me = {};
    picked = [];
    reasons = {};
    const game = {
      myPlayer: () => me,
      inSpawnPhase: () => false,
      isValidCoord: (x: number, y: number) =>
        x >= 0 && y >= 0 && x < 100 && y < 100,
      ref: (x: number, y: number) => x + y * 100,
    } as unknown as GameView;
    const transform = {
      screenToWorldCoordinates: (x: number, y: number) => ({ x, y }),
    };
    picker = new TilePicker(game, bus, ui, transform as never);
    request = {
      mode: "found_capital",
      hint: "pick one",
      validate: (tile) => reasons[tile] ?? null,
      onPick: (tile) => picked.push(tile),
    };
  });

  afterEach(() => {
    picker.cancel();
  });

  it("claims the next click, and shows what is being chosen", () => {
    expect(picker.mode).toBeNull();
    picker.begin(request);
    expect(picker.mode).toBe("found_capital");
    expect(ui.pickMode).toBe("found_capital");
    expect(message()).toBe("pick one");
    expect(hint()!.getAttribute("role")).toBe("status");
  });

  it("hands over a good tile once, after the click has been seen by everyone", async () => {
    picker.begin(request);
    // The map-click handler registers after the picker and runs in the same
    // emit: it must still see that a tile was being chosen, or it would send an attack.
    let seenByMapClick: string | null | undefined;
    bus.on(MouseUpEvent, () => {
      seenByMapClick = ui.pickMode;
    });
    click(3, 4);
    expect(seenByMapClick).toBe("found_capital");
    await Promise.resolve();
    expect(picked).toEqual([403]);
    expect(ui.pickMode).toBeNull();
    expect(picker.mode).toBeNull();
    expect(hint()).toBeNull();
    // Once only: a second click is an ordinary click again.
    click(5, 5);
    await Promise.resolve();
    expect(picked).toEqual([403]);
  });

  it("says why a tile will not do, and keeps choosing", async () => {
    picker.begin(request);
    reasons[403] = "too close to the border";
    click(3, 4);
    await Promise.resolve();
    expect(message()).toBe("too close to the border");
    expect(hint()!.querySelector(".msg")!.classList.contains("bad")).toBe(true);
    expect(picked).toEqual([]);
    expect(picker.mode).toBe("found_capital");
    // Another tile does.
    click(9, 9);
    await Promise.resolve();
    expect(picked).toEqual([909]);
  });

  it("ignores a click outside the map", async () => {
    picker.begin(request);
    click(500, 4);
    click(-1, 2);
    await Promise.resolve();
    expect(picked).toEqual([]);
    expect(picker.mode).toBe("found_capital");
  });

  it("ends with nothing sent on Escape, or on its Cancel button", () => {
    picker.begin(request);
    window.dispatchEvent(new KeyboardEvent("keydown", { code: "Escape" }));
    expect(picker.mode).toBeNull();
    expect(ui.pickMode).toBeNull();
    expect(hint()).toBeNull();

    picker.begin(request);
    hint()!.querySelector("button")!.click();
    expect(picker.mode).toBeNull();
    expect(picked).toEqual([]);
    // Other keys do not.
    picker.begin(request);
    window.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyA" }));
    expect(picker.mode).toBe("found_capital");
  });

  it("starting another pick drops the first without sending it", async () => {
    picker.begin(request);
    const second: PickRequest = {
      ...request,
      mode: "resistance_base",
      hint: "base",
      onPick: vi.fn(),
    };
    picker.begin(second);
    expect(document.querySelectorAll(".tile-picker-hint")).toHaveLength(1);
    expect(message()).toBe("base");
    click(1, 1);
    await Promise.resolve();
    expect(picked).toEqual([]);
    expect(second.onPick).toHaveBeenCalledWith(101);
  });

  it("does nothing when no pick is open", async () => {
    click(2, 2);
    await Promise.resolve();
    expect(picked).toEqual([]);
    expect(ui.pickMode ?? null).toBeNull();
  });

  it("lets go when the player is gone", () => {
    picker.begin(request);
    me = null;
    picker.tick();
    expect(picker.mode).toBeNull();
    expect(ui.pickMode).toBeNull();
  });
});
