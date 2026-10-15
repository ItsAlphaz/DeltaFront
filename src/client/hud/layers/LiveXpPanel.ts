import { GameType } from "@openfront/engine-api/game/GameTypes";
import { GameUpdateType } from "@openfront/engine-api/game/GameUpdates";
import type { LiveXpResponse } from "@openfront/shared/ApiSchemas";
import { EventBus } from "@openfront/shared/EventBus";
import { html, LitElement, nothing } from "lit";
import { customElement, state } from "lit/decorators.js";
import "../../components/LiveXpCard";
import { effectiveStatus } from "../../components/LiveXpCard";
import { Controller } from "../../Controller";
import { rememberPendingXp } from "../../PendingXpStore";
import { resolveXpAccount } from "../../ProgressionAccount";
import { fetchLiveXp, LIVE_XP_POLL_MS } from "../../ProgressionApi";
import { translateText } from "../../Utils";
import { GameView } from "../../view";

/**
 * The player's XP in the game they are playing, in a corner of the HUD: "Match
 * XP +150", and for someone eliminated who is still there "150 XP pending". It
 * opens to the lines behind it (participation, eliminations, the multiplier) and
 * what is still to be decided.
 *
 * Nothing here is worked out on the client. The account API computes the
 * number from what the game server reports, with the rules that decide the final
 * award, and this panel only reads it. No kills, victory, placement or
 * multiplier is ever taken from the player's own screen: the one thing the
 * client contributes is whether it is itself still alive, which only changes
 * the wording (a death is seen at once; the server's report follows).
 *
 * A game with nothing to show (singleplayer, a replay, a spectator, a guest,
 * progression off, a game that pays nothing) draws nothing.
 */
@customElement("live-xp-panel")
export class LiveXpPanel extends LitElement implements Controller {
  public game!: GameView;
  public eventBus!: EventBus;

  @state() private data: LiveXpResponse | null = null;
  @state() private open = false;
  @state() private alive: boolean | null = null;
  // Gone once the game ends: the end-of-game panel takes over.
  @state() private finished = false;

  // Replaceable for tests.
  load: typeof fetchLiveXp = fetchLiveXp;
  account: typeof resolveXpAccount = resolveXpAccount;
  now: () => number = Date.now;

  // Decided on the first tick that can: null until then.
  private enabled: boolean | null = null;
  private deciding = false;
  private polling = false;
  private lastPoll = Number.NEGATIVE_INFINITY;

  createRenderRoot() {
    return this;
  }

  /** The tick need not run more than once a second: the report is slower than that. */
  getTickIntervalMs(): number {
    return 1_000;
  }

  tick(): void {
    if (this.finished || this.enabled === false) return;
    const game = this.game;
    const config = game.config();
    if (
      config.isReplay() ||
      config.gameConfig().gameType === GameType.Singleplayer
    ) {
      this.enabled = false;
      return;
    }
    const wins = game.updatesSinceLastTick()?.[GameUpdateType.Win] ?? [];
    if (wins.length > 0) {
      this.finished = true;
      return;
    }
    const me = game.myPlayer();
    // A spectator has no XP of their own; before spawning there is nothing yet.
    if (!me || !me.hasSpawned()) return;
    const alive = me.isAlive();
    if (alive !== this.alive) this.alive = alive;
    if (this.enabled === null) {
      void this.decide();
      return;
    }
    if (this.polling || this.now() - this.lastPoll < LIVE_XP_POLL_MS) return;
    void this.poll();
  }

  // Whether this player is signed in with progression on, once.
  private async decide(): Promise<void> {
    if (this.deciding) return;
    this.deciding = true;
    try {
      const account = await this.account();
      this.enabled =
        account.kind === "signed_in" &&
        account.me.player.progress !== undefined;
    } catch {
      this.enabled = false;
    } finally {
      this.deciding = false;
    }
  }

  private async poll(): Promise<void> {
    this.polling = true;
    this.lastPoll = this.now();
    try {
      const result = await this.load(this.game.gameID());
      if (result.status === "unavailable") {
        this.enabled = false;
        this.data = null;
        return;
      }
      if (result.status === "ok") {
        this.data = result.data;
        // XP is at stake: remember the game so its result can be told later
        // even if the player leaves before it is stored.
        if (
          result.data.status !== "none" &&
          result.data.status !== "forfeited"
        ) {
          rememberPendingXp(this.game.gameID());
        }
      }
    } finally {
      this.polling = false;
    }
  }

  private toggle = (): void => {
    this.open = !this.open;
  };

  render() {
    const data = this.data;
    if (this.finished || data === null || data.status === "none") {
      return nothing;
    }
    const status = effectiveStatus(data, this.alive);
    return html`<div
      data-live-xp-panel
      data-live-status=${status}
      class="pointer-events-auto mr-2 mt-1 w-64 rounded-md border border-white/15 bg-black/65 px-3 py-2 backdrop-blur-sm"
    >
      <button
        type="button"
        class="block w-full cursor-pointer border-0 bg-transparent p-0 text-left"
        aria-expanded=${this.open ? "true" : "false"}
        aria-label=${translateText(
          this.open ? "progression.live_collapse" : "progression.live_expand",
        )}
        @click=${this.toggle}
      >
        <live-xp-card
          .data=${data}
          .playerAlive=${this.alive}
          ?summary=${!this.open}
        ></live-xp-card>
      </button>
    </div>`;
  }
}
