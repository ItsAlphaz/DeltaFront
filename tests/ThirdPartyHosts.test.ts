import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Every third-party host the browser client or the game server can reach is
 * listed here, with why (docs/OpenFrontAudit.md has the same table). A new
 * `https://host` in client or server code fails this test until someone
 * decides it belongs: a runtime dependency on a service we do not run is a
 * privacy, availability and (for OpenFront's) licensing decision, not a detail.
 */
const ALLOWED: Record<string, string> = {
  "www.w3.org": "XML namespace URIs (not requests)",
  "github.com":
    "links: the source repository (AGPL), contributor profiles in news text",
  "cdn.discordapp.com": "Discord avatars and clan pictures (img-src)",
  "discord.gg": "clan Discord invite links (user-supplied, validated)",
  "discord.com": "Discord OAuth endpoints (account API only) and invite links",
  "accounts.google.com": "Google OAuth authorize URL (account API only)",
  "oauth2.googleapis.com": "Google OAuth token endpoint (account API only)",
  "openidconnect.googleapis.com": "Google OAuth userinfo (account API only)",
  "api.resend.com":
    "email provider, only if EMAIL_PROVIDER=resend (account API sends sign-in links; never the browser)",
  "api.postmarkapp.com":
    "email provider, only if EMAIL_PROVIDER=postmark (account API only)",
  "challenges.cloudflare.com": "Cloudflare Turnstile (bot check at join)",
  "sdk.crazygames.com":
    "CrazyGames SDK, loaded only when embedded on crazygames.com",
  "www.googletagmanager.com":
    "Google Analytics, only when GOOGLE_ANALYTICS_ID is set",
  "static.cloudflareinsights.com":
    "Cloudflare Web Analytics, only when CLOUDFLARE_ANALYTICS_TOKEN is set",
  "www.youtube.com": "links to a stream channel from the optional streams feed",
  "www.twitch.tv": "links to a stream channel from the optional streams feed",
  "embed.twitch.tv":
    "Twitch player SDK, only when the streams feed has a featured stream",
  "store.steampowered.com":
    "Steam wishlist link, hidden unless BRAND.steamAppId is set",
  localhost: "development",
  "clanmap.localhost":
    "development only (the clan map iframe, which DeltaFront does not run)",
  "www.google-analytics.com":
    "CSP allowance for Google Analytics, only when GOOGLE_ANALYTICS_ID is set",
};

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(path.join(ROOT, dir), {
    withFileTypes: true,
  })) {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) walk(rel, out);
    else if (/\.(ts|js|html)$/.test(entry.name)) out.push(rel);
  }
  return out;
}

function codeHosts(file: string): Array<{ host: string; line: number }> {
  const hits: Array<{ host: string; line: number }> = [];
  fs.readFileSync(path.join(ROOT, file), "utf8")
    .split("\n")
    .forEach((line, index) => {
      const trimmed = line.trim();
      if (/^(\/\/|\/\*|\*|<!--|#)/.test(trimmed)) return;
      const code = line.replace(/\s\/\/.*$/, "");
      for (const m of code.matchAll(/https?:\/\/([a-z0-9.-]+)/gi)) {
        hits.push({ host: m[1].toLowerCase(), line: index + 1 });
      }
    });
  return hits;
}

describe("third-party hosts", () => {
  const files = [
    ...walk("src/client"),
    ...walk("src/server"),
    ...walk("src/account-api"),
    ...walk("packages/shared/src"),
    "index.html",
  ];

  it("only the audited hosts appear in code", () => {
    const unknown: string[] = [];
    for (const file of files) {
      for (const { host, line } of codeHosts(file)) {
        // `https://api.${domain}` and friends are our own deployment, built at runtime.
        if (host.endsWith(".") || host === "" || host.endsWith("example.com"))
          continue;
        if (!(host in ALLOWED)) unknown.push(`${file}:${line}: ${host}`);
      }
    }
    expect(unknown).toEqual([]);
  });

  it("every audited host is still used (the list does not rot)", () => {
    const used = new Set(files.flatMap((f) => codeHosts(f).map((h) => h.host)));
    const stale = Object.keys(ALLOWED).filter((h) => !used.has(h));
    expect(stale).toEqual([]);
  });

  it("no audited host is an OpenFront service", () => {
    for (const host of Object.keys(ALLOWED))
      expect(host).not.toMatch(/openfront/i);
  });

  it("the audit document lists every host", () => {
    const doc = fs.readFileSync(
      path.join(ROOT, "docs/OpenFrontAudit.md"),
      "utf8",
    );
    for (const host of Object.keys(ALLOWED)) {
      if (host.includes("localhost") || host === "www.w3.org") continue;
      expect(doc, host).toContain(host);
    }
  });

  it("the shipped branding embeds nothing from OpenFront", async () => {
    const { BRAND } = await import("../src/client/Branding");
    expect(BRAND.tutorialVideoUrl).toBe("");
    expect(BRAND.discordUrl + BRAND.redditUrl + BRAND.wikiUrl).not.toMatch(
      /openfront/i,
    );
    expect(BRAND.steamAppId).toBeNull();
    expect(BRAND.adsEnabled).toBe(false);
  });
});
