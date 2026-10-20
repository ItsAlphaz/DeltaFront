// The settings rows in the website's design (components/ui/PageUi.ts): a
// bordered surface row, the name in the body scale and the description under
// it in muted text. Shared by every setting-* component.
export const ROW =
  "flex w-full flex-row items-center justify-between gap-4 rounded-ui-card border border-ui-border bg-ui-surface px-4 py-3 font-ui transition-colors hover:border-ui-border-hover";
export const COLUMN_ROW =
  "flex w-full flex-col gap-3 rounded-ui-card border border-ui-border bg-ui-surface px-4 py-3 font-ui transition-colors hover:border-ui-border-hover";
export const LABEL = "ui-body block font-semibold text-ui-text";
export const DESCRIPTION =
  "ui-body mt-0.5 block text-[13px] leading-snug text-ui-muted";
export const FIELD =
  "ui-focus ui-mono h-10 rounded-ui-card border border-ui-border-strong bg-ui-ground px-3 text-[14px] text-ui-text transition-colors hover:border-ui-border-hover disabled:cursor-not-allowed disabled:opacity-50";
export const RAINBOW =
  "bg-[linear-gradient(270deg,#990033,#996600,#336600,#008080,#1c3f99,#5e0099,#990033)] bg-[length:1400%_1400%] animate-rainbow-bg text-white hover:bg-[linear-gradient(270deg,#990033,#996600,#336600,#008080,#1c3f99,#5e0099,#990033)]";
