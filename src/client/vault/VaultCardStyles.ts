import { VAULT_TILT_CSS } from "./VaultTilt";

/**
 * The pixel item card, which the Vault's collection and the shop share: a
 * pixel frame in the rarity's colour (`tone()` sets `--c` and `--bi` on it), a
 * dithered body in two flat bands, the art in an inset box, a hard shadow on
 * hover, and on the epic and legendary ones a light running round the edge a
 * block at a time. It leans towards the pointer through `.vault-tilt` and
 * `tiltMove` (VaultTilt.ts).
 *
 * The shop's card also sets `data-shop`, which lets what it holds (a variant's
 * swatches, a buy button, the info tooltip) overflow the card and puts the
 * pixel face on it, as `.vault-px` does on the Vault's page.
 */
export const PIXEL_CARD_CSS = `
.vault-item { --u: 4px; --dither: conic-gradient(rgba(255,255,255,.06) 25%, transparent 0 50%, rgba(255,255,255,.06) 0 75%, transparent 0) 0 0 / calc(var(--u) * 2) calc(var(--u) * 2); position: relative; display: flex; height: 100%; flex-direction: column; overflow: hidden; border: var(--u) solid transparent; border-image: var(--bi) 1 / var(--u) / 0 stretch; background-clip: padding-box; background: var(--dither), linear-gradient(180deg, color-mix(in srgb, var(--c) 20%, #16151d) 0 46%, #111016 46%); transition: box-shadow .12s steps(2, end); }
@media (max-width: 640px) { .vault-item { --u: 3px; } }
.vault-item:hover { box-shadow: 0 6px 0 color-mix(in srgb, var(--c) 45%, #000); }
.vault-item .vault-item-art { position: relative; aspect-ratio: 5 / 4; margin: 10px 10px 0; padding: 8px; background: rgba(0,0,0,.4); box-shadow: inset 0 0 0 3px rgba(255,255,255,.07); transition: filter .15s steps(3, end), opacity .15s steps(3, end); }
.vault-item[data-owned="false"] .vault-item-art { filter: grayscale(1) brightness(.5); opacity: .8; }
.vault-item[data-owned="false"]:hover .vault-item-art { filter: grayscale(.3) brightness(.9); opacity: 1; }
.vault-item .vault-item-state { position: absolute; top: 14px; right: 14px; z-index: 3; display: inline-flex; align-items: center; gap: 4px; padding: 3px 7px; font-size: 14px; font-weight: 700; letter-spacing: .1em; text-transform: uppercase; }
.vault-item[data-owned="true"] .vault-item-state { background: #14391f; color: #4ade80; box-shadow: inset 0 0 0 2px #2d8a4e; }
.vault-item[data-owned="false"] .vault-item-state { background: rgba(0,0,0,.6); color: var(--color-ui-muted); box-shadow: inset 0 0 0 2px #2a2a33; }
/* a light running round the edge of the epic and legendary ones, a block at a time */
.vault-edge { position: absolute; inset: 0; z-index: 2; pointer-events: none; background: repeating-linear-gradient(90deg, var(--c) 0 8px, transparent 8px 16px) 0 0 / 100% 4px no-repeat, repeating-linear-gradient(90deg, var(--c) 0 8px, transparent 8px 16px) 0 100% / 100% 4px no-repeat, repeating-linear-gradient(0deg, var(--c) 0 8px, transparent 8px 16px) 0 0 / 4px 100% no-repeat, repeating-linear-gradient(0deg, var(--c) 0 8px, transparent 8px 16px) 100% 0 / 4px 100% no-repeat; animation: vault-march .8s steps(4) infinite; }
@keyframes vault-march { to { background-position: 16px 0, -16px 100%, 0 -16px, 100% 16px; } }
.vault-item[data-owned="false"] .vault-edge { opacity: .45; }

/* the shop's card */
.vault-item[data-shop], .vault-item[data-shop] * { font-family: var(--font-pixel, "Pixelify Sans"), Inter, system-ui, sans-serif; }
.vault-item[data-shop] { overflow: visible; }
.vault-item[data-shop] .vault-item-art { aspect-ratio: auto; display: flex; align-items: center; justify-content: center; overflow: hidden; }
.vault-item[data-shop] .vault-item-art > cosmetic-preview { max-width: 100%; }
.vault-item[data-shop] .vault-edge, .vault-item[data-shop] .vault-glare { z-index: 2; }
.vault-item[data-shop] [data-cosmetic-main] { padding: 0; }
.vault-item[data-shop] button, .vault-item[data-shop] [data-cosmetic-action] > *, .vault-item[data-shop] [data-cosmetic-status] { border-radius: 0; }
.vault-item[data-shop] [data-cosmetic-name] { font-size: 17px; letter-spacing: .02em; text-transform: none; }
.vault-item[data-shop] [data-cosmetic-rarity-label] { font-size: 12px; font-weight: 700; letter-spacing: .2em; text-transform: uppercase; }
.vault-item[data-shop] [data-cosmetic-equipped] { border-radius: 0; background: #14391f; color: #4ade80; box-shadow: inset 0 0 0 2px #2d8a4e; }
.vault-item[data-shop][data-state="focused"] { box-shadow: 0 6px 0 color-mix(in srgb, var(--c) 70%, #000); }
.vault-item[data-shop][data-state="equipped"] { box-shadow: 0 6px 0 #2d8a4e; }

@media (prefers-reduced-motion: reduce) { .vault-edge { animation: none !important; } .vault-item { transition: none; } }
`;

/** Everything a page needs to draw pixel item cards: the card and the lean towards the pointer. */
export const PIXEL_CARD_PAGE_CSS = `${VAULT_TILT_CSS}\n${PIXEL_CARD_CSS}`;

const STYLE_ID = "vault-pixel-card-styles";

/** Puts the pixel card's stylesheet on the page, once (the shop has no Vault page to carry it). */
export function ensurePixelCardStyles(): void {
  if (typeof document === "undefined") return;
  if (document.getElementById(STYLE_ID) !== null) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = PIXEL_CARD_PAGE_CSS;
  document.head.appendChild(style);
}
