import { assetUrl } from "@openfront/shared/AssetUrls";
import { LitElement, html } from "lit";
import { customElement, state } from "lit/decorators.js";
import { BRAND } from "./Branding";
import { translateText } from "./Utils";

@customElement("game-starting-modal")
export class GameStartingModal extends LitElement {
  @state()
  isVisible = false;

  createRenderRoot() {
    return this;
  }

  render() {
    const isVisible = this.isVisible;
    return html`
      <div
        class="fixed inset-0 bg-black/70 z-[9998] transition-opacity duration-300 ${isVisible
          ? "opacity-100 visible"
          : "opacity-0 invisible"}"
      ></div>
      <div
        role="status"
        aria-live="polite"
        class="fixed top-1/2 left-1/2 bg-df-panel border border-df-border border-t-2 border-t-df-red p-6 rounded-sm z-[9999] text-df-text w-[400px] max-w-[calc(100vw-2rem)] text-center transition-all duration-300 -translate-x-1/2 ${isVisible
          ? "opacity-100 visible -translate-y-1/2"
          : "opacity-0 invisible -translate-y-[48%]"}"
      >
        <img
          src=${assetUrl("images/branding/deltafront-icon.png")}
          alt=""
          class="pixelated mx-auto mb-4 size-16 motion-safe:animate-pulse"
          draggable="false"
        />
        <p
          class="font-display text-xl font-bold tracking-widest uppercase text-df-text mb-4"
        >
          ${translateText("game_starting_modal.title")}
        </p>
        <div class="text-sm tracking-wider uppercase text-df-text-muted mb-2">
          ${translateText("main.copyright")}
        </div>
        <a
          href=${BRAND.upstreamCreditsUrl}
          target="_blank"
          rel="noopener noreferrer"
          class="inline-block mb-3 text-sm font-bold tracking-wider uppercase text-df-red-bright no-underline transition-colors duration-150 hover:text-df-text focus-visible:outline-2 focus-visible:outline-df-red"
          >${translateText("game_starting_modal.credits")}</a
        >
        <p class="text-xs text-df-text-muted">
          ${translateText("game_starting_modal.code_license")}
        </p>
      </div>
    `;
  }

  show() {
    this.isVisible = true;
    this.requestUpdate();
  }

  hide() {
    this.isVisible = false;
    this.requestUpdate();
  }
}
