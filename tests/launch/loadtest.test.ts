// @vitest-environment node
import { describe, expect, it } from "vitest";
import { percentile, summarize } from "../../scripts/launch/loadtest";

describe("the load-test summary", () => {
  it("computes nearest-rank percentiles", () => {
    const ms = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(percentile(ms, 50)).toBe(50);
    expect(percentile(ms, 95)).toBe(95);
    expect(percentile(ms, 99)).toBe(99);
    expect(percentile(ms, 100)).toBe(100);
    expect(percentile([], 95)).toBe(0);
    expect(percentile([7], 99)).toBe(7);
  });

  it("splits successes, rate limits and failures per route", () => {
    const samples = [
      { route: "a", status: 200, ms: 10 },
      { route: "a", status: 200, ms: 30 },
      { route: "a", status: 429, ms: 2 },
      { route: "a", status: 503, ms: 100 },
      { route: "a", status: 0, ms: 5000 },
      { route: "b", status: 200, ms: 4 },
    ];
    const [a, b] = summarize(samples, 2);
    expect(a).toMatchObject({
      route: "a",
      requests: 5,
      perSecond: 2.5,
      ok: 2,
      limited: 1,
      failed: 2,
      max: 5000,
    });
    expect(b).toMatchObject({
      route: "b",
      requests: 1,
      ok: 1,
      limited: 0,
      failed: 0,
      p50: 4,
    });
  });
});
