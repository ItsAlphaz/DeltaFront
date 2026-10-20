import {
  GameMapType,
  GameMode,
  maps,
} from "@openfront/engine-api/game/GameTypes";
import { assetUrl } from "@openfront/shared/AssetUrls";
import { html, TemplateResult } from "lit";
import { translateText } from "../../Utils";

// What the Create Lobby and Solo pages show in their right-hand detail panel
// (PageUi.ts uiDetailPanel): the picked map, large, and the settings in a few
// rows. Shared so the two pages read the same.

/** The picked map, large, with its name: the panel's first block. */
export function lobbyMapPreview(props: {
  map: GameMapType;
  useRandom: boolean;
  /** The map's thumbnail (terrainMapFileLoader.getMapData(map).webpPath). */
  mapImage: string;
}): TemplateResult {
  const info = props.useRandom
    ? undefined
    : maps.find((m) => m.type === props.map);
  const name = props.useRandom
    ? translateText("map.random")
    : info
      ? translateText(info.translationKey)
      : String(props.map);
  const src = props.useRandom
    ? assetUrl("images/RandomMap.webp")
    : props.mapImage;
  return html`<div data-lobby-map-preview>
    <div
      class="aspect-[2/1] overflow-hidden rounded-ui-card border border-ui-border bg-ui-ground"
    >
      <img
        src=${src}
        alt=${name}
        draggable="false"
        class="h-full w-full object-cover"
      />
    </div>
    <div class="ui-label mt-4">${translateText("map.map")}</div>
    <h2 data-lobby-map-name class="ui-title mt-1 text-ui-text">${name}</h2>
  </div>`;
}

/** The settings in a few rows: what the game is, at a glance. */
export function lobbySummaryRows(s: {
  difficulty: string;
  /** 0 means no nations, so there is no difficulty to show. */
  nations: number;
  bots: number;
  gameMode: GameMode;
  /** One flag per rule; the row counts the ones that are on. */
  rules: readonly boolean[];
  /** One flag per limit; the row counts the ones that are set. */
  limits: readonly boolean[];
  disabledUnits: number;
}): { label: string; value: string }[] {
  return [
    {
      label: translateText("difficulty.difficulty"),
      value:
        s.nations === 0
          ? "—"
          : translateText(`difficulty.${s.difficulty.toLowerCase()}`),
    },
    {
      label: translateText("host_modal.mode"),
      value:
        s.gameMode === GameMode.FFA
          ? translateText("game_mode.ffa")
          : translateText("game_mode.teams"),
    },
    {
      label: translateText("host_modal.summary_population"),
      value: `${s.bots} / ${s.nations}`,
    },
    {
      label: translateText("host_modal.summary_rules"),
      value: String(s.rules.filter(Boolean).length),
    },
    {
      label: translateText("host_modal.summary_limits"),
      value: String(s.limits.filter(Boolean).length),
    },
    {
      label: translateText("host_modal.summary_units"),
      value:
        s.disabledUnits === 0
          ? translateText("common.none")
          : String(s.disabledUnits),
    },
  ];
}
