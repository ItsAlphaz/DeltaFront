import type { LiveXpResponse } from "@openfront/shared/ApiSchemas";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/client/Utils", () => ({
  translateText: (key: string, params?: Record<string, string | number>) =>
    params ? `${key}:${JSON.stringify(params)}` : key,
}));

import {
  effectiveStatus,
  LiveXpCard,
} from "../../src/client/components/LiveXpCard";

if (!customElements.get("live-xp-card")) {
  customElements.define("live-xp-card", LiveXpCard);
}

// A running game's XP as the player sees it: the number and lines are the API's
// (this card works nothing out), and what is still to be decided is said.

const breakdown = (over: Record<string, unknown> = {}) => ({
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
  ...over,
});

function data(over: Partial<LiveXpResponse> = {}): LiveXpResponse {
  return {
    gameId: "gLIVE0001",
    status: "live",
    mode: "full",
    reason: null,
    total: 150,
    breakdown: breakdown(),
    pending: ["placement", "victory", "challenges", "season"],
    alive: true,
    winner: false,
    ...over,
  } as LiveXpResponse;
}

let card: LiveXpCard;
async function show(
  props: Partial<LiveXpCard> & { data: LiveXpResponse | null },
) {
  card?.remove();
  card = document.createElement("live-xp-card") as LiveXpCard;
  Object.assign(card, props);
  document.body.appendChild(card);
  await card.updateComplete;
  // let the figure's ease-in finish
  await vi.advanceTimersByTimeAsync(1_000);
  await card.updateComplete;
  return card;
}
const q = (sel: string) => card.querySelector<HTMLElement>(sel);
const text = (sel: string) => q(sel)?.textContent?.replace(/\s+/g, " ").trim();

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  card?.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("a running game's XP", () => {
  it("says Match XP and the figure the API worked out", async () => {
    await show({ data: data() });
    expect(q("[data-live-xp]")?.getAttribute("data-live-status")).toBe("live");
    expect(text("[data-live-xp-title]")).toBe("progression.live_title");
    expect(text("[data-live-xp-total]")).toBe(
      'progression.xp_total:{"xp":"150"}',
    );
  });

  it("lists what it is made of: taking part, and the eliminations counted", async () => {
    await show({ data: data() });
    const lines = [...card.querySelectorAll("[data-live-xp-line]")].map((l) =>
      l.getAttribute("data-live-xp-line"),
    );
    expect(lines).toEqual(["played", "eliminations"]);
    expect(text('[data-live-xp-line="played"]')).toContain(
      "progression.line_played",
    );
    expect(text('[data-live-xp-line="played"]')).toContain('"xp":"100"');
    // "2 eliminations", not just "Eliminations"
    expect(text('[data-live-xp-line="eliminations"]')).toContain(
      'progression.live_eliminations:{"count":2}',
    );
    expect(text('[data-live-xp-line="eliminations"]')).toContain('"xp":"50"');
  });

  it("names a multiplier other than 1x", async () => {
    await show({
      data: data({ breakdown: breakdown({ gamePermille: 500 }) as never }),
    });
    expect(
      card.querySelector('[data-live-xp-multiplier="game"]'),
    ).not.toBeNull();
    // a small game pays half: a cut, named as one
    expect(text('[data-live-xp-multiplier="game"]')).toContain(
      "progression.penalty_line",
    );
    await show({
      data: data({ breakdown: breakdown({ gamePermille: 1250 }) as never }),
    });
    expect(text('[data-live-xp-multiplier="game"]')).toContain(
      "progression.bonus_line",
    );
    await show({ data: data() });
    expect(card.querySelector("[data-live-xp-multiplier]")).toBeNull();
  });

  it("says that placement and victory are still to come", async () => {
    await show({ data: data() });
    expect(text("[data-live-xp-note]")).toBe("progression.live_note_result");
  });

  it("shows no line a game did not earn", async () => {
    await show({
      data: data({
        total: 100,
        breakdown: breakdown({
          eliminations: 0,
          eliminationCount: 0,
          subtotal: 100,
          total: 100,
        }) as never,
      }),
    });
    expect(
      [...card.querySelectorAll("[data-live-xp-line]")].map((l) =>
        l.getAttribute("data-live-xp-line"),
      ),
    ).toEqual(["played"]);
  });

  it("draws nothing for a game that pays nothing, or with nothing to show", async () => {
    await show({
      data: data({
        status: "none",
        reason: "ranked",
        total: 0,
        breakdown: null,
      }),
    });
    expect(q("[data-live-xp]")).toBeNull();
    await show({ data: null });
    expect(q("[data-live-xp]")).toBeNull();
  });
});

describe("eliminated", () => {
  // the server has confirmed the elimination and worked out the reduced award
  const reduced = (over: Partial<LiveXpResponse> = {}) =>
    data({
      status: "pending",
      mode: "reduced",
      alive: false,
      total: 31,
      breakdown: breakdown({
        eliminations: 25,
        eliminationCount: 1,
        subtotal: 125,
        gamePermille: 250,
        reducedReason: "eliminated",
        total: 31,
      }) as never,
      pending: [],
      ...over,
    });

  it("is confirmed by the server: the reduced figure, and that it is being finalized", async () => {
    await show({ data: reduced() });
    expect(q("[data-live-xp]")?.getAttribute("data-live-status")).toBe(
      "pending",
    );
    expect(text("[data-live-xp-title]")).toBe("progression.live_pending_title");
    expect(text("[data-live-xp-total]")).toBe(
      'progression.xp_total:{"xp":"31"}',
    );
    expect(text("[data-live-xp-note]")).toBe("progression.live_pending_note");
    // nothing says to stay: the old "stay until the result" note is gone
    expect(card.innerHTML).not.toContain("stay");
  });

  it("keeps the lines: taking part and the eliminations they made", async () => {
    await show({ data: reduced() });
    expect(card.querySelectorAll("[data-live-xp-line]")).toHaveLength(2);
    expect(text("[data-live-xp-reduced]")).toBe(
      "progression.live_reduced_note",
    );
  });

  it("the lines add up to the figure: the quarter is shared across them, as on the end-of-game panel", async () => {
    await show({ data: reduced() });
    const amounts = [
      ...card.querySelectorAll("[data-live-xp-line] span:last-child"),
    ].map((el) => el.textContent!.replace(/\s+/g, " ").trim());
    // 100 and 25 at a quarter of 125 = 31: 25 and 6
    expect(amounts).toEqual([
      'progression.xp_total:{"xp":"25"}',
      'progression.xp_total:{"xp":"6"}',
    ]);
  });

  it("their own screen says they are out a moment before the server does: no figure yet, never the full-game one", async () => {
    // the server still says they are playing (with the full-game figure); the
    // player's simulation knows they died
    await show({ data: data(), playerAlive: false });
    expect(q("[data-live-xp]")?.getAttribute("data-live-status")).toBe(
      "pending",
    );
    expect(text("[data-live-xp-total]")).toBe("progression.live_finalizing");
    expect(card.innerHTML).not.toContain('"xp":"150"');
    // no lines for a figure that is not theirs any more
    expect(card.querySelectorAll("[data-live-xp-line]")).toHaveLength(0);
  });

  it("the figure replaces the full-game one when the server confirms, without counting down to it", async () => {
    await show({ data: data({ total: 150 }) });
    expect(text("[data-live-xp-total]")).toContain('"xp":"150"');
    card.data = reduced({ total: 31 });
    card.playerAlive = false;
    await card.updateComplete;
    // at once: not 150 easing down to 31
    expect(text("[data-live-xp-total]")).toBe(
      'progression.xp_total:{"xp":"31"}',
    );
  });

  it("effectiveStatus changes nothing else", () => {
    expect(effectiveStatus(data(), true)).toBe("live");
    expect(effectiveStatus(data(), null)).toBe("live");
    expect(effectiveStatus(data(), false)).toBe("pending");
    expect(effectiveStatus(data({ status: "settled" }), false)).toBe("settled");
    expect(effectiveStatus(data({ status: "final" }), false)).toBe("final");
    expect(effectiveStatus(data({ status: "forfeited" }), true)).toBe(
      "forfeited",
    );
  });
});

describe("a death that has been paid", () => {
  const final = data({
    status: "final",
    mode: "reduced",
    alive: false,
    total: 31,
    breakdown: breakdown({
      eliminations: 25,
      eliminationCount: 1,
      subtotal: 125,
      gamePermille: 250,
      reducedReason: "eliminated",
      total: 31,
    }) as never,
    pending: [],
  });

  it("says XP earned and the amount, already in the account", async () => {
    await show({ data: final, playerAlive: false });
    expect(q("[data-live-xp]")?.getAttribute("data-live-status")).toBe("final");
    expect(text("[data-live-xp-title]")).toBe("progression.live_final_title");
    expect(text("[data-live-xp-total]")).toBe(
      'progression.xp_total:{"xp":"31"}',
    );
    expect(text("[data-live-xp-note]")).toBe("progression.live_final_note");
  });

  it("shows the reduced multiplier, and is not pending", async () => {
    await show({ data: final, playerAlive: false });
    expect(
      card.querySelector("[data-live-xp-multiplier]")?.textContent,
    ).toContain("progression.reduced_line");
    expect(card.innerHTML).not.toContain("live_pending");
    expect(card.innerHTML).not.toContain("live_forfeited");
  });

  it("is the same collapsed: just the heading and the figure", async () => {
    await show({ data: final, summary: true, playerAlive: false });
    expect(text("[data-live-xp-total]")).toBe(
      'progression.xp_total:{"xp":"31"}',
    );
    expect(card.querySelectorAll("[data-live-xp-line]")).toHaveLength(0);
    expect(q("[data-live-xp-note]")).toBeNull();
  });
});

describe("the result is in", () => {
  it("a winner is told it is confirmed and that they can leave", async () => {
    await show({
      data: data({
        status: "settled",
        winner: true,
        total: 425,
        breakdown: breakdown({
          placement: 150,
          win: 250,
          subtotal: 550,
          total: 425,
        }) as never,
        pending: ["challenges", "season"],
      }),
    });
    expect(text("[data-live-xp-title]")).toBe("progression.live_settled_title");
    expect(text("[data-live-xp-note]")).toBe("progression.live_winner_note");
    const lines = [...card.querySelectorAll("[data-live-xp-line]")].map((l) =>
      l.getAttribute("data-live-xp-line"),
    );
    expect(lines).toContain("placement");
    expect(lines).toContain("win");
  });

  it("anyone else is told their XP is being finalized", async () => {
    await show({ data: data({ status: "settled", winner: false }) });
    expect(text("[data-live-xp-note]")).toBe("progression.live_settled_note");
  });
});

describe("a forfeit", () => {
  const forfeited = data({
    status: "forfeited",
    total: 0,
    breakdown: null,
    reason: "left_early",
    pending: [],
  });

  it("says so: XP forfeited, because they left before their result was final", async () => {
    await show({ data: forfeited });
    expect(q("[data-live-xp]")?.getAttribute("data-live-status")).toBe(
      "forfeited",
    );
    expect(text("[data-live-xp-title]")).toBe(
      "progression.live_forfeited_title",
    );
    expect(text("[data-live-xp-note]")).toBe("progression.live_forfeited_note");
    // nothing to receive: a struck-through zero, no lines
    expect(q("[data-live-xp-total]")!.className).toContain("line-through");
    expect(card.querySelector("[data-live-xp-line]")).toBeNull();
  });
});

describe("a reduced match", () => {
  const reduced = data({
    mode: "reduced",
    total: 31,
    breakdown: breakdown({
      eliminations: 25,
      eliminationCount: 1,
      subtotal: 125,
      gamePermille: 250,
      reducedReason: "private_game",
      total: 31,
    }) as never,
    pending: [],
  });

  it("shows the participation, the elimination and the multiplier, and says it is reduced", async () => {
    await show({ data: reduced });
    expect(q("[data-live-xp]")?.getAttribute("data-live-mode")).toBe("reduced");
    expect(text("[data-live-xp-total]")).toContain('"xp":"31"');
    expect(text('[data-live-xp-multiplier="reduced_private"]')).toContain(
      "progression.reduced_line",
    );
    expect(text("[data-live-xp-reduced]")).toBe(
      "progression.live_reduced_note",
    );
  });

  it("has nothing left to decide, so it does not say so", async () => {
    await show({ data: reduced });
    expect(card.querySelector("[data-live-xp-note]")).toBeNull();
  });

  it("is not called reduced once it is forfeited", async () => {
    await show({
      data: { ...reduced, status: "forfeited", total: 0, breakdown: null },
    });
    expect(card.querySelector("[data-live-xp-reduced]")).toBeNull();
  });
});

describe("summary", () => {
  it("is just the heading and the figure, for a collapsed panel", async () => {
    await show({ data: data(), summary: true });
    expect(q("[data-live-xp-title]")).not.toBeNull();
    expect(q("[data-live-xp-total]")).not.toBeNull();
    expect(card.querySelector("[data-live-xp-line]")).toBeNull();
    expect(card.querySelector("[data-live-xp-note]")).toBeNull();
    expect(card.querySelector("[data-live-xp-reduced]")).toBeNull();
  });
});

describe("motion", () => {
  async function frames() {
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) =>
      setTimeout(() => {
        now += 16;
        cb(now);
      }, 16),
    );
    vi.stubGlobal("cancelAnimationFrame", (id: number) => clearTimeout(id));
  }

  it("the figure eases from where it was to the new amount, and pops when it grows", async () => {
    await frames();
    await show({ data: data({ total: 150 }) });
    expect(text("[data-live-xp-total]")).toContain('"xp":"150"');
    expect(card.querySelector(".df-xp-pop")).toBeNull();
    card.data = data({ total: 225 });
    await card.updateComplete;
    // part way: between the two, never back to zero
    await vi.advanceTimersByTimeAsync(200);
    await card.updateComplete;
    const middle = Number(
      /"xp":"(\d+)"/.exec(text("[data-live-xp-total]")!)![1],
    );
    expect(middle).toBeGreaterThan(150);
    expect(middle).toBeLessThan(225);
    expect(card.querySelector(".df-xp-pop")).not.toBeNull();
    await vi.advanceTimersByTimeAsync(1_000);
    await card.updateComplete;
    expect(text("[data-live-xp-total]")).toContain('"xp":"225"');
  });

  it("does not pop when it shrinks or stays", async () => {
    await show({ data: data({ total: 150 }) });
    card.data = data({ total: 100 });
    await card.updateComplete;
    await vi.advanceTimersByTimeAsync(1_000);
    await card.updateComplete;
    expect(card.querySelector(".df-xp-pop")).toBeNull();
    expect(text("[data-live-xp-total]")).toContain('"xp":"100"');
  });

  it("goes straight to the figure under reduced motion", async () => {
    vi.stubGlobal(
      "matchMedia",
      vi.fn((query: string) => ({ matches: query.includes("reduce") })),
    );
    card?.remove();
    card = document.createElement("live-xp-card") as LiveXpCard;
    card.data = data({ total: 150 });
    document.body.appendChild(card);
    await card.updateComplete;
    expect(text("[data-live-xp-total]")).toContain('"xp":"150"');
    card.data = data({ total: 800 });
    await card.updateComplete;
    // no frames needed: already there
    expect(text("[data-live-xp-total]")).toContain('"xp":"800"');
  });

  it("the pop is switched off in the stylesheet under reduced motion", async () => {
    const css = (await import("node:fs")).readFileSync(
      "src/client/styles.css",
      "utf8",
    );
    const block =
      /@media \(prefers-reduced-motion: reduce\) \{([^}]*\{[^}]*\}[^}]*)\}/.exec(
        css.slice(css.indexOf("df-xp-pop")),
      )![1];
    expect(block).toContain(".df-xp-pop");
    expect(block).toContain("animation: none");
  });
});
