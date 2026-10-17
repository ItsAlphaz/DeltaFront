import { Cell } from "@openfront/engine-api/game/GameTypes";
import { LitElement } from "lit";
import { customElement } from "lit/decorators.js";
import { Controller } from "../../Controller";
import type { TransformHandler } from "../../TransformHandler";
import type { GameView } from "../../view";

/**
 * A marker over every capital on the map (docs/Capital.md): a small badge in the
 * owner's territory colour, solid for the founding capital and dashed for a
 * replacement, with a pulsing ring on the local player's own.
 *
 * Capitals are public, like every other structure. The markers are read from
 * engine state (PlayerView.capitalTile) and positioned from the camera each
 * frame; they take no pointer events, and a capital that is off screen has no
 * element at all. Nothing here can change the game.
 */

const SIZE_MIN = 14;
const SIZE_MAX = 30;
const SIZE_PER_ZOOM = 5;

const BADGE_SVG = `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M5 20h14M7 20V11l5-4 5 4v9" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M12 7V3.5" stroke="#fff" stroke-width="2" stroke-linecap="round"/></svg>`;

@customElement("capital-markers")
export class CapitalMarkers extends LitElement implements Controller {
  public game: GameView;
  public transformHandler: TransformHandler;

  private markers = new Map<number, HTMLElement>();
  private raf = 0;

  createRenderRoot() {
    this.style.position = "fixed";
    this.style.inset = "0";
    this.style.pointerEvents = "none";
    this.style.zIndex = "40";
    this.style.overflow = "hidden";
    return this;
  }

  init() {
    this.ensureStyle();
    const frame = () => {
      this.place();
      this.raf = requestAnimationFrame(frame);
    };
    this.raf = requestAnimationFrame(frame);
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    cancelAnimationFrame(this.raf);
    this.markers.clear();
  }

  /** Once per frame: move, create and drop the markers. */
  private place(): void {
    const game = this.game;
    const view = this.transformHandler;
    if (game === undefined || view === undefined) return;

    const mySmallID = game.myPlayer()?.smallID() ?? -1;
    const size = Math.max(
      SIZE_MIN,
      Math.min(SIZE_MAX, SIZE_MIN + view.scale * SIZE_PER_ZOOM - SIZE_PER_ZOOM),
    );
    const shown = new Set<number>();
    for (const p of game.players()) {
      if (!p.hasCapital() || !p.isAlive()) continue;
      const tile = p.capitalTile();
      const cell = new Cell(game.x(tile), game.y(tile));
      if (!view.isOnScreen(cell)) continue;
      const at = view.worldToScreenCoordinates(cell);
      let el = this.markers.get(p.smallID());
      if (el === undefined) {
        el = document.createElement("div");
        el.className = "df-capital-marker";
        el.innerHTML = BADGE_SVG;
        el.dataset.capitalOf = String(p.smallID());
        this.appendChild(el);
        this.markers.set(p.smallID(), el);
      }
      el.classList.toggle("replacement", p.capitalIsReplacement());
      el.classList.toggle("mine", p.smallID() === mySmallID);
      el.style.setProperty("--capital-color", p.territoryColor().toHex());
      el.style.width = el.style.height = `${size}px`;
      el.style.transform = `translate(${at.x - size / 2}px, ${at.y - size / 2}px)`;
      shown.add(p.smallID());
    }
    for (const [id, el] of this.markers) {
      if (shown.has(id)) continue;
      el.remove();
      this.markers.delete(id);
    }
  }

  private ensureStyle(): void {
    if (document.getElementById("df-capital-marker-style") !== null) return;
    const style = document.createElement("style");
    style.id = "df-capital-marker-style";
    style.textContent = `
      .df-capital-marker {
        position: absolute; left: 0; top: 0; box-sizing: border-box;
        border-radius: 50%; padding: 15%;
        background: var(--capital-color, #888);
        border: 2px solid rgba(255,255,255,.92);
        box-shadow: 0 0 0 1px rgba(0,0,0,.7), 0 2px 6px rgba(0,0,0,.6);
        will-change: transform;
      }
      .df-capital-marker svg { width: 100%; height: 100%; display: block; }
      .df-capital-marker.replacement { border-style: dashed; }
      .df-capital-marker.mine::after {
        content: ""; position: absolute; inset: -7px; border-radius: 50%;
        border: 2px solid var(--capital-color, #fff);
        animation: df-capital-ring 2.2s ease-out infinite;
      }
      @keyframes df-capital-ring {
        0% { transform: scale(.7); opacity: .9; }
        100% { transform: scale(1.5); opacity: 0; }
      }
      @media (prefers-reduced-motion: reduce) {
        .df-capital-marker.mine::after { animation: none; opacity: .7; }
      }
    `;
    document.head.appendChild(style);
  }
}
