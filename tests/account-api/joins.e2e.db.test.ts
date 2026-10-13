// @vitest-environment node
import type { PlayerCosmeticRefs } from "@openfront/shared/WireSchemas";
import {
  decodeLobbyMessage,
  decodeServerMessage,
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
import { makeUser, type TestUser } from "./util/games";
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
const CLOSE = { Unauthorized: 4001, Forbidden: 4002, Banned: 4003 } as const;
const REASON = {
  InvalidToken: "close_reason.invalid_token",
  TurnstileFailed: "close_reason.turnstile_failed",
  Banned: "close_reason.banned",
  CosmeticsForbidden: "close_reason.cosmetics_forbidden",
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
    cosmetics?: PlayerCosmeticRefs;
    clanTag?: string | null;
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
        clanTag: options.clanTag ?? null,
        cosmetics: options.cosmetics,
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

describeDb(
  "cosmetics at join, with the real game server and the real catalog (inventory feature)",
  () => {
    let h: Harness;
    let server: GameServer;
    const shopperMock = createMockProviders({
      buyer: {
        discord: {
          id: "e2e-buyer",
          username: "buyer",
          email: "buyer@example.com",
          verified: true,
        },
      },
    });
    const FREE_PATTERN: PlayerCosmeticRefs = {
      patternName: "delta_stripes",
      patternColorPaletteName: "ash",
    };

    /** A guest with the given items granted by the admin command. */
    async function player(grants: string[] = []) {
      const guest = await newGuest(h);
      const me = (await (
        await call(h, "/users/@me", { bearer: guest.jwt, origin: null })
      ).json()) as { player: { publicId: string } };
      for (const flare of grants) {
        const r = await runAdminCommand(
          h.db.pool,
          ["item:grant", me.player.publicId, flare],
          io,
        );
        expect(r).toBe(0);
      }
      return { ...guest, publicId: me.player.publicId };
    }

    async function admitted(
      grants: string[],
      cosmetics: PlayerCosmeticRefs,
    ): Promise<JoinOutcome> {
      const p = await player(grants);
      const { gameID } = await createGame(p.jwt);
      return join(gameID!, p.jwt, { cosmetics });
    }

    beforeAll(async () => {
      for (const port of [8787, 3000, 3001]) {
        if (!(await portFree(port))) {
          throw new Error(
            `port ${port} is in use: stop other servers and rerun.`,
          );
        }
      }
      h = await startHarness({
        fixedPort: 8787,
        turnstile,
        features: "accounts,inventory,store",
        fetchFn: shopperMock.fetchFn,
        // These tests create many guests from one address.
        limits: { guestCreation: { max: 1000, windowMs: 60_000 } },
      });
      const key = await createServerKey(h, "e2e-cosmetics-key-0123456789ab");
      server = await startGameServer(key, {
        DF_ACCOUNT_FEATURES: "accounts,inventory,store",
      });
      // Until the server has loaded the catalog it deliberately strips every
      // cosmetic instead of checking it, so wait for the first load.
      const deadline = Date.now() + 30_000;
      while (!server.output().includes("Privilege checker loaded")) {
        if (Date.now() > deadline) {
          throw new Error(
            `the game server never loaded the catalog:\n${server.output().slice(-2500)}`,
          );
        }
        await new Promise((r) => setTimeout(r, 250));
      }
    }, 120_000);

    afterAll(async () => {
      await server?.stop();
      await h?.close();
    });

    it("loaded the DeltaFront catalog and the reserved tag list from the account API", () => {
      const m =
        /Privilege checker loaded successfully \((\d+) reserved clan tags\)/.exec(
          server.output(),
        );
      // no clan exists yet: these are the reserved names alone
      expect(Number(m![1])).toBeGreaterThan(0);
    });

    it("admits the free pattern for a guest who owns nothing else", async () => {
      const outcome = await admitted([], FREE_PATTERN);
      expect(outcome.closed).toBeNull();
      expect(outcome.messages).toBeGreaterThan(0);
    }, 30_000);

    it("admits an owned flag, pattern and effect together", async () => {
      const outcome = await admitted(
        ["flag:delta_mark", "pattern:grid_check:ember", "effect:red_wake"],
        {
          flag: "flag:delta_mark",
          patternName: "grid_check",
          patternColorPaletteName: "ember",
          effects: { transportShipTrail: "red_wake" },
        },
      );
      expect(outcome.closed, server.output().slice(-1500)).toBeNull();
      expect(outcome.messages).toBeGreaterThan(0);
    }, 30_000);

    it.each([
      ["a flag the account does not own", { flag: "flag:split_field" }],
      [
        "a pattern it does not own",
        { patternName: "grid_check", patternColorPaletteName: "ember" },
      ],
      [
        "a paid palette of the free pattern",
        { patternName: "delta_stripes", patternColorPaletteName: "ember" },
      ],
      [
        "the free pattern without its palette (a different flare)",
        { patternName: "delta_stripes" },
      ],
      [
        "an effect it does not own",
        { effects: { transportShipTrail: "red_wake" } },
      ],
      ["an item that is not in the catalog", { flag: "flag:made_up" }],
      ["a wildcard flag", { flag: "flag:*" }],
      ["a skin (the catalog has none)", { skinName: "delta_stripes" }],
      ["a crown (the catalog has none)", { crownName: "gold" }],
      ["a colour it was never sold", { color: "#ff0000" }],
    ] as Array<[string, PlayerCosmeticRefs]>)(
      "refuses a join that claims %s",
      async (_what, cosmetics) => {
        const outcome = await admitted([], cosmetics);
        expect(outcome.messages).toBe(0);
        expect(outcome.closed).toEqual({
          code: CLOSE.Forbidden,
          reason: REASON.CosmeticsForbidden,
        });
      },
      30_000,
    );

    it("refuses a malformed cosmetic name before it is ever looked up", async () => {
      const outcome = await admitted([], { patternName: "*" });
      // The message does not even parse, so the player is told and dropped.
      expect(outcome.closed).not.toBeNull();
    }, 30_000);

    it("refuses an effect owned for a different slot", async () => {
      const outcome = await admitted(["effect:red_wake"], {
        effects: { nukeTrail: "red_wake" },
      });
      expect(outcome.closed?.reason).toBe(REASON.CosmeticsForbidden);
    }, 30_000);

    it("does not accept another account's item", async () => {
      await player(["flag:delta_mark"]); // someone else owns it
      const outcome = await admitted([], { flag: "flag:delta_mark" });
      expect(outcome.closed?.reason).toBe(REASON.CosmeticsForbidden);
    }, 30_000);

    it("refuses an item the moment the admin revokes it", async () => {
      const p = await player(["flag:split_field"]);
      const { gameID } = await createGame(p.jwt);
      const ok = await join(gameID!, p.jwt, {
        cosmetics: { flag: "flag:split_field" },
      });
      expect(ok.closed).toBeNull();
      expect(
        await runAdminCommand(
          h.db.pool,
          ["item:revoke", p.publicId, "flag:split_field", "--yes"],
          io,
        ),
      ).toBe(0);
      const second = await createGame(p.jwt);
      const refused = await join(second.gameID!, p.jwt, {
        cosmetics: { flag: "flag:split_field" },
      });
      expect(refused.closed?.reason).toBe(REASON.CosmeticsForbidden);
    }, 30_000);

    it("lets a player with no cosmetics selected play, and country flags need no ownership", async () => {
      const bare = await admitted([], {});
      expect(bare.closed).toBeNull();
      const country = await admitted([], { flag: "country:fr" });
      expect(country.closed).toBeNull();
    }, 30_000);

    it("shows an owned cosmetic to the other players in the game, and nothing they were not given", async () => {
      const alice = await player([
        "flag:delta_mark",
        "pattern:grid_check:ember",
      ]);
      const bob = await player();
      const { gameID } = await createGame(alice.jwt);

      // Two live connections: they collect every server message.
      const open = async (
        token: string,
        username: string,
        cosmetics: PlayerCosmeticRefs,
      ) => {
        const ws = new WebSocket("ws://localhost:3001/w0");
        const messages: ReturnType<typeof decodeServerMessage>[] = [];
        ws.on("message", (data: Buffer) => {
          try {
            messages.push(decodeServerMessage(data, undefined));
          } catch {
            // later frames use the roster table; only the start message matters here
          }
        });
        await new Promise<void>((resolve, reject) => {
          ws.once("open", () => resolve());
          ws.once("error", reject);
        });
        ws.send(
          encodeClientMessage(
            {
              type: "join",
              token,
              gameID: gameID!,
              username,
              clanTag: null,
              cosmetics,
              turnstileToken: "good",
              gitCommit: COMMIT,
            } as never,
            undefined,
          ),
        );
        return { ws, messages };
      };
      const a = await open(alice.jwt, "Alice", {
        flag: "flag:delta_mark",
        patternName: "grid_check",
        patternColorPaletteName: "ember",
      });
      const b = await open(bob.jwt, "Bob", FREE_PATTERN);
      try {
        // The creator starts the lobby.
        for (
          let i = 0;
          i < 40 && !b.messages.some((m) => m.type === "lobby_info");
          i++
        ) {
          await new Promise((r) => setTimeout(r, 100));
        }
        a.ws.send(
          encodeClientMessage(
            {
              type: "intent",
              intent: { type: "toggle_game_start_timer" },
            } as never,
            undefined,
          ),
        );
        let start:
          | Extract<ReturnType<typeof decodeServerMessage>, { type: "start" }>
          | undefined;
        for (let i = 0; i < 150 && start === undefined; i++) {
          start = b.messages.find((m) => m.type === "start") as typeof start;
          if (start === undefined) await new Promise((r) => setTimeout(r, 100));
        }
        expect(start, server.output().slice(-1500)).toBeDefined();

        const catalog = (await (
          await fetch("http://localhost:8787/cosmetics.json")
        ).json()) as {
          flags: Record<string, { url: string }>;
          patterns: Record<string, { pattern: string }>;
          colorPalettes: Record<string, unknown>;
        };
        const players = start!.gameStartInfo.players;
        const seenAlice = players.find((p) => p.username === "Alice")!;
        const seenBob = players.find((p) => p.username === "Bob")!;
        expect(seenAlice.cosmetics?.flag).toBe(catalog.flags.delta_mark.url);
        expect(seenAlice.cosmetics?.pattern).toEqual({
          name: "grid_check",
          patternData: catalog.patterns.grid_check.pattern,
          colorPalette: catalog.colorPalettes.ember,
        });
        // Bob wore only the free pattern: he shows that, and no flag.
        expect(seenBob.cosmetics?.pattern?.name).toBe("delta_stripes");
        expect(seenBob.cosmetics?.pattern?.colorPalette).toEqual(
          catalog.colorPalettes.ash,
        );
        expect(seenBob.cosmetics?.flag).toBeUndefined();
      } finally {
        a.ws.close();
        b.ws.close();
      }
    }, 60_000);

    it("accepts an item bought in the store, and refuses it before it was bought", async () => {
      const login = await completeLogin(h, "discord", "buyer");
      const jwt = (await (await refresh(h, login.jar)).json()).jwt as string;
      const me = (await (
        await call(h, "/users/@me", { bearer: jwt, origin: null })
      ).json()) as { player: { publicId: string } };
      expect(
        await runAdminCommand(
          h.db.pool,
          ["wallet:grant", me.player.publicId, "1000", "--reason", "e2e"],
          io,
        ),
      ).toBe(0);
      const cosmetics: PlayerCosmeticRefs = { flag: "flag:split_field" };
      const before = await createGame(jwt);
      const refused = await join(before.gameID!, jwt, { cosmetics });
      expect(refused.closed?.reason).toBe(REASON.CosmeticsForbidden);

      const bought = await call(h, "/shop/purchase", {
        method: "POST",
        bearer: jwt,
        origin: null,
        json: {
          cosmeticType: "flag",
          cosmeticName: "split_field",
          currencyType: "soft",
        },
      });
      expect(bought.status).toBe(200);
      const after = await createGame(jwt);
      const admitted = await join(after.gameID!, jwt, { cosmetics });
      expect(admitted.closed, server.output().slice(-1500)).toBeNull();
      expect(admitted.messages).toBeGreaterThan(0);
    }, 60_000);

    it("never contacted an OpenFront host while loading the catalog or checking joins", () => {
      expect(server.output()).not.toMatch(/openfront\.(io|dev)/i);
    });
  },
);

interface Entrant {
  token: string;
  username: string;
  clanTag?: string | null;
}

/**
 * Puts the entrants in one private game, starts it from the first one (the
 * creator) and returns who the server says is playing: the roster of the
 * `start` message every client receives, with the clan tag the server settled on.
 */
async function playLobby(
  gameID: string,
  entrants: Entrant[],
): Promise<Array<{ username: string; clanTag: string | null | undefined }>> {
  const sockets = await Promise.all(
    entrants.map(async (e) => {
      const ws = new WebSocket("ws://localhost:3001/w0");
      const messages: ReturnType<typeof decodeServerMessage>[] = [];
      let closed: { code: number; reason: string } | null = null;
      ws.on("message", (data: Buffer) => {
        try {
          messages.push(decodeServerMessage(data, undefined));
        } catch {
          // frames after the start use the roster table; only the start matters here
        }
      });
      ws.on("close", (code, reason) => {
        closed = { code, reason: reason.toString() };
      });
      await new Promise<void>((resolve, reject) => {
        ws.once("open", () => resolve());
        ws.once("error", reject);
      });
      ws.send(
        encodeClientMessage(
          {
            type: "join",
            token: e.token,
            gameID,
            username: e.username,
            clanTag: e.clanTag ?? null,
            turnstileToken: "good",
            gitCommit: COMMIT,
          } as never,
          undefined,
        ),
      );
      return { ws, messages, closed: () => closed };
    }),
  );
  try {
    for (
      let i = 0;
      i < 60 &&
      !sockets.every((s) => s.messages.some((m) => m.type === "lobby_info"));
      i++
    ) {
      await new Promise((r) => setTimeout(r, 100));
    }
    sockets[0].ws.send(
      encodeClientMessage(
        {
          type: "intent",
          intent: { type: "toggle_game_start_timer" },
        } as never,
        undefined,
      ),
    );
    let start:
      | Extract<ReturnType<typeof decodeServerMessage>, { type: "start" }>
      | undefined;
    for (let i = 0; i < 200 && start === undefined; i++) {
      start = sockets[sockets.length - 1].messages.find(
        (m) => m.type === "start",
      ) as typeof start;
      if (start === undefined) await new Promise((r) => setTimeout(r, 100));
    }
    if (start === undefined) {
      throw new Error(
        `no start message; closes: ${JSON.stringify(sockets.map((s) => s.closed()))}`,
      );
    }
    return start.gameStartInfo.players.map((p) => ({
      username: p.username,
      clanTag: p.clanTag,
    }));
  } finally {
    for (const s of sockets) s.ws.close();
  }
}

describeDb(
  "clan tags at join, with the real game server and the real clan API (clans feature)",
  () => {
    let h: Harness;
    let server: GameServer;
    let n = 0;

    const post = (u: { jwt: string }, route: string, body?: unknown) =>
      call(h, route, {
        method: "POST",
        bearer: u.jwt,
        origin: null,
        ...(body === undefined ? {} : { json: body }),
      });

    /** A registered, clan-eligible account (old enough, ten completed games). */
    async function player(): Promise<TestUser> {
      const u = await makeUser(h, "registered");
      await h.db.pool.query(
        "UPDATE users SET created_at = now() - interval '10 days' WHERE id = $1",
        [u.id],
      );
      await h.db.pool.query(
        `WITH gs AS (
           INSERT INTO games (game_code, source, type, started_at, ended_at, duration_s, human_players, counts_for_stats)
           SELECT 'clj' || ${++n} || k, 'server', 'Public', now() - interval '10 minutes', now(), 600, 2, true
             FROM generate_series(1, 10) k RETURNING id)
         INSERT INTO game_players (game_id, client_id, user_id, username, result, completed)
         SELECT id, 'p1', $1, 'x', 'victory', true FROM gs`,
        [u.id],
      );
      return u;
    }
    const gameFor = async (u: TestUser) => (await createGame(u.jwt)).gameID!;

    beforeAll(async () => {
      for (const port of [8787, 3000, 3001]) {
        if (!(await portFree(port)))
          throw new Error(
            `port ${port} is in use: stop other servers and rerun.`,
          );
      }
      h = await startHarness({
        fixedPort: 8787,
        turnstile,
        features: "accounts,inventory,clans",
        limits: {
          guestCreation: { max: 1000, windowMs: 60_000 },
          clanWrite: { max: 1000, windowMs: 60_000 },
        },
      });
      const key = await createServerKey(h, "e2e-clans-key-0123456789abcdef");
      server = await startGameServer(key, {
        DF_ACCOUNT_FEATURES: "accounts,inventory,clans",
      });
      const deadline = Date.now() + 30_000;
      while (
        !/Privilege checker loaded successfully \(\d+ reserved clan tags\)/.test(
          server.output(),
        )
      ) {
        if (Date.now() > deadline)
          throw new Error(
            `the game server never loaded the tags:\n${server.output().slice(-2500)}`,
          );
        await new Promise((r) => setTimeout(r, 250));
      }
    }, 120_000);
    afterAll(async () => {
      await server?.stop();
      await h?.close();
    });

    it("loaded the reserved list from the account API", () => {
      const m =
        /Privilege checker loaded successfully \((\d+) reserved clan tags\)/.exec(
          server.output(),
        );
      expect(Number(m![1])).toBeGreaterThan(0);
    });

    it("a member's real tag appears in the game, and another player sees it", async () => {
      const leader = await player();
      const tag = `E${(++n).toString(36).toUpperCase().padStart(2, "0")}`;
      expect(
        (await post(leader, "/clans", { name: `E2E Clan ${tag}`, tag })).status,
      ).toBe(201);
      const watcher = await newGuest(h);
      const roster = await playLobby(await gameFor(leader), [
        { token: leader.jwt, username: "Wearer", clanTag: tag },
        { token: watcher.jwt, username: "Watcher" },
      ]);
      expect(roster.find((p) => p.username === "Wearer")?.clanTag).toBe(tag);
      expect(
        roster.find((p) => p.username === "Watcher")?.clanTag ?? null,
      ).toBeNull();
    }, 60_000);

    it("a forged tag is dropped: a non-member wearing a real clan's tag (even one created after the server's last refresh), or a reserved one, gets none", async () => {
      const leader = await player();
      const tag = `F${(++n).toString(36).toUpperCase().padStart(2, "0")}`;
      await post(leader, "/clans", { name: `Forgery Target ${tag}`, tag });
      const impostor = await newGuest(h);
      const reserved = await newGuest(h);
      const plain = await newGuest(h);
      const roster = await playLobby(await gameFor(leader), [
        { token: leader.jwt, username: "Leader", clanTag: tag },
        {
          token: impostor.jwt,
          username: "Imposter",
          clanTag: tag.toLowerCase(),
        },
        { token: reserved.jwt, username: "Reserved", clanTag: "ADMIN" },
        { token: plain.jwt, username: "Plain" },
      ]);
      expect(roster.find((p) => p.username === "Leader")?.clanTag).toBe(tag);
      expect(
        roster.find((p) => p.username === "Imposter")?.clanTag ?? null,
      ).toBeNull();
      expect(
        roster.find((p) => p.username === "Reserved")?.clanTag ?? null,
      ).toBeNull();
      expect(
        roster.find((p) => p.username === "Plain")?.clanTag ?? null,
      ).toBeNull();
    }, 60_000);

    it("a tag nobody has registered is a free, fictional tag and is kept (the existing design)", async () => {
      const u = await newGuest(h);
      const roster = await playLobby(
        await gameFor({ jwt: u.jwt } as TestUser),
        [{ token: u.jwt, username: "Fiction", clanTag: "ZQX" }],
      );
      expect(roster[0].clanTag).toBe("ZQX");
    }, 60_000);

    it("after leaving or being kicked, the old tag is dropped at the next join", async () => {
      const leader = await player();
      const tag = `L${(++n).toString(36).toUpperCase().padStart(2, "0")}`;
      await post(leader, "/clans", { name: `Leavers ${tag}`, tag });
      const leaver = await player();
      const kicked = await player();
      for (const u of [leaver, kicked])
        expect((await post(u, `/clans/${tag}/join`)).status).toBe(200);
      const before = await playLobby(await gameFor(leader), [
        { token: leader.jwt, username: "Boss", clanTag: tag },
        { token: leaver.jwt, username: "Leaver", clanTag: tag },
        { token: kicked.jwt, username: "Kicked", clanTag: tag },
      ]);
      for (const name of ["Boss", "Leaver", "Kicked"])
        expect(before.find((p) => p.username === name)?.clanTag, name).toBe(
          tag,
        );

      expect((await post(leaver, `/clans/${tag}/leave`)).status).toBe(200);
      const me = (await (
        await call(h, "/users/@me", { bearer: kicked.jwt, origin: null })
      ).json()) as { player: { publicId: string } };
      expect(
        (
          await post(leader, `/clans/${tag}/kick`, {
            targetPublicId: me.player.publicId,
          })
        ).status,
      ).toBe(200);
      const after = await playLobby(await gameFor(leader), [
        { token: leader.jwt, username: "Boss", clanTag: tag },
        { token: leaver.jwt, username: "Leaver", clanTag: tag },
        { token: kicked.jwt, username: "Kicked", clanTag: tag },
      ]);
      expect(after.find((p) => p.username === "Boss")?.clanTag).toBe(tag);
      expect(
        after.find((p) => p.username === "Leaver")?.clanTag ?? null,
      ).toBeNull();
      expect(
        after.find((p) => p.username === "Kicked")?.clanTag ?? null,
      ).toBeNull();
    }, 90_000);
  },
);
