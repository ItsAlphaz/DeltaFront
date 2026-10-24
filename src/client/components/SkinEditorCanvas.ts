import type { SkinGrid } from "@openfront/shared/CustomSkins";
import { html, LitElement, type PropertyValues } from "lit";
import { customElement, property } from "lit/decorators.js";
import { floodFill, paintCell, paintLine } from "../SkinEditorOps";
import { translateText } from "../Utils";

/** What the editor tells its parent: the picture changed, or a stroke began. */
export type SkinEditorTool = "draw" | "fill";

/** A cell's centre in the picture. */
interface Cell {
  x: number;
  y: number;
}

/** Pixels per cell in the canvas, so the picture is crisp at any grid size. */
const TARGET_SIZE = 512;

/**
 * The skin creator's drawing surface: the grid as big square cells, painted
 * with the mouse, a finger or the keyboard. It owns no state of its own: the
 * parent hands it the picture and the two colours, and hears about every change
 * (`grid-change`) and the start of every stroke (`stroke-start`, with the
 * picture as it was, for undo).
 *
 * The primary button paints `secondaryBrush`'s colour and the secondary
 * button (right click) the other one.
 */
@customElement("skin-editor-canvas")
export class SkinEditorCanvas extends LitElement {
  @property({ attribute: false }) grid!: SkinGrid;
  @property() primaryColor = "#e5383b";
  @property() secondaryColor = "#101010";
  @property() tool: SkinEditorTool = "draw";
  /** The colour a normal press paints: false the primary, true the secondary. */
  @property({ type: Boolean }) secondaryBrush = false;

  private stroke: { secondary: boolean; last: Cell } | null = null;
  private hover: Cell | null = null;
  /** The cell the keyboard is on. */
  private cursor: Cell = { x: 0, y: 0 };

  createRenderRoot() {
    return this;
  }

  render() {
    return html`<canvas
      data-skin-canvas
      role="application"
      tabindex="0"
      aria-label=${translateText("skin_creator.canvas_label")}
      class="block aspect-square w-full touch-none select-none rounded-ui-card border border-ui-border-strong bg-ui-ground [image-rendering:pixelated] focus:outline-none focus-visible:ring-2 focus-visible:ring-ui-accent"
      @pointerdown=${this.onPointerDown}
      @pointermove=${this.onPointerMove}
      @pointerup=${this.endStroke}
      @pointercancel=${this.endStroke}
      @pointerleave=${this.onPointerLeave}
      @contextmenu=${(e: Event) => e.preventDefault()}
      @keydown=${this.onKeyDown}
      @focus=${() => this.draw()}
      @blur=${() => this.draw()}
    ></canvas>`;
  }

  protected updated(_changed: PropertyValues<this>): void {
    this.draw();
  }

  private canvas(): HTMLCanvasElement | null {
    return this.querySelector("canvas");
  }

  /** The cell under a pointer, or null when it is outside the picture. */
  private cellAt(event: PointerEvent): Cell | null {
    const canvas = this.canvas();
    if (canvas === null) return null;
    const rect = canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return null;
    const x = Math.floor(
      ((event.clientX - rect.left) / rect.width) * this.grid.width,
    );
    const y = Math.floor(
      ((event.clientY - rect.top) / rect.height) * this.grid.height,
    );
    if (x < 0 || y < 0 || x >= this.grid.width || y >= this.grid.height) {
      return null;
    }
    return { x, y };
  }

  private apply(grid: SkinGrid): void {
    if (grid === this.grid) return;
    this.grid = grid;
    this.dispatchEvent(
      new CustomEvent<SkinGrid>("grid-change", { detail: grid, bubbles: true }),
    );
  }

  private onPointerDown(event: PointerEvent): void {
    if (event.button !== 0 && event.button !== 2) return;
    const cell = this.cellAt(event);
    if (cell === null) return;
    event.preventDefault();
    this.canvas()?.focus({ preventScroll: true });
    this.canvas()?.setPointerCapture?.(event.pointerId);
    const secondary =
      event.button === 2 ? !this.secondaryBrush : this.secondaryBrush;
    this.dispatchEvent(
      new CustomEvent<SkinGrid>("stroke-start", {
        detail: this.grid,
        bubbles: true,
      }),
    );
    this.cursor = cell;
    if (this.tool === "fill") {
      this.apply(floodFill(this.grid, cell.x, cell.y, secondary));
      return;
    }
    this.stroke = { secondary, last: cell };
    this.apply(paintCell(this.grid, cell.x, cell.y, secondary));
  }

  private onPointerMove(event: PointerEvent): void {
    const cell = this.cellAt(event);
    if (this.stroke !== null && cell !== null) {
      this.apply(
        paintLine(this.grid, this.stroke.last, cell, this.stroke.secondary),
      );
      this.stroke.last = cell;
    }
    if (cell?.x !== this.hover?.x || cell?.y !== this.hover?.y) {
      this.hover = cell;
      this.draw();
    }
  }

  private onPointerLeave(): void {
    this.hover = null;
    this.draw();
  }

  private endStroke(event: PointerEvent): void {
    this.stroke = null;
    this.canvas()?.releasePointerCapture?.(event.pointerId);
  }

  /** Arrow keys move, Space or Enter paints, Shift paints the other colour. */
  private onKeyDown(event: KeyboardEvent): void {
    const moves: Record<string, Cell> = {
      ArrowLeft: { x: -1, y: 0 },
      ArrowRight: { x: 1, y: 0 },
      ArrowUp: { x: 0, y: -1 },
      ArrowDown: { x: 0, y: 1 },
    };
    const move = moves[event.key];
    if (move !== undefined) {
      event.preventDefault();
      this.cursor = {
        x: Math.min(this.grid.width - 1, Math.max(0, this.cursor.x + move.x)),
        y: Math.min(this.grid.height - 1, Math.max(0, this.cursor.y + move.y)),
      };
      this.hover = this.cursor;
      this.draw();
      return;
    }
    if (event.key === " " || event.key === "Enter") {
      event.preventDefault();
      const secondary = event.shiftKey
        ? !this.secondaryBrush
        : this.secondaryBrush;
      this.dispatchEvent(
        new CustomEvent<SkinGrid>("stroke-start", {
          detail: this.grid,
          bubbles: true,
        }),
      );
      const { x, y } = this.cursor;
      this.apply(
        this.tool === "fill"
          ? floodFill(this.grid, x, y, secondary)
          : paintCell(this.grid, x, y, secondary),
      );
    }
  }

  private draw(): void {
    const canvas = this.canvas();
    const grid = this.grid;
    if (canvas === null || !grid) return;
    const cell = Math.max(
      1,
      Math.floor(TARGET_SIZE / Math.max(grid.width, grid.height)),
    );
    const width = grid.width * cell;
    const height = grid.height * cell;
    if (canvas.width !== width) canvas.width = width;
    if (canvas.height !== height) canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (ctx === null) return;
    for (let y = 0; y < grid.height; y++) {
      for (let x = 0; x < grid.width; x++) {
        ctx.fillStyle = grid.secondary[y * grid.width + x]
          ? this.secondaryColor
          : this.primaryColor;
        ctx.fillRect(x * cell, y * cell, cell, cell);
      }
    }
    // faint cell lines, so single cells can be told apart
    ctx.strokeStyle = "rgba(255,255,255,0.14)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let i = 1; i < grid.width; i++) {
      ctx.moveTo(i * cell + 0.5, 0);
      ctx.lineTo(i * cell + 0.5, height);
    }
    for (let i = 1; i < grid.height; i++) {
      ctx.moveTo(0, i * cell + 0.5);
      ctx.lineTo(width, i * cell + 0.5);
    }
    ctx.stroke();
    const mark =
      this.hover ?? (document.activeElement === canvas ? this.cursor : null);
    if (mark !== null) {
      ctx.strokeStyle = "#ffffff";
      ctx.lineWidth = Math.max(2, Math.round(cell / 8));
      ctx.strokeRect(
        mark.x * cell + ctx.lineWidth / 2,
        mark.y * cell + ctx.lineWidth / 2,
        cell - ctx.lineWidth,
        cell - ctx.lineWidth,
      );
    }
  }
}
