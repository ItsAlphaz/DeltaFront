import type { SkinGrid } from "@openfront/shared/CustomSkins";

/**
 * The drawing operations of the skin creator, on a SkinGrid. Each returns a new
 * grid (or the same one when nothing changed), so the editor can keep a history
 * by holding on to the old ones.
 */

const at = (grid: SkinGrid, x: number, y: number) => y * grid.width + x;
const inside = (grid: SkinGrid, x: number, y: number) =>
  Number.isInteger(x) &&
  Number.isInteger(y) &&
  x >= 0 &&
  y >= 0 &&
  x < grid.width &&
  y < grid.height;

/** A grid of one colour: every cell primary (false) or secondary (true). */
export function blankGrid(
  size: number,
  scale = 1,
  secondary = false,
): SkinGrid {
  return {
    width: size,
    height: size,
    scale,
    secondary: Array.from({ length: size * size }, () => secondary),
  };
}

/** Sets one cell. Out of range, or already that colour: the grid is returned as it was. */
export function paintCell(
  grid: SkinGrid,
  x: number,
  y: number,
  secondary: boolean,
): SkinGrid {
  if (!inside(grid, x, y) || grid.secondary[at(grid, x, y)] === secondary) {
    return grid;
  }
  const cells = grid.secondary.slice();
  cells[at(grid, x, y)] = secondary;
  return { ...grid, secondary: cells };
}

/** The cells a straight stroke from one point to another passes over (both ends included). */
export function lineCells(
  from: { x: number; y: number },
  to: { x: number; y: number },
): Array<{ x: number; y: number }> {
  const cells: Array<{ x: number; y: number }> = [];
  let x = from.x;
  let y = from.y;
  const dx = Math.abs(to.x - x);
  const dy = -Math.abs(to.y - y);
  const sx = x < to.x ? 1 : -1;
  const sy = y < to.y ? 1 : -1;
  let error = dx + dy;
  for (;;) {
    cells.push({ x, y });
    if (x === to.x && y === to.y) break;
    const doubled = 2 * error;
    if (doubled >= dy) {
      error += dy;
      x += sx;
    }
    if (doubled <= dx) {
      error += dx;
      y += sy;
    }
  }
  return cells;
}

/** Paints a stroke, so a fast drag leaves no gaps. */
export function paintLine(
  grid: SkinGrid,
  from: { x: number; y: number },
  to: { x: number; y: number },
  secondary: boolean,
): SkinGrid {
  let result = grid;
  for (const cell of lineCells(from, to)) {
    result = paintCell(result, cell.x, cell.y, secondary);
  }
  return result;
}

/** Fills the connected cells of the same colour, four ways, like a paint bucket. */
export function floodFill(
  grid: SkinGrid,
  x: number,
  y: number,
  secondary: boolean,
): SkinGrid {
  if (!inside(grid, x, y)) return grid;
  const target = grid.secondary[at(grid, x, y)];
  if (target === secondary) return grid;
  const cells = grid.secondary.slice();
  const stack = [{ x, y }];
  while (stack.length > 0) {
    const cell = stack.pop()!;
    if (
      !inside(grid, cell.x, cell.y) ||
      cells[at(grid, cell.x, cell.y)] !== target
    ) {
      continue;
    }
    cells[at(grid, cell.x, cell.y)] = secondary;
    stack.push(
      { x: cell.x + 1, y: cell.y },
      { x: cell.x - 1, y: cell.y },
      { x: cell.x, y: cell.y + 1 },
      { x: cell.x, y: cell.y - 1 },
    );
  }
  return { ...grid, secondary: cells };
}

/** Swaps the two colours. */
export function invertGrid(grid: SkinGrid): SkinGrid {
  return { ...grid, secondary: grid.secondary.map((cell) => !cell) };
}

/** Mirrors the picture left to right. */
export function flipGrid(grid: SkinGrid): SkinGrid {
  const cells = grid.secondary.slice();
  for (let y = 0; y < grid.height; y++) {
    for (let x = 0; x < grid.width; x++) {
      cells[at(grid, x, y)] = grid.secondary[at(grid, grid.width - 1 - x, y)];
    }
  }
  return { ...grid, secondary: cells };
}

/**
 * Changes the grid's size, keeping what fits: a bigger grid keeps the picture
 * in its top-left corner and fills the rest with the primary colour, a smaller
 * one crops it.
 */
export function resizeGrid(grid: SkinGrid, size: number): SkinGrid {
  const next = blankGrid(size, grid.scale);
  for (let y = 0; y < Math.min(size, grid.height); y++) {
    for (let x = 0; x < Math.min(size, grid.width); x++) {
      next.secondary[y * size + x] = grid.secondary[at(grid, x, y)];
    }
  }
  return next;
}

/** Whether two grids are the same picture. */
export function sameGrid(a: SkinGrid, b: SkinGrid): boolean {
  return (
    a.width === b.width &&
    a.height === b.height &&
    a.scale === b.scale &&
    a.secondary.every((cell, i) => cell === b.secondary[i])
  );
}
