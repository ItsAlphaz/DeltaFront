import { TileRef } from "@openfront/engine-api/game/GameMap";
import {
  AirstrikeUnitType,
  PlayerBuildableUnitType,
} from "@openfront/engine-api/game/GameTypes";

export interface UIState {
  attackRatio: number;
  ghostStructure: PlayerBuildableUnitType | null;
  rocketDirectionUp: boolean;
  upgradeMultiplier: number;
  /**
   * The tile an Airstrike was aimed at while the strike-type menu is open
   * (null = menu closed). Non-null exactly while `<airstrike-type-menu>` is
   * shown; every way of closing the menu clears it.
   */
  airstrikeTarget: TileRef | null;
  /** The strike type selected in the menu (also the last one used). */
  airstrikeType: AirstrikeUnitType;
  /**
   * While a tile is being chosen for an order (a resistance base, a replacement
   * capital) the next map click belongs to that order, not to the attack a click
   * normally sends. Owned by TilePicker; absent or null when not choosing.
   */
  pickMode?: PickMode | null;
}

export type PickMode = "resistance_base" | "found_capital";
