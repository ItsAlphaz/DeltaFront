import { LitElement, html } from "lit";
import { customElement, property, query, state } from "lit/decorators.js";
import { translateText } from "../../Utils";
import { documentStylesSheet } from "./SharedStyles";

export type OModalTab = { key: string; label: string };

@customElement("o-modal")
export class OModal extends LitElement {
  static styles = [documentStylesSheet()];

  @state() public isModalOpen = false;

  @query("[data-modal-scroll]") private scrollContainer?: HTMLElement;

  static openCount = 0;

  @property({ type: Boolean })
  public inline = false;

  @property({ type: Boolean })
  public alwaysMaximized = false;

  @property({ type: Boolean })
  public hideCloseButton = false;

  @property({ type: String })
  public title = "";

  @property({ type: Boolean })
  public hideHeader = false;

  /**
   * The website's shell (components/ui/PageUi.ts): a dark panel with the
   * design system's 16px radius and border, the full width of its column.
   * Every page and dialog uses it; `false` gives the translucent glass.
   */
  @property({ type: Boolean })
  public ui = true;

  @property({ type: String })
  public maxWidth = "";

  @property({ type: Array })
  public tabs: OModalTab[] = [];

  @property({ type: String })
  public activeTab = "";

  @property({ attribute: false })
  public onTabChange?: (key: string) => void;

  public onClose?: () => void;

  public open() {
    if (!this.isModalOpen) {
      if (!this.inline) {
        OModal.openCount = OModal.openCount + 1;
        if (OModal.openCount === 1) document.body.style.overflow = "hidden";
      }
      this.isModalOpen = true;
    }
  }

  public close() {
    if (this.isModalOpen) {
      this.isModalOpen = false;
      this.onClose?.();
      if (!this.inline) {
        OModal.openCount = Math.max(0, OModal.openCount - 1);
        if (OModal.openCount === 0) document.body.style.overflow = "";
      }
    }
  }

  public getScrollTop(): number {
    return this.scrollContainer?.scrollTop ?? 0;
  }

  public setScrollTop(scrollTop: number): void {
    if (this.scrollContainer) {
      this.scrollContainer.scrollTop = scrollTop;
    }
  }

  disconnectedCallback() {
    // Ensure global counter is decremented if this modal is removed while open.
    if (this.isModalOpen && !this.inline) {
      OModal.openCount = Math.max(0, OModal.openCount - 1);
      if (OModal.openCount === 0) document.body.style.overflow = "";
    }
    super.disconnectedCallback();
  }

  private handleTabClick(key: string) {
    this.onTabChange?.(key);
  }

  private renderTabs() {
    return html`
      <div
        role="tablist"
        class="flex gap-6 overflow-x-auto overflow-y-hidden border-b border-ui-border px-4 lg:px-6 shrink-0 font-ui"
      >
        ${this.tabs.map((tab) => {
          const active = this.activeTab === tab.key;
          return html`
            <button
              type="button"
              role="tab"
              data-key=${tab.key}
              aria-selected=${active}
              class="ui-focus -mb-px flex h-[52px] shrink-0 items-center whitespace-nowrap border-b-2 text-[14px] font-semibold transition-colors cursor-pointer ${active
                ? "border-ui-accent text-ui-text"
                : "border-transparent text-ui-muted hover:text-ui-text"}"
              @click=${() => this.handleTabClick(tab.key)}
            >
              ${tab.label}
            </button>
          `;
        })}
      </div>
    `;
  }

  render() {
    const shouldRender = this.isModalOpen || this.inline;
    if (!shouldRender) {
      return html``;
    }

    const backdropClass = this.inline
      ? "relative z-10 w-full h-full flex items-stretch bg-transparent"
      : "fixed inset-0 z-[9999] bg-black/60 flex items-center justify-center overflow-hidden";

    const wrapperClass = this.inline
      ? "relative flex flex-col w-full h-full m-0 max-w-full max-h-none shadow-none"
      : `relative flex flex-col w-full h-full lg:w-[90%] lg:h-auto lg:min-w-[400px] lg:max-w-[900px] lg:m-8 lg:rounded-ui-modal lg:max-h-[calc(100vh-4rem)] ${
          this.alwaysMaximized ? "h-auto" : ""
        }`;
    const wrapperStyle =
      !this.inline && this.maxWidth ? `max-width: ${this.maxWidth};` : "";

    const hasTabs = this.tabs.length > 0;
    const sectionClass = this.ui
      ? "relative flex-1 min-h-0 flex flex-col text-ui-text bg-ui-panel lg:rounded-ui-modal lg:border border-ui-border overflow-hidden font-ui"
      : "relative flex-1 min-h-0 flex flex-col text-white bg-black/70 backdrop-blur-xl lg:rounded-2xl lg:border border-white/10 overflow-hidden";

    return html`
      <aside
        class="${backdropClass}"
        @click=${this.inline ? null : () => this.close()}
      >
        <div
          @click=${(e: Event) => e.stopPropagation()}
          class="${wrapperClass}"
          style="${wrapperStyle}"
        >
          ${this.inline || this.hideCloseButton
            ? html``
            : html`<button
                type="button"
                aria-label=${translateText("common.close")}
                class="ui-focus absolute top-5 right-5 z-10 flex h-11 w-11 items-center justify-center rounded-ui-card border border-ui-border-strong bg-ui-surface text-ui-muted transition-colors hover:border-ui-border-hover hover:text-ui-text cursor-pointer"
                @click=${() => this.close()}
              >
                ✕
              </button>`}
          ${!this.hideHeader && this.title
            ? html`<div
                class="px-[1.4rem] py-[1rem] text-2xl font-bold text-white"
              >
                ${this.title}
              </div>`
            : html``}
          <section class="${sectionClass}">
            <slot name="header"></slot>
            ${hasTabs ? this.renderTabs() : html``}
            <div data-modal-scroll class="flex-1 min-h-0 overflow-y-auto">
              <slot></slot>
            </div>
          </section>
        </div>
      </aside>
    `;
  }
}
