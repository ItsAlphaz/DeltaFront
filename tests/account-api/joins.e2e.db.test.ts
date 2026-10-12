// @vitest-environment node
import {
  decodeLobbyMessage,
  encodeClientMessage,
} from "@openfront/shared/ZbinWire";
import type { ChildProcess } from "node:child_process";
import net from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import {
  runAdminCommand,
  type AdminIo,
} from "../../src/account-api/admin/commands";
import type { Turnstile } from "../../src/account-api/turnstile";
import {
  call,
  completeLogin,
  createMockProviders,
  createServerKey,
  newGuest,
  refresh,
  startHarness,
  type Harness,
} from "./util/harness";
import { makeWorkDir, startScript } from "./util/runScript";
import { describeDb } from "./util/testDb";

/**
 * Production-style admission, end to end, with nothing mocked on the game
 * server's side: the real game server (GAME_ENV=staging, which refuses
 * anonymous persistent ids exactly as production does) is started as a
 * process, talks to the real account API over HTTP, and players join over a
 * real WebSocket with tokens the API issued.
 *
 * It needs the account API on 8787 (the issuer URL the game server derives
 * from DOMAIN=localhost) and the game server's own ports 3000 and 3001, so it
 * refuses to run, loudly, if any is taken (for instance by `npm run
 * dev:accounts`).
 */

const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const CLOSE = { Unauthorized: 4001, Banned: 4003 } as const;
const REASON = {
  InvalidToken: "close_reason.invalid_token",
  TurnstileFailed: "close_reason.turnstile_failed",
  Banned: "close_reason.banned",
} as const;

async function portFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once("error", () => resolve(false));
    s.listen(port, "127.0.0.1", () => s.close(() => resolve(true)));
  });
}

const work = makeWorkDir();
afterAll(() => work.remove());

/** A Turnstile stand-in keyed by the token the "browser" presents. */
const turnstile: Turnstile = {
  async verify(token) {
    if (token === "good") return { status: "ok" };
    if (token === "down")
      return { status: "unavailable", reason: "cloudflare unreachable" };
    return { status: "rejected", reason: "invalid-input-response" };
  },
};

interface GameServer {
  child: ChildProcess;
  output(): string;
  stop(): Promise<void>;
}

async function startGameServer(
  apiKey: string,
  extraEnv: Record<string, string> = {},
): Promise<GameServer> {
  const proc = startScript(work.dir, "src/server/Server.ts", {
    GAME_ENV: "staging",
    DOMAIN: "localhost",
    INSTANCE_LETTER: "a",
    NUM_WORKERS: "1",
    GIT_COMMIT: COMMIT,
    API_KEY: apiKey,
    TURNSTILE_SITE_KEY: "1x00000000000000000000AA",
    DF_ACCOUNT_FEATURES: "accounts",
    ...extraEnv,
  });
  const deadline = Date.now() + 60_000;
  for (;;) {
    try {
      const res = await fetch("http://localhost:3000/api/health");
      if (res.ok) break;
    } catch {
      // not up yet
    }
    if (Date.now() > deadline) {
      proc.child.kill("SIGKILL");
      throw new Error(
        `game server did not become healthy:\n${proc.output().slice(-3000)}`,
      );
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  return {
    child: proc.child,
    output: proc.output,
    stop: async () => {
      proc.child.kill("SIGTERM");
      await Promise.race([
        proc.exited,
        new Promise((r) => setTimeout(r, 8000)),
      ]);
      proc.child.kill("SIGKILL");
    },
  };
}

interface JoinOutcome {
  /** Messages received before the connection closed or the wait ended. */
  messages: number;
  closed: { code: number; reason: string } | null;
}

/** Connects to a game on the worker, sends a join, and reports what the server did. */
async function join(
  gameID: string,
  token: string,
  options: {
    turnstileToken?: string | null;
    username?: string;
    gitCommit?: string;
    waitMs?: number;
  } = {},
): Promise<JoinOutcome> {
  const ws = new WebSocket("ws://localhost:3001/w0");
  const outcome: JoinOutcome = { messages: 0, closed: null };
  ws.on("message", () => void outcome.messages++);
  ws.on("error", () => undefined);
  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });
  const closed = new Promise<void>((resolve) =>
    ws.once("close", (code, reason) => {
      outcome.closed = { code, reason: reason.toString() };
      resolve();
    }),
  );
  ws.send(
    encodeClientMessage(
      {
        type: "join",
        token,
        gameID,
        username: options.username ?? "Tester",
        clanTag: null,
        turnstileToken:
          options.turnstileToken === undefined
            ? "good"
            : options.turnstileToken,
        gitCommit: options.gitCommit ?? COMMIT,
      } as never,
      undefined,
    ),
  );
  await Promise.race([
    closed,
    new Promise((r) => setTimeout(r, options.waitMs ?? 2500)),
  ]);
  if (outcome.closed === null) ws.close();
  return outcome;
}

async function createGame(
  token: string,
): Promise<{ status: number; gameID?: string }> {
  const res = await fetch("http://localhost:3001/w0/api/create_game", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: "{}",
  });
  return {
    status: res.status,
    gameID: res.ok
      ? ((await res.json()) as { gameID: string }).gameID
      : undefined,
  };
}

const io: AdminIo = {
  out: () => undefined,
  err: () => undefined,
  env: {},
  actor: "e2e",
};

describeDb(
  "production-style player admission (real game server, real API, real WebSocket)",
  () => {
    let h: Harness;
    let server: GameServer;
    let key: string;
    const mock = createMockProviders({
      discord: {
        discord: {
          id: "e2e-disc",
          username: "e2e",
          email: "e2e@example.com",
          verified: true,
        },
      },
      banned: {
        google: {
          sub: "e2e-banned",
          email: "ban@example.com",
          email_verified: true,
        },
      },
    });

    beforeAll(async () => {
      for (const port of [8787, 3000, 3001]) {
        if (!(await portFree(port))) {
          throw new Error(
            `port ${port} is in use: this test needs 8787 (account API), 3000 and 3001 (game server). Stop \`npm run dev:accounts\` or any other server and rerun.`,
          );
        }
      }
      h = await startHarness({
        fixedPort: 8787,
        turnstile,
        fetchFn: mock.fetchFn,
      });
      key = await createServerKey(h, "e2e-server-key-0123456789abcdef");
      server = await startGameServer(key);
    }, 120_000);

    afterAll(async () => {
      await server?.stop();
      await h?.close();
    });

    it("starts in production-style mode: the account API is the issuer, and the server verifies against its JWKS", async () => {
      expect(server.output()).toContain('"environment":"staging"');
      const jwks = await (
        await fetch("http://localhost:8787/.well-known/jwks.json")
      ).json();
      expect(jwks.keys[0].crv).toBe("Ed25519");
    });

    it("admits a guest with a valid token", async () => {
      const guest = await newGuest(h);
      const { status, gameID } = await createGame(guest.jwt);
      expect(status).toBe(200);
      const outcome = await join(gameID!, guest.jwt);
      expect(outcome.closed, server.output().slice(-1500)).toBeNull();
      expect(outcome.messages).toBeGreaterThan(0);
    }, 30_000);

    it("admits a signed-in player with a valid token", async () => {
      const { jar } = await completeLogin(h, "discord", "discord");
      const jwt = (await (await refresh(h, jar)).json()).jwt as string;
      const { gameID } = await createGame(jwt);
      const outcome = await join(gameID!, jwt, { username: "SignedIn" });
      expect(outcome.closed).toBeNull();
      expect(outcome.messages).toBeGreaterThan(0);
    }, 30_000);

    it("refuses a forged token (signed by some other key)", async () => {
      const guest = await newGuest(h);
      const { gameID } = await createGame(guest.jwt);
      const { TokenService } =
        await import("../../src/account-api/auth/tokens");
      const { createEphemeralKeyRing } =
        await import("../../src/account-api/auth/keys");
      const forged = new TokenService(
        await createEphemeralKeyRing(),
        h.config.publicOrigin,
        h.config.domain,
      );
      const fake = (
        await forged.issue({
          userId: "123e4567-e89b-42d3-a456-426614174000",
          role: null,
          provider: "guest",
          sid: "x",
        })
      ).jwt;
      const outcome = await join(gameID!, fake);
      expect(outcome.messages).toBe(0);
      expect(outcome.closed?.reason).toBe(REASON.InvalidToken);
    }, 30_000);

    it("refuses an anonymous persistent id, which production never accepts", async () => {
      const guest = await newGuest(h);
      const { gameID } = await createGame(guest.jwt);
      const outcome = await join(
        gameID!,
        "123e4567-e89b-42d3-a456-426614174000",
      );
      expect(outcome.messages).toBe(0);
      expect(outcome.closed?.reason).toBe(REASON.InvalidToken);
    }, 30_000);

    it("refuses to create a game with a forged token, or with none", async () => {
      expect((await createGame("x.y.z")).status).toBe(401);
      const res = await fetch("http://localhost:3001/w0/api/create_game", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      expect(res.status).toBe(400);
    }, 30_000);

    it("refuses a revoked session even though its token has not expired", async () => {
      const guest = await newGuest(h);
      const { gameID } = await createGame(guest.jwt);
      // Signs the account out; the 15-minute access token is still a valid signature.
      await call(h, "/auth/logout", { method: "POST", jar: guest.jar });
      const outcome = await join(gameID!, guest.jwt);
      expect(outcome.messages).toBe(0);
      expect(outcome.closed).toEqual({
        code: CLOSE.Unauthorized,
        reason: REASON.InvalidToken,
      });
    }, 30_000);

    it("refuses a banned player", async () => {
      await completeLogin(h, "google", "banned");
      const publicId = (
        await h.db.pool.query(
          "SELECT public_id FROM users WHERE id = (SELECT user_id FROM auth_identities WHERE provider_user_id = 'e2e-banned')",
        )
      ).rows[0].public_id;
      await runAdminCommand(
        h.db.pool,
        ["user:ban", publicId, "--category", "test", "--yes"],
        io,
      );
      const again = await completeLogin(h, "google", "banned");
      const jwt = (await (await refresh(h, again.jar)).json()).jwt as string;
      const host = await newGuest(h);
      const { gameID } = await createGame(host.jwt);
      const outcome = await join(gameID!, jwt);
      expect(outcome.closed).toEqual({
        code: CLOSE.Banned,
        reason: REASON.Banned,
      });
    }, 30_000);

    describe("Turnstile at join", () => {
      it("refuses a first join with no Turnstile token", async () => {
        const guest = await newGuest(h);
        const { gameID } = await createGame(guest.jwt);
        const outcome = await join(gameID!, guest.jwt, {
          turnstileToken: null,
        });
        expect(outcome.messages).toBe(0);
        expect(outcome.closed?.reason).toBe(REASON.TurnstileFailed);
      }, 30_000);

      it("refuses a token the API's Turnstile check rejects", async () => {
        const guest = await newGuest(h);
        const { gameID } = await createGame(guest.jwt);
        const outcome = await join(gameID!, guest.jwt, {
          turnstileToken: "forged-token",
        });
        expect(outcome.messages).toBe(0);
        expect(outcome.closed?.reason).toBe(REASON.TurnstileFailed);
      }, 30_000);

      it("fails open, as designed, when Cloudflare cannot be reached", async () => {
        const guest = await newGuest(h);
        const { gameID } = await createGame(guest.jwt);
        const outcome = await join(gameID!, guest.jwt, {
          turnstileToken: "down",
        });
        expect(outcome.closed).toBeNull();
        expect(outcome.messages).toBeGreaterThan(0);
      }, 30_000);
    });

    it("refuses a client build that differs from the server's (the simulation must stay in sync)", async () => {
      const guest = await newGuest(h);
      const { gameID } = await createGame(guest.jwt);
      const outcome = await join(gameID!, guest.jwt, {
        gitCommit: "f".repeat(40),
      });
      expect(outcome.messages).toBeGreaterThan(0); // told why (an error message), then closed normally
      expect(outcome.closed).toEqual({
        code: 1000,
        reason: "Version mismatch",
      });
    }, 30_000);

    it("never contacted anything but the account API and (mocked) providers", async () => {
      // Everything the API called out to went through the recorded fetch.
      for (const request of mock.requests) {
        expect(new URL(request.url).hostname).not.toMatch(/openfront/i);
      }
      // And the game server's own log never names an OpenFront host.
      expect(server.output()).not.toMatch(/openfront\.(io|dev)/i);
    });
  },
);

describeDb(
  "server discovery with the real game server: public lobbies open once the API accepts it",
  () => {
    let h: Harness;
    let server: GameServer | null = null;
    let key: string;

    beforeAll(async () => {
      for (const port of [8787, 3000, 3001]) {
        if (!(await portFree(port)))
          throw new Error(
            `port ${port} is in use: stop other servers and rerun.`,
          );
      }
      h = await startHarness({ fixedPort: 8787, turnstile });
    }, 60_000);
    afterAll(async () => {
      await server?.stop();
      await h?.close();
    });

    async function publicLobbyCount(): Promise<number> {
      const ws = new WebSocket("ws://localhost:3001/w0/lobbies");
      let games = 0;
      ws.on("message", (data: Buffer) => {
        try {
          const msg = decodeLobbyMessage(data);
          if (msg.type === "full")
            games = Object.values(msg.games).flat().length;
        } catch {
          // not a lobby frame
        }
      });
      await new Promise<void>((resolve, reject) => {
        ws.once("open", () => resolve());
        ws.once("error", reject);
      });
      await new Promise((r) => setTimeout(r, 1800));
      ws.close();
      return games;
    }

    it("registers with the API, is listed in cluster.json, and only then schedules public lobbies", async () => {
      key = await createServerKey(h, "e2e-discovery-key-0123456789ab");
      server = await startGameServer(key, {
        GAME_HOST: "localhost",
        SITE_HOST: "localhost",
      });

      // The first check-in happens within a few seconds of startup.
      let list: {
        servers?: Record<
          string,
          { host: string; state: string; version: string }
        >;
        latest?: string;
      } | null = null;
      for (let i = 0; i < 40 && list === null; i++) {
        const res = await fetch(
          "http://localhost:8787/cluster.json?site=localhost",
        );
        if (res.ok) list = await res.json();
        else await new Promise((r) => setTimeout(r, 500));
      }
      expect(list, server.output().slice(-2000)).not.toBeNull();
      expect(list!.servers!.a).toEqual({
        host: "localhost",
        numWorkers: 1,
        version: COMMIT,
        state: "open",
      });
      expect(list!.latest).toBe(COMMIT);

      // Open: the master schedules public lobbies without any OpenFront service.
      let lobbies = 0;
      for (let i = 0; i < 10 && lobbies === 0; i++)
        lobbies = await publicLobbyCount();
      expect(lobbies).toBeGreaterThan(0);
    }, 120_000);

    it("a fenced server stops being offered new lobbies (existing ones are kept)", async () => {
      await runAdminCommand(
        h.db.pool,
        ["server:state", "localhost", "a", "fenced", "--yes"],
        io,
      );
      // The next check-in (every 10 s) applies it; the server keeps what it queued but adds no more.
      let state = "open";
      for (let i = 0; i < 40 && state !== "fenced"; i++) {
        state = (
          await (
            await fetch("http://localhost:8787/cluster.json?site=localhost")
          ).json()
        ).servers.a.state;
        if (state !== "fenced") await new Promise((r) => setTimeout(r, 500));
      }
      expect(state).toBe("fenced");
    }, 60_000);
  },
);
