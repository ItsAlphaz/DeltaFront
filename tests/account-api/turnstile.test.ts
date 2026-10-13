// @vitest-environment node
import { describe, expect, it } from "vitest";
import { silentLogger } from "../../src/account-api/logger";
import {
  createTurnstile,
  hostnameAllowed,
  TURNSTILE_JOIN_ACTION,
} from "../../src/account-api/turnstile";

type Reply = { status?: number; json?: unknown; throws?: boolean };

function make(
  replies: Reply[],
  options: Partial<Parameters<typeof createTurnstile>[0]> = {},
) {
  const calls: Array<{ body: URLSearchParams }> = [];
  const fetchFn = (async (_url: string, init?: RequestInit) => {
    calls.push({ body: init!.body as URLSearchParams });
    const reply = replies.shift() ?? { json: { success: false } };
    if (reply.throws) throw new Error("network down");
    return new Response(JSON.stringify(reply.json ?? {}), {
      status: reply.status ?? 200,
    });
  }) as typeof fetch;
  const turnstile = createTurnstile({
    secret: "turnstile-secret-value",
    fetchFn,
    log: silentLogger,
    allowedHostnames: ["example.com"],
    expectedAction: TURNSTILE_JOIN_ACTION,
    ...options,
  });
  return { turnstile, calls };
}

const good = (extra: Record<string, unknown> = {}) => ({
  json: { success: true, hostname: "example.com", action: "join", ...extra },
});

describe("Turnstile verification", () => {
  it("accepts a token solved on our hostname for the join action and sends the secret only to Cloudflare", async () => {
    const { turnstile, calls } = make([good()]);
    expect(await turnstile.verify("tok", "203.0.113.5")).toEqual({
      status: "ok",
    });
    expect(calls[0].body.get("secret")).toBe("turnstile-secret-value");
    expect(calls[0].body.get("response")).toBe("tok");
    expect(calls[0].body.get("remoteip")).toBe("203.0.113.5");
  });

  it("accepts our subdomains and rejects look-alike hostnames", async () => {
    expect(hostnameAllowed("play.example.com", ["example.com"])).toBe(true);
    expect(hostnameAllowed("EXAMPLE.com", ["example.com"])).toBe(true);
    expect(hostnameAllowed("evilexample.com", ["example.com"])).toBe(false);
    expect(hostnameAllowed("example.com.evil.test", ["example.com"])).toBe(
      false,
    );
    expect(hostnameAllowed("", ["example.com"])).toBe(false);
  });

  it("rejects a token solved on another site, or with no hostname", async () => {
    for (const reply of [
      good({ hostname: "attacker.test" }),
      good({ hostname: undefined }),
    ]) {
      const { turnstile } = make([reply]);
      expect(await turnstile.verify("tok", "1.1.1.1")).toEqual({
        status: "rejected",
        reason: "hostname",
      });
    }
  });

  it("rejects a token solved for another action", async () => {
    for (const action of ["login", "", undefined]) {
      const { turnstile } = make([good({ action })]);
      expect(await turnstile.verify("tok", "1.1.1.1")).toEqual({
        status: "rejected",
        reason: "action",
      });
    }
  });

  it("skips the hostname and action checks when they are not configured (dev)", async () => {
    const { turnstile } = make([good({ hostname: "localhost", action: "" })], {
      allowedHostnames: null,
      expectedAction: null,
    });
    expect((await turnstile.verify("tok", "1.1.1.1")).status).toBe("ok");
  });

  it("tells a bad token (rejected) from a provider failure (unavailable)", async () => {
    const cases: Array<[Reply, string]> = [
      [
        { json: { success: false, "error-codes": ["invalid-input-response"] } },
        "rejected",
      ],
      [
        { json: { success: false, "error-codes": ["timeout-or-duplicate"] } },
        "rejected",
      ],
      [
        { json: { success: false, "error-codes": ["internal-error"] } },
        "unavailable",
      ],
      // Our own secret is wrong: not the player's fault, and loud in the log.
      [
        { json: { success: false, "error-codes": ["invalid-input-secret"] } },
        "unavailable",
      ],
      [{ status: 500 }, "unavailable"],
      [{ status: 403 }, "unavailable"],
      [{ throws: true }, "unavailable"],
    ];
    for (const [reply, expected] of cases) {
      const { turnstile } = make([reply]);
      expect(
        (await turnstile.verify("tok", "1.1.1.1")).status,
        JSON.stringify(reply),
      ).toBe(expected);
    }
  });

  it("times out instead of hanging", async () => {
    const hang = ((_url: string, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init!.signal!.addEventListener("abort", () => reject(new Error("t")));
      })) as typeof fetch;
    const turnstile = createTurnstile({
      secret: "s",
      fetchFn: hang,
      log: silentLogger,
      timeoutMs: 20,
    });
    expect((await turnstile.verify("tok", "1.1.1.1")).status).toBe(
      "unavailable",
    );
  });

  it("refuses a token it has already accepted, without asking Cloudflare again", async () => {
    const { turnstile, calls } = make([good(), { throws: true }]);
    expect((await turnstile.verify("tok", "1.1.1.1")).status).toBe("ok");
    expect(await turnstile.verify("tok", "1.1.1.1")).toEqual({
      status: "rejected",
      reason: "replayed",
    });
    expect(calls).toHaveLength(1);
  });

  it("forgets an accepted token after the replay window", async () => {
    const clock = { t: 0 };
    const { turnstile } = make([good(), good()], { now: () => clock.t });
    await turnstile.verify("tok", "1.1.1.1");
    clock.t += 7 * 60_000;
    expect((await turnstile.verify("tok", "1.1.1.1")).status).toBe("ok");
  });

  it("does not remember a rejected token as accepted", async () => {
    const { turnstile } = make([
      { json: { success: false, "error-codes": ["invalid-input-response"] } },
      good(),
    ]);
    expect((await turnstile.verify("tok", "1.1.1.1")).status).toBe("rejected");
    expect((await turnstile.verify("tok", "1.1.1.1")).status).toBe("ok");
  });

  it("with no secret (dev) approves and never calls Cloudflare", async () => {
    const { turnstile, calls } = make([], { secret: null });
    expect((await turnstile.verify("tok", "1.1.1.1")).status).toBe("ok");
    expect(calls).toHaveLength(0);
  });
});
