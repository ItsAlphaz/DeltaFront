// @vitest-environment node
import {
  LEVEL_MILESTONES,
  levelFromRunXp,
} from "@openfront/shared/ProgressionRules";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { CATALOG_DIR, loadCatalog } from "../../src/account-api/catalog/load";
import { backfillLevelRewards } from "../../src/account-api/jobs/milestones";
import { makeUser, type TestUser } from "./util/games";
import { call, startHarness, type Harness } from "./util/harness";
import { describeDb } from "./util/testDb";

// "Earned, not bought" and seasonal bundles, and the level rewards an account
// already past a new milestone is given.

const FEATURES = "accounts,store,inventory,progression";
const HOUR = 3_600_000;

const harnesses: Harness[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.close();
  for (const d of dirs.splice(0))
    fs.rmSync(d, { recursive: true, force: true });
});

/** A copy of the public sample catalog with `edit` applied to its JSON. */
function catalogDir(edit: (c: Record<string, any>) => void): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "df-levels-"));
  dirs.push(dir);
  fs.cpSync(path.join(CATALOG_DIR, "assets"), path.join(dir, "assets"), {
    recursive: true,
  });
  const json = JSON.parse(
    fs.readFileSync(path.join(CATALOG_DIR, "cosmetics.json"), "utf8"),
  );
  edit(json);
  fs.writeFileSync(path.join(dir, "cosmetics.json"), JSON.stringify(json));
  return dir;
}

const lockedCatalog = () =>
  catalogDir((c) => {
    c.patterns.grid_check.minLevel = 10; // 500 Credits
    c.flags.delta_mark.minLevel = 5; // 400 Credits, also in recruit_kit
    const now = Date.now();
    c.packs.war_machine.endsAt = new Date(now - HOUR).toISOString(); // over
    c.packs.doomsday_cache.startsAt = new Date(now + HOUR).toISOString(); // not yet
  });

async function start(features = FEATURES, dir = lockedCatalog()) {
  const h = await startHarness({ features, catalogDir: dir });
  harnesses.push(h);
  return h;
}

const q = async (h: Harness, sql: string, params: unknown[] = []) =>
  (await h.db.pool.query(sql, params)).rows;

async function shopper(h: Harness, level: number, prestige = 0) {
  const user = await makeUser(h);
  const runXp = [0, 0, 500, 1080, 1890, 2460][level] ?? 7270; // level 1..5, else level 10
  await q(
    h,
    `INSERT INTO user_progress (user_id, lifetime_xp, run_xp, prestige) VALUES ($1, $2, $2, $3)`,
    [user.id, runXp, prestige],
  );
  await q(
    h,
    `INSERT INTO wallets (user_id, credits) VALUES ($1, 100000)
     ON CONFLICT (user_id) DO UPDATE SET credits = 100000`,
    [user.id],
  );
  return user;
}

const buy = (h: Harness, u: TestUser, body: Record<string, unknown>) =>
  call(h, "/shop/purchase", {
    method: "POST",
    bearer: u.jwt,
    json: { currencyType: "soft", ...body },
    origin: null,
  });
const buyPack = (h: Harness, u: TestUser, packName: string) =>
  call(h, "/shop/purchase/pack", {
    method: "POST",
    bearer: u.jwt,
    json: { packName },
    origin: null,
  });
const GRID = {
  cosmeticType: "pattern",
  cosmeticName: "grid_check",
  colorPaletteName: "ember",
};
const owned = async (h: Harness, u: TestUser) =>
  (await q(h, "SELECT flare FROM user_flares WHERE user_id = $1", [u.id])).map(
    (r) => r.flare as string,
  );
const credits = async (h: Harness, u: TestUser) =>
  Number(
    (await q(h, "SELECT credits FROM wallets WHERE user_id = $1", [u.id]))[0]
      .credits,
  );

describeDb("level-locked items (earned, not bought)", () => {
  it("refuses a level-locked item below its level, charging nothing and granting nothing", async () => {
    const h = await start();
    const u = await shopper(h, 1);
    const res = await buy(h, u, GRID);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      reason: "Level too low",
      minLevel: 10,
    });
    expect(await credits(h, u)).toBe(100000);
    expect(await owned(h, u)).toEqual([]);
  });

  it("sells it once the account reaches the level", async () => {
    const h = await start();
    const u = await shopper(h, 10);
    expect((await buy(h, u, GRID)).status).toBe(200);
    expect(await owned(h, u)).toContain("pattern:grid_check:ember");
    expect(await credits(h, u)).toBe(99500);
  });

  it("counts a prestiged account as level 100", async () => {
    const h = await start();
    const u = await shopper(h, 1, 1);
    expect((await buy(h, u, GRID)).status).toBe(200);
  });

  it("leaves items without a level lock open to everyone", async () => {
    const h = await start();
    const u = await shopper(h, 1);
    const res = await buy(h, u, {
      cosmeticType: "flag",
      cosmeticName: "split_field",
    });
    expect(res.status).toBe(200);
  });

  it("is not enforced when progression is off (there is no level to read)", async () => {
    const h = await start("accounts,store,inventory");
    const u = await shopper(h, 1);
    expect((await buy(h, u, GRID)).status).toBe(200);
  });

  it("holds a bundle to the highest level any of its items needs", async () => {
    const h = await start();
    const low = await shopper(h, 3);
    const res = await buyPack(h, low, "recruit_kit");
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ reason: "Level too low", minLevel: 5 });
    expect(await credits(h, low)).toBe(100000);
    const ok = await shopper(h, 5);
    expect((await buyPack(h, ok, "recruit_kit")).status).toBe(200);
  });
});

describeDb("seasonal bundles", () => {
  it("are not sold after their end or before their start", async () => {
    const h = await start();
    const u = await shopper(h, 10);
    for (const name of ["war_machine", "doomsday_cache"]) {
      const res = await buyPack(h, u, name);
      expect(res.status, name).toBe(400);
      expect(await res.json(), name).toEqual({ reason: "Pack not found" });
    }
    expect(await credits(h, u)).toBe(100000);
  });

  it("are served in the catalog with their window", async () => {
    const h = await start();
    const body = await (
      await call(h, "/cosmetics.json", { origin: null })
    ).json();
    expect(body.packs.war_machine.endsAt).toBeTruthy();
    expect(body.packs.doomsday_cache.startsAt).toBeTruthy();
    expect(body.flags.delta_mark.minLevel).toBe(5);
  });
});

describeDb("level rewards for accounts already past a new milestone", () => {
  const sample = loadCatalog({ publicOrigin: "http://localhost" });

  it("gives an account every milestone reward it is at or above, once", async () => {
    const h = await start("accounts,store,inventory,progression", CATALOG_DIR);
    const u = await shopper(h, 10, 0);
    const runXp = 100_000; // level 44
    await q(
      h,
      "UPDATE user_progress SET run_xp = $2, lifetime_xp = $2 WHERE user_id = $1",
      [u.id, runXp],
    );
    const env = { validFlares: sample.validFlares };
    const first = await backfillLevelRewards(h.db.pool, env);
    expect(first.accounts).toBeGreaterThanOrEqual(1);
    const rewards = await q(
      h,
      "SELECT key, flare FROM progression_rewards WHERE user_id = $1 ORDER BY key",
      [u.id],
    );
    const level = levelFromRunXp(runXp);
    expect(level).toBe(44);
    const due = LEVEL_MILESTONES.filter((m) => m.level <= level);
    expect(rewards.map((r) => r.key).sort()).toEqual(
      due.map((m) => `level:p0:${m.level}`).sort(),
    );
    // the XP-only cosmetics of those levels were granted
    const flares = await owned(h, u);
    for (const m of due) if (m.flare) expect(flares).toContain(m.flare);
    expect(flares).toContain("effect:corporal_wake");
    expect(flares).toContain("effect:lieutenant_ring");
    expect(flares).not.toContain("effect:major_livery"); // level 60
    // a second run (every restart) creates nothing
    expect(await backfillLevelRewards(h.db.pool, env)).toEqual({
      accounts: 0,
      rewards: 0,
    });
  });

  it("gives a level 1 account nothing", async () => {
    const h = await start("accounts,store,inventory,progression", CATALOG_DIR);
    const u = await shopper(h, 1, 0);
    await backfillLevelRewards(h.db.pool, { validFlares: sample.validFlares });
    expect(
      await q(h, "SELECT 1 FROM progression_rewards WHERE user_id = $1", [
        u.id,
      ]),
    ).toHaveLength(0);
  });
});
