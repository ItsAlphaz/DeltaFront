// @vitest-environment node
import {
  ACCOUNT_FEATURE_NAMES,
  ACCOUNT_FEATURES,
  ACCOUNT_FEATURES_ENV,
  allFeaturesOff,
  AUTH_PROVIDERS,
  parseAccountFeatureOverride,
  resolveAccountFeatures,
  usesAccountApi,
} from "@openfront/shared/AccountFeatures";
import { describe, expect, it } from "vitest";

describe("the account feature flags", () => {
  it("are the eleven documented ones", () => {
    expect([...ACCOUNT_FEATURE_NAMES]).toEqual([
      "accounts",
      "store",
      "inventory",
      "ranked",
      "clans",
      "leaderboards",
      "payments",
      "friends",
      "progression",
      "tribes",
      "trustedLobbies",
    ]);
    expect(ACCOUNT_FEATURES_ENV).toBe("DF_ACCOUNT_FEATURES");
  });

  it("allFeaturesOff has exactly those keys, all false, as a fresh object each time", () => {
    const off = allFeaturesOff();
    expect(Object.keys(off).sort()).toEqual([...ACCOUNT_FEATURE_NAMES].sort());
    expect(Object.values(off).every((v) => v === false)).toBe(true);
    off.accounts = true;
    expect(allFeaturesOff().accounts).toBe(false);
  });

  it("ship all off: the real object, as the code loaded it, with nothing in the environment", () => {
    // Captured by tests/setup.ts before it turns the flags on for the suite.
    const shipped = (globalThis as Record<string, unknown>)
      .__SHIPPED_ACCOUNT_FEATURES__;
    expect(shipped).toEqual(allFeaturesOff());
  });

  it("usesAccountApi is true as soon as any one flag is on", () => {
    expect(usesAccountApi(allFeaturesOff())).toBe(false);
    for (const name of ACCOUNT_FEATURE_NAMES) {
      expect(usesAccountApi({ ...allFeaturesOff(), [name]: true }), name).toBe(
        true,
      );
    }
  });

  it("the test setup turns every flag on, so the inherited suite exercises the full product", () => {
    for (const name of ACCOUNT_FEATURE_NAMES) {
      expect(ACCOUNT_FEATURES[name], name).toBe(true);
    }
  });
});

describe("parseAccountFeatureOverride", () => {
  const enabled = (raw: unknown) => parseAccountFeatureOverride(raw).enabled;
  const rejected = (raw: unknown) => parseAccountFeatureOverride(raw).rejected;

  it("enables nothing when unset, empty or blank", () => {
    for (const raw of [undefined, null, "", "   ", ",", " , ,, "]) {
      expect(parseAccountFeatureOverride(raw), JSON.stringify(raw)).toEqual({
        enabled: [],
        rejected: [],
      });
    }
  });

  it("enables each known flag, and only that one", () => {
    for (const name of ACCOUNT_FEATURE_NAMES) {
      expect(enabled(name), name).toEqual([name]);
      const { features } = resolveAccountFeatures(name);
      expect(
        ACCOUNT_FEATURE_NAMES.filter((n) => features[n]),
        name,
      ).toEqual([name]);
    }
  });

  it("reads a comma-separated list, in the documented order, once each", () => {
    expect(enabled("store,accounts")).toEqual(["accounts", "store"]);
    expect(enabled("clans,clans,clans")).toEqual(["clans"]);
    expect(enabled("accounts,leaderboards,inventory,store,clans")).toEqual([
      "accounts",
      "store",
      "inventory",
      "clans",
      "leaderboards",
    ]);
  });

  it("tolerates whitespace, empty tokens and a trailing comma", () => {
    expect(enabled(" accounts ,, store ,")).toEqual(["accounts", "store"]);
    expect(rejected(" accounts ,, store ,")).toEqual([]);
  });

  it("never enables an unknown name, and reports it", () => {
    expect(parseAccountFeatureOverride("accounts,stroe,nope")).toEqual({
      enabled: ["accounts"],
      rejected: ["stroe", "nope"],
    });
    expect(enabled("stroe")).toEqual([]);
  });

  it("is case-sensitive: a near miss is rejected, not guessed at", () => {
    expect(
      parseAccountFeatureOverride("Accounts,STORE,trustedlobbies"),
    ).toEqual({
      enabled: [],
      rejected: ["Accounts", "STORE", "trustedlobbies"],
    });
    expect(enabled("trustedLobbies")).toEqual(["trustedLobbies"]);
  });

  it("has no wildcard and no way to switch a flag off", () => {
    for (const token of [
      "all",
      "*",
      "true",
      "1",
      "on",
      "everything",
      "-accounts",
      "!store",
      "accounts=false",
      "accounts:false",
    ]) {
      expect(enabled(token), token).toEqual([]);
      expect(rejected(token), token).toEqual([token]);
    }
  });

  it("treats object-prototype names as unknown, and cannot pollute anything", () => {
    for (const token of [
      "__proto__",
      "constructor",
      "prototype",
      "toString",
      "hasOwnProperty",
      "valueOf",
    ]) {
      expect(enabled(token), token).toEqual([]);
      expect(rejected(token), token).toEqual([token]);
      const { features } = resolveAccountFeatures(token);
      expect(Object.keys(features).sort()).toEqual(
        [...ACCOUNT_FEATURE_NAMES].sort(),
      );
    }
    expect(({} as Record<string, unknown>).accounts).toBeUndefined();
  });

  it("does not split on anything but a comma", () => {
    expect(enabled("accounts store")).toEqual([]);
    expect(rejected("accounts store")).toEqual(["accounts store"]);
    expect(enabled("accounts;store|clans")).toEqual([]);
  });

  it("rejects a value that is not a string", () => {
    for (const raw of [true, 1, {}, ["accounts"], () => "accounts"]) {
      expect(enabled(raw), String(raw)).toEqual([]);
      expect(rejected(raw).length, String(raw)).toBe(1);
    }
  });

  it("rejects an absurdly long value whole, even if it starts with a real flag", () => {
    const raw = `accounts,${"x".repeat(600)}`;
    expect(enabled(raw)).toEqual([]);
    expect(rejected(raw)).toHaveLength(1);
  });
});

describe("resolveAccountFeatures", () => {
  it("returns every flag as a boolean, off unless named", () => {
    const { features, rejected } = resolveAccountFeatures(
      "accounts,leaderboards",
    );
    expect(features).toEqual({
      ...allFeaturesOff(),
      accounts: true,
      leaderboards: true,
    });
    expect(rejected).toEqual([]);
  });

  it("unset means every flag off", () => {
    expect(resolveAccountFeatures(undefined).features).toEqual(
      allFeaturesOff(),
    );
  });

  it("a garbage value switches nothing on", () => {
    const { features, rejected } = resolveAccountFeatures("}{garbage,;;;");
    expect(features).toEqual(allFeaturesOff());
    expect(rejected.length).toBeGreaterThan(0);
  });
});

describe("AUTH_PROVIDERS", () => {
  it("is Discord and Google only (decision D3), and cannot be changed at runtime", () => {
    expect(AUTH_PROVIDERS).toEqual({
      discord: true,
      google: true,
      email: false,
      steam: false,
    });
    expect(Object.isFrozen(AUTH_PROVIDERS)).toBe(true);
  });
});
