import { LitElement, html } from "lit";
import { customElement } from "lit/decorators.js";

@customElement("main-layout")
export class MainLayout extends LitElement {
  private _initialChildren: Node[] = [];

  createRenderRoot() {
    return this;
  }

  connectedCallback() {
    if (this._initialChildren.length === 0 && this.childNodes.length > 0) {
      this._initialChildren = Array.from(this.childNodes);
    }
    super.connectedCallback();
  }

  // The homepage spans 75rem (its centred controls and the full-width
  // Upcoming row); inline pages (settings, help, ...) keep the narrower
  // column they were designed for.
  render() {
    return html`
      <main
        class="relative [.in-game_&]:hidden flex flex-col flex-1 min-h-0 w-full px-0 lg:px-[clamp(1.5rem,3vw,3rem)] pt-0 lg:pt-[clamp(0.75rem,1.5vw,1.5rem)] pb-0 lg:pb-[clamp(0.375rem,0.75vw,0.75rem)]"
      >
        <div
          class="w-full lg:max-w-[75rem] in-[.page-open]:lg:max-w-[20cm] in-[.page-open]:2xl:max-w-[24cm] desktop:in-[.page-open]:lg:max-w-[min(100%,clamp(80rem,50%,90rem))] mx-auto flex flex-col flex-1 min-h-0 gap-0 lg:gap-[clamp(1.5rem,3vw,3rem)] overflow-x-clip sm:px-4 lg:px-0"
        >
          ${this._initialChildren}
        </div>
      </main>
    `;
  }
}
