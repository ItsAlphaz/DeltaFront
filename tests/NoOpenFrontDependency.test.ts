import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * DeltaFront runs on its own infrastructure. The OpenFront client and game
 * server were written against OpenFront's closed account API; the
 * DeltaFront-owned backend replaces it, so no code may point at OpenFront's
 * hosts. The API base is derived from the deployment's own DOMAIN
 * (src/client/ApiBase.ts, src/server/ServerEnv.ts), never a fixed host.
 *
 * Comments may still mention them (they document upstream behaviour); only
 * code, strings and markup count.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OPENFRONT_HOST = /openfront\.(io|dev)\b|api\.openfront|openfrontio\.com/i;

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(path.join(ROOT, dir), {
    withFileTypes: true,
  })) {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) walk(rel, out);
    else if (/\.(ts|js|mjs|html)$/.test(entry.name)) out.push(rel);
  }
  return out;
}

function codeLinesMentioningOpenFront(file: string): string[] {
  const hits: string[] = [];
  fs.readFileSync(path.join(ROOT, file), "utf8")
    .split("\n")
    .forEach((line, index) => {
      const trimmed = line.trim();
      if (/^(\/\/|\/\*|\*|<!--|#)/.test(trimmed)) return;
      const code = line.replace(/\s\/\/.*$/, "");
      if (OPENFRONT_HOST.test(code))
        hits.push(`${file}:${index + 1}: ${trimmed.slice(0, 100)}`);
    });
  return hits;
}

describe("no dependency on OpenFront's infrastructure", () => {
  const files = [
    ...walk("src"),
    ...fs
      .readdirSync(path.join(ROOT, "packages"))
      .flatMap((pkg) =>
        fs.existsSync(path.join(ROOT, "packages", pkg, "src"))
          ? walk(`packages/${pkg}/src`)
          : [],
      ),
    "index.html",
  ];

  it("no source file, template or the account API contains an OpenFront host outside a comment", () => {
    expect(files.length).toBeGreaterThan(100);
    expect(files.flatMap(codeLinesMentioningOpenFront)).toEqual([]);
  });

  it("the account API itself never names one, even in comments", () => {
    for (const file of walk("src/account-api")) {
      expect(fs.readFileSync(path.join(ROOT, file), "utf8"), file).not.toMatch(
        OPENFRONT_HOST,
      );
    }
  });

  it("the check can see a violation", () => {
    const sample = [
      'const base = "https://api.openfront.io";',
      'fetch("https://blue.openfront.dev/x")',
    ];
    for (const line of sample) expect(OPENFRONT_HOST.test(line)).toBe(true);
    expect(OPENFRONT_HOST.test("// see openfront.io")).toBe(true); // matched; comments are filtered by the caller
  });
});
