import type { AdminServerInfo } from "@openfront/shared/AdminSchemas";
import { html, LitElement, nothing } from "lit";
import { customElement, state } from "lit/decorators.js";
import { adminApi } from "../AdminApi";
import {
  ago,
  BTN,
  CARD,
  chip,
  errorText,
  sectionTitle,
  t,
  TABLE,
  TD,
  TH,
} from "./AdminUi";

/** Read-only server information: health, readiness, version and the game servers. */
@customElement("admin-server-view")
export class AdminServerView extends LitElement {
  @state() private info: AdminServerInfo | null = null;
  @state() private error: string | null = null;

  createRenderRoot() {
    return this;
  }

  connectedCallback() {
    super.connectedCallback();
    void this.load();
  }

  private async load() {
    const result = await adminApi.server();
    if (result.ok) {
      this.info = result.data;
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
    const i = this.info;
    if (i === null)
      return html`<p class="text-df-text-muted p-4">${t("loading")}</p>`;
    return html`<div class="flex flex-col gap-4 p-4 lg:p-6" id="admin-server">
      <div class="${CARD} flex flex-col gap-2">
        ${sectionTitle(t("api"))}
        <div class="flex flex-wrap items-center gap-2">
          ${chip(
            i.readiness.ready ? t("health_ok") : t("health_degraded"),
            i.readiness.ready ? "green" : "red",
          )}
          ${chip(i.environment, "white")}
          <span class="text-sm text-df-text-secondary"
            >${t("release", { version: i.version })}</span
          >
          ${i.commit === null
            ? nothing
            : html`<span class="font-mono text-sm"
                >${i.commit.slice(0, 7)}</span
              >`}
          <button class="${BTN} ml-auto" @click=${() => this.load()}>
            ${t("refresh")}
          </button>
        </div>
        <div class="flex flex-wrap gap-2">
          ${Object.entries(i.readiness.checks).map(
            ([name, state]) =>
              html`<span class="text-xs text-df-text-secondary"
                >${name}:
                ${chip(
                  state,
                  state === "ok" || state === "off" ? "green" : "red",
                )}</span
              >`,
          )}
        </div>
        <div class="text-xs text-df-text-muted">
          ${t("features")}: ${i.features.join(", ") || "-"} ·
          ${t("uptime", { minutes: Math.floor(i.uptimeSeconds / 60) })}
        </div>
      </div>
      <div class="${CARD}">
        ${sectionTitle(t("game_servers"))}
        ${i.servers.length === 0
          ? html`<p class="text-sm text-df-text-muted">${t("none")}</p>`
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
                ${i.servers.map(
                  (s) =>
                    html`<tr>
                      <td class="${TD} font-mono">${s.letter} · ${s.site}</td>
                      <td class="${TD}">
                        ${s.online
                          ? chip(t("chip_online"), "green")
                          : chip(t("chip_offline"), "red")}
                        ${s.state === "open" ? nothing : chip(s.state, "amber")}
                      </td>
                      <td class="${TD} font-mono text-xs">
                        ${s.version.slice(0, 7)}
                      </td>
                      <td class="${TD}">${s.numWorkers}</td>
                      <td class="${TD}">${s.liveGames}</td>
                      <td class="${TD} text-xs text-df-text-muted">
                        ${ago(s.lastCheckinAt)}
                      </td>
                    </tr>`,
                )}
              </tbody>
            </table>`}
        <p class="text-xs text-df-text-muted mt-3">
          ${t("server_readonly_note")}
        </p>
      </div>
    </div>`;
  }
}
