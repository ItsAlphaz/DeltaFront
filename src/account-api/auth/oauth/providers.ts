import { AUTH_PROVIDERS } from "@openfront/shared/AccountFeatures";
import { createHash } from "node:crypto";
import { z } from "zod";
import type { AccountApiConfig } from "../../config";
import type { ProviderIdentity } from "../signIn";

/**
 * Discord and Google sign-in (OAuth 2.0 authorization code flow with PKCE).
 *
 * HTTP goes through an injected `fetch` and the endpoints are overridable, so
 * tests (and local verification against a stand-in provider) never touch the
 * real services. Provider secrets are only ever sent to the provider's own
 * token endpoint, and error messages never contain them.
 */

export type OAuthProviderId = "discord" | "google";

export class OAuthExchangeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OAuthExchangeError";
  }
}

export interface OAuthProvider {
  id: OAuthProviderId;
  /** The URL to send the browser to. */
  authorizeUrl(args: {
    redirectUri: string;
    state: string;
    codeVerifier: string;
  }): string;
  /** Trades the callback `code` for the provider's account details. */
  exchange(args: {
    code: string;
    redirectUri: string;
    codeVerifier: string;
  }): Promise<ProviderIdentity>;
}

export interface OAuthEndpoints {
  authorize: string;
  token: string;
  userinfo: string;
}

export const DEFAULT_ENDPOINTS: Record<OAuthProviderId, OAuthEndpoints> = {
  discord: {
    authorize: "https://discord.com/oauth2/authorize",
    token: "https://discord.com/api/oauth2/token",
    userinfo: "https://discord.com/api/users/@me",
  },
  google: {
    authorize: "https://accounts.google.com/o/oauth2/v2/auth",
    token: "https://oauth2.googleapis.com/token",
    userinfo: "https://openidconnect.googleapis.com/v1/userinfo",
  },
};

const SCOPES: Record<OAuthProviderId, string> = {
  discord: "identify email",
  google: "openid email profile",
};

const TIMEOUT_MS = 10_000;

export function pkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

const TokenResponse = z.object({ access_token: z.string().min(1) });

const DiscordUser = z.object({
  id: z.string().min(1),
  username: z.string(),
  global_name: z.string().nullable().optional(),
  avatar: z.string().nullable().optional(),
  discriminator: z.string().optional(),
  email: z.string().nullable().optional(),
  verified: z.boolean().optional(),
});

const GoogleUser = z.object({
  sub: z.string().min(1),
  email: z.string().nullable().optional(),
  email_verified: z.boolean().optional(),
  name: z.string().nullable().optional(),
  picture: z.string().nullable().optional(),
});

interface Credentials {
  clientId: string;
  clientSecret: string;
}

function build(
  id: OAuthProviderId,
  creds: Credentials,
  endpoints: OAuthEndpoints,
  fetchFn: typeof fetch,
  mapUser: (json: unknown) => ProviderIdentity,
): OAuthProvider {
  return {
    id,
    authorizeUrl({ redirectUri, state, codeVerifier }) {
      const url = new URL(endpoints.authorize);
      url.searchParams.set("client_id", creds.clientId);
      url.searchParams.set("redirect_uri", redirectUri);
      url.searchParams.set("response_type", "code");
      url.searchParams.set("scope", SCOPES[id]);
      url.searchParams.set("state", state);
      url.searchParams.set("code_challenge", pkceChallenge(codeVerifier));
      url.searchParams.set("code_challenge_method", "S256");
      if (id === "discord") url.searchParams.set("prompt", "none");
      return url.toString();
    },
    async exchange({ code, redirectUri, codeVerifier }) {
      let tokenRes: Response;
      try {
        tokenRes = await fetchFn(endpoints.token, {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            Accept: "application/json",
          },
          body: new URLSearchParams({
            grant_type: "authorization_code",
            code,
            redirect_uri: redirectUri,
            client_id: creds.clientId,
            client_secret: creds.clientSecret,
            code_verifier: codeVerifier,
          }),
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
      } catch {
        throw new OAuthExchangeError(`${id}: token request failed`);
      }
      if (!tokenRes.ok)
        throw new OAuthExchangeError(
          `${id}: token endpoint answered ${tokenRes.status}`,
        );
      const token = TokenResponse.safeParse(
        await tokenRes.json().catch(() => null),
      );
      if (!token.success)
        throw new OAuthExchangeError(`${id}: malformed token response`);

      let userRes: Response;
      try {
        userRes = await fetchFn(endpoints.userinfo, {
          headers: {
            Authorization: `Bearer ${token.data.access_token}`,
            Accept: "application/json",
          },
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
      } catch {
        throw new OAuthExchangeError(`${id}: profile request failed`);
      }
      if (!userRes.ok)
        throw new OAuthExchangeError(
          `${id}: profile endpoint answered ${userRes.status}`,
        );
      try {
        return mapUser(await userRes.json());
      } catch {
        throw new OAuthExchangeError(`${id}: malformed profile`);
      }
    },
  };
}

function discordIdentity(json: unknown): ProviderIdentity {
  const u = DiscordUser.parse(json);
  const email = u.email ? u.email.toLowerCase() : null;
  return {
    provider: "discord",
    providerUserId: u.id,
    email,
    emailVerified: email !== null && u.verified === true,
    displayName: u.global_name ?? u.username,
    avatar: u.avatar ?? null,
    // Exactly the fields UserMeResponse's `discord` object carries.
    profile: {
      id: u.id,
      username: u.username,
      global_name: u.global_name ?? null,
      avatar: u.avatar ?? null,
      discriminator: u.discriminator ?? "0",
    },
  };
}

function googleIdentity(json: unknown): ProviderIdentity {
  const u = GoogleUser.parse(json);
  const email = u.email ? u.email.toLowerCase() : null;
  return {
    provider: "google",
    providerUserId: u.sub,
    email,
    emailVerified: email !== null && u.email_verified === true,
    displayName: u.name ?? null,
    avatar: u.picture ?? null,
    profile: { email },
  };
}

export type OAuthProviders = Partial<Record<OAuthProviderId, OAuthProvider>>;

/**
 * The providers this deployment offers: those enabled in AUTH_PROVIDERS and
 * given credentials. A provider without credentials is simply not offered.
 */
export function createOAuthProviders(
  config: Pick<AccountApiConfig, "oauth">,
  fetchFn: typeof fetch = fetch,
  endpoints: Partial<Record<OAuthProviderId, OAuthEndpoints>> = {},
): OAuthProviders {
  const providers: OAuthProviders = {};
  if (AUTH_PROVIDERS.discord && config.oauth.discord !== null) {
    providers.discord = build(
      "discord",
      config.oauth.discord,
      endpoints.discord ?? DEFAULT_ENDPOINTS.discord,
      fetchFn,
      discordIdentity,
    );
  }
  if (AUTH_PROVIDERS.google && config.oauth.google !== null) {
    providers.google = build(
      "google",
      config.oauth.google,
      endpoints.google ?? DEFAULT_ENDPOINTS.google,
      fetchFn,
      googleIdentity,
    );
  }
  return providers;
}
