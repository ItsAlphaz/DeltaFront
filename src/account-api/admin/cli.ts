// Loaded first so .env is in process.env before anything reads it.
import "dotenv/config";

import os from "node:os";
import { ConfigError, loadDatabaseConfig } from "../config";
import { createPool } from "../db/pool";
import { createLogger } from "../logger";
import { runAdminCommand } from "./commands";

/**
 * The admin command line (plan section 15), run on the API host as
 * `npm run admin -- <command>`. Needs only DATABASE_URL.
 */
async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  // Help needs no database.
  if (argv.length === 0 || argv[0] === "help" || argv[0] === "--help") {
    return runAdminCommand(null as never, argv, io);
  }
  const pool = createPool(loadDatabaseConfig(), createLogger("error"));
  try {
    return await runAdminCommand(pool, argv, io);
  } finally {
    await pool.end();
  }
}

const io = {
  out: (line: string) => console.log(line),
  err: (line: string) => console.error(line),
  env: process.env,
  actor: process.env.SUDO_USER ?? process.env.USER ?? os.userInfo().username,
};

main().then(
  (code) => process.exit(code),
  (error) => {
    console.error(
      error instanceof ConfigError
        ? error.message
        : `admin command failed: ${String(error)}`,
    );
    process.exit(1);
  },
);
