// Loaded first so .env is in process.env before anything reads it.
import "dotenv/config";

import { ConfigError, loadConfig } from "./config";
import { MigrationError } from "./db/migrator";
import { createLogger } from "./logger";
import { startAccountApi, StartupError } from "./service";

async function main(): Promise<void> {
  const config = loadConfig();
  const log = createLogger(config.logLevel);
  const service = await startAccountApi(config, log);

  let closing = false;
  const shutdown = (signal: string) => {
    if (closing) return;
    closing = true;
    log.info(`received ${signal}, shutting down`);
    service.close().then(
      () => process.exit(0),
      (error) => {
        log.error("error during shutdown", { error: String(error) });
        process.exit(1);
      },
    );
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((error) => {
  if (
    error instanceof ConfigError ||
    error instanceof StartupError ||
    error instanceof MigrationError
  ) {
    console.error(error.message);
  } else {
    console.error("account API failed to start:", error);
  }
  process.exit(1);
});
