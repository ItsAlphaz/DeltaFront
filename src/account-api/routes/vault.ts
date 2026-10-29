import {
  VAULT_RARITIES,
  percentOf,
  type VaultRarity,
} from "@openfront/shared/VaultSchemas";
import express, { type Request, type Response, type Router } from "express";
import { z } from "zod";
import type { Catalog } from "../catalog/load";
import { drawFromVault, packInSeason, vaultStateOf } from "../domain/vault";
import type { ItemsByRarity } from "../domain/vaultDraw";
import { activeBan, getUser } from "../repo/users";
import { authenticate, jsonBody, type AppDeps } from "./common";

/**
 * The Vault (docs/Vault.md): a spin wheel and packs paid for with Credits.
 *
 *   GET  /vault                          the odds and prices, and for a signed-in
 *                                        account its counters and its daily spin
 *   POST /vault/spin         { requestId }   spin the wheel for Credits
 *   POST /vault/daily        { requestId }   the free daily spin
 *   POST /vault/packs/:pack/open { requestId }   open a pack for Credits
 *
 * The three POSTs need a registered, unbanned account and answer
 *   200 { result, balance, replay }
 *   400 { reason: "Insufficient balance", balance }   nothing charged
 *   404 { reason: "Pack not found" }                   unknown or out of season
 *   409 { code: "DAILY_USED", nextAt }                 the free spin is taken today
 *   429 { code: "DAILY_LIMIT" }                        the day's most is reached
 *
 * Nothing in a request is a price, a card or a chance. A request id that was
 * seen before answers with the same result and charges nothing, so a double
 * click or a retry cannot cost twice.
 */

const Body = z.object({ requestId: z.string().uuid() });
const PACK = /^[a-z0-9_]{1,32}$/;

export function vaultRouter(deps: AppDeps & { catalog: Catalog }): Router {
  const { pool, limiters, catalog } = deps;
  const router = express.Router();
  const vault = catalog.vault;

  /** The signed-in, registered, unbanned account behind a POST, or null (the response is sent). */
  async function account(req: Request, res: Response) {
    res.setHeader("Cache-Control", "no-store");
    const claims = await authenticate(req, deps);
    const user = claims === null ? null : await getUser(pool, claims.userId);
    if (user === null || user.deletedAt !== null) {
      res.status(401).json({ error: "unauthorized" });
      return null;
    }
    const verdict = limiters.vaultWrite.hit(user.id);
    if (!verdict.allowed) {
      res.setHeader("Retry-After", String(verdict.retryAfterSeconds));
      res.status(429).json({ error: "rate_limited" });
      return null;
    }
    if (user.kind === "guest") {
      res.status(403).json({ code: "LOGIN_REQUIRED" });
      return null;
    }
    if ((await activeBan(pool, user.id)) !== null) {
      res.status(403).json({ code: "BANNED" });
      return null;
    }
    return user;
  }

  const itemsOf = (items: ItemsByRarity) =>
    VAULT_RARITIES.flatMap((rarity) =>
      items[rarity].map((item) => ({
        type: item.ref.type,
        name: item.ref.name,
        ...(item.ref.colorPalette === undefined
          ? {}
          : { colorPalette: item.ref.colorPalette }),
        rarity,
      })),
    );

  router.get("/vault", async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    if (vault === null) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const now = new Date();
    const wheel = vault.source.wheel;
    const wheelTotal = wheel.segments.reduce((sum, s) => sum + s.weight, 0);
    const packs = [...vault.packs.values()].map(({ source, items }) => ({
      name: source.name,
      displayName: source.displayName,
      ...(source.tagline === undefined ? {} : { tagline: source.tagline }),
      priceSoft: source.priceSoft,
      rarity: source.rarity,
      inSeason: packInSeason(source, now),
      ...(source.startsAt === undefined ? {} : { startsAt: source.startsAt }),
      ...(source.endsAt === undefined ? {} : { endsAt: source.endsAt }),
      pity: source.pity,
      // per card: the chance of each rarity, as a percentage
      slots: source.slots.map((weights) => {
        const total = VAULT_RARITIES.reduce(
          (sum, r) => sum + (items[r].length > 0 ? (weights[r] ?? 0) : 0),
          0,
        );
        return Object.fromEntries(
          VAULT_RARITIES.filter(
            (r) => items[r].length > 0 && (weights[r] ?? 0) > 0,
          ).map((r) => [r, percentOf(weights[r] ?? 0, total)]),
        ) as Partial<Record<VaultRarity, number>>;
      }),
      items: itemsOf(items),
    }));

    let state = null;
    const claims = await authenticate(req, deps);
    const user = claims === null ? null : await getUser(pool, claims.userId);
    if (user !== null && user.deletedAt === null && user.kind !== "guest") {
      state = await vaultStateOf(pool, user.id, now);
    }
    res.json({
      wheel: {
        spinPrice: wheel.spinPrice,
        segments: wheel.segments.map((s) => ({
          id: s.id,
          label: s.label,
          prize: s.prize,
          percent: percentOf(s.weight, wheelTotal),
        })),
        items: itemsOf(vault.wheelItems),
      },
      packs,
      dupeCredits: vault.source.dupeCredits,
      limits: vault.source.limits,
      state,
    });
  });

  async function run(
    req: Request,
    res: Response,
    request: Parameters<typeof drawFromVault>[2],
  ) {
    const user = await account(req, res);
    if (user === null) return;
    if (vault === null) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const body = Body.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ reason: "Invalid request" });
      return;
    }
    const outcome = await drawFromVault(
      pool,
      user.id,
      request,
      body.data.requestId,
      { vault, defaultFlares: catalog.defaultFlares },
    );
    switch (outcome.kind) {
      case "ok":
        res.json({
          result: outcome.result,
          balance: outcome.balance,
          replay: outcome.replay,
        });
        return;
      case "insufficient":
        res
          .status(400)
          .json({ reason: "Insufficient balance", balance: outcome.balance });
        return;
      case "not_found":
        res.status(404).json({ reason: "Pack not found" });
        return;
      case "limit":
        res.status(429).json({ code: "DAILY_LIMIT" });
        return;
      case "daily_used":
        res
          .status(409)
          .json({ code: "DAILY_USED", nextAt: outcome.nextAt.toISOString() });
        return;
    }
  }

  router.post("/vault/spin", jsonBody("1kb"), (req, res) =>
    run(req, res, { kind: "spin" }),
  );
  router.post("/vault/daily", jsonBody("1kb"), (req, res) =>
    run(req, res, { kind: "daily" }),
  );
  router.post("/vault/packs/:pack/open", jsonBody("1kb"), (req, res) => {
    const pack = String(req.params.pack);
    if (!PACK.test(pack)) {
      res.status(404).json({ reason: "Pack not found" });
      return;
    }
    return run(req, res, { kind: "pack", pack });
  });

  return router;
}
