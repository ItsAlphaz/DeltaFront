import type {
  AdminClanDetail,
  AdminClanList,
  AdminMe,
} from "@openfront/shared/AdminSchemas";
import { hasPermission, type Permission } from "@openfront/shared/Permissions";
import { html, LitElement, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { adminApi, type AdminResult } from "../AdminApi";
import { showInGameConfirm } from "../InGameModal";
import { staffBadge } from "../components/ui/StaffBadge";
import { verifiedBadge } from "../components/ui/VerifiedBadge";
import {
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

type Row = AdminClanList["clans"][number];

/** Clan search, official clan creation and the clan actions. */
@customElement("admin-clans-view")
export class AdminClansView extends LitElement {
  @property({ attribute: false }) me!: AdminMe;

  @state() private q = "";
  @state() private rows: Row[] | null = null;
  @state() private detail: AdminClanDetail | null = null;
  @state() private reason = "";
  @state() private busy = false;
  @state() private notice: { ok: boolean; text: string } | null = null;
  @state() private newName = "";
  @state() private newTag = "";
  @state() private newDescription = "";
  @state() private renameTo = "";
  @state() private retagTo = "";
  @state() private target = "";

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
    const result = await adminApi.clans(this.q.trim());
    if (result.ok) this.rows = result.data.clans;
    else this.notice = { ok: false, text: errorText(result) };
  }

  private async open(tag: string) {
    const result = await adminApi.clan(tag);
    if (result.ok) {
      this.detail = result.data;
      this.renameTo = result.data.name;
      this.retagTo = result.data.tag;
    } else {
      this.notice = { ok: false, text: errorText(result) };
    }
  }

  private async act(
    run: (reason: string) => Promise<AdminResult<{ message: string }>>,
    confirmKey: string | null = null,
    reopen: string | null = this.detail?.tag ?? null,
  ) {
    if (this.busy) return;
    const reason = this.reason.trim();
    if (reason === "") {
      this.notice = { ok: false, text: t("reason_required") };
      return;
    }
    if (confirmKey !== null) {
      const sure = await showInGameConfirm(
        t(confirmKey, { tag: this.detail?.tag ?? "" }),
        { heading: t("confirm_heading"), confirmText: t("confirm_button") },
      );
      if (!sure) return;
    }
    this.busy = true;
    const result = await run(reason);
    this.busy = false;
    if (!result.ok) {
      this.notice = { ok: false, text: errorText(result) };
      return;
    }
    const message = result.data.message;
    await this.search();
    if (reopen !== null) await this.open(reopen);
    this.notice = { ok: true, text: message };
  }

  private renderCreate() {
    if (!this.can("admin.clans.official")) return nothing;
    return html`<form
      class="${CARD} flex flex-col gap-2"
      id="admin-create-clan"
      @submit=${(e: Event) => {
        e.preventDefault();
        void this.act(
          (reason) =>
            adminApi.createOfficialClan({
              name: this.newName,
              tag: this.newTag,
              description: this.newDescription || undefined,
              reason,
            }),
          null,
          this.newTag.toUpperCase(),
        );
      }}
    >
      ${sectionTitle(t("create_official_clan"))}
      <p class="text-xs text-df-text-muted">${t("create_official_note")}</p>
      <input
        id="admin-new-clan-name"
        class="${INPUT}"
        placeholder=${t("clan_name")}
        .value=${this.newName}
        @input=${(e: Event) =>
          (this.newName = (e.target as HTMLInputElement).value)}
      />
      <input
        id="admin-new-clan-tag"
        class="${INPUT} w-32 uppercase"
        maxlength="5"
        placeholder=${t("clan_tag")}
        .value=${this.newTag}
        @input=${(e: Event) =>
          (this.newTag = (e.target as HTMLInputElement).value)}
      />
      <input
        class="${INPUT}"
        placeholder=${t("clan_description")}
        .value=${this.newDescription}
        @input=${(e: Event) =>
          (this.newDescription = (e.target as HTMLInputElement).value)}
      />
      <button
        class="${BTN_PRIMARY} self-start"
        type="submit"
        ?disabled=${this.busy}
      >
        ${t("create_clan")}
      </button>
    </form>`;
  }

  private renderDetail(c: AdminClanDetail) {
    const tag = c.tag;
    return html`<div class="${CARD} flex flex-col gap-4" id="admin-clan-detail">
      <div class="flex flex-wrap items-center gap-2">
        <h2 class="text-xl font-bold text-df-text">
          <span class="font-mono text-df-red-bright">[${c.tag}]</span> ${c.name}
        </h2>
        ${chip(
          c.isOpen ? t("chip_open") : t("chip_closed"),
          c.isOpen ? "green" : "grey",
        )}
        <span class="text-xs text-df-text-muted"
          >${t("created")} ${fmtDate(c.createdAt)}</span
        >
      </div>
      <p class="text-sm text-df-text-secondary">${c.description || "-"}</p>

      ${this.can("admin.clans.manage")
        ? html`<div class="flex flex-col gap-3">
            ${sectionTitle(t("actions"))}
            <div class="flex flex-wrap items-end gap-2">
              <input
                class="${INPUT} w-56"
                .value=${this.renameTo}
                @input=${(e: Event) =>
                  (this.renameTo = (e.target as HTMLInputElement).value)}
              />
              <button
                class="${BTN}"
                ?disabled=${this.busy}
                @click=${() =>
                  this.act((r) => adminApi.clanRename(tag, this.renameTo, r))}
              >
                ${t("rename")}
              </button>
              <input
                class="${INPUT} w-28 uppercase"
                maxlength="5"
                .value=${this.retagTo}
                @input=${(e: Event) =>
                  (this.retagTo = (e.target as HTMLInputElement).value)}
              />
              <button
                class="${BTN}"
                ?disabled=${this.busy}
                @click=${() =>
                  this.act(
                    (r) => adminApi.clanRetag(tag, this.retagTo, r),
                    null,
                    this.retagTo.toUpperCase(),
                  )}
              >
                ${t("change_tag")}
              </button>
              <button
                class="${BTN}"
                ?disabled=${this.busy}
                @click=${() =>
                  this.act((r) => adminApi.clanOpen(tag, !c.isOpen, r))}
              >
                ${c.isOpen ? t("close_clan") : t("open_clan")}
              </button>
            </div>
            <div class="flex flex-wrap items-end gap-2">
              <input
                id="admin-clan-target"
                class="${INPUT} w-48 font-mono"
                placeholder=${t("target_public_id")}
                .value=${this.target}
                @input=${(e: Event) =>
                  (this.target = (e.target as HTMLInputElement).value.trim())}
              />
              <button
                class="${BTN_DANGER}"
                ?disabled=${this.busy || this.target === ""}
                @click=${() =>
                  this.act(
                    (r) => adminApi.clanTransfer(tag, this.target, r),
                    "confirm_clan_transfer",
                  )}
              >
                ${t("transfer")}
              </button>
              <button
                class="${BTN_DANGER}"
                ?disabled=${this.busy || this.target === ""}
                @click=${() =>
                  this.act(
                    (r) => adminApi.clanBan(tag, this.target, true, r),
                    "confirm_clan_ban",
                  )}
              >
                ${t("clan_ban")}
              </button>
              <button
                class="${BTN}"
                ?disabled=${this.busy || this.target === ""}
                @click=${() =>
                  this.act((r) => adminApi.clanBan(tag, this.target, false, r))}
              >
                ${t("clan_unban")}
              </button>
            </div>
          </div>`
        : nothing}

      <div>
        ${sectionTitle(t("members", { n: c.membersList.length }))}
        <table class="${TABLE}">
          <thead>
            <tr>
              <th class="${TH}">${t("col_account")}</th>
              <th class="${TH}">${t("col_role")}</th>
              <th class="${TH}">${t("col_joined")}</th>
              <th class="${TH}"></th>
            </tr>
          </thead>
          <tbody>
            ${c.membersList.map(
              (m) =>
                html`<tr>
                  <td class="${TD}">
                    <span class="inline-flex items-center gap-1.5 text-df-text">
                      ${m.username ?? m.publicId} ${staffBadge(m.staffRole)}
                      ${m.verified ? verifiedBadge() : nothing}
                    </span>
                    <div class="font-mono text-xs text-df-text-muted">
                      ${m.publicId}
                    </div>
                  </td>
                  <td class="${TD}">
                    ${chip(m.role, m.role === "leader" ? "red" : "grey")}
                  </td>
                  <td class="${TD} text-xs text-df-text-muted">
                    ${fmtDate(m.joinedAt)}
                  </td>
                  <td class="${TD}">
                    ${this.can("admin.clans.manage") && m.role !== "leader"
                      ? html`<button
                          class="${BTN_DANGER}"
                          ?disabled=${this.busy}
                          @click=${() =>
                            this.act(
                              (r) =>
                                adminApi.clanRemoveMember(tag, m.publicId, r),
                              "confirm_clan_member",
                            )}
                        >
                          ${t("remove")}
                        </button>`
                      : nothing}
                  </td>
                </tr>`,
            )}
          </tbody>
        </table>
      </div>

      ${c.bans.length === 0
        ? nothing
        : html`<div>
            ${sectionTitle(t("clan_bans"))}
            ${c.bans.map(
              (b) =>
                html`<div class="text-xs text-df-text-secondary">
                  ${b.username ?? b.publicId} · ${b.reason ?? "-"} ·
                  ${fmtDate(b.createdAt)}
                </div>`,
            )}
          </div>`}
      ${this.can("admin.clans.delete")
        ? html`<div>
            <button
              id="admin-clan-delete"
              class="${BTN_DANGER}"
              ?disabled=${this.busy}
              @click=${() =>
                this.act(
                  (r) => adminApi.clanDelete(tag, r),
                  "confirm_clan_delete",
                  null,
                ).then(() => {
                  this.detail = null;
                })}
            >
              ${t("delete_clan")}
            </button>
          </div>`
        : nothing}
    </div>`;
  }

  render() {
    return html`<div
      class="grid lg:grid-cols-[minmax(280px,380px)_1fr] gap-4 p-4 lg:p-6"
    >
      <div class="flex flex-col gap-4 self-start">
        <div class="${CARD} flex flex-col gap-3">
          <form
            class="flex gap-2"
            @submit=${(e: Event) => {
              e.preventDefault();
              void this.search();
            }}
          >
            <input
              id="admin-clan-search"
              class="${INPUT} flex-1"
              placeholder=${t("search_clans")}
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
                  <tbody>
                    ${this.rows.map(
                      (r) =>
                        html`<tr
                          class="cursor-pointer hover:bg-white/5"
                          @click=${() => this.open(r.tag)}
                        >
                          <td class="${TD}">
                            <span class="font-mono text-df-red-bright"
                              >[${r.tag}]</span
                            >
                            ${r.name}
                          </td>
                          <td class="${TD} text-xs text-df-text-muted">
                            ${t("members", { n: r.members })}
                          </td>
                        </tr>`,
                    )}
                  </tbody>
                </table>`}
        </div>
        ${this.renderCreate()}
      </div>
      <div class="flex flex-col gap-3">
        <label class="${CARD} flex flex-col gap-1 text-xs text-df-text-muted">
          ${t("reason")}
          <input
            id="admin-clan-reason"
            class="${INPUT}"
            maxlength="200"
            placeholder=${t("reason_placeholder")}
            .value=${this.reason}
            @input=${(e: Event) =>
              (this.reason = (e.target as HTMLInputElement).value)}
          />
        </label>
        ${this.notice === null
          ? nothing
          : html`<p
              id="admin-clan-notice"
              role="status"
              class="text-sm ${this.notice.ok
                ? "text-emerald-300"
                : "text-df-red-bright"}"
            >
              ${this.notice.text}
            </p>`}
        ${this.detail === null
          ? html`<div class="${CARD} text-df-text-muted text-sm">
              ${t("select_clan")}
            </div>`
          : this.renderDetail(this.detail)}
      </div>
    </div>`;
  }
}
