import { generateKeyPairSync } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createEphemeralKeyRing,
  type KeyRing,
} from "../../../src/account-api/auth/keys";
import type {
  OAuthEndpoints,
  OAuthProviderId,
} from "../../../src/account-api/auth/oauth/providers";
import { TokenService } from "../../../src/account-api/auth/tokens";
import {
  loadConfig,
  type AccountApiConfig,
} from "../../../src/account-api/config";
import { applyMigrations } from "../../../src/account-api/db/migrator";
import { createPool } from "../../../src/account-api/db/pool";
import { sha256 } from "../../../src/account-api/http";
import type { RateLimit, RateLimitName } from "../../../src/account-api/limits";
import { silentLogger } from "../../../src/account-api/logger";
import {
  startAccountApi,
  type RunningService,
} from "../../../src/account-api/service";
import type { Turnstile } from "../../../src/account-api/turnstile";
import { createTestDatabase, type TestDatabase } from "./testDb";

/** The origin the browser app is served from in these tests. */
export const APP_ORIGIN = "http://localhost:9000";
export const DISCORD_ID = "discord-client-id";
export const DISCORD_SECRET = "discord-secret-DO-NOT-LEAK";
export const GOOGLE_ID = "google-client-id";
export const GOOGLE_SECRET = "google-secret-DO-NOT-LEAK";

export interface HarnessOptions {
  /** DF_ACCOUNT_FEATURES; default "accounts". */
  features?: string;
  env?: "dev" | "staging";
  fetchFn?: typeof fetch;
  turnstile?: Turnstile;
  limits?: Partial<Record<RateLimitName, RateLimit>>;
  /** Leave Discord (or Google) unconfigured. */
  withoutProviders?: Array<"discord" | "google">;
  oauthEndpoints?: Partial<Record<OAuthProviderId, OAuthEndpoints>>;
  keys?: KeyRing;
  /** Read the cosmetic catalog from this directory. */
  catalogDir?: string;
  /** Bind this port instead of a free one (the game server expects the API on 8787 in dev). */
  fixedPort?: number;
}

export interface Harness {
  db: TestDatabase;
  service: RunningService;
  config: AccountApiConfig;
  keys: KeyRing;
  /** Issues tokens exactly as the API does (same issuer and audience). */
  tokens: TokenService;
  baseUrl: string;
  /** The origin that sends browser requests in this harness. */
  origin: string;
  close(): Promise<void>;
}

/** A browser's cookies for the API host. */
export class CookieJar {
  private readonly cookies = new Map<string, string>();
  /** Every Set-Cookie header seen, raw, for attribute assertions. */
  readonly raw: string[] = [];

  absorb(res: Response): void {
    for (const header of res.headers.getSetCookie()) {
      this.raw.push(header);
      const [pair, ...attrs] = header.split(";");
      const eq = pair.indexOf("=");
      const name = pair.slice(0, eq).trim();
      const value = decodeURIComponent(pair.slice(eq + 1));
      const maxAge = attrs
        .map((a) => a.trim())
        .find((a) => /^max-age=/i.test(a));
      if (
        value === "" ||
        (maxAge !== undefined && Number(maxAge.split("=")[1]) <= 0)
      ) {
        this.cookies.delete(name);
      } else {
        this.cookies.set(name, value);
      }
    }
  }
  get(name: string): string | undefined {
    return this.cookies.get(name);
  }
  set(name: string, value: string): void {
    this.cookies.set(name, value);
  }
  header(): string {
    return [...this.cookies]
      .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
      .join("; ");
  }
  clone(): CookieJar {
    const copy = new CookieJar();
    for (const [k, v] of this.cookies) copy.cookies.set(k, v);
    return copy;
  }
}

const tempFiles: string[] = [];
export function writeTempKeyFile(): string {
  const { privateKey } = generateKeyPairSync("ed25519");
  const file = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "df-key-")),
    "jwt.pem",
  );
  fs.writeFileSync(file, privateKey.export({ type: "pkcs8", format: "pem" }), {
    mode: 0o600,
  });
  tempFiles.push(file);
  return file;
}
export function removeTempKeyFiles(): void {
  for (const f of tempFiles.splice(0))
    fs.rmSync(path.dirname(f), { recursive: true, force: true });
}

export async function startHarness(
  options: HarnessOptions = {},
): Promise<Harness> {
  const db = await createTestDatabase();
  const bootstrap = createPool({ url: db.url, poolMax: 2 }, silentLogger);
  await applyMigrations(bootstrap);
  await bootstrap.end();

  const staging = options.env === "staging";
  const env: Record<string, string> = staging
    ? {
        GAME_ENV: "staging",
        DOMAIN: "example.com",
        API_PUBLIC_ORIGIN: "https://api.example.com",
        ALLOWED_ORIGINS: "https://example.com",
        JWT_PRIVATE_KEY_PATH: writeTempKeyFile(),
        TURNSTILE_SECRET_KEY: "turnstile-secret",
      }
    : {
        GAME_ENV: "dev",
        // The dev defaults the client and game server expect.
        API_PORT: "8787",
        ALLOWED_ORIGINS: APP_ORIGIN,
      };
  Object.assign(env, {
    DATABASE_URL: db.url,
    DF_ACCOUNT_FEATURES: options.features ?? "accounts",
  });
  const without = new Set(options.withoutProviders ?? []);
  if (!without.has("discord"))
    Object.assign(env, {
      DISCORD_CLIENT_ID: DISCORD_ID,
      DISCORD_CLIENT_SECRET: DISCORD_SECRET,
    });
  if (!without.has("google"))
    Object.assign(env, {
      GOOGLE_CLIENT_ID: GOOGLE_ID,
      GOOGLE_CLIENT_SECRET: GOOGLE_SECRET,
    });
  const config = { ...loadConfig(env), port: options.fixedPort ?? 0 };

  const keys = options.keys ?? (await createEphemeralKeyRing());
  const service = await startAccountApi(config, silentLogger, {
    keys,
    fetchFn: options.fetchFn,
    turnstile: options.turnstile,
    limits: options.limits,
    oauthEndpoints: options.oauthEndpoints,
    catalogDir: options.catalogDir,
  });
  return {
    db,
    service,
    config,
    keys,
    tokens: new TokenService(keys, config.publicOrigin, config.domain),
    baseUrl: `http://127.0.0.1:${service.port}`,
    origin: config.allowedOrigins[0],
    async close() {
      await service.close();
      await db.drop();
    },
  };
}

export interface CallOptions {
  method?: string;
  jar?: CookieJar;
  /** Browser requests carry an Origin; pass null to omit it. */
  origin?: string | null;
  bearer?: string;
  headers?: Record<string, string>;
  json?: unknown;
  userAgent?: string;
  redirect?: RequestRedirect;
}

/** One request to the harness, the way a browser (or a game server) would make it. */
export async function call(
  h: Harness,
  route: string,
  options: CallOptions = {},
): Promise<Response> {
  const headers: Record<string, string> = {
    "User-Agent": options.userAgent ?? "test-browser/1.0",
    ...options.headers,
  };
  const origin = options.origin === undefined ? h.origin : options.origin;
  if (origin !== null) headers.Origin = origin;
  if (options.bearer !== undefined)
    headers.Authorization = `Bearer ${options.bearer}`;
  const cookie = options.jar?.header();
  if (cookie) headers.Cookie = cookie;
  let body: string | undefined;
  if (options.json !== undefined) {
    body = JSON.stringify(options.json);
    headers["Content-Type"] = "application/json";
  }
  const res = await fetch(`${h.baseUrl}${route}`, {
    method: options.method ?? (body !== undefined ? "POST" : "GET"),
    headers,
    body,
    redirect: options.redirect ?? "manual",
  });
  options.jar?.absorb(res);
  return res;
}

/** A guest session: POST /auth/refresh with no cookie. */
export async function newGuest(
  h: Harness,
  jar = new CookieJar(),
): Promise<{
  jar: CookieJar;
  jwt: string;
  body: { jwt: string; expiresIn: number };
}> {
  const res = await call(h, "/auth/refresh", { method: "POST", jar });
  if (res.status !== 200)
    throw new Error(`guest refresh answered ${res.status}`);
  const body = (await res.json()) as { jwt: string; expiresIn: number };
  return { jar, jwt: body.jwt, body };
}

export async function refresh(
  h: Harness,
  jar: CookieJar,
  options: CallOptions = {},
): Promise<Response> {
  return call(h, "/auth/refresh", { method: "POST", jar, ...options });
}

/** Registers a server API key (what `server:key:create` does) and returns it. */
export async function createServerKey(
  h: Harness,
  key = `test-server-key-${Math.random().toString(36).slice(2)}-0123456789`,
): Promise<string> {
  await h.db.pool.query(
    "INSERT INTO server_api_keys (name, key_hash) VALUES ('test', $1)",
    [sha256(key)],
  );
  return key;
}

export const decodeJwtPayload = (jwt: string): Record<string, unknown> =>
  JSON.parse(Buffer.from(jwt.split(".")[1], "base64url").toString("utf8"));

// ----------------------------------------------------------- mock providers

export interface MockAccount {
  /** What the provider would return for this authorization code. */
  discord?: {
    id: string;
    username: string;
    global_name?: string | null;
    avatar?: string | null;
    discriminator?: string;
    email?: string | null;
    verified?: boolean;
  };
  google?: {
    sub: string;
    email?: string | null;
    email_verified?: boolean;
    name?: string | null;
    picture?: string | null;
  };
  /** Make the token endpoint refuse this code. */
  tokenError?: number;
  /** Make the profile endpoint fail. */
  profileError?: number;
}

export interface RecordedRequest {
  url: string;
  method: string;
  body: string;
  authorization: string | null;
}

/**
 * A stand-in for Discord, Google and Cloudflare. `accounts` maps an
 * authorization `code` to what the provider would say about it. Every
 * outbound request is recorded, which is also how the tests prove no request
 * ever goes to an unexpected host (and that secrets only go to token URLs).
 */
export function createMockProviders(
  accounts: Record<string, MockAccount> = {},
) {
  const requests: RecordedRequest[] = [];
  const issued = new Map<string, string>(); // access token -> code
  const fetchFn = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = String(input);
    const body =
      init?.body instanceof URLSearchParams
        ? init.body.toString()
        : String(init?.body ?? "");
    const headers = new Headers(init?.headers);
    requests.push({
      url,
      method: init?.method ?? "GET",
      body,
      authorization: headers.get("authorization"),
    });
    const json = (status: number, value: unknown) =>
      new Response(JSON.stringify(value), {
        status,
        headers: { "Content-Type": "application/json" },
      });

    if (
      url === "https://discord.com/api/oauth2/token" ||
      url === "https://oauth2.googleapis.com/token"
    ) {
      const params = new URLSearchParams(body);
      const code = params.get("code") ?? "";
      const account = accounts[code];
      if (account === undefined) return json(400, { error: "invalid_grant" });
      if (account.tokenError !== undefined)
        return json(account.tokenError, { error: "nope" });
      const token = `at-${code}`;
      issued.set(token, code);
      return json(200, { access_token: token, token_type: "Bearer" });
    }
    if (
      url === "https://discord.com/api/users/@me" ||
      url === "https://openidconnect.googleapis.com/v1/userinfo"
    ) {
      const code = issued.get(
        (headers.get("authorization") ?? "").replace("Bearer ", ""),
      );
      const account = code === undefined ? undefined : accounts[code];
      if (account === undefined) return json(401, { error: "bad token" });
      if (account.profileError !== undefined)
        return json(account.profileError, {});
      const profile = url.includes("discord")
        ? account.discord
        : account.google;
      return profile === undefined ? json(400, {}) : json(200, profile);
    }
    return json(404, { error: `unexpected request to ${url}` });
  }) as typeof fetch;
  return { fetchFn, requests, accounts };
}

/** Hosts the API may talk to; anything else is a bug (and OpenFront is never one of them). */
export const ALLOWED_OUTBOUND_HOSTS = new Set([
  "discord.com",
  "accounts.google.com",
  "oauth2.googleapis.com",
  "openidconnect.googleapis.com",
  "challenges.cloudflare.com",
]);

/** The state and the redirect target from a provider authorize URL. */
export function parseAuthorizeUrl(location: string): URL {
  return new URL(location);
}

/** Drives an OAuth login to its callback, like a browser that approved at the provider. */
export async function completeLogin(
  h: Harness,
  provider: "discord" | "google",
  code: string,
  options: {
    jar?: CookieJar;
    redirectUri?: string;
    callbackParams?: Record<string, string>;
    omitState?: boolean;
    userAgent?: string;
  } = {},
): Promise<{
  start: Response;
  callback: Response;
  jar: CookieJar;
  location: string | null;
  state: string;
}> {
  const jar = options.jar ?? new CookieJar();
  const redirectUri = options.redirectUri ?? `${APP_ORIGIN}/#modal=account`;
  const start = await call(
    h,
    `/auth/login/${provider}?redirect_uri=${encodeURIComponent(redirectUri)}`,
    {
      jar,
      origin: null,
      userAgent: options.userAgent,
    },
  );
  if (start.status !== 302)
    throw new Error(`login start answered ${start.status}`);
  const authorize = new URL(start.headers.get("location")!);
  const state = authorize.searchParams.get("state")!;
  const params = new URLSearchParams(options.callbackParams ?? { code });
  if (!options.omitState && !params.has("state")) params.set("state", state);
  const callback = await call(h, `/auth/callback/${provider}?${params}`, {
    jar,
    origin: null,
    userAgent: options.userAgent,
  });
  return {
    start,
    callback,
    jar,
    location: callback.headers.get("location"),
    state,
  };
}
