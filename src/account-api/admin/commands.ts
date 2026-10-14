import {
  progressState,
  rankForLevel,
} from "@openfront/shared/ProgressionRules";
import { randomBytes } from "node:crypto";
import type { Pool } from "pg";
import { hasFlareShape, isWildcardFlare } from "../catalog/flares";
import { loadCatalog, type Catalog } from "../catalog/load";
import { withTransaction } from "../db/tx";
import {
  adjustCredits,
  AdminOpError,
  banUser,
  grantItem,
  revokeItem,
  revokeSessions,
  ROLE_VALUES,
  setBareNameEntitlement,
  setRole,
  setVerified,
  unbanUser,
  writeAudit,
  type AuditContext,
} from "../domain/adminOps";
import {
  adminRemoveClan,
  adminRemoveMember,
  adminRenameClan,
  adminTransferClan,
  ClanError,
} from "../domain/clanOps";
import { loadReservedClanNames, tagFromRoute } from "../domain/clans";
import { ACCOUNT_RULES } from "../domain/constants";
import {
  adjustXp,
  closeSeason,
  createSeason,
  type XpAdminAction,
} from "../domain/progressionOps";
import { displayUsername } from "../domain/usernames";
import { sha256 } from "../http";
import { clanByTag, clansOfUser } from "../repo/clans";
import { flareRowsOf } from "../repo/inventory";
import { allSeasons, progressRowOf, seasonByNumber } from "../repo/progression";
import type { Db } from "../repo/users";

/**
 * The admin commands (docs/DeltaFrontAccountsPlan.md section 15). Run on the
 * API host with `npm run admin -- <command>`. The staff web panel
 * (routes/admin.ts) calls the same operations (domain/adminOps.ts), so a rule is
 * written once. The CLI is the operator on the server: the owner role is
 * assigned only here, never over HTTP. Every change is one transaction that also
 * writes `admin_audit_log`, and anything destructive needs `--yes`.
 */

export interface AdminIo {
  out(line: string): void;
  err(line: string): void;
  /** Environment for `--from-env`. */
  env: Record<string, string | undefined>;
  /** Who is running this, for the audit log. */
  actor: string;
  /** The cosmetic catalog item commands check against; the shipped one when absent. */
  catalog?: Catalog;
}

export class AdminUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AdminUsageError";
  }
}

const SERVER_STATES = ["open", "draining", "fenced"] as const;
const MIN_KEY_LENGTH = 16;

interface Parsed {
  positional: string[];
  flags: Map<string, string | true>;
}

function parse(args: string[]): Parsed {
  const positional: string[] = [];
  const flags = new Map<string, string | true>();
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith("--")) {
      const name = a.slice(2);
      const next = args[i + 1];
      if (next !== undefined && !next.startsWith("--") && name !== "yes") {
        flags.set(name, next);
        i++;
      } else {
        flags.set(name, true);
      }
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

const flag = (p: Parsed, name: string): string | undefined => {
  const v = p.flags.get(name);
  return typeof v === "string" ? v : undefined;
};

function need(p: Parsed, index: number, what: string): string {
  const v = p.positional[index];
  if (v === undefined || v === "") throw new AdminUsageError(`missing ${what}`);
  return v;
}

function requireYes(p: Parsed, what: string): void {
  if (p.flags.get("yes") !== true) {
    throw new AdminUsageError(
      `${what} is destructive: repeat the command with --yes to confirm`,
    );
  }
}

export const ADMIN_COMMANDS = [
  "user:find <publicId|uuid|email|providerId>",
  "user:show <publicId>",
  "user:ban <publicId> --category <name> --reason <text> [--days <n>] --yes",
  "user:unban <publicId> --reason <text>",
  "user:revoke-sessions <publicId> --reason <text> --yes",
  "user:role <publicId> <owner|admin|mod|flagged|none> --reason <text> --yes",
  "user:verify <publicId> --reason <text> --yes",
  "user:unverify <publicId> --reason <text> --yes",
  "user:grant-bare-name <publicId> --reason <text> --yes",
  "user:revoke-bare-name <publicId> --reason <text> --yes",
  "clan:list [search]",
  "clan:show <TAG>",
  "clan:rename <TAG> <new name> --reason <text>",
  "clan:transfer <TAG> <publicId> --reason <text> --yes",
  "clan:member-remove <TAG> <publicId> --reason <text> --yes",
  "clan:remove <TAG> --reason <text> --yes",
  "wallet:show <publicId>",
  "wallet:grant <publicId> <credits> --reason <text>",
  "wallet:revoke <publicId> <credits> --reason <text> --yes",
  "xp:show <publicId>",
  "xp:grant <publicId> <xp> --reason <text> [--season]",
  "xp:revoke <publicId> <xp> --reason <text> --yes",
  "xp:set <publicId> <run xp> --reason <text> --yes",
  "season:list",
  "season:create --name <text> --start <ISO date> --end <ISO date> [--number <n>]",
  "season:close <number> --reason <text> --yes",
  "item:list <publicId>",
  "item:grant <publicId> <flare>",
  "item:revoke <publicId> <flare> --reason <text> --yes",
  "server:key:create <name> [--from-env <VAR>]",
  "server:key:list",
  "server:key:revoke <id> --reason <text> [--allow-last] --yes",
  "server:state <site> <letter> <open|draining|fenced> --reason <text> --yes",
  "email:status",
] as const;

/** The audit context of a CLI run: the operator on the server. */
function ctxOf(io: AdminIo): AuditContext {
  return { actor: io.actor, source: "cli", actorRole: "operator" };
}

async function audit(
  db: Db,
  io: AdminIo,
  action: string,
  targetType: string,
  targetId: string,
  details: Record<string, unknown> = {},
): Promise<void> {
  await writeAudit(db, ctxOf(io), action, targetType, targetId, details);
}

async function userByPublicId(
  db: Db,
  publicId: string,
): Promise<{ id: string; public_id: string }> {
  const { rows } = await db.query<{ id: string; public_id: string }>(
    "SELECT id, public_id FROM users WHERE public_id = $1",
    [publicId],
  );
  if (rows.length === 0)
    throw new AdminUsageError(`no user with public id ${publicId}`);
  return rows[0];
}

/** The catalog the item commands check flares against. Asset URLs are not used here. */
function catalogOf(io: AdminIo): Catalog {
  return io.catalog ?? loadCatalog({ publicOrigin: "http://localhost" });
}

/** A Credits amount: a whole number from 1 up to the per-command limit. */
function creditsArg(p: Parsed, index: number): number {
  const raw = need(p, index, "amount of Credits");
  if (!/^[1-9]\d{0,15}$/.test(raw)) {
    throw new AdminUsageError("the amount must be a positive whole number");
  }
  const amount = Number(raw);
  if (amount > ACCOUNT_RULES.adminMaxCreditsPerCommand) {
    throw new AdminUsageError(
      `at most ${ACCOUNT_RULES.adminMaxCreditsPerCommand.toLocaleString("en-US")} Credits per command`,
    );
  }
  return amount;
}

/** The mandatory note for a wallet change (it goes to the audit log). */
function reasonArg(p: Parsed): string {
  const reason = flag(p, "reason")?.trim();
  if (reason === undefined || reason === "") {
    throw new AdminUsageError("--reason <text> is required");
  }
  if (reason.length > 200) {
    throw new AdminUsageError("--reason is at most 200 characters");
  }
  return reason;
}

/** A flare argument: shaped like one, and never a wildcard. */
function flareArg(p: Parsed, index: number): string {
  const flare = need(p, index, "flare (e.g. flag:delta_mark)");
  if (isWildcardFlare(flare)) {
    throw new AdminUsageError(
      "wildcard flares are not allowed: grant one item at a time",
    );
  }
  if (!hasFlareShape(flare)) {
    throw new AdminUsageError(
      `${JSON.stringify(flare.slice(0, 60))} is not a flare (expected pattern:<name>:<palette>, flag:<name> or effect:<name>)`,
    );
  }
  return flare;
}

/** Runs one command; returns the process exit code. */
export async function runAdminCommand(
  pool: Pick<Pool, "connect" | "query">,
  argv: string[],
  io: AdminIo,
): Promise<number> {
  const [command, ...rest] = argv;
  if (command === undefined || command === "help" || command === "--help") {
    io.out("DeltaFront account admin\n\nCommands:");
    for (const c of ADMIN_COMMANDS) io.out(`  ${c}`);
    return 0;
  }
  const p = parse(rest);
  try {
    switch (command) {
      case "user:find": {
        const q = need(p, 0, "search text");
        const { rows } = await pool.query<{
          public_id: string;
          kind: string;
          created_at: Date;
          providers: string | null;
        }>(
          `SELECT DISTINCT u.public_id, u.kind, u.created_at,
                  (SELECT string_agg(i2.provider, ',' ORDER BY i2.id) FROM auth_identities i2 WHERE i2.user_id = u.id) AS providers
             FROM users u LEFT JOIN auth_identities i ON i.user_id = u.id
            WHERE u.public_id = $1 OR u.id::text = $1 OR i.provider_user_id = $1 OR i.email = $1
            ORDER BY u.created_at DESC LIMIT 20`,
          [q],
        );
        if (rows.length === 0) io.out("no matching users");
        for (const r of rows) {
          io.out(
            `${r.public_id}  ${r.kind}  ${r.created_at.toISOString()}  ${r.providers ?? "-"}`,
          );
        }
        return 0;
      }
      case "user:show": {
        const user = await userByPublicId(pool, need(p, 0, "public id"));
        const [u, ids, sessions, bans] = await Promise.all([
          pool.query(
            "SELECT id, public_id, kind, role, verified, bare_username_enabled, username_base::text AS username_base, username_discriminator, next_username_change_at, created_at, last_seen_at, deletion_requested_at FROM users WHERE id = $1",
            [user.id],
          ),
          pool.query(
            "SELECT provider, provider_user_id, email, email_verified, created_at FROM auth_identities WHERE user_id = $1 ORDER BY id",
            [user.id],
          ),
          pool.query(
            "SELECT count(*)::int AS n FROM refresh_sessions WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > now()",
            [user.id],
          ),
          pool.query(
            "SELECT category, reason, created_at, expires_at, revoked_at FROM bans WHERE user_id = $1 ORDER BY created_at DESC",
            [user.id],
          ),
        ]);
        const row = u.rows[0];
        io.out(`public id:   ${row.public_id}`);
        io.out(`id:          ${row.id}`);
        io.out(
          `kind:        ${row.kind}${row.role ? `  role: ${row.role}` : ""}`,
        );
        io.out(`verified:    ${row.verified ? "yes" : "no"}`);
        io.out(
          `username:    ${displayUsername(row.username_base, row.username_discriminator) ?? "(not set)"}${row.username_base !== null && row.username_discriminator === null ? "  (bare name held)" : ""}`,
        );
        io.out(
          `bare name:   ${row.bare_username_enabled ? "entitled" : "not entitled"}`,
        );
        io.out(
          `created:     ${row.created_at.toISOString()}   last seen: ${row.last_seen_at.toISOString()}`,
        );
        if (row.deletion_requested_at)
          io.out(
            `deletion requested: ${row.deletion_requested_at.toISOString()}`,
          );
        io.out(`live sessions: ${sessions.rows[0].n}`);
        io.out(`identities:`);
        for (const i of ids.rows)
          io.out(
            `  ${i.provider}  ${i.provider_user_id}  ${i.email ?? "-"}${i.email_verified ? " (verified)" : ""}`,
          );
        if (ids.rows.length === 0) io.out("  (none: guest)");
        const owned = (await flareRowsOf(pool, user.id)).filter(
          (r) => r.revokedAt === null,
        );
        io.out(
          `items:       ${owned.length === 0 ? "(none granted; see item:list)" : owned.map((r) => r.flare).join(", ")}`,
        );
        const myClans = await clansOfUser(pool, user.id);
        io.out(
          `clans:       ${myClans.clans.length === 0 ? "(none)" : myClans.clans.map((c) => `${c.tag} (${c.role})`).join(", ")}${myClans.requests.length === 0 ? "" : `   pending requests: ${myClans.requests.map((r) => r.tag).join(", ")}`}`,
        );
        io.out(`bans:`);
        for (const b of bans.rows) {
          const state = b.revoked_at
            ? "revoked"
            : b.expires_at && b.expires_at < new Date()
              ? "expired"
              : "ACTIVE";
          io.out(
            `  ${state}  ${b.category}  ${b.reason ?? "-"}  ${b.created_at.toISOString()}`,
          );
        }
        if (bans.rows.length === 0) io.out("  (none)");
        return 0;
      }
      case "user:ban": {
        requireYes(p, "banning a user");
        const publicId = need(p, 0, "public id");
        const category = flag(p, "category");
        if (category === undefined || category.trim() === "")
          throw new AdminUsageError("--category is required");
        const reason = reasonArg(p);
        const days = flag(p, "days");
        if (days !== undefined && !/^[1-9]\d{0,4}$/.test(days))
          throw new AdminUsageError("--days must be a positive whole number");
        await withTransaction(pool, (db) =>
          banUser(db, ctxOf(io), publicId, {
            category,
            reason,
            days: days === undefined ? null : Number(days),
          }),
        );
        io.out(`banned ${publicId}; their sessions were revoked`);
        return 0;
      }
      case "user:unban": {
        const publicId = need(p, 0, "public id");
        const reason = reasonArg(p);
        const count = await withTransaction(pool, (db) =>
          unbanUser(db, ctxOf(io), publicId, reason),
        );
        io.out(`${count} ban(s) lifted for ${publicId}`);
        return 0;
      }
      case "user:revoke-sessions": {
        requireYes(p, "revoking all sessions");
        const publicId = need(p, 0, "public id");
        const reason = reasonArg(p);
        const count = await withTransaction(pool, (db) =>
          revokeSessions(db, ctxOf(io), publicId, reason),
        );
        io.out(`${count} session(s) revoked for ${publicId}`);
        return 0;
      }
      case "user:role": {
        requireYes(p, "changing a role");
        const publicId = need(p, 0, "public id");
        const role = need(p, 1, "role");
        if (!(ROLE_VALUES as readonly string[]).includes(role))
          throw new AdminUsageError(
            `role must be one of: ${ROLE_VALUES.join(", ")}`,
          );
        const reason = reasonArg(p);
        await withTransaction(pool, (db) =>
          setRole(
            db,
            ctxOf(io),
            publicId,
            role as (typeof ROLE_VALUES)[number],
            reason,
          ),
        );
        io.out(`role of ${publicId} is now ${role}`);
        return 0;
      }
      case "user:verify":
      case "user:unverify": {
        const verify = command === "user:verify";
        requireYes(
          p,
          verify ? "verifying an account" : "unverifying an account",
        );
        const publicId = need(p, 0, "public id");
        const reason = reasonArg(p);
        const changed = await withTransaction(pool, (db) =>
          setVerified(db, ctxOf(io), publicId, verify, reason),
        );
        io.out(
          changed
            ? `${publicId} is now ${verify ? "verified" : "unverified"}`
            : `${publicId} was already ${verify ? "verified" : "unverified"}; nothing changed`,
        );
        return 0;
      }
      case "user:grant-bare-name":
      case "user:revoke-bare-name": {
        const grant = command === "user:grant-bare-name";
        requireYes(
          p,
          grant ? "granting a bare username" : "revoking a bare username",
        );
        const publicId = need(p, 0, "public id");
        const reason = reasonArg(p);
        const outcome = await withTransaction(pool, (db) =>
          setBareNameEntitlement(db, ctxOf(io), publicId, grant, reason),
        );
        if (outcome === null) {
          io.out(
            `${publicId} ${grant ? "already may" : "already may not"} claim a bare username; nothing changed`,
          );
        } else if (grant) {
          io.out(
            `${publicId} may now claim a bare username (rename cooldown cleared): they set it in the username form`,
          );
        } else {
          io.out(
            `${publicId} may no longer claim a bare username` +
              (outcome.holdsBare
                ? `; they keep holding the bare name "${outcome.name}" until they rename (their next name gets a number)`
                : ""),
          );
        }
        return 0;
      }
      case "clan:list": {
        const search = p.positional[0]?.toLowerCase();
        const { rows } = await pool.query<{
          tag: string;
          name: string;
          members: number;
          is_open: boolean;
          created_at: Date;
        }>(
          `SELECT c.tag::text AS tag, c.name::text AS name, c.is_open, c.created_at,
                  (SELECT count(*)::int FROM clan_members m WHERE m.clan_id = c.id) AS members
             FROM clans c
            WHERE c.disbanded_at IS NULL
              AND ($1::text IS NULL OR lower(c.tag::text) = $1 OR lower(c.name::text) LIKE '%' || $1 || '%')
            ORDER BY c.created_at DESC LIMIT 50`,
          [search === undefined ? null : search.replace(/[\\%_]/g, "")],
        );
        if (rows.length === 0) io.out("no matching clans");
        for (const r of rows) {
          io.out(
            `${r.tag.padEnd(5)}  ${r.name}  ${r.members} member(s)  ${r.is_open ? "open" : "closed"}  ${r.created_at.toISOString()}`,
          );
        }
        return 0;
      }
      case "clan:show": {
        const tag = tagFromRoute(need(p, 0, "clan tag"));
        const clan = tag === null ? null : await clanByTag(pool, tag);
        if (clan === null)
          throw new AdminUsageError("no live clan with that tag");
        const [members, requests, bans, events] = await Promise.all([
          pool.query<{ public_id: string; role: string; joined_at: Date }>(
            `SELECT u.public_id, m.role, m.joined_at FROM clan_members m JOIN users u ON u.id = m.user_id
              WHERE m.clan_id = $1 ORDER BY (m.role = 'leader') DESC, (m.role = 'officer') DESC, m.joined_at`,
            [clan.id],
          ),
          pool.query<{ n: number }>(
            "SELECT count(*)::int AS n FROM clan_join_requests WHERE clan_id = $1",
            [clan.id],
          ),
          pool.query<{ n: number }>(
            "SELECT count(*)::int AS n FROM clan_bans WHERE clan_id = $1",
            [clan.id],
          ),
          pool.query<{ action: string; created_at: Date; details: unknown }>(
            "SELECT action, created_at, details FROM clan_events WHERE clan_id = $1 ORDER BY id DESC LIMIT 10",
            [clan.id],
          ),
        ]);
        io.out(
          `${clan.tag}  ${clan.name}  (${clan.isOpen ? "open" : "closed"})`,
        );
        io.out(`created:     ${clan.createdAt.toISOString()}`);
        io.out(
          `description: ${clan.description === "" ? "-" : clan.description}`,
        );
        io.out(`discord:     ${clan.discordUrl ?? "-"}`);
        io.out(
          `pending requests: ${requests.rows[0].n}   bans: ${bans.rows[0].n}`,
        );
        io.out(`members (${members.rows.length}):`);
        for (const m of members.rows) {
          io.out(
            `  ${m.public_id}  ${m.role}  joined ${m.joined_at.toISOString()}`,
          );
        }
        io.out("recent events (newest first):");
        for (const e of events.rows) {
          io.out(`  ${e.created_at.toISOString()}  ${e.action}`);
        }
        return 0;
      }
      case "clan:rename":
      case "clan:transfer":
      case "clan:member-remove":
      case "clan:remove": {
        if (command !== "clan:rename") requireYes(p, command);
        const tag = tagFromRoute(need(p, 0, "clan tag"));
        if (tag === null) throw new AdminUsageError("not a clan tag");
        const reason = reasonArg(p);
        const clanAudit =
          (details: Record<string, unknown>) => async (db: Db) =>
            audit(db, io, command, "clan", tag, { reason, ...details });
        try {
          if (command === "clan:rename") {
            const name = need(p, 1, "new name");
            await adminRenameClan(
              pool,
              tag,
              name,
              reason,
              loadReservedClanNames(),
              (tx) => clanAudit({ name })(tx),
            );
            io.out(`${tag} renamed to ${name}`);
          } else if (command === "clan:transfer") {
            const target = need(p, 1, "public id");
            await adminTransferClan(pool, tag, target, reason, (tx) =>
              clanAudit({ target })(tx),
            );
            io.out(
              `${tag} is now led by ${target} (the old leader is an officer)`,
            );
          } else if (command === "clan:member-remove") {
            const target = need(p, 1, "public id");
            await adminRemoveMember(pool, tag, target, reason, (tx) =>
              clanAudit({ target })(tx),
            );
            io.out(`${target} removed from ${tag}`);
          } else {
            const clan = await adminRemoveClan(pool, tag, reason, (tx, c) =>
              clanAudit({ name: c.name, members: c.memberCount })(tx),
            );
            io.out(
              `${tag} (${clan.name}, ${clan.memberCount} member(s)) removed; its tag is held`,
            );
          }
        } catch (error) {
          if (error instanceof ClanError) {
            throw new AdminUsageError(
              `${String(error.body.code ?? "refused")}${error.body.code === "TRANSFER_REQUIRED" ? ": transfer the clan or remove it first" : ""}`,
            );
          }
          throw error;
        }
        return 0;
      }
      case "wallet:show": {
        const user = await userByPublicId(pool, need(p, 0, "public id"));
        const [wallet, ledger] = await Promise.all([
          pool.query<{ credits: string }>(
            "SELECT credits::text AS credits FROM wallets WHERE user_id = $1",
            [user.id],
          ),
          pool.query<{
            delta: string;
            balance_after: string;
            reason: string;
            ref_type: string | null;
            ref_id: string | null;
            created_at: Date;
          }>(
            `SELECT delta::text, balance_after::text, reason, ref_type, ref_id, created_at
               FROM currency_ledger WHERE user_id = $1 ORDER BY id DESC LIMIT 20`,
            [user.id],
          ),
        ]);
        io.out(
          `credits of ${user.public_id}: ${wallet.rows[0]?.credits ?? "0"}`,
        );
        io.out("last ledger rows (newest first):");
        for (const r of ledger.rows) {
          io.out(
            `  ${r.created_at.toISOString()}  ${r.delta.padStart(8)}  -> ${r.balance_after.padStart(8)}  ${r.reason}${r.ref_type ? `  ${r.ref_type}:${r.ref_id}` : ""}`,
          );
        }
        if (ledger.rows.length === 0) io.out("  (none)");
        return 0;
      }
      case "wallet:grant":
      case "wallet:revoke": {
        const grant = command === "wallet:grant";
        if (!grant) requireYes(p, "deducting Credits");
        const publicId = need(p, 0, "public id");
        const amount = creditsArg(p, 1);
        const reason = reasonArg(p);
        const outcome = await withTransaction(pool, (db) =>
          adjustCredits(
            db,
            ctxOf(io),
            publicId,
            grant ? amount : -amount,
            reason,
          ),
        );
        io.out(
          `${grant ? "granted" : "deducted"} ${amount} Credits ${grant ? "to" : "from"} ${publicId}: ${outcome.before} -> ${outcome.after}`,
        );
        return 0;
      }
      case "xp:show": {
        const user = await userByPublicId(pool, need(p, 0, "public id"));
        const row = await progressRowOf(pool, user.id);
        const state = progressState(row);
        io.out(
          `${user.public_id}: level ${state.level} (${rankForLevel(state.level)}), prestige ${state.prestige}${state.legend ? " (Legend)" : ""}`,
        );
        io.out(`  lifetime XP ${row.lifetimeXp}, this run ${row.runXp}`);
        const ledger = await pool.query<{
          delta: string;
          source: string;
          ref_id: string | null;
          created_at: Date;
        }>(
          `SELECT delta::text, source, ref_id, created_at FROM xp_ledger
            WHERE user_id = $1 ORDER BY id DESC LIMIT 20`,
          [user.id],
        );
        io.out("last ledger rows (newest first):");
        for (const r of ledger.rows) {
          io.out(
            `  ${r.created_at.toISOString()}  ${r.delta.padStart(8)}  ${r.source}${r.ref_id ? `  ${r.ref_id}` : ""}`,
          );
        }
        if (ledger.rows.length === 0) io.out("  (none)");
        return 0;
      }
      case "xp:grant":
      case "xp:revoke":
      case "xp:set": {
        const action = command.slice(3) as XpAdminAction;
        if (action !== "grant") requireYes(p, "changing XP downwards");
        const publicId = need(p, 0, "public id");
        const raw = need(p, 1, "XP");
        if (!/^\d{1,9}$/.test(raw)) {
          throw new AdminUsageError("the XP must be a whole number");
        }
        const reason = reasonArg(p);
        const outcome = await withTransaction(pool, (db) =>
          adjustXp(db, ctxOf(io), publicId, action, Number(raw), reason, {
            countsForSeason: p.flags.get("season") === true,
            env: { validFlares: catalogOf(io).validFlares },
          }),
        );
        io.out(
          `${action} ${raw} XP for ${publicId}: run ${outcome.before.runXp} -> ${outcome.after.runXp}, level ${outcome.before.level} -> ${outcome.after.level}`,
        );
        return 0;
      }
      case "season:list": {
        const seasons = await allSeasons(pool);
        for (const s of seasons) {
          io.out(
            `  ${s.number}  ${s.name}  ${s.startsAt.toISOString()} -> ${s.endsAt.toISOString()}  ${s.archivedAt ? "archived" : s.current ? "RUNNING" : "scheduled"}`,
          );
        }
        if (seasons.length === 0) io.out("  (no seasons)");
        return 0;
      }
      case "season:create": {
        const name = flag(p, "name")?.trim();
        const start = new Date(flag(p, "start") ?? "");
        const end = new Date(flag(p, "end") ?? "");
        if (name === undefined || name === "") {
          throw new AdminUsageError("--name <text> is required");
        }
        if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
          throw new AdminUsageError("--start and --end must be ISO dates");
        }
        const number = flag(p, "number");
        const season = await withTransaction(pool, (db) =>
          createSeason(
            db,
            ctxOf(io),
            {
              name,
              startsAt: start,
              endsAt: end,
              number: number === undefined ? undefined : Number(number),
            },
            catalogOf(io).validFlares,
          ),
        );
        io.out(`created season ${season.number} (${season.name})`);
        return 0;
      }
      case "season:close": {
        requireYes(p, "closing a season");
        reasonArg(p);
        const number = Number(need(p, 0, "season number"));
        const season = await seasonByNumber(pool, number);
        if (season === null) throw new AdminUsageError("no such season");
        await withTransaction(pool, (db) =>
          closeSeason(db, ctxOf(io), season.id),
        );
        io.out(`closed and archived season ${number}`);
        return 0;
      }
      case "item:list": {
        const user = await userByPublicId(pool, need(p, 0, "public id"));
        const catalog = catalogOf(io);
        const rows = await flareRowsOf(pool, user.id);
        io.out(`items of ${user.public_id}:`);
        for (const flare of catalog.defaultFlares) {
          io.out(`  ${flare}  default (everyone owns it)`);
        }
        for (const r of rows) {
          const known = catalog.validFlares.has(r.flare)
            ? ""
            : "  (no longer in the catalog)";
          io.out(
            `  ${r.flare}  ${r.revokedAt ? `REVOKED ${r.revokedAt.toISOString()}` : `owned (${r.source}) since ${r.grantedAt.toISOString()}`}${known}`,
          );
        }
        if (rows.length === 0) io.out("  (nothing granted)");
        return 0;
      }
      case "item:grant": {
        const publicId = need(p, 0, "public id");
        const flare = flareArg(p, 1);
        const catalog = catalogOf(io);
        const result = await withTransaction(pool, (db) =>
          grantItem(db, ctxOf(io), catalog, publicId, flare),
        );
        io.out(
          result === "already_owned"
            ? `${publicId} already owns ${flare} (nothing changed)`
            : `${flare} ${result === "restored" ? "restored for" : "granted to"} ${publicId}`,
        );
        return 0;
      }
      case "item:revoke": {
        requireYes(p, "revoking an item");
        const publicId = need(p, 0, "public id");
        const flare = flareArg(p, 1);
        const reason = reasonArg(p);
        const result = await withTransaction(pool, (db) =>
          revokeItem(db, ctxOf(io), catalogOf(io), publicId, flare, reason),
        );
        io.out(
          result === "revoked"
            ? `${flare} revoked from ${publicId}`
            : `${publicId} does not own ${flare} (nothing changed)`,
        );
        return 0;
      }
      case "server:key:create": {
        const name = need(p, 0, "key name");
        const fromEnv = flag(p, "from-env");
        let key: string;
        if (fromEnv !== undefined) {
          const value = io.env[fromEnv];
          if (value === undefined || value.length < MIN_KEY_LENGTH) {
            throw new AdminUsageError(
              `${fromEnv} must be set to a key of at least ${MIN_KEY_LENGTH} characters`,
            );
          }
          // The development placeholder must never become a real server key.
          if (
            value.includes("WARNING_DEV_API_KEY") &&
            (io.env.GAME_ENV === "staging" || io.env.GAME_ENV === "prod")
          ) {
            throw new AdminUsageError(
              `${fromEnv} holds the development placeholder key: it cannot be registered when GAME_ENV=${io.env.GAME_ENV}`,
            );
          }
          key = value;
        } else {
          key = `dfk_${randomBytes(32).toString("base64url")}`;
        }
        const created = await withTransaction(pool, async (db) => {
          const existing = await db.query(
            "SELECT id FROM server_api_keys WHERE key_hash = $1 AND revoked_at IS NULL",
            [sha256(key)],
          );
          if (existing.rows.length > 0) return null;
          const { rows } = await db.query<{ id: string }>(
            "INSERT INTO server_api_keys (name, key_hash) VALUES ($1, $2) RETURNING id",
            [name, sha256(key)],
          );
          await audit(db, io, "server:key:create", "server_key", rows[0].id, {
            name,
            fromEnv: fromEnv ?? null,
          });
          return rows[0].id;
        });
        if (created === null) {
          io.out("that key is already registered (nothing changed)");
        } else if (fromEnv !== undefined) {
          io.out(`registered key #${created} "${name}" from ${fromEnv}`);
        } else {
          io.out(
            `key #${created} "${name}" created. It is shown once and cannot be recovered:`,
          );
          io.out(key);
          io.out("Give it to the game server as API_KEY.");
        }
        return 0;
      }
      case "server:key:list": {
        const { rows } = await pool.query<{
          id: string;
          name: string;
          created_at: Date;
          revoked_at: Date | null;
        }>(
          "SELECT id, name, created_at, revoked_at FROM server_api_keys ORDER BY id",
        );
        if (rows.length === 0) io.out("no server keys");
        for (const r of rows)
          io.out(
            `#${r.id}  ${r.name}  ${r.created_at.toISOString()}  ${r.revoked_at ? `revoked ${r.revoked_at.toISOString()}` : "active"}`,
          );
        return 0;
      }
      case "server:key:revoke": {
        requireYes(p, "revoking a server key");
        const id = need(p, 0, "key id");
        if (!/^\d+$/.test(id))
          throw new AdminUsageError("key id must be a number");
        const reason = reasonArg(p);
        await withTransaction(pool, async (db) => {
          // Serialise with other key changes, then keep the one invariant that
          // matters: revoking the last active key would lock every game server
          // out until someone with shell access registers another.
          await db.query(
            "LOCK TABLE server_api_keys IN SHARE ROW EXCLUSIVE MODE",
          );
          const active = await db.query<{ id: string }>(
            "SELECT id FROM server_api_keys WHERE revoked_at IS NULL",
          );
          if (!active.rows.some((row) => String(row.id) === id))
            throw new AdminUsageError(`no active key #${id}`);
          if (active.rows.length === 1 && p.flags.get("allow-last") !== true) {
            throw new AdminUsageError(
              `key #${id} is the only active server key: revoking it would lock every game server out. Create the replacement first (rotation), or repeat with --allow-last if that is intended`,
            );
          }
          await db.query(
            "UPDATE server_api_keys SET revoked_at = now() WHERE id = $1",
            [id],
          );
          await audit(db, io, "server:key:revoke", "server_key", id, {
            reason,
            remainingActive: active.rows.length - 1,
          });
        });
        io.out(`key #${id} revoked`);
        return 0;
      }
      case "server:state": {
        requireYes(p, "changing a server's state");
        const site = need(p, 0, "site");
        const letter = need(p, 1, "letter");
        const state = need(p, 2, "state");
        if (!(SERVER_STATES as readonly string[]).includes(state))
          throw new AdminUsageError(
            `state must be one of: ${SERVER_STATES.join(", ")}`,
          );
        const reason = reasonArg(p);
        await withTransaction(pool, async (db) => {
          const r = await db.query(
            "UPDATE game_servers SET state = $3 WHERE site = $1 AND letter = $2",
            [site, letter, state],
          );
          if ((r.rowCount ?? 0) === 0)
            throw new AdminUsageError(
              `no server ${letter} registered under ${site}`,
            );
          await audit(
            db,
            io,
            "server:state",
            "game_server",
            `${site}/${letter}`,
            { state, reason },
          );
        });
        io.out(`server ${letter} of ${site} is now ${state}`);
        return 0;
      }
      case "email:status": {
        // Counts only: never a token, never an address. Read-only, not audited.
        const { rows } = await pool.query<{
          pending: number;
          unused_expired: number;
          used: number;
          last_hour: number;
          oldest_pending_s: number | null;
        }>(
          `SELECT count(*) FILTER (WHERE consumed_at IS NULL AND expires_at > now())::int AS pending,
                  count(*) FILTER (WHERE consumed_at IS NULL AND expires_at <= now())::int AS unused_expired,
                  count(*) FILTER (WHERE consumed_at IS NOT NULL)::int AS used,
                  count(*) FILTER (WHERE created_at > now() - interval '1 hour')::int AS last_hour,
                  floor(extract(epoch FROM now() - min(created_at) FILTER (WHERE consumed_at IS NULL AND expires_at > now())))::int AS oldest_pending_s
             FROM magic_link_tokens`,
        );
        const r = rows[0];
        io.out(
          `email sign-in links: ${r.pending} pending, ${r.unused_expired} expired unused, ${r.used} used, ${r.last_hour} requested in the last hour`,
        );
        io.out(
          r.oldest_pending_s === null
            ? "no link is waiting"
            : `the oldest pending link is ${r.oldest_pending_s}s old`,
        );
        io.out(
          "(expired and used rows are deleted by the maintenance job a day after expiry)",
        );
        return 0;
      }
      default:
        io.err(`unknown command "${command}" (run "npm run admin -- help")`);
        return 2;
    }
  } catch (error) {
    if (error instanceof AdminUsageError) {
      io.err(error.message);
      return 2;
    }
    // A refused operation (shared with the HTTP API) reads as a usage error here.
    if (error instanceof AdminOpError) {
      io.err(error.message);
      return 2;
    }
    throw error;
  }
}
