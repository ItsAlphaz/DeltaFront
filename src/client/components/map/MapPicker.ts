import {
  Difficulty,
  GameMapType,
  MapCategory,
  mapCategoryOrder,
  MapInfo,
  maps,
} from "@openfront/engine-api/game/GameTypes";
import { assetUrl } from "@openfront/shared/AssetUrls";
import { html, LitElement } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { repeat } from "lit/directives/repeat.js";
import { translateText } from "../../Utils";
import { uiSegmented } from "../ui/PageUi";
import "./MapDisplay";
import { getFavoriteMaps, starIcon, toggleFavoriteMap } from "./MapFavorites";
const randomMap = assetUrl("images/RandomMap.webp");

type MapTab = "featured" | "all" | "favorites";

// Featured grid order: ranked maps first (1 = first), unranked alphabetical.
const featuredMaps: MapInfo[] = maps
  .filter((m) => m.categories.includes("featured"))
  .sort(
    (a, b) =>
      (a.featuredRank ?? Number.MAX_SAFE_INTEGER) -
      (b.featuredRank ?? Number.MAX_SAFE_INTEGER),
  );

function mapsInCategory(category: MapCategory): MapInfo[] {
  return maps.filter((m) => m.categories.includes(category));
}

@customElement("map-picker")
export class MapPicker extends LitElement {
  @property({ type: String }) selectedMap: GameMapType = GameMapType.World;
  @property({ type: Boolean }) useRandomMap = false;
  @property({ type: Boolean }) showMedals = false;
  @property({ type: Boolean }) randomMapDivider = false;
  @property({ type: String }) searchQuery = "";
  @property({ attribute: false }) mapWins: Map<GameMapType, Set<Difficulty>> =
    new Map();
  @property({ attribute: false }) onSelectMap?: (map: GameMapType) => void;
  @property({ attribute: false }) onSelectRandom?: () => void;
  @state() private activeTab: MapTab = "featured";
  @state() private expandedCategories: Set<string> = new Set();
  @state() private favorites: GameMapType[] = getFavoriteMaps();

  createRenderRoot() {
    return this;
  }

  private handleToggleFavorite(mapValue: GameMapType) {
    this.favorites = toggleFavoriteMap(mapValue);
  }

  private handleMapSelection(mapValue: GameMapType) {
    this.onSelectMap?.(mapValue);
  }

  private handleSelectRandomMap = () => {
    this.onSelectRandom?.();
  };

  private toggleCategory(categoryKey: string) {
    const expanded = new Set(this.expandedCategories);
    if (expanded.has(categoryKey)) {
      expanded.delete(categoryKey);
    } else {
      expanded.add(categoryKey);
    }
    this.expandedCategories = expanded;
  }

  private get allCategories(): MapCategory[] {
    return mapCategoryOrder.filter((categoryKey) => categoryKey !== "featured");
  }

  private toggleExpandAll() {
    this.expandedCategories =
      this.expandedCategories.size > 0
        ? new Set()
        : new Set(this.allCategories);
  }

  private preventImageDrag(event: DragEvent) {
    event.preventDefault();
  }

  private get filteredMaps(): MapInfo[] {
    if (!this.searchQuery.trim()) return [];
    const query = this.searchQuery.trim().toLowerCase();
    return maps.filter((m) => {
      const name = translateText(m.translationKey).toLowerCase();
      const id = m.id.toLowerCase();
      return name.includes(query) || id.includes(query);
    });
  }

  private getWins(mapValue: GameMapType): Set<Difficulty> {
    return this.mapWins?.get(mapValue) ?? new Set();
  }

  private renderMapCard(map: MapInfo) {
    return html`
      <div
        @click=${() => this.handleMapSelection(map.type)}
        class="cursor-pointer"
      >
        <map-display
          .mapKey=${map.id}
          .selected=${!this.useRandomMap && this.selectedMap === map.type}
          .showMedals=${this.showMedals}
          .wins=${this.getWins(map.type)}
          .favorite=${this.favorites.includes(map.type)}
          .onToggleFavorite=${() => this.handleToggleFavorite(map.type)}
          .translation=${translateText(map.translationKey)}
        ></map-display>
      </div>
    `;
  }

  private renderMapGrid(mapList: MapInfo[]) {
    // Keyed by map so cards keep their identity when the list shifts
    // (e.g. the selected map gets prepended to the featured grid) —
    // positional reuse would leave stale thumbnails behind.
    return html`<div
      class="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-4"
    >
      ${repeat(
        mapList,
        (map) => map.id,
        (map) => this.renderMapCard(map),
      )}
    </div>`;
  }

  private renderSectionHeading(label: string) {
    return html`<h4 class="ui-label mb-3">${label}</h4>`;
  }

  private renderCategoryBar(categoryKey: MapCategory, mapList: MapInfo[]) {
    const expanded = this.expandedCategories.has(categoryKey);
    return html`<div class="w-full">
      <button
        type="button"
        aria-expanded=${expanded}
        @click=${() => this.toggleCategory(categoryKey)}
        class="ui-focus flex min-h-11 w-full cursor-pointer items-center justify-between gap-3 rounded-ui-card border bg-ui-surface px-4 transition-colors ${expanded
          ? "border-ui-accent ring-1 ring-ui-accent"
          : "border-ui-border hover:border-ui-border-hover"}"
      >
        <span
          class="flex items-center gap-3 font-ui text-[13px] font-bold uppercase tracking-[0.06em] text-ui-text"
        >
          <svg
            class="w-3.5 h-3.5 shrink-0 transition-transform duration-200 ${expanded
              ? "rotate-90"
              : ""}"
            viewBox="0 0 12 12"
            fill="currentColor"
            aria-hidden="true"
          >
            <path d="M4 2l5 4-5 4z" />
          </svg>
          ${translateText(`map_categories.${categoryKey}`)}
        </span>
        <span class="ui-mono text-[12px] text-ui-muted">${mapList.length}</span>
      </button>
      ${expanded
        ? html`<div class="mt-4">${this.renderMapGrid(mapList)}</div>`
        : null}
    </div>`;
  }

  private renderFeaturedTab() {
    let featuredMapList = featuredMaps;
    const selected = maps.find((m) => m.type === this.selectedMap);
    if (
      !this.useRandomMap &&
      selected !== undefined &&
      !featuredMaps.includes(selected)
    ) {
      featuredMapList = [selected, ...featuredMaps];
    }
    return html`<div class="w-full">
      ${this.renderSectionHeading(translateText("map_categories.featured"))}
      ${this.renderMapGrid(featuredMapList)}
    </div>`;
  }

  private renderAllTab() {
    return html`<div class="space-y-3">
      ${this.allCategories.map((categoryKey) =>
        this.renderCategoryBar(categoryKey, mapsInCategory(categoryKey)),
      )}
    </div>`;
  }

  private renderExpandToggle() {
    const anyExpanded = this.expandedCategories.size > 0;
    return html`<div
      class="shrink-0 rounded-ui-card border border-ui-border bg-ui-ground p-1"
    >
      <button
        type="button"
        aria-expanded=${anyExpanded}
        title=${anyExpanded
          ? translateText("common.collapse_all")
          : translateText("common.expand_all")}
        @click=${() => this.toggleExpandAll()}
        class="ui-focus flex h-full min-h-9 cursor-pointer items-center gap-1.5 rounded-[8px] px-3 font-ui text-[13px] font-semibold uppercase tracking-[0.06em] text-ui-muted transition-colors hover:text-ui-text"
      >
        <svg
          class="w-3 h-3 shrink-0 transition-transform duration-200 ${anyExpanded
            ? "rotate-180"
            : ""}"
          viewBox="0 0 12 12"
          fill="currentColor"
          aria-hidden="true"
        >
          <path d="M2 4l4 5 4-5z" />
        </svg>
        <span class="hidden sm:inline">
          ${anyExpanded
            ? translateText("common.collapse_all")
            : translateText("common.expand_all")}
        </span>
      </button>
    </div>`;
  }

  private renderFavoritesTab() {
    if (this.favorites.length === 0) {
      return html`<div
        class="flex w-full flex-col items-center justify-center gap-3 rounded-ui-card border border-dashed border-ui-border bg-ui-panel px-4 py-12 text-center"
      >
        <div class="text-ui-placeholder">${starIcon(false, "w-8 h-8")}</div>
        <p class="ui-body max-w-xs text-ui-muted">
          ${translateText("map_component.favorites_empty")}
        </p>
      </div>`;
    }
    const favoriteMaps = this.favorites
      .map((favorite) => maps.find((m) => m.type === favorite))
      .filter((m) => m !== undefined);
    return html`<div class="w-full">
      ${this.renderSectionHeading(translateText("map_categories.favorites"))}
      ${this.renderMapGrid(favoriteMaps)}
    </div>`;
  }

  private renderActiveTab() {
    switch (this.activeTab) {
      case "all":
        return this.renderAllTab();
      case "favorites":
        return this.renderFavoritesTab();
      default:
        return this.renderFeaturedTab();
    }
  }

  private renderSearchResults() {
    const results = this.filteredMaps;
    if (results.length === 0) {
      return html`<div
        class="flex w-full flex-col items-center justify-center gap-3 rounded-ui-card border border-dashed border-ui-border bg-ui-panel px-4 py-12 text-center"
      >
        <svg
          class="h-8 w-8 text-ui-placeholder"
          viewBox="0 0 20 20"
          fill="currentColor"
        >
          <path
            fill-rule="evenodd"
            d="M9 3.5a5.5 5.5 0 100 11 5.5 5.5 0 000-11zM2 9a7 7 0 1112.452 4.391l3.328 3.329a.75.75 0 11-1.06 1.06l-3.329-3.328A7 7 0 012 9z"
            clip-rule="evenodd"
          />
        </svg>
        <p class="ui-body max-w-xs text-ui-muted">
          ${translateText("map_component.no_results")}
        </p>
      </div>`;
    }
    return html`<div class="w-full">
      ${this.renderSectionHeading(
        `${translateText("map_component.search_results")} (${results.length})`,
      )}
      ${this.renderMapGrid(results)}
    </div>`;
  }

  render() {
    const isSearching = this.searchQuery.trim().length > 0;
    return html`
      <div class="space-y-6">
        <div class="flex w-full items-center gap-2">
          ${isSearching
            ? null
            : html`${uiSegmented<MapTab>({
                options: [
                  { key: "featured", label: translateText("map.featured") },
                  { key: "all", label: translateText("map.all") },
                  {
                    key: "favorites",
                    label: translateText("map.favorites"),
                  },
                ],
                value: this.activeTab,
                onChange: (tab) => (this.activeTab = tab),
                ariaLabel: translateText("map.map"),
                name: "map-tabs",
              })}
              ${this.activeTab === "all" ? this.renderExpandToggle() : null}`}
        </div>
        ${isSearching ? this.renderSearchResults() : this.renderActiveTab()}
        <div class="w-full">
          ${this.renderSectionHeading(translateText("map_categories.special"))}
          <div class="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-4">
            <button
              type="button"
              aria-pressed=${this.useRandomMap}
              class="ui-focus group relative flex h-full w-full cursor-pointer flex-col overflow-hidden rounded-ui-card border bg-ui-surface text-left transition-colors ${this
                .useRandomMap
                ? "border-ui-accent ring-1 ring-ui-accent"
                : "border-ui-border hover:border-ui-border-hover"}"
              @click=${this.handleSelectRandomMap}
            >
              <div
                class="relative aspect-[2/1] w-full overflow-hidden bg-ui-ground"
              >
                <img
                  src=${randomMap}
                  alt=${translateText("map.random")}
                  draggable="false"
                  @dragstart=${this.preventImageDrag}
                  class="h-full w-full object-cover ${this.useRandomMap
                    ? "opacity-100"
                    : "opacity-80"} transition-opacity duration-200 group-hover:opacity-100"
                />
              </div>
              <div class="flex items-center justify-between gap-2 px-4 py-3">
                <span
                  class="font-ui text-[13px] font-bold uppercase leading-tight tracking-[0.06em] text-ui-text"
                  >${translateText("map.random")}</span
                >
                <span class="ui-label"
                  >${translateText("map_categories.special")}</span
                >
              </div>
            </button>
          </div>
        </div>
      </div>
    `;
  }
}
