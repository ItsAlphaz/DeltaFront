import type { StaffRoleWire } from "@openfront/shared/WireSchemas";
import { html, nothing, svg, SVGTemplateResult, TemplateResult } from "lit";
import { translateText } from "../../Utils";

// The staff badges: DeltaFront Owner, Administrator and Moderator. A separate
// mark from the verified check (see VerifiedBadge.ts) and drawn beside it, never
// instead of it: an account can be both. Each role has its own shape as well as
// its own colour, so they stay apart at small sizes and for colour-blind players:
//
//   mod    a shield (outline)
//   admin  a red shield with a star
//   owner  the DeltaFront delta (a triangle) with a crown, the most distinctive
//
// Callers pass the role the SERVER stamped (account API / game server), never one
// worked out from a name or a client-held token.

const LABEL_KEYS: Record<StaffRoleWire, string> = {
  owner: "staff.owner",
  admin: "staff.admin",
  mod: "staff.mod",
};

/** The role's name for a tooltip, an accessible label or a chip: "DeltaFront Owner". */
export function staffRoleLabel(role: StaffRoleWire): string {
  return translateText(LABEL_KEYS[role]);
}

const SHIELD =
  "M12 2.5 L20 5.5 V11.5 C20 16.4 16.6 20.2 12 21.8 C7.4 20.2 4 16.4 4 11.5 V5.5 Z";

// SVG fragments need the `svg` tag: an `html` template would create the paths in
// the HTML namespace, where they draw nothing.
function glyph(role: StaffRoleWire): SVGTemplateResult {
  switch (role) {
    case "mod":
      return svg` <path
          d=${SHIELD}
          fill="#161616"
          stroke="#f5f5f5"
          stroke-width="1.7"
          stroke-linejoin="round"
        ></path>
        <path
          d="M8.2 12.4 L11 15.2 L16 9.2"
          fill="none"
          stroke="#f5f5f5"
          stroke-width="1.9"
          stroke-linecap="round"
          stroke-linejoin="round"
        ></path>`;
    case "admin":
      return svg` <path
          d=${SHIELD}
          fill="#e31b23"
          stroke="#f5f5f5"
          stroke-width="1.7"
          stroke-linejoin="round"
        ></path>
        <path
          d="M12 6.8 L13.3 10.4 L17 10.6 L14.1 12.9 L15.1 16.5 L12 14.4 L8.9 16.5 L9.9 12.9 L7 10.6 L10.7 10.4 Z"
          fill="#f5f5f5"
        ></path>`;
    case "owner":
      return svg` <path
          d="M12 2 L22.4 20.6 H1.6 Z"
          fill="#e31b23"
          stroke="#f5f5f5"
          stroke-width="1.8"
          stroke-linejoin="round"
        ></path>
        <path
          d="M7.6 17 L7.2 11.6 L10 14 L12 10 L14 14 L16.8 11.6 L16.4 17 Z"
          fill="#f5f5f5"
        ></path>`;
  }
}

/**
 * The staff badge for a role, or nothing when there is none. `label: null`
 * draws it decoratively (the surrounding control already says it).
 */
export function staffBadge(
  role: StaffRoleWire | null | undefined,
  sizeClass = "w-4 h-4",
  label?: string | null,
): TemplateResult | typeof nothing {
  if (role === null || role === undefined) return nothing;
  const text = label === undefined ? staffRoleLabel(role) : label;
  return html`<svg
    viewBox="0 0 24 24"
    class="${sizeClass} shrink-0 staff-badge staff-badge-${role}"
    data-staff-role=${role}
    role=${text === null ? nothing : "img"}
    aria-hidden=${text === null ? "true" : nothing}
    aria-label=${text ?? nothing}
  >
    ${text === null ? nothing : svg`<title>${text}</title>`} ${glyph(role)}
  </svg>`;
}
