import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/client/Utils", () => ({
  translateText: (key: string, params?: Record<string, string | number>) =>
    params ? `${key}:${JSON.stringify(params)}` : key,
}));

import type { GameXpEligible } from "@openfront/shared/ApiSchemas";
import "../../src/client/components/GameXpPanel";
import type { GameXpPanel } from "../../src/client/components/GameXpPanel";
import {
  multiplierAmounts,
  promotionInGame,
  titleText,
  visibleMultipliers,
  visibleXpLines,
} from "../../src/client/Progression";

function result(over: Partial<GameXpEligible> = {}): GameXpEligible {
  return {
    gameId: "g1",
    eligible: true,
    breakdown: {
      leftEarly: false,
      played: 100,
      time: 0,
      placement: 150,
      win: 250,
      eliminations: 50,
      eliminationCount: 2,
      firstGame: 0,
      firstWin: 150,
      feats: 0,
      subtotal: 700,
      gamePermille: 1150,
      subscriberPermille: 1000,
      repeatPermille: 1000,
      playerCount: 20,
      capped: false,
      softCapped: false,
      total: 805,
    },
    before: { prestige: 0, level: 29, xpInLevel: 2800, xpForNext: 3000 },
    after: {
      prestige: 0,
      level: 30,
      xpInLevel: 605,
      xpForNext: 3050,
      lifetimeXp: 50_000,
      legend: false,
      canPrestige: false,
    },
    levelsReached: [{ prestige: 0, level: 30 }],
    challenges: [],
    season: null,
    flags: [],
    ...over,
  };
}

let panel: GameXpPanel;

beforeEach(async () => {
  // no reveal: the panel rests on its final state
  vi.stubGlobal("matchMedia", () => ({ matches: true }));
  panel = document.createElement("game-xp-panel") as GameXpPanel;
  document.body.appendChild(panel);
});
afterEach(() => {
  panel.remove();
  vi.unstubAllGlobals();
});

async function show(data: GameXpEligible) {
  panel.view = { kind: "result", data };
  await panel.updateComplete;
}
const q = (sel: string) => panel.querySelector(sel);

describe("the post-game XP breakdown", () => {
  it("lists every line the award is made of, in order, adding up to the subtotal", () => {
    const lines = visibleXpLines(result().breakdown);
    expect(lines.map((l) => [l.key, l.amount])).toEqual([
      ["played", 100],
      ["placement", 150],
      ["win", 250],
      ["eliminations", 50],
      ["firstWin", 150],
    ]);
    expect(lines.reduce((a, l) => a + l.amount, 0)).toBe(700);
  });

  it("draws the eliminations and first-win cards and the player-count multiplier", async () => {
    await show(result());
    expect(q('[data-xp-line="eliminations"]')).not.toBeNull();
    expect(q('[data-xp-line="firstWin"]')).not.toBeNull();
    expect(q('[data-xp-multiplier="game"]')?.textContent).toContain(
      "progression.bonus_line",
    );
  });

  it("shows the repeated-opponents cut as its own line", async () => {
    const base = result().breakdown;
    const data = result({
      breakdown: { ...base, repeatPermille: 500, total: 402 },
    });
    expect(visibleMultipliers(data.breakdown).map((m) => m.key)).toEqual([
      "game",
      "repeat",
    ]);
    await show(data);
    const cut = q('[data-xp-multiplier="repeat"]');
    expect(cut?.textContent).toContain("progression.penalty_line");
    expect(cut?.textContent).toContain("progression.multiplier_repeat");
  });

  it("gives no per-multiplier amount when a cap also changed the award", () => {
    const base = result().breakdown;
    expect(multiplierAmounts({ ...base, gamePermille: 1150 })[0].amount).toBe(
      805 - 700,
    );
    expect(
      multiplierAmounts({ ...base, gamePermille: 1150, softCapped: true })[0]
        .amount,
    ).toBeNull();
  });

  it("explains a cap that held the award back", async () => {
    const base = result().breakdown;
    await show(result({ breakdown: { ...base, softCapped: true } }));
    expect(q('[data-xp-note="soft_cap"]')?.textContent).toContain(
      "progression.note_soft_cap",
    );
    await show(
      result({ breakdown: { ...base, softCapped: false, capped: true } }),
    );
    expect(q('[data-xp-note="cap"]')).not.toBeNull();
    await show(result());
    expect(q("[data-xp-note]")).toBeNull();
  });
});

describe("rank promotion", () => {
  it("is found from the levels a game crossed", () => {
    expect(
      promotionInGame({
        before: { level: 29 },
        after: { level: 30 },
        levelsReached: [{ level: 30 }],
      }),
    ).toEqual({ from: "corporal", to: "sergeant", atLevel: 30 });
    expect(
      promotionInGame({
        before: { level: 31 },
        after: { level: 33 },
        levelsReached: [{ level: 32 }, { level: 33 }],
      }),
    ).toBeNull();
    // several ranks at once report the final one
    expect(
      promotionInGame({
        before: { level: 9 },
        after: { level: 41 },
        levelsReached: [
          { level: 10 },
          { level: 20 },
          { level: 30 },
          { level: 40 },
          { level: 41 },
        ],
      })?.to,
    ).toBe("lieutenant");
  });

  it("shows PROMOTED with both ranks when the rank changed", async () => {
    await show(result());
    const card = q("[data-xp-promotion]");
    expect(card?.getAttribute("data-xp-rank-to")).toBe("sergeant");
    expect(card?.textContent).toContain("progression.promoted");
    expect(card?.textContent).toContain(
      'progression.promotion_line:{"from":"progression.rank_corporal","to":"progression.rank_sergeant"}',
    );
  });

  it("shows nothing for a level-up inside a rank", async () => {
    await show(
      result({
        before: { prestige: 0, level: 31, xpInLevel: 1, xpForNext: 3000 },
        after: { ...result().after, level: 32 },
        levelsReached: [{ prestige: 0, level: 32 }],
      }),
    );
    expect(q("[data-xp-promotion]")).toBeNull();
  });
});

describe("challenges, season and prestige on the panel", () => {
  it("lists each completed challenge with its XP and Credits", async () => {
    await show(
      result({
        challenges: [
          { id: "d_win_1", period: "daily", xp: 400, credits: 0 },
          { id: "w_wins_5", period: "weekly", xp: 2000, credits: 150 },
        ],
      }),
    );
    const cards = panel.querySelectorAll("[data-xp-challenge]");
    expect([...cards].map((c) => c.getAttribute("data-xp-challenge"))).toEqual([
      "d_win_1",
      "w_wins_5",
    ]);
    expect(cards[0].textContent).toContain("progression.challenge_d_win_1");
    expect(cards[0].textContent).toContain("progression.challenge_daily_done");
    expect(cards[1].textContent).toContain("progression.challenge_weekly_done");
    expect(cards[1].textContent).toContain("progression.credits");
    expect(cards[0].textContent).not.toContain("progression.credits");
  });

  it("shows no challenge section when none completed", async () => {
    await show(result());
    expect(q("[data-xp-challenges]")).toBeNull();
  });

  it("summarises the season XP of the game", async () => {
    await show(
      result({
        season: { number: 1, name: "Opening", xp: 7850, level: 4, added: 805 },
      }),
    );
    expect(q("[data-xp-season]")?.textContent).toContain(
      '"name":"Opening","level":4,"xp":"805"',
    );
    await show(result({ season: null }));
    expect(q("[data-xp-season]")).toBeNull();
  });

  it("announces that prestige is available at level 100", async () => {
    await show(
      result({
        after: {
          ...result().after,
          level: 100,
          xpInLevel: 0,
          xpForNext: 0,
          canPrestige: true,
        },
      }),
    );
    expect(q("[data-xp-prestige-ready]")?.textContent).toContain(
      "progression.prestige_available",
    );
    await show(result());
    expect(q("[data-xp-prestige-ready]")).toBeNull();
  });
});

describe("titles", () => {
  const t = (key: string, p?: Record<string, string | number>) =>
    p ? `${key}:${JSON.stringify(p)}` : key;
  it("reads each kind of title id, and shows an unknown one as it is", () => {
    expect(titleText("veteran", t)).toBe("progression.title_veteran");
    expect(titleText("prestige:3", t)).toBe(
      'progression.title_prestige:{"rank":"3"}',
    );
    expect(titleText("season_elite:2", t)).toBe(
      'progression.title_season_elite:{"season":"2"}',
    );
    expect(titleText("future_title", t)).toBe("future_title");
  });
});
