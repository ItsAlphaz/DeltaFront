import { staffRoleOf } from "@openfront/shared/Permissions";
import { html, nothing, TemplateResult } from "lit";
import type { AdminResult } from "../AdminApi";
import { translateText } from "../Utils";

/** Panel text: every string lives under "admin_panel." in en.json. */
export const t = (key: string, vars?: Record<string, string | number>) =>
  translateText(`admin_panel.${key}`, vars);

export type ChipTone = "red" | "white" | "grey" | "green" | "amber";

const CHIP_TONES: Record<ChipTone, string> = {
  red: "border-df-red/60 bg-df-red/15 text-df-red-bright",
  white: "border-white/30 bg-white/10 text-white",
  grey: "border-white/10 bg-white/5 text-white/50",
  green: "border-emerald-500/40 bg-emerald-500/10 text-emerald-300",
  amber: "border-amber-500/40 bg-amber-500/10 text-amber-300",
};

/** A compact status chip (OWNER, ADMIN, MOD, VERIFIED, BANNED, ONLINE, ...). */
export function chip(label: string, tone: ChipTone = "grey"): TemplateResult {
  return html`<span
    class="inline-flex items-center rounded border px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider whitespace-nowrap ${CHIP_TONES[
      tone
    ]}"
    >${label}</span
  >`;
}

/** The role and state chips of one account row. */
export function accountChips(user: {
  role: string | null;
  verified: boolean;
  banned?: boolean;
  kind?: string;
}): TemplateResult {
  const staff = staffRoleOf(user.role);
  return html`<span class="inline-flex flex-wrap gap-1"
    >${staff === "owner"
      ? chip(t("chip_owner"), "red")
      : staff === "admin"
        ? chip(t("chip_admin"), "red")
        : staff === "mod"
          ? chip(t("chip_mod"), "white")
          : user.role === "flagged"
            ? chip(t("chip_flagged"), "amber")
            : nothing}
    ${user.verified ? chip(t("chip_verified"), "white") : nothing}
    ${user.banned === true ? chip(t("chip_banned"), "red") : nothing}
    ${user.kind === "guest" ? chip(t("chip_guest"), "grey") : nothing}</span
  >`;
}

export function fmtDate(iso: string | null): string {
  if (iso === null) return "-";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "-" : d.toLocaleString();
}

export function ago(iso: string): string {
  const s = Math.max(
    0,
    Math.floor((Date.now() - new Date(iso).getTime()) / 1000),
  );
  if (s < 60) return t("ago_seconds", { n: s });
  if (s < 3600) return t("ago_minutes", { n: Math.floor(s / 60) });
  if (s < 86400) return t("ago_hours", { n: Math.floor(s / 3600) });
  return t("ago_days", { n: Math.floor(s / 86400) });
}

/**
 * The refusal codes the API sends that the panel has words for
 * ("admin_panel.error_<code>" in en.json). Anything else falls back to the
 * server's message, or a generic line with the code.
 */
export const KNOWN_ERROR_CODES: readonly string[] = [
  "ALREADY_LEADER",
  "ARCHIVED",
  "CATALOG_UNAVAILABLE",
  "CLAN_NOT_FOUND",
  "CONFIRMATION_REQUIRED",
  "DEFAULT_ITEM",
  "FORBIDDEN",
  "INSUFFICIENT",
  "NAME_TAKEN",
  "NO_CHANGE",
  "NO_SEASON",
  "NOT_FOUND",
  "NOT_IN_CATALOG",
  "NOT_REGISTERED",
  "NOT_STARTED",
  "NUMBER_TAKEN",
  "OVERLAP",
  "OWNER_VIA_CLI_ONLY",
  "ROLE_NOT_ASSIGNABLE",
  "SELF_ACTION",
  "SELF_CHANGE",
  "STARTED",
  "TAG_HELD",
  "TAG_TAKEN",
  "TARGET_PROTECTED",
  "TRANSFER_REQUIRED",
  "WALLET_MAX",
];

/** A readable reason for a failed request. */
export function errorText(
  result: Extract<AdminResult<unknown>, { ok: false }>,
): string {
  if (result.status === 401) return t("error_signed_out");
  if (KNOWN_ERROR_CODES.includes(result.error)) {
    return t(`error_${result.error}`);
  }
  if (result.status === 403) return t("error_forbidden");
  if (result.status === 429) return t("error_rate_limited");
  return result.message ?? t("error_generic", { code: result.error });
}

// Shared Tailwind class sets, so the five views look like one panel.
export const CARD = "rounded-lg border border-df-border bg-df-panel p-4";
export const TABLE = "w-full text-left text-sm border-collapse";
export const TH =
  "px-3 py-2 text-[10px] uppercase tracking-widest text-df-text-muted font-bold border-b border-df-border";
export const TD = "px-3 py-2 border-b border-df-border/60 align-middle";
export const INPUT =
  "df-input rounded border border-df-border bg-df-bg px-3 py-2 text-sm text-df-text placeholder-white/30 focus:outline-none focus:ring-2 focus:ring-df-red/60";
export const BTN = "df-btn df-btn-secondary !min-h-9 !px-3 !py-1.5 !text-xs";
export const BTN_PRIMARY =
  "df-btn df-btn-primary !min-h-9 !px-3 !py-1.5 !text-xs";
/** Obviously dangerous: red on black with a heavy border. */
export const BTN_DANGER =
  "df-btn !min-h-9 !px-3 !py-1.5 !text-xs !bg-black !text-df-red-bright !border-df-red hover:!bg-df-red hover:!text-white";

export function sectionTitle(text: string): TemplateResult {
  return html`<h3
    class="text-[11px] uppercase tracking-[0.2em] text-df-text-muted font-bold mb-2"
  >
    ${text}
  </h3>`;
}

export function stat(label: string, value: string | number): TemplateResult {
  return html`<div class="${CARD} flex flex-col gap-1">
    <span class="text-[10px] uppercase tracking-widest text-df-text-muted"
      >${label}</span
    >
    <span class="text-2xl font-bold text-df-text tabular-nums">${value}</span>
  </div>`;
}
