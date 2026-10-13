import {
  calculateJwkThumbprint,
  createLocalJWKSet,
  exportJWK,
  exportPKCS8,
  generateKeyPair,
  importPKCS8,
  importSPKI,
  jwtVerify,
  SignJWT,
  type CryptoKey,
  type JWK,
  type JWTPayload,
  type KeyObject,
} from "jose";
import fs from "node:fs";
import path from "node:path";

/**
 * The Ed25519 keys that sign access tokens.
 *
 * Only the public half is ever published (JWKS); the private key is read from
 * a file on the API host and kept in memory. The game server picks a key from
 * the JWKS by `kid` (src/server/JwksCache.ts), so during a rotation the
 * previous public key stays listed after the current one and tokens signed
 * with it keep verifying, here and on the game server, until it is removed.
 */

export interface PublicJwk extends JWK {
  kty: "OKP";
  crv: "Ed25519";
  x: string;
  alg: "EdDSA";
  use: "sig";
  kid: string;
}

export interface KeyRing {
  /** Signs `claims` with the current key. */
  sign(
    claims: JWTPayload & { jti: string },
    ttlSeconds: number,
  ): Promise<string>;
  /** Verifies a token's signature, issuer and audience against every key in the ring. */
  verify(token: string, issuer: string, audience: string): Promise<JWTPayload>;
  /** The public keys, current first. Never contains private material. */
  jwks(): { keys: PublicJwk[] };
}

async function publicJwkOf(key: CryptoKey | KeyObject): Promise<PublicJwk> {
  const full = await exportJWK(key);
  // Only these members are public; `d` is the private scalar and is dropped.
  const base = {
    kty: "OKP" as const,
    crv: "Ed25519" as const,
    x: full.x as string,
  };
  return {
    ...base,
    alg: "EdDSA",
    use: "sig",
    kid: await calculateJwkThumbprint(base),
  };
}

export async function createKeyRing(
  privateKey: CryptoKey | KeyObject,
  previousPublic: Array<CryptoKey | KeyObject> = [],
): Promise<KeyRing> {
  const current = await publicJwkOf(privateKey);
  const previous = await Promise.all(previousPublic.map(publicJwkOf));
  const keys = [current, ...previous.filter((k) => k.kid !== current.kid)];
  const jwkSet = createLocalJWKSet({ keys });
  return {
    async sign(claims, ttlSeconds) {
      return new SignJWT(claims)
        .setProtectedHeader({ alg: "EdDSA", typ: "JWT", kid: current.kid })
        .setIssuedAt()
        .setExpirationTime(`${ttlSeconds}s`)
        .sign(privateKey);
    },
    async verify(token, issuer, audience) {
      const { payload } = await jwtVerify(token, jwkSet, {
        algorithms: ["EdDSA"],
        issuer,
        audience,
      });
      return payload;
    },
    jwks: () => ({ keys: keys.map((k) => ({ ...k })) }),
  };
}

/** A throwaway key (tests). */
export async function createEphemeralKeyRing(): Promise<KeyRing> {
  const { privateKey } = await generateKeyPair("EdDSA", {
    crv: "Ed25519",
    extractable: true,
  });
  return createKeyRing(privateKey);
}

export interface LoadKeyOptions {
  privateKeyPath: string | null;
  previousPublicKeyPath: string | null;
  /**
   * Dev only: with no key configured, create one here on first run and reuse
   * it afterwards (a new key on every restart would invalidate the JWKS the
   * game server has already cached). Null means a missing key is an error.
   */
  devKeyDir: string | null;
}

export class KeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KeyError";
  }
}

export async function loadKeyRing(options: LoadKeyOptions): Promise<KeyRing> {
  let pem: string;
  if (options.privateKeyPath !== null) {
    try {
      pem = fs.readFileSync(options.privateKeyPath, "utf8");
    } catch {
      throw new KeyError(
        "JWT_PRIVATE_KEY_PATH points to a file that cannot be read",
      );
    }
  } else if (options.devKeyDir !== null) {
    const file = path.join(options.devKeyDir, "jwt-ed25519.pem");
    if (fs.existsSync(file)) {
      pem = fs.readFileSync(file, "utf8");
    } else {
      const { privateKey } = await generateKeyPair("EdDSA", {
        crv: "Ed25519",
        extractable: true,
      });
      pem = await exportPKCS8(privateKey);
      fs.mkdirSync(options.devKeyDir, { recursive: true, mode: 0o700 });
      fs.writeFileSync(file, pem, { mode: 0o600 });
    }
  } else {
    throw new KeyError("no signing key: set JWT_PRIVATE_KEY_PATH");
  }

  let privateKey: KeyObject | CryptoKey;
  try {
    privateKey = await importPKCS8(pem, "EdDSA", { extractable: true });
  } catch {
    throw new KeyError(
      "the signing key is not a valid PKCS#8 Ed25519 private key (PEM)",
    );
  }
  await assertEd25519(privateKey);

  const previous: Array<KeyObject | CryptoKey> = [];
  if (options.previousPublicKeyPath !== null) {
    try {
      previous.push(
        await importSPKI(
          fs.readFileSync(options.previousPublicKeyPath, "utf8"),
          "EdDSA",
          {
            extractable: true,
          },
        ),
      );
    } catch {
      throw new KeyError(
        "JWT_PREVIOUS_PUBLIC_KEY_PATH is not a readable SPKI Ed25519 public key (PEM)",
      );
    }
  }
  return createKeyRing(privateKey, previous);
}

async function assertEd25519(key: KeyObject | CryptoKey): Promise<void> {
  const jwk = await exportJWK(key);
  if (jwk.kty !== "OKP" || jwk.crv !== "Ed25519") {
    throw new KeyError("the signing key must be Ed25519");
  }
}
