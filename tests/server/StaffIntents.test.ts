import { GameType } from "@openfront/engine-api/game/GameTypes";
import { Intent } from "@openfront/engine-api/Schemas";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// What the game server reports to the account API's audit log is captured here.
const { reportAdminAction } = vi.hoisted(() => ({
  reportAdminAction: vi.fn(async (_report: unknown, _deps: unknown) => true),
}));
vi.mock("../../src/server/AdminAudit", () => ({ reportAdminAction }));

import { hasPermission } from "@openfront/shared/Permissions";
import {
  authorizeIntent,
  type IntentActor,
  type IntentGameState,
} from "../../src/server/IntentAuthorization";
import { effectiveRole, stampStaffRole } from "../../src/server/Privilege";
import {
  cid,
  makeClient,
  makeGame,
  mockWsOf,
  startGame,
} from "../util/GameServerHarness";

const give: Intent = {
  type: "admin_command",
  command: "give_gold",
  target: cid("victim"),
  amount: 500,
};
const eliminate: Intent = {
  type: "admin_command",
  command: "eliminate",
  target: cid("victim"),
};
const forceWin: Intent = {
  type: "admin_command",
  command: "force_win",
  target: cid("victim"),
};
const kick: Intent = { type: "kick_player", targetClientID: cid("victim") };
const pause: Intent = { type: "toggle_pause", paused: true };

const actor = (over: Partial<IntentActor> = {}): IntentActor => ({
  clientID: cid("sender"),
  isLobbyCreator: false,
  isAdmin: false,
  isAdminBot: false,
  ...over,
});
const running = (over: Partial<IntentGameState> = {}): IntentGameState => ({
  isPublic: false,
  isListed: false,
  isQueued: false,
  hasStarted: true,
  ...over,
});
const status = (i: Intent, a: IntentActor, g = running()) =>
  authorizeIntent(i, a, g)?.status ?? null;

describe("authorizeIntent: staff commands, by role", () => {
  const roles = {
    player: actor(),
    mod: actor({ role: "mod" }),
    admin: actor({ role: "admin", isAdmin: true }),
    owner: actor({ role: "owner", isAdmin: true }),
    root: actor({ role: "root", isAdmin: true }),
  };

  it("a normal player cannot send any admin command", () => {
    for (const command of [give, eliminate, forceWin]) {
      expect(status(command, roles.player)).toBe(403);
    }
  });

  it("a moderator can kick but cannot change the game", () => {
    expect(status(kick, roles.mod)).toBeNull();
    expect(status(give, roles.mod)).toBe(403);
    expect(status(eliminate, roles.mod)).toBe(403);
    expect(status(forceWin, roles.mod)).toBe(403);
    expect(status(pause, roles.mod)).toBe(403);
  });

  it("an admin can eliminate, kick and pause, but resources and forcing a winner are owner-only", () => {
    expect(status(kick, roles.admin)).toBeNull();
    expect(status(pause, roles.admin)).toBeNull();
    expect(status(eliminate, roles.admin)).toBeNull();
    expect(status(give, roles.admin)).toBe(403);
    expect(status(forceWin, roles.admin)).toBe(403);
  });

  it("the owner (and upstream's root) can send every command", () => {
    for (const who of [roles.owner, roles.root]) {
      for (const command of [give, eliminate, forceWin, kick, pause]) {
        expect(status(command, who), `${who.role} ${command.type}`).toBeNull();
      }
    }
  });

  it("the legacy isAdmin flag alone grants no admin command: a role is required", () => {
    expect(status(give, actor({ isAdmin: true }))).toBe(403);
    expect(status(eliminate, actor({ isAdmin: true, role: null }))).toBe(403);
    expect(status(forceWin, actor({ isAdmin: true, role: "flagged" }))).toBe(
      403,
    );
  });

  it("a role claim that is not a staff role grants nothing", () => {
    for (const role of ["flagged", "banned", "user", "OWNER", "Admin", ""]) {
      expect(status(give, actor({ role }))).toBe(403);
    }
  });

  it("in a public or listed game only the owner may run a command that changes it", () => {
    const publicGame = running({ isPublic: true });
    const listedGame = running({ isListed: true });
    for (const game of [publicGame, listedGame]) {
      // The owner (and upstream's root, which reads as owner): every command.
      for (const who of [roles.owner, roles.root]) {
        for (const command of [give, eliminate, forceWin]) {
          expect(
            status(command, who, game),
            `${who.role} ${command.type}`,
          ).toBeNull();
        }
      }
      // An admin may eliminate in a private game, but never here.
      expect(status(eliminate, roles.admin, game)).toBe(403);
      expect(status(give, roles.admin, game)).toBe(403);
      expect(status(forceWin, roles.admin, game)).toBe(403);
      expect(status(eliminate, roles.mod, game)).toBe(403);
      expect(status(give, roles.player, game)).toBe(403);
      // The legacy flag and non-staff role claims buy nothing.
      expect(
        status(give, actor({ isAdmin: true, role: "flagged" }), game),
      ).toBe(403);
    }
    // Private and unlisted: the admin's elimination still works, as before.
    expect(status(eliminate, roles.admin, running())).toBeNull();
    // The refusal names the reason, not a permission the admin is missing.
    expect(authorizeIntent(eliminate, roles.admin, publicGame)?.error).toMatch(
      /owner-only/,
    );
    // Moderation (kick) still reaches a public game.
    expect(status(kick, roles.mod, publicGame)).toBeNull();
  });

  it("the public-game right is its own permission, held by the owner alone", () => {
    expect(hasPermission("owner", "game.admin.public")).toBe(true);
    expect(hasPermission("root", "game.admin.public")).toBe(true);
    for (const role of ["admin", "mod", "flagged", null, undefined, "OWNER"]) {
      expect(hasPermission(role, "game.admin.public")).toBe(false);
    }
  });

  it("commands need a started game", () => {
    expect(status(give, roles.owner, running({ hasStarted: false }))).toBe(409);
  });

  it("the trusted admin bot cannot send them either", () => {
    expect(
      status(give, actor({ isAdmin: true, isAdminBot: true, role: "owner" })),
    ).toBe(400);
  });

  it("staff can pause and kick where the host cannot (a listed game)", () => {
    expect(status(pause, roles.admin, running({ isListed: true }))).toBeNull();
    expect(status(kick, roles.mod, running({ isListed: true }))).toBeNull();
    expect(
      status(
        pause,
        actor({ isLobbyCreator: true }),
        running({ isListed: true }),
      ),
    ).toBe(403);
  });
});

describe("the role a connection acts with, and the badge it shows", () => {
  it("a signed-in account acts with the API's current staff role, not the token's", () => {
    expect(effectiveRole(true, "admin", "owner")).toBe("owner");
    // Demoted since the token was issued: the stale claim is dropped.
    expect(effectiveRole(true, "admin", undefined)).toBeNull();
    expect(effectiveRole(true, "owner", undefined)).toBeNull();
    expect(effectiveRole(true, "mod", undefined)).toBeNull();
  });

  it("a non-staff claim is kept, and an anonymous join has no role", () => {
    expect(effectiveRole(true, "flagged", undefined)).toBe("flagged");
    expect(effectiveRole(true, null, undefined)).toBeNull();
    expect(effectiveRole(false, "admin", "admin")).toBeNull();
  });

  it("the staff badge comes only from the account: whatever the client sent is discarded", () => {
    const spoofed = { staffRole: "owner" as const, verified: true };
    stampStaffRole(spoofed, undefined);
    expect(spoofed).toEqual({ verified: true });
    stampStaffRole(spoofed, "mod");
    expect(spoofed.staffRole).toBe("mod");
  });
});

describe("GameServer: staff intents over the socket", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    reportAdminAction.mockClear();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllTimers();
  });

  function setup(config = {}, opts: { listed?: boolean } = {}) {
    const game = makeGame({ config: { maxPlayers: 10, ...config } });
    // A listed lobby is listed before it starts, as a host does it.
    if (opts.listed === true) game.setListed(true);
    const joined = (role: string | null, tag: string) => {
      const client = makeClient({
        clientID: cid(tag),
        role,
        publicId: `pub${tag}`,
      });
      game.joinClient(client);
      return client;
    };
    const victim = joined(null, "victim");
    const player = joined(null, "player");
    const mod = joined("mod", "mod");
    const admin = joined("admin", "admin");
    const owner = joined("owner", "owner");
    startGame(game);
    const added = vi.spyOn(game as never, "addIntent" as never);
    return { game, victim, player, mod, admin, owner, added };
  }

  const send = (c: ReturnType<typeof makeClient>, intent: Intent) =>
    mockWsOf(c).emit({ type: "intent", intent } as never);
  const relayed = (added: ReturnType<typeof vi.spyOn>, type: string) =>
    added.mock.calls.filter(
      ([i]: unknown[]) => (i as { type: string }).type === type,
    );

  it("a normal player's admin command is refused: nothing is relayed, logged or marked", async () => {
    const { game, player, victim, added } = setup();
    await send(player, { ...give, target: victim.clientID } as Intent);
    expect(relayed(added, "admin_command")).toHaveLength(0);
    expect(game.isAdminModified()).toBe(false);
    expect(reportAdminAction).not.toHaveBeenCalled();
  });

  it("a spoofed client cannot claim a role: the server uses the one it stored at join", async () => {
    const { game, player, victim, added } = setup();
    // Whatever the message says, the sender is the joined connection with no role.
    await mockWsOf(player).emit({
      type: "intent",
      intent: { ...give, target: victim.clientID },
      role: "owner",
      isAdmin: true,
    } as never);
    expect(relayed(added, "admin_command")).toHaveLength(0);
    expect(game.isAdminModified()).toBe(false);
  });

  it("an owner's command is relayed, marks the game admin-modified, and is audited", async () => {
    const { game, owner, victim, added } = setup();
    await send(owner, { ...give, target: victim.clientID } as Intent);
    const calls = relayed(added, "admin_command");
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toMatchObject({
      type: "admin_command",
      command: "give_gold",
      amount: 500,
      clientID: owner.clientID,
    });
    expect(game.isAdminModified()).toBe(true);
    expect(reportAdminAction).toHaveBeenCalledTimes(1);
    expect(reportAdminAction.mock.calls[0][0]).toMatchObject({
      gameID: game.id,
      actorPublicId: "pubowner",
      action: "game:command",
      details: { command: "give_gold", amount: 500 },
    });
  });

  it("an admin's elimination goes through, but their resource command is refused", async () => {
    const { game, admin, victim, added } = setup();
    await send(admin, { ...eliminate, target: victim.clientID } as Intent);
    await send(admin, { ...give, target: victim.clientID } as Intent);
    expect(
      relayed(added, "admin_command").map(
        ([i]: unknown[]) => (i as { command: string }).command,
      ),
    ).toEqual(["eliminate"]);
    expect(game.isAdminModified()).toBe(true);
  });

  it("owner-only: an admin cannot force a winner, the owner can", async () => {
    const { admin, owner, victim, added } = setup();
    await send(admin, { ...forceWin, target: victim.clientID } as Intent);
    expect(relayed(added, "admin_command")).toHaveLength(0);
    await send(owner, { ...forceWin, target: victim.clientID } as Intent);
    expect(relayed(added, "admin_command")).toHaveLength(1);
  });

  it("the owner may run a command in a private, an unlisted and a listed game", async () => {
    for (const [config, opts] of [
      [{ gameType: GameType.Private }, {}],
      [{ gameType: GameType.Private }, { listed: false }],
      [{ gameType: GameType.Private }, { listed: true }],
    ] as const) {
      const { game, owner, victim, added } = setup(config, opts);
      expect(game.isListed()).toBe(opts.listed === true);
      await send(owner, { ...give, target: victim.clientID } as Intent);
      expect(relayed(added, "admin_command")).toHaveLength(1);
      expect(game.isAdminModified()).toBe(true);
    }
  });

  it("an owner's command in a public game is relayed, marks the game admin-modified, and is audited as one", async () => {
    const { game, owner, victim, added } = setup({ gameType: GameType.Public });
    expect(game.isPublic()).toBe(true);
    await send(owner, { ...give, target: victim.clientID } as Intent);
    expect(relayed(added, "admin_command")).toHaveLength(1);
    expect(game.isAdminModified()).toBe(true);
    expect(reportAdminAction).toHaveBeenCalledTimes(1);
    const report = reportAdminAction.mock.calls[0][0] as Record<
      string,
      unknown
    >;
    expect(report).toMatchObject({
      gameID: game.id,
      actorPublicId: "pubowner",
      action: "game:command",
      details: {
        command: "give_gold",
        amount: 500,
        public: true,
        listed: false,
      },
    });
    // Identifiers and numbers only: no token, key or address.
    expect(JSON.stringify(report)).not.toMatch(
      /token|apikey|secret|password|ip/i,
    );
  });

  it("an owner's command in a listed game is audited with the listed flag", async () => {
    const { owner, victim, added } = setup({}, { listed: true });
    await send(owner, { ...eliminate, target: victim.clientID } as Intent);
    expect(relayed(added, "admin_command")).toHaveLength(1);
    expect(reportAdminAction.mock.calls[0][0]).toMatchObject({
      details: { command: "eliminate", listed: true, public: false },
    });
  });

  it("in a public or listed game an admin, a moderator and a player are refused, and the game stays unmodified", async () => {
    for (const [config, opts] of [
      [{ gameType: GameType.Public }, {}],
      [{}, { listed: true }],
    ] as const) {
      const { game, admin, mod, player, victim, added } = setup(config, opts);
      for (const who of [admin, mod, player]) {
        await send(who, { ...eliminate, target: victim.clientID } as Intent);
        await send(who, { ...give, target: victim.clientID } as Intent);
      }
      expect(relayed(added, "admin_command")).toHaveLength(0);
      expect(game.isAdminModified()).toBe(false);
      expect(reportAdminAction).not.toHaveBeenCalled();
    }
  });

  it("an admin's elimination still works in a private game, and is audited as not public", async () => {
    const { admin, victim, added } = setup({ gameType: GameType.Private });
    await send(admin, { ...eliminate, target: victim.clientID } as Intent);
    expect(relayed(added, "admin_command")).toHaveLength(1);
    expect(reportAdminAction.mock.calls[0][0]).toMatchObject({
      actorPublicId: "pubadmin",
      details: { public: false, listed: false },
    });
  });

  it("a client claiming to be the owner in a public game is refused: the server's stored role decides", async () => {
    const { game, admin, victim, added } = setup({ gameType: GameType.Public });
    await mockWsOf(admin).emit({
      type: "intent",
      intent: { ...give, target: victim.clientID },
      role: "owner",
      staffRole: "owner",
      isAdmin: true,
    } as never);
    expect(relayed(added, "admin_command")).toHaveLength(0);
    expect(game.isAdminModified()).toBe(false);
  });

  it("staff kick: a moderator can, a player cannot, and it is audited", async () => {
    const { game, mod, player, victim } = setup();
    const kickClient = vi
      .spyOn(game, "kickClient")
      .mockImplementation(() => {});
    await send(player, { ...kick, targetClientID: victim.clientID } as Intent);
    expect(kickClient).not.toHaveBeenCalled();
    await send(mod, { ...kick, targetClientID: victim.clientID } as Intent);
    expect(kickClient).toHaveBeenCalledTimes(1);
    expect(reportAdminAction.mock.calls[0][0]).toMatchObject({
      action: "game:kick",
      actorPublicId: "pubmod",
      targetClientID: victim.clientID,
    });
    // A kick is moderation, not a change to the game's outcome.
    expect(game.isAdminModified()).toBe(false);
  });

  it("a staff pause is audited; the host's own pause is not a staff action", async () => {
    const { admin } = setup();
    await send(admin, pause);
    expect(reportAdminAction).toHaveBeenCalledTimes(1);
    expect(reportAdminAction.mock.calls[0][0]).toMatchObject({
      action: "game:pause",
      actorPublicId: "pubadmin",
    });
  });
});
