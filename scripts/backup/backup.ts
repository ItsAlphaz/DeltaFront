import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/**
 * Nightly database backups for the single-server deployment, and the restore
 * drill that proves they work (docs/Deployment.md, "Backups").
 *
 * The shape of it:
 *   pg_dump (custom format)  ->  age/gpg encryption  ->  one file per night
 *     ->  checksum  ->  optional off-site copy (rclone)  ->  retention prune.
 * The plaintext dump never touches the disk when encryption is on: pg_dump's
 * output is piped into the encryptor. Nothing in this file holds a credential:
 * the database password is handed to pg_dump through the environment (never
 * the command line, where `ps` would show it), recipients are public keys, and
 * the rclone remote is configured outside the repository.
 *
 * The planning functions are pure (they only build argument lists and names),
 * so the whole procedure can be reviewed with `--dry-run` and unit tested; only
 * `runCommand` and the file moves touch the machine.
 */

// ------------------------------------------------------------------ config

export type Encryption = "age" | "gpg" | "none";

export interface RetentionPolicy {
  /** Keep the newest backup of each of the last N days. */
  daily: number;
  /** ...and of each of the last N weeks. */
  weekly: number;
  /** ...and of each of the last N months. */
  monthly: number;
}

export interface BackupConfig {
  /** Connection parts for pg_dump; the password travels in the environment. */
  db: {
    host: string;
    port: string;
    user: string;
    password: string;
    name: string;
  };
  dir: string;
  encryption: Encryption;
  /** age: a recipients file (`-R`) or a single public key (`-r`). */
  ageRecipient: string | null;
  ageRecipientsFile: string | null;
  gpgRecipient: string | null;
  /** An rclone destination such as `b2:deltafront-backups/prod`, or null for local only. */
  remote: string | null;
  localRetention: RetentionPolicy;
  remoteRetention: RetentionPolicy;
}

export class BackupConfigError extends Error {
  constructor(readonly issues: string[]) {
    super(
      `Invalid backup configuration:\n${issues.map((i) => `  - ${i}`).join("\n")}`,
    );
    this.name = "BackupConfigError";
  }
}

type Env = Record<string, string | undefined>;

const positive = (
  env: Env,
  name: string,
  fallback: number,
  issues: string[],
): number => {
  const raw = env[name]?.trim();
  if (raw === undefined || raw === "") return fallback;
  if (!/^\d{1,4}$/.test(raw)) {
    issues.push(`${name} must be a whole number`);
    return fallback;
  }
  return Number(raw);
};

/** A trimmed value, or null when unset or empty. */
const blankToNull = (value: string | undefined): string | null => {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed === "" ? null : trimmed;
};

export function loadBackupConfig(env: Env = process.env): BackupConfig {
  const issues: string[] = [];
  const rawUrl = (env.BACKUP_DATABASE_URL ?? env.DATABASE_URL ?? "").trim();
  let db: BackupConfig["db"] = {
    host: "",
    port: "",
    user: "",
    password: "",
    name: "",
  };
  if (rawUrl === "") {
    issues.push("BACKUP_DATABASE_URL (or DATABASE_URL) is required");
  } else {
    try {
      const url = new URL(rawUrl);
      if (!/^postgres(ql)?:$/.test(url.protocol)) throw new Error("scheme");
      db = {
        host: decodeURIComponent(url.hostname),
        port: url.port || "5432",
        user: decodeURIComponent(url.username),
        password: decodeURIComponent(url.password),
        name: decodeURIComponent(url.pathname.replace(/^\//, "")),
      };
      if (db.name === "") issues.push("the database URL names no database");
    } catch {
      issues.push("BACKUP_DATABASE_URL is not a valid postgres:// URL");
    }
  }

  const dir = (env.BACKUP_DIR ?? "/var/backups/deltafront").trim();
  if (!path.isAbsolute(dir)) issues.push("BACKUP_DIR must be an absolute path");

  const mode = (env.BACKUP_ENCRYPT ?? "age").trim();
  if (mode !== "age" && mode !== "gpg" && mode !== "none") {
    issues.push("BACKUP_ENCRYPT must be age, gpg or none");
  }
  const ageRecipient = blankToNull(env.BACKUP_AGE_RECIPIENT);
  const ageRecipientsFile = blankToNull(env.BACKUP_AGE_RECIPIENTS_FILE);
  const gpgRecipient = blankToNull(env.BACKUP_GPG_RECIPIENT);
  const remote = blankToNull(env.BACKUP_REMOTE);

  if (mode === "age") {
    if (ageRecipient === null && ageRecipientsFile === null) {
      issues.push(
        "BACKUP_ENCRYPT=age needs BACKUP_AGE_RECIPIENT (a public key, age1...) or BACKUP_AGE_RECIPIENTS_FILE",
      );
    }
    if (ageRecipient !== null && !/^age1[a-z0-9]{50,70}$/.test(ageRecipient)) {
      issues.push("BACKUP_AGE_RECIPIENT is not an age public key (age1...)");
    }
    if (ageRecipient !== null && /AGE-SECRET-KEY/i.test(ageRecipient)) {
      issues.push(
        "BACKUP_AGE_RECIPIENT is a SECRET key: the server must only hold the public half",
      );
    }
  }
  if (mode === "gpg" && gpgRecipient === null) {
    issues.push("BACKUP_ENCRYPT=gpg needs BACKUP_GPG_RECIPIENT");
  }
  // Unencrypted copies never leave the machine: plaintext is allowed locally
  // only, so an unset recipient cannot silently upload readable user data.
  if (mode === "none" && remote !== null) {
    issues.push(
      "BACKUP_ENCRYPT=none cannot be combined with BACKUP_REMOTE: off-site copies must be encrypted",
    );
  }
  if (remote !== null && !/^[A-Za-z0-9_.-]+:[^\s]*$/.test(remote)) {
    issues.push(
      "BACKUP_REMOTE must look like an rclone destination, e.g. b2:bucket/path",
    );
  }

  const retention = (
    prefix: string,
    defaults: RetentionPolicy,
  ): RetentionPolicy => ({
    daily: positive(env, `${prefix}_DAILY`, defaults.daily, issues),
    weekly: positive(env, `${prefix}_WEEKLY`, defaults.weekly, issues),
    monthly: positive(env, `${prefix}_MONTHLY`, defaults.monthly, issues),
  });
  const localRetention = retention("BACKUP_KEEP_LOCAL", {
    daily: 7,
    weekly: 0,
    monthly: 0,
  });
  const remoteRetention = retention("BACKUP_KEEP_REMOTE", {
    daily: 14,
    weekly: 8,
    monthly: 12,
  });
  if (localRetention.daily < 1)
    issues.push("BACKUP_KEEP_LOCAL_DAILY must be at least 1");
  if (remote !== null && remoteRetention.daily < 1) {
    issues.push("BACKUP_KEEP_REMOTE_DAILY must be at least 1");
  }

  if (issues.length > 0) throw new BackupConfigError(issues);
  return {
    db,
    dir,
    encryption: mode as Encryption,
    ageRecipient,
    ageRecipientsFile,
    gpgRecipient,
    remote,
    localRetention,
    remoteRetention,
  };
}

/** Safe to print: the password and recipients are not included. */
export function describeBackupConfig(
  config: BackupConfig,
): Record<string, unknown> {
  return {
    database: `${config.db.host}:${config.db.port}/${config.db.name}`,
    dir: config.dir,
    encryption: config.encryption,
    remote: config.remote ?? "none (local only)",
    localRetention: config.localRetention,
    remoteRetention: config.remote === null ? "n/a" : config.remoteRetention,
  };
}

// ------------------------------------------------------------------- names

const NAME =
  /^deltafront-(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z\.dump(\.age|\.gpg)?$/;

export function backupFileName(now: Date, encryption: Encryption): string {
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  const stamp = `${p(now.getUTCFullYear(), 4)}${p(now.getUTCMonth() + 1)}${p(now.getUTCDate())}T${p(now.getUTCHours())}${p(now.getUTCMinutes())}${p(now.getUTCSeconds())}Z`;
  const suffix =
    encryption === "age" ? ".age" : encryption === "gpg" ? ".gpg" : "";
  return `deltafront-${stamp}.dump${suffix}`;
}

/** The time a backup file name records, or null for a file that is not one of ours. */
export function parseBackupName(name: string): Date | null {
  const m = NAME.exec(name);
  if (m === null) return null;
  const [, y, mo, d, h, mi, s] = m.map(Number) as number[];
  const date = new Date(Date.UTC(y, mo - 1, d, h, mi, s));
  return Number.isNaN(date.getTime()) ? null : date;
}

// --------------------------------------------------------------- retention

const DAY_MS = 86_400_000;

function isoWeekKey(d: Date): string {
  // Thursday decides the ISO year/week.
  const t = new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()),
  );
  t.setUTCDate(t.getUTCDate() + 4 - (t.getUTCDay() || 7));
  const yearStart = Date.UTC(t.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((t.getTime() - yearStart) / DAY_MS + 1) / 7);
  return `${t.getUTCFullYear()}-W${week}`;
}

/**
 * Which backups to keep. Only names that are exactly ours are considered, so
 * a stray file in the directory is never listed for deletion. The newest
 * backup is always kept, whatever the policy says.
 */
export function selectRetention(
  names: readonly string[],
  now: Date,
  policy: RetentionPolicy,
): { keep: string[]; remove: string[] } {
  const dated = names
    .map((name) => ({ name, at: parseBackupName(name) }))
    .filter((e): e is { name: string; at: Date } => e.at !== null)
    .sort((a, b) => b.at.getTime() - a.at.getTime());
  const keep = new Set<string>();
  if (dated.length > 0) keep.add(dated[0].name);

  const bucket = (
    keyOf: (d: Date) => string,
    count: number,
    spanMs: (n: number) => number,
  ) => {
    if (count <= 0) return;
    const seen = new Set<string>();
    for (const e of dated) {
      if (now.getTime() - e.at.getTime() > spanMs(count)) continue;
      const key = keyOf(e.at);
      if (!seen.has(key)) {
        seen.add(key); // newest first, so the first per bucket is the newest
        keep.add(e.name);
      }
    }
  };
  bucket(
    (d) => d.toISOString().slice(0, 10),
    policy.daily,
    (n) => n * DAY_MS,
  );
  bucket(isoWeekKey, policy.weekly, (n) => n * 7 * DAY_MS);
  bucket(
    (d) => d.toISOString().slice(0, 7),
    policy.monthly,
    (n) => n * 31 * DAY_MS,
  );

  return {
    keep: dated.filter((e) => keep.has(e.name)).map((e) => e.name),
    remove: dated.filter((e) => !keep.has(e.name)).map((e) => e.name),
  };
}

// -------------------------------------------------------------------- plans

export interface Command {
  /** Executable and arguments. Never contains a secret. */
  argv: string[];
  /** Names (not values) of environment variables the command receives beyond the inherited ones. */
  env?: Record<string, string>;
  /** Pipe this command's stdout into the next command's stdin. */
  pipeToNext?: boolean;
  /** Write this command's stdout to a file instead. */
  stdoutFile?: string;
}

export interface Step {
  description: string;
  commands: Command[];
}

const pgEnv = (db: BackupConfig["db"]): Record<string, string> => ({
  PGHOST: db.host,
  PGPORT: db.port,
  PGUSER: db.user,
  PGPASSWORD: db.password,
  PGDATABASE: db.name,
  // Fail rather than wait for a prompt on a headless timer.
  PGCONNECT_TIMEOUT: "15",
});

const encryptCommand = (config: BackupConfig): Command | null => {
  switch (config.encryption) {
    case "age":
      return {
        argv: [
          "age",
          ...(config.ageRecipientsFile !== null
            ? ["-R", config.ageRecipientsFile]
            : ["-r", config.ageRecipient!]),
        ],
      };
    case "gpg":
      return {
        argv: [
          "gpg",
          "--batch",
          "--yes",
          "--trust-model",
          "always",
          "--recipient",
          config.gpgRecipient!,
          "--encrypt",
        ],
      };
    case "none":
      return null;
  }
};

/** The steps of one nightly backup. `tmpFile` is where the (encrypted) dump is written first. */
export function buildBackupPlan(
  config: BackupConfig,
  now: Date,
): { fileName: string; steps: Step[] } {
  const fileName = backupFileName(now, config.encryption);
  const finalPath = path.join(config.dir, fileName);
  const tmpPath = `${finalPath}.partial`;
  const dump: Command = {
    argv: [
      "pg_dump",
      "--format=custom",
      "--compress=9",
      "--no-owner",
      "--no-privileges",
      "--lock-wait-timeout=60000",
    ],
    env: pgEnv(config.db),
  };
  const encrypt = encryptCommand(config);
  const steps: Step[] = [];
  if (encrypt === null) {
    steps.push({
      description: "dump the database (UNENCRYPTED, local only)",
      commands: [{ ...dump, argv: [...dump.argv, "--file", tmpPath] }],
    });
  } else {
    steps.push({
      description: `dump the database and encrypt it with ${config.encryption} (the plaintext never touches the disk)`,
      commands: [
        { ...dump, pipeToNext: true },
        { ...encrypt, stdoutFile: tmpPath },
      ],
    });
  }
  if (config.remote !== null) {
    steps.push({
      description: "copy to the off-site remote",
      commands: [
        {
          argv: [
            "rclone",
            "copyto",
            finalPath,
            `${config.remote.replace(/\/$/, "")}/${fileName}`,
            "--immutable",
          ],
        },
      ],
    });
  }
  return { fileName, steps };
}

/** The restore drill: a scratch database, a restore into it, a sanity query, and cleanup. */
export function buildRestoreDrillPlan(
  config: BackupConfig,
  options: { dumpPath: string; scratchDb: string; identityFile: string | null },
): Step[] {
  const adminEnv = { ...pgEnv(config.db), PGDATABASE: "postgres" };
  const scratchEnv = { ...pgEnv(config.db), PGDATABASE: options.scratchDb };
  const steps: Step[] = [];
  const restore: Command = {
    argv: [
      "pg_restore",
      "--exit-on-error",
      "--no-owner",
      "--no-privileges",
      "--dbname",
      options.scratchDb,
    ],
    env: scratchEnv,
  };
  steps.push({
    description: `create the scratch database ${options.scratchDb}`,
    commands: [{ argv: ["createdb", options.scratchDb], env: adminEnv }],
  });
  if (options.dumpPath.endsWith(".age")) {
    steps.push({
      description:
        "decrypt with the age identity and restore into the scratch database",
      commands: [
        {
          argv: [
            "age",
            "--decrypt",
            "-i",
            options.identityFile ?? "<identity file>",
            options.dumpPath,
          ],
          pipeToNext: true,
        },
        restore,
      ],
    });
  } else if (options.dumpPath.endsWith(".gpg")) {
    steps.push({
      description: "decrypt with gpg and restore into the scratch database",
      commands: [
        {
          argv: ["gpg", "--batch", "--decrypt", options.dumpPath],
          pipeToNext: true,
        },
        restore,
      ],
    });
  } else {
    steps.push({
      description: "restore into the scratch database",
      commands: [{ ...restore, argv: [...restore.argv, options.dumpPath] }],
    });
  }
  steps.push({
    description: "drop the scratch database",
    commands: [
      { argv: ["dropdb", "--if-exists", options.scratchDb], env: adminEnv },
    ],
  });
  return steps;
}

/** Plan text for `--dry-run` and logs: argv and variable NAMES, never values. */
export function planToText(steps: readonly Step[]): string {
  const lines: string[] = [];
  steps.forEach((step, i) => {
    lines.push(`${i + 1}. ${step.description}`);
    for (const c of step.commands) {
      const env = c.env
        ? Object.keys(c.env)
            .map((k) => `${k}=<set>`)
            .join(" ")
        : "";
      const tail = c.pipeToNext
        ? " |"
        : c.stdoutFile
          ? ` > ${c.stdoutFile}`
          : "";
      lines.push(`     ${[env, ...c.argv].filter(Boolean).join(" ")}${tail}`);
    }
  });
  return lines.join("\n");
}

// ---------------------------------------------------------------- execution

export interface Runner {
  /** Runs a pipeline of commands; rejects with a message (no secrets) on failure. */
  run(commands: readonly Command[]): Promise<void>;
}

/** The real runner: spawn with the environment, wire pipes, fail on any non-zero exit. */
export const processRunner: Runner = {
  run(commands) {
    return new Promise((resolve, reject) => {
      const children = commands.map((c) =>
        spawn(c.argv[0], c.argv.slice(1), {
          env: { ...process.env, ...c.env },
          stdio: ["pipe", "pipe", "pipe"],
        }),
      );
      const errors: string[] = [];
      let pending = children.length;
      let failed = false;
      children.forEach((child, i) => {
        const c = commands[i];
        if (i + 1 < children.length && c.pipeToNext)
          child.stdout.pipe(children[i + 1].stdin);
        else if (c.stdoutFile !== undefined)
          child.stdout.pipe(
            fs.createWriteStream(c.stdoutFile, { mode: 0o600 }),
          );
        else child.stdout.resume();
        if (i === 0) child.stdin.end();
        child.stderr.on("data", (d: Buffer) =>
          errors.push(d.toString().slice(0, 500)),
        );
        child.on("error", (e) => {
          failed = true;
          reject(new Error(`${c.argv[0]}: ${e.message}`));
        });
        child.on("close", (code) => {
          if (code !== 0 && !failed) {
            failed = true;
            // stderr of pg tools can echo a connection URL: scrub before it travels.
            const text = errors
              .join("")
              .replace(/postgres(ql)?:\/\/\S+/gi, "[url]")
              .trim()
              .slice(0, 400);
            reject(
              new Error(
                `${c.argv[0]} exited with status ${code}${text ? `: ${text}` : ""}`,
              ),
            );
          }
          if (--pending === 0 && !failed) resolve();
        });
      });
    });
  },
};

export interface BackupResult {
  fileName: string;
  bytes: number;
  sha256: string;
  removedLocal: string[];
  removedRemote: string[];
}

async function sha256File(file: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    fs.createReadStream(file)
      .on("data", (d) => hash.update(d))
      .on("end", () => resolve())
      .on("error", reject);
  });
  return hash.digest("hex");
}

/** Smaller than this cannot be a real dump of this schema: treat it as a failed backup. */
export const MIN_BACKUP_BYTES = 1024;

export async function runBackup(
  config: BackupConfig,
  options: {
    now?: Date;
    runner?: Runner;
    listRemote?: () => Promise<string[]>;
    removeRemote?: (name: string) => Promise<void>;
  } = {},
): Promise<BackupResult> {
  const now = options.now ?? new Date();
  const runner = options.runner ?? processRunner;
  fs.mkdirSync(config.dir, { recursive: true, mode: 0o700 });
  const plan = buildBackupPlan(config, now);
  const finalPath = path.join(config.dir, plan.fileName);
  const tmpPath = `${finalPath}.partial`;
  fs.rmSync(tmpPath, { force: true });

  try {
    await runner.run(plan.steps[0].commands);
    const size = fs.statSync(tmpPath).size;
    if (size < MIN_BACKUP_BYTES) {
      throw new Error(`the backup is only ${size} bytes: refusing to keep it`);
    }
    fs.chmodSync(tmpPath, 0o600);
    fs.renameSync(tmpPath, finalPath);
  } catch (error) {
    fs.rmSync(tmpPath, { force: true });
    throw error;
  }
  const sha256 = await sha256File(finalPath);
  fs.writeFileSync(`${finalPath}.sha256`, `${sha256}  ${plan.fileName}\n`, {
    mode: 0o600,
  });

  for (const step of plan.steps.slice(1)) await runner.run(step.commands);

  // Prune only after the new backup is safely written (and uploaded).
  const removedLocal = pruneLocal(config, now);
  let removedRemote: string[] = [];
  if (config.remote !== null && options.listRemote && options.removeRemote) {
    const { remove } = selectRetention(
      await options.listRemote(),
      now,
      config.remoteRetention,
    );
    for (const name of remove) await options.removeRemote(name);
    removedRemote = remove;
  }
  return {
    fileName: plan.fileName,
    bytes: fs.statSync(finalPath).size,
    sha256,
    removedLocal,
    removedRemote,
  };
}

export function pruneLocal(config: BackupConfig, now: Date): string[] {
  const names = fs.readdirSync(config.dir);
  const { remove } = selectRetention(names, now, config.localRetention);
  for (const name of remove) {
    fs.rmSync(path.join(config.dir, name), { force: true });
    fs.rmSync(path.join(config.dir, `${name}.sha256`), { force: true });
  }
  return remove;
}

/** The newest backup file in `dir`, or null. */
export function latestBackup(dir: string): string | null {
  const dated = fs
    .readdirSync(dir)
    .map((name) => ({ name, at: parseBackupName(name) }))
    .filter((e): e is { name: string; at: Date } => e.at !== null)
    .sort((a, b) => b.at.getTime() - a.at.getTime());
  return dated.length === 0 ? null : path.join(dir, dated[0].name);
}

/** Checks a backup file against its recorded checksum. */
export async function verifyChecksum(file: string): Promise<boolean> {
  const recorded = fs.readFileSync(`${file}.sha256`, "utf8").split(/\s+/)[0];
  return recorded === (await sha256File(file));
}

// ------------------------------------------------------------ restore drill

export interface DrillResult {
  scratchDb: string;
  migrationsApplied: number;
  users: number;
}

export interface DrillOptions {
  dumpPath: string;
  /** age identity (private key file), held by whoever runs the drill: never on the server by default. */
  identityFile?: string | null;
  runner?: Runner;
  /** Runs read-only SQL against the scratch database and returns the first column of the first row. */
  scalar: (scratchDb: string, sql: string) => Promise<number>;
  /** How many migration files this release expects. */
  expectedMigrations: number;
  scratchSuffix?: string;
}

/**
 * Restores a backup into a scratch database and checks it looks like
 * DeltaFront's: every migration recorded, the core tables present. The
 * scratch database is dropped whatever happens, and it can never be the live
 * database.
 */
export async function runRestoreDrill(
  config: BackupConfig,
  options: DrillOptions,
): Promise<DrillResult> {
  const runner = options.runner ?? processRunner;
  const scratchDb = `df_restore_drill_${options.scratchSuffix ?? Date.now().toString(36)}`;
  if (scratchDb === config.db.name)
    throw new Error("the scratch database must not be the live database");
  if (!/^[a-z0-9_]+$/.test(scratchDb))
    throw new Error("invalid scratch database name");
  const steps = buildRestoreDrillPlan(config, {
    dumpPath: options.dumpPath,
    scratchDb,
    identityFile: options.identityFile ?? null,
  });
  let created = false;
  try {
    await runner.run(steps[0].commands);
    created = true;
    await runner.run(steps[1].commands);
    const migrationsApplied = await options.scalar(
      scratchDb,
      "SELECT count(*)::int FROM schema_migrations",
    );
    const users = await options.scalar(
      scratchDb,
      "SELECT count(*)::int FROM users",
    );
    for (const table of [
      "users",
      "refresh_sessions",
      "auth_identities",
      "server_api_keys",
    ]) {
      const present = await options.scalar(
        scratchDb,
        `SELECT (to_regclass('${table}') IS NOT NULL)::int`,
      );
      if (present !== 1)
        throw new Error(`the restored database has no ${table} table`);
    }
    if (migrationsApplied !== options.expectedMigrations) {
      throw new Error(
        `the restored database has ${migrationsApplied} migrations but this release expects ${options.expectedMigrations}`,
      );
    }
    return { scratchDb, migrationsApplied, users };
  } finally {
    if (created) await runner.run(steps[2].commands).catch(() => undefined);
  }
}
