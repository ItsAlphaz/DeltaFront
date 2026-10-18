import {
  InsurgencyPhase,
  InsurgencyRegionStatus,
  type InsurgencyRegionView,
  type InsurgencyView,
} from "@openfront/engine-api/game/GameUpdates";
import { INSURGENCY_SPEC as SPEC } from "@openfront/engine-lib/insurgency/InsurgencyRules";
import { EventBus } from "@openfront/shared/EventBus";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ResistanceCommand } from "../../../src/client/hud/layers/ResistanceCommand";
import type { PickRequest } from "../../../src/client/resistance/TilePicker";
import {
  SendResistanceBaseIntentEvent,
  SendResistanceIntelIntentEvent,
  SendResistanceRecruitIntentEvent,
  SendResistanceUprisingIntentEvent,
  SendSuppressRegionIntentEvent,
} from "../../../src/client/Transport";
import type { GameView } from "../../../src/client/view";

// No canvas in jsdom: the region squares are verified in a real browser.
vi.mock("../../../src/client/resistance/RegionOverlay", () => ({
  RegionOverlay: class {
    start() {}
    stop() {}
    label() {
      return "";
    }
  },
}));
await import("../../../src/client/hud/layers/ResistanceCommand");

const ME = 1;
const RAIDER = 2;

function region(
  over: Partial<InsurgencyRegionView> = {},
): InsurgencyRegionView {
  return {
    id: 0,
    former: 800,
    status: InsurgencyRegionStatus.Occupied,
    band: 3,
    occupier: RAIDER,
    cooldownUntil: 0,
    hasBase: false,
    hasOperation: false,
    suppressed: false,
    flips: 0,
    ...over,
  };
}

function view(over: Partial<InsurgencyView> = {}): InsurgencyView {
  return {
    owner: ME,
    phase: InsurgencyPhase.Field,
    endReason: "",
    startTick: 100,
    deadline: 100 + 7_200,
    limboDeadline: -1,
    startingTroops: 100_000,
    capacity: 200_000,
    available: 100_000,
    deployed: 0,
    pending: [],
    funds: 400_000n,
    fundsStart: 400_000n,
    strength: 50,
    bases: [],
    operations: [],
    regions: [region()],
    intel: [],
    intelReadyTick: 0,
    suppressions: [],
    reclaimed: 0,
    ...over,
  };
}

interface Env {
  s: {
    ticks: number;
    alive: boolean;
    catchingUp: boolean;
    army: number;
    views: Map<number, InsurgencyView>;
  };
  game: GameView;
}

function makeEnv(): Env {
  const s = {
    ticks: 1_000,
    alive: true,
    catchingUp: false,
    army: 1_000_000,
    views: new Map<number, InsurgencyView>([[ME, view()]]),
  };
  const players: Record<number, unknown> = {
    [ME]: { smallID: () => ME, isPlayer: () => true, displayName: () => "Me" },
    [RAIDER]: {
      smallID: () => RAIDER,
      isPlayer: () => true,
      displayName: () => "Raider",
      id: () => "raider-id",
    },
    3: {
      smallID: () => 3,
      isPlayer: () => true,
      displayName: () => "Alice",
      id: () => "alice-id",
    },
  };
  const game = {
    ticks: () => s.ticks,
    isCatchingUp: () => s.catchingUp,
    width: () => 200,
    height: () => 200,
    config: () => ({ insurgencySpec: () => SPEC }),
    myPlayer: () => ({
      smallID: () => ME,
      isAlive: () => s.alive,
      troops: () => s.army,
      isFriendly: () => false,
    }),
    playerBySmallID: (id: number) => players[id] ?? { isPlayer: () => false },
    insurgencyOf: (id: number) => s.views.get(id) ?? null,
    insurgencies: () => s.views.values(),
    x: (t: number) => t % 200,
    y: (t: number) => Math.floor(t / 200),
    isLand: () => true,
    owner: (t: number) => (t === 7 ? players[ME] : players[RAIDER]),
  } as unknown as GameView;
  return { s, game };
}

describe("ResistanceCommand", () => {
  let panel: ResistanceCommand;
  let bus: EventBus;
  let env: Env;
  let sent: object[];
  let requests: PickRequest[];
  let cancelled: number;

  const q = <T extends Element>(sel: string) => panel.querySelector<T>(sel);
  const qa = (sel: string) => [...panel.querySelectorAll<HTMLElement>(sel)];
  const text = (sel: string) =>
    q(sel)?.textContent?.replace(/\s+/g, " ").trim();
  const step = async (ticks = 0) => {
    env.s.ticks += ticks;
    panel.tick();
    await panel.updateComplete;
  };
  const click = async (sel: string) => {
    q<HTMLElement>(sel)!.click();
    await panel.updateComplete;
  };

  beforeEach(async () => {
    vi.useFakeTimers();
    try {
      localStorage.clear();
    } catch {
      // not available: the panel copes
    }
    window.innerWidth = 1280;
    env = makeEnv();
    bus = new EventBus();
    sent = [];
    requests = [];
    cancelled = 0;
    for (const E of [
      SendResistanceRecruitIntentEvent,
      SendResistanceBaseIntentEvent,
      SendResistanceUprisingIntentEvent,
      SendResistanceIntelIntentEvent,
      SendSuppressRegionIntentEvent,
    ]) {
      bus.on(E as never, ((e: object) => sent.push(e)) as never);
    }
    panel = document.createElement("resistance-command") as ResistanceCommand;
    panel.game = env.game;
    panel.eventBus = bus;
    panel.picker = {
      mode: null,
      begin: (r: PickRequest) => requests.push(r),
      cancel: () => cancelled++,
    } as never;
    panel.transformHandler = {} as never;
    document.body.appendChild(panel);
    panel.init();
  });

  afterEach(() => {
    panel.remove();
    vi.useRealTimers();
  });

  describe("for someone who has never seen it", () => {
    it("opens with the goal in plain words, one thing to do next, and the how-it-works card the first time", async () => {
      await step();
      expect(text('[data-rc="goal"]')).toBe("resistance.guide_goal");
      expect(q('[data-rc="help-card"]')).not.toBeNull();
      expect(text('[data-rc="help-card"]')).toContain(
        "resistance.guide_help_title",
      );
      // Three short steps first; the whole story is one click away.
      expect(qa('[data-rc="help-short"] li')).toHaveLength(3);
      expect(q('[data-rc="help-long"]')).toBeNull();
      await click('[data-rc="help-more"]');
      expect(qa('[data-rc="help-long"] li')).toHaveLength(6);
      await click('[data-rc="help-more"]');
      expect(q('[data-rc="help-long"]')).toBeNull();
      expect(q('[data-rc="next"]')!.getAttribute("data-step")).toBe("uprising");
      expect(text('[data-rc="next"]')).toContain(
        "resistance.guide_step_uprising",
      );
    });

    it("says the goal differently for a player with no land", async () => {
      env.s.views.set(
        ME,
        view({ phase: InsurgencyPhase.Limbo, limboDeadline: 100 + 900 }),
      );
      await step();
      expect(text('[data-rc="goal"]')).toBe("resistance.guide_goal_limbo");
    });

    it("the how-it-works card closes, stays closed on the next visit, and comes back from the help link", async () => {
      await step();
      await click('[data-rc="help-close"]');
      expect(q('[data-rc="help-card"]')).toBeNull();
      expect(localStorage.getItem("resistancePanel.helpSeen")).toBe("1");
      // A new panel (the next match, a reload): it does not open by itself.
      panel.remove();
      panel = document.createElement("resistance-command") as ResistanceCommand;
      panel.game = env.game;
      panel.eventBus = bus;
      panel.picker = { mode: null, begin() {}, cancel() {} } as never;
      panel.transformHandler = {} as never;
      document.body.appendChild(panel);
      panel.init();
      await step();
      expect(q('[data-rc="help-card"]')).toBeNull();
      await click('[data-rc="help"]');
      expect(q('[data-rc="help-card"]')).not.toBeNull();
    });

    it("the 'show me' button opens the order that is suggested, aimed at the area it names", async () => {
      await click('[data-rc="help-close"]').catch(() => undefined);
      env.s.views.set(
        ME,
        view({
          regions: [region({ id: 2, band: 3 }), region({ id: 5, band: 2 })],
        }),
      );
      await step();
      expect(q('[data-rc="next"]')!.getAttribute("data-step")).toBe("uprising");
      await click('[data-rc="do-next"]');
      // The uprising form is open, on the most restless area.
      expect(q(".rc-form")).not.toBeNull();
      expect(q('.rc-region[data-region="2"]')!.classList.contains("sel")).toBe(
        true,
      );
    });

    it("with nothing to press (only waiting to do), there is no button, only the advice", async () => {
      env.s.views.set(
        ME,
        view({
          funds: 0n,
          available: 0,
          intelReadyTick: 1_000_000,
          regions: [region({ band: 0 })],
        }),
      );
      await step();
      expect(q('[data-rc="next"]')!.getAttribute("data-step")).toBe("funds");
      expect(q('[data-rc="do-next"]')).toBeNull();
    });
  });

  it("draws nothing without a resistance", async () => {
    env.s.views.clear();
    await step();
    expect(panel.textContent?.trim()).toBe("");
  });

  it("waits a few seconds when a resistance has only just begun, so as not to cover the CRISIS announcement", async () => {
    env.s.ticks = 110; // 10 ticks after the start at 100
    await step();
    expect(q('[data-rc="mine"]')).toBeNull();
    await step(40);
    expect(q('[data-rc="mine"]')).not.toBeNull();
    // A client catching up (a reconnect) has no announcement to wait for.
    panel.remove();
  });

  it("shows the force, the purse, the clock and the regions", async () => {
    await step();
    expect(text(".rc-title")).toBe("resistance.title");
    expect(text(".rc-phase")).toBe("resistance.phase_field");
    // 7,200 ticks from the start at 100, now 1,000: 6,300 ticks = 630 s.
    expect(text(".rc-clock")).toContain("10:30");
    expect(text('[data-rc="ready"]')).toBe("10.0K");
    expect(text('[data-rc="funds"]')).toBe("400K");
    expect(q(".rc-meter")!.getAttribute("title")).toBe(
      "resistance.strength_title",
    );
    const rows = qa(".rc-region");
    expect(rows).toHaveLength(1);
    expect(rows[0].textContent).toContain("A1"); // region 0 on a 200 wide map
    expect(rows[0].querySelector(".rc-band")!.className).toContain("b3");
    expect(rows[0].textContent).toContain("resistance.band_volatile");
  });

  it("with no land, races the time to win a tile back", async () => {
    env.s.alive = false;
    env.s.views.set(
      ME,
      view({ phase: InsurgencyPhase.Limbo, limboDeadline: 1_300 }),
    );
    await step();
    expect(text(".rc-phase")).toBe("resistance.phase_limbo");
    expect(text(".rc-clock")).toContain("00:30");
    expect(text(".rc-clock")).toContain("resistance.time_limbo");
    expect(q(".rc-clock")!.classList.contains("warn")).toBe(true);
  });

  it("folds away, and remembers it", async () => {
    await step();
    expect(q(".rc-body")).not.toBeNull();
    await click(".rc-head");
    expect(q(".rc-body")).toBeNull();
    expect(localStorage.getItem("resistancePanel.collapsed")).toBe("1");
    await click(".rc-head");
    expect(q(".rc-body")).not.toBeNull();
  });

  describe("recruiting", () => {
    it("offers an amount, prices it, and sends the engine's units on confirm", async () => {
      await step();
      await click('[data-order="recruit"]');
      const form = q('[data-form="recruit"]')!;
      expect(form).not.toBeNull();
      const slider = form.querySelector<HTMLInputElement>("input[type=range]")!;
      // The purse could buy 20,000 (400,000 gold at 20 each); the capacity left allows 10,000.
      expect(Number(slider.min)).toBe(500);
      expect(Number(slider.max)).toBe(10_000);
      slider.value = "1000";
      slider.dispatchEvent(new Event("input"));
      await panel.updateComplete;
      expect(form.textContent).toContain("20.0K"); // 1,000 troops cost 20,000 gold
      await click('[data-rc="confirm"]');
      expect(sent).toHaveLength(1);
      expect(sent[0]).toBeInstanceOf(SendResistanceRecruitIntentEvent);
      expect((sent[0] as SendResistanceRecruitIntentEvent).troops).toBe(10_000);
      // The form closes: there is nothing to send twice.
      expect(q('[data-form="recruit"]')).toBeNull();
    });

    it("cancel sends nothing", async () => {
      await step();
      await click('[data-order="recruit"]');
      await click('[data-rc="cancel"]');
      expect(q('[data-form="recruit"]')).toBeNull();
      expect(sent).toEqual([]);
    });

    it("is unavailable, with the reason, when nothing can be bought", async () => {
      env.s.views.set(ME, view({ funds: 0n }));
      await step();
      const button = q<HTMLButtonElement>('[data-order="recruit"]')!;
      expect(button.disabled).toBe(true);
      expect(button.title).toBe("resistance.block_funds");
      expect(button.textContent).toContain("resistance.block_funds");
    });
  });

  describe("an uprising", () => {
    it("asks which region and how many, says it can fail, and sends on confirm", async () => {
      await step();
      await click('[data-order="uprising"]');
      const form = q('[data-form="uprising"]')!;
      expect(form.textContent).toContain("resistance.form_uprising_text");
      expect(form.textContent).toContain("resistance.form_uprising_nobase");
      const slider = form.querySelector<HTMLInputElement>("input[type=range]")!;
      slider.value = "2000";
      slider.dispatchEvent(new Event("input"));
      await panel.updateComplete;
      await click('[data-rc="confirm"]');
      expect(sent).toHaveLength(1);
      const order = sent[0] as SendResistanceUprisingIntentEvent;
      expect(order).toBeInstanceOf(SendResistanceUprisingIntentEvent);
      expect(order.region).toBe(0);
      expect(order.troops).toBe(20_000);
    });

    it("is unavailable while no region is restless enough", async () => {
      env.s.views.set(ME, view({ regions: [region({ band: 1 })] }));
      await step();
      const button = q<HTMLButtonElement>('[data-order="uprising"]')!;
      expect(button.disabled).toBe(true);
      expect(button.title).toBe("resistance.block_unrest");
    });

    it("drops out by itself when it stops making sense", async () => {
      await step();
      await click('[data-order="uprising"]');
      expect(q('[data-form="uprising"]')).not.toBeNull();
      env.s.views.set(ME, view({ funds: 0n }));
      await step();
      expect(q('[data-form="uprising"]')).toBeNull();
    });
  });

  describe("a base", () => {
    it("is chosen on the map, then confirmed", async () => {
      await step();
      await click('[data-order="base"]');
      expect(requests).toHaveLength(1);
      const request = requests[0];
      expect(request.mode).toBe("resistance_base");
      expect(request.hint).toBe("resistance.pick_base");
      // Tile 7 is the player's own; tile 400 is the raider's, in region 0.
      expect(request.validate(7)).toBe("resistance.pick_not_enemy");
      expect(request.validate(400)).toBeNull();
      request.onPick(400);
      await panel.updateComplete;
      expect(q('[data-form="base"]')).not.toBeNull();
      await click('[data-rc="confirm"]');
      expect(sent).toHaveLength(1);
      expect(sent[0]).toBeInstanceOf(SendResistanceBaseIntentEvent);
      expect((sent[0] as SendResistanceBaseIntentEvent).tile).toBe(400);
    });

    it("says why a tile will not do", async () => {
      // Region 0 is calm; region 2 (x 64 to 95, y under 32) is restless and free.
      env.s.views.set(
        ME,
        view({ regions: [region({ band: 0 }), region({ id: 2 })] }),
      );
      await step();
      await click('[data-order="base"]');
      const request = requests[0];
      expect(request.validate(400)).toBe("resistance.block_unrest");
      expect(request.validate(5 * 200 + 70)).toBeNull();
      // Region 11 is not land the player held when the capital fell.
      expect(request.validate(40 * 200 + 150)).toBe(
        "resistance.pick_not_national",
      );
    });
  });

  it("buys intelligence, and shows what it learned", async () => {
    await step();
    await click('[data-order="intel"]');
    await click('[data-rc="confirm"]');
    expect(sent[0]).toBeInstanceOf(SendResistanceIntelIntentEvent);
    expect((sent[0] as SendResistanceIntelIntentEvent).region).toBe(0);

    env.s.views.set(
      ME,
      view({
        intel: [
          {
            region: 0,
            tick: env.s.ticks - 100,
            unrest: 61,
            garrison: 120_000,
            occupier: RAIDER,
          },
        ],
        intelReadyTick: env.s.ticks + 300,
      }),
    );
    await step();
    expect(text(".rc-region")).toContain("resistance.intel_line");
    // The next report has to wait.
    expect(q<HTMLButtonElement>('[data-order="intel"]')!.disabled).toBe(true);
    // Once stale, only the band can be trusted.
    await step(1_000);
    expect(text(".rc-region")).toContain("resistance.intel_stale");
  });

  it("lists what is under way", async () => {
    env.s.views.set(
      ME,
      view({
        pending: [{ troops: 5_000, arrives: env.s.ticks + 210 }],
        bases: [{ id: 1, region: 0, tile: 400, integrity: 80 }],
        operations: [
          {
            id: 2,
            region: 0,
            committed: 30_000,
            troops: 21_000,
            startTick: 900,
          },
        ],
      }),
    );
    await step();
    const lines = qa('[data-rc="under-way"] li').map((l) => l.textContent);
    expect(lines).toEqual([
      "resistance.recruits_line",
      "resistance.base_line",
      "resistance.uprising_line",
    ]);
  });

  describe("when it ends", () => {
    it("says so once, and goes away when dismissed", async () => {
      await step();
      env.s.views.set(
        ME,
        view({ phase: InsurgencyPhase.Ended, endReason: "limbo_expired" }),
      );
      await step();
      expect(q('[data-rc="mine"]')).toBeNull();
      expect(text('[data-rc="ended"]')).toContain(
        "resistance.ended_limbo_expired",
      );
      await click('[data-rc="ended"] button');
      expect(q('[data-rc="ended"]')).toBeNull();
      // It does not come back on the next tick.
      await step(10);
      expect(q('[data-rc="ended"]')).toBeNull();
    });

    it("goes by itself after a while, and cancels a pick that was under way", async () => {
      await step();
      env.s.views.set(
        ME,
        view({ phase: InsurgencyPhase.Ended, endReason: "exhausted" }),
      );
      await step();
      expect(cancelled).toBeGreaterThan(0);
      expect(q('[data-rc="ended"]')).not.toBeNull();
      await vi.advanceTimersByTimeAsync(15_100);
      await panel.updateComplete;
      expect(q('[data-rc="ended"]')).toBeNull();
    });

    it("shows nothing for an end that was over before the client caught up", async () => {
      env.s.catchingUp = true;
      env.s.views.set(
        ME,
        view({ phase: InsurgencyPhase.Ended, endReason: "exhausted" }),
      );
      await step();
      expect(q('[data-rc="ended"]')).toBeNull();
    });
  });

  describe("the occupier's side", () => {
    function occupying(band = 3) {
      env.s.views.clear();
      env.s.views.set(3, {
        ...view({ owner: 3 }),
        regions: [region({ id: 4, band, occupier: ME })],
      });
    }

    it("lists the regions of a resistance that the player holds", async () => {
      occupying();
      await step();
      const row = q('[data-occupied="3:4"]')!;
      expect(row).not.toBeNull();
      expect(row.textContent).toContain("Alice");
      expect(row.querySelector(".rc-band")!.className).toContain("b3");
      // They have no resistance of their own.
      expect(q('[data-rc="mine"]')).toBeNull();
    });

    it("asks twice before sending troops, and the second click must be soon enough", async () => {
      occupying();
      await step();
      const button = () => q<HTMLButtonElement>('[data-rc="suppress"]')!;
      expect(button().textContent).toContain("resistance.suppress_sub");
      await click('[data-rc="suppress"]');
      expect(sent).toEqual([]);
      expect(button().textContent).toContain("resistance.suppress_confirm");
      // Too slow: it forgets, and asks again.
      await vi.advanceTimersByTimeAsync(4_100);
      await panel.updateComplete;
      expect(button().textContent).toContain("resistance.suppress_sub");
      await click('[data-rc="suppress"]');
      await click('[data-rc="suppress"]');
      expect(sent).toHaveLength(1);
      const order = sent[0] as SendSuppressRegionIntentEvent;
      expect(order).toBeInstanceOf(SendSuppressRegionIntentEvent);
      expect(order.region).toBe(4);
      expect(order.target.id()).toBe("alice-id");
    });

    it("cannot send what the army cannot spare, and says so", async () => {
      occupying();
      env.s.army = 5_000;
      await step();
      const button = q<HTMLButtonElement>('[data-rc="suppress"]')!;
      expect(button.disabled).toBe(true);
      expect(button.title).toBe("resistance.suppress_block_troops");
    });

    it("shows a suppression under way instead of the button", async () => {
      occupying();
      env.s.views.get(3)!.suppressions = [
        { region: 4, occupier: ME, endTick: env.s.ticks + 300 },
      ];
      await step();
      expect(q('[data-rc="suppress"]')).toBeNull();
      expect(text(".busy")).toContain("resistance.suppressing");
    });

    it("is not shown for a resistance that is over", async () => {
      occupying();
      env.s.views.get(3)!.phase = InsurgencyPhase.Ended;
      await step();
      expect(q('[data-rc="occupier"]')).toBeNull();
    });
  });

  it("takes no part in the map: the panel is a fixed layer the player can ignore", async () => {
    await step();
    expect(getComputedStyle(q(".rc")!).position).toBe("fixed");
  });
});
