import { GameUpdateType } from "@openfront/engine-api/game/GameUpdates";
import { EventBus } from "@openfront/shared/EventBus";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../../../src/client/hud/layers/CapitalVictory";
import type { CapitalVictory } from "../../../src/client/hud/layers/CapitalVictory";
import { PlaySoundEffectEvent } from "../../../src/client/sound/Sounds";
import type { GameView } from "../../../src/client/view";

const ME = 4;
const THEM = 9;

function capture(over: Record<string, unknown> = {}) {
  return {
    type: GameUpdateType.CapitalEvent,
    kind: "captured",
    tick: 100,
    capitalId: 1,
    tile: 5,
    owner: THEM,
    captor: ME,
    replacement: false,
    crisisEndTick: 1_900,
    rewardGold: 250_000n,
    rewardTroops: 12_000,
    ...over,
  };
}

describe("CapitalVictory", () => {
  let banner: CapitalVictory;
  let sounds: string[];
  let updates: Record<number, unknown[]>;
  let catchingUp: boolean;

  const root = () => banner.shadowRoot!;
  const step = async (...events: unknown[]) => {
    updates = { [GameUpdateType.CapitalEvent]: events };
    banner.tick();
    await banner.updateComplete;
  };

  beforeEach(() => {
    vi.useFakeTimers();
    window.matchMedia = ((q: string) => ({
      matches: false,
      media: q,
    })) as never;
    catchingUp = false;
    updates = {};
    banner = document.createElement("capital-victory") as CapitalVictory;
    const bus = new EventBus();
    sounds = [];
    bus.on(PlaySoundEffectEvent, (e) => sounds.push(e.effect));
    banner.eventBus = bus;
    banner.game = {
      updatesSinceLastTick: () => updates,
      myPlayer: () => ({ smallID: () => ME }),
      isCatchingUp: () => catchingUp,
      playerBySmallID: (id: number) => ({
        isPlayer: () => true,
        name: () => (id === THEM ? "Alphaz" : "?"),
      }),
    } as unknown as GameView;
    document.body.appendChild(banner);
  });

  afterEach(() => {
    banner.remove();
    vi.useRealTimers();
  });

  it("shows nothing until a capital is captured", async () => {
    await step();
    expect(root().querySelector(".banner")).toBeNull();
  });

  it("shows the capture with what the engine paid, and plays the capture cues", async () => {
    await step(capture());
    const el = root().querySelector(".banner")!;
    expect(el.querySelector(".title")!.textContent).toBe(
      "capital_victory.title",
    );
    expect(el.querySelector(".sub")!.textContent!.trim()).toBe(
      "capital_victory.subtitle",
    );
    expect(sounds).toEqual(["conquered"]);
    await vi.advanceTimersByTimeAsync(500);
    expect(sounds).toEqual(["conquered", "ka-ching"]);
    // The numbers roll up to exactly the amounts paid.
    await vi.advanceTimersByTimeAsync(1_500);
    await banner.updateComplete;
    expect(el.querySelector('[data-reward="gold"]')!.textContent).toContain(
      "250K",
    );
    expect(el.querySelector('[data-reward="troops"]')!.textContent).toContain(
      "1.20K",
    );
  });

  it("is the captor's alone: not shown for being captured, nor for others' captures", async () => {
    await step(capture({ captor: THEM, owner: ME })); // I was the victim
    expect(root().querySelector(".banner")).toBeNull();
    await step(capture({ capitalId: 2, captor: 77, owner: 78 })); // two others
    expect(root().querySelector(".banner")).toBeNull();
    await step(capture({ capitalId: 3, kind: "destroyed", captor: null }));
    expect(root().querySelector(".banner")).toBeNull();
    expect(sounds).toEqual([]);
  });

  it("shows a capital once, however often the event is delivered", async () => {
    await step(capture());
    await vi.advanceTimersByTimeAsync(6_000);
    await banner.updateComplete;
    expect(root().querySelector(".banner")).toBeNull();
    await step(capture());
    await step(capture(), capture());
    expect(root().querySelector(".banner")).toBeNull();
    expect(sounds.filter((s) => s === "conquered")).toHaveLength(1);
  });

  it("says so, and plays no gold cue, when nothing was paid", async () => {
    await step(capture({ rewardGold: 0n, rewardTroops: 0 }));
    const el = root().querySelector(".banner")!;
    expect(el.querySelector(".none")!.textContent!.trim()).toBe(
      "capital_victory.already_paid",
    );
    expect(el.querySelector(".rewards")).toBeNull();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(sounds).toEqual(["conquered"]);
  });

  it("is silent while the game catches up (a rejoin replays old captures)", async () => {
    catchingUp = true;
    await step(capture());
    expect(root().querySelector(".banner")).toBeNull();
    expect(sounds).toEqual([]);
    // And it is then remembered, so it does not appear later either.
    catchingUp = false;
    await step(capture());
    expect(root().querySelector(".banner")).toBeNull();
  });

  it("queues a second capture behind the first, and leaves after a few seconds", async () => {
    await step(capture(), capture({ capitalId: 2, owner: 11 }));
    expect(root().querySelector('[data-capital-victory="1"]')).not.toBeNull();
    await vi.advanceTimersByTimeAsync(5_300);
    await banner.updateComplete;
    expect(root().querySelector('[data-capital-victory="2"]')).not.toBeNull();
    await vi.advanceTimersByTimeAsync(5_300);
    await banner.updateComplete;
    expect(root().querySelector(".banner")).toBeNull();
  });

  it("takes no pointer events", () => {
    const css = String(
      (banner.constructor as unknown as { styles: { cssText: string } }).styles
        .cssText,
    );
    expect(css).toMatch(/:host\s*{[^}]*pointer-events:\s*none/);
  });
});
