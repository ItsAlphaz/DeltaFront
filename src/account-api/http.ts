import type { NextFunction, Request, Response } from "express";
import { createHash } from "node:crypto";

/**
 * CORS and origin checks.
 *
 * The browser app lives on a different origin from the API (https://<domain>
 * vs https://api.<domain>; localhost:9000 vs localhost:8787 in dev), so every
 * response to an allowed origin carries explicit CORS headers with
 * credentials. Any other origin gets none, which makes the browser refuse to
 * hand the response to the page.
 */
export function cors(allowedOrigins: readonly string[]) {
  const allowed = new Set(allowedOrigins);
  return (req: Request, res: Response, next: NextFunction): void => {
    const origin = req.headers.origin;
    res.vary("Origin");
    if (typeof origin === "string" && allowed.has(origin)) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Access-Control-Allow-Credentials", "true");
      if (req.method === "OPTIONS") {
        res.setHeader(
          "Access-Control-Allow-Methods",
          "GET, POST, PUT, PATCH, DELETE, OPTIONS",
        );
        res.setHeader(
          "Access-Control-Allow-Headers",
          req.headers["access-control-request-headers"] ??
            "Authorization, Content-Type",
        );
        res.setHeader("Access-Control-Max-Age", "600");
      }
    }
    if (req.method === "OPTIONS") {
      res.status(204).end();
      return;
    }
    next();
  };
}

/**
 * CSRF guard for endpoints authenticated by the refresh cookie (which the
 * browser attaches by itself): the request must name an allowed Origin.
 * Browsers always send Origin on cross-origin requests and scripts cannot
 * forge it; a missing or foreign Origin is refused. SameSite=Lax is the
 * second layer.
 */
export function requireAllowedOrigin(allowedOrigins: readonly string[]) {
  const allowed = new Set(allowedOrigins);
  return (req: Request, res: Response, next: NextFunction): void => {
    const origin = req.headers.origin;
    if (typeof origin !== "string" || !allowed.has(origin)) {
      res.status(403).json({ error: "forbidden_origin" });
      return;
    }
    next();
  };
}

/** SHA-256, hex or raw: the form tokens and keys are stored in. */
export function sha256(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

/** The address a rate limit or Turnstile check should see for this request. */
export function clientIp(req: Request): string {
  return req.ip ?? req.socket.remoteAddress ?? "unknown";
}
