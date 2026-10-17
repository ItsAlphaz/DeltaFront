import { CAPITAL_SPEC } from "@openfront/engine-lib/capital/CapitalRules";
import { EventBus } from "@openfront/shared/EventBus";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../../../src/client/hud/layers/CapitalAction";
import type { CapitalAction } from "../../../src/client/hud/layers/CapitalAction";
import type { PickRequest } from "../../../src/client/resistance/TilePicker";
import { SendFoundCapitalIntentEvent } from "../../../src/client/Transport";
import type { GameView } from "../../../src/client/view";

const ME = 1;

function makeEnv() {
  const s = {
    ticks: 500,
    enabled: true,
    alive: true,
    spawned: true,
    inSpawn: false,
    hasCapital: false,
    gold: 600_000n,
    infiniteGold: false,
    /** tile -> owner smallID; anything else is water. */
    owners: new Map<number, number>(),
  };
  // A 10 x 10 map: land everywhere, all ours except column 9 (the enemy's).
  for (let y = 0; y < 10; y++) {
    for (let x = 0; x < 10; x++) s.owners.set(x + y * 10, x === 9 ? 2 : ME);
  }
  const me = {
    smallID: () => ME,
    hasSpawned: () => s.spawned,
    isAlive: () => s.alive,
    hasCapital: () => s.hasCapital,
    gold: () => s.gold,
  };
  const game = {
    ticks: () => s.ticks,
    inSpawnPhase: () => s.inSpawn,
    config: () => ({
      capitalSystemEnabled: () => s.enabled,
      capitalSpec: () => CAPITAL_SPEC,
      gameConfig: () => ({ infiniteGold: s.infiniteGold }),
    }),
    myPlayer: () => me,
    isLand: (t: number) => s.owners.has(t),
    owner: (t: number) => (s.owners.get(t) === ME ? me : { smallID: () => 2 }),
    ownerID: (t: number) => s.owners.get(t) ?? 0,
    x: (t: number) => t % 10,
    y: (t: number) => Math.floor(t / 10),
    isValidCoord: (x: number, y: number) =>
      x >= 0 && y >= 0 && x < 10 && y < 10,
    ref: (x: number, y: number) => x + y * 10,
  } as unknown as GameView;
  return { s, game };
}

describe("CapitalAction", () => {
  let el: CapitalAction;
  let env: ReturnType<typeof makeEnv>;
  let bus: EventBus;
  let sent: SendFoundCapitalIntentEvent[];
  let requests: PickRequest[];
  let picker: {
    mode: string | null;
    begin: (r: PickRequest) => void;
    cancel: () => void;
  };
  let cancelled: number;

  const button = () =>
    el.querySelector<HTMLButtonElement>("[data-capital-action]");
  const step = async (ticks = 0) => {
    env.s.ticks += ticks;
    el.tick();
    await el.updateComplete;
  };

  beforeEach(() => {
    env = makeEnv();
    bus = new EventBus();
    sent = [];
    requests = [];
    cancelled = 0;
    bus.on(SendFoundCapitalIntentEvent, (e) => sent.push(e));
    picker = {
      mode: null,
      begin: (r) => {
        requests.push(r);
        picker.mode = r.mode;
      },
      cancel: () => {
        cancelled++;
        picker.mode = null;
      },
    };
    el = document.createElement("capital-action") as CapitalAction;
    el.game = env.game;
    el.eventBus = bus;
    el.picker = picker as never;
    document.body.appendChild(el);
    el.init();
  });

  afterEach(() => el.remove());

  it("appears for a player with land and no capital, after a moment", async () => {
    await step();
    expect(button()).toBeNull(); // the engine may be about to found one
    await step(10);
    expect(button()).not.toBeNull();
    expect(button()!.textContent).toContain("capital_action.found");
    expect(button()!.disabled).toBe(false);
  });

  it("is absent whenever it makes no sense", async () => {
    const hidden = async (change: () => void) => {
      change();
      await step();
      await step(20);
      expect(button()).toBeNull();
    };
    await hidden(() => (env.s.enabled = false));
    env.s.enabled = true;
    await hidden(() => (env.s.hasCapital = true));
    env.s.hasCapital = false;
    await hidden(() => (env.s.alive = false));
    env.s.alive = true;
    await hidden(() => (env.s.inSpawn = true));
    env.s.inSpawn = false;
    await hidden(() => (env.s.spawned = false));
  });

  it("names the price, and is disabled with the shortfall when it cannot be paid", async () => {
    env.s.gold = 100n;
    await step();
    await step(10);
    expect(button()!.disabled).toBe(true);
    expect(button()!.title).toBe("capital_action.need");
    // Infinite gold: nothing is charged, as with every other purchase.
    env.s.infiniteGold = true;
    await step();
    expect(button()!.disabled).toBe(false);
  });

  it("lets the player choose a tile of their own, and sends it", async () => {
    await step();
    await step(10);
    button()!.click();
    expect(requests).toHaveLength(1);
    const request = requests[0];
    expect(request.mode).toBe("found_capital");
    expect(request.hint).toBe("capital_action.pick");
    // (4,4) is interior; (9,4) is the enemy's; (8,4) borders the enemy;
    // (0,4) is on the map's edge of our land but every neighbour in the map is ours.
    expect(request.validate(44)).toBeNull();
    expect(request.validate(49)).toBe("capital_action.tile_not_owned");
    expect(request.validate(48)).toBe("capital_action.tile_border");
    expect(request.validate(500)).toBe("capital_action.tile_water");
    request.onPick(44);
    expect(sent.map((e) => e.tile)).toEqual([44]);
  });

  it("a second click while choosing cancels the pick", async () => {
    await step();
    await step(10);
    button()!.click();
    await el.updateComplete;
    button()!.click();
    expect(cancelled).toBe(1);
  });

  it("drops a pick that is under way if the player no longer needs one", async () => {
    await step();
    await step(10);
    button()!.click();
    env.s.hasCapital = true; // a capital was founded some other way
    await step();
    expect(cancelled).toBeGreaterThan(0);
    expect(picker.mode).toBeNull();
    vi.useRealTimers();
  });
});
