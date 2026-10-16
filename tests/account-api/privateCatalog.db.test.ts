// @vitest-environment node
import { UserMeResponseSchema } from "@openfront/shared/ApiSchemas";
import { CosmeticsSchema } from "@openfront/shared/CosmeticSchemas";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  runAdminCommand,
  type AdminIo,
} from "../../src/account-api/admin/commands";
import { loadConfig } from "../../src/account-api/config";
import { applyMigrations } from "../../src/account-api/db/migrator";
import { createPool } from "../../src/account-api/db/pool";
import { silentLogger } from "../../src/account-api/logger";
import { startAccountApi } from "../../src/account-api/service";
import {
  call,
  completeLogin,
  createMockProviders,
  newGuest,
  refresh,
  startHarness,
  type Harness,
} from "./util/harness";
import {
  makePrivateCatalog,
  PRIVATE_ITEMS,
  PRIVATE_ONLY_FLARES,
  PRIVATE_PRICES,
  type PrivateCatalog,
} from "./util/privateCatalog";
import { createTestDatabase, describeDb } from "./util/testDb";

const FEATURES = "accounts,inventory,store";

function cli(h: Harness, argv: string[], env: Record<string, string> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const io: AdminIo = {
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    env,
    actor: "tester",
  };
  return runAdminCommand(h.db.pool, argv, io).then((code) => ({
    code,
    out: out.join("\n"),
    err: err.join("\n"),
  }));
}

const accounts: Record<string, any> = {};
for (let i = 0; i < 6; i++) {
  accounts[`pc${i}`] = {
    discord: {
      id: `pc-${i}`,
      username: `pc${i}`,
      email: `pc${i}@example.com`,
      verified: true,
    },
  };
}

describeDb("the API with a private production catalog (DF_CATALOG_DIR)", () => {
  let h: Harness;
  let priv: PrivateCatalog;
  const mock = createMockProviders(accounts);
  let n = 0;

  beforeAll(async () => {
    priv = makePrivateCatalog();
    h = await startHarness({
      features: FEATURES,
      fetchFn: mock.fetchFn,
      extraEnv: priv.env,
      limits: { purchase: { max: 100_000, windowMs: 60_000 } },
    });
  }, 60_000);
  afterAll(async () => {
    await h?.close();
    priv?.cleanup();
  });

  async function shopper(credits: number) {
    const login = await completeLogin(h, "discord", `pc${n++}`);
    const jwt = (await (await refresh(h, login.jar)).json()).jwt as string;
    const me = await meOf(jwt);
    if (credits > 0) {
      const r = await cli(h, [
        "wallet:grant",
        me.player.publicId,
        String(credits),
        "--reason",
        "test",
      ]);
      expect(r.code, r.err).toBe(0);
    }
    return { jwt, publicId: me.player.publicId };
  }
  const meOf = async (jwt: string) =>
    UserMeResponseSchema.parse(
      await (await call(h, "/users/@me", { bearer: jwt, origin: null })).json(),
    );

  it("loaded the configured catalog, not the sample", () => {
    expect(h.config.catalog).toEqual({
      dir: priv.dir,
      assetDir: priv.assetDir,
    });
  });

  it("serves the private catalog at /cosmetics.json, in the client's own schema, and none of the sample-only items", async () => {
    const res = await call(h, "/cosmetics.json", { origin: null });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(CosmeticsSchema.safeParse(body).success).toBe(true);
    expect(body.flags).toHaveProperty(PRIVATE_ITEMS.adminFlag);
    expect(body.crowns).toHaveProperty(PRIVATE_ITEMS.crown);
    expect(body.patterns).toHaveProperty(PRIVATE_ITEMS.pattern);
    for (const [slot, name] of Object.entries(PRIVATE_ITEMS.effects)) {
      const type = ["atom", "hydro", "mirvWarhead"].includes(slot)
        ? "nukeExplosion"
        : slot;
      expect(body.effects[type], name).toHaveProperty(name);
    }
    expect(body.crowns).not.toHaveProperty("sample_crown");
    expect(body.effects.nukeTrail).not.toHaveProperty("sample_nuke_trail");
    // Absolute URLs on this API, versioned by content.
    expect(body.crowns[PRIVATE_ITEMS.crown].url).toMatch(
      new RegExp(
        `^${h.config.publicOrigin}/cosmetics/assets/${PRIVATE_ITEMS.crown}\\.svg\\?v=[0-9a-f]{12}$`,
      ),
    );
  });

  it("serves the images from DF_CATALOG_ASSET_DIR: the private ones and the originals", async () => {
    for (const file of [
      `${PRIVATE_ITEMS.crown}.svg`,
      `${PRIVATE_ITEMS.flag}.svg`,
      `${PRIVATE_ITEMS.adminFlag}.svg`,
      "delta_mark.svg",
    ]) {
      const res = await call(h, `/cosmetics/assets/${file}`, { origin: null });
      expect(res.status, file).toBe(200);
      expect(res.headers.get("content-type")).toMatch(/^image\/svg\+xml/);
      expect(res.headers.get("content-security-policy")).toMatch(/sandbox/);
      expect(await res.text()).toMatch(/^<svg /);
    }
  });

  it("serves nothing else from the asset folder: decoys, sources, hidden files, listings, other folders", async () => {
    for (const route of [
      "/cosmetics/assets/unused_variant.svg",
      "/cosmetics/assets/notes.txt",
      "/cosmetics/assets/.hidden.svg",
      "/cosmetics/assets/source",
      "/cosmetics/assets/source%2Fprod_crown.psd",
      "/cosmetics/assets/source/prod_crown.psd",
      "/cosmetics/assets/",
      "/cosmetics/assets",
      "/cosmetics/assets/..%2Fcatalog%2Fcosmetics.json",
      "/cosmetics/assets/%2e%2e%2fcatalog%2fcosmetics.json",
      "/cosmetics/assets/..%2f..%2fetc%2fpasswd",
      "/cosmetics/assets/cosmetics.json",
      "/cosmetics/assets/effects.json",
      "/cosmetics/assets/sample_crown.svg",
    ]) {
      const res = await call(h, route, { origin: null });
      expect(res.status, route).toBe(404);
      expect(await res.text(), route).not.toContain("private, not for serving");
    }
  });

  it("lets an account buy a private item at its own price, and own it afterwards", async () => {
    const s = await shopper(PRIVATE_PRICES.crown + PRIVATE_PRICES.pattern + 50);
    const buy = (json: unknown) =>
      call(h, "/shop/purchase", {
        method: "POST",
        bearer: s.jwt,
        origin: null,
        json,
      });
    const crown = await buy({
      cosmeticType: "crown",
      cosmeticName: PRIVATE_ITEMS.crown,
      currencyType: "soft",
    });
    expect(crown.status).toBe(200);
    expect(await crown.json()).toMatchObject({
      currency: { soft: PRIVATE_PRICES.pattern + 50 },
      flares: [`crown:${PRIVATE_ITEMS.crown}`],
    });
    const pattern = await buy({
      cosmeticType: "pattern",
      cosmeticName: PRIVATE_ITEMS.pattern,
      colorPaletteName: "ember",
      currencyType: "soft",
    });
    expect(pattern.status).toBe(200);
    const me = await meOf(s.jwt);
    expect(me.player.flares).toEqual(
      expect.arrayContaining([
        `crown:${PRIVATE_ITEMS.crown}`,
        `pattern:${PRIVATE_ITEMS.pattern}:ember`,
      ]),
    );
    expect(me.player.currency?.soft).toBe(50);
    // Owned: not sold twice. A sample-only item is not for sale here at all.
    expect(
      (
        await buy({
          cosmeticType: "crown",
          cosmeticName: PRIVATE_ITEMS.crown,
          currencyType: "soft",
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await buy({
          cosmeticType: "crown",
          cosmeticName: "sample_crown",
          currencyType: "soft",
        })
      ).status,
    ).toBe(400);
  });

  it("does not sell an item with no price (admin-only), but an admin may grant it", async () => {
    const s = await shopper(5000);
    const res = await call(h, "/shop/purchase", {
      method: "POST",
      bearer: s.jwt,
      origin: null,
      json: {
        cosmeticType: "flag",
        cosmeticName: PRIVATE_ITEMS.adminFlag,
        currencyType: "soft",
      },
    });
    expect(res.status).toBe(400);
  });

  describe("the admin item tools check the private catalog", () => {
    const flare = `flag:${PRIVATE_ITEMS.adminFlag}`;

    it("grant and revoke an item that only the private catalog has, when the environment names it", async () => {
      const g = await newGuest(h);
      const id = (await meOf(g.jwt)).player.publicId;
      const grant = await cli(h, ["item:grant", id, flare], priv.env);
      expect(grant.code, grant.err).toBe(0);
      expect((await meOf(g.jwt)).player.flares).toContain(flare);
      const list = await cli(h, ["item:list", id], priv.env);
      expect(list.out).toContain(flare);
      const revoke = await cli(
        h,
        ["item:revoke", id, flare, "--yes", "--reason", "test"],
        priv.env,
      );
      expect(revoke.code, revoke.err).toBe(0);
      expect((await meOf(g.jwt)).player.flares).not.toContain(flare);
    });

    it("every private item can be granted, and a sample-only item cannot", async () => {
      const g = await newGuest(h);
      const id = (await meOf(g.jwt)).player.publicId;
      for (const each of PRIVATE_ONLY_FLARES) {
        const r = await cli(h, ["item:grant", id, each], priv.env);
        expect(r.code, `${each}: ${r.err}`).toBe(0);
      }
      const sampleOnly = await cli(
        h,
        ["item:grant", id, "crown:sample_crown"],
        priv.env,
      );
      expect(sampleOnly.code).toBe(2);
      expect(sampleOnly.err).toMatch(/not an item in the catalog/);
    });

    it("without the private catalog in its environment the same grant is refused (the sample does not have it)", async () => {
      const g = await newGuest(h);
      const id = (await meOf(g.jwt)).player.publicId;
      const r = await cli(h, ["item:grant", id, flare], {});
      expect(r.code).toBe(2);
      expect(r.err).toMatch(/not an item in the catalog/);
    });

    it("does not bypass validation: wildcards, junk and unknown items are refused", async () => {
      const g = await newGuest(h);
      const id = (await meOf(g.jwt)).player.publicId;
      for (const bad of [
        "flag:*",
        "flag:not_here",
        "crown:*",
        "*",
        "flag:../x",
      ]) {
        const r = await cli(h, ["item:grant", id, bad], priv.env);
        expect(r.code, bad).toBe(2);
      }
    });

    it("a configured catalog that cannot be read is an error, never the sample", async () => {
      const g = await newGuest(h);
      const id = (await meOf(g.jwt)).player.publicId;
      const r = await cli(h, ["item:grant", id, "flag:delta_mark"], {
        DF_CATALOG_DIR: `${priv.root}/missing`,
        DF_CATALOG_ASSET_DIR: priv.assetDir,
      });
      expect(r.code).toBe(1);
      expect(r.err).toMatch(/cosmetics\.json cannot be read/);
      const relative = await cli(h, ["item:grant", id, "flag:delta_mark"], {
        DF_CATALOG_DIR: "relative/path",
      });
      expect(relative.code).toBe(1);
      expect(relative.err).toMatch(/must be an absolute path/);
    });
  });
});

describeDb("the API with only the public sample catalog", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await startHarness({ features: FEATURES });
  }, 60_000);
  afterAll(async () => h?.close());

  it("serves the sample, which has no private item", async () => {
    expect(h.config.catalog).toEqual({ dir: null, assetDir: null });
    const body = await (
      await call(h, "/cosmetics.json", { origin: null })
    ).json();
    expect(body.crowns).toHaveProperty("sample_crown");
    expect(body.crowns).not.toHaveProperty(PRIVATE_ITEMS.crown);
    expect(body.flags).not.toHaveProperty(PRIVATE_ITEMS.adminFlag);
    expect((await call(h, "/cosmetics/assets/sample_crown.svg")).status).toBe(
      200,
    );
    expect(
      (await call(h, `/cosmetics/assets/${PRIVATE_ITEMS.crown}.svg`)).status,
    ).toBe(404);
  });

  it("refuses to grant an item only the private catalog has (the admin tools check the catalog in use)", async () => {
    const g = await newGuest(h);
    const me = UserMeResponseSchema.parse(
      await (
        await call(h, "/users/@me", { bearer: g.jwt, origin: null })
      ).json(),
    );
    const r = await cli(h, [
      "item:grant",
      me.player.publicId,
      `flag:${PRIVATE_ITEMS.adminFlag}`,
    ]);
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/not an item in the catalog/);
  });
});

describeDb(
  "a private catalog that is missing or broken stops the API from starting",
  () => {
    async function start(env: Record<string, string>) {
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
            DF_ACCOUNT_FEATURES: FEATURES,
            ...env,
          }),
          port: 0,
        };
        const service = await startAccountApi(config, silentLogger);
        await service.close();
      } finally {
        await db.drop();
      }
    }

    it("starts with a good private catalog (the control for the rest)", async () => {
      const f = makePrivateCatalog();
      try {
        await expect(start(f.env)).resolves.toBeUndefined();
      } finally {
        f.cleanup();
      }
    });

    it("refuses to start, and does not serve the sample instead, when the folder is missing", async () => {
      const f = makePrivateCatalog();
      try {
        await expect(
          start({
            DF_CATALOG_DIR: `${f.root}/gone`,
            DF_CATALOG_ASSET_DIR: f.assetDir,
          }),
        ).rejects.toThrow(/cosmetics\.json cannot be read/);
      } finally {
        f.cleanup();
      }
    });

    it("refuses to start on a malformed catalog or a missing image", async () => {
      const f = makePrivateCatalog();
      try {
        const fs = await import("node:fs");
        fs.writeFileSync(`${f.dir}/effects.json`, "{ nope");
        await expect(start(f.env)).rejects.toThrow(
          /effects\.json is not valid JSON/,
        );
        fs.rmSync(`${f.dir}/effects.json`);
        fs.rmSync(`${f.assetDir}/${PRIVATE_ITEMS.crown}.svg`);
        await expect(start(f.env)).rejects.toThrow(
          /prod_crown\.svg does not exist/,
        );
      } finally {
        f.cleanup();
      }
    });

    it("refuses to start on a relative path, or an asset folder without a catalog folder", async () => {
      await expect(
        start({ DF_CATALOG_DIR: "relative/catalog" }),
      ).rejects.toThrow(/DF_CATALOG_DIR must be an absolute path/);
      await expect(
        start({ DF_CATALOG_ASSET_DIR: "/somewhere/assets" }),
      ).rejects.toThrow(/DF_CATALOG_ASSET_DIR needs DF_CATALOG_DIR/);
    });
  },
);
