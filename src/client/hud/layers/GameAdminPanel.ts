import type { AdminCommand } from "@openfront/engine-api/AdminCommands";
import { GameType, PlayerType } from "@openfront/engine-api/game/GameTypes";
import { renderNumber } from "@openfront/engine-lib/Format";
import type { EventBus } from "@openfront/shared/EventBus";
import {
  hasPermission,
  staffRoleOf,
  type Permission,
} from "@openfront/shared/Permissions";
import { html, LitElement, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { staffBadge, staffRoleLabel } from "../../components/ui/StaffBadge";
import { verifiedBadge } from "../../components/ui/VerifiedBadge";
import type { Controller } from "../../Controller";
import { currentBuildLabel } from "../../GameVersion";
import { showInGameConfirm } from "../../InGameModal";
import { SendKickPlayerIntentEvent } from "../../LobbyEvents";
import { GoToPlayerEvent } from "../../TransformHandler";
import {
  PauseGameIntentEvent,
  SendAdminCommandIntentEvent,
} from "../../Transport";
import { translateText } from "../../Utils";
import type { GameView, PlayerView } from "../../view";

// Engine troop counts are stored x10 (renderTroops divides by 10); the panel
// speaks in the numbers the HUD shows.
const TROOP_SCALE = 10;
// What "refill" sets a gold balance to.
const REFILL_GOLD = 1_000_000_000;

const t = (key: string, vars?: Record<string, string | number>) =>
  translateText(`game_admin.${key}`, vars);

type Tab = "players" | "game" | "tools";

interface Row {
  view: PlayerView;
  id: string;
  name: string;
  kind: "human" | "nation" | "bot";
  alive: boolean;
  gold: bigint;
  troops: number;
  tiles: number;
}

/**
 * The in-game admin panel for staff: look at every player, move the camera,
 * kick, eliminate, change resources, pause, or force a winner.
 *
 * It is only a way to ask. Each action is an ordinary intent that the game
 * server relays ONLY if the sender's account holds the matching permission
 * (src/server/IntentAuthorization.ts), so a panel opened by someone who is not
 * staff, or a hand-built message, does nothing. Commands that change state are
 * refused in public and listed games unless the sender is the owner; a game that
 * received one is marked admin-modified and never counts for stats, Credits or the leaderboard.
 *
 * What is drawn follows the role, from the same permission table the server
 * uses (@openfront/shared/Permissions).
 */
@customElement("game-admin-panel")
export class GameAdminPanel extends LitElement implements Controller {
  @property({ attribute: false }) public game: GameView | null = null;
  @property({ attribute: false }) public eventBus: EventBus | null = null;
  @property({ attribute: false }) public role: string | null = null;

  @state() private open = false;
  @state() private tab: Tab = "players";
  @state() private rows: Row[] = [];
  @state() private selectedId: string | null = null;
  @state() private amount = "1000";
  @state() private adminModified = false;
  @state() private last = "";

  private onKey = (e: KeyboardEvent) => {
    // The backquote key toggles the panel, unless a text field has focus.
    if (e.code !== "Backquote" || !this.canUse("game.admin.panel")) return;
    const target = e.target as HTMLElement | null;
    if (
      target !== null &&
      (target.tagName === "INPUT" ||
        target.tagName === "TEXTAREA" ||
        target.isContentEditable)
    ) {
      return;
    }
    e.preventDefault();
    this.open = !this.open;
    if (this.open) this.refresh();
  };

  createRenderRoot() {
    return this;
  }

  /** Called by the renderer with the role the signed-in token carries. */
  setRole(role: string | null) {
    this.role = role;
  }

  private canUse(permission: Permission): boolean {
    return hasPermission(this.role, permission);
  }

  init() {
    window.addEventListener("keydown", this.onKey);
  }

  disconnectedCallback() {
    window.removeEventListener("keydown", this.onKey);
    super.disconnectedCallback();
  }

  getTickIntervalMs() {
    return 1000;
  }

  tick() {
    if (this.open) this.refresh();
  }

  private refresh() {
    const game = this.game;
    if (game === null) return;
    this.rows = game
      .playerViews()
      .map((view) => ({
        view,
        id: view.id(),
        name: view.displayName(),
        kind:
          view.type() === PlayerType.Human
            ? ("human" as const)
            : view.type() === PlayerType.Nation
              ? ("nation" as const)
              : ("bot" as const),
        alive: view.isAlive(),
        gold: view.gold(),
        troops: view.troops(),
        tiles: view.numTilesOwned(),
      }))
      .sort((a, b) => b.tiles - a.tiles);
  }

  private get selected(): Row | null {
    return this.rows.find((r) => r.id === this.selectedId) ?? null;
  }

  /** A public or listed game: real players recruited from the browser or matchmaker. */
  private get isPublic(): boolean {
    const config = this.game?.config();
    return (
      config?.gameConfig().gameType === GameType.Public ||
      config?.listed === true
    );
  }

  /**
   * Whether commands that change the game may be drawn at all: any game for the
   * owner, private games only for everyone else. The server decides for real
   * (authorizeIntent); this only keeps the panel from offering what it refuses.
   */
  private get commandsAllowed(): boolean {
    return !this.isPublic || this.canUse("game.admin.public");
  }

  private amountValue(): number | null {
    const n = Number(this.amount);
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : null;
  }

  private send(command: AdminCommand, target: PlayerView, amount?: number) {
    this.eventBus?.emit(
      new SendAdminCommandIntentEvent(command, target, amount),
    );
    this.adminModified = true;
    this.last = t("sent", {
      command: t(`cmd_${command}`),
      name: target.displayName(),
    });
  }

  private async confirm(key: string, name: string): Promise<boolean> {
    return showInGameConfirm(t(key, { name }), {
      heading: t("confirm_heading"),
      confirmText: t("confirm_button"),
    });
  }

  private renderPlayers() {
    const sel = this.selected;
    return html`
      <div class="max-h-56 overflow-y-auto border border-white/10 rounded">
        <table class="w-full text-xs">
          <tbody>
            ${this.rows.map(
              (r) =>
                html`<tr
                  class="cursor-pointer hover:bg-white/10 ${r.id ===
                  this.selectedId
                    ? "bg-white/15"
                    : ""} ${r.alive ? "" : "opacity-40"}"
                  @click=${() => (this.selectedId = r.id)}
                >
                  <td class="px-2 py-1">
                    <span class="inline-flex items-center gap-1">
                      ${staffBadge(r.view.staffBadgeRole(), "w-3.5 h-3.5")}
                      ${r.view.showsVerifiedBadge()
                        ? verifiedBadge("w-3.5 h-3.5")
                        : nothing}
                      <span class="truncate max-w-[9rem]">${r.name}</span>
                    </span>
                  </td>
                  <td class="px-1 text-white/50">${t(`kind_${r.kind}`)}</td>
                  <td class="px-1 tabular-nums text-right">
                    ${renderNumber(r.gold)}
                  </td>
                  <td class="px-1 tabular-nums text-right">
                    ${renderNumber(r.troops / TROOP_SCALE)}
                  </td>
                </tr>`,
            )}
          </tbody>
        </table>
      </div>
      ${sel === null
        ? html`<p class="text-xs text-white/50">${t("select_player")}</p>`
        : this.renderSelected(sel)}
    `;
  }

  private btn(
    label: string,
    onClick: () => void,
    danger = false,
    disabled = false,
  ) {
    return html`<button
      type="button"
      class="px-2 py-1 text-xs font-bold uppercase tracking-wide rounded border ${danger
        ? "border-df-red text-df-red-bright bg-black hover:bg-df-red hover:text-white"
        : "border-white/25 text-white bg-white/5 hover:bg-white/15"} disabled:opacity-40 disabled:cursor-not-allowed"
      ?disabled=${disabled}
      @click=${onClick}
    >
      ${label}
    </button>`;
  }

  private renderSelected(sel: Row) {
    const me = this.game?.myPlayer() ?? null;
    const isMe = me !== null && me.id() === sel.id;
    const amount = this.amountValue();
    const commands = this.commandsAllowed;
    return html`
      <div
        class="flex flex-col gap-2 border border-white/10 rounded p-2"
        id="game-admin-selected"
      >
        <div class="text-sm font-bold text-white flex items-center gap-1">
          ${staffBadge(sel.view.staffBadgeRole(), "w-4 h-4")} ${sel.name}
          <span class="text-white/50 text-xs font-normal"
            >${t(`kind_${sel.kind}`)}</span
          >
          ${sel.alive
            ? nothing
            : html`<span class="text-df-red-bright text-xs"
                >${t("dead")}</span
              >`}
        </div>
        <div class="flex flex-wrap gap-1">
          ${this.canUse("game.admin.spectate")
            ? this.btn(t("go_to"), () =>
                this.eventBus?.emit(new GoToPlayerEvent(sel.view)),
              )
            : nothing}
          ${this.canUse("game.admin.kick") && sel.kind === "human" && !isMe
            ? this.btn(
                t("kick"),
                async () => {
                  const id = sel.view.clientID();
                  if (
                    id !== null &&
                    (await this.confirm("confirm_kick", sel.name))
                  ) {
                    this.eventBus?.emit(new SendKickPlayerIntentEvent(id));
                    this.last = t("sent", {
                      command: t("kick"),
                      name: sel.name,
                    });
                  }
                },
                true,
              )
            : nothing}
          ${this.canUse("game.admin.kill") && commands
            ? this.btn(
                t("eliminate"),
                async () => {
                  if (await this.confirm("confirm_eliminate", sel.name)) {
                    this.send("eliminate", sel.view);
                  }
                },
                true,
                !sel.alive,
              )
            : nothing}
          ${this.canUse("game.admin.force_end") && commands
            ? this.btn(
                t("force_win"),
                async () => {
                  if (await this.confirm("confirm_force_win", sel.name)) {
                    this.send("force_win", sel.view);
                  }
                },
                true,
              )
            : nothing}
        </div>
        ${this.canUse("game.admin.resources") && commands
          ? html`<div class="flex flex-col gap-1">
              <label
                class="text-[10px] uppercase tracking-widest text-white/50"
              >
                ${t("amount")}
                <input
                  id="game-admin-amount"
                  class="ml-2 w-28 rounded border border-white/20 bg-black px-2 py-1 text-xs text-white"
                  inputmode="numeric"
                  .value=${this.amount}
                  @input=${(e: Event) =>
                    (this.amount = (e.target as HTMLInputElement).value)}
                />
              </label>
              <div class="flex flex-wrap gap-1">
                ${this.btn(
                  t("gold_give"),
                  () =>
                    amount !== null && this.send("give_gold", sel.view, amount),
                  false,
                  amount === null,
                )}
                ${this.btn(
                  t("gold_take"),
                  () =>
                    amount !== null && this.send("take_gold", sel.view, amount),
                  false,
                  amount === null,
                )}
                ${this.btn(
                  t("gold_set"),
                  () =>
                    amount !== null && this.send("set_gold", sel.view, amount),
                  false,
                  amount === null,
                )}
              </div>
              <div class="flex flex-wrap gap-1">
                ${this.btn(
                  t("troops_give"),
                  () =>
                    amount !== null &&
                    this.send("give_troops", sel.view, amount * TROOP_SCALE),
                  false,
                  amount === null,
                )}
                ${this.btn(
                  t("troops_take"),
                  () =>
                    amount !== null &&
                    this.send("take_troops", sel.view, amount * TROOP_SCALE),
                  false,
                  amount === null,
                )}
                ${this.btn(
                  t("troops_set"),
                  () =>
                    amount !== null &&
                    this.send("set_troops", sel.view, amount * TROOP_SCALE),
                  false,
                  amount === null,
                )}
              </div>
            </div>`
          : nothing}
      </div>
    `;
  }

  private renderGame() {
    const game = this.game;
    if (game === null) return nothing;
    const humans = this.rows.filter((r) => r.kind === "human").length;
    return html`
      <div class="flex flex-col gap-2 text-xs" id="game-admin-game">
        <dl class="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
          <dt class="text-white/50">${t("game_id")}</dt>
          <dd class="font-mono select-all">${game.gameID()}</dd>
          <dt class="text-white/50">${t("tick")}</dt>
          <dd>${game.ticks()}</dd>
          <dt class="text-white/50">${t("players")}</dt>
          <dd>${this.rows.length} (${humans} ${t("kind_human")})</dd>
          <dt class="text-white/50">${t("game_type")}</dt>
          <dd>${String(game.config().gameConfig().gameType)}</dd>
          ${this.canUse("game.admin.debug")
            ? html`<dt class="text-white/50">${t("build")}</dt>
                <dd class="font-mono">${currentBuildLabel()}</dd>`
            : nothing}
        </dl>
        <div class="flex flex-wrap gap-1">
          ${this.canUse("game.admin.pause")
            ? html`${this.btn(t("pause"), () => {
                this.eventBus?.emit(new PauseGameIntentEvent(true));
                this.last = t("pause");
              })}
              ${this.btn(t("resume"), () => {
                this.eventBus?.emit(new PauseGameIntentEvent(false));
                this.last = t("resume");
              })}`
            : nothing}
        </div>
      </div>
    `;
  }

  private renderTools() {
    const me = this.game?.myPlayer() ?? null;
    const commands =
      this.commandsAllowed && this.canUse("game.admin.resources");
    if (!commands) {
      return html`<p class="text-xs text-white/50">
        ${t("tools_unavailable")}
      </p>`;
    }
    return html`<div class="flex flex-col gap-2" id="game-admin-tools">
      <p class="text-xs text-white/60">${t("tools_note")}</p>
      <div class="flex flex-wrap gap-1">
        ${me === null
          ? nothing
          : html`${this.btn(t("refill_gold"), () =>
              this.send("set_gold", me, REFILL_GOLD),
            )}
            ${this.btn(t("refill_troops"), () => {
              const max = this.game?.config().maxTroops(me) ?? 0;
              this.send("set_troops", me, max);
            })}`}
      </div>
    </div>`;
  }

  render() {
    if (!this.canUse("game.admin.panel")) return nothing;
    const staff = staffRoleOf(this.role);
    return html`
      <div
        class="fixed top-2 left-1/2 -translate-x-1/2 z-[1000] pointer-events-auto"
      >
        <button
          id="game-admin-toggle"
          type="button"
          class="inline-flex items-center gap-1.5 rounded border border-df-red bg-black/80 px-2 py-1 text-[11px] font-bold uppercase tracking-widest text-white hover:bg-df-red"
          aria-expanded=${this.open ? "true" : "false"}
          title=${t("toggle_hint")}
          @click=${() => {
            this.open = !this.open;
            if (this.open) this.refresh();
          }}
        >
          ${staffBadge(staff, "w-4 h-4", null)} ${t("title")}
        </button>
      </div>
      ${this.open
        ? html`<aside
            id="game-admin-panel"
            class="fixed right-2 top-14 z-[1000] w-[22rem] max-h-[80vh] overflow-y-auto rounded-lg border border-df-red/60 bg-black/90 p-3 text-white shadow-2xl backdrop-blur pointer-events-auto flex flex-col gap-2"
            @keydown=${(e: KeyboardEvent) => e.stopPropagation()}
          >
            <div class="flex items-center gap-2">
              ${staffBadge(staff, "w-5 h-5")}
              <span class="font-bold uppercase tracking-widest text-sm"
                >${t("title")}</span
              >
              <span class="text-[10px] text-white/50"
                >${staff === null ? "" : staffRoleLabel(staff)}</span
              >
              <button
                class="ml-auto text-white/60 hover:text-white"
                aria-label=${t("close")}
                @click=${() => (this.open = false)}
              >
                ✕
              </button>
            </div>
            ${this.isPublic
              ? html`<p
                  class="text-[11px] text-amber-300"
                  id="game-admin-public-note"
                >
                  ${this.commandsAllowed
                    ? t("public_note_owner")
                    : t("public_note")}
                </p>`
              : nothing}
            ${this.adminModified
              ? html`<p
                  class="text-[11px] font-bold text-df-red-bright"
                  id="game-admin-modified"
                >
                  ${t("modified_banner")}
                </p>`
              : nothing}
            <div class="flex gap-1 border-b border-white/10 pb-1">
              ${(["players", "game", "tools"] as const).map(
                (tab) =>
                  html`<button
                    class="px-2 py-1 text-xs font-bold uppercase tracking-wide ${this
                      .tab === tab
                      ? "text-df-red-bright border-b-2 border-df-red"
                      : "text-white/60 hover:text-white"}"
                    @click=${() => (this.tab = tab)}
                  >
                    ${t(`tab_${tab}`)}
                  </button>`,
              )}
            </div>
            ${this.tab === "players"
              ? this.renderPlayers()
              : this.tab === "game"
                ? this.renderGame()
                : this.renderTools()}
            ${this.last === ""
              ? nothing
              : html`<p class="text-[11px] text-emerald-300" role="status">
                  ${this.last}
                </p>`}
            <p class="text-[10px] text-white/40">${t("server_note")}</p>
          </aside>`
        : nothing}
    `;
  }
}
