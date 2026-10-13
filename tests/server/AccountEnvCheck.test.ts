import { allFeaturesOff } from "@openfront/shared/AccountFeatures";
import { describe, expect, it } from "vitest";
import {
  AccountEnvError,
  assertAccountBackendEnv,
} from "../../src/server/AccountEnvCheck";

const REAL_KEY = "dfk_Zk3p0Qm8VrT1uYb7Nc2LwXa9HdJe5GfS4iO6";
const DEPLOYED = {
  GAME_ENV: "prod",
  API_KEY: REAL_KEY,
  DOMAIN: "example.com",
  TURNSTILE_SITE_KEY: "0x4AAAAAAAsitekey",
};

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
        env: { ...DEPLOYED, API_KEY: REAL_KEY },
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

  describe("on a deployed server", () => {
    const check = (env: Record<string, string | undefined>, ...f: string[]) =>
      assertAccountBackendEnv({
        env,
        features: on(...f),
        isDev: false,
      });

    it("accepts the launch configuration", () => {
      expect(() =>
        check(
          { ...DEPLOYED, TURNSTILE_FALLBACK: "registered" },
          "accounts",
          "store",
          "inventory",
          "clans",
          "leaderboards",
        ),
      ).not.toThrow();
    });

    it("reports every problem at once, by name, never by value", () => {
      const secret = "changeme-short";
      let message = "";
      try {
        check(
          {
            GAME_ENV: "prod",
            API_KEY: secret,
            DOMAIN: "localhost",
            TURNSTILE_FALLBACK: "wide-open",
          },
          "accounts",
          "payments",
        );
      } catch (error) {
        message = String(error);
      }
      expect(message).toMatch(/API_KEY does not look like/);
      expect(message).toMatch(/DOMAIN must be the public site domain/);
      expect(message).toMatch(/TURNSTILE_SITE_KEY is required/);
      expect(message).toMatch(/TURNSTILE_FALLBACK must be one of/);
      expect(message).toMatch(/enables payments/);
      expect(message).not.toContain(secret);
    });

    it("refuses every feature outside the launch profile", () => {
      for (const name of [
        "ranked",
        "payments",
        "friends",
        "progression",
        "tribes",
        "trustedLobbies",
      ]) {
        expect(() => check(DEPLOYED, "accounts", name), name).toThrow(
          new RegExp(`enables ${name}`),
        );
      }
    });

    it("allows localhost for staging (a production-like local stack) but not prod", () => {
      const local = { ...DEPLOYED, DOMAIN: "localhost" };
      expect(() =>
        check({ ...local, GAME_ENV: "staging" }, "accounts"),
      ).not.toThrow();
      expect(() => check({ ...local, GAME_ENV: "prod" }, "accounts")).toThrow(
        /DOMAIN/,
      );
    });

    it("refuses a short or placeholder API key", () => {
      for (const API_KEY of [
        "short",
        "please-change-me-0123456789abcdefghijk",
      ]) {
        expect(() => check({ ...DEPLOYED, API_KEY }, "accounts")).toThrow(
          /API_KEY does not look like/,
        );
      }
    });
  });
});
