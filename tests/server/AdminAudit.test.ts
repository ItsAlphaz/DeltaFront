import { describe, expect, it, vi } from "vitest";
import {
  reportAdminAction,
  type AdminActionReport,
} from "../../src/server/AdminAudit";

const report: AdminActionReport = {
  gameID: "abcd1234",
  actorPublicId: "9EKyqPa9rm",
  action: "game:command",
  targetClientID: "victim00",
  details: { command: "give_gold", amount: 500 },
};
const log = () => ({ info: vi.fn(), warn: vi.fn() });

describe("reportAdminAction", () => {
  it("posts the report to the API with the game server's key, and nothing secret in the body", async () => {
    const fetchFn = vi.fn(async () => new Response(null, { status: 204 }));
    const l = log();
    const ok = await reportAdminAction(report, {
      apiBase: "https://api.example.com",
      apiKey: "dfk_secret_key_value",
      fetchFn: fetchFn as unknown as typeof fetch,
      log: l,
    });
    expect(ok).toBe(true);
    const [url, init] = fetchFn.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe("https://api.example.com/game_admin/audit");
    expect((init.headers as Record<string, string>)["x-api-key"]).toBe(
      "dfk_secret_key_value",
    );
    expect(init.body).toBe(JSON.stringify(report));
    expect(String(init.body)).not.toContain("dfk_secret_key_value");
    // The game server's own log has the action too, and never the key.
    expect(JSON.stringify(l.info.mock.calls)).toContain("game:command");
    expect(
      JSON.stringify([l.info.mock.calls, l.warn.mock.calls]),
    ).not.toContain("dfk_secret_key_value");
  });

  it("an API that refuses or is down never throws: it is logged and reported as not delivered", async () => {
    const refused = log();
    expect(
      await reportAdminAction(report, {
        apiBase: "https://api.example.com",
        apiKey: "k",
        fetchFn: (async () =>
          new Response(null, { status: 401 })) as typeof fetch,
        log: refused,
      }),
    ).toBe(false);
    expect(refused.warn).toHaveBeenCalled();

    const down = log();
    expect(
      await reportAdminAction(report, {
        apiBase: "https://api.example.com",
        apiKey: "k",
        fetchFn: (async () => {
          throw new Error("ECONNREFUSED");
        }) as typeof fetch,
        log: down,
      }),
    ).toBe(false);
    expect(down.warn).toHaveBeenCalled();
  });

  it("a missing server setting degrades to a warning, never an exception", async () => {
    // DOMAIN and API_KEY are not set in the test environment.
    const l = log();
    await expect(
      reportAdminAction(report, {
        log: l,
        fetchFn: vi.fn() as unknown as typeof fetch,
      }),
    ).resolves.toBe(false);
    expect(l.warn).toHaveBeenCalled();
  });
});
