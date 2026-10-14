import type {
  AdminMe,
  AdminProgression,
  AdminXpHistory,
} from "@openfront/shared/AdminSchemas";
import { hasPermission, type Permission } from "@openfront/shared/Permissions";
import { html, LitElement, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { adminApi } from "../AdminApi";
import { showInGameConfirm } from "../InGameModal";
import { rankLabelKey } from "../Progression";
import { translateText } from "../Utils";
import {
  BTN,
  BTN_DANGER,
  CARD,
  errorText,
  fmtDate,
  INPUT,
  sectionTitle,
  t,
} from "./AdminUi";

/**
 * One account's progression on the admin user page: lifetime XP, level, rank,
 * prestige, season XP and challenge progress, recent games with review flags,
 * the XP history, and (for a role that holds the permission) the grant, revoke
 * and set tools. Every change needs a reason, is audited by the API, and the
 * API checks the permission again: hiding a button here is presentation only.
 */
@customElement("admin-progression-card")
export class AdminProgressionCard extends LitElement {
  @property({ attribute: false }) me!: AdminMe;
  @property({ type: String }) publicId = "";

  @state() private data: AdminProgression | null = null;
  @state() private history: AdminXpHistory | null = null;
  @state() private amount = "";
  @state() private reason = "";
  @state() private countsForSeason = false;
  @state() private busy = false;
  @state() private notice: { ok: boolean; text: string } | null = null;

  createRenderRoot() {
    return this;
  }

  protected willUpdate(changed: Map<string, unknown>): void {
    if (changed.has("publicId") && this.publicId !== "") void this.load();
  }

  private can(permission: Permission): boolean {
    return hasPermission(this.me.role, permission);
  }

  private async load(page = 1): Promise<void> {
    const id = this.publicId;
    const [progress, history] = await Promise.all([
      adminApi.progression(id),
      this.can("admin.xp.history")
        ? adminApi.xpHistory(id, page)
        : Promise.resolve(null),
    ]);
    if (id !== this.publicId) return;
    if (!progress.ok) {
      this.notice = { ok: false, text: errorText(progress) };
      return;
    }
    this.data = progress.data;
    this.history = history !== null && history.ok ? history.data : null;
  }

  private async apply(
    action: "grant" | "revoke" | "set",
    permission: Permission,
  ): Promise<void> {
    if (this.busy || !this.can(permission)) return;
    const amount = Number(this.amount);
    const reason = this.reason.trim();
    if (
      !Number.isInteger(amount) ||
      amount < 0 ||
      (amount === 0 && action !== "set")
    ) {
      this.notice = { ok: false, text: t("xp_invalid") };
      return;
    }
    if (reason === "") {
      this.notice = { ok: false, text: t("reason_required") };
      return;
    }
    if (
      action !== "grant" &&
      !(await showInGameConfirm(t("confirm_xp", { id: this.publicId }), {
        heading: t("confirm_heading"),
        confirmText: t("confirm_button"),
      }))
    ) {
      return;
    }
    this.busy = true;
    const result = await adminApi.adjustXp(
      this.publicId,
      action,
      amount,
      reason,
      this.countsForSeason,
    );
    this.busy = false;
    this.notice = result.ok
      ? { ok: true, text: result.data.message }
      : { ok: false, text: errorText(result) };
    if (result.ok) await this.load();
  }

  render() {
    const d = this.data;
    if (d === null) return nothing;
    if (!d.registered) {
      return html`<div class="${CARD}" data-admin-progression>
        ${sectionTitle(t("progression"))}
        <p class="text-sm text-df-text-muted">${t("xp_guest")}</p>
      </div>`;
    }
    return html`<div class="${CARD} flex flex-col gap-3" data-admin-progression>
      ${sectionTitle(t("progression"))}
      <dl class="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
        <dt class="text-df-text-muted">${t("xp_level")}</dt>
        <dd data-admin-level>
          ${d.level} · ${translateText(rankLabelKey(d.level))}
          ${d.legend ? html`· ${t("xp_legend")}` : nothing}
        </dd>
        <dt class="text-df-text-muted">${t("xp_prestige")}</dt>
        <dd>${d.prestige}</dd>
        <dt class="text-df-text-muted">${t("xp_run")}</dt>
        <dd data-admin-run-xp>${d.runXp.toLocaleString()}</dd>
        <dt class="text-df-text-muted">${t("xp_lifetime")}</dt>
        <dd data-admin-lifetime-xp>${d.lifetimeXp.toLocaleString()}</dd>
        ${d.season === null
          ? nothing
          : html`<dt class="text-df-text-muted">${t("xp_season")}</dt>
              <dd>
                ${d.season.name} · ${d.season.level} ·
                ${d.season.xp.toLocaleString()}
              </dd>`}
        ${d.title === null
          ? nothing
          : html`<dt class="text-df-text-muted">${t("xp_title")}</dt>
              <dd>${d.title}</dd>`}
      </dl>
      ${d.challenges.length === 0
        ? nothing
        : html`<ul class="m-0 list-none p-0 text-xs text-df-text-secondary">
            ${d.challenges.map(
              (c) =>
                html`<li>
                  ${c.period} · ${c.id} · ${c.progress}/${c.target}
                  ${c.completed ? "✓" : ""}
                </li>`,
            )}
          </ul>`}
      ${d.flaggedGames.length === 0
        ? nothing
        : html`<div class="text-xs">
            <div class="font-bold text-amber-300">${t("xp_flagged")}</div>
            ${d.flaggedGames.map(
              (g) =>
                html`<div class="font-mono">
                  ${g.gameId} · ${g.flags.join(", ")} · ${g.xp} XP ·
                  ${fmtDate(g.at)}
                </div>`,
            )}
          </div>`}
      ${this.can("admin.xp.grant") ||
      this.can("admin.xp.revoke") ||
      this.can("admin.xp.set")
        ? this.renderTools()
        : nothing}
      ${this.notice === null
        ? nothing
        : html`<p
            class="m-0 text-sm ${this.notice.ok
              ? "text-emerald-300"
              : "text-df-red-bright"}"
            role="status"
          >
            ${this.notice.text}
          </p>`}
      ${this.history === null ? nothing : this.renderHistory(this.history)}
    </div>`;
  }

  private renderTools() {
    return html`<div class="flex flex-wrap items-end gap-2" data-admin-xp-tools>
      <label class="flex flex-col gap-1 text-xs text-df-text-muted">
        ${t("xp_amount")}
        <input
          class="${INPUT} w-32"
          inputmode="numeric"
          .value=${this.amount}
          @input=${(e: Event) =>
            (this.amount = (e.target as HTMLInputElement).value)}
        />
      </label>
      <label class="flex flex-col gap-1 text-xs text-df-text-muted">
        ${t("reason")}
        <input
          class="${INPUT} w-64"
          maxlength="200"
          .value=${this.reason}
          @input=${(e: Event) =>
            (this.reason = (e.target as HTMLInputElement).value)}
        />
      </label>
      <label class="flex items-center gap-1 text-xs text-df-text-muted">
        <input
          type="checkbox"
          .checked=${this.countsForSeason}
          @change=${(e: Event) =>
            (this.countsForSeason = (e.target as HTMLInputElement).checked)}
        />
        ${t("xp_counts_for_season")}
      </label>
      ${this.can("admin.xp.grant")
        ? html`<button
            class="${BTN}"
            data-admin-xp-grant
            ?disabled=${this.busy}
            @click=${() => this.apply("grant", "admin.xp.grant")}
          >
            ${t("xp_grant")}
          </button>`
        : nothing}
      ${this.can("admin.xp.revoke")
        ? html`<button
            class="${BTN_DANGER}"
            data-admin-xp-revoke
            ?disabled=${this.busy}
            @click=${() => this.apply("revoke", "admin.xp.revoke")}
          >
            ${t("xp_revoke")}
          </button>`
        : nothing}
      ${this.can("admin.xp.set")
        ? html`<button
            class="${BTN_DANGER}"
            data-admin-xp-set
            ?disabled=${this.busy}
            @click=${() => this.apply("set", "admin.xp.set")}
          >
            ${t("xp_set")}
          </button>`
        : nothing}
    </div>`;
  }

  private renderHistory(history: AdminXpHistory) {
    return html`<details data-admin-xp-history>
      <summary class="cursor-pointer text-xs font-bold text-df-text-muted">
        ${t("xp_history")}
      </summary>
      <table class="mt-2 w-full text-xs">
        <tbody>
          ${history.entries.map(
            (e) =>
              html`<tr>
                <td class="pr-3 text-df-text-muted">${fmtDate(e.createdAt)}</td>
                <td
                  class="pr-3 font-mono ${e.amount < 0 ? "text-sky-300" : ""}"
                >
                  ${e.amount > 0 ? "+" : ""}${e.amount}
                </td>
                <td class="pr-3">${e.source}</td>
                <td class="text-df-text-muted">
                  ${e.reason ?? e.refId ?? ""}${e.actor === null
                    ? ""
                    : html` · ${e.actor}`}
                </td>
              </tr>`,
          )}
        </tbody>
      </table>
      <div class="mt-2 flex gap-2">
        <button
          class="${BTN}"
          ?disabled=${history.page <= 1}
          @click=${() => this.load(history.page - 1)}
        >
          ${t("page_prev")}
        </button>
        <button
          class="${BTN}"
          ?disabled=${!history.hasMore}
          @click=${() => this.load(history.page + 1)}
        >
          ${t("page_next")}
        </button>
      </div>
    </details>`;
  }
}
