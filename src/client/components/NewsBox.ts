import type { NewsItem } from "@openfront/shared/ApiSchemas";
import type { ClientPlatform } from "@openfront/shared/WireSchemas";
import { LitElement, html, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { getNews } from "../Api";
import { clientPlatform } from "../ClientPlatform";
import { translateText } from "../Utils";

export type { NewsItem };

const DISMISSED_NEWS_KEY = "dismissedNewsItems";
const CYCLE_INTERVAL_MS = 5000;

function getDismissedIds(): Set<string> {
  const raw = localStorage.getItem(DISMISSED_NEWS_KEY);
  if (raw) return new Set(JSON.parse(raw));
  return new Set();
}

function saveDismissedIds(ids: Set<string>): void {
  localStorage.setItem(DISMISSED_NEWS_KEY, JSON.stringify([...ids]));
}

export function getVisibleNewsItems(items: NewsItem[]): NewsItem[] {
  const dismissed = getDismissedIds();
  return items.filter((item) => !dismissed.has(item.id));
}

export function filterNewsByPlatform(
  items: NewsItem[],
  platform: ClientPlatform,
): NewsItem[] {
  return items.filter(
    (item) => !item.platforms?.length || item.platforms.includes(platform),
  );
}

const typeLabelKeys: Record<string, string> = {
  tournament: "news_box.tournament",
  tutorial: "news_box.tutorial",
  announcement: "news_box.news",
  warning: "news_box.warning",
};

const typeLabelColors: Record<string, string> = {
  tournament: "bg-amber-500/20 text-amber-300",
  tutorial: "bg-sky-500/20 text-sky-300",
  announcement: "bg-emerald-500/20 text-emerald-300",
  warning: "bg-red-500/20 text-red-300",
};

@customElement("news-box")
export class NewsBox extends LitElement {
  /**
   * "box": the card in the homepage column (phones). "strip": a slim bar
   * across the top of the page, above the desktop header. Same items,
   * rotation and dismissal either way.
   */
  @property({ type: String }) variant: "box" | "strip" = "box";
  @state() private items: NewsItem[] = [];
  @state() private activeIndex = 0;
  // The markdown renderer is its own chunk, loaded alongside the news.
  private renderMarkdown: typeof import("../Markdown").renderMarkdown | null =
    null;
  private cycleTimer: ReturnType<typeof setInterval> | null = null;

  createRenderRoot() {
    return this;
  }

  connectedCallback() {
    super.connectedCallback();
    this.loadNews();
  }

  private async loadNews() {
    try {
      const [news, { renderMarkdown }] = await Promise.all([
        getNews(),
        import("../Markdown"),
      ]);
      this.renderMarkdown = renderMarkdown;
      const allItems = filterNewsByPlatform(news, clientPlatform());
      // Reset stale dismissed list when all items would be hidden
      const visible = getVisibleNewsItems(allItems);
      if (visible.length === 0 && allItems.length > 0) {
        localStorage.removeItem(DISMISSED_NEWS_KEY);
        this.items = allItems;
      } else {
        this.items = visible;
      }
      this.startCycle();
    } catch (e) {
      console.warn(e);
    }
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.stopCycle();
  }

  private startCycle() {
    this.stopCycle();
    if (this.items.length > 1) {
      this.cycleTimer = setInterval(() => {
        this.activeIndex = (this.activeIndex + 1) % this.items.length;
      }, CYCLE_INTERVAL_MS);
    }
  }

  private stopCycle() {
    if (this.cycleTimer !== null) {
      clearInterval(this.cycleTimer);
      this.cycleTimer = null;
    }
  }

  private dismiss(id: string) {
    const dismissed = getDismissedIds();
    dismissed.add(id);
    saveDismissedIds(dismissed);
    this.items = this.items.filter((item) => item.id !== id);
    if (this.activeIndex >= this.items.length) {
      this.activeIndex = 0;
    }
    this.startCycle();
  }

  private goTo(index: number) {
    this.activeIndex = index;
    this.startCycle();
  }

  render() {
    if (this.items.length === 0) return nothing;
    const item = this.items[this.activeIndex];
    return this.variant === "strip"
      ? this.renderStrip(item)
      : this.renderBox(item);
  }

  private renderBadge(item: NewsItem, extra = "") {
    return html`<span
      class="shrink-0 font-bold tracking-wider rounded-sm ${typeLabelColors[
        item.type
      ] ?? typeLabelColors["announcement"]} ${extra}"
      >${translateText(
        typeLabelKeys[item.type] ?? typeLabelKeys["announcement"],
      )}</span
    >`;
  }

  private renderTitle(item: NewsItem, extra = "") {
    return item.url
      ? html`<a
          href="${item.url}"
          target="_blank"
          rel="noopener noreferrer"
          class="font-medium text-white hover:text-df-red-bright transition-colors ${extra}"
          >${item.title}</a
        >`
      : html`<span class="font-medium text-white ${extra}"
          >${item.title}</span
        >`;
  }

  private renderDescription(item: NewsItem, extra = "") {
    return html`<span
      class="[&_a]:text-df-red-bright [&_a:hover]:text-df-text ${extra}"
      >${this.renderMarkdown?.(
        item.descriptionTranslationKey
          ? translateText(item.descriptionTranslationKey)
          : (item.description ?? ""),
      )}</span
    >`;
  }

  private renderControls(item: NewsItem) {
    return html`
      ${this.items.length > 1
        ? html`
            <div class="flex gap-1 shrink-0">
              ${this.items.map(
                (_, i) => html`
                  <button
                    @click=${() => this.goTo(i)}
                    class="w-1.5 h-1.5 rounded-full transition-colors ${i ===
                    this.activeIndex
                      ? "bg-white/60"
                      : "bg-white/20 hover:bg-white/40"}"
                    aria-label="${translateText("news_box.go_to_item", {
                      num: i + 1,
                    })}"
                  ></button>
                `,
              )}
            </div>
          `
        : nothing}
      <button
        @click=${() => this.dismiss(item.id)}
        class="shrink-0 p-0.5 text-white/30 hover:text-white/70 transition-colors"
        aria-label="${translateText("news_box.dismiss")}"
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          viewBox="0 0 20 20"
          fill="currentColor"
          class="w-3.5 h-3.5"
        >
          <path
            d="M6.28 5.22a.75.75 0 00-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 101.06 1.06L10 11.06l3.72 3.72a.75.75 0 101.06-1.06L11.06 10l3.72-3.72a.75.75 0 00-1.06-1.06L10 8.94 6.28 5.22z"
          />
        </svg>
      </button>
    `;
  }

  // Slim full-width bar: badge, then title and description as one wrapping
  // line, controls on the right. Held at a two-line height so rotating
  // between a short and a long item never shifts the page below it.
  private renderStrip(item: NewsItem) {
    return html`
      <div
        class="flex min-h-[62px] items-center gap-4 border-b border-df-border bg-df-panel px-8 py-2"
      >
        ${this.renderBadge(item, "font-display text-xs px-2.5 py-1")}
        <p
          class="flex-1 min-w-0 text-[13px] leading-[1.6] text-df-text-secondary"
        >
          ${this.renderTitle(item, "text-[15px] mr-1.5")}
          ${this.renderDescription(item, "[&_p]:inline")}
        </p>
        <div class="flex items-center gap-4 shrink-0">
          ${this.renderControls(item)}
        </div>
      </div>
    `;
  }

  private renderBox(item: NewsItem) {
    return html`
      <div
        class="px-2 py-2 bg-surface border-y border-white/10 lg:border-y-0 lg:rounded-xl lg:p-3"
      >
        <div class="flex items-center gap-3">
          ${this.renderBadge(item, "text-[10px] px-2 py-0.5")}
          <div class="flex-1 min-w-0">
            ${this.renderTitle(item, "text-sm truncate block")}
            ${this.renderDescription(item, "text-xs text-white/50 block")}
          </div>
          ${this.renderControls(item)}
        </div>
      </div>
    `;
  }
}
