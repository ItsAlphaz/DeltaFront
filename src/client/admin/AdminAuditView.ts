import type { AdminAuditEntry, AdminMe } from "@openfront/shared/AdminSchemas";
import { hasPermission } from "@openfront/shared/Permissions";
import { html, LitElement, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { adminApi } from "../AdminApi";
import {
  BTN,
  BTN_PRIMARY,
  CARD,
  chip,
  errorText,
  fmtDate,
  INPUT,
  t,
  TABLE,
  TD,
  TH,
} from "./AdminUi";

/** The audit log. Owners and admins see everything; moderators only moderation actions. */
@customElement("admin-audit-view")
export class AdminAuditView extends LitElement {
  @property({ attribute: false }) me!: AdminMe;

  @state() private entries: AdminAuditEntry[] = [];
  @state() private next: string | null = null;
  @state() private error: string | null = null;
  @state() private loading = false;
  @state() private actor = "";
  @state() private action = "";
  @state() private target = "";
  @state() private source = "";

  createRenderRoot() {
    return this;
  }

  connectedCallback() {
    super.connectedCallback();
    void this.load(false);
  }

  private async load(more: boolean) {
    this.loading = true;
    const result = await adminApi.audit({
      actor: this.actor.trim(),
      action: this.action.trim(),
      target: this.target.trim(),
      source: this.source,
      before: more ? (this.next ?? undefined) : undefined,
    });
    this.loading = false;
    if (!result.ok) {
      this.error = errorText(result);
      return;
    }
    this.error = null;
    this.entries = more
      ? [...this.entries, ...result.data.entries]
      : result.data.entries;
    this.next = result.data.nextBefore;
  }

  private detailText(e: AdminAuditEntry): string {
    const { reason, ...rest } = e.details;
    const parts = Object.entries(rest).map(
      ([k, v]) =>
        `${k}=${typeof v === "object" ? JSON.stringify(v) : String(v)}`,
    );
    return [typeof reason === "string" ? reason : null, ...parts]
      .filter((p) => p !== null)
      .join(" · ");
  }

  render() {
    const all = hasPermission(this.me.role, "admin.audit.view");
    return html`<div class="flex flex-col gap-4 p-4 lg:p-6" id="admin-audit">
      ${all
        ? nothing
        : html`<p class="text-xs text-df-text-muted">
            ${t("audit_mod_note")}
          </p>`}
      <form
        class="${CARD} flex flex-wrap items-end gap-2"
        @submit=${(e: Event) => {
          e.preventDefault();
          void this.load(false);
        }}
      >
        <input
          class="${INPUT} w-44"
          placeholder=${t("filter_actor")}
          .value=${this.actor}
          @input=${(e: Event) =>
            (this.actor = (e.target as HTMLInputElement).value)}
        />
        <input
          class="${INPUT} w-44"
          placeholder=${t("filter_action")}
          .value=${this.action}
          @input=${(e: Event) =>
            (this.action = (e.target as HTMLInputElement).value)}
        />
        <input
          class="${INPUT} w-44"
          placeholder=${t("filter_target")}
          .value=${this.target}
          @input=${(e: Event) =>
            (this.target = (e.target as HTMLInputElement).value)}
        />
        <select
          class="${INPUT}"
          .value=${this.source}
          @change=${(e: Event) =>
            (this.source = (e.target as HTMLSelectElement).value)}
        >
          <option value="">${t("source_any")}</option>
          <option value="web">web</option>
          <option value="cli">cli</option>
          <option value="game">game</option>
        </select>
        <button class="${BTN_PRIMARY}" type="submit">${t("search")}</button>
      </form>
      ${this.error === null
        ? nothing
        : html`<p class="text-df-red-bright" role="alert">${this.error}</p>`}
      <div class="${CARD} overflow-x-auto">
        <table class="${TABLE}">
          <thead>
            <tr>
              <th class="${TH}">${t("col_time")}</th>
              <th class="${TH}">${t("col_actor")}</th>
              <th class="${TH}">${t("col_action")}</th>
              <th class="${TH}">${t("col_target")}</th>
              <th class="${TH}">${t("col_details")}</th>
            </tr>
          </thead>
          <tbody>
            ${this.entries.map(
              (e) =>
                html`<tr>
                  <td
                    class="${TD} text-xs text-df-text-muted whitespace-nowrap"
                  >
                    ${fmtDate(e.createdAt)}
                  </td>
                  <td class="${TD} text-xs">
                    <span class="font-mono">${e.actor}</span>
                    ${e.actorRole ? chip(e.actorRole, "white") : nothing}
                    ${chip(e.source, "grey")}
                  </td>
                  <td class="${TD}">${chip(e.action, "red")}</td>
                  <td class="${TD} font-mono text-xs">${e.targetId ?? "-"}</td>
                  <td class="${TD} text-xs text-df-text-secondary break-words">
                    ${this.detailText(e)}
                  </td>
                </tr>`,
            )}
          </tbody>
        </table>
        ${this.entries.length === 0 && !this.loading
          ? html`<p class="text-sm text-df-text-muted p-3">${t("none")}</p>`
          : nothing}
      </div>
      ${this.next === null
        ? nothing
        : html`<button
            class="${BTN} self-start"
            ?disabled=${this.loading}
            @click=${() => this.load(true)}
          >
            ${t("load_more")}
          </button>`}
    </div>`;
  }
}
