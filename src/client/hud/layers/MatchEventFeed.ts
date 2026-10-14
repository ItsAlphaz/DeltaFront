import { EventBus } from "@openfront/shared/EventBus";
import { html, LitElement } from "lit";
import { customElement, state } from "lit/decorators.js";
import { repeat } from "lit/directives/repeat.js";
import { Controller } from "../../Controller";
import {
  matchEventIcon,
  repeatBadge,
  sentence,
} from "../../matchevents/MatchEventLine";
import {
  liveFeedRows,
  severityRank,
  type FeedRow,
} from "../../matchevents/MatchEventLog";
import {
  describeEvent,
  involvesHuman,
  type DescribedEvent,
} from "../../matchevents/MatchEventText";
import { PlaySoundEffectEvent } from "../../sound/Sounds";
import { USER_SETTINGS_CHANGED_EVENT, UserSettings } from "../../UserSettings";
import { translateText } from "../../Utils";
import { GameView } from "../../view";

/** Ticks a cue is held back after the last one, so a flurry is one sound. */
const SOUND_COOLDOWN_TICKS = 30;
/** Only events this fresh are worth a cue (not the backlog of a catch-up). */
const SOUND_FRESH_TICKS = 3;

const ACCENT: Record<
  DescribedEvent["severity"],
  { border: string; icon: string }
> = {
  critical: {
    border: "border-df-red-bright shadow-[0_0_0_1px_rgba(227,27,35,0.35)]",
    icon: "text-df-red-bright",
  },
  major: { border: "border-df-red-dark", icon: "text-df-red" },
  normal: { border: "border-white/20", icon: "text-df-text-secondary" },
};

/**
 * The live match-event ticker: a few compact lines in the upper right of the
 * game ("[DELTA] Alphaz eliminated RedFox", "Alphaz became the largest
 * nation"), newest on top, fading out as they age; critical ones stay longer.
 *
 * It only draws what the match event log holds (see MatchEventLog); the
 * engine decides what happened, and names, clans and badges are looked up as
 * the line is drawn, so Anonymous Names applies to it like to everything else.
 */
@customElement("match-event-feed")
export class MatchEventFeed extends LitElement implements Controller {
  public game: GameView;
  public eventBus: EventBus;

  private settings = new UserSettings();
  @state() private rows: FeedRow[] = [];
  private signature = "";
  private lastSoundTick = -Infinity;
  private soundedCounts = new Map<number, number>();

  createRenderRoot() {
    return this;
  }

  private onSettingChanged = () => {
    this.signature = "";
    this.requestUpdate();
  };

  connectedCallback() {
    super.connectedCallback();
    // A name that was real a moment ago must not stay on screen after the
    // player turns Anonymous Names on, and the feed can be switched off live.
    for (const key of ["anonymousNames", "eventFeed", "eventFeedDetail"]) {
      window.addEventListener(
        `${USER_SETTINGS_CHANGED_EVENT}:settings.${key}`,
        this.onSettingChanged,
      );
    }
  }

  disconnectedCallback() {
    for (const key of ["anonymousNames", "eventFeed", "eventFeedDetail"]) {
      window.removeEventListener(
        `${USER_SETTINGS_CHANGED_EVENT}:settings.${key}`,
        this.onSettingChanged,
      );
    }
    super.disconnectedCallback();
  }

  tick() {
    if (this.game === undefined) return;
    if (!this.settings.eventFeed()) {
      if (this.rows.length > 0) this.rows = [];
      this.signature = "";
      return;
    }
    // Replaying a backlog (joining late, a long catch-up) would flicker rows
    // that are about to be too old; the feed picks up once it is current.
    if (this.game.isCatchingUp()) return;

    const log = this.game.matchEvents();
    const now = this.game.ticks();
    const rows = liveFeedRows(log, now, {
      detail: this.settings.eventFeedDetail(),
      involvesHuman: (e) => involvesHuman(e, this.game),
    });
    this.playSounds(now);

    const signature = rows
      .map((r) => `${r.entry.id}:${r.entry.count}:${r.opacity.toFixed(1)}`)
      .join("|");
    if (signature === this.signature) return;
    this.signature = signature;
    this.rows = rows;
  }

  /** A quiet cue for what just happened to someone else (the player's own events have theirs). */
  private playSounds(now: number) {
    if (!this.settings.eventFeedSound()) return;
    const me = this.game.myPlayer()?.smallID();
    const log = this.game.matchEvents();
    const entries = log.entries();
    for (let i = entries.length - 1; i >= 0; i--) {
      const entry = entries[i];
      if (now - entry.lastTick > SOUND_FRESH_TICKS) break;
      if ((this.soundedCounts.get(entry.id) ?? 0) >= entry.count) continue;
      this.soundedCounts.set(entry.id, entry.count);
      const e = entry.event;
      const cue =
        e.type === "alliance_broken" && e.meta.cause === "broken"
          ? "alliance-broken"
          : severityRank(e.severity) >= severityRank("critical")
            ? "message"
            : null;
      if (cue === null || e.actor === me || e.target === me) continue;
      if (now - this.lastSoundTick < SOUND_COOLDOWN_TICKS) continue;
      this.lastSoundTick = now;
      this.eventBus.emit(new PlaySoundEffectEvent(cue));
    }
    if (this.soundedCounts.size > 400) this.soundedCounts.clear();
  }

  render() {
    if (this.rows.length === 0 || !this.settings.eventFeed()) return html``;
    return html`
      <style>
        @keyframes match-feed-in {
          from {
            opacity: 0;
            transform: translateX(10px);
          }
        }
        .match-feed-row {
          animation: match-feed-in 160ms ease-out;
          transition: opacity 0.5s linear;
        }
        @media (prefers-reduced-motion: reduce) {
          .match-feed-row {
            animation: none;
            transition: none;
          }
        }
      </style>
      <div
        class="flex flex-col items-end gap-1 pointer-events-none select-none w-[min(24rem,calc(100vw-1rem))] pr-2 max-sm:[&>.match-feed-row:nth-child(n+5)]:hidden"
        role="log"
        aria-label=${translateText("match_events.feed_label")}
      >
        ${repeat(
          this.rows,
          (r) => r.entry.id,
          (r) => this.renderRow(r),
        )}
      </div>
    `;
  }

  private renderRow(row: FeedRow) {
    const desc = describeEvent(row.entry, this.game, translateText);
    const accent = ACCENT[desc.severity];
    return html`
      <div
        class="match-feed-row flex items-start gap-1.5 w-full rounded-sm border-l-2 ${accent.border} bg-black/80 backdrop-blur-sm pl-1.5 pr-2 py-1 text-[12px] leading-tight text-df-text shadow-md"
        style="opacity:${row.opacity}"
        data-severity=${desc.severity}
        data-event-type=${row.entry.event.type}
        data-event-id=${row.entry.id}
      >
        <span
          class="${accent.icon} mt-px ${desc.severity === "critical"
            ? "drop-shadow-[0_0_3px_rgba(255,37,45,0.7)]"
            : ""}"
          >${matchEventIcon(desc.icon)}</span
        >
        <span class="min-w-0 flex-1 break-words leading-snug"
          >${sentence(desc)}</span
        >
        ${repeatBadge(desc)}
      </div>
    `;
  }
}
