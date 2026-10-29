import { pixelBorder } from "./VaultPixel";
import { VAULT_TILT_CSS } from "./VaultTilt";

/**
 * The Vault page's stylesheet, put on the page in a <style> (the way the reveal
 * puts its own): the pixel look, and the keyframes and the few things
 * Tailwind's utilities cannot say.
 *
 * Everything is made of whole pixels of `--u` (4px; 3px on a phone): a frame is
 * a `--u` border with its corner pixel left out (`pixelBorder`), shadows are
 * hard, shades are flat bands with a checker dither between them, and what
 * moves moves in steps. The pixel face (Pixelify Sans, the nav's) is used for
 * all text. Colours come from the design system's tokens or, for the rarity of
 * a thing, from `--c` and `--bi` set on it (`tone()`). Every loop starts and
 * ends where nothing shows (off the card, at zero opacity, a full turn) so none
 * of them pauses or jumps, and all of them are off for reduced motion.
 */
const INK = pixelBorder("#0b0814");
const LINE = pixelBorder("#3a3750");
const SOFT = pixelBorder("#26233a");
const GOLD = pixelBorder("#fbbf24");
const RED = pixelBorder("#8b1d28");
const GREEN = pixelBorder("#4ade80");

export const VAULT_CSS = `
${VAULT_TILT_CSS}

.vault-px {
  --u: 4px;
  --bi-ink: ${INK};
  --bi-line: ${LINE};
  --bi-soft: ${SOFT};
  --bi-gold: ${GOLD};
  --bi-red: ${RED};
  --bi-green: ${GREEN};
  --dither: conic-gradient(rgba(255,255,255,.06) 25%, transparent 0 50%, rgba(255,255,255,.06) 0 75%, transparent 0) 0 0 / calc(var(--u) * 2) calc(var(--u) * 2);
}
@media (max-width: 640px) { .vault-px { --u: 3px; } }

/* all of the page is set in the pixel face */
.vault-px, .vault-px * { font-family: var(--font-pixel, "Pixelify Sans"), Inter, system-ui, sans-serif; }
.vault-px .ui-body { font-size: 16px; line-height: 1.3; }
.vault-px [data-vault-sources] { color: rgba(255,255,255,.62); }
.vault-px .ui-title { font-size: 24px; letter-spacing: .06em; text-transform: uppercase; }
.vault-px .ui-mono { font-variant-numeric: tabular-nums; letter-spacing: .02em; }
.vault-px .text-xs { font-size: 14px; }
.vault-hero .ui-body, .vault-hero .text-xs { text-shadow: 2px 2px 0 #000; }
.vault-px .text-sm { font-size: 15px; }

/* ---- the page's own header: the shared pieces, in pixels ---- */
.vault-px [data-ui="page-header"] { border-bottom: var(--u) solid #1a1826; }
.vault-px [data-ui="status-chip"], .vault-px [data-ui="icon-button"] { --u: 3px; border: var(--u) solid transparent; border-image: var(--bi-line) 1 / var(--u) / 0 stretch; background-clip: padding-box; border-radius: 0; background-color: #14121c; }
.vault-px [data-ui="icon-button"]:hover { border-image-source: var(--bi-gold); }
.vault-px [data-ui="segmented"] { --u: 3px; border: var(--u) solid transparent; border-image: var(--bi-line) 1 / var(--u) / 0 stretch; background-clip: padding-box; border-radius: 0; background-color: #0e0d15; padding: 2px; gap: 2px; }
.vault-px [data-ui="segmented"] button { border-radius: 0; font-size: 14px; letter-spacing: .08em; }
.vault-px [data-ui="segmented"] button[aria-pressed="true"] { background: var(--color-ui-accent); color: #fff; box-shadow: inset 0 -3px 0 rgba(0,0,0,.3), inset 0 3px 0 rgba(255,255,255,.25); }

/* ---- entrance ---- */
@keyframes vault-rise { from { opacity: 0; transform: translateY(24px); } to { opacity: 1; transform: none; } }
.vault-rise { animation: vault-rise .6s steps(6, end) backwards; animation-delay: var(--d, 0s); }
[data-vault-in-view] { transition: opacity .5s steps(5, end), transform .5s steps(5, end); transition-delay: var(--d, 0s); }
[data-vault-in-view]:not([data-in]) { opacity: 0; transform: translateY(28px); }

/* ---- section heads ---- */
.vault-section-title { display: flex; align-items: center; gap: 14px; font-size: 26px; line-height: 1.1; font-weight: 700; letter-spacing: .06em; text-transform: uppercase; color: #fff; text-shadow: 3px 3px 0 #000; }
.vault-title-bar { display: block; width: 8px; height: 26px; flex: none; background: linear-gradient(180deg, #fde68a 0 28%, transparent 28% 36%, #f59e0b 36% 64%, transparent 64% 72%, #e5383b 72% 100%); transform-origin: top; animation: vault-bar-grow .6s steps(4, end) backwards; }
@keyframes vault-bar-grow { from { transform: scaleY(0); } to { transform: scaleY(1); } }

/* ---- the hero ---- */
.vault-hero { --u: 6px; position: relative; isolation: isolate; overflow: hidden; border: var(--u) solid transparent; border-image: var(--bi-line) 1 / var(--u) / 0 stretch; background-clip: padding-box; background: #09090e; box-shadow: 0 var(--u) 0 #000; }
.vault-bg { position: absolute; inset: 0; z-index: -1; overflow: hidden; pointer-events: none; }
vault-sky { position: absolute; inset: 0; display: block; }
.vault-sky-canvas, .vault-wheel-canvas { image-rendering: crisp-edges; image-rendering: pixelated; }
.vault-sky-canvas { display: block; width: 100%; height: 100%; }
.vault-gridlines { position: absolute; inset: 0; background-image: linear-gradient(rgba(255,255,255,.04) 2px, transparent 2px), linear-gradient(90deg, rgba(255,255,255,.04) 2px, transparent 2px); background-size: 48px 48px; -webkit-mask-image: linear-gradient(90deg, #000, transparent 85%); mask-image: linear-gradient(90deg, #000, transparent 85%); }
.vault-stage { position: relative; }

/* panels */
.vault-panel { --u: 4px; border: var(--u) solid transparent; border-image: var(--bi, var(--bi-line)) 1 / var(--u) / 0 stretch; background-clip: padding-box; background: var(--dither), rgba(14,12,24,.82); border-radius: 0; box-shadow: 0 var(--u) 0 rgba(0,0,0,.55); }

.vault-eyebrow { font-size: 14px; font-weight: 700; letter-spacing: .3em; text-transform: uppercase; color: #fbbf24; text-shadow: 2px 2px 0 #000; }
.vault-headline { font-size: 48px; line-height: 1; font-weight: 700; letter-spacing: .02em; text-transform: uppercase; background: linear-gradient(90deg, #fff 0 25%, #fde68a 25% 50%, #f59e0b 50% 75%, #fde68a 75% 100%); background-size: 200% auto; -webkit-background-clip: text; background-clip: text; -webkit-text-fill-color: transparent; color: transparent; animation: vault-headline 2.4s steps(8) infinite; filter: drop-shadow(4px 4px 0 #000); }
@keyframes vault-headline { to { background-position: -200% center; } }
@media (max-width: 640px) { .vault-headline { font-size: 32px; } }

/* the daily spin */
.vault-daily { --u: 4px; --bi: var(--bi-line); position: relative; display: flex; width: 100%; align-items: center; gap: 16px; overflow: hidden; padding: 14px 16px; text-align: left; cursor: pointer; transition: transform .12s steps(2, end); }
.vault-daily:disabled { cursor: default; }
.vault-daily[data-ready] { --bi: var(--bi-gold); background: var(--dither), linear-gradient(110deg, rgba(251,191,36,.28) 0 55%, rgba(14,12,24,.82) 55%); animation: vault-ready 1.2s steps(2, end) infinite; }
.vault-daily[data-ready]:hover { transform: translateY(-3px); }
@keyframes vault-ready { 0%, 100% { box-shadow: 0 var(--u) 0 rgba(0,0,0,.55), 0 0 0 0 transparent; } 50% { box-shadow: 0 var(--u) 0 rgba(0,0,0,.55), 0 0 0 4px rgba(251,191,36,.35); } }
.vault-daily-icon { --u: 3px; position: relative; display: grid; width: 60px; height: 60px; flex: none; place-items: center; border: var(--u) solid transparent; border-image: var(--bi-ink) 1 / var(--u) / 0 stretch; background-clip: padding-box; background: var(--dither), #1b1827; }
.vault-daily[data-ready] .vault-daily-icon { background: var(--dither), #3a2a08; }
.vault-daily-gift { color: #fbbf24; }
.vault-daily[data-ready] .vault-daily-gift { animation: vault-hop .8s steps(2, end) infinite; }
.vault-daily:not([data-ready]) .vault-daily-gift { filter: grayscale(1) brightness(.7); }
@keyframes vault-hop { 0%, 49.9% { transform: translateY(0); } 50%, 100% { transform: translateY(-4px); } }
.vault-claim { position: relative; overflow: hidden; margin-left: auto; flex: none; padding: 8px 14px; font-size: 14px; font-weight: 700; letter-spacing: .1em; text-transform: uppercase; color: #3a2200; background: #fbbf24; box-shadow: inset 0 3px 0 #fde68a, inset 0 -3px 0 #b45309, 0 4px 0 #5a3a05; }

/* a segmented bar of blocks: the day passing, a guarantee filling */
.vault-blocks { position: relative; height: 10px; background: repeating-linear-gradient(90deg, rgba(255,255,255,.1) 0 6px, transparent 6px 8px); }
.vault-blocks > i { position: absolute; inset: 0 auto 0 0; width: var(--p, 0%); background: repeating-linear-gradient(90deg, var(--rc, #fbbf24) 0 6px, transparent 6px 8px); }
.vault-blocks[data-full] > i { animation: vault-blink .5s steps(2, end) infinite; }
@keyframes vault-blink { 0%, 49.9% { filter: none; } 50%, 100% { filter: brightness(1.6); } }

/* a band of light that sweeps across and is gone before the next begins */
.vault-shine { position: relative; overflow: hidden; }
.vault-shine::after { content: ""; position: absolute; top: 0; bottom: 0; left: 0; width: 16%; background: rgba(255,255,255,.32); transform: translateX(-260%) skewX(-18deg); animation: vault-sweep 2.4s steps(18) infinite; pointer-events: none; }
.vault-shine:disabled::after { display: none; }
@keyframes vault-sweep { from { transform: translateX(-260%) skewX(-18deg); } to { transform: translateX(760%) skewX(-18deg); } }

/* pixel buttons: a flat face, a light top and a dark bottom, a hard shadow that it sinks into when pressed */
.vault-btn { --u: 4px; position: relative; display: flex; align-items: center; justify-content: space-between; gap: 16px; width: 100%; border: var(--u) solid transparent; border-image: var(--bi, var(--bi-red)) 1 / var(--u) / 0 stretch; background-clip: padding-box; border-radius: 0; background: var(--dither), var(--bg); color: #fff; cursor: pointer; box-shadow: inset 0 var(--u) 0 var(--hi), inset 0 calc(var(--u) * -1) 0 var(--lo), 0 var(--u) 0 var(--sh); transition: transform .08s steps(2, end), box-shadow .08s steps(2, end), filter .08s steps(2, end); }
.vault-btn:hover:not(:disabled) { transform: translateY(-3px); filter: brightness(1.12); box-shadow: inset 0 var(--u) 0 var(--hi), inset 0 calc(var(--u) * -1) 0 var(--lo), 0 calc(var(--u) + 3px) 0 var(--sh); }
.vault-btn:active:not(:disabled) { transform: translateY(var(--u)); filter: none; box-shadow: inset 0 var(--u) 0 var(--lo), 0 0 0 var(--sh); }
.vault-btn:disabled { --bg: #1c1b25; --hi: transparent; --lo: rgba(0,0,0,.35); --sh: #0a0a10; --bi: var(--bi-soft); color: #6b6b76; cursor: not-allowed; }
.vault-spin { --bg: #e5383b; --hi: #ff7a7c; --lo: #a3181b; --sh: #5c0f12; --bi: var(--bi-red); min-height: 68px; padding: 0 20px; }

/* the odds: a bar of what the wheel can give, and a legend that lights up the wheel */
.vault-bar { display: flex; height: 14px; gap: 2px; overflow: hidden; background: #0b0a12; border: 2px solid #26233a; padding: 2px; }
.vault-bar > i { display: block; flex: var(--w) 1 0; min-width: 5px; background: var(--c); transition: transform .12s steps(2, end), filter .12s steps(2, end); transform-origin: center; }
.vault-bar > i:hover, .vault-bar > i[data-hot] { transform: scaleY(1.7); filter: brightness(1.35); }
.vault-chip { --u: 2px; display: inline-flex; align-items: center; gap: 6px; border: var(--u) solid transparent; border-image: var(--bi, var(--bi-soft)) 1 / var(--u) / 0 stretch; background-clip: padding-box; background: #14121c; padding: 5px 9px; font-size: 14px; font-weight: 600; color: #d4d4d8; transition: transform .1s steps(2, end), background .1s steps(2, end); cursor: default; }
.vault-chip:hover, .vault-chip[data-hot] { background: color-mix(in srgb, var(--c) 28%, #14121c); transform: translateY(-2px); }
.vault-chip .vault-dot { width: 8px; height: 8px; background: var(--c); }
button.vault-chip { cursor: pointer; }
button.vault-chip[aria-pressed="true"] { background: color-mix(in srgb, var(--c) 34%, #14121c); color: #fff; }
.vault-drawer { display: grid; grid-template-rows: 0fr; opacity: 0; transition: grid-template-rows .3s steps(6, end), opacity .2s steps(3, end); }
.vault-drawer[data-open] { grid-template-rows: 1fr; opacity: 1; }
.vault-drawer > div { min-height: 0; overflow: hidden; }
.vault-oddrow { position: relative; }
.vault-oddrow:hover { background: rgba(255,255,255,.06); }
.vault-oddrow td:first-child { position: relative; }
.vault-oddrow td:first-child::before { content: ""; position: absolute; left: 0; top: 18%; bottom: 18%; width: 4px; background: var(--c); transform: scaleY(0); transition: transform .1s steps(2, end); }
.vault-oddrow:hover td:first-child::before { transform: scaleY(1); }
.vault-link { display: inline-flex; align-items: center; gap: 6px; font-size: 14px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; color: var(--color-ui-muted); cursor: pointer; }
.vault-link:hover { color: #fff; }
.vault-link[aria-expanded="true"] svg { transform: rotate(180deg); }

/* ---- packs ---- */
.vault-pack-card { --u: 4px; position: relative; display: flex; height: 100%; flex-direction: column; overflow: hidden; border: var(--u) solid transparent; border-image: var(--bi) 1 / var(--u) / 0 stretch; background-clip: padding-box; background: var(--dither), linear-gradient(180deg, color-mix(in srgb, var(--c) 24%, #14121c) 0 42%, color-mix(in srgb, var(--c) 10%, #14121c) 42% 44%, #14121c 44%); transition: transform .14s steps(3, end), box-shadow .14s steps(3, end); }
.vault-pack-card:hover { transform: translateY(-5px); box-shadow: 0 8px 0 color-mix(in srgb, var(--c) 40%, #000); }
.vault-pack-shelf { position: relative; display: flex; justify-content: center; padding: 30px 0 22px; }
.vault-pack-glow { position: absolute; left: 50%; bottom: 8px; width: 60%; height: 16px; transform: translateX(-50%); background: color-mix(in srgb, var(--c) 70%, #000); opacity: .65; -webkit-mask: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 14 4' preserveAspectRatio='none' shape-rendering='crispEdges'%3E%3Cpath d='M4 0h6v1H4zM2 1h10v1H2zM0 2h14v1H0zM2 3h10v1H2z'/%3E%3C/svg%3E") center / 100% 100% no-repeat; mask: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 14 4' preserveAspectRatio='none' shape-rendering='crispEdges'%3E%3Cpath d='M4 0h6v1H4zM2 1h10v1H2zM0 2h14v1H0zM2 3h10v1H2z'/%3E%3C/svg%3E") center / 100% 100% no-repeat; pointer-events: none; }
.vault-pack-card:hover .vault-pack-glow { opacity: 1; }
.vault-pack-float { width: 196px; aspect-ratio: 250 / 360; animation: vault-bob 1.6s steps(4, end) infinite alternate; animation-delay: var(--d, 0s); transition: opacity .2s steps(3, end), filter .2s steps(3, end); }
.vault-pack-float[data-away] { opacity: .14; filter: grayscale(.6); }
@keyframes vault-bob { from { transform: translateY(0); } to { transform: translateY(-8px); } }
.vault-pack-float .vault-tilt { height: 100%; filter: drop-shadow(0 6px 0 rgba(0,0,0,.55)); }
.vault-pack-spark { position: absolute; width: 10px; height: 10px; background: color-mix(in srgb, var(--c) 40%, #fff); clip-path: polygon(40% 0, 60% 0, 60% 40%, 100% 40%, 100% 60%, 60% 60%, 60% 100%, 40% 100%, 40% 60%, 0 60%, 0 40%, 40% 40%); opacity: 0; pointer-events: none; }
.vault-pack-card:hover .vault-pack-spark { animation: vault-spark 1.2s steps(6, end) infinite; animation-delay: var(--d, 0s); }
@keyframes vault-spark { 0% { opacity: 0; transform: translateY(14px); } 30% { opacity: 1; } 100% { opacity: 0; transform: translateY(-36px); } }
.vault-pack-odds { position: absolute; inset: 8px 8px 4px; z-index: 5; overflow-y: auto; padding: 14px 16px; background: var(--dither), color-mix(in srgb, var(--c) 14%, #0e0d16); border: 3px solid color-mix(in srgb, var(--c) 55%, #000); opacity: 0; transform: translateY(12px); pointer-events: none; transition: opacity .2s steps(4, end), transform .2s steps(4, end); scrollbar-width: thin; scrollbar-color: var(--color-ui-border-strong) transparent; }
.vault-pack-odds[data-open] { opacity: 1; transform: none; pointer-events: auto; }
.vault-open { --bg: color-mix(in srgb, var(--c) 30%, #14121c); --hi: color-mix(in srgb, var(--c) 55%, #14121c); --lo: color-mix(in srgb, var(--c) 18%, #000); --sh: color-mix(in srgb, var(--c) 25%, #000); min-height: 52px; padding: 0 14px; font-size: 16px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; }
.vault-open:hover:not(:disabled) { --bg: var(--c); --hi: color-mix(in srgb, var(--c) 60%, #fff); --lo: color-mix(in srgb, var(--c) 60%, #000); color: #0b0b0c; }
.vault-meter { position: relative; height: 10px; background: repeating-linear-gradient(90deg, rgba(255,255,255,.1) 0 6px, transparent 6px 8px); }
.vault-meter > i { position: absolute; inset: 0 auto 0 0; width: var(--p, 0%); background: repeating-linear-gradient(90deg, var(--rc) 0 6px, transparent 6px 8px); }
.vault-meter[data-full] > i { animation: vault-blink .5s steps(2, end) infinite; }

/* the pack's art (also the sealed pack of the reveal): foil with crimped ends, an emblem in a ring of turning pixels */
.vault-pack-wrap { container-type: inline-size; width: 100%; height: 100%; }
.vault-pack-art { --u: 4px; --pu: 4px; --pu: round(down, 2.2cqw, 1px); position: relative; display: flex; width: 100%; height: 100%; flex-direction: column; overflow: hidden; color: var(--c); border: var(--pu) solid transparent; border-image: var(--bi-ink) 1 / var(--pu) / 0 stretch; background-clip: padding-box; background: var(--dither), linear-gradient(135deg, color-mix(in srgb, var(--c) 55%, #fff) 0 12%, color-mix(in srgb, var(--c) 82%, #fff) 12% 20%, var(--c) 20% 60%, color-mix(in srgb, var(--c) 70%, #000) 60% 86%, color-mix(in srgb, var(--c) 52%, #000) 86% 100%); box-shadow: inset 0 0 0 var(--pu) rgba(255,255,255,.14); }
.vault-pack-crimp { height: 8cqw; flex: none; background: conic-gradient(rgba(255,255,255,.38) 25%, rgba(0,0,0,.22) 0 50%, rgba(255,255,255,.38) 0 75%, rgba(0,0,0,.22) 0) 0 0 / calc(var(--pu) * 2) calc(var(--pu) * 2); }
.vault-pack-crimp-bottom { transform: scaleY(-1); }
.vault-pack-face { position: relative; display: flex; flex: 1; flex-direction: column; align-items: center; justify-content: center; gap: 4cqw; padding: 0 8cqw; text-align: center; color: #fff; }
.vault-pack-emblem { position: relative; display: grid; width: 56cqw; aspect-ratio: 1; place-items: center; color: color-mix(in srgb, var(--c) 35%, #fff); }
.vault-pack-emblem svg { position: relative; z-index: 1; width: 45px; height: 45px; width: round(down, 22cqw, 15px); height: round(down, 22cqw, 15px); filter: drop-shadow(var(--pu) var(--pu) 0 rgba(0,0,0,.45)); }
.vault-pack-orbit { position: absolute; inset: 0; animation: vault-orbit 3.6s steps(12) infinite; }
.vault-pack-orbit i { position: absolute; left: 50%; top: 50%; width: 3px; height: 3px; width: round(down, 3.4cqw, 2px); height: round(down, 3.4cqw, 2px); margin: -2px; margin: calc(round(down, 3.4cqw, 2px) / -2); background: rgba(255,255,255,.95); transform: rotate(calc(var(--n) * 30deg)) translateY(-26cqw); }
.vault-pack-orbit i:nth-child(odd) { background: rgba(255,255,255,.5); }
@keyframes vault-orbit { to { transform: rotate(360deg); } }
.vault-pack-name { font-size: 16px; font-size: round(down, 8.4cqw, 8px); font-weight: 700; line-height: 1.05; letter-spacing: .08em; text-transform: uppercase; text-shadow: calc(var(--pu) * .75) calc(var(--pu) * .75) 0 rgba(0,0,0,.5); }
.vault-pack-pips { display: flex; gap: 2cqw; }
.vault-pack-pips i { display: block; width: 10px; height: 10px; width: round(down, 5cqw, 5px); height: round(down, 5cqw, 5px); background: #fff; clip-path: polygon(40% 0, 60% 0, 60% 40%, 100% 40%, 100% 60%, 60% 60%, 60% 100%, 40% 100%, 40% 60%, 0 60%, 0 40%, 40% 40%); }
.vault-pack-brand { font-size: 12px; font-size: round(down, 4cqw, 2px); font-weight: 700; letter-spacing: .3em; text-transform: uppercase; color: rgba(255,255,255,.7); }
.vault-pack-sheen { position: absolute; inset: 0; overflow: hidden; pointer-events: none; }
.vault-pack-sheen::after { content: ""; position: absolute; top: 0; bottom: 0; left: 0; width: 14%; background: rgba(255,255,255,.3); transform: translateX(-300%) skewX(-18deg); animation: vault-sweep-pack 2.6s steps(20) infinite; }
@keyframes vault-sweep-pack { from { transform: translateX(-300%) skewX(-18deg); } to { transform: translateX(760%) skewX(-18deg); } }
/* foil: stripes of rainbow that follow the pointer */
.vault-holo { position: absolute; inset: 0; pointer-events: none; opacity: 0; mix-blend-mode: color-dodge; transition: opacity .15s steps(3, end); background: repeating-linear-gradient(115deg, rgba(255,90,200,.5) 0 10px, rgba(90,210,255,.5) 10px 20px, rgba(255,240,100,.5) 20px 30px, transparent 30px 60px); background-size: 200% 200%; background-position: var(--gx, 50%) var(--gy, 50%); }
.vault-tilt[data-tilting] .vault-holo { opacity: .6; }

/* ---- collection ---- */
.vault-item { --u: 4px; position: relative; display: flex; height: 100%; flex-direction: column; overflow: hidden; border: var(--u) solid transparent; border-image: var(--bi) 1 / var(--u) / 0 stretch; background-clip: padding-box; background: var(--dither), linear-gradient(180deg, color-mix(in srgb, var(--c) 20%, #16151d) 0 46%, #111016 46%); transition: box-shadow .12s steps(2, end); }
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
.vault-progress { position: relative; height: 12px; width: 220px; max-width: 100%; background: repeating-linear-gradient(90deg, rgba(255,255,255,.1) 0 8px, transparent 8px 10px); }
.vault-progress > i { position: absolute; inset: 0 auto 0 0; width: var(--p, 0%); background: repeating-linear-gradient(90deg, #fbbf24 0 8px, transparent 8px 10px); }

/* ---- the balance ---- */
.vault-delta { position: absolute; left: 50%; bottom: 100%; font-size: 18px; font-weight: 700; white-space: nowrap; pointer-events: none; text-shadow: 2px 2px 0 #000; animation: vault-delta 1.4s steps(8, end) both; }
.vault-delta-up { color: #4ade80; }
.vault-delta-down { color: #f87171; }
@keyframes vault-delta { 0% { opacity: 0; transform: translate(-50%, 10px); } 15% { opacity: 1; transform: translate(-50%, 0); } 70% { opacity: 1; transform: translate(-50%, -6px); } 100% { opacity: 0; transform: translate(-50%, -16px); } }

/* ---- reduced motion: nothing moves on its own, everything is shown ---- */
@media (prefers-reduced-motion: reduce) {
  .vault-rise, .vault-headline, .vault-daily[data-ready], .vault-daily-gift, .vault-shine::after, .vault-pack-float, .vault-pack-orbit, .vault-pack-sheen::after, .vault-edge, .vault-title-bar, .vault-meter > i, .vault-blocks > i { animation: none !important; }
  .vault-headline { -webkit-text-fill-color: #fde68a; }
  [data-vault-in-view]:not([data-in]) { opacity: 1; transform: none; }
  [data-vault-in-view], .vault-pack-card, .vault-item .vault-item-art, .vault-drawer, .vault-pack-odds, .vault-pack-float, .vault-btn, .vault-chip { transition: none; }
}
`;
