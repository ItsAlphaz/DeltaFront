// @vitest-environment node
import { censorPlayer } from "@openfront/shared/Censor";
import { ServerListSchema } from "@openfront/shared/ServerList";
import { ArchivedAnalyticsRecordSchema } from "@openfront/shared/WireSchemas";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  runAdminCommand,
  type AdminIo,
} from "../../src/account-api/admin/commands";
import { sha256 } from "../../src/account-api/http";
import { silentLogger } from "../../src/account-api/logger";
import { CHECKIN_STALE_SECONDS } from "../../src/account-api/routes/cluster";
import {
  createTurnstile,
  type Turnstile,
  type TurnstileVerdict,
} from "../../src/account-api/turnstile";
import {
  applyCheckinState,
  sendCheckin,
  type CheckinBody,
} from "../../src/server/ClusterCheckin";
import { verifyJoin } from "../../src/server/JoinVerify";
import { MasterLobbyService } from "../../src/server/MasterLobbyService";
import { startPolling } from "../../src/server/PollingLoop";
import { ServerEnv } from "../../src/server/ServerEnv";
import { makeGameRecord } from "./util/gameRecord";
import {
  call,
  createServerKey,
  startHarness,
  type Harness,
} from "./util/harness";
import { describeDb } from "./util/testDb";

// The master's scheduling loop is captured, not run, so a test can invoke one
// pass by hand (the pattern of tests/server/MasterLobbyServiceActive.test.ts).
vi.mock("../../src/server/Logger", () => ({
  logger: { child: () => ({ error: vi.fn(), info: vi.fn(), warn: vi.fn() }) },
}));
vi.mock("../../src/server/PollingLoop", () => ({ startPolling: vi.fn() }));

const harnesses: Harness[] = [];
async function harness(
  options: Parameters<typeof startHarness>[0] = {},
): Promise<Harness> {
  const h = await startHarness(options);
  harnesses.push(h);
  return h;
}
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.close();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const checkin = (over: Partial<CheckinBody> = {}): CheckinBody => ({
  site: "example.com",
  letter: "a",
  host: "blue.example.com",
  version: COMMIT,
  numWorkers: 2,
  liveGames: 0,
  ...over,
});
const post = (
  h: Harness,
  route: string,
  key: string | undefined,
  json: unknown,
) =>
  call(h, route, {
    method: "POST",
    json,
    origin: null,
    headers: key === undefined ? {} : { "x-api-key": key },
  });

describeDb("server API keys", () => {
  it("every server endpoint needs a valid key", async () => {
    const h = await harness();
    const good = await createServerKey(h);
    const revoked = await createServerKey(h);
    await h.db.pool.query(
      "UPDATE server_api_keys SET revoked_at = now() WHERE key_hash = $1",
      [sha256(revoked)],
    );

    const endpoints: Array<[string, unknown]> = [
      ["/cluster/checkin", checkin()],
      [
        "/join_verify",
        { ip: "1.2.3.4", token: null, username: "Ann", clanTag: null },
      ],
    ];
    for (const [route, body] of endpoints) {
      expect(
        (await post(h, route, undefined, body)).status,
        `${route} without a key`,
      ).toBe(401);
      expect(
        (await post(h, route, "", body)).status,
        `${route} with an empty key`,
      ).toBe(401);
      expect(
        (await post(h, route, "wrong-key", body)).status,
        `${route} with a wrong key`,
      ).toBe(401);
      expect(
        (await post(h, route, revoked, body)).status,
        `${route} with a revoked key`,
      ).toBe(401);
      expect(
        (await post(h, route, good, body)).status,
        `${route} with a valid key`,
      ).toBe(200);
    }
    expect(
      (await post(h, "/game/abCD1234", "wrong-key", makeGameRecord("abCD1234")))
        .status,
    ).toBe(401);
  });

  it("stores only a hash of the key", async () => {
    const h = await harness();
    const key = await createServerKey(
      h,
      "plain-text-key-should-never-be-stored",
    );
    const stored = (
      await h.db.pool.query(
        "SELECT encode(key_hash, 'hex') AS hash FROM server_api_keys",
      )
    ).rows[0].hash;
    expect(stored).not.toContain(key);
    expect(stored).toHaveLength(64);
  });

  it("a key in a query string or the Authorization header does not count", async () => {
    const h = await harness();
    const key = await createServerKey(h);
    const body = { ip: "1.2.3.4", token: null, username: "Ann", clanTag: null };
    const viaQuery = await call(h, `/join_verify?x-api-key=${key}`, {
      method: "POST",
      json: body,
      origin: null,
    });
    expect(viaQuery.status).toBe(401);
    const viaBearer = await call(h, "/join_verify", {
      method: "POST",
      json: body,
      origin: null,
      bearer: key,
    });
    expect(viaBearer.status).toBe(401);
  });
});

describeDb("server check-in and the server list", () => {
  it("a server checks in and is listed, in the exact shape the client parses", async () => {
    const h = await harness();
    const key = await createServerKey(h);
    const res = await post(
      h,
      "/cluster/checkin",
      key,
      checkin({ liveGames: 3, machine: "m-1" }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ state: "open" });

    const list = await call(h, "/cluster.json?site=example.com", {
      origin: null,
    });
    expect(list.status).toBe(200);
    const parsed = ServerListSchema.parse(await list.json());
    expect(parsed.latest).toBe(COMMIT);
    expect(parsed.servers).toEqual({
      a: {
        host: "blue.example.com",
        numWorkers: 2,
        version: COMMIT,
        state: "open",
      },
    });
    expect(
      (await h.db.pool.query("SELECT live_games, machine FROM game_servers"))
        .rows,
    ).toEqual([{ live_games: 3, machine: "m-1" }]);
  });

  it("repeated check-ins update the same row", async () => {
    const h = await harness();
    const key = await createServerKey(h);
    await post(h, "/cluster/checkin", key, checkin({ liveGames: 1 }));
    await post(
      h,
      "/cluster/checkin",
      key,
      checkin({ liveGames: 7, version: "f".repeat(40) }),
    );
    const rows = (
      await h.db.pool.query("SELECT live_games, version FROM game_servers")
    ).rows;
    expect(rows).toEqual([{ live_games: 7, version: "f".repeat(40) }]);
  });

  it("lists several servers of a site and none of another", async () => {
    const h = await harness();
    const key = await createServerKey(h);
    await post(
      h,
      "/cluster/checkin",
      key,
      checkin({ letter: "a", host: "blue.example.com" }),
    );
    await post(
      h,
      "/cluster/checkin",
      key,
      checkin({ letter: "b", host: "green.example.com" }),
    );
    await post(
      h,
      "/cluster/checkin",
      key,
      checkin({ site: "other.org", letter: "a", host: "x.other.org" }),
    );
    const parsed = ServerListSchema.parse(
      await (
        await call(h, "/cluster.json?site=example.com", { origin: null })
      ).json(),
    );
    expect(Object.keys(parsed.servers)).toEqual(["a", "b"]);
    const other = ServerListSchema.parse(
      await (
        await call(h, "/cluster.json?site=other.org", { origin: null })
      ).json(),
    );
    expect(Object.keys(other.servers)).toEqual(["a"]);
  });

  it("answers 404 for a site nobody registered (the client reads that as 'no list') and 400 for a malformed one", async () => {
    const h = await harness();
    expect(
      (await call(h, "/cluster.json?site=nobody.example", { origin: null }))
        .status,
    ).toBe(404);
    for (const site of [
      "",
      "UPPER.example",
      "bad site",
      "a/b",
      "-x.com",
      "x.com:99999999",
    ]) {
      expect(
        (
          await call(h, `/cluster.json?site=${encodeURIComponent(site)}`, {
            origin: null,
          })
        ).status,
        site,
      ).toBe(400);
    }
    expect((await call(h, "/cluster.json", { origin: null })).status).toBe(400);
  });

  it("stops listing a server that has gone quiet", async () => {
    const h = await harness();
    const key = await createServerKey(h);
    await post(h, "/cluster/checkin", key, checkin({ letter: "a" }));
    await post(
      h,
      "/cluster/checkin",
      key,
      checkin({ letter: "b", host: "green.example.com" }),
    );
    await h.db.pool.query(
      `UPDATE game_servers SET last_checkin_at = now() - interval '${CHECKIN_STALE_SECONDS + 5} seconds' WHERE letter = 'a'`,
    );
    const parsed = ServerListSchema.parse(
      await (
        await call(h, "/cluster.json?site=example.com", { origin: null })
      ).json(),
    );
    expect(Object.keys(parsed.servers)).toEqual(["b"]);
    await h.db.pool.query(
      "UPDATE game_servers SET last_checkin_at = now() - interval '1 hour'",
    );
    expect(
      (await call(h, "/cluster.json?site=example.com", { origin: null }))
        .status,
    ).toBe(404);
  });

  it("rejects a malformed check-in", async () => {
    const h = await harness();
    const key = await createServerKey(h);
    for (const bad of [
      checkin({ version: "DEV" }),
      checkin({ version: "not-a-commit" }),
      checkin({ letter: "A" }),
      checkin({ letter: "ab" }),
      checkin({ numWorkers: 0 }),
      checkin({ liveGames: -1 }),
      checkin({ host: "has spaces" }),
      checkin({ site: "UPPER.com" }),
      { site: "example.com" },
    ]) {
      expect(
        (await post(h, "/cluster/checkin", key, bad)).status,
        JSON.stringify(bad),
      ).toBe(400);
    }
    expect(
      (await h.db.pool.query("SELECT count(*)::int AS n FROM game_servers"))
        .rows[0].n,
    ).toBe(0);
  });

  it("a letter belongs to the first host that claims it; another host is refused (409)", async () => {
    const h = await harness();
    const key = await createServerKey(h);
    await post(
      h,
      "/cluster/checkin",
      key,
      checkin({ host: "blue.example.com" }),
    );
    const res = await post(
      h,
      "/cluster/checkin",
      key,
      checkin({ host: "attacker.example.com" }),
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      reason: "letter is registered to a different host",
      host: "blue.example.com",
    });
    // The real owner is unaffected.
    expect(
      (await h.db.pool.query("SELECT host FROM game_servers")).rows,
    ).toEqual([{ host: "blue.example.com" }]);
  });

  it("the worker count cannot change while games are live", async () => {
    const h = await harness();
    const key = await createServerKey(h);
    await post(
      h,
      "/cluster/checkin",
      key,
      checkin({ numWorkers: 2, liveGames: 4 }),
    );
    const refused = await post(
      h,
      "/cluster/checkin",
      key,
      checkin({ numWorkers: 4, liveGames: 4 }),
    );
    expect(refused.status).toBe(409);
    expect((await refused.json()).reason).toMatch(/worker count/);
    // Once the games are done, it can.
    await post(
      h,
      "/cluster/checkin",
      key,
      checkin({ numWorkers: 2, liveGames: 0 }),
    );
    expect(
      (
        await post(
          h,
          "/cluster/checkin",
          key,
          checkin({ numWorkers: 4, liveGames: 0 }),
        )
      ).status,
    ).toBe(200);
  });

  it("the state is the operator's decision: a check-in cannot change it, and `latest` follows the open servers", async () => {
    const h = await harness();
    const key = await createServerKey(h);
    const OLD = "a".repeat(40);
    await post(
      h,
      "/cluster/checkin",
      key,
      checkin({ letter: "a", host: "blue.example.com", version: OLD }),
    );
    await post(
      h,
      "/cluster/checkin",
      key,
      checkin({ letter: "b", host: "green.example.com", version: COMMIT }),
    );

    const io: AdminIo = {
      out: () => undefined,
      err: () => undefined,
      env: {},
      actor: "test",
    };
    expect(
      await runAdminCommand(
        h.db.pool,
        [
          "server:state",
          "example.com",
          "a",
          "draining",
          "--yes",
          "--reason",
          "test",
        ],
        io,
      ),
    ).toBe(0);

    expect(
      await (
        await post(
          h,
          "/cluster/checkin",
          key,
          checkin({ letter: "a", host: "blue.example.com", version: OLD }),
        )
      ).json(),
    ).toEqual({ state: "draining" });
    expect(
      await (
        await post(
          h,
          "/cluster/checkin",
          key,
          checkin({ letter: "b", host: "green.example.com", version: COMMIT }),
        )
      ).json(),
    ).toEqual({ state: "open" });

    const parsed = ServerListSchema.parse(
      await (
        await call(h, "/cluster.json?site=example.com", { origin: null })
      ).json(),
    );
    expect(parsed.latest).toBe(COMMIT); // what the open server runs
    expect(parsed.servers.a.state).toBe("draining");

    await runAdminCommand(
      h.db.pool,
      [
        "server:state",
        "example.com",
        "b",
        "fenced",
        "--yes",
        "--reason",
        "test",
      ],
      io,
    );
    const none = ServerListSchema.parse(
      await (
        await call(h, "/cluster.json?site=example.com", { origin: null })
      ).json(),
    );
    expect(none.latest).toBeUndefined(); // no open server, no version to recommend
    expect(none.servers.b.state).toBe("fenced");
  });
});

describeDb(
  "public lobbies unlock only when the API says the server is open",
  () => {
    let service: MasterLobbyService;
    const sent: Array<{ type: string }> = [];

    beforeEach(() => {
      sent.length = 0;
      vi.mocked(startPolling).mockClear();
      vi.stubEnv("DOMAIN", "localhost");
      vi.spyOn(ServerEnv, "numWorkers").mockReturnValue(1);
      const playlist = { gameConfig: vi.fn(async () => ({})) };
      // A registering server (awaitApiState = true): it schedules nothing until the API answers.
      service = new MasterLobbyService(
        playlist as never,
        { info: vi.fn(), error: vi.fn(), warn: vi.fn() } as never,
        true,
      );
      const worker = Object.assign(new EventEmitter(), {
        send: (msg: { type: string }) => void sent.push(msg),
      });
      service.registerWorker(0, worker as never);
      (worker as unknown as { emit(e: string, m: unknown): void }).emit(
        "message",
        { type: "workerReady", workerId: 0 },
      );
    });

    const schedule = async () => {
      const call = vi
        .mocked(startPolling)
        .mock.calls.find(([, ms]) => ms === 1000)!;
      await call[0]();
    };
    const created = () => sent.filter((m) => m.type === "createGame").length;

    /** The real game-server check-in code, talking to the real API. */
    async function realCheckin(h: Harness, key: string, body: CheckinBody) {
      vi.stubEnv("API_KEY", key);
      const fetchToHarness = ((url: string, init: RequestInit) =>
        fetch(
          url.replace("http://localhost:8787", h.baseUrl),
          init,
        )) as typeof fetch;
      return sendCheckin(body, fetchToHarness);
    }

    it("nothing is scheduled before the first answer, or after a refusal", async () => {
      const h = await harness();
      await schedule();
      expect(created()).toBe(0);

      const result = await realCheckin(
        h,
        "unregistered-key-0123456789",
        checkin(),
      ); // refused: 401 -> null
      expect(result).toBeNull();
      applyCheckinState(result, (a) => service.setActive(a));
      await schedule();
      expect(created()).toBe(0);
    });

    it("opens when the API answers open, and closes again when it is fenced or draining", async () => {
      const h = await harness();
      const key = await createServerKey(h);
      const io: AdminIo = {
        out: () => undefined,
        err: () => undefined,
        env: {},
        actor: "test",
      };

      const open = await realCheckin(h, key, checkin());
      expect(open).toBe("open");
      applyCheckinState(open, (a) => service.setActive(a));
      await schedule();
      expect(created()).toBeGreaterThan(0);

      for (const state of ["draining", "fenced"] as const) {
        await runAdminCommand(
          h.db.pool,
          [
            "server:state",
            "example.com",
            "a",
            state,
            "--yes",
            "--reason",
            "test",
          ],
          io,
        );
        const answer = await realCheckin(h, key, checkin());
        expect(answer).toBe(state);
        sent.length = 0;
        applyCheckinState(answer, (a) => service.setActive(a));
        await schedule();
        expect(created(), state).toBe(0);
      }

      await runAdminCommand(
        h.db.pool,
        [
          "server:state",
          "example.com",
          "a",
          "open",
          "--yes",
          "--reason",
          "test",
        ],
        io,
      );
      applyCheckinState(await realCheckin(h, key, checkin()), (a) =>
        service.setActive(a),
      );
      await schedule();
      expect(created()).toBeGreaterThan(0);
    });

    it("a host that claims someone else's letter is refused and schedules nothing", async () => {
      const h = await harness();
      const key = await createServerKey(h);
      await realCheckin(h, key, checkin({ host: "blue.example.com" }));
      const refused = await realCheckin(
        h,
        key,
        checkin({ host: "attacker.example.com" }),
      );
      expect(refused).toEqual({
        refused:
          "letter is registered to a different host (host: blue.example.com)",
      });
      applyCheckinState(refused, (a) => service.setActive(a));
      await schedule();
      expect(created()).toBe(0);
    });
  },
);

describeDb("join verification (the production admission gate)", () => {
  const verify = (h: Harness, key: string, body: Record<string, unknown>) =>
    post(h, "/join_verify", key, body);

  it("approves a clean name and upper-cases a surviving clan tag", async () => {
    const h = await harness();
    const key = await createServerKey(h);
    const res = await verify(h, key, {
      ip: "1.2.3.4",
      token: null,
      username: "Anna",
      clanTag: "ab",
    });
    expect(await res.json()).toEqual({
      status: "approved",
      username: "Anna",
      clanTag: "AB",
    });
  });

  it("screens names exactly like the game server's own censor (same shadow name, same tag rules)", async () => {
    const h = await harness();
    const key = await createServerKey(h);
    for (const [username, clanTag] of [
      ["xXfaggotXx", null],
      ["nice", "KKK"],
      ["adolf fan", "AB"],
      ["Casual", "ss"],
      ["Bob", null],
    ] as const) {
      const res = await verify(h, key, {
        ip: "1.2.3.4",
        token: null,
        username,
        clanTag,
      });
      const body = await res.json();
      expect(
        { username: body.username, clanTag: body.clanTag },
        `${username}/${clanTag}`,
      ).toEqual(censorPlayer(username, clanTag));
    }
    // A banned name really is replaced.
    const body = await (
      await verify(h, key, {
        ip: "1.2.3.4",
        token: null,
        username: "hitler",
        clanTag: null,
      })
    ).json();
    expect(body.username).not.toBe("hitler");
  });

  it("rejects a malformed request", async () => {
    const h = await harness();
    const key = await createServerKey(h);
    for (const bad of [
      {},
      { ip: "1", token: 5, username: "a", clanTag: null },
      { ip: "1", token: null, username: "x".repeat(200), clanTag: null },
      { ip: "1", token: null, username: "a" },
    ]) {
      expect((await verify(h, key, bad)).status, JSON.stringify(bad)).toBe(400);
    }
  });

  describe("Turnstile", () => {
    const withTurnstile = (verdict: TurnstileVerdict) => {
      const calls: Array<{ token: string; ip: string }> = [];
      const turnstile: Turnstile = {
        verify: async (token, ip) => {
          calls.push({ token, ip });
          return verdict;
        },
      };
      return { turnstile, calls };
    };

    it("a genuine token is approved, and the token and player's address reach the check", async () => {
      const t = withTurnstile({ status: "ok" });
      const h = await harness({ turnstile: t.turnstile });
      const key = await createServerKey(h);
      const res = await verify(h, key, {
        ip: "203.0.113.9",
        token: "cf-token",
        username: "Ann",
        clanTag: null,
      });
      expect((await res.json()).status).toBe("approved");
      expect(t.calls).toEqual([{ token: "cf-token", ip: "203.0.113.9" }]);
    });

    it("a rejected token is a rejection (the game server then refuses the join)", async () => {
      const t = withTurnstile({
        status: "rejected",
        reason: "invalid",
      });
      const h = await harness({ turnstile: t.turnstile });
      const key = await createServerKey(h);
      const res = await verify(h, key, {
        ip: "1.1.1.1",
        token: "forged",
        username: "Ann",
        clanTag: null,
      });
      expect(await res.json()).toEqual({
        status: "rejected",
        reason: "invalid",
      });
    });

    it("a reconnect (no token) skips the check entirely and still screens the name", async () => {
      const t = withTurnstile({
        status: "rejected",
        reason: "invalid",
      });
      const h = await harness({ turnstile: t.turnstile });
      const key = await createServerKey(h);
      const res = await verify(h, key, {
        ip: "1.1.1.1",
        token: null,
        username: "Ann",
        clanTag: null,
      });
      expect((await res.json()).status).toBe("approved");
      expect(t.calls).toEqual([]);
    });

    it("when Cloudflare cannot be reached the API answers 503, which the game server treats as 'fail open'", async () => {
      const t = withTurnstile({
        status: "unavailable",
        reason: "siteverify unreachable",
      });
      const h = await harness({ turnstile: t.turnstile });
      const key = await createServerKey(h);
      const res = await verify(h, key, {
        ip: "1.1.1.1",
        token: "cf",
        username: "Ann",
        clanTag: null,
      });
      expect(res.status).toBe(503);
    });

    it("the real Turnstile client sends the secret, token and address to Cloudflare, and maps its answers", async () => {
      const requests: Array<{ url: string; body: URLSearchParams }> = [];
      const answers: Array<() => Response> = [
        () => new Response(JSON.stringify({ success: true })),
        () =>
          new Response(
            JSON.stringify({
              success: false,
              "error-codes": ["timeout-or-duplicate"],
            }),
          ),
        () => new Response("nope", { status: 500 }),
      ];
      const fetchFn = (async (url: string, init: RequestInit) => {
        requests.push({ url, body: init.body as URLSearchParams });
        return answers.shift()!();
      }) as unknown as typeof fetch;
      const turnstile = createTurnstile({
        secret: "the-secret",
        fetchFn,
        log: silentLogger,
      });
      expect(await turnstile.verify("tok", "9.9.9.9")).toEqual({
        status: "ok",
      });
      expect(await turnstile.verify("tok2", "9.9.9.9")).toEqual({
        status: "rejected",
        reason: "invalid",
        detail: "timeout-or-duplicate",
      });
      expect((await turnstile.verify("tok3", "9.9.9.9")).status).toBe(
        "unavailable",
      );
      expect(requests[0].url).toBe(
        "https://challenges.cloudflare.com/turnstile/v0/siteverify",
      );
      expect(Object.fromEntries(requests[0].body)).toEqual({
        secret: "the-secret",
        response: "tok",
        remoteip: "9.9.9.9",
      });

      const thrower = createTurnstile({
        secret: "s",
        fetchFn: (async () => {
          throw new Error("down");
        }) as never,
        log: silentLogger,
      });
      expect((await thrower.verify("t", "1.1.1.1")).status).toBe("unavailable");
    });

    it("without a secret (dev only) the check is skipped, and says so once", async () => {
      const warnings: string[] = [];
      const turnstile = createTurnstile({
        secret: null,
        log: {
          error() {},
          info() {},
          debug() {},
          warn: (m: unknown) => void warnings.push(String(m)),
        } as never,
      });
      expect(await turnstile.verify("t", "1.1.1.1")).toEqual({ status: "ok" });
      await turnstile.verify("t", "1.1.1.1");
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toMatch(/NOT being verified/);
    });
  });

  it("the game server's own verifyJoin reads the API's answers correctly (approved, rejected, error)", async () => {
    const t = { n: 0 };
    const verdicts: TurnstileVerdict[] = [
      { status: "ok" },
      { status: "rejected", reason: "invalid" },
      { status: "unavailable", reason: "down" },
    ];
    const h = await harness({
      turnstile: { verify: async () => verdicts[t.n++] },
    });
    const key = await createServerKey(h);
    vi.stubEnv("DOMAIN", "localhost");
    vi.stubEnv("API_KEY", key);
    const realFetch = globalThis.fetch;
    vi.stubGlobal("fetch", ((url: string, init: RequestInit) =>
      realFetch(
        String(url).replace("http://localhost:8787", h.baseUrl),
        init,
      )) as typeof fetch);
    expect(await verifyJoin("1.2.3.4", "tok", "Ann", "ab")).toEqual({
      status: "approved",
      username: "Ann",
      clanTag: "AB",
    });
    expect(await verifyJoin("1.2.3.4", "tok", "Ann", null)).toEqual({
      status: "rejected",
      reason: "invalid",
    });
    expect((await verifyJoin("1.2.3.4", "tok", "Ann", null)).status).toBe(
      "error",
    );
  });
});

describeDb("the game archive", () => {
  it("stores a finished game once, and answers a repeat without error", async () => {
    const h = await harness();
    const key = await createServerKey(h);
    const record = makeGameRecord("abCD1234");
    expect((await post(h, "/game/abCD1234", key, record)).status).toBe(200);
    expect((await post(h, "/game/abCD1234", key, record)).status).toBe(200);

    const games = (
      await h.db.pool.query(
        "SELECT game_code, source, type, mode, difficulty, map, human_players, server_letter, counts_for_stats, duration_s FROM games",
      )
    ).rows;
    expect(games).toEqual([
      {
        game_code: "abCD1234",
        source: "server",
        type: "Public",
        mode: "Free For All",
        difficulty: "Medium",
        map: "Africa",
        human_players: 2,
        server_letter: "a",
        counts_for_stats: false,
        duration_s: 600,
      },
    ]);
    expect(
      (await h.db.pool.query("SELECT count(*)::int AS n FROM game_records"))
        .rows[0].n,
    ).toBe(1);
    // Its players have no accounts here, so nothing is derived from it.
    expect(
      (await h.db.pool.query("SELECT count(*)::int AS n FROM game_players"))
        .rows[0].n,
    ).toBe(0);
    expect(
      (await h.db.pool.query("SELECT count(*)::int AS n FROM wallets")).rows[0]
        .n,
    ).toBe(0);
  });

  it("serves it back as the archive reader expects, with the players' identities removed", async () => {
    const h = await harness();
    const key = await createServerKey(h);
    await post(h, "/game/abCD1234", key, makeGameRecord("abCD1234"));
    const res = await call(h, "/game/abCD1234", { origin: null });
    expect(res.status).toBe(200);
    const body = await res.json();
    const parsed = ArchivedAnalyticsRecordSchema.parse(body);
    expect(parsed.info.players.map((p) => p.persistentID)).toEqual([
      null,
      null,
    ]);
    expect(JSON.stringify(body)).not.toContain(
      "11111111-1111-4111-8111-111111111111",
    );
    expect(body.info.reports).toBeUndefined();
    expect(body.turns).toHaveLength(1);
    expect((await call(h, "/game/zzzzzzzz", { origin: null })).status).toBe(
      404,
    );
  });

  it("rejects a record that is not valid, or that names a different game", async () => {
    const h = await harness();
    const key = await createServerKey(h);
    expect((await post(h, "/game/abCD1234", key, { nope: true })).status).toBe(
      400,
    );
    expect(
      (await post(h, "/game/abCD1234", key, makeGameRecord("otherID1"))).status,
    ).toBe(400);
    expect(
      (await post(h, "/game/bad id!", key, makeGameRecord("abCD1234"))).status,
    ).toBe(400);
    expect(
      (await h.db.pool.query("SELECT count(*)::int AS n FROM games")).rows[0].n,
    ).toBe(0);
  });
});

describeDb("news and streams feeds", () => {
  it("serve the bundled files", async () => {
    const h = await harness();
    for (const name of ["news", "streams"]) {
      const res = await call(h, `/${name}.json`, { origin: null });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual(
        JSON.parse(
          fs.readFileSync(
            path.resolve(__dirname, `../../resources/${name}.json`),
            "utf8",
          ),
        ),
      );
    }
  });
});
