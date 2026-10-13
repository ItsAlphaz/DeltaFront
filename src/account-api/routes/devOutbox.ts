import express, { type Router } from "express";
import type { DevMailer } from "../auth/email";

/**
 * Development only: reads back the sign-in emails the in-memory `dev` mailer
 * "sent", so a developer (or a test) can open the link without a mail
 * server. It is mounted only when GAME_ENV=dev AND EMAIL_PROVIDER is `dev`
 * (app.ts), answers only to a connection from this machine, and the `dev`
 * provider itself is refused by the configuration anywhere else. There is no
 * production code path that exposes a link.
 */

const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

export function devOutboxRouter(mailer: DevMailer): Router {
  const router = express.Router();
  router.get("/dev/email-outbox", (req, res) => {
    if (!LOOPBACK.has(req.socket.remoteAddress ?? "")) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const email =
      typeof req.query.email === "string" ? req.query.email : undefined;
    res.json({ messages: mailer.outbox(email) });
  });
  return router;
}
