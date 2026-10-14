import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Which release this API process is: the semantic version (package.json, the
 * one place it is defined) and the Git commit, for the admin dashboard. Read
 * once and cached; every failure is "unknown" (null), never an error: a
 * dashboard label must not be able to break the API.
 */

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);

export interface BuildInfo {
  version: string;
  commit: string | null;
}

let cached: BuildInfo | undefined;

export function getBuildInfo(
  env: Record<string, string | undefined> = process.env,
): BuildInfo {
  if (cached !== undefined) return cached;
  let version = "unknown";
  try {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(ROOT, "package.json"), "utf8"),
    ) as { version?: unknown };
    if (typeof pkg.version === "string") version = pkg.version;
  } catch {
    // keep "unknown"
  }
  let commit: string | null = /^[0-9a-f]{7,40}$/i.test(env.GIT_COMMIT ?? "")
    ? (env.GIT_COMMIT as string)
    : null;
  if (commit === null) {
    try {
      const out = execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: ROOT,
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 2000,
      })
        .toString()
        .trim();
      if (/^[0-9a-f]{40}$/i.test(out)) commit = out;
    } catch {
      // not a git checkout, or git is absent
    }
  }
  cached = { version, commit };
  return cached;
}
