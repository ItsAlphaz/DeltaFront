import type { AdminMe } from "@openfront/shared/AdminSchemas";
import {
  hasPermission,
  type Permission,
  type StaffRole,
} from "@openfront/shared/Permissions";
import { html, TemplateResult } from "lit";
import { customElement, state } from "lit/decorators.js";
import { adminApi } from "./AdminApi";
import "./admin/AdminAuditView";
import "./admin/AdminClansView";
import "./admin/AdminDashboardView";
import "./admin/AdminServerView";
import { chip, errorText, t } from "./admin/AdminUi";
import "./admin/AdminUsersView";
import { BaseModal } from "./components/BaseModal";
import { modalHeader } from "./components/ui/ModalHeader";
import { staffBadge, staffRoleLabel } from "./components/ui/StaffBadge";

const TABS: ReadonlyArray<{
  key: string;
  label: string;
  permission: Permission;
}> = [
  {
    key: "dashboard",
    label: "tab_dashboard",
    permission: "admin.dashboard.view",
  },
  { key: "users", label: "tab_users", permission: "admin.users.view" },
  { key: "clans", label: "tab_clans", permission: "admin.clans.view" },
  {
    key: "audit",
    label: "tab_audit",
    permission: "admin.audit.view_moderation",
  },
  { key: "server", label: "tab_server", permission: "admin.server.view" },
];

/**
 * The web admin panel (#modal=admin). What it shows follows the staff role, but
 * that is presentation only: every request it makes is authorized again by the
 * API from the account's role in the database.
 */
@customElement("admin-modal")
export class AdminModal extends BaseModal {
  protected routerName = "admin";

  @state() private me: AdminMe | null = null;
  @state() private status: "loading" | "ready" | "denied" | "signed_out" =
    "loading";
  @state() private message = "";

  protected modalConfig() {
    if (this.status !== "ready" || this.me === null) return {};
    const me = this.me;
    return {
      tabs: TABS.filter((tab) => hasPermission(me.role, tab.permission)).map(
        (tab) => ({ key: tab.key, label: t(tab.label) }),
      ),
    };
  }

  protected renderHeaderSlot() {
    return modalHeader({
      title: t("title"),
      onBack: () => this.close(),
      ariaLabel: t("back"),
      rightContent: this.me
        ? html`<span class="inline-flex items-center gap-2">
            ${staffBadge(this.me.role as StaffRole, "w-5 h-5")}
            ${chip(staffRoleLabel(this.me.role), "red")}
          </span>`
        : undefined,
    });
  }

  protected onOpen(): void {
    void this.loadMe();
  }

  private async loadMe() {
    this.status = "loading";
    const result = await adminApi.me();
    if (result.ok) {
      this.me = result.data;
      this.status = "ready";
      return;
    }
    this.me = null;
    this.status = result.status === 401 ? "signed_out" : "denied";
    this.message = errorText(result);
  }

  protected renderBody(tab: string): TemplateResult {
    if (this.status === "loading") {
      return html`<p class="p-6 text-df-text-muted">${t("loading")}</p>`;
    }
    if (this.status !== "ready" || this.me === null) {
      return html`<div class="p-6 flex flex-col gap-2" id="admin-denied">
        <h2 class="text-lg font-bold text-df-red-bright">
          ${t("denied_title")}
        </h2>
        <p class="text-df-text-secondary">${this.message}</p>
      </div>`;
    }
    switch (tab) {
      case "users":
        return html`<admin-users-view .me=${this.me}></admin-users-view>`;
      case "clans":
        return html`<admin-clans-view .me=${this.me}></admin-clans-view>`;
      case "audit":
        return html`<admin-audit-view .me=${this.me}></admin-audit-view>`;
      case "server":
        return html`<admin-server-view></admin-server-view>`;
      default:
        return html`<admin-dashboard-view></admin-dashboard-view>`;
    }
  }
}
