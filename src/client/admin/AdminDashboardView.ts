import type { AdminDashboard } from "@openfront/shared/AdminSchemas";
import { html, LitElement, nothing } from "lit";
import { customElement, state } from "lit/decorators.js";
import { adminApi } from "../AdminApi";
import {
  accountChips,
  ago,
  BTN,
  CARD,
  chip,
  errorText,
  fmtDate,
  sectionTitle,
  stat,
  t,
  TABLE,
  TD,
  TH,
} from "./AdminUi";

/** The dashboard: how the game and the API are doing right now. */
@customElement("admin-dashboard-view")
export class AdminDashboardView extends LitElement {
  @state() private data: AdminDashboard | null = null;
  @state() private error: string | null = null;
  @state() private loading = false;

  createRenderRoot() {
    return this;
  }

  connectedCallback() {
    super.connectedCallback();
    void this.refresh();
  }

  private async refresh() {
    this.loading = true;
    const result = await adminApi.dashboard();
    this.loading = false;
    if (result.ok) {
      this.data = result.data;
      this.error = null;
    } else {
      this.error = errorText(result);
    }
  }

  render() {
    if (this.error !== null) {
      return html`<p class="text-df-red-bright p-4" role="alert">
        ${this.error}
      </p>`;
    }
    const d = this.data;
    if (d === null) {
      return html`<p class="text-df-text-muted p-4">${t("loading")}</p>`;
    }
    const health = d.health;
    const healthy =
      health.database === "ok" &&
      health.migrations === "ok" &&
      health.signingKey === "ok";
    return html`
      <div class="flex flex-col gap-6 p-4 lg:p-6" id="admin-dashboard">
        <div class="flex flex-wrap items-center gap-3">
          ${chip(
            healthy ? t("health_ok") : t("health_degraded"),
            healthy ? "green" : "red",
          )}
          <span class="text-sm text-df-text-secondary"
            >${t("release", { version: d.version })}
            ${d.commit === null
              ? nothing
              : html`<span class="font-mono"
                  >${d.commit.slice(0, 7)}</span
                >`}</span
          >
          <span class="text-sm text-df-text-muted"
            >${t("uptime", { minutes: Math.floor(d.uptimeSeconds / 60) })}</span
          >
          <button
            class="${BTN} ml-auto"
            ?disabled=${this.loading}
            @click=${() => this.refresh()}
          >
            ${t("refresh")}
          </button>
        </div>

        <div class="grid grid-cols-2 lg:grid-cols-4 gap-3">
          ${stat(t("stat_active_accounts"), d.counts.activeAccounts5m)}
          ${stat(t("stat_live_games"), d.counts.liveGames)}
          ${stat(t("stat_registered"), d.counts.registeredUsers)}
          ${stat(t("stat_guests"), d.counts.guests)}
          ${stat(t("stat_new_24h"), d.counts.newUsers24h)}
          ${stat(t("stat_new_7d"), d.counts.newUsers7d)}
          ${stat(t("stat_bans"), d.counts.activeBans)}
          ${stat(t("stat_clans"), d.counts.clans)}
        </div>
        <p class="text-xs text-df-text-muted -mt-3">${t("active_note")}</p>

        <div class="grid lg:grid-cols-2 gap-4">
          <div class="${CARD}">
            ${sectionTitle(t("recent_registrations"))}
            <table class="${TABLE}">
              <tbody>
                ${d.recentRegistrations.map(
                  (u) =>
                    html`<tr>
                      <td class="${TD}">
                        <span class="font-mono text-xs text-df-text-secondary"
                          >${u.publicId}</span
                        >
                        <div class="text-df-text">${u.username ?? "-"}</div>
                      </td>
                      <td class="${TD}">${accountChips(u)}</td>
                      <td class="${TD} text-df-text-muted text-xs">
                        ${ago(u.createdAt)}
                      </td>
                    </tr>`,
                )}
              </tbody>
            </table>
          </div>
          <div class="${CARD}">
            ${sectionTitle(t("recent_bans"))}
            ${d.recentBans.length === 0
              ? html`<p class="text-df-text-muted text-sm">${t("none")}</p>`
              : html`<table class="${TABLE}">
                  <tbody>
                    ${d.recentBans.map(
                      (b) =>
                        html`<tr>
                          <td class="${TD}">
                            <span
                              class="font-mono text-xs text-df-text-secondary"
                              >${b.publicId}</span
                            >
                            <div class="text-df-text">${b.username ?? "-"}</div>
                          </td>
                          <td class="${TD}">${chip(b.category, "red")}</td>
                          <td class="${TD} text-df-text-muted text-xs">
                            ${fmtDate(b.createdAt)}
                          </td>
                        </tr>`,
                    )}
                  </tbody>
                </table>`}
          </div>
        </div>

        <div class="${CARD}">
          ${sectionTitle(t("game_servers"))}
          ${d.servers.length === 0
            ? html`<p class="text-df-text-muted text-sm">${t("none")}</p>`
            : html`<table class="${TABLE}">
                <thead>
                  <tr>
                    <th class="${TH}">${t("col_server")}</th>
                    <th class="${TH}">${t("col_status")}</th>
                    <th class="${TH}">${t("col_commit")}</th>
                    <th class="${TH}">${t("col_workers")}</th>
                    <th class="${TH}">${t("col_games")}</th>
                    <th class="${TH}">${t("col_last_seen")}</th>
                  </tr>
                </thead>
                <tbody>
                  ${d.servers.map(
                    (s) =>
                      html`<tr>
                        <td class="${TD} font-mono">${s.letter} · ${s.site}</td>
                        <td class="${TD}">
                          ${s.online
                            ? chip(t("chip_online"), "green")
                            : chip(t("chip_offline"), "red")}
                          ${s.state === "open"
                            ? nothing
                            : chip(s.state, "amber")}
                        </td>
                        <td class="${TD} font-mono text-xs">
                          ${s.version.slice(0, 7)}
                        </td>
                        <td class="${TD}">${s.numWorkers}</td>
                        <td class="${TD}">${s.liveGames}</td>
                        <td class="${TD} text-df-text-muted text-xs">
                          ${ago(s.lastCheckinAt)}
                        </td>
                      </tr>`,
                  )}
                </tbody>
              </table>`}
        </div>
      </div>
    `;
  }
}
