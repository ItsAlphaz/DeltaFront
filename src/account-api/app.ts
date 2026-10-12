import express, { type Express } from "express";
import type { AccountApiConfig } from "./config";
import type { Logger } from "./logger";

/**
 * The HTTP application. M0 is the skeleton only: a liveness check and JSON
 * error handling. The endpoints the existing client expects from
 * api.<DOMAIN> (docs/DeltaFrontAccountsPlan.md section 4) arrive with the
 * milestones that own them, starting with M1.
 */
export function createApp(deps: {
  config: AccountApiConfig;
  log: Logger;
  /** Registers routes. They go before the 404 and the error handler. */
  mount?: (app: Express) => void;
}): Express {
  const { log } = deps;
  const app = express();
  app.disable("x-powered-by");

  app.use((_req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    next();
  });

  // Liveness only: the process is up. It deliberately says nothing about the
  // database or the configuration.
  app.get("/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  deps.mount?.(app);

  app.use((_req, res) => {
    res.status(404).json({ error: "not_found" });
  });

  app.use(
    (
      err: unknown,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      log.error("unhandled request error", {
        error: err instanceof Error ? err.message : String(err),
      });
      res.status(500).json({ error: "internal_error" });
    },
  );

  return app;
}
