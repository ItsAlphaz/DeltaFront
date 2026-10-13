import express, { type Router } from "express";
import { z } from "zod";
import { ASSET_ROUTE, type Catalog } from "../catalog/load";
import { findOffer } from "../catalog/offer";
import { purchaseOffer } from "../domain/economy";
import { activeBan, getUser } from "../repo/users";
import { authenticate, jsonBody, type AppDeps } from "./common";

/**
 * The cosmetic catalog and its assets (docs/DeltaFrontAccountsPlan.md section
 * 9.3). Both are public, read-only and held in memory from startup, so a
 * request never touches the disk or the database, and the asset route can only
 * ever return a file the catalog was validated with (a lookup in a map, never
 * a path built from the request).
 *
 * Purchases are `shopRouter` below (milestone M5).
 */
export function storeRouter(catalog: Catalog): Router {
  const router = express.Router();

  router.get("/cosmetics.json", (req, res) => {
    res.setHeader("Cache-Control", "public, max-age=300");
    res.setHeader("ETag", catalog.etag);
    if (req.headers["if-none-match"] === catalog.etag) {
      res.status(304).end();
      return;
    }
    res.type("application/json").send(catalog.body);
  });

  router.get(`${ASSET_ROUTE}/:file`, (req, res) => {
    const asset = catalog.assets.get(String(req.params.file));
    if (asset === undefined) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    // The URL the catalog hands out carries ?v=<content hash>, so a changed
    // file has a new URL and the old one can be cached for good.
    res.setHeader(
      "Cache-Control",
      req.query.v === asset.version
        ? "public, max-age=31536000, immutable"
        : "public, max-age=300",
    );
    // Public artwork: any page may use it (the renderer needs CORS to read
    // pixels), but an SVG must never run script of its own.
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.removeHeader("Access-Control-Allow-Credentials");
    res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'none'; style-src 'unsafe-inline'; sandbox",
    );
    res.type(asset.contentType).send(asset.bytes);
  });

  return router;
}

const NAME = /^[a-z0-9_]{1,32}$/;

/**
 * What the client sends (the existing contract, `Api.purchaseWithCurrency`):
 * the kind, name and palette of the item and the currency it believes it is
 * paying in. There is no price, no balance and no flare in it, and any such
 * field a client adds is ignored: only these five are read.
 */
const PurchaseBody = z.object({
  cosmeticType: z.enum(["pattern", "skin", "flag", "crown", "effect"]),
  cosmeticName: z.string().regex(NAME),
  currencyType: z.enum(["soft", "hard"]),
  colorPaletteName: z.string().regex(NAME).optional(),
});

/**
 * `POST /shop/purchase`: spend Credits on a catalog item (plan section 9.4).
 *
 * Only a registered, unbanned account may buy (a guest has no identity to keep
 * what it buys; 403 `LOGIN_REQUIRED`). The price and the flare come from the
 * server's own catalog; the wallet is debited, the purchase and ledger rows are
 * written and the item is granted in one locked transaction (domain/economy).
 *
 *   200 { currency, flares }         bought
 *   400 { reason: "Insufficient balance" }   too few Credits, nothing charged
 *   400 { reason: "Currency not accepted" }  anything but Credits ("soft")
 *   400 { reason: "Item not for sale" }      unknown, unpriced or invalid palette
 *   409 { reason: "Already owned" }          held already, or a free default
 *
 * The premium currency, bundles (`/shop/purchase/pack`), subscriptions and
 * checkout do not exist in V1: those paths are not routed (404).
 */
export function shopRouter(deps: AppDeps & { catalog: Catalog }): Router {
  const { pool, limiters, catalog } = deps;
  const router = express.Router();

  router.post("/shop/purchase", jsonBody("2kb"), async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    const claims = await authenticate(req, deps);
    const user = claims === null ? null : await getUser(pool, claims.userId);
    if (user === null || user.deletedAt !== null) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    const verdict = limiters.purchase.hit(user.id);
    if (!verdict.allowed) {
      res.setHeader("Retry-After", String(verdict.retryAfterSeconds));
      res.status(429).json({ reason: "Too many requests" });
      return;
    }
    if (user.kind === "guest") {
      res.status(403).json({ code: "LOGIN_REQUIRED" });
      return;
    }
    if ((await activeBan(pool, user.id)) !== null) {
      res.status(403).json({ code: "BANNED" });
      return;
    }
    const body = PurchaseBody.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ reason: "Invalid request" });
      return;
    }
    if (body.data.currencyType !== "soft") {
      res.status(400).json({ reason: "Currency not accepted" });
      return;
    }
    const offer = findOffer(catalog, body.data);
    if (offer === null) {
      res.status(400).json({ reason: "Item not for sale" });
      return;
    }
    const outcome = await purchaseOffer(pool, user.id, offer, {
      catalogVersion: catalog.version,
      defaultFlares: catalog.defaultFlares,
    });
    switch (outcome.kind) {
      case "owned":
        res.status(409).json({ reason: "Already owned" });
        return;
      case "insufficient":
        res.status(400).json({ reason: "Insufficient balance" });
        return;
      case "purchased":
        res.json({
          currency: { soft: outcome.balance, hard: 0 },
          flares: [offer.flare],
        });
        return;
    }
  });

  return router;
}
