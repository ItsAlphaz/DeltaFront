import type { NextFunction, Request, Response } from "express";
import { createHash } from "node:crypto";

/**
 * Browser security headers for the pages and assets the game server serves.
 * (The account API sets its own, much stricter set: src/account-api/
 * security.ts, since it serves no HTML.)
 *
 * The Content-Security-Policy is built from the page it protects. The app
 * shell has a handful of inline `<script>` blocks (bootstrap config, the
 * sidebar fallback, the optional analytics loader); instead of allowing
 * 'unsafe-inline' for scripts, the policy lists the SHA-256 of each block that
 * is actually in the rendered HTML, so a script injected into the page cannot
 * run. Everything else is an allow-list of the few origins the game really
 * talks to:
 *
 *  - Cloudflare Turnstile: its script, its challenge iframe and its siteverify
 *    token requests (the bot check before joining);
 *  - the account API (`https://api.<domain>`): fetch/XHR with credentials and
 *    cosmetic images;
 *  - the game's own WebSockets (`wss://<domain>`, its subdomains and the game
 *    domain);
 *  - Discord's avatar CDN (profile and clan pictures);
 *  - the CrazyGames SDK, loaded only when embedded on crazygames.com
 *    (index.html);
 *  - the CDN, when CDN_BASE is set;
 *  - Google Analytics / Cloudflare Web Analytics, only when the deployment
 *    turned them on.
 * See docs/OpenFrontAudit.md for why each is there.
 */

export interface CspOptions {
  /** The rendered app shell: its inline scripts are hashed. */
  html: string;
  /** `https://api.<domain>` (http://localhost:8787 on a local stack). */
  apiOrigin: string;
  /** The site's domain, and the game domain when it differs. */
  domains: readonly string[];
  /** CDN origin, or "" for same-origin assets. */
  cdnBase: string;
  googleAnalytics: boolean;
  cloudflareAnalytics: boolean;
  /** Add `upgrade-insecure-requests` (not on an http://localhost stack). */
  upgradeInsecure: boolean;
}

const INLINE_SCRIPT = /<script(?![^>]*\bsrc\s*=)([^>]*)>([\s\S]*?)<\/script>/gi;

/** `'sha256-…'` source expressions for every inline script block in `html`. */
export function inlineScriptHashes(html: string): string[] {
  const hashes = new Set<string>();
  for (const match of html.matchAll(INLINE_SCRIPT)) {
    // JSON and other data blocks are not governed by script-src.
    const type = /\btype\s*=\s*["']?([^"'\s>]+)/i.exec(match[1])?.[1];
    if (
      type !== undefined &&
      !/^(module|(text|application)\/javascript)$/i.test(type)
    ) {
      continue;
    }
    const digest = createHash("sha256")
      .update(match[2], "utf8")
      .digest("base64");
    hashes.add(`'sha256-${digest}'`);
  }
  return [...hashes];
}

export function buildContentSecurityPolicy(options: CspOptions): string {
  const cdn = options.cdnBase !== "" ? [options.cdnBase] : [];
  const sockets = options.domains.flatMap((d) => [
    `wss://${d}`,
    `wss://*.${d}`,
  ]);
  const insecureSockets = options.domains.includes("localhost")
    ? ["ws://localhost:*"]
    : [];
  const analyticsScripts = options.googleAnalytics
    ? ["https://www.googletagmanager.com"]
    : [];
  const analyticsConnect = options.googleAnalytics
    ? [
        "https://www.google-analytics.com",
        "https://*.google-analytics.com",
        "https://*.analytics.google.com",
        "https://www.googletagmanager.com",
      ]
    : [];
  const cfBeacon = options.cloudflareAnalytics
    ? ["https://static.cloudflareinsights.com"]
    : [];
  const directives: Array<[string, string[]]> = [
    ["default-src", ["'self'"]],
    ["base-uri", ["'self'"]],
    ["object-src", ["'none'"]],
    ["form-action", ["'self'"]],
    ["frame-ancestors", ["'self'"]],
    [
      "script-src",
      [
        "'self'",
        ...inlineScriptHashes(options.html),
        "https://challenges.cloudflare.com",
        "https://sdk.crazygames.com",
        ...analyticsScripts,
        ...cfBeacon,
        ...cdn,
      ],
    ],
    // Lit and the Tailwind build use inline style attributes and a <style>
    // block; styles cannot run code, so 'unsafe-inline' is accepted here.
    ["style-src", ["'self'", "'unsafe-inline'", ...cdn]],
    [
      "img-src",
      [
        "'self'",
        "data:",
        "blob:",
        "https://cdn.discordapp.com",
        options.apiOrigin,
        ...analyticsConnect.slice(0, 1),
        ...cdn,
      ],
    ],
    ["font-src", ["'self'", "data:", ...cdn]],
    ["media-src", ["'self'", "blob:", "data:", ...cdn]],
    [
      "connect-src",
      [
        "'self'",
        options.apiOrigin,
        "https://challenges.cloudflare.com",
        ...sockets,
        ...insecureSockets,
        ...analyticsConnect,
        ...cfBeacon,
        ...cdn,
      ],
    ],
    ["frame-src", ["https://challenges.cloudflare.com"]],
    ["worker-src", ["'self'", "blob:", ...cdn]],
    ["manifest-src", ["'self'", ...cdn]],
  ];
  if (options.upgradeInsecure)
    directives.push(["upgrade-insecure-requests", []]);
  return directives
    .map(([name, sources]) => [name, ...sources].join(" "))
    .join("; ");
}

/** Headers every response carries, whatever it is. */
export function applyCommonSecurityHeaders(
  res: Response,
  options: { hsts: boolean },
): void {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("X-Frame-Options", "SAMEORIGIN");
  res.setHeader(
    "Permissions-Policy",
    "camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()",
  );
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin-allow-popups");
  if (options.hsts) {
    res.setHeader(
      "Strict-Transport-Security",
      "max-age=31536000; includeSubDomains",
    );
  }
}

/**
 * Express middleware for the game server and its workers. HSTS is sent only
 * on requests that arrived over https (behind the proxy: X-Forwarded-Proto),
 * and only outside dev.
 */
export function commonSecurityHeaders(options: { enabled: boolean }) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (options.enabled) {
      applyCommonSecurityHeaders(res, { hsts: req.secure });
    } else {
      res.setHeader("X-Content-Type-Options", "nosniff");
    }
    next();
  };
}
