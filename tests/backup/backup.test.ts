// @vitest-environment node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  BackupConfigError,
  backupFileName,
  buildBackupPlan,
  buildRestoreDrillPlan,
  describeBackupConfig,
  latestBackup,
  loadBackupConfig,
  MIN_BACKUP_BYTES,
  parseBackupName,
  planToText,
  processRunner,
  runBackup,
  runRestoreDrill,
  selectRetention,
  verifyChecksum,
  type Command,
  type Runner,
} from "../../scripts/backup/backup";

const AGE_KEY =
  "age1ql3z7hjy54pw3hyww5ayyfg7zqgvc7w3j2elw8zmrj2kg5sfn9aqmcac8p";
const PASSWORD = "pa55w0rd-Zq81!";
const baseEnv = (extra: Record<string, string | undefined> = {}) => ({
  DATABASE_URL: `postgres://df_backup:${encodeURIComponent(PASSWORD)}@127.0.0.1:5432/deltafront`,
  BACKUP_DIR: "/var/backups/deltafront",
  BACKUP_AGE_RECIPIENT: AGE_KEY,
  ...extra,
});

const dirs: string[] = [];
const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "df-backup-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0))
    fs.rmSync(d, { recursive: true, force: true });
});

const issuesOf = (env: Record<string, string | undefined>): string[] => {
  try {
    loadBackupConfig(env);
  } catch (e) {
    expect(e).toBeInstanceOf(BackupConfigError);
    return (e as BackupConfigError).issues;
  }
  throw new Error("expected a rejection");
};

describe("backup configuration", () => {
  it("reads a valid environment, taking the password from the URL", () => {
    const config = loadBackupConfig(baseEnv());
    expect(config.db).toEqual({
      host: "127.0.0.1",
      port: "5432",
      user: "df_backup",
      password: PASSWORD,
      name: "deltafront",
    });
    expect(config.encryption).toBe("age");
    expect(config.localRetention).toEqual({ daily: 7, weekly: 0, monthly: 0 });
    expect(config.remoteRetention).toEqual({
      daily: 14,
      weekly: 8,
      monthly: 12,
    });
  });

  it("describes itself without the password or the recipient", () => {
    const text = JSON.stringify(
      describeBackupConfig(loadBackupConfig(baseEnv())),
    );
    expect(text).not.toContain(PASSWORD);
    expect(text).not.toContain(AGE_KEY);
    expect(text).toContain("127.0.0.1:5432/deltafront");
  });

  it("rejects what would make a backup unsafe or useless", () => {
    expect(issuesOf({ ...baseEnv(), DATABASE_URL: undefined }).join()).toMatch(
      /DATABASE_URL.*required/,
    );
    expect(
      issuesOf({ ...baseEnv(), DATABASE_URL: "mysql://x/y" }).join(),
    ).toMatch(/not a valid postgres/);
    expect(
      issuesOf({ ...baseEnv(), BACKUP_DIR: "relative/dir" }).join(),
    ).toMatch(/absolute/);
    expect(
      issuesOf({ ...baseEnv(), BACKUP_AGE_RECIPIENT: undefined }).join(),
    ).toMatch(/needs BACKUP_AGE_RECIPIENT/);
    expect(
      issuesOf({ ...baseEnv(), BACKUP_AGE_RECIPIENT: "not-a-key" }).join(),
    ).toMatch(/not an age public key/);
    expect(issuesOf({ ...baseEnv(), BACKUP_ENCRYPT: "rot13" }).join()).toMatch(
      /age, gpg or none/,
    );
    expect(issuesOf({ ...baseEnv(), BACKUP_ENCRYPT: "gpg" }).join()).toMatch(
      /BACKUP_GPG_RECIPIENT/,
    );
    expect(
      issuesOf({ ...baseEnv(), BACKUP_KEEP_LOCAL_DAILY: "0" }).join(),
    ).toMatch(/at least 1/);
    expect(
      issuesOf({ ...baseEnv(), BACKUP_KEEP_LOCAL_DAILY: "many" }).join(),
    ).toMatch(/whole number/);
  });

  it("refuses a secret key where a public one belongs, and never echoes it", () => {
    const secret =
      "AGE-SECRET-KEY-1QQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQ";
    const issues = issuesOf({ ...baseEnv(), BACKUP_AGE_RECIPIENT: secret });
    expect(issues.join()).toMatch(/not an age public key/);
    expect(issues.join()).not.toContain(secret);
  });

  it("never allows unencrypted data to be copied off-site", () => {
    expect(
      issuesOf({
        ...baseEnv(),
        BACKUP_ENCRYPT: "none",
        BACKUP_REMOTE: "b2:bucket/x",
      }).join(),
    ).toMatch(/off-site copies must be encrypted/);
    expect(
      loadBackupConfig({ ...baseEnv(), BACKUP_ENCRYPT: "none" }).encryption,
    ).toBe("none");
    expect(
      issuesOf({ ...baseEnv(), BACKUP_REMOTE: "not a remote" }).join(),
    ).toMatch(/rclone destination/);
  });
});

describe("backup names and retention", () => {
  const at = new Date(Date.UTC(2026, 10, 3, 2, 30, 5));

  it("names a backup by UTC time and reads the time back", () => {
    expect(backupFileName(at, "age")).toBe(
      "deltafront-20261103T023005Z.dump.age",
    );
    expect(backupFileName(at, "gpg")).toBe(
      "deltafront-20261103T023005Z.dump.gpg",
    );
    expect(backupFileName(at, "none")).toBe("deltafront-20261103T023005Z.dump");
    expect(
      parseBackupName("deltafront-20261103T023005Z.dump.age")?.toISOString(),
    ).toBe(at.toISOString());
    for (const other of [
      "notes.txt",
      "deltafront-latest.dump",
      "deltafront-20261103T023005Z.dump.age.sha256",
      "../x",
    ]) {
      expect(parseBackupName(other)).toBeNull();
    }
  });

  const nightly = (days: number, now: Date) =>
    Array.from({ length: days }, (_, i) =>
      backupFileName(new Date(now.getTime() - i * 86_400_000), "age"),
    );

  it("keeps one per day for the daily window, and never touches files that are not backups", () => {
    const now = new Date(Date.UTC(2026, 10, 30, 3, 0, 0));
    const names = [
      ...nightly(20, now),
      "README.txt",
      "deltafront-20261101T000000Z.dump.age.sha256",
    ];
    const { keep, remove } = selectRetention(names, now, {
      daily: 7,
      weekly: 0,
      monthly: 0,
    });
    expect(keep).toHaveLength(8); // 7 days back, inclusive of the boundary
    expect(remove).toHaveLength(12);
    expect(remove).not.toContain("README.txt");
    expect([...keep, ...remove].sort()).toEqual(nightly(20, now).sort());
  });

  it("keeps the newest per day when there are several", () => {
    const now = new Date(Date.UTC(2026, 10, 30, 12, 0, 0));
    const early = backupFileName(
      new Date(Date.UTC(2026, 10, 30, 1, 0, 0)),
      "age",
    );
    const late = backupFileName(
      new Date(Date.UTC(2026, 10, 30, 9, 0, 0)),
      "age",
    );
    const { keep, remove } = selectRetention([early, late], now, {
      daily: 3,
      weekly: 0,
      monthly: 0,
    });
    expect(keep).toEqual([late]);
    expect(remove).toEqual([early]);
  });

  it("adds weekly and monthly survivors from further back", () => {
    const now = new Date(Date.UTC(2027, 3, 1, 3, 0, 0));
    const names = nightly(400, now);
    const policy = { daily: 14, weekly: 8, monthly: 12 };
    const { keep } = selectRetention(names, now, policy);
    // 14-15 dailies + about 8 weeklies + about 12 monthlies, overlapping a little
    expect(keep.length).toBeGreaterThan(25);
    expect(keep.length).toBeLessThan(40);
    expect(keep).toContain(names[0]); // the newest
    // something well past the daily window survives as a weekly or monthly
    const oldest = parseBackupName(keep[keep.length - 1])!;
    expect(now.getTime() - oldest.getTime()).toBeGreaterThan(200 * 86_400_000);
    // and nothing older than the monthly window is kept
    expect(now.getTime() - oldest.getTime()).toBeLessThan(13 * 31 * 86_400_000);
  });

  it("always keeps the newest backup, even when it is older than every window", () => {
    const now = new Date(Date.UTC(2027, 0, 1));
    const old = backupFileName(new Date(Date.UTC(2026, 0, 1)), "age");
    expect(
      selectRetention([old], now, { daily: 1, weekly: 0, monthly: 0 }).keep,
    ).toEqual([old]);
    expect(
      selectRetention([], now, { daily: 1, weekly: 0, monthly: 0 }),
    ).toEqual({ keep: [], remove: [] });
  });
});

describe("the backup and restore plans", () => {
  const config = (extra: Record<string, string | undefined> = {}) =>
    loadBackupConfig(baseEnv(extra));
  const now = new Date(Date.UTC(2026, 10, 3, 2, 30, 5));

  it("pipes pg_dump into age so the plaintext never reaches the disk, with the password only in the environment", () => {
    const plan = buildBackupPlan(config(), now);
    const [pipeline] = plan.steps;
    expect(pipeline.commands.map((c) => c.argv[0])).toEqual(["pg_dump", "age"]);
    expect(pipeline.commands[0].pipeToNext).toBe(true);
    expect(pipeline.commands[1].argv).toEqual(["age", "-r", AGE_KEY]);
    expect(pipeline.commands[1].stdoutFile).toBe(
      "/var/backups/deltafront/deltafront-20261103T023005Z.dump.age.partial",
    );
    expect(pipeline.commands[0].env).toMatchObject({
      PGPASSWORD: PASSWORD,
      PGUSER: "df_backup",
      PGDATABASE: "deltafront",
    });
    for (const command of pipeline.commands) {
      expect(command.argv.join(" ")).not.toContain(PASSWORD);
    }
    expect(pipeline.commands[0].argv).toEqual(
      expect.arrayContaining([
        "--format=custom",
        "--no-owner",
        "--no-privileges",
      ]),
    );
  });

  it("supports an age recipients file, gpg and a local-only plaintext mode", () => {
    expect(
      buildBackupPlan(
        config({
          BACKUP_AGE_RECIPIENT: undefined,
          BACKUP_AGE_RECIPIENTS_FILE: "/etc/deltafront/recipients.txt",
        }),
        now,
      ).steps[0].commands[1].argv,
    ).toEqual(["age", "-R", "/etc/deltafront/recipients.txt"]);
    const gpg = buildBackupPlan(
      config({
        BACKUP_ENCRYPT: "gpg",
        BACKUP_GPG_RECIPIENT: "ops@example.com",
      }),
      now,
    ).steps[0].commands[1].argv;
    expect(gpg).toEqual(
      expect.arrayContaining([
        "gpg",
        "--recipient",
        "ops@example.com",
        "--encrypt",
      ]),
    );
    const plain = buildBackupPlan(config({ BACKUP_ENCRYPT: "none" }), now);
    expect(plain.steps[0].commands).toHaveLength(1);
    expect(plain.steps[0].commands[0].argv).toEqual(
      expect.arrayContaining(["--file"]),
    );
    expect(plain.fileName).toBe("deltafront-20261103T023005Z.dump");
  });

  it("copies off-site with rclone, refusing to overwrite an existing object", () => {
    const plan = buildBackupPlan(
      config({ BACKUP_REMOTE: "b2:deltafront-backups/prod/" }),
      now,
    );
    expect(plan.steps).toHaveLength(2);
    expect(plan.steps[1].commands[0].argv).toEqual([
      "rclone",
      "copyto",
      "/var/backups/deltafront/deltafront-20261103T023005Z.dump.age",
      "b2:deltafront-backups/prod/deltafront-20261103T023005Z.dump.age",
      "--immutable",
    ]);
    expect(buildBackupPlan(config(), now).steps).toHaveLength(1);
  });

  it("prints a dry run with variable names, never their values", () => {
    const text = planToText(
      buildBackupPlan(config({ BACKUP_REMOTE: "b2:bucket/x" }), now).steps,
    );
    expect(text).toContain("PGPASSWORD=<set>");
    expect(text).not.toContain(PASSWORD);
    expect(text).toContain("pg_dump");
    expect(text).toContain("rclone copyto");
  });

  it("restores into a scratch database through age and drops it afterwards", () => {
    const steps = buildRestoreDrillPlan(config(), {
      dumpPath: "/var/backups/deltafront/x.dump.age",
      scratchDb: "df_restore_drill_abc",
      identityFile: "/root/age-identity.txt",
    });
    expect(
      steps.map((s) => s.commands.map((c) => c.argv[0]).join("|")),
    ).toEqual(["createdb", "age|pg_restore", "dropdb"]);
    const text = planToText(steps);
    expect(text).toContain(
      "age --decrypt -i /root/age-identity.txt /var/backups/deltafront/x.dump.age",
    );
    expect(text).toContain(
      "pg_restore --exit-on-error --no-owner --no-privileges --dbname df_restore_drill_abc",
    );
    expect(text).not.toContain(PASSWORD);
    // the restore never targets the live database
    expect(steps[1].commands[1].env?.PGDATABASE).toBe("df_restore_drill_abc");
    expect(text).not.toMatch(/--dbname deltafront\b/);
  });
});

/** A runner that records what it was asked and can be told to write the dump or fail. */
function fakeRunner(options: { dumpBytes?: number; failOn?: string } = {}) {
  const ran: string[][] = [];
  const runner: Runner = {
    async run(commands: readonly Command[]) {
      ran.push(commands.map((c) => c.argv[0]));
      for (const c of commands) {
        if (options.failOn === c.argv[0])
          throw new Error(`${c.argv[0]} exited with status 1`);
        if (c.stdoutFile !== undefined) {
          fs.writeFileSync(
            c.stdoutFile,
            Buffer.alloc(options.dumpBytes ?? 4096, 7),
          );
        }
        const fileIndex = c.argv.indexOf("--file");
        if (fileIndex >= 0)
          fs.writeFileSync(
            c.argv[fileIndex + 1],
            Buffer.alloc(options.dumpBytes ?? 4096, 7),
          );
      }
    },
  };
  return { runner, ran };
}

describe("running a backup", () => {
  let dir: string;
  beforeEach(() => {
    dir = tmp();
  });
  const configFor = (extra: Record<string, string | undefined> = {}) =>
    loadBackupConfig(baseEnv({ BACKUP_DIR: dir, ...extra }));
  const now = new Date(Date.UTC(2026, 10, 3, 2, 30, 5));

  it("writes a private file, a checksum, and prunes the old ones", async () => {
    for (let i = 1; i <= 10; i++) {
      const old = backupFileName(
        new Date(now.getTime() - i * 86_400_000),
        "age",
      );
      fs.writeFileSync(path.join(dir, old), "old");
      fs.writeFileSync(path.join(dir, `${old}.sha256`), "x");
    }
    fs.writeFileSync(path.join(dir, "keepme.txt"), "not ours");
    const { runner } = fakeRunner();
    const result = await runBackup(configFor(), { now, runner });
    const file = path.join(dir, result.fileName);
    expect(result.fileName).toBe("deltafront-20261103T023005Z.dump.age");
    expect(fs.statSync(file).mode & 0o077).toBe(0);
    expect(await verifyChecksum(file)).toBe(true);
    expect(fs.existsSync(`${file}.partial`)).toBe(false);
    expect(fs.existsSync(path.join(dir, "keepme.txt"))).toBe(true);
    expect(result.removedLocal.length).toBeGreaterThan(0);
    for (const name of result.removedLocal) {
      expect(fs.existsSync(path.join(dir, name))).toBe(false);
      expect(fs.existsSync(path.join(dir, `${name}.sha256`))).toBe(false);
    }
    expect(latestBackup(dir)).toBe(file);
  });

  it("refuses a suspiciously small dump and leaves nothing behind", async () => {
    const { runner } = fakeRunner({ dumpBytes: MIN_BACKUP_BYTES - 1 });
    await expect(runBackup(configFor(), { now, runner })).rejects.toThrow(
      /refusing to keep it/,
    );
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it("a failing dump keeps the previous backups and leaves no partial file", async () => {
    const previous = backupFileName(
      new Date(now.getTime() - 86_400_000),
      "age",
    );
    fs.writeFileSync(path.join(dir, previous), "yesterday");
    const { runner } = fakeRunner({ failOn: "pg_dump" });
    await expect(runBackup(configFor(), { now, runner })).rejects.toThrow(
      /pg_dump exited/,
    );
    expect(fs.readdirSync(dir)).toEqual([previous]);
  });

  it("uploads before pruning the remote, and does not prune anything if the upload fails", async () => {
    const remoteNames = Array.from({ length: 40 }, (_, i) =>
      backupFileName(new Date(now.getTime() - (i + 1) * 86_400_000), "age"),
    );
    const removed: string[] = [];
    const okRunner = fakeRunner();
    const result = await runBackup(
      configFor({ BACKUP_REMOTE: "b2:bucket/x" }),
      {
        now,
        runner: okRunner.runner,
        listRemote: async () => remoteNames,
        removeRemote: async (n) => void removed.push(n),
      },
    );
    expect(okRunner.ran).toEqual([["pg_dump", "age"], ["rclone"]]);
    expect(removed.length).toBeGreaterThan(0);
    expect(result.removedRemote).toEqual(removed);

    const failed: string[] = [];
    const bad = fakeRunner({ failOn: "rclone" });
    await expect(
      runBackup(configFor({ BACKUP_REMOTE: "b2:bucket/x" }), {
        now: new Date(now.getTime() + 86_400_000),
        runner: bad.runner,
        listRemote: async () => remoteNames,
        removeRemote: async (n) => void failed.push(n),
      }),
    ).rejects.toThrow(/rclone/);
    expect(failed).toEqual([]);
  });

  it("detects a backup that was altered after it was written", async () => {
    const { runner } = fakeRunner();
    const result = await runBackup(configFor(), { now, runner });
    const file = path.join(dir, result.fileName);
    fs.appendFileSync(file, "tamper");
    expect(await verifyChecksum(file)).toBe(false);
  });
});

describe("the restore drill", () => {
  const config = loadBackupConfig(baseEnv());
  const scalarFor =
    (answers: Record<string, number>) => async (_db: string, sql: string) => {
      for (const [needle, value] of Object.entries(answers))
        if (sql.includes(needle)) return value;
      return 1;
    };

  it("creates a scratch database, restores into it, checks it, and drops it", async () => {
    const { runner, ran } = fakeRunner();
    const result = await runRestoreDrill(config, {
      dumpPath: "/b/x.dump.age",
      identityFile: "/id.txt",
      runner,
      expectedMigrations: 12,
      scratchSuffix: "t1",
      scalar: scalarFor({ schema_migrations: 12, "FROM users": 42 }),
    });
    expect(result).toEqual({
      scratchDb: "df_restore_drill_t1",
      migrationsApplied: 12,
      users: 42,
    });
    expect(ran).toEqual([["createdb"], ["age", "pg_restore"], ["dropdb"]]);
  });

  it("drops the scratch database even when the restore fails", async () => {
    const { runner, ran } = fakeRunner({ failOn: "pg_restore" });
    await expect(
      runRestoreDrill(config, {
        dumpPath: "/b/x.dump.age",
        identityFile: "/id.txt",
        runner,
        expectedMigrations: 12,
        scratchSuffix: "t2",
        scalar: scalarFor({}),
      }),
    ).rejects.toThrow(/pg_restore/);
    expect(ran[ran.length - 1]).toEqual(["dropdb"]);
  });

  it("fails, and still cleans up, when migrations are missing or a core table is absent", async () => {
    const cases: Array<Record<string, number>> = [
      { schema_migrations: 7 },
      { "to_regclass('refresh_sessions')": 0 },
    ];
    for (const answers of cases) {
      const { runner, ran } = fakeRunner();
      await expect(
        runRestoreDrill(config, {
          dumpPath: "/b/x.dump",
          runner,
          expectedMigrations: 12,
          scratchSuffix: "t3",
          scalar: scalarFor({ schema_migrations: 12, ...answers }),
        }),
      ).rejects.toThrow();
      expect(ran[ran.length - 1]).toEqual(["dropdb"]);
    }
  });

  it("will not use the live database as the scratch database", async () => {
    const live = {
      ...config,
      db: { ...config.db, name: "df_restore_drill_live" },
    };
    await expect(
      runRestoreDrill(live, {
        dumpPath: "/b/x.dump",
        runner: fakeRunner().runner,
        expectedMigrations: 1,
        scratchSuffix: "live",
        scalar: scalarFor({}),
      }),
    ).rejects.toThrow(/must not be the live database/);
  });
});

describe("the real process runner", () => {
  const node = process.execPath;

  it("pipes one command into the next and writes the result to a file", async () => {
    const out = path.join(tmp(), "out.bin");
    await processRunner.run([
      {
        argv: [node, "-e", "process.stdout.write('hello pipeline')"],
        pipeToNext: true,
      },
      {
        argv: [node, "-e", "process.stdin.pipe(process.stdout)"],
        stdoutFile: out,
      },
    ]);
    // the file stream may flush just after close
    await new Promise((r) => setTimeout(r, 50));
    expect(fs.readFileSync(out, "utf8")).toBe("hello pipeline");
  });

  it("passes variables through the environment, and fails on a non-zero exit without leaking them", async () => {
    await processRunner.run([
      {
        argv: [
          node,
          "-e",
          "if (process.env.PGPASSWORD !== 'pw') process.exit(9)",
        ],
        env: { PGPASSWORD: "pw" },
      },
    ]);
    const error = await processRunner
      .run([
        {
          argv: [
            node,
            "-e",
            "console.error('could not connect to postgres://u:SECRETPW@h/db'); process.exit(3)",
          ],
          env: { PGPASSWORD: "SECRETPW" },
        },
      ])
      .catch((e: Error) => e);
    expect(String(error)).toMatch(/exited with status 3/);
    expect(String(error)).not.toContain("SECRETPW");
    expect(String(error)).toContain("[url]");
  });

  it("reports a missing executable by name", async () => {
    await expect(
      processRunner.run([{ argv: ["df-no-such-tool"] }]),
    ).rejects.toThrow(/df-no-such-tool/);
  });
});
