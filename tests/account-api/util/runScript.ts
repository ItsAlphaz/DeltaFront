import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Runs the account API's real entry points as processes, with a clean
 * environment and an empty working directory, so neither the host shell nor a
 * developer's .env can change the outcome.
 */

export const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const TSX = path.join(ROOT, "node_modules", ".bin", "tsx");

export function makeWorkDir(): { dir: string; remove(): void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "df-account-"));
  return {
    dir,
    remove: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

function childFor(
  workDir: string,
  script: string,
  args: string[],
  env: Record<string, string>,
): ChildProcess {
  return spawn(TSX, [path.join(ROOT, script), ...args], {
    cwd: workDir,
    env: { PATH: process.env.PATH ?? "", HOME: workDir, ...env },
  });
}

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Runs a script to completion. */
export function runScript(
  workDir: string,
  script: string,
  args: string[],
  env: Record<string, string>,
  timeoutMs = 45_000,
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = childFor(workDir, script, args, env);
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d) => (stdout += d));
    child.stderr?.on("data", (d) => (stderr += d));
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`timed out: ${script}\n${stdout}\n${stderr}`));
    }, timeoutMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

/** Starts a long-running script; resolve `exited` after you signal it. */
export function startScript(
  workDir: string,
  script: string,
  env: Record<string, string>,
): { child: ChildProcess; output(): string; exited: Promise<number | null> } {
  const child = childFor(workDir, script, [], env);
  let output = "";
  child.stdout?.on("data", (d) => (output += d));
  child.stderr?.on("data", (d) => (output += d));
  const exited = new Promise<number | null>((resolve) =>
    child.on("close", (code) => resolve(code)),
  );
  return { child, output: () => output, exited };
}
