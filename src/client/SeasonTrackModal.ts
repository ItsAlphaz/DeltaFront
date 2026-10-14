import type { ProgressionMe } from "@openfront/shared/ApiSchemas";
import { html, TemplateResult } from "lit";
import { customElement, state } from "lit/decorators.js";
import { claimAllRewards, claimReward, invalidateUserMe } from "./Api";
import { BaseModal } from "./components/BaseModal";
import "./components/CreditsIcon";
import { compactDuration } from "./components/ProgressionPanel";
import { modalHeader } from "./components/ui/ModalHeader";
import { formatXp, xpBar } from "./components/XpBar";
import { titleText } from "./Progression";
import { fetchProgressionMe } from "./ProgressionApi";
import { translateText } from "./Utils";

/**
 * The free season track (#modal=season): levels 5 to 50 of the running season,
 * what each gives, and a Claim button for the Credits a level has unlocked.
 * No paid track. Everything shown comes from GET /progression/me; a claim is
 * the same reward claim the rest of the game uses.
 */
@customElement("season-track-modal")
export class SeasonTrackModal extends BaseModal {
  protected routerName = "season";

  @state() private me: ProgressionMe | null = null;
  @state() private status: "loading" | "ready" | "failed" = "loading";
  @state() private claiming = false;

  protected modalConfig() {
    return {};
  }

  protected renderHeaderSlot() {
    return modalHeader({
      title: translateText("progression.season_track"),
      onBack: () => this.close(),
      ariaLabel: translateText("common.back"),
    });
  }

  protected onOpen(): void {
    void this.load();
  }

  private async load(): Promise<void> {
    this.status = "loading";
    const me = await fetchProgressionMe();
    if (me === false) {
      this.status = "failed";
      return;
    }
    this.me = me;
    this.status = "ready";
  }

  private async claim(rewardId: string | null): Promise<void> {
    if (this.claiming) return;
    this.claiming = true;
    try {
      if (rewardId === null) await claimAllRewards();
      else await claimReward(rewardId);
      invalidateUserMe();
      await this.load();
    } finally {
      this.claiming = false;
    }
  }

  protected renderBody(): TemplateResult {
    if (this.status === "loading") {
      return html`<p class="p-6 text-df-text-muted">
        ${translateText("progression.loading")}
      </p>`;
    }
    const me = this.me;
    if (this.status === "failed" || me === null) {
      return html`<p class="p-6 text-df-text-muted" data-season-failed>
        ${translateText("progression.load_failed")}
      </p>`;
    }
    const season = me.season;
    if (season === null) {
      return html`<p class="p-6 text-df-text-muted" data-season-none>
        ${translateText("progression.no_season")}
      </p>`;
    }
    const maxed = season.level >= season.maxLevel;
    const into = season.xp % season.xpPerLevel;
    const claimable = me.seasonTrack.filter((t) => t.rewardId !== null);
    return html`<div class="custom-scrollbar mr-1">
      <div class="flex flex-col gap-5 p-6">
        <div data-season-summary class="flex flex-col gap-2">
          <div class="flex flex-wrap items-baseline justify-between gap-2">
            <h2 class="m-0 text-xl font-black uppercase text-white">
              ${season.name}
            </h2>
            <span class="text-xs text-white/50"
              >${translateText("progression.season_ends_in", {
                time: compactDuration(Date.parse(season.endsAt) - Date.now()),
              })}</span
            >
          </div>
          <div class="text-sm text-white/80">
            ${translateText("progression.season_level", {
              level: season.level,
            })}
            <span class="text-white/50">· ${formatXp(season.xp)} XP</span>
          </div>
          ${xpBar(maxed ? 100 : (into / season.xpPerLevel) * 100)}
        </div>
        ${claimable.length > 1
          ? html`<button
              type="button"
              data-season-claim-all
              class="df-btn self-start"
              ?disabled=${this.claiming}
              @click=${() => void this.claim(null)}
            >
              ${translateText("progression.claim_all")}
            </button>`
          : null}
        <ul
          data-season-track
          class="m-0 grid list-none grid-cols-1 gap-2 p-0 sm:grid-cols-2"
        >
          ${me.seasonTrack.map(
            (entry) =>
              html`<li
                data-season-level=${entry.level}
                data-state=${entry.claimed
                  ? "claimed"
                  : entry.unlocked
                    ? "unlocked"
                    : "locked"}
                class="flex items-center justify-between gap-3 rounded-lg border px-3 py-2 ${entry.unlocked
                  ? "border-yellow-400/40 bg-yellow-400/5"
                  : "border-white/10 bg-black/20 opacity-70"}"
              >
                <div class="min-w-0">
                  <div class="text-sm font-bold text-white">
                    ${translateText("progression.level", {
                      level: entry.level,
                    })}
                  </div>
                  <div class="truncate text-xs text-white/60">
                    ${formatXp(entry.credits)}
                    ${translateText("progression.credits")}${entry.title ===
                    null
                      ? ""
                      : html` ·
                        ${titleText(
                          `season_${entry.title}:${season.number}`,
                          translateText,
                        )}`}${entry.flare === null
                      ? ""
                      : html` · ${translateText("progression.track_cosmetic")}`}
                  </div>
                </div>
                ${entry.rewardId !== null
                  ? html`<button
                      type="button"
                      data-season-claim=${entry.rewardId}
                      class="df-btn shrink-0 text-xs"
                      ?disabled=${this.claiming}
                      @click=${() => void this.claim(entry.rewardId)}
                    >
                      ${translateText("progression.claim")}
                    </button>`
                  : html`<span class="shrink-0 text-xs text-white/50"
                      >${entry.claimed
                        ? translateText("progression.claimed")
                        : entry.unlocked
                          ? ""
                          : translateText("progression.locked")}</span
                    >`}
              </li>`,
          )}
        </ul>
      </div>
    </div>`;
  }
}
