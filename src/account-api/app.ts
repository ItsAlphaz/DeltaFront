import {
  usesAccountApi,
  usesCosmeticCatalog,
} from "@openfront/shared/AccountFeatures";
import express, { type Express } from "express";
import type { AccountApiConfig } from "./config";
import { cors } from "./http";
import type { Logger } from "./logger";
import { authRouter } from "./routes/auth";
import { clansRouter } from "./routes/clans";
import { clusterRouter } from "./routes/cluster";
import type { AppDeps } from "./routes/common";
import { feedsRouter } from "./routes/feeds";
import { gameRouter } from "./routes/game";
import { joinVerifyRouter } from "./routes/joinVerify";
import { leaderboardRouter } from "./routes/leaderboard";
import { profileRouter } from "./routes/profile";
import { serverLookupsRouter } from "./routes/server";
import { shopRouter, storeRouter } from "./routes/store";
import { usersRouter } from "./routes/users";

/**
 * The HTTP application.
 *
 * What is served follows the feature flags (docs/DeltaFrontAccountsPlan.md
 * section 17), so a deployment never exposes an endpoint for a feature that is
 * off:
 *  - `accounts`: sign-in, sessions, /users/@me, usernames, player profiles
 *    and game history, the signing-key set and the game server's join
 *    verification;
 *  - `store` (with `accounts`): `POST /shop/purchase`, spending Credits;
 *  - `clans` (with `accounts`): the clan API, `/public/clan/:tag/exists` and
 *    the clan leaderboard;
 *  - `leaderboards`: the basic player leaderboard;
 *  - `inventory` (or `store`, or `clans`): the cosmetic catalog and its
 *    assets, and the lookups the game server's cosmetic checks need;
 *  - any feature: server discovery (check-in and the server list), the game
 *    archive and the news feeds, which the client and game server use as soon
 *    as they talk to the API at all.
 * With every flag off only /health answers (milestone M0's skeleton).
 */
export function createApp(deps: {
  config: AccountApiConfig;
  log: Logger;
  /** The wired-up backend; absent when no feature needs one. */
  backend?: AppDeps;
  /** Registers extra routes. They go before the 404 and the error handler. */
  mount?: (app: Express) => void;
}): Express {
  const { config, log, backend } = deps;
  const app = express();
  app.disable("x-powered-by");
  // The API's JSON is dynamic and uncacheable; automatic ETags add nothing.
  app.set("etag", false);
  if (config.trustProxyHops > 0) app.set("trust proxy", config.trustProxyHops);

  app.use((_req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    next();
  });
  app.use(cors(config.allowedOrigins));

  // Liveness only: the process is up. It deliberately says nothing about the
  // database or the configuration.
  app.get("/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  if (backend !== undefined) {
    if (config.features.accounts) {
      app.get("/.well-known/jwks.json", (_req, res) => {
        // Public keys only. The game server reads keys[0], the current key.
        res.setHeader("Cache-Control", "public, max-age=300");
        res.json(backend.keys.jwks());
      });
      app.use(authRouter(backend));
      app.use(usersRouter(backend));
      app.use(profileRouter(backend));
      app.use(joinVerifyRouter(backend));
    }
    if (config.features.clans && config.features.accounts) {
      app.use(clansRouter(backend));
    }
    if (config.features.leaderboards) {
      app.use(leaderboardRouter(backend));
    }
    if (backend.catalog !== null && usesCosmeticCatalog(config.features)) {
      app.use(storeRouter(backend.catalog));
      app.use(serverLookupsRouter(backend.pool, backend.reserved));
      // Spending Credits needs sign-in as well as the catalog.
      if (config.features.store && config.features.accounts) {
        app.use(shopRouter({ ...backend, catalog: backend.catalog }));
      }
    }
    if (usesAccountApi(config.features)) {
      app.use(clusterRouter(backend));
      app.use(gameRouter(backend));
      app.use(feedsRouter());
    }
  }

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
