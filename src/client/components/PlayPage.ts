import { ACCOUNT_FEATURES } from "@openfront/shared/AccountFeatures";
import { assetUrl } from "@openfront/shared/AssetUrls";
import { LitElement, html } from "lit";
import { customElement } from "lit/decorators.js";
import "./CosmeticBackground";
import "./NavAccountMenu";
import "./NavUtilityIcons";
import "./NewsBox";
import "./SteamWishlist";
import "./StreamingNow";

@customElement("play-page")
export class PlayPage extends LitElement {
  createRenderRoot() {
    return this;
  }

  render() {
    return html`
      <!-- Desktop: fills the space between header and footer and sizes every
           section from the viewport height (.df-home in styles.css), so the
           whole homepage fits one screen. Spare height centres the stack,
           keeping the space above the logo equal to the space below the cards
           (the bottom padding tops up main-layout's half-height bottom pad). -->
      <div
        id="page-play"
        class="df-home flex flex-col w-full min-h-0 lg:flex-1 lg:justify-center lg:pb-[clamp(0.375rem,0.75vw,0.75rem)]"
      >
        <token-login class="absolute"></token-login>
        <rewards-modal class="absolute"></rewards-modal>

        <!-- Mobile: Fixed top bar -->
        <div
          class="lg:hidden fixed left-0 right-0 top-[var(--top-ad-height,0px)] z-40 pt-[env(safe-area-inset-top)] bg-df-bg-secondary border-b border-df-border"
        >
          <div
            class="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center h-14 px-2 gap-2"
          >
            <button
              id="hamburger-btn"
              class="col-start-1 justify-self-start h-10 shrink-0 aspect-[4/3] flex text-df-text hover:text-df-red-bright focus-visible:outline-2 focus-visible:outline-df-red items-center justify-center transition-colors"
              data-i18n-aria-label="main.menu"
              aria-expanded="false"
              aria-controls="sidebar-menu"
              aria-haspopup="dialog"
              data-i18n-title="main.menu"
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                fill="none"
                viewBox="0 0 24 24"
                stroke-width="1.5"
                stroke="currentColor"
                class="size-8"
              >
                <path
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  d="M3.75 6.75h16.5M3.75 12h16.5m-16.5 5.25h16.5"
                />
              </svg>
            </button>

            <div
              class="col-start-2 flex h-7 max-w-[28vw] items-center justify-center min-w-0"
            >
              <img
                src=${assetUrl("images/branding/deltafront-logo.png")}
                alt="DeltaFront"
                class="pixelated h-full w-auto max-w-full object-contain"
              />
            </div>

            <!-- Right slot: bell, help, settings and the profile control. The menu is
                 the account affordance on every platform now — on CrazyGames
                 its "Sign in" item hands off to their SDK prompt. -->
            <div
              class="col-start-3 justify-self-end shrink-0 flex items-center gap-0.5"
            >
              <nav-utility-icons size="mobile"></nav-utility-icons>
              ${ACCOUNT_FEATURES.accounts
                ? html`<nav-account-menu variant="mobile"></nav-account-menu>`
                : ""}
            </div>
          </div>
        </div>

        <!-- Mobile: spacer for the fixed top bar, then the news card. Desktop
             shows news as a strip above the header (index.html). -->
        <div class="lg:hidden h-[calc(env(safe-area-inset-top)+56px)]"></div>
        <news-box class="lg:hidden"></news-box>

        <!-- Hero (desktop): the wordmark and the build's version, centred. The
             version is stamped into .game-version-display at boot
             (renderNavVersion), as it is in the nav drawer. -->
        <div class="hidden lg:flex flex-col items-center shrink-0">
          <img
            src=${assetUrl("images/branding/deltafront-logo.png")}
            alt="DeltaFront"
            class="pixelated block h-(--df-logo) w-auto"
            draggable="false"
          />
          <div
            class="game-version-display mt-0.5 text-(length:--df-version) leading-none tracking-[0.2em] text-df-text-muted"
            translate="no"
          ></div>
        </div>

        <!-- Identity panel: the player's name over their selected cosmetic
             background, in the centred 480px control column. -->
        <div
          class="mx-auto w-full max-w-[480px] shrink-0 px-4 pt-4 sm:px-0 lg:pt-0 lg:mt-(--df-gap)"
        >
          <div
            class="relative flex h-16 lg:h-(--df-name) items-center overflow-visible rounded-sm border border-df-border bg-df-panel"
          >
            <!-- Selected skin/pattern fills the panel like the player's territory in game. -->
            <cosmetic-background
              class="absolute inset-0 z-0 overflow-hidden rounded-sm pointer-events-none"
            ></cosmetic-background>
            <div
              class="relative z-10 flex h-full w-full min-w-0 items-center bg-df-panel/80 p-1"
            >
              <username-input class="flex-1 min-w-0 h-full"></username-input>
            </div>
          </div>
        </div>

        <!-- Takes the remaining height (the cards grow into it) but never more
           than its controls plus the cards' cap, so leftover space centres
           the page instead of stretching the cards. -->
        <game-mode-selector
          class="block mt-3 lg:mt-(--df-gap-a) lg:flex lg:flex-col lg:flex-1 lg:min-h-0 lg:max-h-[calc(var(--df-solo)+var(--df-gap-a)+var(--df-row)+var(--df-gap-up)+36px+var(--df-cards-max))]"
        ></game-mode-selector>

        <!-- Streaming Now: kept mounted but hidden; the one-screen desktop
             homepage has no room for it, and its feed needs the account
             backend (off). -->
        <streaming-now class="hidden"></streaming-now>

        <!-- Desktop gets the compact footer button instead. -->
        <steam-wishlist
          campaign="home_mobile"
          class="block px-2 pb-4 lg:hidden"
        ></steam-wishlist>
      </div>
    `;
  }
}
