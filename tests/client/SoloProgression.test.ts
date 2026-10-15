import { afterEach, describe, expect, it, vi } from "vitest";
import en from "../../resources/lang/en.json";

vi.mock("../../src/client/Utils", () => ({
  translateText: (key: string, params?: Record<string, string | number>) =>
    params ? `${key}:${JSON.stringify(params)}` : key,
}));

import {
  GameXpResponseSchema,
  XpBreakdownSchema,
  type GameXpEligible,
  type XpBreakdown,
} from "@openfront/shared/ApiSchemas";
import { GameXpPanel } from "../../src/client/components/GameXpPanel";
import { PastGameXpCard } from "../../src/client/components/PastGameXpCard";
import { ProgressionPanel } from "../../src/client/components/ProgressionPanel";
import { xpBonusText } from "../../src/client/components/XpBar";
import {
  difficultyNameKey,
  isReducedKey,
  SOLO_CRITERION_KEYS,
  visibleMultipliers,
  visibleSoloCriteria,
  xpHeadingKey,
} from "../../src/client/Progression";

for (const [tag, ctor] of [
  ["game-xp-panel", GameXpPanel],
  ["past-game-xp-card", PastGameXpCard],
  ["progression-panel", ProgressionPanel],
] as const) {
  if (!customElements.get(tag)) customElements.define(tag, ctor);
}

// The solo award as the account API stores it: 100 + 250, scaled by the setup.
const solo = (
  over: Partial<NonNullable<XpBreakdown["solo"]>> = {},
): NonNullable<XpBreakdown["solo"]> => ({
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
  ...over,
});

const breakdown = (over: Partial<XpBreakdown> = {}): XpBreakdown => ({
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
  solo: solo(),
  total: 280,
  ...over,
});

const award = (over: Partial<GameXpEligible> = {}): GameXpEligible => ({
  gameId: "g1",
  eligible: true,
  mode: "solo",
  breakdown: breakdown(),
  before: { prestige: 0, level: 3, xpInLevel: 100, xpForNext: 700 },
  after: {
    prestige: 0,
    level: 3,
    xpInLevel: 380,
    xpForNext: 700,
    lifetimeXp: 1_700,
    legend: false,
    canPrestige: false,
  },
  levelsReached: [],
  challenges: [],
  season: null,
  ...over,
});

describe("the solo award on the wire", () => {
  it("parses a stored solo result, with its setup", () => {
    const parsed = GameXpResponseSchema.parse(award());
    expect(parsed.eligible && parsed.mode).toBe("solo");
    expect(parsed.eligible && parsed.breakdown.soloPermille).toBe(800);
    expect(parsed.eligible && parsed.breakdown.solo?.criteria).toHaveLength(6);
  });

  it("every other award reads as before: no solo block, no solo multiplier", () => {
    const plain = XpBreakdownSchema.parse({
      subtotal: 100,
      gamePermille: 1000,
      total: 100,
    });
    expect(plain.solo).toBeUndefined();
    expect(plain.soloPermille).toBeUndefined();
  });

  it("keeps an unreadable solo block from failing the whole result", () => {
    const parsed = XpBreakdownSchema.parse({
      subtotal: 100,
      gamePermille: 1000,
      total: 100,
      solo: { nonsense: true },
    });
    expect(parsed.solo).toBeUndefined();
  });
});

describe("how a solo award is read", () => {
  it("shows the setup multiplier as its own line, and none for a full 1.00x", () => {
    expect(visibleMultipliers(breakdown())).toEqual([
      { key: "solo", permille: 800 },
    ]);
    expect(
      visibleMultipliers(breakdown({ soloPermille: 1000, solo: solo() })),
    ).toEqual([]);
  });

  it("a solo award that is also reduced shows both: why it was reduced, then the setup", () => {
    expect(
      visibleMultipliers(
        breakdown({
          gamePermille: 250,
          reducedReason: "eliminated",
          win: 0,
          subtotal: 100,
          total: 20,
        }),
      ),
    ).toEqual([
      { key: "reduced_eliminated", permille: 250 },
      { key: "solo", permille: 800 },
    ]);
  });

  it("is not a reduced key: it is a factor of its own", () => {
    expect(isReducedKey("solo")).toBe(false);
    expect(xpBonusText("solo", 800)).toBe(
      'progression.solo_line:{"multiplier":"0.80"}',
    );
    expect(xpBonusText("solo", 100)).toBe(
      'progression.solo_line:{"multiplier":"0.10"}',
    );
  });

  it("names the heading by the mode", () => {
    expect(xpHeadingKey("solo")).toBe("progression.xp_heading_solo");
    expect(xpHeadingKey("reduced")).toBe("progression.xp_heading_reduced");
    expect(xpHeadingKey("full")).toBe("progression.xp_heading");
    expect(xpHeadingKey(undefined)).toBe("progression.xp_heading");
  });

  it("lists the six criteria in order, with words for each, and skips one it has none for", () => {
    const listed = visibleSoloCriteria(solo());
    expect(listed.map((c) => c.key)).toEqual([
      "tribes",
      "nations",
      "instant_build",
      "infinite_gold",
      "infinite_troops",
      "difficulty",
    ]);
    expect(listed.find((c) => c.key === "difficulty")).toMatchObject({
      met: false,
      labelKey: "progression.solo_criterion_difficulty",
    });
    expect(
      visibleSoloCriteria(
        solo({ criteria: [{ key: "from_a_newer_api", met: true }] }),
      ),
    ).toEqual([]);
    // every criterion has its words in the language file
    for (const key of Object.values(SOLO_CRITERION_KEYS)) {
      expect(
        (en.progression as Record<string, string>)[key.split(".")[1]],
        key,
      ).toBeTruthy();
    }
  });

  it("names the difficulties by the engine's own values, never by a label", () => {
    expect(difficultyNameKey("Hard")).toBe("difficulty.hard");
    expect(difficultyNameKey("Impossible")).toBe("difficulty.impossible");
    expect(difficultyNameKey("Medium")).toBe("difficulty.medium");
    expect(difficultyNameKey("Easy")).toBe("difficulty.easy");
    expect(difficultyNameKey("Hard Mode")).toBeNull();
    expect(difficultyNameKey("hard")).toBeNull();
  });

  it("says the criteria in the words of the setup", () => {
    expect(en.progression.solo_criterion_tribes).toBe("Tribes > 30");
    expect(en.progression.solo_criterion_nations).toBe("Nations > 30");
    expect(en.progression.solo_criterion_instant_build).toBe(
      "Instant Build Off",
    );
    expect(en.progression.solo_criterion_infinite_gold).toBe(
      "Infinite Gold Off",
    );
    expect(en.progression.solo_criterion_infinite_troops).toBe(
      "Infinite Troops Off",
    );
    expect(en.progression.solo_criterion_difficulty).toBe(
      "Difficulty > Medium",
    );
    expect(en.progression.solo_multiplier_label).toBe("Solo multiplier");
  });
});

let host: HTMLElement | null = null;
afterEach(() => host?.remove());

describe("the end-of-game panel for a solo match", () => {
  async function panel(data: GameXpEligible): Promise<GameXpPanel> {
    const el = document.createElement("game-xp-panel") as GameXpPanel;
    host = el;
    el.view = { kind: "result", data };
    // no reveal: show the result as it rests
    el.onScreen = false;
    document.body.appendChild(el);
    await el.updateComplete;
    return el;
  }

  it("headlines Solo XP and lists every criterion with its mark, then the multiplier", async () => {
    const el = await panel(award());
    expect(el.textContent).toContain("progression.xp_heading_solo");
    const rows = [...el.querySelectorAll("[data-xp-solo-criterion]")];
    expect(rows.map((r) => r.getAttribute("data-met"))).toEqual([
      "true",
      "true",
      "true",
      "true",
      "true",
      "false",
    ]);
    // a mark for each, and the missed one reads as missed to a screen reader
    expect(rows[0].textContent).toContain("✓");
    expect(rows[5].textContent).toContain("✕");
    expect(
      rows[5].querySelector("[role='img']")!.getAttribute("aria-label"),
    ).toBe("progression.solo_missed");
    expect(
      el.querySelector("[data-xp-solo-multiplier]")!.textContent,
    ).toContain('"multiplier":"0.80"');
    // the lines add up to the total: 100 + 250 scaled by 0.80
    const lines = [...el.querySelectorAll("[data-xp-line]")].map((l) =>
      l.getAttribute("data-xp-line"),
    );
    expect(lines).toEqual(["played", "win"]);
    expect(el.textContent).toContain('progression.xp_total:{"xp":"280"}');
  });

  it("a fully met setup is 1.00x with every mark met and no multiplier line", async () => {
    const full = award({
      breakdown: breakdown({
        soloPermille: 1000,
        total: 350,
        solo: solo({
          multiplierPermille: 1000,
          failed: 0,
          difficulty: "Hard",
          criteria: solo().criteria.map((c) => ({ ...c, met: true })),
        }),
      }),
    });
    const el = await panel(full);
    expect(
      [...el.querySelectorAll("[data-xp-solo-criterion]")].every(
        (r) => r.getAttribute("data-met") === "true",
      ),
    ).toBe(true);
    expect(
      el.querySelector("[data-xp-solo-multiplier]")!.textContent,
    ).toContain('"multiplier":"1.00"');
    expect(el.querySelector("[data-xp-multiplier]")).toBeNull();
  });

  it("says the setup in words: difficulty, tribes and nations from the match", async () => {
    const el = await panel(award());
    const setup = el.querySelector("[data-xp-solo-setup]")!.textContent!;
    expect(setup).toContain("progression.solo_setup_summary");
    expect(setup).toContain('"difficulty":"difficulty.medium"');
    expect(setup).toContain('"tribes":45');
    expect(setup).toContain('"nations":50');
  });

  it("says what a solo award counts for, and why a reduced one was reduced", async () => {
    expect(
      (await panel(award())).querySelector("[data-xp-note='solo']")!
        .textContent,
    ).toContain("progression.note_solo");
    host?.remove();
    const eliminated = award({
      breakdown: breakdown({
        win: 0,
        subtotal: 100,
        gamePermille: 250,
        reducedReason: "eliminated",
        total: 20,
      }),
    });
    expect(
      (await panel(eliminated)).querySelector("[data-xp-note='solo']")!
        .textContent,
    ).toContain("progression.note_solo_eliminated");
    host?.remove();
    const short = award({
      breakdown: breakdown({
        win: 0,
        subtotal: 100,
        gamePermille: 250,
        reducedReason: "short_game",
        total: 20,
      }),
    });
    expect(
      (await panel(short)).querySelector("[data-xp-note='solo']")!.textContent,
    ).toContain("progression.note_solo_short");
  });

  it("shows no season or challenge card: solo XP is lifetime XP only", async () => {
    const el = await panel(award());
    expect(el.querySelector("[data-xp-season]")).toBeNull();
    expect(el.querySelector("[data-xp-challenge]")).toBeNull();
    expect(el.textContent).not.toContain("progression.season");
  });

  it("a multiplayer award shows none of it", async () => {
    const plain = award({
      mode: undefined,
      breakdown: breakdown({ soloPermille: undefined, solo: undefined }),
    });
    const el = await panel(plain);
    expect(el.querySelector("[data-xp-solo]")).toBeNull();
    expect(el.textContent).toContain(
      '"xp_heading"'.slice(1, -1) === "" ? "" : "progression.xp_heading",
    );
    expect(el.textContent).not.toContain("xp_heading_solo");
  });
});

describe("a past solo match's XP card", () => {
  it("shows the setup as one chip per criterion, met or missed", async () => {
    const card = document.createElement("past-game-xp-card") as PastGameXpCard;
    host = card;
    card.view = { kind: "result", data: award() };
    document.body.appendChild(card);
    await card.updateComplete;
    expect(card.textContent).toContain("progression.xp_heading_solo");
    const chips = [...card.querySelectorAll("[data-past-xp-solo-criterion]")];
    expect(chips.map((c) => c.getAttribute("data-met"))).toEqual([
      "true",
      "true",
      "true",
      "true",
      "true",
      "false",
    ]);
    expect(
      card.querySelector("[data-past-xp-multiplier='solo']")!.textContent,
    ).toContain("progression.solo_line");
    expect(card.querySelector("[data-past-xp-total]")!.textContent).toContain(
      '"xp":"280"',
    );
  });

  it("is plain for a multiplayer award", async () => {
    const card = document.createElement("past-game-xp-card") as PastGameXpCard;
    host = card;
    card.view = {
      kind: "result",
      data: award({
        mode: undefined,
        breakdown: breakdown({ soloPermille: undefined, solo: undefined }),
      }),
    };
    document.body.appendChild(card);
    await card.updateComplete;
    expect(card.querySelector("[data-past-xp-solo]")).toBeNull();
  });
});

describe("XP history", () => {
  it("labels a solo match as one, with its setup in small print", async () => {
    const el = document.createElement("progression-panel") as ProgressionPanel;
    host = el;
    el.load = vi.fn(async () => ({
      progress: award().after,
      rank: "recruit",
      nextMilestone: null,
      season: null,
      seasonTrack: [],
      challenges: {
        daily: { periodKey: "d", resetsAt: "2026-10-16T00:00:00Z", items: [] },
        weekly: { periodKey: "w", resetsAt: "2026-10-19T00:00:00Z", items: [] },
      },
      titles: [],
      selectedTitle: null,
      history: [
        {
          amount: 280,
          source: "match",
          detail: "solo",
          solo: {
            difficulty: "Hard",
            tribes: 40,
            nations: 45,
            multiplierPermille: 800,
          },
          at: "2026-10-14T10:00:00Z",
        },
        { amount: 620, source: "match", at: "2026-10-14T09:00:00Z" },
      ],
      levelHidden: false,
    })) as never;
    document.body.appendChild(el);
    await el.updateComplete;
    await el.refresh();
    await el.updateComplete;
    const history = el.querySelector("[data-progression-history]")!;
    expect(history.textContent).toContain("progression.history_match_solo");
    expect(history.textContent).toContain(
      'progression.history_plus:{"xp":"280"}',
    );
    const meta = history.querySelectorAll("[data-history-solo]");
    // only the solo line carries the small print
    expect(meta).toHaveLength(1);
    expect(meta[0].textContent).toContain("progression.history_solo_meta");
    expect(meta[0].textContent).toContain('"difficulty":"difficulty.hard"');
    expect(meta[0].textContent).toContain('"tribes":40');
    expect(meta[0].textContent).toContain('"nations":45');
  });
});
