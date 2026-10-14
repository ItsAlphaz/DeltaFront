import {
  matchEventCategory,
  type MatchEvent,
  type MatchEventCategory,
  type MatchEventSeverity,
} from "@openfront/engine-api/game/MatchEvents";

/**
 * The match's event history as the client keeps it: one log, fed with the
 * structured events the engine emits (GameUpdateType.MatchEvent) and read by
 * both the compact live feed and the full event log. There is no second
 * representation to drift out of step.
 *
 * An entry is one line of the history. Runs of the same kind of bookkeeping
 * event are collapsed into one entry with a count ("Alphaz eliminated 3 tribes",
 * "used admin tools ×4") so a burst is one line, not a stream. The events the
 * engine emits are never merged or rewritten, only grouped for display.
 */

/** Entries kept. When it is full, ordinary events go before the important ones. */
export const MATCH_LOG_MAX_ENTRIES = 500;

/** How far apart (in ticks) events can be and still collapse into one entry. */
export const COLLAPSE_WINDOW_TICKS = 100;

export interface MatchLogEntry {
  /** Unique within the log; a collapsed run keeps the id of its first event. */
  id: number;
  /** The newest event of the entry. */
  event: MatchEvent;
  /** How many events the entry stands for. */
  count: number;
  firstTick: number;
  lastTick: number;
}

const SEVERITY_RANK: Record<MatchEventSeverity, number> = {
  normal: 0,
  major: 1,
  critical: 2,
};

export function severityRank(severity: MatchEventSeverity): number {
  return SEVERITY_RANK[severity];
}

/**
 * Events with the same key within the window collapse into one entry. Null:
 * never collapse. Only repetitive bookkeeping collapses; an elimination of a
 * player, a lost alliance or a new leader is always its own line.
 */
export function collapseKey(event: MatchEvent): string | null {
  switch (event.type) {
    case "player_eliminated":
      // A battle against tribes drops many of them: one line per killer.
      return event.meta.targetKind === "bot"
        ? `tribes:${event.actor ?? "none"}`
        : null;
    case "admin_action":
      // Commands that change numbers (not the eliminate / force-win ones, which
      // are events in their own right).
      return event.meta.command === "eliminate" ||
        event.meta.command === "force_win"
        ? null
        : `admin:${event.actor}:${event.target}:${event.meta.command}`;
    default:
      return null;
  }
}

type Listener = () => void;

export class MatchEventLog {
  private list: MatchLogEntry[] = [];
  private lastSeq = -1;
  private nextId = 0;
  private listeners = new Set<Listener>();
  /** Bumped on every change, so a renderer can tell cheaply whether to redraw. */
  private _version = 0;

  constructor(private readonly maxEntries = MATCH_LOG_MAX_ENTRIES) {}

  get version(): number {
    return this._version;
  }

  /** Oldest first. Do not mutate. */
  entries(): readonly MatchLogEntry[] {
    return this.list;
  }

  size(): number {
    return this.list.length;
  }

  /**
   * Adds events from the engine, in order. An event whose `seq` is not newer
   * than the last one taken is ignored, so delivering the same tick twice
   * (a replay re-reading a frame) adds nothing. Returns the entries that are new
   * or grew.
   */
  ingest(events: readonly MatchEvent[]): MatchLogEntry[] {
    const touched: MatchLogEntry[] = [];
    for (const event of events) {
      if (event.seq <= this.lastSeq) continue;
      this.lastSeq = event.seq;
      const merged = this.mergeInto(event);
      if (merged !== null) {
        if (!touched.includes(merged)) touched.push(merged);
        continue;
      }
      const entry: MatchLogEntry = {
        id: this.nextId++,
        event,
        count: 1,
        firstTick: event.tick,
        lastTick: event.tick,
      };
      this.list.push(entry);
      touched.push(entry);
    }
    if (touched.length > 0) {
      this.trim();
      this._version++;
      this.listeners.forEach((fn) => fn());
    }
    return touched;
  }

  /** Forgets everything (a replay jumping to another point of the match). */
  clear(): void {
    if (this.list.length === 0 && this.lastSeq === -1) return;
    this.list = [];
    this.lastSeq = -1;
    this._version++;
    this.listeners.forEach((fn) => fn());
  }

  /** Called after every change. Returns the function that stops it. */
  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** The entries of one filter, oldest first; "all" is every entry. */
  filtered(category: MatchEventCategory | "all"): MatchLogEntry[] {
    return category === "all"
      ? [...this.list]
      : this.list.filter((e) => matchEventCategory(e.event.type) === category);
  }

  private mergeInto(event: MatchEvent): MatchLogEntry | null {
    const key = collapseKey(event);
    if (key === null) return null;
    // Only the entries at the tail can still be inside the window.
    for (let i = this.list.length - 1; i >= 0; i--) {
      const entry = this.list[i];
      if (event.tick - entry.lastTick > COLLAPSE_WINDOW_TICKS) return null;
      if (collapseKey(entry.event) !== key) continue;
      entry.event = event;
      entry.count++;
      entry.lastTick = event.tick;
      // Moves to the end so the entry reads as the newest thing that happened.
      this.list.splice(i, 1);
      this.list.push(entry);
      return entry;
    }
    return null;
  }

  private trim(): void {
    while (this.list.length > this.maxEntries) {
      const drop = this.list.findIndex((e) => e.event.severity === "normal");
      this.list.splice(drop === -1 ? 0 : drop, 1);
    }
  }
}

// ---- The compact live feed: which entries are on screen now ----

/** How long (ticks, 10 per second) a row stays on the live feed. Important ones linger. */
export const FEED_LIFETIME_TICKS: Record<MatchEventSeverity, number> = {
  critical: 200,
  major: 120,
  normal: 70,
};

/** The last part of a row's life, in which it fades out. */
export const FEED_FADE_TICKS = 15;

/** Rows on the live feed at most (the full log has the rest). */
export const FEED_MAX_ROWS = 6;

export type FeedDetail = "major" | "all";

export interface FeedRow {
  entry: MatchLogEntry;
  /** 1 while fully shown, falling to 0 as the row fades out. */
  opacity: number;
}

export interface FeedOptions {
  detail: FeedDetail;
  /**
   * Whether a person is involved in an ordinary event. In "all" mode the ticker
   * leaves out the ordinary events that only concern tribes and nations
   * (nations allying with each other all game long); the full log keeps them.
   */
  involvesHuman: (event: MatchEvent) => boolean;
  maxRows?: number;
}

/** Whether the live feed shows this entry at all, whatever its age. */
export function feedShows(entry: MatchLogEntry, opts: FeedOptions): boolean {
  const { severity } = entry.event;
  if (severity !== "normal") return true;
  return opts.detail === "all" && opts.involvesHuman(entry.event);
}

/**
 * The rows to draw at `nowTick`, newest first: entries young enough for their
 * severity, filtered by the detail setting. When more than fit, the oldest of
 * the least important go first, so a flurry of small events can never push a
 * critical one off the feed while it is still fresh.
 */
export function liveFeedRows(
  log: MatchEventLog,
  nowTick: number,
  opts: FeedOptions,
): FeedRow[] {
  const maxRows = opts.maxRows ?? FEED_MAX_ROWS;
  const rows: FeedRow[] = [];
  for (const entry of log.entries()) {
    if (!feedShows(entry, opts)) continue;
    const age = nowTick - entry.lastTick;
    const life = FEED_LIFETIME_TICKS[entry.event.severity];
    if (age < 0 || age >= life) continue;
    const left = life - age;
    rows.push({
      entry,
      opacity:
        left >= FEED_FADE_TICKS ? 1 : Math.max(0, left / FEED_FADE_TICKS),
    });
  }
  while (rows.length > maxRows) {
    let victim = 0;
    for (let i = 1; i < rows.length; i++) {
      const a = SEVERITY_RANK[rows[i].entry.event.severity];
      const b = SEVERITY_RANK[rows[victim].entry.event.severity];
      // Lowest severity first, the oldest among equals (rows are oldest first).
      if (a < b) victim = i;
    }
    rows.splice(victim, 1);
  }
  return rows.reverse();
}
