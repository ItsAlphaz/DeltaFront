import { AUTH_PROVIDERS } from "@openfront/shared/AccountFeatures";
import express, { type Request, type Response, type Router } from "express";
import { timingSafeEqual } from "node:crypto";
import {
  clearCookie,
  OAUTH_COOKIE,
  parseCookies,
  REFRESH_COOKIE,
  REFRESH_COOKIE_MAX_AGE_SECONDS,
  serializeCookie,
} from "../auth/cookies";
import {
  validateRedirectUri,
  withLoginResult,
  type LoginResult,
} from "../auth/redirects";
import { completeSignIn, signedInUser } from "../auth/signIn";
import { withTransaction } from "../db/tx";
import { clientIp, requireAllowedOrigin } from "../http";
import {
  consumeOAuthState,
  newOAuthState,
  newPkceVerifier,
  OAUTH_STATE_TTL_MS,
  saveOAuthState,
} from "../repo/oauthStates";
import {
  createSession,
  findSession,
  hashIp,
  liveSession,
  revokeAllForUser,
  revokeFamily,
  rotateSession,
} from "../repo/sessions";
import {
  activeBan,
  createUser,
  getUser,
  identitiesOf,
  roleClaim,
  touchLastSeen,
} from "../repo/users";
import { authenticate, cookieSecure, type AppDeps } from "./common";

/** The `provider` claim: how this account signs in. Guests have no identity. */
async function providerClaim(deps: AppDeps, userId: string): Promise<string> {
  const identities = await identitiesOf(deps.pool, userId);
  return identities.length === 0 ? "guest" : identities[0].provider;
}

async function issueAccessToken(
  deps: AppDeps,
  userId: string,
  familyId: string,
) {
  const user = await getUser(deps.pool, userId);
  if (user === null || user.deletedAt !== null) return null;
  const ban = await activeBan(deps.pool, userId);
  return deps.tokens.issue({
    userId,
    role: roleClaim(user, ban),
    provider: await providerClaim(deps, userId),
    sid: familyId,
  });
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export function authRouter(deps: AppDeps): Router {
  const { config, pool, log, limiters, providers } = deps;
  const router = express.Router();
  const secure = cookieSecure(config);
  const sameOrigin = requireAllowedOrigin(config.allowedOrigins);

  const refreshCookie = (token: string) =>
    serializeCookie(REFRESH_COOKIE, token, {
      maxAgeSeconds: REFRESH_COOKIE_MAX_AGE_SECONDS,
      secure,
    });
  const clearRefreshCookie = () => clearCookie(REFRESH_COOKIE, { secure });

  router.use((_req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    next();
  });

  const sessionContext = (req: Request) => ({
    userAgent: req.get("user-agent") ?? null,
    ipHash: hashIp(clientIp(req)),
  });

  // ---------------------------------------------------------------- refresh
  // The heartbeat of every session, and where guests come from: a visitor
  // with no cookie gets a new guest account. A cookie that is revoked,
  // expired or reused is answered 401 (the client then signs out and the next
  // refresh, with the cookie cleared, mints a fresh guest).
  router.post("/auth/refresh", sameOrigin, async (req, res) => {
    const presented = parseCookies(req.headers.cookie)[REFRESH_COOKIE];
    const ctx = sessionContext(req);

    if (presented === undefined || presented === "") {
      const verdict = limiters.guestCreation.hit(clientIp(req));
      if (!verdict.allowed) {
        res.setHeader("Retry-After", String(verdict.retryAfterSeconds));
        res.status(429).json({ error: "rate_limited" });
        return;
      }
      const { user, session } = await withTransaction(pool, async (db) => {
        const created = await createUser(db, "guest");
        return {
          user: created,
          session: await createSession(db, created.id, ctx),
        };
      });
      const access = await deps.tokens.issue({
        userId: user.id,
        role: null,
        provider: "guest",
        sid: session.familyId,
      });
      res.append("Set-Cookie", refreshCookie(session.token));
      res.json(access);
      return;
    }

    const verdict = limiters.refresh.hit(clientIp(req));
    if (!verdict.allowed) {
      res.setHeader("Retry-After", String(verdict.retryAfterSeconds));
      res.status(429).json({ error: "rate_limited" });
      return;
    }
    const rotated = await rotateSession(pool, presented, ctx);
    if (rotated.kind === "invalid") {
      res.append("Set-Cookie", clearRefreshCookie());
      res.status(401).json({ error: "invalid_session" });
      return;
    }
    const access = await issueAccessToken(
      deps,
      rotated.userId,
      rotated.familyId,
    );
    if (access === null) {
      res.append("Set-Cookie", clearRefreshCookie());
      res.status(401).json({ error: "invalid_session" });
      return;
    }
    // "grace": a concurrent refresh already set the successor cookie in this
    // browser, so this response must not overwrite it with nothing.
    if (rotated.kind === "rotated")
      res.append("Set-Cookie", refreshCookie(rotated.token));
    void touchLastSeen(pool, rotated.userId).catch(() => undefined);
    res.json(access);
  });

  // ----------------------------------------------------------- logout/revoke
  router.post("/auth/logout", sameOrigin, async (req, res) => {
    const presented = parseCookies(req.headers.cookie)[REFRESH_COOKIE];
    if (presented) {
      const session = await findSession(pool, presented);
      if (session !== null)
        await revokeFamily(pool, session.familyId, "logout");
    }
    res.append("Set-Cookie", clearRefreshCookie());
    res.json({ ok: true });
  });

  router.post("/auth/revoke", sameOrigin, async (req, res) => {
    const presented = parseCookies(req.headers.cookie)[REFRESH_COOKIE];
    const session = presented ? await findSession(pool, presented) : null;
    res.append("Set-Cookie", clearRefreshCookie());
    if (session === null) {
      res.status(401).json({ error: "invalid_session" });
      return;
    }
    const revoked = await revokeAllForUser(pool, session.userId, "revoke_all");
    res.json({ ok: true, revoked });
  });

  // -------------------------------------------------------- OAuth: start
  /** Records the attempt and returns the provider URL; binds it to this browser with a cookie. */
  async function beginOAuth(
    res: Response,
    providerId: "discord" | "google",
    redirectUri: string,
    linkUserId: string | null,
  ): Promise<string> {
    const provider = providers[providerId]!;
    const state = newOAuthState();
    const codeVerifier = newPkceVerifier();
    await saveOAuthState(pool, state, {
      provider: providerId,
      redirectUri,
      pkceVerifier: codeVerifier,
      linkUserId,
    });
    // The state is also kept in a cookie only this browser has, and the
    // callback requires both to match: a callback URL an attacker obtained for
    // their own login cannot be replayed into someone else's browser.
    res.append(
      "Set-Cookie",
      serializeCookie(OAUTH_COOKIE, state, {
        maxAgeSeconds: OAUTH_STATE_TTL_MS / 1000,
        secure,
        path: "/auth/callback",
      }),
    );
    return provider.authorizeUrl({
      redirectUri: `${config.publicOrigin}/auth/callback/${providerId}`,
      state,
      codeVerifier,
    });
  }

  const isProviderId = (v: string): v is "discord" | "google" =>
    v === "discord" || v === "google";

  router.get("/auth/login/:provider", async (req, res) => {
    const name = String(req.params.provider);
    const redirectUri = validateRedirectUri(
      req.query.redirect_uri,
      config.allowedOrigins,
    );
    if (!isProviderId(name) || !AUTH_PROVIDERS[name]) {
      res.status(404).json({ error: "unknown_provider" });
      return;
    }
    // Never redirect anywhere we cannot vouch for, not even with an error.
    if (redirectUri === null) {
      res.status(400).json({ error: "invalid_redirect_uri" });
      return;
    }
    const verdict = limiters.oauthStart.hit(clientIp(req));
    if (!verdict.allowed) {
      res.setHeader("Retry-After", String(verdict.retryAfterSeconds));
      res.status(429).json({ error: "rate_limited" });
      return;
    }
    if (providers[name] === undefined) {
      // Enabled but not configured on this deployment.
      res.redirect(302, withLoginResult(redirectUri, "error"));
      return;
    }
    res.redirect(302, await beginOAuth(res, name, redirectUri, null));
  });

  // Linking (signed-in users): the client calls this with its bearer token and
  // navigates to the returned URL itself.
  router.get("/auth/link/:provider", async (req, res) => {
    const name = String(req.params.provider);
    if (name !== "google" || !AUTH_PROVIDERS.google) {
      res.status(404).json({ error: "unknown_provider" });
      return;
    }
    const claims = await authenticate(req, deps);
    if (claims === null) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    const redirectUri = validateRedirectUri(
      req.query.redirect_uri,
      config.allowedOrigins,
    );
    if (redirectUri === null) {
      res.status(400).json({ error: "invalid_redirect_uri" });
      return;
    }
    const verdict = limiters.oauthStart.hit(clientIp(req));
    if (!verdict.allowed) {
      res.setHeader("Retry-After", String(verdict.retryAfterSeconds));
      res.status(429).json({ error: "rate_limited" });
      return;
    }
    if (providers.google === undefined) {
      res.status(404).json({ error: "unknown_provider" });
      return;
    }
    res.json({
      url: await beginOAuth(res, "google", redirectUri, claims.userId),
    });
  });

  // ----------------------------------------------------- OAuth: callback
  router.get("/auth/callback/:provider", async (req, res) => {
    const name = String(req.params.provider);
    const state = typeof req.query.state === "string" ? req.query.state : "";
    const bound = parseCookies(req.headers.cookie)[OAUTH_COOKIE] ?? "";
    // One try per attempt, whatever happens next.
    res.append(
      "Set-Cookie",
      clearCookie(OAUTH_COOKIE, { secure, path: "/auth/callback" }),
    );

    // Until the state checks out we do not know where to send the browser, and
    // must not trust anything in the request: answer plainly.
    if (state === "" || bound === "" || !safeEqual(state, bound)) {
      res.status(400).json({ error: "invalid_state" });
      return;
    }
    const record = await consumeOAuthState(pool, state);
    if (record === null || record.provider !== name) {
      res.status(400).json({ error: "invalid_state" });
      return;
    }

    const fail = (result: LoginResult) =>
      res.redirect(302, withLoginResult(record.redirectUri, result));

    if (typeof req.query.error === "string") {
      fail(req.query.error === "access_denied" ? "cancel" : "error");
      return;
    }
    const code = typeof req.query.code === "string" ? req.query.code : "";
    const provider = isProviderId(name) ? providers[name] : undefined;
    if (code === "" || provider === undefined) {
      fail("error");
      return;
    }

    let identity;
    try {
      identity = await provider.exchange({
        code,
        redirectUri: `${config.publicOrigin}/auth/callback/${name}`,
        codeVerifier: record.pkceVerifier,
      });
    } catch (error) {
      log.warn("OAuth exchange failed", {
        provider: name,
        error: error instanceof Error ? error.message : "unknown",
      });
      fail("error");
      return;
    }

    const presented = parseCookies(req.headers.cookie)[REFRESH_COOKIE];
    const current = presented ? await liveSession(pool, presented) : null;
    const result = await completeSignIn(pool, identity, {
      currentUserId: current?.userId ?? null,
      linkUserId: record.linkUserId,
    });
    if (result.outcome === "email_exists" || result.outcome === "deleted") {
      fail(result.outcome);
      return;
    }
    const userId = signedInUser(result)!;

    // The same person stays on their session (linking, or a guest upgraded in
    // place); a different account gets a fresh one and the old family ends.
    if (current === null || current.userId !== userId) {
      const ctx = sessionContext(req);
      const session = await withTransaction(pool, async (db) => {
        if (current !== null)
          await revokeFamily(db, current.familyId, "sign_in");
        return createSession(db, userId, ctx);
      });
      res.append("Set-Cookie", refreshCookie(session.token));
    }
    res.redirect(302, record.redirectUri);
  });

  return router;
}
