// @vitest-environment node
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { afterEach, expect, it } from "vitest";
import { loadCatalog } from "../../src/account-api/catalog/load";
import { drawFromVault } from "../../src/account-api/domain/vault";
import type { Rng } from "../../src/account-api/domain/vaultDraw";
import { makeUser, userMe, type TestUser } from "./util/games";
import { call, startHarness, type Harness } from "./util/harness";
import { describeDb } from "./util/testDb";
import { catalogWithVault, vaultConfig } from "./util/vaultCatalog";

// The Vault: the wheel, the free daily spin and the packs. A draw is one locked
// transaction; these tests hold it to the rules that matter: it charges exactly
// what it says, never twice for one request, pays duplicates back in Credits,
// and the wallet always equals the ledger.

const FEATURES = "accounts,store,inventory";
const ORIGIN = "http://localhost:8787";

const harnesses: Harness[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.close();
  for (const d of dirs.splice(0))
    fs.rmSync(d, { recursive: true, force: true });
});

async function start(vault?: unknown) {
  const dir = catalogWithVault(dirs, vault);
  const h = await startHarness({ features: FEATURES, catalogDir: dir });
  harnesses.push(h);
  return { h, catalog: loadCatalog({ publicOrigin: ORIGIN, dir }) };
}

const q = async (h: Harness, sql: string, params: unknown[] = []) =>
  (await h.db.pool.query(sql, params)).rows;

async function credits(h: Harness, u: TestUser, amount: number) {
  await q(
    h,
    `INSERT INTO wallets (user_id, credits) VALUES ($1, $2)
     ON CONFLICT (user_id) DO UPDATE SET credits = $2`,
    [u.id, amount],
  );
}
const balanceOf = async (h: Harness, u: TestUser) =>
  Number(
    (await q(h, "SELECT credits FROM wallets WHERE user_id = $1", [u.id]))[0]
      .credits,
  );
const ledgerSum = async (h: Harness, u: TestUser) =>
  Number(
    (
      await q(
        h,
        "SELECT COALESCE(SUM(delta), 0) AS s FROM currency_ledger WHERE user_id = $1",
        [u.id],
      )
    )[0].s,
  );

const post = (
  h: Harness,
  u: TestUser | null,
  path: string,
  body: unknown = { requestId: randomUUID() },
) =>
  call(h, path, { method: "POST", bearer: u?.jwt, json: body, origin: null });

/** Random numbers that return the scripted values in turn, then zeros. */
const script =
  (...values: number[]): Rng =>
  (max) =>
    Math.min(max - 1, values.shift() ?? 0);

describeDb("the Vault: reading it", () => {
  it("shows anyone the odds, and a signed-in account its own counters", async () => {
    const { h } = await start();
    const anon = await call(h, "/vault", { origin: null });
    const open = await anon.json();
    expect(anon.status).toBe(200);
    expect(open.state).toBeNull();
    expect(open.wheel.spinPrice).toBe(150);
    const percents = open.wheel.segments.map(
      (s: { percent: number }) => s.percent,
    );
    expect(percents.reduce((a: number, b: number) => a + b, 0)).toBeCloseTo(
      100,
      1,
    );
    const recruit = open.packs.find(
      (p: { name: string }) => p.name === "recruit",
    );
    expect(recruit.slots).toHaveLength(3);
    for (const slot of recruit.slots) {
      expect(
        Object.values(slot as Record<string, number>).reduce(
          (a, b) => a + b,
          0,
        ),
      ).toBeCloseTo(100, 1);
    }
    expect(recruit.items.length).toBe(10);

    const u = await makeUser(h);
    await credits(h, u, 700);
    const mine = await (
      await call(h, "/vault", { bearer: u.jwt, origin: null })
    ).json();
    expect(mine.state.balance).toBe(700);
    expect(mine.state.daily.available).toBe(true);
    expect(new Date(mine.state.daily.nextAt).getTime()).toBeGreaterThan(
      Date.now(),
    );
    // a guest has no account to keep anything in: no state
    const guest = await makeUser(h, "guest");
    expect(
      (
        await (
          await call(h, "/vault", { bearer: guest.jwt, origin: null })
        ).json()
      ).state,
    ).toBeNull();
  });

  it("is a 404 when the catalog has no Vault", async () => {
    const h = await startHarness({ features: FEATURES });
    harnesses.push(h);
    expect((await call(h, "/vault", { origin: null })).status).toBe(404);
  });
});

describeDb("the Vault: who may draw", () => {
  it("needs a registered, signed-in account", async () => {
    const { h } = await start();
    expect((await post(h, null, "/vault/spin")).status).toBe(401);
    const guest = await makeUser(h, "guest");
    await credits(h, guest, 1000);
    const res = await post(h, guest, "/vault/spin");
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("LOGIN_REQUIRED");
    expect(await balanceOf(h, guest)).toBe(1000);
  });

  it("refuses a bad request body and an unknown pack, changing nothing", async () => {
    const { h } = await start();
    const u = await makeUser(h);
    await credits(h, u, 1000);
    expect(
      (await post(h, u, "/vault/spin", { requestId: "nope" })).status,
    ).toBe(400);
    expect((await post(h, u, "/vault/spin", {})).status).toBe(400);
    expect((await post(h, u, "/vault/packs/nothing/open")).status).toBe(404);
    expect((await post(h, u, "/vault/packs/BAD NAME/open")).status).toBe(404);
    expect(await balanceOf(h, u)).toBe(1000);
    expect(await q(h, "SELECT 1 FROM vault_draws")).toEqual([]);
  });
});

describeDb("the Vault: packs", () => {
  it("charges the price, grants the cards and writes the draw and the ledger", async () => {
    const { h } = await start();
    const u = await makeUser(h);
    await credits(h, u, 1000);
    const res = await post(h, u, "/vault/packs/recruit/open");
    expect(res.status).toBe(200);
    const { result, balance } = await res.json();
    expect(result.cards).toHaveLength(3);
    const refunds = result.cards.reduce(
      (s: number, c: { credits: number }) => s + c.credits,
      0,
    );
    expect(balance).toBe(1000 - 100 + refunds);
    expect(await balanceOf(h, u)).toBe(balance);
    // every card that was not a duplicate is owned now, and stored as won from the Vault
    const owned = await q(
      h,
      "SELECT flare, source FROM user_flares WHERE user_id = $1",
      [u.id],
    );
    for (const card of result.cards.filter((c: { dupe: boolean }) => !c.dupe)) {
      expect(owned).toContainEqual({
        flare: `crown:${card.name}`,
        source: "vault",
      });
    }
    const draws = await q(
      h,
      "SELECT kind, item_key, cost FROM vault_draws WHERE user_id = $1",
      [u.id],
    );
    expect(draws).toEqual([{ kind: "pack", item_key: "recruit", cost: "100" }]);
    // the wallet is exactly what the ledger adds up to
    expect(await ledgerSum(h, u)).toBe(balance - 1000);
    expect(
      (await userMe(h, u)).body.player.flares.filter((f: string) =>
        f.startsWith("crown:vc_"),
      ).length,
    ).toBe(result.cards.filter((c: { dupe: boolean }) => !c.dupe).length);
  });

  it("answers 'insufficient' without touching anything", async () => {
    const { h } = await start();
    const u = await makeUser(h);
    await credits(h, u, 99);
    const res = await post(h, u, "/vault/packs/recruit/open");
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      reason: "Insufficient balance",
      balance: 99,
    });
    expect(await balanceOf(h, u)).toBe(99);
    expect(await q(h, "SELECT 1 FROM vault_draws")).toEqual([]);
    expect(
      await q(h, "SELECT 1 FROM user_flares WHERE source = 'vault'"),
    ).toEqual([]);
  });

  it("never charges twice for one request id", async () => {
    const { h } = await start();
    const u = await makeUser(h);
    await credits(h, u, 1000);
    const requestId = randomUUID();
    const first = await (
      await post(h, u, "/vault/packs/recruit/open", { requestId })
    ).json();
    const second = await (
      await post(h, u, "/vault/packs/recruit/open", { requestId })
    ).json();
    expect(second.replay).toBe(true);
    expect(second.result).toEqual(first.result);
    expect(second.balance).toBe(first.balance);
    expect(await q(h, "SELECT 1 FROM vault_draws")).toHaveLength(1);
    expect(await balanceOf(h, u)).toBe(first.balance);
  });

  it("two clicks at once cost one pack each, never more than the balance allows", async () => {
    const { h } = await start();
    const u = await makeUser(h);
    await credits(h, u, 150);
    const [a, b] = await Promise.all([
      post(h, u, "/vault/packs/recruit/open"),
      post(h, u, "/vault/packs/recruit/open"),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 400]);
    expect(await q(h, "SELECT 1 FROM vault_draws")).toHaveLength(1);
  });

  it("pays a duplicate back in Credits instead of giving it again", async () => {
    const { h, catalog } = await start();
    const u = await makeUser(h);
    await credits(h, u, 5000);
    // every roll of 0 draws the first common crown: three of the same card
    const out = await drawFromVault(
      h.db.pool,
      u.id,
      { kind: "pack", pack: "recruit" },
      randomUUID(),
      {
        vault: catalog.vault!,
        defaultFlares: catalog.defaultFlares,
        rng: script(),
      },
    );
    expect(out.kind).toBe("ok");
    if (out.kind !== "ok" || !("cards" in out.result))
      throw new Error("not a pack");
    expect(out.result.cards.map((c) => c.dupe)).toEqual([false, true, true]);
    expect(out.result.cards.map((c) => c.credits)).toEqual([0, 10, 10]);
    expect(out.balance).toBe(5000 - 100 + 20);
    expect(
      await q(h, "SELECT 1 FROM user_flares WHERE source = 'vault'"),
    ).toHaveLength(1);
    // a second pack: all three already owned
    const again = await drawFromVault(
      h.db.pool,
      u.id,
      { kind: "pack", pack: "recruit" },
      randomUUID(),
      {
        vault: catalog.vault!,
        defaultFlares: catalog.defaultFlares,
        rng: script(),
      },
    );
    if (again.kind !== "ok" || !("cards" in again.result))
      throw new Error("not a pack");
    expect(again.result.cards.every((c) => c.dupe)).toBe(true);
  });

  it("guarantees a rare after enough packs without one, and remembers its counters", async () => {
    const { h, catalog } = await start();
    const u = await makeUser(h);
    await credits(h, u, 100_000);
    const open = () =>
      drawFromVault(
        h.db.pool,
        u.id,
        { kind: "pack", pack: "recruit" },
        randomUUID(),
        {
          vault: catalog.vault!,
          defaultFlares: catalog.defaultFlares,
          rng: script(), // always the lowest roll: commons
        },
      );
    for (let i = 0; i < 3; i++) await open();
    expect(await q(h, "SELECT since_rare, since_epic FROM vault_pity")).toEqual(
      [{ since_rare: 3, since_epic: 3 }],
    );
    // the 4th pack (rareAfter: 4) has a rare as its last card whatever the roll
    const fourth = await open();
    if (fourth.kind !== "ok" || !("cards" in fourth.result))
      throw new Error("not a pack");
    expect(fourth.result.cards.map((c) => c.rarity)).toEqual([
      "common",
      "common",
      "rare",
    ]);
    expect(await q(h, "SELECT since_rare, since_epic FROM vault_pity")).toEqual(
      [{ since_rare: 0, since_epic: 4 }],
    );
  });

  it("stops at the day's limit and counts only today", async () => {
    const { h } = await start(
      vaultConfig({ limits: { paidSpinsPerDay: 20, packsPerDay: 2 } }),
    );
    const u = await makeUser(h);
    await credits(h, u, 10_000);
    expect((await post(h, u, "/vault/packs/recruit/open")).status).toBe(200);
    expect((await post(h, u, "/vault/packs/recruit/open")).status).toBe(200);
    const res = await post(h, u, "/vault/packs/recruit/open");
    expect(res.status).toBe(429);
    expect((await res.json()).code).toBe("DAILY_LIMIT");
    expect(await q(h, "SELECT 1 FROM vault_draws")).toHaveLength(2);
    // yesterday's packs do not count
    await q(h, "UPDATE vault_draws SET day = day - 1");
    expect((await post(h, u, "/vault/packs/recruit/open")).status).toBe(200);
  });

  it("keeps a pack out of season closed", async () => {
    const base = vaultConfig();
    const future = {
      ...(base.packs.recruit as object),
      startsAt: new Date(Date.now() + 86_400_000).toISOString(),
    };
    const { h } = await start({
      ...base,
      packs: { ...base.packs, recruit: future },
    });
    const u = await makeUser(h);
    await credits(h, u, 1000);
    expect((await post(h, u, "/vault/packs/recruit/open")).status).toBe(404);
    expect(await balanceOf(h, u)).toBe(1000);
  });
});

describeDb("the Vault: the wheel", () => {
  it("charges the spin price and pays the prize, the wallet matching the ledger", async () => {
    const { h } = await start();
    const u = await makeUser(h);
    await credits(h, u, 3000);
    let spent = 0;
    for (let i = 0; i < 12; i++) {
      const res = await post(h, u, "/vault/spin");
      expect(res.status).toBe(200);
      const { result } = await res.json();
      expect(result.cost).toBe(150);
      expect(result.daily).toBe(false);
      spent += 150;
      expect(result.segment).toBeGreaterThanOrEqual(0);
      expect(result.segment).toBeLessThan(6);
    }
    expect(
      await q(h, "SELECT 1 FROM vault_draws WHERE kind = 'spin'"),
    ).toHaveLength(12);
    expect(await ledgerSum(h, u)).toBe((await balanceOf(h, u)) - 3000);
    expect(await ledgerSum(h, u)).toBeGreaterThanOrEqual(-spent);
    // every ledger row of a draw points at the draw it came from
    const rows = await q(
      h,
      "SELECT reason, ref_type FROM currency_ledger WHERE user_id = $1",
      [u.id],
    );
    for (const row of rows) {
      expect(["vault_spend", "vault_payout"]).toContain(row.reason);
      expect(row.ref_type).toBe("vault_draw");
    }
  });

  it("lands on each kind of prize and pays it", async () => {
    const { h, catalog } = await start();
    const u = await makeUser(h);
    await credits(h, u, 10_000);
    const spin = (roll: number, requestId = randomUUID()) =>
      drawFromVault(h.db.pool, u.id, { kind: "spin" }, requestId, {
        vault: catalog.vault!,
        defaultFlares: catalog.defaultFlares,
        // the first roll chooses the segment, the rest the items
        rng: script(roll),
      });
    // weights 40, 25, 5, 10, 3, 7 (total 90): 0 -> c50, 40 -> c100, 65 -> c500, 70 -> rare, 80 -> epic, 83 -> pack
    const credits50 = await spin(0);
    if (credits50.kind !== "ok" || !("segmentId" in credits50.result))
      throw new Error("no spin");
    expect(credits50.result.segmentId).toBe("c50");
    expect(credits50.result.creditsWon).toBe(50);
    expect(credits50.balance).toBe(10_000 - 150 + 50);

    const rare = await spin(70);
    if (rare.kind !== "ok" || !("segmentId" in rare.result))
      throw new Error("no spin");
    expect(rare.result.segmentId).toBe("rare");
    expect(rare.result.card?.rarity).toBe("rare");
    expect(rare.result.card?.dupe).toBe(false);

    const pack = await spin(83);
    if (pack.kind !== "ok" || !("segmentId" in pack.result))
      throw new Error("no spin");
    expect(pack.result.segmentId).toBe("pack");
    expect(pack.result.pack?.pack).toBe("recruit");
    expect(pack.result.pack?.cards).toHaveLength(3);
  });

  it("answers insufficient for the paid spin and charges nothing", async () => {
    const { h } = await start();
    const u = await makeUser(h);
    await credits(h, u, 149);
    expect((await post(h, u, "/vault/spin")).status).toBe(400);
    expect(await balanceOf(h, u)).toBe(149);
  });
});

describeDb("the Vault: the daily spin", () => {
  it("is free, once per UTC day, and comes back at midnight", async () => {
    const { h } = await start();
    const u = await makeUser(h);
    const first = await post(h, u, "/vault/daily");
    expect(first.status).toBe(200);
    const { result, balance } = await first.json();
    expect(result.daily).toBe(true);
    expect(result.cost).toBe(0);
    expect(balance).toBe(result.creditsWon);

    const second = await post(h, u, "/vault/daily");
    expect(second.status).toBe(409);
    const body = await second.json();
    expect(body.code).toBe("DAILY_USED");
    expect(new Date(body.nextAt).getUTCHours()).toBe(0);
    expect(new Date(body.nextAt).getTime()).toBeGreaterThan(Date.now());

    const state = await (
      await call(h, "/vault", { bearer: u.jwt, origin: null })
    ).json();
    expect(state.state.daily.available).toBe(false);
    expect(state.state.daily.nextAt).toBe(body.nextAt);

    // the next UTC day: yesterday's spin no longer counts
    await q(h, "UPDATE vault_draws SET day = day - 1");
    expect((await post(h, u, "/vault/daily")).status).toBe(200);
  });

  it("does not use up the paid spins, and is refused to a guest", async () => {
    const { h } = await start();
    const u = await makeUser(h);
    await credits(h, u, 500);
    expect((await post(h, u, "/vault/daily")).status).toBe(200);
    expect((await post(h, u, "/vault/spin")).status).toBe(200);
    const guest = await makeUser(h, "guest");
    expect((await post(h, guest, "/vault/daily")).status).toBe(403);
  });

  it("two clicks at once give one daily spin", async () => {
    const { h } = await start();
    const u = await makeUser(h);
    const [a, b] = await Promise.all([
      post(h, u, "/vault/daily"),
      post(h, u, "/vault/daily"),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect(
      await q(h, "SELECT 1 FROM vault_draws WHERE kind = 'daily'"),
    ).toHaveLength(1);
  });
});
