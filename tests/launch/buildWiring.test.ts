// @vitest-environment node
import {
  buildTimeFeatureList,
  LAUNCH_FEATURES,
  LAUNCH_FEATURES_VALUE,
  resolveAccountFeatures,
  unfinishedFeatures,
} from "@openfront/shared/AccountFeatures";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  AccountEnvError,
  assertBuildMatchesRuntime,
} from "../../src/server/AccountEnvCheck";

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0))
    fs.rmSync(d, { recursive: true, force: true });
});
const staticWith = (content: string | null): string => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "df-static-"));
  dirs.push(d);
  if (content !== null)
    fs.writeFileSync(path.join(d, "account-features.txt"), content);
  return d;
};
const features = (value: string) => resolveAccountFeatures(value).features;

describe("the launch feature profile", () => {
  it("is accounts, store, inventory, clans and leaderboards, and nothing unfinished", () => {
    expect([...LAUNCH_FEATURES]).toEqual([
      "accounts",
      "store",
      "inventory",
      "clans",
      "leaderboards",
    ]);
    expect(LAUNCH_FEATURES_VALUE).toBe(
      "accounts,store,inventory,clans,leaderboards",
    );
    expect(unfinishedFeatures(features(LAUNCH_FEATURES_VALUE))).toEqual([]);
    for (const name of [
      "ranked",
      "payments",
      "friends",
      "progression",
      "tribes",
      "trustedLobbies",
    ]) {
      expect(unfinishedFeatures(features(`accounts,${name}`)), name).toEqual([
        name,
      ]);
    }
  });
});

describe("what the client build bakes in", () => {
  it("only known feature names, normalised, in the documented order", () => {
    expect(buildTimeFeatureList(" clans , accounts,,accounts ", true)).toBe(
      "accounts,clans",
    );
    expect(buildTimeFeatureList(undefined, true)).toBe("");
    expect(buildTimeFeatureList("", true)).toBe("");
  });

  it("an unknown name stops a production build, naming it, and is dropped in development", () => {
    expect(() => buildTimeFeatureList("accounts,stoer", true)).toThrow(
      /unknown feature "stoer"/,
    );
    expect(buildTimeFeatureList("accounts,stoer", false)).toBe("accounts");
  });

  it("never carries stray text from the variable into the bundle", () => {
    const hostile =
      "accounts,DATABASE_URL=postgres://u:secret@h/db,</script><script>alert(1)";
    expect(buildTimeFeatureList(hostile, false)).toBe("accounts");
    expect(() => buildTimeFeatureList(hostile, true)).toThrow();
    try {
      buildTimeFeatureList(hostile, true);
    } catch (error) {
      expect(String(error)).not.toContain("secret");
    }
    expect(buildTimeFeatureList("x".repeat(600), false)).toBe("");
  });

  it("the build script records exactly the baked value in static/account-features.txt", () => {
    const script = fs.readFileSync(
      path.join(ROOT, "scripts/writeBuildFeatures.ts"),
      "utf8",
    );
    expect(script).toContain(
      "buildTimeFeatureList(process.env.DF_ACCOUNT_FEATURES, true)",
    );
    expect(script).toContain("account-features.txt");
    const pkg = JSON.parse(
      fs.readFileSync(path.join(ROOT, "package.json"), "utf8"),
    );
    expect(pkg.scripts["build-prod"]).toMatch(/writeBuildFeatures\.ts/);
    expect(pkg.scripts["launch:check"]).toBe("tsx scripts/launch/cli.ts");
  });

  it("the production Docker build takes the flags as a build argument and carries them to runtime", () => {
    const dockerfile = fs.readFileSync(path.join(ROOT, "Dockerfile"), "utf8");
    const buildStage = dockerfile.slice(
      dockerfile.indexOf("AS build"),
      dockerfile.indexOf("AS prod-deps"),
    );
    expect(buildStage).toMatch(/ARG DF_ACCOUNT_FEATURES/);
    expect(buildStage.indexOf("ARG DF_ACCOUNT_FEATURES")).toBeLessThan(
      buildStage.indexOf("RUN npm run build-prod"),
    );
    expect(buildStage).toMatch(
      /ENV DF_ACCOUNT_FEATURES="\$DF_ACCOUNT_FEATURES"/,
    );
    const finalStage = dockerfile.slice(dockerfile.lastIndexOf("FROM base"));
    expect(finalStage).toMatch(/ARG DF_ACCOUNT_FEATURES/);
    expect(finalStage).toMatch(/ENV DF_ACCOUNT_FEATURES=/);
    // Nothing secret is ever a build argument.
    expect(dockerfile).not.toMatch(
      /ARG (API_KEY|DATABASE_URL|TURNSTILE_SECRET|JWT|DISCORD_CLIENT_SECRET|GOOGLE_CLIENT_SECRET)/,
    );
    expect(dockerfile).not.toMatch(/openfront\.dev/);
  });
});

describe("the server refuses a client built with different features", () => {
  const check = (
    staticDir: string,
    runtime: string,
    env: "dev" | "staging" | "prod",
    warn: string[] = [],
  ) =>
    assertBuildMatchesRuntime({
      staticDir,
      features: features(runtime),
      env,
      warn: (m) => warn.push(m),
    });

  it("accepts a match, in any order of listing", () => {
    expect(() =>
      check(staticWith("accounts,clans\n"), "clans,accounts", "prod"),
    ).not.toThrow();
    expect(() =>
      check(
        staticWith(`${LAUNCH_FEATURES_VALUE}\n`),
        LAUNCH_FEATURES_VALUE,
        "prod",
      ),
    ).not.toThrow();
  });

  it("refuses a client with the store when the server has it off, and the reverse", () => {
    expect(() =>
      check(staticWith("accounts,store\n"), "accounts", "prod"),
    ).toThrow(AccountEnvError);
    expect(() =>
      check(staticWith("accounts\n"), "accounts,store", "staging"),
    ).toThrow(
      /built with DF_ACCOUNT_FEATURES=accounts but this server runs with accounts,store/,
    );
    // the empty client against a server with features: the Docker bug this guards
    expect(() =>
      check(staticWith("\n"), LAUNCH_FEATURES_VALUE, "prod"),
    ).toThrow(/\(none\)/);
  });

  it("a missing record is refused in prod and reported in staging", () => {
    expect(() => check(staticWith(null), "accounts", "prod")).toThrow(
      /account-features\.txt is missing/,
    );
    const warnings: string[] = [];
    check(staticWith(null), "accounts", "staging", warnings);
    expect(warnings).toHaveLength(1);
  });

  it("does nothing in dev, where Vite serves the page", () => {
    expect(() =>
      check(staticWith("accounts,store\n"), "", "dev"),
    ).not.toThrow();
  });
});

describe("a real production build of the flag plumbing", () => {
  it("vite defines only the sanitised list (checked by evaluating the config helper in a child process)", () => {
    const out = execFileSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "-e",
        `import { buildTimeFeatureList } from "./packages/shared/src/AccountFeatures.ts"; console.log(buildTimeFeatureList(process.env.DF_ACCOUNT_FEATURES, true));`,
      ],
      {
        cwd: ROOT,
        env: { ...process.env, DF_ACCOUNT_FEATURES: " store, accounts " },
        encoding: "utf8",
      },
    );
    expect(out.trim()).toBe(
      "accounts,store"
        .split(",")
        .sort(
          (a, b) =>
            ["accounts", "store"].indexOf(a) - ["accounts", "store"].indexOf(b),
        )
        .join(","),
    );
  });
});
