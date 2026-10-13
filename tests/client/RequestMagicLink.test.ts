import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { requestMagicLink, sendMagicLink } from "../../src/client/Auth";
import { ClientEnv } from "../../src/client/ClientEnv";

const respond = (status: number, body?: unknown) =>
  new Response(body === undefined ? null : JSON.stringify(body), { status });

describe("requestMagicLink", () => {
  const fetchSpy = vi.fn();
  beforeEach(() => {
    fetchSpy.mockReset();
    vi.stubGlobal("fetch", fetchSpy);
    (window as any).BOOTSTRAP_CONFIG = {
      gameEnv: "prod",
      numWorkers: 1,
      turnstileSiteKey: "x",
      jwtAudience: "localhost",
      instanceId: "test",
      gitCommit: "test",
    };
    ClientEnv.reset();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    delete (window as any).BOOTSTRAP_CONFIG;
    ClientEnv.reset();
  });

  it("posts the address and the site's own origin, with the cookie, as JSON", async () => {
    fetchSpy.mockResolvedValue(respond(204));
    await requestMagicLink("ann@example.com");
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toMatch(/\/auth\/magic-link$/);
    expect(init).toMatchObject({ method: "POST", credentials: "include" });
    expect(JSON.parse(init.body)).toEqual({
      email: "ann@example.com",
      redirectDomain: window.location.origin,
    });
  });

  it("maps each answer: 204 sent, 400 invalid_email, 429 rate_limited, anything else failed", async () => {
    const cases: Array<[Response, string]> = [
      [respond(204), "sent"],
      [respond(200), "sent"],
      [respond(400, { code: "invalid_email" }), "invalid_email"],
      [respond(400, { code: "invalid_redirect_domain" }), "failed"],
      [respond(400), "failed"],
      [respond(429, { error: "rate_limited" }), "rate_limited"],
      [respond(503, { code: "delivery_failed" }), "failed"],
      [respond(404), "failed"],
      [respond(500), "failed"],
    ];
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    for (const [response, status] of cases) {
      fetchSpy.mockResolvedValueOnce(response);
      expect((await requestMagicLink("ann@example.com")).status).toBe(status);
    }
  });

  it("a network failure is `failed`, never a throw", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    fetchSpy.mockRejectedValue(new TypeError("Failed to fetch"));
    expect(await requestMagicLink("ann@example.com")).toEqual({
      status: "failed",
    });
  });

  it("sendMagicLink stays a boolean for older callers", async () => {
    fetchSpy.mockResolvedValueOnce(respond(204));
    expect(await sendMagicLink("ann@example.com")).toBe(true);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    fetchSpy.mockResolvedValueOnce(respond(429));
    expect(await sendMagicLink("ann@example.com")).toBe(false);
  });
});
