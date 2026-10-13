import type { Pool, PoolClient } from "pg";
import { withTransaction } from "../db/tx";
import { clanByTag, roleIn, type ClanRow } from "../repo/clans";
import {
  can,
  checkClanName,
  checkClanTag,
  checkCreateEligibility,
  checkDescription,
  checkDiscordUrl,
  isReservedName,
  isReservedTag,
  type ClanAction,
  type ClanRole,
  type ReservedClanNames,
} from "./clans";
import { CLAN_RULES } from "./constants";

/**
 * Everything that changes a clan, one function per action (docs/
 * DeltaFrontAccountsPlan.md section 12). Each runs in one transaction that
 * first locks the clan's row, so two actions on one clan are serialised, then
 * re-reads the actor's role INSIDE the transaction (a role fetched earlier can
 * be stale) and asks `can()` before touching anything. A refusal throws a
 * ClanError and rolls everything back.
 *
 * One clan per account is also a database fact (`UNIQUE clan_members(user_id)`):
 * when two joins race, the loser's INSERT fails and is reported as
 * ALREADY_IN_CLAN.
 */

export class ClanError extends Error {
  constructor(
    readonly status: number,
    readonly body: Record<string, unknown>,
  ) {
    super(String(body.code ?? body.message ?? status));
    this.name = "ClanError";
  }
}

const fail = (status: number, code: string, extra: object = {}): never => {
  throw new ClanError(status, { code, ...extra });
};

const DAY_MS = 86_400_000;

type Tx = PoolClient;

interface Actor {
  id: string;
}

/** Locks and returns the live clan with this tag, or 404. */
async function lockClan(tx: Tx, tag: string): Promise<ClanRow> {
  const { rows } = await tx.query<{ id: string }>(
    "SELECT id::text AS id FROM clans WHERE tag = $1 AND disbanded_at IS NULL FOR UPDATE",
    [tag],
  );
  if (rows.length === 0) return fail(404, "CLAN_NOT_FOUND");
  const clan = await clanByTag(tx, tag);
  return clan ?? fail(404, "CLAN_NOT_FOUND");
}

/** The actor's role in the clan, refusing anything the permission table does not allow. */
async function requireCan(
  tx: Tx,
  clan: ClanRow,
  actor: Actor,
  action: ClanAction,
  targetRole: ClanRole | null = null,
): Promise<ClanRole> {
  const role = await roleIn(tx, clan.id, actor.id);
  if (role === null) return fail(403, "NOT_A_MEMBER");
  if (!can(role, action, targetRole)) return fail(403, "FORBIDDEN");
  return role;
}

interface TargetUser {
  id: string;
  publicId: string;
  unavailable: boolean;
}

async function targetByPublicId(
  tx: Tx,
  publicId: unknown,
): Promise<TargetUser> {
  if (typeof publicId !== "string" || !/^[A-Za-z0-9]{6,32}$/.test(publicId)) {
    return fail(400, "INVALID_TARGET");
  }
  const { rows } = await tx.query<{
    id: string;
    public_id: string;
    deleted_at: Date | null;
    deletion_requested_at: Date | null;
  }>(
    "SELECT id, public_id, deleted_at, deletion_requested_at FROM users WHERE public_id = $1",
    [publicId],
  );
  if (rows.length === 0) return fail(404, "TARGET_NOT_FOUND");
  return {
    id: rows[0].id,
    publicId: rows[0].public_id,
    unavailable:
      rows[0].deleted_at !== null || rows[0].deletion_requested_at !== null,
  };
}

async function event(
  tx: Tx,
  clanId: string,
  actor: string | null,
  action: string,
  target: string | null = null,
  details: object = {},
): Promise<void> {
  await tx.query(
    "INSERT INTO clan_events (clan_id, actor, action, target, details) VALUES ($1, $2, $3, $4, $5)",
    [clanId, actor, action, target, details],
  );
}

/** A unique-violation, as the constraint it broke. */
const violated = (error: unknown): string | null =>
  (error as { code?: string }).code === "23505"
    ? ((error as { constraint?: string }).constraint ?? "")
    : null;

async function run<T>(
  pool: Pick<Pool, "connect">,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  try {
    return await withTransaction(pool, fn);
  } catch (error) {
    const constraint = violated(error);
    if (constraint === "clan_members_user_id_key") {
      return fail(409, "ALREADY_IN_CLAN", { message: "Already in a clan" });
    }
    if (constraint === "clans_tag_live") return fail(409, "TAG_TAKEN");
    if (constraint === "clans_name_live") return fail(409, "NAME_TAKEN");
    throw error;
  }
}

// ---------------------------------------------------------------- create

export interface CreateInput {
  name: unknown;
  tag: unknown;
  description?: unknown;
  isOpen?: unknown;
}

/**
 * Creates a clan and makes the caller its leader (plan 12.2), atomically.
 * Checks, in order: the input is well formed, the account is not already in a
 * clan, is old enough and has enough completed games, then that the tag and
 * name are free (not reserved, held, or used by a live clan).
 */
export async function createClan(
  pool: Pick<Pool, "connect">,
  user: { id: string; createdAt: Date },
  input: CreateInput,
  reserved: ReservedClanNames,
  now: Date = new Date(),
): Promise<string> {
  const name = checkClanName(input.name);
  if (!name.ok) return fail(400, name.code);
  const tag = checkClanTag(input.tag);
  if (!tag.ok) return fail(400, tag.code);
  const description = checkDescription(input.description ?? "");
  if (!description.ok) return fail(400, "INVALID_DESCRIPTION");
  if (input.isOpen !== undefined && typeof input.isOpen !== "boolean") {
    return fail(400, "INVALID_REQUEST");
  }
  const isOpen = input.isOpen ?? true;

  return run(pool, async (tx) => {
    const me = await tx.query<{
      deleted_at: Date | null;
      deletion_requested_at: Date | null;
    }>("SELECT deleted_at, deletion_requested_at FROM users WHERE id = $1", [
      user.id,
    ]);
    if (
      me.rows.length === 0 ||
      me.rows[0].deleted_at !== null ||
      me.rows[0].deletion_requested_at !== null
    ) {
      return fail(401, "UNAUTHORIZED");
    }
    const existing = await tx.query(
      "SELECT 1 FROM clan_members WHERE user_id = $1",
      [user.id],
    );
    if (existing.rows.length > 0) {
      return fail(403, "ALREADY_IN_CLAN", { message: "Already in a clan" });
    }
    const games = await tx.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM game_players WHERE user_id = $1 AND completed",
      [user.id],
    );
    const eligible = checkCreateEligibility(
      user.createdAt,
      games.rows[0].n,
      now,
    );
    if (!eligible.ok) {
      return fail(403, eligible.code, {
        required: eligible.required,
        current: eligible.current,
      });
    }
    if (
      isReservedTag(reserved, tag.value) ||
      isReservedName(reserved, name.value)
    ) {
      return fail(
        409,
        isReservedTag(reserved, tag.value) ? "TAG_TAKEN" : "NAME_TAKEN",
      );
    }
    const held = await tx.query<{ reusable_after: Date }>(
      "SELECT reusable_after FROM clan_tag_holds WHERE tag = $1 FOR UPDATE",
      [tag.value],
    );
    if (held.rows.length > 0) {
      if (held.rows[0].reusable_after > now) return fail(409, "TAG_HELD");
      await tx.query("DELETE FROM clan_tag_holds WHERE tag = $1", [tag.value]);
    }
    const clan = await tx.query<{ id: string }>(
      `INSERT INTO clans (tag, name, description, is_open, created_by)
       VALUES ($1, $2, $3, $4, $5) RETURNING id::text AS id`,
      [tag.value, name.value, description.value, isOpen, user.id],
    );
    const clanId = clan.rows[0].id;
    await tx.query(
      "INSERT INTO clan_members (clan_id, user_id, role) VALUES ($1, $2, 'leader')",
      [clanId, user.id],
    );
    await tx.query("DELETE FROM clan_join_requests WHERE user_id = $1", [
      user.id,
    ]);
    await event(tx, clanId, user.id, "create", null, {
      tag: tag.value,
      name: name.value,
    });
    return tag.value;
  });
}

// ------------------------------------------------------------ membership

/** Puts `userId` in the clan as a member and clears all their pending requests. */
async function addMember(tx: Tx, clan: ClanRow, userId: string): Promise<void> {
  await tx.query(
    "INSERT INTO clan_members (clan_id, user_id, role) VALUES ($1, $2, 'member')",
    [clan.id, userId],
  );
  await tx.query("DELETE FROM clan_join_requests WHERE user_id = $1", [userId]);
}

async function clanBan(tx: Tx, clanId: string, userId: string) {
  const { rows } = await tx.query<{ reason: string | null }>(
    "SELECT reason FROM clan_bans WHERE clan_id = $1 AND user_id = $2",
    [clanId, userId],
  );
  return rows.length === 0 ? null : { reason: rows[0].reason };
}

export type JoinResult = "joined" | "requested";

/** Joins an open clan, or asks to join a closed one (plan 12.2). */
export async function joinClan(
  pool: Pick<Pool, "connect">,
  user: Actor,
  tag: string,
): Promise<JoinResult> {
  return run(pool, async (tx) => {
    const clan = await lockClan(tx, tag);
    const inClan = await tx.query(
      "SELECT 1 FROM clan_members WHERE user_id = $1",
      [user.id],
    );
    if (inClan.rows.length > 0) {
      return fail(409, "ALREADY_IN_CLAN", { message: "Already in a clan" });
    }
    const ban = await clanBan(tx, clan.id, user.id);
    if (ban !== null) {
      return fail(
        403,
        "BANNED",
        ban.reason === null ? {} : { reason: ban.reason },
      );
    }
    if (clan.isOpen) {
      await addMember(tx, clan, user.id);
      await event(tx, clan.id, user.id, "join");
      return "joined";
    }
    const pending = await tx.query<{ clan_id: string }>(
      "SELECT clan_id FROM clan_join_requests WHERE user_id = $1",
      [user.id],
    );
    if (pending.rows.some((r) => r.clan_id === clan.id)) {
      return fail(409, "REQUEST_PENDING", {
        message: "Join request already pending",
      });
    }
    if (pending.rows.length >= CLAN_RULES.maxPendingRequests) {
      return fail(429, "TOO_MANY_REQUESTS", {
        message: "Too many pending requests",
      });
    }
    await tx.query(
      "INSERT INTO clan_join_requests (clan_id, user_id) VALUES ($1, $2)",
      [clan.id, user.id],
    );
    await event(tx, clan.id, user.id, "request");
    return "requested";
  });
}

/** Removes the clan: members and requests go, the tag is held, the name is freed. */
async function disbandLocked(
  tx: Tx,
  clan: ClanRow,
  actor: string | null,
  byAdmin: boolean,
  details: object = {},
): Promise<void> {
  await tx.query(
    "UPDATE clans SET disbanded_at = now(), removed_by_admin = $2 WHERE id = $1",
    [clan.id, byAdmin],
  );
  await tx.query("DELETE FROM clan_members WHERE clan_id = $1", [clan.id]);
  await tx.query("DELETE FROM clan_join_requests WHERE clan_id = $1", [
    clan.id,
  ]);
  await tx.query(
    `INSERT INTO clan_tag_holds (tag, reusable_after)
     VALUES ($1, now() + make_interval(days => $2))
     ON CONFLICT (tag) DO UPDATE SET released_at = now(), reusable_after = excluded.reusable_after`,
    [clan.tag, CLAN_RULES.disbandedTagHoldDays],
  );
  await event(
    tx,
    clan.id,
    actor,
    byAdmin ? "admin-remove" : "disband",
    null,
    details,
  );
}

/**
 * Leaves the clan. A leader with other members must hand over leadership first
 * (409 TRANSFER_REQUIRED); a leader who is the only member disbands the clan.
 */
export async function leaveClan(
  pool: Pick<Pool, "connect">,
  user: Actor,
  tag: string,
): Promise<void> {
  await run(pool, async (tx) => {
    const clan = await lockClan(tx, tag);
    const role = await roleIn(tx, clan.id, user.id);
    if (role === null) return fail(404, "NOT_A_MEMBER");
    if (role === "leader") {
      const others = await tx.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM clan_members WHERE clan_id = $1 AND user_id <> $2",
        [clan.id, user.id],
      );
      if (others.rows[0].n > 0) return fail(409, "TRANSFER_REQUIRED");
      await disbandLocked(tx, clan, user.id, false, {
        reason: "last member left",
      });
      return;
    }
    await tx.query(
      "DELETE FROM clan_members WHERE clan_id = $1 AND user_id = $2",
      [clan.id, user.id],
    );
    await event(tx, clan.id, user.id, "leave");
  });
}

export async function disbandClan(
  pool: Pick<Pool, "connect">,
  user: Actor,
  tag: string,
): Promise<void> {
  await run(pool, async (tx) => {
    const clan = await lockClan(tx, tag);
    await requireCan(tx, clan, user, "disband");
    await disbandLocked(tx, clan, user.id, false);
  });
}

// ------------------------------------------------------- managing members

async function targetRole(
  tx: Tx,
  clan: ClanRow,
  target: TargetUser,
): Promise<ClanRole> {
  const role = await roleIn(tx, clan.id, target.id);
  return role ?? fail(404, "TARGET_NOT_A_MEMBER");
}

function notSelf(actor: Actor, target: TargetUser): void {
  if (actor.id === target.id) fail(400, "INVALID_TARGET");
}

export async function kickMember(
  pool: Pick<Pool, "connect">,
  actor: Actor,
  tag: string,
  targetPublicId: unknown,
): Promise<void> {
  await run(pool, async (tx) => {
    const clan = await lockClan(tx, tag);
    const target = await targetByPublicId(tx, targetPublicId);
    notSelf(actor, target);
    const role = await targetRole(tx, clan, target);
    await requireCan(tx, clan, actor, "kick", role);
    await tx.query(
      "DELETE FROM clan_members WHERE clan_id = $1 AND user_id = $2",
      [clan.id, target.id],
    );
    await event(tx, clan.id, actor.id, "kick", target.id);
  });
}

export async function promoteMember(
  pool: Pick<Pool, "connect">,
  actor: Actor,
  tag: string,
  targetPublicId: unknown,
): Promise<void> {
  await run(pool, async (tx) => {
    const clan = await lockClan(tx, tag);
    const target = await targetByPublicId(tx, targetPublicId);
    notSelf(actor, target);
    const role = await targetRole(tx, clan, target);
    await requireCan(tx, clan, actor, "promote", role);
    await tx.query(
      "UPDATE clan_members SET role = 'officer' WHERE clan_id = $1 AND user_id = $2",
      [clan.id, target.id],
    );
    await event(tx, clan.id, actor.id, "promote", target.id);
  });
}

export async function demoteMember(
  pool: Pick<Pool, "connect">,
  actor: Actor,
  tag: string,
  targetPublicId: unknown,
): Promise<void> {
  await run(pool, async (tx) => {
    const clan = await lockClan(tx, tag);
    const target = await targetByPublicId(tx, targetPublicId);
    notSelf(actor, target);
    const role = await targetRole(tx, clan, target);
    await requireCan(tx, clan, actor, "demote", role);
    await tx.query(
      "UPDATE clan_members SET role = 'member' WHERE clan_id = $1 AND user_id = $2",
      [clan.id, target.id],
    );
    await event(tx, clan.id, actor.id, "demote", target.id);
  });
}

/** Moves a clan's leadership to `targetId`; the old leader becomes an officer. */
async function transferLeadershipTo(
  tx: Tx,
  clan: ClanRow,
  oldLeaderId: string,
  targetId: string,
): Promise<void> {
  // The one-leader index forbids two leaders even for an instant: demote first.
  await tx.query(
    "UPDATE clan_members SET role = 'officer' WHERE clan_id = $1 AND user_id = $2",
    [clan.id, oldLeaderId],
  );
  await tx.query(
    "UPDATE clan_members SET role = 'leader' WHERE clan_id = $1 AND user_id = $2",
    [clan.id, targetId],
  );
}

export async function transferLeadership(
  pool: Pick<Pool, "connect">,
  actor: Actor,
  tag: string,
  targetPublicId: unknown,
): Promise<void> {
  await run(pool, async (tx) => {
    const clan = await lockClan(tx, tag);
    const target = await targetByPublicId(tx, targetPublicId);
    notSelf(actor, target);
    // The leader is never a valid target, and only the leader may transfer.
    const role = await roleIn(tx, clan.id, target.id);
    if (role === null) return fail(404, "TARGET_NOT_A_MEMBER");
    await requireCan(tx, clan, actor, "transfer", role);
    if (target.unavailable) return fail(409, "ACCOUNT_UNAVAILABLE");
    await transferLeadershipTo(tx, clan, actor.id, target.id);
    await event(tx, clan.id, actor.id, "transfer", target.id);
  });
}

// ---------------------------------------------------------------- requests

export async function approveRequest(
  pool: Pick<Pool, "connect">,
  actor: Actor,
  tag: string,
  targetPublicId: unknown,
): Promise<void> {
  let stale: string | null = null;
  try {
    await run(pool, async (tx) => {
      const clan = await lockClan(tx, tag);
      await requireCan(tx, clan, actor, "approve");
      const target = await targetByPublicId(tx, targetPublicId);
      const request = await tx.query(
        "SELECT 1 FROM clan_join_requests WHERE clan_id = $1 AND user_id = $2",
        [clan.id, target.id],
      );
      if (request.rows.length === 0) return fail(404, "REQUEST_NOT_FOUND");
      const dropRequest = () =>
        tx.query(
          "DELETE FROM clan_join_requests WHERE clan_id = $1 AND user_id = $2",
          [clan.id, target.id],
        );
      if (target.unavailable) {
        await dropRequest();
        // The request is gone even though the call is refused.
        stale = "ACCOUNT_UNAVAILABLE";
        throw new ClanError(409, { code: "ACCOUNT_UNAVAILABLE" });
      }
      const inClan = await tx.query(
        "SELECT 1 FROM clan_members WHERE user_id = $1",
        [target.id],
      );
      if (inClan.rows.length > 0) {
        await dropRequest();
        stale = "ALREADY_IN_CLAN";
        throw new ClanError(409, {
          code: "ALREADY_IN_CLAN",
          message: "Already in a clan",
        });
      }
      if ((await clanBan(tx, clan.id, target.id)) !== null) {
        await dropRequest();
        stale = "BANNED";
        throw new ClanError(409, { code: "BANNED" });
      }
      await addMember(tx, clan, target.id);
      await event(tx, clan.id, actor.id, "approve", target.id);
    });
  } catch (error) {
    if (
      stale !== null ||
      (error instanceof ClanError && error.body.code === "ALREADY_IN_CLAN")
    ) {
      // A refusal rolled the transaction back, including the removal of the
      // request that can never be approved: remove it for good.
      await removeStaleRequest(pool, tag, targetPublicId);
    }
    throw error;
  }
}

async function removeStaleRequest(
  pool: Pick<Pool, "connect">,
  tag: string,
  targetPublicId: unknown,
): Promise<void> {
  if (typeof targetPublicId !== "string") return;
  await withTransaction(pool, async (tx) => {
    await tx.query(
      `DELETE FROM clan_join_requests r USING clans c, users u
        WHERE r.clan_id = c.id AND c.tag = $1 AND c.disbanded_at IS NULL
          AND r.user_id = u.id AND u.public_id = $2`,
      [tag, targetPublicId],
    );
  });
}

export async function denyRequest(
  pool: Pick<Pool, "connect">,
  actor: Actor,
  tag: string,
  targetPublicId: unknown,
): Promise<void> {
  await run(pool, async (tx) => {
    const clan = await lockClan(tx, tag);
    await requireCan(tx, clan, actor, "deny");
    const target = await targetByPublicId(tx, targetPublicId);
    const gone = await tx.query(
      "DELETE FROM clan_join_requests WHERE clan_id = $1 AND user_id = $2",
      [clan.id, target.id],
    );
    if ((gone.rowCount ?? 0) === 0) return fail(404, "REQUEST_NOT_FOUND");
    await event(tx, clan.id, actor.id, "deny", target.id);
  });
}

export async function withdrawRequest(
  pool: Pick<Pool, "connect">,
  actor: Actor,
  tag: string,
): Promise<void> {
  await run(pool, async (tx) => {
    const clan = await lockClan(tx, tag);
    const gone = await tx.query(
      "DELETE FROM clan_join_requests WHERE clan_id = $1 AND user_id = $2",
      [clan.id, actor.id],
    );
    if ((gone.rowCount ?? 0) === 0) return fail(404, "REQUEST_NOT_FOUND");
  });
}

// -------------------------------------------------------------------- bans

const cleanReason = (raw: unknown): string | null => {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "string") return fail(400, "INVALID_REQUEST");
  const reason = raw
    .replace(/[\p{C}\p{Zl}\p{Zp}]/gu, " ")
    .replace(/ +/g, " ")
    .trim();
  if (reason.length > CLAN_RULES.banReasonMaxLength)
    return fail(400, "INVALID_REQUEST");
  return reason === "" ? null : reason;
};

export async function banMember(
  pool: Pick<Pool, "connect">,
  actor: Actor,
  tag: string,
  targetPublicId: unknown,
  rawReason: unknown,
): Promise<void> {
  const reason = cleanReason(rawReason);
  await run(pool, async (tx) => {
    const clan = await lockClan(tx, tag);
    const target = await targetByPublicId(tx, targetPublicId);
    notSelf(actor, target);
    const role = await roleIn(tx, clan.id, target.id);
    await requireCan(tx, clan, actor, "ban", role);
    await tx.query(
      `INSERT INTO clan_bans (clan_id, user_id, banned_by, reason)
       VALUES ($1, $2,
               $3, $4)
       ON CONFLICT (clan_id, user_id) DO UPDATE
          SET banned_by = excluded.banned_by, reason = excluded.reason, created_at = now()`,
      [clan.id, target.id, actor.id, reason],
    );
    await tx.query(
      "DELETE FROM clan_members WHERE clan_id = $1 AND user_id = $2",
      [clan.id, target.id],
    );
    await tx.query(
      "DELETE FROM clan_join_requests WHERE clan_id = $1 AND user_id = $2",
      [clan.id, target.id],
    );
    await event(
      tx,
      clan.id,
      actor.id,
      "ban",
      target.id,
      reason === null ? {} : { reason },
    );
  });
}

export async function unbanMember(
  pool: Pick<Pool, "connect">,
  actor: Actor,
  tag: string,
  targetPublicId: unknown,
): Promise<void> {
  await run(pool, async (tx) => {
    const clan = await lockClan(tx, tag);
    await requireCan(tx, clan, actor, "unban");
    const target = await targetByPublicId(tx, targetPublicId);
    const gone = await tx.query(
      "DELETE FROM clan_bans WHERE clan_id = $1 AND user_id = $2",
      [clan.id, target.id],
    );
    if ((gone.rowCount ?? 0) === 0) return fail(404, "NOT_BANNED");
    await event(tx, clan.id, actor.id, "unban", target.id);
  });
}

// ------------------------------------------------------------------ editing

export interface ClanPatch {
  name?: unknown;
  description?: unknown;
  discordUrl?: unknown;
  isOpen?: unknown;
}

/**
 * Edits the clan. The leader may change anything; an officer may change the
 * description, Discord link and openness; renaming is the leader's, once per
 * `nameChangeCooldownDays`, and the new name is screened, unique and not a
 * reserved imitation. The tag never changes.
 */
export async function updateClan(
  pool: Pick<Pool, "connect">,
  actor: Actor,
  tag: string,
  patch: ClanPatch,
  reserved: ReservedClanNames,
  now: Date = new Date(),
): Promise<void> {
  await run(pool, async (tx) => {
    const clan = await lockClan(tx, tag);
    let role = await requireCan(tx, clan, actor, "edit");
    const sets: string[] = [];
    const params: unknown[] = [clan.id];
    const set = (column: string, value: unknown) => {
      params.push(value);
      sets.push(`${column} = $${params.length}`);
    };
    if (patch.name !== undefined) {
      role = await requireCan(tx, clan, actor, "rename");
      const name = checkClanName(patch.name);
      if (!name.ok) return fail(400, name.code);
      if (name.value !== clan.name) {
        if (isReservedName(reserved, name.value))
          return fail(409, "NAME_TAKEN");
        const last = await tx.query<{ created_at: Date }>(
          "SELECT created_at FROM clan_events WHERE clan_id = $1 AND action = 'rename' ORDER BY id DESC LIMIT 1",
          [clan.id],
        );
        if (
          last.rows.length > 0 &&
          now.getTime() - last.rows[0].created_at.getTime() <
            CLAN_RULES.nameChangeCooldownDays * DAY_MS
        ) {
          return fail(409, "NAME_COOLDOWN");
        }
        set("name", name.value);
        await event(tx, clan.id, actor.id, "rename", null, {
          from: clan.name,
          to: name.value,
        });
      }
    }
    if (patch.description !== undefined) {
      const description = checkDescription(patch.description);
      if (!description.ok) return fail(400, "INVALID_DESCRIPTION");
      set("description", description.value);
    }
    if (patch.discordUrl !== undefined) {
      const url = checkDiscordUrl(patch.discordUrl);
      if (!url.ok) return fail(400, "DISCORD_INVALID");
      set("discord_url", url.value);
    }
    if (patch.isOpen !== undefined) {
      if (typeof patch.isOpen !== "boolean")
        return fail(400, "INVALID_REQUEST");
      set("is_open", patch.isOpen);
    }
    void role;
    if (sets.length > 0) {
      await tx.query(
        `UPDATE clans SET ${sets.join(", ")} WHERE id = $1`,
        params,
      );
      await event(tx, clan.id, actor.id, "edit");
    }
  });
}

// ------------------------------------------------ account lifecycle, admin

/**
 * Takes a deleted account out of its clan (plan 12.4): a leader's clan goes to
 * the oldest officer, else the oldest member, else it is disbanded. Pending
 * requests and bans naming the account are removed. Runs inside the account
 * deletion's transaction.
 */
export async function removeAccountFromClans(
  tx: Tx,
  userId: string,
): Promise<void> {
  await tx.query("DELETE FROM clan_join_requests WHERE user_id = $1", [userId]);
  await tx.query("DELETE FROM clan_bans WHERE user_id = $1", [userId]);
  const membership = await tx.query<{ tag: string }>(
    `SELECT c.tag::text AS tag FROM clan_members m JOIN clans c ON c.id = m.clan_id WHERE m.user_id = $1`,
    [userId],
  );
  for (const { tag } of membership.rows) {
    const clan = await lockClan(tx, tag).catch(() => null);
    if (clan === null) continue;
    const role = await roleIn(tx, clan.id, userId);
    if (role === null) continue;
    if (role === "leader") {
      const successor = await tx.query<{ user_id: string }>(
        `SELECT m.user_id FROM clan_members m JOIN users u ON u.id = m.user_id
          WHERE m.clan_id = $1 AND m.user_id <> $2
            AND u.deleted_at IS NULL AND u.deletion_requested_at IS NULL
          ORDER BY (m.role = 'officer') DESC, m.joined_at, m.user_id LIMIT 1`,
        [clan.id, userId],
      );
      if (successor.rows.length === 0) {
        await disbandLocked(tx, clan, null, false, {
          reason: "owner deleted, no successor",
        });
        continue;
      }
      await transferLeadershipTo(tx, clan, userId, successor.rows[0].user_id);
      await event(tx, clan.id, null, "transfer", successor.rows[0].user_id, {
        reason: "leader account deleted",
      });
    }
    await tx.query(
      "DELETE FROM clan_members WHERE clan_id = $1 AND user_id = $2",
      [clan.id, userId],
    );
    await event(tx, clan.id, null, "leave", userId, {
      reason: "account deleted",
    });
  }
}

/** What an admin command runs inside the same transaction as its change (its audit row). */
export type AdminAudit = (tx: Tx, clan: ClanRow) => Promise<void>;

/** Admin: remove a clan for cause. The tag is held like any disbanded tag. */
export async function adminRemoveClan(
  pool: Pick<Pool, "connect">,
  tag: string,
  reason: string,
  audit: AdminAudit,
): Promise<ClanRow> {
  return run(pool, async (tx) => {
    const clan = await lockClan(tx, tag);
    await disbandLocked(tx, clan, null, true, { reason });
    await audit(tx, clan);
    return clan;
  });
}

/** Admin: take one member out of a clan (a leader first needs `adminTransferClan`, or the clan removed). */
export async function adminRemoveMember(
  pool: Pick<Pool, "connect">,
  tag: string,
  targetPublicId: string,
  reason: string,
  audit: AdminAudit,
): Promise<void> {
  await run(pool, async (tx) => {
    const clan = await lockClan(tx, tag);
    const target = await targetByPublicId(tx, targetPublicId);
    const role = await targetRole(tx, clan, target);
    if (role === "leader") return fail(409, "TRANSFER_REQUIRED");
    await tx.query(
      "DELETE FROM clan_members WHERE clan_id = $1 AND user_id = $2",
      [clan.id, target.id],
    );
    await event(tx, clan.id, null, "admin-kick", target.id, { reason });
    await audit(tx, clan);
  });
}

/** Admin: hand the clan to an existing member. */
export async function adminTransferClan(
  pool: Pick<Pool, "connect">,
  tag: string,
  targetPublicId: string,
  reason: string,
  audit: AdminAudit,
): Promise<void> {
  await run(pool, async (tx) => {
    const clan = await lockClan(tx, tag);
    const target = await targetByPublicId(tx, targetPublicId);
    const role = await targetRole(tx, clan, target);
    if (role === "leader") return fail(409, "ALREADY_LEADER");
    const leader = await tx.query<{ user_id: string }>(
      "SELECT user_id FROM clan_members WHERE clan_id = $1 AND role = 'leader'",
      [clan.id],
    );
    if (leader.rows.length === 0) return fail(409, "NO_LEADER");
    await transferLeadershipTo(tx, clan, leader.rows[0].user_id, target.id);
    await event(tx, clan.id, null, "admin-transfer", target.id, { reason });
    await audit(tx, clan);
  });
}

/** Admin: rename without the cooldown (still screened, unique and not a reserved imitation). */
export async function adminRenameClan(
  pool: Pick<Pool, "connect">,
  tag: string,
  rawName: string,
  reason: string,
  reserved: ReservedClanNames,
  audit: AdminAudit,
): Promise<void> {
  await run(pool, async (tx) => {
    const clan = await lockClan(tx, tag);
    const name = checkClanName(rawName);
    if (!name.ok) return fail(400, name.code);
    if (isReservedName(reserved, name.value)) return fail(409, "NAME_TAKEN");
    await tx.query("UPDATE clans SET name = $2 WHERE id = $1", [
      clan.id,
      name.value,
    ]);
    await event(tx, clan.id, null, "admin-rename", null, {
      from: clan.name,
      to: name.value,
      reason,
    });
    await audit(tx, clan);
  });
}
