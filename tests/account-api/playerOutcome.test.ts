// @vitest-environment node
import { describe, expect, it } from "vitest";
import { ECONOMY } from "../../src/account-api/domain/constants";
import {
  isCompleted,
  isCompletedOutcome,
  playerProgressionOutcome,
  RESULT_GRACE_TURNS,
  resultFor,
  type PlayerProgressionOutcome,
} from "../../src/account-api/domain/stats";
import {
  buildRecord,
  clientIdOf,
  type GameSpec,
  type PlayerSpec,
} from "./util/games";

// What a game came to for one player: the rule behind XP, Credits and the clan
// threshold. Records here are the current game server's: `resultTurn` says when
// the result was determined, and a player's `leftTurn` that the server lost
// their connection then and they never came back.

const account = (n: number): PlayerSpec => ({
  user: { id: `00000000-0000-4000-8000-00000000000${n}` } as never,
});

const RESULT = 6000;

function outcome(
  spec: Partial<GameSpec>,
  who = 0,
  counted = true,
): PlayerProgressionOutcome {
  const record = buildRecord("abCD1234", {
    players: [account(1), account(2)],
    lastTurn: RESULT + 40,
    resultTurn: RESULT,
    ...spec,
  });
  return playerProgressionOutcome(record, clientIdOf(who), counted);
}

const dead = (killedAt: number, leftTurn?: number): PlayerSpec => ({
  ...account(2),
  fate: { killedAt },
  ...(leftTurn === undefined ? {} : { leftTurn }),
});

describe("staying to the result", () => {
  it("alive when the game ends: completed", () => {
    expect(outcome({})).toBe("completed_alive");
    expect(outcome({}, 1)).toBe("completed_alive");
  });

  it("eliminated after the minimum and staying to the end: completed", () => {
    expect(outcome({ players: [account(1), dead(3000)] }, 1)).toBe(
      "completed_eliminated",
    );
  });

  it("being eliminated is a placement, not a reason to lose anything", () => {
    const record = buildRecord("abCD1234", {
      players: [account(1), dead(ECONOMY.minEliminationTick + 1)],
      resultTurn: RESULT,
      lastTurn: RESULT + 40,
    });
    expect(isCompleted(record, clientIdOf(1), true)).toBe(true);
    expect(resultFor(clientIdOf(1), record.info.winner)).toBe("defeat");
  });
});

describe("leaving early", () => {
  it("alive and leaving before the end: left early", () => {
    expect(
      outcome({ players: [account(1), { ...account(2), leftTurn: 4000 }] }, 1),
    ).toBe("left_early");
  });

  it("eliminated and then leaving before the end: left early", () => {
    expect(outcome({ players: [account(1), dead(3000, 4000)] }, 1)).toBe(
      "left_early",
    );
  });

  it("leaving before being eliminated: left early", () => {
    expect(outcome({ players: [account(1), dead(3000, 2000)] }, 1)).toBe(
      "left_early",
    );
  });

  it("a player whose empire outlasted them still left early", () => {
    // gone at 4000; their land is what is left when the others are beaten
    expect(
      outcome({ players: [{ ...account(1), leftTurn: 4000 }, account(2)] }),
    ).toBe("left_early");
  });

  it("an early leave is not completed, and says so for Credits and XP alike", () => {
    expect(isCompletedOutcome("left_early")).toBe(false);
    expect(isCompletedOutcome("disconnected_early")).toBe(false);
  });
});

describe("leaving after the result", () => {
  it("a winner leaving once the win is determined still completed it", () => {
    const winner: PlayerSpec = { ...account(1), leftTurn: RESULT + 10 };
    expect(outcome({ players: [winner, account(2)] })).toBe(
      "won_and_left_after_result",
    );
  });

  it("the moment of the result, and the grace before it, count as after", () => {
    for (const left of [RESULT, RESULT - RESULT_GRACE_TURNS]) {
      expect(
        outcome({ players: [{ ...account(1), leftTurn: left }, account(2)] }),
      ).toBe("won_and_left_after_result");
    }
    expect(
      outcome({
        players: [
          { ...account(1), leftTurn: RESULT - RESULT_GRACE_TURNS - 1 },
          account(2),
        ],
      }),
    ).toBe("left_early");
  });

  it("a winner leaving after the win keeps the victory", () => {
    const record = buildRecord("abCD1234", {
      players: [{ ...account(1), leftTurn: RESULT + 10 }, account(2)],
      resultTurn: RESULT,
      lastTurn: RESULT + 40,
    });
    expect(resultFor(clientIdOf(0), record.info.winner)).toBe("victory");
    expect(isCompleted(record, clientIdOf(0), true)).toBe(true);
  });

  it("anyone who leaves once the game is decided completed it, eliminated or not", () => {
    expect(outcome({ players: [account(1), dead(3000, RESULT + 5)] }, 1)).toBe(
      "completed_eliminated",
    );
    expect(
      outcome(
        { players: [account(1), { ...account(2), leftTurn: RESULT + 5 }] },
        1,
      ),
    ).toBe("completed_alive");
  });

  it("a winner who was eliminated earlier (their team won) is a completed elimination", () => {
    const record = buildRecord("abCD1234", {
      mode: "Team",
      playerTeams: "Humans Vs Nations",
      players: [account(1), dead(3000, RESULT + 5)],
      winner: ["team", "Red", clientIdOf(0), clientIdOf(1)],
      resultTurn: RESULT,
      lastTurn: RESULT + 40,
    });
    expect(playerProgressionOutcome(record, clientIdOf(1), true)).toBe(
      "completed_eliminated",
    );
  });
});

describe("reconnecting", () => {
  it("a drop that came back is not leaving: the server roster is the word", () => {
    // the heartbeat said disconnected at 4000 and connected at 5000: no leftTurn
    expect(
      outcome({
        disconnects: [
          { clientID: clientIdOf(0), turn: 4000, isDisconnected: true },
          { clientID: clientIdOf(0), turn: 5000, isDisconnected: false },
        ],
      }),
    ).toBe("completed_alive");
  });

  it("a heartbeat that has not caught up with a stalled link does not override the roster", () => {
    expect(
      outcome({
        disconnects: [
          { clientID: clientIdOf(0), turn: 5990, isDisconnected: true },
        ],
      }),
    ).toBe("completed_alive");
  });

  it("an eliminated player who dropped, came back and stayed completed it", () => {
    expect(
      outcome(
        {
          players: [account(1), dead(3000)],
          disconnects: [
            { clientID: clientIdOf(1), turn: 2900, isDisconnected: true },
            { clientID: clientIdOf(1), turn: 3400, isDisconnected: false },
          ],
        },
        1,
      ),
    ).toBe("completed_eliminated");
  });

  it("dropping and not returning before the result is leaving", () => {
    expect(
      outcome({ players: [account(1), { ...account(2), leftTurn: 3500 }] }, 1),
    ).toBe("left_early");
  });
});

describe("the other exclusions are unchanged", () => {
  it("a player eliminated in the first two minutes did not complete it, whether or not they stayed", () => {
    expect(
      outcome(
        { players: [account(1), dead(ECONOMY.minEliminationTick - 1)] },
        1,
      ),
    ).toBe("eliminated_early");
    expect(
      outcome(
        {
          players: [
            account(1),
            dead(ECONOMY.minEliminationTick - 1, RESULT + 3),
          ],
        },
        1,
      ),
    ).toBe("eliminated_early");
  });

  it("a player who never owned land did not spawn", () => {
    expect(
      outcome(
        { players: [account(1), { ...account(2), fate: "never-spawned" }] },
        1,
      ),
    ).toBe("not_spawned");
  });

  it("a game with no winner completes nothing", () => {
    expect(outcome({ winner: null, resultTurn: undefined })).toBe("no_winner");
  });

  it("a game that does not count completes nothing", () => {
    expect(outcome({}, 0, false)).toBe("not_counted");
  });

  it("a stranger to the record did not spawn", () => {
    const record = buildRecord("abCD1234", {
      players: [account(1), account(2)],
      resultTurn: RESULT,
    });
    expect(playerProgressionOutcome(record, "nobody01", true)).toBe(
      "not_spawned",
    );
  });
});

describe("a record from before the server stamped who stayed", () => {
  // Only the heartbeat's intents: a player is there unless their latest state,
  // as of the last turn, is disconnected, and a disconnect within the grace of
  // the end is a departure after the result.
  const legacy = (spec: Partial<GameSpec>, who = 0) =>
    playerProgressionOutcome(
      buildRecord("abCD1234", {
        players: [account(1), account(2)],
        lastTurn: RESULT,
        ...spec,
      }),
      clientIdOf(who),
      true,
    );

  it("is present, and completed, with no disconnect", () => {
    expect(legacy({})).toBe("completed_alive");
  });

  it("is gone, and incomplete, after a disconnect that never reversed", () => {
    expect(
      legacy({
        disconnects: [
          { clientID: clientIdOf(0), turn: 5000, isDisconnected: true },
        ],
      }),
    ).toBe("disconnected_early");
  });

  it("is present after a disconnect that reversed", () => {
    expect(
      legacy({
        disconnects: [
          { clientID: clientIdOf(0), turn: 4000, isDisconnected: true },
          { clientID: clientIdOf(0), turn: 4500, isDisconnected: false },
        ],
      }),
    ).toBe("completed_alive");
  });
});
