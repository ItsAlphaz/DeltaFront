// First, so .env is in process.env before any module below is evaluated:
// packages/shared/src/AccountFeatures.ts reads DF_ACCOUNT_FEATURES once, when
// it is imported, and the client build reads the same .env through Vite.
import "dotenv/config";

import { GameEnv } from "@openfront/shared/configuration/Env";
import cluster from "cluster";
import * as dotenv from "dotenv";
import { AccountEnvError, assertAccountBackendEnv } from "./AccountEnvCheck";
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
  if (error instanceof AccountEnvError) {
    console.error(`Failed to start server: ${error.message}`);
    process.exit(1);
  }
  console.error("Failed to start server:", error);
  process.exit(1);
});
