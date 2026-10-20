import { assetUrl } from "@openfront/shared/AssetUrls";
import { html } from "lit";
import { customElement, property } from "lit/decorators.js";
import { translateText } from "../client/Utils";
import { BaseModal } from "./components/BaseModal";
import { uiPageHeader } from "./components/ui/PageUi";
import { renderMarkdown } from "./Markdown";
import { normalizeNewsMarkdown } from "./NewsMarkdown";

@customElement("news-modal")
export class NewsModal extends BaseModal {
  protected routerName = "news";

  @property({ type: String }) markdown = "Loading...";

  private initialized = false;

  protected renderHeaderSlot() {
    return uiPageHeader({
      title: translateText("news.title"),
      onBack: () => this.close(),
      backLabel: translateText("common.back"),
    });
  }

  protected renderBody() {
    return html`
      <div
        class="prose prose-invert prose-sm mx-auto max-w-3xl px-6 py-6
          [&_a]:text-ui-accent-soft [&_a:hover]:text-ui-text transition-colors
          [&_h1]:text-xl [&_h1]:font-bold [&_h1]:uppercase [&_h1]:tracking-[0.08em] [&_h1]:mb-4 [&_h1]:text-ui-text [&_h1]:border-b [&_h1]:border-ui-border [&_h1]:pb-3
          [&_h2]:text-[15px] [&_h2]:font-bold [&_h2]:uppercase [&_h2]:tracking-[0.06em] [&_h2]:mt-8 [&_h2]:mb-3 [&_h2]:text-ui-text
          [&_h3]:text-[15px] [&_h3]:font-bold [&_h3]:mt-6 [&_h3]:mb-2 [&_h3]:text-ui-text
          [&_ul]:pl-5 [&_ul]:my-3 [&_ul]:list-disc [&_ul]:space-y-1
          [&_li]:text-ui-muted [&_li]:leading-relaxed
          [&_p]:text-ui-muted [&_p]:mb-3 [&_strong]:text-ui-text [&_strong]:font-bold"
      >
        ${renderMarkdown(this.markdown, { includeImages: true })}
      </div>
    `;
  }

  protected onOpen(): void {
    if (!this.initialized) {
      this.initialized = true;
      fetch(assetUrl("changelog.md"))
        .then((response) => (response.ok ? response.text() : "Failed to load"))
        .then((markdown) => normalizeNewsMarkdown(markdown))
        .then((markdown) => (this.markdown = markdown))
        .catch(() => (this.markdown = "Failed to load"));
    }
  }
}
