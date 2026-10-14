import {
  MATCH_EVENT_CATEGORIES,
  type MatchEventCategory,
} from "@openfront/engine-api/game/MatchEvents";
import { EventBus } from "@openfront/shared/EventBus";
import { html, LitElement, nothing } from "lit";
import { customElement, state } from "lit/decorators.js";
import { Controller } from "../../Controller";
import {
  matchEventIcon,
  repeatBadge,
  sentence,
} from "../../matchevents/MatchEventLine";
import type { MatchLogEntry } from "../../matchevents/MatchEventLog";
import {
  describeEvent,
  type DescribedEvent,
} from "../../matchevents/MatchEventText";
import { GoToPlayerEvent } from "../../TransformHandler";
import { translateText } from "../../Utils";
import { GameView, PlayerView } from "../../view";

/** Opens (or, with `visible: false`, closes) the full match event log. */
export class ShowMatchEventLogEvent {
  constructor(public readonly visible: boolean = true) {}
}

type Filter = MatchEventCategory | "all";
const FILTERS: readonly Filter[] = ["all", ...MATCH_EVENT_CATEGORIES];

const ACCENT: Record<
  DescribedEvent["severity"],
  { border: string; icon: string }
> = {
  critical: { border: "border-df-red-bright", icon: "text-df-red-bright" },
  major: { border: "border-df-red-dark", icon: "text-df-red" },
  normal: { border: "border-white/15", icon: "text-df-text-secondary" },
};

const pad = (n: number) => (n < 10 ? `0${n}` : String(n));

/** Game clock, "m:ss" (or "h:mm:ss"), from the tick the match began on. */
export function clockLabel(tick: number, startTick: number): string {
  const seconds = Math.max(0, Math.floor((tick - startTick) / 10));
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/**
 * The full match event log: everything that happened this match, newest first,
 * with filters (All, Combat, Diplomacy, Territory, System). It reads the same
 * structured log as the live feed (MatchEventLog), so the two cannot disagree.
 * A line with a player in it takes the camera there.
 */
@customElement("match-event-log-modal")
export class MatchEventLogModal extends LitElement implements Controller {
  public game: GameView;
  public eventBus: EventBus;

  @state() private open = false;
  @state() private filter: Filter = "all";
  private unsubscribe: (() => void) | null = null;

  createRenderRoot() {
    return this;
  }

  init() {
    this.eventBus.on(ShowMatchEventLogEvent, (e) => {
      if (e.visible) this.show();
      else this.hide();
    });
  }

  connectedCallback() {
    super.connectedCallback();
    window.addEventListener("keydown", this.onKeyDown);
  }

  disconnectedCallback() {
    window.removeEventListener("keydown", this.onKeyDown);
    this.unsubscribe?.();
    this.unsubscribe = null;
    super.disconnectedCallback();
  }

  private onKeyDown = (e: KeyboardEvent) => {
    if (this.open && e.key === "Escape") this.hide();
  };

  show() {
    if (this.open) return;
    this.open = true;
    // New events appear in the list while it is open.
    this.unsubscribe = this.game
      .matchEvents()
      .subscribe(() => this.requestUpdate());
  }

  updated(changed: Map<string, unknown>) {
    // A dialog takes focus when it opens (and gives it back to the page by closing).
    if (changed.has("open") && this.open) {
      this.querySelector<HTMLButtonElement>("header button")?.focus();
    }
  }

  hide() {
    this.open = false;
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  private goTo(desc: DescribedEvent) {
    const id = desc.slots.target?.id ?? desc.slots.actor?.id;
    if (id === undefined) return;
    const player = this.game.playerBySmallID(id);
    if (!player.isPlayer()) return;
    this.eventBus.emit(new GoToPlayerEvent(player as PlayerView));
    this.hide();
  }

  render() {
    if (!this.open || this.game === undefined) return nothing;
    const log = this.game.matchEvents();
    const startTick =
      log.entries().find((e) => e.event.type === "game_started")?.event.tick ??
      0;
    // Newest first.
    const entries = log.filtered(this.filter).reverse();
    return html`
      <div
        class="fixed inset-0 z-[1100] flex items-center justify-center bg-black/60 p-4"
        @click=${(e: Event) => {
          if (e.target === e.currentTarget) this.hide();
        }}
      >
        <section
          class="flex flex-col w-[min(34rem,100%)] max-h-[80vh] rounded-lg border border-df-border border-t-2 border-t-df-red bg-df-bg-secondary text-df-text shadow-2xl"
          role="dialog"
          aria-modal="true"
          aria-label=${translateText("match_events.log_title")}
          data-match-event-log
        >
          <header
            class="flex items-center justify-between gap-3 px-4 py-3 border-b border-df-border"
          >
            <div class="min-w-0">
              <h2 class="text-sm font-bold uppercase tracking-wider">
                ${translateText("match_events.log_title")}
              </h2>
              <p class="text-xs text-df-text-muted">
                ${translateText("match_events.log_count", {
                  count: log.size(),
                })}
              </p>
            </div>
            <button
              class="df-btn px-2 py-1 text-xs"
              @click=${() => this.hide()}
              aria-label=${translateText("match_events.log_close")}
            >
              ${translateText("match_events.log_close")}
            </button>
          </header>
          <div
            class="flex flex-wrap gap-1 px-4 py-2 border-b border-df-border"
            role="tablist"
          >
            ${FILTERS.map(
              (f) =>
                html`<button
                  role="tab"
                  aria-selected=${this.filter === f}
                  data-filter=${f}
                  class="px-2.5 py-1 rounded text-xs font-semibold border transition-colors ${this
                    .filter === f
                    ? "bg-df-red border-df-red text-white"
                    : "bg-transparent border-df-border text-df-text-secondary hover:text-white hover:border-df-red-dark"}"
                  @click=${() => {
                    this.filter = f;
                  }}
                >
                  ${translateText(`match_events.filter_${f}`)}
                </button>`,
            )}
          </div>
          <ol class="overflow-y-auto px-3 py-2 flex flex-col gap-1">
            ${entries.length === 0
              ? html`<li
                  class="px-1 py-6 text-center text-sm text-df-text-muted"
                >
                  ${translateText("match_events.log_empty")}
                </li>`
              : entries.map((entry) => this.renderEntry(entry, startTick))}
          </ol>
        </section>
      </div>
    `;
  }

  private renderEntry(entry: MatchLogEntry, startTick: number) {
    const desc = describeEvent(entry, this.game, translateText);
    const accent = ACCENT[desc.severity];
    const hasPlayer =
      desc.slots.target !== undefined || desc.slots.actor !== undefined;
    return html`<li
      class="flex items-start gap-2 rounded-sm border-l-2 ${accent.border} bg-black/40 pl-2 pr-2 py-1.5 text-[13px] ${hasPlayer
        ? "cursor-pointer hover:bg-white/5"
        : ""}"
      data-severity=${desc.severity}
      data-event-type=${entry.event.type}
      tabindex=${hasPlayer ? 0 : nothing}
      @click=${() => this.goTo(desc)}
      @keydown=${(e: KeyboardEvent) => {
        if (e.key === "Enter") this.goTo(desc);
      }}
    >
      <span class="font-mono text-xs text-df-text-muted w-12 shrink-0"
        >${clockLabel(entry.lastTick, startTick)}</span
      >
      <span class=${accent.icon}>${matchEventIcon(desc.icon)}</span>
      <span class="min-w-0 flex-1 break-words">${sentence(desc)}</span>
      ${repeatBadge(desc)}
    </li>`;
  }
}
