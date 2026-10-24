import {
  CustomSkinBodySchema,
  MAX_CUSTOM_SKINS,
  ownsSkinCreator,
} from "@openfront/shared/CustomSkins";
import express, { type Request, type Response, type Router } from "express";
import type { Catalog } from "../catalog/load";
import {
  customSkinsOf,
  deleteCustomSkin,
  saveCustomSkin,
} from "../repo/customSkins";
import { activeFlaresOf, reportedFlares } from "../repo/inventory";
import { activeBan, getUser } from "../repo/users";
import { authenticate, jsonBody, type AppDeps } from "./common";

/**
 * The "Create Your Own" skin creator's saved designs.
 *
 *   PUT    /users/@me/skins/:slot   { name, patternData, primaryColor, secondaryColor }
 *   DELETE /users/@me/skins/:slot
 *
 * Both answer `{ customSkins }`, the account's whole list afterwards. Saving
 * needs the creator: the account must own the shop item (its flare), so a
 * request from an account that does not is a 403 `NOT_OWNED`. A design is
 * validated here with the same schema the game server applies at join, and the
 * slot, like everything else, is the account's own: the account is the
 * signed-in one and nothing in the body names another.
 */
export function customSkinsRouter(
  deps: AppDeps & { catalog: Catalog },
): Router {
  const { pool, limiters, catalog } = deps;
  const router = express.Router();

  /** The signed-in, registered, not banned account behind a request, or null (the response is sent). */
  async function account(req: Request, res: Response) {
    res.setHeader("Cache-Control", "no-store");
    const claims = await authenticate(req, deps);
    const user = claims === null ? null : await getUser(pool, claims.userId);
    if (user === null || user.deletedAt !== null) {
      res.status(401).json({ error: "unauthorized" });
      return null;
    }
    const verdict = limiters.skinWrite.hit(user.id);
    if (!verdict.allowed) {
      res.setHeader("Retry-After", String(verdict.retryAfterSeconds));
      res.status(429).json({ error: "rate_limited" });
      return null;
    }
    if (user.kind === "guest") {
      res.status(403).json({ code: "LOGIN_REQUIRED" });
      return null;
    }
    if ((await activeBan(pool, user.id)) !== null) {
      res.status(403).json({ code: "BANNED" });
      return null;
    }
    return user;
  }

  const slotOf = (req: Request): number | null => {
    const slot = Number(req.params.slot);
    return Number.isInteger(slot) && slot >= 0 && slot < MAX_CUSTOM_SKINS
      ? slot
      : null;
  };

  router.put("/users/@me/skins/:slot", jsonBody("4kb"), async (req, res) => {
    const user = await account(req, res);
    if (user === null) return;
    const slot = slotOf(req);
    if (slot === null) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const owned = reportedFlares(catalog, await activeFlaresOf(pool, user.id));
    if (!ownsSkinCreator(owned)) {
      res.status(403).json({ code: "NOT_OWNED" });
      return;
    }
    const body = CustomSkinBodySchema.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: "invalid_design" });
      return;
    }
    await saveCustomSkin(pool, user.id, slot, body.data);
    res.json({ customSkins: await customSkinsOf(pool, user.id) });
  });

  router.delete("/users/@me/skins/:slot", async (req, res) => {
    const user = await account(req, res);
    if (user === null) return;
    const slot = slotOf(req);
    if (slot === null) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    await deleteCustomSkin(pool, user.id, slot);
    res.json({ customSkins: await customSkinsOf(pool, user.id) });
  });

  return router;
}
