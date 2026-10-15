import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { getUserMe, fetchProgressionConfig, isLoggedIn } = vi.hoisted(() => ({
  getUserMe: vi.fn(),
  fetchProgressionConfig: vi.fn(),
  isLoggedIn: vi.fn(),
}));

vi.mock("../../../../src/client/Utils", () => ({
  translateText: (key: string, params?: Record<string, string | number>) =>
    params ? `${key}:${JSON.stringify(params)}` : key,
  getGamesPlayed: vi.fn(() => 10),
  isInIframe: vi.fn(() => false),
  homeHref: vi.fn(() => "/"),
  TUTORIAL_VIDEO_URL: "https://example.com/tutorial",
}));

vi.mock("../../../../src/client/Api", () => ({ getUserMe }));

vi.mock("../../../../src/client/Auth", () => ({
  getAuthHeader: vi.fn(async () => "Bearer test-token"),
  isLoggedIn,
}));

vi.mock("../../../../src/client/ApiBase", () => ({
  getApiBase: () => "https://api.test",
}));

// Only the config lookup is replaced: the poll and the XP fetch run for real
// against the stubbed fetch below.
vi.mock("../../../../src/client/ProgressionApi", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../../../src/client/ProgressionApi")
  >()),
  fetchProgressionConfig,
}));

vi.mock("../../../../src/client/Cosmetics", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../../../src/client/Cosmetics")
  >()),
  fetchCosmetics: vi.fn(async () => null),
  resolveCosmetics: vi.fn(() => []),
}));

vi.mock("../../../../src/client/CrazyGamesSDK", () => ({
  crazyGamesSDK: {
    happytime: vi.fn(),
    requestAd: vi.fn(),
    gameplayStop: vi.fn(),
    isOnCrazyGames: vi.fn(() => false),
    getUserProfile: vi.fn(async () => null),
  },
}));

import { GameType } from "@openfront/engine-api/game/GameTypes";
import { GameUpdateType } from "@openfront/engine-api/game/GameUpdates";
import { EventBus } from "@openfront/shared/EventBus";
// The game fetches the XP section when it starts and the Legend ceremony
// ahead of its moment; here both are loaded up front, as they are by the
// time a game ends.
import "../../../../src/client/components/GameXpPanel";
import type { GameXpPanel } from "../../../../src/client/components/GameXpPanel";
import "../../../../src/client/components/LegendCeremony";
import "../../../../src/client/hud/layers/WinModal";
import type { WinModal } from "../../../../src/client/hud/layers/WinModal";
import { SendSoloArchiveEvent } from "../../../../src/client/Transport";
import type { GameView } from "../../../../src/client/view";

const GAME_ID = "gXPTEST01";
const XP_URL = `https://api.test/users/@me/xp/${GAME_ID}`;
const LIVE_URL = `https://api.test/users/@me/xp/live/${GAME_ID}`;

// Progression on: /users/@me carries progress, level 1 before any XP.
const signedIn = {
  user: { email: "player@example.com" },
  player: {
    publicId: "me",
    progress: {
      prestige: 0,
      level: 1,
      xpInLevel: 0,
      xpForNext: 150,
      lifetimeXp: 0,
      legend: false,
      canPrestige: false,
    },
  },
};
const anonymous = { user: {}, player: { publicId: "anon" } };

function eligible(overrides: Record<string, unknown> = {}) {
  return {
    gameId: GAME_ID,
    eligible: true,
    breakdown: {
      leftEarly: false,
      played: 50,
      time: 20,
      placement: 0,
      win: 100,
      firstGame: 0,
      feats: 0,
      subtotal: 170,
      gamePermille: 1250,
      subscriberPermille: 1000,
      total: 212,
    },
    before: { prestige: 0, level: 4, xpInLevel: 300, xpForNext: 400 },
    after: {
      prestige: 0,
      level: 4,
      xpInLevel: 512,
      xpForNext: 400,
      lifetimeXp: 2000,
      legend: false,
      canPrestige: false,
    },
    levelsReached: [],
    ...overrides,
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// Answers the XP endpoint from a queue; once it runs dry, the last answer
// repeats. The preview of a running game (the live endpoint) has its own queue,
// not found unless a test says otherwise. Anything else is a test bug.
function stubXpEndpoint(
  answers: (() => Response)[],
  live: (() => Response)[] = [() => new Response("", { status: 404 })],
) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === LIVE_URL) {
      const next = live.length > 1 ? live.shift()! : live[0];
      return next();
    }
    if (url !== XP_URL) throw new Error(`unexpected fetch ${url}`);
    const next = answers.length > 1 ? answers.shift()! : answers[0];
    return next();
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

// The calls for the stored game's XP (not the preview of a running one).
const storedCalls = (fetchMock: ReturnType<typeof vi.fn>) =>
  fetchMock.mock.calls.filter(([url]) => String(url) === XP_URL);
const liveCalls = (fetchMock: ReturnType<typeof vi.fn>) =>
  fetchMock.mock.calls.filter(([url]) => String(url) === LIVE_URL);

const notFound = () => new Response("", { status: 404 });

function makeGame(opts: {
  ended: boolean;
  alive?: boolean;
  replay?: boolean;
  gameType?: GameType;
}) {
  const winUpdate = { winner: ["team", "Red"], allPlayersStats: {} };
  let delivered = false;
  return {
    gameID: () => GAME_ID,
    myPlayer: () => ({
      isAlive: () => opts.alive ?? true,
      hasSpawned: () => true,
      team: () => "Red",
      clientID: () => "me",
    }),
    inSpawnPhase: () => false,
    updatesSinceLastTick: () => {
      if (!opts.ended || delivered) return {};
      delivered = true;
      return { [GameUpdateType.Win]: [winUpdate] };
    },
    playerByClientID: () => undefined,
    config: () => ({
      gameConfig: () => ({
        rankedType: undefined,
        gameType: opts.gameType ?? GameType.Public,
      }),
      isReplay: () => opts.replay ?? false,
    }),
  } as unknown as GameView;
}

describe("WinModal XP section", () => {
  let modal: WinModal;

  beforeEach(() => {
    vi.useFakeTimers();
    getUserMe.mockResolvedValue(signedIn);
    isLoggedIn.mockResolvedValue(true);
    fetchProgressionConfig.mockResolvedValue({
      version: 1,
      maxLevel: 100,
      maxPrestige: 10,
      levels: [],
    });
    vi.spyOn(history, "replaceState").mockImplementation(() => {});
  });

  afterEach(() => {
    modal?.remove();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  async function mount(
    game: GameView,
    prepare?: (modal: WinModal) => void,
  ): Promise<void> {
    modal = document.createElement("win-modal") as WinModal;
    modal.game = game;
    modal.eventBus = new EventBus();
    prepare?.(modal);
    // Pin the promo slot to the pattern promo (the Steam wishlist one needs
    // ResizeObserver, which jsdom lacks).
    Object.assign(modal as unknown as { rand: number }, { rand: 0.75 });
    document.body.appendChild(modal);
    modal.tick();
    await settle();
  }

  async function settle(ms = 0): Promise<void> {
    await vi.advanceTimersByTimeAsync(ms);
    await modal.updateComplete;
    const panel = modal.querySelector<GameXpPanel>("game-xp-panel");
    await panel?.updateComplete;
  }

  function panel(): HTMLElement | null {
    return modal.querySelector<HTMLElement>("game-xp-panel [data-xp-panel]");
  }

  // The result animates in (a caption per XP source, the bar climbing).
  // Tapping skips to the end, as a player can.
  async function finishReveal(): Promise<void> {
    panel()?.click();
    await settle();
  }

  function xpState(): string {
    return panel()?.getAttribute("data-xp-state") ?? "hidden";
  }

  it("shows calculating while the game is processed, then the breakdown", async () => {
    const fetchMock = stubXpEndpoint([
      notFound,
      notFound,
      () => json(eligible()),
    ]);
    await mount(makeGame({ ended: true }));
    await finishReveal();

    expect(xpState()).toBe("calculating");
    expect(panel()!.textContent).toContain("progression.calculating");
    // Never a number while pending.
    expect(panel()!.textContent).not.toContain("progression.xp_total");

    // The first looks come every second.
    await settle(1_000);
    expect(xpState()).toBe("calculating");

    await settle(1_000);
    expect(xpState()).toBe("result");
    // First looks come every second, so the stored XP shows within a moment
    // of being stored: 3 answers by t=3s.
    expect(storedCalls(fetchMock)).toHaveLength(3);
    await finishReveal();
    const text = panel()!.textContent!;
    expect(text).toContain('progression.xp_total:{"xp":"212"}');
    // Non-zero lines only.
    const lines = [...panel()!.querySelectorAll("[data-xp-line]")].map((el) =>
      el.getAttribute("data-xp-line"),
    );
    expect(lines).toEqual(["played", "time", "win"]);
    // Only multipliers other than 1x.
    const multipliers = [
      ...panel()!.querySelectorAll("[data-xp-multiplier]"),
    ].map((el) => el.getAttribute("data-xp-multiplier"));
    expect(multipliers).toEqual(["game"]);
    // Shown like a group bonus: "+25% XP (GAME TYPE)".
    expect(text).toContain(
      'progression.bonus_line:{"percent":25,"source":"progression.multiplier_game"}',
    );
    expect(panel()!.querySelector("[data-xp-levelup]")).toBeNull();
    expect(panel()!.querySelector("[data-xp-left-early]")).toBeNull();
  });

  it("hides the section when the game is never processed in time", async () => {
    const fetchMock = stubXpEndpoint([notFound]);
    await mount(makeGame({ ended: true }));
    await finishReveal();
    expect(xpState()).toBe("calculating");

    // The game server replays a game before archiving it, so the wait is long.
    await settle(60_000);
    expect(xpState()).toBe("calculating");
    await settle(90_000);
    expect(xpState()).toBe("hidden");
    expect(modal.querySelector("[data-xp-panel]")).toBeNull();
    const calls = fetchMock.mock.calls.length;
    expect(calls).toBeGreaterThan(10);

    // And it stops asking.
    await settle(30_000);
    expect(fetchMock.mock.calls.length).toBe(calls);
  });

  it("shows one friendly line for an ineligible game", async () => {
    stubXpEndpoint([
      () => json({ gameId: GAME_ID, eligible: false, reason: "left_early" }),
    ]);
    await mount(makeGame({ ended: true }));
    await finishReveal();
    expect(xpState()).toBe("ineligible");
    expect(panel()!.textContent!.trim()).toBe(
      "progression.ineligible_left_early",
    );
  });

  it("falls back to a generic line for an unknown reason", async () => {
    stubXpEndpoint([
      () => json({ gameId: GAME_ID, eligible: false, reason: "new_rule" }),
    ]);
    await mount(makeGame({ ended: true }));
    await finishReveal();
    expect(panel()!.textContent!.trim()).toBe("progression.ineligible_generic");
  });

  it("tells a singleplayer match that was not verified so, in its own words", async () => {
    stubXpEndpoint([
      () => json({ gameId: GAME_ID, eligible: false, reason: "unverified" }),
    ]);
    await mount(makeGame({ ended: true, gameType: GameType.Singleplayer }));
    await finishReveal();
    expect(panel()!.textContent!.trim()).toBe(
      "progression.ineligible_solo_unverified",
    );
  });

  it("shows a reduced (private) game as earned XP with its reason, not as an ineligible game", async () => {
    stubXpEndpoint([
      () =>
        json(
          eligible({
            mode: "reduced",
            breakdown: {
              leftEarly: false,
              played: 100,
              time: 0,
              placement: 0,
              win: 0,
              eliminations: 25,
              eliminationCount: 1,
              firstGame: 0,
              firstWin: 0,
              feats: 0,
              subtotal: 125,
              gamePermille: 250,
              subscriberPermille: 1000,
              repeatPermille: 1000,
              playerCount: 0,
              capped: false,
              softCapped: false,
              reducedReason: "private_game",
              total: 31,
            },
          }),
        ),
    ]);
    await mount(makeGame({ ended: true, gameType: GameType.Private }));
    await finishReveal();
    expect(xpState()).toBe("result");
    expect(
      panel()!.querySelector('[data-xp-multiplier="reduced_private"]')
        ?.textContent,
    ).toContain("progression.multiplier_reduced_private");
    expect(panel()!.textContent).not.toContain("progression.ineligible");
  });

  it("still says a multiplayer game's results couldn't be verified", async () => {
    stubXpEndpoint([
      () => json({ gameId: GAME_ID, eligible: false, reason: "unverified" }),
    ]);
    await mount(makeGame({ ended: true, gameType: GameType.Public }));
    await finishReveal();
    expect(panel()!.textContent!.trim()).toBe(
      "progression.ineligible_unverified",
    );
  });
  it("explains a left-early forfeit", async () => {
    stubXpEndpoint([
      () =>
        json(
          eligible({
            breakdown: {
              ...eligible().breakdown,
              leftEarly: true,
              played: 0,
              placement: 0,
              win: 0,
              total: 20,
            },
          }),
        ),
    ]);
    await mount(makeGame({ ended: true }));
    await finishReveal();
    expect(xpState()).toBe("result");
    expect(
      panel()!.querySelector("[data-xp-left-early]")?.textContent,
    ).toContain("progression.left_early");
  });

  it("gives ordinary level-ups no card, just the caption and the badge", async () => {
    stubXpEndpoint([
      () =>
        json(
          eligible({
            before: { prestige: 0, level: 6, xpInLevel: 300, xpForNext: 400 },
            after: {
              ...eligible().after,
              level: 9,
              xpInLevel: 50,
              xpForNext: 600,
            },
            levelsReached: [
              { prestige: 0, level: 7 },
              { prestige: 0, level: 8 },
              { prestige: 0, level: 9 },
            ],
          }),
        ),
    ]);
    await mount(makeGame({ ended: true }));
    await finishReveal();
    expect(panel()!.querySelector("[data-xp-levelup]")).toBeNull();
    expect(panel()!.querySelector("[data-xp-caption]")!.textContent).toContain(
      'progression.level_reached:{"level":9}',
    );
    // The bar runs from the level the player is now on to the next one.
    const badgeLevel = (sel: string) =>
      (
        panel()!.querySelector(`${sel} level-badge`) as HTMLElement & {
          level: number;
        }
      ).level;
    expect(badgeLevel("[data-xp-current-badge]")).toBe(9);
    expect(badgeLevel("[data-xp-next-badge]")).toBe(10);
  });

  it("gives a milestone reached this game its own card", async () => {
    stubXpEndpoint([
      () =>
        json(
          eligible({
            before: { prestige: 0, level: 9, xpInLevel: 300, xpForNext: 330 },
            after: {
              ...eligible().after,
              level: 11,
              xpInLevel: 10,
              xpForNext: 370,
            },
            levelsReached: [
              { prestige: 0, level: 10 },
              { prestige: 0, level: 11 },
            ],
          }),
        ),
    ]);
    await mount(makeGame({ ended: true }));
    await finishReveal();
    // Passed 10 on the way to 11: the card is for 10, the milestone.
    const cards = panel()!.querySelectorAll("[data-xp-levelup]");
    expect(cards).toHaveLength(1);
    expect(cards[0].getAttribute("data-xp-milestone")).toBe("10");
    expect(cards[0].textContent).toContain("progression.new_milestone");
    expect(cards[0].textContent).toContain('progression.level:{"level":10}');
  });

  it("never shows a prestige change as a level-up", async () => {
    // A game can't prestige a player; an entry at another prestige is noise.
    stubXpEndpoint([
      () =>
        json(
          eligible({
            before: { prestige: 0, level: 5, xpInLevel: 0, xpForNext: 230 },
            levelsReached: [{ prestige: 1, level: 1 }],
          }),
        ),
    ]);
    await mount(makeGame({ ended: true }));
    await finishReveal();
    expect(xpState()).toBe("result");
    expect(panel()!.querySelector("[data-xp-levelup]")).toBeNull();
  });

  it("gives becoming a Legend its own moment", async () => {
    stubXpEndpoint([
      () =>
        json(
          eligible({
            before: {
              prestige: 10,
              level: 99,
              xpInLevel: 4400,
              xpForNext: 4510,
            },
            after: {
              ...eligible().after,
              prestige: 10,
              level: 100,
              xpInLevel: 0,
              xpForNext: 0,
              legend: true,
              lifetimeXp: 2106720,
            },
            levelsReached: [{ prestige: 10, level: 100 }],
          }),
        ),
    ]);
    await mount(makeGame({ ended: true }));
    await finishReveal();
    // The caption announces it; the card carries the lifetime XP.
    expect(panel()!.querySelector("[data-xp-caption]")?.textContent).toContain(
      "progression.legend_reached_title",
    );
    expect(panel()!.querySelector("[data-xp-legend]")?.textContent).toContain(
      "progression.legend_reached_body",
    );
    expect(panel()!.querySelector("[data-xp-levelup]")).toBeNull();
    // The end of the track: the crown on the left, no next level.
    const current = panel()!.querySelector(
      "[data-xp-current-badge] level-badge",
    ) as HTMLElement & { level: number; legend: boolean };
    expect(current.level).toBe(100);
    expect(current.legend).toBe(true);
    expect(panel()!.querySelector("[data-xp-next-badge]")).toBeNull();
  });

  describe("the Legend ceremony", () => {
    // P10 L99 -> 100: this game makes the player a Legend.
    const legendResult = () =>
      eligible({
        before: { prestige: 10, level: 99, xpInLevel: 4400, xpForNext: 4510 },
        after: {
          ...eligible().after,
          prestige: 10,
          level: 100,
          xpInLevel: 0,
          xpForNext: 0,
          legend: true,
          lifetimeXp: 2106720,
        },
        levelsReached: [{ prestige: 10, level: 100 }],
      });
    const ceremony = () =>
      document.body.querySelector<HTMLElement>("[data-legend-ceremony]");
    const revealing = () => panel()?.dataset.xpRevealing === "true";

    beforeEach(() => localStorage.clear());

    it("takes the level-100 moment full screen, then returns to the settled popup", async () => {
      stubXpEndpoint([() => json(legendResult())]);
      await mount(makeGame({ ended: true }));
      expect(xpState()).toBe("result");
      // The reveal plays up to level 100 first.
      let steps = 0;
      while (ceremony() === null && steps++ < 200) {
        expect(revealing()).toBe(true);
        await settle(50);
      }
      expect(ceremony()).not.toBeNull();
      // The popup rests on its final state behind it.
      expect(revealing()).toBe(false);
      expect(panel()!.querySelector("[data-xp-legend]")).not.toBeNull();
      expect(localStorage.getItem("legendCeremonySeen:me")).not.toBeNull();
      expect(ceremony()!.textContent).not.toContain("2,106,720");

      await settle(7000);
      expect(ceremony()!.dataset.beat).toBe("done");
      expect(
        ceremony()!.querySelector("[data-legend-line] b")!.textContent,
      ).toBe((2106720).toLocaleString());
      ceremony()!
        .querySelector<HTMLButtonElement>("[data-legend-continue]")!
        .click();
      await settle();
      expect(ceremony()).toBeNull();
      expect(xpState()).toBe("result");
      expect(revealing()).toBe(false);
      expect(document.activeElement).toBe(
        modal.querySelector('[data-win-action="keep"]'),
      );
    });

    it("plays it when the reveal is skipped before level 100", async () => {
      stubXpEndpoint([() => json(legendResult())]);
      await mount(makeGame({ ended: true }));
      await finishReveal();
      expect(ceremony()).not.toBeNull();
    });

    it("plays it once per account", async () => {
      localStorage.setItem("legendCeremonySeen:me", "1");
      stubXpEndpoint([() => json(legendResult())]);
      await mount(makeGame({ ended: true }));
      // The panel's own Legend moment plays instead.
      let sawCaption = false;
      for (let i = 0; i < 200 && revealing(); i++) {
        if (panel()!.querySelector("[data-xp-caption-legend]")) {
          sawCaption = true;
        }
        await settle(50);
      }
      expect(sawCaption).toBe(true);
      expect(ceremony()).toBeNull();
    });

    it("never for anything but the server's Legend result", async () => {
      // Waiting on the server: nothing yet.
      stubXpEndpoint([notFound, notFound, () => json(eligible())]);
      await mount(makeGame({ ended: true }));
      expect(xpState()).toBe("calculating");
      expect(ceremony()).toBeNull();
      // An ordinary result.
      await settle(6_000);
      await finishReveal();
      expect(xpState()).toBe("result");
      expect(ceremony()).toBeNull();
    });

    it("falls back to the panel's own Legend moment when the ceremony can't load", async () => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      stubXpEndpoint([() => json(legendResult())]);
      await mount(makeGame({ ended: true }), (m) => {
        m.loadLegendCeremony = () => Promise.reject(new Error("offline"));
      });
      let sawCaption = false;
      for (let i = 0; i < 200 && revealing(); i++) {
        if (panel()!.querySelector("[data-xp-caption-legend]")) {
          sawCaption = true;
        }
        await settle(50);
      }
      expect(sawCaption).toBe(true);
      expect(ceremony()).toBeNull();
      // Not marked seen: it never played.
      expect(localStorage.getItem("legendCeremonySeen:me")).toBeNull();
    });

    it("is fetched only for a player who could become a Legend", async () => {
      const load = vi.fn(
        () => import("../../../../src/client/components/LegendCeremony"),
      );
      stubXpEndpoint([() => json(eligible())]);
      await mount(makeGame({ ended: true }), (m) => {
        m.loadLegendCeremony = load;
      });
      await finishReveal();
      expect(load).not.toHaveBeenCalled();
      modal.remove();

      // On the last prestige run: fetched before the result is in.
      getUserMe.mockResolvedValue({
        ...signedIn,
        player: {
          ...signedIn.player,
          progress: { ...signedIn.player.progress, prestige: 10, level: 99 },
        },
      });
      stubXpEndpoint([notFound]);
      await mount(makeGame({ ended: true }), (m) => {
        m.loadLegendCeremony = load;
      });
      expect(xpState()).toBe("calculating");
      expect(load).toHaveBeenCalledTimes(1);
    });

    it("goes by the config's last prestige rank, the client's only without one", async () => {
      const load = vi.fn(
        () => import("../../../../src/client/components/LegendCeremony"),
      );
      const atPrestige = (prestige: number) =>
        getUserMe.mockResolvedValue({
          ...signedIn,
          player: {
            ...signedIn.player,
            progress: { ...signedIn.player.progress, prestige, level: 99 },
          },
        });
      const mountAt = async (prestige: number) => {
        atPrestige(prestige);
        stubXpEndpoint([notFound]);
        await mount(makeGame({ ended: true }), (m) => {
          m.loadLegendCeremony = load;
        });
      };
      fetchProgressionConfig.mockResolvedValue({
        version: 1,
        maxLevel: 100,
        maxPrestige: 12,
        levels: [],
      });

      // Ranks left to earn on the server's ladder: not the last run.
      await mountAt(10);
      expect(load).not.toHaveBeenCalled();
      modal.remove();

      await mountAt(12);
      expect(load).toHaveBeenCalledTimes(1);
      modal.remove();

      // No config: the client's own ladder.
      fetchProgressionConfig.mockResolvedValue(false);
      await mountAt(10);
      expect(load).toHaveBeenCalledTimes(2);
    });

    it("never for a player who was a Legend already", async () => {
      const already = legendResult();
      stubXpEndpoint([
        () =>
          json({
            ...already,
            before: { prestige: 10, level: 100, xpInLevel: 0, xpForNext: 0 },
            levelsReached: [],
          }),
      ]);
      await mount(makeGame({ ended: true }));
      await finishReveal();
      expect(ceremony()).toBeNull();
    });
  });

  it("shows a player who was already a Legend as one throughout the reveal", async () => {
    stubXpEndpoint([
      () =>
        json(
          eligible({
            before: { prestige: 10, level: 100, xpInLevel: 0, xpForNext: 0 },
            after: {
              ...eligible().after,
              prestige: 10,
              level: 100,
              xpInLevel: 0,
              xpForNext: 0,
              legend: true,
              lifetimeXp: 2200000,
            },
            levelsReached: [],
          }),
        ),
    ]);
    await mount(makeGame({ ended: true }));
    const currentLegend = () =>
      (
        panel()!.querySelector("[data-xp-current-badge] level-badge") as
          | (HTMLElement & { legend: boolean; level: number })
          | null
      )?.legend;
    expect(panel()!.getAttribute("data-xp-revealing")).toBe("true");
    expect(currentLegend()).toBe(true);
    // And every frame of the reveal after it, not just the first.
    for (let i = 0; i < 400; i++) {
      await settle(50);
      if (panel()?.getAttribute("data-xp-revealing") !== "true") break;
      expect(currentLegend()).toBe(true);
    }
    expect(currentLegend()).toBe(true);
    // Not this game's moment: no Legend card or caption.
    expect(panel()!.querySelector("[data-xp-legend]")).toBeNull();
    expect(panel()!.querySelector("[data-xp-caption-legend]")).toBeNull();
  });

  it("reveals the XP a source at a time, then settles on the award", async () => {
    stubXpEndpoint([() => json(eligible())]);
    await mount(makeGame({ ended: true }));
    expect(xpState()).toBe("result");
    expect(panel()!.getAttribute("data-xp-revealing")).toBe("true");
    // Nothing counted yet. Every card's slot is laid out from the start,
    // hidden, so the panel never changes size.
    expect(panel()!.querySelector("[data-xp-total]")!.textContent).toContain(
      '"xp":"0"',
    );
    const hiddenSlots = () =>
      panel()!.querySelectorAll("[data-xp-slot-hidden]").length;
    // A card for each of the three sources; the game-type multiplier is a
    // bonus line under the counter, not a card.
    expect(panel()!.querySelectorAll("[data-xp-card]")).toHaveLength(3);
    expect(panel()!.querySelector("[data-xp-bonuses]")).not.toBeNull();
    expect(hiddenSlots()).toBe(4);

    // The captions roll through the sources in order, and each source's card
    // lands as its caption finishes.
    const captions: string[] = [];
    const hiddenCounts: number[] = [];
    for (let i = 0; i < 40; i++) {
      await settle(100);
      const text =
        panel()?.querySelector("[data-xp-caption]")?.textContent ?? "";
      const last = captions[captions.length - 1];
      if (text.trim() !== "" && text !== last) captions.push(text);
      if (panel()?.getAttribute("data-xp-revealing") !== "true") break;
      hiddenCounts.push(hiddenSlots());
    }
    const order = ["line_played", "line_time", "line_win"].map((key) =>
      captions.findIndex((c) => c.includes("progression." + key)),
    );
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    // One at a time: 4 hidden, then 3, 2, and the bonus line last.
    expect([...new Set(hiddenCounts)].slice(0, 4)).toEqual([4, 3, 2, 1]);
    // The multiplier gets its own caption; the award never does, it is the
    // counter's number.
    expect(
      captions.some((c) => c.includes("progression.multiplier_game")),
    ).toBe(true);
    expect(captions.some((c) => c.includes('"xp":"212"'))).toBe(false);

    // Run it out: the counter lands on the award and every card is up.
    await settle(20_000);
    expect(panel()!.getAttribute("data-xp-revealing")).toBeNull();
    expect(panel()!.querySelector("[data-xp-total]")!.textContent).toContain(
      '"xp":"212"',
    );
    expect(hiddenSlots()).toBe(0);
  });

  it("applies a multiplier to the cards, which add up to the award", async () => {
    stubXpEndpoint([() => json(eligible())]);
    await mount(makeGame({ ended: true }));
    const values = () =>
      [...panel()!.querySelectorAll("[data-xp-card]")]
        .filter((c) => c.querySelector("[data-xp-line]"))
        .map(
          (c) =>
            JSON.parse(
              c
                .querySelector("[data-xp-card-value]")!
                .textContent!.trim()
                .replace("progression.xp_total:", ""),
            ).xp,
        );
    // Face values while the sources come in.
    expect(values()).toEqual(["50", "20", "100"]);
    // The boost wipes across the cards, turning them over first to last:
    // at some point the first card is boosted while the last isn't yet.
    let wiped = false;
    let inOrder = false;
    for (let i = 0; i < 200; i++) {
      await settle(50);
      if (panel()!.querySelector(".xp-card-wipe")) wiped = true;
      const v = values();
      if (v[0] !== "50" && v[2] === "100") inOrder = true;
      if (panel()?.getAttribute("data-xp-revealing") !== "true") break;
    }
    expect(wiped).toBe(true);
    expect(inOrder).toBe(true);
    // 170 x1.25, awarded as 212, split across the cards.
    expect(values()).toEqual(["62", "25", "125"]);
  });

  it("keeps no space for a milestone or a bonus until the reveal gets to it", async () => {
    stubXpEndpoint([
      () =>
        json(
          eligible({
            before: { prestige: 0, level: 9, xpInLevel: 300, xpForNext: 330 },
            after: {
              ...eligible().after,
              level: 10,
              xpInLevel: 182,
              xpForNext: 370,
            },
            levelsReached: [{ prestige: 0, level: 10 }],
          }),
        ),
    ]);
    await mount(makeGame({ ended: true }));
    const space = (sel: string) =>
      panel()!
        .querySelector(sel)!
        .closest("[data-xp-collapsible]")!
        .getAttribute("data-xp-collapsible");
    // Closed at the start: nothing hints at what is coming.
    expect(space("[data-xp-levelup]")).toBe("closed");
    expect(space("[data-xp-bonuses]")).toBe("closed");
    // The milestone opens its space when the bar reaches it, before the
    // bonus does.
    let milestoneFirst = false;
    for (let i = 0; i < 400; i++) {
      await settle(50);
      if (panel()?.getAttribute("data-xp-revealing") !== "true") break;
      if (
        space("[data-xp-levelup]") === "open" &&
        space("[data-xp-bonuses]") === "closed"
      ) {
        milestoneFirst = true;
      }
    }
    expect(milestoneFirst).toBe(true);
    expect(space("[data-xp-levelup]")).toBe("open");
    expect(space("[data-xp-bonuses]")).toBe("open");
  });

  it("shows a subscription tier's boost under its name, in its colours", async () => {
    stubXpEndpoint([
      () =>
        json(
          eligible({
            breakdown: {
              ...eligible().breakdown,
              gamePermille: 1000,
              subscriberPermille: 2000,
              total: 340,
            },
          }),
        ),
    ]);
    await mount(makeGame({ ended: true }));
    await finishReveal();
    const line = panel()!.querySelector("[data-xp-multiplier='subscriber']")!;
    expect(line.getAttribute("data-xp-tier")).toBe("sovereign");
    expect(line.textContent).toContain(
      'progression.bonus_line:{"percent":100,"source":"progression.multiplier_sovereign"}',
    );
    // Sovereign's gold, on the line and across the panel's boosted cards.
    expect(line.getAttribute("style")).toContain("--accent-a: #ffc713");
    expect(panel()!.getAttribute("style")).toContain("--accent-b: #ffde90");
  });

  it("shows an unknown subscriber boost as a plain subscriber bonus", async () => {
    stubXpEndpoint([
      () =>
        json(
          eligible({
            breakdown: {
              ...eligible().breakdown,
              gamePermille: 1000,
              subscriberPermille: 1200,
              total: 204,
            },
          }),
        ),
    ]);
    await mount(makeGame({ ended: true }));
    await finishReveal();
    const line = panel()!.querySelector("[data-xp-multiplier='subscriber']")!;
    expect(line.getAttribute("data-xp-tier")).toBeNull();
    expect(line.textContent).toContain("progression.multiplier_subscriber");
    expect(panel()!.getAttribute("style")).toBeNull();
  });

  it("rolls the closing caption in once, not again when the reveal ends", async () => {
    stubXpEndpoint([
      () =>
        json(
          eligible({
            before: { prestige: 0, level: 4, xpInLevel: 300, xpForNext: 400 },
            after: {
              ...eligible().after,
              level: 5,
              xpInLevel: 10,
              xpForNext: 430,
            },
            levelsReached: [{ prestige: 0, level: 5 }],
          }),
        ),
    ]);
    await mount(makeGame({ ended: true }));
    // Wait for the closing "Level 5!" caption, while still revealing.
    let closing: Element | null = null;
    for (let i = 0; i < 400 && closing === null; i++) {
      await settle(50);
      const el = panel()!.querySelector("[data-xp-caption-step]");
      if (
        panel()!.getAttribute("data-xp-revealing") === "true" &&
        el?.textContent?.includes("progression.level_reached")
      ) {
        closing = el;
      }
    }
    expect(closing).not.toBeNull();
    await settle(20_000);
    expect(panel()!.getAttribute("data-xp-revealing")).toBeNull();
    // The same element: no second roll-in.
    expect(panel()!.querySelector("[data-xp-caption-step]")).toBe(closing);
  });

  it("pauses on every level reached during the reveal", async () => {
    stubXpEndpoint([
      () =>
        json(
          eligible({
            before: { prestige: 0, level: 4, xpInLevel: 300, xpForNext: 400 },
            after: {
              ...eligible().after,
              level: 7,
              xpInLevel: 50,
              xpForNext: 600,
            },
            levelsReached: [
              { prestige: 0, level: 5 },
              { prestige: 0, level: 6 },
              { prestige: 0, level: 7 },
            ],
          }),
        ),
    ]);
    await mount(makeGame({ ended: true }));
    const moments: string[] = [];
    for (let i = 0; i < 400; i++) {
      await settle(50);
      const moment = panel()
        ?.querySelector("[data-xp-caption-levelup]")
        ?.getAttribute("data-xp-caption-levelup");
      if (moment && moment !== moments[moments.length - 1]) {
        moments.push(moment);
        // The bar is full and the badge shows the new level.
        expect(
          panel()!
            .querySelector("[data-xp-bar]")!
            .getAttribute("aria-valuenow"),
        ).toBe("100");
        // The level being reached is the right-hand badge, with the one
        // before it still on the left.
        const badgeLevel = (sel: string) =>
          (
            panel()!.querySelector(`${sel} level-badge`) as HTMLElement & {
              level: number;
            }
          ).level;
        expect(badgeLevel("[data-xp-next-badge]")).toBe(Number(moment));
        expect(badgeLevel("[data-xp-current-badge]")).toBe(Number(moment) - 1);
      }
      if (panel()?.getAttribute("data-xp-revealing") !== "true") break;
    }
    expect(moments).toEqual(["5", "6", "7"]);
  });

  it("celebrates a level-up from a level the player started full", async () => {
    // A curve change left the player a full bar on level 9.
    stubXpEndpoint([
      () =>
        json(
          eligible({
            before: { prestige: 0, level: 9, xpInLevel: 330, xpForNext: 330 },
            after: {
              ...eligible().after,
              level: 10,
              xpInLevel: 182,
              xpForNext: 370,
            },
            levelsReached: [{ prestige: 0, level: 10 }],
          }),
        ),
    ]);
    await mount(makeGame({ ended: true }));
    const badgeLevel = (sel: string) =>
      (
        panel()!.querySelector(`${sel} level-badge`) as HTMLElement & {
          level: number;
        }
      ).level;
    const milestoneSpace = () =>
      panel()!
        .querySelector("[data-xp-levelup]")!
        .closest("[data-xp-collapsible]")!
        .getAttribute("data-xp-collapsible");
    // It starts on level 9, the milestone still to come.
    expect(badgeLevel("[data-xp-current-badge]")).toBe(9);
    expect(badgeLevel("[data-xp-next-badge]")).toBe(10);
    expect(milestoneSpace()).toBe("closed");
    const moments: string[] = [];
    for (let i = 0; i < 400; i++) {
      await settle(50);
      const moment = panel()
        ?.querySelector("[data-xp-caption-levelup]")
        ?.getAttribute("data-xp-caption-levelup");
      if (moment && moment !== moments[moments.length - 1]) {
        moments.push(moment);
      }
      if (panel()?.getAttribute("data-xp-revealing") !== "true") break;
    }
    expect(moments).toEqual(["10"]);
    expect(milestoneSpace()).toBe("open");
    expect(badgeLevel("[data-xp-current-badge]")).toBe(10);
  });

  it("shows XP from a source it doesn't know as its own card, not spread over the others", async () => {
    // Scored when the first-game bonus was stored as `firstWinOfDay`.
    stubXpEndpoint([
      () =>
        json(
          eligible({
            breakdown: {
              played: 50,
              time: 100,
              firstWinOfDay: 200,
              subtotal: 350,
              gamePermille: 1000,
              subscriberPermille: 1000,
              total: 350,
            },
          }),
        ),
    ]);
    await mount(makeGame({ ended: true }));
    await finishReveal();
    const cards = [...panel()!.querySelectorAll("[data-xp-card]")].map((c) => [
      c.querySelector("[data-xp-line]")!.getAttribute("data-xp-line"),
      c.querySelector("[data-xp-card-value]")!.textContent!.trim(),
    ]);
    expect(cards).toEqual([
      ["played", 'progression.xp_total:{"xp":"50"}'],
      ["time", 'progression.xp_total:{"xp":"100"}'],
      ["other", 'progression.xp_total:{"xp":"200"}'],
    ]);
  });
  it("skips to the end when the panel is tapped", async () => {
    stubXpEndpoint([() => json(eligible())]);
    await mount(makeGame({ ended: true }));
    expect(panel()!.getAttribute("data-xp-revealing")).toBe("true");
    panel()!.click();
    await settle();
    expect(panel()!.getAttribute("data-xp-revealing")).toBeNull();
    expect(panel()!.querySelector("[data-xp-total]")!.textContent).toContain(
      '"xp":"212"',
    );
  });

  it("shows a result that lands after the modal is dismissed in its final state", async () => {
    stubXpEndpoint([notFound, () => json(eligible())]);
    await mount(makeGame({ ended: true }));
    expect(xpState()).toBe("calculating");
    // Keep playing / spectate while it is still calculating.
    modal.querySelector<HTMLButtonElement>('[data-win-action="keep"]')!.click();
    await settle(3_000);
    expect(xpState()).toBe("result");
    // No reveal playing where nobody can see it: it is already over.
    expect(panel()!.getAttribute("data-xp-revealing")).toBeNull();
    expect(panel()!.getAttribute("aria-busy")).toBe("false");
    expect(panel()!.querySelector("[data-xp-total]")!.textContent).toContain(
      '"xp":"212"',
    );
    expect(vi.getTimerCount()).toBe(0);
  });

  it("ends a reveal in progress when the modal is dismissed", async () => {
    stubXpEndpoint([() => json(eligible())]);
    await mount(makeGame({ ended: true }));
    expect(panel()!.getAttribute("data-xp-revealing")).toBe("true");
    modal.querySelector<HTMLButtonElement>('[data-win-action="keep"]')!.click();
    await settle();
    expect(panel()!.getAttribute("data-xp-revealing")).toBeNull();
    expect(panel()!.querySelector("[data-xp-total]")!.textContent).toContain(
      '"xp":"212"',
    );
  });

  it("does not come back half-revealed when the panel is removed and re-added", async () => {
    stubXpEndpoint([() => json(eligible())]);
    await mount(makeGame({ ended: true }));
    const element = modal.querySelector<GameXpPanel>("game-xp-panel")!;
    expect(panel()!.getAttribute("aria-busy")).toBe("true");
    const parent = element.parentElement!;
    element.remove();
    parent.prepend(element);
    await element.updateComplete;
    expect(panel()!.getAttribute("data-xp-revealing")).toBeNull();
    expect(panel()!.getAttribute("aria-busy")).toBe("false");
  });

  it("skips from the keyboard with a real button", async () => {
    stubXpEndpoint([() => json(eligible())]);
    await mount(makeGame({ ended: true }));
    const skip = panel()!.querySelector<HTMLButtonElement>("[data-xp-skip]");
    expect(skip).not.toBeNull();
    expect(skip!.tagName).toBe("BUTTON");
    expect(skip!.textContent!.trim()).toBe("progression.skip_reveal");
    // A button's Enter / Space activation is a click.
    skip!.click();
    await settle();
    expect(panel()!.getAttribute("data-xp-revealing")).toBeNull();
    expect(panel()!.querySelector("[data-xp-skip]")).toBeNull();
  });

  it("names the progress bar for assistive tech", async () => {
    stubXpEndpoint([() => json(eligible())]);
    await mount(makeGame({ ended: true }));
    await finishReveal();
    const bar = panel()!.querySelector("[data-xp-bar]")!;
    expect(bar.getAttribute("aria-label")).toBe("progression.xp_bar_label");
    expect(bar.getAttribute("aria-valuetext")).toBe(
      'progression.xp_progress:{"current":"512","next":"400"}',
    );
  });

  it("asks a signed-out player to sign in, without polling", async () => {
    getUserMe.mockResolvedValue(anonymous);
    const fetchMock = stubXpEndpoint([notFound]);
    await mount(makeGame({ ended: true }));
    await finishReveal();
    expect(xpState()).toBe("signed_out");
    expect(panel()!.textContent).toContain("progression.sign_in_to_earn");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("asks a player with no session at all to sign in", async () => {
    isLoggedIn.mockResolvedValue(false);
    getUserMe.mockResolvedValue(false);
    const fetchMock = stubXpEndpoint([notFound]);
    await mount(makeGame({ ended: true }));
    expect(xpState()).toBe("signed_out");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("says nothing, rather than 'sign in', when /users/@me fails for a session", async () => {
    // A 5xx or a timeout: getUserMe answers false, as for a signed-out
    // player, but there is a session, so this says nothing about the account.
    getUserMe.mockResolvedValue(false);
    fetchProgressionConfig.mockClear();
    const fetchMock = stubXpEndpoint([notFound]);
    await mount(makeGame({ ended: true }));
    expect(xpState()).toBe("hidden");
    expect(fetchProgressionConfig).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("says nothing at all when progression is off", async () => {
    fetchProgressionConfig.mockResolvedValue(false);
    isLoggedIn.mockResolvedValue(false);
    getUserMe.mockResolvedValue(false);
    const fetchMock = stubXpEndpoint([notFound]);
    await mount(makeGame({ ended: true }));
    await finishReveal();
    expect(xpState()).toBe("hidden");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("says nothing to a signed-in player when /users/@me has no progress", async () => {
    getUserMe.mockResolvedValue({ ...signedIn, player: { publicId: "me" } });
    const fetchMock = stubXpEndpoint([notFound]);
    await mount(makeGame({ ended: true }));
    await finishReveal();
    expect(xpState()).toBe("hidden");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // A running game's XP, as the API's preview reports it.
  const livePreview =
    (over: Record<string, unknown> = {}) =>
    () =>
      json({
        gameId: GAME_ID,
        status: "pending",
        mode: "full",
        reason: null,
        total: 150,
        breakdown: {
          leftEarly: false,
          played: 100,
          time: 0,
          placement: 0,
          win: 0,
          eliminations: 50,
          eliminationCount: 2,
          firstGame: 0,
          firstWin: 0,
          feats: 0,
          subtotal: 150,
          gamePermille: 1000,
          repeatPermille: 1000,
          subscriberPermille: 1000,
          playerCount: 8,
          capped: false,
          softCapped: false,
          total: 150,
        },
        pending: ["placement", "challenges", "season"],
        alive: false,
        winner: false,
        ...over,
      });

  // The reduced award for a death, as the account API reports it.
  const reducedPreview = (over: Record<string, unknown> = {}) =>
    livePreview({
      status: "pending",
      mode: "reduced",
      total: 31,
      breakdown: {
        leftEarly: false,
        played: 100,
        time: 0,
        placement: 0,
        win: 0,
        eliminations: 25,
        eliminationCount: 1,
        firstGame: 0,
        firstWin: 0,
        feats: 0,
        subtotal: 125,
        gamePermille: 250,
        repeatPermille: 1000,
        subscriberPermille: 1000,
        playerCount: 0,
        capped: false,
        softCapped: false,
        reducedReason: "eliminated",
        total: 31,
      },
      pending: [],
      ...over,
    });

  // The stored award a paid death reads back (GET /users/@me/xp/:gameId before
  // the game is stored).
  const deathAward = (over: Record<string, unknown> = {}) =>
    eligible({
      mode: "reduced",
      breakdown: {
        ...eligible().breakdown,
        played: 100,
        time: 0,
        win: 0,
        eliminations: 25,
        eliminationCount: 1,
        subtotal: 125,
        gamePermille: 250,
        reducedReason: "eliminated",
        total: 31,
      },
      before: { prestige: 0, level: 4, xpInLevel: 300, xpForNext: 400 },
      after: {
        prestige: 0,
        level: 4,
        xpInLevel: 331,
        xpForNext: 400,
        lifetimeXp: 2031,
        legend: false,
        canPrestige: false,
      },
      challenges: [],
      season: null,
      ...over,
    });

  it("shows the XP the server is finalizing, not a wait message, when the player dies mid-game", async () => {
    const fetchMock = stubXpEndpoint([notFound], [reducedPreview()]);
    await mount(makeGame({ ended: false, alive: false }));
    await settle(1_500);
    expect(xpState()).toBe("live");
    const card = panel()!.querySelector("live-xp-card")!;
    expect(
      card.getAttribute("data-live-status") ??
        card
          .querySelector("[data-live-status]")
          ?.getAttribute("data-live-status"),
    ).toBe("pending");
    expect(panel()!.textContent).toContain("progression.live_pending_note");
    expect(panel()!.textContent).toContain('"xp":"31"');
    // nothing tells them to stay: the old "wait until the end" text is gone
    expect(panel()!.textContent).not.toContain("awaiting_end");
    expect(panel()!.textContent).not.toMatch(/stay/i);
    // and the stored XP is not asked for before the game is over
    expect(storedCalls(fetchMock)).toHaveLength(0);
    expect(liveCalls(fetchMock).length).toBeGreaterThanOrEqual(1);
  });

  it("shows what the death earned as soon as the server has paid it, with the level, while the match goes on", async () => {
    const fetchMock = stubXpEndpoint(
      [() => json(deathAward())],
      [reducedPreview({ status: "final" })],
    );
    await mount(makeGame({ ended: false, alive: false }));
    await settle(2_500);
    // the full panel, not a card: the bar, the counter and the reduced heading
    expect(xpState()).toBe("result");
    await finishReveal();
    const text = panel()!.textContent!;
    expect(text).toContain('progression.xp_total:{"xp":"31"}');
    expect(text).toContain("progression.xp_heading_reduced");
    expect(text).toContain("progression.note_reduced_eliminated");
    expect(panel()!.querySelector("[data-xp-bar]")).not.toBeNull();
    // it was read from the account, before the game was over
    expect(storedCalls(fetchMock).length).toBeGreaterThanOrEqual(1);
    // no pending, no wait, no stay-until-the-end
    expect(text).not.toContain("live_pending");
    expect(text).not.toContain("progression.calculating");
    expect(text).not.toMatch(/stay/i);
    // and nothing is left to be told on the next visit
    expect(window.localStorage.getItem("df.pendingXp")).toBeNull();
  });

  it("tells the page the account has the XP, so the nav's level and bar catch up", async () => {
    const heard: unknown[] = [];
    const listen = (e: Event) => heard.push((e as CustomEvent).detail);
    document.addEventListener("xp-awarded", listen);
    try {
      stubXpEndpoint(
        [() => json(deathAward())],
        [reducedPreview({ status: "final" })],
      );
      await mount(makeGame({ ended: false, alive: false }));
      await settle(2_500);
    } finally {
      document.removeEventListener("xp-awarded", listen);
    }
    expect(heard).toEqual([{ gameId: GAME_ID }]);
  });

  it("offers to exit or spectate on the death screen, and the award is already there to leave with", async () => {
    stubXpEndpoint(
      [() => json(deathAward())],
      [reducedPreview({ status: "final" })],
    );
    await mount(makeGame({ ended: false, alive: false }));
    await settle(2_500);
    await finishReveal();
    expect(modal.querySelector("h2")!.textContent).toContain("win_modal.died");
    const actions = [...modal.querySelectorAll("[data-win-action]")].map(
      (el) => [el.getAttribute("data-win-action"), el.textContent!.trim()],
    );
    expect(actions).toEqual([
      ["exit", "win_modal.exit"],
      ["keep", "win_modal.spectate"],
    ]);
    expect(xpState()).toBe("result");
  });

  it("does not look for the stored XP again when the match ends: the award it already shows is final", async () => {
    const opts = { ended: false, alive: false };
    const fetchMock = stubXpEndpoint(
      [() => json(deathAward())],
      [reducedPreview({ status: "final" })],
    );
    await mount(makeGame(opts));
    await settle(2_500);
    expect(xpState()).toBe("result");
    const calls = storedCalls(fetchMock).length;
    // the match ends
    opts.ended = true;
    modal.tick();
    await settle(5_000);
    expect(xpState()).toBe("result");
    expect(panel()!.textContent).not.toContain("progression.calculating");
    expect(storedCalls(fetchMock).length).toBe(calls);
  });

  it("keeps the preview current while waiting for the server to confirm, every two seconds", async () => {
    let total = 25;
    const fetchMock = stubXpEndpoint(
      [notFound],
      [() => reducedPreview({ total })()],
    );
    await mount(makeGame({ ended: false, alive: false }));
    await settle();
    const first = liveCalls(fetchMock).length;
    total = 37;
    await settle(2_000);
    expect(liveCalls(fetchMock).length).toBeGreaterThan(first);
    // the figure eases to the new amount, then rests on it
    await settle(1_500);
    expect(panel()!.textContent).toContain('"xp":"37"');
  });

  it("says nothing, and asks nothing of the stored game, when the API has no preview", async () => {
    const fetchMock = stubXpEndpoint([notFound]);
    await mount(makeGame({ ended: false, alive: false }));
    await settle();
    expect(xpState()).toBe("hidden");
    expect(storedCalls(fetchMock)).toHaveLength(0);
  });

  it("when the result comes in, shows the confirmed win while the stored XP is looked for", async () => {
    const settledPreview = livePreview({
      status: "settled",
      winner: true,
      alive: true,
      pending: ["challenges", "season"],
    });
    stubXpEndpoint(
      [notFound, notFound, () => json(eligible())],
      [settledPreview],
    );
    await mount(makeGame({ ended: true }));
    await settle();
    expect(xpState()).toBe("live");
    expect(panel()!.textContent).toContain("progression.live_winner_note");
    // then the stored XP replaces it, within a couple of seconds
    await settle(2_000);
    expect(xpState()).toBe("result");
  });

  it("shows a forfeit at once when the preview says the player left before the result", async () => {
    stubXpEndpoint(
      [notFound, () => json(eligible())],
      [livePreview({ status: "forfeited", total: 0, reason: "left_early" })],
    );
    await mount(makeGame({ ended: true }));
    await settle();
    expect(panel()!.textContent).toContain("progression.live_forfeited_note");
  });

  it("remembers the game while XP is at stake, and forgets it once the stored XP is shown", async () => {
    window.localStorage.removeItem("df.pendingXp");
    stubXpEndpoint([notFound, () => json(eligible())], [livePreview()]);
    await mount(makeGame({ ended: false, alive: false }));
    await settle();
    expect(window.localStorage.getItem("df.pendingXp")).toContain(GAME_ID);
  });

  it("stays hidden in a replay", async () => {
    const fetchMock = stubXpEndpoint([notFound]);
    await mount(makeGame({ ended: true, replay: true }));
    expect(xpState()).toBe("hidden");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  describe("a singleplayer match", () => {
    // 100 + 250 at 0.80x (one criterion missed): 280
    const soloResult = () =>
      eligible({
        mode: "solo",
        breakdown: {
          leftEarly: false,
          played: 100,
          time: 0,
          placement: 0,
          win: 250,
          eliminations: 0,
          eliminationCount: 0,
          firstGame: 0,
          firstWin: 0,
          feats: 0,
          subtotal: 350,
          gamePermille: 1000,
          soloPermille: 800,
          subscriberPermille: 1000,
          repeatPermille: 1000,
          playerCount: 0,
          capped: false,
          softCapped: false,
          solo: {
            multiplierPermille: 800,
            failed: 1,
            difficulty: "Medium",
            tribes: 45,
            nations: 50,
            criteria: [
              { key: "tribes", met: true },
              { key: "nations", met: true },
              { key: "instant_build", met: true },
              { key: "infinite_gold", met: true },
              { key: "infinite_troops", met: true },
              { key: "difficulty", met: false },
            ],
          },
          total: 280,
        },
        season: null,
        challenges: [],
      });

    it("looks for the XP the account API pays after replaying it, says so while it waits, then shows the solo breakdown", async () => {
      const fetchMock = stubXpEndpoint([
        notFound,
        notFound,
        () => json(soloResult()),
      ]);
      await mount(makeGame({ ended: true, gameType: GameType.Singleplayer }));
      await finishReveal();
      expect(xpState()).toBe("calculating");
      expect(panel()!.textContent).toContain("progression.calculating_solo");
      // there is no running-game preview for a match no server is watching
      expect(liveCalls(fetchMock)).toHaveLength(0);

      await settle(2_000);
      expect(xpState()).toBe("result");
      await finishReveal();
      const text = panel()!.textContent!;
      expect(text).toContain('progression.xp_total:{"xp":"280"}');
      // the heading, the criteria exactly as they were met, and the multiplier
      expect(text).toContain("progression.xp_heading_solo");
      const criteria = [
        ...panel()!.querySelectorAll("[data-xp-solo-criterion]"),
      ].map((el) => [
        el.getAttribute("data-xp-solo-criterion"),
        el.getAttribute("data-met"),
      ]);
      expect(criteria).toEqual([
        ["tribes", "true"],
        ["nations", "true"],
        ["instant_build", "true"],
        ["infinite_gold", "true"],
        ["infinite_troops", "true"],
        ["difficulty", "false"],
      ]);
      expect(
        panel()!.querySelector("[data-xp-solo-multiplier]")!.textContent,
      ).toContain('progression.solo_multiplier_value:{"multiplier":"0.80"}');
      expect(
        panel()!.querySelector("[data-xp-solo-setup]")!.textContent,
      ).toContain('"tribes":45');
      // the solo note: level and rank only
      expect(panel()!.querySelector("[data-xp-note='solo']")).not.toBeNull();
      // and no season or challenge cards
      expect(panel()!.querySelector("[data-xp-season]")).toBeNull();
      expect(panel()!.querySelector("[data-xp-challenge]")).toBeNull();
    });

    it("uploads the match the moment the player is eliminated, and looks for the XP at once", async () => {
      const fetchMock = stubXpEndpoint([notFound, () => json(soloResult())]);
      const archived = vi.fn();
      // the player is out and the match goes on
      await mount(
        makeGame({
          ended: false,
          alive: false,
          gameType: GameType.Singleplayer,
        }),
        (m) => m.eventBus.on(SendSoloArchiveEvent, archived),
      );
      expect(archived).toHaveBeenCalledTimes(1);
      // looking for the stored XP now, not waiting for the match to end
      expect(storedCalls(fetchMock).length).toBeGreaterThan(0);
      expect(liveCalls(fetchMock)).toHaveLength(0);
      await settle(2_000);
      expect(xpState()).toBe("result");
      // asked once: a later tick does not upload again
      modal.tick();
      await settle();
      expect(archived).toHaveBeenCalledTimes(1);
    });

    it("does not upload a multiplayer death: the game server pays that", async () => {
      stubXpEndpoint([notFound], [livePreview()]);
      const archived = vi.fn();
      await mount(makeGame({ ended: false, alive: false }), (m) =>
        m.eventBus.on(SendSoloArchiveEvent, archived),
      );
      expect(archived).not.toHaveBeenCalled();
    });

    it("waits longer than a multiplayer game for it: the replay can take minutes", async () => {
      stubXpEndpoint([notFound]);
      await mount(makeGame({ ended: true, gameType: GameType.Singleplayer }));
      await settle(200_000);
      // past a multiplayer game's two and a half minutes, still waiting
      expect(xpState()).toBe("calculating");
      await settle(200_000);
      expect(xpState()).toBe("hidden");
    });

    it("says why a match was not verified", async () => {
      stubXpEndpoint([
        () =>
          json({ gameId: GAME_ID, eligible: false, reason: "solo_unverified" }),
      ]);
      await mount(makeGame({ ended: true, gameType: GameType.Singleplayer }));
      await finishReveal();
      expect(xpState()).toBe("ineligible");
      expect(panel()!.textContent!.trim()).toBe(
        "progression.ineligible_solo_unverified",
      );
    });
  });
});
