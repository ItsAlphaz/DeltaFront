// @vitest-environment node
import { afterEach, expect, it } from "vitest";
import {
  buildRecord,
  clientIdOf,
  creditsOf,
  makeUser,
  submitGame,
  type GameSpec,
  type PlayerSpec,
  type TestUser,
} from "./util/games";
import { createServerKey, startHarness, type Harness } from "./util/harness";
import { describeDb } from "./util/testDb";

// Who earns XP for a game they did not finish alive. Leaving while still in the
// game is what costs it: a player who stays to the result earns it; one who
// leaves before it earns nothing; a winner who leaves once the win is determined
// has still won. An eliminated player is on the reduced award and is paid
// whether they stay or go afterwards; only abandoning the game while alive and
// being eliminated without them is leaving. Records here are the current game
// server's: `resultTurn` is when the result was determined and a player's
// `leftTurn` is when their connection was lost for good.

const FEATURES = "accounts,store,inventory,clans,leaderboards,progression";
const harnesses: Harness[] = [];
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.close();
});

let seq = 0;
const gameId = () => `pr${String(++seq).padStart(6, "0")}`;

// the game is 600 s = 6,000 turns long; its result is determined just before the end
const RESULT = 5990;
const AFTER = RESULT + 5;
const BEFORE = 4000;

async function setup(players = 6) {
  const h = await startHarness({ features: FEATURES });
  harnesses.push(h);
  const key = await createServerKey(h);
  const users: TestUser[] = [];
  for (let i = 0; i < players; i++) users.push(await makeUser(h));
  return { h, key, users };
}

const q = async (h: Harness, sql: string, params: unknown[] = []) =>
  (await h.db.pool.query(sql, params)).rows;

/**
 * Six players. The winner (0) eliminated the second (1, out after eight
 * minutes), a third player (2) is still alive at the end and the rest were
 * out early in the game. `players` patches any of them.
 */
function game(
  users: TestUser[],
  patch: Partial<Record<number, Partial<PlayerSpec>>> = {},
  over: Partial<GameSpec> = {},
): GameSpec {
  const base: PlayerSpec[] = [
    {
      user: users[0],
      stats: { kills: [{ victim: clientIdOf(1), tick: "5000" }] },
    },
    { user: users[1], fate: { killedAt: 5000 } },
    { user: users[2] },
    { user: users[3], fate: { killedAt: 4000 } },
    { user: users[4], fate: { killedAt: 3000 } },
    { user: users[5], fate: { killedAt: 2000 } },
  ];
  return {
    allAct: true,
    resultTurn: RESULT,
    players: base.map((p, i) => ({ ...p, ...patch[i] })),
    ...over,
  };
}

async function play(h: Harness, key: string, spec: GameSpec, id = gameId()) {
  const res = await submitGame(h, key, buildRecord(id, spec));
  expect(res.status).toBe(200);
  return id;
}

async function resultOf(h: Harness, id: string, user: TestUser) {
  const rows = await q(
    h,
    `SELECT p.xp_awarded::int AS xp, p.completed, p.credits_awarded::int AS credits,
            p.xp_result
       FROM game_players p JOIN games g ON g.id = p.game_id
      WHERE g.game_code = $1 AND p.user_id = $2`,
    [id, user.id],
  );
  return rows[0] as {
    xp: number;
    completed: boolean;
    credits: number;
    xp_result: any;
  };
}

const ledgerCount = async (h: Harness, user: TestUser) =>
  (
    await q(
      h,
      "SELECT count(*)::int AS n FROM xp_ledger WHERE user_id = $1 AND source = 'match'",
      [user.id],
    )
  )[0].n as number;

const LEFT = { eligible: false, reason: "left_early" };

describeDb("a player who stays to the end earns XP, dead or alive", () => {
  it("alive when the game ends: XP", async () => {
    const { h, key, users } = await setup();
    const id = await play(h, key, game(users));
    const alive = await resultOf(h, id, users[2]);
    expect(alive.completed).toBe(true);
    expect(alive.xp).toBeGreaterThan(0);
    expect(alive.xp_result).toMatchObject({ eligible: true, mode: "full" });
    // the winner, alive and present
    expect((await resultOf(h, id, users[0])).xp).toBeGreaterThan(alive.xp);
  });

  it("eliminated and staying until the end: the reduced award, and Credits as before", async () => {
    const { h, key, users } = await setup();
    const id = await play(h, key, game(users));
    const out = await resultOf(h, id, users[1]);
    expect(out.completed).toBe(true);
    // 100 x 0.25: a death is a reduced award, whenever the game ends
    expect(out.xp).toBe(25);
    expect(out.xp_result).toMatchObject({ eligible: true, mode: "reduced" });
    expect(out.xp_result.breakdown.reducedReason).toBe("eliminated");
    expect(out.credits).toBeGreaterThan(0);
    expect(await ledgerCount(h, users[1])).toBe(1);
  });

  it("eliminated and leaving once the game is decided: the same award", async () => {
    const { h, key, users } = await setup();
    const id = await play(h, key, game(users, { 1: { leftTurn: AFTER } }));
    expect((await resultOf(h, id, users[1])).xp).toBe(25);
  });

  it("eliminated and leaving right after the death, long before the end: the award is already theirs", async () => {
    const { h, key, users } = await setup();
    const id = await play(
      h,
      key,
      game(users, { 1: { fate: { killedAt: 3000 }, leftTurn: 3050 } }),
    );
    const out = await resultOf(h, id, users[1]);
    expect(out.xp).toBe(25);
    expect(out.xp_result).toMatchObject({ eligible: true, mode: "reduced" });
    expect(await ledgerCount(h, users[1])).toBe(1);
    // the Credits rule is its own: they did not stay to the result
    expect(out.completed).toBe(false);
    expect(out.credits).toBe(0);
  });

  it("eliminated within the first two minutes and gone: still the reduced award", async () => {
    const { h, key, users } = await setup();
    const id = await play(
      h,
      key,
      game(users, { 5: { fate: { killedAt: 600 }, leftTurn: 620 } }),
    );
    expect((await resultOf(h, id, users[5])).xp).toBe(25);
  });
});

describeDb("a player who leaves before the result earns nothing", () => {
  it("alive and leaving early: no XP, no Credits, no ledger row", async () => {
    const { h, key, users } = await setup();
    const id = await play(h, key, game(users, { 2: { leftTurn: BEFORE } }));
    const left = await resultOf(h, id, users[2]);
    expect(left.xp).toBe(0);
    expect(left.completed).toBe(false);
    expect(left.credits).toBe(0);
    expect(left.xp_result).toEqual(LEFT);
    expect(await ledgerCount(h, users[2])).toBe(0);
  });

  it("leaving while still alive and being eliminated without them: no XP, not even the death's", async () => {
    const { h, key, users } = await setup();
    // they were gone from turn 4000; their empire fell at 5000
    const id = await play(h, key, game(users, { 1: { leftTurn: BEFORE } }));
    const left = await resultOf(h, id, users[1]);
    expect(left.xp).toBe(0);
    expect(left.xp_result).toEqual(LEFT);
    expect(await ledgerCount(h, users[1])).toBe(0);
  });

  it("leaving before the result costs only the leaver: the others are paid as usual", async () => {
    const { h, key, users } = await setup();
    const id = await play(h, key, game(users, { 2: { leftTurn: BEFORE } }));
    expect((await resultOf(h, id, users[0])).xp).toBeGreaterThan(0);
    expect((await resultOf(h, id, users[1])).xp).toBeGreaterThan(0);
  });
});

describeDb("a winner who leaves once the win is determined", () => {
  it("is paid, with the victory", async () => {
    const { h, key, users } = await setup();
    const id = await play(h, key, game(users, { 0: { leftTurn: AFTER } }));
    const winner = await resultOf(h, id, users[0]);
    expect(winner.completed).toBe(true);
    expect(winner.xp).toBeGreaterThan(0);
    expect(winner.xp_result).toMatchObject({ eligible: true, mode: "full" });
    expect(winner.xp_result.breakdown.win).toBeGreaterThan(0);
  });

  it("loses neither the placement nor the victory XP by leaving", async () => {
    const stays = await setup();
    const stayedId = await play(stays.h, stays.key, game(stays.users));
    const stayed = await resultOf(stays.h, stayedId, stays.users[0]);

    const leaves = await setup();
    const leftId = await play(
      leaves.h,
      leaves.key,
      game(leaves.users, { 0: { leftTurn: AFTER } }),
    );
    const left = await resultOf(leaves.h, leftId, leaves.users[0]);

    expect(left.xp).toBe(stayed.xp);
    expect(left.xp_result.breakdown).toEqual(stayed.xp_result.breakdown);
    expect(left.xp_result.breakdown.placement).toBeGreaterThan(0);
    expect(left.credits).toBe(stayed.credits);
  });

  it("a winner who left before the result is not paid: the empire won without them", async () => {
    const { h, key, users } = await setup();
    const id = await play(h, key, game(users, { 0: { leftTurn: BEFORE } }));
    expect((await resultOf(h, id, users[0])).xp_result).toEqual(LEFT);
  });
});

describeDb("reconnecting", () => {
  it("a drop that came back is not leaving: the same XP as staying", async () => {
    const stays = await setup();
    const stayedId = await play(stays.h, stays.key, game(stays.users));
    const stayed = await resultOf(stays.h, stayedId, stays.users[2]);

    const drops = await setup();
    const dropId = await play(
      drops.h,
      drops.key,
      game(
        drops.users,
        {},
        {
          // dropped for half a minute in the middle, then back
          disconnects: [
            { clientID: clientIdOf(2), turn: 3000, isDisconnected: true },
            { clientID: clientIdOf(2), turn: 3300, isDisconnected: false },
          ],
        },
      ),
    );
    const dropped = await resultOf(drops.h, dropId, drops.users[2]);
    expect(dropped.xp).toBe(stayed.xp);
    expect(dropped.completed).toBe(true);
  });

  it("an eliminated player who dropped at the moment they were out, came back and stayed: XP", async () => {
    const { h, key, users } = await setup();
    const id = await play(
      h,
      key,
      game(
        users,
        {},
        {
          disconnects: [
            { clientID: clientIdOf(1), turn: 29900, isDisconnected: true },
            { clientID: clientIdOf(1), turn: 30500, isDisconnected: false },
          ],
        },
      ),
    );
    expect((await resultOf(h, id, users[1])).xp).toBeGreaterThan(0);
  });
});

describeDb("the same rules in a reduced game", () => {
  it("a private game: eliminated but staying pays the quarter, 100 x 0.25", async () => {
    const { h, key, users } = await setup();
    const id = await play(h, key, game(users, {}, { type: "Private" }));
    const out = await resultOf(h, id, users[1]);
    expect(out.xp).toBe(25);
    expect(out.xp_result).toMatchObject({ eligible: true, mode: "reduced" });
  });

  it("a private game: leaving early pays nothing", async () => {
    const { h, key, users } = await setup();
    const id = await play(
      h,
      key,
      game(users, { 1: { leftTurn: BEFORE } }, { type: "Private" }),
    );
    expect((await resultOf(h, id, users[1])).xp_result).toEqual(LEFT);
    expect(await ledgerCount(h, users[1])).toBe(0);
  });

  it("a private game: a winner leaving after the win still gets the reduced award", async () => {
    const { h, key, users } = await setup();
    const id = await play(
      h,
      key,
      game(users, { 0: { leftTurn: AFTER } }, { type: "Private" }),
    );
    const winner = await resultOf(h, id, users[0]);
    expect(winner.xp).toBe(31);
    expect(winner.xp_result).toMatchObject({ eligible: true, mode: "reduced" });
  });

  it("a low-population public game: eliminated but staying pays the quarter", async () => {
    const { h, key, users } = await setup(1);
    const spec: GameSpec = {
      allAct: true,
      resultTurn: RESULT,
      // the only account holder was out after 50 minutes; nobody else has an account
      players: [
        { user: users[0], fate: { killedAt: 30000 } },
        { user: null },
        { user: null },
        { user: null },
      ],
      winner: ["player", clientIdOf(1)],
    };
    const id = await play(h, key, spec);
    const out = await resultOf(h, id, users[0]);
    expect(out.xp).toBe(25);
    expect(out.xp_result).toMatchObject({
      eligible: true,
      mode: "reduced",
      breakdown: { reducedReason: "public_too_few_humans" },
    });
  });

  it("a low-population public game: leaving early pays nothing", async () => {
    const { h, key, users } = await setup(1);
    const id = await play(h, key, {
      allAct: true,
      resultTurn: RESULT,
      players: [
        { user: users[0], fate: { killedAt: 30000 }, leftTurn: BEFORE },
        { user: null },
        { user: null },
      ],
      winner: ["player", clientIdOf(1)],
    });
    expect((await resultOf(h, id, users[0])).xp_result).toEqual(LEFT);
  });
});

describeDb("the other exclusions and idempotence are unchanged", () => {
  const command = (clientID: string) => ({
    type: "admin_command",
    command: "give_gold",
    target: clientID,
    amount: 1,
    clientID,
  });

  it("a game staff tests changed pays everyone the reduced award, whoever stayed", async () => {
    const { h, key, users } = await setup();
    const id = await play(
      h,
      key,
      game(
        users,
        {},
        {
          extraIntents: [command(clientIdOf(5))],
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
      ),
    );
    for (const user of users) {
      const r = await resultOf(h, id, user);
      expect(r.xp_result, user.id).toMatchObject({
        eligible: true,
        mode: "reduced",
      });
      expect(r.xp_result.breakdown.reducedReason).toBe("admin_modified");
      expect(r.xp).toBeGreaterThan(0);
    }
  });

  it("an owner who used a command in a public game is paid like any player", async () => {
    const { h, key, users } = await setup();
    await q(h, "UPDATE users SET role = 'owner' WHERE id = $1", [users[2].id]);
    const id = await play(
      h,
      key,
      game(
        users,
        {},
        {
          extraIntents: [command(clientIdOf(2))],
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
      ),
    );
    const owner = await resultOf(h, id, users[2]);
    expect(owner.xp_result).toMatchObject({ eligible: true, mode: "full" });
    expect(owner.xp).toBeGreaterThan(0);
    expect(owner.xp_result.flags).toContain("admin_counted");
    // and the others
    expect((await resultOf(h, id, users[1])).xp).toBeGreaterThan(0);
  });

  it("the same record twice pays once", async () => {
    const { h, key, users } = await setup();
    const record = buildRecord(
      gameId(),
      game(users, { 0: { leftTurn: AFTER } }),
    );
    expect((await submitGame(h, key, record)).status).toBe(200);
    const [before] = await q(
      h,
      "SELECT lifetime_xp::int AS life FROM user_progress WHERE user_id = $1",
      [users[0].id],
    );
    const credits = await creditsOf(h, users[0]);
    expect((await submitGame(h, key, record)).status).toBe(200);
    const [after] = await q(
      h,
      "SELECT lifetime_xp::int AS life FROM user_progress WHERE user_id = $1",
      [users[0].id],
    );
    expect(after.life).toBe(before.life);
    expect(await ledgerCount(h, users[0])).toBe(1);
    expect(await creditsOf(h, users[0])).toEqual(credits);
  });

  it("an older record, with only the heartbeat, is still judged by its last state", async () => {
    const { h, key, users } = await setup();
    // no resultTurn: the old format. Player 2 dropped at 4000 and never came back.
    const id = await play(
      h,
      key,
      game(
        users,
        {},
        {
          resultTurn: undefined,
          disconnects: [
            { clientID: clientIdOf(2), turn: 4000, isDisconnected: true },
          ],
        },
      ),
    );
    expect((await resultOf(h, id, users[2])).xp_result).toEqual(LEFT);
    expect((await resultOf(h, id, users[1])).xp).toBeGreaterThan(0);
  });
});
