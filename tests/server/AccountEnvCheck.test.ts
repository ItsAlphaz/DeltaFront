import { allFeaturesOff } from "@openfront/shared/AccountFeatures";
import { describe, expect, it } from "vitest";
import {
  AccountEnvError,
  assertAccountBackendEnv,
} from "../../src/server/AccountEnvCheck";

const on = (...names: string[]) => ({
  ...allFeaturesOff(),
  ...Object.fromEntries(names.map((n) => [n, true])),
});

describe("the game server's startup check for account-backed operation", () => {
  it("does nothing while every account feature is off, with or without an API_KEY", () => {
    for (const env of [
      {},
      { API_KEY: "" },
      { API_KEY: "whatever-long-enough-key" },
    ]) {
      expect(() =>
        assertAccountBackendEnv({
          env,
          features: allFeaturesOff(),
          isDev: false,
        }),
      ).not.toThrow();
    }
  });

  it("refuses to start when a feature is on and API_KEY is missing, empty or blank", () => {
    for (const env of [{}, { API_KEY: "" }, { API_KEY: "   " }]) {
      const attempt = () =>
        assertAccountBackendEnv({
          env,
          features: on("accounts"),
          isDev: false,
        });
      expect(attempt).toThrow(AccountEnvError);
      expect(attempt).toThrow(
        /API_KEY is required when account features are enabled \(accounts\)/,
      );
    }
  });

  it("names every enabled feature and says how to fix it", () => {
    expect(() =>
      assertAccountBackendEnv({
        env: {},
        features: on("accounts", "leaderboards", "trustedLobbies"),
        isDev: true,
      }),
    ).toThrow(/\(accounts, leaderboards, trustedLobbies\).*server:key:create/s);
  });

  it("any one feature is enough to need the key", () => {
    for (const name of Object.keys(allFeaturesOff())) {
      expect(
        () =>
          assertAccountBackendEnv({
            env: {},
            features: on(name),
            isDev: false,
          }),
        name,
      ).toThrow(AccountEnvError);
    }
  });

  it("starts with a key present, and says nothing secret when it does not", () => {
    expect(() =>
      assertAccountBackendEnv({
        env: { API_KEY: "dfk_real-key-value" },
        features: on("accounts"),
        isDev: false,
      }),
    ).not.toThrow();
    try {
      assertAccountBackendEnv({
        env: { API_KEY: "   " },
        features: on("accounts"),
        isDev: false,
      });
    } catch (error) {
      expect(String(error)).not.toContain("dfk_");
    }
  });

  it("never prints the key, even when refusing a dev placeholder on a deployed server", () => {
    const secret = "WARNING_DEV_API_KEY_DO_NOT_USE_IN_PRODUCTION";
    const attempt = () =>
      assertAccountBackendEnv({
        env: { API_KEY: secret },
        features: on("accounts"),
        isDev: false,
      });
    expect(attempt).toThrow(AccountEnvError);
    expect(attempt).toThrow(/development placeholder key/);
    expect(attempt).not.toThrow(new RegExp(secret));
  });

  it("allows the dev placeholder on a dev server", () => {
    expect(() =>
      assertAccountBackendEnv({
        env: { API_KEY: "WARNING_DEV_API_KEY_DO_NOT_USE_IN_PRODUCTION" },
        features: on("accounts"),
        isDev: true,
      }),
    ).not.toThrow();
  });
});
