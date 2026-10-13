// @vitest-environment node
import {
  PlayerProfileSchema,
  PublicPlayerGamesResponseSchema,
  PutUsernameResponseSchema,
  UserMeResponseSchema,
} from "@openfront/shared/ApiSchemas";
import { afterEach, expect, it } from "vitest";
import { ECONOMY } from "../../src/account-api/domain/constants";
import {
  runDeletions,
  runGuestCleanup,
} from "../../src/account-api/domain/lifecycle";
import {
  buildRecord,
  clientIdOf,
  makeUser,
  submitGame,
  userMe,
  type GameSpec,
  type TestUser,
} from "./util/games";
import {
  call,
  createServerKey,
  newGuest,
  startHarness,
  type Harness,
} from "./util/harness";
import { describeDb } from "./util/testDb";

const harnesses: Harness[] = [];
async function harness(): Promise<Harness> {
  const h = await startHarness();
  harnesses.push(h);
  return h;
}
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.close();
});

let seq = 0;
const gameId = () => `pf${String(++seq).padStart(6, "0")}`;
const WIN = ECONOMY.completedGameReward + ECONOMY.winBonus;

async function setup(count = 2) {
  const h = await harness();
  const key = await createServerKey(h);
  const users: TestUser[] = [];
  for (let i = 0; i < count; i++) users.push(await makeUser(h));
  return { h, key, users };
}

const play = (h: Harness, key: string, spec: GameSpec) =>
  submitGame(h, key, buildRecord(gameId(), spec));

const q = async (h: Harness, sql: string, params: unknown[] = []) =>
  (await h.db.pool.query(sql, params)).rows;

const publicProfile = (h: Harness, publicId: string) =>
  call(h, `/public/player/${publicId}`, { origin: null });

const games = (h: Harness, publicId: string, query = "") =>
  call(h, `/public/player/${publicId}/games${query}`, { origin: null });

describeDb("/users/@me", () => {
  it("a guest's body parses with the client's schema and shows 0 Credits, no username", async () => {
    const h = await harness();
    const guest = await newGuest(h);
    const res = await call(h, "/users/@me", {
      bearer: guest.jwt,
      origin: null,
    });
    expect(res.status).toBe(200);
    const body = UserMeResponseSchema.parse(await res.json());
    expect(body.user).toEqual({});
    expect(body.player.currency).toEqual({ soft: 0, hard: 0 });
    expect(body.player.username).toBeNull();
    expect(body.player.usernameStatus).toBe("unclaimed");
    expect(body.player.nextUsernameChangeAt).toBeNull();
  });

  it("a registered player's Credits follow their games, and the premium currency never moves", async () => {
    const { h, key, users } = await setup();
    expect((await userMe(h, users[0])).body.player.currency).toEqual({
      soft: 0,
      hard: 0,
    });
    await play(h, key, { players: [{ user: users[0] }, { user: users[1] }] });
    const me = await userMe(h, users[0]);
    expect(UserMeResponseSchema.safeParse(me.body).success).toBe(true);
    expect(me.body.player.currency).toEqual({ soft: WIN, hard: 0 });
    expect((await userMe(h, users[1])).body.player.currency).toEqual({
      soft: ECONOMY.completedGameReward,
      hard: 0,
    });
  });

  it("exposes nothing from later milestones", async () => {
    const { h, users } = await setup(1);
    const { body } = await userMe(h, users[0]);
    for (const absent of [
      "rewards",
      "progress",
      "clans",
      "clanRequests",
      "flares",
      "leaderboard",
      "creator",
      "marketingConsent",
      "levelHidden",
    ])
      expect(body.player[absent], absent).toBeUndefined();
    expect(body.player).toMatchObject({
      adfree: false,
      unlimitedRanked: false,
      canCreatePublicLobbies: false,
      friends: [],
      subscription: null,
    });
  });

  it("the balance persists: a new session of the same account sees it", async () => {
    const { h, key, users } = await setup();
    await play(h, key, { players: [{ user: users[0] }, { user: users[1] }] });
    const res = await call(h, "/auth/refresh", {
      method: "POST",
      jar: users[0].jar,
    });
    const { jwt } = (await res.json()) as { jwt: string };
    const me = await call(h, "/users/@me", { bearer: jwt, origin: null });
    expect((await me.json()).player.currency.soft).toBe(WIN);
  });
});

describeDb("player profiles", () => {
  it("after a public game both players' profiles show the game and the updated totals", async () => {
    const { h, key, users } = await setup();
    const [a, b] = users;
    await play(h, key, {
      players: [{ user: a, stats: { gold: ["12"] } }, { user: b }],
    });
    for (const [user, wins, losses] of [
      [a, 1n, 0n],
      [b, 0n, 1n],
    ] as const) {
      const res = await publicProfile(h, user.publicId);
      expect(res.status).toBe(200);
      const profile = PlayerProfileSchema.parse(await res.json());
      const leaf = profile.stats.Public?.["Free For All"]?.Medium;
      expect(leaf).toMatchObject({ wins, losses, total: 1n });
      expect(profile.stats.recent?.all).toEqual({
        games: 1,
        wins: Number(wins),
      });
      expect(profile.username).toBeNull();
      const history = PublicPlayerGamesResponseSchema.parse(
        await (await games(h, user.publicId)).json(),
      );
      expect(history.results).toHaveLength(1);
      expect(history.results[0]).toMatchObject({
        type: "Public",
        mode: "Free For All",
        result: wins === 1n ? "victory" : "defeat",
      });
    }
    const leafA = PlayerProfileSchema.parse(
      await (await publicProfile(h, a.publicId)).json(),
    ).stats.Public?.["Free For All"]?.Medium;
    expect(leafA?.stats?.gold).toEqual([12n]);
  });

  it("totals grow with every game, in the right bucket", async () => {
    const { h, key, users } = await setup();
    const [a, b] = users;
    await play(h, key, { players: [{ user: a }, { user: b }] });
    await play(h, key, { players: [{ user: b }, { user: a }] });
    await play(h, key, {
      players: [{ user: a }, { user: b }],
      difficulty: "Hard",
    });
    await play(h, key, {
      players: [{ user: a }, { user: b }],
      mode: "Team",
      winner: ["team", "Red", clientIdOf(0)],
    });
    const profile = PlayerProfileSchema.parse(
      await (await publicProfile(h, a.publicId)).json(),
    );
    expect(profile.stats.Public?.["Free For All"]?.Medium).toMatchObject({
      wins: 1n,
      losses: 1n,
      total: 2n,
    });
    expect(profile.stats.Public?.["Free For All"]?.Hard).toMatchObject({
      wins: 1n,
      total: 1n,
    });
    expect(profile.stats.Public?.Team?.Medium).toMatchObject({
      wins: 1n,
      total: 1n,
    });
    expect(profile.stats.recent?.all).toEqual({ games: 4, wins: 3 });
    expect(profile.stats.recent?.Public?.Team?.all).toEqual({
      games: 1,
      wins: 1,
    });
  });

  it("private games show in the Private bucket only", async () => {
    const { h, key, users } = await setup();
    await play(h, key, {
      type: "Private",
      players: [{ user: users[0] }, { user: users[1] }],
    });
    const profile = PlayerProfileSchema.parse(
      await (await publicProfile(h, users[0].publicId)).json(),
    );
    expect(profile.stats.Public).toBeUndefined();
    expect(profile.stats.Private?.["Free For All"]?.Medium).toMatchObject({
      wins: 1n,
      total: 1n,
    });
    expect(profile.stats.Singleplayer).toBeUndefined();
  });

  it("a game that did not count does not touch the Public totals", async () => {
    const { h, key, users } = await setup();
    await play(h, key, {
      durationSeconds: 60,
      players: [{ user: users[0] }, { user: users[1] }],
    });
    const profile = PlayerProfileSchema.parse(
      await (await publicProfile(h, users[0].publicId)).json(),
    );
    expect(profile.stats.Public).toBeUndefined();
    const history = PublicPlayerGamesResponseSchema.parse(
      await (await games(h, users[0].publicId)).json(),
    );
    expect(history.results).toHaveLength(1);
  });

  it("a guest, and a player with no games, have a valid empty profile", async () => {
    const h = await harness();
    const guest = await makeUser(h, "guest");
    const res = await publicProfile(h, guest.publicId);
    expect(res.status).toBe(200);
    const profile = PlayerProfileSchema.parse(await res.json());
    expect(profile).toMatchObject({
      username: null,
      stats: { recent: { all: { games: 0, wins: 0 } } },
    });
    expect(profile.user).toBeUndefined();
    expect(profile.clans).toBeUndefined();
    expect(new Date(profile.createdAt).getTime()).toBeLessThanOrEqual(
      Date.now(),
    );
  });

  it("a guest who plays keeps a persistent profile across sessions", async () => {
    const h = await harness();
    const key = await createServerKey(h);
    const g1 = await makeUser(h, "guest");
    const g2 = await makeUser(h, "guest");
    await play(h, key, { players: [{ user: g1 }, { user: g2 }] });
    // a later session of the same guest (refresh) sees the same profile
    const res = await call(h, "/auth/refresh", { method: "POST", jar: g1.jar });
    expect(res.status).toBe(200);
    const profile = PlayerProfileSchema.parse(
      await (await publicProfile(h, g1.publicId)).json(),
    );
    expect(profile.stats.Public?.["Free For All"]?.Medium?.total).toBe(1n);
  });

  it("the signed-in endpoint answers the same body, and needs a valid session", async () => {
    const { h, key, users } = await setup();
    await play(h, key, { players: [{ user: users[0] }, { user: users[1] }] });
    const open = await (await publicProfile(h, users[0].publicId)).json();
    const authed = await call(h, `/player/${users[0].publicId}`, {
      bearer: users[1].jwt,
      origin: null,
    });
    expect(authed.status).toBe(200);
    expect(await authed.json()).toEqual(open);
    expect(
      (await call(h, `/player/${users[0].publicId}`, { origin: null })).status,
    ).toBe(401);
    expect(
      (
        await call(h, `/player/${users[0].publicId}`, {
          bearer: "garbage",
          origin: null,
        })
      ).status,
    ).toBe(401);
  });

  it("a revoked session can no longer read the signed-in endpoint", async () => {
    const { h, users } = await setup();
    await call(h, "/auth/logout", { method: "POST", jar: users[0].jar });
    expect(
      (
        await call(h, `/player/${users[1].publicId}`, {
          bearer: users[0].jwt,
          origin: null,
        })
      ).status,
    ).toBe(401);
  });

  it("unknown, malformed and hostile ids are 404, not errors", async () => {
    const h = await harness();
    for (const id of [
      "doesNotExist",
      "x",
      "a".repeat(40),
      "bad%20id",
      "..%2F..%2Fetc",
      "'%3B--",
      "%00",
    ]) {
      expect((await publicProfile(h, id)).status, id).toBe(404);
      expect((await games(h, id)).status, `${id} games`).toBe(404);
    }
    const guest = await newGuest(h);
    expect(
      (
        await call(h, "/player/doesNotExist", {
          bearer: guest.jwt,
          origin: null,
        })
      ).status,
    ).toBe(404);
  });

  it("shows the Discord profile when one is linked, and nothing else about sign-in", async () => {
    const { h, users } = await setup(1);
    await h.db.pool.query(
      `INSERT INTO auth_identities (user_id, provider, provider_user_id, email, display_name, profile)
       VALUES ($1, 'discord', 'd-123', 'secret@example.com', 'Dee', $2)`,
      [
        users[0].id,
        JSON.stringify({
          id: "d-123",
          username: "dee",
          global_name: "Dee",
          avatar: null,
          discriminator: "0",
        }),
      ],
    );
    await h.db.pool.query(
      `INSERT INTO auth_identities (user_id, provider, provider_user_id, email, display_name, profile)
       VALUES ($1, 'google', 'g-123', 'private@gmail.com', 'G', '{}')`,
      [users[0].id],
    );
    const text = await (await publicProfile(h, users[0].publicId)).text();
    const profile = PlayerProfileSchema.parse(JSON.parse(text));
    expect(profile.user).toMatchObject({ id: "d-123", username: "dee" });
    expect(text).not.toContain("secret@example.com");
    expect(text).not.toContain("private@gmail.com");
    expect(text).not.toContain(users[0].id);
  });

  it("a deleted account has no public page either", async () => {
    const { h, users } = await setup(1);
    await h.db.pool.query("UPDATE users SET deleted_at = now() WHERE id = $1", [
      users[0].id,
    ]);
    expect((await publicProfile(h, users[0].publicId)).status).toBe(404);
    expect((await games(h, users[0].publicId)).status).toBe(404);
  });

  it("an account queued for deletion has no public page", async () => {
    const { h, users } = await setup(1);
    await h.db.pool.query(
      "UPDATE users SET deletion_requested_at = now() WHERE id = $1",
      [users[0].id],
    );
    expect((await publicProfile(h, users[0].publicId)).status).toBe(404);
  });
});

describeDb("game history", () => {
  /** n counted games for `a`, alternating opponents; returns their codes oldest first. */
  async function manyGames(
    h: Harness,
    key: string,
    a: TestUser,
    b: TestUser,
    n: number,
    spec: Partial<GameSpec> = {},
  ) {
    const codes: string[] = [];
    for (let i = 0; i < n; i++) {
      const code = gameId();
      codes.push(code);
      await submitGame(
        h,
        key,
        buildRecord(code, { players: [{ user: a }, { user: b }], ...spec }),
      );
    }
    return codes;
  }

  it("pages newest first with a cursor, no duplicates, no gaps, and ends with a null cursor", async () => {
    const { h, key, users } = await setup();
    const [a, b] = users;
    const codes = await manyGames(h, key, a, b, 45);
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const res = await games(
        h,
        a.publicId,
        cursor === null ? "" : `?cursor=${encodeURIComponent(cursor)}`,
      );
      expect(res.status).toBe(200);
      const body = PublicPlayerGamesResponseSchema.parse(await res.json());
      seen.push(...body.results.map((g) => g.gameId));
      cursor = body.nextCursor;
      pages += 1;
      expect(pages).toBeLessThan(10);
    } while (cursor !== null);
    expect(seen).toEqual([...codes].reverse());
    expect(new Set(seen).size).toBe(45);
    expect(pages).toBe(3);
  });

  it("a game that arrives between two page loads neither duplicates nor hides anything", async () => {
    const { h, key, users } = await setup();
    const [a, b] = users;
    const codes = await manyGames(h, key, a, b, 25);
    const first = PublicPlayerGamesResponseSchema.parse(
      await (await games(h, a.publicId)).json(),
    );
    expect(first.results).toHaveLength(20);
    const [extra] = await manyGames(h, key, a, b, 1);
    const second = PublicPlayerGamesResponseSchema.parse(
      await (
        await games(
          h,
          a.publicId,
          `?cursor=${encodeURIComponent(first.nextCursor!)}`,
        )
      ).json(),
    );
    expect(second.nextCursor).toBeNull();
    const all = [...first.results, ...second.results].map((g) => g.gameId);
    expect(all).toEqual([...codes].reverse());
    expect(all).not.toContain(extra);
    // and the new game is the newest on a fresh load
    expect(
      PublicPlayerGamesResponseSchema.parse(
        await (await games(h, a.publicId)).json(),
      ).results[0].gameId,
    ).toBe(extra);
  });

  it("filters by game type and by mode, and the filters combine", async () => {
    const { h, key, users } = await setup();
    const [a, b] = users;
    const ffa = await manyGames(h, key, a, b, 2);
    const priv = await manyGames(h, key, a, b, 1, { type: "Private" });
    const team = await manyGames(h, key, a, b, 1, {
      mode: "Team",
      winner: ["team", "Red", clientIdOf(0)],
    });
    const hvn = await manyGames(h, key, a, b, 1, {
      mode: "Team",
      playerTeams: "Humans Vs Nations",
      winner: ["nation", "Nations"],
    });
    const ids = async (query: string) =>
      PublicPlayerGamesResponseSchema.parse(
        await (await games(h, a.publicId, query)).json(),
      ).results.map((g) => g.gameId);

    expect(await ids("")).toHaveLength(5);
    expect((await ids("?type=private")).sort()).toEqual(priv);
    expect((await ids("?type=public")).sort()).toEqual(
      [...ffa, ...team, ...hvn].sort(),
    );
    expect(await ids("?type=singleplayer")).toEqual([]);
    expect((await ids("?filter=ffa")).sort()).toEqual([...ffa, ...priv].sort());
    expect(await ids("?filter=team")).toEqual(team);
    expect(await ids("?filter=hvn")).toEqual(hvn);
    expect(await ids("?filter=ranked")).toEqual([]);
    expect((await ids("?filter=ffa&type=public")).sort()).toEqual(ffa.sort());
  });

  it("a private game appears in the history with its own type", async () => {
    const { h, key, users } = await setup();
    await play(h, key, {
      type: "Private",
      players: [{ user: users[0] }, { user: users[1] }],
    });
    const body = PublicPlayerGamesResponseSchema.parse(
      await (await games(h, users[0].publicId)).json(),
    );
    expect(body.results).toHaveLength(1);
    expect(body.results[0]).toMatchObject({
      type: "Private",
      totalPlayers: 2,
      username: "Player1",
      clanTag: null,
      rankedType: "",
    });
  });

  it("rows are the player's own: username as played, duration, map, start", async () => {
    const { h, key, users } = await setup();
    await play(h, key, {
      durationSeconds: 777,
      players: [{ user: users[0], username: "Zed" }, { user: users[1] }],
    });
    const [row] = PublicPlayerGamesResponseSchema.parse(
      await (await games(h, users[0].publicId)).json(),
    ).results;
    expect(row).toMatchObject({
      username: "Zed",
      durationSeconds: 777,
      map: "Africa",
      result: "victory",
    });
    expect(new Date(row.start).toISOString()).toBe(row.start);
  });

  it("old or sparse games (missing mode, map, counts) still render safely", async () => {
    const { h, users } = await setup(1);
    const { rows } = await h.db.pool.query<{ id: string }>(
      `INSERT INTO games (game_code, source, type, started_at, ended_at, duration_s, human_players)
       VALUES ('oldGame001', 'server', 'Public', '2020-01-01', '2020-01-01 00:10', 600, 0) RETURNING id`,
    );
    await h.db.pool.query(
      `INSERT INTO game_players (game_id, client_id, user_id, username, result, completed)
       VALUES ($1, 'oldp0001', $2, 'Old Timer', 'incomplete', false)`,
      [rows[0].id, users[0].id],
    );
    const body = PublicPlayerGamesResponseSchema.parse(
      await (await games(h, users[0].publicId)).json(),
    );
    expect(body.results).toHaveLength(1);
    expect(body.results[0]).toMatchObject({
      gameId: "oldGame001",
      map: "",
      mode: "",
      playerTeams: null,
      rankedType: "",
      result: "incomplete",
      totalPlayers: 0,
    });
    // and the profile survives rows with no mode or difficulty
    expect((await publicProfile(h, users[0].publicId)).status).toBe(200);
  });

  it("refuses an unknown filter or a cursor it did not issue", async () => {
    const { h, users } = await setup(1);
    for (const query of [
      "?filter=nope",
      "?type=nope",
      "?cursor=!!!",
      "?cursor=" + "A".repeat(100),
      "?cursor=e30",
      "?cursor=a&cursor=b",
      "?filter=ffa&filter=team",
    ])
      expect((await games(h, users[0].publicId, query)).status, query).toBe(
        400,
      );
  });

  it("is rate limited per address", async () => {
    const h = await startHarness({
      limits: { publicRead: { max: 3, windowMs: 60_000 } },
    });
    harnesses.push(h);
    const user = await makeUser(h);
    const statuses = [];
    for (let i = 0; i < 5; i++)
      statuses.push((await publicProfile(h, user.publicId)).status);
    expect(statuses).toEqual([200, 200, 200, 429, 429]);
  });
});

describeDb("usernames", () => {
  const put = (h: Harness, user: TestUser | { jwt: string }, body: unknown) =>
    call(h, "/users/@me/username", {
      method: "PUT",
      bearer: user.jwt,
      origin: null,
      json: body,
    });

  it("a registered player sets a name; it gets a four-digit suffix and shows on the profile and /users/@me", async () => {
    const { h, users } = await setup(1);
    const res = await put(h, users[0], { username: "Aydin" });
    expect(res.status).toBe(200);
    const body = PutUsernameResponseSchema.parse(await res.json());
    expect(body.base).toBe("Aydin");
    expect(body.discriminator).toMatch(/^\d{4}$/);
    expect(body.username).toBe(`Aydin.${body.discriminator}`);
    expect(body.usernameStatus).toBe("unclaimed");
    expect(new Date(body.nextUsernameChangeAt!).getTime()).toBeGreaterThan(
      Date.now() + 6 * 86_400_000,
    );

    const me = await userMe(h, users[0]);
    expect(me.body.player).toMatchObject({
      username: body.username,
      usernameBase: "Aydin",
      usernameDiscriminator: body.discriminator,
    });
    const profile = PlayerProfileSchema.parse(
      await (await publicProfile(h, users[0].publicId)).json(),
    );
    expect(profile.username).toBe(body.username);
  });

  it("can not change again during the cooldown (429 with Retry-After), and can after it", async () => {
    const { h, users } = await setup(1);
    expect((await put(h, users[0], { username: "First" })).status).toBe(200);
    const again = await put(h, users[0], { username: "Second" });
    expect(again.status).toBe(429);
    expect(Number(again.headers.get("retry-after"))).toBeGreaterThan(
      6 * 86_400,
    );
    expect((await again.json()).code).toBe("USERNAME_COOLDOWN");
    expect((await userMe(h, users[0])).body.player.usernameBase).toBe("First");

    await h.db.pool.query(
      "UPDATE users SET next_username_change_at = now() - interval '1 second' WHERE id = $1",
      [users[0].id],
    );
    expect((await put(h, users[0], { username: "Second" })).status).toBe(200);
    expect((await userMe(h, users[0])).body.player.usernameBase).toBe("Second");
  });

  it("two simultaneous changes: exactly one wins", async () => {
    const { h, users } = await setup(1);
    const results = await Promise.all(
      ["Alpha", "Bravo", "Cindy", "Delta"].map((username) =>
        put(h, users[0], { username }),
      ),
    );
    expect(results.map((r) => r.status).sort()).toEqual([200, 429, 429, 429]);
  });

  it("refuses guests (403 LOGIN_REQUIRED), bad names, profanity, and anonymous callers", async () => {
    const { h, users } = await setup(1);
    const guest = await makeUser(h, "guest");
    const g = await put(h, guest, { username: "Guesty" });
    expect(g.status).toBe(403);
    expect(await g.json()).toEqual({ code: "LOGIN_REQUIRED" });

    for (const username of [
      "ab",
      "x".repeat(21),
      "has.dot",
      "名前名前",
      "   ",
    ]) {
      const res = await put(h, users[0], { username });
      expect(res.status, username).toBe(400);
      expect((await res.json()).code, username).toBe("USERNAME_INVALID");
    }
    const profane = await put(h, users[0], { username: "fuckyou" });
    expect(profane.status).toBe(400);
    expect((await profane.json()).code).toBe("USERNAME_PROFANE");
    expect((await put(h, users[0], {})).status).toBe(400);
    expect((await put(h, users[0], { username: 42 })).status).toBe(400);

    expect(
      (
        await call(h, "/users/@me/username", {
          method: "PUT",
          origin: null,
          json: { username: "Nobody" },
        })
      ).status,
    ).toBe(401);
    // none of the failures used up the cooldown
    expect((await put(h, users[0], { username: "Fine" })).status).toBe(200);
  });

  it("the same base can belong to several players (the suffix tells them apart)", async () => {
    const { h, users } = await setup(3);
    const names = new Set<string>();
    for (const u of users) {
      const res = await put(h, u, { username: "Twin" });
      expect(res.status).toBe(200);
      names.add((await res.json()).username);
    }
    expect(names.size).toBe(3);
  });

  it("a banned player can not rename", async () => {
    const { h, users } = await setup(1);
    await h.db.pool.query(
      "INSERT INTO bans (user_id, category, reason) VALUES ($1, 'cheating', 'x')",
      [users[0].id],
    );
    expect((await put(h, users[0], { username: "Nope" })).status).toBe(403);
  });

  it("the in-game name stays whatever the player typed (usernames are display names on the profile)", async () => {
    const { h, key, users } = await setup();
    await put(h, users[0], { username: "Named" });
    await play(h, key, {
      players: [
        { user: users[0], username: "TypedInGame" },
        { user: users[1] },
      ],
    });
    const [row] = PublicPlayerGamesResponseSchema.parse(
      await (await games(h, users[0].publicId)).json(),
    ).results;
    expect(row.username).toBe("TypedInGame");
  });
});

describeDb("deleting an account and the cleanup jobs", () => {
  const del = (h: Harness, user: TestUser, origin: string | null = h.origin) =>
    call(h, "/users/@me", { method: "DELETE", jar: user.jar, origin });

  it("queues the deletion, signs everything out, and hides the profile; the job finishes it after the delay", async () => {
    const { h, key, users } = await setup();
    const [a, b] = users;
    await play(h, key, { players: [{ user: a }, { user: b }] });
    await h.db.pool.query(
      `INSERT INTO auth_identities (user_id, provider, provider_user_id, email, profile) VALUES ($1, 'discord', 'd-1', 'x@y.z', '{}')`,
      [a.id],
    );
    await call(h, "/users/@me/username", {
      method: "PUT",
      bearer: a.jwt,
      origin: null,
      json: { username: "Leaving" },
    });

    const res = await del(h, a);
    expect(res.status).toBe(204);
    expect(res.headers.getSetCookie().join(";")).toMatch(/df_refresh=;/);
    // signed out everywhere at once
    expect(
      (await call(h, "/users/@me", { bearer: a.jwt, origin: null })).status,
    ).toBe(401);
    expect(
      (await call(h, "/auth/refresh", { method: "POST", jar: a.jar })).status,
    ).not.toBe(204);
    expect((await publicProfile(h, a.publicId)).status).toBe(404);

    // nothing is removed before the delay
    const now = new Date();
    expect(await runDeletions(h.db.pool, now)).toBe(0);
    expect(
      (await q(h, "SELECT deleted_at FROM users WHERE id = $1", [a.id]))[0]
        .deleted_at,
    ).toBeNull();

    expect(
      await runDeletions(h.db.pool, new Date(now.getTime() + 25 * 3_600_000)),
    ).toBe(1);
    expect(
      await runDeletions(h.db.pool, new Date(now.getTime() + 26 * 3_600_000)),
    ).toBe(0);
    const [row] = await q(
      h,
      "SELECT deleted_at, username_base, kind FROM users WHERE id = $1",
      [a.id],
    );
    expect(row.deleted_at).not.toBeNull();
    expect(row.username_base).toBeNull();
    expect(
      await q(h, "SELECT 1 FROM auth_identities WHERE user_id = $1", [a.id]),
    ).toHaveLength(0);
    expect(
      await q(h, "SELECT 1 FROM refresh_sessions WHERE user_id = $1", [a.id]),
    ).toHaveLength(0);
    expect(
      await q(h, "SELECT 1 FROM player_stat_aggregates WHERE user_id = $1", [
        a.id,
      ]),
    ).toHaveLength(0);
    // the other player's history keeps the game, with the deleted player detached
    expect(
      await q(h, "SELECT 1 FROM game_players WHERE user_id = $1", [a.id]),
    ).toHaveLength(0);
    const theirs = PublicPlayerGamesResponseSchema.parse(
      await (await games(h, b.publicId)).json(),
    );
    expect(theirs.results).toHaveLength(1);
    // and the other player is untouched
    expect(
      (
        await q(
          h,
          "SELECT count(*)::int AS n FROM player_stat_aggregates WHERE user_id = $1",
          [b.id],
        )
      )[0].n,
    ).toBe(1);
  });

  it("a deleted account earns nothing from later records", async () => {
    const { h, key, users } = await setup(3);
    await del(h, users[0]);
    await runDeletions(h.db.pool, new Date(Date.now() + 48 * 3_600_000));
    await play(h, key, {
      players: [{ user: users[0] }, { user: users[1] }, { user: users[2] }],
    });
    expect(
      await q(h, "SELECT credits::int AS c FROM wallets WHERE user_id = $1", [
        users[0].id,
      ]),
    ).toEqual([{ c: 0 }]);
    expect(
      (await q(h, "SELECT count(*)::int AS n FROM game_players"))[0].n,
    ).toBe(2);
  });

  it("needs the session cookie and a page on the site; staff can not self-delete", async () => {
    const { h, users } = await setup(2);
    expect((await del(h, users[0], null)).status).toBe(403);
    expect((await del(h, users[0], "https://evil.example")).status).toBe(403);
    expect(
      (await call(h, "/users/@me", { method: "DELETE", origin: h.origin }))
        .status,
    ).toBe(401);
    // a bearer token alone is not enough (the endpoint is cookie-authenticated)
    expect(
      (
        await call(h, "/users/@me", {
          method: "DELETE",
          bearer: users[0].jwt,
          origin: h.origin,
        })
      ).status,
    ).toBe(401);
    await h.db.pool.query("UPDATE users SET role = 'admin' WHERE id = $1", [
      users[1].id,
    ]);
    expect((await del(h, users[1])).status).toBe(403);
    expect(
      (
        await q(
          h,
          "SELECT deletion_requested_at FROM users WHERE id = ANY($1)",
          [[users[0].id, users[1].id]],
        )
      ).every((r) => r.deletion_requested_at === null),
    ).toBe(true);
  });

  it("is rate limited", async () => {
    const h = await startHarness({
      limits: { accountDeletion: { max: 1, windowMs: 60_000 } },
    });
    harnesses.push(h);
    const a = await makeUser(h);
    const b = await makeUser(h);
    expect((await del(h, a)).status).toBe(204);
    expect((await del(h, b)).status).toBe(429);
  });

  it("the sign-in funnel reports a queued deletion", async () => {
    const { h, users } = await setup(1);
    await h.db.pool.query(
      `INSERT INTO auth_identities (user_id, provider, provider_user_id, profile) VALUES ($1, 'discord', 'd-77', '{}')`,
      [users[0].id],
    );
    expect((await del(h, users[0])).status).toBe(204);
    expect(
      (
        await q(h, "SELECT deletion_requested_at FROM users WHERE id = $1", [
          users[0].id,
        ])
      )[0].deletion_requested_at,
    ).not.toBeNull();
  });

  it("removes idle guests with nothing to keep, and only those", async () => {
    const { h, key, users } = await setup(2);
    const old = async (user: TestUser) =>
      h.db.pool.query(
        "UPDATE users SET last_seen_at = now() - interval '60 days' WHERE id = $1",
        [user.id],
      );
    const idle = await makeUser(h, "guest");
    const idleWithGame = await makeUser(h, "guest");
    const recent = await makeUser(h, "guest");
    const idleRegistered = await makeUser(h, "registered");
    const idleWithCredits = await makeUser(h, "guest");
    // a private game pays nothing, so only the game itself protects this guest
    await play(h, key, {
      type: "Private",
      players: [{ user: idleWithGame }, { user: users[0] }],
    });
    await h.db.pool.query(
      "UPDATE users SET kind = 'guest', last_seen_at = now() - interval '60 days' WHERE id = $1",
      [idleWithCredits.id],
    );
    await h.db.pool.query(
      `INSERT INTO currency_ledger (user_id, delta, balance_after, reason) VALUES ($1, 5, 5, 'admin_grant')`,
      [idleWithCredits.id],
    );
    for (const u of [idle, idleWithGame, idleRegistered]) await old(u);

    expect(await runGuestCleanup(h.db.pool)).toBe(1);
    const left = new Set((await q(h, "SELECT id FROM users")).map((r) => r.id));
    expect(left.has(idle.id)).toBe(false);
    for (const u of [
      idleWithGame,
      recent,
      idleRegistered,
      idleWithCredits,
      users[0],
      users[1],
    ])
      expect(left.has(u.id)).toBe(true);
    expect(await runGuestCleanup(h.db.pool)).toBe(0);
    // its sessions and wallet went with it
    expect(
      await q(h, "SELECT 1 FROM wallets WHERE user_id = $1", [idle.id]),
    ).toHaveLength(0);
    expect(
      await q(h, "SELECT 1 FROM refresh_sessions WHERE user_id = $1", [
        idle.id,
      ]),
    ).toHaveLength(0);
  });
});
