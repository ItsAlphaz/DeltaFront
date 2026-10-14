import type { AdminSeason } from "@openfront/shared/AdminSchemas";
import { html, LitElement, nothing } from "lit";
import { customElement, state } from "lit/decorators.js";
import { adminApi } from "../AdminApi";
import { showInGameConfirm } from "../InGameModal";
import {
  BTN_DANGER,
  BTN_PRIMARY,
  CARD,
  chip,
  errorText,
  fmtDate,
  INPUT,
  sectionTitle,
  t,
  TABLE,
  TD,
  TH,
} from "./AdminUi";

/**
 * Seasons (owner only): the running and past ones, creating the next, renaming
 * or moving the end of one that has not been archived, and closing the running
 * one early. The API refuses an overlap and says why.
 */
@customElement("admin-seasons-view")
export class AdminSeasonsView extends LitElement {
  @state() private seasons: AdminSeason[] | null = null;
  @state() private name = "";
  @state() private startsAt = "";
  @state() private endsAt = "";
  @state() private reason = "";
  @state() private busy = false;
  @state() private notice: { ok: boolean; text: string } | null = null;

  createRenderRoot() {
    return this;
  }

  connectedCallback() {
    super.connectedCallback();
    void this.load();
  }

  private async load() {
    const result = await adminApi.seasons();
    if (result.ok) this.seasons = result.data.seasons;
    else this.notice = { ok: false, text: errorText(result) };
  }

  private async create() {
    if (this.busy) return;
    const start = new Date(this.startsAt);
    const end = new Date(this.endsAt);
    if (
      this.name.trim() === "" ||
      Number.isNaN(start.getTime()) ||
      Number.isNaN(end.getTime())
    ) {
      this.notice = { ok: false, text: t("season_invalid") };
      return;
    }
    this.busy = true;
    const result = await adminApi.createSeason({
      name: this.name.trim(),
      startsAt: start.toISOString(),
      endsAt: end.toISOString(),
    });
    this.busy = false;
    this.notice = result.ok
      ? { ok: true, text: result.data.message }
      : { ok: false, text: errorText(result) };
    if (result.ok) {
      this.name = "";
      await this.load();
    }
  }

  private async close(season: AdminSeason) {
    const reason = this.reason.trim();
    if (this.busy) return;
    if (reason === "") {
      this.notice = { ok: false, text: t("reason_required") };
      return;
    }
    const sure = await showInGameConfirm(
      t("confirm_season_close", { name: season.name }),
      { heading: t("confirm_heading"), confirmText: t("confirm_button") },
    );
    if (!sure) return;
    this.busy = true;
    const result = await adminApi.closeSeason(season.id, reason);
    this.busy = false;
    this.notice = result.ok
      ? { ok: true, text: result.data.message }
      : { ok: false, text: errorText(result) };
    if (result.ok) await this.load();
  }

  render() {
    return html`<div class="flex flex-col gap-4 p-4" id="admin-seasons">
      <div class="${CARD} flex flex-wrap items-end gap-2">
        ${sectionTitle(t("seasons_new"))}
        <label class="flex flex-col gap-1 text-xs text-df-text-muted">
          ${t("season_name")}
          <input
            class="${INPUT} w-56"
            maxlength="40"
            .value=${this.name}
            @input=${(e: Event) =>
              (this.name = (e.target as HTMLInputElement).value)}
          />
        </label>
        <label class="flex flex-col gap-1 text-xs text-df-text-muted">
          ${t("season_starts")}
          <input
            class="${INPUT}"
            type="datetime-local"
            .value=${this.startsAt}
            @input=${(e: Event) =>
              (this.startsAt = (e.target as HTMLInputElement).value)}
          />
        </label>
        <label class="flex flex-col gap-1 text-xs text-df-text-muted">
          ${t("season_ends")}
          <input
            class="${INPUT}"
            type="datetime-local"
            .value=${this.endsAt}
            @input=${(e: Event) =>
              (this.endsAt = (e.target as HTMLInputElement).value)}
          />
        </label>
        <button
          class="${BTN_PRIMARY}"
          data-admin-season-create
          ?disabled=${this.busy}
          @click=${() => this.create()}
        >
          ${t("season_create")}
        </button>
      </div>
      <label class="flex flex-col gap-1 text-xs text-df-text-muted">
        ${t("reason")}
        <input
          class="${INPUT} w-96 max-w-full"
          maxlength="200"
          .value=${this.reason}
          @input=${(e: Event) =>
            (this.reason = (e.target as HTMLInputElement).value)}
        />
      </label>
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
      <table class="${TABLE}">
        <thead>
          <tr>
            <th class="${TH}">#</th>
            <th class="${TH}">${t("season_name")}</th>
            <th class="${TH}">${t("season_starts")}</th>
            <th class="${TH}">${t("season_ends")}</th>
            <th class="${TH}">${t("season_players")}</th>
            <th class="${TH}"></th>
          </tr>
        </thead>
        <tbody>
          ${(this.seasons ?? []).map(
            (s) =>
              html`<tr data-admin-season=${s.number}>
                <td class="${TD}">${s.number}</td>
                <td class="${TD}">
                  ${s.name}
                  ${s.current
                    ? chip(t("season_running"), "green")
                    : s.archivedAt !== null
                      ? chip(t("season_archived"), "grey")
                      : chip(t("season_scheduled"), "amber")}
                </td>
                <td class="${TD}">${fmtDate(s.startsAt)}</td>
                <td class="${TD}">${fmtDate(s.endsAt)}</td>
                <td class="${TD}">${s.players}</td>
                <td class="${TD}">
                  ${s.current
                    ? html`<button
                        class="${BTN_DANGER}"
                        ?disabled=${this.busy}
                        @click=${() => this.close(s)}
                      >
                        ${t("season_close")}
                      </button>`
                    : nothing}
                </td>
              </tr>`,
          )}
        </tbody>
      </table>
    </div>`;
  }
}
