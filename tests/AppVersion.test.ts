// @vitest-environment node
import fs from "fs";
import path from "path";
import { describe, expect, it } from "vitest";
import { APP_VERSION } from "../src/client/AppVersion";

const root = path.join(__dirname, "..");
const readJson = (file: string) =>
  JSON.parse(fs.readFileSync(path.join(root, file), "utf8"));

// The game version lives in exactly one place -- package.json's "version" --
// and everything else (the nav bar, the news-seen key, production builds)
// derives from it. See docs/Deployment.md "Releasing a version".
describe("app version", () => {
  const pkg = readJson("package.json");

  it("is a plain MAJOR.MINOR.PATCH in package.json", () => {
    expect(pkg.version).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("is what the client bundle is built with", () => {
    expect(APP_VERSION).toBe(pkg.version);
  });

  it("agrees with package-lock.json", () => {
    const lock = readJson("package-lock.json");
    expect(lock.version).toBe(pkg.version);
    expect(lock.packages[""].version).toBe(pkg.version);
  });

  it("has no second copy in resources/version.txt", () => {
    expect(fs.existsSync(path.join(root, "resources/version.txt"))).toBe(false);
  });
});
