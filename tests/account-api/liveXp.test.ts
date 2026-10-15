// @vitest-environment node
import type {
  LiveProgress,
  LiveProgressPlayer,
} from "@openfront/shared/LiveProgress";
import type { Pool } from "pg";
import { describe, expect, it, vi, type Mock } from "vitest";
import { ECONOMY } from "../../src/account-api/domain/constants";
import {
  adminActionsInvalidate,
  leftBeforeResult,
  LIVE_MAX_GAMES,
  LIVE_TTL_MS,
  liveXpFor,
  LiveXpStore,
  type LiveGame,
} from "../../src/account-api/domain/liveXp";
import { RESULT_GRACE_TURNS } from "../../src/account-api/domain/stats";

// A running game's XP as a preview: worked out by the account API from what the
// game server reports, with the very functions that decide the final award. These
// tests read the preview of an 8-player free-for-all (the player count that pays
// the full 1.0x): 100 for taking part plus the day's first-game bonus of 100 is 200
// before anything is earned in the game itself.

const CODE = "gLIVE0001";
const NOW = 1_700_000_000_000;
const user = (i: number) => `00000000-0000-4000-8000-00000000000${i + 1}`;
const cid = (i: number) => `pl00000${i + 1}`;
const RESULT = 6000;

type Patch = Partial<LiveProgressPlayer>;

/** 8 players, all accounts, all acting, all alive and connected, unless patched. */
function progress(
  patch: Record<number, Patch> = {},
  over: Partial<LiveProgress> = {},
  size = 8,
): LiveProgress {
  return {
    gameID: CODE,
    turn: 3000,
    elapsedSeconds: 300,
    config: {
      gameType: "Public",
      gameMode: "Free For All",
      rankedType: null,
      listed: null,
    },
    adminActions: [],
    adminSenders: [],
    result: null,
    players: Array.from({ length: size }, (_, i) => ({
      clientID: cid(i),
      persistentID: user(i),
      alive: true,
      killedBy: null,
      aliveAtTurn: 3000,
      deadAtTurn: null,
      connected: true,
      leftTurn: null,
      acted: true,
      ...patch[i],
    })),
    ...over,
  };
}

/** `who` has been eliminated by player 0, well after the two-minute minimum. */
const felled = (aliveAt = 3000, deadAt = 3100): Patch => ({
  alive: false,
  killedBy: cid(0),
  aliveAtTurn: aliveAt,
  deadAtTurn: deadAt,
});

const fakePool = (rows: unknown[] = []) =>
  ({ query: vi.fn(async () => ({ rows })) }) as unknown as Pool & {
    query: Mock;
  };

function loaded(
  p: LiveProgress,
  kinds: Record<number, "guest" | "registered"> = {},
): { store: LiveXpStore } {
  const store = new LiveXpStore();
  const users = new Map<string, "guest" | "registered">();
  p.players.forEach((pl, i) => {
    if (pl.persistentID !== null)
      users.set(pl.persistentID, kinds[i] ?? "registered");
  });
  const game: LiveGame = {
    progress: p,
    receivedAt: NOW,
    users,
    contexts: new Map(),
  };
  store.set(CODE, game);
  return { store };
}

async function preview(
  p: LiveProgress,
  who = 0,
  kinds: Record<number, "guest" | "registered"> = {},
  pool = fakePool(),
) {
  const { store } = loaded(p, kinds);
  return liveXpFor(pool, CODE, user(who), store, NOW);
}

describe("while the game is on", () => {
  it("shows an alive player what they have earned for playing: 200 before any elimination", async () => {
    const live = await preview(progress());
    expect(live).toMatchObject({
      status: "live",
      mode: "full",
      total: 200,
      alive: true,
      winner: false,
    });
    expect(live!.breakdown).toMatchObject({
      played: 100,
      firstGame: 100,
      eliminations: 0,
      eliminationCount: 0,
      placement: 0,
      win: 0,
      gamePermille: 1000,
    });
  });

  it("an elimination moves it: 25 each, as the stored game will pay", async () => {
    const none = await preview(progress());
    const one = await preview(progress({ 1: felled() }));
    const two = await preview(progress({ 1: felled(), 2: felled() }));
    expect(none!.total).toBe(200);
    expect(one!.total).toBe(225);
    expect(two!.total).toBe(250);
    expect(two!.breakdown).toMatchObject({
      eliminations: 50,
      eliminationCount: 2,
    });
  });

  it("counts a victim once however it shows up, and never the player themselves", async () => {
    const live = await preview(
      progress({
        0: { alive: false, killedBy: cid(0), deadAtTurn: 3100 },
        1: felled(),
      }),
    );
    expect(live!.breakdown!.eliminationCount).toBe(1);
  });

  it("the limit is six eliminations", async () => {
    const patch: Record<number, Patch> = {};
    for (let i = 1; i < 8; i++) patch[i] = felled();
    const live = await preview(progress(patch));
    expect(live!.breakdown!.eliminationCount).toBe(6);
    expect(live!.total).toBe(200 + 6 * 25);
  });

  it("only counts a victim who lasted the minimum: seen alive at or after the elimination minimum", async () => {
    const min = ECONOMY.minEliminationTick;
    // fell between turns 1000 and 1100: a fresh spawn's free kill
    expect((await preview(progress({ 1: felled(1000, 1100) })))!.total).toBe(
      200,
    );
    // fell somewhere in 1100..1200: not known to have lasted, so not counted yet
    expect(
      (await preview(progress({ 1: felled(min - 100, min) })))!.total,
    ).toBe(200);
    // seen alive at the minimum: fell after it
    expect(
      (await preview(progress({ 1: felled(min, min + 100) })))!.total,
    ).toBe(225);
    // never seen alive in a snapshot: it died within the first hundred turns
    expect(
      (await preview(progress({ 1: { ...felled(), aliveAtTurn: null } })))!
        .total,
    ).toBe(200);
  });

  it("only a human's elimination counts: a victim a bot or nation felled earns nobody anything", async () => {
    const live = await preview(
      progress({
        1: {
          alive: false,
          killedBy: null,
          aliveAtTurn: 3000,
          deadAtTurn: 3100,
        },
      }),
    );
    expect(live!.total).toBe(200);
  });

  it("never invents what is not known: no victory, no placement, no challenge or season XP", async () => {
    const live = await preview(progress({ 1: felled() }));
    expect(live!.breakdown).toMatchObject({
      win: 0,
      placement: 0,
      firstWin: 0,
    });
    // what is still to be decided is said, not guessed
    expect(live!.pending).toEqual([
      "placement",
      "victory",
      "challenges",
      "season",
    ]);
  });

  it("reads the player-count multiplier from who is in it: 4 players pay half", async () => {
    const live = await preview(progress({}, {}, 4));
    expect(live!.breakdown!.gamePermille).toBe(500);
    // (100 + 100) x 0.5
    expect(live!.total).toBe(100);
  });

  it("only counts players who have acted towards that multiplier", async () => {
    // 8 humans but 3 never took an action: 5 are in it, which is the 0.5x band
    const idle: Record<number, Patch> = {
      5: { acted: false },
      6: { acted: false },
      7: { acted: false },
    };
    expect((await preview(progress(idle)))!.breakdown!.gamePermille).toBe(500);
  });

  it("uses what the day has already paid: the first-game bonus is gone once used", async () => {
    const used = fakePool([
      { match_xp: "300", first_game_ref: "gOTHER001", first_win_ref: null },
    ]);
    const live = await preview(progress(), 0, {}, used);
    expect(live!.breakdown!.firstGame).toBe(0);
    expect(live!.total).toBe(100);
  });

  it("applies the daily soft cap", async () => {
    const capped = fakePool([
      { match_xp: "6000", first_game_ref: "x", first_win_ref: "y" },
    ]);
    const live = await preview(progress(), 0, {}, capped);
    // 100 at the soft rate (25%)
    expect(live!.total).toBe(25);
    expect(live!.breakdown!.softCapped).toBe(true);
  });
});

describe("eliminated but still there", () => {
  const out = (over: Patch = {}) => ({
    0: {
      alive: false,
      killedBy: cid(1),
      aliveAtTurn: 3000,
      deadAtTurn: 3100,
      ...over,
    },
  });

  it("is pending: the XP they have is theirs once the result is settled, if they stay", async () => {
    const live = await preview(progress({ ...out(), 1: { killedBy: null } }));
    expect(live).toMatchObject({
      status: "pending",
      alive: false,
      mode: "full",
    });
    // participation and the first game: eliminations they made before dying still count
    expect(live!.total).toBe(200);
  });

  it("keeps the eliminations they made before they fell", async () => {
    const live = await preview(
      progress({ ...out(), 2: felled(), 3: felled() }),
    );
    expect(live!.status).toBe("pending");
    expect(live!.total).toBe(250);
    expect(live!.breakdown!.eliminationCount).toBe(2);
  });

  it("has nothing more to place: placement stays pending until the result", async () => {
    const live = await preview(progress(out()));
    expect(live!.pending).toContain("placement");
    expect(live!.breakdown!.placement).toBe(0);
    expect(live!.pending).not.toContain("victory");
  });

  it("falling in the first two minutes pays nothing: they did not play", async () => {
    const live = await preview(
      progress(out({ aliveAtTurn: 800, deadAtTurn: 900 })),
    );
    expect(live).toMatchObject({
      status: "none",
      reason: "eliminated_early",
      total: 0,
    });
  });

  it("falling when it is not known to be early still previews: the stored game decides", async () => {
    const min = ECONOMY.minEliminationTick;
    const live = await preview(
      progress(out({ aliveAtTurn: min - 100, deadAtTurn: min })),
    );
    expect(live!.status).toBe("pending");
  });
});

describe("leaving before the result forfeits", () => {
  it("an alive player who left: forfeited, nothing", async () => {
    const live = await preview(
      progress({ 0: { connected: false, leftTurn: 4000 } }),
    );
    expect(live).toMatchObject({
      status: "forfeited",
      reason: "left_early",
      total: 0,
      mode: "full",
      breakdown: null,
    });
  });

  it("an eliminated player who left: forfeited too, whatever they had", async () => {
    const live = await preview(
      progress({
        0: { alive: false, killedBy: cid(1), connected: false, leftTurn: 4000 },
        2: felled(),
      }),
    );
    expect(live).toMatchObject({ status: "forfeited", total: 0 });
  });

  it("a drop that came back is not leaving", async () => {
    // connected again: no leftTurn
    expect(
      (await preview(progress({ 0: { connected: true, leftTurn: null } })))!
        .status,
    ).toBe("live");
    // gone but the roster has not recorded when (nothing to judge): still playing
    expect(
      (await preview(progress({ 0: { connected: false, leftTurn: null } })))!
        .status,
    ).toBe("live");
  });

  it("leaving also takes them out of everyone else's player count", async () => {
    // 6 stay, 2 left: 6 are in it, still the 1.0x band
    const patch: Record<number, Patch> = {
      6: { connected: false, leftTurn: 2000 },
      7: { connected: false, leftTurn: 2000 },
    };
    expect((await preview(progress(patch)))!.breakdown!.gamePermille).toBe(
      1000,
    );
    // 3 left: 5 are in it, the 0.5x band
    patch[5] = { connected: false, leftTurn: 2000 };
    expect((await preview(progress(patch)))!.breakdown!.gamePermille).toBe(500);
  });
});

describe("the result is in", () => {
  const settled = (winner = 0): Partial<LiveProgress> => ({
    result: { winner: ["player", cid(winner)], resultTurn: RESULT },
    turn: RESULT + 20,
  });

  it("the winner's victory and placement are final: they join the preview", async () => {
    const live = await preview(progress({}, settled()));
    expect(live).toMatchObject({
      status: "settled",
      winner: true,
      alive: true,
    });
    // played 100 + placement 150 (1st of 8) + victory 250 + first game 100 + first win 150
    expect(live!.breakdown).toMatchObject({
      played: 100,
      placement: 150,
      win: 250,
      firstGame: 100,
      firstWin: 150,
    });
    expect(live!.total).toBe(750);
    // only what is paid with the stored game is still to come
    expect(live!.pending).toEqual(["challenges", "season"]);
  });

  it("a winner who left once the win was determined still has it", async () => {
    const live = await preview(
      progress({ 0: { connected: false, leftTurn: RESULT + 12 } }, settled()),
    );
    expect(live).toMatchObject({ status: "settled", winner: true, total: 750 });
  });

  it("a winner who left before the result does not: their empire won without them", async () => {
    const live = await preview(
      progress({ 0: { connected: false, leftTurn: 4000 } }, settled()),
    );
    expect(live).toMatchObject({ status: "forfeited", total: 0 });
  });

  it("the grace before the result counts as after it, one turn earlier does not", async () => {
    const at = (leftTurn: number) =>
      preview(progress({ 0: { connected: false, leftTurn } }, settled()));
    expect((await at(RESULT - RESULT_GRACE_TURNS))!.status).toBe("settled");
    expect((await at(RESULT - RESULT_GRACE_TURNS - 1))!.status).toBe(
      "forfeited",
    );
  });

  it("anyone else is settled without a placement: it stays pending until the stored game", async () => {
    const live = await preview(progress({}, settled(1)), 0);
    expect(live).toMatchObject({ status: "settled", winner: false });
    expect(live!.breakdown).toMatchObject({ placement: 0, win: 0 });
    expect(live!.pending).toEqual(["placement", "challenges", "season"]);
    expect(live!.total).toBe(200);
  });

  it("an eliminated player who stayed is settled; one who left before the result is not", async () => {
    const out = { alive: false, killedBy: cid(1), deadAtTurn: 3100 };
    const stayed = await preview(progress({ 0: out }, settled(1)));
    expect(stayed!.status).toBe("settled");
    const left = await preview(
      progress({ 0: { ...out, connected: false, leftTurn: 3500 } }, settled(1)),
    );
    expect(left!.status).toBe("forfeited");
  });

  it("a team game has no placement to wait for", async () => {
    const team = progress(
      {},
      {
        ...settled(),
        config: {
          gameType: "Public",
          gameMode: "Team",
          rankedType: null,
          listed: null,
        },
      },
    );
    const live = await preview(team);
    expect(live!.pending).not.toContain("placement");
    expect(live!.breakdown!.placement).toBe(0);
  });
});

describe("reduced games", () => {
  const priv = (over: Partial<LiveProgress["config"]> = {}) => ({
    config: {
      gameType: "Private",
      gameMode: "Free For All",
      rankedType: null,
      listed: null,
      ...over,
    },
  });

  it("a private game previews the quarter: 100 x 0.25 = 25", async () => {
    const live = await preview(progress({}, priv()));
    expect(live).toMatchObject({ status: "live", mode: "reduced", total: 25 });
    expect(live!.breakdown).toMatchObject({
      played: 100,
      eliminations: 0,
      gamePermille: 250,
      reducedReason: "private_game",
      firstGame: 0,
      placement: 0,
      win: 0,
    });
    // nothing competitive: nothing left to decide
    expect(live!.pending).toEqual([]);
  });

  it("with an elimination: (100 + 25) x 0.25 = 31", async () => {
    const live = await preview(progress({ 1: felled() }, priv()));
    expect(live!.total).toBe(31);
    expect(live!.breakdown!.eliminationCount).toBe(1);
  });

  it("says why: unlisted, and a public game with too few humans", async () => {
    expect(
      (await preview(progress({}, priv({ listed: false }))))!.breakdown!
        .reducedReason,
    ).toBe("unlisted_game");
    // a public game where only one player has an account
    const lowPop = progress({}, {}, 8);
    lowPop.players.forEach((p, i) => {
      if (i > 0) p.persistentID = null;
    });
    const live = await preview(lowPop);
    expect(live).toMatchObject({ status: "live", mode: "reduced", total: 25 });
    expect(live!.breakdown!.reducedReason).toBe("public_too_few_humans");
  });

  it("a reduced game pays no victory or placement even to the winner, and says it is settled", async () => {
    const live = await preview(
      progress(
        {},
        {
          ...priv(),
          result: { winner: ["player", cid(0)], resultTurn: RESULT },
        },
      ),
    );
    expect(live).toMatchObject({ status: "settled", winner: true, total: 25 });
    expect(live!.breakdown).toMatchObject({
      win: 0,
      placement: 0,
      firstWin: 0,
    });
    expect(live!.pending).toEqual([]);
  });

  it("the same rules: an eliminated player is pending, one who left is forfeited", async () => {
    const out = { alive: false, killedBy: cid(1), deadAtTurn: 3100 };
    expect((await preview(progress({ 0: out }, priv())))!.status).toBe(
      "pending",
    );
    const left = await preview(
      progress({ 0: { connected: false, leftTurn: 3000 } }, priv()),
    );
    expect(left).toMatchObject({
      status: "forfeited",
      mode: "reduced",
      total: 0,
    });
  });

  it("a game that is not yet two minutes old previews as it will count", async () => {
    const live = await preview(progress({}, { elapsedSeconds: 45 }));
    expect(live).toMatchObject({ status: "live", mode: "full" });
  });
});

describe("what pays nothing", () => {
  it("a guest", async () => {
    expect(await preview(progress(), 0, { 0: "guest" })).toMatchObject({
      status: "none",
      reason: "guest",
      total: 0,
    });
  });

  it("a ranked game and a singleplayer record", async () => {
    const ranked = progress(
      {},
      {
        config: {
          gameType: "Public",
          gameMode: "Free For All",
          rankedType: "1v1",
          listed: null,
        },
      },
    );
    expect(await preview(ranked)).toMatchObject({
      status: "none",
      reason: "ranked",
    });
    const solo = progress(
      {},
      {
        config: {
          gameType: "Singleplayer",
          gameMode: "Free For All",
          rankedType: null,
          listed: null,
        },
      },
    );
    expect(await preview(solo)).toMatchObject({
      status: "none",
      reason: "singleplayer",
    });
  });

  it("a game staff tests changed", async () => {
    const tested = progress(
      {},
      {
        adminActions: [
          {
            command: "give_gold",
            role: "admin",
            public: true,
            listed: false,
            invalidatesResult: true,
            count: 1,
          },
        ],
      },
    );
    expect(await preview(tested)).toMatchObject({
      status: "none",
      reason: "admin_modified",
    });
  });

  it("an admin who ran a command, even when the game counts", async () => {
    const owner = progress(
      {},
      {
        adminSenders: [cid(0)],
        adminActions: [
          {
            command: "give_gold",
            role: "owner",
            public: true,
            listed: false,
            invalidatesResult: false,
            count: 1,
          },
        ],
      },
    );
    expect(await preview(owner)).toMatchObject({
      status: "none",
      reason: "admin_actor",
    });
    // the others are paid as usual
    expect((await preview(owner, 1))!.status).toBe("live");
  });

  it("the staff-command verdict is the final rule's, role and game kind included", () => {
    const action = (
      role: "owner" | "admin",
      pub: boolean,
      listed: boolean,
    ) => ({
      command: "give_gold" as const,
      role,
      public: pub,
      listed,
      invalidatesResult: false,
      count: 1,
    });
    expect(adminActionsInvalidate([])).toBe(false);
    expect(adminActionsInvalidate([action("owner", true, false)])).toBe(false);
    expect(adminActionsInvalidate([action("admin", true, false)])).toBe(true);
    expect(adminActionsInvalidate([action("owner", false, false)])).toBe(true);
  });
});

describe("whose preview it is", () => {
  it("is null for a game the API was not told about, and for someone not in it", async () => {
    const { store } = loaded(progress());
    expect(
      await liveXpFor(fakePool(), "gOTHER002", user(0), store, NOW),
    ).toBeNull();
    expect(
      await liveXpFor(
        fakePool(),
        CODE,
        "00000000-0000-4000-8000-0000000000ff",
        store,
        NOW,
      ),
    ).toBeNull();
  });

  it("is null for a player the game has no account for", async () => {
    const p = progress();
    p.players[0].persistentID = null;
    expect(await preview(p)).toBeNull();
  });

  it("matches a player's account whatever the case of the id the server recorded", async () => {
    const p = progress();
    p.players[0].persistentID = user(0).toUpperCase();
    const { store } = loaded(p);
    // the account list is keyed by the lower-case id, as ingestion keys it
    const game = store.get(CODE, NOW)!;
    (game.users as Map<string, "registered">).set(user(0), "registered");
    expect(
      await liveXpFor(fakePool(), CODE, user(0), store, NOW),
    ).not.toBeNull();
  });

  it("each player's own preview, from the same report", async () => {
    const p = progress({ 1: felled() });
    const winner = await preview(p, 0);
    const victim = await preview(p, 1);
    expect(winner!.total).toBe(225);
    expect(victim!.status).toBe("pending");
    expect(victim!.total).toBe(200);
  });
});

describe("leftBeforeResult", () => {
  const p = (over: Patch): LiveProgressPlayer => ({
    clientID: cid(0),
    persistentID: user(0),
    alive: true,
    killedBy: null,
    aliveAtTurn: 0,
    deadAtTurn: null,
    connected: true,
    leftTurn: null,
    acted: true,
    ...over,
  });
  it("needs the roster to say they are gone and when", () => {
    expect(leftBeforeResult(p({}), null)).toBe(false);
    expect(leftBeforeResult(p({ connected: false }), null)).toBe(false);
    expect(leftBeforeResult(p({ connected: false, leftTurn: 10 }), null)).toBe(
      true,
    );
    expect(leftBeforeResult(p({ connected: true, leftTurn: 10 }), null)).toBe(
      false,
    );
  });
  it("once there is a result, only a departure before it counts", () => {
    const gone = (leftTurn: number) => p({ connected: false, leftTurn });
    expect(leftBeforeResult(gone(100), 6000)).toBe(true);
    expect(leftBeforeResult(gone(6000), 6000)).toBe(false);
    expect(leftBeforeResult(gone(5995), 6000)).toBe(false);
    expect(leftBeforeResult(gone(5994), 6000)).toBe(true);
  });
});

describe("the store of running games", () => {
  const game = (n: number): LiveGame => ({
    progress: { ...progress(), gameID: `g${String(n).padStart(8, "0")}` },
    receivedAt: NOW,
    users: new Map(),
    contexts: new Map(),
  });

  it("forgets a game that stopped reporting", () => {
    const store = new LiveXpStore();
    store.set(CODE, game(1));
    expect(store.get(CODE, NOW + LIVE_TTL_MS - 1)).toBeDefined();
    expect(store.get(CODE, NOW + LIVE_TTL_MS + 1)).toBeUndefined();
    expect(store.size).toBe(0);
  });

  it("keeps a bounded number of games, the oldest report going first", () => {
    const store = new LiveXpStore();
    for (let i = 0; i < LIVE_MAX_GAMES + 5; i++) store.set(`g${i}`, game(i));
    expect(store.size).toBe(LIVE_MAX_GAMES);
    expect(store.get("g0", NOW)).toBeUndefined();
    expect(store.get(`g${LIVE_MAX_GAMES + 4}`, NOW)).toBeDefined();
  });

  it("a fresh report keeps what was already read about the players", () => {
    const store = new LiveXpStore();
    const first = game(1);
    first.contexts.set("u", {
      at: 1,
      earnedToday: 5,
      firstGameAvailable: true,
      firstWinAvailable: true,
      repeat: 1000,
    });
    store.set(CODE, first);
    store.set(CODE, game(1));
    expect(store.get(CODE, NOW)!.contexts.get("u")?.earnedToday).toBe(5);
  });

  it("deletes a game, and clears them all", () => {
    const store = new LiveXpStore();
    store.set(CODE, game(1));
    store.delete(CODE);
    expect(store.size).toBe(0);
    store.set(CODE, game(1));
    store.clear();
    expect(store.size).toBe(0);
  });
});

describe("reads of the day are reused, not repeated for every poll", () => {
  it("asks the database once per player for a while", async () => {
    const pool = fakePool();
    const { store } = loaded(progress());
    await liveXpFor(pool, CODE, user(0), store, NOW);
    const first = (pool.query as ReturnType<typeof vi.fn>).mock.calls.length;
    await liveXpFor(pool, CODE, user(0), store, NOW + 5_000);
    expect((pool.query as ReturnType<typeof vi.fn>).mock.calls.length).toBe(
      first,
    );
    await liveXpFor(pool, CODE, user(0), store, NOW + 60_000);
    expect(
      (pool.query as ReturnType<typeof vi.fn>).mock.calls.length,
    ).toBeGreaterThan(first);
  });
});
