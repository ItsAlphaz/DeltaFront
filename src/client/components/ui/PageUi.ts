import { html, nothing, svg, SVGTemplateResult, TemplateResult } from "lit";

/**
 * The account pages' shared components (Store, Inventory, Leaderboard, Clans,
 * Create Lobby), built once from the design system's tokens (`--color-ui-*`,
 * `--radius-ui-*`, `.ui-title` and friends in styles.css) so a page is made of
 * these and carries no colour or size of its own.
 *
 * They are template functions, like `modalHeader`: the page keeps its own state
 * and passes values and callbacks in. Every control is a real <button> or
 * <input> with a keyboard focus ring (`.ui-focus`: 2px accent outline) and an
 * accessible name. Red is for the selected state and the main action only.
 *
 * Each root carries a `data-ui` hook so a test can find it without knowing the
 * classes.
 */

// ---- Icons ---------------------------------------------------------------

const icon = (path: SVGTemplateResult, size = "h-5 w-5") =>
  html`<svg
    class="${size} shrink-0"
    xmlns="http://www.w3.org/2000/svg"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="2"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    ${path}
  </svg>`;

export const uiIconButtonClasses =
  "ui-focus flex h-11 w-11 shrink-0 items-center justify-center rounded-ui-card border border-ui-border-strong bg-ui-surface text-ui-muted transition-colors hover:border-ui-border-hover hover:text-ui-text cursor-pointer";

export const uiIcons = {
  lock: () =>
    icon(
      svg`<rect width="18" height="11" x="3" y="11" rx="2" ry="2" /> <path d="M7 11V7a5 5 0 0 1 10 0v4" />`,
      "h-4 w-4",
    ),
  back: () => icon(svg`<path d="M19 12H5" /> <path d="m12 19-7-7 7-7" />`),
  search: () =>
    icon(
      svg`<circle cx="11" cy="11" r="7" /> <path d="m21 21-4.3-4.3" />`,
      "h-4 w-4",
    ),
  check: (size = "h-3.5 w-3.5") => icon(svg`<path d="m5 12 5 5L20 7" />`, size),
  chevronRight: () => icon(svg`<path d="m9 6 6 6-6 6" />`, "h-4 w-4"),
  clipboard: () =>
    icon(
      svg`<rect width="8" height="4" x="8" y="2" rx="1" /> <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" />`,
      "h-5 w-5",
    ),
  players: () =>
    icon(
      svg`<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" /> <circle cx="9" cy="7" r="4" /> <path d="M22 21v-2a4 4 0 0 0-3-3.87" /> <path d="M16 3.13a4 4 0 0 1 0 7.75" />`,
      "h-4 w-4",
    ),
  plus: () => icon(svg`<path d="M12 5v14" /> <path d="M5 12h14" />`, "h-4 w-4"),
  arrowRight: () =>
    icon(svg`<path d="M5 12h14" /> <path d="m12 5 7 7-7 7" />`, "h-4 w-4"),
  eye: () =>
    icon(
      svg`<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z" />
        <circle cx="12" cy="12" r="3" />`,
      "h-5 w-5",
    ),
  play: () =>
    html`<svg
      class="h-3 w-3 shrink-0"
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
    >
      <path d="M7 4v16l13-8z" />
    </svg>`,
};

// ---- Buttons -------------------------------------------------------------

export type UiButtonVariant = "primary" | "secondary" | "text";

export interface UiButtonProps {
  label: string | TemplateResult;
  onClick?: (event: MouseEvent) => void;
  variant?: UiButtonVariant;
  disabled?: boolean;
  /** Full-width 52px action (the detail panel's), or an auto-width 44px one. */
  block?: boolean;
  ariaLabel?: string;
  /** Hook for tests: rendered as data-ui-button. */
  name?: string;
  type?: "button" | "submit";
}

const BUTTON_BASE =
  "ui-focus inline-flex items-center justify-center gap-2 rounded-ui-card border font-ui font-bold uppercase tracking-[0.06em] transition-colors cursor-pointer select-none disabled:cursor-not-allowed disabled:border-ui-border disabled:bg-ui-disabled disabled:text-ui-muted";

const BUTTON_VARIANT: Record<UiButtonVariant, string> = {
  primary:
    "border-ui-accent bg-ui-accent text-white hover:brightness-110 active:brightness-95",
  secondary:
    "border-ui-border-strong bg-ui-surface text-ui-text hover:border-ui-border-hover",
  text: "border-transparent bg-transparent text-ui-muted hover:text-ui-text disabled:!border-transparent disabled:!bg-transparent disabled:opacity-50",
};

/** The classes of a button, for the few places that need their own attributes on it. */
export function uiButtonClasses(
  variant: UiButtonVariant = "secondary",
  block = false,
): string {
  const size =
    variant === "text"
      ? "min-h-11 px-3 text-[12px]"
      : block
        ? "h-[52px] w-full px-4 text-[15px]"
        : "min-h-11 px-5 text-[13px]";
  return `${BUTTON_BASE} ${BUTTON_VARIANT[variant]} ${size}`;
}

/** primary (accent fill), secondary (surface and strong border) or a quiet text button. */
export function uiButton(props: UiButtonProps): TemplateResult {
  const variant = props.variant ?? "secondary";
  return html`<button
    type=${props.type ?? "button"}
    data-ui="button"
    data-ui-button=${props.name ?? nothing}
    data-variant=${variant}
    aria-label=${props.ariaLabel ?? nothing}
    ?disabled=${props.disabled === true}
    class="${uiButtonClasses(variant, props.block)}"
    @click=${props.onClick ?? nothing}
  >
    ${props.label}
  </button>`;
}

/** A 44px square icon button. `ariaLabel` is required: there is no text. */
export function uiIconButton(props: {
  icon: TemplateResult;
  ariaLabel: string;
  onClick?: (event: MouseEvent) => void;
  name?: string;
}): TemplateResult {
  return html`<button
    type="button"
    data-ui="icon-button"
    data-ui-button=${props.name ?? nothing}
    aria-label=${props.ariaLabel}
    class="ui-focus flex h-11 w-11 shrink-0 items-center justify-center rounded-ui-card border border-ui-border-strong bg-ui-surface text-ui-muted transition-colors hover:border-ui-border-hover hover:text-ui-text cursor-pointer"
    @click=${props.onClick ?? nothing}
  >
    ${props.icon}
  </button>`;
}

// ---- Badge / chip --------------------------------------------------------

export type UiBadgeTone = "success" | "gold" | "accent" | "neutral";

const BADGE_TONE: Record<UiBadgeTone, string> = {
  success: "bg-ui-success/15 text-ui-success",
  gold: "bg-ui-gold/15 text-ui-gold",
  accent: "bg-ui-accent-tint text-ui-accent-soft",
  neutral: "bg-ui-border-strong text-ui-muted",
};

/** A small pill: Owned, Equipped, Leader, You, Host. Never a button. */
export function uiBadge(
  label: string | TemplateResult,
  tone: UiBadgeTone = "neutral",
): TemplateResult {
  return html`<span
    data-ui="badge"
    data-tone=${tone}
    class="inline-flex items-center gap-1 rounded-full px-2.5 py-1 font-ui text-[10px] font-bold uppercase leading-none tracking-[0.1em] ${BADGE_TONE[
      tone
    ]}"
    >${label}</span
  >`;
}

/** A multi-select toggle (Disable units): selected is the accent tint. */
export function uiChip(props: {
  label: string;
  selected: boolean;
  onToggle: () => void;
  /** A selected chip can strike its label through (a disabled unit). */
  strike?: boolean;
  name?: string;
}): TemplateResult {
  return html`<button
    type="button"
    data-ui="chip"
    data-ui-chip=${props.name ?? nothing}
    aria-pressed=${props.selected ? "true" : "false"}
    class="ui-focus min-h-11 rounded-full border px-5 font-ui text-[14px] font-semibold transition-colors cursor-pointer ${props.selected
      ? "border-ui-accent bg-ui-accent-tint text-ui-accent-soft"
      : "border-ui-border-strong bg-ui-surface text-ui-text hover:border-ui-border-hover"} ${props.selected &&
    props.strike
      ? "line-through"
      : ""}"
    @click=${props.onToggle}
  >
    ${props.label}
  </button>`;
}

// ---- Segmented control and tabs -----------------------------------------

export interface UiOption<T extends string = string> {
  key: T;
  label: string | TemplateResult;
  /** Overrides the accessible name when the label is not text. */
  ariaLabel?: string;
}

/**
 * A segmented control for filters and sub-views (Featured / All / Favourites,
 * Atom / Hydrogen / MIRV, Cosmetics / Effects). One option is selected;
 * `aria-pressed` carries it for assistive technology.
 */
export function uiSegmented<T extends string>(props: {
  options: readonly UiOption<T>[];
  value: T;
  onChange: (key: T) => void;
  ariaLabel: string;
  /** "fill" stretches the options across the width (the lobby's pickers). */
  fill?: boolean;
  name?: string;
}): TemplateResult {
  return html`<div
    role="group"
    data-ui="segmented"
    data-ui-segmented=${props.name ?? nothing}
    aria-label=${props.ariaLabel}
    class="${props.fill
      ? "flex w-full"
      : "inline-flex max-w-full"} gap-1 overflow-x-auto overflow-y-hidden rounded-ui-card border border-ui-border bg-ui-ground p-1"
  >
    ${props.options.map((option) => {
      const selected = option.key === props.value;
      return html`<button
        type="button"
        data-key=${option.key}
        aria-pressed=${selected ? "true" : "false"}
        aria-label=${option.ariaLabel ?? nothing}
        class="ui-focus flex min-h-9 items-center justify-center whitespace-nowrap rounded-[8px] px-4 font-ui text-[13px] font-semibold uppercase tracking-[0.06em] transition-colors cursor-pointer ${props.fill
          ? "flex-1"
          : ""} ${selected
          ? "bg-ui-border-strong text-ui-text"
          : "text-ui-muted hover:text-ui-text"}"
        @click=${() => props.onChange(option.key)}
      >
        ${option.label}
      </button>`;
    })}
  </div>`;
}

/**
 * Underline tabs for categories (Store categories, Leaderboard tabs, Clans
 * tabs). They scroll sideways when they do not fit.
 */
export function uiTabs<T extends string>(props: {
  tabs: readonly UiOption<T>[];
  value: T;
  onChange: (key: T) => void;
  ariaLabel: string;
  name?: string;
}): TemplateResult {
  return html`<div
    role="tablist"
    data-ui="tabs"
    data-ui-tabs=${props.name ?? nothing}
    aria-label=${props.ariaLabel}
    class="flex gap-6 overflow-x-auto overflow-y-hidden border-b border-ui-border px-6"
  >
    ${props.tabs.map((tab) => {
      const selected = tab.key === props.value;
      return html`<button
        type="button"
        role="tab"
        data-key=${tab.key}
        aria-selected=${selected ? "true" : "false"}
        class="ui-focus -mb-px flex h-[52px] shrink-0 items-center whitespace-nowrap border-b-2 font-ui text-[14px] font-semibold transition-colors cursor-pointer ${selected
          ? "border-ui-accent text-ui-text"
          : "border-transparent text-ui-muted hover:text-ui-text"}"
        @click=${() => props.onChange(tab.key)}
      >
        ${tab.label}
      </button>`;
    })}
  </div>`;
}

// ---- Inputs ---------------------------------------------------------------

export function uiSearch(props: {
  value: string;
  placeholder: string;
  ariaLabel: string;
  onInput: (value: string) => void;
}): TemplateResult {
  return html`<label
    data-ui="search"
    class="ui-focus flex h-11 min-w-0 items-center gap-2 rounded-ui-card border border-ui-border bg-ui-panel px-3 text-ui-muted focus-within:border-ui-border-hover"
  >
    ${uiIcons.search()}
    <input
      type="search"
      aria-label=${props.ariaLabel}
      placeholder=${props.placeholder}
      .value=${props.value}
      class="min-w-0 flex-1 bg-transparent font-ui text-[14px] font-medium text-ui-text outline-none placeholder:text-ui-placeholder"
      @input=${(event: Event) =>
        props.onInput((event.target as HTMLInputElement).value)}
    />
  </label>`;
}

/** A checkbox with its label ("Hide owned"). */
export function uiCheck(props: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  name?: string;
}): TemplateResult {
  return html`<label
    data-ui="check"
    data-ui-check=${props.name ?? nothing}
    class="ui-focus flex min-h-11 cursor-pointer items-center gap-2.5"
  >
    <input
      type="checkbox"
      class="h-5 w-5 shrink-0 cursor-pointer"
      .checked=${props.checked}
      @change=${(event: Event) =>
        props.onChange((event.target as HTMLInputElement).checked)}
    />
    <span class="ui-body text-ui-text">${props.label}</span>
  </label>`;
}

/**
 * A row with a label and a switch (the lobby's Rules). `extra` (a dropdown, for
 * a rule with a setting) sits under the label, outside the clickable label so
 * using it does not flip the switch.
 */
export function uiSwitchRow(props: {
  label: string;
  description?: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  extra?: TemplateResult;
  title?: string;
  name?: string;
}): TemplateResult {
  return html`<div
    data-ui="switch-row"
    data-ui-switch=${props.name ?? nothing}
    title=${props.title ?? nothing}
    class="rounded-ui-card border border-ui-border bg-ui-surface px-4 py-3 hover:border-ui-border-hover"
  >
    <label
      class="ui-focus relative flex min-h-8 cursor-pointer items-center justify-between gap-4"
    >
      <span class="min-w-0">
        <span class="ui-body block text-ui-text">${props.label}</span>
        ${props.description
          ? html`<span class="ui-body mt-0.5 block text-[12px] text-ui-muted"
              >${props.description}</span
            >`
          : nothing}
      </span>
      <input
        type="checkbox"
        role="switch"
        class="peer sr-only"
        .checked=${props.checked}
        @change=${(event: Event) =>
          props.onChange((event.target as HTMLInputElement).checked)}
      />
      <span
        aria-hidden="true"
        class="relative h-6 w-11 shrink-0 rounded-full border border-ui-border-strong bg-ui-ground transition-colors peer-checked:border-ui-accent peer-checked:bg-ui-accent after:absolute after:left-0.5 after:top-0.5 after:h-[18px] after:w-[18px] after:rounded-full after:bg-ui-text after:transition-transform peer-checked:after:translate-x-5"
      ></span>
    </label>
    ${props.extra ? html`<div class="pt-3">${props.extra}</div>` : nothing}
  </div>`;
}

/** A checkbox with a label and, beside it, a number and its unit (the lobby's Limits). */
export function uiValueRow(props: {
  label: string;
  checked: boolean;
  value: number | string;
  unit?: string;
  onToggle: (checked: boolean) => void;
  onValue: (value: string) => void;
  name?: string;
}): TemplateResult {
  return html`<div
    data-ui="value-row"
    data-ui-value=${props.name ?? nothing}
    class="flex min-h-14 items-center gap-3 rounded-ui-card border border-ui-border bg-ui-surface px-4 py-2"
  >
    <label
      class="ui-focus flex min-w-0 flex-1 cursor-pointer items-center gap-3"
    >
      <input
        type="checkbox"
        class="h-5 w-5 shrink-0 cursor-pointer"
        .checked=${props.checked}
        @change=${(event: Event) =>
          props.onToggle((event.target as HTMLInputElement).checked)}
      />
      <span class="ui-body min-w-0 truncate text-ui-text">${props.label}</span>
    </label>
    <input
      type="number"
      aria-label=${props.label}
      .value=${String(props.value)}
      ?disabled=${!props.checked}
      class="ui-focus ui-mono h-11 w-24 rounded-ui-card border border-ui-border-strong bg-ui-panel px-3 text-right text-[14px] text-ui-text disabled:text-ui-muted"
      @input=${(event: Event) =>
        props.onValue((event.target as HTMLInputElement).value)}
    />
    ${props.unit
      ? html`<span class="ui-label shrink-0 normal-case tracking-normal"
          >${props.unit}</span
        >`
      : nothing}
  </div>`;
}

// ---- Cards -----------------------------------------------------------------

export type UiTier = "green" | "blue" | "purple" | "gray";

const TIER_STRIPE: Record<UiTier, string> = {
  green: "bg-ui-tier-green",
  blue: "bg-ui-tier-blue",
  purple: "bg-ui-tier-purple",
  gray: "bg-ui-tier-gray",
};

/** The catalog's rarity as one of the design system's four tiers. */
export function tierForRarity(rarity: string | undefined): UiTier {
  switch (rarity) {
    case "uncommon":
      return "green";
    case "rare":
      return "blue";
    case "epic":
    case "legendary":
      return "purple";
    default:
      return "gray";
  }
}

/**
 * A cosmetic preview is a square; the card's preview box is not. The square
 * takes the box's height and is centred in it, so the whole image shows (it
 * used to take the box's width and get cut off at the bottom).
 */
const PREVIEW_FIT =
  "[&>cosmetic-preview]:flex [&>cosmetic-preview]:items-center [&>cosmetic-preview]:justify-center [&_[data-cosmetic-preview]]:aspect-square [&_[data-cosmetic-preview]]:h-full [&_[data-cosmetic-preview]]:w-auto [&_[data-cosmetic-preview]]:max-w-full";

/**
 * A card in a grid: a dark preview area, the name and a price or meta line
 * beneath it, a 3px tier stripe on top (never a coloured background), and an
 * Owned/Equipped badge when there is one. Selected is the accent border and a
 * 1px accent ring. The whole card is one button.
 */
export function uiItemCard(props: {
  preview: TemplateResult;
  name: string;
  meta?: string | TemplateResult;
  tier?: UiTier;
  selected?: boolean;
  badge?: TemplateResult;
  onSelect: () => void;
  /** The ratio of the preview box; 4:3 by default. */
  previewClass?: string;
  /** Hooks for tests. */
  dataKey?: string;
  hook?: string;
}): TemplateResult {
  const selected = props.selected === true;
  return html`<button
    type="button"
    data-ui="item-card"
    data-ui-item=${props.hook ?? nothing}
    data-key=${props.dataKey ?? nothing}
    aria-pressed=${selected ? "true" : "false"}
    class="ui-focus group relative flex min-w-0 flex-col overflow-hidden rounded-ui-card border bg-ui-surface text-left transition-colors cursor-pointer ${selected
      ? "border-ui-accent ring-1 ring-ui-accent"
      : "border-ui-border hover:border-ui-border-hover"}"
    @click=${props.onSelect}
  >
    ${props.tier
      ? html`<span
          data-ui="tier-stripe"
          data-tier=${props.tier}
          aria-hidden="true"
          class="absolute inset-x-0 top-0 z-10 h-[3px] ${TIER_STRIPE[
            props.tier
          ]}"
        ></span>`
      : nothing}
    <span
      class="${PREVIEW_FIT} relative flex items-center justify-center overflow-hidden bg-ui-ground p-3 ${props.previewClass ??
      "aspect-[4/3]"}"
    >
      ${props.preview}
      ${props.badge
        ? html`<span class="absolute right-2 top-3 z-10">${props.badge}</span>`
        : nothing}
    </span>
    <span class="flex items-center justify-between gap-3 px-4 py-3">
      <span class="ui-body min-w-0 truncate text-ui-text">${props.name}</span>
      ${props.meta
        ? html`<span
            class="ui-mono flex shrink-0 items-center gap-1.5 text-[13px] text-ui-muted"
            >${props.meta}</span
          >`
        : nothing}
    </span>
  </button>`;
}

/** Colour variants as round swatches (the detail panel's COLOR row). */
export function uiSwatches(props: {
  swatches: readonly {
    key: string;
    label: string;
    primary: string;
    secondary: string;
  }[];
  value: string;
  onChange: (key: string) => void;
}): TemplateResult {
  return html`<div
    data-ui="swatches"
    role="group"
    class="flex flex-wrap items-center gap-3"
  >
    ${props.swatches.map((swatch) => {
      const selected = swatch.key === props.value;
      return html`<button
        type="button"
        data-variant-key=${swatch.key}
        title=${swatch.label}
        aria-label=${swatch.label}
        aria-pressed=${selected ? "true" : "false"}
        class="ui-focus flex h-11 w-11 shrink-0 cursor-pointer items-center justify-center rounded-full border-2 transition-colors ${selected
          ? "border-ui-accent"
          : "border-ui-border-strong hover:border-ui-border-hover"}"
        @click=${() => props.onChange(swatch.key)}
      >
        <span
          aria-hidden="true"
          class="h-7 w-7 rounded-full"
          style="background-image: linear-gradient(135deg, ${swatch.primary} 0 50%, ${swatch.secondary} 50% 100%)"
        ></span>
      </button>`;
    })}
  </div>`;
}

// ---- The page shell --------------------------------------------------------

/**
 * The header every page shares: a 76px bar with the back button (44px icon
 * button), the uppercase title, an optional segmented control or other control
 * beside it, and an optional status chip (balance, lobby code) on the right.
 */
export function uiPageHeader(props: {
  title: string;
  backLabel: string;
  onBack: (event: MouseEvent) => void;
  /** A segmented control, a loadout switcher... shown beside the title. */
  controls?: TemplateResult;
  /** The right side: a balance chip, a code, a secondary link. */
  status?: TemplateResult;
}): TemplateResult {
  return html`<header
    data-ui="page-header"
    class="flex h-[76px] shrink-0 items-center gap-4 border-b border-ui-border px-6"
  >
    ${uiIconButton({
      icon: uiIcons.back(),
      ariaLabel: props.backLabel,
      onClick: props.onBack,
      name: "back",
    })}
    <h1 class="ui-title shrink-0 text-ui-text">${props.title}</h1>
    ${props.controls
      ? html`<div class="min-w-0 max-w-full">${props.controls}</div>`
      : nothing}
    ${props.status
      ? html`<div class="ml-auto flex shrink-0 items-center gap-3">
          ${props.status}
        </div>`
      : nothing}
  </header>`;
}

/** The status chip in the header (a balance, a code): a bordered pill. */
export function uiStatusChip(content: TemplateResult): TemplateResult {
  return html`<div
    data-ui="status-chip"
    class="ui-mono flex h-11 items-center gap-2 rounded-ui-card border border-ui-border-strong bg-ui-surface px-4 text-[15px] font-semibold text-ui-text"
  >
    ${content}
  </div>`;
}

/**
 * The two-column body: content on the left (it scrolls), a 340px detail panel
 * on the right. Below `lg` the panel stacks under the content and the whole
 * page scrolls.
 */
export function uiTwoColumn(props: {
  content: TemplateResult;
  detail: TemplateResult;
}): TemplateResult {
  return html`<div
    data-ui="two-column"
    class="flex min-h-0 flex-col lg:h-full lg:flex-row"
  >
    <div
      data-ui="content"
      class="flex min-w-0 flex-1 flex-col [scrollbar-color:var(--color-ui-border-strong)_transparent] [scrollbar-width:thin] lg:min-h-0 lg:overflow-y-auto [&>*]:shrink-0"
    >
      ${props.content}
    </div>
    ${props.detail}
  </div>`;
}

/**
 * The detail panel: what is selected, then the page's one main action pinned
 * at the bottom (a primary button, or a secondary one when it is not a buy).
 */
export function uiDetailPanel(props: {
  body: TemplateResult;
  action?: TemplateResult;
  /** An extra block above the action (the lobby's player count). */
  footer?: TemplateResult;
}): TemplateResult {
  return html`<aside
    data-ui="detail-panel"
    class="flex w-full shrink-0 flex-col border-t border-ui-border bg-ui-surface [scrollbar-color:var(--color-ui-border-strong)_transparent] [scrollbar-width:thin] lg:min-h-0 lg:w-[340px] lg:overflow-y-auto lg:border-l lg:border-t-0"
  >
    <div class="flex flex-1 flex-col gap-5 p-6">${props.body}</div>
    ${props.footer
      ? html`<div class="px-6 pb-4">${props.footer}</div>`
      : nothing}
    ${props.action
      ? html`<div data-ui="detail-action" class="mt-auto p-6 pt-2">
          ${props.action}
        </div>`
      : nothing}
  </aside>`;
}

/** Label / value rows in the detail panel (Price, Balance after, ...). */
export function uiDetailRows(
  rows: readonly { label: string; value: string | TemplateResult }[],
): TemplateResult {
  return html`<dl data-ui="detail-rows" class="m-0 flex flex-col">
    ${rows.map(
      (row) =>
        html`<div
          class="flex min-h-11 items-center justify-between gap-4 border-t border-ui-border first:border-t-0"
        >
          <dt class="ui-body m-0 text-ui-muted">${row.label}</dt>
          <dd class="ui-body ui-mono m-0 text-right text-ui-text">
            ${row.value}
          </dd>
        </div>`,
    )}
  </dl>`;
}

/** "BOAT TRAIL · ATOM" over the item name: the detail panel's heading. */
export function uiDetailHeading(props: {
  eyebrow: string;
  title: string;
}): TemplateResult {
  return html`<div data-ui="detail-heading">
    <div class="ui-label">${props.eyebrow}</div>
    <h2 class="ui-title mt-1 normal-case tracking-normal text-ui-text">
      ${props.title}
    </h2>
  </div>`;
}
