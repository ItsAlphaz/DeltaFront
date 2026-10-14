import { profanityMatcher } from "@openfront/shared/Censor";
import { hasPermission } from "@openfront/shared/Permissions";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { CLAN_RULES } from "./constants";

/**
 * Clan rules that need no database (docs/DeltaFrontAccountsPlan.md section
 * 12): who may do what, who may create a clan, and what a clan name, tag,
 * description and Discord link may look like. Everything the routes enforce is
 * decided here, so the same function answers the API and the tests.
 */

// ---------------------------------------------------------------- roles

export const CLAN_ROLES = ["leader", "officer", "member"] as const;
export type ClanRole = (typeof CLAN_ROLES)[number];

export const CLAN_ACTIONS = [
  "rename",
  "edit",
  "approve",
  "deny",
  "kick",
  "ban",
  "unban",
  "promote",
  "demote",
  "transfer",
  "disband",
  "viewRequests",
  "viewBans",
  "viewMembers",
  "viewGames",
] as const;
export type ClanAction = (typeof CLAN_ACTIONS)[number];

/** Actions whose answer depends on the target's role (a person acted on). */
const TARGETED: readonly ClanAction[] = [
  "kick",
  "ban",
  "promote",
  "demote",
  "transfer",
];

/**
 * Whether `actor` may perform `action` (plan 12.3). `target` is the role of
 * the member acted on, for the actions that act on one; an action on a person
 * who is not in the clan passes `null` (only ban and unban allow that, and
 * only a leader or an officer may). Nobody ever acts on themselves here: the
 * routes refuse a target equal to the actor before asking.
 *
 *  - leader: everything, but the leader is never a target (leadership moves
 *    only by `transfer`);
 *  - officer: description, discord and openness; requests; kick and ban of
 *    plain members only; every view;
 *  - member: the member list and the game history, nothing else.
 */
export function can(
  actor: ClanRole | null,
  action: ClanAction,
  target: ClanRole | null = null,
): boolean {
  if (actor === null) return false;
  if (TARGETED.includes(action) && target === "leader") return false;
  switch (actor) {
    case "leader":
      if (action === "promote") return target === "member";
      if (action === "demote") return target === "officer";
      if (action === "transfer") return target !== null;
      return true;
    case "officer":
      switch (action) {
        case "edit":
        case "approve":
        case "deny":
        case "unban":
        case "viewRequests":
        case "viewBans":
        case "viewMembers":
        case "viewGames":
          return true;
        case "kick":
        case "ban":
          return target === "member" || (action === "ban" && target === null);
        default:
          return false;
      }
    case "member":
      return action === "viewMembers" || action === "viewGames";
  }
}

// ------------------------------------------------------------ creation

export type CreateEligibility =
  | { ok: true }
  | { ok: false; code: "ACCOUNT_TOO_NEW"; required: number; current: number }
  | { ok: false; code: "NOT_ENOUGH_GAMES"; required: number; current: number };

const DAY_MS = 86_400_000;

/**
 * Whether an account may create a clan (decision D2): at least
 * `createMinAccountAgeDays` old and `createMinCompletedGames` completed games.
 * The thresholds are inclusive: an account exactly that old, with exactly that
 * many games, qualifies. `current` is whole days, rounded down.
 */
/**
 * Whether this account may create OFFICIAL clans: skip the age and completed-games
 * rules and use reserved tags and names. A staff right (Permissions.ts), read from
 * the account's stored role; never from the request, and never granted by
 * verification or a bare-name entitlement.
 */
export function mayCreateOfficialClans(account: {
  role: string | null;
}): boolean {
  return hasPermission(account.role, "admin.clans.official");
}

export function checkCreateEligibility(
  accountCreatedAt: Date,
  completedGames: number,
  now: Date = new Date(),
): CreateEligibility {
  const ageMs = now.getTime() - accountCreatedAt.getTime();
  if (ageMs < CLAN_RULES.createMinAccountAgeDays * DAY_MS) {
    return {
      ok: false,
      code: "ACCOUNT_TOO_NEW",
      required: CLAN_RULES.createMinAccountAgeDays,
      current: Math.max(0, Math.floor(ageMs / DAY_MS)),
    };
  }
  if (completedGames < CLAN_RULES.createMinCompletedGames) {
    return {
      ok: false,
      code: "NOT_ENOUGH_GAMES",
      required: CLAN_RULES.createMinCompletedGames,
      current: Math.max(0, completedGames),
    };
  }
  return { ok: true };
}

// ------------------------------------------------- names, tags and text

/** Letters and digits (any script) at either end; a few quiet punctuation marks inside. */
const NAME_PATTERN = /^[\p{L}\p{N}][\p{L}\p{N} _.'&!-]*[\p{L}\p{N}!.]$/u;
const TAG_PATTERN = /^[A-Za-z0-9]{2,5}$/;
/** Control, format (zero-width, bidi), separator and combining characters. */
const UNWANTED = /[\p{C}\p{Z}\p{M}]/u;

/** One canonical spelling: NFKC, every whitespace run one plain space, trimmed. */
export function normalizeName(raw: string): string {
  return raw
    .normalize("NFKC")
    .replace(/[\p{Z}\s]+/gu, " ")
    .trim();
}

/**
 * What a name boils down to for comparisons with the reserved list: lower
 * case letters and digits only, so `Delta-Front`, `DELTA FRONT` and
 * `d e l t a f r o n t` are one name.
 */
export function nameSkeleton(name: string): string {
  return name
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, "");
}

export type TextVerdict<T = string> =
  | { ok: true; value: T }
  | { ok: false; code: "INVALID_NAME" | "INVALID_TAG" | "NAME_PROFANE" };

/** A clan name: 3 to 35 characters, no control, invisible or combining characters, not profane. */
export function checkClanName(raw: unknown): TextVerdict {
  if (typeof raw !== "string") return { ok: false, code: "INVALID_NAME" };
  if (raw.length > CLAN_RULES.nameMaxLength * 4) {
    return { ok: false, code: "INVALID_NAME" };
  }
  const name = normalizeName(raw);
  if (
    name.length < CLAN_RULES.nameMinLength ||
    name.length > CLAN_RULES.nameMaxLength ||
    !NAME_PATTERN.test(name) ||
    // after normalising, the plain space is the only separator allowed
    UNWANTED.test(name.replace(/ /g, ""))
  ) {
    return { ok: false, code: "INVALID_NAME" };
  }
  if (profanityMatcher.hasMatch(name)) {
    return { ok: false, code: "NAME_PROFANE" };
  }
  return { ok: true, value: name };
}

/** A tag: 2 to 5 ASCII letters or digits, stored upper case, not profane. */
export function checkClanTag(raw: unknown): TextVerdict {
  if (typeof raw !== "string" || !TAG_PATTERN.test(raw)) {
    return { ok: false, code: "INVALID_TAG" };
  }
  const tag = raw.toUpperCase();
  if (profanityMatcher.hasMatch(tag)) {
    return { ok: false, code: "NAME_PROFANE" };
  }
  return { ok: true, value: tag };
}

/** The canonical (upper case) form of a tag taken from a URL, or null when it is not tag-shaped. */
export function tagFromRoute(raw: string): string | null {
  return TAG_PATTERN.test(raw) ? raw.toUpperCase() : null;
}

/** A description: at most 200 characters, no control or line-break characters, not profane. */
export function checkDescription(raw: unknown): {
  ok: boolean;
  value: string;
} {
  if (typeof raw !== "string") return { ok: false, value: "" };
  const value = raw
    .normalize("NFKC")
    .replace(/[ \t]+/g, " ")
    .trim();
  if (
    value.length > CLAN_RULES.descriptionMaxLength ||
    /[\p{C}\p{Zl}\p{Zp}]/u.test(value) ||
    profanityMatcher.hasMatch(value)
  ) {
    return { ok: false, value };
  }
  return { ok: true, value };
}

const DISCORD_INVITE =
  /^https:\/\/(?:discord\.gg\/|discord\.com\/invite\/)[A-Za-z0-9-]{2,32}$/;

/**
 * A clan's Discord invite: an https link to `discord.gg/<code>` or
 * `discord.com/invite/<code>` and nothing else (no other host, query or
 * fragment). The empty string clears it. The API never fetches the link.
 */
export function checkDiscordUrl(
  raw: unknown,
): { ok: true; value: string | null } | { ok: false } {
  if (typeof raw !== "string") return { ok: false };
  const value = raw.trim();
  if (value === "") return { ok: true, value: null };
  if (value.length > 255 || !DISCORD_INVITE.test(value)) return { ok: false };
  return { ok: true, value };
}

// --------------------------------------------------------- reserved data

const ReservedSchema = z.strictObject({
  tags: z.array(z.string().regex(/^[A-Z0-9]{2,5}$/)),
  nameSkeletons: z.array(z.string().regex(/^[a-z0-9]{3,35}$/)),
});

export interface ReservedClanNames {
  /** Tags nobody may register or wear (system, staff, DeltaFront), upper case. */
  tags: ReadonlySet<string>;
  /** Names containing one of these once reduced to letters and digits are refused. */
  nameSkeletons: readonly string[];
}

export const CLANS_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "clans",
);

/** Reads and validates `clans/reserved.json`; a malformed file stops the API from starting. */
export function loadReservedClanNames(
  dir: string = CLANS_DIR,
): ReservedClanNames {
  const parsed = ReservedSchema.safeParse(
    JSON.parse(fs.readFileSync(path.join(dir, "reserved.json"), "utf8")),
  );
  if (!parsed.success) {
    throw new Error(
      `clans/reserved.json is invalid: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
    );
  }
  const tags = new Set(parsed.data.tags);
  if (tags.size !== parsed.data.tags.length) {
    throw new Error("clans/reserved.json lists a tag twice");
  }
  return { tags, nameSkeletons: parsed.data.nameSkeletons };
}

/** Whether a tag is on the reserved list (the caller passes it upper case). */
export const isReservedTag = (
  reserved: ReservedClanNames,
  tag: string,
): boolean => reserved.tags.has(tag.toUpperCase());

/** Whether a name imitates a reserved one. */
export const isReservedName = (
  reserved: ReservedClanNames,
  name: string,
): boolean => {
  const skeleton = nameSkeleton(name);
  return reserved.nameSkeletons.some((word) => skeleton.includes(word));
};

// ------------------------------------------------------------- the wire

/** Page and limit from a query string; malformed or oversized values are clamped, never trusted. */
export function pageParams(query: { page?: unknown; limit?: unknown }): {
  page: number;
  limit: number;
} {
  const num = (v: unknown, fallback: number): number =>
    typeof v === "string" && /^\d{1,7}$/.test(v) ? Number(v) : fallback;
  return {
    page: Math.min(CLAN_RULES.maxPage, Math.max(1, num(query.page, 1))),
    limit: Math.min(
      CLAN_RULES.maxPageSize,
      Math.max(1, num(query.limit, CLAN_RULES.defaultPageSize)),
    ),
  };
}
