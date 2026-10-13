// @vitest-environment node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  CLANS_DIR,
  CLAN_ACTIONS,
  CLAN_ROLES,
  can,
  checkClanName,
  checkClanTag,
  checkCreateEligibility,
  checkDescription,
  checkDiscordUrl,
  isReservedName,
  isReservedTag,
  loadReservedClanNames,
  nameSkeleton,
  normalizeName,
  pageParams,
  tagFromRoute,
  type ClanAction,
  type ClanRole,
} from "../../src/account-api/domain/clans";
import { CLAN_RULES } from "../../src/account-api/domain/constants";

const DAY = 86_400_000;

describe("who may do what (plan 12.3)", () => {
  // The whole table, written out: [action, target role, leader, officer, member]
  type Row = [ClanAction, ClanRole | null, boolean, boolean, boolean];
  const TABLE: Row[] = [
    ["rename", null, true, false, false],
    ["edit", null, true, true, false],
    ["approve", null, true, true, false],
    ["deny", null, true, true, false],
    ["viewRequests", null, true, true, false],
    ["viewBans", null, true, true, false],
    ["viewMembers", null, true, true, true],
    ["viewGames", null, true, true, true],
    ["unban", null, true, true, false],
    ["disband", null, true, false, false],
    ["kick", "member", true, true, false],
    ["kick", "officer", true, false, false],
    ["kick", "leader", false, false, false],
    ["ban", "member", true, true, false],
    ["ban", "officer", true, false, false],
    ["ban", "leader", false, false, false],
    ["ban", null, true, true, false],
    ["promote", "member", true, false, false],
    ["promote", "officer", false, false, false],
    ["promote", "leader", false, false, false],
    ["demote", "officer", true, false, false],
    ["demote", "member", false, false, false],
    ["demote", "leader", false, false, false],
    ["transfer", "member", true, false, false],
    ["transfer", "officer", true, false, false],
    ["transfer", "leader", false, false, false],
  ];

  it.each(TABLE)(
    "%s on %s: leader %s, officer %s, member %s",
    (action, target, leader, officer, member) => {
      expect(can("leader", action, target)).toBe(leader);
      expect(can("officer", action, target)).toBe(officer);
      expect(can("member", action, target)).toBe(member);
    },
  );

  it("nobody outside the clan may do anything", () => {
    for (const action of CLAN_ACTIONS) {
      for (const target of [null, ...CLAN_ROLES]) {
        expect(can(null, action, target), `${action} on ${target}`).toBe(false);
      }
    }
  });

  it("has an answer for every action, and the table covers every action", () => {
    expect(new Set(TABLE.map((r) => r[0]))).toEqual(new Set(CLAN_ACTIONS));
  });

  it("never lets the leader be acted on, and never lets an officer touch another officer or the leader", () => {
    for (const action of [
      "kick",
      "ban",
      "promote",
      "demote",
      "transfer",
    ] as const) {
      for (const actor of CLAN_ROLES)
        expect(can(actor, action, "leader")).toBe(false);
    }
    for (const action of [
      "kick",
      "ban",
      "promote",
      "demote",
      "transfer",
    ] as const) {
      expect(can("officer", action, "officer")).toBe(false);
    }
  });

  it("gives an officer no way to become leader: promote, transfer and disband are leader-only", () => {
    for (const action of [
      "promote",
      "demote",
      "transfer",
      "disband",
      "rename",
    ] as const) {
      for (const target of [null, ...CLAN_ROLES])
        expect(can("officer", action, target)).toBe(false);
    }
  });
});

describe("clan creation eligibility (decision D2)", () => {
  const now = new Date("2026-06-15T12:00:00Z");
  const born = (ms: number) => new Date(now.getTime() - ms);

  it("takes the numbers from CLAN_RULES", () => {
    expect(CLAN_RULES.createMinAccountAgeDays).toBe(3);
    expect(CLAN_RULES.createMinCompletedGames).toBe(10);
  });

  it("accepts an account exactly 3 days old with exactly 10 completed games", () => {
    expect(checkCreateEligibility(born(3 * DAY), 10, now)).toEqual({
      ok: true,
    });
  });

  it("refuses an account one second short of 3 days: ACCOUNT_TOO_NEW, current 2 days", () => {
    expect(checkCreateEligibility(born(3 * DAY - 1000), 50, now)).toEqual({
      ok: false,
      code: "ACCOUNT_TOO_NEW",
      required: 3,
      current: 2,
    });
    expect(
      checkCreateEligibility(born(2 * DAY + 23 * 3600_000), 50, now),
    ).toMatchObject({
      code: "ACCOUNT_TOO_NEW",
      current: 2,
    });
  });

  it("refuses 9 completed games: NOT_ENOUGH_GAMES", () => {
    expect(checkCreateEligibility(born(30 * DAY), 9, now)).toEqual({
      ok: false,
      code: "NOT_ENOUGH_GAMES",
      required: 10,
      current: 9,
    });
  });

  it("checks the age first, and handles a brand new or clock-skewed account", () => {
    expect(checkCreateEligibility(born(0), 0, now)).toMatchObject({
      code: "ACCOUNT_TOO_NEW",
      current: 0,
    });
    expect(
      checkCreateEligibility(new Date(now.getTime() + DAY), 99, now),
    ).toMatchObject({
      code: "ACCOUNT_TOO_NEW",
      current: 0,
    });
  });
});

describe("clan names", () => {
  it.each([
    ["Delta Force", "Delta Force"],
    ["  Delta   Force  ", "Delta Force"],
    ["Delta Force", "Delta Force"], // no-break space becomes a plain space
    ["Delta\tForce", "Delta Force"],
    ["Delta\nForce", "Delta Force"], // line breaks are whitespace too
    ["Delta\u0301", "Delt\u00e1"], // a combining accent composes into one letter
    ["Ｄｅｌｔａ", "Delta"], // full-width letters fold to ASCII (NFKC)
    ["Ünited Nations", "Ünited Nations"],
    ["Red-Wolves", "Red-Wolves"],
    ["O'Neil Clan", "O'Neil Clan"],
    ["abc", "abc"],
    ["x".repeat(35), "x".repeat(35)],
    ["Clan 7", "Clan 7"],
  ])("accepts %j as %j", (input, expected) => {
    expect(checkClanName(input)).toEqual({ ok: true, value: expected });
  });

  it.each([
    ["too short", "ab"],
    ["too long", "x".repeat(36)],
    ["empty", ""],
    ["only spaces", "     "],
    ["a zero-width space", "Del​ta"],
    ["a zero-width joiner", "Del‍ta"],
    ["a bidi override", "Delta‮Force"],
    ["a control character", "Delta\u0007Force"],
    ["an emoji", "Delta 🔥"],
    ["a combining mark that does not compose", "Delta\u0489"],
    ["a leading dash", "-Delta"],
    ["angle brackets", "<b>Delta</b>"],
    ["a script tag", "<script>x</script>"],
    ["a slash", "Delta/Force"],
    ["a non-string", 42],
    ["null", null],
    ["an object", { name: "Delta" }],
    ["an enormous input", "x".repeat(10_000)],
  ])("rejects %s", (_what, input) => {
    expect(checkClanName(input)).toEqual({ ok: false, code: "INVALID_NAME" });
  });

  it("rejects profanity, with a code of its own", () => {
    expect(checkClanName("Fuck Clan")).toEqual({
      ok: false,
      code: "NAME_PROFANE",
    });
  });

  it("normalises whitespace the same way everywhere", () => {
    expect(normalizeName("  a   b  c ")).toBe("a b c");
    expect(nameSkeleton("Delta-Front")).toBe("deltafront");
    expect(nameSkeleton("D E L T A  front")).toBe("deltafront");
    expect(nameSkeleton("ＤＥＬＴＡfront")).toBe("deltafront");
  });
});

describe("clan tags", () => {
  it.each([
    ["ab", "AB"],
    ["Df1", "DF1"],
    ["ABCDE", "ABCDE"],
    ["a1b2c", "A1B2C"],
  ])("accepts %j as %j", (input, expected) => {
    expect(checkClanTag(input)).toEqual({ ok: true, value: expected });
  });

  it.each([
    "a",
    "ABCDEF",
    "",
    "A B",
    "A-B",
    "ÄB",
    "ab ",
    " ab",
    "a\nb",
    "<b>",
    "AB​",
    "٣٣",
    "ＡＢ",
  ])("rejects %j", (input) => {
    expect(checkClanTag(input)).toEqual({ ok: false, code: "INVALID_TAG" });
  });

  it("rejects non-strings and profane tags", () => {
    for (const bad of [null, undefined, 12, ["AB"], { tag: "AB" }]) {
      expect(checkClanTag(bad)).toEqual({ ok: false, code: "INVALID_TAG" });
    }
    expect(checkClanTag("FUCK")).toEqual({ ok: false, code: "NAME_PROFANE" });
  });

  it("reads a tag from a URL only when it is tag-shaped", () => {
    expect(tagFromRoute("abc")).toBe("ABC");
    expect(tagFromRoute("a")).toBeNull();
    expect(tagFromRoute("abc%2e")).toBeNull();
    expect(tagFromRoute("../x")).toBeNull();
  });
});

describe("descriptions and Discord links", () => {
  it("accepts up to 200 characters, trims, and refuses control characters and profanity", () => {
    expect(checkDescription("  Hello   world ")).toEqual({
      ok: true,
      value: "Hello world",
    });
    expect(checkDescription("")).toEqual({ ok: true, value: "" });
    expect(checkDescription("x".repeat(200)).ok).toBe(true);
    expect(checkDescription("x".repeat(201)).ok).toBe(false);
    expect(checkDescription("a\nb").ok).toBe(false);
    expect(checkDescription("a\u0000b").ok).toBe(false);
    expect(checkDescription("you are a fuck").ok).toBe(false);
    expect(checkDescription(5).ok).toBe(false);
  });

  it.each([
    "https://discord.gg/abcDEF1",
    "https://discord.com/invite/abc-DEF",
    "https://discord.gg/ab",
  ])("accepts the invite %s", (url) => {
    expect(checkDiscordUrl(url)).toEqual({ ok: true, value: url });
  });

  it("clears the link with an empty string", () => {
    expect(checkDiscordUrl("")).toEqual({ ok: true, value: null });
    expect(checkDiscordUrl("   ")).toEqual({ ok: true, value: null });
  });

  it.each([
    "http://discord.gg/abc",
    "https://discord.gg/",
    "https://discord.gg/a",
    "https://discord.gg/abc?x=1",
    "https://discord.gg/abc#f",
    "https://discord.gg.evil.com/abc",
    "https://evil.com/discord.gg/abc",
    "https://discord.com/invite/abc/def",
    "https://discordapp.com/invite/abc",
    "javascript:alert(1)",
    "https://discord.gg/abc def",
    `https://discord.gg/${"a".repeat(40)}`,
    "discord.gg/abc",
  ])("refuses %s", (url) => {
    expect(checkDiscordUrl(url)).toEqual({ ok: false });
  });

  it("refuses a link that is not a string", () => {
    expect(checkDiscordUrl(7)).toEqual({ ok: false });
    expect(checkDiscordUrl(null)).toEqual({ ok: false });
  });
});

describe("the reserved tags and names (clans/reserved.json)", () => {
  const reserved = loadReservedClanNames();

  it("is data in one file, validated when it loads", () => {
    expect(reserved.tags.has("ADMIN")).toBe(true);
    for (const tag of ["ADMIN", "MOD", "DEV", "STAFF", "DF", "DELTA"]) {
      expect(isReservedTag(reserved, tag), tag).toBe(true);
    }
    expect(isReservedTag(reserved, "df")).toBe(true); // matching ignores case
    expect(isReservedTag(reserved, "WOLF")).toBe(false);
    // every tag in the file is a legal clan tag, upper case
    for (const tag of reserved.tags)
      expect(checkClanTag(tag).ok || /^[A-Z0-9]{2,5}$/.test(tag)).toBe(true);
  });

  it("refuses names that imitate DeltaFront, OpenFront or staff, however they are spaced or styled", () => {
    for (const name of [
      "DeltaFront",
      "Delta Front",
      "delta-front Official",
      "Ｄｅｌｔａ Ｆｒｏｎｔ",
      "The OpenFront Team",
      "Admin Squad",
      "Support",
    ]) {
      expect(isReservedName(reserved, name), name).toBe(true);
    }
    for (const name of ["Delta Force", "Front Line", "Open Door"]) {
      expect(isReservedName(reserved, name), name).toBe(false);
    }
  });

  it("is not duplicated in the client or the game server: the only copy of the list is the data file", () => {
    const root = path.resolve(__dirname, "../..");
    const walk = (dir: string, out: string[] = []): string[] => {
      for (const e of fs.readdirSync(path.join(root, dir), {
        withFileTypes: true,
      })) {
        const rel = `${dir}/${e.name}`;
        if (e.isDirectory()) walk(rel, out);
        else if (rel.endsWith(".ts")) out.push(rel);
      }
      return out;
    };
    for (const file of [
      ...walk("src/client"),
      ...walk("src/server"),
      ...walk("packages/shared/src"),
    ]) {
      expect(fs.readFileSync(path.join(root, file), "utf8"), file).not.toMatch(
        /["']STAFF["']\s*,\s*["']SUPPORT["']/,
      );
    }
  });

  it("refuses a malformed reserved file", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "df-reserved-"));
    const write = (data: unknown) =>
      fs.writeFileSync(path.join(dir, "reserved.json"), JSON.stringify(data));
    write({ tags: ["ok"], nameSkeletons: [] });
    expect(() => loadReservedClanNames(dir)).toThrow(/invalid/);
    write({ tags: ["AB", "AB"], nameSkeletons: [] });
    expect(() => loadReservedClanNames(dir)).toThrow(/twice/);
    write({ tags: ["AB"], nameSkeletons: ["has space"] });
    expect(() => loadReservedClanNames(dir)).toThrow(/invalid/);
    write({ tags: ["AB"], nameSkeletons: [], extra: 1 });
    expect(() => loadReservedClanNames(dir)).toThrow(/invalid/);
    write({ tags: ["AB"], nameSkeletons: ["abc"] });
    expect(loadReservedClanNames(dir).tags.has("AB")).toBe(true);
    expect(CLANS_DIR).toMatch(/src\/account-api\/clans$/);
  });
});

describe("page parameters", () => {
  it("defaults, clamps and ignores junk", () => {
    expect(pageParams({})).toEqual({
      page: 1,
      limit: CLAN_RULES.defaultPageSize,
    });
    expect(pageParams({ page: "3", limit: "10" })).toEqual({
      page: 3,
      limit: 10,
    });
    expect(pageParams({ page: "0", limit: "0" })).toEqual({
      page: 1,
      limit: 1,
    });
    expect(pageParams({ page: "99999999", limit: "99999" }).limit).toBe(
      CLAN_RULES.maxPageSize,
    );
    expect(pageParams({ page: "99999999" }).page).toBeLessThanOrEqual(
      CLAN_RULES.maxPage,
    );
    expect(pageParams({ page: "-1", limit: "abc" })).toEqual({
      page: 1,
      limit: CLAN_RULES.defaultPageSize,
    });
    expect(pageParams({ page: ["1", "2"], limit: { a: 1 } })).toEqual({
      page: 1,
      limit: CLAN_RULES.defaultPageSize,
    });
    expect(pageParams({ page: "1e3", limit: "1.5" })).toEqual({
      page: 1,
      limit: CLAN_RULES.defaultPageSize,
    });
  });
});
