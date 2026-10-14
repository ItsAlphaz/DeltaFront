import { PlayerType } from "@openfront/engine-api/game/GameTypes";
import {
  MATCH_EVENT_CATEGORIES,
  type MatchEvent,
} from "@openfront/engine-api/game/MatchEvents";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sentenceText } from "../../src/client/matchevents/MatchEventLine";
import type { MatchLogEntry } from "../../src/client/matchevents/MatchEventLog";
import {
  describeEvent,
  involvesHuman,
  resolvePlayer,
  slotText,
  type MatchPlayerLookup,
} from "../../src/client/matchevents/MatchEventText";
import { UserSettings } from "../../src/client/UserSettings";
import { hasEnglish, translateEn } from "../util/translateEn";
import { makeGameView, makePlayerView } from "../util/viewStubs";

// The real English strings, formatted the way the client formats them, so the
// wording the player reads is what is tested, not the keys.
const translate = translateEn;
const EN = new Proxy({} as Record<string, string | undefined>, {
  get: (_t, key: string) => (hasEnglish(key) ? key : undefined),
});

const clearSettings = () => {
  localStorage.clear();
  (
    UserSettings as unknown as { cache: Map<string, string | null> }
  ).cache.clear();
};

const game = makeGameView({ myClientID: "me" });
function player(
  smallID: number,
  name: string,
  opts: {
    clan?: string | null;
    type?: PlayerType;
    staffRole?: "owner" | "admin" | "mod";
    verified?: boolean;
    clientID?: string | null;
  } = {},
) {
  return makePlayerView({
    game,
    data: {
      id: `p${smallID}`,
      smallID,
      name,
      displayName: opts.clan ? `[${opts.clan}] ${name}` : name,
      clanTag: opts.clan ?? null,
      playerType: opts.type ?? PlayerType.Human,
      clientID: opts.clientID === undefined ? `c${smallID}` : opts.clientID,
    },
    cosmetics: { staffRole: opts.staffRole, verified: opts.verified },
  });
}

const ALPHAZ = 1;
const REDFOX = 2;
const NOVA = 3;
const TRIBE = 4;
function lookupOf(): MatchPlayerLookup {
  const players = new Map([
    [
      ALPHAZ,
      player(ALPHAZ, "Alphaz", {
        clan: "DELTA",
        staffRole: "owner",
        verified: true,
      }),
    ],
    [REDFOX, player(REDFOX, "RedFox")],
    [NOVA, player(NOVA, "Nova", { type: PlayerType.Nation, clientID: null })],
    [TRIBE, player(TRIBE, "Tribe 4", { type: PlayerType.Bot, clientID: null })],
  ]);
  return {
    playerBySmallID: (id) => players.get(id) ?? { isPlayer: () => false },
  };
}

let seq = 0;
function entry(
  over: Partial<MatchEvent> & Pick<MatchEvent, "type">,
  count = 1,
): MatchLogEntry {
  const event: MatchEvent = {
    seq: seq++,
    tick: 100,
    severity: "normal",
    actor: null,
    target: null,
    meta: {},
    ...over,
  };
  return { id: seq, event, count, firstTick: 100, lastTick: 100 };
}

const text = (e: MatchLogEntry, lookup = lookupOf()) =>
  sentenceText(describeEvent(e, lookup, translate), translate);

beforeEach(clearSettings);
afterEach(clearSettings);

describe("the wording of each event", () => {
  it("player eliminated: names the killer only when the engine credited one", () => {
    expect(
      text(
        entry({
          type: "player_eliminated",
          severity: "critical",
          actor: ALPHAZ,
          target: REDFOX,
          meta: { targetKind: "player" },
        }),
      ),
    ).toBe("[DELTA] Alphaz eliminated RedFox");
    // No credited killer: no one is named, however obvious it might look.
    expect(
      text(
        entry({
          type: "player_eliminated",
          severity: "critical",
          actor: null,
          target: REDFOX,
          meta: { targetKind: "player" },
        }),
      ),
    ).toBe("RedFox was eliminated");
  });

  it("a run of tribes reads as a count, with or without a killer", () => {
    const tribes = (actor: number | null, n: number) =>
      entry(
        {
          type: "player_eliminated",
          actor,
          target: TRIBE,
          meta: { targetKind: "bot" },
        },
        n,
      );
    expect(text(tribes(ALPHAZ, 3))).toBe("[DELTA] Alphaz eliminated 3 tribes");
    expect(text(tribes(null, 3))).toBe("3 tribes were eliminated");
    expect(text(tribes(null, 1))).toBe("Tribe 4 was eliminated");
    expect(text(tribes(ALPHAZ, 1))).toBe("[DELTA] Alphaz eliminated Tribe 4");
  });

  it("largest nation", () => {
    expect(
      text(
        entry({
          type: "largest_nation_changed",
          severity: "major",
          actor: ALPHAZ,
          meta: { share: 12 },
        }),
      ),
    ).toBe("[DELTA] Alphaz became the largest nation");
    expect(
      text(
        entry({
          type: "largest_nation_changed",
          severity: "major",
          meta: { team: "Red", share: 30 },
        }),
      ),
    ).toBe("Team Red became the largest nation");
  });

  it("alliances: formed, broken by someone, and ended without a culprit", () => {
    expect(
      text(entry({ type: "alliance_formed", actor: ALPHAZ, target: REDFOX })),
    ).toBe("[DELTA] Alphaz formed an alliance with RedFox");
    expect(
      text(
        entry({
          type: "alliance_broken",
          severity: "major",
          actor: ALPHAZ,
          target: REDFOX,
          meta: { cause: "broken" },
        }),
      ),
    ).toBe("[DELTA] Alphaz broke the alliance with RedFox");
    expect(
      text(
        entry({
          type: "alliance_broken",
          actor: ALPHAZ,
          target: REDFOX,
          meta: { cause: "expired" },
        }),
      ),
    ).toBe("Alliance between [DELTA] Alphaz and RedFox ended");
  });

  it("territory loss", () => {
    expect(
      text(
        entry({
          type: "major_territory_loss",
          severity: "major",
          target: REDFOX,
          meta: { percent: 50 },
        }),
      ),
    ).toBe("RedFox lost 50% of its territory");
  });

  it("the match starting and ending", () => {
    expect(text(entry({ type: "game_started" }))).toBe("The match has begun");
    expect(
      text(entry({ type: "game_ending", severity: "critical", actor: REDFOX })),
    ).toBe("RedFox won the match");
    expect(
      text(
        entry({
          type: "game_ending",
          severity: "critical",
          meta: { team: "Blue" },
        }),
      ),
    ).toBe("Team Blue won the match");
    expect(text(entry({ type: "game_ending", severity: "critical" }))).toBe(
      "The match has ended",
    );
  });

  it("staff actions say so, and name the role when the badge is on show", () => {
    const admin = (
      command: NonNullable<MatchEvent["meta"]["command"]>,
      target: number | null = REDFOX,
    ) =>
      entry({
        type: "admin_action",
        severity: command === "force_win" ? "critical" : "major",
        actor: ALPHAZ,
        target,
        meta: { command },
      });
    expect(text(admin("eliminate"))).toBe(
      "[DELTA] Alphaz eliminated RedFox using admin tools",
    );
    expect(text(admin("force_win", ALPHAZ))).toBe(
      "[DELTA] Alphaz forced the winner",
    );
    expect(text(admin("force_win", REDFOX))).toBe(
      "[DELTA] Alphaz forced RedFox as the winner",
    );
    expect(text(admin("give_gold"))).toBe(
      "Owner [DELTA] Alphaz used admin tools on RedFox",
    );
  });

  it("a collapsed run of the same staff command says how many times", () => {
    const cmd = entry(
      {
        type: "admin_action",
        severity: "major",
        actor: ALPHAZ,
        target: REDFOX,
        meta: { command: "set_gold" },
      },
      4,
    );
    expect(text(cmd)).toBe(
      "Owner [DELTA] Alphaz used admin tools on RedFox ×4",
    );
  });

  it("public staff lines carry no amounts or audit detail", () => {
    const e = entry({
      type: "admin_action",
      severity: "major",
      actor: ALPHAZ,
      target: REDFOX,
      meta: { command: "give_gold" },
    });
    const desc = describeEvent(e, lookupOf(), translate);
    expect(JSON.stringify(desc)).not.toMatch(/reason|audit|amount|ip|email/i);
  });
});

describe("players in a line: names, clans, badges", () => {
  it("come from the same views as the rest of the HUD: clan tag, staff badge, verified check", () => {
    const desc = describeEvent(
      entry({ type: "alliance_formed", actor: ALPHAZ, target: REDFOX }),
      lookupOf(),
    );
    expect(desc.slots.actor).toMatchObject({
      name: "Alphaz",
      clan: "DELTA",
      staff: "owner",
      verified: true,
      type: PlayerType.Human,
    });
    expect(desc.slots.target).toMatchObject({
      name: "RedFox",
      clan: null,
      staff: null,
      verified: false,
    });
    expect(slotText(desc.slots.actor!)).toBe("[DELTA] Alphaz");
  });

  it("a staff badge is never inferred from the name", () => {
    const lookup: MatchPlayerLookup = {
      playerBySmallID: () => player(9, "Owner", { clan: "OWNER" }),
    };
    const slot = resolvePlayer(lookup, 9)!;
    expect(slot.staff).toBeNull();
    expect(slot.verified).toBe(false);
  });

  it("Anonymous Names: no real name, clan tag or badge in the line, and it follows the setting live", () => {
    const e = entry({ type: "alliance_formed", actor: ALPHAZ, target: REDFOX });
    // Alphaz and RedFox are other players here (the game's own client is "me").
    const lookup = lookupOf();
    expect(text(e, lookup)).toContain("Alphaz");

    localStorage.setItem("settings.anonymousNames", "true");
    (
      UserSettings as unknown as { cache: Map<string, string | null> }
    ).cache.clear();
    const anon = describeEvent(e, lookup, translate);
    const line = sentenceText(anon, translate);
    expect(line).not.toContain("Alphaz");
    expect(line).not.toContain("RedFox");
    expect(line).not.toContain("DELTA");
    expect(anon.slots.actor).toMatchObject({
      clan: null,
      staff: null,
      verified: false,
    });
    expect(anon.slots.target).toMatchObject({
      clan: null,
      staff: null,
      verified: false,
    });
    // A generated name stands in for each.
    expect(anon.slots.actor!.name.length).toBeGreaterThan(0);

    clearSettings();
    expect(text(e, lookup)).toContain("Alphaz");
  });

  it("Anonymous Names: a staff action does not reveal the role either", () => {
    localStorage.setItem("settings.anonymousNames", "true");
    (
      UserSettings as unknown as { cache: Map<string, string | null> }
    ).cache.clear();
    const e = entry({
      type: "admin_action",
      severity: "major",
      actor: ALPHAZ,
      target: REDFOX,
      meta: { command: "give_gold" },
    });
    const desc = describeEvent(e, lookupOf(), translate);
    expect(desc.role).toBeNull();
    expect(desc.key).toBe("match_events.admin_used");
    const line = sentenceText(desc, translate);
    expect(line).not.toMatch(/owner|admin(?!\s+tools)|Alphaz|DELTA/i);
  });

  it("an id that is not a player (or gone) is left out, not guessed", () => {
    const desc = describeEvent(
      entry({ type: "alliance_formed", actor: 99, target: REDFOX }),
      lookupOf(),
    );
    expect(desc.slots.actor).toBeUndefined();
    expect(desc.slots.target?.name).toBe("RedFox");
  });
});

describe("involvesHuman", () => {
  const e = (actor: number | null, target: number | null) =>
    entry({ type: "alliance_formed", actor, target }).event;
  it("is true when a person is one of the parties, false for tribes and nations only", () => {
    const lookup = lookupOf();
    expect(involvesHuman(e(NOVA, TRIBE), lookup)).toBe(false);
    expect(involvesHuman(e(NOVA, REDFOX), lookup)).toBe(true);
    expect(involvesHuman(e(null, ALPHAZ), lookup)).toBe(true);
    expect(involvesHuman(e(null, null), lookup)).toBe(true);
  });
});

describe("categories and translations", () => {
  it("every sentence and label the feed can show exists in en.json", () => {
    const lookup = lookupOf();
    const events: MatchLogEntry[] = [
      entry({ type: "game_started" }),
      entry({ type: "game_ending", actor: ALPHAZ }),
      entry({ type: "game_ending", meta: { team: "Red" } }),
      entry({ type: "game_ending" }),
      entry({ type: "player_eliminated", actor: ALPHAZ, target: REDFOX }),
      entry({ type: "player_eliminated", target: REDFOX }),
      entry({ type: "player_eliminated", actor: ALPHAZ, target: TRIBE }, 3),
      entry({ type: "player_eliminated", target: TRIBE }, 3),
      entry({ type: "largest_nation_changed", actor: ALPHAZ }),
      entry({ type: "largest_nation_changed", meta: { team: "Red" } }),
      entry({ type: "alliance_formed", actor: ALPHAZ, target: REDFOX }),
      entry({
        type: "alliance_broken",
        actor: ALPHAZ,
        target: REDFOX,
        meta: { cause: "broken" },
      }),
      entry({
        type: "alliance_broken",
        actor: ALPHAZ,
        target: REDFOX,
        meta: { cause: "expired" },
      }),
      entry({
        type: "major_territory_loss",
        target: REDFOX,
        meta: { percent: 25 },
      }),
      ...(["give_gold", "eliminate", "force_win"] as const).flatMap(
        (command) => [
          entry({
            type: "admin_action",
            actor: ALPHAZ,
            target: ALPHAZ,
            meta: { command },
          }),
          entry({
            type: "admin_action",
            actor: ALPHAZ,
            target: REDFOX,
            meta: { command },
          }),
        ],
      ),
    ];
    const keys = new Set(events.map((x) => describeEvent(x, lookup).key));
    for (const key of keys) expect(EN[key], key).toBeTypeOf("string");
    for (const category of ["all", ...MATCH_EVENT_CATEGORIES]) {
      expect(EN[`match_events.filter_${category}`]).toBeTypeOf("string");
    }
    for (const role of ["owner", "admin", "mod"]) {
      expect(EN[`match_events.role_${role}`]).toBeTypeOf("string");
    }
    for (const key of [
      "match_events.feed_label",
      "match_events.log_title",
      "match_events.log_button",
      "match_events.log_close",
      "match_events.log_empty",
      "match_events.log_count",
      "user_setting.event_feed_label",
      "user_setting.event_feed_desc",
      "user_setting.event_feed_detail_label",
      "user_setting.event_feed_detail_desc",
      "user_setting.event_feed_detail_all",
      "user_setting.event_feed_detail_major",
      "user_setting.event_feed_sound_label",
      "user_setting.event_feed_sound_desc",
    ]) {
      expect(EN[key], key).toBeTypeOf("string");
    }
  });

  it("describes each event with its severity, category and an icon", () => {
    const lookup = lookupOf();
    const d = describeEvent(
      entry({
        type: "alliance_broken",
        severity: "major",
        actor: ALPHAZ,
        target: REDFOX,
        meta: { cause: "broken" },
      }),
      lookup,
    );
    expect(d).toMatchObject({
      severity: "major",
      category: "diplomacy",
      icon: "alliance_broken",
    });
  });
});
