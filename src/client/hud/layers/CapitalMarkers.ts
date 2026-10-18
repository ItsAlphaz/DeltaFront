import { Cell } from "@openfront/engine-api/game/GameTypes";
import { LitElement } from "lit";
import { customElement } from "lit/decorators.js";
import { Controller } from "../../Controller";
import type { TilePicker } from "../../resistance/TilePicker";
import type { TransformHandler } from "../../TransformHandler";
import { translateText } from "../../Utils";
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
const GHOST_MIN = 44;

const BADGE_SVG = `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M5 20h14M7 20V11l5-4 5 4v9" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M12 7V3.5" stroke="#fff" stroke-width="2" stroke-linecap="round"/></svg>`;

@customElement("capital-markers")
export class CapitalMarkers extends LitElement implements Controller {
  public game: GameView;
  public transformHandler: TransformHandler;
  /** While a capital is being placed, what is under the pointer (a preview is drawn there). */
  public picker: TilePicker | null = null;

  private ghost: HTMLElement | null = null;
  private markers = new Map<number, HTMLElement>();
  /** Capitals going up: a marker with a ring that fills as the building nears its end. */
  private building = new Map<number, HTMLElement>();
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
      const isNew = el === undefined;
      if (el === undefined) {
        el = document.createElement("div");
        el.className = "df-capital-marker";
        el.innerHTML = BADGE_SVG;
        el.dataset.capitalOf = String(p.smallID());
        this.appendChild(el);
        this.markers.set(p.smallID(), el);
      }
      if (isNew && !game.isCatchingUp()) {
        // A capital that has just been founded: a burst of rings where it stands.
        el.classList.add("burst");
        el.addEventListener("animationend", (e) => {
          if ((e as AnimationEvent).animationName === "df-capital-burst") {
            el?.classList.remove("burst");
          }
        });
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
    this.placeBuilding(size, mySmallID);
    this.placeGhost(size);
  }

  /** A capital being built, in its owner's colour, with how far along it is. */
  private placeBuilding(size: number, mySmallID: number): void {
    const game = this.game;
    const view = this.transformHandler;
    const shown = new Set<number>();
    for (const p of game.players()) {
      if (!p.isAlive() || p.hasCapital() || !p.isBuildingCapital()) continue;
      const tile = p.capitalBuildTile();
      const cell = new Cell(game.x(tile), game.y(tile));
      if (!view.isOnScreen(cell)) continue;
      const at = view.worldToScreenCoordinates(cell);
      let el = this.building.get(p.smallID());
      if (el === undefined) {
        el = document.createElement("div");
        el.className = "df-capital-marker building";
        // The progress bar every building has, under the capital itself.
        el.innerHTML = `${BADGE_SVG}<div class="df-capital-bar"><i></i></div>`;
        el.dataset.capitalBuilding = String(p.smallID());
        this.appendChild(el);
        this.building.set(p.smallID(), el);
      }
      el.classList.toggle("mine", p.smallID() === mySmallID);
      el.style.setProperty("--capital-color", p.territoryColor().toHex());
      const percent = p.capitalBuildPercent();
      el.style.setProperty("--progress", `${percent}%`);
      const fill = el.querySelector<HTMLElement>(".df-capital-bar i");
      if (fill !== null) fill.style.width = `${percent}%`;
      el.style.width = el.style.height = `${size}px`;
      el.style.transform = `translate(${at.x - size / 2}px, ${at.y - size / 2}px)`;
      shown.add(p.smallID());
    }
    for (const [id, el] of this.building) {
      if (shown.has(id)) continue;
      el.remove();
      this.building.delete(id);
    }
  }

  /**
   * The capital as it would stand where the pointer is: translucent in the
   * player's colour, like a building being placed, and red with the reason when
   * the tile will not do. It draws nothing the engine does not check again.
   */
  private placeGhost(size: number): void {
    const hover = this.picker?.ghost ? this.picker.hover() : null;
    const game = this.game;
    const me = game.myPlayer();
    if (hover === null || me === null) {
      this.ghost?.remove();
      this.ghost = null;
      return;
    }
    if (this.ghost === null) {
      const el = document.createElement("div");
      el.className = "df-capital-ghost";
      el.dataset.capitalGhost = "";
      el.innerHTML = `${BADGE_SVG}<span class="df-capital-ghost-label"></span>`;
      this.appendChild(el);
      this.ghost = el;
    }
    const el = this.ghost;
    const cell = new Cell(game.x(hover.tile), game.y(hover.tile));
    const at = this.transformHandler.worldToScreenCoordinates(cell);
    // Larger than the badge it will become, so it reads at a glance.
    const big = Math.max(GHOST_MIN, size * 1.8);
    const ok = hover.why === null;
    el.classList.toggle("ok", ok);
    el.classList.toggle("bad", !ok);
    el.style.setProperty("--capital-color", me.territoryColor().toHex());
    el.style.width = el.style.height = `${big}px`;
    el.style.transform = `translate(${at.x - big / 2}px, ${at.y - big / 2}px)`;
    const label = el.querySelector<HTMLElement>(".df-capital-ghost-label");
    if (label !== null) {
      label.textContent = ok
        ? translateText("capital_action.ghost_ok")
        : (hover.why ?? "");
    }
  }

  private ensureStyle(): void {
    if (document.getElementById("df-capital-marker-style") !== null) return;
    const style = document.createElement("style");
    style.id = "df-capital-marker-style";
    style.textContent = `
      .df-capital-marker {
        position: absolute; left: 0; top: 0; box-sizing: border-box;
        /* No padding in percent: it resolves against the containing block (the
           whole screen), which made every badge a disc hundreds of pixels wide. */
        display: grid; place-items: center;
        border-radius: 50%;
        background: var(--capital-color, #888);
        border: 2px solid rgba(255,255,255,.92);
        box-shadow: 0 0 0 1px rgba(0,0,0,.7), 0 2px 6px rgba(0,0,0,.6);
        will-change: transform;
      }
      .df-capital-marker svg { width: 70%; height: 70%; display: block; }
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
      .df-capital-marker.building {
        opacity: 0.8;
        border-style: dotted;
      }
      .df-capital-bar {
        position: absolute; left: 50%; top: 100%; margin-top: 5px;
        transform: translateX(-50%); width: max(40px, 170%); height: 7px; box-sizing: border-box;
        background: rgba(0,0,0,.7); border: 1px solid rgba(255,255,255,.9);
        box-shadow: 0 1px 4px rgba(0,0,0,.6);
      }
      .df-capital-bar i {
        display: block; height: 100%; width: 0;
        background: linear-gradient(180deg, #ffe38a, #ffa51f);
        transition: width .25s linear;
      }
      .df-capital-marker.burst::before {
        content: ""; position: absolute; inset: -10px; border-radius: 50%;
        border: 3px solid #ffd45c; box-shadow: 0 0 24px 6px rgba(255, 190, 40, .8);
        animation: df-capital-burst 1.6s ease-out 3 forwards;
      }
      @keyframes df-capital-burst {
        0% { transform: scale(.6); opacity: 1; }
        100% { transform: scale(5); opacity: 0; }
      }
      .df-capital-ghost {
        position: absolute; left: 0; top: 0; box-sizing: border-box;
        display: grid; place-items: center; border-radius: 50%;
        /* translucent like a building being placed, but not its label */
        background: color-mix(in srgb, var(--capital-color, #888) 55%, rgba(0,0,0,.45));
        border: 3px dashed #fff;
        box-shadow: 0 0 0 2px rgba(0,0,0,.85), 0 0 18px 4px rgba(255,255,255,.4);
        will-change: transform;
      }
      .df-capital-ghost svg { width: 70%; height: 70%; display: block; filter: drop-shadow(0 0 2px #000) drop-shadow(0 0 1px #000); }
      .df-capital-ghost.bad { background: rgba(179,38,30,.75); border-color: #ffb4ab; }
      .df-capital-ghost-label {
        position: absolute; left: 50%; top: 100%; margin-top: 8px; transform: translateX(-50%);
        white-space: nowrap; padding: 3px 8px; font: 600 11px Inter, system-ui, sans-serif;
        color: #fff; background: rgba(10,10,10,.85); border-radius: 3px; opacity: 1;
      }
      .df-capital-ghost.bad .df-capital-ghost-label { background: rgba(120,20,15,.92); }
      @media (prefers-reduced-motion: reduce) {
        .df-capital-marker.mine::after { animation: none; opacity: .7; }
        .df-capital-marker.burst::before { animation: none; opacity: 0; }
      }
    `;
    document.head.appendChild(style);
  }
}
