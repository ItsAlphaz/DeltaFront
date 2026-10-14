import type {
  AdminAuditEntry,
  AdminMe,
  AdminUserDetail,
  AdminUserList,
} from "@openfront/shared/AdminSchemas";
import { hasPermission, type Permission } from "@openfront/shared/Permissions";
import { html, LitElement, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { adminApi, type AdminResult } from "../AdminApi";
import { showInGameConfirm } from "../InGameModal";
import {
  accountChips,
  ago,
  BTN,
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

type Row = AdminUserList["users"][number];

/** User search and the per-account staff actions. */
@customElement("admin-users-view")
export class AdminUsersView extends LitElement {
  @property({ attribute: false }) me!: AdminMe;

  @state() private q = "";
  @state() private rows: Row[] | null = null;
  @state() private detail: AdminUserDetail | null = null;
  @state() private audit: AdminAuditEntry[] = [];
  @state() private reason = "";
  @state() private busy = false;
  @state() private notice: { ok: boolean; text: string } | null = null;
  @state() private credits = "";
  @state() private flare = "";
  @state() private newRole = "mod";
  @state() private banCategory = "";
  @state() private banDays = "";

  createRenderRoot() {
    return this;
  }

  connectedCallback() {
    super.connectedCallback();
    void this.search();
  }

  private can(permission: Permission): boolean {
    return hasPermission(this.me.role, permission);
  }

  private async search() {
    const result = await adminApi.users(this.q.trim());
    if (result.ok) this.rows = result.data.users;
    else this.notice = { ok: false, text: errorText(result) };
  }

  private async open(publicId: string) {
    const [detail, audit] = await Promise.all([
      adminApi.user(publicId),
      adminApi.userAudit(publicId),
    ]);
    if (!detail.ok) {
      this.notice = { ok: false, text: errorText(detail) };
      return;
    }
    this.detail = detail.data;
    this.audit = audit.ok ? audit.data.entries : [];
    this.notice = null;
  }

  /** Runs one action: needs a reason, an explicit confirmation when destructive. */
  private async act(
    run: (reason: string) => Promise<AdminResult<{ message: string }>>,
    confirmKey: string | null = null,
  ) {
    const detail = this.detail;
    if (detail === null || this.busy) return;
    const reason = this.reason.trim();
    if (reason === "") {
      this.notice = { ok: false, text: t("reason_required") };
      return;
    }
    if (confirmKey !== null) {
      const sure = await showInGameConfirm(
        t(confirmKey, { id: detail.publicId }),
        {
          heading: t("confirm_heading"),
          confirmText: t("confirm_button"),
        },
      );
      if (!sure) return;
    }
    this.busy = true;
    const result = await run(reason);
    this.busy = false;
    this.notice = result.ok
      ? { ok: true, text: result.data.message }
      : { ok: false, text: errorText(result) };
    if (result.ok) {
      await Promise.all([this.open(detail.publicId), this.search()]);
      this.notice = { ok: true, text: result.data.message };
    }
  }

  private renderRow(u: Row) {
    return html`<tr
      class="cursor-pointer hover:bg-white/5 ${this.detail?.publicId ===
      u.publicId
        ? "bg-white/5"
        : ""}"
      @click=${() => this.open(u.publicId)}
    >
      <td class="${TD}">
        <div class="text-df-text font-medium">${u.username ?? "-"}</div>
        <div class="font-mono text-xs text-df-text-secondary">
          ${u.publicId}
        </div>
      </td>
      <td class="${TD}">${accountChips(u)}</td>
      <td class="${TD} text-df-text-muted text-xs">${ago(u.lastSeenAt)}</td>
    </tr>`;
  }

  private renderActions(d: AdminUserDetail) {
    const id = d.publicId;
    return html`
      <div class="flex flex-col gap-3">
        ${sectionTitle(t("actions"))}
        <label class="flex flex-col gap-1 text-xs text-df-text-muted">
          ${t("reason")}
          <input
            id="admin-reason"
            class="${INPUT}"
            maxlength="200"
            .value=${this.reason}
            placeholder=${t("reason_placeholder")}
            @input=${(e: Event) =>
              (this.reason = (e.target as HTMLInputElement).value)}
          />
        </label>

        <div class="flex flex-wrap gap-2">
          ${this.can("admin.users.verify")
            ? html`<button
                class="${BTN}"
                ?disabled=${this.busy}
                @click=${() =>
                  this.act((r) => adminApi.setVerified(id, !d.verified, r))}
              >
                ${d.verified ? t("unverify") : t("verify")}
              </button>`
            : nothing}
          ${this.can("admin.users.bare_name")
            ? html`<button
                class="${BTN}"
                ?disabled=${this.busy}
                @click=${() =>
                  this.act((r) =>
                    adminApi.setBareName(id, !d.bareUsernameEnabled, r),
                  )}
              >
                ${d.bareUsernameEnabled
                  ? t("revoke_bare_name")
                  : t("grant_bare_name")}
              </button>`
            : nothing}
          ${this.can("admin.users.sessions")
            ? html`<button
                class="${BTN_DANGER}"
                ?disabled=${this.busy}
                @click=${() =>
                  this.act(
                    (r) => adminApi.revokeSessions(id, r),
                    "confirm_sessions",
                  )}
              >
                ${t("revoke_sessions")}
              </button>`
            : nothing}
        </div>

        ${this.can("admin.users.role")
          ? html`<div class="flex flex-wrap items-end gap-2">
              <label class="flex flex-col gap-1 text-xs text-df-text-muted">
                ${t("role")}
                <select
                  id="admin-role"
                  class="${INPUT}"
                  .value=${this.newRole}
                  @change=${(e: Event) =>
                    (this.newRole = (e.target as HTMLSelectElement).value)}
                >
                  ${this.can("admin.roles.manage_admins")
                    ? html`<option value="admin">${t("chip_admin")}</option>`
                    : nothing}
                  <option value="mod">${t("chip_mod")}</option>
                  <option value="flagged">${t("chip_flagged")}</option>
                  <option value="none">${t("role_none")}</option>
                </select>
              </label>
              <button
                class="${BTN_DANGER}"
                ?disabled=${this.busy}
                @click=${() =>
                  this.act(
                    (r) =>
                      adminApi.setRole(
                        id,
                        this.newRole as "admin" | "mod" | "flagged" | "none",
                        r,
                      ),
                    "confirm_role",
                  )}
              >
                ${t("change_role")}
              </button>
              <span class="text-xs text-df-text-muted">${t("owner_note")}</span>
            </div>`
          : nothing}
        ${this.can("admin.wallet.grant")
          ? html`<div class="flex flex-wrap items-end gap-2">
              <label class="flex flex-col gap-1 text-xs text-df-text-muted">
                ${t("credits")}
                <input
                  id="admin-credits"
                  class="${INPUT} w-36"
                  inputmode="numeric"
                  placeholder="100 / -100"
                  .value=${this.credits}
                  @input=${(e: Event) =>
                    (this.credits = (e.target as HTMLInputElement).value)}
                />
              </label>
              <button
                class="${BTN}"
                ?disabled=${this.busy}
                @click=${() => {
                  const n = Number(this.credits);
                  if (!Number.isInteger(n) || n === 0) {
                    this.notice = { ok: false, text: t("credits_invalid") };
                    return;
                  }
                  void this.act(
                    (r) => adminApi.credits(id, n, r),
                    n < 0 ? "confirm_credits" : null,
                  );
                }}
              >
                ${t("apply_credits")}
              </button>
            </div>`
          : nothing}
        ${this.can("admin.inventory.grant")
          ? html`<div class="flex flex-wrap items-end gap-2">
              <label class="flex flex-col gap-1 text-xs text-df-text-muted">
                ${t("item")}
                <input
                  id="admin-flare"
                  class="${INPUT} w-64 font-mono"
                  placeholder="flag:delta_mark"
                  .value=${this.flare}
                  @input=${(e: Event) =>
                    (this.flare = (e.target as HTMLInputElement).value.trim())}
                />
              </label>
              <button
                class="${BTN}"
                ?disabled=${this.busy || this.flare === ""}
                @click=${() =>
                  this.act((r) => adminApi.item(id, this.flare, true, r))}
              >
                ${t("grant_item")}
              </button>
              <button
                class="${BTN_DANGER}"
                ?disabled=${this.busy || this.flare === ""}
                @click=${() =>
                  this.act(
                    (r) => adminApi.item(id, this.flare, false, r),
                    "confirm_item",
                  )}
              >
                ${t("revoke_item")}
              </button>
            </div>`
          : nothing}
        ${this.can("admin.users.ban")
          ? html`<div class="flex flex-wrap items-end gap-2">
              <label class="flex flex-col gap-1 text-xs text-df-text-muted">
                ${t("ban_category")}
                <input
                  id="admin-ban-category"
                  class="${INPUT} w-40"
                  maxlength="40"
                  placeholder="cheating"
                  .value=${this.banCategory}
                  @input=${(e: Event) =>
                    (this.banCategory = (e.target as HTMLInputElement).value)}
                />
              </label>
              <label class="flex flex-col gap-1 text-xs text-df-text-muted">
                ${t("ban_days")}
                <input
                  class="${INPUT} w-24"
                  inputmode="numeric"
                  placeholder=${t("ban_forever")}
                  .value=${this.banDays}
                  @input=${(e: Event) =>
                    (this.banDays = (e.target as HTMLInputElement).value)}
                />
              </label>
              <button
                class="${BTN_DANGER}"
                ?disabled=${this.busy || this.banCategory.trim() === ""}
                @click=${() => {
                  const days =
                    this.banDays.trim() === "" ? null : Number(this.banDays);
                  if (days !== null && (!Number.isInteger(days) || days < 1)) {
                    this.notice = { ok: false, text: t("days_invalid") };
                    return;
                  }
                  void this.act(
                    (r) => adminApi.ban(id, this.banCategory.trim(), days, r),
                    "confirm_ban",
                  );
                }}
              >
                ${t("ban")}
              </button>
              <button
                class="${BTN}"
                ?disabled=${this.busy}
                @click=${() => this.act((r) => adminApi.unban(id, r))}
              >
                ${t("unban")}
              </button>
            </div>`
          : nothing}
      </div>
    `;
  }

  private renderDetail(d: AdminUserDetail) {
    return html`
      <div class="${CARD} flex flex-col gap-4" id="admin-user-detail">
        <div class="flex flex-wrap items-center gap-2">
          <h2 class="text-xl font-bold text-df-text break-all">
            ${d.username ?? d.publicId}
          </h2>
          ${accountChips({
            role: d.role,
            verified: d.verified,
            kind: d.kind,
            banned: d.bans.some((b) => b.active),
          })}
          ${d.bareUsernameEnabled
            ? chip(t("chip_bare_name"), "white")
            : nothing}
        </div>
        <dl class="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
          <dt class="text-df-text-muted">${t("public_id")}</dt>
          <dd class="font-mono">${d.publicId}</dd>
          <dt class="text-df-text-muted">${t("account_id")}</dt>
          <dd class="font-mono text-xs break-all">${d.id}</dd>
          <dt class="text-df-text-muted">${t("created")}</dt>
          <dd>${fmtDate(d.createdAt)}</dd>
          <dt class="text-df-text-muted">${t("last_seen")}</dt>
          <dd>${fmtDate(d.lastSeenAt)}</dd>
          <dt class="text-df-text-muted">${t("role")}</dt>
          <dd>${d.role ?? t("role_none")}</dd>
          <dt class="text-df-text-muted">${t("credits")}</dt>
          <dd>${d.credits}</dd>
          <dt class="text-df-text-muted">${t("sessions")}</dt>
          <dd>${d.liveSessions}</dd>
          <dt class="text-df-text-muted">${t("clan")}</dt>
          <dd>
            ${d.clans.length === 0
              ? "-"
              : d.clans.map((c) => `${c.tag} (${c.role})`).join(", ")}
          </dd>
          <dt class="text-df-text-muted">${t("identities")}</dt>
          <dd>
            ${d.identities.length === 0
              ? t("guest_account")
              : d.identities.map(
                  (i) =>
                    html`<div class="text-xs">
                      ${i.provider} ·
                      <span class="font-mono">${i.providerUserId}</span>
                      ${i.email ? html`· ${i.email}` : nothing}
                    </div>`,
                )}
          </dd>
          <dt class="text-df-text-muted">${t("items")}</dt>
          <dd class="text-xs font-mono">
            ${d.items.filter((i) => i.revokedAt === null).length === 0
              ? "-"
              : d.items
                  .filter((i) => i.revokedAt === null)
                  .map((i) => i.flare)
                  .join(", ")}
          </dd>
        </dl>

        ${d.bans.length === 0
          ? nothing
          : html`<div>
              ${sectionTitle(t("bans"))}
              ${d.bans.map(
                (b) =>
                  html`<div class="text-xs text-df-text-secondary">
                    ${b.active
                      ? chip(t("chip_banned"), "red")
                      : chip(t("chip_lifted"), "grey")}
                    ${b.category} · ${b.reason ?? "-"} · ${fmtDate(b.createdAt)}
                  </div>`,
              )}
            </div>`}
        ${this.renderActions(d)}
        ${this.notice === null
          ? nothing
          : html`<p
              id="admin-notice"
              role="status"
              class="text-sm ${this.notice.ok
                ? "text-emerald-300"
                : "text-df-red-bright"}"
            >
              ${this.notice.text}
            </p>`}
        <div>
          ${sectionTitle(t("audit_history"))}
          ${this.audit.length === 0
            ? html`<p class="text-sm text-df-text-muted">${t("none")}</p>`
            : html`<ul class="flex flex-col gap-1 text-xs">
                ${this.audit.map(
                  (e) =>
                    html`<li class="text-df-text-secondary">
                      <span class="text-df-text-muted"
                        >${fmtDate(e.createdAt)}</span
                      >
                      ${chip(e.action, "grey")} ${e.actor}
                      ${typeof e.details.reason === "string"
                        ? html`· ${e.details.reason}`
                        : nothing}
                    </li>`,
                )}
              </ul>`}
        </div>
      </div>
    `;
  }

  render() {
    return html`
      <div class="grid lg:grid-cols-[minmax(280px,380px)_1fr] gap-4 p-4 lg:p-6">
        <div class="${CARD} flex flex-col gap-3 self-start">
          <form
            class="flex gap-2"
            @submit=${(e: Event) => {
              e.preventDefault();
              void this.search();
            }}
          >
            <input
              id="admin-user-search"
              class="${INPUT} flex-1"
              placeholder=${t("search_users")}
              .value=${this.q}
              @input=${(e: Event) =>
                (this.q = (e.target as HTMLInputElement).value)}
            />
            <button class="${BTN_PRIMARY}" type="submit">${t("search")}</button>
          </form>
          ${this.rows === null
            ? html`<p class="text-df-text-muted text-sm">${t("loading")}</p>`
            : this.rows.length === 0
              ? html`<p class="text-df-text-muted text-sm">
                  ${t("no_results")}
                </p>`
              : html`<table class="${TABLE}">
                  <thead>
                    <tr>
                      <th class="${TH}">${t("col_account")}</th>
                      <th class="${TH}">${t("col_status")}</th>
                      <th class="${TH}">${t("col_seen")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    ${this.rows.map((u) => this.renderRow(u))}
                  </tbody>
                </table>`}
        </div>
        ${this.detail === null
          ? html`<div class="${CARD} text-df-text-muted text-sm">
              ${t("select_user")}
            </div>`
          : this.renderDetail(this.detail)}
      </div>
    `;
  }
}
