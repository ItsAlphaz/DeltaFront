import { TileRef } from "@openfront/engine-api/game/GameMap";
import { UnitType } from "@openfront/engine-api/game/GameTypes";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  attackMenuElement,
  MenuElementParams,
} from "../../../src/client/hud/layers/RadialMenuElements";
import { BuildUnitIntentEvent } from "../../../src/client/Transport";
import { GameView, PlayerView } from "../../../src/client/view";

vi.mock("../../../src/client/Utils", () => ({
  translateText: vi.fn((key: string) => key),
}));
vi.mock("@openfront/engine-lib/Format", () => ({
  renderNumber: vi.fn((num: number) => num.toString()),
}));
vi.mock("../../../src/client/hud/layers/BuildMenu", async () => {
  const { UnitType } = await vi.importActual<
    typeof import("@openfront/engine-api/game/GameTypes")
  >("@openfront/engine-api/game/GameTypes");
  return {
    flattenedBuildTable: [
      {
        unitType: UnitType.Airstrike,
        key: "unit_type.airstrike",
        description: "build_menu.desc.airstrike",
        icon: "airstrike-icon",
        countable: false,
      },
    ],
  };
});
vi.mock("nanoid", () => ({
  customAlphabet: vi.fn(() => vi.fn(() => "mock-id")),
}));
vi.mock("dompurify", () => ({
  __esModule: true,
  default: { sanitize: vi.fn((str: string) => str) },
}));

const TILE = 77 as TileRef;
const STRIKES = [
  UnitType.BombingRun,
  UnitType.RocketStrike,
  UnitType.StrafingRun,
] as const;

describe("radial menu Airstrike item", () => {
  let params: MenuElementParams;
  let disabledTypes: Set<string>;
  let buildable: Array<{ type: UnitType; canBuild: boolean; cost: bigint }>;
  let canBuildOrUpgrade: boolean;

  const airstrike = () => {
    const items = attackMenuElement.subMenu!(params);
    const item = items.find((i) => i.name === "airstrike");
    expect(item, "airstrike item").toBeDefined();
    return item!;
  };

  beforeEach(() => {
    disabledTypes = new Set();
    canBuildOrUpgrade = true;
    buildable = STRIKES.map((type) => ({ type, canBuild: true, cost: 500n }));

    const enemy = { isPlayer: () => true, smallID: () => 2 };
    const me = {
      id: () => 1,
      smallID: () => 1,
      isFriendly: () => false,
      isPlayer: () => true,
      gold: () => 10_000n,
      units: () => [],
    } as unknown as PlayerView;

    const game = {
      inSpawnPhase: () => false,
      isSpawnImmunityActive: () => false,
      isLand: () => true,
      isImpassable: () => false,
      owner: () => enemy,
      config: () => ({
        isUnitDisabled: (t: string) => disabledTypes.has(t),
        airportRange: () => 400,
        AirportCooldown: () => 200,
        msPerTick: () => 100,
      }),
    } as unknown as GameView;

    params = {
      myPlayer: me,
      selected: enemy as unknown as PlayerView,
      tile: TILE,
      playerActions: {
        get buildableUnits() {
          return buildable;
        },
      } as any,
      game,
      buildMenu: {
        canBuildOrUpgrade: () => canBuildOrUpgrade,
        cost: () => 500n,
        count: () => 0,
      } as any,
      emojiTable: {} as any,
      playerActionHandler: {} as any,
      playerPanel: {} as any,
      chatIntegration: {} as any,
      eventBus: { emit: vi.fn() } as any,
      closeMenu: vi.fn(),
    };
  });

  it("offers the three strikes as a submenu of one Airstrike item", () => {
    const item = airstrike();
    expect(item.disabled(params)).toBe(false);
    const subMenu = item.subMenu!(params);
    expect(subMenu.map((s) => s.name)).toEqual([
      "bombing_run",
      "rocket_strike",
      "strafing_run",
    ]);
    expect(subMenu.every((s) => s.disabled(params) === false)).toBe(true);
  });

  it("launches the chosen strike at the clicked tile and closes the menu", () => {
    const rocket = airstrike().subMenu!(params)[1];
    rocket.action!(params);

    expect(params.eventBus.emit).toHaveBeenCalledTimes(1);
    const sent = (params.eventBus.emit as any).mock
      .calls[0][0] as BuildUnitIntentEvent;
    expect(sent).toBeInstanceOf(BuildUnitIntentEvent);
    expect(sent.unit).toBe(UnitType.RocketStrike);
    expect(sent.tile).toBe(TILE);
    expect(params.closeMenu).toHaveBeenCalledTimes(1);
  });

  it("the item itself never launches anything", () => {
    airstrike().action!(params);
    expect(params.eventBus.emit).not.toHaveBeenCalled();
  });

  it("hides strikes the game has disabled", () => {
    disabledTypes.add(UnitType.RocketStrike);
    const subMenu = airstrike().subMenu!(params);
    expect(subMenu.map((s) => s.name)).toEqual(["bombing_run", "strafing_run"]);
  });

  it("greys out a strike the engine refuses and explains why", () => {
    buildable[0].canBuild = false; // no airport in range
    const subMenu = airstrike().subMenu!(params);
    const bombing = subMenu[0];
    expect(bombing.disabled(params)).toBe(true);
    expect(subMenu[1].disabled(params)).toBe(false);
    expect(bombing.tooltipItems!.map((t) => t.text)).toContain(
      "airstrike_menu.reason.no_airport",
    );

    // A refused strike sends nothing and keeps the menu open.
    bombing.action!(params);
    expect(params.eventBus.emit).not.toHaveBeenCalled();
    expect(params.closeMenu).not.toHaveBeenCalled();
  });

  it("greys out the whole item, with the reason, when nothing can launch", () => {
    canBuildOrUpgrade = false;
    for (const b of buildable) b.canBuild = false;
    const item = airstrike();
    expect(item.disabled(params)).toBe(true);
    expect(item.tooltipItems!.map((t) => t.text)).toContain(
      "airstrike_menu.reason.no_airport",
    );
  });
});
