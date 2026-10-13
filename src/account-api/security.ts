import type { NextFunction, Request, RequestHandler, Response } from "express";
import type { AccountApiConfig } from "./config";
import type { Logger } from "./logger";

/**
 * Response headers for the JSON API (it serves no HTML, so the policy is the
 * strictest one there is) and the structured access log.
 *
 *  - `nosniff`, `no-referrer`, `X-Frame-Options: DENY` and a CSP that allows
 *    nothing and forbids framing: a response can never be rendered or embedded
 *    as a page;
 *  - `Cache-Control: no-store` by default. Routes that are public and cacheable
 *    (the key set, the catalog and its assets, the news feeds) set their own
 *    header, which replaces this one;
 *  - HSTS when the API's public origin is https, so a browser that has seen the
 *    API once never talks to it over plain http. (Browsers ignore the header on
 *    an http connection, so it is harmless on a local stack.)
 *
 * There is deliberately no `Cross-Origin-Resource-Policy` header: the site and
 * the API are different origins, and cross-origin reads are governed by the
 * CORS allow-list (http.ts), not by CORP.
 */
export function securityHeaders(
  config: Pick<AccountApiConfig, "publicOrigin">,
): RequestHandler {
  const https = config.publicOrigin.startsWith("https://");
  return (_req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    );
    res.setHeader("Cache-Control", "no-store");
    if (https) {
      res.setHeader(
        "Strict-Transport-Security",
        "max-age=31536000; includeSubDomains",
      );
    }
    next();
  };
}

/** Refusals worth a line in the normal log: failed authentication, forbidden origin, rate limit. */
const SECURITY_STATUSES: ReadonlySet<number> = new Set([401, 403, 429]);

/**
 * One structured line per request that failed (5xx), was refused for a
 * security reason (401, 403, 429) or was slow; every other request, including
 * ordinary 400/404/409 answers, one line at debug level.
 *
 * What is logged is the route *pattern* (`/auth/callback/:provider`), never the
 * URL: the OAuth callback carries a one-time code and state in its query, and
 * paths can carry identifiers. Headers, cookies, bodies and addresses are not
 * logged either; the status code and timing are enough to see a failing
 * sign-in or join, and the application logs the reason.
 */
export function requestLog(log: Logger, slowMs = 1_000): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    const started = process.hrtime.bigint();
    res.on("finish", () => {
      const ms = Number((process.hrtime.bigint() - started) / 1_000_000n);
      const route =
        req.route?.path !== undefined
          ? `${req.baseUrl}${req.route.path}`
          : "unmatched";
      const fields = {
        method: req.method,
        route,
        status: res.statusCode,
        ms,
      };
      if (res.statusCode >= 500) log.error("request failed", fields);
      else if (SECURITY_STATUSES.has(res.statusCode))
        log.info("request refused", fields);
      else if (ms >= slowMs) log.warn("slow request", fields);
      else log.debug("request", fields);
    });
    next();
  };
}
