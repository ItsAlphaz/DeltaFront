import type { AdminCommand } from "@openfront/engine-api/AdminCommands";
import { GameMode, PlayerType } from "@openfront/engine-api/game/GameTypes";
import { GameUpdateType } from "@openfront/engine-api/game/GameUpdates";
import {
  TERRITORY_LOSS_MILESTONES,
  type AllianceEndCause,
  type MatchEvent,
  type MatchEventMeta,
  type MatchEventSeverity,
  type MatchEventType,
} from "@openfront/engine-api/game/MatchEvents";
import { zInt } from "@openfront/engine-lib/snapshot/SnapshotType";
import { z } from "zod";
import type { Game, Player } from "./Game";

/**
 * Derives the match events (engine-api/game/MatchEvents.ts) from simulation
 * state, as `GameUpdateType.MatchEvent` updates.
 *
 * It only watches. Nothing it holds feeds back into the simulation (it is not
 * part of the game hash), so a bug here can make a feed line wrong but never
 * desynchronise a game. It is deterministic all the same: every client runs it
 * on the same state, so a live game and a replay of its record produce the same
 * events on the same ticks.
 *
 * Two kinds of event:
 *  - transitions the engine already performs (an alliance formed or broken, the
 *    last territory of a player captured, a winner set, a staff command run) are
 *    reported by the code that performs them;
 *  - states that merely change over time (who is the largest nation, how much of
 *    its territory a player has lost) are sampled once per second, so a swing of
 *    a few ticks never produces a line.
 *
 * ## Who gets credit for an elimination
 *
 * A player is dead when it owns no tiles. The only place the engine knows who
 * took the last of them is `conquerPlayer(conqueror, conquered)`, called when an
 * attack finishes off a defender or a player's last enclosed territory is
 * absorbed by its captor. That conqueror is recorded as a *claim*, and the
 * elimination names it only if the victim is observed dead before the tick
 * ends. Every other death (a nuke, the doomsday clock, a staff
 * elimination) has no reliable killer and is reported without one: accuracy over
 * drama. See docs/MatchEvents.md.
 */

/** Sampling period, in ticks (one second). */
const SAMPLE_INTERVAL_TICKS = 10;

/**
 * A claim lives until the end of the tick it was made on. The conquest takes
 * the victim's land in the same call, so a victim that is not dead by then did
 * not die of it, and a later death (a nuke, say) must not inherit the credit.
 */

/** A new largest nation must lead on `DEBOUNCE` ticks of unbroken lead before it is announced... */
const LEADER_DEBOUNCE_TICKS = 30;
/** ...and announcements are at least this far apart (a back-and-forth race is not a stream of lines). */
const LEADER_COOLDOWN_TICKS = 150;
/** The leader must hold at least this share of the land (and tiles) to be worth announcing. */
const LEADER_MIN_SHARE_PERCENT = 3;
const LEADER_MIN_TILES = 100;

/** A player's peak must reach this share of the land (and tiles) for its losses to be reported. */
const LOSS_MIN_PEAK_SHARE_PERCENT = 2;
const LOSS_MIN_PEAK_TILES = 150;

export const MatchEventsStateSchema = z.object({
  seq: zInt(),
  reported: z.array(zInt()),
  claims: z.array(z.tuple([zInt(), zInt(), zInt()])),
  leader: z.string().nullable(),
  candidate: z.object({ key: z.string(), since: zInt() }).nullable(),
  lastLeaderEventTick: zInt().nullable(),
  peaks: z.array(z.tuple([zInt(), zInt()])),
  milestones: z.array(z.tuple([zInt(), zInt()])),
});
export type MatchEventsState = z.infer<typeof MatchEventsStateSchema>;

interface Claim {
  killer: number;
  tick: number;
}

interface Leader {
  key: string;
  tiles: number;
  player: number | null;
  team: string | null;
}

export class MatchEvents {
  private seq = 0;
  /** smallIDs whose elimination has been reported (once each). */
  private reported = new Set<number>();
  /** victim smallID -> the player that captured its last territory. */
  private claims = new Map<number, Claim>();

  private leader: string | null = null;
  private candidate: { key: string; since: number } | null = null;
  private lastLeaderEventTick: number | null = null;

  /** smallID -> most tiles the player has held. */
  private peaks = new Map<number, number>();
  /** smallID -> highest territory-loss milestone already reported. */
  private milestones = new Map<number, number>();

  constructor(private readonly mg: Game) {}

  // ---- Transitions reported by the code that performs them ----

  gameStarted(): void {
    this.emit("game_started", "normal", null, null);
  }

  gameEnding(winner: Player | string | null): void {
    const meta: MatchEventMeta = {};
    let actor: number | null = null;
    if (typeof winner === "string") meta.team = winner;
    else if (winner !== null) actor = winner.smallID();
    this.emit("game_ending", "critical", actor, null, meta);
  }

  /** `killer` took the last territory of `victim`; named if `victim` is then seen dead. */
  claimKill(killer: Player, victim: Player): void {
    if (killer === victim) return;
    this.claims.set(victim.smallID(), {
      killer: killer.smallID(),
      tick: this.mg.ticks(),
    });
  }

  /**
   * `victim` is out of tiles. Called by the player's own execution when it sees
   * the death and again at the end of the tick for claimed kills, so the
   * elimination is reported once however the two interleave.
   */
  playerDied(victim: Player): void {
    const id = victim.smallID();
    if (this.reported.has(id)) return;
    this.reported.add(id);
    const claim = this.claims.get(id);
    this.claims.delete(id);
    const killer =
      claim !== undefined && claim.tick === this.mg.ticks()
        ? claim.killer
        : null;
    const targetKind = victim.type() === PlayerType.Bot ? "bot" : "player";
    this.emit(
      "player_eliminated",
      // A tribe falling is bookkeeping; a player or nation falling is news.
      targetKind === "bot" ? "normal" : "critical",
      killer,
      id,
      { targetKind },
    );
  }

  allianceFormed(requestor: Player, recipient: Player): void {
    this.emit(
      "alliance_formed",
      "normal",
      requestor.smallID(),
      recipient.smallID(),
    );
  }

  /** `breaker` ended the alliance with `other` (the engine knows who did). */
  allianceBroken(breaker: Player, other: Player): void {
    this.allianceEnd("major", "broken", breaker, other);
  }

  /** The alliance ran out. Neutral: `a` and `b` are just its two sides. */
  allianceExpired(a: Player, b: Player): void {
    this.allianceEnd("normal", "expired", a, b);
  }

  private allianceEnd(
    severity: MatchEventSeverity,
    cause: AllianceEndCause,
    actor: Player,
    target: Player,
  ): void {
    this.emit("alliance_broken", severity, actor.smallID(), target.smallID(), {
      cause,
    });
  }

  /** A staff command ran (the server authorized it before the intent was relayed). */
  adminAction(
    issuer: Player,
    command: AdminCommand,
    target: Player | null,
  ): void {
    // The staff elimination is its own line; the death it causes is not a second one.
    if (command === "eliminate" && target !== null) {
      this.reported.add(target.smallID());
    }
    this.emit(
      "admin_action",
      command === "force_win" ? "critical" : "major",
      issuer.smallID(),
      target === null ? null : target.smallID(),
      { command },
    );
  }

  // ---- Sampled states ----

  /**
   * Once per tick, after every execution has run. The feed only watches, so a
   * failure here must cost a feed line at worst, never the tick: it runs on
   * every client inside the simulation loop.
   */
  tick(ticks: number): void {
    try {
      this.resolveClaims();
      if (this.mg.inSpawnPhase() || ticks % SAMPLE_INTERVAL_TICKS !== 0) return;
      const land = this.mg.totalLandTiles();
      if (land <= 0) return;
      this.sampleLeader(ticks, land);
      this.sampleTerritory(land);
    } catch (e) {
      console.error("match events: sampling failed", e);
    }
  }

  /** Reports the claimed kills whose victim is now dead; every claim ends with the tick. */
  private resolveClaims(): void {
    for (const victimID of [...this.claims.keys()]) {
      const victim = this.mg.playerBySmallID(victimID);
      if (victim.isPlayer() && !victim.isAlive()) {
        this.playerDied(victim);
      }
      this.claims.delete(victimID);
    }
  }

  private sampleLeader(ticks: number, land: number): void {
    const best = this.largest();
    if (best === null) return;
    if (best.key === this.leader) {
      this.candidate = null;
      return;
    }
    // The first leader, and any leader too small to be news (the opening
    // seconds, when whoever has one more tile "leads"), is tracked silently.
    const worthy =
      best.tiles >= LEADER_MIN_TILES &&
      best.tiles * 100 >= land * LEADER_MIN_SHARE_PERCENT;
    if (this.leader === null || !worthy) {
      this.leader = best.key;
      this.candidate = null;
      return;
    }
    if (this.candidate === null || this.candidate.key !== best.key) {
      this.candidate = { key: best.key, since: ticks };
    }
    const held = ticks - this.candidate.since >= LEADER_DEBOUNCE_TICKS;
    const rested =
      this.lastLeaderEventTick === null ||
      ticks - this.lastLeaderEventTick >= LEADER_COOLDOWN_TICKS;
    if (!held || !rested) return;
    this.leader = best.key;
    this.candidate = null;
    this.lastLeaderEventTick = ticks;
    this.emit(
      "largest_nation_changed",
      "major",
      best.player,
      null,
      best.team === null
        ? { share: Math.floor((best.tiles * 100) / land) }
        : { share: Math.floor((best.tiles * 100) / land), team: best.team },
    );
  }

  /** The side holding the most land: a player, or a whole team in team games. */
  private largest(): Leader | null {
    const byTeam = this.mg.config().gameConfig().gameMode === GameMode.Team;
    const sides = new Map<string, Leader>();
    for (const p of this.mg.players()) {
      // Tribes are filler, not nations; an unspawned player owns nothing yet.
      if (p.type() === PlayerType.Bot || !p.hasSpawned()) continue;
      const team = p.team();
      if (byTeam && team === null) continue;
      const key = byTeam ? `t:${team}` : `p:${p.smallID()}`;
      const side = sides.get(key);
      if (side === undefined) {
        sides.set(key, {
          key,
          tiles: p.numTilesOwned(),
          player: byTeam ? null : p.smallID(),
          team: byTeam ? team : null,
        });
      } else {
        side.tiles += p.numTilesOwned();
      }
    }
    let best: Leader | null = null;
    for (const side of sides.values()) {
      if (best === null || side.tiles > best.tiles) best = side;
    }
    // A tie keeps whoever already holds the title: no flip-flopping on equal land.
    const holder = this.leader === null ? undefined : sides.get(this.leader);
    if (best !== null && holder !== undefined && holder.tiles === best.tiles) {
      return holder;
    }
    return best;
  }

  private sampleTerritory(land: number): void {
    for (const p of this.mg.players()) {
      if (p.type() === PlayerType.Bot || !p.hasSpawned()) continue;
      const id = p.smallID();
      const tiles = p.numTilesOwned();
      const peak = Math.max(this.peaks.get(id) ?? 0, tiles);
      this.peaks.set(id, peak);
      if (
        peak < LOSS_MIN_PEAK_TILES ||
        peak * 100 < land * LOSS_MIN_PEAK_SHARE_PERCENT
      ) {
        continue;
      }
      const lostPercent = Math.floor(((peak - tiles) * 100) / peak);
      const done = this.milestones.get(id) ?? 0;
      let crossed = 0;
      for (const m of TERRITORY_LOSS_MILESTONES) {
        if (lostPercent >= m && m > done) crossed = m;
      }
      if (crossed === 0) continue;
      // Every milestone up to the one crossed is spent, so a big swing is one line.
      this.milestones.set(id, crossed);
      this.emit(
        "major_territory_loss",
        // A quarter lost is worth a log line; half or more is worth the ticker.
        crossed >= 50 ? "major" : "normal",
        null,
        id,
        { percent: crossed },
      );
    }
  }

  private emit(
    type: MatchEventType,
    severity: MatchEventSeverity,
    actor: number | null,
    target: number | null,
    meta: MatchEventMeta = {},
  ): void {
    const event: MatchEvent = {
      seq: this.seq++,
      tick: this.mg.ticks(),
      type,
      severity,
      actor,
      target,
      meta,
    };
    this.mg.addUpdate({ type: GameUpdateType.MatchEvent, event });
  }

  // ---- Snapshots ----

  snapshot(): MatchEventsState {
    return {
      seq: this.seq,
      reported: [...this.reported],
      claims: [...this.claims].map(([victim, c]): [number, number, number] => [
        victim,
        c.killer,
        c.tick,
      ]),
      leader: this.leader,
      candidate: this.candidate === null ? null : { ...this.candidate },
      lastLeaderEventTick: this.lastLeaderEventTick,
      peaks: [...this.peaks],
      milestones: [...this.milestones],
    };
  }

  restoreSnapshot(s: MatchEventsState): void {
    this.seq = s.seq;
    this.reported = new Set(s.reported);
    this.claims = new Map(
      s.claims.map(([victim, killer, tick]) => [victim, { killer, tick }]),
    );
    this.leader = s.leader;
    this.candidate = s.candidate === null ? null : { ...s.candidate };
    this.lastLeaderEventTick = s.lastLeaderEventTick;
    this.peaks = new Map(s.peaks);
    this.milestones = new Map(s.milestones);
  }
}
