import {
  ADMIN_CROWNS,
  ADMIN_SKINS,
  OWNER_CROWNS,
  STAFF_CROWNS,
  STAFF_SKINS,
  roleCrownNames,
  roleFlares,
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

  it("gives the owner's crowns to the owner and nobody else", () => {
    expect(roleCrownNames("mod")).toEqual([...STAFF_CROWNS]);
    expect(roleCrownNames("admin")).toEqual([...STAFF_CROWNS, ...ADMIN_CROWNS]);
    expect(roleCrownNames("owner")).toEqual([
      ...STAFF_CROWNS,
      ...ADMIN_CROWNS,
      ...OWNER_CROWNS,
    ]);
    expect(roleCrownNames(null)).toEqual([]);
    for (const role of ["mod", "admin", null, "flagged"]) {
      for (const crown of OWNER_CROWNS) {
        expect(roleFlares(role), `${role} ${crown}`).not.toContain(
          `crown:${crown}`,
        );
      }
    }
    expect(roleFlares("root")).toContain("crown:owner_wings");
  });
});
