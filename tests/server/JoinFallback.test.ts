import type { TokenPayload } from "@openfront/shared/ApiSchemas";
import { describe, expect, it } from "vitest";
import {
  joinFallbackDecision,
  parseJoinFallback,
} from "../../src/server/JoinFallback";

const claims = (provider: string | undefined) =>
  ({ provider, sub: "x" }) as unknown as TokenPayload;

describe("the join fallback when the bot check is unreachable", () => {
  it("defaults to open in dev and to registered-only everywhere else", () => {
    expect(parseJoinFallback(undefined, true)).toBe("open");
    expect(parseJoinFallback("", false)).toBe("registered");
    expect(parseJoinFallback(undefined, false)).toBe("registered");
  });

  it("accepts the three policies and refuses anything else, loudly", () => {
    for (const p of ["open", "registered", "closed"] as const) {
      expect(parseJoinFallback(p, false)).toBe(p);
    }
    for (const bad of ["Open", "none", "true", "fail-open"]) {
      expect(() => parseJoinFallback(bad, false)).toThrow(/TURNSTILE_FALLBACK/);
    }
  });

  it("registered admits signed-in providers and refuses guests, unknown and missing providers", () => {
    for (const p of ["discord", "google", "email", "steam"]) {
      expect(joinFallbackDecision("registered", claims(p)), p).toBe("admit");
    }
    for (const c of [
      claims("guest"),
      claims(undefined),
      claims("other"),
      null,
    ]) {
      expect(joinFallbackDecision("registered", c)).toBe("deny");
    }
  });

  it("open admits everyone and closed admits no one", () => {
    expect(joinFallbackDecision("open", claims("guest"))).toBe("admit");
    expect(joinFallbackDecision("open", null)).toBe("admit");
    expect(joinFallbackDecision("closed", claims("discord"))).toBe("deny");
  });
});
