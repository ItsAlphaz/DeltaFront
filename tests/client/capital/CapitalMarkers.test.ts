import { afterEach, beforeEach, describe, expect, it } from "vitest";
import "../../../src/client/hud/layers/CapitalMarkers";
import type { CapitalMarkers } from "../../../src/client/hud/layers/CapitalMarkers";

/** Players with the capitals the engine reports, and a camera that puts every tile on screen. */
function world() {
  const state = {
    scale: 1.8,
    catchingUp: false,
    onScreen: true,
    tick: 1000,
    players: [
      {
        small: 1,
        tile: 100,
        alive: true,
        has: true,
        replacement: false,
        building: false,
        buildTile: -1,
        buildPercent: 0,
        founded: 998,
        color: "#3366ff",
      },
      {
        small: 2,
        tile: 200,
        alive: true,
        has: true,
        replacement: true,
        building: false,
        buildTile: -1,
        buildPercent: 0,
        founded: 999,
        color: "#ff6633",
      },
    ],
  };
  const game = {
    isCatchingUp: () => state.catchingUp,
    ticks: () => state.tick,
    isValidCoord: () => true,
    myPlayer: () => ({
      smallID: () => 1,
      territoryColor: () => ({ toHex: () => "#3366ff" }),
    }),
    players: () =>
      state.players.map((p) => ({
        smallID: () => p.small,
        hasCapital: () => p.has,
        isAlive: () => p.alive,
        capitalTile: () => p.tile,
        capitalFoundedTick: () => p.founded,
        capitalIsReplacement: () => p.replacement,
        isBuildingCapital: () => p.building,
        capitalBuildTile: () => p.buildTile,
        capitalBuildPercent: () => p.buildPercent,
        territoryColor: () => ({ toHex: () => p.color }),
      })),
    x: (t: number) => t % 50,
    y: (t: number) => Math.floor(t / 50),
  };
  const transformHandler = {
    get scale() {
      return state.scale;
    },
    isOnScreen: () => state.onScreen,
    worldToScreenCoordinates: (c: { x: number; y: number }) => ({
      x: 10 * c.x,
      y: 10 * c.y,
    }),
  };
  return { state, game, transformHandler };
}

// The capital badges (docs/Capital.md). The CSS is what a browser lays out and
// jsdom cannot, so the second half pins the one rule that went wrong: a
// percentage padding resolves against the containing block (the whole screen),
// which made every badge a disc hundreds of pixels wide, whatever size the layer
// gave it. The real-browser run (docs/PreReleasePlaytest.md, row 1.1) measures
// the badge on screen.
describe("CapitalMarkers", () => {
  let markers: CapitalMarkers;
  let w: ReturnType<typeof world>;
  const place = () => (markers as unknown as { place(): void }).place();
  const all = () => [
    ...markers.querySelectorAll<HTMLElement>(".df-capital-marker"),
  ];

  beforeEach(() => {
    w = world();
    markers = document.createElement("capital-markers") as CapitalMarkers;
    markers.game = w.game as never;
    markers.transformHandler = w.transformHandler as never;
    document.body.append(markers);
  });

  afterEach(() => {
    markers.remove();
    document.getElementById("df-capital-marker-style")?.remove();
  });

  it("puts a badge on every capital, in its owner's colour, marking mine and a replacement", () => {
    place();
    const [mine, theirs] = all();
    expect(all()).toHaveLength(2);
    expect(mine.dataset.capitalOf).toBe("1");
    expect(mine.classList.contains("mine")).toBe(true);
    expect(mine.classList.contains("replacement")).toBe(false);
    expect(mine.style.getPropertyValue("--capital-color")).toBe("#3366ff");
    expect(theirs.dataset.capitalOf).toBe("2");
    expect(theirs.classList.contains("mine")).toBe(false);
    expect(theirs.classList.contains("replacement")).toBe(true);
  });

  it("sizes each badge from the zoom, between 14 and 30 pixels, centred on its tile", () => {
    for (const [scale, size] of [
      [0.2, 14],
      [1.8, 18],
      [20, 30],
    ] as const) {
      w.state.scale = scale;
      place();
      const [mine] = all();
      expect(mine.style.width).toBe(`${size}px`);
      expect(mine.style.height).toBe(`${size}px`);
      // Tile 100 is (0, 2): the camera puts it at (0, 20).
      expect(mine.style.transform).toBe(
        `translate(${-size / 2}px, ${20 - size / 2}px)`,
      );
    }
  });

  it("has no element for a capital that is off screen, lost or never founded", () => {
    place();
    expect(all()).toHaveLength(2);
    w.state.onScreen = false;
    place();
    expect(all()).toHaveLength(0);
    w.state.onScreen = true;
    w.state.players[0].has = false;
    w.state.players[1].alive = false;
    place();
    expect(all()).toHaveLength(0);
  });

  it("styles the badge without any percentage padding or margin (they resolve against the screen)", () => {
    (markers as unknown as { ensureStyle(): void }).ensureStyle();
    const css = document.getElementById(
      "df-capital-marker-style",
    )!.textContent!;
    const rule = (selector: string) => {
      const start = css.indexOf(selector + " {");
      expect(start).toBeGreaterThanOrEqual(0);
      return css.slice(start, css.indexOf("}", start));
    };
    const badge = rule(".df-capital-marker");
    expect(badge).not.toMatch(/(padding|margin)[a-z-]*\s*:[^;]*\d%/);
    // A percentage is fine on the icon inside it: that resolves against the badge.
    expect(rule(".df-capital-marker svg")).toMatch(/width:\s*\d+%/);
  });

  it("takes no pointer events and sits under the HUD", () => {
    expect(markers.style.pointerEvents).toBe("none");
    expect(markers.style.position).toBe("fixed");
  });
});

describe("CapitalMarkers: a capital as it is placed, and as it is founded", () => {
  let markers: CapitalMarkers;
  let w: ReturnType<typeof world>;
  const place = () => (markers as unknown as { place(): void }).place();
  const ghost = () =>
    markers.querySelector<HTMLElement>("[data-capital-ghost]");
  let hover: { tile: number; why: string | null } | null;
  let wanted: boolean;

  beforeEach(() => {
    w = world();
    hover = null;
    wanted = true;
    markers = document.createElement("capital-markers") as CapitalMarkers;
    markers.game = w.game as never;
    markers.transformHandler = w.transformHandler as never;
    markers.picker = {
      get ghost() {
        return wanted;
      },
      hover: () => hover,
    } as never;
    document.body.append(markers);
  });
  afterEach(() => {
    markers.remove();
    document.getElementById("df-capital-marker-style")?.remove();
  });

  it("draws a translucent capital at the tile under the pointer, in my colour", () => {
    hover = { tile: 153, why: null }; // (3, 3)
    place();
    const el = ghost()!;
    expect(el).not.toBeNull();
    expect(el.classList.contains("ok")).toBe(true);
    expect(el.style.getPropertyValue("--capital-color")).toBe("#3366ff");
    // Larger than a badge (at least 44 px), centred on the tile (the camera puts (3, 3) at (30, 30)).
    const size = parseFloat(el.style.width);
    expect(size).toBe(44);
    expect(el.style.transform).toBe(
      `translate(${30 - size / 2}px, ${30 - size / 2}px)`,
    );
    expect(el.textContent).toBe("capital_action.ghost_ok");
  });

  it("goes red and says why when the tile will not do", () => {
    hover = { tile: 153, why: "capital_action.tile_border" };
    place();
    expect(ghost()!.classList.contains("bad")).toBe(true);
    expect(ghost()!.textContent).toBe("capital_action.tile_border");
  });

  it("follows the pointer, and is gone when nothing is being placed", () => {
    hover = { tile: 153, why: null };
    place();
    const first = ghost()!.style.transform;
    hover = { tile: 204, why: null }; // (4, 4)
    place();
    expect(ghost()!.style.transform).not.toBe(first);
    expect(markers.querySelectorAll("[data-capital-ghost]")).toHaveLength(1);
    wanted = false;
    place();
    expect(ghost()).toBeNull();
    wanted = true;
    hover = null;
    place();
    expect(ghost()).toBeNull();
  });

  it("is translucent in its body but not its label, and has no percentage padding", () => {
    (markers as unknown as { ensureStyle(): void }).ensureStyle();
    const css = document.getElementById(
      "df-capital-marker-style",
    )!.textContent!;
    const rule = css.slice(
      css.indexOf(".df-capital-ghost {"),
      css.indexOf("}", css.indexOf(".df-capital-ghost {")),
    );
    expect(rule).toMatch(/color-mix\(/);
    expect(rule).not.toMatch(/(^|\s)opacity\s*:/);
    expect(rule).not.toMatch(/(padding|margin)[a-z-]*\s*:[^;]*\d%/);
  });

  it("only a capital founded just now bursts: one that scrolls back into view stays quiet", () => {
    const all = () => [
      ...markers.querySelectorAll<HTMLElement>(".df-capital-marker"),
    ];
    place();
    // Both were founded a moment ago: mine gets the full burst, the other a quiet ring.
    const [mine, theirs] = all();
    expect(mine.classList.contains("burst")).toBe(true);
    expect(mine.classList.contains("other")).toBe(false);
    expect(theirs.classList.contains("burst")).toBe(true);
    expect(theirs.classList.contains("other")).toBe(true);
    // A minute on, the other capital leaves the screen and comes back (its marker is made again).
    w.state.tick = 1600;
    w.state.onScreen = false;
    place();
    expect(all()).toHaveLength(0);
    w.state.onScreen = true;
    place();
    expect(all()).toHaveLength(2);
    expect(markers.querySelectorAll(".burst")).toHaveLength(0);
  });

  it("the burst class is removed when either burst animation ends (the full one and the quiet one)", () => {
    place();
    const els = [
      ...markers.querySelectorAll<HTMLElement>(".df-capital-marker.burst"),
    ];
    expect(els).toHaveLength(2);
    for (const [el, name] of [
      [els[0], "df-capital-burst"],
      [els[1], "df-capital-burst-quiet"],
    ] as const) {
      const e = new Event("animationend");
      Object.defineProperty(e, "animationName", { value: name });
      el.dispatchEvent(e);
      expect(el.classList.contains("burst")).toBe(false);
      expect(el.classList.contains("other")).toBe(false);
    }
  });

  it("the rings are small and quiet: no big glow, a thin single ring for other players", () => {
    (markers as unknown as { ensureStyle(): void }).ensureStyle();
    const css = document.getElementById(
      "df-capital-marker-style",
    )!.textContent!;
    expect(css).toMatch(/scale\(3\.2\)/);
    expect(css).not.toMatch(/scale\(5\)/);
    expect(css).toMatch(/\.burst\.other::before[^}]*box-shadow: none/);
    expect(css).toMatch(/df-capital-ring 3\.6s/);
  });

  it("a capital that appears while playing bursts with rings, once; not while catching up", () => {
    place();
    // Both capitals were there at the first frame: they appeared now.
    expect(markers.querySelectorAll(".df-capital-marker.burst")).toHaveLength(
      2,
    );
    // A frame later nothing new appears: nothing bursts again.
    for (const el of markers.querySelectorAll(".df-capital-marker")) {
      el.classList.remove("burst");
    }
    place();
    expect(markers.querySelectorAll(".burst")).toHaveLength(0);
    // A joiner replaying history sees no fanfare.
    markers.remove();
    markers = document.createElement("capital-markers") as CapitalMarkers;
    w.state.catchingUp = true;
    markers.game = w.game as never;
    markers.transformHandler = w.transformHandler as never;
    document.body.append(markers);
    place();
    expect(markers.querySelectorAll(".burst")).toHaveLength(0);
  });

  it("marks a capital being built where it will stand, with how far along it is, and takes it away when it stands", () => {
    w.state.players[0].has = false;
    w.state.players[0].building = true;
    w.state.players[0].buildTile = 153; // (3, 3)
    w.state.players[0].buildPercent = 40;
    place();
    const el = markers.querySelector<HTMLElement>("[data-capital-building]")!;
    expect(el).not.toBeNull();
    expect(el.dataset.capitalBuilding).toBe("1");
    expect(el.classList.contains("mine")).toBe(true);
    expect(el.style.getPropertyValue("--progress")).toBe("40%");
    // The bar every building has, under the capital itself, filled to how far along it is.
    const fill = el.querySelector<HTMLElement>(".df-capital-bar i")!;
    expect(fill).not.toBeNull();
    expect(fill.style.width).toBe("40%");
    expect(el.style.getPropertyValue("--capital-color")).toBe("#3366ff");
    w.state.players[0].buildPercent = 80;
    place();
    expect(el.style.getPropertyValue("--progress")).toBe("80%");
    expect(fill.style.width).toBe("80%");
    // It stands: the building marker goes and the capital's own appears.
    w.state.players[0].building = false;
    w.state.players[0].has = true;
    place();
    expect(markers.querySelector("[data-capital-building]")).toBeNull();
    expect(markers.querySelector('[data-capital-of="1"]')).not.toBeNull();
  });
});
