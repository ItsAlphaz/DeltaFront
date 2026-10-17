// @vitest-environment node
import { ProgressionTrackSchema } from "@openfront/shared/ApiSchemas";
import {
  LEVEL_MILESTONES,
  MAX_RUN_XP,
  xpForLevel,
} from "@openfront/shared/ProgressionRules";
import { afterEach, expect, it } from "vitest";
import {
  buildRecord,
  creditsOf,
  makeUser,
  submitGame,
  type TestUser,
} from "./util/games";
import {
  call,
  createServerKey,
  startHarness,
  type Harness,
} from "./util/harness";
import { describeDb } from "./util/testDb";

const ON = "accounts,store,inventory,clans,leaderboards,progression";
const harnesses: Harness[] = [];
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.close();
});

async function harness(features = ON) {
  const h = await startHarness({ features });
  harnesses.push(h);
  return h;
}

const q = async (h: Harness, sql: string, params: unknown[] = []) =>
  (await h.db.pool.query(sql, params)).rows;
const send = (
  h: Harness,
  who: TestUser | null,
  method: string,
  route: string,
  headers: Record<string, string> = {},
) => call(h, route, { method, bearer: who?.jwt, origin: null, headers });
const track = async (h: Harness, who: TestUser) =>
  ProgressionTrackSchema.parse(
    await (await send(h, who, "GET", "/progression/track")).json(),
  );

async function seed(h: Harness, user: TestUser, runXp: number, prestige = 0) {
  await q(
    h,
    `INSERT INTO user_progress (user_id, lifetime_xp, run_xp, prestige) VALUES ($1, $2, $2, $3)
     ON CONFLICT (user_id) DO UPDATE SET lifetime_xp = $2, run_xp = $2, prestige = $3`,
    [user.id, runXp, prestige],
  );
}

describeDb("GET /progression/track", () => {
  it("lists the milestone levels, the only ones that pay, with their stored rewards", async () => {
    const h = await harness();
    const user = await makeUser(h);
    const body = await track(h, user);
    expect(body.levels.map((l) => l.level)).toEqual(
      LEVEL_MILESTONES.map((m) => m.level),
    );
    expect(body.levels[0]).toMatchObject({ level: 5, credits: 250 });
    expect(body.levels.every((l) => !l.unlocked && !l.claimed)).toBe(true);
    expect(body.progress).toMatchObject({ prestige: 0, level: 1 });
    expect(body).toMatchObject({ prestigeHistory: [], wins: 0 });
  });

  it("tells claimed, ready and locked apart, and shows the reward row only while it is claimable", async () => {
    const h = await harness();
    const user = await makeUser(h);
    await seed(h, user, xpForLevel(30));
    const [five] = await q(
      h,
      "INSERT INTO progression_rewards (user_id, key, kind, credits, claimed_at) VALUES ($1, 'level:p0:5', 'level_milestone', 250, now()) RETURNING id::text AS id",
      [user.id],
    );
    const [ten] = await q(
      h,
      "INSERT INTO progression_rewards (user_id, key, kind, credits) VALUES ($1, 'level:p0:10', 'level_milestone', 500) RETURNING id::text AS id",
      [user.id],
    );
    const body = await track(h, user);
    const at = (level: number) => body.levels.find((l) => l.level === level)!;
    expect(body.progress.level).toBe(30);
    expect(at(5)).toMatchObject({
      unlocked: true,
      claimed: true,
      rewardId: null,
    });
    expect(at(10)).toMatchObject({
      unlocked: true,
      claimed: false,
      rewardId: ten.id,
    });
    expect(at(25)).toMatchObject({ unlocked: true, rewardId: null });
    expect(at(50)).toMatchObject({
      unlocked: false,
      claimed: false,
      rewardId: null,
    });
    expect(five.id).not.toBe(ten.id);
  });

  it("claims through the existing reward route, once, and refuses a locked level", async () => {
    const h = await harness();
    const user = await makeUser(h);
    await seed(h, user, xpForLevel(12));
    await q(
      h,
      "INSERT INTO progression_rewards (user_id, key, kind, credits) VALUES ($1, 'level:p0:10', 'level_milestone', 500)",
      [user.id],
    );
    const ready = (await track(h, user)).levels.find((l) => l.level === 10)!;
    const before = await creditsOf(h, user);
    const first = await send(
      h,
      user,
      "POST",
      `/rewards/${ready.rewardId}/claim`,
    );
    expect(first.status).toBe(200);
    expect(
      (await send(h, user, "POST", `/rewards/${ready.rewardId}/claim`)).status,
    ).toBe(404);
    expect(await creditsOf(h, user)).toBe(before + 500);
    const after = (await track(h, user)).levels.find((l) => l.level === 10)!;
    expect(after).toMatchObject({ claimed: true, rewardId: null });
    // Level 25 is not reached: there is no row, so there is nothing to claim.
    const locked = (await track(h, user)).levels.find((l) => l.level === 25)!;
    expect(locked.rewardId).toBeNull();
    expect(
      (await send(h, user, "POST", "/rewards/999999999/claim")).status,
    ).toBe(404);
  });

  it("reads another prestige run's rewards as locked again", async () => {
    const h = await harness();
    const user = await makeUser(h);
    await seed(h, user, xpForLevel(6), 1);
    await q(
      h,
      "INSERT INTO progression_rewards (user_id, key, kind, credits, claimed_at) VALUES ($1, 'level:p0:5', 'level_milestone', 250, now())",
      [user.id],
    );
    const five = (await track(h, user)).levels.find((l) => l.level === 5)!;
    // Reached in this run, but this run's reward row does not exist: not claimed.
    expect(five).toMatchObject({
      unlocked: true,
      claimed: false,
      rewardId: null,
    });
  });

  it("records a prestige in the history with its reward, and answers empty before", async () => {
    const h = await harness();
    const user = await makeUser(h);
    await seed(h, user, MAX_RUN_XP);
    expect((await track(h, user)).prestigeHistory).toEqual([]);
    const done = await send(h, user, "POST", "/users/@me/prestige", {
      "idempotency-key": "track-key-123456",
    });
    expect(done.status).toBe(200);
    const body = await track(h, user);
    expect(body.progress).toMatchObject({ prestige: 1, level: 1 });
    expect(body.prestigeHistory).toHaveLength(1);
    expect(body.prestigeHistory[0]).toMatchObject({
      prestige: 1,
      fromPrestige: 0,
      runXpBefore: MAX_RUN_XP,
      lifetimeXp: MAX_RUN_XP,
      credits: 1000,
      claimed: false,
    });
    expect(Date.parse(body.prestigeHistory[0].at)).not.toBeNaN();
    // The run is reset: every level reward is locked again.
    expect(body.levels.every((l) => !l.unlocked)).toBe(true);
  });

  it("counts public wins, and nobody else's", async () => {
    const h = await harness();
    const key = await createServerKey(h);
    const players: TestUser[] = [];
    for (let i = 0; i < 6; i++) players.push(await makeUser(h));
    await submitGame(
      h,
      key,
      buildRecord("tk000001", {
        allAct: true,
        players: players.map((user, i) =>
          i === 0 ? { user } : { user, fate: { killedAt: 4000 - i * 100 } },
        ),
      }),
    );
    expect((await track(h, players[0])).wins).toBe(1);
    expect((await track(h, players[1])).wins).toBe(0);
  });

  it("needs a signed-in account, and is off with progression", async () => {
    const h = await harness();
    expect((await send(h, null, "GET", "/progression/track")).status).toBe(401);
    const off = await harness("accounts,leaderboards");
    const user = await makeUser(off);
    expect((await send(off, user, "GET", "/progression/track")).status).toBe(
      404,
    );
  });
});
