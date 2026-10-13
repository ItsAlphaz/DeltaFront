// First, so .env is in process.env before any module below is evaluated:
// packages/shared/src/AccountFeatures.ts reads DF_ACCOUNT_FEATURES once, when
// it is imported, and the client build reads the same .env through Vite.
import "dotenv/config";

import { AUTH_PROVIDERS } from "@openfront/shared/AccountFeatures";
import { GameEnv } from "@openfront/shared/configuration/Env";
import cluster from "cluster";
import * as dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  AccountEnvError,
  assertAccountBackendEnv,
  assertBuildMatchesRuntime,
} from "./AccountEnvCheck";
import { assertLegalPagesFinal, LegalPagesError } from "./LegalGate";
import { startMaster } from "./Master";
import { ServerEnv } from "./ServerEnv";
import { startWorker } from "./Worker";

// Load environment variables before we read configuration values derived from them.
dotenv.config();

// Main entry point of the application
async function main() {
  // Refuse to start, with a clear message, when account features are on but
  // the server could not authenticate to the account API.
  assertAccountBackendEnv({ isDev: ServerEnv.env() === GameEnv.Dev });
  // Placeholder legal pages must not go public unnoticed (only the primary
  // checks, so the workers do not repeat the warning).
  if (cluster.isPrimary) {
    const staticDir = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      "../../static",
    );
    const env = ServerEnv.gameEnvName() as "dev" | "staging" | "prod";
    assertBuildMatchesRuntime({
      staticDir,
      env,
      warn: (message) => console.warn(message),
    });
    assertLegalPagesFinal({
      staticDir,
      env: ServerEnv.gameEnvName() as "dev" | "staging" | "prod",
      allowPlaceholders: process.env.ALLOW_PLACEHOLDER_LEGAL_PAGES === "1",
      emailAuth: AUTH_PROVIDERS.email,
      warn: (message) => console.warn(message),
    });
  }

  if (cluster.isPrimary) {
    console.log("Starting master process...");
    await startMaster();
  } else {
    // This is a worker process
    console.log("Starting worker process...");
    await startWorker();
  }
}

// Start the application
main().catch((error) => {
  if (error instanceof AccountEnvError || error instanceof LegalPagesError) {
    console.error(`Failed to start server: ${error.message}`);
    process.exit(1);
  }
  console.error("Failed to start server:", error);
  process.exit(1);
});
