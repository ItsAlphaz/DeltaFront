import { LAUNCH_FEATURES_VALUE } from "@openfront/shared/AccountFeatures";
import { generateKeyPairSync } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * A complete, launch-ready deployment on disk: a repository root with built
 * client and final legal pages, a private signing key kept outside it, and an
 * environment that passes every check. Tests break one thing at a time.
 */

export const SECRETS = {
  API_KEY: "dfk_Zk3p0Qm8VrT1uYb7Nc2LwXa9HdJe5GfS4iO6",
  TURNSTILE_SECRET_KEY: "0x4AAAAAAA-turnstile-secret-9f8e7d6c",
  DISCORD_CLIENT_SECRET: "discord-oauth-secret-ab12cd34ef56",
  GOOGLE_CLIENT_SECRET: "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",
  DB_PASSWORD: "s3cr3t-db-password-Q9w8e7",
};

export const BRAND_OK = {
  sourceRepoUrl: "https://git.example.com/deltafront/deltafront",
  steamAppId: null,
  adsEnabled: false,
};

export interface Fixture {
  root: string;
  keyPath: string;
  env: Record<string, string>;
  remove(): void;
}

const filler = Array.from(
  { length: 20 },
  (_, i) =>
    `<p>Paragraph ${i + 1} explains in plain words how the service treats this subject.</p>`,
).join("\n");

export const FINISHED_PAGES = {
  "terms-of-service.html": `<!doctype html><html><body><main>
<!-- DELTAFRONT-LEGAL-REVIEWED: 2026-01-15 by Jane Example -->
<h1>Terms</h1><p>You may keep one account. We may ban, suspend or terminate an account that breaks the rules. Credits are an in-game currency with no cash value. We accept no liability for lost progress. The governing law is that of the operator's country.</p>
${filler}<p>Contact: <a href="mailto:legal@example.com">legal@example.com</a></p></main></body></html>`,
  "privacy-policy.html": `<!doctype html><html><body><main>
<!-- DELTAFRONT-LEGAL-REVIEWED: 2026-01-15 by Jane Example -->
<h1>Privacy</h1><p>We set one cookie that keeps you signed in. You can sign in with Discord or Google. We keep your IP address only as a keyed hash. Cloudflare Turnstile checks you are not a bot. You can delete your account; we retain game records without your name.</p>
${filler}<p>Contact: <a href="mailto:privacy@example.com">privacy@example.com</a></p></main></body></html>`,
};

export function createFixture(): Fixture {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "df-launch-"));
  const root = path.join(base, "repo");
  const secrets = path.join(base, "secrets");
  fs.mkdirSync(secrets, { mode: 0o700 });
  for (const dir of [
    "resources/public",
    "resources/maps/world",
    "static/assets",
  ]) {
    fs.mkdirSync(path.join(root, dir), { recursive: true });
  }
  for (const [file, html] of Object.entries(FINISHED_PAGES)) {
    fs.writeFileSync(path.join(root, "resources/public", file), html);
    fs.writeFileSync(path.join(root, "static", file), html);
  }
  // what the account API replays singleplayer matches from
  fs.writeFileSync(path.join(root, "resources/maps/world/manifest.json"), "{}");
  fs.writeFileSync(path.join(root, "static/index.html"), "<html></html>");
  fs.writeFileSync(
    path.join(root, "static/assets/index-abc.js"),
    `var f="${LAUNCH_FEATURES_VALUE}";console.log(f)`,
  );
  const keyPath = path.join(secrets, "jwt.pem");
  fs.writeFileSync(
    keyPath,
    generateKeyPairSync("ed25519").privateKey.export({
      type: "pkcs8",
      format: "pem",
    }),
    { mode: 0o600 },
  );
  const env: Record<string, string> = {
    GAME_ENV: "prod",
    DOMAIN: "example.com",
    API_PUBLIC_ORIGIN: "https://api.example.com",
    ALLOWED_ORIGINS: "https://example.com",
    DATABASE_URL: `postgres://df:${SECRETS.DB_PASSWORD}@db.internal:5432/deltafront?sslmode=require`,
    DF_ACCOUNT_FEATURES: LAUNCH_FEATURES_VALUE,
    JWT_PRIVATE_KEY_PATH: keyPath,
    TRUST_PROXY_HOPS: "1",
    API_KEY: SECRETS.API_KEY,
    TURNSTILE_SITE_KEY: "0x4AAAAAAA-sitekey",
    TURNSTILE_SECRET_KEY: SECRETS.TURNSTILE_SECRET_KEY,
    DISCORD_CLIENT_ID: "discord-id",
    DISCORD_CLIENT_SECRET: SECRETS.DISCORD_CLIENT_SECRET,
    GOOGLE_CLIENT_ID: "google-id",
    GOOGLE_CLIENT_SECRET: SECRETS.GOOGLE_CLIENT_SECRET,
  };
  return {
    root,
    keyPath,
    env,
    remove: () => fs.rmSync(base, { recursive: true, force: true }),
  };
}
