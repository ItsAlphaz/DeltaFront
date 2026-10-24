import { StaffRole, staffRoleOf } from "./Permissions";

/**
 * Skins and crowns that belong to a role instead of being bought: the staff
 * and admin patterns, and the staff, admin and owner crowns. The account API adds their flares to what `/users/@me` reports for
 * as long as the account holds the role, so they appear in the inventory when
 * someone is promoted and are gone, with nothing stored to clean up, when the
 * role is taken away. Each skin is a catalog pattern without a price, with one
 * palette that has the same name, and each crown a catalog crown without a
 * price; a catalog without them simply grants nothing.
 */
export const STAFF_SKINS = ["staff_tag", "staff_diagonal"] as const;
export const ADMIN_SKINS = [
  "admin_tag",
  "admin_diagonal",
  "admin_crest",
  "admin_shield",
] as const;

export const STAFF_CROWNS = ["staff_majesty", "pixel_staff"] as const;
export const ADMIN_CROWNS = ["crimson_majesty", "pixel_admin"] as const;
/** Only the owner is given these. */
export const OWNER_CROWNS = [
  "owner_majesty",
  "owner_wings",
  "pixel_owner",
] as const;

/** The skin names a staff role is given: everyone on staff gets the staff skins, admins and the owner the admin ones too. */
export function roleSkinNames(staffRole: StaffRole | null): string[] {
  switch (staffRole) {
    case "owner":
    case "admin":
      return [...STAFF_SKINS, ...ADMIN_SKINS];
    case "mod":
      return [...STAFF_SKINS];
    default:
      return [];
  }
}

/** The flares (`pattern:<name>:<palette>`) of the skins an account with this `users.role` is given. */
export function roleSkinFlares(role: string | null | undefined): string[] {
  return roleSkinNames(staffRoleOf(role)).map(
    (name) => `pattern:${name}:${name}`,
  );
}

/** The crown names a staff role is given: the owner's only go to the owner. */
export function roleCrownNames(staffRole: StaffRole | null): string[] {
  switch (staffRole) {
    case "owner":
      return [...STAFF_CROWNS, ...ADMIN_CROWNS, ...OWNER_CROWNS];
    case "admin":
      return [...STAFF_CROWNS, ...ADMIN_CROWNS];
    case "mod":
      return [...STAFF_CROWNS];
    default:
      return [];
  }
}

/** Every flare an account with this `users.role` is given: its skins and its crowns. */
export function roleFlares(role: string | null | undefined): string[] {
  const staffRole = staffRoleOf(role);
  return [
    ...roleSkinFlares(role),
    ...roleCrownNames(staffRole).map((name) => `crown:${name}`),
  ];
}
