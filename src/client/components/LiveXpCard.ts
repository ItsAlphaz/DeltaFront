import type {
  LiveXpResponse,
  LiveXpStatus,
} from "@openfront/shared/ApiSchemas";
import { html, LitElement, nothing, PropertyValues, TemplateResult } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { keyed } from "lit/directives/keyed.js";
import {
  visibleMultipliers,
  visibleXpLines,
  XP_LINE_LABEL_KEYS,
} from "../Progression";
import { translateText } from "../Utils";
import { countUp } from "../utilities/CountUp";
import { formatXp, xpBonusText } from "./XpBar";

/**
 * A running game's XP, as the account API works it out from what the game
 * server reports: the same lines as the end-of-game panel (participation,
 * eliminations, the multipliers), and what still has to be decided. A preview:
 * it only draws, and every number was worked out by the server. Only the
 * stored game awards XP, once.
 *
 *   live       playing: "Match XP +150"
 *   pending    eliminated and still there: "150 XP pending" until the result
 *   settled    the result is in: the XP is being finalized
 *   forfeited  left before the result: nothing to receive
 *
 * The figure eases to each new value and pops when it grows; both stop under
 * reduced motion.
 */

const HEADING_KEYS: Record<LiveXpStatus, string> = {
  live: "progression.live_title",
  pending: "progression.live_pending_title",
  settled: "progression.live_settled_title",
  forfeited: "progression.live_forfeited_title",
  none: "progression.live_title",
};

/** The status as the player's own game state says it: a live reading for someone already out is pending. */
export function effectiveStatus(
  data: LiveXpResponse,
  playerAlive: boolean | null,
): LiveXpStatus {
  if (data.status === "live" && playerAlive === false) return "pending";
  return data.status;
}

@customElement("live-xp-card")
export class LiveXpCard extends LitElement {
  @property({ attribute: false }) data: LiveXpResponse | null = null;
  // The player's own view of whether they are still in it (their simulation
  // knows at once; the server's report can be a few seconds behind).
  @property({ attribute: false }) playerAlive: boolean | null = null;
  // Only the heading and the figure: for a collapsed panel.
  @property({ type: Boolean }) summary = false;

  // What the figure shows now (it eases towards `data.total`) and a counter
  // that restarts its pop.
  @state() private shown = 0;
  @state() private bump = 0;
  private shownTarget = -1;
  private stop: (() => void) | null = null;

  createRenderRoot() {
    return this;
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    this.stop?.();
    this.stop = null;
  }

  protected willUpdate(changed: PropertyValues<this>): void {
    super.willUpdate(changed);
    const total = this.data?.total ?? 0;
    if (total === this.shownTarget) return;
    const grew = this.shownTarget >= 0 && total > this.shownTarget;
    const from = this.shownTarget < 0 ? 0 : this.shown;
    this.shownTarget = total;
    this.stop?.();
    this.stop = countUp(
      total,
      (value) => {
        this.shown = value;
      },
      grew ? 700 : 900,
      from,
    );
    if (grew) this.bump += 1;
  }

  private renderLines(data: LiveXpResponse): TemplateResult | typeof nothing {
    const breakdown = data.breakdown;
    if (breakdown === null) return nothing;
    const lines = visibleXpLines(breakdown);
    const multipliers = visibleMultipliers(breakdown);
    if (lines.length === 0 && multipliers.length === 0) return nothing;
    return html`<ul
      data-live-xp-lines
      class="m-0 flex list-none flex-col gap-1 p-0 text-sm"
    >
      ${lines.map(
        (line) =>
          html`<li
            data-live-xp-line=${line.key}
            class="flex items-baseline justify-between gap-3"
          >
            <span class="min-w-0 text-white/70"
              >${line.key === "eliminations" && breakdown.eliminationCount > 0
                ? translateText("progression.live_eliminations", {
                    count: breakdown.eliminationCount,
                  })
                : translateText(XP_LINE_LABEL_KEYS[line.key])}</span
            >
            <span
              class="shrink-0 whitespace-nowrap font-bold tabular-nums text-yellow-300"
              >${translateText("progression.xp_total", {
                xp: formatXp(line.amount),
              })}</span
            >
          </li>`,
      )}
      ${multipliers.map(
        (m) =>
          html`<li
            data-live-xp-multiplier=${m.key}
            class="text-xs font-bold uppercase tracking-wider text-white/50"
          >
            ${xpBonusText(m.key, m.permille)}
          </li>`,
      )}
    </ul>`;
  }

  private note(data: LiveXpResponse, status: LiveXpStatus): string | null {
    switch (status) {
      case "pending":
        return translateText("progression.live_pending_note");
      case "settled":
        return translateText(
          data.winner
            ? "progression.live_winner_note"
            : "progression.live_settled_note",
        );
      case "forfeited":
        return translateText("progression.live_forfeited_note");
      case "live":
        if (
          data.pending.includes("placement") ||
          data.pending.includes("victory")
        ) {
          return translateText("progression.live_note_result");
        }
        return null;
      case "none":
        return null;
    }
  }

  render() {
    const data = this.data;
    if (data === null || data.status === "none") return nothing;
    const status = effectiveStatus(data, this.playerAlive);
    const forfeited = status === "forfeited";
    const figure = forfeited
      ? html`<span data-live-xp-total class="text-white/40 line-through"
          >${translateText("progression.xp_total", { xp: "0" })}</span
        >`
      : status === "pending"
        ? html`<span data-live-xp-total class="text-yellow-300"
            >${translateText("progression.live_pending_amount", {
              xp: formatXp(this.shown),
            })}</span
          >`
        : html`<span data-live-xp-total class="text-yellow-300"
            >${keyed(
              this.bump,
              html`<span class=${this.bump > 0 ? "df-xp-pop" : "inline-block"}
                >${translateText("progression.xp_total", {
                  xp: formatXp(this.shown),
                })}</span
              >`,
            )}</span
          >`;
    const note = this.note(data, status);
    return html`<section
      data-live-xp
      data-live-status=${status}
      data-live-mode=${data.mode ?? nothing}
      class="flex flex-col gap-2 text-white"
    >
      <div
        class="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1"
      >
        <span
          data-live-xp-title
          class="font-display text-xs font-bold uppercase tracking-[0.2em] text-white/60"
          >${translateText(HEADING_KEYS[status])}</span
        >
        <span
          class="ml-auto whitespace-nowrap text-xl font-black tabular-nums leading-none"
          >${figure}</span
        >
      </div>
      ${forfeited || this.summary ? nothing : this.renderLines(data)}
      ${data.mode === "reduced" && !forfeited && !this.summary
        ? html`<p data-live-xp-reduced class="m-0 text-xs text-white/50">
            ${translateText("progression.live_reduced_note")}
          </p>`
        : nothing}
      ${note === null || this.summary
        ? nothing
        : html`<p data-live-xp-note class="m-0 text-xs text-white/60">
            ${note}
          </p>`}
    </section>`;
  }
}
