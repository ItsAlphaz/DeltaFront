// @vitest-environment node
import {
  PlayerProfileSchema,
  UserMeResponseSchema,
} from "@openfront/shared/ApiSchemas";
import {
  ClanBansResponseSchema,
  ClanBrowseResponseSchema,
  ClanGamesResponseSchema,
  ClanInfoSchema,
  ClanLeaderboardResponseSchema,
  ClanMembersResponseSchema,
  ClanRequestsResponseSchema,
  JoinClanResponseSchema,
  ReservedClanTagsResponseSchema,
} from "@openfront/shared/ClanApiSchemas";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, it } from "vitest";
import {
  runAdminCommand,
  type AdminIo,
} from "../../src/account-api/admin/commands";
import { CLAN_RULES } from "../../src/account-api/domain/constants";
import { runDeletions } from "../../src/account-api/domain/lifecycle";
import { buildRecord, makeUser, submitGame, type TestUser } from "./util/games";
import {
  call,
  createServerKey,
  startHarness,
  type Harness,
} from "./util/harness";
import { describeDb } from "./util/testDb";

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const DAY = 86_400_000;

let h: Harness;
let serverKey: string;
let n = 0;
let games = 0;

const q = async (sql: string, params: unknown[] = []) =>
  (await h.db.pool.query(sql, params)).rows;

function run(argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const io: AdminIo = {
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    env: {},
    actor: "tester",
  };
  return runAdminCommand(h.db.pool, argv, io).then((code) => ({
    code,
    out: out.join("\n"),
    err: err.join("\n"),
  }));
}

/** Completed counted games for a user, straight into the tables (M2 tests the rule that makes a game "completed"). */
async function seedCompleted(
  user: TestUser,
  count: number,
  completed = true,
  type = "Public",
) {
  const prefix = `c${(++games).toString(36)}`;
  await q(
    `WITH gs AS (
       INSERT INTO games (game_code, source, type, started_at, ended_at, duration_s, human_players, counts_for_stats)
       SELECT $1 || lpad(k::text, 3, '0'), 'server', $4, now() - interval '10 minutes', now(), 600, 2, $5
         FROM generate_series(1, $2) k RETURNING id)
     INSERT INTO game_players (game_id, client_id, user_id, username, result, completed)
     SELECT id, 'p1', $3, 'x', 'victory', $5 FROM gs`,
    [prefix, count, user.id, type, completed],
  );
}

/** A registered, eligible account: old enough and with enough completed games. */
async function player(
  options: { ageDays?: number; games?: number } = {},
): Promise<TestUser> {
  const u = await makeUser(h, "registered");
  await q(
    "UPDATE users SET created_at = now() - make_interval(days => $2), username_base = $3, username_discriminator = '0001' WHERE id = $1",
    [u.id, options.ageDays ?? 10, `p${++n}`],
  );
  if ((options.games ?? 10) > 0) await seedCompleted(u, options.games ?? 10);
  return u;
}

const api = (
  u: { jwt: string } | null,
  method: string,
  route: string,
  body?: unknown,
) =>
  call(h, route, {
    method,
    bearer: u?.jwt,
    origin: null,
    ...(body === undefined ? {} : { json: body }),
  });
const post = (u: TestUser | null, route: string, body?: unknown) =>
  api(u, "POST", route, body);
const get = (u: TestUser | null, route: string) => api(u, "GET", route);

let tagN = 0;
const nextTag = () =>
  `T${(++tagN).toString(36).toUpperCase().padStart(3, "0")}`;
const body = async (res: Response) => res.json();

/** Creates a clan and returns its tag; the creator is the leader. */
async function makeClan(
  leader: TestUser,
  options: {
    name?: string;
    tag?: string;
    isOpen?: boolean;
    description?: string;
  } = {},
): Promise<string> {
  const tag = options.tag ?? nextTag();
  const res = await post(leader, "/clans", {
    name: options.name ?? `Clan ${tag}`,
    tag,
    isOpen: options.isOpen ?? true,
    ...(options.description === undefined
      ? {}
      : { description: options.description }),
  });
  expect(
    res.status,
    JSON.stringify(
      await res
        .clone()
        .json()
        .catch(() => null),
    ),
  ).toBe(201);
  return tag;
}

const roleOf = async (u: TestUser) =>
  (await q("SELECT role FROM clan_members WHERE user_id = $1", [u.id]))[0]
    ?.role ?? null;
const clanOfUser = async (u: TestUser) =>
  (
    await q(
      "SELECT c.tag::text AS tag FROM clan_members m JOIN clans c ON c.id = m.clan_id WHERE m.user_id = $1",
      [u.id],
    )
  )[0]?.tag ?? null;
const meOf = async (u: TestUser) =>
  UserMeResponseSchema.parse(await body(await get(u, "/users/@me")));

/** A clan with a leader, an officer and a plain member, open or closed. */
async function crew(options: { isOpen?: boolean } = {}) {
  const leader = await player();
  const tag = await makeClan(leader, options);
  const officer = await player();
  const member = await player();
  // join through the real endpoints (closed clans: request + approve)
  for (const u of [officer, member]) {
    if (options.isOpen === false) {
      expect((await post(u, `/clans/${tag}/join`)).status).toBe(200);
      expect(
        (
          await post(leader, `/clans/${tag}/requests/approve`, {
            targetPublicId: u.publicId,
          })
        ).status,
      ).toBe(200);
    } else {
      expect((await post(u, `/clans/${tag}/join`)).status).toBe(200);
    }
  }
  expect(
    (
      await post(leader, `/clans/${tag}/promote`, {
        targetPublicId: officer.publicId,
      })
    ).status,
  ).toBe(200);
  return { leader, officer, member, tag };
}

/** Every live clan has exactly one leader, and nobody is in two clans. */
async function expectInvariants() {
  const noLeader = await q(
    `SELECT c.tag::text FROM clans c WHERE c.disbanded_at IS NULL
        AND (SELECT count(*) FROM clan_members m WHERE m.clan_id = c.id AND m.role = 'leader') <> 1`,
  );
  expect(noLeader, "a live clan without exactly one leader").toEqual([]);
  expect(
    await q(
      "SELECT user_id FROM clan_members GROUP BY user_id HAVING count(*) > 1",
    ),
  ).toEqual([]);
  expect(
    await q(
      "SELECT 1 FROM clan_members m JOIN clans c ON c.id = m.clan_id WHERE c.disbanded_at IS NOT NULL",
    ),
  ).toEqual([]);
}

beforeAll(async () => {
  h = await startHarness({
    features: "accounts,inventory,clans",
    limits: {
      clanWrite: { max: 100_000, windowMs: 60_000 },
      publicRead: { max: 100_000, windowMs: 60_000 },
    },
  });
  serverKey = await createServerKey(h);
}, 60_000);
afterAll(async () => h?.close());

describeDb("creating a clan", () => {
  it("creates it atomically: the clan, the leader's membership and an event, and answers 201 ClanInfo", async () => {
    const u = await player();
    const res = await post(u, "/clans", {
      name: "  Delta   Wolves ",
      tag: "dwf",
      description: "We play at night",
      isOpen: false,
    });
    expect(res.status).toBe(201);
    const info = ClanInfoSchema.parse(await body(res));
    expect(info).toMatchObject({
      name: "Delta Wolves",
      tag: "DWF",
      description: "We play at night",
      isOpen: false,
      memberCount: 1,
    });
    expect(info.createdAt).toBeDefined();
    // balances do not exist in V1 and are not invented
    expect(info.softBalance).toBeUndefined();
    expect(info.hardBalance).toBeUndefined();
    expect(
      await q("SELECT role FROM clan_members WHERE user_id = $1", [u.id]),
    ).toEqual([{ role: "leader" }]);
    const clan = (
      await q(
        "SELECT tag::text, name::text, created_by, disbanded_at FROM clans WHERE tag = 'DWF'",
      )
    )[0];
    expect(clan).toMatchObject({
      tag: "DWF",
      name: "Delta Wolves",
      created_by: u.id,
      disbanded_at: null,
    });
    expect(
      (
        await q(
          "SELECT action FROM clan_events WHERE clan_id = (SELECT id FROM clans WHERE tag = 'DWF')",
        )
      ).map((r) => r.action),
    ).toEqual(["create"]);
    expect((await meOf(u)).player.clans).toEqual([
      expect.objectContaining({ tag: "DWF", role: "leader", memberCount: 1 }),
    ]);
  });

  it("uses the defaults: open, empty description", async () => {
    const u = await player();
    const tag = nextTag();
    const res = await post(u, "/clans", { name: `Plain ${tag}`, tag });
    expect(ClanInfoSchema.parse(await body(res))).toMatchObject({
      isOpen: true,
      description: "",
    });
  });

  it("succeeds with exactly the requirements: 10 completed games (and an account a little over 3 days old)", async () => {
    const u = await player({ ageDays: 3, games: 10 });
    await q(
      "UPDATE users SET created_at = now() - interval '3 days 5 seconds' WHERE id = $1",
      [u.id],
    );
    expect(
      (await post(u, "/clans", { name: "Edge Clan", tag: nextTag() })).status,
    ).toBe(201);
  });

  it("refuses an account a few seconds short of 3 days: 403 ACCOUNT_TOO_NEW with the requirement and the current age", async () => {
    const u = await player({ games: 12 });
    await q(
      "UPDATE users SET created_at = now() - interval '2 days 23 hours 59 minutes' WHERE id = $1",
      [u.id],
    );
    const res = await post(u, "/clans", { name: "Too Soon", tag: nextTag() });
    expect(res.status).toBe(403);
    expect(await body(res)).toEqual({
      code: "ACCOUNT_TOO_NEW",
      required: 3,
      current: 2,
    });
    expect(await clanOfUser(u)).toBeNull();
  });

  it("refuses 9 completed games: 403 NOT_ENOUGH_GAMES with required and current", async () => {
    const u = await player({ games: 9 });
    const res = await post(u, "/clans", { name: "Nine Games", tag: nextTag() });
    expect(res.status).toBe(403);
    expect(await body(res)).toEqual({
      code: "NOT_ENOUGH_GAMES",
      required: 10,
      current: 9,
    });
  });

  it("counts only completed games: incomplete ones and private ones do not help", async () => {
    const u = await player({ games: 5 });
    await seedCompleted(u, 4, false); // not completed
    await seedCompleted(u, 4, false, "Private"); // private games never complete
    const res = await post(u, "/clans", { name: "Not Enough", tag: nextTag() });
    expect(await body(res)).toEqual({
      code: "NOT_ENOUGH_GAMES",
      required: 10,
      current: 5,
    });
    await seedCompleted(u, 5);
    expect(
      (await post(u, "/clans", { name: "Now Enough", tag: nextTag() })).status,
    ).toBe(201);
  });

  it("refuses a member, and a leader, who are already in a clan: 403 ALREADY_IN_CLAN", async () => {
    const { leader, member } = await crew();
    for (const u of [leader, member]) {
      const res = await post(u, "/clans", {
        name: "Second Clan",
        tag: nextTag(),
      });
      expect(res.status).toBe(403);
      expect(await body(res)).toMatchObject({ code: "ALREADY_IN_CLAN" });
    }
    await expectInvariants();
  });

  it("refuses a duplicate name (any case, any spacing) and a duplicate tag (any case): 409", async () => {
    const owner = await player();
    const tag = await makeClan(owner, { name: "Iron Legion", tag: "IRN" });
    for (const name of [
      "iron legion",
      "IRON  LEGION",
      " Iron Legion ",
      "Ｉｒｏｎ Ｌｅｇｉｏｎ",
    ]) {
      const u = await player();
      const res = await post(u, "/clans", { name, tag: nextTag() });
      expect(res.status, name).toBe(409);
      expect(await body(res), name).toEqual({ code: "NAME_TAKEN" });
    }
    for (const t of ["irn", "Irn", "IRN"]) {
      const u = await player();
      const res = await post(u, "/clans", { name: `Other ${t}${n}`, tag: t });
      expect(res.status, t).toBe(409);
      expect(await body(res), t).toEqual({ code: "TAG_TAKEN" });
    }
    expect(tag).toBe("IRN");
    expect(
      await q("SELECT count(*)::int AS n FROM clans WHERE tag = 'IRN'"),
    ).toEqual([{ n: 1 }]);
  });

  it.each(["ADMIN", "admin", "Mod", "DEV", "staff", "DF", "delta", "of"])(
    "refuses the reserved tag %s: 409 TAG_TAKEN",
    async (tag) => {
      const u = await player();
      const res = await post(u, "/clans", { name: `Reserved ${n}${tag}`, tag });
      expect(res.status).toBe(409);
      expect(await body(res)).toEqual({ code: "TAG_TAKEN" });
      expect(await clanOfUser(u)).toBeNull();
    },
  );

  it.each([
    "DeltaFront",
    "Delta Front Elite",
    "D-E-L-T-A-F-R-O-N-T",
    "OpenFront Veterans",
    "Official Admin Team",
  ])(
    "refuses the name %s, which imitates a reserved one: 409 NAME_TAKEN",
    async (name) => {
      const u = await player();
      const res = await post(u, "/clans", { name, tag: nextTag() });
      expect(res.status).toBe(409);
      expect(await body(res)).toEqual({ code: "NAME_TAKEN" });
    },
  );

  it.each([
    ["a name that is too short", { name: "ab", tag: "OKT" }, "INVALID_NAME"],
    [
      "a name that is too long",
      { name: "x".repeat(36), tag: "OKT" },
      "INVALID_NAME",
    ],
    [
      "a name with a zero-width character",
      { name: "Del​ta", tag: "OKT" },
      "INVALID_NAME",
    ],
    [
      "a name with a bidi override",
      { name: "Delta‮Force", tag: "OKT" },
      "INVALID_NAME",
    ],
    ["a name with markup", { name: "<b>Clan</b>", tag: "OKT" }, "INVALID_NAME"],
    ["a profane name", { name: "Fuck Clan", tag: "OKT" }, "NAME_PROFANE"],
    [
      "a tag that is too short",
      { name: "Valid Name", tag: "A" },
      "INVALID_TAG",
    ],
    [
      "a tag that is too long",
      { name: "Valid Name", tag: "ABCDEF" },
      "INVALID_TAG",
    ],
    ["a tag with a space", { name: "Valid Name", tag: "A B" }, "INVALID_TAG"],
    ["a tag with a dash", { name: "Valid Name", tag: "A-B" }, "INVALID_TAG"],
    ["a non-ASCII tag", { name: "Valid Name", tag: "ÄB" }, "INVALID_TAG"],
    ["a profane tag", { name: "Valid Name", tag: "FUCK" }, "NAME_PROFANE"],
    ["a missing name", { tag: "OKT" }, "INVALID_NAME"],
    ["a missing tag", { name: "Valid Name" }, "INVALID_TAG"],
    ["a number as the name", { name: 5, tag: "OKT" }, "INVALID_NAME"],
    [
      "an object as the tag",
      { name: "Valid Name", tag: { $ne: 1 } },
      "INVALID_TAG",
    ],
  ])("refuses %s: 400 %s", async (_what, input, code) => {
    const u = await player();
    const res = await post(u, "/clans", input);
    expect(res.status).toBe(400);
    expect(await body(res)).toEqual({ code });
    expect(await clanOfUser(u)).toBeNull();
  });

  it("refuses a bad description or flag: 400", async () => {
    const u = await player();
    for (const input of [
      { description: "x".repeat(201) },
      { description: "line\nbreak" },
      { description: 5 },
      { isOpen: "yes" },
    ]) {
      const res = await post(u, "/clans", {
        name: "Valid Name",
        tag: "VLD",
        ...input,
      });
      expect(res.status, JSON.stringify(input)).toBe(400);
    }
    expect(await q("SELECT 1 FROM clans WHERE tag = 'VLD'")).toEqual([]);
  });

  it("refuses non-object bodies and malformed JSON", async () => {
    const u = await player();
    for (const raw of ["[]", '"x"', "null", "{ nope"]) {
      const res = await fetch(`${h.baseUrl}/clans`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${u.jwt}`,
          "Content-Type": "application/json",
        },
        body: raw,
      });
      expect(res.status, raw).toBe(400);
    }
  });

  it("refuses a guest (403 LOGIN_REQUIRED), the signed out (401), a banned account (403 BANNED) and an account queued for deletion (401)", async () => {
    const guest = await makeUser(h, "guest");
    await q(
      "UPDATE users SET created_at = now() - interval '10 days' WHERE id = $1",
      [guest.id],
    );
    await seedCompleted(guest, 10);
    const res = await post(guest, "/clans", {
      name: "Guest Clan",
      tag: nextTag(),
    });
    expect([res.status, (await body(res)).code]).toEqual([
      403,
      "LOGIN_REQUIRED",
    ]);
    expect(
      (await post(null, "/clans", { name: "Nobody Clan", tag: nextTag() }))
        .status,
    ).toBe(401);

    const banned = await player();
    await q(
      "INSERT INTO bans (user_id, category, reason) VALUES ($1, 'test', 'x')",
      [banned.id],
    );
    const b = await post(banned, "/clans", {
      name: "Banned Clan",
      tag: nextTag(),
    });
    expect(b.status).toBe(403);
    expect(await body(b)).toEqual({ code: "BANNED" });

    const queued = await player();
    await q("UPDATE users SET deletion_requested_at = now() WHERE id = $1", [
      queued.id,
    ]);
    expect(
      (await post(queued, "/clans", { name: "Queued Clan", tag: nextTag() }))
        .status,
    ).toBe(401);
    expect(
      await q(
        "SELECT 1 FROM clans WHERE name::text IN ('Guest Clan','Banned Clan','Queued Clan')",
      ),
    ).toEqual([]);
  });

  it("holds a disbanded clan's tag for the hold period, then lets it go", async () => {
    const owner = await player();
    const tag = await makeClan(owner, { tag: "HLD" });
    expect((await api(owner, "DELETE", `/clans/${tag}`)).status).toBe(200);
    const other = await player();
    const held = await post(other, "/clans", { name: "Held Out", tag: "HLD" });
    expect(held.status).toBe(409);
    expect(await body(held)).toEqual({ code: "TAG_HELD" });
    // the hold length is the constant, and an expired hold frees the tag
    const hold = (
      await q(
        "SELECT reusable_after > now() + make_interval(days => $1 - 1) AS long_enough FROM clan_tag_holds WHERE tag = 'HLD'",
        [CLAN_RULES.disbandedTagHoldDays],
      )
    )[0];
    expect(hold.long_enough).toBe(true);
    await q(
      "UPDATE clan_tag_holds SET reusable_after = now() - interval '1 second' WHERE tag = 'HLD'",
    );
    expect(
      (await post(other, "/clans", { name: "Held Out", tag: "HLD" })).status,
    ).toBe(201);
    expect(await q("SELECT 1 FROM clan_tag_holds WHERE tag = 'HLD'")).toEqual(
      [],
    );
  });

  it("frees the name of a disbanded clan at once", async () => {
    const owner = await player();
    const tag = await makeClan(owner, {
      name: "Fleeting Name",
      tag: nextTag(),
    });
    expect((await api(owner, "DELETE", `/clans/${tag}`)).status).toBe(200);
    const next = await player();
    expect(
      (await post(next, "/clans", { name: "Fleeting Name", tag: nextTag() }))
        .status,
    ).toBe(201);
  });

  it("two accounts creating the same tag at once: one 201, one 409", async () => {
    const a = await player();
    const b = await player();
    const results = await Promise.all([
      post(a, "/clans", { name: "Race Alpha", tag: "RCE" }),
      post(b, "/clans", { name: "Race Beta", tag: "RCE" }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(
      await q("SELECT count(*)::int AS n FROM clans WHERE tag = 'RCE'"),
    ).toEqual([{ n: 1 }]);
    await expectInvariants();
  });

  it("two accounts creating the same name at once: one 201, one 409", async () => {
    const a = await player();
    const b = await player();
    const results = await Promise.all([
      post(a, "/clans", { name: "Twin Name", tag: nextTag() }),
      post(b, "/clans", { name: "twin name", tag: nextTag() }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
  });

  it("one account creating two clans at once: one 201, the other refused, one membership", async () => {
    const u = await player();
    const results = await Promise.all([
      post(u, "/clans", { name: "Double One", tag: nextTag() }),
      post(u, "/clans", { name: "Double Two", tag: nextTag() }),
    ]);
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(
      results
        .filter((r) => r.status !== 201)
        .every((r) => r.status === 403 || r.status === 409),
    ).toBe(true);
    expect(
      await q(
        "SELECT count(*)::int AS n FROM clan_members WHERE user_id = $1",
        [u.id],
      ),
    ).toEqual([{ n: 1 }]);
    await expectInvariants();
  });

  it("deletes the creator's pending requests elsewhere", async () => {
    const owner = await player();
    const closed = await makeClan(owner, { isOpen: false });
    const u = await player();
    await post(u, `/clans/${closed}/join`);
    expect(
      await q("SELECT 1 FROM clan_join_requests WHERE user_id = $1", [u.id]),
    ).toHaveLength(1);
    await makeClan(u);
    expect(
      await q("SELECT 1 FROM clan_join_requests WHERE user_id = $1", [u.id]),
    ).toEqual([]);
  });
});

describeDb("joining, requesting and leaving", () => {
  it("joins an open clan at once: 200 { status: joined }, and /users/@me shows the clan", async () => {
    const owner = await player();
    const tag = await makeClan(owner);
    const u = await player();
    const res = await post(u, `/clans/${tag}/join`);
    expect(res.status).toBe(200);
    expect(JoinClanResponseSchema.parse(await body(res))).toEqual({
      status: "joined",
    });
    expect(await roleOf(u)).toBe("member");
    expect((await meOf(u)).player.clans).toEqual([
      expect.objectContaining({ tag, role: "member", memberCount: 2 }),
    ]);
  });

  it("asks to join a closed clan: 200 { status: requested }, not yet a member, visible in /users/@me", async () => {
    const owner = await player();
    const tag = await makeClan(owner, { isOpen: false });
    const u = await player();
    const res = await post(u, `/clans/${tag}/join`);
    expect(JoinClanResponseSchema.parse(await body(res))).toEqual({
      status: "requested",
    });
    expect(await clanOfUser(u)).toBeNull();
    const me = await meOf(u);
    expect(me.player.clanRequests).toEqual([expect.objectContaining({ tag })]);
    expect(me.player.clans).toEqual([]);
  });

  it("the same request twice is refused (409 REQUEST_PENDING, message containing 'request') and not duplicated", async () => {
    const tag = await makeClan(await player(), { isOpen: false });
    const u = await player();
    await post(u, `/clans/${tag}/join`);
    const again = await post(u, `/clans/${tag}/join`);
    expect(again.status).toBe(409);
    const b = await body(again);
    expect(b.code).toBe("REQUEST_PENDING");
    expect(String(b.message).toLowerCase()).toContain("request");
    expect(
      await q("SELECT 1 FROM clan_join_requests WHERE user_id = $1", [u.id]),
    ).toHaveLength(1);
  });

  it("the leader approves a request: the player becomes a member and every other request of theirs is deleted", async () => {
    const a = await player();
    const b = await player();
    const tagA = await makeClan(a, { isOpen: false });
    const tagB = await makeClan(b, { isOpen: false });
    const u = await player();
    await post(u, `/clans/${tagA}/join`);
    await post(u, `/clans/${tagB}/join`);
    const listed = ClanRequestsResponseSchema.parse(
      await body(await get(a, `/clans/${tagA}/requests`)),
    );
    expect(listed.results.map((r) => r.publicId)).toEqual([u.publicId]);
    const res = await post(a, `/clans/${tagA}/requests/approve`, {
      targetPublicId: u.publicId,
    });
    expect(res.status).toBe(200);
    expect(await clanOfUser(u)).toBe(tagA);
    expect(
      await q("SELECT 1 FROM clan_join_requests WHERE user_id = $1", [u.id]),
    ).toEqual([]);
    expect(await roleOf(u)).toBe("member");
  });

  it("denies a request: it is gone and the player is not a member; denying again is 404", async () => {
    const owner = await player();
    const tag = await makeClan(owner, { isOpen: false });
    const u = await player();
    await post(u, `/clans/${tag}/join`);
    expect(
      (
        await post(owner, `/clans/${tag}/requests/deny`, {
          targetPublicId: u.publicId,
        })
      ).status,
    ).toBe(200);
    expect(
      await q("SELECT 1 FROM clan_join_requests WHERE user_id = $1", [u.id]),
    ).toEqual([]);
    expect(await clanOfUser(u)).toBeNull();
    expect(
      (
        await post(owner, `/clans/${tag}/requests/deny`, {
          targetPublicId: u.publicId,
        })
      ).status,
    ).toBe(404);
  });

  it("replaying an approval does nothing: the second is 404 and the membership is unchanged", async () => {
    const owner = await player();
    const tag = await makeClan(owner, { isOpen: false });
    const u = await player();
    await post(u, `/clans/${tag}/join`);
    const first = await post(owner, `/clans/${tag}/requests/approve`, {
      targetPublicId: u.publicId,
    });
    const second = await post(owner, `/clans/${tag}/requests/approve`, {
      targetPublicId: u.publicId,
    });
    expect([first.status, second.status]).toEqual([200, 404]);
    expect(
      await q(
        "SELECT count(*)::int AS n FROM clan_members WHERE user_id = $1",
        [u.id],
      ),
    ).toEqual([{ n: 1 }]);
  });

  it("an approval racing the same approval: one member row, no error leaks", async () => {
    const owner = await player();
    const tag = await makeClan(owner, { isOpen: false });
    const u = await player();
    await post(u, `/clans/${tag}/join`);
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        post(owner, `/clans/${tag}/requests/approve`, {
          targetPublicId: u.publicId,
        }),
      ),
    );
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(results.every((r) => [200, 404, 409].includes(r.status))).toBe(true);
    expect(
      await q(
        "SELECT count(*)::int AS n FROM clan_members WHERE user_id = $1",
        [u.id],
      ),
    ).toEqual([{ n: 1 }]);
  });

  it("withdraws your own request; withdrawing a request that is not there is 404", async () => {
    const tag = await makeClan(await player(), { isOpen: false });
    const u = await player();
    await post(u, `/clans/${tag}/join`);
    expect((await post(u, `/clans/${tag}/requests/withdraw`)).status).toBe(200);
    expect(
      await q("SELECT 1 FROM clan_join_requests WHERE user_id = $1", [u.id]),
    ).toEqual([]);
    expect((await post(u, `/clans/${tag}/requests/withdraw`)).status).toBe(404);
  });

  it("refuses a second clan on join: 409 ALREADY_IN_CLAN, whether the first is the same clan or another", async () => {
    const a = await makeClan(await player());
    const b = await makeClan(await player());
    const u = await player();
    await post(u, `/clans/${a}/join`);
    for (const tag of [a, b]) {
      const res = await post(u, `/clans/${tag}/join`);
      expect(res.status).toBe(409);
      const bd = await body(res);
      expect(bd.code).toBe("ALREADY_IN_CLAN");
      expect(String(bd.message).toLowerCase()).not.toContain("request");
    }
    expect(await clanOfUser(u)).toBe(a);
  });

  it("limits pending requests to 3 per player (the 4th is 429), and clears them when one is accepted elsewhere", async () => {
    const clans: string[] = [];
    for (let i = 0; i < 4; i++)
      clans.push(await makeClan(await player(), { isOpen: false }));
    const u = await player();
    for (let i = 0; i < CLAN_RULES.maxPendingRequests; i++) {
      expect((await post(u, `/clans/${clans[i]}/join`)).status).toBe(200);
    }
    const over = await post(u, `/clans/${clans[3]}/join`);
    expect(over.status).toBe(429);
    expect((await body(over)).code).toBe("TOO_MANY_REQUESTS");
    expect(
      await q(
        "SELECT count(*)::int AS n FROM clan_join_requests WHERE user_id = $1",
        [u.id],
      ),
    ).toEqual([{ n: 3 }]);
  });

  it("approving a request after the player joined another clan: 409 ALREADY_IN_CLAN and the request is removed", async () => {
    const ownerA = await player();
    const tagA = await makeClan(ownerA, { isOpen: false });
    const tagB = await makeClan(await player(), { isOpen: true });
    const u = await player();
    await post(u, `/clans/${tagA}/join`); // pending at A
    // the request survives only because joining B (open) would normally delete it: put it back to model the race
    await post(u, `/clans/${tagB}/join`);
    await q(
      "INSERT INTO clan_join_requests (clan_id, user_id) SELECT id, $1 FROM clans WHERE tag = $2",
      [u.id, tagA],
    );
    const res = await post(ownerA, `/clans/${tagA}/requests/approve`, {
      targetPublicId: u.publicId,
    });
    expect(res.status).toBe(409);
    expect((await body(res)).code).toBe("ALREADY_IN_CLAN");
    expect(
      await q("SELECT 1 FROM clan_join_requests WHERE user_id = $1", [u.id]),
    ).toEqual([]);
    expect(await clanOfUser(u)).toBe(tagB);
  });

  it("joining one clan deletes the player's pending requests everywhere", async () => {
    const closed = await makeClan(await player(), { isOpen: false });
    const open = await makeClan(await player(), { isOpen: true });
    const u = await player();
    await post(u, `/clans/${closed}/join`);
    expect(
      await q("SELECT 1 FROM clan_join_requests WHERE user_id = $1", [u.id]),
    ).toHaveLength(1);
    await post(u, `/clans/${open}/join`);
    expect(
      await q("SELECT 1 FROM clan_join_requests WHERE user_id = $1", [u.id]),
    ).toEqual([]);
  });

  it("two simultaneous joins to two different open clans: exactly one wins, the other is ALREADY_IN_CLAN", async () => {
    for (let round = 0; round < 8; round++) {
      const a = await makeClan(await player());
      const b = await makeClan(await player());
      const u = await player();
      const results = await Promise.all([
        post(u, `/clans/${a}/join`),
        post(u, `/clans/${b}/join`),
      ]);
      expect(results.map((r) => r.status).sort(), `round ${round}`).toEqual([
        200, 409,
      ]);
      const loser = results.find((r) => r.status === 409)!;
      expect((await body(loser)).code).toBe("ALREADY_IN_CLAN");
      expect(
        await q(
          "SELECT count(*)::int AS n FROM clan_members WHERE user_id = $1",
          [u.id],
        ),
      ).toEqual([{ n: 1 }]);
    }
    await expectInvariants();
  });

  it("two simultaneous approvals by two clans of the same player: one clan gets them", async () => {
    for (let round = 0; round < 6; round++) {
      const ownerA = await player();
      const ownerB = await player();
      const a = await makeClan(ownerA, { isOpen: false });
      const b = await makeClan(ownerB, { isOpen: false });
      const u = await player();
      await post(u, `/clans/${a}/join`);
      await post(u, `/clans/${b}/join`);
      const results = await Promise.all([
        post(ownerA, `/clans/${a}/requests/approve`, {
          targetPublicId: u.publicId,
        }),
        post(ownerB, `/clans/${b}/requests/approve`, {
          targetPublicId: u.publicId,
        }),
      ]);
      expect(
        results.filter((r) => r.status === 200),
        `round ${round}`,
      ).toHaveLength(1);
      expect(
        await q(
          "SELECT count(*)::int AS n FROM clan_members WHERE user_id = $1",
          [u.id],
        ),
      ).toEqual([{ n: 1 }]);
      expect(
        await q("SELECT 1 FROM clan_join_requests WHERE user_id = $1", [u.id]),
      ).toEqual([]);
    }
    await expectInvariants();
  });

  it("the database itself refuses a second membership and a second leader", async () => {
    const owner = await player();
    const a = await makeClan(owner);
    const b = await makeClan(await player());
    const bClan = (await q("SELECT id FROM clans WHERE tag = $1", [b]))[0].id;
    await expect(
      q(
        "INSERT INTO clan_members (clan_id, user_id, role) VALUES ($1, $2, 'member')",
        [bClan, owner.id],
      ),
    ).rejects.toMatchObject({ code: "23505" });
    const aClan = (await q("SELECT id FROM clans WHERE tag = $1", [a]))[0].id;
    const extra = await player();
    await expect(
      q(
        "INSERT INTO clan_members (clan_id, user_id, role) VALUES ($1, $2, 'leader')",
        [aClan, extra.id],
      ),
    ).rejects.toMatchObject({ code: "23505" });
    await expect(
      q(
        "INSERT INTO clan_members (clan_id, user_id, role) VALUES ($1, $2, 'owner')",
        [aClan, extra.id],
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("leaves a clan: the membership is gone and the tag no longer appears in /users/@me", async () => {
    const { member, tag } = await crew();
    expect((await post(member, `/clans/${tag}/leave`)).status).toBe(200);
    expect(await clanOfUser(member)).toBeNull();
    expect((await meOf(member)).player.clans).toEqual([]);
    expect((await post(member, `/clans/${tag}/leave`)).status).toBe(404);
  });

  it("a leader with other members cannot leave: 409 TRANSFER_REQUIRED, the clan keeps its leader", async () => {
    const { leader, tag } = await crew();
    const res = await post(leader, `/clans/${tag}/leave`);
    expect(res.status).toBe(409);
    expect(await body(res)).toEqual({ code: "TRANSFER_REQUIRED" });
    expect(await roleOf(leader)).toBe("leader");
    await expectInvariants();
  });

  it("a sole member who is the leader leaving disbands the clan, holds its tag and frees its name", async () => {
    const leader = await player();
    const tag = await makeClan(leader, { name: "Last Stand", tag: "LST" });
    expect((await post(leader, `/clans/${tag}/leave`)).status).toBe(200);
    expect(
      await q(
        "SELECT disbanded_at IS NOT NULL AS gone FROM clans WHERE tag = 'LST'",
      ),
    ).toEqual([{ gone: true }]);
    expect(
      await q("SELECT 1 FROM clan_tag_holds WHERE tag = 'LST'"),
    ).toHaveLength(1);
    expect((await get(null, "/clans/LST")).status).toBe(404);
    expect(
      (
        await post(await player(), "/clans", {
          name: "Last Stand",
          tag: nextTag(),
        })
      ).status,
    ).toBe(201);
  });

  it("a guest, the signed out and a banned account cannot join; each leaves no trace", async () => {
    const tag = await makeClan(await player());
    const guest = await makeUser(h, "guest");
    const res = await post(guest, `/clans/${tag}/join`);
    expect([res.status, (await body(res)).code]).toEqual([
      403,
      "LOGIN_REQUIRED",
    ]);
    expect((await post(null, `/clans/${tag}/join`)).status).toBe(401);
    const banned = await player();
    await q("INSERT INTO bans (user_id, category) VALUES ($1, 'test')", [
      banned.id,
    ]);
    expect((await post(banned, `/clans/${tag}/join`)).status).toBe(403);
    expect(
      (
        await q(
          "SELECT count(*)::int AS n FROM clan_members m JOIN clans c ON c.id = m.clan_id WHERE c.tag = $1",
          [tag],
        )
      )[0].n,
    ).toBe(1);
  });

  it("an unknown or malformed tag is 404, and the response never leaks anything", async () => {
    const u = await player();
    for (const tag of ["NOPE1", "A", "ABCDEFG", "%2e%2e", "a%20b"]) {
      expect((await post(u, `/clans/${tag}/join`)).status, tag).toBe(404);
      expect((await get(u, `/clans/${tag}`)).status, tag).toBe(404);
    }
  });
});

describeDb("kick, ban, promote, demote and transfer", () => {
  it("a leader kicks an officer and a member; an officer kicks a member but not an officer or the leader", async () => {
    const { leader, officer, member, tag } = await crew();
    const other = await player();
    await post(other, `/clans/${tag}/join`);
    await post(leader, `/clans/${tag}/promote`, {
      targetPublicId: other.publicId,
    });
    // officer vs officer, officer vs leader
    expect(
      (
        await post(officer, `/clans/${tag}/kick`, {
          targetPublicId: other.publicId,
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await post(officer, `/clans/${tag}/kick`, {
          targetPublicId: leader.publicId,
        })
      ).status,
    ).toBe(403);
    expect(await roleOf(other)).toBe("officer");
    expect(await roleOf(leader)).toBe("leader");
    // officer vs member
    expect(
      (
        await post(officer, `/clans/${tag}/kick`, {
          targetPublicId: member.publicId,
        })
      ).status,
    ).toBe(200);
    expect(await clanOfUser(member)).toBeNull();
    // leader vs officer
    expect(
      (
        await post(leader, `/clans/${tag}/kick`, {
          targetPublicId: other.publicId,
        })
      ).status,
    ).toBe(200);
    expect(await clanOfUser(other)).toBeNull();
  });

  it("a member cannot kick, ban, promote, demote, transfer, edit, disband or read the requests, bans or leader tools", async () => {
    const { leader, officer, member, tag } = await crew();
    const target = { targetPublicId: officer.publicId };
    for (const route of [
      "kick",
      "promote",
      "demote",
      "transfer",
      "ban",
      "unban",
      "requests/approve",
      "requests/deny",
    ]) {
      const res = await post(member, `/clans/${tag}/${route}`, target);
      expect(res.status, route).toBe(403);
    }
    expect(
      (await api(member, "PATCH", `/clans/${tag}`, { description: "hijack" }))
        .status,
    ).toBe(403);
    expect((await api(member, "DELETE", `/clans/${tag}`)).status).toBe(403);
    expect((await get(member, `/clans/${tag}/requests`)).status).toBe(403);
    expect((await get(member, `/clans/${tag}/bans`)).status).toBe(403);
    expect(await roleOf(officer)).toBe("officer");
    expect(await roleOf(leader)).toBe("leader");
  });

  it("an officer cannot promote, demote, transfer, rename or disband", async () => {
    const { leader, officer, member, tag } = await crew();
    for (const [route, who] of [
      ["promote", member],
      ["demote", leader],
      ["transfer", member],
      ["transfer", leader],
      ["promote", leader],
    ] as const) {
      const res = await post(officer, `/clans/${tag}/${route}`, {
        targetPublicId: who.publicId,
      });
      expect(res.status, `${route} ${who.publicId}`).toBe(403);
    }
    expect(
      (await api(officer, "PATCH", `/clans/${tag}`, { name: "Officers Rule" }))
        .status,
    ).toBe(403);
    expect((await api(officer, "DELETE", `/clans/${tag}`)).status).toBe(403);
    expect(await roleOf(member)).toBe("member");
    expect(await roleOf(leader)).toBe("leader");
  });

  it("an officer cannot make themselves leader: promoting or transferring to self is refused, and a forged role in the body is ignored", async () => {
    const { leader, officer, tag } = await crew();
    for (const route of ["promote", "transfer", "demote", "kick"]) {
      const res = await post(officer, `/clans/${tag}/${route}`, {
        targetPublicId: officer.publicId,
        role: "leader",
      });
      expect([400, 403], route).toContain(res.status);
    }
    const patch = await api(officer, "PATCH", `/clans/${tag}`, {
      role: "leader",
      leader: officer.publicId,
      description: "ok",
    });
    expect(patch.status).toBe(200);
    expect(await roleOf(officer)).toBe("officer");
    expect(await roleOf(leader)).toBe("leader");
    // a role smuggled into a join, a create or a promote does nothing either
    const joiner = await player();
    await post(joiner, `/clans/${tag}/join`, {
      role: "leader",
      clanRole: "officer",
    });
    expect(await roleOf(joiner)).toBe("member");
  });

  it("nobody can kick, ban, demote or promote the leader, or act on themselves", async () => {
    const { leader, officer, member, tag } = await crew();
    for (const route of ["kick", "ban", "demote", "promote", "transfer"]) {
      expect(
        (
          await post(leader, `/clans/${tag}/${route}`, {
            targetPublicId: leader.publicId,
          })
        ).status,
        `leader self ${route}`,
      ).toBe(400);
      expect(
        (
          await post(officer, `/clans/${tag}/${route}`, {
            targetPublicId: leader.publicId,
          })
        ).status,
        `officer on leader ${route}`,
      ).toBe(403);
      expect(
        (
          await post(member, `/clans/${tag}/${route}`, {
            targetPublicId: leader.publicId,
          })
        ).status,
        `member on leader ${route}`,
      ).toBe(403);
    }
    expect(await roleOf(leader)).toBe("leader");
    await expectInvariants();
  });

  it("promotes a member to officer and demotes an officer to member, and only those", async () => {
    const { leader, officer, member, tag } = await crew();
    expect(
      (
        await post(leader, `/clans/${tag}/promote`, {
          targetPublicId: member.publicId,
        })
      ).status,
    ).toBe(200);
    expect(await roleOf(member)).toBe("officer");
    expect(
      (
        await post(leader, `/clans/${tag}/promote`, {
          targetPublicId: member.publicId,
        })
      ).status,
    ).toBe(403); // already an officer
    expect(
      (
        await post(leader, `/clans/${tag}/demote`, {
          targetPublicId: officer.publicId,
        })
      ).status,
    ).toBe(200);
    expect(await roleOf(officer)).toBe("member");
    expect(
      (
        await post(leader, `/clans/${tag}/demote`, {
          targetPublicId: officer.publicId,
        })
      ).status,
    ).toBe(403); // a member cannot go lower
  });

  it("transfers leadership: the target becomes leader, the old leader an officer, and the old leader loses leader powers", async () => {
    const { leader, officer, member, tag } = await crew();
    expect(
      (
        await post(leader, `/clans/${tag}/transfer`, {
          targetPublicId: officer.publicId,
        })
      ).status,
    ).toBe(200);
    expect(await roleOf(officer)).toBe("leader");
    expect(await roleOf(leader)).toBe("officer");
    await expectInvariants();
    expect(
      (
        await post(leader, `/clans/${tag}/promote`, {
          targetPublicId: member.publicId,
        })
      ).status,
    ).toBe(403);
    expect((await api(leader, "DELETE", `/clans/${tag}`)).status).toBe(403);
    expect(
      (
        await post(officer, `/clans/${tag}/promote`, {
          targetPublicId: member.publicId,
        })
      ).status,
    ).toBe(200);
    // the old leader can now leave
    expect((await post(leader, `/clans/${tag}/leave`)).status).toBe(200);
  });

  it("transfers to a plain member too, and refuses a target outside the clan", async () => {
    const { leader, member, tag } = await crew();
    const outsider = await player();
    expect(
      (
        await post(leader, `/clans/${tag}/transfer`, {
          targetPublicId: outsider.publicId,
        })
      ).status,
    ).toBe(404);
    expect(await roleOf(leader)).toBe("leader");
    expect(
      (
        await post(leader, `/clans/${tag}/transfer`, {
          targetPublicId: member.publicId,
        })
      ).status,
    ).toBe(200);
    expect(await roleOf(member)).toBe("leader");
  });

  it("two simultaneous transfers to different members: one wins and there is never zero or two leaders", async () => {
    for (let round = 0; round < 6; round++) {
      const { leader, officer, member, tag } = await crew();
      const results = await Promise.all([
        post(leader, `/clans/${tag}/transfer`, {
          targetPublicId: officer.publicId,
        }),
        post(leader, `/clans/${tag}/transfer`, {
          targetPublicId: member.publicId,
        }),
      ]);
      expect(results.map((r) => r.status).sort(), `round ${round}`).toEqual([
        200, 403,
      ]);
      await expectInvariants();
    }
  });

  it("a transfer racing the old leader leaving: the clan is never ownerless", async () => {
    for (let round = 0; round < 6; round++) {
      const { leader, officer, tag } = await crew();
      await Promise.all([
        post(leader, `/clans/${tag}/transfer`, {
          targetPublicId: officer.publicId,
        }),
        post(leader, `/clans/${tag}/leave`),
      ]);
      await expectInvariants();
    }
  });

  it("disbands: members and requests go, the clan is 404, the tag is held", async () => {
    const { leader, officer, member, tag } = await crew({ isOpen: false });
    const asker = await player();
    await post(asker, `/clans/${tag}/join`);
    expect((await api(leader, "DELETE", `/clans/${tag}`)).status).toBe(200);
    for (const u of [leader, officer, member])
      expect(await clanOfUser(u)).toBeNull();
    expect(
      await q("SELECT 1 FROM clan_join_requests WHERE user_id = $1", [
        asker.id,
      ]),
    ).toEqual([]);
    expect((await get(null, `/clans/${tag}`)).status).toBe(404);
    expect((await post(member, `/clans/${tag}/join`)).status).toBe(404);
    expect(
      await q("SELECT 1 FROM clan_tag_holds WHERE tag = $1", [tag]),
    ).toHaveLength(1);
    await expectInvariants();
  });

  it("bans remove the member and their request, block rejoining with BANNED and the reason, and unban lifts it", async () => {
    const { leader, officer, member, tag } = await crew({ isOpen: false });
    const res = await post(officer, `/clans/${tag}/ban`, {
      targetPublicId: member.publicId,
      reason: "griefing",
    });
    expect(res.status).toBe(200);
    expect(await clanOfUser(member)).toBeNull();
    const rejoin = await post(member, `/clans/${tag}/join`);
    expect(rejoin.status).toBe(403);
    expect(await body(rejoin)).toEqual({ code: "BANNED", reason: "griefing" });
    const bans = ClanBansResponseSchema.parse(
      await body(await get(leader, `/clans/${tag}/bans`)),
    );
    expect(bans.results).toEqual([
      expect.objectContaining({
        publicId: member.publicId,
        reason: "griefing",
        bannedBy: officer.publicId,
      }),
    ]);
    // a banned player's pending request is removed too, and cannot be approved
    expect(
      (
        await post(leader, `/clans/${tag}/unban`, {
          targetPublicId: member.publicId,
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await post(leader, `/clans/${tag}/unban`, {
          targetPublicId: member.publicId,
        })
      ).status,
    ).toBe(404);
    expect((await post(member, `/clans/${tag}/join`)).status).toBe(200);
  });

  it("an officer cannot ban an officer or the leader; a leader can ban someone who is not in the clan", async () => {
    const { leader, officer, tag } = await crew();
    const other = await player();
    expect(
      (
        await post(officer, `/clans/${tag}/ban`, {
          targetPublicId: leader.publicId,
        })
      ).status,
    ).toBe(403);
    const o2 = await player();
    await post(o2, `/clans/${tag}/join`);
    await post(leader, `/clans/${tag}/promote`, {
      targetPublicId: o2.publicId,
    });
    expect(
      (
        await post(officer, `/clans/${tag}/ban`, {
          targetPublicId: o2.publicId,
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await post(leader, `/clans/${tag}/ban`, {
          targetPublicId: other.publicId,
        })
      ).status,
    ).toBe(200);
    expect((await post(other, `/clans/${tag}/join`)).status).toBe(403);
  });

  it("refuses a malformed target or reason, and a target that does not exist", async () => {
    const { leader, tag } = await crew();
    for (const target of [
      undefined,
      "",
      5,
      null,
      "x",
      "a".repeat(40),
      { $ne: 1 },
      "../etc",
    ]) {
      expect(
        (await post(leader, `/clans/${tag}/kick`, { targetPublicId: target }))
          .status,
        JSON.stringify(target),
      ).toBe(400);
    }
    expect(
      (
        await post(leader, `/clans/${tag}/kick`, {
          targetPublicId: "Nobody000",
        })
      ).status,
    ).toBe(404);
    const victim = await player();
    expect(
      (
        await post(leader, `/clans/${tag}/ban`, {
          targetPublicId: victim.publicId,
          reason: "x".repeat(300),
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await post(leader, `/clans/${tag}/ban`, {
          targetPublicId: victim.publicId,
          reason: 5,
        })
      ).status,
    ).toBe(400);
  });

  it("the leader of another clan has no powers here", async () => {
    const { member, tag } = await crew();
    const other = await player();
    await makeClan(other);
    for (const route of [
      "kick",
      "promote",
      "demote",
      "transfer",
      "ban",
      "unban",
      "requests/approve",
    ]) {
      expect(
        (
          await post(other, `/clans/${tag}/${route}`, {
            targetPublicId: member.publicId,
          })
        ).status,
        route,
      ).toBe(403);
    }
    expect(
      (await api(other, "PATCH", `/clans/${tag}`, { description: "mine now" }))
        .status,
    ).toBe(403);
    expect((await api(other, "DELETE", `/clans/${tag}`)).status).toBe(403);
    expect(await clanOfUser(member)).toBe(tag);
  });

  it("holds the invariants through a storm of mixed actions on one clan", async () => {
    const { leader, officer, member, tag } = await crew();
    const extras = await Promise.all(Array.from({ length: 4 }, () => player()));
    await Promise.all(extras.map((u) => post(u, `/clans/${tag}/join`)));
    const actions: Array<Promise<Response>> = [];
    const everyone = [leader, officer, member, ...extras];
    for (let i = 0; i < 24; i++) {
      const actor = everyone[i % everyone.length];
      const target = everyone[(i * 3 + 1) % everyone.length];
      const route = ["kick", "promote", "demote", "transfer", "ban", "leave"][
        i % 6
      ];
      actions.push(
        post(actor, `/clans/${tag}/${route}`, {
          targetPublicId: target.publicId,
        }),
      );
    }
    const results = await Promise.all(actions);
    for (const r of results)
      expect([200, 400, 403, 404, 409]).toContain(r.status);
    await expectInvariants();
  });
});

describeDb("editing a clan", () => {
  it("lets the leader and officers change the description, Discord link and openness; PATCH answers ClanInfo", async () => {
    const { leader, officer, tag } = await crew();
    const res = await api(officer, "PATCH", `/clans/${tag}`, {
      description: "New words",
      discordUrl: "https://discord.gg/deltafront",
      isOpen: false,
    });
    expect(res.status).toBe(200);
    expect(ClanInfoSchema.parse(await body(res))).toMatchObject({
      description: "New words",
      discordUrl: "https://discord.gg/deltafront",
      isOpen: false,
    });
    const cleared = await api(leader, "PATCH", `/clans/${tag}`, {
      discordUrl: "",
    });
    expect((await body(cleared)).discordUrl).toBeNull();
  });

  it("refuses a bad Discord link with DISCORD_INVALID and changes nothing", async () => {
    const { leader, tag } = await crew();
    for (const url of [
      "https://evil.example/x",
      "http://discord.gg/abc",
      "javascript:alert(1)",
      5,
    ]) {
      const res = await api(leader, "PATCH", `/clans/${tag}`, {
        discordUrl: url,
        description: "should not stick",
      });
      expect(res.status).toBe(400);
      expect(await body(res)).toEqual({ code: "DISCORD_INVALID" });
    }
    expect(
      (await q("SELECT description FROM clans WHERE tag = $1", [tag]))[0]
        .description,
    ).not.toBe("should not stick");
  });

  it("refuses a bad description or flag", async () => {
    const { leader, tag } = await crew();
    expect(
      (
        await api(leader, "PATCH", `/clans/${tag}`, {
          description: "x".repeat(201),
        })
      ).status,
    ).toBe(400);
    expect(
      (await api(leader, "PATCH", `/clans/${tag}`, { isOpen: "no" })).status,
    ).toBe(400);
    expect((await api(leader, "PATCH", `/clans/${tag}`, "string")).status).toBe(
      400,
    );
  });

  it("lets only the leader rename: screened, unique, not a reserved imitation, and at most once every 30 days", async () => {
    const { leader, tag } = await crew();
    const taken = await player();
    await makeClan(taken, { name: "Taken Name" });
    const rename = (name: string) =>
      api(leader, "PATCH", `/clans/${tag}`, { name });
    expect((await rename("taken name")).status).toBe(409);
    expect((await rename("DeltaFront Official")).status).toBe(409);
    expect(await rename("Fuck Squad")).toMatchObject({ status: 400 });
    expect((await rename("ab")).status).toBe(400);
    const ok = await rename("Brand New Name");
    expect(ok.status).toBe(200);
    expect((await body(ok)).name).toBe("Brand New Name");
    const again = await rename("Another Name");
    expect(again.status).toBe(409);
    expect(await body(again)).toEqual({ code: "NAME_COOLDOWN" });
    // 30 days later it is allowed
    await q(
      "UPDATE clan_events SET created_at = now() - interval '31 days' WHERE action = 'rename' AND clan_id = (SELECT id FROM clans WHERE tag = $1)",
      [tag],
    );
    expect((await rename("Another Name")).status).toBe(200);
    // the tag never changes
    expect(
      (await api(leader, "PATCH", `/clans/${tag}`, { tag: "NEWTG" })).status,
    ).toBe(200);
    expect(
      (await q("SELECT tag::text FROM clans WHERE name = 'Another Name'"))[0]
        .tag,
    ).toBe(tag);
  });

  it("a rename that keeps the same name, or only changes nothing, costs no cooldown", async () => {
    const leader = await player();
    const tag = await makeClan(leader, { name: "Stay Put" });
    expect(
      (await api(leader, "PATCH", `/clans/${tag}`, { name: "Stay Put" }))
        .status,
    ).toBe(200);
    expect((await api(leader, "PATCH", `/clans/${tag}`, {})).status).toBe(200);
    expect(
      await q(
        "SELECT 1 FROM clan_events WHERE action = 'rename' AND clan_id = (SELECT id FROM clans WHERE tag = $1)",
        [tag],
      ),
    ).toEqual([]);
  });

  it("two renames to the same name at once: one wins", async () => {
    const a = await player();
    const b = await player();
    const ta = await makeClan(a);
    const tb = await makeClan(b);
    const results = await Promise.all([
      api(a, "PATCH", `/clans/${ta}`, { name: "Contested Name" }),
      api(b, "PATCH", `/clans/${tb}`, { name: "contested name" }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
  });
});

describeDb("what the clan pages show", () => {
  it("browse lists live clans, biggest first, with the page and limit echoed, and parses with the client's schema", async () => {
    const big = await crew();
    await makeClan(await player());
    const res = await get(null, "/clans?page=1&limit=5");
    const parsed = ClanBrowseResponseSchema.parse(await body(res));
    expect(parsed.page).toBe(1);
    expect(parsed.limit).toBe(5);
    expect(parsed.results.length).toBeLessThanOrEqual(5);
    expect(parsed.results[0].memberCount).toBeGreaterThanOrEqual(
      parsed.results[parsed.results.length - 1].memberCount!,
    );
    const found = ClanBrowseResponseSchema.parse(
      await body(await get(null, `/clans?search=${big.tag.toLowerCase()}`)),
    );
    expect(found.results.map((c) => c.tag)).toContain(big.tag);
    // search needs two characters and is not a wildcard
    const wild = ClanBrowseResponseSchema.parse(
      await body(await get(null, "/clans?search=%25%25")),
    );
    expect(wild.total).toBe(0);
  });

  it("clamps the page size and survives hostile paging", async () => {
    for (const query of [
      "limit=100000",
      "page=-5",
      "page=abc&limit=xyz",
      "page=999999999",
      "limit=0",
      "search=a",
    ]) {
      const res = await get(null, `/clans?${query}`);
      expect(res.status, query).toBe(200);
      const parsed = ClanBrowseResponseSchema.parse(await body(res));
      expect(parsed.limit).toBeLessThanOrEqual(CLAN_RULES.maxPageSize);
    }
  });

  it("a disbanded clan is not listed", async () => {
    const owner = await player();
    const tag = await makeClan(owner, { name: "Vanishing Clan" });
    await api(owner, "DELETE", `/clans/${tag}`);
    const found = ClanBrowseResponseSchema.parse(
      await body(await get(null, "/clans?search=vanishing")),
    );
    expect(found.results).toEqual([]);
  });

  it("the clan page parses and carries only public information: no ids, emails or provider data", async () => {
    const { leader, tag } = await crew();
    const res = await get(null, `/clans/${tag}`);
    const raw = await body(res);
    expect(ClanInfoSchema.parse(raw)).toMatchObject({ tag, memberCount: 3 });
    expect(Object.keys(raw).sort()).toEqual([
      "createdAt",
      "description",
      "discordUrl",
      "isOpen",
      "memberCount",
      "name",
      "tag",
    ]);
    const members = await body(await get(leader, `/clans/${tag}/members`));
    const text = JSON.stringify(members);
    expect(text).not.toMatch(
      /email|provider|discord_?id|"id"|user_?id|uuid|jwt|token/i,
    );
    expect(text).not.toContain(leader.id);
    for (const m of members.results)
      expect(Object.keys(m).sort()).toEqual([
        "joinedAt",
        "publicId",
        "role",
        "stats",
        "username",
        "verified",
      ]);
  });

  it("lists the members, leader first, to members only; pendingRequests only for officers and the leader", async () => {
    const { leader, officer, member, tag } = await crew();
    const asLeader = ClanMembersResponseSchema.parse(
      await body(await get(leader, `/clans/${tag}/members`)),
    );
    expect(asLeader.total).toBe(3);
    expect(asLeader.results.map((m) => m.role)).toEqual([
      "leader",
      "officer",
      "member",
    ]);
    expect(asLeader.results.map((m) => m.publicId)).toEqual([
      leader.publicId,
      officer.publicId,
      member.publicId,
    ]);
    expect(asLeader.pendingRequests).toBe(0);
    const asMember = ClanMembersResponseSchema.parse(
      await body(await get(member, `/clans/${tag}/members`)),
    );
    expect(asMember.pendingRequests).toBeUndefined();
    const outsider = await player();
    expect((await get(outsider, `/clans/${tag}/members`)).status).toBe(403);
    expect((await get(null, `/clans/${tag}/members`)).status).toBe(401);
    expect(
      (await get(await makeUser(h, "guest"), `/clans/${tag}/members`)).status,
    ).toBe(403);
  });

  it("sorts and searches members, and rejects an unknown sort", async () => {
    const { leader, officer, member, tag } = await crew();
    // member has 5 wins, officer 2 wins and 3 losses
    const ids = (
      await q(
        `INSERT INTO games (game_code, source, type, mode, started_at, ended_at, duration_s, human_players, counts_for_stats)
         SELECT 'srt' || k, 'server', 'Public', 'Free For All', now() - interval '1 hour', now(), 600, 2, true
           FROM generate_series(1, 5) k RETURNING id`,
      )
    ).map((r) => r.id as string);
    for (const [i, id] of ids.entries()) {
      await q(
        `INSERT INTO game_players (game_id, client_id, user_id, username, result, completed)
         VALUES ($1, 'm', $2, 'm', 'victory', true), ($1, 'o', $3, 'o', $4, true)`,
        [id, member.id, officer.id, i < 2 ? "victory" : "defeat"],
      );
    }
    const sorted = ClanMembersResponseSchema.parse(
      await body(
        await get(leader, `/clans/${tag}/members?sort=winsTotal&order=desc`),
      ),
    );
    expect(sorted.results[0].publicId).toBe(member.publicId);
    // every player() also has 10 seeded wins in games with no mode
    expect(sorted.results[0].stats?.total).toEqual({ wins: 15, losses: 0 });
    expect(sorted.results[0].stats?.ffa).toEqual({ wins: 5, losses: 0 });
    const officerRow = sorted.results.find(
      (m) => m.publicId === officer.publicId,
    )!;
    expect(officerRow.stats?.total).toEqual({ wins: 12, losses: 3 });
    const asc = ClanMembersResponseSchema.parse(
      await body(
        await get(leader, `/clans/${tag}/members?sort=lossesTotal&order=asc`),
      ),
    );
    expect(asc.results[asc.results.length - 1].publicId).toBe(officer.publicId);
    const found = ClanMembersResponseSchema.parse(
      await body(
        await get(
          leader,
          `/clans/${tag}/members?search=${officer.publicId.slice(0, 8).toLowerCase()}`,
        ),
      ),
    );
    expect(found.results.map((m) => m.publicId)).toEqual([officer.publicId]);
    for (const query of [
      "sort=DROP",
      "sort=winsTotal&order=sideways",
      `search=${"x".repeat(80)}`,
    ]) {
      expect(
        (await get(leader, `/clans/${tag}/members?${query}`)).status,
        query,
      ).toBe(400);
    }
  });

  it("only officers and the leader see the requests and the bans", async () => {
    const { leader, officer, member, tag } = await crew({ isOpen: false });
    const asker = await player();
    await post(asker, `/clans/${tag}/join`);
    for (const u of [leader, officer]) {
      const reqs = ClanRequestsResponseSchema.parse(
        await body(await get(u, `/clans/${tag}/requests`)),
      );
      expect(reqs.results.map((r) => r.publicId)).toEqual([asker.publicId]);
      expect((await get(u, `/clans/${tag}/bans`)).status).toBe(200);
    }
    expect((await get(member, `/clans/${tag}/requests`)).status).toBe(403);
    expect((await get(asker, `/clans/${tag}/requests`)).status).toBe(403);
    const members = ClanMembersResponseSchema.parse(
      await body(await get(leader, `/clans/${tag}/members`)),
    );
    expect(members.pendingRequests).toBe(1);
  });

  it("/users/@me lists the clan and the requests in the shape the client parses; a public profile shows the clan", async () => {
    const { member, tag } = await crew();
    const me = await meOf(member);
    expect(me.player.clans).toEqual([
      expect.objectContaining({ tag, role: "member", memberCount: 3 }),
    ]);
    const profile = await get(null, `/public/player/${member.publicId}`);
    const parsed = PlayerProfileSchema.parse(await body(profile));
    expect(parsed.clans).toEqual([
      expect.objectContaining({ tag, role: "member" }),
    ]);
    expect(JSON.stringify(parsed)).not.toContain(member.id);
  });

  it("answers the public existence probe for live, held and reserved tags, and nothing else", async () => {
    const owner = await player();
    const tag = await makeClan(owner, { tag: "EXS" });
    expect((await get(null, "/public/clan/exs/exists")).status).toBe(200);
    expect((await get(null, "/public/clan/ADMIN/exists")).status).toBe(200); // reserved
    expect((await get(null, "/public/clan/NOPEZ/exists")).status).toBe(404);
    expect((await get(null, "/public/clan/%2e%2e/exists")).status).toBe(404);
    await api(owner, "DELETE", `/clans/${tag}`);
    expect((await get(null, "/public/clan/EXS/exists")).status).toBe(200); // still held
    await q(
      "UPDATE clan_tag_holds SET reusable_after = now() - interval '1 day' WHERE tag = 'EXS'",
    );
    expect((await get(null, "/public/clan/EXS/exists")).status).toBe(404);
  });

  it("serves the game history to members only, newest first, with the clan's players and result", async () => {
    const { leader, member, tag } = await crew();
    const outsider = await player();
    // a game in which the leader and a stranger played, the leader under the clan tag
    const clanId = (await q("SELECT id FROM clans WHERE tag = $1", [tag]))[0]
      .id;
    const g = (
      await q(
        `INSERT INTO games (game_code, source, type, mode, started_at, ended_at, duration_s, human_players, counts_for_stats)
       VALUES ('hist0001', 'server', 'Public', 'Free For All', now() - interval '20 minutes', now(), 600, 2, true) RETURNING id`,
      )
    )[0].id;
    await q(
      `INSERT INTO game_players (game_id, client_id, user_id, username, clan_tag, clan_id, result, completed) VALUES
         ($1, 'a', $2, 'LeaderInGame', $4, $5, 'victory', true), ($1, 'b', $3, 'Stranger', NULL, NULL, 'defeat', true)`,
      [g, leader.id, outsider.id, tag, clanId],
    );
    const res = await get(member, `/clans/${tag}/games`);
    const games = ClanGamesResponseSchema.parse(await body(res));
    expect(games.results).toHaveLength(1);
    expect(games.results[0]).toMatchObject({
      gameId: "hist0001",
      result: "victory",
    });
    expect(games.results[0].clanPlayers).toEqual([
      { publicId: leader.publicId, username: "LeaderInGame", won: true },
    ]);
    expect(games.nextCursor).toBeNull();
    expect((await get(outsider, `/clans/${tag}/games`)).status).toBe(403);
    expect((await get(member, `/clans/${tag}/games?filter=nope`)).status).toBe(
      400,
    );
    expect((await get(member, `/clans/${tag}/games?cursor=!!`)).status).toBe(
      400,
    );
    expect((await get(member, `/clans/${tag}/games?filter=team`)).status).toBe(
      200,
    );
  });

  it("every clan endpoint parses with the client's schemas, and unknown clans are 404", async () => {
    expect((await get(null, "/clans/NOPE1")).status).toBe(404);
    const u = await player();
    expect((await get(u, "/clans/NOPE1/members")).status).toBe(404);
    expect((await get(u, "/clans/NOPE1/requests")).status).toBe(404);
  });
});

describeDb("the reserved tag list the game server reads", () => {
  const serverTags = async () => {
    const res = await call(h, "/reserved_clan_tags", {
      origin: null,
      headers: { "x-api-key": serverKey },
    });
    expect(res.status).toBe(200);
    return ReservedClanTagsResponseSchema.parse(await res.json());
  };

  it("needs a registered server key", async () => {
    expect(
      (await call(h, "/reserved_clan_tags", { origin: null })).status,
    ).toBe(401);
    expect(
      (
        await call(h, "/reserved_clan_tags", {
          origin: null,
          headers: { "x-api-key": "not-a-real-key-0123456789" },
        })
      ).status,
    ).toBe(401);
  });

  it("is the reserved list plus every live clan's tag plus every held tag, sorted, upper case, no duplicates", async () => {
    const owner = await player();
    await makeClan(owner, { tag: "RS1" });
    const gone = await player();
    const goneTag = await makeClan(gone, { tag: "RS2" });
    await api(gone, "DELETE", `/clans/${goneTag}`);
    const tags = await serverTags();
    for (const reserved of ["ADMIN", "MOD", "DEV", "STAFF", "DF", "DELTA"])
      expect(tags).toContain(reserved);
    expect(tags).toContain("RS1"); // active
    expect(tags).toContain("RS2"); // held
    expect(tags).toEqual([...tags].sort());
    expect(new Set(tags).size).toBe(tags.length);
    expect(
      tags.every((t) => t === t.toUpperCase() && /^[A-Z0-9]{2,5}$/.test(t)),
    ).toBe(true);
    // once the hold is over a disbanded tag is free again
    await q(
      "UPDATE clan_tag_holds SET reusable_after = now() - interval '1 second' WHERE tag = 'RS2'",
    );
    expect(await serverTags()).not.toContain("RS2");
  });

  it("answers whether one tag is registered right now, for the server key only", async () => {
    const owner = await player();
    await makeClan(owner, { tag: "ONE" });
    const ask = (tag: string, key: string | null = serverKey) =>
      call(h, `/reserved_clan_tags/${tag}`, {
        origin: null,
        headers: key === null ? {} : { "x-api-key": key },
      });
    expect(await (await ask("ONE")).json()).toEqual({ registered: true });
    expect(await (await ask("one")).json()).toEqual({ registered: true });
    expect(await (await ask("ADMIN")).json()).toEqual({ registered: true });
    expect(await (await ask("NOPEZ")).json()).toEqual({ registered: false });
    expect(await (await ask("a%2eb")).json()).toEqual({ registered: false });
    expect((await ask("ONE", null)).status).toBe(401);
    expect((await ask("ONE", "wrong-key-0123456789")).status).toBe(401);
  });

  it("is served even when clans are off, with the reserved list alone", async () => {
    const off = await startHarness({ features: "accounts,inventory" });
    try {
      const key = await createServerKey(off);
      const res = await call(off, "/reserved_clan_tags", {
        origin: null,
        headers: { "x-api-key": key },
      });
      const tags = ReservedClanTagsResponseSchema.parse(await res.json());
      expect(tags).toContain("ADMIN");
      expect(tags).not.toContain("RS1");
      // and none of the clan routes exist
      expect((await call(off, "/clans", { origin: null })).status).toBe(404);
      expect(
        (await call(off, "/public/clans/leaderboard", { origin: null })).status,
      ).toBe(404);
      expect(
        (await call(off, "/public/clan/ABC/exists", { origin: null })).status,
      ).toBe(404);
    } finally {
      await off.close();
    }
  });

  it("the account API and the game server read the same list: /users/@me clans is what the server's tag check keeps", async () => {
    const { member, tag } = await crew();
    const me = await meOf(member);
    expect((me.player.clans ?? []).map((c) => c.tag)).toEqual([tag]);
    expect(await serverTags()).toContain(tag);
  });
});

describeDb("clan stats and the clan leaderboard", () => {
  /** A finished counted game: the given accounts play, wearing the given tags. */
  async function playGame(
    players: Array<{ user: TestUser; tag?: string | null; wins?: boolean }>,
    endMs = Date.now() - 3_600_000,
  ) {
    const winner = players.find((p) => p.wins)?.user;
    const record = buildRecord(
      `g${(++games).toString(36).padStart(7, "0")}`.slice(0, 8),
      {
        players: players.map((p) => ({ user: p.user })),
        winner:
          winner === undefined
            ? null
            : [
                "player",
                `pl00000${players.findIndex((p) => p.user === winner) + 1}`,
              ],
        endMs,
      },
    );
    record.info.players.forEach((p, i) => {
      p.clanTag = players[i].tag ?? null;
    });
    const res = await submitGame(h, serverKey, record);
    expect(res.status).toBe(200);
  }

  it("ties a game to a clan only for a member wearing that clan's tag (not for an imposter, or a member wearing no tag)", async () => {
    const { leader, member, tag } = await crew();
    const imposter = await player();
    const other = await player();
    const otherTag = await makeClan(other);
    await playGame([
      { user: leader, tag, wins: true },
      { user: imposter, tag },
      { user: member, tag: null },
      { user: other, tag: otherTag.toLowerCase() },
    ]);
    const rows = await q(
      `SELECT u.public_id, p.clan_tag, c.tag::text AS clan FROM game_players p
         JOIN users u ON u.id = p.user_id LEFT JOIN clans c ON c.id = p.clan_id
        WHERE p.game_id = (SELECT max(id) FROM games) ORDER BY p.client_id`,
    );
    const byUser = new Map(rows.map((r) => [r.public_id, r.clan]));
    expect(byUser.get(leader.publicId)).toBe(tag);
    expect(byUser.get(imposter.publicId)).toBeNull();
    expect(byUser.get(member.publicId)).toBeNull();
    expect(byUser.get(other.publicId)).toBe(otherTag); // case does not matter
  });

  it("the leaderboard counts a clan's games, wins, losses and player sessions from stored games, and parses with the client's schema", async () => {
    const { leader, officer, member, tag } = await crew();
    const rival = await player();
    await playGame([
      { user: leader, tag, wins: true },
      { user: officer, tag },
      { user: rival },
    ]); // clan wins with 1 winner, 1 loser
    await playGame([
      { user: member, tag },
      { user: rival, wins: true },
    ]); // clan loses
    const res = await get(null, "/public/clans/leaderboard");
    expect(res.status).toBe(200);
    const board = ClanLeaderboardResponseSchema.parse(await body(res));
    const mine = board.clans.find((c) => c.clanTag === tag)!;
    expect(mine).toMatchObject({
      games: 2,
      wins: 1,
      losses: 1,
      playerSessions: 3,
      weightedWins: 1,
      weightedLosses: 2,
    });
    expect(mine.weightedWLRatio).toBeCloseTo(0.5);
    expect(
      new Date(board.end).getTime() - new Date(board.start).getTime(),
    ).toBe(CLAN_RULES.leaderboardDays * DAY);
    // ordered best ratio first
    const ratios = board.clans.map((c) => c.weightedWLRatio);
    expect(ratios).toEqual([...ratios].sort((a, b) => b - a));
  });

  it("leaves out games older than the window, private games and a disbanded clan; a clan with no games is not listed", async () => {
    const { leader, tag } = await crew();
    const rival = await player();
    await playGame(
      [{ user: leader, tag, wins: true }, { user: rival }],
      Date.now() - (CLAN_RULES.leaderboardDays + 5) * DAY,
    );
    const none = ClanLeaderboardResponseSchema.parse(
      await body(await get(null, "/public/clans/leaderboard")),
    );
    expect(none.clans.find((c) => c.clanTag === tag)).toBeUndefined();
    await playGame([{ user: leader, tag, wins: true }, { user: rival }]);
    expect(
      ClanLeaderboardResponseSchema.parse(
        await body(await get(null, "/public/clans/leaderboard")),
      ).clans.find((c) => c.clanTag === tag),
    ).toBeDefined();
    await q(
      "UPDATE games SET type = 'Private', counts_for_stats = false WHERE id = (SELECT max(id) FROM games)",
    );
    expect(
      ClanLeaderboardResponseSchema.parse(
        await body(await get(null, "/public/clans/leaderboard")),
      ).clans.find((c) => c.clanTag === tag),
    ).toBeUndefined();
    await q(
      "UPDATE games SET type = 'Public', counts_for_stats = true WHERE id = (SELECT max(id) FROM games)",
    );
    await api(leader, "DELETE", `/clans/${tag}`).catch(() => undefined);
  });

  it("is public, cached briefly, and takes no input that reaches the database", async () => {
    const res = await get(
      null,
      "/public/clans/leaderboard?limit=1&clan=x'; DROP TABLE clans; --",
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("public, max-age=60");
    expect(await q("SELECT 1 FROM clans LIMIT 1")).not.toHaveLength(0);
  });

  it("a browser cannot submit a clan result: only a game server's record counts", async () => {
    const { leader, tag } = await crew();
    const record = buildRecord("forged01", {
      players: [{ user: leader }, { user: await player() }],
    });
    record.info.players[0].clanTag = tag;
    expect((await submitGame(h, undefined, record)).status).toBe(401);
    expect(
      (
        await call(h, "/game/forged01", {
          method: "POST",
          json: record,
          bearer: leader.jwt,
        })
      ).status,
    ).toBeGreaterThanOrEqual(400);
  });
});

describeDb("account deletion, bans and the clan", () => {
  async function deleteAccount(u: TestUser) {
    await q(
      "UPDATE users SET deletion_requested_at = now() - interval '2 days' WHERE id = $1",
      [u.id],
    );
    expect(await runDeletions(h.db.pool)).toBeGreaterThanOrEqual(1);
  }

  it("hands a deleted leader's clan to the oldest officer, then the oldest member, and disbands it when nobody is left", async () => {
    const { leader, officer, member, tag } = await crew();
    await deleteAccount(leader);
    expect(await roleOf(officer)).toBe("leader");
    expect(await roleOf(member)).toBe("member");
    expect(await clanOfUser(leader)).toBeNull();
    await expectInvariants();
    await deleteAccount(officer);
    expect(await roleOf(member)).toBe("leader");
    await expectInvariants();
    await deleteAccount(member);
    expect(
      await q(
        "SELECT disbanded_at IS NOT NULL AS gone FROM clans WHERE tag = $1",
        [tag],
      ),
    ).toEqual([{ gone: true }]);
    expect(
      await q("SELECT 1 FROM clan_tag_holds WHERE tag = $1", [tag]),
    ).toHaveLength(1);
    await expectInvariants();
  });

  it("prefers an officer over an older plain member", async () => {
    const leader = await player();
    const tag = await makeClan(leader);
    const oldMember = await player();
    const youngOfficer = await player();
    await post(oldMember, `/clans/${tag}/join`);
    await post(youngOfficer, `/clans/${tag}/join`);
    await post(leader, `/clans/${tag}/promote`, {
      targetPublicId: youngOfficer.publicId,
    });
    await q(
      "UPDATE clan_members SET joined_at = now() - interval '30 days' WHERE user_id = $1",
      [oldMember.id],
    );
    await deleteAccount(leader);
    expect(await roleOf(youngOfficer)).toBe("leader");
  });

  it("removes a deleted member, their requests and the bans naming them", async () => {
    const { leader, member, tag } = await crew({ isOpen: false });
    const asker = await player();
    const closed = await makeClan(await player(), { isOpen: false });
    await post(asker, `/clans/${closed}/join`);
    await post(leader, `/clans/${tag}/ban`, { targetPublicId: asker.publicId });
    await deleteAccount(member);
    await deleteAccount(asker);
    expect(
      await q("SELECT 1 FROM clan_members WHERE user_id = $1", [member.id]),
    ).toEqual([]);
    expect(
      await q("SELECT 1 FROM clan_join_requests WHERE user_id = $1", [
        asker.id,
      ]),
    ).toEqual([]);
    expect(
      await q("SELECT 1 FROM clan_bans WHERE user_id = $1", [asker.id]),
    ).toEqual([]);
    const members = ClanMembersResponseSchema.parse(
      await body(await get(leader, `/clans/${tag}/members`)),
    );
    expect(members.results.map((m) => m.publicId)).not.toContain(
      member.publicId,
    );
    expect((await get(null, `/public/player/${member.publicId}`)).status).toBe(
      404,
    );
  });

  it("a deletion that is only queued: the account cannot act, and cannot be approved into a clan", async () => {
    const leader = await player();
    const tag = await makeClan(leader, { isOpen: false });
    const u = await player();
    await post(u, `/clans/${tag}/join`);
    await q("UPDATE users SET deletion_requested_at = now() WHERE id = $1", [
      u.id,
    ]);
    expect((await post(u, `/clans/${tag}/join`)).status).toBe(401);
    const res = await post(leader, `/clans/${tag}/requests/approve`, {
      targetPublicId: u.publicId,
    });
    expect(res.status).toBe(409);
    expect((await body(res)).code).toBe("ACCOUNT_UNAVAILABLE");
    expect(
      await q("SELECT 1 FROM clan_join_requests WHERE user_id = $1", [u.id]),
    ).toEqual([]);
    expect(await clanOfUser(u)).toBeNull();
  });

  it("deleting accounts while clan actions run never leaves an ownerless clan", async () => {
    for (let round = 0; round < 4; round++) {
      const { leader, officer, tag } = await crew();
      await q(
        "UPDATE users SET deletion_requested_at = now() - interval '2 days' WHERE id = $1",
        [leader.id],
      );
      await Promise.all([
        runDeletions(h.db.pool),
        post(officer, `/clans/${tag}/kick`, {
          targetPublicId: leader.publicId,
        }),
        post(leader, `/clans/${tag}/transfer`, {
          targetPublicId: officer.publicId,
        }),
      ]);
      await expectInvariants();
    }
  });

  it("a banned (site) leader keeps the clan but cannot act: every write is 403 BANNED until an admin steps in", async () => {
    const { leader, officer, member, tag } = await crew();
    await q(
      "INSERT INTO bans (user_id, category, reason) VALUES ($1, 'test', 'x')",
      [leader.id],
    );
    for (const [route, who] of [
      ["kick", member],
      ["promote", member],
      ["transfer", officer],
    ] as const) {
      const res = await post(leader, `/clans/${tag}/${route}`, {
        targetPublicId: who.publicId,
      });
      expect([res.status, (await body(res)).code], route).toEqual([
        403,
        "BANNED",
      ]);
    }
    expect(
      (await api(leader, "PATCH", `/clans/${tag}`, { description: "x" }))
        .status,
    ).toBe(403);
    expect((await api(leader, "DELETE", `/clans/${tag}`)).status).toBe(403);
    expect(await roleOf(leader)).toBe("leader");
    // the admin hands the clan over
    const r = await run([
      "clan:transfer",
      tag,
      officer.publicId,
      "--reason",
      "leader banned",
      "--yes",
    ]);
    expect(r.code, r.err).toBe(0);
    expect(await roleOf(officer)).toBe("leader");
    await expectInvariants();
  });

  it("a banned member cannot join or request; being banned does not erase membership but blocks writes", async () => {
    const { member, tag } = await crew();
    await q("INSERT INTO bans (user_id, category) VALUES ($1, 'test')", [
      member.id,
    ]);
    expect((await post(member, `/clans/${tag}/leave`)).status).toBe(403);
    expect(await clanOfUser(member)).toBe(tag);
  });
});

describeDb(
  "admin: clan:list, clan:show, clan:rename, clan:transfer, clan:member-remove, clan:remove",
  () => {
    const audit = (action: string, tag: string) =>
      q(
        "SELECT actor, details FROM admin_audit_log WHERE action = $1 AND target_id = $2 ORDER BY id",
        [action, tag],
      );

    it("lists and shows clans, with members, requests, bans and recent events", async () => {
      const { leader, officer, member, tag } = await crew({ isOpen: false });
      const listed = await run(["clan:list", tag.toLowerCase()]);
      expect(listed.code).toBe(0);
      expect(listed.out).toContain(tag);
      expect((await run(["clan:list", "zzzzzzzz-nothing"])).out).toBe(
        "no matching clans",
      );
      const shown = await run(["clan:show", tag]);
      expect(shown.code, shown.err).toBe(0);
      expect(shown.out).toContain(leader.publicId);
      expect(shown.out).toMatch(new RegExp(`${officer.publicId}\\s+officer`));
      expect(shown.out).toMatch(new RegExp(`${member.publicId}\\s+member`));
      expect(shown.out).toContain("recent events");
      expect(shown.out).not.toContain(leader.id); // internal ids stay internal
      expect((await run(["clan:show", "NOPE1"])).code).toBe(2);
      expect((await run(["clan:show", "../x"])).code).toBe(2);
      // user:show lists the clan
      expect((await run(["user:show", member.publicId])).out).toMatch(
        new RegExp(`clans:\\s+${tag} \\(member\\)`),
      );
    });

    it("renames, audited with the reason, screened and without the cooldown", async () => {
      const { leader, tag } = await crew();
      await api(leader, "PATCH", `/clans/${tag}`, { name: "First Rename" }); // starts the player cooldown
      const r = await run([
        "clan:rename",
        tag,
        "Renamed By Owner",
        "--reason",
        "owner asked",
      ]);
      expect(r.code, r.err).toBe(0);
      expect(
        (await q("SELECT name::text FROM clans WHERE tag = $1", [tag]))[0].name,
      ).toBe("Renamed By Owner");
      const rows = await audit("clan:rename", tag);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        actor: "tester",
        details: { reason: "owner asked", name: "Renamed By Owner" },
      });
      expect(
        (await run(["clan:rename", tag, "DeltaFront Team", "--reason", "x"]))
          .code,
      ).toBe(2);
      expect(
        (await run(["clan:rename", tag, "ab", "--reason", "x"])).code,
      ).toBe(2);
      expect((await run(["clan:rename", tag, "Needs Reason"])).err).toMatch(
        /--reason/,
      );
    });

    it("transfers leadership with --yes and a reason, audited, and refuses non-members and the current leader", async () => {
      const { leader, officer, member, tag } = await crew();
      expect(
        (await run(["clan:transfer", tag, member.publicId, "--reason", "r"]))
          .err,
      ).toMatch(/--yes/);
      expect(await roleOf(leader)).toBe("leader");
      const r = await run([
        "clan:transfer",
        tag,
        member.publicId,
        "--reason",
        "leader inactive",
        "--yes",
      ]);
      expect(r.code, r.err).toBe(0);
      expect(await roleOf(member)).toBe("leader");
      expect(await roleOf(leader)).toBe("officer");
      expect(
        (
          await run([
            "clan:transfer",
            tag,
            member.publicId,
            "--reason",
            "r",
            "--yes",
          ])
        ).err,
      ).toContain("ALREADY_LEADER");
      const outsider = await player();
      expect(
        (
          await run([
            "clan:transfer",
            tag,
            outsider.publicId,
            "--reason",
            "r",
            "--yes",
          ])
        ).err,
      ).toContain("TARGET_NOT_A_MEMBER");
      expect(await audit("clan:transfer", tag)).toHaveLength(1);
      expect(await roleOf(officer)).toBe("officer");
      await expectInvariants();
    });

    it("removes a member with --yes and a reason, audited; a leader must be transferred or the clan removed", async () => {
      const { leader, member, tag } = await crew();
      expect(
        (
          await run([
            "clan:member-remove",
            tag,
            member.publicId,
            "--reason",
            "r",
          ])
        ).code,
      ).toBe(2);
      expect(await clanOfUser(member)).toBe(tag);
      expect(
        (
          await run([
            "clan:member-remove",
            tag,
            member.publicId,
            "--reason",
            "spam",
            "--yes",
          ])
        ).code,
      ).toBe(0);
      expect(await clanOfUser(member)).toBeNull();
      const refused = await run([
        "clan:member-remove",
        tag,
        leader.publicId,
        "--reason",
        "r",
        "--yes",
      ]);
      expect(refused.code).toBe(2);
      expect(refused.err).toContain("TRANSFER_REQUIRED");
      expect(await roleOf(leader)).toBe("leader");
      const rows = await audit("clan:member-remove", tag);
      expect(rows).toHaveLength(1);
      expect(rows[0].details).toMatchObject({
        reason: "spam",
        target: member.publicId,
      });
    });

    it("removes a clan for cause with --yes: members out, tag held, marked removed by admin, audited", async () => {
      const { leader, officer, member, tag } = await crew();
      expect(
        (await run(["clan:remove", tag, "--reason", "offensive name"])).code,
      ).toBe(2);
      expect(await clanOfUser(leader)).toBe(tag);
      const r = await run([
        "clan:remove",
        tag,
        "--reason",
        "offensive name",
        "--yes",
      ]);
      expect(r.code, r.err).toBe(0);
      expect(r.out).toContain("its tag is held");
      for (const u of [leader, officer, member])
        expect(await clanOfUser(u)).toBeNull();
      expect(
        await q(
          "SELECT removed_by_admin, disbanded_at IS NOT NULL AS gone FROM clans WHERE tag = $1",
          [tag],
        ),
      ).toEqual([{ removed_by_admin: true, gone: true }]);
      expect(
        await q("SELECT 1 FROM clan_tag_holds WHERE tag = $1", [tag]),
      ).toHaveLength(1);
      const rows = await audit("clan:remove", tag);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        actor: "tester",
        details: { reason: "offensive name", members: 3 },
      });
      expect(
        (await post(await player(), "/clans", { name: "Reuse Attempt", tag }))
          .status,
      ).toBe(409);
      expect(
        (await run(["clan:remove", tag, "--reason", "again", "--yes"])).code,
      ).toBe(2);
    });

    it("changes nothing and writes no audit row when a command is refused", async () => {
      const { tag } = await crew();
      const before = (
        await q("SELECT count(*)::int AS n FROM admin_audit_log")
      )[0].n;
      await run(["clan:rename", tag, "x", "--reason", "r"]);
      await run(["clan:transfer", tag, "Nobody000", "--reason", "r", "--yes"]);
      await run([
        "clan:member-remove",
        tag,
        "Nobody000",
        "--reason",
        "r",
        "--yes",
      ]);
      await run(["clan:remove", "ZZZZZ", "--reason", "r", "--yes"]);
      expect(
        (await q("SELECT count(*)::int AS n FROM admin_audit_log"))[0].n,
      ).toBe(before);
    });

    it("is listed in the help", async () => {
      const r = await run(["help"]);
      for (const c of [
        "clan:list",
        "clan:show",
        "clan:rename",
        "clan:transfer",
        "clan:member-remove",
        "clan:remove",
      ]) {
        expect(r.out).toContain(c);
      }
    });
  },
);

describeDb("only the backend changes clans", () => {
  const walk = (dir: string, out: string[] = []): string[] => {
    for (const e of fs.readdirSync(path.join(ROOT, dir), {
      withFileTypes: true,
    })) {
      const rel = `${dir}/${e.name}`;
      if (e.isDirectory()) walk(rel, out);
      else if (rel.endsWith(".ts")) out.push(rel);
    }
    return out;
  };
  const text = (f: string) => fs.readFileSync(path.join(ROOT, f), "utf8");

  it("only domain/clanOps.ts writes the clan tables, and no route does", () => {
    const sources = walk("src/account-api");
    const writers = (table: string) =>
      sources.filter((f) =>
        new RegExp(
          `(INSERT\\s+INTO|UPDATE|DELETE\\s+FROM)\\s+${table}\\b`,
          "i",
        ).test(text(f)),
      );
    for (const table of [
      "clans",
      "clan_members",
      "clan_join_requests",
      "clan_bans",
      "clan_tag_holds",
      "clan_events",
    ]) {
      expect(writers(table), table).toEqual([
        "src/account-api/domain/clanOps.ts",
      ]);
    }
    for (const f of sources.filter((x) =>
      x.startsWith("src/account-api/routes/"),
    )) {
      expect(text(f), f).not.toMatch(
        /(INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+clan/i,
      );
    }
  });

  it("the clan routes read a role from nowhere in the request: only the tag in the path and targetPublicId", () => {
    const source = text("src/account-api/routes/clans.ts");
    expect(source).not.toMatch(
      /req\.body\??\.role|body\.role|query\.role|headers\[["']x-clan/i,
    );
    expect(source).not.toMatch(/\.role\b/);
  });

  it("limits clan writes per account: the 4th write in the window is 429 RATE_LIMITED, with Retry-After; reads are not limited", async () => {
    const limited = await startHarness({
      features: "accounts,clans",
      limits: { clanWrite: { max: 3, windowMs: 60_000 } },
    });
    try {
      const u = await makeUser(limited, "registered");
      const statuses: number[] = [];
      for (let i = 0; i < 5; i++) {
        const r = await call(limited, "/clans/NOPE1/join", {
          method: "POST",
          bearer: u.jwt,
          origin: null,
        });
        statuses.push(r.status);
        if (r.status === 429)
          expect(r.headers.get("retry-after")).toMatch(/^\d+$/);
      }
      expect(statuses).toEqual([404, 404, 404, 429, 429]);
      expect(
        (await call(limited, "/clans", { origin: null, bearer: u.jwt })).status,
      ).toBe(200);
    } finally {
      await limited.close();
    }
  });

  it("the clan API does not exist without the clans feature or without accounts", async () => {
    for (const features of ["accounts", "clans"]) {
      const off = await startHarness({ features });
      try {
        const u = await makeUser(off, "registered");
        for (const route of [
          "/clans",
          "/clans/ABC",
          "/public/clans/leaderboard",
        ]) {
          expect(
            (await call(off, route, { origin: null, bearer: u.jwt })).status,
            `${features} ${route}`,
          ).toBe(404);
        }
        if (features === "accounts") {
          const me = await call(off, "/users/@me", {
            origin: null,
            bearer: u.jwt,
          });
          expect((await me.json()).player.clans).toBeUndefined();
        }
      } finally {
        await off.close();
      }
    }
  });
});
