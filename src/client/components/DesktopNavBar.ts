import { ACCOUNT_FEATURES } from "@openfront/shared/AccountFeatures";
import { LitElement, html } from "lit";
import { customElement } from "lit/decorators.js";
import "./NavAccountMenu";
import { NavNotificationsController } from "./NavNotificationsController";
import "./NavUtilityIcons";

// Page links: pixel face, white on hover, a red underline marks the open page.
const NAV_ITEM =
  "nav-menu-item font-display text-base text-df-text-secondary hover:text-df-text tracking-[0.15em] uppercase cursor-pointer transition-colors px-1 pt-2.5 pb-2 border-b-2 border-transparent focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-df-red [&.active]:text-df-text [&.active]:border-df-red";

@customElement("desktop-nav-bar")
export class DesktopNavBar extends LitElement {
  private _notifications = new NavNotificationsController(this);

  createRenderRoot() {
    return this;
  }

  connectedCallback() {
    super.connectedCallback();
    window.addEventListener("showPage", this._onShowPage);

    const current = window.currentPageId;
    if (current) {
      // Wait for render
      this.updateComplete.then(() => {
        this._updateActiveState(current);
      });
    }
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    window.removeEventListener("showPage", this._onShowPage);
  }

  private _onShowPage = (e: Event) => {
    const pageId = (e as CustomEvent).detail;
    this._updateActiveState(pageId);
  };

  private _updateActiveState(pageId: string) {
    this.querySelectorAll(".nav-menu-item").forEach((el) => {
      if ((el as HTMLElement).dataset.page === pageId) {
        el.classList.add("active");
      } else {
        el.classList.remove("active");
      }
    });
  }

  render() {
    window.currentPageId ??= "page-play";
    const currentPage = window.currentPageId;
    const active = (page: string) => (currentPage === page ? "active" : "");

    return html`
      <!-- Minimal header over the page grid: page links on the left, the
           utility icons (and the account menu, when accounts are on) on the
           right. The logo and version live in the play page's hero. -->
      <nav
        class="hidden lg:flex w-full h-[66px] items-center justify-between pl-8 pr-10 shrink-0 z-50 relative"
      >
        <div class="flex items-center gap-8">
          <button
            class="${NAV_ITEM} ${active("page-play")}"
            data-page="page-play"
            data-i18n="main.play"
          ></button>
          <!-- Store, inventory, leaderboards and clans need the account
               backend and are each hidden until their feature is on
               (ACCOUNT_FEATURES). -->
          ${ACCOUNT_FEATURES.store
            ? html`<div class="relative no-crazygames">
                <button
                  class="${NAV_ITEM} ${active("page-item-store")}"
                  data-page="page-item-store"
                  data-i18n="main.store"
                  @click=${this._notifications.onStoreClick}
                ></button>
                ${this._notifications.showStoreDot()
                  ? html`
                      <span
                        class="absolute -top-1 -right-1 w-2 h-2 bg-df-red-bright rounded-full animate-ping"
                      ></span>
                      <span
                        class="absolute -top-1 -right-1 w-2 h-2 bg-df-red-bright rounded-full"
                      ></span>
                    `
                  : ""}
              </div>`
            : ""}
          ${ACCOUNT_FEATURES.inventory
            ? html`<button
                class="${NAV_ITEM} ${active("page-inventory")}"
                data-page="page-inventory"
                data-i18n="main.inventory"
              ></button>`
            : ""}
          ${ACCOUNT_FEATURES.leaderboards
            ? html`<button
                class="${NAV_ITEM}"
                data-page="page-leaderboard"
                data-i18n="main.leaderboard"
              ></button>`
            : ""}
          ${ACCOUNT_FEATURES.clans
            ? html`<button
                class="no-crazygames ${NAV_ITEM}"
                data-page="page-clan"
                data-i18n="main.clans"
              ></button>`
            : ""}
        </div>
        <!-- Utility cluster: bell, help, settings and the profile control are
             account/notification/utility affordances rather than page links. -->
        <div class="flex items-center gap-2">
          <nav-utility-icons size="desktop"></nav-utility-icons>
          ${ACCOUNT_FEATURES.accounts
            ? html`<nav-account-menu variant="desktop"></nav-account-menu>`
            : ""}
        </div>
      </nav>
    `;
  }
}
