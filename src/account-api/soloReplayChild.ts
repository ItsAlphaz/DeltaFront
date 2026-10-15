// The solo-replay subprocess (see soloReplay.ts): receives one singleplayer
// game's start info and turns, replays them on the engine, sends back what the
// simulation found and exits. It is the only file of the account API that loads
// the engine.
import { GameMapType } from "@openfront/engine-api/game/GameTypes";
import { MapManifest } from "@openfront/engine-api/game/MapFiles";
import { replaySolo } from "@openfront/engine/WinnerReplay";
import {
  GameMapLoader,
  loadMapFiles,
  MapData,
} from "@openfront/shared/GameMapLoader";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { SoloReplayRequest, SoloReplayResponse } from "./soloReplay";

// The release's own copy of the maps: the API is deployed from a checkout that
// has them (the game image removes them, it is not what runs here).
const MAPS_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../resources/maps",
);

function mapDirName(map: GameMapType): string {
  const key = (
    Object.keys(GameMapType) as Array<keyof typeof GameMapType>
  ).find((k) => GameMapType[k] === map);
  if (key === undefined) throw new Error(`Unknown map: ${map}`);
  return key.toLowerCase();
}

class ApiMapLoader implements GameMapLoader {
  getMapData(map: GameMapType): MapData {
    const dir = path.join(MAPS_DIR, mapDirName(map));
    const bin = (name: string) => async () =>
      new Uint8Array(await fsp.readFile(path.join(dir, name)));
    return {
      mapBin: bin("map.bin"),
      map4xBin: bin("map4x.bin"),
      map16xBin: bin("map16x.bin"),
      manifest: async () =>
        JSON.parse(
          await fsp.readFile(path.join(dir, "manifest.json"), "utf8"),
        ) as MapManifest,
      webpPath: "",
      layerPng: async () => {
        throw new Error("the API never renders map layers");
      },
    };
  }
}

// The simulation logs as it goes (wins, per-tick debug); none of it belongs in
// the API's logs. Warnings and errors still go out.
console.log = console.info = console.debug = () => {};

// First in line for the OOM killer (Linux only; elsewhere this is skipped).
try {
  fs.writeFileSync("/proc/self/oom_score_adj", "1000");
} catch {
  // not Linux
}

async function replay(req: SoloReplayRequest) {
  const { gameMap, gameMapSize } = req.gameStart.config;
  const map = await loadMapFiles(new ApiMapLoader(), gameMap, gameMapSize);
  return replaySolo(req.gameStart, req.turns, map);
}

process.once("message", (req: SoloReplayRequest) => {
  replay(req)
    .then(
      (result): SoloReplayResponse => ({ ok: true, result }),
      (error: unknown): SoloReplayResponse => ({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      }),
    )
    .then((res) => process.send!(res, () => process.exit(0)));
});
