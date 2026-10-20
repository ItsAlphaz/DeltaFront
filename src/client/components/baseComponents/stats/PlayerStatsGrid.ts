import { LitElement, html } from "lit";
import { customElement, property } from "lit/decorators.js";

@customElement("player-stats-grid")
export class PlayerStatsGrid extends LitElement {
  createRenderRoot() {
    return this;
  }

  @property({ type: Array }) titles: string[] = [];
  @property({ type: Array }) values: Array<string | number> = [];

  // Currently fixed to display 4 stats (can be changed if needed)
  private readonly VISIBLE_STATS_COUNT = 4;

  render() {
    return html`
      <div class="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-2">
        ${Array(this.VISIBLE_STATS_COUNT)
          .fill(0)
          .map(
            (_, i) => html`
              <div
                class="flex flex-col items-center justify-center p-4 rounded-xl bg-ui-surface border border-ui-border hover:bg-white/10 transition-colors"
              >
                <div class="text-2xl font-bold text-ui-text mb-1">
                  ${this.values[i] ?? ""}
                </div>
                <div
                  class="text-ui-muted text-xs font-bold uppercase tracking-[0.1em]"
                >
                  ${this.titles[i] ?? ""}
                </div>
              </div>
            `,
          )}
      </div>
    `;
  }
}
