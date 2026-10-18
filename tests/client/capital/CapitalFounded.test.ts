import {
  GameUpdateType,
  type CapitalEventUpdate,
} from "@openfront/engine-api/game/GameUpdates";
import { CAPITAL_SPEC } from "@openfront/engine-lib/capital/CapitalRules";
import { EventBus } from "@openfront/shared/EventBus";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../../../src/client/hud/layers/CapitalFounded";
import type { CapitalFounded } from "../../../src/client/hud/layers/CapitalFounded";
import { PlaySoundEffectEvent } from "../../../src/client/sound/Sounds";

const ME = 1;

function event(over: Partial<CapitalEventUpdate>): CapitalEventUpdate {
  return {
    type: GameUpdateType.CapitalEvent,
    kind: "founded",
    tick: 100,
    capitalId: 1,
    tile: 5,
    owner: ME,
    captor: null,
    replacement: false,
    crisisEndTick: -1,
    rewardGold: 0n,
    rewardTroops: 0,
    ...over,
  };
}

describe("CapitalFounded: off to the side, never in the middle", () => {
  let el: CapitalFounded;
  let events: CapitalEventUpdate[];
  let catchingUp: boolean;
  let sounds: string[];

  const card = () =>
    el.shadowRoot!.querySelector<HTMLElement>("[data-capital-founded]");
  const step = async () => {
    el.tick();
    await el.updateComplete;
    events = [];
  };

  beforeEach(() => {
    vi.useFakeTimers();
    events = [];
    catchingUp = false;
    sounds = [];
    const bus = new EventBus();
    bus.on(PlaySoundEffectEvent, (e) => sounds.push(e.effect));
    el = document.createElement("capital-founded") as CapitalFounded;
    el.game = {
      myPlayer: () => ({ smallID: () => ME }),
      isCatchingUp: () => catchingUp,
      updatesSinceLastTick: () => ({ [GameUpdateType.CapitalEvent]: events }),
      config: () => ({ capitalSpec: () => CAPITAL_SPEC }),
    } as never;
    el.eventBus = bus;
    document.body.appendChild(el);
  });
  afterEach(() => {
    el.remove();
    vi.useRealTimers();
    document.documentElement.style.removeProperty("--df-capital-extra");
  });

  it("makes the building sound when the building begins, and shows nothing yet", async () => {
    events = [event({ kind: "building", completeTick: 400 })];
    await step();
    expect(sounds).toEqual(["build-city"]);
    expect(card()).toBeNull();
  });

  it("when it stands: a chime and a card saying what it does, one bonus per line, with the rules' own numbers", async () => {
    events = [event({})];
    await step();
    expect(sounds).toEqual(["silo-built"]);
    const c = card()!;
    expect(c).not.toBeNull();
    const text = c.textContent!;
    expect(text).toContain("capital_founded.title");
    expect(text).not.toContain("capital_founded.title_replacement");
    for (const key of [
      "troops",
      "discount",
      "income",
      "regen",
      "loss",
      "unlocks",
    ]) {
      expect(text).toContain(`capital_founded.${key}`);
    }
    expect(c.querySelectorAll("li")).toHaveLength(6);
  });

  it("has the effects that catch the eye: a glowing card, a sweep of light, sparkles, a pulse along the screen's edge", async () => {
    events = [event({})];
    await step();
    const root = el.shadowRoot!;
    expect(root.querySelector(".shine")).not.toBeNull();
    expect(root.querySelectorAll(".spark").length).toBeGreaterThanOrEqual(4);
    expect(root.querySelector(".edge")).not.toBeNull();
    const css = String(
      (el.constructor as unknown as { styles: { cssText: string } }).styles
        .cssText,
    );
    expect(css).toMatch(/@keyframes glow/);
    expect(css).toMatch(/@keyframes shine/);
    expect(css).toMatch(/@keyframes pop/);
  });

  it("stays at the side: a narrow card at the left, never over the middle of the screen", async () => {
    events = [event({})];
    await step();
    const css = String(
      (el.constructor as unknown as { styles: { cssText: string } }).styles
        .cssText,
    );
    const rule = css.slice(
      css.indexOf(".card {"),
      css.indexOf("}", css.indexOf(".card {")),
    );
    expect(rule).toMatch(/left:\s*8px/);
    expect(rule).toMatch(/width:\s*232px/);
    expect(rule).not.toMatch(/left:\s*50%/);
    // And it tells the panel under it to make room while it is up.
    expect(
      document.documentElement.style.getPropertyValue("--df-capital-extra"),
    ).toMatch(/px$/);
  });

  it("calls a replacement a new capital", async () => {
    events = [event({ replacement: true })];
    await step();
    expect(card()!.textContent).toContain("capital_founded.title_replacement");
  });

  it("is for the player's own capital only", async () => {
    events = [event({ owner: 2 })];
    await step();
    expect(card()).toBeNull();
    expect(sounds).toEqual([]);
    events = [event({ kind: "captured", capitalId: 2 })];
    await step();
    expect(card()).toBeNull();
  });

  it("reacts once per capital and event, and not at all while catching up", async () => {
    catchingUp = true;
    events = [event({ capitalId: 7 })];
    await step();
    expect(card()).toBeNull();
    catchingUp = false;
    events = [event({ capitalId: 7 })]; // already seen: not shown late either
    await step();
    expect(card()).toBeNull();
    events = [event({ capitalId: 8 })];
    await step();
    expect(card()).not.toBeNull();
    events = [event({ capitalId: 8 })];
    await step();
    expect(sounds).toEqual(["silo-built"]);
  });

  it("leaves by itself, gives the room back, and takes no pointer events", async () => {
    events = [event({})];
    await step();
    await vi.advanceTimersByTimeAsync(8_500);
    await el.updateComplete;
    expect(card()!.classList.contains("leaving")).toBe(true);
    await vi.advanceTimersByTimeAsync(600);
    await el.updateComplete;
    expect(card()).toBeNull();
    expect(
      document.documentElement.style.getPropertyValue("--df-capital-extra"),
    ).toBe("");
    const css = String(
      (el.constructor as unknown as { styles: { cssText: string } }).styles
        .cssText,
    );
    expect(css).toMatch(/pointer-events:\s*none/);
  });
});
