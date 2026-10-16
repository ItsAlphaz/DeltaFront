import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/client/Auth", () => ({
  getAuthHeader: vi.fn(async () => "Bearer t"),
}));
vi.mock("../../src/client/ApiBase", () => ({
  getApiBase: () => "https://api.test",
}));

import type { GameXpResponse } from "@openfront/shared/ApiSchemas";
import {
  reportSoloUpload,
  resetSoloUploads,
} from "../../src/client/SoloUpload";
import {
  fetchSoloStatus,
  pollSoloXp,
  SOLO_POLL_TIMEOUT_MS,
  SOLO_UNKNOWN_GRACE_MS,
  type SoloFetchResult,
  type SoloPhase,
} from "../../src/client/SoloXpApi";

const ID = "solo0001";
const ok = (
  status: "unknown" | "queued" | "verifying" | "paid" | "rejected",
  extra: Record<string, unknown> = {},
): SoloFetchResult => ({
  status: "ok",
  data: { gameId: ID, status, ...extra } as never,
});
const award = { gameId: ID, eligible: true } as unknown as GameXpResponse;

/** A fetcher that answers from a script (the last answer repeats) and counts its calls. */
function script(...answers: SoloFetchResult[]) {
  const calls: number[] = [];
  const fetcher = vi.fn(async () => {
    calls.push(Date.now());
    return answers.length > 1 ? answers.shift()! : answers[0];
  });
  return { fetcher, calls };
}

beforeEach(() => {
  vi.useFakeTimers();
  resetSoloUploads();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("pollSoloXp", () => {
  it("follows queued, verifying, then the award, and stops asking", async () => {
    reportSoloUpload(ID, { state: "queued" });
    const { fetcher } = script(
      ok("queued"),
      ok("verifying"),
      ok("paid", { result: award }),
    );
    const phases: SoloPhase[] = [];
    const done = pollSoloXp(ID, { fetcher, onPhase: (p) => phases.push(p) });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await done).toEqual({ kind: "result", data: award });
    expect(phases).toEqual(["queued", "verifying"]);
    // nothing more is asked once it has the answer
    const calls = fetcher.mock.calls.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetcher.mock.calls.length).toBe(calls);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a refusal is a conclusion with a reason the panel has words for", async () => {
    reportSoloUpload(ID, { state: "queued" });
    const refused = {
      gameId: ID,
      eligible: false,
      reason: "solo_unverified",
    } as GameXpResponse;
    const { fetcher } = script(
      ok("rejected", { reason: "desync", result: refused }),
    );
    expect(await pollSoloXp(ID, { fetcher })).toEqual({
      kind: "result",
      data: refused,
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("the API giving up on the replay is a failure, not a result, and cannot be retried", async () => {
    reportSoloUpload(ID, { state: "queued" });
    const { fetcher } = script(
      ok("rejected", {
        reason: "verify_failed",
        result: { gameId: ID, eligible: false, reason: "solo_unverified" },
      }),
    );
    expect(await pollSoloXp(ID, { fetcher })).toEqual({
      kind: "failed",
      failure: "verify_failed",
      retryable: false,
    });
  });

  it("a failed upload is reported at once, without asking the server, with a retry", async () => {
    reportSoloUpload(ID, { state: "failed", retryable: true, status: 503 });
    const { fetcher } = script(ok("unknown"));
    expect(await pollSoloXp(ID, { fetcher })).toEqual({
      kind: "failed",
      failure: "upload",
      retryable: true,
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("an upload the API refused cannot be retried; a 404 on it means the API has no route", async () => {
    reportSoloUpload(ID, { state: "failed", retryable: false, status: 400 });
    expect(
      await pollSoloXp(ID, { fetcher: script(ok("unknown")).fetcher }),
    ).toEqual({ kind: "failed", failure: "refused_upload", retryable: false });
    reportSoloUpload(ID, { state: "failed", retryable: false, status: 404 });
    expect(
      await pollSoloXp(ID, { fetcher: script(ok("unknown")).fetcher }),
    ).toEqual({ kind: "failed", failure: "unsupported", retryable: false });
  });

  it("a failure that happens while it waits ends the wait at once", async () => {
    reportSoloUpload(ID, { state: "uploading" });
    const { fetcher } = script(ok("unknown"));
    const done = pollSoloXp(ID, { fetcher });
    await vi.advanceTimersByTimeAsync(200);
    reportSoloUpload(ID, { state: "failed", retryable: true, status: null });
    await vi.advanceTimersByTimeAsync(0);
    expect(await done).toMatchObject({ kind: "failed", failure: "upload" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("a guest's upload is ignored: no XP, no waiting", async () => {
    reportSoloUpload(ID, { state: "ignored" });
    const { fetcher } = script(ok("unknown"));
    expect(await pollSoloXp(ID, { fetcher })).toEqual({
      kind: "result",
      data: { gameId: ID, eligible: false, reason: "guest" },
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("a 404 from the API (no such route) does not loop forever: two looks, then unsupported", async () => {
    reportSoloUpload(ID, { state: "queued" });
    const { fetcher } = script({ status: "missing" });
    const done = pollSoloXp(ID, { fetcher });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await done).toEqual({
      kind: "failed",
      failure: "unsupported",
      retryable: false,
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("a match the API says it never received, long after the upload, is lost: retry", async () => {
    reportSoloUpload(ID, { state: "queued" });
    const { fetcher } = script(ok("unknown"));
    const done = pollSoloXp(ID, { fetcher });
    await vi.advanceTimersByTimeAsync(SOLO_UNKNOWN_GRACE_MS + 6_000);
    expect(await done).toEqual({
      kind: "failed",
      failure: "upload",
      retryable: true,
    });
  });

  it("a transient error is waited out; several in a row are 'unreachable'", async () => {
    reportSoloUpload(ID, { state: "queued" });
    const flaky = script(
      { status: "error" },
      { status: "error" },
      ok("paid", { result: award }),
    );
    const a = pollSoloXp(ID, { fetcher: flaky.fetcher });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await a).toEqual({ kind: "result", data: award });

    const down = script({ status: "error" });
    const b = pollSoloXp(ID, { fetcher: down.fetcher });
    await vi.advanceTimersByTimeAsync(120_000);
    expect(await b).toEqual({
      kind: "failed",
      failure: "unreachable",
      retryable: true,
    });
    expect(down.fetcher.mock.calls.length).toBeLessThan(10);
  });

  it("an error then success resets the count", async () => {
    reportSoloUpload(ID, { state: "queued" });
    const answers: SoloFetchResult[] = [];
    for (let i = 0; i < 5; i++) {
      answers.push({ status: "error" }, ok("verifying"));
    }
    answers.push(ok("paid", { result: award }));
    const { fetcher } = script(...answers);
    const done = pollSoloXp(ID, { fetcher });
    await vi.advanceTimersByTimeAsync(300_000);
    expect(await done).toEqual({ kind: "result", data: award });
  });

  it("signed out ends it", async () => {
    reportSoloUpload(ID, { state: "queued" });
    expect(
      await pollSoloXp(ID, {
        fetcher: script({ status: "unavailable" }).fetcher,
      }),
    ).toEqual({ kind: "failed", failure: "signed_out", retryable: false });
  });

  it("is never endless: past the deadline it says it timed out, with a retry", async () => {
    reportSoloUpload(ID, { state: "queued" });
    const { fetcher, calls } = script(ok("verifying"));
    const done = pollSoloXp(ID, { fetcher });
    await vi.advanceTimersByTimeAsync(SOLO_POLL_TIMEOUT_MS + 5_000);
    expect(await done).toEqual({
      kind: "failed",
      failure: "timeout",
      retryable: true,
    });
    const n = calls.length;
    // bounded: a look every 3 s after the first few, for ten minutes
    expect(n).toBeLessThan(260);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(calls.length).toBe(n);
  });

  it("stops the moment it is aborted: no more requests, no timers left", async () => {
    reportSoloUpload(ID, { state: "queued" });
    const { fetcher } = script(ok("verifying"));
    const abort = new AbortController();
    const done = pollSoloXp(ID, { fetcher, signal: abort.signal });
    await vi.advanceTimersByTimeAsync(3_000);
    abort.abort();
    expect(await done).toEqual({ kind: "aborted" });
    const n = fetcher.mock.calls.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetcher.mock.calls.length).toBe(n);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("fetchSoloStatus", () => {
  const respond = (status: number, body: unknown = {}) =>
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify(body), { status })),
    );

  it("asks the solo route, not a multiplayer XP route", async () => {
    respond(200, { gameId: ID, status: "queued" });
    expect(await fetchSoloStatus(ID)).toMatchObject({ status: "ok" });
    const url = String(vi.mocked(fetch).mock.calls[0][0]);
    expect(url).toBe(`https://api.test/users/@me/solo/${ID}`);
    expect(url).not.toContain("/xp/");
  });

  it("tells a missing route (404), a refusal (401) and a server error apart", async () => {
    respond(404);
    expect(await fetchSoloStatus(ID)).toEqual({ status: "missing" });
    respond(401);
    expect(await fetchSoloStatus(ID)).toEqual({ status: "unavailable" });
    respond(502);
    expect(await fetchSoloStatus(ID)).toEqual({ status: "error" });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Promise.reject(new Error("offline"))),
    );
    expect(await fetchSoloStatus(ID)).toEqual({ status: "error" });
  });

  it("reads a status from a newer API as unknown instead of failing", async () => {
    respond(200, { gameId: ID, status: "teleporting" });
    expect(await fetchSoloStatus(ID)).toMatchObject({
      status: "ok",
      data: { status: "unknown" },
    });
  });
});
