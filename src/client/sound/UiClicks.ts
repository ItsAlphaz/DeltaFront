import type { SoundEffect } from "./Sounds";

/** Slight variation so a run of clicks does not machine-gun one sample. */
export const UI_CLICK_VARIANTS: readonly SoundEffect[] = [
  "click-1",
  "click-2",
  "click-3",
];

/**
 * What counts as pressing something. Sliders are left out: the settings
 * modal gives them their own cue on every step, and a click on top would
 * double up.
 */
const CLICKABLE =
  'button, a[href], summary, select, [role="button"], [role="tab"], [role="menuitem"], input[type="checkbox"], input[type="radio"], .df-btn';

function isDisabled(el: Element): boolean {
  return (
    (el as HTMLButtonElement).disabled === true ||
    el.getAttribute("aria-disabled") === "true"
  );
}

/**
 * Whether a click event landed on a live, pressable UI control. Walks the
 * composed path so it also works for controls inside a shadow root.
 */
export function isUiClick(event: Event): boolean {
  // el.click() from code is not the player pressing something.
  if (!event.isTrusted) return false;
  for (const node of event.composedPath()) {
    if (!(node instanceof Element)) continue;
    if (node.matches('input[type="range"]')) return false;
    if (node.matches(CLICKABLE)) return !isDisabled(node);
  }
  return false;
}
