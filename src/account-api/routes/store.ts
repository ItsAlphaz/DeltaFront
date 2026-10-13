import express, { type Router } from "express";
import { ASSET_ROUTE, type Catalog } from "../catalog/load";

/**
 * The cosmetic catalog and its assets (docs/DeltaFrontAccountsPlan.md section
 * 9.3). Both are public, read-only and held in memory from startup, so a
 * request never touches the disk or the database, and the asset route can only
 * ever return a file the catalog was validated with (a lookup in a map, never
 * a path built from the request).
 *
 * Purchases (`POST /shop/purchase`) arrive in milestone M5.
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
