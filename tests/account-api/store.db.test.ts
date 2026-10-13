// @vitest-environment node
import { UserMeResponseSchema } from "@openfront/shared/ApiSchemas";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  runAdminCommand,
  type AdminIo,
} from "../../src/account-api/admin/commands";
import { loadCatalog } from "../../src/account-api/catalog/load";
import { ACCOUNT_RULES } from "../../src/account-api/domain/constants";
import {
  call,
  completeLogin,
  createMockProviders,
  newGuest,
  refresh,
  startHarness,
  type Harness,
} from "./util/harness";
import { describeDb } from "./util/testDb";

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const FREE = "pattern:delta_stripes:ash";
const catalog = loadCatalog({ publicOrigin: "http://localhost" });

// The plan's placeholder prices (docs/DeltaFrontAccountsPlan.md 9.3).
const PRICE = {
  "pattern:delta_stripes:ember": 300,
  "pattern:grid_check:ember": 500,
  "flag:delta_mark": 400,
  "flag:split_field": 400,
  "effect:red_wake": 600,
} as const;
type Flare = keyof typeof PRICE;
const BODY: Record<Flare, Record<string, string>> = {
  "pattern:delta_stripes:ember": {
    cosmeticType: "pattern",
    cosmeticName: "delta_stripes",
    colorPaletteName: "ember",
    currencyType: "soft",
  },
  "pattern:grid_check:ember": {
    cosmeticType: "pattern",
    cosmeticName: "grid_check",
    colorPaletteName: "ember",
    currencyType: "soft",
  },
  "flag:delta_mark": {
    cosmeticType: "flag",
    cosmeticName: "delta_mark",
    currencyType: "soft",
  },
  "flag:split_field": {
    cosmeticType: "flag",
    cosmeticName: "split_field",
    currencyType: "soft",
  },
  "effect:red_wake": {
    cosmeticType: "effect",
    cosmeticName: "red_wake",
    currencyType: "soft",
  },
};

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

interface Shopper {
  jwt: string;
  jar: Awaited<ReturnType<typeof newGuest>>["jar"];
  publicId: string;
  userId: string;
}

describeDb("POST /shop/purchase", () => {
  let h: Harness;
  let n = 0;
  const accounts: Record<
    string,
    { discord: { id: string; username: string; email: string; verified: true } }
  > = {};
  for (let i = 0; i < 300; i++) {
    accounts[`shopper${i}`] = {
      discord: {
        id: `shop-${i}`,
        username: `shopper${i}`,
        email: `s${i}@example.com`,
        verified: true,
      },
    };
  }
  const mock = createMockProviders(accounts);

  beforeAll(async () => {
    h = await startHarness({
      features: "accounts,inventory,store",
      fetchFn: mock.fetchFn,
      limits: {
        purchase: { max: 100_000, windowMs: 60_000 },
        guestCreation: { max: 100_000, windowMs: 60_000 },
        oauthStart: { max: 100_000, windowMs: 60_000 },
        refresh: { max: 100_000, windowMs: 60_000 },
      },
    });
  }, 60_000);
  afterAll(async () => h?.close());

  /** A signed-in (registered) account holding `credits` Credits, put there by the admin command. */
  async function shopper(credits: number): Promise<Shopper> {
    const login = await completeLogin(h, "discord", `shopper${n++}`);
    const jwt = (await (await refresh(h, login.jar)).json()).jwt as string;
    const me = await meOf(jwt);
    const userId = (
      await rows(h, "SELECT id FROM users WHERE public_id = $1", [
        me.player.publicId,
      ])
    )[0].id as string;
    if (credits > 0) {
      const r = await run(h, [
        "wallet:grant",
        me.player.publicId,
        String(credits),
        "--reason",
        "test",
      ]);
      expect(r.code, r.err).toBe(0);
    }
    return { jwt, jar: login.jar, publicId: me.player.publicId, userId };
  }
  const meOf = async (jwt: string) =>
    UserMeResponseSchema.parse(
      await (await call(h, "/users/@me", { bearer: jwt, origin: null })).json(),
    );
  const buy = (s: { jwt: string }, body: unknown) =>
    call(h, "/shop/purchase", {
      method: "POST",
      bearer: s.jwt,
      json: body,
      origin: null,
    });
  const credits = async (s: Shopper) =>
    Number(
      (
        await rows(h, "SELECT credits FROM wallets WHERE user_id = $1", [
          s.userId,
        ])
      )[0]?.credits ?? 0,
    );
  const owned = async (s: Shopper) =>
    (
      await rows(
        h,
        "SELECT flare FROM user_flares WHERE user_id = $1 AND revoked_at IS NULL ORDER BY flare",
        [s.userId],
      )
    ).map((r) => r.flare as string);
  const counts = async (s: Shopper) => ({
    purchases: (
      await rows(
        h,
        "SELECT count(*)::int n FROM purchases WHERE user_id = $1",
        [s.userId],
      )
    )[0].n as number,
    ledger: (
      await rows(
        h,
        "SELECT count(*)::int n FROM currency_ledger WHERE user_id = $1 AND reason = 'purchase'",
        [s.userId],
      )
    )[0].n as number,
    flares: (await owned(s)).length,
  });

  describe("a purchase", () => {
    it("debits the catalog price, grants the item and writes the purchase and its ledger row", async () => {
      const s = await shopper(1000);
      const res = await buy(s, BODY["pattern:grid_check:ember"]);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        currency: { soft: 500, hard: 0 },
        flares: ["pattern:grid_check:ember"],
      });
      expect(await credits(s)).toBe(500);
      expect(await owned(s)).toEqual(["pattern:grid_check:ember"]);
      const purchase = (
        await rows(h, "SELECT * FROM purchases WHERE user_id = $1", [s.userId])
      )[0];
      expect(purchase).toMatchObject({
        kind: "cosmetic",
        item_key: "pattern:grid_check:ember",
        flares: ["pattern:grid_check:ember"],
        catalog_version: catalog.version,
      });
      expect(Number(purchase.price_credits)).toBe(500);
      const ledger = (
        await rows(
          h,
          "SELECT * FROM currency_ledger WHERE user_id = $1 AND reason = 'purchase'",
          [s.userId],
        )
      )[0];
      expect(Number(ledger.delta)).toBe(-500);
      expect(Number(ledger.balance_after)).toBe(500);
      expect([
        ledger.ref_type,
        ledger.ref_id,
        ledger.currency,
        ledger.reward_day,
      ]).toEqual(["purchase", String(purchase.id), "credits", null]);
      const flare = (
        await rows(h, "SELECT * FROM user_flares WHERE user_id = $1", [
          s.userId,
        ])
      )[0];
      expect([
        flare.source,
        String(flare.purchase_id),
        flare.revoked_at,
      ]).toEqual(["purchase", String(purchase.id), null]);
    });

    it("shows in /users/@me at once: the new balance and the item", async () => {
      const s = await shopper(700);
      expect((await buy(s, BODY["flag:delta_mark"])).status).toBe(200);
      const me = await meOf(s.jwt);
      expect(me.player.currency).toEqual({ soft: 300, hard: 0 });
      expect(me.player.flares).toEqual(["flag:delta_mark", FREE]);
      // ...and after a new session.
      const next = (await (await refresh(h, s.jar)).json()).jwt as string;
      expect((await meOf(next)).player.flares).toContain("flag:delta_mark");
    });

    it.each(Object.entries(PRICE) as Array<[Flare, number]>)(
      "charges the plan's price for %s: %i Credits",
      async (flare, price) => {
        const s = await shopper(1000);
        expect((await buy(s, BODY[flare])).status).toBe(200);
        expect(await credits(s)).toBe(1000 - price);
        expect(await owned(s)).toEqual([flare]);
      },
    );

    it("can spend the last Credit: a balance exactly equal to the price", async () => {
      const s = await shopper(400);
      expect((await buy(s, BODY["flag:split_field"])).status).toBe(200);
      expect(await credits(s)).toBe(0);
    });

    it("keeps Credits earned from games apart from Credits spent: the reward ledger and cap are untouched", async () => {
      const s = await shopper(500);
      await buy(s, BODY["flag:delta_mark"]);
      const byReason = await rows(
        h,
        "SELECT reason, count(*)::int n FROM currency_ledger WHERE user_id = $1 GROUP BY reason ORDER BY reason",
        [s.userId],
      );
      expect(byReason).toEqual([
        { reason: "admin_grant", n: 1 },
        { reason: "purchase", n: 1 },
      ]);
      expect(
        (
          await rows(
            h,
            "SELECT count(*)::int n FROM currency_ledger WHERE user_id = $1 AND reason = 'game_reward'",
            [s.userId],
          )
        )[0].n,
      ).toBe(0);
    });

    it("buys a revoked item again (and charges again): the same row is restored", async () => {
      const s = await shopper(1000);
      await buy(s, BODY["flag:delta_mark"]);
      expect(
        (
          await run(h, [
            "item:revoke",
            s.publicId,
            "flag:delta_mark",
            "--yes",
            "--reason",
            "test",
          ])
        ).code,
      ).toBe(0);
      expect((await buy(s, BODY["flag:delta_mark"])).status).toBe(200);
      expect(await credits(s)).toBe(200);
      const stored = await rows(
        h,
        "SELECT source, revoked_at FROM user_flares WHERE user_id = $1 AND flare = 'flag:delta_mark'",
        [s.userId],
      );
      expect(stored).toEqual([{ source: "purchase", revoked_at: null }]);
    });
  });

  describe("refusals change nothing", () => {
    async function expectUntouched(
      s: Shopper,
      before: { credits: number; counts: Awaited<ReturnType<typeof counts>> },
    ) {
      expect(await credits(s)).toBe(before.credits);
      expect(await counts(s)).toEqual(before.counts);
    }
    async function snapshot(s: Shopper) {
      return { credits: await credits(s), counts: await counts(s) };
    }

    it("too few Credits: 400 Insufficient balance", async () => {
      const s = await shopper(499);
      const before = await snapshot(s);
      const res = await buy(s, BODY["pattern:grid_check:ember"]);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ reason: "Insufficient balance" });
      await expectUntouched(s, before);
    });

    it("no wallet activity at all: an account that never earned anything", async () => {
      const s = await shopper(0);
      const res = await buy(s, BODY["flag:delta_mark"]);
      expect(res.status).toBe(400);
      expect((await res.json()).reason).toBe("Insufficient balance");
    });

    it("already owned: 409, and not charged again", async () => {
      const s = await shopper(2000);
      expect((await buy(s, BODY["flag:delta_mark"])).status).toBe(200);
      const before = await snapshot(s);
      const again = await buy(s, BODY["flag:delta_mark"]);
      expect(again.status).toBe(409);
      expect(await again.json()).toEqual({ reason: "Already owned" });
      await expectUntouched(s, before);
    });

    it("owned through an admin grant: 409", async () => {
      const s = await shopper(2000);
      await run(h, ["item:grant", s.publicId, "effect:red_wake"]);
      const before = await snapshot(s);
      expect((await buy(s, BODY["effect:red_wake"])).status).toBe(409);
      await expectUntouched(s, before);
    });

    it("the free default pattern cannot be bought, even though its pattern has a price: 409", async () => {
      const s = await shopper(2000);
      const before = await snapshot(s);
      const res = await buy(s, {
        cosmeticType: "pattern",
        cosmeticName: "delta_stripes",
        colorPaletteName: "ash",
        currencyType: "soft",
      });
      expect(res.status).toBe(409);
      await expectUntouched(s, before);
    });

    it.each([
      [
        "an unknown pattern",
        {
          cosmeticType: "pattern",
          cosmeticName: "nope",
          colorPaletteName: "ember",
        },
      ],
      ["an unknown flag", { cosmeticType: "flag", cosmeticName: "nope" }],
      ["an unknown effect", { cosmeticType: "effect", cosmeticName: "nope" }],
      [
        "a palette the pattern does not have",
        {
          cosmeticType: "pattern",
          cosmeticName: "grid_check",
          colorPaletteName: "ash",
        },
      ],
      [
        "a palette that is not defined",
        {
          cosmeticType: "pattern",
          cosmeticName: "grid_check",
          colorPaletteName: "neon",
        },
      ],
      [
        "a pattern without its palette (the legacy flare is not sold)",
        { cosmeticType: "pattern", cosmeticName: "grid_check" },
      ],
      [
        "a palette on a flag",
        {
          cosmeticType: "flag",
          cosmeticName: "delta_mark",
          colorPaletteName: "ember",
        },
      ],
      [
        "a skin (the catalog has none)",
        { cosmeticType: "skin", cosmeticName: "delta_stripes" },
      ],
      [
        "a crown (the catalog has none)",
        { cosmeticType: "crown", cosmeticName: "gold" },
      ],
      [
        "a name that is an Object.prototype member",
        { cosmeticType: "flag", cosmeticName: "constructor" },
      ],
      [
        "a name that is __proto__",
        {
          cosmeticType: "pattern",
          cosmeticName: "__proto__",
          colorPaletteName: "ember",
        },
      ],
      [
        "a flag name used as an effect",
        { cosmeticType: "effect", cosmeticName: "delta_mark" },
      ],
    ])("%s: 400 Item not for sale", async (_what, body) => {
      const s = await shopper(5000);
      const before = await snapshot(s);
      const res = await buy(
        s,
        body.cosmeticName === "__proto__"
          ? JSON.parse(JSON.stringify({ ...body, currencyType: "soft" }))
          : { ...body, currencyType: "soft" },
      );
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ reason: "Item not for sale" });
      await expectUntouched(s, before);
    });

    it("an item the catalog sells for no price is not for sale", async () => {
      // The shipped catalog prices everything but the default; check the rule itself.
      const { findOffer } = await import("../../src/account-api/catalog/offer");
      const unpriced = {
        ...catalog,
        cosmetics: {
          ...catalog.cosmetics,
          flags: {
            free_one: {
              name: "free_one",
              url: "x.svg",
              product: null,
              rarity: "common",
            },
          },
        },
        validFlares: new Set([...catalog.validFlares, "flag:free_one"]),
      };
      expect(
        findOffer(unpriced as never, {
          cosmeticType: "flag",
          cosmeticName: "free_one",
        }),
      ).toBeNull();
    });

    it("the premium currency: 400 Currency not accepted, nothing charged", async () => {
      const s = await shopper(5000);
      const before = await snapshot(s);
      const res = await buy(s, {
        ...BODY["flag:delta_mark"],
        currencyType: "hard",
      });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ reason: "Currency not accepted" });
      await expectUntouched(s, before);
    });

    it.each([
      ["no body", undefined],
      ["an array", []],
      ["a string", "flag:delta_mark"],
      [
        "a missing currency",
        { cosmeticType: "flag", cosmeticName: "delta_mark" },
      ],
      [
        "an unknown currency",
        { ...BODY["flag:delta_mark"], currencyType: "credits" },
      ],
      [
        "an unknown kind",
        {
          cosmeticType: "bundle",
          cosmeticName: "starter",
          currencyType: "soft",
        },
      ],
      [
        "a name with a space",
        {
          cosmeticType: "flag",
          cosmeticName: "delta mark",
          currencyType: "soft",
        },
      ],
      [
        "an upper-case name",
        {
          cosmeticType: "flag",
          cosmeticName: "Delta_Mark",
          currencyType: "soft",
        },
      ],
      [
        "a name that is too long",
        {
          cosmeticType: "flag",
          cosmeticName: "a".repeat(33),
          currencyType: "soft",
        },
      ],
      [
        "a number as the name",
        { cosmeticType: "flag", cosmeticName: 5, currencyType: "soft" },
      ],
      [
        "an object as the name",
        {
          cosmeticType: "flag",
          cosmeticName: { $ne: "x" },
          currencyType: "soft",
        },
      ],
      [
        "an injection attempt",
        {
          cosmeticType: "flag",
          cosmeticName: "x'; DROP TABLE wallets; --",
          currencyType: "soft",
        },
      ],
    ])("%s: 400 Invalid request", async (_what, body) => {
      const s = await shopper(5000);
      const before = await snapshot(s);
      const res = await call(h, "/shop/purchase", {
        method: "POST",
        bearer: s.jwt,
        origin: null,
        ...(body === undefined ? {} : { json: body }),
      });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ reason: "Invalid request" });
      await expectUntouched(s, before);
      expect(await rows(h, "SELECT 1 FROM wallets LIMIT 1")).not.toHaveLength(
        0,
      );
    });

    it("a malformed or oversized JSON body is a 400, not a server error", async () => {
      const s = await shopper(5000);
      for (const raw of [
        "{ not json",
        JSON.stringify({ cosmeticType: "flag", pad: "x".repeat(5000) }),
      ]) {
        const res = await fetch(`${h.baseUrl}/shop/purchase`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${s.jwt}`,
            "Content-Type": "application/json",
          },
          body: raw,
        });
        expect(res.status).toBe(400);
      }
    });
  });

  describe("who may buy", () => {
    it("a guest cannot: 403 LOGIN_REQUIRED, and nothing is created", async () => {
      const g = await newGuest(h);
      await run(h, [
        "wallet:grant",
        (await meOf(g.jwt)).player.publicId,
        "1000",
        "--reason",
        "test",
      ]);
      const res = await buy(g, BODY["flag:delta_mark"]);
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ code: "LOGIN_REQUIRED" });
      expect(
        await rows(
          h,
          "SELECT 1 FROM purchases WHERE user_id = (SELECT id FROM users WHERE public_id = $1)",
          [(await meOf(g.jwt)).player.publicId],
        ),
      ).toHaveLength(0);
    });

    it("no token, a bad token and a revoked session are 401", async () => {
      expect(
        (
          await call(h, "/shop/purchase", {
            method: "POST",
            json: BODY["flag:delta_mark"],
            origin: null,
          })
        ).status,
      ).toBe(401);
      expect(
        (await buy({ jwt: "x.y.z" }, BODY["flag:delta_mark"])).status,
      ).toBe(401);
      const s = await shopper(1000);
      await call(h, "/auth/logout", { method: "POST", jar: s.jar });
      expect((await buy(s, BODY["flag:delta_mark"])).status).toBe(401);
      expect(await credits(s)).toBe(1000);
    });

    it("a banned account cannot: 403 BANNED", async () => {
      const s = await shopper(1000);
      await h.db.pool.query(
        "INSERT INTO bans (user_id, category, reason) VALUES ($1, 'test', 'x')",
        [s.userId],
      );
      const res = await buy(s, BODY["flag:delta_mark"]);
      // the ban ended the session (admin ban revokes), or the ban check answers
      expect([401, 403]).toContain(res.status);
      expect(await credits(s)).toBe(1000);
    });

    it("an account queued for deletion cannot", async () => {
      const s = await shopper(1000);
      await h.db.pool.query(
        "UPDATE users SET deleted_at = now() WHERE id = $1",
        [s.userId],
      );
      expect((await buy(s, BODY["flag:delta_mark"])).status).toBe(401);
      expect(await credits(s)).toBe(1000);
    });

    it("is limited per account (20 a minute by default)", async () => {
      const limited = await startHarness({
        features: "accounts,inventory,store",
        fetchFn: createMockProviders({
          lim: {
            discord: {
              id: "lim-1",
              username: "lim",
              email: "l@example.com",
              verified: true,
            },
          },
        }).fetchFn,
        limits: { purchase: { max: 3, windowMs: 60_000 } },
      });
      try {
        const login = await completeLogin(limited, "discord", "lim");
        const jwt = (await (await refresh(limited, login.jar)).json())
          .jwt as string;
        const statuses: number[] = [];
        for (let i = 0; i < 5; i++) {
          const r = await call(limited, "/shop/purchase", {
            method: "POST",
            bearer: jwt,
            json: BODY["flag:delta_mark"],
            origin: null,
          });
          statuses.push(r.status);
          if (r.status === 429)
            expect(r.headers.get("retry-after")).toMatch(/^\d+$/);
        }
        expect(statuses).toEqual([400, 400, 400, 429, 429]);
      } finally {
        await limited.close();
      }
    });
  });

  describe("the client cannot choose the price, the balance or the item", () => {
    it("ignores a forged price: the catalog's price is charged", async () => {
      const s = await shopper(1000);
      const res = await buy(s, {
        ...BODY["pattern:grid_check:ember"],
        price: 1,
        priceSoft: 1,
        priceHard: 0,
        cost: 1,
        amount: 1,
        discount: 100,
        flare: "flag:split_field",
        flares: ["pattern:*"],
        credits: 99999,
      });
      expect(res.status).toBe(200);
      expect(await credits(s)).toBe(500);
      expect(await owned(s)).toEqual(["pattern:grid_check:ember"]);
    });

    it("a negative or zero 'price' cannot raise the balance or buy for free", async () => {
      const s = await shopper(100);
      for (const price of [-500, 0, -1, 0.5, "free", null]) {
        const res = await buy(s, {
          ...BODY["flag:delta_mark"],
          price,
          priceSoft: price,
        });
        expect(res.status).toBe(400); // 400 Insufficient balance: 100 < 400
      }
      expect(await credits(s)).toBe(100);
      expect(await owned(s)).toEqual([]);
    });

    it("has no route to change a balance or grant an item at a player's request", async () => {
      const s = await shopper(100);
      const attempts: Array<[string, string, unknown]> = [
        ["PUT", "/users/@me", { currency: { soft: 99999, hard: 0 } }],
        ["POST", "/users/@me/currency", { soft: 99999 }],
        ["POST", "/users/@me/wallet", { credits: 99999 }],
        ["POST", "/shop/grant", { flare: "flag:delta_mark" }],
        ["POST", "/shop/refund", { purchaseId: 1 }],
        ["POST", "/rewards/claim-all", {}],
        ["POST", "/shop/purchase/pack", { packName: "starter" }],
        [
          "POST",
          "/payments/checkout",
          { kind: "currency_pack", packName: "p" },
        ],
        ["POST", "/stripe/create-custom-currency-checkout", { amount: 5 }],
        ["POST", "/subscriptions/@me/cancel", {}],
        ["POST", "/users/@me/tribe_names", { name: "x" }],
        ["POST", "/users/@me/lobby_queue", {}],
      ];
      for (const [method, route, json] of attempts) {
        const res = await call(h, route, {
          method,
          bearer: s.jwt,
          json,
          origin: null,
        });
        expect(
          [401, 403, 404, 405],
          `${method} ${route} -> ${res.status}`,
        ).toContain(res.status);
      }
      expect(await credits(s)).toBe(100);
      expect(await owned(s)).toEqual([]);
    });

    it("only domain/economy.ts writes wallets, the ledger and purchases (and ownership only through the inventory repository)", () => {
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
      const text = (f: string) => fs.readFileSync(path.join(ROOT, f), "utf8");
      const writers = (table: string) =>
        sources.filter((f) =>
          new RegExp(
            `(INSERT\\s+INTO|UPDATE|DELETE\\s+FROM)\\s+${table}\\b`,
            "i",
          ).test(text(f)),
        );
      expect(writers("currency_ledger")).toEqual([
        "src/account-api/domain/economy.ts",
      ]);
      expect(writers("purchases")).toEqual([
        "src/account-api/domain/economy.ts",
      ]);
      // users.ts only creates the empty wallet row of a new account
      expect(writers("wallets").sort()).toEqual([
        "src/account-api/domain/economy.ts",
        "src/account-api/repo/users.ts",
      ]);
      expect(text("src/account-api/repo/users.ts")).toMatch(
        /INSERT INTO wallets \(user_id\) VALUES \(\$1\)"/,
      );
      // ...and routes never touch these tables or the grant helpers themselves
      for (const f of sources.filter((x) =>
        x.startsWith("src/account-api/routes/"),
      )) {
        expect(text(f), f).not.toMatch(
          /(INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+(wallets|currency_ledger|purchases|user_flares)\b|\b(grantFlare|revokeFlare|adjustWallet)\b/i,
        );
      }
      expect(
        sources.filter((f) => /\bgrantFlare\b/.test(text(f))).sort(),
      ).toEqual([
        "src/account-api/admin/commands.ts",
        "src/account-api/domain/economy.ts",
        "src/account-api/repo/inventory.ts",
      ]);
    });
  });

  describe("concurrency", () => {
    it("the same item bought by ten simultaneous requests: bought once, charged once", async () => {
      const s = await shopper(1000);
      const results = await Promise.all(
        Array.from({ length: 10 }, () =>
          buy(s, BODY["pattern:grid_check:ember"]),
        ),
      );
      const statuses = results.map((r) => r.status).sort();
      expect(statuses).toEqual([
        200, 409, 409, 409, 409, 409, 409, 409, 409, 409,
      ]);
      expect(await credits(s)).toBe(500);
      expect(await counts(s)).toEqual({ purchases: 1, ledger: 1, flares: 1 });
      expect(
        await rows(h, "SELECT 1 FROM user_flares WHERE user_id = $1", [
          s.userId,
        ]),
      ).toHaveLength(1);
    });

    it("a double click from two tabs of the same account does not double-charge", async () => {
      const s = await shopper(800);
      const other = (await (await refresh(h, s.jar)).json()).jwt as string;
      const [a, b] = await Promise.all([
        buy(s, BODY["flag:delta_mark"]),
        buy({ jwt: other }, BODY["flag:delta_mark"]),
      ]);
      expect([a.status, b.status].sort()).toEqual([200, 409]);
      expect(await credits(s)).toBe(400);
    });

    it("different items at once with money for only some: the balance never goes below zero and equals what was bought", async () => {
      const s = await shopper(1000);
      const wanted = Object.keys(PRICE) as Flare[]; // 300+500+400+400+600 = 2200 > 1000
      const results = await Promise.all(wanted.map((f) => buy(s, BODY[f])));
      const bought = wanted.filter((_, i) => results[i].status === 200);
      const spent = bought.reduce((sum, f) => sum + PRICE[f], 0);
      expect(spent).toBeLessThanOrEqual(1000);
      expect(await credits(s)).toBe(1000 - spent);
      expect((await owned(s)).sort()).toEqual([...bought].sort());
      for (let i = 0; i < wanted.length; i++) {
        expect([200, 400]).toContain(results[i].status);
        if (results[i].status === 400)
          expect((await results[i].json()).reason).toBe("Insufficient balance");
      }
      expect((await counts(s)).purchases).toBe(bought.length);
      // the ledger tells the same story, row by row
      const ledger = await rows(
        h,
        "SELECT delta::int d, balance_after::int b FROM currency_ledger WHERE user_id = $1 AND reason = 'purchase' ORDER BY id",
        [s.userId],
      );
      let balance = 1000;
      for (const row of ledger) {
        balance += row.d;
        expect(row.b).toBe(balance);
        expect(row.b).toBeGreaterThanOrEqual(0);
      }
    });

    it("two different items racing for the last Credits: exactly one wins", async () => {
      const s = await shopper(400);
      const [a, b] = await Promise.all([
        buy(s, BODY["flag:delta_mark"]),
        buy(s, BODY["flag:split_field"]),
      ]);
      expect([a.status, b.status].sort()).toEqual([200, 400]);
      expect(await credits(s)).toBe(0);
      expect(await owned(s)).toHaveLength(1);
    });

    it("a storm: many repeats of five items against one wallet keeps every invariant", async () => {
      const s = await shopper(1500);
      const wanted = Object.keys(PRICE) as Flare[];
      const calls = Array.from(
        { length: 40 },
        (_, i) => wanted[i % wanted.length],
      );
      const results = await Promise.all(calls.map((f) => buy(s, BODY[f])));
      const ok = results
        .map((r, i) => (r.status === 200 ? calls[i] : null))
        .filter((f): f is Flare => f !== null);
      expect(new Set(ok).size).toBe(ok.length); // nothing bought twice
      const spent = ok.reduce((sum, f) => sum + PRICE[f], 0);
      expect(await credits(s)).toBe(1500 - spent);
      expect(1500 - spent).toBeGreaterThanOrEqual(0);
      expect(await counts(s)).toEqual({
        purchases: ok.length,
        ledger: ok.length,
        flares: ok.length,
      });
      for (const r of results) expect([200, 400, 409]).toContain(r.status);
    });

    it("a purchase racing an admin deduction cannot overdraw the wallet, and the two never deadlock", async () => {
      // Repeated: the first version of the admin command locked the user row
      // before the wallet and deadlocked with a purchase now and then.
      for (let round = 0; round < 60; round++) {
        const s = await shopper(500);
        const [p, d] = await Promise.all([
          buy(s, BODY["pattern:grid_check:ember"]),
          run(h, [
            "wallet:revoke",
            s.publicId,
            "300",
            "--reason",
            "race",
            "--yes",
          ]),
        ]);
        const final = await credits(s);
        expect(final).toBeGreaterThanOrEqual(0);
        // exactly one of: bought (500 -> 0, then the deduction is refused) or
        // deducted (500 -> 200, then the purchase is refused)
        if (p.status === 200) {
          expect(d.code, d.err).toBe(2);
          expect(final).toBe(0);
        } else {
          expect(p.status).toBe(400);
          expect(d.code, d.err).toBe(0);
          expect(final).toBe(200);
        }
      }
    }, 60_000);
  });

  describe("transaction safety: a failure part-way leaves nothing behind", () => {
    const TRIGGERS: Array<[string, string, string]> = [
      [
        "after the wallet was debited (the purchase row cannot be written)",
        "purchases",
        "BEFORE INSERT",
      ],
      [
        "after the purchase row (the ledger row cannot be written)",
        "currency_ledger",
        "BEFORE INSERT",
      ],
      [
        "after the item was granted (a last-step failure)",
        "user_flares",
        "AFTER INSERT",
      ],
    ];
    it.each(TRIGGERS)("%s", async (_name, table, when) => {
      const s = await shopper(1000);
      const before = { credits: await credits(s), counts: await counts(s) };
      await h.db.pool.query(
        `CREATE OR REPLACE FUNCTION fail_it() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'simulated failure'; END $$`,
      );
      await h.db.pool.query(
        `CREATE TRIGGER fail_${table} ${when} ON ${table} FOR EACH ROW WHEN (NEW.user_id = '${s.userId}') EXECUTE FUNCTION fail_it()`,
      );
      try {
        const res = await buy(s, BODY["pattern:grid_check:ember"]);
        expect(res.status).toBe(500);
        expect(await credits(s)).toBe(before.credits);
        expect(await counts(s)).toEqual(before.counts);
        expect(
          await rows(h, "SELECT 1 FROM user_flares WHERE user_id = $1", [
            s.userId,
          ]),
        ).toHaveLength(0);
        // the wallet row is not left locked either
        expect(
          (
            await buy(s, {
              cosmeticType: "flag",
              cosmeticName: "nope",
              currencyType: "soft",
            })
          ).status,
        ).toBe(400);
      } finally {
        await h.db.pool.query(`DROP TRIGGER fail_${table} ON ${table}`);
      }
      // the retry succeeds cleanly, exactly once
      const retry = await buy(s, BODY["pattern:grid_check:ember"]);
      expect(retry.status).toBe(200);
      expect(await credits(s)).toBe(500);
      expect(await counts(s)).toEqual({ purchases: 1, ledger: 1, flares: 1 });
      expect((await buy(s, BODY["pattern:grid_check:ember"])).status).toBe(409);
      expect(await credits(s)).toBe(500);
    });
  });
});

describeDb("the store is off without its feature", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await startHarness({ features: "accounts,inventory" });
  }, 60_000);
  afterAll(async () => h?.close());

  it("POST /shop/purchase does not exist with the inventory alone (the catalog still does)", async () => {
    const g = await newGuest(h);
    expect(
      (
        await call(h, "/shop/purchase", {
          method: "POST",
          bearer: g.jwt,
          json: {
            cosmeticType: "flag",
            cosmeticName: "delta_mark",
            currencyType: "soft",
          },
          origin: null,
        })
      ).status,
    ).toBe(404);
    expect((await call(h, "/cosmetics.json")).status).toBe(200);
  });
});

describeDb("the store needs sign-in", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await startHarness({ features: "store" });
  }, 60_000);
  afterAll(async () => h?.close());

  it("serves the catalog but no purchase route without accounts", async () => {
    expect((await call(h, "/cosmetics.json")).status).toBe(200);
    expect(
      (
        await call(h, "/shop/purchase", {
          method: "POST",
          json: {},
          origin: null,
        })
      ).status,
    ).toBe(404);
  });
});

describeDb("admin: wallet:show, wallet:grant, wallet:revoke", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await startHarness({
      features: "accounts,inventory,store",
      limits: { guestCreation: { max: 100_000, windowMs: 60_000 } },
    });
  }, 60_000);
  afterAll(async () => h?.close());

  async function account() {
    const g = await newGuest(h);
    const me = UserMeResponseSchema.parse(
      await (
        await call(h, "/users/@me", { bearer: g.jwt, origin: null })
      ).json(),
    );
    const userId = (
      await rows(h, "SELECT id FROM users WHERE public_id = $1", [
        me.player.publicId,
      ])
    )[0].id as string;
    return { ...g, publicId: me.player.publicId, userId };
  }
  const balance = async (id: string) =>
    Number(
      (await rows(h, "SELECT credits FROM wallets WHERE user_id = $1", [id]))[0]
        .credits,
    );

  it("grants Credits: balance, ledger row and audit record agree, and /users/@me shows it", async () => {
    const a = await account();
    const r = await run(h, [
      "wallet:grant",
      a.publicId,
      "250",
      "--reason",
      "support: apology",
    ]);
    expect(r.code, r.err).toBe(0);
    expect(r.out).toMatch(/granted 250 Credits to .*: 0 -> 250/);
    expect(await balance(a.userId)).toBe(250);
    const audit = (
      await rows(
        h,
        "SELECT * FROM admin_audit_log WHERE action = 'wallet:grant' AND target_id = $1",
        [a.publicId],
      )
    )[0];
    expect(audit.actor).toBe("tester");
    expect(audit.details).toMatchObject({
      amount: 250,
      reason: "support: apology",
      before: 0,
      after: 250,
    });
    const ledger = (
      await rows(h, "SELECT * FROM currency_ledger WHERE user_id = $1", [
        a.userId,
      ])
    )[0];
    expect([
      ledger.reason,
      Number(ledger.delta),
      Number(ledger.balance_after),
      ledger.ref_type,
      ledger.ref_id,
    ]).toEqual(["admin_grant", 250, 250, "admin", String(audit.id)]);
    expect(String(audit.details.ledgerId)).toBe(String(ledger.id));
    const me = UserMeResponseSchema.parse(
      await (
        await call(h, "/users/@me", { bearer: a.jwt, origin: null })
      ).json(),
    );
    expect(me.player.currency).toEqual({ soft: 250, hard: 0 });
  });

  it("deducts Credits with --yes, down to exactly zero", async () => {
    const a = await account();
    await run(h, ["wallet:grant", a.publicId, "300", "--reason", "setup"]);
    const r = await run(h, [
      "wallet:revoke",
      a.publicId,
      "100",
      "--reason",
      "chargeback",
      "--yes",
    ]);
    expect(r.code, r.err).toBe(0);
    expect(r.out).toMatch(/deducted 100 Credits from .*: 300 -> 200/);
    expect(
      (
        await run(h, [
          "wallet:revoke",
          a.publicId,
          "200",
          "--reason",
          "all of it",
          "--yes",
        ])
      ).code,
    ).toBe(0);
    expect(await balance(a.userId)).toBe(0);
    const reasons = await rows(
      h,
      "SELECT reason, delta::int d FROM currency_ledger WHERE user_id = $1 ORDER BY id",
      [a.userId],
    );
    expect(reasons).toEqual([
      { reason: "admin_grant", d: 300 },
      { reason: "admin_revoke", d: -100 },
      { reason: "admin_revoke", d: -200 },
    ]);
  });

  it("refuses to deduct more than the balance, and leaves no trace of the attempt", async () => {
    const a = await account();
    await run(h, ["wallet:grant", a.publicId, "100", "--reason", "setup"]);
    const before = {
      audit: (await rows(h, "SELECT count(*)::int n FROM admin_audit_log"))[0]
        .n,
      ledger: (
        await rows(
          h,
          "SELECT count(*)::int n FROM currency_ledger WHERE user_id = $1",
          [a.userId],
        )
      )[0].n,
    };
    const r = await run(h, [
      "wallet:revoke",
      a.publicId,
      "101",
      "--reason",
      "too much",
      "--yes",
    ]);
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/has only 100 Credits: cannot deduct 101/);
    expect(await balance(a.userId)).toBe(100);
    expect(
      (await rows(h, "SELECT count(*)::int n FROM admin_audit_log"))[0].n,
    ).toBe(before.audit);
    expect(
      (
        await rows(
          h,
          "SELECT count(*)::int n FROM currency_ledger WHERE user_id = $1",
          [a.userId],
        )
      )[0].n,
    ).toBe(before.ledger);
    // an account that never had a wallet row cannot go negative either
    const fresh = await account();
    await h.db.pool.query("DELETE FROM wallets WHERE user_id = $1", [
      fresh.userId,
    ]);
    expect(
      (
        await run(h, [
          "wallet:revoke",
          fresh.publicId,
          "1",
          "--reason",
          "x",
          "--yes",
        ])
      ).code,
    ).toBe(2);
  });

  it("refuses to pass the wallet maximum", async () => {
    const a = await account();
    await h.db.pool.query(
      "UPDATE wallets SET credits = $2 WHERE user_id = $1",
      [a.userId, ACCOUNT_RULES.maxWalletCredits - 5],
    );
    const r = await run(h, ["wallet:grant", a.publicId, "10", "--reason", "x"]);
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/wallet maximum/);
    expect(await balance(a.userId)).toBe(ACCOUNT_RULES.maxWalletCredits - 5);
  });

  it.each([
    ["zero", "0"],
    ["a negative number", "-5"],
    ["a fraction", "1.5"],
    ["words", "lots"],
    ["exponent notation", "1e3"],
    ["a leading plus", "+5"],
    ["leading zeros", "007"],
    [
      "more than the per-command limit",
      String(ACCOUNT_RULES.adminMaxCreditsPerCommand + 1),
    ],
    ["an absurdly long number", "9".repeat(40)],
  ])("rejects %s as an amount", async (_what, amount) => {
    const a = await account();
    for (const argv of [
      ["wallet:grant", a.publicId, amount, "--reason", "x"],
      ["wallet:revoke", a.publicId, amount, "--reason", "x", "--yes"],
    ]) {
      const r = await run(h, argv);
      expect(r.code, argv.join(" ")).toBe(2);
    }
    expect(
      await rows(h, "SELECT 1 FROM currency_ledger WHERE user_id = $1", [
        a.userId,
      ]),
    ).toHaveLength(0);
  });

  it("requires a reason, and --yes for a deduction", async () => {
    const a = await account();
    expect((await run(h, ["wallet:grant", a.publicId, "5"])).err).toMatch(
      /--reason/,
    );
    expect(
      (await run(h, ["wallet:grant", a.publicId, "5", "--reason", "   "])).err,
    ).toMatch(/--reason/);
    expect(
      (
        await run(h, [
          "wallet:grant",
          a.publicId,
          "5",
          "--reason",
          "x".repeat(201),
        ])
      ).err,
    ).toMatch(/at most 200/);
    await run(h, ["wallet:grant", a.publicId, "50", "--reason", "setup"]);
    const noYes = await run(h, [
      "wallet:revoke",
      a.publicId,
      "5",
      "--reason",
      "x",
    ]);
    expect(noYes.code).toBe(2);
    expect(noYes.err).toMatch(/--yes/);
    expect(await balance(a.userId)).toBe(50);
  });

  it("refuses an unknown or deleted account", async () => {
    expect(
      (await run(h, ["wallet:grant", "nobody00000", "5", "--reason", "x"])).err,
    ).toMatch(/no user with public id/);
    const a = await account();
    await h.db.pool.query("UPDATE users SET deleted_at = now() WHERE id = $1", [
      a.userId,
    ]);
    const r = await run(h, ["wallet:grant", a.publicId, "5", "--reason", "x"]);
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/deleted account/);
  });

  it("stores a hostile reason as plain data", async () => {
    const a = await account();
    const reason = "x'); DROP TABLE wallets; --";
    expect(
      (await run(h, ["wallet:grant", a.publicId, "5", "--reason", reason]))
        .code,
    ).toBe(0);
    const audit = (
      await rows(
        h,
        "SELECT details FROM admin_audit_log WHERE action = 'wallet:grant' AND target_id = $1",
        [a.publicId],
      )
    )[0];
    expect(audit.details.reason).toBe(reason);
    expect(await rows(h, "SELECT 1 FROM wallets LIMIT 1")).not.toHaveLength(0);
  });

  it("shows the balance and the ledger, newest first, purchases and rewards distinguishable", async () => {
    const a = await account();
    await run(h, ["wallet:grant", a.publicId, "700", "--reason", "setup"]);
    await h.db.pool.query(
      "INSERT INTO currency_ledger (user_id, delta, balance_after, reason, ref_type, ref_id, reward_day) VALUES ($1, 100, 800, 'game_reward', 'game', 'g1', current_date)",
      [a.userId],
    );
    await run(h, [
      "wallet:revoke",
      a.publicId,
      "50",
      "--reason",
      "fix",
      "--yes",
    ]);
    const r = await run(h, ["wallet:show", a.publicId]);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/credits of .*: 650/);
    const lines = r.out
      .split("\n")
      .filter((l) => /admin_|game_reward|purchase/.test(l));
    expect(lines[0]).toMatch(/admin_revoke/);
    expect(lines[1]).toMatch(/game_reward/);
    expect(lines[2]).toMatch(/admin_grant/);
    expect(
      (await run(h, ["wallet:show", (await account()).publicId])).out,
    ).toMatch(/: 0\n[\s\S]*\(none\)/);
  });

  it("is audited even for several commands in a row, with the operator recorded", async () => {
    const a = await account();
    await run(h, ["wallet:grant", a.publicId, "10", "--reason", "one"]);
    await run(h, ["wallet:grant", a.publicId, "20", "--reason", "two"]);
    await run(h, [
      "wallet:revoke",
      a.publicId,
      "5",
      "--reason",
      "three",
      "--yes",
    ]);
    const log = await rows(
      h,
      "SELECT actor, action, details FROM admin_audit_log WHERE target_id = $1 ORDER BY id",
      [a.publicId],
    );
    expect(
      log.map((l) => [l.actor, l.action, l.details.amount, l.details.after]),
    ).toEqual([
      ["tester", "wallet:grant", 10, 10],
      ["tester", "wallet:grant", 20, 30],
      ["tester", "wallet:revoke", 5, 25],
    ]);
  });
});
