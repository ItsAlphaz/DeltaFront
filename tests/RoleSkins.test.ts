import {
  ADMIN_SKINS,
  STAFF_SKINS,
  roleSkinFlares,
  roleSkinNames,
} from "@openfront/shared/RoleSkins";
import { describe, expect, it } from "vitest";

describe("role skins", () => {
  it("gives staff the staff skins and admins both sets", () => {
    expect(roleSkinNames("mod")).toEqual([...STAFF_SKINS]);
    expect(roleSkinNames("admin")).toEqual([...STAFF_SKINS, ...ADMIN_SKINS]);
    expect(roleSkinNames("owner")).toEqual([...STAFF_SKINS, ...ADMIN_SKINS]);
    expect(roleSkinNames(null)).toEqual([]);
  });

  it("reads the users.role value, the owner's legacy name included", () => {
    expect(roleSkinFlares("root")).toEqual(roleSkinFlares("owner"));
    expect(roleSkinFlares("mod")).toEqual([
      "pattern:staff_tag:staff_tag",
      "pattern:staff_diagonal:staff_diagonal",
    ]);
    for (const role of [null, undefined, "", "flagged", "none", "*"]) {
      expect(roleSkinFlares(role), String(role)).toEqual([]);
    }
  });
});
