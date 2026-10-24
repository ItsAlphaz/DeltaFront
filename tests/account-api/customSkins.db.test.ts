// @vitest-environment node
import {
  CUSTOM_SKIN_NAME_MAX,
  SKIN_CREATOR_FLARE,
  encodeSkinGrid,
} from "@openfront/shared/CustomSkins";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  runAdminCommand,
  type AdminIo,
} from "../../src/account-api/admin/commands";
import { CATALOG_DIR } from "../../src/account-api/catalog/load";
import { makeUser, userMe, type TestUser } from "./util/games";
import { call, startHarness, type Harness } from "./util/harness";
import { describeDb } from "./util/testDb";

// "Create Your Own": the shop item that lets an account draw and save a few
// territory skins, the routes that keep them, and what /users/@me reports.

const FEATURES = "accounts,store,inventory";

const harnesses: Harness[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.close();
  for (const d of dirs.splice(0))
    fs.rmSync(d, { recursive: true, force: true });
});

/** The public sample plus the creator item, as the production catalog sells it. */
function catalogWithCreator(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "df-skins-"));
  dirs.push(dir);
  fs.cpSync(path.join(CATALOG_DIR, "assets"), path.join(dir, "assets"), {
    recursive: true,
  });
  fs.writeFileSync(
    path.join(dir, "assets", "create_your_own.svg"),
    '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8" fill="#000"/></svg>',
  );
  const json = JSON.parse(
    fs.readFileSync(path.join(CATALOG_DIR, "cosmetics.json"), "utf8"),
  );
  json.patterns.create_your_own = {
    name: "create_your_own",
    priceSoft: 10000,
    pattern: "AAAAAA",
    url: "create_your_own.svg",
    product: null,
    rarity: "legendary",
  };
  fs.writeFileSync(path.join(dir, "cosmetics.json"), JSON.stringify(json));
  return dir;
}

async function start() {
  const h = await startHarness({
    features: FEATURES,
    catalogDir: catalogWithCreator(),
  });
  harnesses.push(h);
  return h;
}

const q = async (h: Harness, sql: string, params: unknown[] = []) =>
  (await h.db.pool.query(sql, params)).rows;

async function giveCredits(h: Harness, u: TestUser, credits: number) {
  await q(
    h,
    `INSERT INTO wallets (user_id, credits) VALUES ($1, $2)
     ON CONFLICT (user_id) DO UPDATE SET credits = $2`,
    [u.id, credits],
  );
}

const buyCreator = (h: Harness, u: TestUser) =>
  call(h, "/shop/purchase", {
    method: "POST",
    bearer: u.jwt,
    json: {
      currencyType: "soft",
      cosmeticType: "pattern",
      cosmeticName: "create_your_own",
    },
    origin: null,
  });

/** An account that bought the creator. */
async function creator(h: Harness) {
  const u = await makeUser(h);
  await giveCredits(h, u, 10000);
  expect((await buyCreator(h, u)).status).toBe(200);
  return u;
}

const design = (over: Record<string, unknown> = {}) => ({
  name: "Night Watch",
  patternData: encodeSkinGrid({
    width: 8,
    height: 8,
    scale: 1,
    secondary: Array.from({ length: 64 }, (_, i) => i % 3 === 0),
  }),
  primaryColor: "#aa0000",
  secondaryColor: "#101010",
  ...over,
});

const save = (h: Harness, u: TestUser, slot: number | string, body: unknown) =>
  call(h, `/users/@me/skins/${slot}`, {
    method: "PUT",
    bearer: u.jwt,
    json: body,
    origin: null,
  });
const remove = (h: Harness, u: TestUser, slot: number | string) =>
  call(h, `/users/@me/skins/${slot}`, {
    method: "DELETE",
    bearer: u.jwt,
    origin: null,
  });

describeDb("the Create Your Own shop item", () => {
  it("is sold for 10,000 Credits and its flare is the right to use the creator", async () => {
    const h = await start();
    const u = await makeUser(h);
    await giveCredits(h, u, 9999);
    expect((await buyCreator(h, u)).status).toBe(400); // one Credit short
    await giveCredits(h, u, 10000);
    expect((await buyCreator(h, u)).status).toBe(200);
    expect(
      (await q(h, "SELECT credits FROM wallets WHERE user_id = $1", [u.id]))[0]
        .credits,
    ).toBe("0");
    const me = await userMe(h, u);
    expect(me.body.player.flares).toContain(SKIN_CREATOR_FLARE);
  });

  it("serves its artwork with the catalog", async () => {
    const h = await start();
    const body = (await (
      await call(h, "/cosmetics.json", { origin: null })
    ).json()) as {
      patterns: Record<string, { url?: string }>;
    };
    const url = body.patterns.create_your_own.url ?? "";
    expect(url).toMatch(
      /\/cosmetics\/assets\/create_your_own\.svg\?v=[0-9a-f]{12}$/,
    );
    const asset = await fetch(url.replace(/^https?:\/\/[^/]+/, h.baseUrl));
    expect(asset.status).toBe(200);
  });
});

describeDb("saving a design", () => {
  it("keeps it for an account that owns the creator, and reports it with the account", async () => {
    const h = await start();
    const u = await creator(h);
    const res = await save(h, u, 0, design());
    expect(res.status).toBe(200);
    const saved = ((await res.json()) as { customSkins: unknown[] })
      .customSkins;
    expect(saved).toEqual([{ slot: 0, ...design() }]);
    expect((await userMe(h, u)).body.player.customSkins).toEqual(saved);
  });

  it("replaces what a slot held, and keeps the slots apart", async () => {
    const h = await start();
    const u = await creator(h);
    await save(h, u, 0, design({ name: "One" }));
    await save(h, u, 3, design({ name: "Three" }));
    await save(h, u, 0, design({ name: "One again", primaryColor: "#00aa00" }));
    const skins = (await userMe(h, u)).body.player.customSkins;
    expect(
      skins.map((s: { slot: number; name: string }) => [s.slot, s.name]),
    ).toEqual([
      [0, "One again"],
      [3, "Three"],
    ]);
    expect(skins[0].primaryColor).toBe("#00aa00");
  });

  it("refuses an account that has not bought the creator", async () => {
    const h = await start();
    const u = await makeUser(h);
    const res = await save(h, u, 0, design());
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ code: "NOT_OWNED" });
    expect(await q(h, "SELECT 1 FROM custom_skins")).toEqual([]);
  });

  it("refuses a guest, and someone not signed in", async () => {
    const h = await start();
    const guest = await makeUser(h, "guest");
    expect((await save(h, guest, 0, design())).status).toBe(403);
    const anonymous = await call(h, "/users/@me/skins/0", {
      method: "PUT",
      json: design(),
      origin: null,
    });
    expect(anonymous.status).toBe(401);
  });

  it("refuses anything outside what a design may be, saving nothing", async () => {
    const h = await start();
    const u = await creator(h);
    const bad: Array<[string, unknown]> = [
      ["a name with markup", design({ name: "<b>hi</b>" })],
      [
        "a name that is too long",
        design({ name: "x".repeat(CUSTOM_SKIN_NAME_MAX + 1) }),
      ],
      ["no name", design({ name: "" })],
      ["a colour that is not #rrggbb", design({ primaryColor: "red" })],
      ["an upper-case colour", design({ secondaryColor: "#FFFFFF" })],
      ["data that is not a pattern", design({ patternData: "AAAA" })],
      [
        "a grid that is too big",
        design({
          patternData: encodeSkinGrid({
            width: 40,
            height: 8,
            scale: 0,
            secondary: Array.from({ length: 320 }, () => false),
          }),
        }),
      ],
      ["a missing field", { name: "x" }],
      ["not an object", "design"],
    ];
    for (const [what, body] of bad) {
      expect((await save(h, u, 0, body)).status, what).toBe(400);
    }
    expect(await q(h, "SELECT 1 FROM custom_skins")).toEqual([]);
  });

  it("has five slots, 0 to 4", async () => {
    const h = await start();
    const u = await creator(h);
    for (const slot of [0, 1, 2, 3, 4]) {
      expect((await save(h, u, slot, design())).status, String(slot)).toBe(200);
    }
    for (const slot of [5, -1, "x", "1.5"]) {
      expect((await save(h, u, slot, design())).status, String(slot)).toBe(404);
    }
    expect(await q(h, "SELECT 1 FROM custom_skins")).toHaveLength(5);
  });

  it("ignores any extra field, such as another account's id", async () => {
    const h = await start();
    const u = await creator(h);
    const other = await makeUser(h);
    await save(h, u, 0, { ...design(), userId: other.id, slot: 4 });
    const rows = await q(h, "SELECT user_id, slot FROM custom_skins");
    expect(rows).toEqual([{ user_id: u.id, slot: 0 }]);
  });
});

describeDb("deleting a design", () => {
  it("removes it, and answers with what is left", async () => {
    const h = await start();
    const u = await creator(h);
    await save(h, u, 0, design());
    await save(h, u, 1, design({ name: "Two" }));
    const res = await remove(h, u, 0);
    expect(res.status).toBe(200);
    const left = (
      (await res.json()) as { customSkins: Array<{ slot: number }> }
    ).customSkins;
    expect(left.map((s) => s.slot)).toEqual([1]);
  });

  it("is harmless for an empty slot, and never touches another account's design", async () => {
    const h = await start();
    const a = await creator(h);
    const b = await creator(h);
    await save(h, a, 0, design({ name: "Mine" }));
    expect((await remove(h, b, 0)).status).toBe(200);
    expect((await remove(h, b, 9)).status).toBe(404);
    expect((await userMe(h, a)).body.player.customSkins).toHaveLength(1);
  });

  it("goes with the account", async () => {
    const h = await start();
    const u = await creator(h);
    await save(h, u, 0, design());
    await q(h, "DELETE FROM users WHERE id = $1", [u.id]);
    expect(await q(h, "SELECT 1 FROM custom_skins")).toEqual([]);
  });
});

describeDb("/users/@me", () => {
  it("lists no designs for an account with none", async () => {
    const h = await start();
    const u = await creator(h);
    expect((await userMe(h, u)).body.player.customSkins).toBeUndefined();
  });

  it("is limited by a rate per account", async () => {
    const h = await start();
    const u = await creator(h);
    let limited = 0;
    for (let i = 0; i < 35; i++) {
      if ((await save(h, u, 0, design())).status === 429) limited++;
    }
    expect(limited).toBeGreaterThan(0);
  });
});

describeDb("staff removing a design", () => {
  function admin(h: Harness, argv: string[]) {
    const out: string[] = [];
    const err: string[] = [];
    const io: AdminIo = {
      out: (l) => out.push(l),
      err: (l) => err.push(l),
      env: {},
      actor: "tester",
    };
    return runAdminCommand(h.db.pool, argv, io).then((code) => ({
      code,
      out: out.join("\n"),
      err: err.join("\n"),
    }));
  }

  it("removes one slot, or all of them, and writes it to the audit log", async () => {
    const h = await start();
    const u = await creator(h);
    for (const slot of [0, 1, 2]) {
      await save(h, u, slot, design({ name: `Design ${slot}` }));
    }
    const one = await admin(h, [
      "skin:remove",
      u.publicId,
      "1",
      "--reason",
      "offensive",
      "--yes",
    ]);
    expect(one.code).toBe(0);
    expect(one.out).toContain('1 "Design 1"');
    expect(
      (await userMe(h, u)).body.player.customSkins.map(
        (s: { slot: number }) => s.slot,
      ),
    ).toEqual([0, 2]);
    const all = await admin(h, [
      "skin:remove",
      u.publicId,
      "all",
      "--reason",
      "offensive",
      "--yes",
    ]);
    expect(all.out).toContain("0");
    expect(await q(h, "SELECT 1 FROM custom_skins")).toEqual([]);
    const audit = await q(
      h,
      "SELECT action FROM admin_audit_log WHERE action = 'skin:remove'",
    );
    expect(audit).toHaveLength(2);
  });

  it("asks for --yes and a reason, and refuses a slot that does not exist", async () => {
    const h = await start();
    const u = await creator(h);
    await save(h, u, 0, design());
    const noYes = await admin(h, [
      "skin:remove",
      u.publicId,
      "0",
      "--reason",
      "x",
    ]);
    expect(noYes.code).not.toBe(0);
    const badSlot = await admin(h, [
      "skin:remove",
      u.publicId,
      "9",
      "--reason",
      "x",
      "--yes",
    ]);
    expect(badSlot.code).not.toBe(0);
    expect(await q(h, "SELECT 1 FROM custom_skins")).toHaveLength(1);
  });

  it("changes nothing for a slot that is empty", async () => {
    const h = await start();
    const u = await creator(h);
    const result = await admin(h, [
      "skin:remove",
      u.publicId,
      "3",
      "--reason",
      "x",
      "--yes",
    ]);
    expect(result.code).toBe(0);
    expect(result.out).toContain("nothing changed");
  });
});
