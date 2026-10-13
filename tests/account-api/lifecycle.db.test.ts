// @vitest-environment node
import { afterEach, expect, it } from "vitest";
import { ACCOUNT_RULES } from "../../src/account-api/domain/constants";
import {
  runDeletions,
  runMaintenance,
  runRetention,
} from "../../src/account-api/domain/lifecycle";
import { silentLogger } from "../../src/account-api/logger";
import { buildRecord, makeUser, submitGame } from "./util/games";
import {
  call,
  createServerKey,
  startHarness,
  type Harness,
} from "./util/harness";
import { describeDb } from "./util/testDb";

const harnesses: Harness[] = [];
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.close().catch(() => undefined);
});
async function setup() {
  const h = await startHarness();
  harnesses.push(h);
  const key = await createServerKey(h);
  const a = await makeUser(h);
  const b = await makeUser(h);
  return { h, key, a, b };
}
const q = async (h: Harness, sql: string, params: unknown[] = []) =>
  (await h.db.pool.query(sql, params)).rows;
const HOUR = 3_600_000;

async function play(
  h: Harness,
  key: string,
  code: string,
  a: Awaited<ReturnType<typeof makeUser>>,
  b: Awaited<ReturnType<typeof makeUser>>,
) {
  const res = await submitGame(
    h,
    key,
    buildRecord(code, {
      players: [
        { user: a, username: "RealNameAlice" },
        { user: b, username: "Bob" },
      ],
    }),
  );
  expect(res.status).toBe(200);
}

describeDb("account deletion and data lifecycle", () => {
  it("erases what identifies the account, keeps what other players' history needs, and anonymises it", async () => {
    const { h, key, a, b } = await setup();
    await play(h, key, "gameAAAA01", a, b);
    await h.db.pool.query(
      `INSERT INTO auth_identities (user_id, provider, provider_user_id, email, profile) VALUES ($1, 'discord', 'd-erase', 'erase@example.com', '{"username":"alice"}')`,
      [a.id],
    );
    await h.db.pool.query(
      "UPDATE users SET username_base = 'Alice', username_discriminator = '1234' WHERE id = $1",
      [a.id],
    );
    await h.db.pool.query(
      "UPDATE game_players SET clan_tag = 'TAG' WHERE user_id = $1",
      [a.id],
    );
    expect(
      (await call(h, "/users/@me", { method: "DELETE", jar: a.jar })).status,
    ).toBe(204);
    const later = new Date(Date.now() + 25 * HOUR);
    expect(await runDeletions(h.db.pool, later)).toBe(1);

    // gone
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
    const [user] = await q(h, "SELECT * FROM users WHERE id = $1", [a.id]);
    expect(user.username_base).toBeNull();
    expect(user.username_discriminator).toBeNull();
    expect(user.role).toBeNull();
    expect(user.deleted_at).not.toBeNull();
    // no personal text anywhere in the tombstone row
    expect(JSON.stringify(user)).not.toMatch(
      /Alice|erase@example\.com|d-erase/,
    );

    // kept for the other player's history, but no longer about this person
    const rows = await q(
      h,
      "SELECT user_id, username, clan_tag FROM game_players ORDER BY client_id",
    );
    const names = rows.map((r) => r.username);
    expect(names).toContain(ACCOUNT_RULES.deletedPlayerName);
    expect(names).not.toContain("RealNameAlice");
    expect(names).toContain("Bob");
    const erased = rows.find(
      (r) => r.username === ACCOUNT_RULES.deletedPlayerName,
    );
    expect(erased).toMatchObject({ user_id: null, clan_tag: null });
    // the ledger, which other records reference, is untouched
    expect(
      await q(h, "SELECT 1 FROM wallets WHERE user_id = $1", [a.id]),
    ).toHaveLength(1);
  });

  it("an active ban outlives a deletion request: the account cannot be erased to escape it", async () => {
    const { h, a } = await setup();
    await h.db.pool.query(
      "INSERT INTO bans (user_id, category, reason) VALUES ($1, 'cheating', 'x')",
      [a.id],
    );
    const res = await call(h, "/users/@me", { method: "DELETE", jar: a.jar });
    expect(res.status).toBe(403);
    expect((await res.json()).message).toMatch(/active ban/);
    expect(
      (
        await q(h, "SELECT deletion_requested_at FROM users WHERE id = $1", [
          a.id,
        ])
      )[0].deletion_requested_at,
    ).toBeNull();

    // banned after asking: the job waits for the ban to end
    await h.db.pool.query(
      "UPDATE bans SET revoked_at = now() WHERE user_id = $1",
      [a.id],
    );
    expect(
      (await call(h, "/users/@me", { method: "DELETE", jar: a.jar })).status,
    ).toBe(204);
    await h.db.pool.query(
      "INSERT INTO bans (user_id, category) VALUES ($1, 'cheating')",
      [a.id],
    );
    const later = new Date(Date.now() + 48 * HOUR);
    expect(await runDeletions(h.db.pool, later)).toBe(0);
    expect(
      (await q(h, "SELECT deleted_at FROM users WHERE id = $1", [a.id]))[0]
        .deleted_at,
    ).toBeNull();
    // an expired ban no longer holds it
    await h.db.pool.query(
      "UPDATE bans SET expires_at = now() - interval '1 minute' WHERE user_id = $1 AND revoked_at IS NULL",
      [a.id],
    );
    expect(await runDeletions(h.db.pool, later)).toBe(1);
  });
});

describeDb("retention of stored game records and dead sessions", () => {
  it("stores a record with an expiry of the retention period", async () => {
    const { h, key, a, b } = await setup();
    await play(h, key, "gameBBBB01", a, b);
    const [r] = await q(
      h,
      "SELECT extract(epoch FROM (expires_at - now()))/86400 AS days FROM game_records",
    );
    expect(Number(r.days)).toBeGreaterThan(
      ACCOUNT_RULES.gameRecordRetentionDays - 0.1,
    );
    // calendar days: a daylight-saving change moves it by an hour
    expect(Number(r.days)).toBeLessThan(
      ACCOUNT_RULES.gameRecordRetentionDays + 0.1,
    );
  });

  it("prunes expired records (and old ones with no expiry), keeps the game rows, and leaves fresh records alone", async () => {
    const { h, key, a, b } = await setup();
    for (const code of ["gameCCCC01", "gameCCCC02", "gameCCCC03", "gameCCCC04"])
      await play(h, key, code, a, b);
    const id = async (code: string) =>
      (await q(h, "SELECT id FROM games WHERE game_code = $1", [code]))[0].id;
    await h.db.pool.query(
      "UPDATE game_records SET expires_at = now() - interval '1 day' WHERE game_id = $1",
      [await id("gameCCCC01")],
    );
    await h.db.pool.query(
      "UPDATE game_records SET expires_at = NULL WHERE game_id = $1",
      [await id("gameCCCC02")],
    );
    await h.db.pool.query(
      "UPDATE games SET ended_at = now() - interval '90 days' WHERE id = $1",
      [await id("gameCCCC02")],
    );
    await h.db.pool.query(
      "UPDATE game_records SET expires_at = NULL WHERE game_id = $1",
      [await id("gameCCCC03")],
    );
    await h.db.pool.query(
      "UPDATE games SET ended_at = now() - interval '5 days' WHERE id = $1",
      [await id("gameCCCC03")],
    );

    const result = await runRetention(h.db.pool, new Date());
    expect(result.records).toBe(2);
    const left = await q(
      h,
      "SELECT g.game_code FROM game_records r JOIN games g ON g.id = r.game_id ORDER BY 1",
    );
    expect(left.map((r) => r.game_code)).toEqual(["gameCCCC03", "gameCCCC04"]);
    expect(await q(h, "SELECT 1 FROM games")).toHaveLength(4);
    expect(await q(h, "SELECT 1 FROM game_players")).toHaveLength(8);
    // a pruned record is a clean 404 for the replay route, not an error
    const gone = await call(h, "/game/gameCCCC01", {
      origin: null,
      headers: { "x-api-key": key },
    });
    expect([404, 410]).toContain(gone.status);
    // running it again changes nothing
    expect(await runRetention(h.db.pool, new Date())).toEqual({
      records: 0,
      sessions: 0,
    });
  });

  it("prunes refresh sessions long dead, and keeps live ones and recently dead ones (reuse detection needs them)", async () => {
    const { h, a } = await setup();
    const add = async (sql: string) =>
      h.db.pool.query(
        `INSERT INTO refresh_sessions (user_id, family_id, token_hash, expires_at, revoked_at, revoked_reason)
         VALUES ($1, gen_random_uuid(), sha256(gen_random_uuid()::text::bytea), ${sql})`,
        [a.id],
      );
    await add("now() - interval '40 days', NULL, NULL"); // expired long ago
    await add(
      "now() + interval '10 days', now() - interval '40 days', 'logout'",
    ); // revoked long ago
    await add("now() - interval '2 days', NULL, NULL"); // expired recently
    await add(
      "now() + interval '10 days', now() - interval '1 day', 'rotated'",
    ); // rotated yesterday
    await add("now() + interval '10 days', NULL, NULL"); // live
    const before = (
      await q(
        h,
        "SELECT count(*)::int AS n FROM refresh_sessions WHERE user_id = $1",
        [a.id],
      )
    )[0].n;
    const result = await runRetention(h.db.pool, new Date());
    expect(result.sessions).toBe(2);
    const after = (
      await q(
        h,
        "SELECT count(*)::int AS n FROM refresh_sessions WHERE user_id = $1",
        [a.id],
      )
    )[0].n;
    expect(after).toBe(before - 2);
  });

  it("the maintenance pass runs deletions, guest cleanup and retention, and never throws", async () => {
    const { h } = await setup();
    await expect(
      runMaintenance(h.db.pool, silentLogger),
    ).resolves.toBeUndefined();
    await h.db.pool.end().catch(() => undefined);
  });
});
