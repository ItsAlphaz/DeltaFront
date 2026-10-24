import { describe, expect, it } from "vitest";
import {
  blankGrid,
  flipGrid,
  floodFill,
  invertGrid,
  lineCells,
  paintCell,
  paintLine,
  resizeGrid,
  sameGrid,
} from "../../src/client/SkinEditorOps";

const rows = (grid: { width: number; secondary: boolean[] }) => {
  const out: string[] = [];
  for (let i = 0; i < grid.secondary.length; i += grid.width) {
    out.push(
      grid.secondary
        .slice(i, i + grid.width)
        .map((c) => (c ? "#" : "."))
        .join(""),
    );
  }
  return out;
};
const fromRows = (lines: string[], scale = 1) => ({
  width: lines[0].length,
  height: lines.length,
  scale,
  secondary: lines.flatMap((line) => [...line].map((c) => c === "#")),
});

describe("painting a cell", () => {
  it("sets one cell and leaves the old grid alone", () => {
    const grid = blankGrid(4);
    const next = paintCell(grid, 1, 2, true);
    expect(rows(next)).toEqual(["....", "....", ".#..", "...."]);
    expect(rows(grid)).toEqual(["....", "....", "....", "...."]);
  });

  it("returns the very same grid when nothing would change", () => {
    const grid = blankGrid(4);
    expect(paintCell(grid, 1, 1, false)).toBe(grid);
    for (const [x, y] of [
      [-1, 0],
      [0, -1],
      [4, 0],
      [0, 4],
      [1.5, 1],
    ]) {
      expect(paintCell(grid, x, y, true), `${x},${y}`).toBe(grid);
    }
  });
});

describe("drawing a line", () => {
  it("passes over every cell between two points, both ends included", () => {
    expect(lineCells({ x: 0, y: 0 }, { x: 3, y: 0 })).toEqual([
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 2, y: 0 },
      { x: 3, y: 0 },
    ]);
    expect(lineCells({ x: 2, y: 2 }, { x: 2, y: 2 })).toEqual([{ x: 2, y: 2 }]);
    expect(lineCells({ x: 3, y: 3 }, { x: 0, y: 0 })).toHaveLength(4);
  });

  it("leaves no gap in a fast drag, and stays inside the grid", () => {
    const grid = paintLine(blankGrid(5), { x: 0, y: 0 }, { x: 4, y: 4 }, true);
    expect(rows(grid)).toEqual(["#....", ".#...", "..#..", "...#.", "....#"]);
    const cropped = paintLine(
      blankGrid(3),
      { x: -2, y: 1 },
      { x: 5, y: 1 },
      true,
    );
    expect(rows(cropped)).toEqual(["...", "###", "..."]);
  });
});

describe("the paint bucket", () => {
  it("fills the connected cells of one colour, not across a wall", () => {
    const grid = fromRows(["..#..", "..#..", "..#.."]);
    expect(rows(floodFill(grid, 0, 0, true))).toEqual([
      "###..",
      "###..",
      "###..",
    ]);
    expect(rows(floodFill(grid, 4, 2, true))).toEqual([
      "..###",
      "..###",
      "..###",
    ]);
  });

  it("does not run diagonally", () => {
    const grid = fromRows([".#", "#."]);
    expect(rows(floodFill(grid, 0, 0, true))).toEqual(["##", "#."]);
  });

  it("changes nothing for the colour already there, or a point outside", () => {
    const grid = blankGrid(3);
    expect(floodFill(grid, 1, 1, false)).toBe(grid);
    expect(floodFill(grid, 3, 1, true)).toBe(grid);
  });
});

describe("whole-picture changes", () => {
  it("inverts the colours", () => {
    expect(rows(invertGrid(fromRows(["#.", ".."])))).toEqual([".#", "##"]);
  });

  it("flips left to right", () => {
    expect(rows(flipGrid(fromRows(["#..", ".#."])))).toEqual(["..#", ".#."]);
  });

  it("keeps the corner when the grid grows, and crops when it shrinks", () => {
    const grid = fromRows(["#.", ".#"]);
    expect(rows(resizeGrid(grid, 3))).toEqual(["#..", ".#.", "..."]);
    expect(rows(resizeGrid(fromRows(["#.#", ".#.", "#.#"]), 2))).toEqual([
      "#.",
      ".#",
    ]);
    expect(resizeGrid(grid, 4).scale).toBe(grid.scale);
  });

  it("compares by picture", () => {
    expect(sameGrid(fromRows(["#."]), fromRows(["#."]))).toBe(true);
    expect(sameGrid(fromRows(["#."]), fromRows([".#"]))).toBe(false);
    expect(sameGrid(fromRows(["#."], 1), fromRows(["#."], 2))).toBe(false);
  });
});
