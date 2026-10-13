import { assetUrl } from "@openfront/shared/AssetUrls";
import { html, LitElement } from "lit";
import { customElement, property } from "lit/decorators.js";
import { translateText } from "../Utils";

/** The DeltaFront Credits coin: the icon of the one virtual currency. */
@customElement("credits-icon")
export class CreditsIcon extends LitElement {
  @property({ type: Number })
  size: number = 48;

  createRenderRoot() {
    return this;
  }

  render() {
    return html`
      <div
        class="inline-flex items-center justify-center"
        style="width:${this.size}px; height:${this.size}px;"
      >
        <img
          src=${assetUrl("images/CreditsIcon.svg")}
          alt=${translateText("cosmetics.soft")}
          style="width:${this.size}px; height:${this.size}px;"
          draggable="false"
        />
      </div>
    `;
  }
}
