import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { getAuthHeader } = vi.hoisted(() => ({
  getAuthHeader: vi.fn(async () => "Bearer test-jwt"),
}));
vi.mock("../../src/client/Auth", () => ({ getAuthHeader }));
vi.mock("../../src/client/ApiBase", () => ({
  getApiBase: () => "https://api.example.com",
}));

import { adminApi } from "../../src/client/AdminApi";

const respond = (status: number, body: unknown) =>
  vi.fn(async () => new Response(JSON.stringify(body), { status }));

describe("adminApi", () => {
  beforeEach(() => {
    getAuthHeader.mockResolvedValue("Bearer test-jwt");
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends the session in the Authorization header, never a cookie, and never a role", async () => {
    const fetchMock = respond(200, {
      publicId: "P",
      role: "mod",
      permissions: [],
    });
    vi.stubGlobal("fetch", fetchMock);
    const r = await adminApi.me();
    expect(r).toEqual({
      ok: true,
      data: { publicId: "P", role: "mod", permissions: [] },
    });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe("https://api.example.com/admin/me");
    expect((init.headers as Record<string, string>).authorization).toBe(
      "Bearer test-jwt",
    );
    expect(init.credentials).toBeUndefined();
    expect(String(init.body ?? "")).not.toMatch(/role/);
  });

  it("makes no request at all when signed out", async () => {
    getAuthHeader.mockResolvedValue("");
    const fetchMock = respond(200, {});
    vi.stubGlobal("fetch", fetchMock);
    const r = await adminApi.users("x");
    expect(r).toEqual({ ok: false, status: 401, error: "unauthorized" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("passes a refusal through with its code and status", async () => {
    vi.stubGlobal(
      "fetch",
      respond(403, { error: "TARGET_PROTECTED", message: "no" }),
    );
    expect(await adminApi.setVerified("TARGET0001", true, "r")).toEqual({
      ok: false,
      status: 403,
      error: "TARGET_PROTECTED",
      message: "no",
    });
  });

  it("treats a malformed success body as a failure, not as data", async () => {
    vi.stubGlobal("fetch", respond(200, { unexpected: true }));
    const r = await adminApi.dashboard();
    expect(r).toMatchObject({ ok: false, error: "bad_response" });
  });

  it("a network failure is a failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("offline");
      }),
    );
    expect(await adminApi.me()).toMatchObject({
      ok: false,
      status: 0,
      error: "network",
    });
  });

  it("destructive calls carry the explicit confirmation; plain grants do not", async () => {
    const fetchMock = respond(200, { ok: true, message: "done" });
    vi.stubGlobal("fetch", fetchMock);
    const body = (i: number) =>
      JSON.parse(
        String(
          (fetchMock.mock.calls[i] as unknown as [string, RequestInit])[1].body,
        ),
      );
    await adminApi.ban("TARGET0001", "cheating", 7, "r");
    await adminApi.revokeSessions("TARGET0001", "r");
    await adminApi.credits("TARGET0001", 50, "r");
    await adminApi.credits("TARGET0001", -50, "r");
    await adminApi.clanDelete("DELTA", "r");
    expect(body(0)).toMatchObject({
      confirm: true,
      days: 7,
      category: "cheating",
    });
    expect(body(1)).toMatchObject({ confirm: true });
    expect(body(2).confirm).toBeUndefined();
    expect(body(3)).toMatchObject({ confirm: true, amount: -50 });
    expect(body(4)).toMatchObject({ confirm: true });
  });

  it("encodes what it puts in a path or query", async () => {
    const fetchMock = respond(200, { users: [] });
    vi.stubGlobal("fetch", fetchMock);
    await adminApi.users("a b&role=owner");
    expect((fetchMock.mock.calls[0] as unknown as [string])[0]).toBe(
      "https://api.example.com/admin/users?q=a%20b%26role%3Downer",
    );
  });
});
