import { LiveXpResponseSchema } from "@openfront/shared/ApiSchemas";
import {
  GAMEPLAY_INTENTS,
  LiveProgressSchema,
} from "@openfront/shared/LiveProgress";
import { describe, expect, it } from "vitest";
import { clientsWhoActed } from "../src/account-api/domain/xp";

// The report a game server sends the account API, and what a player reads back.

const player = (i: number) => ({
  clientID: `pl00000${i}`,
  persistentID: `00000000-0000-4000-8000-00000000000${i}`,
  alive: true,
  eliminated: false,
  killedBy: null,
  aliveAtTurn: 100,
  deadAtTurn: null,
  connected: true,
  leftTurn: null,
  acted: true,
});
const report = (over: Record<string, unknown> = {}) => ({
  gameID: "gLIVE0001",
  turn: 100,
  elapsedSeconds: 10,
  config: {
    gameType: "Public",
    gameMode: "Free For All",
    rankedType: null,
    listed: null,
  },
  adminActions: [],
  adminSenders: [],
  result: null,
  players: [player(1), player(2)],
  ...over,
});

describe("LiveProgressSchema", () => {
  it("accepts a running game's report", () => {
    expect(LiveProgressSchema.safeParse(report()).success).toBe(true);
  });

  it("accepts a settled one, with the winner and when", () => {
    const parsed = LiveProgressSchema.safeParse(
      report({ result: { winner: ["player", "pl000001"], resultTurn: 5990 } }),
    );
    expect(parsed.success).toBe(true);
    expect(parsed.data!.result).toEqual({
      winner: ["player", "pl000001"],
      resultTurn: 5990,
    });
  });

  it("reads an older server's report, which says nothing of eliminations, as nobody eliminated", () => {
    const older: Record<string, unknown> = { ...player(1) };
    delete older.eliminated;
    const parsed = LiveProgressSchema.safeParse(report({ players: [older] }));
    expect(parsed.success).toBe(true);
    expect(parsed.data!.players[0].eliminated).toBe(false);
  });

  it("carries an elimination", () => {
    const out = {
      ...player(2),
      alive: false,
      eliminated: true,
      killedBy: "pl000001",
      deadAtTurn: 200,
    };
    const parsed = LiveProgressSchema.safeParse(report({ players: [out] }));
    expect(parsed.data!.players[0]).toMatchObject({
      eliminated: true,
      alive: false,
    });
    expect(
      LiveProgressSchema.safeParse(
        report({ players: [{ ...out, eliminated: "yes" }] }),
      ).success,
    ).toBe(false);
  });

  it("accepts a player with no account, and one who is gone", () => {
    const gone = {
      ...player(2),
      persistentID: null,
      connected: false,
      leftTurn: 40,
    };
    expect(
      LiveProgressSchema.safeParse(report({ players: [player(1), gone] }))
        .success,
    ).toBe(true);
  });

  it.each([
    ["a bad game id", { gameID: "not an id!" }],
    ["a negative turn", { turn: -1 }],
    ["a fractional turn", { turn: 1.5 }],
    ["no config", { config: undefined }],
    ["players that are not a list", { players: "x" }],
    [
      "a player with a bad id",
      { players: [{ ...player(1), clientID: "x y" }] },
    ],
    ["a negative left turn", { players: [{ ...player(1), leftTurn: -3 }] }],
    [
      "a winner that is not one",
      { result: { winner: ["king", "pl000001"], resultTurn: 1 } },
    ],
    ["a result with no turn", { result: { winner: ["player", "pl000001"] } }],
    [
      "too many staff senders",
      {
        adminSenders: Array.from(
          { length: 65 },
          (_, i) => `pl${String(i).padStart(6, "0")}`,
        ),
      },
    ],
    [
      "too many players",
      {
        players: Array.from({ length: 2049 }, (_, i) => ({
          ...player(1),
          clientID: `p${String(i).padStart(7, "0")}`,
        })),
      },
    ],
  ])("refuses %s", (_name, over) => {
    expect(LiveProgressSchema.safeParse(report(over)).success).toBe(false);
  });

  it("keeps only what it knows: a field a report invents is dropped, never carried", () => {
    const parsed = LiveProgressSchema.parse(
      report({
        xpAwarded: 99_999,
        players: [{ ...player(1), kills: 99, xp: 5 }],
      }),
    );
    expect("xpAwarded" in parsed).toBe(false);
    expect("kills" in parsed.players[0]).toBe(false);
    expect("xp" in parsed.players[0]).toBe(false);
  });
});

describe("LiveXpResponseSchema", () => {
  const body = {
    gameId: "g1",
    status: "pending",
    mode: "full",
    reason: null,
    total: 150,
    breakdown: {
      played: 100,
      eliminations: 50,
      subtotal: 150,
      gamePermille: 1000,
      total: 150,
    },
    pending: ["placement", "victory"],
    alive: false,
    winner: false,
  };

  it("reads a preview, filling in what an older breakdown lacks", () => {
    const parsed = LiveXpResponseSchema.parse(body);
    expect(parsed).toMatchObject({
      status: "pending",
      total: 150,
      alive: false,
    });
    expect(parsed.breakdown).toMatchObject({
      played: 100,
      firstGame: 0,
      repeatPermille: 1000,
      leftEarly: false,
    });
  });

  it("reads the final status of a death that has been paid", () => {
    const parsed = LiveXpResponseSchema.parse({
      ...body,
      status: "final",
      mode: "reduced",
      total: 31,
    });
    expect(parsed).toMatchObject({
      status: "final",
      mode: "reduced",
      total: 31,
    });
  });

  it("an unknown status is nothing to show, never an error", () => {
    expect(
      LiveXpResponseSchema.parse({ ...body, status: "brand_new" }).status,
    ).toBe("none");
  });

  it("an unknown mode, pending list or flags fall back to safe ones", () => {
    const parsed = LiveXpResponseSchema.parse({
      ...body,
      mode: "ultra",
      pending: ["nonsense"],
      alive: "yes",
      winner: 3,
      total: "lots",
    });
    expect(parsed).toMatchObject({
      mode: null,
      pending: [],
      alive: true,
      winner: false,
      total: 0,
    });
  });

  it("a forfeit has no breakdown", () => {
    const parsed = LiveXpResponseSchema.parse({
      ...body,
      status: "forfeited",
      reason: "left_early",
      total: 0,
      breakdown: null,
    });
    expect(parsed).toMatchObject({
      status: "forfeited",
      breakdown: null,
      reason: "left_early",
    });
  });
});

describe("GAMEPLAY_INTENTS", () => {
  it("is what counts as playing: not spawning, chat, emoji or host controls", () => {
    for (const type of [
      "attack",
      "boat",
      "build_unit",
      "allianceRequest",
      "donate_gold",
      "embargo",
    ]) {
      expect(GAMEPLAY_INTENTS.has(type), type).toBe(true);
    }
    for (const type of [
      "spawn",
      "emoji",
      "quick_chat",
      "toggle_pause",
      "mark_disconnected",
      "admin_command",
    ]) {
      expect(GAMEPLAY_INTENTS.has(type), type).toBe(false);
    }
  });

  it("is the one definition: the final award reads the same set the server's report does", () => {
    const turns = [...GAMEPLAY_INTENTS, "spawn", "emoji"].map((type, i) => ({
      turnNumber: i,
      intents: [{ type, clientID: `pl${String(i).padStart(6, "0")}` }],
    })) as never;
    expect(clientsWhoActed(turns).size).toBe(GAMEPLAY_INTENTS.size);
  });
});
