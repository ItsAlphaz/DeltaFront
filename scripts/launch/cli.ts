// Loaded first so .env is in process.env before anything reads it.
import "dotenv/config";

import path from "node:path";
import { fileURLToPath } from "node:url";
import { formatReport, runLaunchChecks } from "./launchCheck";

/**
 * npm run launch:check [-- --json] [--probe] [--no-database] [--allow-staging]
 *
 * Exit status: 0 when nothing failed (warnings are listed but do not fail),
 * 1 when at least one check failed, 2 on a usage error.
 */
const args = new Set(process.argv.slice(2));
const known = new Set([
  "--json",
  "--probe",
  "--no-database",
  "--allow-staging",
]);
const unknown = [...args].filter((a) => !known.has(a));
if (unknown.length > 0) {
  console.error(
    `unknown option ${unknown[0]} (use --json, --probe, --no-database, --allow-staging)`,
  );
  process.exit(2);
}

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const report = await runLaunchChecks({
  env: process.env,
  root,
  database: args.has("--no-database") ? false : undefined,
  probe: args.has("--probe"),
  allowStaging: args.has("--allow-staging"),
});
console.log(
  args.has("--json") ? JSON.stringify(report, null, 2) : formatReport(report),
);
process.exit(report.failed === 0 ? 0 : 1);
