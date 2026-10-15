// @vitest-environment node
import { describe, expect, it } from "vitest";
import { ECONOMY } from "../../src/account-api/domain/constants";
import {
  completedByClient,
  countsAsParticipant,
  outcomesByClient,
  playerIneligibleReason,
  type GameXpContext,
} from "../../src/account-api/domain/progression";
import {
  leftWhileAlive,
  RESULT_GRACE_TURNS,
} from "../../src/account-api/domain/stats";
import {
  eliminatedBeforeMinimum,
  playerStanding,
  progressionEligibility,
  reducedReasonFor,
} from "../../src/account-api/domain/xp";
import {
  buildRecord,
  clientIdOf,
  type GameSpec,
  type PlayerSpec,
} from "./util/games";

// The rules behind a death's reduced award, on the records the game server
// writes: who counts as eliminated, who left while still in the game (and so
// forfeits everything) and who left after the death (and keeps the award).

const RESULT = 6000;
const account = (n: number): PlayerSpec => ({
  user: { id: `00000000-0000-4000-8000-00000000000${n}` } as never,
});
const dead = (n: number, killedAt: number, leftTurn?: number): PlayerSpec => ({
  ...account(n),
  fate: { killedAt },
  ...(leftTurn === undefined ? {} : { leftTurn }),
});

const record = (spec: Partial<GameSpec> = {}) =>
  buildRecord("abCD1234", {
    players: [account(1), account(2)],
    lastTurn: RESULT + 40,
    resultTurn: RESULT,
    ...spec,
  });

describe("where a player stood", () => {
  it("is eliminated, still in it, or never in it", () => {
    const r = record({
      players: [
        account(1),
        dead(2, 3000),
        { ...account(3), fate: "never-spawned" },
      ],
    });
    expect(playerStanding(r, clientIdOf(0))).toBe("survived");
    expect(playerStanding(r, clientIdOf(1))).toBe("eliminated");
    expect(playerStanding(r, clientIdOf(2))).toBe("not_spawned");
    expect(playerStanding(r, "stranger1")).toBe("not_spawned");
  });

  it("an elimination before the minimum is still an elimination", () => {
    const r = record({
      players: [account(1), dead(2, ECONOMY.minEliminationTick - 1)],
    });
    expect(playerStanding(r, clientIdOf(1))).toBe("eliminated");
    expect(eliminatedBeforeMinimum(r, clientIdOf(1))).toBe(true);
    const later = record({
      players: [account(1), dead(2, ECONOMY.minEliminationTick)],
    });
    expect(eliminatedBeforeMinimum(later, clientIdOf(1))).toBe(false);
    expect(eliminatedBeforeMinimum(later, clientIdOf(0))).toBe(false);
  });
});

describe("leaving while alive is not leaving after the death", () => {
  it("gone after the death: the award is theirs", () => {
    const r = record({ players: [account(1), dead(2, 3000, 3040)] });
    expect(leftWhileAlive(r, clientIdOf(1))).toBe(false);
    // even long after, right up to the end
    expect(
      leftWhileAlive(
        record({ players: [account(1), dead(2, 3000, RESULT - 1)] }),
        clientIdOf(1),
      ),
    ).toBe(false);
  });

  it("gone before the death, never back: that was leaving", () => {
    const r = record({ players: [account(1), dead(2, 3000, 2000)] });
    expect(leftWhileAlive(r, clientIdOf(1))).toBe(true);
  });

  it("the grace covers a connection noticed a moment after the death", () => {
    const at = 3000;
    expect(
      leftWhileAlive(
        record({
          players: [account(1), dead(2, at, at - RESULT_GRACE_TURNS)],
        }),
        clientIdOf(1),
      ),
    ).toBe(false);
    expect(
      leftWhileAlive(
        record({
          players: [account(1), dead(2, at, at - RESULT_GRACE_TURNS - 1)],
        }),
        clientIdOf(1),
      ),
    ).toBe(true);
  });

  it("a drop that came back, or a player who stayed, did not leave", () => {
    // no leftTurn: connected when the record was written
    expect(
      leftWhileAlive(
        record({ players: [account(1), dead(2, 3000)] }),
        clientIdOf(1),
      ),
    ).toBe(false);
  });

  it("a player who is not eliminated is not judged here", () => {
    const r = record({
      players: [account(1), { ...account(2), leftTurn: 100 }],
    });
    expect(leftWhileAlive(r, clientIdOf(1))).toBe(false);
    expect(leftWhileAlive(r, "stranger1")).toBe(false);
  });

  describe("on a record from before the server stamped who stayed", () => {
    const old = (
      killedAt: number,
      disconnects: NonNullable<GameSpec["disconnects"]>,
    ) =>
      record({
        resultTurn: undefined,
        players: [account(1), dead(2, killedAt)],
        disconnects,
      });

    it("gone before the death and never back: leaving", () => {
      expect(
        leftWhileAlive(
          old(3000, [
            { clientID: clientIdOf(1), turn: 2000, isDisconnected: true },
          ]),
          clientIdOf(1),
        ),
      ).toBe(true);
    });

    it("gone after the death: not leaving", () => {
      expect(
        leftWhileAlive(
          old(3000, [
            { clientID: clientIdOf(1), turn: 3100, isDisconnected: true },
          ]),
          clientIdOf(1),
        ),
      ).toBe(false);
    });

    it("dropped before the death but back at the end: not leaving", () => {
      expect(
        leftWhileAlive(
          old(3000, [
            { clientID: clientIdOf(1), turn: 2000, isDisconnected: true },
            { clientID: clientIdOf(1), turn: 2500, isDisconnected: false },
          ]),
          clientIdOf(1),
        ),
      ).toBe(false);
    });
  });
});

describe("the reason on a reduced award", () => {
  it("is the game's own when it was reduced anyway, and the death otherwise", () => {
    expect(reducedReasonFor({ mode: "full", reason: "normal_public" })).toBe(
      "eliminated",
    );
    expect(reducedReasonFor({ mode: "reduced", reason: "private_game" })).toBe(
      "private_game",
    );
    expect(
      reducedReasonFor({ mode: "reduced", reason: "public_too_few_humans" }),
    ).toBe("public_too_few_humans");
    expect(
      reducedReasonFor({ mode: "reduced", reason: "admin_modified" }),
    ).toBe("admin_modified");
    expect(reducedReasonFor({ mode: "reduced", reason: "short_game" })).toBe(
      "short_game",
    );
  });
});

/** A stored game's context, as ingestion builds it, for one set of players. */
function context(
  r: ReturnType<typeof record>,
  acting: readonly number[],
): GameXpContext {
  const ids = r.info.players.map((p) => p.clientID);
  const outcomes = outcomesByClient(r, ids, true);
  return {
    record: r,
    gameCode: "abCD1234",
    endedAt: new Date(r.info.end),
    eligibility: progressionEligibility({
      source: "server",
      type: "Public",
      rankedType: null,
      durationSeconds: 600,
      accountHolders: 2,
    }),
    isFfa: true,
    placement: { placeOf: null, humans: ids.length },
    acted: new Set(acting.map((i) => clientIdOf(i))),
    adminSenders: new Set(),
    outcomes,
    completed: completedByClient(outcomes),
    eligible: [],
    map: null,
    season: null,
    env: { validFlares: null },
  };
}
const player = (n: number, kind: "guest" | "registered" = "registered") => ({
  userId: `00000000-0000-4000-8000-00000000000${n + 1}`,
  clientID: clientIdOf(n),
  kind,
  clanId: null,
});

describe("who is paid, and why not", () => {
  it("an eliminated player is eligible whether they stayed, left after the death or the game had no winner", () => {
    const stayed = context(
      record({ players: [account(1), dead(2, 3000)] }),
      [0, 1],
    );
    expect(playerIneligibleReason(stayed, player(1))).toBeNull();
    const left = context(
      record({ players: [account(1), dead(2, 3000, 3040)] }),
      [0, 1],
    );
    expect(playerIneligibleReason(left, player(1))).toBeNull();
    const none = context(
      record({
        players: [account(1), dead(2, 3000)],
        winner: null,
        resultTurn: undefined,
      }),
      [0, 1],
    );
    expect(playerIneligibleReason(none, player(1))).toBeNull();
    // the player still in it has no result to wait for
    expect(playerIneligibleReason(none, player(0))).toBe("no_winner");
  });

  it("an eliminated player within the first two minutes is eligible too", () => {
    const early = context(
      record({
        players: [account(1), dead(2, ECONOMY.minEliminationTick - 1)],
      }),
      [0, 1],
    );
    expect(playerIneligibleReason(early, player(1))).toBeNull();
  });

  it("leaving while alive, a guest, never playing, and never acting are not", () => {
    const abandoned = context(
      record({ players: [account(1), dead(2, 3000, 2000)] }),
      [0, 1],
    );
    expect(playerIneligibleReason(abandoned, player(1))).toBe("left_early");
    expect(playerIneligibleReason(abandoned, player(1, "guest"))).toBe("guest");
    const alive = context(
      record({ players: [account(1), { ...account(2), leftTurn: 4000 }] }),
      [0, 1],
    );
    expect(playerIneligibleReason(alive, player(1))).toBe("left_early");
    const never = context(
      record({
        players: [account(1), { ...account(2), fate: "never-spawned" }],
      }),
      [0, 1],
    );
    expect(playerIneligibleReason(never, player(1))).toBe("not_spawned");
    const idle = context(record({ players: [account(1), dead(2, 3000)] }), [0]);
    expect(playerIneligibleReason(idle, player(1))).toBe("no_action");
  });
});

describe("who counts towards the player-count multiplier", () => {
  const counts = (r: ReturnType<typeof record>, who: number) =>
    countsAsParticipant(r, playerCompleted(r, who), true, clientIdOf(who));
  const playerCompleted = (r: ReturnType<typeof record>, who: number) =>
    completedByClient(
      outcomesByClient(
        r,
        r.info.players.map((p) => p.clientID),
        true,
      ),
    ).get(clientIdOf(who)) === true;

  it("an eliminated player counts once they are gone: leaving a dead seat does not shrink the game", () => {
    expect(counts(record({ players: [account(1), dead(2, 3000)] }), 1)).toBe(
      true,
    );
    expect(
      counts(record({ players: [account(1), dead(2, 3000, 3040)] }), 1),
    ).toBe(true);
  });

  it("an elimination in the first two minutes does not count: a free kill must not inflate the game", () => {
    expect(
      counts(
        record({
          players: [account(1), dead(2, ECONOMY.minEliminationTick - 1)],
        }),
        1,
      ),
    ).toBe(false);
  });

  it("neither does one who left before the death, nor one who left while alive", () => {
    expect(
      counts(record({ players: [account(1), dead(2, 3000, 2000)] }), 1),
    ).toBe(false);
    expect(
      counts(
        record({ players: [account(1), { ...account(2), leftTurn: 4000 }] }),
        1,
      ),
    ).toBe(false);
  });

  it("a player who did not act counts for nothing, dead or alive", () => {
    const r = record({ players: [account(1), dead(2, 3000)] });
    expect(countsAsParticipant(r, true, false, clientIdOf(1))).toBe(false);
    expect(countsAsParticipant(r, true, false, clientIdOf(0))).toBe(false);
    expect(countsAsParticipant(r, true, true, "stranger1")).toBe(false);
  });
});
