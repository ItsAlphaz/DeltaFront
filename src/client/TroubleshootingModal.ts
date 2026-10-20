import { assetUrl } from "@openfront/shared/AssetUrls";
import { html, nothing } from "lit";
import { customElement, property } from "lit/decorators.js";
import { translateText } from "./Utils";
import { BaseModal } from "./components/BaseModal";
import { uiButton, uiPageHeader } from "./components/ui/PageUi";
import {
  collectGraphicsDiagnostics,
  GraphicsDiagnostics,
} from "./utilities/Diagnostic";
const infoIcon = assetUrl("images/InfoIcon.svg");

@customElement("troubleshooting-modal")
export class TroubleshootingModal extends BaseModal {
  protected routerName = "troubleshooting";

  @property({ type: String }) markdown = "Loading...";

  @property({ type: Object })
  diagnostics?: GraphicsDiagnostics;

  @property({ type: Boolean }) loading = true;

  private initialized: boolean = false;

  private async loadDiagnostics() {
    const canvas = document.createElement("canvas");
    this.diagnostics = await collectGraphicsDiagnostics(canvas);
    this.loading = false;
    this.initialized = true;
  }

  protected renderHeaderSlot() {
    return uiPageHeader({
      title: `${translateText("main.help")} / ${translateText("troubleshooting.title")}`,
      onBack: () => this.close(),
      backLabel: translateText("common.back"),
      status: uiButton({
        label: translateText("common.copy"),
        variant: "secondary",
        name: "copy",
        onClick: () => void this.copyDiagnostics(),
      }),
    });
  }

  protected renderBody() {
    if (this.loading) return html``;
    return html`
      <div class="mx-auto w-full max-w-3xl py-2">
        ${this.section(
          "",
          html`${this.infoTip(
            translateText("troubleshooting.hardware_acceleration_tip"),
            true,
          )}`,
        )}
        ${this.section(
          translateText("troubleshooting.environment"),
          html`
            ${this.row(
              translateText("troubleshooting.browser"),
              this.diagnostics!.browser.engine,
            )}
            ${this.row(
              translateText("troubleshooting.platform"),
              this.diagnostics!.browser.platform,
            )}
            ${this.row(
              translateText("troubleshooting.os"),
              this.diagnostics!.browser.os,
            )}
            ${this.row(
              translateText("troubleshooting.device_pixel_ratio"),
              this.diagnostics!.browser.dpr,
            )}
            ${this.infoTip(translateText("troubleshooting.chromium_tip"))}
          `,
        )}
        ${this.section(
          translateText("troubleshooting.rendering"),
          html`
            ${this.row(
              translateText("troubleshooting.renderer"),
              this.describeRenderer(this.diagnostics!.rendering),
            )}
            ${this.row(
              translateText("troubleshooting.max_texture_size"),
              this.diagnostics!.rendering.maxTextureSize ??
                translateText("troubleshooting.unknown"),
            )}
            ${this.row(
              translateText("troubleshooting.high_precision_shaders"),
              this.diagnostics!.rendering.shaderHighp === true
                ? translateText("troubleshooting.yes")
                : translateText("troubleshooting.no"),
            )}${this.row(
              translateText("troubleshooting.gpu"),
              !this.diagnostics!.rendering.gpu ||
                this.diagnostics!.rendering.gpu.unavailable
                ? translateText("troubleshooting.unavailable")
                : `${this.diagnostics!.rendering.gpu.vendor} — ${this.diagnostics!.rendering.gpu.renderer}`,
            )}
            ${this.infoTip(translateText("troubleshooting.gpu_tip"))}
          `,
        )}
        ${this.section(
          translateText("troubleshooting.power"),
          html`
            ${this.diagnostics!.power.unavailable
              ? this.row(
                  translateText("troubleshooting.battery"),
                  translateText("troubleshooting.unavailable"),
                )
              : html`
                  ${this.row(
                    translateText("troubleshooting.charging"),
                    this.diagnostics!.power.charging
                      ? translateText("troubleshooting.yes")
                      : translateText("troubleshooting.no"),
                  )}
                  ${this.row(
                    translateText("troubleshooting.battery_level"),
                    this.diagnostics!.power.level,
                  )}
                `}
            ${this.infoTip(translateText("troubleshooting.power_saving_tip"))}
          `,
        )}
      </div>
    `;
  }

  private infoTip(text: string, warning?: boolean): unknown {
    return html`
      <div
        class="ui-body mt-3 flex items-center gap-3 rounded-ui-card border px-4 py-3 text-[13px] ${warning
          ? "border-ui-gold/40 bg-ui-gold/10 text-ui-gold"
          : "border-ui-border bg-ui-surface text-ui-muted"}"
      >
        <img src="${infoIcon}" alt="" class="w-4 shrink-0" />
        ${text}
      </div>
    `;
  }

  protected onOpen(): void {
    if (!this.initialized) {
      this.initialized = true;
      this.loadDiagnostics();
    }
  }

  private section(title: string, content: unknown) {
    return html`
      <section class="px-6 py-4">
        ${title ? html`<h2 class="ui-label mb-3">${title}</h2>` : nothing}
        <div class="space-y-1">${content}</div>
      </section>
    `;
  }

  private row(label: string, value: unknown) {
    return html`
      <div
        class="ui-body flex min-h-9 items-center justify-between gap-4 border-b border-ui-border last:border-b-0"
      >
        <span class="text-ui-muted">${label}</span>
        <span class="ui-mono max-w-[60%] text-right text-[13px] text-ui-text"
          >${value}</span
        >
      </div>
    `;
  }

  private async copyDiagnostics() {
    if (!this.diagnostics) return;
    const formatted =
      "```json\n" + JSON.stringify(this.diagnostics, null, 2) + "\n```";
    await navigator.clipboard.writeText(formatted);
    window.dispatchEvent(
      new CustomEvent("show-message", {
        detail: {
          message: html`${translateText("troubleshooting.copied_to_clipboard")}`,
          type: "info",
          duration: 3000,
        },
      }),
    );
  }

  private describeRenderer(rendering: any): string {
    if (rendering.gpu?.software) {
      return translateText("troubleshooting.software_rendering");
    }
    if (rendering.type === "Canvas2D") {
      return translateText("troubleshooting.canvas_2d_no_gpu");
    }
    return `${rendering.type}`;
  }

  public close(): void {
    // Override BaseModal.close() to navigate back to Help (this modal is
    // opened from inside HelpModal), not to page-play like other inline modals.
    // Main's game-start sweep closes it unopened; that must not reopen Help.
    const wasOpen = this.isOpen();
    this.unregisterEscapeHandler();
    this.onClose();
    if (this.inline) {
      this.style.pointerEvents = "none";
      if (wasOpen) window.showPage?.("page-help");
    } else {
      this.modalEl?.close();
    }
  }
}
