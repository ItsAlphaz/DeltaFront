import type { Reward } from "@openfront/shared/ApiSchemas";
import {
  canPrestige as canPrestigeAt,
  isTitleId,
  levelFromRunXp,
  MAX_RUN_XP,
  PRESTIGE_CREDITS,
  SEASON_MAX_LEVEL,
  SEASON_TRACK,
  SEASON_XP_PER_LEVEL,
} from "@openfront/shared/ProgressionRules";
import type { Pool, PoolClient } from "pg";
import { withTransaction } from "../db/tx";
import {
  currentSeason,
  earnedTitlesOf,
  progressRowOf,
  progressWire,
} from "../repo/progression";
import {
  AdminOpError,
  targetUser,
  writeAudit,
  type AuditContext,
} from "./adminOps";
import { PROGRESSION } from "./constants";
import {
  applyXp,
  lockProgress,
  SEASON_COLUMNS,
  seasonAt,
  toSeason,
  unlockReward,
  type RewardEnv,
  type SeasonRow,
} from "./progression";

/**
 * The operations that change an account's progression on request: prestige, the
 * title shown, the admin's XP tools, and seasons. Each runs on a transaction
 * (the HTTP layer and the CLI wrap them) and takes the account's progress row
 * lock first, like every other XP change.
 */

// ---------------------------------------------------------------- prestige

export type PrestigeOutcome =
  | {
      kind: "ok";
      response: {
        progress: ReturnType<typeof progressWire>;
        rewards: Reward[];
      };
    }
  /** Not at level 100 (or already at the last prestige): nothing changed. */
  | { kind: "refused" };

/**
 * Enters the next prestige rank, for the account itself. The server decides
 * everything: level 100 is read from the stored run XP, the request carries
 * only an idempotency key. The row lock makes a second request wait; it then
 * finds either its own key (and gets the stored answer) or a run that is no
 * longer at level 100 (and is refused).
 */
export async function prestigeAccount(
  pool: Pick<Pool, "connect">,
  userId: string,
  idempotencyKey: string,
  env: RewardEnv,
): Promise<PrestigeOutcome> {
  return withTransaction(pool, async (tx) => {
    const state = await lockProgress(tx, userId);
    const earlier = await tx.query<{ response: unknown }>(
      "SELECT response FROM prestige_events WHERE user_id = $1 AND idempotency_key = $2",
      [userId, idempotencyKey],
    );
    if (earlier.rows.length > 0) {
      return {
        kind: "ok",
        response: earlier.rows[0].response as never,
      } satisfies PrestigeOutcome;
    }
    const level = levelFromRunXp(state.runXp);
    if (!canPrestigeAt(state.prestige, level)) {
      return { kind: "refused" } satisfies PrestigeOutcome;
    }
    const next = state.prestige + 1;
    await tx.query(
      `UPDATE user_progress SET run_xp = 0, prestige = $2, updated_at = now()
        WHERE user_id = $1`,
      [userId, next],
    );
    const rewardId = await unlockReward(
      tx,
      userId,
      {
        key: `prestige:${next}`,
        kind: "prestige",
        credits: PRESTIGE_CREDITS,
        flare: null,
      },
      env,
    );
    const row = await progressRowOf(tx, userId);
    const response = {
      progress: progressWire(row, row.displayTitle),
      rewards:
        rewardId === null
          ? []
          : [
              {
                id: rewardId,
                currencyType: "soft" as const,
                amount: String(PRESTIGE_CREDITS),
                reason: "prestige",
                note: null,
              },
            ],
    };
    await tx.query(
      `INSERT INTO prestige_events
         (user_id, idempotency_key, from_prestige, to_prestige, run_xp_before, lifetime_xp, response)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
      [
        userId,
        idempotencyKey,
        state.prestige,
        next,
        state.runXp,
        state.lifetimeXp,
        JSON.stringify(response),
      ],
    );
    return { kind: "ok", response } satisfies PrestigeOutcome;
  });
}

// ------------------------------------------------------------------ title

/** Chooses the title shown beside the account's name; null clears it. Returns false for one not earned. */
export async function setDisplayTitle(
  pool: Pick<Pool, "connect">,
  userId: string,
  title: string | null,
): Promise<boolean> {
  if (title !== null && !isTitleId(title)) return false;
  return withTransaction(pool, async (tx) => {
    const state = await lockProgress(tx, userId);
    if (title !== null) {
      const earned = await earnedTitlesOf(tx, userId, state);
      if (!earned.includes(title)) return false;
    }
    await tx.query(
      "UPDATE user_progress SET display_title = $2, updated_at = now() WHERE user_id = $1",
      [userId, title],
    );
    return true;
  });
}

// ---------------------------------------------------------- admin XP tools

/** The current UTC day as YYYY-MM-DD. */
const utcToday = () => new Date().toISOString().slice(0, 10);

export type XpAdminAction = "grant" | "revoke" | "set";

export interface XpAdminResult {
  before: {
    lifetimeXp: number;
    runXp: number;
    prestige: number;
    level: number;
  };
  after: { lifetimeXp: number; runXp: number; prestige: number; level: number };
  auditId: string;
}

/**
 * An admin's change to an account's XP, on the caller's transaction:
 *  - grant / revoke: `amount` (1..adminMaxXpPerCommand) is added to / taken from the
 *    current run; a revoke larger than the run is refused (no automatic un-prestige);
 *  - set: the run XP becomes `amount` (0..level-100 total), lifetime XP moving by the difference.
 * The audit row is written first, the ledger row refers to it, and the audit
 * row then gets the before/after. A grant unlocks milestones normally; a revoke
 * never takes back a reward that was already unlocked.
 */
export async function adjustXp(
  tx: PoolClient,
  ctx: AuditContext,
  publicId: string,
  action: XpAdminAction,
  amount: number,
  reason: string,
  options: { countsForSeason: boolean; env: RewardEnv },
): Promise<XpAdminResult> {
  if (!Number.isInteger(amount)) {
    throw new AdminOpError(
      "INVALID_AMOUNT",
      "the amount must be a whole number",
    );
  }
  if (action === "set") {
    if (amount < 0 || amount > MAX_RUN_XP) {
      throw new AdminOpError(
        "INVALID_AMOUNT",
        `the run XP must be between 0 and ${MAX_RUN_XP}`,
      );
    }
  } else if (amount < 1 || amount > PROGRESSION.adminMaxXpPerCommand) {
    throw new AdminOpError(
      "INVALID_AMOUNT",
      `the amount must be between 1 and ${PROGRESSION.adminMaxXpPerCommand}`,
    );
  }
  const user = await targetUser(tx, publicId);
  const deleted = await tx.query<{ deleted_at: Date | null; kind: string }>(
    "SELECT deleted_at, kind FROM users WHERE id = $1",
    [user.id],
  );
  if (deleted.rows[0].deleted_at !== null) {
    throw new AdminOpError("DELETED", `${publicId} is a deleted account`);
  }
  if (deleted.rows[0].kind !== "registered") {
    throw new AdminOpError(
      "NOT_REGISTERED",
      "only registered accounts earn XP",
      409,
    );
  }
  const state = await lockProgress(tx, user.id);
  let delta: number;
  if (action === "grant") delta = amount;
  else if (action === "revoke") {
    if (amount > state.runXp) {
      throw new AdminOpError(
        "INSUFFICIENT",
        `${publicId} has only ${state.runXp} XP in this run: cannot take ${amount}`,
        409,
      );
    }
    delta = -amount;
  } else {
    delta = amount - state.runXp;
    if (delta === 0) {
      throw new AdminOpError(
        "NO_CHANGE",
        "the run XP is already that value",
        409,
      );
    }
  }
  const auditId = await writeAudit(tx, ctx, `xp:${action}`, "user", publicId, {
    amount,
    reason,
    countsForSeason: options.countsForSeason,
  });
  const season = options.countsForSeason
    ? await seasonAt(tx, new Date())
    : null;
  const applied = await applyXp(
    tx,
    user.id,
    state,
    delta,
    {
      source:
        action === "grant"
          ? "admin_grant"
          : action === "revoke"
            ? "admin_revoke"
            : "admin_set",
      refType: "admin",
      refId: auditId,
      rewardDay: utcToday(),
      season,
      seasonDelta: delta > 0 && season !== null ? delta : 0,
      actor: ctx.actorUserId ?? null,
      reason,
    },
    options.env,
  );
  const shape = (s: {
    lifetimeXp: number;
    runXp: number;
    prestige: number;
  }) => ({
    ...s,
    level: levelFromRunXp(s.runXp),
  });
  const result: XpAdminResult = {
    before: shape(state),
    after: shape(applied.after),
    auditId,
  };
  await tx.query(
    "UPDATE admin_audit_log SET details = details || $2::jsonb WHERE id = $1",
    [auditId, { before: result.before, after: result.after }],
  );
  return result;
}

/** Zeroes an account's XP in the running season (the audit row records what it was). */
export async function resetSeasonXp(
  tx: PoolClient,
  ctx: AuditContext,
  publicId: string,
  reason: string,
): Promise<{ before: number; after: number; season: number }> {
  const user = await targetUser(tx, publicId);
  await lockProgress(tx, user.id);
  const season = await currentSeason(tx);
  if (season === null) {
    throw new AdminOpError("NO_SEASON", "there is no running season", 409);
  }
  const { rows } = await tx.query<{ xp: string }>(
    "SELECT xp::text AS xp FROM user_season_progress WHERE season_id = $1 AND user_id = $2 FOR UPDATE",
    [season.id, user.id],
  );
  const before = rows.length === 0 ? 0 : Number(rows[0].xp);
  await tx.query(
    `UPDATE user_season_progress SET xp = 0, updated_at = now()
      WHERE season_id = $1 AND user_id = $2`,
    [season.id, user.id],
  );
  await writeAudit(tx, ctx, "season:reset-user", "user", publicId, {
    season: season.number,
    before,
    after: 0,
    reason,
  });
  return { before, after: 0, season: season.number };
}

// ----------------------------------------------------------------- seasons

export interface SeasonInput {
  name: string;
  startsAt: Date;
  endsAt: Date;
  number?: number;
  /** Season level -> catalog flare for the track's cosmetic slot. */
  rewardFlares?: Record<string, string>;
}

const COSMETIC_LEVELS = new Set(
  SEASON_TRACK.filter((r) => r.cosmetic).map((r) => String(r.level)),
);

function checkSeasonInput(
  input: Partial<SeasonInput>,
  validFlares: ReadonlySet<string> | null,
): void {
  if (input.name !== undefined) {
    const name = input.name.trim();
    if (name.length < 1 || name.length > 40) {
      throw new AdminOpError(
        "INVALID_NAME",
        "a season name is 1 to 40 characters",
      );
    }
  }
  if (
    (input.startsAt !== undefined && Number.isNaN(input.startsAt.getTime())) ||
    (input.endsAt !== undefined && Number.isNaN(input.endsAt.getTime()))
  ) {
    throw new AdminOpError("INVALID_DATES", "the season dates are not valid");
  }
  for (const [level, flare] of Object.entries(input.rewardFlares ?? {})) {
    if (!COSMETIC_LEVELS.has(level)) {
      throw new AdminOpError(
        "INVALID_REWARD",
        `level ${level} has no cosmetic slot on the track`,
      );
    }
    if (validFlares === null || !validFlares.has(flare)) {
      throw new AdminOpError(
        "INVALID_REWARD",
        `${flare} is not in the catalog`,
      );
    }
  }
}

async function assertNoOverlap(
  tx: PoolClient,
  startsAt: Date,
  endsAt: Date,
  exceptId: string | null,
): Promise<void> {
  const { rows } = await tx.query<{ number: number }>(
    `SELECT number FROM seasons
      WHERE ($3::bigint IS NULL OR id <> $3::bigint)
        AND starts_at < $2 AND ends_at > $1 LIMIT 1`,
    [startsAt, endsAt, exceptId],
  );
  if (rows.length > 0) {
    throw new AdminOpError(
      "OVERLAP",
      `that overlaps season ${rows[0].number}`,
      409,
    );
  }
}

/** Seasons are created by the owner: no overlap, ever (the table is locked while this runs). */
export async function createSeason(
  tx: PoolClient,
  ctx: AuditContext,
  input: SeasonInput,
  validFlares: ReadonlySet<string> | null,
): Promise<SeasonRow> {
  checkSeasonInput(input, validFlares);
  if (input.endsAt.getTime() <= input.startsAt.getTime()) {
    throw new AdminOpError(
      "INVALID_DATES",
      "a season must end after it starts",
    );
  }
  await tx.query("LOCK TABLE seasons IN EXCLUSIVE MODE");
  await assertNoOverlap(tx, input.startsAt, input.endsAt, null);
  let number = input.number;
  if (number === undefined) {
    const next = await tx.query<{ n: number }>(
      "SELECT COALESCE(max(number), 0) + 1 AS n FROM seasons",
    );
    number = next.rows[0].n;
  }
  try {
    const { rows } = await tx.query<Parameters<typeof toSeason>[0]>(
      `INSERT INTO seasons (number, name, starts_at, ends_at, reward_flares, created_by)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6) RETURNING ${SEASON_COLUMNS}`,
      [
        number,
        input.name.trim(),
        input.startsAt,
        input.endsAt,
        JSON.stringify(input.rewardFlares ?? {}),
        ctx.actorUserId ?? null,
      ],
    );
    const season = toSeason(rows[0]);
    await writeAudit(
      tx,
      ctx,
      "season:create",
      "season",
      String(season.number),
      {
        name: season.name,
        startsAt: season.startsAt.toISOString(),
        endsAt: season.endsAt.toISOString(),
        rewardFlares: season.rewardFlares,
      },
    );
    return season;
  } catch (error) {
    if ((error as { code?: string }).code === "23505") {
      throw new AdminOpError(
        "NUMBER_TAKEN",
        `season ${number} already exists`,
        409,
      );
    }
    throw error;
  }
}

export interface SeasonPatch {
  name?: string;
  startsAt?: Date;
  endsAt?: Date;
  rewardFlares?: Record<string, string>;
}

async function seasonById(tx: PoolClient, id: string): Promise<SeasonRow> {
  const { rows } = await tx.query<Parameters<typeof toSeason>[0]>(
    `SELECT ${SEASON_COLUMNS} FROM seasons WHERE id = $1 FOR UPDATE`,
    [id],
  );
  if (rows.length === 0) {
    throw new AdminOpError("NOT_FOUND", "no such season", 404);
  }
  return toSeason(rows[0]);
}

/** Edits a season that is not archived; its start can only move while it has not begun. */
export async function updateSeason(
  tx: PoolClient,
  ctx: AuditContext,
  id: string,
  patch: SeasonPatch,
  validFlares: ReadonlySet<string> | null,
): Promise<SeasonRow> {
  checkSeasonInput(patch, validFlares);
  await tx.query("LOCK TABLE seasons IN EXCLUSIVE MODE");
  const season = await seasonById(tx, id);
  if (season.archivedAt !== null) {
    throw new AdminOpError(
      "ARCHIVED",
      "an archived season cannot be changed",
      409,
    );
  }
  if (
    patch.startsAt !== undefined &&
    season.startsAt.getTime() <= Date.now() &&
    patch.startsAt.getTime() !== season.startsAt.getTime()
  ) {
    throw new AdminOpError(
      "STARTED",
      "a season that has begun keeps its start",
      409,
    );
  }
  const startsAt = patch.startsAt ?? season.startsAt;
  const endsAt = patch.endsAt ?? season.endsAt;
  if (endsAt.getTime() <= startsAt.getTime()) {
    throw new AdminOpError(
      "INVALID_DATES",
      "a season must end after it starts",
    );
  }
  await assertNoOverlap(tx, startsAt, endsAt, id);
  const { rows } = await tx.query<Parameters<typeof toSeason>[0]>(
    `UPDATE seasons
          SET reward_flares = $5::jsonb,
              name = $2, starts_at = $3, ends_at = $4
      WHERE id = $1 RETURNING ${SEASON_COLUMNS}`,
    [
      id,
      patch.name?.trim() ?? season.name,
      startsAt,
      endsAt,
      JSON.stringify(patch.rewardFlares ?? season.rewardFlares),
    ],
  );
  const updated = toSeason(rows[0]);
  await writeAudit(tx, ctx, "season:update", "season", String(season.number), {
    before: { name: season.name, endsAt: season.endsAt.toISOString() },
    after: { name: updated.name, endsAt: updated.endsAt.toISOString() },
  });
  return updated;
}

/**
 * Stores each player's final season level and, for the accounts that may be
 * listed, final rank (most XP first, then who reached it first, then public
 * id), and marks the season archived. Nothing is deleted.
 */
export async function archiveSeason(
  tx: PoolClient,
  seasonId: string,
): Promise<void> {
  await tx.query(
    `UPDATE user_season_progress p
        SET final_level = LEAST($2::int, 1 + (p.xp / $3::bigint)::int)
      WHERE p.season_id = $1`,
    [seasonId, SEASON_MAX_LEVEL, SEASON_XP_PER_LEVEL],
  );
  await tx.query(
    `WITH listed AS (
       SELECT s.user_id,
              row_number() OVER (ORDER BY s.xp DESC, s.updated_at, u.public_id COLLATE "C") AS pos
         FROM user_season_progress s JOIN users u ON u.id = s.user_id
        WHERE s.season_id = $1 AND s.xp > 0 AND u.kind = 'registered'
          AND u.deleted_at IS NULL AND u.deletion_requested_at IS NULL
          AND u.role IS DISTINCT FROM 'flagged'
          AND NOT EXISTS (SELECT 1 FROM bans b WHERE b.user_id = u.id AND b.revoked_at IS NULL
                           AND (b.expires_at IS NULL OR b.expires_at > now())))
     UPDATE user_season_progress p SET final_rank = l.pos
       FROM listed l WHERE p.season_id = $1 AND p.user_id = l.user_id`,
    [seasonId],
  );
  await tx.query("UPDATE seasons SET archived_at = now() WHERE id = $1", [
    seasonId,
  ]);
}

/** Ends a season now and archives it at once (the owner closing it early). */
export async function closeSeason(
  tx: PoolClient,
  ctx: AuditContext,
  id: string,
): Promise<SeasonRow> {
  const season = await seasonById(tx, id);
  if (season.archivedAt !== null) {
    throw new AdminOpError("ARCHIVED", "that season is already archived", 409);
  }
  if (season.startsAt.getTime() > Date.now()) {
    throw new AdminOpError(
      "NOT_STARTED",
      "that season has not begun: move its dates instead",
      409,
    );
  }
  await tx.query(
    "UPDATE seasons SET ends_at = LEAST(ends_at, now()) WHERE id = $1",
    [id],
  );
  await archiveSeason(tx, id);
  await writeAudit(tx, ctx, "season:close", "season", String(season.number), {
    name: season.name,
  });
  return await seasonById(tx, id);
}

/**
 * Archives every season that ended more than the grace period ago. Safe to run
 * from several instances and to repeat; returns the numbers it archived.
 */
export async function archiveDueSeasons(
  pool: Pick<Pool, "connect">,
  now: Date = new Date(),
): Promise<number[]> {
  const due = await withTransaction(pool, async (tx) => {
    // Wait for another instance that is archiving: when it is done there is
    // nothing left for this one to find, so a repeat is harmless.
    await tx.query("SELECT pg_advisory_xact_lock($1::bigint)", ["7374410004"]);
    const { rows } = await tx.query<{ id: string; number: number }>(
      `SELECT id::text AS id, number FROM seasons
        WHERE archived_at IS NULL
          AND ends_at + make_interval(mins => $2) <= $1
        ORDER BY number FOR UPDATE`,
      [now, PROGRESSION.seasonGraceMinutes],
    );
    for (const season of rows) await archiveSeason(tx, season.id);
    return rows.map((r) => r.number);
  });
  return due;
}
