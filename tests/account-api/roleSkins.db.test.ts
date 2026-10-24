// @vitest-environment node
import {
  ADMIN_CROWNS,
  ADMIN_SKINS,
  OWNER_CROWNS,
  STAFF_CROWNS,
  STAFF_SKINS,
} from "@openfront/shared/RoleSkins";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { CATALOG_DIR } from "../../src/account-api/catalog/load";
import { makeUser, userMe } from "./util/games";
import { startHarness, type Harness } from "./util/harness";
import { describeDb } from "./util/testDb";

// The staff and admin skins are not stored for anyone: /users/@me adds them
// for as long as users.role says so.

const harnesses: Harness[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.close();
  for (const d of dirs.splice(0))
    fs.rmSync(d, { recursive: true, force: true });
});

const ALL_SKINS = [...STAFF_SKINS, ...ADMIN_SKINS];
const ALL_CROWNS = [...STAFF_CROWNS, ...ADMIN_CROWNS, ...OWNER_CROWNS];
const flareOf = (name: string) => `pattern:${name}:${name}`;

/** The public sample plus the six role skins, unpriced, each with a palette of its own. */
function catalogWithRoleSkins(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "df-roleskins-"));
  dirs.push(dir);
  fs.cpSync(path.join(CATALOG_DIR, "assets"), path.join(dir, "assets"), {
    recursive: true,
  });
  const json = JSON.parse(
    fs.readFileSync(path.join(CATALOG_DIR, "cosmetics.json"), "utf8"),
  );
  for (const name of ALL_SKINS) {
    json.colorPalettes[name] = {
      name,
      primaryColor: "#ff4040",
      secondaryColor: "#101010",
    };
    json.patterns[name] = {
      name,
      pattern: json.patterns.delta_stripes.pattern,
      colorPalettes: [{ name, isArchived: false }],
      product: null,
      rarity: "epic",
    };
  }
  fs.writeFileSync(
    path.join(dir, "assets", "role_crown.svg"),
    '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8" fill="#000"/></svg>',
  );
  for (const name of ALL_CROWNS) {
    json.crowns[name] = {
      name,
      url: "role_crown.svg",
      product: null,
      rarity: "epic",
    };
  }
  fs.writeFileSync(path.join(dir, "cosmetics.json"), JSON.stringify(json));
  return dir;
}

async function start(withSkins = true) {
  const h = await startHarness({
    features: "accounts,store,inventory",
    ...(withSkins ? { catalogDir: catalogWithRoleSkins() } : {}),
  });
  harnesses.push(h);
  return h;
}

const setRole = (h: Harness, userId: string, role: string | null) =>
  h.db.pool.query("UPDATE users SET role = $2 WHERE id = $1", [userId, role]);

const skinFlares = (flares: string[]) =>
  flares.filter((f) => ALL_SKINS.some((name) => f === flareOf(name))).sort();

const crownFlares = (flares: string[]) =>
  flares.filter((f) => ALL_CROWNS.some((name) => f === `crown:${name}`)).sort();

describeDb("staff and admin skins", () => {
  it("gives an ordinary account none of them", async () => {
    const h = await start();
    const u = await makeUser(h);
    expect(skinFlares((await userMe(h, u)).body.player.flares)).toEqual([]);
  });

  it("gives a mod the staff skins and nothing more", async () => {
    const h = await start();
    const u = await makeUser(h);
    await setRole(h, u.id, "mod");
    expect(skinFlares((await userMe(h, u)).body.player.flares)).toEqual(
      STAFF_SKINS.map(flareOf).sort(),
    );
  });

  it.each(["admin", "owner", "root"])(
    "gives %s the staff and the admin skins",
    async (role) => {
      const h = await start();
      const u = await makeUser(h);
      await setRole(h, u.id, role);
      expect(skinFlares((await userMe(h, u)).body.player.flares)).toEqual(
        ALL_SKINS.map(flareOf).sort(),
      );
    },
  );

  it("follows the role at once: promoted, demoted, removed", async () => {
    const h = await start();
    const u = await makeUser(h);
    const mine = async () =>
      skinFlares((await userMe(h, u)).body.player.flares);
    await setRole(h, u.id, "admin");
    expect(await mine()).toHaveLength(ALL_SKINS.length);
    await setRole(h, u.id, "mod");
    expect(await mine()).toEqual(STAFF_SKINS.map(flareOf).sort());
    await setRole(h, u.id, null);
    expect(await mine()).toEqual([]);
    const { rows } = await h.db.pool.query(
      "SELECT 1 FROM user_flares WHERE user_id = $1",
      [u.id],
    );
    expect(rows).toHaveLength(0);
  });

  it("grants nothing for a role the account only has flagged on it", async () => {
    const h = await start();
    const u = await makeUser(h);
    await setRole(h, u.id, "flagged");
    expect(skinFlares((await userMe(h, u)).body.player.flares)).toEqual([]);
  });

  it("is harmless when the catalog does not define the skins", async () => {
    const h = await start(false);
    const u = await makeUser(h);
    await setRole(h, u.id, "admin");
    const { status, body } = await userMe(h, u);
    expect(status).toBe(200);
    expect(skinFlares(body.player.flares)).toEqual([]);
  });

  it("gives crowns by role, and the owner's only to the owner", async () => {
    const h = await start();
    const u = await makeUser(h);
    const mine = async () =>
      crownFlares((await userMe(h, u)).body.player.flares);
    const crowns = (names: readonly string[]) =>
      names.map((n) => `crown:${n}`).sort();
    expect(await mine()).toEqual([]);
    await setRole(h, u.id, "mod");
    expect(await mine()).toEqual(crowns(STAFF_CROWNS));
    await setRole(h, u.id, "admin");
    expect(await mine()).toEqual(crowns([...STAFF_CROWNS, ...ADMIN_CROWNS]));
    await setRole(h, u.id, "owner");
    expect(await mine()).toEqual(crowns(ALL_CROWNS));
    await setRole(h, u.id, "mod");
    expect(await mine()).toEqual(crowns(STAFF_CROWNS));
    await setRole(h, u.id, null);
    expect(await mine()).toEqual([]);
  });
});
