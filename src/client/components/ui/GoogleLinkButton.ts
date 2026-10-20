import { assetUrl } from "@openfront/shared/AssetUrls";
import { html, TemplateResult } from "lit";
import { translateText } from "../../Utils";

/**
 * "Link Google account" button. Shared by the account modal's identity card and
 * the account-settings panel's bind-an-email state so both entry points keep
 * Google's dark-theme button (the multicolour mark on the page's own surface) in sync.
 *
 * `labelKey` overrides the caption: the desktop shell cannot run the Google
 * OAuth redirect in place and sends the player to the website instead (see
 * linkGoogle in Auth.ts), and a button that opens a browser must say so.
 */
export const googleLinkButton = (
  onClick: (event: MouseEvent) => unknown,
  labelKey: string = "account_modal.link_google",
): TemplateResult => html`
  <button
    @click=${onClick}
    class="ui-focus flex min-h-11 w-full cursor-pointer items-center justify-center gap-3 rounded-ui-card border border-ui-border-strong bg-ui-surface px-6 py-3 text-ui-text transition-colors hover:border-ui-border-hover"
  >
    <img
      src=${assetUrl("images/GoogleLogo.svg")}
      alt=${translateText("account_modal.google_alt")}
      class="w-5 h-5"
    />
    <span class="text-[14px] font-semibold">${translateText(labelKey)}</span>
  </button>
`;
