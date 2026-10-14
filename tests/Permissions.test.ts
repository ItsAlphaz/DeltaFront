import {
  ADMIN_COMMAND_PERMISSION,
  ADMIN_COMMANDS,
  API_ASSIGNABLE_ROLES,
  canActOnTarget,
  canChangeRole,
  hasPermission,
  isStaff,
  PERMISSIONS,
  permissionsOf,
  ROLE_GRANTS,
  STAFF_ROLES,
  staffRoleOf,
  type Permission,
} from "@openfront/shared/Permissions";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.join(__dirname, "..");

// The matrix, spelled out. A permission moving between roles is a decision, so
// it has to change this table (and be reviewed), not slip in with a refactor.
const MATRIX: Record<Permission, "mod" | "admin" | "owner"> = {
  "admin.panel.view": "mod",
  "admin.dashboard.view": "mod",
  "admin.users.view": "mod",
  "admin.users.ban": "mod",
  "admin.clans.view": "mod",
  "admin.audit.view_moderation": "mod",
  "game.admin.panel": "mod",
  "game.admin.spectate": "mod",
  "game.admin.kick": "mod",
  "game.admin.nations": "mod",
  "admin.users.view_email": "admin",
  "admin.users.sessions": "admin",
  "admin.users.verify": "admin",
  "admin.users.bare_name": "admin",
  "admin.users.role": "admin",
  "admin.wallet.grant": "admin",
  "admin.inventory.grant": "admin",
  "admin.clans.manage": "admin",
  "admin.clans.official": "admin",
  "admin.audit.view": "admin",
  "admin.server.view": "admin",
  "game.admin.pause": "admin",
  "game.admin.kill": "admin",
  "game.admin.debug": "admin",
  "admin.roles.manage_admins": "owner",
  "admin.clans.delete": "owner",
  "admin.server.manage": "owner",
  "game.admin.resources": "owner",
  "game.admin.force_end": "owner",
  "game.admin.impersonate_ai": "owner",
};
const RANK = { mod: 1, admin: 2, owner: 3 } as const;

describe("the role and permission matrix", () => {
  it("lists every permission exactly once, and every permission is in the table", () => {
    expect(new Set(PERMISSIONS).size).toBe(PERMISSIONS.length);
    expect([...PERMISSIONS].sort()).toEqual(Object.keys(MATRIX).sort());
  });

  it("matches the table for every role", () => {
    for (const role of STAFF_ROLES) {
      for (const permission of PERMISSIONS) {
        const expected = RANK[role] >= RANK[MATRIX[permission]];
        expect(hasPermission(role, permission), `${role} ${permission}`).toBe(
          expected,
        );
      }
    }
  });

  it("the owner holds every permission, including ones added later", () => {
    for (const permission of PERMISSIONS) {
      expect(hasPermission("owner", permission)).toBe(true);
    }
    expect(ROLE_GRANTS.owner.size).toBe(PERMISSIONS.length);
  });

  it("an admin holds the operational permissions but not the owner-only ones", () => {
    expect(hasPermission("admin", "admin.users.verify")).toBe(true);
    expect(hasPermission("admin", "game.admin.kill")).toBe(true);
    for (const owner of [
      "admin.roles.manage_admins",
      "admin.clans.delete",
      "admin.server.manage",
      "game.admin.resources",
      "game.admin.force_end",
      "game.admin.impersonate_ai",
    ] as const) {
      expect(hasPermission("admin", owner), owner).toBe(false);
    }
  });

  it("a moderator gets moderation permissions only", () => {
    for (const permission of [
      "admin.users.ban",
      "game.admin.kick",
      "game.admin.spectate",
      "admin.audit.view_moderation",
    ] as const) {
      expect(hasPermission("mod", permission), permission).toBe(true);
    }
    for (const permission of [
      "admin.users.verify",
      "admin.users.bare_name",
      "admin.users.role",
      "admin.wallet.grant",
      "admin.inventory.grant",
      "admin.clans.manage",
      "admin.audit.view",
      "game.admin.resources",
      "game.admin.kill",
      "game.admin.pause",
    ] as const) {
      expect(hasPermission("mod", permission), permission).toBe(false);
    }
  });

  it("everyone who is not staff gets nothing: no role, flagged, banned, unknown, or anything verified or entitled", () => {
    const nobody = [
      null,
      undefined,
      "",
      "flagged",
      "banned",
      "user",
      "superadmin",
      "ADMIN",
      { role: null },
      { role: "flagged" },
      // Not roles at all: verification and the bare-name entitlement ride on
      // the account, and neither carries a role.
      { verified: true } as unknown as { role?: string },
      { bareUsernameEnabled: true } as unknown as { role?: string },
      { verified: true, bareUsernameEnabled: true } as unknown as {
        role?: string;
      },
    ];
    for (const subject of nobody) {
      expect(isStaff(subject), JSON.stringify(subject)).toBe(false);
      expect(permissionsOf(subject)).toEqual([]);
      for (const permission of PERMISSIONS) {
        expect(hasPermission(subject, permission)).toBe(false);
      }
    }
  });

  it("reads upstream's root as owner, and the staff role of an object", () => {
    expect(staffRoleOf("root")).toBe("owner");
    expect(hasPermission("root", "game.admin.force_end")).toBe(true);
    expect(hasPermission({ role: "admin" }, "admin.users.verify")).toBe(true);
    expect(hasPermission({ staffRole: "mod" }, "game.admin.kick")).toBe(true);
    expect(hasPermission({ staffRole: "mod" }, "game.admin.resources")).toBe(
      false,
    );
  });

  it("each in-game command needs a permission, and changing resources or ending a game is owner-only", () => {
    for (const command of ADMIN_COMMANDS) {
      expect(ADMIN_COMMAND_PERMISSION[command], command).toBeDefined();
    }
    expect(ADMIN_COMMAND_PERMISSION.give_gold).toBe("game.admin.resources");
    expect(ADMIN_COMMAND_PERMISSION.eliminate).toBe("game.admin.kill");
    expect(ADMIN_COMMAND_PERMISSION.force_win).toBe("game.admin.force_end");
    expect(hasPermission("admin", ADMIN_COMMAND_PERMISSION.set_gold)).toBe(
      false,
    );
    expect(hasPermission("owner", ADMIN_COMMAND_PERMISSION.set_gold)).toBe(
      true,
    );
  });
});

describe("who may change whose role", () => {
  const base = { actorPublicId: "ACTOR00001", targetPublicId: "TARGET0001" };
  const change = (
    actorRole: string | null,
    current: string | null,
    next: string,
    ids = base,
  ) => canChangeRole({ actorRole, current, next, ...ids });

  it("nobody below admin may change roles", () => {
    for (const actor of [null, "mod", "flagged"]) {
      expect(change(actor, null, "mod")).toEqual({
        ok: false,
        code: "FORBIDDEN",
      });
    }
  });

  it("the owner role is never handed out over the API, by anyone", () => {
    for (const actor of ["admin", "owner", "root"]) {
      for (const next of ["owner", "root"]) {
        expect(change(actor, null, next)).toEqual({
          ok: false,
          code: "OWNER_VIA_CLI_ONLY",
        });
      }
    }
  });

  it("an admin cannot make themselves, or anyone, an admin or owner", () => {
    expect(change("admin", null, "admin")).toEqual({
      ok: false,
      code: "TARGET_PROTECTED",
    });
    expect(
      change("admin", "admin", "mod", {
        actorPublicId: "ACTOR00001",
        targetPublicId: "ACTOR00001",
      }),
    ).toEqual({ ok: false, code: "SELF_CHANGE" });
    expect(change("admin", "admin", "none")).toEqual({
      ok: false,
      code: "TARGET_PROTECTED",
    });
    expect(change("admin", "owner", "none")).toEqual({
      ok: false,
      code: "TARGET_PROTECTED",
    });
  });

  it("an admin manages moderators and the flag; the owner also manages admins, but never owners", () => {
    expect(change("admin", null, "mod")).toEqual({ ok: true });
    expect(change("admin", "mod", "flagged")).toEqual({ ok: true });
    expect(change("admin", "flagged", "none")).toEqual({ ok: true });
    expect(change("owner", null, "admin")).toEqual({ ok: true });
    expect(change("owner", "admin", "none")).toEqual({ ok: true });
    expect(change("owner", "owner", "admin")).toEqual({
      ok: false,
      code: "TARGET_PROTECTED",
    });
    expect(change("owner", "root", "none")).toEqual({
      ok: false,
      code: "TARGET_PROTECTED",
    });
    expect(change("owner", null, "superuser")).toEqual({
      ok: false,
      code: "ROLE_NOT_ASSIGNABLE",
    });
    expect([...API_ASSIGNABLE_ROLES]).toEqual([
      "admin",
      "mod",
      "flagged",
      "none",
    ]);
  });

  it("nobody acts on an account of equal or higher standing", () => {
    expect(canActOnTarget("owner", "admin")).toBe(true);
    expect(canActOnTarget("owner", "mod")).toBe(true);
    expect(canActOnTarget("owner", null)).toBe(true);
    expect(canActOnTarget("owner", "owner")).toBe(false);
    expect(canActOnTarget("admin", "mod")).toBe(true);
    expect(canActOnTarget("admin", "admin")).toBe(false);
    expect(canActOnTarget("admin", "owner")).toBe(false);
    expect(canActOnTarget("mod", "admin")).toBe(false);
    expect(canActOnTarget("mod", "mod")).toBe(false);
    expect(canActOnTarget("mod", null)).toBe(true);
    expect(canActOnTarget("mod", "flagged")).toBe(true);
    expect(canActOnTarget(null, null)).toBe(false);
    expect(canActOnTarget("flagged", null)).toBe(false);
  });
});

// The point of one authority: nothing else decides what a role may do by
// comparing role strings. The pure role helpers are the exceptions listed here.
describe("no scattered role checks", () => {
  const ALLOWED = new Set([
    "packages/shared/src/Permissions.ts",
    // Reads the "banned" pseudo-role of a token to refuse the join; not a staff check.
    "src/server/Worker.ts",
  ]);

  function walk(dir: string, out: string[]) {
    for (const e of fs.readdirSync(path.join(ROOT, dir), {
      withFileTypes: true,
    })) {
      const rel = `${dir}/${e.name}`;
      if (e.isDirectory()) walk(rel, out);
      else if (rel.endsWith(".ts")) out.push(rel);
    }
  }

  it("no source file compares a role to a staff role name", () => {
    const sources: string[] = [];
    for (const dir of ["src", "packages/shared/src", "packages/engine/src"])
      walk(dir, sources);
    const offenders = sources.filter((file) => {
      if (ALLOWED.has(file)) return false;
      const text = fs.readFileSync(path.join(ROOT, file), "utf8");
      return /\brole\)?\s*[!=]==?\s*["'](owner|admin|mod|root)["']/.test(text);
    });
    expect(offenders).toEqual([]);
  });
});
