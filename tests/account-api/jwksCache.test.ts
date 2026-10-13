// @vitest-environment node
import { generateKeyPair, jwtVerify, SignJWT } from "jose";
import { describe, expect, it } from "vitest";
import {
  createEphemeralKeyRing,
  createKeyRing,
} from "../../src/account-api/auth/keys";
import {
  createJwksCache,
  JwksUnavailableError,
} from "../../src/server/JwksCache";

const ISS = "https://api.example.test";
const AUD = "example.test";

async function ring() {
  const { privateKey } = await generateKeyPair("EdDSA", {
    crv: "Ed25519",
    extractable: true,
  });
  return { privateKey, keys: await createKeyRing(privateKey) };
}

async function tokenFrom(keys: Awaited<ReturnType<typeof createKeyRing>>) {
  return keys.sign({ jti: "t", sub: "u", iss: ISS, aud: AUD }, 300);
}

/** A JWKS endpoint whose content and availability the test controls. */
function endpoint(initial: unknown) {
  const state = {
    body: initial as unknown,
    status: 200,
    fetches: 0,
    down: false,
  };
  const fetchFn = (async () => {
    state.fetches++;
    if (state.down) throw new Error("connection refused");
    return new Response(JSON.stringify(state.body), { status: state.status });
  }) as typeof fetch;
  return { state, fetchFn };
}

function setup(
  jwks: unknown,
  extra: Partial<Parameters<typeof createJwksCache>[0]> = {},
) {
  const clock = { t: 1_000_000 };
  const ep = endpoint(jwks);
  const cache = createJwksCache({
    url: `${ISS}/.well-known/jwks.json`,
    fetchFn: ep.fetchFn,
    now: () => clock.t,
    ...extra,
  });
  const verify = (token: string) =>
    jwtVerify(token, cache.getKey, {
      algorithms: ["EdDSA"],
      issuer: ISS,
      audience: AUD,
    });
  return { clock, ep, cache, verify };
}

describe("game server JWKS cache", () => {
  it("verifies with the current key and does not refetch for later joins", async () => {
    const { keys } = await ring();
    const { ep, verify } = setup(keys.jwks());
    await verify(await tokenFrom(keys));
    await verify(await tokenFrom(keys));
    await verify(await tokenFrom(keys));
    expect(ep.state.fetches).toBe(1);
  });

  it("verifies tokens from the previous key while both are published", async () => {
    const old = await ring();
    const next = await generateKeyPair("EdDSA", {
      crv: "Ed25519",
      extractable: true,
    });
    const rotated = await createKeyRing(next.privateKey, [old.privateKey]);
    const { verify } = setup(rotated.jwks());
    await verify(await tokenFrom(old.keys)); // signed before the rotation
    await verify(await tokenFrom(rotated)); // signed after it
  });

  it("rejects a token signed with a key that is not published, even with a copied kid", async () => {
    const { keys } = await ring();
    const attacker = await createEphemeralKeyRing();
    const { verify } = setup(keys.jwks());
    await expect(verify(await tokenFrom(attacker))).rejects.toThrow();
    // same kid as the real key, wrong signature
    const kid = keys.jwks().keys[0].kid;
    const { privateKey } = await generateKeyPair("EdDSA", {
      crv: "Ed25519",
    });
    const forged = await new SignJWT({ jti: "x" })
      .setProtectedHeader({ alg: "EdDSA", kid })
      .setIssuer(ISS)
      .setAudience(AUD)
      .setSubject("u")
      .setExpirationTime("5m")
      .sign(privateKey);
    await expect(verify(forged)).rejects.toThrow();
  });

  it("refreshes once when a token names an unknown kid, so a rotation is picked up", async () => {
    const first = await ring();
    const second = await ring();
    const { ep, verify } = setup(first.keys.jwks());
    await verify(await tokenFrom(first.keys));
    expect(ep.state.fetches).toBe(1);

    ep.state.body = second.keys.jwks(); // the API rotated
    await verify(await tokenFrom(second.keys));
    expect(ep.state.fetches).toBe(2);
  });

  it("rejects a token whose key was withdrawn once the cache has refreshed", async () => {
    const first = await ring();
    const second = await ring();
    const { ep, clock, verify } = setup(first.keys.jwks(), {
      maxAgeMs: 1000,
      unknownKidCooldownMs: 0,
    });
    const stale = await tokenFrom(first.keys);
    await verify(stale);

    ep.state.body = second.keys.jwks(); // overlap ended: first key is gone
    clock.t += 2000;
    await verify(await tokenFrom(second.keys)); // triggers the background refresh
    await new Promise((r) => setTimeout(r, 10));
    await expect(verify(stale)).rejects.toThrow();
  });

  it("does not let unknown kids flood the API: one refresh per cooldown", async () => {
    const { keys } = await ring();
    const { ep, clock, verify } = setup(keys.jwks(), {
      unknownKidCooldownMs: 30_000,
    });
    await verify(await tokenFrom(keys));
    const stranger = await createEphemeralKeyRing();
    for (let i = 0; i < 20; i++) {
      await expect(verify(await tokenFrom(stranger))).rejects.toThrow();
    }
    expect(ep.state.fetches).toBe(2); // the first load plus one lookup
    clock.t += 31_000;
    await expect(verify(await tokenFrom(stranger))).rejects.toThrow();
    expect(ep.state.fetches).toBe(3);
  });

  it("shares one fetch between concurrent joins", async () => {
    const { keys } = await ring();
    const { ep, verify } = setup(keys.jwks());
    const token = await tokenFrom(keys);
    await Promise.all(Array.from({ length: 10 }, () => verify(token)));
    expect(ep.state.fetches).toBe(1);
  });

  it("keeps admitting on cached keys while the API is down, up to the stale limit", async () => {
    const { keys } = await ring();
    const { ep, clock, verify } = setup(keys.jwks(), {
      maxAgeMs: 60_000,
      staleLimitMs: 3_600_000,
      retryAfterFailureMs: 1000,
    });
    const token = await tokenFrom(keys);
    await verify(token);

    ep.state.down = true;
    clock.t += 120_000; // past maxAge, within the stale limit
    await verify(token);
    await verify(token);

    clock.t += 3_600_000; // past the stale limit
    await expect(verify(token)).rejects.toBeInstanceOf(JwksUnavailableError);
  });

  it("recovers when the API comes back after being down", async () => {
    const { keys } = await ring();
    const { ep, clock, verify } = setup(keys.jwks(), {
      retryAfterFailureMs: 1000,
    });
    ep.state.down = true;
    const token = await tokenFrom(keys);
    await expect(verify(token)).rejects.toBeInstanceOf(JwksUnavailableError);
    // inside the back-off window nothing is fetched again
    const before = ep.state.fetches;
    await expect(verify(token)).rejects.toBeInstanceOf(JwksUnavailableError);
    expect(ep.state.fetches).toBe(before);

    ep.state.down = false;
    clock.t += 2000;
    await verify(token);
  });

  it("fails closed on an empty, malformed or non-EdDSA key set", async () => {
    const { keys } = await ring();
    const token = await tokenFrom(keys);
    for (const body of [
      { keys: [] },
      { keys: [{ kty: "RSA", kid: "x", n: "AQAB", e: "AQAB" }] },
      { nope: true },
      "text",
    ]) {
      const { verify } = setup(body);
      await expect(verify(token)).rejects.toBeInstanceOf(JwksUnavailableError);
    }
    const { ep, verify } = setup({}, {});
    ep.state.status = 503;
    await expect(verify(token)).rejects.toBeInstanceOf(JwksUnavailableError);
  });

  it("refresh() reports failure without throwing", async () => {
    const { keys } = await ring();
    const { ep, cache } = setup(keys.jwks());
    ep.state.down = true;
    expect(await cache.refresh()).toBe(false);
    ep.state.down = false;
    expect(await cache.refresh()).toBe(true);
    expect(cache.kids()).toEqual([keys.jwks().keys[0].kid]);
  });
});
