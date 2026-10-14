import type {
  MatchEvent,
  MatchEventSeverity,
} from "@openfront/engine-api/game/MatchEvents";
import { describe, expect, it } from "vitest";
import {
  COLLAPSE_WINDOW_TICKS,
  FEED_FADE_TICKS,
  FEED_LIFETIME_TICKS,
  FEED_MAX_ROWS,
  MATCH_LOG_MAX_ENTRIES,
  MatchEventLog,
  collapseKey,
  liveFeedRows,
  type FeedOptions,
} from "../../src/client/matchevents/MatchEventLog";

let nextSeq = 0;
function ev(over: Partial<MatchEvent> & Pick<MatchEvent, "type">): MatchEvent {
  return {
    seq: nextSeq++,
    tick: 100,
    severity: "normal",
    actor: null,
    target: null,
    meta: {},
    ...over,
  };
}

const elimination = (
  over: Partial<MatchEvent> = {},
  targetKind: "player" | "bot" = "player",
) =>
  ev({
    type: "player_eliminated",
    severity: targetKind === "bot" ? "normal" : "critical",
    target: 2,
    meta: { targetKind },
    ...over,
  });

const everyoneIsHuman: FeedOptions["involvesHuman"] = () => true;
const all: FeedOptions = { detail: "all", involvesHuman: everyoneIsHuman };
const major: FeedOptions = { detail: "major", involvesHuman: everyoneIsHuman };

describe("MatchEventLog: ingest", () => {
  it("keeps events in the order they came, one entry each", () => {
    const log = new MatchEventLog();
    const a = ev({ type: "game_started", tick: 10 });
    const b = elimination({ tick: 20, actor: 1 });
    const c = ev({ type: "alliance_formed", tick: 30, actor: 1, target: 2 });
    log.ingest([a, b]);
    log.ingest([c]);
    expect(log.entries().map((e) => e.event)).toEqual([a, b, c]);
    expect(log.entries().every((e) => e.count === 1)).toBe(true);
    expect(new Set(log.entries().map((e) => e.id)).size).toBe(3);
  });

  it("ignores an event it has already taken (a frame delivered twice adds nothing)", () => {
    const log = new MatchEventLog();
    const a = ev({ type: "game_started" });
    const b = elimination({ actor: 1 });
    log.ingest([a, b]);
    const version = log.version;
    expect(log.ingest([a, b])).toEqual([]);
    expect(log.ingest([a])).toEqual([]);
    expect(log.size()).toBe(2);
    expect(log.version).toBe(version);
  });

  it("tells subscribers about changes, and only changes", () => {
    const log = new MatchEventLog();
    let calls = 0;
    const stop = log.subscribe(() => calls++);
    log.ingest([ev({ type: "game_started" })]);
    expect(calls).toBe(1);
    log.ingest([]);
    expect(calls).toBe(1);
    stop();
    log.ingest([ev({ type: "alliance_formed", actor: 1, target: 2 })]);
    expect(calls).toBe(1);
  });

  it("clear() forgets the history and lets a replay start over", () => {
    const log = new MatchEventLog();
    const a = ev({ type: "game_started" });
    log.ingest([a]);
    log.clear();
    expect(log.size()).toBe(0);
    // The same event can be taken again after a seek.
    expect(log.ingest([a])).toHaveLength(1);
  });
});

describe("MatchEventLog: collapsing runs of bookkeeping", () => {
  it("a run of tribes falling to the same player is one entry with a count", () => {
    const log = new MatchEventLog();
    for (let i = 0; i < 5; i++) {
      log.ingest([
        elimination({ actor: 1, target: 10 + i, tick: 100 + i * 5 }, "bot"),
      ]);
    }
    expect(log.size()).toBe(1);
    expect(log.entries()[0]).toMatchObject({
      count: 5,
      firstTick: 100,
      lastTick: 120,
    });
    expect(log.entries()[0].event.target).toBe(14); // the newest
  });

  it("different killers, or a gap longer than the window, start new entries", () => {
    const log = new MatchEventLog();
    log.ingest([elimination({ actor: 1, tick: 100 }, "bot")]);
    log.ingest([elimination({ actor: 3, tick: 101 }, "bot")]);
    log.ingest([elimination({ actor: null, tick: 102 }, "bot")]);
    expect(log.size()).toBe(3);
    log.ingest([
      elimination({ actor: 1, tick: 101 + COLLAPSE_WINDOW_TICKS + 10 }, "bot"),
    ]);
    expect(log.size()).toBe(4);
  });

  it("a player's elimination is never collapsed, even next to tribes", () => {
    const log = new MatchEventLog();
    log.ingest([elimination({ actor: 1, tick: 100 }, "bot")]);
    log.ingest([elimination({ actor: 1, target: 5, tick: 101 })]);
    log.ingest([elimination({ actor: 1, target: 6, tick: 102 })]);
    expect(log.size()).toBe(3);
    expect(log.entries().map((e) => e.count)).toEqual([1, 1, 1]);
  });

  it("repeated staff resource commands on the same player collapse; eliminate and force-win do not", () => {
    const log = new MatchEventLog();
    const give = (
      tick: number,
      command: "give_gold" | "set_troops" | "eliminate" | "force_win",
    ) =>
      ev({
        type: "admin_action",
        severity: command === "force_win" ? "critical" : "major",
        actor: 1,
        target: 2,
        tick,
        meta: { command },
      });
    log.ingest([
      give(100, "give_gold"),
      give(101, "give_gold"),
      give(102, "give_gold"),
    ]);
    log.ingest([give(103, "set_troops")]);
    log.ingest([give(104, "eliminate"), give(105, "eliminate")]);
    log.ingest([give(106, "force_win")]);
    expect(log.entries().map((e) => [e.event.meta.command, e.count])).toEqual([
      ["give_gold", 3],
      ["set_troops", 1],
      ["eliminate", 1],
      ["eliminate", 1],
      ["force_win", 1],
    ]);
  });

  it("only the repetitive kinds have a collapse key", () => {
    expect(
      collapseKey(ev({ type: "alliance_formed", actor: 1, target: 2 })),
    ).toBeNull();
    expect(
      collapseKey(ev({ type: "alliance_broken", actor: 1, target: 2 })),
    ).toBeNull();
    expect(
      collapseKey(ev({ type: "largest_nation_changed", actor: 1 })),
    ).toBeNull();
    expect(
      collapseKey(ev({ type: "major_territory_loss", target: 1 })),
    ).toBeNull();
    expect(collapseKey(ev({ type: "game_ending" }))).toBeNull();
  });
});

describe("MatchEventLog: history and filters", () => {
  it("keeps a long history for the whole match, up to a cap", () => {
    const log = new MatchEventLog();
    const events: MatchEvent[] = [];
    for (let i = 0; i < 300; i++) {
      events.push(
        ev({ type: "alliance_formed", actor: i, target: i + 1, tick: i }),
      );
    }
    log.ingest(events);
    expect(log.size()).toBe(300);
    expect(MATCH_LOG_MAX_ENTRIES).toBeGreaterThanOrEqual(300);
  });

  it("past the cap, ordinary events go first and critical ones stay", () => {
    const log = new MatchEventLog(10);
    log.ingest([elimination({ actor: 1, target: 2, tick: 1 })]);
    for (let i = 0; i < 30; i++) {
      log.ingest([
        ev({ type: "alliance_formed", actor: 1, target: 2, tick: 2 + i }),
      ]);
    }
    expect(log.size()).toBe(10);
    expect(
      log.entries().some((e) => e.event.type === "player_eliminated"),
    ).toBe(true);
    // And the newest ordinary ones are the ones kept.
    expect(log.entries()[log.size() - 1].event.tick).toBe(31);
  });

  it("filters by category: combat, diplomacy, territory, system", () => {
    const log = new MatchEventLog();
    log.ingest([
      ev({ type: "game_started" }),
      elimination({ actor: 1 }),
      ev({ type: "alliance_formed", actor: 1, target: 2 }),
      ev({
        type: "alliance_broken",
        severity: "major",
        actor: 1,
        target: 2,
        meta: { cause: "broken" },
      }),
      ev({
        type: "largest_nation_changed",
        severity: "major",
        actor: 1,
        meta: { share: 9 },
      }),
      ev({
        type: "major_territory_loss",
        severity: "major",
        target: 2,
        meta: { percent: 50 },
      }),
      ev({
        type: "admin_action",
        severity: "major",
        actor: 1,
        target: 2,
        meta: { command: "give_gold" },
      }),
      ev({ type: "game_ending", severity: "critical", actor: 1 }),
    ]);
    const types = (f: Parameters<MatchEventLog["filtered"]>[0]) =>
      log.filtered(f).map((e) => e.event.type);
    expect(types("all")).toHaveLength(8);
    expect(types("combat")).toEqual(["player_eliminated"]);
    expect(types("diplomacy")).toEqual(["alliance_formed", "alliance_broken"]);
    expect(types("territory")).toEqual([
      "largest_nation_changed",
      "major_territory_loss",
    ]);
    expect(types("system")).toEqual([
      "game_started",
      "admin_action",
      "game_ending",
    ]);
  });
});

describe("liveFeedRows: what is on the ticker", () => {
  const log = (...events: MatchEvent[]) => {
    const l = new MatchEventLog();
    l.ingest(events);
    return l;
  };
  const ofSeverity = (severity: MatchEventSeverity, tick: number) =>
    ev({
      type:
        severity === "critical"
          ? "player_eliminated"
          : severity === "major"
            ? "alliance_broken"
            : "alliance_formed",
      severity,
      actor: 1,
      target: 2,
      tick,
      meta: severity === "major" ? { cause: "broken" } : {},
    });

  it("shows the newest first", () => {
    const l = log(
      ofSeverity("major", 100),
      ofSeverity("critical", 105),
      ofSeverity("normal", 110),
    );
    const rows = liveFeedRows(l, 112, all);
    expect(rows.map((r) => r.entry.event.severity)).toEqual([
      "normal",
      "critical",
      "major",
    ]);
  });

  it("critical events linger longer than major, and major longer than normal", () => {
    expect(FEED_LIFETIME_TICKS.critical).toBeGreaterThan(
      FEED_LIFETIME_TICKS.major,
    );
    expect(FEED_LIFETIME_TICKS.major).toBeGreaterThan(
      FEED_LIFETIME_TICKS.normal,
    );
    const l = log(
      ofSeverity("critical", 0),
      ofSeverity("major", 0),
      ofSeverity("normal", 0),
    );
    const severitiesAt = (now: number) =>
      liveFeedRows(l, now, all).map((r) => r.entry.event.severity);
    expect(severitiesAt(FEED_LIFETIME_TICKS.normal - 1)).toHaveLength(3);
    expect(severitiesAt(FEED_LIFETIME_TICKS.normal)).toEqual([
      "major",
      "critical",
    ]);
    expect(severitiesAt(FEED_LIFETIME_TICKS.major)).toEqual(["critical"]);
    expect(severitiesAt(FEED_LIFETIME_TICKS.critical)).toEqual([]);
  });

  it("fades out over the last part of a row's life", () => {
    const l = log(ofSeverity("major", 0));
    const life = FEED_LIFETIME_TICKS.major;
    const opacityAt = (now: number) => liveFeedRows(l, now, all)[0].opacity;
    expect(opacityAt(5)).toBe(1);
    expect(opacityAt(life - FEED_FADE_TICKS)).toBe(1);
    const fading = opacityAt(life - FEED_FADE_TICKS / 2);
    expect(fading).toBeGreaterThan(0);
    expect(fading).toBeLessThan(1);
    expect(opacityAt(life - 1)).toBeLessThan(fading);
  });

  it("shows at most FEED_MAX_ROWS rows, and a flurry of small events cannot push a critical one off", () => {
    const events: MatchEvent[] = [ofSeverity("critical", 100)];
    for (let i = 0; i < 20; i++) events.push(ofSeverity("normal", 101 + i));
    const rows = liveFeedRows(log(...events), 125, all);
    expect(rows).toHaveLength(FEED_MAX_ROWS);
    expect(rows.some((r) => r.entry.event.severity === "critical")).toBe(true);
    // The rest are the newest of the small ones.
    const normal = rows.filter((r) => r.entry.event.severity === "normal");
    expect(normal.map((r) => r.entry.event.tick)).toEqual(
      [120, 119, 118, 117, 116].slice(0, normal.length),
    );
    expect(
      liveFeedRows(log(...events), 125, { ...all, maxRows: 3 }),
    ).toHaveLength(3);
  });

  it("'major only' leaves out ordinary events; 'all' leaves out ordinary events nobody human is in", () => {
    const l = log(
      ofSeverity("normal", 100),
      ofSeverity("major", 101),
      ofSeverity("critical", 102),
    );
    expect(
      liveFeedRows(l, 105, major).map((r) => r.entry.event.severity),
    ).toEqual(["critical", "major"]);
    expect(liveFeedRows(l, 105, all)).toHaveLength(3);
    const aiOnly: FeedOptions = { detail: "all", involvesHuman: () => false };
    // Major and critical always show; the ordinary AI-only one does not.
    expect(
      liveFeedRows(l, 105, aiOnly).map((r) => r.entry.event.severity),
    ).toEqual(["critical", "major"]);
  });

  it("does not show an event from the future (a replay seek back), or an old one", () => {
    const l = log(ofSeverity("critical", 500));
    expect(liveFeedRows(l, 400, all)).toEqual([]);
    expect(
      liveFeedRows(l, 500 + FEED_LIFETIME_TICKS.critical + 1, all),
    ).toEqual([]);
  });

  it("a collapsed entry's row lives from its newest event", () => {
    const l = new MatchEventLog();
    l.ingest([elimination({ actor: 1, tick: 0 }, "bot")]);
    l.ingest([elimination({ actor: 1, target: 11, tick: 60 }, "bot")]);
    // 0 + 70 would have expired the first; the run's newest event keeps it.
    const rows = liveFeedRows(l, 90, all);
    expect(rows).toHaveLength(1);
    expect(rows[0].entry.count).toBe(2);
  });
});
