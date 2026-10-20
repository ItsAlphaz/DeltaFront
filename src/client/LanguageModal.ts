import { assetUrl } from "@openfront/shared/AssetUrls";
import { html, TemplateResult } from "lit";
import { customElement, property } from "lit/decorators.js";
import { translateText } from "../client/Utils";
import { BaseModal } from "./components/BaseModal";
import { uiIcons, uiPageHeader } from "./components/ui/PageUi";

interface LanguageOption {
  code: string;
  svg: string;
  native: string;
  en: string;
}

@customElement("language-modal")
export class LanguageModal extends BaseModal {
  protected routerName = "language";

  @property({ type: Array }) languageList: LanguageOption[] = [];
  @property({ type: String }) currentLang = "en";

  private selectLanguage = (lang: string) => {
    this.dispatchEvent(
      new CustomEvent("language-selected", {
        detail: { lang },
        bubbles: true,
        composed: true,
      }),
    );
    this.close();
  };

  protected renderHeaderSlot() {
    return uiPageHeader({
      title: translateText("select_lang.title"),
      onBack: () => this.close(),
      backLabel: translateText("common.back"),
    });
  }

  protected renderBody(): TemplateResult {
    return html`
      <div class="p-6">
        <div
          class="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3"
        >
          ${this.languageList.map((lang) => {
            const isActive = this.currentLang === lang.code;
            const isDebug = lang.code === "debug";

            let buttonClasses =
              "ui-focus relative group rounded-ui-card border transition-colors flex items-center p-3 gap-3 w-full cursor-pointer";

            if (isDebug) {
              buttonClasses +=
                " animate-pulse font-bold text-white border-2 border-dashed border-cyan-400 shadow-[0_0_15px_rgba(34,211,238,0.2)] bg-gradient-to-r from-red-600 via-yellow-600 via-green-600 via-blue-600 to-purple-600";
            } else if (isActive) {
              buttonClasses +=
                " border-ui-accent bg-ui-surface ring-1 ring-ui-accent";
            } else {
              buttonClasses +=
                " bg-ui-surface border-ui-border hover:border-ui-border-hover";
            }

            return html`
              <button
                class="${buttonClasses}"
                @click=${() => this.selectLanguage(lang.code)}
              >
                <img
                  src=${assetUrl(`flags/${lang.svg}.svg`)}
                  class="w-8 h-6 object-contain rounded-[3px] shrink-0"
                  alt="${lang.code}"
                />
                <div class="flex flex-col items-start min-w-0">
                  <span
                    class="ui-body whitespace-normal break-words w-full text-left font-bold text-ui-text"
                    >${lang.native}</span
                  >
                  <span
                    class="ui-label whitespace-normal break-words w-full text-left"
                    >${lang.en}</span
                  >
                </div>

                ${isActive
                  ? html`
                      <span
                        class="ml-auto grid h-6 w-6 shrink-0 place-items-center rounded-full bg-ui-accent text-white"
                        aria-hidden="true"
                        >${uiIcons.check()}</span
                      >
                    `
                  : ""}
              </button>
            `;
          })}
        </div>
      </div>
    `;
  }
}
