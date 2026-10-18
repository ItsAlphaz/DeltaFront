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
    inCrisis: false,
    strength: 50,
    foundedTick: 400,
    building: false,
    buildPercent: 0,
    buildLeft: 0,
    strainStart: 6_000,
    strainNow: 0,
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
    isBuildingCapital: () => s.building,
    capitalBuildPercent: () => s.buildPercent,
    capitalBuildRemainingTicks: () => s.buildLeft,
    capitalStrengthPercent: () => s.strength,
    capitalFoundedTick: () => s.foundedTick,
    inCrisis: () => s.inCrisis,
    strainStartTick: () => s.strainStart,
    strainPercentNow: () => s.strainNow,
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

  it("appears at once for a player with land and no capital", async () => {
    await step();
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
    expect(button()!.title).toContain("capital_action.need");
    // How much of the price they hold, as a bar and as numbers.
    expect(button()!.textContent).toContain("capital_action.progress");
    expect(button()!.querySelector<HTMLElement>(".meter i")!.style.width).toBe(
      "0%",
    );
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

describe("CapitalAction: what having no capital costs", () => {
  let el: CapitalAction;
  let env: ReturnType<typeof makeEnv>;
  const strain = () => el.querySelector<HTMLElement>("[data-capital-strain]")!;
  const step = async (ticks = 0) => {
    env.s.ticks += ticks;
    el.tick();
    await el.updateComplete;
  };

  beforeEach(() => {
    env = makeEnv();
    el = document.createElement("capital-action") as CapitalAction;
    el.game = env.game;
    el.eventBus = new EventBus();
    el.picker = { mode: null, begin() {}, cancel() {} } as never;
    document.body.appendChild(el);
    el.init();
  });
  afterEach(() => el.remove());

  it("tells the player when strain begins, before it does", async () => {
    await step();
    expect(strain().textContent).toContain("capital_action.strain_soon");
    expect(strain().classList.contains("on")).toBe(false);
  });

  it("says how much it takes once it has begun, in the amber of a warning", async () => {
    env.s.strainNow = 9;
    await step();
    expect(strain().textContent).toContain("capital_action.strain_now");
    expect(strain().classList.contains("on")).toBe(true);
  });

  it("is not the CRISIS: during one it says there is no strain", async () => {
    env.s.inCrisis = true;
    env.s.strainNow = 0;
    await step();
    expect(strain().textContent).toContain("capital_action.strain_crisis");
    expect(strain().classList.contains("on")).toBe(false);
  });

  it("is gone with a capital: nothing to explain", async () => {
    await step();
    expect(strain()).not.toBeNull();
    env.s.hasCapital = true;
    await step();
    expect(el.querySelector("[data-capital-strain]")).toBeNull();
  });

  it("explains what a capital gives in the button's tooltip", async () => {
    await step();
    expect(
      el.querySelector<HTMLButtonElement>("[data-capital-action]")!.title,
    ).toContain("capital_action.benefits");
  });
});

describe("CapitalAction: it never covers the panel under it", () => {
  it("tells the page where it ends while it is up, and takes it back when it is not", async () => {
    const env = makeEnv();
    const el = document.createElement("capital-action") as CapitalAction;
    el.game = env.game;
    el.eventBus = new EventBus();
    el.picker = { mode: null, begin() {}, cancel() {} } as never;
    document.body.appendChild(el);
    el.init();
    el.tick();
    await el.updateComplete;
    const css = document.documentElement.style;
    expect(css.getPropertyValue("--df-capital-panel-bottom")).toMatch(/px$/);
    // The panel stays (it shows the owner what the capital does)...
    env.s.hasCapital = true;
    el.tick();
    await el.updateComplete;
    expect(css.getPropertyValue("--df-capital-panel-bottom")).toMatch(/px$/);
    // ...and takes the variable back when it is gone.
    env.s.alive = false;
    el.tick();
    await el.updateComplete;
    expect(css.getPropertyValue("--df-capital-panel-bottom")).toBe("");
    el.remove();
  });
});

describe("CapitalAction: where it stands, and what it shows an owner", () => {
  let el: CapitalAction;
  let env: ReturnType<typeof makeEnv>;
  let requests: PickRequest[];
  const step = async (ticks = 0) => {
    env.s.ticks += ticks;
    el.tick();
    await el.updateComplete;
  };

  beforeEach(() => {
    env = makeEnv();
    requests = [];
    el = document.createElement("capital-action") as CapitalAction;
    el.game = env.game;
    el.eventBus = new EventBus();
    el.picker = {
      mode: null,
      begin: (r: PickRequest) => requests.push(r),
      cancel() {},
    } as never;
    document.body.appendChild(el);
    el.init();
  });
  afterEach(() => {
    el.remove();
    document.querySelector("game-left-sidebar")?.remove();
  });

  it("goes under the leaderboard, with a gap, wherever the leaderboard ends", async () => {
    const side = document.createElement("game-left-sidebar");
    const aside = document.createElement("aside");
    side.appendChild(aside);
    document.body.appendChild(side);
    for (const bottom of [150, 345]) {
      aside.getBoundingClientRect = () => ({ bottom }) as DOMRect;
      await step();
      const b = el.querySelector<HTMLElement>("[data-capital-action]")!;
      expect(b.style.top).toBe(`${bottom + 14}px`);
    }
  });

  it("asks for the capital to be previewed at the pointer while it is placed", async () => {
    await step();
    el.querySelector<HTMLButtonElement>("[data-capital-action]")!.click();
    expect(requests[0].ghost).toBe(true);
  });

  it("shows an owner what the capital does for them, and how far its bonuses have grown", async () => {
    env.s.hasCapital = true;
    env.s.strength = 62;
    await step();
    const owned = el.querySelector<HTMLElement>("[data-capital-owned]")!;
    expect(owned).not.toBeNull();
    expect(el.querySelector("[data-capital-action]")).toBeNull();
    expect(owned.textContent).toContain("capital_action.owned");
    expect(owned.textContent).toContain("capital_action.ramping");
    expect(owned.querySelector("[data-capital-perks]")!.textContent).toContain(
      "capital_action.perks",
    );
    expect(owned.querySelector<HTMLElement>(".meter i")!.style.width).toBe(
      "62%",
    );
    env.s.strength = 100;
    await step();
    const full = el.querySelector<HTMLElement>("[data-capital-owned]")!;
    expect(full.textContent).toContain("capital_action.full");
    expect(full.querySelector(".meter")).toBeNull();
  });
});

describe("CapitalAction: while the capital is being built", () => {
  it("shows how far along it is, in place of the buy button, and says what can go wrong", async () => {
    const env = makeEnv();
    env.s.building = true;
    env.s.buildPercent = 40;
    env.s.buildLeft = 180;
    const el = document.createElement("capital-action") as CapitalAction;
    el.game = env.game;
    el.eventBus = new EventBus();
    el.picker = { mode: null, begin() {}, cancel() {} } as never;
    document.body.appendChild(el);
    el.init();
    el.tick();
    await el.updateComplete;
    const b = el.querySelector<HTMLElement>("[data-capital-building]")!;
    expect(b).not.toBeNull();
    expect(el.querySelector("[data-capital-action]")).toBeNull();
    expect(b.textContent).toContain("capital_action.building");
    expect(b.textContent).toContain("capital_action.building_sub");
    expect(b.textContent).toContain("capital_action.building_hint");
    expect(b.querySelector<HTMLElement>(".meter i")!.style.width).toBe("40%");
    // Done: the owner's panel.
    env.s.building = false;
    env.s.hasCapital = true;
    el.tick();
    await el.updateComplete;
    expect(el.querySelector("[data-capital-building]")).toBeNull();
    expect(el.querySelector("[data-capital-owned]")).not.toBeNull();
    el.remove();
  });
});
