import {
  Difficulty,
  Duos,
  GameMapType,
  GameMode,
  HumansVsNations,
  Quads,
  Trios,
  UnitType,
} from "@openfront/engine-api/game/GameTypes";
import { TeamCountConfig } from "@openfront/engine-api/Schemas";
import {
  CAPITAL_SPEC,
  CRISIS_MINUTES_DEFAULT,
  CRISIS_MINUTES_LONG,
} from "@openfront/engine-lib/capital/CapitalRules";
import { renderNumber } from "@openfront/engine-lib/Format";
import {
  DOOMSDAY_CLOCK_SPEEDS,
  DoomsdayClockSpeed,
} from "@openfront/engine-lib/game/DoomsdayClock";
import { LitElement, TemplateResult, html, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { translateText } from "../Utils";
import "./Difficulties";
import "./FluentSlider";
import "./map/MapPicker";
import { uiChip, uiSearch, uiSwitchRow } from "./ui/PageUi";

const DIFFICULTY_OPTIONS = Object.entries(Difficulty).filter(([key]) =>
  isNaN(Number(key)),
) as Array<[string, Difficulty]>;
const TEAM_COUNT_OPTIONS: TeamCountConfig[] = [
  2,
  3,
  4,
  5,
  6,
  7,
  Quads,
  Trios,
  Duos,
  HumansVsNations,
];

/** A button in a picker (difficulty, mode, team count): selected is the accent tint and border. */
function pickerClass(active: boolean, extra = ""): string {
  return `ui-focus cursor-pointer rounded-ui-card border transition-colors ${extra} ${
    active
      ? "border-ui-accent bg-ui-accent-tint text-ui-text"
      : "border-transparent text-ui-muted hover:text-ui-text"
  }`;
}

const PICKER_GROUP_CLASS =
  "flex gap-1 rounded-ui-card border border-ui-border bg-ui-ground p-1";

/** One section of the page: its heading (and an action beside it) and its content. */
function renderSection(
  id: string,
  titleKey: string,
  content: TemplateResult | TemplateResult[],
  headerAction?: TemplateResult,
): TemplateResult {
  return html`
    <section data-config-section=${id} class="scroll-mt-24 space-y-4">
      <div class="flex flex-wrap items-center justify-between gap-3">
        <h3 class="ui-heading text-ui-text">${translateText(titleKey)}</h3>
        ${headerAction ?? nothing}
      </div>
      ${content}
    </section>
  `;
}

const unitOptions: { type: UnitType; translationKey: string }[] = [
  { type: UnitType.City, translationKey: "unit_type.city" },
  { type: UnitType.DefensePost, translationKey: "unit_type.defense_post" },
  { type: UnitType.Port, translationKey: "unit_type.port" },
  { type: UnitType.Warship, translationKey: "unit_type.warship" },
  { type: UnitType.TransportShip, translationKey: "unit_type.boat" },
  { type: UnitType.MissileSilo, translationKey: "unit_type.missile_silo" },
  { type: UnitType.SAMLauncher, translationKey: "unit_type.sam_launcher" },
  { type: UnitType.AtomBomb, translationKey: "unit_type.atom_bomb" },
  { type: UnitType.HydrogenBomb, translationKey: "unit_type.hydrogen_bomb" },
  { type: UnitType.MIRV, translationKey: "unit_type.mirv" },
  { type: UnitType.Factory, translationKey: "unit_type.factory" },
  { type: UnitType.Airport, translationKey: "unit_type.airport" },
  { type: UnitType.Airstrike, translationKey: "unit_type.airstrike" },
];

export interface ToggleOptionConfig {
  labelKey: string;
  checked: boolean;
  hidden?: boolean;
  // When set, this toggle's card expands to a pace dropdown while it is checked.
  doomsdayClockSpeed?: DoomsdayClockSpeed;
  // When set, this toggle's card expands to a CRISIS length dropdown (3 or 5
  // minutes) while it is checked (the Capital System).
  crisisMinutes?: CrisisMinutes;
}

export type CrisisMinutes =
  | typeof CRISIS_MINUTES_DEFAULT
  | typeof CRISIS_MINUTES_LONG;

export const CRISIS_LENGTHS: readonly CrisisMinutes[] = [
  CRISIS_MINUTES_DEFAULT,
  CRISIS_MINUTES_LONG,
];

export interface GameConfigSettingsData {
  map: {
    selected: GameMapType;
    useRandom: boolean;
    randomMapDivider?: boolean;
    showMedals?: boolean;
    mapWins?: Map<GameMapType, Set<Difficulty>>;
  };
  difficulty: {
    selected: Difficulty;
    disabled: boolean;
  };
  gameMode: {
    selected: GameMode;
  };
  teamCount: {
    selected: TeamCountConfig;
  };
  options: {
    titleKey: string;
    bots: {
      value: number;
      labelKey: string;
      disabledKey: string;
    };
    nations?: {
      value: number;
      defaultValue?: number;
      labelKey: string;
      disabledKey: string;
      hidden?: boolean;
    };
    toggles: ToggleOptionConfig[];
    inputCards: TemplateResult[];
  };
  hostCheats?: {
    titleKey: string;
    visible: boolean;
    toggles: ToggleOptionConfig[];
    inputCards: TemplateResult[];
  };
  unitTypes: {
    titleKey: string;
    disabledUnits: UnitType[];
  };
}

@customElement("game-config-settings")
export class GameConfigSettings extends LitElement {
  @property({ attribute: false }) settings?: GameConfigSettingsData;
  @property({ attribute: false }) sectionGapClass = "space-y-6";
  @state() private mapSearchQuery = "";
  @state() private activeSection = "map";

  createRenderRoot() {
    return this;
  }

  private emit<T>(name: string, detail: T) {
    this.dispatchEvent(
      new CustomEvent(name, {
        detail,
        bubbles: true,
        composed: true,
      }),
    );
  }

  private jumpTo(section: string) {
    this.activeSection = section;
    const target = this.querySelector<HTMLElement>(
      `[data-config-section="${section}"]`,
    );
    if (!target) return;
    // Scroll only the page's own content column (beside the detail panel): an
    // element-level scrollIntoView would also move every scrollable ancestor.
    const scroller = this.closest<HTMLElement>('[data-ui="content"]');
    if (scroller && scroller.scrollHeight > scroller.clientHeight) {
      const nav = this.querySelector<HTMLElement>("[data-config-nav]");
      const top =
        target.getBoundingClientRect().top -
        scroller.getBoundingClientRect().top +
        scroller.scrollTop -
        (nav?.offsetHeight ?? 0) -
        8;
      scroller.scrollTo({ top, behavior: "smooth" });
      return;
    }
    target.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  private handleSelectMap = (map: GameMapType) => {
    this.emit("map-selected", { map });
  };

  private handleSelectRandom = () => {
    this.emit("random-map-selected", {});
  };

  private handleDifficultySelect = (difficulty: Difficulty) => {
    this.emit("difficulty-selected", { difficulty });
  };

  private handleDoomsdayClockSpeedChange = (e: Event) => {
    const speed = (e.target as HTMLSelectElement).value as DoomsdayClockSpeed;
    this.emit("doomsday-clock-speed-selected", { speed });
  };

  private handleCrisisMinutesChange = (e: Event) => {
    const minutes =
      Number((e.target as HTMLSelectElement).value) === CRISIS_MINUTES_LONG
        ? CRISIS_MINUTES_LONG
        : CRISIS_MINUTES_DEFAULT;
    this.emit("crisis-minutes-selected", { minutes });
  };

  private handleGameModeSelect = (mode: GameMode) => {
    this.emit("game-mode-selected", { mode });
  };

  private handleTeamCountSelect = (count: TeamCountConfig) => {
    this.emit("team-count-selected", { count });
  };

  private handleOptionToggle = (toggle: ToggleOptionConfig) => {
    this.emit("option-toggle-changed", {
      labelKey: toggle.labelKey,
      checked: !toggle.checked,
    });
  };

  private handleBotsChanged = (event: Event) => {
    const customEvent = event as CustomEvent<{ value: number }>;
    this.emit("bots-changed", customEvent.detail);
  };

  private handleNationsChanged = (event: Event) => {
    const customEvent = event as CustomEvent<{ value: number }>;
    this.emit("nations-changed", customEvent.detail);
  };

  private handleHostCheatToggle = (toggle: ToggleOptionConfig) => {
    this.emit("host-cheat-toggle-changed", {
      labelKey: toggle.labelKey,
      checked: !toggle.checked,
    });
  };

  private handleUnitToggle = (unit: UnitType, checked: boolean) => {
    this.emit("unit-toggle-changed", { unit, checked });
  };

  private renderOptionToggle(toggle: ToggleOptionConfig): TemplateResult {
    if (toggle.hidden) return html``;

    // The doomsday clock and the Capital System each grow a dropdown while on.
    // It sits outside the row's label, so choosing from it does not flip the switch.
    let extra: TemplateResult | undefined;
    let title: string | undefined;
    if (toggle.doomsdayClockSpeed !== undefined && toggle.checked) {
      extra = this.renderSelect(
        html`${DOOMSDAY_CLOCK_SPEEDS.map(
          (speed) => html`
            <option
              value=${speed}
              ?selected=${toggle.doomsdayClockSpeed === speed}
            >
              ${translateText(`doomsday_clock_speed.${speed}`)}
            </option>
          `,
        )}`,
        this.handleDoomsdayClockSpeedChange,
        translateText(toggle.labelKey),
      );
    }
    if (toggle.crisisMinutes !== undefined) {
      title = translateText("game_settings.capital_system_hint", {
        cost: renderNumber(CAPITAL_SPEC.cost),
        grant: renderNumber(CAPITAL_SPEC.startingGold),
      });
      if (toggle.checked) {
        extra = this.renderSelect(
          html`${CRISIS_LENGTHS.map(
            (minutes) => html`
              <option
                value=${minutes}
                ?selected=${toggle.crisisMinutes === minutes}
              >
                ${translateText("game_settings.crisis_length_option", {
                  minutes,
                })}
              </option>
            `,
          )}`,
          this.handleCrisisMinutesChange,
          translateText("game_settings.crisis_length"),
          "data-crisis-minutes",
        );
      }
    }
    return uiSwitchRow({
      label: translateText(toggle.labelKey),
      checked: toggle.checked,
      onChange: () => this.handleOptionToggle(toggle),
      extra,
      title,
    });
  }

  private renderSelect(
    options: TemplateResult,
    onChange: (e: Event) => void,
    label: string,
    hook?: string,
  ): TemplateResult {
    return html`<select
      data-crisis-minutes=${hook === undefined ? nothing : ""}
      aria-label=${label}
      class="ui-focus ui-body h-11 w-full rounded-ui-card border border-ui-border-strong bg-ui-panel px-3 text-ui-text"
      @change=${onChange}
    >
      ${options}
    </select>`;
  }

  private renderUnitTypeOptions(disabledUnits: UnitType[]): TemplateResult[] {
    return unitOptions.map(({ type, translationKey }) => {
      const isEnabled = !disabledUnits.includes(type);
      return uiChip({
        label: translateText(translationKey),
        selected: !isEnabled,
        strike: true,
        onToggle: () => this.handleUnitToggle(type, isEnabled),
      });
    });
  }

  private renderMapSearchInput(): TemplateResult {
    return html`<div class="w-full sm:w-[260px]">
      ${uiSearch({
        value: this.mapSearchQuery,
        placeholder: translateText("map_component.search_maps"),
        ariaLabel: translateText("map_component.search_maps"),
        onInput: (value) => (this.mapSearchQuery = value),
      })}
    </div>`;
  }

  private renderNav(
    sections: { key: string; label: string }[],
  ): TemplateResult {
    return html`<nav
      data-config-nav
      aria-label=${translateText("game_settings.sections")}
      class="sticky top-0 z-10 -mx-6 flex gap-2 overflow-x-auto overflow-y-hidden border-b border-ui-border bg-ui-panel px-6 py-3"
    >
      ${sections.map(
        (section) =>
          html`<button
            type="button"
            data-config-jump=${section.key}
            aria-current=${this.activeSection === section.key
              ? "true"
              : "false"}
            class="ui-focus min-h-9 shrink-0 cursor-pointer whitespace-nowrap rounded-[8px] px-4 font-ui text-[14px] font-semibold transition-colors ${this
              .activeSection === section.key
              ? "bg-ui-border-strong text-ui-text"
              : "text-ui-muted hover:text-ui-text"}"
            @click=${() => this.jumpTo(section.key)}
          >
            ${section.label}
          </button>`,
      )}
    </nav>`;
  }

  render() {
    if (!this.settings) return nothing;
    const settings = this.settings;
    const sections = [
      { key: "map", label: translateText("map.map") },
      {
        key: "difficulty",
        label: translateText("game_settings.nav_difficulty_mode"),
      },
      { key: "population", label: translateText("game_settings.population") },
      { key: "rules", label: translateText("game_settings.rules") },
      { key: "limits", label: translateText("game_settings.limits") },
      { key: "units", label: translateText("game_settings.nav_units") },
    ];
    const slider = (
      slider: {
        value: number;
        defaultValue?: number;
        labelKey: string;
        disabledKey: string;
      },
      onChange: (event: Event) => void,
      withDefault: boolean,
    ) =>
      html`<div
        class="rounded-ui-card border border-ui-border bg-ui-surface p-5"
      >
        <fluent-slider
          min="0"
          max="400"
          step="1"
          .value=${slider.value}
          .defaultValue=${withDefault ? slider.defaultValue : undefined}
          defaultLabelKey=${withDefault ? "common.map_default" : ""}
          labelKey=${slider.labelKey}
          disabledKey=${slider.disabledKey}
          @value-changed=${onChange}
        ></fluent-slider>
      </div>`;

    return html`
      ${this.renderNav(sections)}
      <div class="${this.sectionGapClass} pt-8">
        ${renderSection(
          "map",
          "map.map",
          html`<map-picker
            .selectedMap=${settings.map.selected}
            .useRandomMap=${settings.map.useRandom}
            .randomMapDivider=${settings.map.randomMapDivider ?? false}
            .showMedals=${settings.map.showMedals ?? false}
            .mapWins=${settings.map.mapWins ?? new Map()}
            .onSelectMap=${this.handleSelectMap}
            .onSelectRandom=${this.handleSelectRandom}
            .searchQuery=${this.mapSearchQuery}
          ></map-picker>`,
          this.renderMapSearchInput(),
        )}
        <section data-config-section="difficulty" class="scroll-mt-24">
          <div class="grid gap-8 lg:grid-cols-2">
            <div class="space-y-4">
              <h3 class="ui-heading text-ui-text">
                ${translateText("difficulty.difficulty")}
              </h3>
              <div class="${PICKER_GROUP_CLASS}" role="group">
                ${DIFFICULTY_OPTIONS.map(([key, value]) => {
                  const isSelected = settings.difficulty.selected === value;
                  const isDisabled = settings.difficulty.disabled;
                  return html`<button
                    ?disabled=${isDisabled}
                    aria-pressed=${isSelected}
                    @click=${() =>
                      !isDisabled &&
                      this.handleDifficultySelect(value as Difficulty)}
                    class="${pickerClass(
                      isSelected && !isDisabled,
                      "flex min-h-[72px] flex-1 flex-col items-center justify-center gap-1.5 px-2",
                    )} ${isDisabled ? "cursor-not-allowed opacity-40" : ""}"
                  >
                    <difficulty-display
                      .difficultyKey=${key}
                      class=${isDisabled ? "pointer-events-none" : ""}
                    ></difficulty-display>
                    <span
                      class="font-ui text-[12px] font-semibold uppercase tracking-[0.06em]"
                    >
                      ${translateText(`difficulty.${key.toLowerCase()}`)}
                    </span>
                  </button>`;
                })}
              </div>
            </div>
            <div class="space-y-4">
              <h3 class="ui-heading text-ui-text">
                ${translateText("host_modal.mode")}
              </h3>
              <div class="${PICKER_GROUP_CLASS}" role="group">
                ${[GameMode.FFA, GameMode.Team].map((mode) => {
                  const isSelected = settings.gameMode.selected === mode;
                  return html`<button
                    aria-pressed=${isSelected}
                    class="${pickerClass(
                      isSelected,
                      "flex min-h-[72px] flex-1 items-center justify-center px-3 font-ui text-[13px] font-semibold uppercase tracking-[0.08em]",
                    )}"
                    @click=${() => this.handleGameModeSelect(mode)}
                  >
                    ${mode === GameMode.FFA
                      ? translateText("game_mode.ffa")
                      : translateText("game_mode.teams")}
                  </button>`;
                })}
              </div>
            </div>
          </div>
          ${settings.gameMode.selected === GameMode.FFA
            ? nothing
            : html`<div class="mt-6 space-y-4">
                <div class="ui-label">
                  ${translateText("host_modal.team_count")}
                </div>
                <div class="grid grid-cols-2 gap-2 md:grid-cols-5">
                  ${TEAM_COUNT_OPTIONS.map((o) => {
                    const isSelected = settings.teamCount.selected === o;
                    return html`<button
                      aria-pressed=${isSelected}
                      class="${pickerClass(
                        isSelected,
                        "min-h-11 border-ui-border px-4 font-ui text-[13px] font-semibold",
                      )}"
                      @click=${() => this.handleTeamCountSelect(o)}
                    >
                      ${typeof o === "string"
                        ? o === HumansVsNations
                          ? translateText("public_lobby.teams_hvn")
                          : translateText(`host_modal.teams_${o}`)
                        : translateText("public_lobby.teams", { num: o })}
                    </button>`;
                  })}
                </div>
              </div>`}
        </section>
        ${renderSection(
          "population",
          "game_settings.population",
          html`<div class="grid gap-3 md:grid-cols-2">
            ${slider(settings.options.bots, this.handleBotsChanged, false)}
            ${settings.options.nations && !settings.options.nations.hidden
              ? slider(
                  settings.options.nations,
                  this.handleNationsChanged,
                  true,
                )
              : nothing}
          </div>`,
        )}
        ${renderSection(
          "rules",
          "game_settings.rules",
          html`<div class="grid gap-3 md:grid-cols-2">
            ${settings.options.toggles.map((toggle) =>
              this.renderOptionToggle(toggle),
            )}
          </div>`,
        )}
        ${renderSection(
          "limits",
          "game_settings.limits",
          html`<div class="grid gap-3 md:grid-cols-2">
            ${settings.options.inputCards}
          </div>`,
        )}
        ${settings.hostCheats?.visible
          ? renderSection(
              "host-cheats",
              settings.hostCheats.titleKey,
              html`<div class="grid gap-3 md:grid-cols-2">
                ${settings.hostCheats.toggles.map((toggle) =>
                  uiSwitchRow({
                    label: translateText(toggle.labelKey),
                    checked: toggle.checked,
                    onChange: () => this.handleHostCheatToggle(toggle),
                  }),
                )}
                ${settings.hostCheats.inputCards}
              </div>`,
            )
          : nothing}
        ${renderSection(
          "units",
          settings.unitTypes.titleKey,
          html`<div class="flex flex-wrap gap-3 pb-6">
            ${this.renderUnitTypeOptions(settings.unitTypes.disabledUnits)}
          </div>`,
        )}
      </div>
    `;
  }
}
