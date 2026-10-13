// @vitest-environment node
import type { Server } from "node:http";
import type { Pool, PoolClient } from "pg";
import { afterEach, describe, expect, it } from "vitest";
import Transport from "winston-transport";
import { createApp } from "../../src/account-api/app";
import { loadConfig } from "../../src/account-api/config";
import { loadMigrationFiles } from "../../src/account-api/db/migrator";
import {
  isRetryableTransactionError,
  MAX_TRANSACTION_ATTEMPTS,
  withTransaction,
} from "../../src/account-api/db/tx";
import { RateLimiter } from "../../src/account-api/limits";
import { createLogger, type Logger } from "../../src/account-api/logger";
import { createReadiness } from "../../src/account-api/readiness";
import { redact, REDACTED, scrubString } from "../../src/account-api/redact";

const devConfig = () =>
  loadConfig({
    GAME_ENV: "dev",
    DATABASE_URL: "postgres://u:p@localhost:5432/df",
  });
const prodConfig = () =>
  loadConfig({
    GAME_ENV: "prod",
    DOMAIN: "example.com",
    API_PUBLIC_ORIGIN: "https://api.example.com",
    ALLOWED_ORIGINS: "https://example.com",
    DATABASE_URL: "postgres://u:p@localhost:5432/df",
  });

interface Line {
  level: string;
  message: string;
  [k: string]: unknown;
}

/** A real winston logger (so redaction runs) that keeps what it writes. */
function recordingLogger(): { log: Logger; lines: Line[] } {
  const lines: Line[] = [];
  class Memory extends Transport {
    log(info: unknown, next: () => void): void {
      lines.push(JSON.parse(JSON.stringify(info)) as Line);
      next();
    }
  }
  return { log: createLogger("debug", [new Memory()]), lines };
}

const servers: Server[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.close();
});
async function serve(app: ReturnType<typeof createApp>): Promise<string> {
  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  servers.push(server);
  const address = server.address();
  if (typeof address !== "object" || address === null)
    throw new Error("no port");
  return `http://127.0.0.1:${address.port}`;
}

describe("API response headers", () => {
  it("every response is non-sniffable, unframeable, referrer-free and uncacheable by default", async () => {
    const base = await serve(
      createApp({ config: devConfig(), log: recordingLogger().log }),
    );
    for (const route of ["/health", "/nope", "/ready"]) {
      const res = await fetch(`${base}${route}`);
      expect(res.headers.get("x-content-type-options"), route).toBe("nosniff");
      expect(res.headers.get("referrer-policy"), route).toBe("no-referrer");
      expect(res.headers.get("x-frame-options"), route).toBe("DENY");
      expect(res.headers.get("cache-control"), route).toBe("no-store");
      expect(res.headers.get("content-security-policy"), route).toMatch(
        /default-src 'none'; frame-ancestors 'none'/,
      );
      expect(res.headers.get("x-powered-by"), route).toBeNull();
    }
  });

  it("sends HSTS only when the API's public origin is https", async () => {
    const dev = await serve(
      createApp({ config: devConfig(), log: recordingLogger().log }),
    );
    expect(
      (await fetch(`${dev}/health`)).headers.get("strict-transport-security"),
    ).toBeNull();
    const prod = await serve(
      createApp({ config: prodConfig(), log: recordingLogger().log }),
    );
    expect(
      (await fetch(`${prod}/health`)).headers.get("strict-transport-security"),
    ).toBe("max-age=31536000; includeSubDomains");
  });

  it("CORS: only an allowed origin gets credentials; a foreign one gets nothing", async () => {
    const base = await serve(
      createApp({ config: prodConfig(), log: recordingLogger().log }),
    );
    const ok = await fetch(`${base}/health`, {
      headers: { Origin: "https://example.com" },
    });
    expect(ok.headers.get("access-control-allow-origin")).toBe(
      "https://example.com",
    );
    expect(ok.headers.get("access-control-allow-credentials")).toBe("true");
    for (const origin of [
      "https://evil.example",
      "https://example.com.evil.test",
      "null",
      "http://example.com",
    ]) {
      const res = await fetch(`${base}/health`, {
        headers: { Origin: origin },
      });
      expect(res.headers.get("access-control-allow-origin"), origin).toBeNull();
      expect(
        res.headers.get("access-control-allow-credentials"),
        origin,
      ).toBeNull();
    }
    const preflight = await fetch(`${base}/auth/refresh`, {
      method: "OPTIONS",
      headers: {
        Origin: "https://evil.example",
        "Access-Control-Request-Method": "POST",
      },
    });
    expect(preflight.headers.get("access-control-allow-origin")).toBeNull();
  });
});

describe("the request log", () => {
  it("logs the route pattern and status, and never the query string, headers or cookies", async () => {
    const { log, lines } = recordingLogger();
    const base = await serve(createApp({ config: devConfig(), log }));
    await fetch(
      `${base}/auth/callback/discord?code=SUPERSECRETCODE&state=STATEVALUE`,
      {
        headers: {
          Cookie: "df_refresh=COOKIEVALUE",
          Authorization: "Bearer eyJhbGciOi.eyJzdWIi.sig",
        },
      },
    );
    await fetch(`${base}/health`);
    await new Promise((r) => setTimeout(r, 30));
    const text = JSON.stringify(lines);
    for (const secret of [
      "SUPERSECRETCODE",
      "STATEVALUE",
      "COOKIEVALUE",
      "eyJhbGciOi",
    ]) {
      expect(text).not.toContain(secret);
    }
    // an ordinary 404 is debug noise, not a refusal worth reading
    expect(
      lines.find((l) => l.message === "request" && l.route === "unmatched"),
    ).toMatchObject({
      method: "GET",
      status: 404,
    });
    expect(lines.some((l) => l.message === "request refused")).toBe(false);
    expect(
      lines.find((l) => l.message === "request" && l.route === "/health"),
    ).toMatchObject({
      status: 200,
    });
  });

  it("logs security refusals (401, 403, 429) at info, by route pattern", async () => {
    const { log, lines } = recordingLogger();
    const base = await serve(
      createApp({
        config: devConfig(),
        log,
        mount: (a) => {
          for (const status of [401, 403, 429])
            a.get(`/deny/:id/${status}`, (_q, r) => void r.sendStatus(status));
        },
      }),
    );
    for (const status of [401, 403, 429])
      await fetch(`${base}/deny/SECRET-${status}/${status}?code=OAUTHCODE`);
    await new Promise((r) => setTimeout(r, 30));
    const refused = lines.filter((l) => l.message === "request refused");
    expect(refused.map((l) => [l.status, l.route])).toEqual([
      [401, "/deny/:id/401"],
      [403, "/deny/:id/403"],
      [429, "/deny/:id/429"],
    ]);
    expect(JSON.stringify(lines)).not.toMatch(/SECRET-|OAUTHCODE/);
  });

  it("logs a 500 as an error with the route, without the stack or the body", async () => {
    const { log, lines } = recordingLogger();
    const app = createApp({
      config: devConfig(),
      log,
      mount: (a) =>
        a.get("/boom", () => {
          throw new Error("secret detail postgres://user:hunter2@db/x");
        }),
    });
    const base = await serve(app);
    const res = await fetch(`${base}/boom`);
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "internal_error" });
    await new Promise((r) => setTimeout(r, 30));
    expect(JSON.stringify(lines)).not.toContain("hunter2");
    expect(lines.find((l) => l.message === "request failed")).toMatchObject({
      route: "/boom",
      status: 500,
    });
  });
});

describe("log redaction", () => {
  it("replaces values under sensitive keys, at any depth", () => {
    const out = redact({
      ok: "fine",
      accessToken: "abc",
      nested: {
        password: "p",
        Authorization: "Bearer x",
        deeper: { apiKey: "k", note: "hi" },
      },
      list: [{ clientSecret: "s" }, "plain"],
      email: "a@b.co",
      databaseUrl: "postgres://u:p@h/db",
    }) as Record<string, unknown>;
    const text = JSON.stringify(out);
    for (const leaked of [
      '"abc"',
      '"p"',
      "Bearer x",
      '"k"',
      '"s"',
      "a@b.co",
      "postgres://",
    ]) {
      expect(text, leaked).not.toContain(leaked);
    }
    expect(out.ok).toBe("fine");
    expect((out.list as unknown[])[1]).toBe("plain");
    expect(text).toContain(REDACTED);
  });

  it("scrubs secrets that sit inside ordinary text", () => {
    const jwt = "eyJhbGciOiJFZERTQSJ9.eyJzdWIiOiJ1c2VyIn0.c2lnbmF0dXJl";
    const cases = [
      `token ${jwt} rejected`,
      "key dfk_Zk3p0Qm8VrT1uYb7Nc2LwXa9 failed",
      "Authorization: Bearer abcdefghijklmnop",
      "connect postgres://df:hunter2@db.internal:5432/df failed",
      "contact jane.doe+x@example.com now",
      "GET /cb?code=OAUTHCODE&state=S1&x=1",
    ];
    const joined = cases.map(scrubString).join("\n");
    for (const leaked of [
      jwt,
      "dfk_Zk3p",
      "abcdefghijklmnop",
      "hunter2",
      "jane.doe",
      "OAUTHCODE",
      "state=S1",
    ]) {
      expect(joined, leaked).not.toContain(leaked);
    }
    expect(scrubString("a perfectly normal sentence")).toBe(
      "a perfectly normal sentence",
    );
  });

  it("redacts errors, and stops at a depth limit instead of looping on cycles", () => {
    const cyclic: Record<string, unknown> = { name: "x" };
    cyclic.self = cyclic;
    expect(() => redact(cyclic)).not.toThrow();
    const err = redact(new Error("failed for postgres://u:pw@h/db")) as {
      message: string;
    };
    expect(err.message).not.toContain("pw@");
  });

  it("the logger applies it to messages, stacks and fields", () => {
    const { log, lines } = recordingLogger();
    log.error("boom postgres://u:topsecret@h/db", {
      token: "abc",
      detail: "ok",
    });
    log.error(new Error("bad Bearer abcdefghijklmnop"));
    const text = JSON.stringify(lines);
    expect(text).not.toContain("topsecret");
    expect(text).not.toContain('"abc"');
    expect(text).not.toContain("abcdefghijklmnop");
    expect(lines[0].detail).toBe("ok");
  });
});

describe("readiness", () => {
  const files = loadMigrationFiles();
  function pool(options: {
    query?: () => Promise<unknown>;
    applied?: boolean;
    pendingError?: boolean;
  }): Pool {
    return {
      query: options.query ?? (async () => ({ rows: [{ x: 1 }] })),
      connect: async () =>
        ({
          query: async (sql: string) => {
            if (options.pendingError) throw new Error("connection reset");
            if (sql.includes("to_regclass"))
              return { rows: [{ exists: options.applied !== false }] };
            return {
              rows: files.map((f) => ({
                version: f.version,
                name: f.name,
                checksum: f.checksum,
                applied_at: new Date(),
              })),
            };
          },
          release: () => undefined,
        }) as unknown as PoolClient,
    } as unknown as Pool;
  }
  const keys = { jwks: () => ({ keys: [{ kid: "k" }] }) } as never;
  const quiet = { warn: () => undefined };

  it("is ready when the database answers, migrations are current and a signing key exists", async () => {
    const r = await createReadiness({
      pool: pool({}),
      keys,
      log: quiet,
    }).check();
    expect(r).toEqual({
      ready: true,
      checks: {
        database: "ok",
        migrations: "ok",
        signingKey: "ok",
        draining: "ok",
      },
    });
  });

  it("names each failing check without any detail", async () => {
    const down = await createReadiness({
      pool: pool({
        query: async () => {
          throw new Error("ECONNREFUSED 10.0.0.5:5432 password=x");
        },
      }),
      keys,
      log: quiet,
    }).check();
    expect(down.ready).toBe(false);
    expect(down.checks).toMatchObject({ database: "fail", migrations: "fail" });
    expect(JSON.stringify(down)).not.toMatch(
      /ECONNREFUSED|10\.0\.0\.5|password/,
    );

    const pending = await createReadiness({
      pool: pool({ applied: false }),
      keys,
      log: quiet,
    }).check();
    expect(pending.checks).toMatchObject({
      database: "ok",
      migrations: "fail",
    });

    const noKey = await createReadiness({
      pool: pool({}),
      keys: { jwks: () => ({ keys: [] }) } as never,
      log: quiet,
    }).check();
    expect(noKey.checks.signingKey).toBe("fail");
    expect(noKey.ready).toBe(false);
  });

  it("a hung database answers fail instead of hanging the probe", async () => {
    const r = await createReadiness({
      pool: pool({ query: () => new Promise(() => undefined) }),
      keys,
      log: quiet,
      timeoutMs: 30,
    }).check();
    expect(r.checks.database).toBe("fail");
  });

  it("does not ask the database more than once per cache window", async () => {
    let queries = 0;
    let t = 0;
    const r = createReadiness({
      pool: pool({
        query: async () => {
          queries++;
          return { rows: [] };
        },
      }),
      keys,
      log: quiet,
      now: () => t,
      cacheMs: 2000,
    });
    await Promise.all([r.check(), r.check(), r.check()]);
    await r.check();
    expect(queries).toBe(1);
    t = 2500;
    await r.check();
    expect(queries).toBe(2);
  });

  it("turns not-ready the moment draining starts, without touching the database", async () => {
    let queries = 0;
    const r = createReadiness({
      pool: pool({
        query: async () => {
          queries++;
          return { rows: [] };
        },
      }),
      keys,
      log: quiet,
    });
    expect((await r.check()).ready).toBe(true);
    r.startDraining();
    const after = await r.check();
    expect(after.ready).toBe(false);
    expect(after.checks.draining).toBe("fail");
    expect(queries).toBe(1);
  });

  it("/ready answers 200 or 503 with only status and check names", async () => {
    const ok = await serve(
      createApp({
        config: devConfig(),
        log: recordingLogger().log,
        readiness: createReadiness({ pool: pool({}), keys, log: quiet }),
      }),
    );
    const res = await fetch(`${ok}/ready`);
    expect(res.status).toBe(200);
    expect(Object.keys(await res.json()).sort()).toEqual(["checks", "status"]);
    const bad = await serve(
      createApp({
        config: devConfig(),
        log: recordingLogger().log,
        readiness: createReadiness({
          pool: pool({
            query: async () => {
              throw new Error("x");
            },
          }),
          keys,
          log: quiet,
        }),
      }),
    );
    const failed = await fetch(`${bad}/ready`);
    expect(failed.status).toBe(503);
    expect((await failed.json()).status).toBe("not_ready");
    // liveness is independent of readiness
    expect((await fetch(`${bad}/health`)).status).toBe(200);
  });
});

describe("transactions under contention", () => {
  const pgError = (code: string) => Object.assign(new Error("pg"), { code });
  function fakePool(log: string[]): Pool {
    return {
      connect: async () => ({
        query: async (sql: string) => void log.push(sql),
        release: () => log.push("release"),
      }),
    } as unknown as Pool;
  }

  it("recognises exactly the retryable PostgreSQL errors", () => {
    expect(isRetryableTransactionError(pgError("40P01"))).toBe(true);
    expect(isRetryableTransactionError(pgError("40001"))).toBe(true);
    for (const other of [
      pgError("23505"),
      pgError("57014"),
      new Error("x"),
      null,
      "40P01",
    ]) {
      expect(isRetryableTransactionError(other)).toBe(false);
    }
  });

  it("retries a deadlock on a fresh transaction and returns the second result", async () => {
    const log: string[] = [];
    let calls = 0;
    const result = await withTransaction(fakePool(log), async () => {
      calls++;
      if (calls === 1) throw pgError("40P01");
      return "done";
    });
    expect(result).toBe("done");
    expect(calls).toBe(2);
    expect(log.filter((l) => l === "BEGIN")).toHaveLength(2);
    expect(log.filter((l) => l === "ROLLBACK")).toHaveLength(1);
    expect(log.filter((l) => l === "COMMIT")).toHaveLength(1);
    expect(log.filter((l) => l === "release")).toHaveLength(2);
  });

  it("gives up after the maximum attempts and rethrows the deadlock", async () => {
    let calls = 0;
    await expect(
      withTransaction(fakePool([]), async () => {
        calls++;
        throw pgError("40001");
      }),
    ).rejects.toMatchObject({ code: "40001" });
    expect(calls).toBe(MAX_TRANSACTION_ATTEMPTS);
  });

  it("never retries anything else (a unique violation or a plain bug runs once)", async () => {
    for (const error of [pgError("23505"), new Error("bug")]) {
      let calls = 0;
      await expect(
        withTransaction(fakePool([]), async () => {
          calls++;
          throw error;
        }),
      ).rejects.toBe(error);
      expect(calls).toBe(1);
    }
  });
});

describe("the rate limiter's exhaustion check", () => {
  it("reports exhaustion without counting a hit", () => {
    let now = 0;
    const limiter = new RateLimiter({ max: 2, windowMs: 1000 }, () => now);
    expect(limiter.isExhausted("k").allowed).toBe(true);
    limiter.hit("k");
    expect(limiter.isExhausted("k").allowed).toBe(true);
    limiter.hit("k");
    const blocked = limiter.isExhausted("k");
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSeconds).toBe(1);
    expect(limiter.isExhausted("k").allowed).toBe(false); // checking did not move the counter
    now = 1500;
    expect(limiter.isExhausted("k").allowed).toBe(true);
  });
});
