// Loaded first so the environment file is read before anything else.
import "dotenv/config";

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Pool } from "pg";
import { loadMigrationFiles } from "../../src/account-api/db/migrator";
import {
  BackupConfigError,
  buildBackupPlan,
  buildRestoreDrillPlan,
  describeBackupConfig,
  latestBackup,
  loadBackupConfig,
  planToText,
  runBackup,
  runRestoreDrill,
  verifyChecksum,
} from "./backup";

const exec = promisify(execFile);

/**
 * npm run backup:run                       nightly backup (systemd timer)
 * npm run backup:run -- --dry-run          show the steps, change nothing
 * npm run backup:drill -- [file] [--identity /path/to/age-identity.txt]
 *                                          restore the newest (or the given)
 *                                          backup into a scratch database
 *                                          and check it, then drop it
 * npm run backup:drill -- --dry-run        show the drill's steps
 *
 * Secrets are never printed: the plan shows variable names, not values.
 */
async function main(): Promise<number> {
  const [command, ...rest] = process.argv.slice(2);
  const dryRun = rest.includes("--dry-run");
  const config = loadBackupConfig();

  if (command === "run") {
    if (dryRun) {
      console.log(JSON.stringify(describeBackupConfig(config), null, 2));
      console.log(planToText(buildBackupPlan(config, new Date()).steps));
      return 0;
    }
    const remote = config.remote;
    const result = await runBackup(config, {
      listRemote:
        remote === null
          ? undefined
          : async () =>
              (await exec("rclone", ["lsf", "--files-only", remote])).stdout
                .split("\n")
                .filter(Boolean),
      removeRemote:
        remote === null
          ? undefined
          : async (name) => {
              await exec("rclone", [
                "deletefile",
                `${remote.replace(/\/$/, "")}/${name}`,
              ]);
            },
    });
    console.log(
      JSON.stringify({
        event: "backup_done",
        file: result.fileName,
        bytes: result.bytes,
        sha256: result.sha256,
        prunedLocal: result.removedLocal.length,
        prunedRemote: result.removedRemote.length,
      }),
    );
    return 0;
  }

  if (command === "drill") {
    const identityIndex = rest.indexOf("--identity");
    const identityFile =
      identityIndex >= 0 ? (rest[identityIndex + 1] ?? null) : null;
    const given = rest.find(
      (a, i) => !a.startsWith("--") && i !== identityIndex + 1,
    );
    const file = given ?? latestBackup(config.dir);
    if (file === null) {
      console.error(`no backup found in ${config.dir}`);
      return 1;
    }
    if (dryRun) {
      console.log(
        planToText(
          buildRestoreDrillPlan(config, {
            dumpPath: file,
            scratchDb: "df_restore_drill_<id>",
            identityFile,
          }),
        ),
      );
      return 0;
    }
    if (!(await verifyChecksum(file).catch(() => false))) {
      console.error(
        `${file} does not match its recorded checksum (or has none): refusing to restore it`,
      );
      return 1;
    }
    if (file.endsWith(".age") && identityFile === null) {
      console.error(
        "this backup is age-encrypted: pass --identity /path/to/age-identity.txt (the private key is not kept on the server)",
      );
      return 1;
    }
    const result = await runRestoreDrill(config, {
      dumpPath: file,
      identityFile,
      expectedMigrations: loadMigrationFiles().length,
      scalar: async (db, sql) => {
        const pool = new Pool({
          host: config.db.host,
          port: Number(config.db.port),
          user: config.db.user,
          password: config.db.password,
          database: db,
          max: 1,
          options: "-c default_transaction_read_only=on",
        });
        try {
          return Number(Object.values((await pool.query(sql)).rows[0])[0]);
        } finally {
          await pool.end();
        }
      },
    });
    console.log(
      JSON.stringify({
        event: "restore_drill_ok",
        file,
        migrations: result.migrationsApplied,
        users: result.users,
      }),
    );
    return 0;
  }

  console.error("usage: backup <run|drill> [--dry-run]");
  return 2;
}

main().then(
  (code) => process.exit(code),
  (error) => {
    console.error(
      error instanceof BackupConfigError
        ? error.message
        : `backup failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  },
);
