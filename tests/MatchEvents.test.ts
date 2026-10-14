import {
  GameMode,
  PlayerInfo,
  PlayerType,
} from "@openfront/engine-api/game/GameTypes";
import { GameUpdateType } from "@openfront/engine-api/game/GameUpdates";
import {
  MATCH_EVENT_TYPES,
  matchEventCategory,
  type MatchEvent,
  type MatchEventType,
} from "@openfront/engine-api/game/MatchEvents";
import { AdminCommandExecution } from "@openfront/engine/execution/AdminCommandExecution";
import { AllianceRequestExecution } from "@openfront/engine/execution/alliance/AllianceRequestExecution";
import { BreakAllianceExecution } from "@openfront/engine/execution/alliance/BreakAllianceExecution";
import { AttackExecution } from "@openfront/engine/execution/AttackExecution";
import { SpawnExecution } from "@openfront/engine/execution/SpawnExecution";
import { Execution, Game, Player } from "@openfront/engine/game/Game";
import { snapshotGame } from "@openfront/engine/snapshot/GameSnapshot";
import {
  decodeSnapshotValue,
  encodeSnapshotValue,
} from "@openfront/engine/snapshot/SnapshotCodec";
import { setup } from "./util/Setup";
import { diffSnapshots, restoreTestGame, roundTrip } from "./util/Snapshot";

/**
 * The match feed's events come out of the real simulation: these tests drive
 * actual state transitions (attacks, alliances, tiles changing hands, staff
 * commands) and read what `GameUpdateType.MatchEvent` carries, rather than
 * calling the tracker with made-up arguments.
 */

function collect(game: Game, ticks: number): MatchEvent[] {
  const out: MatchEvent[] = [];
  for (let i = 0; i < ticks; i++) {
    const updates = game.executeNextTick();
    for (const u of updates[GameUpdateType.MatchEvent]) out.push(u.event);
  }
  return out;
}

const ofType = (events: MatchEvent[], type: MatchEventType) =>
  events.filter((e) => e.type === type);

function addPlayer(
  game: Game,
  name: string,
  type: PlayerType = PlayerType.Human,
): Player {
  game.addPlayer(new PlayerInfo(name, type, `client_${name}`, name));
  return game.player(name);
}

/** `count` tiles in row-major order from `start`, as the player's land. */
function claim(game: Game, p: Player, start: number, count: number): void {
  const width = game.width();
  for (let i = start; i < start + count; i++) {
    p.conquer(game.ref(i % width, Math.floor(i / width)));
  }
  if (!p.hasSpawned()) p.setSpawnTile(game.ref(start % width, 0));
}

/** The player has exactly the land `[start, start+count)`. */
function setLand(game: Game, p: Player, start: number, count: number): void {
  for (const t of [...p.tiles()]) p.relinquish(t);
  claim(game, p, start, count);
}

describe("MatchEvents: sampled states and the shape of an event", () => {
  let game: Game;

  beforeEach(async () => {
    game = await setup("plains");
  });

  test("every event type has a category, severities are the documented ones", () => {
    for (const t of MATCH_EVENT_TYPES) {
      expect(["combat", "diplomacy", "territory", "system"]).toContain(
        matchEventCategory(t),
      );
    }
  });

  describe("largest nation", () => {
    test("the first leader is tracked silently; a real change is announced once it has held", () => {
      const a = addPlayer(game, "a");
      const b = addPlayer(game, "b");
      setLand(game, a, 0, 600);
      setLand(game, b, 1000, 400);
      // First sample seeds the leader (a) without announcing anyone.
      expect(ofType(collect(game, 11), "largest_nation_changed")).toEqual([]);

      setLand(game, b, 1000, 900);
      // Not yet: the lead has to hold for LEADER_DEBOUNCE ticks.
      expect(ofType(collect(game, 20), "largest_nation_changed")).toEqual([]);
      const events = ofType(collect(game, 40), "largest_nation_changed");
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        type: "largest_nation_changed",
        severity: "major",
        actor: b.smallID(),
        target: null,
      });
      expect(events[0].meta.share).toBe(9); // 900 of 10 000 land tiles
      // And it is not announced again while nothing changes.
      expect(ofType(collect(game, 200), "largest_nation_changed")).toEqual([]);
    });

    test("a lead that does not last is never announced", () => {
      const a = addPlayer(game, "a");
      const b = addPlayer(game, "b");
      setLand(game, a, 0, 600);
      setLand(game, b, 1000, 400);
      collect(game, 11);
      setLand(game, b, 1000, 900);
      collect(game, 10); // one sample with b ahead...
      setLand(game, b, 1000, 300); // ...then it is gone
      expect(ofType(collect(game, 200), "largest_nation_changed")).toEqual([]);
    });

    test("equal land does not change the leader, whoever is listed first", () => {
      const a = addPlayer(game, "a");
      const b = addPlayer(game, "b");
      setLand(game, a, 0, 400);
      setLand(game, b, 1000, 600); // b leads; a comes first in player order
      collect(game, 11);
      setLand(game, a, 0, 600); // tied
      expect(ofType(collect(game, 200), "largest_nation_changed")).toEqual([]);
      setLand(game, a, 0, 601); // now really ahead
      const events = ofType(collect(game, 60), "largest_nation_changed");
      expect(events).toHaveLength(1);
      expect(events[0].actor).toBe(a.smallID());
    });

    test("a back-and-forth race is a few lines, not a stream (cooldown)", () => {
      const a = addPlayer(game, "a");
      const b = addPlayer(game, "b");
      setLand(game, a, 0, 600);
      setLand(game, b, 1000, 400);
      collect(game, 11);
      const all: MatchEvent[] = [];
      for (let round = 0; round < 8; round++) {
        // b ahead for 5 s, then a ahead for 5 s, and so on.
        setLand(game, b, 1000, round % 2 === 0 ? 900 : 300);
        all.push(...ofType(collect(game, 50), "largest_nation_changed"));
      }
      expect(all.length).toBeGreaterThan(0);
      expect(all.length).toBeLessThanOrEqual(3);
      // Consecutive announcements are at least the cooldown apart.
      for (let i = 1; i < all.length; i++) {
        expect(all[i].tick - all[i - 1].tick).toBeGreaterThanOrEqual(150);
      }
    });

    test("a leader too small to matter, and a tribe, are not news", () => {
      const a = addPlayer(game, "a");
      const b = addPlayer(game, "b");
      const tribe = addPlayer(game, "tribe", PlayerType.Bot);
      setLand(game, a, 0, 50);
      setLand(game, b, 1000, 40);
      collect(game, 11);
      setLand(game, b, 1000, 90); // b leads, but with < 1% of the map
      setLand(game, tribe, 3000, 4000); // a huge tribe does not count as a nation
      expect(ofType(collect(game, 300), "largest_nation_changed")).toEqual([]);
    });

    test("the old leader being eliminated makes the next largest the leader", () => {
      const a = addPlayer(game, "a");
      const b = addPlayer(game, "b");
      setLand(game, a, 0, 600);
      setLand(game, b, 1000, 400);
      collect(game, 11);
      for (const t of [...a.tiles()]) a.relinquish(t);
      const events = ofType(collect(game, 60), "largest_nation_changed");
      expect(events).toHaveLength(1);
      expect(events[0].actor).toBe(b.smallID());
    });
  });

  describe("major territory loss", () => {
    test("each milestone fires once, at the percent crossed, and not every tick", () => {
      const a = addPlayer(game, "a");
      setLand(game, a, 0, 1000);
      expect(ofType(collect(game, 30), "major_territory_loss")).toEqual([]);

      setLand(game, a, 0, 700); // lost 30%
      let events = ofType(collect(game, 100), "major_territory_loss");
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        severity: "normal",
        actor: null,
        target: a.smallID(),
        meta: { percent: 25 },
      });

      setLand(game, a, 0, 600); // 40%: nothing new
      expect(ofType(collect(game, 100), "major_territory_loss")).toEqual([]);

      setLand(game, a, 0, 450); // 55%
      events = ofType(collect(game, 100), "major_territory_loss");
      expect(events).toHaveLength(1);
      expect(events[0].meta.percent).toBe(50);
      expect(events[0].severity).toBe("major");

      // Holding at the same level for a long time says nothing more.
      expect(ofType(collect(game, 500), "major_territory_loss")).toEqual([]);
    });

    test("a collapse crossing several milestones at once is one line, for the highest", () => {
      const a = addPlayer(game, "a");
      setLand(game, a, 0, 1000);
      collect(game, 11);
      setLand(game, a, 0, 200); // 80% gone
      const events = ofType(collect(game, 100), "major_territory_loss");
      expect(events).toHaveLength(1);
      expect(events[0].meta.percent).toBe(75);
      // The milestones below are spent too.
      setLand(game, a, 0, 600);
      setLand(game, a, 0, 200);
      expect(ofType(collect(game, 100), "major_territory_loss")).toEqual([]);
    });

    test("the percentage is of the player's peak, not of where it started", () => {
      const a = addPlayer(game, "a");
      setLand(game, a, 0, 400);
      collect(game, 11);
      setLand(game, a, 0, 1000); // grew to 1000...
      collect(game, 11);
      setLand(game, a, 0, 450); // ...and is back to 450: 55% of the peak
      const events = ofType(collect(game, 100), "major_territory_loss");
      expect(events).toHaveLength(1);
      expect(events[0].meta.percent).toBe(50);
    });

    test("a small player's losses and a tribe's are not reported", () => {
      const small = addPlayer(game, "small");
      const tribe = addPlayer(game, "tribe", PlayerType.Bot);
      setLand(game, small, 0, 150); // below 2% of the map
      setLand(game, tribe, 2000, 1000);
      collect(game, 11);
      setLand(game, small, 0, 20);
      setLand(game, tribe, 2000, 100);
      expect(ofType(collect(game, 100), "major_territory_loss")).toEqual([]);
    });

    test("an elimination is not also a 100% territory loss", () => {
      const a = addPlayer(game, "a");
      setLand(game, a, 0, 1000);
      collect(game, 11);
      for (const t of [...a.tiles()]) a.relinquish(t);
      const events = collect(game, 100);
      expect(ofType(events, "major_territory_loss")).toEqual([]);
    });
  });
});

describe("MatchEvents: eliminations and who gets the credit", () => {
  let game: Game;
  let attacker: Player;
  let victim: Player;

  const spawn = (p: Player, x: number, y: number) =>
    new SpawnExecution("game_id", p.info(), game.ref(x, y));

  beforeEach(async () => {
    game = await setup("plains", {
      infiniteGold: true,
      instantBuild: true,
      infiniteTroops: true,
    });
    game.addPlayer(new PlayerInfo("attacker", PlayerType.Human, "ca", "att1"));
    game.addPlayer(new PlayerInfo("victim", PlayerType.Human, "cv", "vic1"));
    game.addExecution(
      spawn(game.player("att1"), 10, 10),
      spawn(game.player("vic1"), 14, 10),
    );
    game.executeNextTick();
    game.executeNextTick();
    attacker = game.player("att1");
    victim = game.player("vic1");
    expect(victim.isAlive()).toBe(true);
  });

  test("an attack that takes a player's last land credits the attacker", () => {
    game.addExecution(new AttackExecution(1_000_000, attacker, victim.id()));
    const events = collect(game, 400);
    const eliminated = ofType(events, "player_eliminated");
    expect(victim.isAlive()).toBe(false);
    expect(eliminated).toHaveLength(1);
    expect(eliminated[0]).toMatchObject({
      severity: "critical",
      actor: attacker.smallID(),
      target: victim.smallID(),
      meta: { targetKind: "player" },
    });
  });

  test("a death nobody conquered (land simply gone) names no killer", () => {
    const run = (mg: Game) => {
      for (const t of [...victim.tiles()]) victim.relinquish(t);
      return mg;
    };
    game.addExecution({
      init: (mg: Game) => void run(mg),
      tick: () => {},
      isActive: () => false,
      activeDuringSpawnPhase: () => true,
    } as unknown as Execution);
    const eliminated = ofType(collect(game, 5), "player_eliminated");
    expect(eliminated).toHaveLength(1);
    expect(eliminated[0]).toMatchObject({
      actor: null,
      target: victim.smallID(),
    });
  });

  test("a conquest that leaves the victim alive does not lend its credit to a later death", () => {
    // conquerPlayer ran (as when an attack breaks a defender) but a tile was
    // left, so the player is still in the game at the end of that tick.
    game.addExecution({
      init: (mg: Game) => mg.conquerPlayer(attacker, victim),
      tick: () => {},
      isActive: () => false,
      activeDuringSpawnPhase: () => true,
    } as unknown as Execution);
    expect(ofType(collect(game, 3), "player_eliminated")).toEqual([]);
    // A nuke (or anything else) finishes the player off later: not the attacker's kill.
    for (const t of [...victim.tiles()]) victim.relinquish(t);
    const eliminated = ofType(collect(game, 5), "player_eliminated");
    expect(eliminated).toHaveLength(1);
    expect(eliminated[0].actor).toBeNull();
  });

  test("an elimination is reported once, however the executions interleave", () => {
    game.addExecution(new AttackExecution(1_000_000, attacker, victim.id()));
    const events = collect(game, 600);
    expect(ofType(events, "player_eliminated")).toHaveLength(1);
  });

  test("a tribe falling is bookkeeping (normal), not news", () => {
    const tribe = addPlayer(game, "tribe", PlayerType.Bot);
    game.addExecution(
      new SpawnExecution("game_id", tribe.info(), game.ref(6, 10)),
    );
    collect(game, 3);
    game.addExecution(new AttackExecution(1_000_000, attacker, tribe.id()));
    const eliminated = ofType(collect(game, 400), "player_eliminated").filter(
      (e) => e.target === tribe.smallID(),
    );
    expect(eliminated).toHaveLength(1);
    expect(eliminated[0]).toMatchObject({
      severity: "normal",
      meta: { targetKind: "bot" },
    });
  });
});

describe("MatchEvents: alliances", () => {
  let game: Game;
  let a: Player;
  let b: Player;
  let c: Player;

  beforeEach(async () => {
    game = await setup("plains", {}, [
      new PlayerInfo("a", PlayerType.Human, null, "a"),
      new PlayerInfo("b", PlayerType.Human, null, "b"),
      new PlayerInfo("c", PlayerType.Human, null, "c"),
    ]);
    a = game.player("a");
    b = game.player("b");
    c = game.player("c");
    a.conquer(game.ref(0, 0));
    b.conquer(game.ref(0, 1));
    c.conquer(game.ref(0, 2));
  });

  test("forming an alliance is reported when the request is accepted, not when it is made", () => {
    game.addExecution(new AllianceRequestExecution(a, b.id()));
    expect(ofType(collect(game, 3), "alliance_formed")).toEqual([]);
    game.addExecution(new AllianceRequestExecution(b, a.id()));
    const formed = ofType(collect(game, 3), "alliance_formed");
    expect(a.isAlliedWith(b)).toBe(true);
    expect(formed).toHaveLength(1);
    // The one who asked first is the actor.
    expect(formed[0]).toMatchObject({
      severity: "normal",
      actor: a.smallID(),
      target: b.smallID(),
    });
  });

  test("a rejected request is not an alliance", () => {
    game.addExecution(new AllianceRequestExecution(a, b.id()));
    collect(game, 2);
    const reqs = b.incomingAllianceRequests();
    expect(reqs).toHaveLength(1);
    reqs[0].reject();
    expect(ofType(collect(game, 3), "alliance_formed")).toEqual([]);
  });

  test("breaking an alliance names who broke it", () => {
    game.addExecution(new AllianceRequestExecution(a, b.id()));
    game.addExecution(new AllianceRequestExecution(b, a.id()));
    collect(game, 3);
    game.addExecution(new BreakAllianceExecution(b, a.id()));
    const broken = ofType(collect(game, 3), "alliance_broken");
    expect(broken).toHaveLength(1);
    expect(broken[0]).toMatchObject({
      severity: "major",
      actor: b.smallID(),
      target: a.smallID(),
      meta: { cause: "broken" },
    });
  });

  test("an alliance running out is neutral: no culprit, and not a major event", () => {
    game.config().allianceDuration = () => 30;
    game.addExecution(new AllianceRequestExecution(a, b.id()));
    game.addExecution(new AllianceRequestExecution(b, a.id()));
    collect(game, 3);
    expect(a.isAlliedWith(b)).toBe(true);
    // PlayerExecution (which expires alliances) only exists for spawned players.
    game.addExecution(
      new SpawnExecution("game_id", a.info(), game.ref(40, 40)),
      new SpawnExecution("game_id", b.info(), game.ref(60, 60)),
    );
    const events = collect(game, 80);
    const ended = ofType(events, "alliance_broken");
    expect(a.isAlliedWith(b)).toBe(false);
    expect(ended).toHaveLength(1);
    expect(ended[0]).toMatchObject({
      severity: "normal",
      meta: { cause: "expired" },
    });
    expect([ended[0].actor, ended[0].target].sort()).toEqual(
      [a.smallID(), b.smallID()].sort(),
    );
  });

  test("an ally being eliminated ends the alliance quietly (the elimination is the news)", () => {
    game.addExecution(new AllianceRequestExecution(a, b.id()));
    game.addExecution(new AllianceRequestExecution(b, a.id()));
    collect(game, 3);
    expect(a.isAlliedWith(b)).toBe(true);
    for (const t of [...b.tiles()]) b.relinquish(t);
    game.addExecution(
      new SpawnExecution("game_id", b.info(), game.ref(60, 60)),
    );
    const events = collect(game, 5);
    expect(ofType(events, "alliance_broken")).toEqual([]);
  });

  test("alliance state changes only: nothing repeats on quiet ticks", () => {
    game.addExecution(new AllianceRequestExecution(a, b.id()));
    game.addExecution(new AllianceRequestExecution(b, a.id()));
    const first = collect(game, 3);
    expect(ofType(first, "alliance_formed")).toHaveLength(1);
    expect(ofType(collect(game, 300), "alliance_formed")).toEqual([]);
  });
});

describe("MatchEvents: the match itself and staff actions", () => {
  test("the match starting is reported once, when the spawn phase ends in a tick", async () => {
    const game = await setup("plains", {}, [], undefined, undefined, false);
    game.addExecution({
      init: (mg: Game) => mg.endSpawnPhase(),
      tick: () => {},
      isActive: () => false,
      activeDuringSpawnPhase: () => true,
    } as unknown as Execution);
    const events = collect(game, 5);
    expect(ofType(events, "game_started")).toHaveLength(1);
    expect(ofType(events, "game_started")[0]).toMatchObject({
      severity: "normal",
      actor: null,
      target: null,
    });
  });

  test("a winner ends the match with a critical event naming them", async () => {
    const game = await setup("plains");
    const a = addPlayer(game, "a");
    claim(game, a, 0, 10);
    game.addExecution({
      init: (mg: Game) => mg.setWinner(a, mg.stats().stats()),
      tick: () => {},
      isActive: () => false,
      activeDuringSpawnPhase: () => true,
    } as unknown as Execution);
    const events = ofType(collect(game, 3), "game_ending");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      severity: "critical",
      actor: a.smallID(),
    });
  });

  test("a team win names the team, not a player", async () => {
    const game = await setup("plains", {
      gameMode: GameMode.Team,
      playerTeams: 2,
    });
    game.addExecution({
      init: (mg: Game) => mg.setWinner("Red", mg.stats().stats()),
      tick: () => {},
      isActive: () => false,
      activeDuringSpawnPhase: () => true,
    } as unknown as Execution);
    const events = ofType(collect(game, 3), "game_ending");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ actor: null, meta: { team: "Red" } });
  });

  describe("staff commands", () => {
    let game: Game;
    let admin: Player;
    let victim: Player;

    beforeEach(async () => {
      game = await setup("plains");
      admin = addPlayer(game, "admin");
      victim = addPlayer(game, "victim");
      claim(game, admin, 0, 300);
      claim(game, victim, 1000, 300);
      game.addExecution(
        new SpawnExecution("game_id", admin.info(), game.ref(80, 80)),
        new SpawnExecution("game_id", victim.info(), game.ref(20, 80)),
      );
      collect(game, 3);
    });

    test("a staff command is announced with the command, who ran it and on whom — no amounts", () => {
      game.addExecution(
        new AdminCommandExecution(admin, "give_gold", victim.id(), 123_456),
      );
      const events = ofType(collect(game, 2), "admin_action");
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        severity: "major",
        actor: admin.smallID(),
        target: victim.smallID(),
        meta: { command: "give_gold" },
      });
      expect(JSON.stringify(events[0])).not.toContain("123456");
    });

    test("a staff elimination is one line: the action, not also an anonymous 'was eliminated'", () => {
      game.addExecution(
        new AdminCommandExecution(admin, "eliminate", victim.id(), undefined),
      );
      const events = collect(game, 5);
      expect(victim.isAlive()).toBe(false);
      expect(ofType(events, "admin_action")).toHaveLength(1);
      expect(ofType(events, "player_eliminated")).toEqual([]);
    });

    test("a second force-win changes nothing and is not announced again", () => {
      game.addExecution(
        new AdminCommandExecution(admin, "force_win", victim.id(), undefined),
      );
      expect(ofType(collect(game, 3), "admin_action")).toHaveLength(1);
      game.addExecution(
        new AdminCommandExecution(admin, "force_win", victim.id(), undefined),
      );
      const again = collect(game, 3);
      expect(ofType(again, "admin_action")).toEqual([]);
      expect(ofType(again, "game_ending")).toEqual([]);
    });

    test("forcing a winner is announced as the action and as the end of the match", () => {
      game.addExecution(
        new AdminCommandExecution(admin, "force_win", victim.id(), undefined),
      );
      const events = collect(game, 3);
      const action = ofType(events, "admin_action");
      expect(action).toHaveLength(1);
      expect(action[0]).toMatchObject({
        severity: "critical",
        meta: { command: "force_win" },
      });
      expect(ofType(events, "game_ending")).toHaveLength(1);
    });
  });
});

describe("MatchEvents: determinism", () => {
  async function play(): Promise<MatchEvent[]> {
    const game = await setup("plains", {
      infiniteGold: true,
      instantBuild: true,
      infiniteTroops: true,
    });
    game.addPlayer(new PlayerInfo("attacker", PlayerType.Human, "ca", "att1"));
    game.addPlayer(new PlayerInfo("victim", PlayerType.Human, "cv", "vic1"));
    game.addExecution(
      new SpawnExecution(
        "game_id",
        game.player("att1").info(),
        game.ref(10, 10),
      ),
      new SpawnExecution(
        "game_id",
        game.player("vic1").info(),
        game.ref(14, 10),
      ),
    );
    collect(game, 2);
    game.addExecution(
      new AttackExecution(
        1_000_000,
        game.player("att1"),
        game.player("vic1").id(),
      ),
    );
    return collect(game, 600);
  }

  test("two runs of the same game produce the same events, in the same order", async () => {
    const first = await play();
    const second = await play();
    expect(first.length).toBeGreaterThan(0);
    expect(second).toEqual(first);
    // Numbered consecutively from the first (the match start, emitted while the
    // test's setup ended the spawn phase outside a tick, is not in the list).
    first.forEach((e, i) => expect(e.seq).toBe(first[0].seq + i));
  });
});

describe("MatchEvents: snapshots", () => {
  test("a restored game carries on with the same feed: pending leader, spent milestones, numbering", async () => {
    const game = await setup("plains");
    const a = addPlayer(game, "a");
    const b = addPlayer(game, "b");
    const c = addPlayer(game, "c");
    setLand(game, a, 0, 600);
    setLand(game, b, 1000, 400);
    setLand(game, c, 3000, 1000);
    collect(game, 11); // the leader is seeded
    setLand(game, c, 3000, 700); // c lost 30%: milestone 25 is spent
    collect(game, 10);
    setLand(game, b, 1000, 900); // b takes the lead; the debounce is half way
    collect(game, 11);

    const { bytes, restored, again } = await roundTrip(game, "plains");
    expect(diffSnapshots(bytes, again)).toEqual([]);

    const original = collect(game, 100);
    const resumed = collect(restored, 100);
    // b's lead completes, c's 25% is not announced a second time.
    expect(ofType(original, "largest_nation_changed")).toHaveLength(1);
    expect(ofType(original, "major_territory_loss")).toEqual([]);
    expect(resumed).toEqual(original);
  });

  test("a snapshot from before the feed existed still restores", async () => {
    const game = await setup("plains");
    const bytes = snapshotGame(game);
    const root = decodeSnapshotValue(bytes) as {
      game: { d: Record<string, unknown> };
    };
    expect(root.game.d).toHaveProperty("matchEvents");
    delete root.game.d.matchEvents;
    const restored = await restoreTestGame(encodeSnapshotValue(root), "plains");
    expect(collect(restored, 20)).toEqual([]);
  });
});
