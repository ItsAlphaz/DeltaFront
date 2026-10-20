import { Difficulty, GameMapType } from "@openfront/engine-api/game/GameTypes";
import { LitElement, html } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { terrainMapFileLoader } from "../../TerrainMapFileLoader";
import { translateText } from "../../Utils";
import { starIcon } from "./MapFavorites";
import { MEDAL_ORDER, medalIcon } from "./Medals";

@customElement("map-display")
export class MapDisplay extends LitElement {
  @property({ type: String }) mapKey = "";
  @property({ type: Boolean }) selected = false;
  @property({ type: String }) translation: string = "";
  @property({ type: Boolean }) showMedals = false;
  @property({ type: Boolean }) favorite = false;
  @property({ attribute: false }) wins: Set<Difficulty> = new Set();
  @property({ attribute: false }) onToggleFavorite?: () => void;
  @state() private mapWebpPath: string | null = null;
  @state() private mapName: string | null = null;
  @state() private isLoading = true;
  @state() private hasNations = true;
  private observer: IntersectionObserver | null = null;
  private dataLoaded = false;

  createRenderRoot() {
    return this;
  }

  connectedCallback() {
    super.connectedCallback();
    this.observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting) && !this.dataLoaded) {
          this.dataLoaded = true;
          this.loadMapData();
          this.observer?.disconnect();
        }
      },
      { rootMargin: "200px" },
    );
    this.observer.observe(this);
  }

  disconnectedCallback() {
    this.observer?.disconnect();
    this.observer = null;
    super.disconnectedCallback();
  }

  updated(changedProperties: Map<string, unknown>) {
    // If this element is reused for a different map, reload its data —
    // otherwise it keeps showing the previous map's thumbnail.
    const previousMapKey = changedProperties.get("mapKey");
    if (
      changedProperties.has("mapKey") &&
      previousMapKey !== undefined &&
      previousMapKey !== this.mapKey &&
      this.dataLoaded
    ) {
      this.loadMapData();
    }
  }

  private async loadMapData() {
    if (!this.mapKey) return;

    try {
      this.isLoading = true;
      const mapValue = GameMapType[this.mapKey as keyof typeof GameMapType];
      const data = terrainMapFileLoader.getMapData(mapValue);
      this.mapWebpPath = data.webpPath;
      const manifest = await data.manifest();
      this.mapName = manifest.name;
      this.hasNations =
        Array.isArray(manifest.nations) && manifest.nations.length > 0;
    } catch (error) {
      console.warn("Failed to load map data:", error);
    } finally {
      this.isLoading = false;
    }
  }

  private handleKeydown(event: KeyboardEvent) {
    // Trigger the same activation logic as click when Enter or Space is pressed
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      // Dispatch a click event to maintain compatibility with parent click handlers
      (event.target as HTMLElement).click();
    }
  }

  private preventImageDrag(event: DragEvent) {
    event.preventDefault();
  }

  private handleToggleFavorite(event: Event) {
    event.stopPropagation();
    event.preventDefault();
    this.onToggleFavorite?.();
  }

  private renderFavoriteButton() {
    if (!this.onToggleFavorite) return null;
    return html`<button
      type="button"
      @click=${this.handleToggleFavorite}
      @keydown=${(e: KeyboardEvent) => e.stopPropagation()}
      aria-pressed=${this.favorite}
      aria-label=${translateText(
        this.favorite ? "map_component.unfavorite" : "map_component.favorite",
      )}
      title=${translateText(
        this.favorite ? "map_component.unfavorite" : "map_component.favorite",
      )}
      class="absolute right-2 top-2 flex h-7 w-7 items-center justify-center rounded-full bg-ui-ground/70 transition-all duration-200 active:scale-90 ${this
        .favorite
        ? "opacity-100 text-ui-gold"
        : "opacity-0 group-hover:opacity-100 text-ui-text hover:text-ui-gold"}"
    >
      ${starIcon(this.favorite, "w-4 h-4")}
    </button>`;
  }

  render() {
    return html`
      <div
        role="button"
        tabindex="0"
        aria-selected="${this.selected}"
        aria-label="${this.translation ?? this.mapName ?? this.mapKey}"
        @keydown="${this.handleKeydown}"
        class="ui-focus group relative flex h-full w-full cursor-pointer flex-col overflow-hidden rounded-ui-card border bg-ui-surface transition-colors ${this
          .selected
          ? "border-ui-accent ring-1 ring-ui-accent"
          : "border-ui-border hover:border-ui-border-hover"}"
      >
        ${this.isLoading
          ? html`<div
              class="ui-label flex aspect-[2/1] w-full animate-pulse items-center justify-center bg-ui-ground"
            >
              ${translateText("common.loading")}
            </div>`
          : this.mapWebpPath
            ? html`<div
                class="relative aspect-[2/1] w-full overflow-hidden bg-ui-ground"
              >
                <img
                  src="${this.mapWebpPath}"
                  alt="${this.translation || this.mapName}"
                  draggable="false"
                  @dragstart=${this.preventImageDrag}
                  class="h-full w-full object-cover ${this.selected
                    ? "opacity-100"
                    : "opacity-80"} transition-opacity duration-200 group-hover:opacity-100"
                />
                ${this.selected
                  ? html`<span
                      data-map-selected
                      aria-hidden="true"
                      class="absolute left-2 top-2 flex h-6 w-6 items-center justify-center rounded-full bg-ui-accent text-white"
                    >
                      <svg
                        class="h-3.5 w-3.5"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        stroke-width="3"
                        stroke-linecap="round"
                        stroke-linejoin="round"
                      >
                        <path d="m5 12 5 5L20 7" />
                      </svg>
                    </span>`
                  : null}
                ${this.renderFavoriteButton()}
              </div>`
            : html`<div
                class="ui-label flex aspect-[2/1] w-full items-center justify-center bg-ui-accent-tint text-ui-accent-soft"
              >
                ${translateText("map_component.error")}
              </div>`}
        ${this.showMedals && this.hasNations
          ? html`<div class="flex w-full justify-center gap-1 pt-2">
              ${this.renderMedals()}
            </div>`
          : null}
        <div
          class="px-4 py-3 text-left font-ui text-[13px] font-bold uppercase leading-tight tracking-[0.06em] text-ui-text"
        >
          ${this.translation || this.mapName}
        </div>
      </div>
    `;
  }

  private renderMedals() {
    const wins = this.readWins();
    return MEDAL_ORDER.map((medal) =>
      medalIcon(medal, "w-5 h-5", wins.has(medal)),
    );
  }

  private readWins(): Set<Difficulty> {
    return this.wins ?? new Set();
  }
}
