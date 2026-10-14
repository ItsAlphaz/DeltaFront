// @vitest-environment node
import { UserMeResponseSchema } from "@openfront/shared/ApiSchemas";
import { ReservedClanTagsResponseSchema } from "@openfront/shared/ClanApiSchemas";
import { CosmeticsSchema } from "@openfront/shared/CosmeticSchemas";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, it } from "vitest";
import {
  ADMIN_COMMANDS,
  runAdminCommand,
  type AdminIo,
} from "../../src/account-api/admin/commands";
import { CATALOG_DIR, loadCatalog } from "../../src/account-api/catalog/load";
import { loadConfig } from "../../src/account-api/config";
import { applyMigrations } from "../../src/account-api/db/migrator";
import { createPool } from "../../src/account-api/db/pool";
import { silentLogger } from "../../src/account-api/logger";
import { startAccountApi } from "../../src/account-api/service";
import {
  call,
  completeLogin,
  createMockProviders,
  createServerKey,
  newGuest,
  refresh,
  startHarness,
  type Harness,
} from "./util/harness";
import { createTestDatabase, describeDb } from "./util/testDb";

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

function run(h: Harness, argv: string[]) {
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

const rows = async (h: Harness, sql: string, params: unknown[] = []) =>
  (await h.db.pool.query(sql, params)).rows;

const FREE = "pattern:delta_stripes:ash";

/** What /users/@me says for this token, parsed with the client's own schema. */
async function me(h: Harness, jwt: string) {
  const res = await call(h, "/users/@me", { bearer: jwt, origin: null });
  expect(res.status).toBe(200);
  return UserMeResponseSchema.parse(await res.json());
}

/** A fresh guest: its access token and public id. */
async function guestWithId(h: Harness) {
  const g = await newGuest(h);
  const { player } = await me(h, g.jwt);
  return { ...g, publicId: player.publicId };
}

describeDb("the catalog routes (inventory feature on)", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await startHarness({ features: "accounts,inventory" });
  }, 60_000);
  afterAll(async () => h?.close());

  it("serves /cosmetics.json with no credentials, in the client's own schema", async () => {
    const res = await call(h, "/cosmetics.json", { origin: null });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/application\/json/);
    expect(res.headers.get("cache-control")).toBe("public, max-age=300");
    expect(res.headers.getSetCookie()).toEqual([]);
    const body = await res.json();
    const parsed = CosmeticsSchema.safeParse(body);
    expect(parsed.success).toBe(true);
    expect(body).not.toHaveProperty("defaultFlares");
    for (const forbidden of [
      "packs",
      "currencyPacks",
      "subscriptions",
      "tribeNames",
      "lobbyQueue",
      "crowns",
      "skins",
    ]) {
      expect(body).not.toHaveProperty(forbidden);
    }
  });

  it("answers a repeat request with 304 when the ETag still matches", async () => {
    const first = await call(h, "/cosmetics.json");
    const etag = first.headers.get("etag");
    expect(etag).toMatch(/^"[0-9a-f]{32}"$/);
    const again = await call(h, "/cosmetics.json", {
      headers: { "If-None-Match": etag! },
    });
    expect(again.status).toBe(304);
    const stale = await call(h, "/cosmetics.json", {
      headers: { "If-None-Match": '"something-else"' },
    });
    expect(stale.status).toBe(200);
  });

  it("hands out asset URLs on this API that actually resolve to the artwork", async () => {
    const catalog = (await (await call(h, "/cosmetics.json")).json()) as {
      flags: Record<string, { url: string }>;
    };
    expect(Object.keys(catalog.flags)).toEqual(["delta_mark", "split_field"]);
    for (const flag of Object.values(catalog.flags)) {
      expect(
        flag.url.startsWith(`${h.config.publicOrigin}/cosmetics/assets/`),
      ).toBe(true);
      const url = new URL(flag.url);
      const res = await call(h, `${url.pathname}${url.search}`, {
        origin: null,
      });
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toMatch(/^image\/svg\+xml/);
      expect(res.headers.get("cache-control")).toBe(
        "public, max-age=31536000, immutable",
      );
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
      expect(res.headers.get("access-control-allow-origin")).toBe("*");
      expect(res.headers.get("access-control-allow-credentials")).toBeNull();
      expect(res.headers.get("content-security-policy")).toMatch(/sandbox/);
      expect(await res.text()).toMatch(/^<svg /);
    }
  });

  it("caches an asset requested without its content version only briefly", async () => {
    const res = await call(h, "/cosmetics/assets/delta_mark.svg");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("public, max-age=300");
    const wrong = await call(h, "/cosmetics/assets/delta_mark.svg?v=nope");
    expect(wrong.headers.get("cache-control")).toBe("public, max-age=300");
  });

  it("serves only the catalog's own files: unknown names and path tricks are 404", async () => {
    for (const bad of [
      "/cosmetics/assets/nope.svg",
      "/cosmetics/assets/cosmetics.json",
      "/cosmetics/assets/%2e%2e%2fcosmetics.json",
      "/cosmetics/assets/..%2f..%2f..%2fpackage.json",
      "/cosmetics/assets/%2e%2e%2f%2e%2e%2f%2e%2e%2f%2e%2e%2fetc%2fpasswd",
      "/cosmetics/assets/delta_mark.svg%00.png",
      "/cosmetics/assets/DELTA_MARK.SVG",
      "/cosmetics/assets/",
    ]) {
      const res = await call(h, bad, { origin: null });
      expect(res.status, bad).toBe(404);
      expect(await res.text(), bad).not.toMatch(
        /root:|"name":\s*"openfront|"defaultFlares"/,
      );
    }
  });

  it("is read-only: other methods on the catalog are refused", async () => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      for (const route of [
        "/cosmetics.json",
        "/cosmetics/assets/delta_mark.svg",
      ]) {
        const res = await call(h, route, { method, json: { patterns: {} } });
        expect(res.status, `${method} ${route}`).toBe(404);
      }
    }
    const after = await (await call(h, "/cosmetics.json")).json();
    expect(CosmeticsSchema.parse(after).patterns).toHaveProperty(
      "delta_stripes",
    );
  });
});

describeDb("the catalog is off when no feature uses it", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await startHarness({ features: "accounts,leaderboards" });
  }, 60_000);
  afterAll(async () => h?.close());

  it("serves no catalog or assets, and /users/@me reports no flares", async () => {
    for (const route of [
      "/cosmetics.json",
      "/cosmetics/assets/delta_mark.svg",
      "/reserved_clan_tags",
    ]) {
      expect((await call(h, route)).status, route).toBe(404);
    }
    const g = await newGuest(h);
    const { player } = await me(h, g.jwt);
    expect(player.flares).toBeUndefined();
  });
});

describeDb("an invalid catalog stops the API from starting", () => {
  function brokenDir(edit: (text: string) => string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "df-catalog-"));
    fs.cpSync(path.join(CATALOG_DIR, "assets"), path.join(dir, "assets"), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(dir, "cosmetics.json"),
      edit(fs.readFileSync(path.join(CATALOG_DIR, "cosmetics.json"), "utf8")),
    );
    return dir;
  }

  async function start(dir: string) {
    const db = await createTestDatabase();
    try {
      const boot = createPool(
        { url: db.url, poolMax: 2, statementTimeoutMs: 30_000 },
        silentLogger,
      );
      await applyMigrations(boot);
      await boot.end();
      const config = {
        ...loadConfig({
          GAME_ENV: "dev",
          ALLOWED_ORIGINS: "http://localhost:9000",
          DATABASE_URL: db.url,
          DF_ACCOUNT_FEATURES: "accounts,inventory",
        }),
        port: 0,
      };
      const service = await startAccountApi(config, silentLogger, {
        catalogDir: dir,
      });
      await service.close();
    } finally {
      await db.drop();
    }
  }

  it("refuses a catalog with an item defined twice", async () => {
    const dir = brokenDir((t) =>
      t.replace(
        '"split_field": {',
        '"delta_mark": {"name":"delta_mark","url":"split_field.svg","product":null,"rarity":"common"},\n"split_field": {',
      ),
    );
    await expect(start(dir)).rejects.toThrow(
      /flags\.delta_mark: defined twice/,
    );
  });

  it("refuses a catalog with a premium price", async () => {
    const dir = brokenDir((t) =>
      t.replace(
        '"rarity": "common"\n    },\n    "grid_check"',
        '"rarity": "common", "priceHard": 5\n    },\n    "grid_check"',
      ),
    );
    await expect(start(dir)).rejects.toThrow(/priceHard is not allowed/);
  });

  it("starts with the shipped catalog (the control for the two above)", async () => {
    await expect(start(CATALOG_DIR)).resolves.toBeUndefined();
  });
});

describeDb("ownership, as /users/@me reports it", () => {
  let h: Harness;
  const mock = createMockProviders({
    linker: {
      discord: {
        id: "inv-linker",
        username: "linker",
        email: "l@example.com",
        verified: true,
      },
    },
    owner: {
      discord: {
        id: "inv-owner",
        username: "owner",
        email: "o@example.com",
        verified: true,
      },
    },
  });
  beforeAll(async () => {
    h = await startHarness({
      features: "accounts,inventory",
      fetchFn: mock.fetchFn,
    });
  }, 60_000);
  afterAll(async () => h?.close());

  it("gives every account, guests included, exactly the free item", async () => {
    const g = await newGuest(h);
    expect((await me(h, g.jwt)).player.flares).toEqual([FREE]);
    const signedIn = await completeLogin(h, "discord", "owner");
    const jwt = (await (await refresh(h, signedIn.jar)).json()).jwt as string;
    expect((await me(h, jwt)).player.flares).toEqual([FREE]);
  });

  it("shows an admin grant at once, keeps it across sessions, and drops it when revoked", async () => {
    const g = await guestWithId(h);
    const granted = await run(h, ["item:grant", g.publicId, "flag:delta_mark"]);
    expect(granted.code, granted.err).toBe(0);
    expect(granted.out).toMatch(/flag:delta_mark granted to/);
    expect((await me(h, g.jwt)).player.flares).toEqual([
      "flag:delta_mark",
      FREE,
    ]);

    // A new session of the same account (a refreshed token) sees it too.
    const next = (await (await refresh(h, g.jar)).json()).jwt as string;
    expect((await me(h, next)).player.flares).toEqual([
      "flag:delta_mark",
      FREE,
    ]);

    const revoked = await run(h, [
      "item:revoke",
      g.publicId,
      "flag:delta_mark",
      "--yes",
      "--reason",
      "test",
    ]);
    expect(revoked.code, revoked.err).toBe(0);
    expect((await me(h, next)).player.flares).toEqual([FREE]);

    // The row is kept, marked revoked, and a later grant restores that same row.
    const history = await rows(
      h,
      "SELECT flare, revoked_at FROM user_flares WHERE flare = 'flag:delta_mark' AND user_id = (SELECT id FROM users WHERE public_id = $1)",
      [g.publicId],
    );
    expect(history).toHaveLength(1);
    expect(history[0].revoked_at).not.toBeNull();
    const again = await run(h, ["item:grant", g.publicId, "flag:delta_mark"]);
    expect(again.out).toMatch(/restored for/);
    expect((await me(h, next)).player.flares).toEqual([
      "flag:delta_mark",
      FREE,
    ]);
  });

  it("lists every kind, sorted, and never another account's items", async () => {
    const a = await guestWithId(h);
    const b = await guestWithId(h);
    for (const flare of [
      "effect:red_wake",
      "pattern:grid_check:ember",
      "flag:split_field",
    ]) {
      expect((await run(h, ["item:grant", a.publicId, flare])).code).toBe(0);
    }
    expect((await me(h, a.jwt)).player.flares).toEqual([
      "effect:red_wake",
      "flag:split_field",
      "pattern:delta_stripes:ash",
      "pattern:grid_check:ember",
    ]);
    expect((await me(h, b.jwt)).player.flares).toEqual([FREE]);
  });

  it("never reports a stored row the catalog does not define: a removed item, a wildcard, junk", async () => {
    const g = await guestWithId(h);
    await h.db.pool.query(
      `INSERT INTO user_flares (user_id, flare, source)
       SELECT id, f, 'admin' FROM users, unnest($2::text[]) AS f WHERE public_id = $1`,
      [
        g.publicId,
        [
          "flag:retired_flag",
          "pattern:*",
          "flag:*",
          "effect:*",
          "color:ff0000",
          "<script>",
        ],
      ],
    );
    expect((await me(h, g.jwt)).player.flares).toEqual([FREE]);
  });

  it("keeps a guest's items when the guest links an account", async () => {
    const g = await guestWithId(h);
    await run(h, ["item:grant", g.publicId, "effect:red_wake"]);
    const linked = await completeLogin(h, "discord", "linker", { jar: g.jar });
    expect(linked.callback.status).toBe(302);
    const jwt = (await (await refresh(h, g.jar)).json()).jwt as string;
    const after = await me(h, jwt);
    expect(after.player.publicId).toBe(g.publicId);
    expect(after.player.flares).toEqual(["effect:red_wake", FREE]);
  });
});

describeDb("only the backend can change ownership", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await startHarness({ features: "accounts,inventory" });
  }, 60_000);
  afterAll(async () => h?.close());

  it("ignores every attempt by a signed-in browser to give itself an item", async () => {
    const g = await guestWithId(h);
    const attempts: Array<[string, string, unknown]> = [
      ["PUT", "/users/@me", { flares: ["flag:delta_mark"] }],
      ["PATCH", "/users/@me", { player: { flares: ["pattern:*"] } }],
      ["POST", "/users/@me", { flares: ["flag:delta_mark"] }],
      ["POST", "/users/@me/flares", { flare: "flag:delta_mark" }],
      ["PUT", "/users/@me/flares", { flares: ["flag:delta_mark"] }],
      ["POST", "/inventory", { flare: "flag:delta_mark" }],
      ["PUT", "/users/@me/loadout", { flag: "flag:delta_mark" }],
      [
        "POST",
        "/shop/purchase",
        {
          cosmeticType: "flag",
          cosmeticName: "delta_mark",
          currencyType: "soft",
        },
      ],
      ["POST", "/shop/purchase/pack", { packName: "starter" }],
      [
        "PUT",
        "/users/@me/username",
        { username: "sneaky", flares: ["flag:delta_mark"] },
      ],
    ];
    for (const [method, route, json] of attempts) {
      const res = await call(h, route, {
        method,
        bearer: g.jwt,
        json,
        origin: null,
      });
      expect(
        [400, 401, 403, 404, 405].includes(res.status) ||
          route === "/users/@me/username",
        `${method} ${route} -> ${res.status}`,
      ).toBe(true);
    }
    expect((await me(h, g.jwt)).player.flares).toEqual([FREE]);
    expect(
      await rows(
        h,
        "SELECT 1 FROM user_flares WHERE user_id = (SELECT id FROM users WHERE public_id = $1)",
        [g.publicId],
      ),
    ).toHaveLength(0);
  });

  it("cannot be asked by a browser to read another account's items (there is no such route)", async () => {
    const a = await guestWithId(h);
    const b = await guestWithId(h);
    for (const route of [
      `/users/${a.publicId}/flares`,
      `/public/player/${a.publicId}/flares`,
      `/inventory/${a.publicId}`,
    ]) {
      expect(
        (await call(h, route, { bearer: b.jwt, origin: null })).status,
        route,
      ).toBe(404);
    }
  });

  it("the database refuses a second row for the same account and item", async () => {
    const g = await guestWithId(h);
    const insert = () =>
      h.db.pool.query(
        "INSERT INTO user_flares (user_id, flare, source) SELECT id, 'flag:delta_mark', 'admin' FROM users WHERE public_id = $1",
        [g.publicId],
      );
    await insert();
    await expect(insert()).rejects.toMatchObject({ code: "23505" });
    await expect(
      h.db.pool.query(
        "INSERT INTO user_flares (user_id, flare, source) SELECT id, 'flag:split_field', 'browser' FROM users WHERE public_id = $1",
        [g.publicId],
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("no source file other than the inventory repository writes ownership rows, and no route reaches it", () => {
    const sources: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(path.join(ROOT, dir), {
        withFileTypes: true,
      })) {
        const rel = `${dir}/${e.name}`;
        if (e.isDirectory()) walk(rel);
        else if (rel.endsWith(".ts")) sources.push(rel);
      }
    };
    walk("src/account-api");
    const writers = sources.filter((f) =>
      /(INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+user_flares\b/i.test(
        fs.readFileSync(path.join(ROOT, f), "utf8"),
      ),
    );
    expect(writers).toEqual(["src/account-api/repo/inventory.ts"]);
    for (const file of sources.filter((f) =>
      f.startsWith("src/account-api/routes/"),
    )) {
      expect(fs.readFileSync(path.join(ROOT, file), "utf8"), file).not.toMatch(
        /\b(grantFlare|revokeFlare)\b/,
      );
    }
    // The only callers are the shared admin operations (the CLI and the /admin
    // API both go through them) and the store purchase.
    const callers = sources.filter((f) =>
      /\b(grantFlare|revokeFlare)\b/.test(
        fs.readFileSync(path.join(ROOT, f), "utf8"),
      ),
    );
    expect(callers.sort()).toEqual([
      "src/account-api/domain/adminOps.ts",
      "src/account-api/domain/economy.ts",
      "src/account-api/repo/inventory.ts",
    ]);
  });

  it("answers the game server's lookups only for a registered server key", async () => {
    const key = await createServerKey(h);
    expect(
      (await call(h, "/reserved_clan_tags", { origin: null })).status,
    ).toBe(401);
    expect(
      (
        await call(h, "/reserved_clan_tags", {
          origin: null,
          headers: { "x-api-key": "wrong-key-0123456789" },
        })
      ).status,
    ).toBe(401);
    const tags = await call(h, "/reserved_clan_tags", {
      origin: null,
      headers: { "x-api-key": key },
    });
    expect(tags.status).toBe(200);
    // no clan exists in this database: the list is the reserved names alone
    const listed = ReservedClanTagsResponseSchema.parse(await tags.json());
    expect(listed).toContain("ADMIN");
    expect(listed.every((t) => /^[A-Z0-9]{2,5}$/.test(t))).toBe(true);

    expect(
      (
        await call(h, "/custom_tribes", {
          method: "POST",
          json: { players: [] },
          origin: null,
        })
      ).status,
    ).toBe(401);
    const tribes = await call(h, "/custom_tribes", {
      method: "POST",
      json: { players: [] },
      origin: null,
      headers: { "x-api-key": key },
    });
    expect(await tribes.json()).toEqual({ tribes: [] });
  });
});

describeDb("admin: item:grant, item:revoke, item:list", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await startHarness({ features: "accounts,inventory" });
  }, 60_000);
  afterAll(async () => h?.close());

  it("lists the new commands in the help", async () => {
    const r = await run(h, ["help"]);
    for (const c of ADMIN_COMMANDS.filter((x) => x.startsWith("item:"))) {
      expect(r.out).toContain(c);
    }
    expect(ADMIN_COMMANDS.filter((x) => x.startsWith("item:"))).toHaveLength(3);
  });

  it("grants an item, once: a repeat changes nothing and leaves one row", async () => {
    const g = await guestWithId(h);
    const first = await run(h, [
      "item:grant",
      g.publicId,
      "pattern:grid_check:ember",
    ]);
    expect(first.code, first.err).toBe(0);
    const second = await run(h, [
      "item:grant",
      g.publicId,
      "pattern:grid_check:ember",
    ]);
    expect(second.code).toBe(0);
    expect(second.out).toMatch(/already owns .* \(nothing changed\)/);
    const stored = await rows(
      h,
      "SELECT flare, source, revoked_at FROM user_flares WHERE user_id = (SELECT id FROM users WHERE public_id = $1)",
      [g.publicId],
    );
    expect(stored).toEqual([
      { flare: "pattern:grid_check:ember", source: "admin", revoked_at: null },
    ]);
  });

  it("audits every grant and revoke, the repeat included, with who ran it", async () => {
    const g = await guestWithId(h);
    await run(h, ["item:grant", g.publicId, "flag:split_field"]);
    await run(h, ["item:grant", g.publicId, "flag:split_field"]);
    await run(h, [
      "item:revoke",
      g.publicId,
      "flag:split_field",
      "--yes",
      "--reason",
      "test",
    ]);
    const log = await rows(
      h,
      "SELECT actor, action, target_id, details FROM admin_audit_log WHERE target_id = $1 ORDER BY id",
      [g.publicId],
    );
    expect(log.map((l) => [l.action, l.details.result])).toEqual([
      ["item:grant", "granted"],
      ["item:grant", "already_owned"],
      ["item:revoke", "revoked"],
    ]);
    expect(
      log.every(
        (l) => l.actor === "tester" && l.details.flare === "flag:split_field",
      ),
    ).toBe(true);
  });

  it("rejects an unknown item, a wildcard, a malformed flare and an injection attempt, changing nothing", async () => {
    const g = await guestWithId(h);
    const cases: Array<[string, RegExp]> = [
      ["flag:not_in_catalog", /not an item in the catalog/],
      ["pattern:delta_stripes:neon", /not an item in the catalog/],
      ["pattern:delta_stripes", /not an item in the catalog/],
      ["crown:gold", /is not a flare/],
      ["pattern:*", /wildcard/],
      ["flag:*", /wildcard/],
      ["*", /wildcard/],
      ["flag:Delta_Mark", /is not a flare/],
      ["flag:../../etc", /is not a flare/],
      ["flag:x'; DROP TABLE users; --", /is not a flare/],
      ["", /missing flare|is not a flare/],
    ];
    for (const [flare, message] of cases) {
      const r = await run(h, ["item:grant", g.publicId, flare]);
      expect(r.code, flare).toBe(2);
      expect(r.err, flare).toMatch(message);
    }
    expect(
      await rows(
        h,
        "SELECT 1 FROM user_flares WHERE user_id = (SELECT id FROM users WHERE public_id = $1)",
        [g.publicId],
      ),
    ).toHaveLength(0);
    expect(await rows(h, "SELECT 1 FROM users LIMIT 1")).not.toHaveLength(0); // the table survived
  });

  it("refuses to grant or revoke the free default item, which everyone already owns", async () => {
    const g = await guestWithId(h);
    expect((await run(h, ["item:grant", g.publicId, FREE])).err).toMatch(
      /default item/,
    );
    expect(
      (
        await run(h, [
          "item:revoke",
          g.publicId,
          FREE,
          "--yes",
          "--reason",
          "test",
        ])
      ).err,
    ).toMatch(/default item/);
    expect(
      await rows(
        h,
        "SELECT 1 FROM user_flares WHERE user_id = (SELECT id FROM users WHERE public_id = $1)",
        [g.publicId],
      ),
    ).toHaveLength(0);
  });

  it("refuses an unknown or deleted account", async () => {
    expect(
      (await run(h, ["item:grant", "nobody00000", "flag:delta_mark"])).err,
    ).toMatch(/no user with public id/);
    const g = await guestWithId(h);
    await h.db.pool.query(
      "UPDATE users SET deleted_at = now() WHERE public_id = $1",
      [g.publicId],
    );
    const r = await run(h, ["item:grant", g.publicId, "flag:delta_mark"]);
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/deleted account/);
  });

  it("revokes only with --yes, and revoking what is not owned changes nothing", async () => {
    const g = await guestWithId(h);
    await run(h, ["item:grant", g.publicId, "flag:delta_mark"]);
    const noYes = await run(h, [
      "item:revoke",
      g.publicId,
      "flag:delta_mark",
      "--reason",
      "test",
    ]);
    expect(noYes.code).toBe(2);
    expect(noYes.err).toMatch(/--yes/);
    expect((await me(h, g.jwt)).player.flares).toContain("flag:delta_mark");

    const notOwned = await run(h, [
      "item:revoke",
      g.publicId,
      "flag:split_field",
      "--yes",
      "--reason",
      "test",
    ]);
    expect(notOwned.code).toBe(0);
    expect(notOwned.out).toMatch(/does not own/);
    expect(
      (
        await run(h, [
          "item:revoke",
          g.publicId,
          "pattern:*",
          "--yes",
          "--reason",
          "test",
        ])
      ).err,
    ).toMatch(/wildcard/);
    const done = await run(h, [
      "item:revoke",
      g.publicId,
      "flag:delta_mark",
      "--yes",
      "--reason",
      "test",
    ]);
    expect(done.out).toMatch(/revoked from/);
    // Revoking twice is a no-op, not an error.
    expect(
      (
        await run(h, [
          "item:revoke",
          g.publicId,
          "flag:delta_mark",
          "--yes",
          "--reason",
          "test",
        ])
      ).out,
    ).toMatch(/does not own/);
  });

  it("can revoke a stale grant for an item the catalog no longer has", async () => {
    const g = await guestWithId(h);
    await h.db.pool.query(
      "INSERT INTO user_flares (user_id, flare, source) SELECT id, 'flag:retired_flag', 'admin' FROM users WHERE public_id = $1",
      [g.publicId],
    );
    const listed = await run(h, ["item:list", g.publicId]);
    expect(listed.out).toMatch(
      /flag:retired_flag .*\(no longer in the catalog\)/,
    );
    expect(
      (
        await run(h, [
          "item:revoke",
          g.publicId,
          "flag:retired_flag",
          "--yes",
          "--reason",
          "test",
        ])
      ).out,
    ).toMatch(/revoked from/);
  });

  it("inspects an account's items: the default, what was granted, and what was revoked", async () => {
    const g = await guestWithId(h);
    await run(h, ["item:grant", g.publicId, "flag:delta_mark"]);
    await run(h, ["item:grant", g.publicId, "effect:red_wake"]);
    await run(h, [
      "item:revoke",
      g.publicId,
      "effect:red_wake",
      "--yes",
      "--reason",
      "test",
    ]);
    const listed = await run(h, ["item:list", g.publicId]);
    expect(listed.code).toBe(0);
    expect(listed.out).toContain(`${FREE}  default (everyone owns it)`);
    expect(listed.out).toMatch(/flag:delta_mark {2}owned \(admin\) since /);
    expect(listed.out).toMatch(/effect:red_wake {2}REVOKED /);

    const shown = await run(h, ["user:show", g.publicId]);
    expect(shown.out).toMatch(/items: +flag:delta_mark$/m);
    const fresh = await guestWithId(h);
    expect((await run(h, ["item:list", fresh.publicId])).out).toMatch(
      /\(nothing granted\)/,
    );
  });

  it("checks against the catalog it is given", async () => {
    const g = await guestWithId(h);
    const catalog = loadCatalog({ publicOrigin: "http://localhost" });
    const smaller = {
      ...catalog,
      validFlares: new Set(["flag:split_field", FREE]),
    };
    const out: string[] = [];
    const err: string[] = [];
    const io: AdminIo = {
      out: (l) => out.push(l),
      err: (l) => err.push(l),
      env: {},
      actor: "t",
      catalog: smaller,
    };
    expect(
      await runAdminCommand(
        h.db.pool,
        ["item:grant", g.publicId, "flag:delta_mark"],
        io,
      ),
    ).toBe(2);
    expect(err.join()).toMatch(/not an item in the catalog/);
    expect(
      await runAdminCommand(
        h.db.pool,
        ["item:grant", g.publicId, "flag:split_field"],
        io,
      ),
    ).toBe(0);
  });
});
