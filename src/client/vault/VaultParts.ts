import type { VaultRarity } from "@openfront/shared/VaultSchemas";
import { html, type TemplateResult } from "lit";
import { translateText } from "../Utils";
import { sprite } from "./VaultSprites";

/** The Vault page's small pieces: icons, the header of a section, and what shows a thing as it scrolls into view. */

/** "Epic", in the player's language. */
export const rarityName = (rarity: VaultRarity): string =>
  translateText(`cosmetics.${rarity}`);

export const vaultIcons = {
  /** The Credits coin, named for a screen reader. */
  coin: (scale = 2) =>
    html`<span
      role="img"
      aria-label=${translateText("cosmetics.soft")}
      class="inline-flex"
      >${sprite("coin", scale)}</span
    >`,
  gift: (scale = 2) => sprite("gift", scale),
  gem: (scale = 1) => sprite("gem", scale),
  sparkle: (scale = 2) => sprite("sparkle", scale),
  chevron: (scale = 2) => sprite("chevron", scale),
  clock: (scale = 1) => sprite("clock", scale),
  lock: (scale = 1) => sprite("lock", scale),
  check: (scale = 1) => sprite("check", scale),
  shield: (scale = 1) => sprite("shield", scale),
};

/** The head of a section of the page: a title with its accent bar, a line under it, and what goes at the far end. */
export function vaultSectionHead(props: {
  title: string;
  blurb?: string;
  aside?: TemplateResult;
  name?: string;
}): TemplateResult {
  return html`<div
    class="flex flex-wrap items-end justify-between gap-x-6 gap-y-3"
    data-vault-section-head=${props.name ?? ""}
  >
    <div class="min-w-0">
      <h2 class="vault-section-title">
        <span class="vault-title-bar" aria-hidden="true"></span>${props.title}
      </h2>
      ${props.blurb === undefined
        ? ""
        : html`<p class="ui-body mt-1 max-w-[62ch] text-ui-muted">
            ${props.blurb}
          </p>`}
    </div>
    ${props.aside ?? ""}
  </div>`;
}

let inView: IntersectionObserver | null = null;

/**
 * Things marked `data-vault-in-view` start hidden and come in (VAULT_CSS) once
 * they are on screen: this finds the ones under `root` that have not yet and
 * watches them. Without an IntersectionObserver everything is simply shown.
 */
export function watchInView(root: HTMLElement): void {
  const waiting = root.querySelectorAll<HTMLElement>(
    "[data-vault-in-view]:not([data-in])",
  );
  if (waiting.length === 0) return;
  if (typeof IntersectionObserver === "undefined") {
    for (const el of waiting) el.dataset.in = "";
    return;
  }
  inView ??= new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        (entry.target as HTMLElement).dataset.in = "";
        inView?.unobserve(entry.target);
      }
    },
    { rootMargin: "0px 0px -8% 0px" },
  );
  for (const el of waiting) inView.observe(el);
}
