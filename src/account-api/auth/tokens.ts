import { TokenPayloadSchema } from "@openfront/shared/ApiSchemas";
import { base64urlToUuid, uuidToBase64url } from "@openfront/shared/Base64";
import { randomUUID } from "node:crypto";
import type { KeyRing } from "./keys";

/** Access tokens live 15 minutes (docs/Auth.md); the client refreshes 3 minutes early. */
export const ACCESS_TOKEN_TTL_SECONDS = 900;

export class TokenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TokenError";
  }
}

export interface AccessTokenInput {
  userId: string;
  /** "banned" while a ban is active, else the account's staff role, else null. */
  role: string | null;
  /** How the session was established: guest, discord, google, ... */
  provider: string;
  /** The session family; /users/@me checks it is still live, so revoking a session ends the token's use at once. */
  sid: string;
}

export interface AccessClaims {
  userId: string;
  role: string | null;
  provider: string | null;
  sid: string | null;
  jti: string;
  exp: number;
}

/**
 * Issues and verifies access tokens. The claims are exactly the ones the
 * client (src/client/Auth.ts) and game server (src/server/jwt.ts) read:
 * `iss` is the API origin, `aud` the site domain, `sub` the user id as
 * base64url, plus `role` and `provider`. `sid` is ours and ignored by them.
 */
export class TokenService {
  constructor(
    private readonly keys: KeyRing,
    private readonly issuer: string,
    private readonly audience: string,
  ) {}

  async issue(
    input: AccessTokenInput,
  ): Promise<{ jwt: string; expiresIn: number }> {
    const claims: Record<string, unknown> = {
      jti: randomUUID(),
      sub: uuidToBase64url(input.userId),
      iss: this.issuer,
      aud: this.audience,
      provider: input.provider,
      sid: input.sid,
    };
    if (input.role !== null) claims.role = input.role;
    const jwt = await this.keys.sign(claims as never, ACCESS_TOKEN_TTL_SECONDS);
    return { jwt, expiresIn: ACCESS_TOKEN_TTL_SECONDS };
  }

  /** Throws TokenError for anything that is not a valid, unexpired token from this API. */
  async verify(token: string): Promise<AccessClaims> {
    let payload;
    try {
      payload = await this.keys.verify(token, this.issuer, this.audience);
    } catch {
      throw new TokenError("invalid token");
    }
    // The shared schema decodes `sub` with a function that throws on malformed
    // base64 (rather than failing validation), so guard the whole parse.
    let parsed;
    try {
      parsed = TokenPayloadSchema.safeParse(payload);
    } catch {
      throw new TokenError("invalid token claims");
    }
    if (!parsed.success) throw new TokenError("invalid token claims");
    const { sub, role, provider, jti, exp } = parsed.data;
    const sid = typeof payload.sid === "string" ? payload.sid : null;
    // TokenPayloadSchema already turned `sub` into the UUID string.
    if (base64urlToUuid(uuidToBase64url(sub)) !== sub)
      throw new TokenError("invalid subject");
    return {
      userId: sub,
      role: role ?? null,
      provider: provider ?? null,
      sid,
      jti,
      exp,
    };
  }
}
