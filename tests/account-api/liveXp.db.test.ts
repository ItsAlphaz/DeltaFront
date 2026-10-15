// @vitest-environment node
import type {
  LiveProgress,
  LiveProgressPlayer,
} from "@openfront/shared/LiveProgress";
import { xpForLevel } from "@openfront/shared/ProgressionRules";
import { afterEach, beforeEach, expect, it } from "vitest";
import { settleEliminations } from "../../src/account-api/domain/earlyXp";
import {
  acceptProgress,
  liveXpStore,
} from "../../src/account-api/domain/liveXp";
import { applySoftCap } from "../../src/account-api/domain/xp";
import {
  buildRecord,
  clientIdOf,
  DEFAULT_END_MS,
  makeUser,
  submitGame,
  type GameSpec,
  type TestUser,
} from "./util/games";
import {
  call,
  createServerKey,
  startHarness,
  type Harness,
} from "./util/harness";
import { describeDb } from "./util/testDb";

// The XP of a running game, end to end through the account API: a game server's
// report in, a player's preview out. A report pays exactly one thing: an
// eliminated account's reduced award, at once, while the match goes on. Everything
// else is paid by the stored game, once it arrives, and the stored game adopts a
// death's award instead of paying it again. The preview of a settled winner is
// the award it will be; every award is made exactly once however many reports and
// repeats come before and after.

const FEATURES = "accounts,store,inventory,clans,leaderboards,progression";
const harnesses: Harness[] = [];
beforeEach(() => liveXpStore.clear());
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.close();
  liveXpStore.clear();
});

let seq = 0;
const gameId = () => `lv${String(++seq).padStart(6, "0")}`;
const RESULT = 5990;

async function setup(players = 6, kind: "guest" | "registered" = "registered") {
  const h = await startHarness({ features: FEATURES });
  harnesses.push(h);
  const key = await createServerKey(h);
  const users: TestUser[] = [];
  for (let i = 0; i < players; i++) users.push(await makeUser(h, kind));
  return { h, key, users };
}

const q = async (h: Harness, sql: string, params: unknown[] = []) =>
  (await h.db.pool.query(sql, params)).rows;

/**
 * Six players. 0 wins having eliminated 2 (who fell at tick 5000); 1 is left
 * alive with less land; 2..5 were eliminated at 5000..2000. As the game server
 * archives it.
 */
function record(users: TestUser[], over: Partial<GameSpec> = {}): GameSpec {
  return {
    allAct: true,
    resultTurn: RESULT,
    players: [
      {
        user: users[0],
        stats: { kills: [{ victim: clientIdOf(2), tick: "5000" }] },
      },
      { user: users[1], stats: { finalTiles: "400" } },
      { user: users[2], fate: { killedAt: 5000 } },
      { user: users[3], fate: { killedAt: 4000 } },
      { user: users[4], fate: { killedAt: 3000 } },
      { user: users[5], fate: { killedAt: 2000 } },
    ],
    ...over,
  };
}

type Patch = Partial<LiveProgressPlayer>;

/** The same game as the server reports it, optionally already settled. */
function live(
  id: string,
  users: TestUser[],
  patch: Record<number, Patch> = {},
  over: Partial<LiveProgress> = {},
): LiveProgress {
  const dead = (i: number, at: number, by: string | null = null): Patch => ({
    alive: false,
    eliminated: true,
    killedBy: by,
    aliveAtTurn: at - 100,
    deadAtTurn: at,
  });
  const base: Record<number, Patch> = {
    2: dead(2, 5000, clientIdOf(0)),
    3: dead(3, 4000),
    4: dead(4, 3000),
    5: dead(5, 2000),
  };
  return {
    gameID: id,
    turn: 5000,
    elapsedSeconds: 500,
    config: {
      gameType: "Public",
      gameMode: "Free For All",
      rankedType: null,
      listed: null,
    },
    adminActions: [],
    adminSenders: [],
    result: null,
    players: users.map((u, i) => ({
      clientID: clientIdOf(i),
      persistentID: u.id,
      alive: true,
      eliminated: false,
      killedBy: null,
      aliveAtTurn: 5000,
      deadAtTurn: null,
      connected: true,
      leftTurn: null,
      acted: true,
      ...base[i],
      ...patch[i],
    })),
    ...over,
  };
}

/** Everyone still in it: none of the four who fell in `live()` has yet. */
const ALL_IN: Record<number, Patch> = Object.fromEntries(
  [2, 3, 4, 5].map((i) => [
    i,
    {
      alive: true,
      eliminated: false,
      killedBy: null,
      aliveAtTurn: 5000,
      deadAtTurn: null,
    } as Patch,
  ]),
);

const settled = (winner = 0): Partial<LiveProgress> => ({
  turn: RESULT + 10,
  result: { winner: ["player", clientIdOf(winner)], resultTurn: RESULT },
});

function report(
  h: Harness,
  key: string | undefined,
  progress: LiveProgress,
  id = progress.gameID,
) {
  return call(h, `/game/${id}/progress`, {
    method: "POST",
    json: progress,
    origin: null,
    headers: key === undefined ? {} : { "x-api-key": key },
  });
}

async function preview(h: Harness, user: TestUser, id: string) {
  const res = await call(h, `/users/@me/xp/live/${id}`, {
    bearer: user.jwt,
    origin: null,
  });
  return {
    status: res.status,
    body: res.status === 200 ? await res.json() : null,
  };
}

async function stored(h: Harness, key: string, spec: GameSpec, id: string) {
  const res = await submitGame(h, key, buildRecord(id, spec));
  expect(res.status).toBe(200);
}

async function awarded(h: Harness, id: string, user: TestUser) {
  const rows = await q(
    h,
    `SELECT p.xp_awarded::int AS xp, p.clan_xp::int AS clan_xp, p.xp_result
       FROM game_players p JOIN games g ON g.id = p.game_id
      WHERE g.game_code = $1 AND p.user_id = $2`,
    [id, user.id],
  );
  return rows[0] as { xp: number; clan_xp: number; xp_result: any };
}

const ledgerRows = (h: Harness, user: TestUser) =>
  q(
    h,
    "SELECT source, ref_id, delta::int AS delta FROM xp_ledger WHERE user_id = $1 ORDER BY id",
    [user.id],
  );

const matchRows = async (h: Harness, user: TestUser) =>
  (await ledgerRows(h, user)).filter((r) => r.source === "match");

describeDb("the game server's report", () => {
  it("is accepted from a game server and from nothing else", async () => {
    const { h, key, users } = await setup();
    const id = gameId();
    const p = live(id, users);
    expect((await report(h, key, p)).status).toBe(200);
    // no key
    expect((await report(h, undefined, p)).status).toBe(401);
    // a key that is not one
    expect(
      (await report(h, "not-a-server-key-0123456789abcdef", p)).status,
    ).toBe(401);
    // a browser: refused before anything else is looked at
    const browser = await call(h, `/game/${id}/progress`, {
      method: "POST",
      json: p,
      headers: { "x-api-key": key },
    });
    expect(browser.status).toBe(403);
    expect(await browser.json()).toEqual({ error: "browser_not_allowed" });
    // a player's own bearer is not a server key
    const player = await call(h, `/game/${id}/progress`, {
      method: "POST",
      json: p,
      origin: null,
      bearer: users[0].jwt,
    });
    expect(player.status).toBe(401);
  });

  it("must be well formed and name the game it is sent to", async () => {
    const { h, key, users } = await setup();
    const id = gameId();
    expect(
      (await report(h, key, { ...live(id, users), players: "x" } as never))
        .status,
    ).toBe(400);
    expect((await report(h, key, live(id, users), "lvOTHER001")).status).toBe(
      400,
    );
    expect((await report(h, key, live(id, users), "bad id!")).status).toBe(400);
    // an unknown field changes nothing: a report is data, never a command
    const extra = {
      ...live(id, users, ALL_IN),
      xpAwarded: 99_999,
    } as unknown as LiveProgress;
    expect((await report(h, key, extra)).status).toBe(200);
    expect(await q(h, "SELECT 1 FROM xp_ledger")).toHaveLength(0);
  });

  it("pays a death and nothing else: no one still in it, no stored game row, no season", async () => {
    const { h, key, users } = await setup();
    const id = gameId();
    await q(
      h,
      "INSERT INTO seasons (number, name, starts_at, ends_at) VALUES (1, 'Opening', '2023-11-01', '2030-12-01')",
    );
    await report(h, key, live(id, users, {}, settled()));
    // the four who were eliminated have their reduced award (100 x 0.25) ...
    for (const i of [2, 3, 4, 5]) {
      expect(await matchRows(h, users[i]), `player ${i}`).toEqual([
        { source: "match", ref_id: id, delta: 25 },
      ]);
    }
    // ... the winner and the runner-up have nothing yet: the stored game pays them
    for (const i of [0, 1]) expect(await matchRows(h, users[i])).toEqual([]);
    expect(await q(h, "SELECT 1 FROM game_players")).toHaveLength(0);
    expect(await q(h, "SELECT 1 FROM games")).toHaveLength(0);
    // a death is lifetime XP only
    expect(await q(h, "SELECT 1 FROM user_season_progress")).toHaveLength(0);
    expect(await q(h, "SELECT 1 FROM challenge_progress")).toHaveLength(0);
  });

  it("with nobody eliminated a report moves nothing in the ledger, the progress or the season", async () => {
    const { h, key, users } = await setup();
    const id = gameId();
    await report(h, key, live(id, users, ALL_IN, settled()));
    expect(await q(h, "SELECT 1 FROM xp_ledger")).toHaveLength(0);
    expect(await q(h, "SELECT 1 FROM user_progress")).toHaveLength(0);
    expect(await q(h, "SELECT 1 FROM early_xp")).toHaveLength(0);
    expect(await q(h, "SELECT 1 FROM game_players")).toHaveLength(0);
  });

  it("is ignored once the game is stored: a late report leaves no stale preview", async () => {
    const { h, key, users } = await setup();
    const id = gameId();
    await stored(h, key, record(users), id);
    const late = await report(h, key, live(id, users, {}, settled()));
    expect(late.status).toBe(200);
    expect(await late.json()).toEqual({ ok: true, ignored: true });
    expect((await preview(h, users[0], id)).status).toBe(404);
  });
});

describeDb("a player's preview", () => {
  it("needs a signed-in account, and is the caller's own", async () => {
    const { h, key, users } = await setup();
    const id = gameId();
    await report(h, key, live(id, users));
    expect(
      (await call(h, `/users/@me/xp/live/${id}`, { origin: null })).status,
    ).toBe(401);
    const mine = await preview(h, users[0], id);
    expect(mine.status).toBe(200);
    expect(mine.body).toMatchObject({
      gameId: id,
      status: "live",
      mode: "full",
      alive: true,
    });
    // someone who was not in the game, and a game nobody reported
    const stranger = await makeUser(h);
    expect((await preview(h, stranger, id)).status).toBe(404);
    expect((await preview(h, users[0], "lvNOBODY01")).status).toBe(404);
  });

  it("is what the report says and nothing a request can change", async () => {
    const { h, key, users } = await setup();
    const id = gameId();
    await report(h, key, live(id, users));
    const before = await preview(h, users[0], id);
    // a client has no way to move it: it can only ask, and what it adds to the
    // request is ignored
    const asked = await call(
      h,
      `/users/@me/xp/live/${id}?total=99999&status=settled&eliminations=6`,
      {
        bearer: users[0].jwt,
        origin: null,
        headers: { "x-xp": "99999" },
      },
    );
    expect(await asked.json()).toEqual(before.body);
    // and it cannot post a report of its own
    const forged = await call(h, `/game/${id}/progress`, {
      method: "POST",
      json: live(id, users, { 0: { alive: false } }),
      origin: null,
      bearer: users[0].jwt,
    });
    expect(forged.status).toBe(401);
    expect((await preview(h, users[0], id)).body).toEqual(before.body);
  });

  it("moves with the report: an elimination changes the figure", async () => {
    const { h, key, users } = await setup();
    const id = gameId();
    await report(
      h,
      key,
      live(id, users, {
        2: { alive: true, killedBy: null, deadAtTurn: null, aliveAtTurn: 5000 },
      }),
    );
    const none = await preview(h, users[0], id);
    await report(h, key, live(id, users));
    const one = await preview(h, users[0], id);
    // 6 players is the 1.0x band: played 100 + first game 100, then +25
    expect(none.body.total).toBe(200);
    expect(one.body.total).toBe(225);
    expect(one.body.breakdown).toMatchObject({
      eliminations: 25,
      eliminationCount: 1,
    });
  });

  it("a guest is told it pays nothing", async () => {
    const { h, key, users } = await setup(6, "guest");
    const id = gameId();
    await report(h, key, live(id, users));
    expect((await preview(h, users[0], id)).body).toMatchObject({
      status: "none",
      reason: "guest",
    });
  });

  it("is gone once the game is stored: the stored XP answers instead", async () => {
    const { h, key, users } = await setup();
    const id = gameId();
    await report(h, key, live(id, users, {}, settled()));
    expect((await preview(h, users[0], id)).status).toBe(200);
    await stored(h, key, record(users), id);
    expect((await preview(h, users[0], id)).status).toBe(404);
    const final = await call(h, `/users/@me/xp/${id}`, {
      bearer: users[0].jwt,
      origin: null,
    });
    expect(final.status).toBe(200);
    expect((await final.json()).eligible).toBe(true);
  });
});

describeDb("a winner is final the moment the result is settled", () => {
  it("sees victory and placement before the game is stored, and is paid exactly that", async () => {
    const { h, key, users } = await setup();
    const id = gameId();
    // the result is in; the record has not been uploaded
    await report(h, key, live(id, users, {}, settled()));
    const settledView = await preview(h, users[0], id);
    expect(settledView.body).toMatchObject({
      status: "settled",
      winner: true,
      alive: true,
    });
    // played 100 + placement 150 + victory 250 + elimination 25 + first game 100 + first win 150
    expect(settledView.body.breakdown).toMatchObject({
      played: 100,
      placement: 150,
      win: 250,
      eliminations: 25,
      firstGame: 100,
      firstWin: 150,
    });
    expect(settledView.body.total).toBe(775);
    expect(await matchRows(h, users[0])).toHaveLength(0);

    // then the stored game awards the very same amount
    await stored(h, key, record(users), id);
    const final = await awarded(h, id, users[0]);
    expect(final.xp).toBe(settledView.body.total);
    expect(final.xp_result.breakdown).toMatchObject({
      played: 100,
      placement: 150,
      win: 250,
      eliminations: 25,
      firstGame: 100,
      firstWin: 150,
    });
  });

  it("can leave from the win screen: the XP is paid all the same", async () => {
    const { h, key, users } = await setup();
    const id = gameId();
    // out of the game a moment after the result, before it is stored
    const gone: Patch = { connected: false, leftTurn: RESULT + 12 };
    await report(h, key, live(id, users, { 0: gone }, settled()));
    expect((await preview(h, users[0], id)).body).toMatchObject({
      status: "settled",
      winner: true,
      total: 775,
    });
    await stored(
      h,
      key,
      record(users, {
        players: record(users).players.map((p, i) =>
          i === 0 ? { ...p, leftTurn: RESULT + 12 } : p,
        ),
      }),
      id,
    );
    const final = await awarded(h, id, users[0]);
    expect(final.xp).toBe(775);
    expect(final.xp_result).toMatchObject({ eligible: true, mode: "full" });
    expect(await matchRows(h, users[0])).toHaveLength(1);
  });

  it("is not paid for an empire that won after they left: forfeited in the preview, and in the award", async () => {
    const { h, key, users } = await setup();
    const id = gameId();
    await report(
      h,
      key,
      live(id, users, { 0: { connected: false, leftTurn: 4000 } }, settled()),
    );
    expect((await preview(h, users[0], id)).body).toMatchObject({
      status: "forfeited",
      total: 0,
    });
    await stored(
      h,
      key,
      record(users, {
        players: record(users).players.map((p, i) =>
          i === 0 ? { ...p, leftTurn: 4000 } : p,
        ),
      }),
      id,
    );
    expect((await awarded(h, id, users[0])).xp_result).toEqual({
      eligible: false,
      reason: "left_early",
    });
    expect(await matchRows(h, users[0])).toHaveLength(0);
  });

  it("does not hand out placement before the result: the others wait for the stored game", async () => {
    const { h, key, users } = await setup();
    const id = gameId();
    await report(h, key, live(id, users, {}, settled()));
    const runnerUp = await preview(h, users[1], id);
    expect(runnerUp.body).toMatchObject({ status: "settled", winner: false });
    expect(runnerUp.body.breakdown).toMatchObject({ placement: 0, win: 0 });
    expect(runnerUp.body.pending).toContain("placement");
    // the stored game then pays the runner-up their placement
    await stored(h, key, record(users), id);
    expect(
      (await awarded(h, id, users[1])).xp_result.breakdown.placement,
    ).toBeGreaterThan(0);
  });
});

const earlyRows = (h: Harness, user: TestUser) =>
  q(
    h,
    "SELECT game_code, xp_awarded::int AS xp, result FROM early_xp WHERE user_id = $1",
    [user.id],
  );

const progressRow = async (h: Harness, user: TestUser) =>
  (
    await q(
      h,
      "SELECT lifetime_xp::int AS life, run_xp::int AS run FROM user_progress WHERE user_id = $1",
      [user.id],
    )
  )[0] ?? null;

describeDb("an eliminated player", () => {
  const out = (over: Patch = {}): Patch => ({
    alive: false,
    eliminated: true,
    killedBy: clientIdOf(0),
    aliveAtTurn: 4900,
    deadAtTurn: 5000,
    ...over,
  });

  it("is paid the reduced award the moment the report carries the death, while the match goes on", async () => {
    const { h, key, users } = await setup();
    const id = gameId();
    // nobody has won: the game is on, everyone else is still in it
    await report(
      h,
      key,
      live(id, users, { ...ALL_IN, 3: out({ killedBy: null }) }),
    );

    const view = await preview(h, users[3], id);
    expect(view.body).toMatchObject({
      status: "final",
      mode: "reduced",
      total: 25,
      alive: false,
      pending: [],
    });
    expect(view.body.breakdown).toMatchObject({
      played: 100,
      eliminations: 0,
      placement: 0,
      win: 0,
      firstGame: 0,
      firstWin: 0,
      gamePermille: 250,
      reducedReason: "eliminated",
      total: 25,
    });
    // it is really in the account, not a promise
    expect(await matchRows(h, users[3])).toEqual([
      { source: "match", ref_id: id, delta: 25 },
    ]);
    expect(await progressRow(h, users[3])).toEqual({ life: 25, run: 25 });
    // ... and the others, still playing, have nothing yet
    expect(await matchRows(h, users[0])).toEqual([]);
    expect(await progressRow(h, users[0])).toBeNull();
  });

  it("can read the whole award at once, with the level it reached, before the game is stored", async () => {
    const { h, key, users } = await setup();
    const id = gameId();
    // a few XP short of level 2
    await q(
      h,
      "INSERT INTO user_progress (user_id, lifetime_xp, run_xp) VALUES ($1, $2, $2)",
      [users[3].id, xpForLevel(2) - 10],
    );
    await report(
      h,
      key,
      live(id, users, { ...ALL_IN, 3: out({ killedBy: null }) }),
    );
    const res = await call(h, `/users/@me/xp/${id}`, {
      bearer: users[3].jwt,
      origin: null,
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      gameId: id,
      eligible: true,
      mode: "reduced",
      season: null,
      challenges: [],
    });
    expect(body.breakdown.total).toBe(25);
    expect(body.before).toMatchObject({ level: 1 });
    expect(body.after).toMatchObject({ level: 2 });
    expect(body.after.rank).toBeDefined();
    expect(body.levelsReached).toEqual([{ prestige: 0, level: 2 }]);
    // the account page and the nav see it at once, with the reason
    const me = await (
      await call(h, "/progression/me", { bearer: users[3].jwt, origin: null })
    ).json();
    expect(me.progress).toMatchObject({ level: 2 });
    expect(me.history[0]).toMatchObject({
      amount: 25,
      source: "match",
      detail: "eliminated",
    });
    // someone else's game, and a stranger's, are still nothing
    expect(
      (
        await call(h, `/users/@me/xp/${id}`, {
          bearer: users[0].jwt,
          origin: null,
        })
      ).status,
    ).toBe(404);
  });

  it("includes the eliminations they made before they fell: (100 + 25) x 0.25 = 31", async () => {
    const { h, key, users } = await setup();
    const id = gameId();
    // player 0 felled player 2 and now falls to player 1
    await report(
      h,
      key,
      live(id, users, {
        ...ALL_IN,
        2: out({ killedBy: clientIdOf(0) }),
        0: out({ killedBy: clientIdOf(1) }),
      }),
    );
    expect((await preview(h, users[0], id)).body).toMatchObject({
      status: "final",
      total: 31,
    });
    expect((await matchRows(h, users[0]))[0].delta).toBe(31);
  });

  it("does not have to stay: leaving at once keeps the award, and the stored game tells the same story", async () => {
    const { h, key, users } = await setup();
    const id = gameId();
    // out at 5000 and gone at 5050: after the death, long before the result
    const gone = out({ killedBy: null, connected: false, leftTurn: 5050 });
    await report(h, key, live(id, users, { ...ALL_IN, 3: gone }));
    expect((await preview(h, users[3], id)).body).toMatchObject({
      status: "final",
      total: 25,
    });
    const early = (await earlyRows(h, users[3]))[0];
    expect(early.xp).toBe(25);

    await stored(
      h,
      key,
      record(users, {
        players: record(users).players.map((p, i) =>
          i === 3 ? { ...p, fate: { killedAt: 4000 }, leftTurn: 5050 } : p,
        ),
      }),
      id,
    );
    const final = await awarded(h, id, users[3]);
    expect(final.xp).toBe(25);
    // the very result the player was shown, not a second one
    expect(final.xp_result).toEqual(early.result);
    expect(await matchRows(h, users[3])).toHaveLength(1);
    expect((await progressRow(h, users[3]))!.life).toBe(25);
  });

  it("does not have to wait for the others: the stored game adopts the award and pays nothing more", async () => {
    const { h, key, users } = await setup();
    const id = gameId();
    await report(
      h,
      key,
      live(id, users, { ...ALL_IN, 3: out({ killedBy: null }) }),
    );
    const early = (await earlyRows(h, users[3]))[0];
    await stored(h, key, record(users), id);
    const final = await awarded(h, id, users[3]);
    expect(final.xp).toBe(early.xp);
    expect(final.xp_result).toEqual(early.result);
    expect(final.clan_xp).toBe(0);
    expect(await matchRows(h, users[3])).toHaveLength(1);
    expect((await progressRow(h, users[3]))!.life).toBe(25);
    // once it is stored the game's own endpoint answers, with the same award
    // (and the live one, which reads the same payment, agrees)
    expect((await preview(h, users[3], id)).body).toMatchObject({
      status: "final",
      total: 25,
    });
    expect((await preview(h, users[0], id)).status).toBe(404);
    const res = await call(h, `/users/@me/xp/${id}`, {
      bearer: users[3].jwt,
      origin: null,
    });
    expect((await res.json()).breakdown.total).toBe(25);
  });

  it("what was paid at the death is their award even where the stored record reads differently", async () => {
    const { h, key, users } = await setup();
    const id = gameId();
    await report(
      h,
      key,
      live(id, users, { ...ALL_IN, 3: out({ killedBy: null }) }),
    );
    // the stored record has the same player still alive and gone: on its own it
    // would be a forfeit. The ledger has the XP, so that is not what the row says.
    await stored(
      h,
      key,
      record(users, {
        players: record(users).players.map((p, i) =>
          i === 3 ? { user: users[3], leftTurn: 2000 } : p,
        ),
      }),
      id,
    );
    const final = await awarded(h, id, users[3]);
    expect(final.xp).toBe(25);
    expect(final.xp_result).toMatchObject({ eligible: true, mode: "reduced" });
    expect(await matchRows(h, users[3])).toHaveLength(1);
  });

  it("a game that is already stored is never paid early: nothing is added next to the stored award", async () => {
    const { h, key, users } = await setup();
    const id = gameId();
    // the stored game judged player 3 a leaver: no award
    await stored(
      h,
      key,
      record(users, {
        players: record(users).players.map((p, i) =>
          i === 3 ? { ...p, leftTurn: 2000 } : p,
        ),
      }),
      id,
    );
    expect((await awarded(h, id, users[3])).xp_result.eligible).toBe(false);
    // a report that got past the route's check before the game was stored
    await acceptProgress(
      h.db.pool,
      live(id, users, { ...ALL_IN, 3: out({ killedBy: null }) }),
    );
    const paid = await settleEliminations(h.db.pool, id, { validFlares: null });
    expect(paid).toEqual([]);
    expect(await matchRows(h, users[3])).toEqual([]);
    expect(await earlyRows(h, users[3])).toEqual([]);
  });

  it("is paid once however many reports repeat the death", async () => {
    const { h, key, users } = await setup();
    const id = gameId();
    const p = live(id, users, { ...ALL_IN, 3: out({ killedBy: null }) });
    for (let i = 0; i < 4; i++) await report(h, key, p);
    await report(h, key, live(id, users, { ...ALL_IN, 3: out() }, settled()));
    expect(await matchRows(h, users[3])).toHaveLength(1);
    expect(await earlyRows(h, users[3])).toHaveLength(1);
    expect((await progressRow(h, users[3]))!.life).toBe(25);
  });

  it("still gets it after the API forgot the game: the award is in the database, not in memory", async () => {
    const { h, key, users } = await setup();
    const id = gameId();
    await report(
      h,
      key,
      live(id, users, { ...ALL_IN, 3: out({ killedBy: null }) }),
    );
    liveXpStore.clear();
    expect((await preview(h, users[3], id)).body).toMatchObject({
      status: "final",
      total: 25,
    });
    // and a restarted API told about the death again does not pay it again
    await report(
      h,
      key,
      live(id, users, { ...ALL_IN, 3: out({ killedBy: null }) }),
    );
    expect(await matchRows(h, users[3])).toHaveLength(1);
  });

  it("who left while still alive, and fell without them, has nothing: that is leaving", async () => {
    const { h, key, users } = await setup();
    const id = gameId();
    // gone since 2000; the empire was still standing at 3900 and fell at 4000
    const abandoned = out({
      killedBy: null,
      aliveAtTurn: 3900,
      deadAtTurn: 4000,
      connected: false,
      leftTurn: 2000,
    });
    await report(h, key, live(id, users, { ...ALL_IN, 3: abandoned }));
    expect((await preview(h, users[3], id)).body).toMatchObject({
      status: "forfeited",
      total: 0,
      reason: "left_early",
    });
    expect(await matchRows(h, users[3])).toEqual([]);
    expect(await earlyRows(h, users[3])).toEqual([]);
    await stored(
      h,
      key,
      record(users, {
        players: record(users).players.map((p, i) =>
          i === 3 ? { ...p, leftTurn: 2000 } : p,
        ),
      }),
      id,
    );
    expect((await awarded(h, id, users[3])).xp_result).toEqual({
      eligible: false,
      reason: "left_early",
    });
    expect(await matchRows(h, users[3])).toEqual([]);
  });

  it("an alive player who leaves early forfeits", async () => {
    const { h, key, users } = await setup();
    const id = gameId();
    await report(
      h,
      key,
      live(id, users, { 1: { connected: false, leftTurn: 3000 } }),
    );
    expect((await preview(h, users[1], id)).body.status).toBe("forfeited");
    await stored(
      h,
      key,
      record(users, {
        players: record(users).players.map((p, i) =>
          i === 1 ? { ...p, leftTurn: 3000 } : p,
        ),
      }),
      id,
    );
    expect((await awarded(h, id, users[1])).xp_result.reason).toBe(
      "left_early",
    );
    expect(await matchRows(h, users[1])).toEqual([]);
  });

  it("a drop that came back is not held against them", async () => {
    const { h, key, users } = await setup();
    const id = gameId();
    // first reported gone, then back (the roster cleared it)
    await report(
      h,
      key,
      live(id, users, { 1: { connected: false, leftTurn: 3000 } }),
    );
    expect((await preview(h, users[1], id)).body.status).toBe("forfeited");
    await report(
      h,
      key,
      live(id, users, { 1: { connected: true, leftTurn: null } }),
    );
    expect((await preview(h, users[1], id)).body.status).toBe("live");
    await stored(h, key, record(users), id);
    expect((await awarded(h, id, users[1])).xp_result.eligible).toBe(true);
  });

  it("pays nothing to one who never acted, or to a guest: a death does not make them a player", async () => {
    const { h, key, users } = await setup();
    const id = gameId();
    await report(
      h,
      key,
      live(id, users, { ...ALL_IN, 3: out({ acted: false }) }),
    );
    expect((await preview(h, users[3], id)).body).toMatchObject({
      status: "none",
      reason: "no_action",
    });
    expect(await matchRows(h, users[3])).toEqual([]);

    const guests = await setup(6, "guest");
    const gid = gameId();
    await report(
      guests.h,
      guests.key,
      live(gid, guests.users, { ...ALL_IN, 3: out() }),
    );
    expect(await matchRows(guests.h, guests.users[3])).toEqual([]);
  });

  it("is on the daily soft cap like any award", async () => {
    const { h, key, users } = await setup();
    const id = gameId();
    await q(
      h,
      "INSERT INTO xp_daily (user_id, day, match_xp, first_game_ref, first_win_ref) VALUES ($1, $2::date, 6000, 'x', 'y')",
      [users[3].id, new Date().toISOString().slice(0, 10)],
    );
    await report(
      h,
      key,
      live(id, users, { ...ALL_IN, 3: out({ killedBy: null }) }),
    );
    const capped = applySoftCap(25, 6000);
    expect(capped.softCapped).toBe(true);
    expect((await matchRows(h, users[3]))[0].delta).toBe(capped.paid);
    expect((await preview(h, users[3], id)).body.total).toBe(capped.paid);
  });

  it("a death in the first two minutes is paid too: a death is never nothing", async () => {
    const { h, key, users } = await setup();
    const id = gameId();
    await report(
      h,
      key,
      live(id, users, {
        ...ALL_IN,
        3: out({ killedBy: null, aliveAtTurn: 700, deadAtTurn: 800 }),
      }),
    );
    expect((await preview(h, users[3], id)).body).toMatchObject({
      status: "final",
      total: 25,
    });
  });

  it("two reports and the stored game at once still pay the death exactly once", async () => {
    const { h, key, users } = await setup();
    const id = gameId();
    const p = live(id, users, { ...ALL_IN, 3: out({ killedBy: null }) });
    const results = await Promise.all([
      report(h, key, p),
      report(h, key, p),
      submitGame(h, key, buildRecord(id, record(users))),
      report(h, key, p),
    ]);
    for (const res of results) expect(res.status).toBe(200);
    for (const i of [2, 3, 4, 5]) {
      expect(await matchRows(h, users[i]), `player ${i}`).toHaveLength(1);
      expect((await progressRow(h, users[i]))!.life).toBe(25);
      const stored = await awarded(h, id, users[i]);
      expect(stored.xp).toBe(25);
      expect(stored.xp_result).toMatchObject({
        eligible: true,
        mode: "reduced",
      });
    }
  });
});

describeDb("reduced games preview as they pay", () => {
  it("a private game: the quarter, and the same in the award", async () => {
    const { h, key, users } = await setup();
    const id = gameId();
    const cfg = {
      gameType: "Private",
      gameMode: "Free For All",
      rankedType: null,
      listed: null,
    };
    await report(h, key, live(id, users, {}, { config: cfg, ...settled() }));
    const view = await preview(h, users[0], id);
    // (100 + 25) x 0.25
    expect(view.body).toMatchObject({
      status: "settled",
      mode: "reduced",
      total: 31,
      pending: [],
    });
    expect(view.body.breakdown).toMatchObject({
      reducedReason: "private_game",
      win: 0,
      placement: 0,
    });
    await stored(h, key, record(users, { type: "Private" }), id);
    const final = await awarded(h, id, users[0]);
    expect(final.xp).toBe(31);
    expect(final.xp_result).toMatchObject({ mode: "reduced" });
  });

  it("a private game's death is paid at once, for the game's own reason", async () => {
    const { h, key, users } = await setup();
    const id = gameId();
    const cfg = {
      gameType: "Private",
      gameMode: "Free For All",
      rankedType: null,
      listed: null,
    };
    await report(h, key, live(id, users, ALL_IN, { config: cfg }));
    expect(await matchRows(h, users[3])).toEqual([]);
    await report(
      h,
      key,
      live(
        id,
        users,
        {
          ...ALL_IN,
          3: {
            alive: false,
            eliminated: true,
            aliveAtTurn: 4900,
            deadAtTurn: 5000,
          },
        },
        { config: cfg },
      ),
    );
    const view = await preview(h, users[3], id);
    expect(view.body).toMatchObject({
      status: "final",
      mode: "reduced",
      total: 25,
    });
    expect(view.body.breakdown.reducedReason).toBe("private_game");
  });

  it("a low-population public game: the quarter, and the same in the award", async () => {
    const { h, key, users } = await setup(1);
    const id = gameId();
    // one account among four players
    const p = live(id, users);
    for (let i = 1; i < 4; i++) {
      p.players.push({
        clientID: clientIdOf(i),
        persistentID: null,
        alive: i === 1,
        eliminated: i !== 1,
        killedBy: null,
        aliveAtTurn: 5000,
        deadAtTurn: null,
        connected: true,
        leftTurn: null,
        acted: true,
      });
    }
    p.players[0] = {
      ...p.players[0],
      alive: false,
      eliminated: true,
      killedBy: null,
      aliveAtTurn: 4900,
      deadAtTurn: 5000,
    };
    await report(h, key, p);
    const view = await preview(h, users[0], id);
    expect(view.body).toMatchObject({
      status: "final",
      mode: "reduced",
      total: 25,
    });
    expect(view.body.breakdown.reducedReason).toBe("public_too_few_humans");
    await stored(
      h,
      key,
      {
        allAct: true,
        resultTurn: RESULT,
        players: [
          { user: users[0], fate: { killedAt: 5000 } },
          { user: null },
          { user: null },
          { user: null },
        ],
        winner: ["player", clientIdOf(1)],
      },
      id,
    );
    const final = await awarded(h, id, users[0]);
    expect(final.xp).toBe(25);
    expect(final.xp_result).toMatchObject({ mode: "reduced" });
    expect(await matchRows(h, users[0])).toHaveLength(1);
  });

  it("a private game's player who left while alive forfeits, dead or not", async () => {
    const { h, key, users } = await setup();
    const id = gameId();
    const cfg = {
      gameType: "Private",
      gameMode: "Free For All",
      rankedType: null,
      listed: null,
    };
    await report(
      h,
      key,
      live(
        id,
        users,
        { 3: { connected: false, leftTurn: 3000 } },
        { config: cfg },
      ),
    );
    expect((await preview(h, users[3], id)).body).toMatchObject({
      status: "forfeited",
      mode: "reduced",
      total: 0,
    });
    expect(await matchRows(h, users[3])).toEqual([]);
  });
});

describeDb("a game staff commands changed", () => {
  const staffCommand = {
    type: "admin_command",
    command: "give_gold",
    target: clientIdOf(5),
    amount: 1,
    clientID: clientIdOf(5),
  };

  it("pays everyone the reduced award, in the preview and in the award", async () => {
    const { h, key, users } = await setup();
    const id = gameId();
    const action = {
      command: "give_gold",
      role: "admin",
      public: true,
      listed: false,
      invalidatesResult: true,
      count: 1,
    };
    await report(
      h,
      key,
      live(
        id,
        users,
        {},
        { adminActions: [action] as never, adminSenders: [clientIdOf(5)] },
      ),
    );
    // alive, still playing: reduced, lifetime only
    expect((await preview(h, users[0], id)).body).toMatchObject({
      status: "live",
      mode: "reduced",
      total: 31,
    });
    expect((await preview(h, users[0], id)).body.breakdown.reducedReason).toBe(
      "admin_modified",
    );
    // eliminated: paid at once, still reduced
    expect((await preview(h, users[3], id)).body).toMatchObject({
      status: "final",
      mode: "reduced",
      total: 25,
    });
    expect((await preview(h, users[3], id)).body.breakdown.reducedReason).toBe(
      "admin_modified",
    );
    // the staff member who ran the command is no exception
    expect((await preview(h, users[5], id)).body).toMatchObject({
      status: "final",
      total: 25,
    });

    await stored(
      h,
      key,
      record(users, { extraIntents: [staffCommand], adminActions: [action] }),
      id,
    );
    expect((await awarded(h, id, users[0])).xp).toBe(31);
    expect((await awarded(h, id, users[0])).xp_result).toMatchObject({
      eligible: true,
      mode: "reduced",
    });
    // the death award is adopted: still one payment each
    for (const i of [0, 1, 2, 3, 4, 5]) {
      expect(await matchRows(h, users[i]), `player ${i}`).toHaveLength(1);
    }
  });

  it("an owner's command in a public game leaves it full, and the owner is paid like anyone", async () => {
    const { h, key, users } = await setup();
    const id = gameId();
    await q(h, "UPDATE users SET role = 'owner' WHERE id = $1", [users[1].id]);
    const action = {
      command: "give_gold",
      role: "owner",
      public: true,
      listed: false,
      invalidatesResult: false,
      count: 1,
    };
    await report(
      h,
      key,
      live(
        id,
        users,
        {},
        { adminActions: [action] as never, adminSenders: [clientIdOf(1)] },
      ),
    );
    // the owner is still in it: the same preview as any player in a full game
    expect((await preview(h, users[1], id)).body).toMatchObject({
      status: "live",
      mode: "full",
    });
    expect((await preview(h, users[0], id)).body).toMatchObject({
      status: "live",
      mode: "full",
    });
    await stored(
      h,
      key,
      record(users, {
        extraIntents: [{ ...staffCommand, clientID: clientIdOf(1) }],
        adminActions: [action],
      }),
      id,
    );
    expect((await awarded(h, id, users[1])).xp_result).toMatchObject({
      eligible: true,
      mode: "full",
    });
    expect((await awarded(h, id, users[0])).xp_result).toMatchObject({
      eligible: true,
      mode: "full",
    });
  });
});

describeDb("every award is made exactly once", () => {
  it("however many reports and repeats come before and after the stored game", async () => {
    const { h, key, users } = await setup();
    const id = gameId();
    // reports through the game, the result settled twice, then the record twice
    await report(h, key, live(id, users));
    await report(h, key, live(id, users, {}, settled()));
    await report(h, key, live(id, users, {}, settled()));
    await stored(h, key, record(users), id);
    const first = await q(
      h,
      "SELECT user_id, lifetime_xp::int AS l, run_xp::int AS r FROM user_progress ORDER BY user_id",
    );
    const ledger = await q(
      h,
      "SELECT user_id, source, ref_id, delta::int AS delta FROM xp_ledger ORDER BY id",
    );
    await stored(h, key, record(users), id);
    await report(h, key, live(id, users, {}, settled()));
    expect(
      await q(
        h,
        "SELECT user_id, lifetime_xp::int AS l, run_xp::int AS r FROM user_progress ORDER BY user_id",
      ),
    ).toEqual(first);
    expect(
      await q(
        h,
        "SELECT user_id, source, ref_id, delta::int AS delta FROM xp_ledger ORDER BY id",
      ),
    ).toEqual(ledger);
    expect(await matchRows(h, users[0])).toHaveLength(1);
    // the unique key behind it: one match award per player per game
    await expect(
      h.db.pool.query(
        "INSERT INTO xp_ledger (user_id, delta, lifetime_after, run_after, prestige, source, ref_type, ref_id) VALUES ($1, 5, 5, 5, 0, 'match', 'game', $2)",
        [users[0].id, id],
      ),
    ).rejects.toThrow(/xp_ledger_award_once|duplicate key/);
  });

  it("the season's XP, the challenge progress, the clan XP and a level reward", async () => {
    const { h, key, users } = await setup();
    // a running season, a clan the winner leads and is wearing, and a winner a few hundred XP short of level 5
    await q(
      h,
      "INSERT INTO seasons (number, name, starts_at, ends_at) VALUES (1, 'Opening', '2023-11-01', '2023-12-01')",
    );
    const [clan] = await q(
      h,
      "INSERT INTO clans (tag, name, created_by) VALUES ('DLT', 'Delta Test', $1) RETURNING id",
      [users[0].id],
    );
    await q(
      h,
      "INSERT INTO clan_members (clan_id, user_id, role) VALUES ($1, $2, 'leader')",
      [clan.id, users[0].id],
    );
    await q(
      h,
      "INSERT INTO user_progress (user_id, lifetime_xp, run_xp) VALUES ($1, 2200, 2200)",
      [users[0].id],
    );

    const id = gameId();
    const spec = record(users);
    spec.players[0].clanTag = "DLT";
    const snapshot = async () => ({
      season: await q(
        h,
        "SELECT user_id, xp::int AS xp FROM user_season_progress ORDER BY user_id",
      ),
      challenges: await q(
        h,
        "SELECT user_id, period_key, challenge_id, progress::int AS progress, completed_at IS NOT NULL AS done FROM challenge_progress ORDER BY user_id, period_key, challenge_id",
      ),
      clan: await q(
        h,
        "SELECT user_id, clan_xp::int AS clan_xp FROM game_players ORDER BY user_id",
      ),
      rewards: await q(
        h,
        "SELECT user_id, key, kind, credits::int AS credits FROM progression_rewards ORDER BY user_id, key",
      ),
      ledger: await q(
        h,
        "SELECT user_id, source, ref_id, delta::int AS delta, season_delta::int AS s FROM xp_ledger ORDER BY id",
      ),
    });

    await report(h, key, live(id, users, {}, settled()));
    await stored(h, key, spec, id);
    const once = await snapshot();
    // the winner really did earn a season's XP, a clan's share, challenge progress and a milestone
    expect(
      once.season.find((r) => r.user_id === users[0].id)!.xp,
    ).toBeGreaterThan(0);
    expect(
      once.clan.find((r) => r.user_id === users[0].id)!.clan_xp,
    ).toBeGreaterThan(0);
    expect(once.challenges.length).toBeGreaterThan(0);
    expect(once.rewards.filter((r) => r.key === "level:p0:5")).toHaveLength(1);

    // reports and repeats around it change none of it
    await report(h, key, live(id, users, {}, settled()));
    await stored(h, key, spec, id);
    await report(h, key, live(id, users));
    expect(await snapshot()).toEqual(once);
  });

  it("two different games still each pay their own: the key is the game, not the player", async () => {
    const { h, key, users } = await setup();
    const a = gameId();
    const b = gameId();
    for (const id of [a, b]) {
      await report(h, key, live(id, users, {}, settled()));
      await stored(
        h,
        key,
        record(users, { endMs: DEFAULT_END_MS + (id === b ? 60_000 : 0) }),
        id,
      );
    }
    expect(await matchRows(h, users[0])).toHaveLength(2);
  });
});

describeDb("with progression off", () => {
  it("accepts and ignores the report, and has no preview to give", async () => {
    const h = await startHarness({ features: "accounts" });
    harnesses.push(h);
    const key = await createServerKey(h);
    const user = await makeUser(h);
    const id = gameId();
    const res = await report(h, key, live(id, [user]));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, ignored: true });
    expect(liveXpStore.size).toBe(0);
    // and a death in it is not paid: there is no progression
    expect(await q(h, "SELECT 1 FROM early_xp")).toHaveLength(0);
    const preview = await call(h, `/users/@me/xp/live/${id}`, {
      bearer: user.jwt,
      origin: null,
    });
    expect(preview.status).toBe(404);
  });
});
