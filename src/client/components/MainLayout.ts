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
  // Upcoming row); every inline page (store, settings, help, ...) takes the
  // design system's 1240px column.
  render() {
    return html`
      <main
        class="relative [.in-game_&]:hidden flex flex-col flex-1 min-h-0 w-full px-0 lg:px-[clamp(1.5rem,3vw,3rem)] pt-0 lg:pt-[clamp(0.75rem,1.5vw,1.5rem)] pb-0 lg:pb-[clamp(0.375rem,0.75vw,0.75rem)]"
      >
        <div
          class="w-full lg:max-w-[75rem] in-[.page-open]:lg:max-w-[1240px] in-[.page-open]:2xl:max-w-[1240px] desktop:in-[.page-open]:lg:max-w-[1240px] mx-auto flex flex-col flex-1 min-h-0 gap-0 lg:gap-[clamp(1.5rem,3vw,3rem)] overflow-x-clip sm:px-4 lg:px-0"
        >
          ${this._initialChildren}
        </div>
      </main>
    `;
  }
}
