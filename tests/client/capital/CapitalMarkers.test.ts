import { afterEach, beforeEach, describe, expect, it } from "vitest";
import "../../../src/client/hud/layers/CapitalMarkers";
import type { CapitalMarkers } from "../../../src/client/hud/layers/CapitalMarkers";

/** Players with the capitals the engine reports, and a camera that puts every tile on screen. */
function world() {
  const state = {
    scale: 1.8,
    onScreen: true,
    players: [
      {
        small: 1,
        tile: 100,
        alive: true,
        has: true,
        replacement: false,
        color: "#3366ff",
      },
      {
        small: 2,
        tile: 200,
        alive: true,
        has: true,
        replacement: true,
        color: "#ff6633",
      },
    ],
  };
  const game = {
    myPlayer: () => ({ smallID: () => 1 }),
    players: () =>
      state.players.map((p) => ({
        smallID: () => p.small,
        hasCapital: () => p.has,
        isAlive: () => p.alive,
        capitalTile: () => p.tile,
        capitalIsReplacement: () => p.replacement,
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
