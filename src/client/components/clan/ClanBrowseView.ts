import { html, LitElement } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { type ClanBrowseResponse, fetchClans } from "../../ClanApi";
import { translateText } from "../../Utils";
import { uiButtonClasses, uiSearch } from "../ui/PageUi";
import "./ClanCard";
import "./ClanCreateForm";
import { type ClanRole, renderLoadingSpinner } from "./ClanShared";

export interface BrowseState {
  data: ClanBrowseResponse | null;
  page: number;
  query: string;
}

@customElement("clan-browse-view")
export class ClanBrowseView extends LitElement {
  createRenderRoot() {
    return this;
  }

  @property({ type: Object }) myClanRoles: Map<string, ClanRole> = new Map();
  @property({ type: Array }) myPendingRequests: { tag: string }[] = [];
  @property({ type: Object }) cachedState: BrowseState | null = null;
  /** Whether to offer "Create clan" (a signed-in player who is in no clan). */
  @property({ type: Boolean }) canCreate = false;
  /** Open with the create form already showing. */
  @property({ type: Boolean }) openCreate = false;
  /** The clan the page's panel is showing: its card is drawn selected. */
  @property({ type: String }) selectedTag = "";

  @state() private creating = false;

  @state() private searchQuery = "";
  @state() private browseData: ClanBrowseResponse | null = null;
  @state() private browsePage = 1;
  @state() private loading = false;
  @state() private errorMsg = "";
  private searchDebounce: ReturnType<typeof setTimeout> | null = null;
  private asyncGeneration = 0;

  private emitState() {
    this.dispatchEvent(
      new CustomEvent("browse-updated", {
        detail: {
          data: this.browseData,
          page: this.browsePage,
          query: this.searchQuery,
        } satisfies BrowseState,
        bubbles: true,
        composed: true,
      }),
    );
  }

  async loadBrowse() {
    const gen = ++this.asyncGeneration;
    this.loading = true;
    this.errorMsg = "";
    try {
      const data = await fetchClans(
        this.searchQuery || undefined,
        this.browsePage,
      );
      if (gen !== this.asyncGeneration) return;
      if (data === false) throw new Error("fetch failed");
      this.browseData = data;
      this.emitState();
    } catch {
      if (gen !== this.asyncGeneration) return;
      this.errorMsg = translateText("clan_modal.error_loading");
    } finally {
      if (gen === this.asyncGeneration) this.loading = false;
    }
  }

  protected willUpdate(changed: Map<string, unknown>) {
    if (changed.has("openCreate") && this.openCreate) this.creating = true;
  }

  connectedCallback() {
    super.connectedCallback();
    if (this.openCreate) this.creating = true;
    if (this.cachedState?.data) {
      this.browseData = this.cachedState.data;
      this.browsePage = this.cachedState.page;
      this.searchQuery = this.cachedState.query;
    } else {
      this.loadBrowse();
    }
  }

  disconnectedCallback() {
    if (this.searchDebounce) clearTimeout(this.searchDebounce);
    super.disconnectedCallback();
  }

  render() {
    if (this.loading && !this.browseData) return renderLoadingSpinner();

    const totalPages = this.browseData
      ? Math.ceil(this.browseData.total / this.browseData.limit)
      : 0;
    const pendingTags = new Set(this.myPendingRequests.map((r) => r.tag));
    const filtered = (this.browseData?.results ?? []).filter(
      (clan) => !this.myClanRoles.has(clan.tag),
    );

    return html`
      <div class="space-y-4">
        ${this.canCreate
          ? this.creating
            ? html`<clan-create-form
                @create-cancel=${() => (this.creating = false)}
              ></clan-create-form>`
            : html`<button
                type="button"
                data-create-clan-start
                class=${uiButtonClasses("primary", true)}
                @click=${() => (this.creating = true)}
              >
                ${translateText("clan_modal.create_button")}
              </button>`
          : ""}
        ${uiSearch({
          value: this.searchQuery,
          placeholder: translateText("clan_modal.search_placeholder"),
          ariaLabel: translateText("clan_modal.search_placeholder"),
          onInput: (value) => {
            this.searchQuery = value;
            if (this.searchDebounce) clearTimeout(this.searchDebounce);
            this.searchDebounce = setTimeout(() => {
              this.browsePage = 1;
              this.loadBrowse();
            }, 400);
          },
        })}
        ${this.errorMsg
          ? html`<p class="ui-body py-4 text-center text-ui-accent-soft">
              ${this.errorMsg}
            </p>`
          : ""}

        <div class="space-y-3">
          ${filtered.length === 0 && this.browseData
            ? html`<p class="ui-body py-8 text-center text-ui-muted">
                ${translateText("clan_modal.no_results")}
              </p>`
            : filtered.map(
                (clan) =>
                  html`<clan-card
                    .clan=${clan}
                    ?pending=${pendingTags.has(clan.tag)}
                    ?selected=${clan.tag === this.selectedTag}
                  ></clan-card>`,
              )}
        </div>

        ${totalPages > 1
          ? html`
              <div class="flex items-center justify-center gap-2 pt-2">
                <button
                  @click=${() => {
                    this.browsePage = Math.max(1, this.browsePage - 1);
                    this.loadBrowse();
                  }}
                  ?disabled=${this.browsePage <= 1}
                  class="ui-focus min-h-11 min-w-11 rounded-ui-card text-[13px] font-bold transition-colors ${this
                    .browsePage <= 1
                    ? "cursor-not-allowed text-ui-placeholder"
                    : "cursor-pointer text-ui-muted hover:text-ui-text"}"
                >
                  &lt;
                </button>
                <span class="ui-mono text-[13px] text-ui-muted">
                  ${this.browsePage} / ${totalPages}
                </span>
                <button
                  @click=${() => {
                    this.browsePage = Math.min(totalPages, this.browsePage + 1);
                    this.loadBrowse();
                  }}
                  ?disabled=${this.browsePage >= totalPages}
                  class="ui-focus min-h-11 min-w-11 rounded-ui-card text-[13px] font-bold transition-colors ${this
                    .browsePage >= totalPages
                    ? "cursor-not-allowed text-ui-placeholder"
                    : "cursor-pointer text-ui-muted hover:text-ui-text"}"
                >
                  &gt;
                </button>
              </div>
            `
          : ""}
      </div>
    `;
  }
}
