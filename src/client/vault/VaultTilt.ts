import { motionAllowed } from "./VaultFx";

/**
 * The lean-towards-the-pointer effect of the shop's feature card
 * (components/CosmeticCard.ts), for the Vault's packs, cards and wheel.
 *
 * The pointer is read on an element that does not itself turn (`host`, the one
 * the handlers are on) and the lean is applied to the `.vault-tilt` inside it:
 * reading a rect that is turning with the pointer would make the card jitter at
 * its edges. `--gx`/`--gy` carry the pointer as a percentage, for the glare and
 * the foil that follow it.
 */
export const VAULT_TILT_CSS = `
  .vault-tilt { position: relative; --tilt-x: 0deg; --tilt-y: 0deg; --tilt-s: 1; transform: perspective(900px) rotateX(var(--tilt-x)) rotateY(var(--tilt-y)) scale(var(--tilt-s)); transition: transform .45s cubic-bezier(.2,.8,.2,1); }
  .vault-tilt[data-tilting] { --tilt-s: var(--tilt-hover-scale, 1.05); transition: transform .08s linear; }
  .vault-glare { position: absolute; inset: 0; pointer-events: none; opacity: 0; transition: opacity .3s; border-radius: inherit; background: radial-gradient(circle at var(--gx, 50%) var(--gy, 50%), rgba(255,255,255,.3), transparent 55%); }
  .vault-tilt[data-tilting] .vault-glare { opacity: 1; }
  @media (prefers-reduced-motion: reduce) { .vault-tilt { transition: none; } }
`;

const tiltTarget = (host: HTMLElement): HTMLElement | null =>
  host.querySelector<HTMLElement>(".vault-tilt");

/** `pointermove` on the host: lean the `.vault-tilt` inside it, up to `max` degrees. */
export function tiltMove(event: PointerEvent, max = 16): void {
  // a finger dragging is a scroll, not a hover
  if (event.pointerType === "touch" || !motionAllowed()) return;
  const host = event.currentTarget as HTMLElement;
  const target = tiltTarget(host);
  if (target === null) return;
  const rect = host.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return;
  const x = (event.clientX - rect.left) / rect.width - 0.5;
  const y = (event.clientY - rect.top) / rect.height - 0.5;
  target.dataset.tilting = "";
  target.style.setProperty("--tilt-y", `${(x * max * 2).toFixed(2)}deg`);
  target.style.setProperty("--tilt-x", `${(-y * max * 2).toFixed(2)}deg`);
  target.style.setProperty("--gx", `${((x + 0.5) * 100).toFixed(1)}%`);
  target.style.setProperty("--gy", `${((y + 0.5) * 100).toFixed(1)}%`);
}

/** `pointerleave` on the host: let go. */
export function tiltLeave(event: PointerEvent): void {
  const target = tiltTarget(event.currentTarget as HTMLElement);
  if (target !== null) tiltRelease(target);
}

export function tiltRelease(target: HTMLElement): void {
  delete target.dataset.tilting;
  target.style.setProperty("--tilt-x", "0deg");
  target.style.setProperty("--tilt-y", "0deg");
}
