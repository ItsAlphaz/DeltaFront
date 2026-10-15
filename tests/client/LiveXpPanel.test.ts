import { GameType } from "@openfront/engine-api/game/GameTypes";
import { GameUpdateType } from "@openfront/engine-api/game/GameUpdates";
import type { LiveXpResponse } from "@openfront/shared/ApiSchemas";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/client/Utils", () => ({
  translateText: (key: string, params?: Record<string, string | number>) =>
    params ? `${key}:${JSON.stringify(params)}` : key,
}));

import "../../src/client/hud/layers/LiveXpPanel";
import { LiveXpPanel } from "../../src/client/hud/layers/LiveXpPanel";
import { readPendingXp } from "../../src/client/PendingXpStore";
import { LIVE_XP_POLL_MS } from "../../src/client/ProgressionApi";

// The player's XP in the match they are playing, in a corner of the HUD. The
// panel reads what the account API worked out; it works out nothing itself.

const GAME_ID = "gLIVE0001";

const live = (over: Partial<LiveXpResponse> = {}): LiveXpResponse =>
  ({
    gameId: GAME_ID,
    status: "live",
    mode: "full",
    reason: null,
    total: 75,
    breakdown: {
      leftEarly: false,
      played: 50,
      time: 0,
      placement: 0,
      win: 0,
      eliminations: 25,
      eliminationCount: 1,
      firstGame: 0,
      firstWin: 0,
      feats: 0,
      subtotal: 75,
      gamePermille: 1000,
      repeatPermille: 1000,
      subscriberPermille: 1000,
      playerCount: 8,
      capped: false,
      softCapped: false,
      total: 75,
    },
    pending: ["placement", "victory", "challenges", "season"],
    alive: true,
    winner: false,
    ...over,
  }) as LiveXpResponse;

interface Opts {
  alive?: boolean;
  spawned?: boolean;
  spectator?: boolean;
  replay?: boolean;
  gameType?: GameType;
  win?: boolean;
}
function makeGame(opts: Opts = {}) {
  const state = { ...opts };
  return {
    state,
    gameID: () => GAME_ID,
    config: () => ({
      isReplay: () => state.replay ?? false,
      gameConfig: () => ({ gameType: state.gameType ?? GameType.Public }),
    }),
    myPlayer: () =>
      state.spectator
        ? null
        : {
            isAlive: () => state.alive ?? true,
            hasSpawned: () => state.spawned ?? true,
          },
    updatesSinceLastTick: () => ({
      [GameUpdateType.Win]: state.win ? [{ winner: ["player", "me"] }] : [],
    }),
  };
}

let panel: LiveXpPanel;
let now = 1_000_000;
const load = vi.fn();
const account = vi.fn();

async function mount(opts: Opts = {}) {
  panel?.remove();
  const game = makeGame(opts);
  panel = document.createElement("live-xp-panel") as LiveXpPanel;
  panel.game = game as never;
  panel.load = load;
  panel.account = account;
  panel.now = () => now;
  document.body.appendChild(panel);
  await panel.updateComplete;
  return game;
}
/** The figure eases up to the amount: let it arrive. */
async function figure() {
  await vi.advanceTimersByTimeAsync(1_000);
  await (q("live-xp-card") as unknown as { updateComplete: Promise<unknown> })
    .updateComplete;
}
/** One tick of the game, and the work it starts. */
async function tick() {
  panel.tick();
  await vi.advanceTimersByTimeAsync(0);
  await panel.updateComplete;
}
const q = (sel: string) => panel.querySelector<HTMLElement>(sel);

beforeEach(() => {
  vi.useFakeTimers();
  load.mockReset().mockResolvedValue({ status: "ok", data: live() });
  account.mockReset().mockResolvedValue({
    kind: "signed_in",
    me: { player: { progress: { level: 1 }, publicId: "me" } },
  });
  now = 1_000_000;
  window.localStorage.removeItem("df.pendingXp");
});
afterEach(() => {
  panel?.remove();
  vi.useRealTimers();
});

describe("when it shows", () => {
  it("draws the XP once the account is known and the API has a preview", async () => {
    await mount();
    await tick(); // decides
    await tick(); // polls
    expect(load).toHaveBeenCalledWith(GAME_ID);
    expect(q("[data-live-xp-panel]")).not.toBeNull();
    await figure();
    expect(q("live-xp-card")!.textContent).toContain('"xp":"75"');
  });

  it("draws nothing before spawning", async () => {
    await mount({ spawned: false });
    await tick();
    await tick();
    expect(load).not.toHaveBeenCalled();
    expect(q("[data-live-xp-panel]")).toBeNull();
  });

  it.each([
    ["singleplayer", { gameType: GameType.Singleplayer }],
    ["a replay", { replay: true }],
  ] as [string, Opts][])("never in %s", async (_name, opts) => {
    await mount(opts);
    await tick();
    await tick();
    expect(account).not.toHaveBeenCalled();
    expect(load).not.toHaveBeenCalled();
    expect(q("[data-live-xp-panel]")).toBeNull();
  });

  it("never for a spectator, who has no XP of their own", async () => {
    await mount({ spectator: true });
    await tick();
    await tick();
    expect(load).not.toHaveBeenCalled();
    expect(q("[data-live-xp-panel]")).toBeNull();
  });

  it("never signed out, and never without progression", async () => {
    account.mockResolvedValue({ kind: "signed_out" });
    await mount();
    await tick();
    await tick();
    expect(load).not.toHaveBeenCalled();
    account.mockResolvedValue({
      kind: "signed_in",
      me: { player: { publicId: "me" } },
    });
    await mount();
    await tick();
    await tick();
    expect(load).not.toHaveBeenCalled();
    expect(q("[data-live-xp-panel]")).toBeNull();
  });

  it("stops asking when the API says it is not available", async () => {
    load.mockResolvedValue({ status: "unavailable" });
    await mount();
    await tick();
    await tick();
    expect(q("[data-live-xp-panel]")).toBeNull();
    now += LIVE_XP_POLL_MS * 3;
    await tick();
    await tick();
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("shows nothing for a game that pays nothing", async () => {
    load.mockResolvedValue({
      status: "ok",
      data: live({
        status: "none",
        reason: "ranked",
        total: 0,
        breakdown: null,
      }),
    });
    await mount();
    await tick();
    await tick();
    expect(q("[data-live-xp-panel]")).toBeNull();
  });

  it("is gone once the game is won: the end-of-game panel takes over", async () => {
    const game = await mount();
    await tick();
    await tick();
    expect(q("[data-live-xp-panel]")).not.toBeNull();
    game.state.win = true;
    await tick();
    expect(q("[data-live-xp-panel]")).toBeNull();
    // and it asks nothing more
    const calls = load.mock.calls.length;
    now += LIVE_XP_POLL_MS * 2;
    game.state.win = false;
    await tick();
    expect(load.mock.calls.length).toBe(calls);
  });
});

describe("how often it asks", () => {
  it("every five seconds, not on every tick", async () => {
    await mount();
    await tick();
    await tick();
    expect(load).toHaveBeenCalledTimes(1);
    for (let i = 0; i < 20; i++) await tick();
    expect(load).toHaveBeenCalledTimes(1);
    now += LIVE_XP_POLL_MS - 1;
    await tick();
    expect(load).toHaveBeenCalledTimes(1);
    now += 1;
    await tick();
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("never two at once", async () => {
    let release!: (v: unknown) => void;
    load.mockReturnValue(new Promise((r) => (release = r)));
    await mount();
    await tick();
    panel.tick();
    now += LIVE_XP_POLL_MS * 2;
    panel.tick();
    panel.tick();
    expect(load).toHaveBeenCalledTimes(1);
    release({ status: "ok", data: live() });
    await vi.advanceTimersByTimeAsync(0);
  });

  it("is throttled to once a second by the game loop", () => {
    expect(new LiveXpPanel().getTickIntervalMs()).toBe(1_000);
  });

  it("shows the newest figure", async () => {
    await mount();
    await tick();
    await tick();
    load.mockResolvedValue({ status: "ok", data: live({ total: 100 }) });
    now += LIVE_XP_POLL_MS;
    await tick();
    await vi.advanceTimersByTimeAsync(1_000);
    await panel.updateComplete;
    expect(q("live-xp-card")!.textContent).toContain('"xp":"100"');
  });

  it("keeps the last figure through a failed read", async () => {
    await mount();
    await tick();
    await tick();
    load.mockResolvedValue({ status: "none" });
    now += LIVE_XP_POLL_MS;
    await tick();
    await tick();
    expect(q("[data-live-xp-panel]")).not.toBeNull();
  });
});

describe("what it says", () => {
  it("Match XP while playing, collapsed to the figure", async () => {
    await mount();
    await tick();
    await tick();
    const card = q("live-xp-card") as unknown as { summary: boolean };
    expect(card.summary).toBe(true);
    expect(q("[data-live-xp-panel]")!.getAttribute("data-live-status")).toBe(
      "live",
    );
    expect(panel.textContent).not.toContain("progression.live_note_result");
  });

  it("opens to the lines behind it, and closes again", async () => {
    await mount();
    await tick();
    await tick();
    const button = q("button")!;
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(button.getAttribute("aria-label")).toBe("progression.live_expand");
    button.click();
    await panel.updateComplete;
    await (q("live-xp-card") as unknown as { updateComplete: Promise<unknown> })
      .updateComplete;
    expect(button.getAttribute("aria-expanded")).toBe("true");
    expect(button.getAttribute("aria-label")).toBe("progression.live_collapse");
    expect(panel.textContent).toContain("progression.live_note_result");
    expect(
      panel.querySelectorAll("[data-live-xp-line]").length,
    ).toBeGreaterThan(0);
    button.click();
    await panel.updateComplete;
    expect((q("live-xp-card") as unknown as { summary: boolean }).summary).toBe(
      true,
    );
  });

  it("pending once the player is out, from their own screen at once", async () => {
    const game = await mount();
    await tick();
    await tick();
    game.state.alive = false;
    await tick();
    expect(q("[data-live-xp-panel]")!.getAttribute("data-live-status")).toBe(
      "pending",
    );
    expect(panel.textContent).toContain("progression.live_pending_amount");
  });

  it("forfeited when the API says the player left before the result", async () => {
    load.mockResolvedValue({
      status: "ok",
      data: live({
        status: "forfeited",
        total: 0,
        breakdown: null,
        reason: "left_early",
        pending: [],
      }),
    });
    await mount();
    await tick();
    await tick();
    expect(q("[data-live-xp-panel]")!.getAttribute("data-live-status")).toBe(
      "forfeited",
    );
  });

  it("the panel takes no clicks except its own button, so play is never blocked", async () => {
    await mount();
    await tick();
    await tick();
    expect(q("[data-live-xp-panel]")!.className).toContain(
      "pointer-events-auto",
    );
    expect(q("[data-live-xp-panel]")!.className).toContain("w-64");
  });
});

describe("it does not work anything out", () => {
  it("shows the API's figure whatever the player's own game says", async () => {
    // a player's screen that shows kills, a win and a place changes nothing
    const game = await mount();
    (game as never as { myPlayer: () => unknown }).myPlayer = () => ({
      isAlive: () => true,
      hasSpawned: () => true,
      kills: () => 99,
      isWinner: () => true,
      place: () => 1,
    });
    await tick();
    await tick();
    await figure();
    expect(q("live-xp-card")!.textContent).toContain('"xp":"75"');
    expect(panel.textContent).not.toContain("99");
  });

  it("the only thing the client contributes is whether it is itself alive: the wording", async () => {
    const game = await mount({ alive: false });
    await tick();
    await tick();
    expect(q("[data-live-xp-panel]")!.getAttribute("data-live-status")).toBe(
      "pending",
    );
    // the amount is still the API's
    await figure();
    expect(q("live-xp-card")!.textContent).toContain('"xp":"75"');
    game.state.alive = true;
  });
});

describe("a game left behind", () => {
  it("is remembered while XP is at stake, so its result can be told later", async () => {
    await mount();
    await tick();
    await tick();
    expect(readPendingXp(now)?.gameId).toBe(GAME_ID);
  });

  it("not once the XP is forfeited: there is nothing to tell", async () => {
    load.mockResolvedValue({
      status: "ok",
      data: live({
        status: "forfeited",
        total: 0,
        breakdown: null,
        pending: [],
      }),
    });
    await mount();
    await tick();
    await tick();
    expect(window.localStorage.getItem("df.pendingXp")).toBeNull();
  });
});
