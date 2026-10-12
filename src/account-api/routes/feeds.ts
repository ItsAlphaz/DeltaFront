import express, { type Router } from "express";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const RESOURCES = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../resources",
);

/** The news and streams feeds: DeltaFront's own bundled files (the client falls back to them anyway). */
export function feedsRouter(): Router {
  const router = express.Router();
  for (const name of ["news", "streams"] as const) {
    router.get(`/${name}.json`, (_req, res) => {
      res.setHeader("Cache-Control", "public, max-age=300");
      res
        .type("application/json")
        .send(fs.readFileSync(path.join(RESOURCES, `${name}.json`), "utf8"));
    });
  }
  return router;
}
