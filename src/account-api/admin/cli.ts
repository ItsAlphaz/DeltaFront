// Loaded first so .env is in process.env before anything reads it.
import "dotenv/config";

/**
 * The admin command line (plan section 15): ban, wallet and item grants, clan
 * and game fixes, server keys. Run over SSH on the API host as
 * `npm run admin -- <command>`.
 *
 * M0 is the entry point only. The commands arrive with the milestones whose
 * data they touch, starting with `user:*` and `server:key:*` in M1.
 */
const [command] = process.argv.slice(2);

if (command === undefined || command === "--help" || command === "help") {
  console.log(
    "DeltaFront account admin\n\nNo commands are available yet (they arrive in milestone M1).",
  );
  process.exit(0);
}

console.error(`unknown command "${command}" (no commands are available yet)`);
process.exit(2);
