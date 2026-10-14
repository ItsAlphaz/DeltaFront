import {
  ClanGameFilterSchema,
  type ClanBansResponse,
  type ClanGamesResponse,
  type ClanInfo,
  type ClanLeaderboardResponse,
  type ClanMembersResponse,
  type ClanRequestsResponse,
  type JoinClanResponse,
} from "@openfront/shared/ClanApiSchemas";
import express, {
  type NextFunction,
  type Request,
  type Response,
  type Router,
} from "express";
import * as ops from "../domain/clanOps";
import { ClanError } from "../domain/clanOps";
import {
  can,
  mayCreateOfficialClans,
  pageParams,
  tagFromRoute,
} from "../domain/clans";
import { CLAN_RULES } from "../domain/constants";
import { clientIp } from "../http";
import {
  bansPage,
  browseClans,
  clanByTag,
  clanGamesPage,
  clanLeaderboard,
  isMemberSort,
  membersPage,
  pendingRequestCount,
  requestsPage,
  roleIn,
  tagIsRegistered,
  toClanInfo,
  type ClanRow,
} from "../repo/clans";
import { activeBan, getUser, type UserRow } from "../repo/users";
import { authenticate, jsonBody, type AppDeps } from "./common";
import { decodeCursor, encodeCursor } from "./profile";

/**
 * The clan API (docs/DeltaFrontAccountsPlan.md sections 4.5 and 12), served
 * with the `clans` feature. The paths and shapes are the ones the existing
 * client already speaks, plus `POST /clans`.
 *
 * Who may do what is decided in domain/clans.ts (`can`) and enforced inside the
 * transaction that changes anything (domain/clanOps.ts); the routes only
 * authenticate, rate-limit and translate. The browser never sends a role: it
 * sends a tag in the URL and a `targetPublicId`, and the server looks up
 * everything else.
 */
export function clansRouter(deps: AppDeps): Router {
  const { pool, limiters, reserved } = deps;
  const router = express.Router();

  const publicRead = (
    req: Request,
    res: Response,
    next: NextFunction,
  ): void => {
    const verdict = limiters.publicRead.hit(clientIp(req));
    if (!verdict.allowed) {
      res.setHeader("Retry-After", String(verdict.retryAfterSeconds));
      res.status(429).json({ error: "rate_limited" });
      return;
    }
    next();
  };

  /** A handler that turns a ClanError into its response. */
  const handle =
    (fn: (req: Request, res: Response) => Promise<void>) =>
    async (req: Request, res: Response): Promise<void> => {
      res.setHeader("Cache-Control", "no-store");
      try {
        await fn(req, res);
      } catch (error) {
        if (error instanceof ClanError) {
          res.status(error.status).json(error.body);
          return;
        }
        throw error;
      }
    };

  /** The signed-in, registered, live account behind the bearer, or a response has been sent. */
  async function member(
    req: Request,
    res: Response,
    options: { write: boolean },
  ): Promise<UserRow | null> {
    const claims = await authenticate(req, deps);
    const user = claims === null ? null : await getUser(pool, claims.userId);
    if (
      user === null ||
      user.deletedAt !== null ||
      user.deletionRequestedAt !== null
    ) {
      res.status(401).json({ error: "unauthorized" });
      return null;
    }
    if (user.kind === "guest") {
      res.status(403).json({ code: "LOGIN_REQUIRED" });
      return null;
    }
    if (options.write) {
      const ban = await activeBan(pool, user.id);
      if (ban !== null) {
        res.status(403).json({ code: "BANNED" });
        return null;
      }
      const verdict = limiters.clanWrite.hit(user.id);
      if (!verdict.allowed) {
        res.setHeader("Retry-After", String(verdict.retryAfterSeconds));
        res.status(429).json({ code: "RATE_LIMITED" });
        return null;
      }
    }
    return user;
  }

  /** A live clan by the tag in the URL, or a 404 has been sent. */
  async function clanOf(req: Request, res: Response): Promise<ClanRow | null> {
    const tag = tagFromRoute(String(req.params.tag));
    const clan = tag === null ? null : await clanByTag(pool, tag);
    if (clan === null) {
      res.status(404).json({ code: "CLAN_NOT_FOUND" });
      return null;
    }
    return clan;
  }

  const tagParam = (req: Request): string =>
    tagFromRoute(String(req.params.tag)) ?? "";

  // --------------------------------------------------------------- reads

  router.get(
    "/clans",
    publicRead,
    handle(async (req, res) => {
      const { page, limit } = pageParams(req.query);
      const raw =
        typeof req.query.search === "string" ? req.query.search.trim() : "";
      const search = raw.length >= 2 && raw.length <= 50 ? raw : null;
      const found = await browseClans(pool, search, page, limit);
      res.json({
        results: found.results.map(toClanInfo),
        total: found.total,
        page,
        limit,
      });
    }),
  );

  router.get(
    "/clans/:tag",
    publicRead,
    handle(async (req, res) => {
      const clan = await clanOf(req, res);
      if (clan === null) return;
      const info: ClanInfo = toClanInfo(clan);
      res.json(info);
    }),
  );

  router.get("/public/clan/:tag/exists", publicRead, async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    const tag = tagFromRoute(String(req.params.tag));
    const exists = tag !== null && (await tagIsRegistered(pool, reserved, tag));
    res.status(exists ? 200 : 404).json({ exists });
  });

  router.get("/public/clans/leaderboard", publicRead, async (_req, res) => {
    res.setHeader("Cache-Control", "public, max-age=60");
    const board = await clanLeaderboard(pool);
    const body: ClanLeaderboardResponse = {
      start: board.start.toISOString(),
      end: board.end.toISOString(),
      clans: board.clans,
      total: board.clans.length,
      limit: CLAN_RULES.leaderboardSize,
    };
    res.json(body);
  });

  router.get(
    "/clans/:tag/members",
    handle(async (req, res) => {
      const user = await member(req, res, { write: false });
      if (user === null) return;
      const clan = await clanOf(req, res);
      if (clan === null) return;
      const role = await roleIn(pool, clan.id, user.id);
      if (!can(role, "viewMembers")) {
        res.status(403).json({ code: "NOT_A_MEMBER" });
        return;
      }
      const { page, limit } = pageParams(req.query);
      const sort = req.query.sort ?? "default";
      const order = req.query.order ?? null;
      const search =
        typeof req.query.search === "string" ? req.query.search.trim() : "";
      if (
        !isMemberSort(sort) ||
        (order !== null && order !== "asc" && order !== "desc") ||
        search.length > 50
      ) {
        res.status(400).json({ code: "INVALID_REQUEST" });
        return;
      }
      const found = await membersPage(pool, clan.id, {
        page,
        limit,
        sort,
        order,
        search: search === "" ? null : search,
      });
      const body: ClanMembersResponse = {
        results: found.results,
        total: found.total,
        page,
        limit,
        ...(can(role, "viewRequests")
          ? { pendingRequests: await pendingRequestCount(pool, clan.id) }
          : {}),
      };
      res.json(body);
    }),
  );

  router.get(
    "/clans/:tag/requests",
    handle(async (req, res) => {
      const user = await member(req, res, { write: false });
      if (user === null) return;
      const clan = await clanOf(req, res);
      if (clan === null) return;
      if (!can(await roleIn(pool, clan.id, user.id), "viewRequests")) {
        res.status(403).json({ code: "FORBIDDEN" });
        return;
      }
      const { page, limit } = pageParams(req.query);
      const found = await requestsPage(pool, clan.id, page, limit);
      const body: ClanRequestsResponse = { ...found, page, limit };
      res.json(body);
    }),
  );

  router.get(
    "/clans/:tag/bans",
    handle(async (req, res) => {
      const user = await member(req, res, { write: false });
      if (user === null) return;
      const clan = await clanOf(req, res);
      if (clan === null) return;
      if (!can(await roleIn(pool, clan.id, user.id), "viewBans")) {
        res.status(403).json({ code: "FORBIDDEN" });
        return;
      }
      const { page, limit } = pageParams(req.query);
      const found = await bansPage(pool, clan.id, page, limit);
      const body: ClanBansResponse = { ...found, page, limit };
      res.json(body);
    }),
  );

  router.get(
    "/clans/:tag/games",
    handle(async (req, res) => {
      const user = await member(req, res, { write: false });
      if (user === null) return;
      const clan = await clanOf(req, res);
      if (clan === null) return;
      if (!can(await roleIn(pool, clan.id, user.id), "viewGames")) {
        res.status(403).json({ code: "NOT_A_MEMBER" });
        return;
      }
      const filter =
        req.query.filter === undefined
          ? undefined
          : ClanGameFilterSchema.safeParse(req.query.filter);
      if (filter?.success === false) {
        res.status(400).json({ code: "INVALID_REQUEST" });
        return;
      }
      let before: string | null = null;
      if (req.query.cursor !== undefined) {
        before =
          typeof req.query.cursor === "string"
            ? decodeCursor(req.query.cursor)
            : null;
        if (before === null) {
          res.status(400).json({ code: "INVALID_REQUEST" });
          return;
        }
      }
      const found = await clanGamesPage(
        pool,
        clan.id,
        filter?.data,
        before,
        CLAN_RULES.gamesPageSize,
      );
      const last = found.games[found.games.length - 1];
      const body: ClanGamesResponse = {
        results: found.games.map(({ id: _id, ...game }) => game),
        nextCursor:
          found.hasMore && last !== undefined ? encodeCursor(last.id) : null,
      };
      res.json(body);
    }),
  );

  // -------------------------------------------------------------- writes

  router.post(
    "/clans",
    jsonBody("4kb"),
    handle(async (req, res) => {
      const user = await member(req, res, { write: true });
      if (user === null) return;
      // Only clans that were created count: a mistyped tag is not a day lost.
      const created = limiters.clanCreate.isExhausted(user.id);
      if (!created.allowed) {
        res.setHeader("Retry-After", String(created.retryAfterSeconds));
        res.status(429).json({ code: "RATE_LIMITED" });
        return;
      }
      const input = (req.body ?? {}) as Record<string, unknown>;
      if (typeof input !== "object" || Array.isArray(input)) {
        res.status(400).json({ code: "INVALID_REQUEST" });
        return;
      }
      // Staff who may create official clans skip the account-age and
      // completed-games thresholds and may use reserved tags and names. The
      // right comes from the account's stored role, never from the request;
      // verification and a bare-name entitlement grant no such right.
      const official = mayCreateOfficialClans(user);
      const tag = await ops.createClan(
        pool,
        { id: user.id, createdAt: user.createdAt },
        {
          name: input.name,
          tag: input.tag,
          description: input.description,
          isOpen: input.isOpen,
        },
        reserved,
        undefined,
        { bypassEligibility: official, bypassReserved: official },
      );
      limiters.clanCreate.hit(user.id);
      const clan = await clanByTag(pool, tag);
      res.status(201).json(clan === null ? {} : toClanInfo(clan));
    }),
  );

  router.post(
    "/clans/:tag/join",
    handle(async (req, res) => {
      const user = await member(req, res, { write: true });
      if (user === null) return;
      const status = await ops.joinClan(pool, user, tagParam(req));
      const body: JoinClanResponse = { status };
      res.json(body);
    }),
  );

  router.post(
    "/clans/:tag/leave",
    handle(async (req, res) => {
      const user = await member(req, res, { write: true });
      if (user === null) return;
      await ops.leaveClan(pool, user, tagParam(req));
      res.json({});
    }),
  );

  router.delete(
    "/clans/:tag",
    handle(async (req, res) => {
      const user = await member(req, res, { write: true });
      if (user === null) return;
      await ops.disbandClan(pool, user, tagParam(req));
      res.json({});
    }),
  );

  router.patch(
    "/clans/:tag",
    jsonBody("4kb"),
    handle(async (req, res) => {
      const user = await member(req, res, { write: true });
      if (user === null) return;
      const body = req.body;
      if (typeof body !== "object" || body === null || Array.isArray(body)) {
        res.status(400).json({ code: "INVALID_REQUEST" });
        return;
      }
      // Only these four fields are read: a role, tag or anything else in the body is ignored.
      const patch = body as Record<string, unknown>;
      await ops.updateClan(
        pool,
        user,
        tagParam(req),
        {
          name: patch.name,
          description: patch.description,
          discordUrl: patch.discordUrl,
          isOpen: patch.isOpen,
        },
        reserved,
      );
      const clan = await clanByTag(pool, tagParam(req));
      res.json(clan === null ? {} : toClanInfo(clan));
    }),
  );

  const targeted = (
    action: (
      pool: AppDeps["pool"],
      actor: { id: string },
      tag: string,
      target: unknown,
    ) => Promise<void>,
  ) =>
    handle(async (req, res) => {
      const user = await member(req, res, { write: true });
      if (user === null) return;
      const body = req.body as { targetPublicId?: unknown } | undefined;
      await action(pool, user, tagParam(req), body?.targetPublicId);
      res.json({});
    });

  router.post("/clans/:tag/kick", jsonBody("2kb"), targeted(ops.kickMember));
  router.post(
    "/clans/:tag/promote",
    jsonBody("2kb"),
    targeted(ops.promoteMember),
  );
  router.post(
    "/clans/:tag/demote",
    jsonBody("2kb"),
    targeted(ops.demoteMember),
  );
  router.post(
    "/clans/:tag/transfer",
    jsonBody("2kb"),
    targeted(ops.transferLeadership),
  );
  router.post(
    "/clans/:tag/requests/approve",
    jsonBody("2kb"),
    targeted(ops.approveRequest),
  );
  router.post(
    "/clans/:tag/requests/deny",
    jsonBody("2kb"),
    targeted(ops.denyRequest),
  );
  router.post("/clans/:tag/unban", jsonBody("2kb"), targeted(ops.unbanMember));

  router.post(
    "/clans/:tag/requests/withdraw",
    handle(async (req, res) => {
      const user = await member(req, res, { write: true });
      if (user === null) return;
      await ops.withdrawRequest(pool, user, tagParam(req));
      res.json({});
    }),
  );

  router.post(
    "/clans/:tag/ban",
    jsonBody("2kb"),
    handle(async (req, res) => {
      const user = await member(req, res, { write: true });
      if (user === null) return;
      const body = (req.body ?? {}) as {
        targetPublicId?: unknown;
        reason?: unknown;
      };
      await ops.banMember(
        pool,
        user,
        tagParam(req),
        body.targetPublicId,
        body.reason,
      );
      res.json({});
    }),
  );

  return router;
}
