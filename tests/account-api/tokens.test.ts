// @vitest-environment node
import { TokenPayloadSchema } from "@openfront/shared/ApiSchemas";
import { base64urlToUuid, uuidToBase64url } from "@openfront/shared/Base64";
import { exportPKCS8, exportSPKI, generateKeyPair, SignJWT } from "jose";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createEphemeralKeyRing,
  createKeyRing,
  KeyError,
  loadKeyRing,
} from "../../src/account-api/auth/keys";
import {
  ACCESS_TOKEN_TTL_SECONDS,
  TokenError,
  TokenService,
} from "../../src/account-api/auth/tokens";

const USER = "123e4567-e89b-42d3-a456-426614174000";
const ISSUER = "http://localhost:8787";
const AUDIENCE = "localhost";

describe("TokenService", () => {
  it("issues the exact claims the client and the game server read", async () => {
    const keys = await createEphemeralKeyRing();
    const tokens = new TokenService(keys, ISSUER, AUDIENCE);
    const { jwt, expiresIn } = await tokens.issue({
      userId: USER,
      role: null,
      provider: "guest",
      sid: "family-1",
    });
    expect(expiresIn).toBe(ACCESS_TOKEN_TTL_SECONDS);
    expect(ACCESS_TOKEN_TTL_SECONDS).toBe(900); // docs/Auth.md: 15 minutes

    const payload = JSON.parse(
      Buffer.from(jwt.split(".")[1], "base64url").toString(),
    );
    const header = JSON.parse(
      Buffer.from(jwt.split(".")[0], "base64url").toString(),
    );
    expect(header).toMatchObject({ alg: "EdDSA", typ: "JWT" });
    expect(header.kid).toBe(keys.jwks().keys[0].kid);

    const parsed = TokenPayloadSchema.parse(payload);
    expect(parsed.sub).toBe(USER); // the schema decodes the base64url UUID
    expect(payload.sub).toBe(uuidToBase64url(USER));
    expect(base64urlToUuid(payload.sub)).toBe(USER);
    expect(parsed.iss).toBe(ISSUER);
    expect(parsed.aud).toBe(AUDIENCE);
    expect(parsed.provider).toBe("guest");
    expect(parsed.role).toBeUndefined();
    expect(parsed.exp - parsed.iat).toBe(900);
    expect(payload.sid).toBe("family-1");
    expect(
      new Set([
        payload.jti,
        await tokens
          .issue({ userId: USER, role: null, provider: "guest", sid: "f" })
          .then(
            (t) =>
              JSON.parse(
                Buffer.from(t.jwt.split(".")[1], "base64url").toString(),
              ).jti,
          ),
      ]).size,
    ).toBe(2);
  });

  it("carries a role only when there is one (banned, staff)", async () => {
    const tokens = new TokenService(
      await createEphemeralKeyRing(),
      ISSUER,
      AUDIENCE,
    );
    for (const role of ["banned", "admin", "mod"]) {
      const { jwt } = await tokens.issue({
        userId: USER,
        role,
        provider: "discord",
        sid: "f",
      });
      expect((await tokens.verify(jwt)).role).toBe(role);
    }
  });

  it("verifies its own tokens and returns the user, session and role", async () => {
    const tokens = new TokenService(
      await createEphemeralKeyRing(),
      ISSUER,
      AUDIENCE,
    );
    const { jwt } = await tokens.issue({
      userId: USER,
      role: "banned",
      provider: "google",
      sid: "fam",
    });
    expect(await tokens.verify(jwt)).toMatchObject({
      userId: USER,
      role: "banned",
      provider: "google",
      sid: "fam",
    });
  });

  it("refuses wrong issuer, wrong audience, another key, expiry, tampering and junk", async () => {
    const keys = await createEphemeralKeyRing();
    const tokens = new TokenService(keys, ISSUER, AUDIENCE);
    const { jwt } = await tokens.issue({
      userId: USER,
      role: null,
      provider: "guest",
      sid: "f",
    });
    const args = { userId: USER, role: null, provider: "guest", sid: "f" };

    const other = async (t: TokenService) => (await t.issue(args)).jwt;
    const bad: Record<string, string> = {
      issuer: await other(
        new TokenService(keys, "https://api.evil.example", AUDIENCE),
      ),
      audience: await other(new TokenService(keys, ISSUER, "evil.example")),
      "another key": await other(
        new TokenService(await createEphemeralKeyRing(), ISSUER, AUDIENCE),
      ),
      expired: await keys.sign(
        {
          jti: "x",
          sub: uuidToBase64url(USER),
          iss: ISSUER,
          aud: AUDIENCE,
        } as never,
        -60,
      ),
      tampered: `${jwt.split(".")[0]}.${Buffer.from(JSON.stringify({ sub: "x" })).toString("base64url")}.${jwt.split(".")[2]}`,
      junk: "a.b.c",
      empty: "",
    };
    for (const [why, token] of Object.entries(bad)) {
      await expect(tokens.verify(token), why).rejects.toBeInstanceOf(
        TokenError,
      );
    }
  });

  it("refuses a validly signed token whose claims are not the contract (bad subject)", async () => {
    const keys = await createEphemeralKeyRing();
    const tokens = new TokenService(keys, ISSUER, AUDIENCE);
    const notUuid = await keys.sign(
      {
        jti: "x",
        sub: "not-a-base64-uuid!",
        iss: ISSUER,
        aud: AUDIENCE,
      } as never,
      60,
    );
    await expect(tokens.verify(notUuid)).rejects.toBeInstanceOf(TokenError);
  });
});

describe("the key ring and JWKS", () => {
  it("publishes only the public half of the current key", async () => {
    const keys = await createEphemeralKeyRing();
    const { keys: published } = keys.jwks();
    expect(published).toHaveLength(1);
    expect(Object.keys(published[0]).sort()).toEqual([
      "alg",
      "crv",
      "kid",
      "kty",
      "use",
      "x",
    ]);
    expect(published[0]).toMatchObject({
      kty: "OKP",
      crv: "Ed25519",
      alg: "EdDSA",
      use: "sig",
    });
  });

  it("lists a previous public key after the current one, and still verifies tokens signed with it", async () => {
    const oldPair = await generateKeyPair("EdDSA", {
      crv: "Ed25519",
      extractable: true,
    });
    const newPair = await generateKeyPair("EdDSA", {
      crv: "Ed25519",
      extractable: true,
    });
    const before = await createKeyRing(oldPair.privateKey);
    const afterRotation = await createKeyRing(newPair.privateKey, [
      oldPair.publicKey,
    ]);

    const [current, previous] = afterRotation.jwks().keys;
    expect(current.kid).not.toBe(previous.kid);
    expect(previous.kid).toBe(before.jwks().keys[0].kid);

    const oldToken = await before.sign({ jti: "o", sub: "s" } as never, 60);
    expect(
      (await afterRotation.verify(oldToken, "", "").catch((e) => e)).message ??
        "",
    ).toBeDefined();
    const withClaims = await before.sign(
      { jti: "o2", iss: ISSUER, aud: AUDIENCE } as never,
      60,
    );
    expect((await afterRotation.verify(withClaims, ISSUER, AUDIENCE)).jti).toBe(
      "o2",
    );
  });

  it("is not tricked by a token that names a different key id", async () => {
    const keys = await createEphemeralKeyRing();
    const attacker = await generateKeyPair("EdDSA", { crv: "Ed25519" });
    const forged = await new SignJWT({ jti: "f", iss: ISSUER, aud: AUDIENCE })
      .setProtectedHeader({ alg: "EdDSA", kid: keys.jwks().keys[0].kid })
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(attacker.privateKey);
    await expect(keys.verify(forged, ISSUER, AUDIENCE)).rejects.toThrow();
  });
});

describe("loading signing keys", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "df-keys-"));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("reads a PKCS#8 Ed25519 private key file, and a previous SPKI public key", async () => {
    const current = await generateKeyPair("EdDSA", {
      crv: "Ed25519",
      extractable: true,
    });
    const previous = await generateKeyPair("EdDSA", {
      crv: "Ed25519",
      extractable: true,
    });
    fs.writeFileSync(
      path.join(dir, "k.pem"),
      await exportPKCS8(current.privateKey),
    );
    fs.writeFileSync(
      path.join(dir, "old.pem"),
      await exportSPKI(previous.publicKey),
    );
    const ring = await loadKeyRing({
      privateKeyPath: path.join(dir, "k.pem"),
      previousPublicKeyPath: path.join(dir, "old.pem"),
      devKeyDir: null,
    });
    expect(ring.jwks().keys).toHaveLength(2);
  });

  it("fails clearly, without echoing the path or contents, for a missing, malformed or non-Ed25519 key", async () => {
    await expect(
      loadKeyRing({
        privateKeyPath: path.join(dir, "missing.pem"),
        previousPublicKeyPath: null,
        devKeyDir: null,
      }),
    ).rejects.toThrow(
      /JWT_PRIVATE_KEY_PATH points to a file that cannot be read/,
    );
    fs.writeFileSync(
      path.join(dir, "junk.pem"),
      "-----BEGIN PRIVATE KEY-----\nSECRETJUNK\n-----END PRIVATE KEY-----",
    );
    const junk = loadKeyRing({
      privateKeyPath: path.join(dir, "junk.pem"),
      previousPublicKeyPath: null,
      devKeyDir: null,
    });
    await expect(junk).rejects.toBeInstanceOf(KeyError);
    await expect(junk).rejects.not.toThrow(/SECRETJUNK/);
    const rsa = await generateKeyPair("RS256", { extractable: true });
    fs.writeFileSync(
      path.join(dir, "rsa.pem"),
      await exportPKCS8(rsa.privateKey),
    );
    await expect(
      loadKeyRing({
        privateKeyPath: path.join(dir, "rsa.pem"),
        previousPublicKeyPath: null,
        devKeyDir: null,
      }),
    ).rejects.toBeInstanceOf(KeyError);
    await expect(
      loadKeyRing({
        privateKeyPath: null,
        previousPublicKeyPath: null,
        devKeyDir: null,
      }),
    ).rejects.toThrow(/no signing key/);
  });

  it("in dev, creates a key once (private permissions) and reuses it on every later start", async () => {
    const devDir = path.join(dir, "dev");
    const first = await loadKeyRing({
      privateKeyPath: null,
      previousPublicKeyPath: null,
      devKeyDir: devDir,
    });
    const second = await loadKeyRing({
      privateKeyPath: null,
      previousPublicKeyPath: null,
      devKeyDir: devDir,
    });
    expect(second.jwks().keys[0].kid).toBe(first.jwks().keys[0].kid);
    const file = path.join(devDir, "jwt-ed25519.pem");
    expect(fs.statSync(file).mode & 0o077).toBe(0); // owner only
    expect(fs.readFileSync(file, "utf8")).toMatch(/BEGIN PRIVATE KEY/);
  });
});

/**
 * The tokens this API issues must pass the game server's own admission code,
 * unchanged (src/server/jwt.ts verifyClientToken). It fetches the JWKS from
 * the issuer URL and pins issuer and audience from DOMAIN.
 */
describe("tokens against the game server's verifyClientToken", () => {
  type ServerJwt = typeof import("../../src/server/jwt");
  let verifyClientToken: ServerJwt["verifyClientToken"];
  let keys: Awaited<ReturnType<typeof createEphemeralKeyRing>>;
  let tokens: TokenService;
  let jwksFetches: number;

  beforeEach(async () => {
    vi.resetModules();
    vi.stubEnv("DOMAIN", "localhost");
    keys = await createEphemeralKeyRing();
    tokens = new TokenService(keys, ISSUER, AUDIENCE);
    jwksFetches = 0;
    vi.stubGlobal("fetch", async (url: string) => {
      if (url === `${ISSUER}/.well-known/jwks.json`) {
        jwksFetches++;
        return new Response(JSON.stringify(keys.jwks()), { status: 200 });
      }
      return new Response("not found", { status: 404 });
    });
    ({ verifyClientToken } = await import("../../src/server/jwt"));
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("admits a guest and a signed-in player, with the account's persistent id", async () => {
    for (const provider of ["guest", "discord", "google"]) {
      const { jwt } = await tokens.issue({
        userId: USER,
        role: null,
        provider,
        sid: "f",
      });
      const result = await verifyClientToken(jwt);
      expect(result.type, provider).toBe("success");
      if (result.type === "success") {
        expect(result.persistentId).toBe(USER);
        expect(result.claims?.provider).toBe(provider);
      }
    }
  });

  it("surfaces the banned role so the join is closed", async () => {
    const { jwt } = await tokens.issue({
      userId: USER,
      role: "banned",
      provider: "google",
      sid: "f",
    });
    const result = await verifyClientToken(jwt);
    expect(result.type === "success" && result.claims?.role).toBe("banned");
  });

  it("rejects forged, wrong-issuer, wrong-audience, expired and garbage tokens", async () => {
    const args = { userId: USER, role: null, provider: "guest", sid: "f" };
    const forged = (
      await new TokenService(
        await createEphemeralKeyRing(),
        ISSUER,
        AUDIENCE,
      ).issue(args)
    ).jwt;
    const wrongIssuer = (
      await new TokenService(keys, "https://api.evil.example", AUDIENCE).issue(
        args,
      )
    ).jwt;
    const wrongAudience = (
      await new TokenService(keys, ISSUER, "evil.example").issue(args)
    ).jwt;
    const expired = await keys.sign(
      {
        jti: "e",
        sub: uuidToBase64url(USER),
        iss: ISSUER,
        aud: AUDIENCE,
      } as never,
      -60,
    );
    for (const [why, token] of Object.entries({
      forged,
      wrongIssuer,
      wrongAudience,
      expired,
      garbage: "x.y.z",
      empty: "",
    })) {
      const result = await verifyClientToken(token);
      expect(result.type, why).toBe("error");
    }
  });

  it("keeps verifying tokens from the previous key while the rotated key set lists both", async () => {
    const oldToken = (
      await tokens.issue({
        userId: USER,
        role: null,
        provider: "guest",
        sid: "f",
      })
    ).jwt;
    expect((await verifyClientToken(oldToken)).type).toBe("success");
    expect(jwksFetches).toBe(1);
  });
});
