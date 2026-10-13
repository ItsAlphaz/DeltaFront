import {
  buildTimeEmailAuth,
  buildTimeFeatureList,
} from "@openfront/shared/AccountFeatures";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Records which account features the client in `static/` was built with, as
 * `static/account-features.txt`. The game server compares it with its own
 * DF_ACCOUNT_FEATURES at start (src/server/AccountEnvCheck.ts,
 * assertBuildMatchesRuntime): a client that shows the store against a server
 * that has it switched off, or the other way round, is refused outside dev.
 *
 * Run by `npm run build-prod`, after vite, with the same environment.
 */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const value = buildTimeFeatureList(process.env.DF_ACCOUNT_FEATURES, true);
const emailAuth = buildTimeEmailAuth(process.env.DF_EMAIL_AUTH, true) === "1";
// Line 1: the feature list. Line 2: whether the sign-in screen offers email links.
fs.writeFileSync(
  path.join(root, "static/account-features.txt"),
  `${value}\nemail-auth=${emailAuth ? "on" : "off"}\n`,
);
console.log(`account features baked into this build: ${value || "(none)"}`);
console.log(`email sign-in baked into this build: ${emailAuth ? "on" : "off"}`);
