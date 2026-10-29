import type { VaultRarity } from "@openfront/shared/VaultSchemas";
import { html, svg, type SVGTemplateResult, type TemplateResult } from "lit";
import { translateText } from "../Utils";

/** The Vault page's small pieces: icons, the header of a section, and what shows a thing as it scrolls into view. */

/** "Epic", in the player's language. */
export const rarityName = (rarity: VaultRarity): string =>
  translateText(`cosmetics.${rarity}`);

const glyph = (path: SVGTemplateResult, size: string, fill = false) =>
  html`<svg
    class="${size} shrink-0"
    xmlns="http://www.w3.org/2000/svg"
    viewBox="0 0 24 24"
    fill=${fill ? "currentColor" : "none"}
    stroke=${fill ? "none" : "currentColor"}
    stroke-width="2"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    ${path}
  </svg>`;

export const vaultIcons = {
  gift: (size = "h-6 w-6") =>
    glyph(
      svg`<rect x="3" y="8" width="18" height="4" rx="1" /><path d="M12 8v13" /><path d="M19 12v7a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-7" /><path d="M7.5 8a2.5 2.5 0 0 1 0-5C11 3 12 8 12 8s1-5 4.5-5a2.5 2.5 0 0 1 0 5" />`,
      size,
    ),
  gem: (size = "h-4 w-4") =>
    glyph(
      svg`<path d="M6 3h12l4 6-10 13L2 9Z" /><path d="M11 3 8 9l4 13 4-13-3-6" /><path d="M2 9h20" />`,
      size,
    ),
  sparkle: (size = "h-4 w-4") =>
    glyph(
      svg`<path d="M12 2l2.4 7.6L22 12l-7.6 2.4L12 22l-2.4-7.6L2 12l7.6-2.4z" />`,
      size,
      true,
    ),
  chevron: (size = "h-4 w-4") => glyph(svg`<path d="m6 9 6 6 6-6" />`, size),
  clock: (size = "h-4 w-4") =>
    glyph(svg`<circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" />`, size),
  lock: (size = "h-4 w-4") =>
    glyph(
      svg`<rect width="18" height="11" x="3" y="11" rx="2" ry="2" /><path d="M7 11V7a5 5 0 0 1 10 0v4" />`,
      size,
    ),
  check: (size = "h-3.5 w-3.5") =>
    glyph(svg`<path d="m5 12 5 5L20 7" />`, size),
  shield: (size = "h-4 w-4") =>
    glyph(
      svg`<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z" /><path d="m9 12 2 2 4-4" />`,
      size,
    ),
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
