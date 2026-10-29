import { VAULT_TILT_CSS } from "./VaultTilt";

/**
 * The Vault page's stylesheet, put on the page in a <style> (the way the reveal
 * puts its own): keyframes and the few things Tailwind's utilities cannot say.
 * Colours come from the design system's tokens or, for the rarity of a thing,
 * from `--c` set on it. Every loop starts and ends where nothing shows (off the
 * card, at zero opacity, a full turn) so none of them pauses or jumps, and all
 * of them are off for reduced motion.
 */
export const VAULT_CSS = `
${VAULT_TILT_CSS}

/* ---- entrance ---- */
@keyframes vault-rise { from { opacity: 0; transform: translateY(22px); } to { opacity: 1; transform: none; } }
.vault-rise { animation: vault-rise .75s cubic-bezier(.2,.8,.2,1) backwards; animation-delay: var(--d, 0s); }
[data-vault-in-view] { transition: opacity .8s cubic-bezier(.2,.8,.2,1), transform .8s cubic-bezier(.2,.8,.2,1); transition-delay: var(--d, 0s); }
[data-vault-in-view]:not([data-in]) { opacity: 0; transform: translateY(28px); }

/* ---- section heads ---- */
.vault-section-title { display: flex; align-items: center; gap: 12px; font-size: 22px; line-height: 1.15; font-weight: 800; letter-spacing: -.01em; color: var(--color-ui-text); }
.vault-title-bar { display: block; width: 4px; height: 22px; border-radius: 2px; background: linear-gradient(180deg, #fde68a, #f59e0b 60%, #e5383b); box-shadow: 0 0 14px rgba(245,158,11,.55); transform-origin: top; animation: vault-bar-grow .9s cubic-bezier(.2,.8,.2,1) backwards; }
@keyframes vault-bar-grow { from { transform: scaleY(0); } to { transform: scaleY(1); } }

/* ---- the hero ---- */
.vault-hero { position: relative; isolation: isolate; overflow: hidden; border-radius: 22px; border: 1px solid rgba(255,255,255,.09); background: radial-gradient(120% 90% at 50% -10%, #1d1836 0%, #100e1c 48%, #09090e 100%); box-shadow: 0 30px 80px -34px rgba(0,0,0,.9), inset 0 1px 0 rgba(255,255,255,.06); }
.vault-bg { position: absolute; inset: 0; z-index: -1; overflow: hidden; pointer-events: none; }
.vault-blob { position: absolute; border-radius: 9999px; filter: blur(80px); will-change: transform; }
.vault-blob-a { width: 560px; height: 560px; left: -170px; top: -210px; background: #f59e0b; opacity: .26; animation: vault-drift-a 19s ease-in-out infinite alternate; }
.vault-blob-b { width: 520px; height: 520px; right: -150px; top: 8%; background: #7c3aed; opacity: .34; animation: vault-drift-b 23s ease-in-out infinite alternate; }
.vault-blob-c { width: 440px; height: 440px; left: 38%; bottom: -270px; background: #e5383b; opacity: .22; animation: vault-drift-a 27s ease-in-out infinite alternate-reverse; }
@keyframes vault-drift-a { to { transform: translate3d(90px, 60px, 0) scale(1.15); } }
@keyframes vault-drift-b { to { transform: translate3d(-80px, 70px, 0) scale(.9); } }
.vault-gridlines { position: absolute; inset: 0; background-image: linear-gradient(rgba(255,255,255,.035) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,.035) 1px, transparent 1px); background-size: 46px 46px; -webkit-mask-image: radial-gradient(ellipse 75% 75% at 32% 50%, #000, transparent); mask-image: radial-gradient(ellipse 75% 75% at 32% 50%, #000, transparent); }
.vault-spot { position: absolute; inset: 0; background: radial-gradient(520px circle at var(--mx, 32%) var(--my, 42%), rgba(255,214,102,.11), transparent 62%); }
.vault-sparkle { position: absolute; left: var(--x); top: var(--y); width: var(--s, 10px); height: var(--s, 10px); background: #fff6d0; clip-path: polygon(50% 0, 62% 38%, 100% 50%, 62% 62%, 50% 100%, 38% 62%, 0 50%, 38% 38%); opacity: 0; animation: vault-twinkle var(--t, 5s) ease-in-out infinite; animation-delay: var(--d, 0s); }
@keyframes vault-twinkle { 0%, 100% { opacity: 0; transform: scale(.3) rotate(0deg); } 50% { opacity: .9; transform: scale(1) rotate(45deg); } }

/* the stage behind the wheel */
.vault-stage { position: relative; }
.vault-halo { position: absolute; left: 50%; top: 50%; width: 112%; aspect-ratio: 1; transform: translate(-50%, -50%); border-radius: 50%; background: radial-gradient(circle, rgba(251,191,36,.24) 0%, rgba(124,58,237,.14) 45%, transparent 70%); animation: vault-breathe 5s ease-in-out infinite; pointer-events: none; }
@keyframes vault-breathe { 0%, 100% { opacity: .7; } 50% { opacity: 1; } }
.vault-rays { position: absolute; left: 50%; top: 50%; width: 132%; aspect-ratio: 1; border-radius: 50%; background: repeating-conic-gradient(from 0deg, rgba(255,214,102,.17) 0deg 5deg, transparent 5deg 30deg); -webkit-mask-image: radial-gradient(circle, transparent 30%, #000 42%, transparent 70%); mask-image: radial-gradient(circle, transparent 30%, #000 42%, transparent 70%); animation: vault-rays-turn 70s linear infinite; opacity: .55; transition: opacity .6s; pointer-events: none; }
@keyframes vault-rays-turn { from { transform: translate(-50%, -50%) rotate(0deg); } to { transform: translate(-50%, -50%) rotate(360deg); } }
.vault-hero[data-spinning] .vault-rays { opacity: 1; }
.vault-hero[data-spinning] .vault-halo { animation-duration: 1.6s; }

/* glass */
.vault-glass { background: linear-gradient(180deg, rgba(255,255,255,.075), rgba(255,255,255,.03)); border: 1px solid rgba(255,255,255,.1); -webkit-backdrop-filter: blur(10px); backdrop-filter: blur(10px); border-radius: 16px; }

.vault-eyebrow { font-size: 11px; font-weight: 800; letter-spacing: .32em; text-transform: uppercase; color: #fbbf24; }
.vault-headline { font-size: clamp(30px, 4.4vw, 46px); line-height: 1.02; font-weight: 900; letter-spacing: -.03em; background: linear-gradient(90deg, #fff 0%, #fde68a 25%, #f59e0b 50%, #fde68a 75%, #fff 100%); background-size: 200% auto; -webkit-background-clip: text; background-clip: text; -webkit-text-fill-color: transparent; color: transparent; animation: vault-headline 7s linear infinite; }
@keyframes vault-headline { to { background-position: -200% center; } }

/* the daily spin */
.vault-daily { position: relative; display: flex; width: 100%; align-items: center; gap: 16px; overflow: hidden; padding: 14px 18px; text-align: left; cursor: pointer; transition: transform .25s cubic-bezier(.2,.8,.2,1), border-color .25s, box-shadow .25s; }
.vault-daily:disabled { cursor: default; }
.vault-daily[data-ready] { border-color: rgba(251,191,36,.65); background: linear-gradient(110deg, rgba(251,191,36,.24), rgba(245,158,11,.08) 62%, rgba(255,255,255,.03)); animation: vault-ready 2.6s ease-in-out infinite; }
.vault-daily[data-ready]:hover { transform: translateY(-2px); }
@keyframes vault-ready { 0%, 100% { box-shadow: 0 0 0 1px rgba(251,191,36,.2), 0 8px 28px -10px rgba(251,191,36,.45); } 50% { box-shadow: 0 0 0 1px rgba(251,191,36,.45), 0 12px 40px -8px rgba(251,191,36,.8); } }
.vault-ring { position: relative; display: grid; width: 60px; height: 60px; flex: none; place-items: center; }
.vault-ring svg.vault-ring-svg { position: absolute; inset: 0; width: 100%; height: 100%; transform: rotate(-90deg); }
.vault-ring .vault-ring-track { stroke: rgba(255,255,255,.1); }
.vault-ring .vault-ring-bar { stroke: #fbbf24; stroke-linecap: round; transition: stroke-dashoffset 1s linear; filter: drop-shadow(0 0 5px rgba(251,191,36,.6)); }
.vault-daily:not([data-ready]) .vault-ring .vault-ring-bar { stroke: #8b8b95; filter: none; }
.vault-ring .vault-ring-gift { color: #fbbf24; transform-origin: 50% 80%; }
.vault-daily[data-ready] .vault-ring .vault-ring-gift { animation: vault-sway 1.3s ease-in-out infinite alternate; }
.vault-daily:not([data-ready]) .vault-ring .vault-ring-gift { color: #8b8b95; }
@keyframes vault-sway { from { transform: rotate(-9deg) scale(1); } to { transform: rotate(9deg) scale(1.12); } }
.vault-claim { position: relative; overflow: hidden; margin-left: auto; flex: none; border-radius: 999px; padding: 9px 16px; font-size: 12px; font-weight: 900; letter-spacing: .12em; text-transform: uppercase; color: #3a2200; background: linear-gradient(180deg, #fde68a, #f59e0b); box-shadow: 0 6px 18px -6px rgba(245,158,11,.9); }

/* a band of light that sweeps across and is gone before the next begins */
.vault-shine { position: relative; overflow: hidden; }
.vault-shine::after { content: ""; position: absolute; top: -10%; bottom: -10%; left: 0; width: 26%; background: linear-gradient(100deg, transparent, rgba(255,255,255,.38) 50%, transparent); transform: translateX(-260%) skewX(-18deg); animation: vault-sweep 3.4s linear infinite; pointer-events: none; }
.vault-shine:disabled::after { display: none; }
@keyframes vault-sweep { from { transform: translateX(-260%) skewX(-18deg); } to { transform: translateX(560%) skewX(-18deg); } }

/* the spin button */
.vault-spin { position: relative; display: flex; width: 100%; height: 64px; align-items: center; justify-content: space-between; gap: 16px; overflow: hidden; border-radius: 14px; border: 1px solid rgba(255,255,255,.22); padding: 0 22px; color: #fff; cursor: pointer; background: linear-gradient(180deg, #f0484b 0%, #c0272b 100%); box-shadow: 0 12px 34px -12px rgba(229,56,59,.85), inset 0 1px 0 rgba(255,255,255,.35); transition: transform .2s cubic-bezier(.2,.8,.2,1), box-shadow .2s, filter .2s; }
.vault-spin:hover:not(:disabled) { transform: translateY(-2px) scale(1.012); filter: brightness(1.08); box-shadow: 0 18px 44px -12px rgba(229,56,59,1), inset 0 1px 0 rgba(255,255,255,.4); }
.vault-spin:active:not(:disabled) { transform: translateY(0) scale(.99); }
.vault-spin:disabled { cursor: not-allowed; border-color: var(--color-ui-border-strong); background: var(--color-ui-disabled); color: var(--color-ui-muted); box-shadow: none; }

/* the odds: a bar of what the wheel can give, and a legend that lights up the wheel */
.vault-bar { display: flex; height: 12px; gap: 2px; overflow: hidden; border-radius: 999px; background: rgba(255,255,255,.05); }
.vault-bar > i { display: block; flex: var(--w) 1 0; min-width: 5px; background: var(--c); transition: transform .2s, filter .2s; transform-origin: center; }
.vault-bar > i:hover, .vault-bar > i[data-hot] { transform: scaleY(1.55); filter: brightness(1.3); }
.vault-chip { display: inline-flex; align-items: center; gap: 6px; border-radius: 999px; border: 1px solid rgba(255,255,255,.1); background: rgba(255,255,255,.04); padding: 5px 10px; font-size: 12px; font-weight: 600; color: #d4d4d8; transition: background .2s, border-color .2s, transform .2s; cursor: default; }
.vault-chip:hover, .vault-chip[data-hot] { border-color: var(--c); background: color-mix(in srgb, var(--c) 20%, transparent); transform: translateY(-1px); }
.vault-chip .vault-dot { width: 8px; height: 8px; border-radius: 3px; background: var(--c); box-shadow: 0 0 8px var(--c); }
button.vault-chip { cursor: pointer; }
button.vault-chip[aria-pressed="true"] { border-color: var(--c); background: color-mix(in srgb, var(--c) 24%, transparent); color: #fff; }
.vault-drawer { display: grid; grid-template-rows: 0fr; opacity: 0; transition: grid-template-rows .45s cubic-bezier(.2,.8,.2,1), opacity .3s; }
.vault-drawer[data-open] { grid-template-rows: 1fr; opacity: 1; }
.vault-drawer > div { min-height: 0; overflow: hidden; }
.vault-oddrow { position: relative; transition: background .2s; }
.vault-oddrow:hover { background: rgba(255,255,255,.05); }
.vault-oddrow td:first-child { position: relative; }
.vault-oddrow td:first-child::before { content: ""; position: absolute; left: 0; top: 18%; bottom: 18%; width: 3px; border-radius: 2px; background: var(--c); transform: scaleY(0); transition: transform .2s; }
.vault-oddrow:hover td:first-child::before { transform: scaleY(1); }
.vault-link { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; color: var(--color-ui-muted); transition: color .2s; cursor: pointer; }
.vault-link:hover { color: var(--color-ui-text); }
.vault-link svg { transition: transform .3s cubic-bezier(.2,.8,.2,1); }
.vault-link[aria-expanded="true"] svg { transform: rotate(180deg); }

/* ---- packs ---- */
.vault-pack-card { position: relative; display: flex; height: 100%; flex-direction: column; overflow: hidden; border-radius: 20px; border: 1px solid color-mix(in srgb, var(--c) 34%, rgba(255,255,255,.07)); background: radial-gradient(120% 70% at 50% 0%, color-mix(in srgb, var(--c) 22%, #15131d) 0%, #121118 64%); transition: transform .35s cubic-bezier(.2,.8,.2,1), box-shadow .35s, border-color .35s; }
.vault-pack-card:hover { transform: translateY(-6px); border-color: color-mix(in srgb, var(--c) 85%, #fff); box-shadow: 0 26px 60px -22px color-mix(in srgb, var(--c) 75%, transparent), 0 0 0 1px color-mix(in srgb, var(--c) 40%, transparent); }
.vault-pack-shelf { position: relative; display: flex; justify-content: center; padding: 30px 0 18px; }
.vault-pack-odds { position: absolute; inset: 10px 10px 4px; z-index: 5; overflow-y: auto; border-radius: 14px; padding: 14px 16px; background: radial-gradient(120% 90% at 50% 0%, color-mix(in srgb, var(--c) 16%, rgba(14,13,22,.94)), rgba(14,13,22,.96)); border: 1px solid color-mix(in srgb, var(--c) 30%, transparent); -webkit-backdrop-filter: blur(8px); backdrop-filter: blur(8px); opacity: 0; transform: translateY(12px) scale(.97); pointer-events: none; transition: opacity .35s cubic-bezier(.2,.8,.2,1), transform .35s cubic-bezier(.2,.8,.2,1); scrollbar-width: thin; scrollbar-color: var(--color-ui-border-strong) transparent; }
.vault-pack-odds[data-open] { opacity: 1; transform: none; pointer-events: auto; }
.vault-pack-glow { position: absolute; left: 50%; bottom: 8px; width: 62%; height: 34px; transform: translateX(-50%); background: radial-gradient(closest-side, color-mix(in srgb, var(--c) 75%, transparent), transparent); filter: blur(10px); opacity: .7; transition: opacity .3s, transform .35s cubic-bezier(.2,.8,.2,1); pointer-events: none; }
.vault-pack-card:hover .vault-pack-glow { opacity: 1; transform: translateX(-50%) scale(1.3); }
.vault-pack-float { width: 196px; aspect-ratio: 250 / 360; animation: vault-bob 4.8s ease-in-out infinite; animation-delay: var(--d, 0s); transition: opacity .35s, filter .35s; }
.vault-pack-float[data-away] { opacity: .14; filter: blur(3px) saturate(.5); }
@keyframes vault-bob { 0%, 100% { transform: translateY(0); } 50% { transform: translateY(-9px); } }
.vault-pack-float .vault-tilt { height: 100%; filter: drop-shadow(0 14px 22px rgba(0,0,0,.55)); }
.vault-pack-spark { position: absolute; width: 9px; height: 9px; background: color-mix(in srgb, var(--c) 40%, #fff); clip-path: polygon(50% 0, 62% 38%, 100% 50%, 62% 62%, 50% 100%, 38% 62%, 0 50%, 38% 38%); opacity: 0; pointer-events: none; }
.vault-pack-card:hover .vault-pack-spark { animation: vault-rise-spark 1.8s ease-in-out infinite; animation-delay: var(--d, 0s); }
@keyframes vault-rise-spark { 0% { opacity: 0; transform: translateY(14px) scale(.4) rotate(0deg); } 40% { opacity: .95; } 100% { opacity: 0; transform: translateY(-38px) scale(1) rotate(80deg); } }
.vault-open { position: relative; display: flex; width: 100%; min-height: 48px; align-items: center; justify-content: space-between; gap: 12px; overflow: hidden; border-radius: 12px; border: 1px solid color-mix(in srgb, var(--c) 65%, transparent); background: color-mix(in srgb, var(--c) 16%, transparent); padding: 0 16px; font-size: 13px; font-weight: 800; letter-spacing: .08em; text-transform: uppercase; color: #fff; cursor: pointer; transition: background .25s, color .25s, transform .2s, box-shadow .25s; }
.vault-open:hover:not(:disabled) { background: var(--c); color: #0b0b0c; box-shadow: 0 10px 28px -8px var(--c); transform: translateY(-1px); }
.vault-open:active:not(:disabled) { transform: translateY(0) scale(.99); }
.vault-open:disabled { cursor: not-allowed; border-color: var(--color-ui-border-strong); background: var(--color-ui-disabled); color: var(--color-ui-muted); }
.vault-meter { position: relative; height: 6px; overflow: hidden; border-radius: 999px; background: rgba(255,255,255,.08); }
.vault-meter > i { position: absolute; inset: 0 auto 0 0; width: var(--p, 0%); border-radius: 999px; background: linear-gradient(90deg, color-mix(in srgb, var(--rc) 60%, #000), var(--rc)); box-shadow: 0 0 10px var(--rc); transition: width 1s cubic-bezier(.2,.8,.2,1); }
.vault-meter[data-full] > i { animation: vault-ready-glow 1.6s ease-in-out infinite; }
@keyframes vault-ready-glow { 0%, 100% { filter: brightness(1); } 50% { filter: brightness(1.5); } }

/* the pack's art (also the sealed pack of the reveal) */
.vault-pack-art { position: relative; display: flex; width: 100%; height: 100%; flex-direction: column; overflow: hidden; border-radius: 16px; container-type: inline-size; color: var(--c); background: radial-gradient(90% 60% at 28% 8%, color-mix(in srgb, var(--c) 85%, #fff) 0%, transparent 62%), linear-gradient(165deg, color-mix(in srgb, var(--c) 92%, #000) 0%, color-mix(in srgb, var(--c) 42%, #120f24) 55%, #14102a 100%); box-shadow: inset 0 0 0 1px rgba(255,255,255,.3), inset 0 0 46px rgba(0,0,0,.4); }
.vault-pack-art::before { content: ""; position: absolute; inset: 0; background: repeating-linear-gradient(115deg, rgba(255,255,255,.07) 0 7px, transparent 7px 16px); mix-blend-mode: overlay; pointer-events: none; }
.vault-pack-crimp { height: 7%; flex: none; background: repeating-linear-gradient(90deg, rgba(255,255,255,.3) 0 2px, rgba(0,0,0,.2) 2px 5px), linear-gradient(180deg, rgba(255,255,255,.32), rgba(255,255,255,.06)); }
.vault-pack-crimp-bottom { transform: scaleY(-1); }
.vault-pack-face { position: relative; display: flex; flex: 1; flex-direction: column; align-items: center; justify-content: center; gap: 5cqw; padding: 0 8cqw; text-align: center; color: #fff; }
.vault-pack-emblem { width: 56cqw; color: rgba(255,255,255,.95); filter: drop-shadow(0 0 10px var(--c)); }
.vault-pack-orbit { transform-box: fill-box; transform-origin: center; animation: vault-orbit 26s linear infinite; }
@keyframes vault-orbit { to { transform: rotate(360deg); } }
.vault-pack-star { animation: vault-star 3.2s ease-in-out infinite; transform-box: fill-box; transform-origin: center; }
@keyframes vault-star { 0%, 100% { transform: scale(.92); } 50% { transform: scale(1.06); } }
.vault-pack-name { font-size: 8.4cqw; font-weight: 900; line-height: 1.1; letter-spacing: .14em; text-transform: uppercase; text-shadow: 0 2px 10px rgba(0,0,0,.45); }
.vault-pack-pips { display: flex; gap: 2.4cqw; }
.vault-pack-pips i { display: block; width: 4.6cqw; height: 4.6cqw; background: #fff; clip-path: polygon(50% 0, 62% 38%, 100% 50%, 62% 62%, 50% 100%, 38% 62%, 0 50%, 38% 38%); }
.vault-pack-brand { font-size: 3.6cqw; font-weight: 800; letter-spacing: .34em; text-transform: uppercase; color: rgba(255,255,255,.7); }
.vault-pack-sheen { position: absolute; inset: 0; overflow: hidden; pointer-events: none; }
.vault-pack-sheen::after { content: ""; position: absolute; top: -10%; bottom: -10%; left: 0; width: 24%; background: linear-gradient(100deg, transparent, rgba(255,255,255,.4) 50%, transparent); transform: translateX(-260%) skewX(-18deg); animation: vault-sweep-pack 3.4s linear infinite; }
@keyframes vault-sweep-pack { from { transform: translateX(-260%) skewX(-18deg); } to { transform: translateX(520%) skewX(-18deg); } }
/* foil: a rainbow that follows the pointer */
.vault-holo { position: absolute; inset: 0; border-radius: inherit; pointer-events: none; opacity: 0; mix-blend-mode: color-dodge; transition: opacity .3s; background: linear-gradient(115deg, transparent 18%, rgba(255,90,200,.55) 32%, rgba(90,210,255,.55) 46%, rgba(255,240,100,.55) 60%, transparent 74%); background-size: 260% 260%; background-position: var(--gx, 50%) var(--gy, 50%); }
.vault-tilt[data-tilting] .vault-holo { opacity: .65; }

/* ---- collection ---- */
.vault-item { position: relative; display: flex; height: 100%; flex-direction: column; overflow: hidden; border-radius: 16px; border: 1px solid color-mix(in srgb, var(--c) 32%, transparent); background: linear-gradient(180deg, color-mix(in srgb, var(--c) 15%, #16151d), #111016 72%); transition: border-color .3s, box-shadow .3s; }
.vault-item:hover { border-color: var(--c); box-shadow: 0 20px 44px -18px color-mix(in srgb, var(--c) 75%, transparent); }
.vault-item .vault-item-art { position: relative; aspect-ratio: 5 / 4; padding: 14px; transition: filter .35s, opacity .35s, transform .5s cubic-bezier(.2,.8,.2,1); }
.vault-item:hover .vault-item-art { transform: scale(1.04); }
.vault-item[data-owned="false"] .vault-item-art { filter: grayscale(.85) brightness(.55); opacity: .75; }
.vault-item[data-owned="false"]:hover .vault-item-art { filter: grayscale(.25) brightness(.9); opacity: 1; }
.vault-item .vault-item-state { position: absolute; top: 10px; right: 10px; z-index: 3; display: inline-flex; align-items: center; gap: 4px; border-radius: 999px; padding: 4px 9px; font-size: 10px; font-weight: 800; letter-spacing: .1em; text-transform: uppercase; }
.vault-item[data-owned="true"] .vault-item-state { background: rgba(74,222,128,.16); color: #4ade80; }
.vault-item[data-owned="false"] .vault-item-state { background: rgba(0,0,0,.45); color: var(--color-ui-muted); }
.vault-edge { position: absolute; inset: 0; z-index: 2; border-radius: inherit; padding: 1.5px; pointer-events: none; background: conic-gradient(from var(--a, 0deg), transparent 0 55%, var(--c) 78%, #fff 90%, transparent 100%); -webkit-mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0); -webkit-mask-composite: xor; mask: linear-gradient(#000 0 0) content-box exclude, linear-gradient(#000 0 0); animation: vault-edge 4.5s linear infinite; }
@property --a { syntax: "<angle>"; inherits: false; initial-value: 0deg; }
@keyframes vault-edge { to { --a: 360deg; } }
.vault-item[data-owned="false"] .vault-edge { opacity: .45; }
.vault-progress { position: relative; height: 8px; width: 220px; max-width: 100%; overflow: hidden; border-radius: 999px; background: rgba(255,255,255,.08); }
.vault-progress > i { position: absolute; inset: 0 auto 0 0; width: var(--p, 0%); border-radius: 999px; background: linear-gradient(90deg, #f59e0b, #fde68a); box-shadow: 0 0 12px rgba(251,191,36,.6); transition: width 1.1s cubic-bezier(.2,.8,.2,1); }

/* ---- the balance ---- */
.vault-delta { position: absolute; left: 50%; bottom: 100%; font-size: 14px; font-weight: 800; white-space: nowrap; pointer-events: none; animation: vault-delta 1.6s cubic-bezier(.2,.8,.2,1) both; }
.vault-delta-up { color: #4ade80; text-shadow: 0 0 12px rgba(74,222,128,.75); }
.vault-delta-down { color: #f87171; }
@keyframes vault-delta { 0% { opacity: 0; transform: translate(-50%, 10px) scale(.8); } 15% { opacity: 1; transform: translate(-50%, 0) scale(1.15); } 70% { opacity: 1; transform: translate(-50%, -6px) scale(1); } 100% { opacity: 0; transform: translate(-50%, -16px); } }

/* ---- reduced motion: nothing moves on its own, everything is shown ---- */
@media (prefers-reduced-motion: reduce) {
  .vault-rise, .vault-blob, .vault-sparkle, .vault-halo, .vault-rays, .vault-headline, .vault-daily[data-ready], .vault-daily .vault-ring-gift, .vault-shine::after, .vault-pack-float, .vault-pack-orbit, .vault-pack-star, .vault-pack-sheen::after, .vault-edge, .vault-title-bar, .vault-meter > i { animation: none !important; }
  .vault-headline { -webkit-text-fill-color: #fde68a; }
  [data-vault-in-view]:not([data-in]) { opacity: 1; transform: none; }
  [data-vault-in-view], .vault-pack-card, .vault-item .vault-item-art, .vault-drawer, .vault-pack-odds, .vault-pack-float { transition: none; }
}
`;
