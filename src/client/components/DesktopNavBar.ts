import { ACCOUNT_FEATURES } from "@openfront/shared/AccountFeatures";
import { assetUrl } from "@openfront/shared/AssetUrls";
import { LitElement, html } from "lit";
import { customElement } from "lit/decorators.js";
import "./NavAccountMenu";
import { NavNotificationsController } from "./NavNotificationsController";
import "./NavUtilityIcons";

// Page links: pixel face, white on hover, a red underline marks the open page.
const NAV_ITEM =
  "nav-menu-item font-display text-[15px] text-df-text-secondary hover:text-df-text font-bold tracking-widest uppercase cursor-pointer transition-colors py-1 border-b-2 border-transparent focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-df-red [&.active]:text-df-text [&.active]:border-df-red";

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
      <nav
        class="hidden lg:flex w-full bg-df-bg-secondary border-b border-df-border items-center justify-center gap-8 py-3 shrink-0 z-50 relative"
      >
        <div class="flex flex-col items-center justify-center">
          <div class="h-8">
            <img
              class="pixelated block h-full w-auto"
              src=${assetUrl("images/branding/deltafront-logo.png")}
              alt="DeltaFront"
            />
          </div>
          <div
            id="game-version"
            class="l-header__highlightText text-center"
          ></div>
        </div>
        <button
          class="${NAV_ITEM} ${active("page-play")}"
          data-page="page-play"
          data-i18n="main.play"
        ></button>
        <!-- Desktop Navigation Menu Items. Store, inventory, leaderboards and
             clans need the account backend and are hidden without it
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
        ${ACCOUNT_FEATURES.store
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
        <!-- Utility cluster: bell, help, settings and the profile control are
             account/notification/utility affordances rather than page links,
             so they sit tight together behind a divider instead of in the nav
             item list. -->
        <div
          class="flex items-center gap-1 pl-5 ml-1 border-l border-df-border"
        >
          <nav-utility-icons size="desktop"></nav-utility-icons>
          ${ACCOUNT_FEATURES.accounts
            ? html`<nav-account-menu variant="desktop"></nav-account-menu>`
            : ""}
        </div>
      </nav>
    `;
  }
}
