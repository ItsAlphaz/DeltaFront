import type { TileRef } from "@openfront/engine-api/game/GameMap";
import {
  AirstrikeTypes,
  Cell,
  MessageType,
  UnitType,
} from "@openfront/engine-api/game/GameTypes";
import {
  AirstrikeImpactPhase,
  type AirstrikeImpactUpdate,
  GameUpdateType,
} from "@openfront/engine-api/game/GameUpdates";
import { EventBus } from "@openfront/shared/EventBus";
import { Controller } from "../Controller";
import {
  type CueOptions,
  PlaySoundEffectEvent,
  type SoundEffect,
} from "../sound/Sounds";
import type { GameView, UnitView } from "../view";

/**
 * The sound of an airstrike, from the warning to the fire it leaves.
 *
 *   warning   the targeted player only, when the engine tells them a strike
 *             is inbound (the UnitIncoming it already sends them): an air-raid
 *             siren for a bombing run or rocket strike, a klaxon for the
 *             faster, lower strafing run
 *   take-off  the attacker, as their plane leaves the airport
 *   pass      a jet roaring overhead ~1.4 s before the plane reaches the end
 *             of its line, read from its real trajectory
 *   bombs     a falling whistle ~0.9 s before a bombing run's bombs land
 *   impact    a heavy explosion (pitched down when it hits a city garrison),
 *             the rockets leaving and landing, or the gun's "BRRRT" on each of
 *             a strafing run's four bursts, as each actually happens
 *   aftermath a fire crackling down after an impact
 *
 * Everything is driven by authoritative updates (the plane units, the
 * engine's AirstrikeImpact and UnitIncoming updates), once each: nothing is
 * polled per frame and nothing feeds back into the game. Who hears what: the
 * attacker and the players hit always (quieter when it is off screen), anyone
 * else only when it happens on their screen; each sound is panned to where it
 * happens. The mixer's channels, mute and per-channel budgets still apply.
 */

/** Ticks between two warnings: a siren is ~5.5 s, so several strikes give one. */
export const WARNING_INTERVAL_TICKS = 50;
/** The pass-over starts this many path steps (ticks) before the end of the line. */
export const FLYBY_LEAD_STEPS = 14;
/** The bomb whistle starts this many steps before the bombs land. */
export const WHISTLE_LEAD_STEPS = 9;
/** A fire crackle (9 s, fading) at most this often. */
export const FIRE_INTERVAL_TICKS = 40;

const INTERVALS: Partial<Record<SoundEffect, number>> = {
  "airstrike-launch": 5,
  "airstrike-flyby": 8,
  "airstrike-bomb-fall": 3,
  "airstrike-bomb": 2,
  "airstrike-rocket": 2,
  "airstrike-rocket-hit": 2,
  // Bursts are ~5 ticks apart: every one of them is heard.
  "airstrike-strafe": 3,
  "airstrike-fire": FIRE_INTERVAL_TICKS,
};

/** Gain for the players a strike involves when it is off their screen. */
const INVOLVED_OFFSCREEN_GAIN = 0.6;
/** Gain for a strike that does not involve the player but is on their screen. */
const BYSTANDER_GAIN = 0.5;
/** A city garrison hit: a deeper, louder blast. */
const CITY_HIT_RATE = 0.82;

/** What the controller needs to know about the camera. */
export interface AudioView {
  /** The world rectangle on screen: top-left and bottom-right cells. */
  screenBoundingRect(): [Cell, Cell];
}

interface PlaneCues {
  flyby: boolean;
  whistle: boolean;
}

export class AirstrikeAudioController implements Controller {
  private readonly lastPlayed = new Map<SoundEffect, number>();
  private lastWarningTick = -Infinity;
  private readonly planes = new Map<number, PlaneCues>();

  constructor(
    private readonly game: GameView,
    private readonly eventBus: EventBus,
    private readonly view: AudioView | null,
  ) {}

  init(): void {}

  tick(): void {
    const updates = this.game.updatesSinceLastTick();
    if (!updates) return;
    const me = this.game.myPlayer();
    const mySmallID = me?.smallID() ?? -1;

    for (const u of updates[GameUpdateType.UnitIncoming] ?? []) {
      if (u.playerID !== mySmallID) continue;
      if (u.messageType !== MessageType.AIRSTRIKE_INBOUND) continue;
      this.warn(this.game.unit(u.unitID));
    }

    for (const u of updates[GameUpdateType.Unit] ?? []) {
      if (!AirstrikeTypes.has(u.unitType)) continue;
      const plane = this.game.unit(u.id);
      if (plane === undefined) continue;
      if (plane.isActive() && plane.createdAt() === this.game.ticks()) {
        if (plane.owner().smallID() === mySmallID) {
          this.play("airstrike-launch", plane.tile(), true);
        }
      }
    }
    this.followPlanes(mySmallID);

    for (const impact of updates[GameUpdateType.AirstrikeImpact] ?? []) {
      this.onImpact(impact, mySmallID);
    }
  }

  /** The air-raid warning for a strike inbound on this player. */
  private warn(plane: UnitView | undefined): void {
    const tick = this.game.ticks();
    if (tick - this.lastWarningTick < WARNING_INTERVAL_TICKS) return;
    this.lastWarningTick = tick;
    const strafing = plane?.type() === UnitType.StrafingRun;
    // A warning is for the player, wherever they are looking: not panned.
    this.eventBus.emit(
      new PlaySoundEffectEvent(
        strafing ? "airstrike-klaxon" : "airstrike-siren",
      ),
    );
  }

  /** Cues timed from each plane's real progress along its trajectory. */
  private followPlanes(mySmallID: number): void {
    const seen = new Set<number>();
    for (const plane of this.game.units(...AirstrikeTypes.types)) {
      if (!plane.isActive()) continue;
      seen.add(plane.id());
      const remaining = stepsRemaining(plane);
      if (remaining === null) continue;
      let cues = this.planes.get(plane.id());
      if (cues === undefined) {
        cues = { flyby: false, whistle: false };
        this.planes.set(plane.id(), cues);
      }
      const target = plane.targetTile() ?? plane.tile();
      const involved =
        plane.owner().smallID() === mySmallID ||
        this.ownerSmallID(target) === mySmallID;
      if (!cues.flyby && remaining <= FLYBY_LEAD_STEPS) {
        cues.flyby = true;
        this.play("airstrike-flyby", target, involved);
      }
      if (
        !cues.whistle &&
        plane.type() === UnitType.BombingRun &&
        remaining <= WHISTLE_LEAD_STEPS
      ) {
        cues.whistle = true;
        this.play("airstrike-bomb-fall", target, involved);
      }
    }
    for (const id of this.planes.keys()) {
      if (!seen.has(id)) this.planes.delete(id);
    }
  }

  private onImpact(a: AirstrikeImpactUpdate, mySmallID: number): void {
    const involved =
      a.attackerID === mySmallID || a.affected.includes(mySmallID);
    switch (a.phase) {
      case AirstrikeImpactPhase.BombImpact:
        this.play(
          "airstrike-bomb",
          a.to,
          involved,
          a.cityLevel > 0 ? { rate: CITY_HIT_RATE } : {},
        );
        this.aftermath(a, involved);
        return;
      case AirstrikeImpactPhase.RocketRelease:
        this.play("airstrike-rocket", a.from, involved);
        return;
      case AirstrikeImpactPhase.RocketImpact:
        this.play(
          "airstrike-rocket-hit",
          a.to,
          involved,
          a.cityLevel > 0 ? { rate: CITY_HIT_RATE } : {},
        );
        this.aftermath(a, involved);
        return;
      case AirstrikeImpactPhase.StrafeBurst:
        this.play("airstrike-strafe", a.from, involved);
        this.aftermath(a, involved);
        return;
    }
  }

  /** The fire after a strike that did damage (nothing burns on empty land). */
  private aftermath(a: AirstrikeImpactUpdate, involved: boolean): void {
    if (a.killed <= 0 && a.levels <= 0) return;
    this.play("airstrike-fire", a.to, involved);
  }

  private ownerSmallID(tile: TileRef): number {
    const owner = this.game.owner(tile);
    return owner.isPlayer() ? owner.smallID() : -1;
  }

  /**
   * Plays a cue at `tile` if this player should hear it, at most once per its
   * interval, panned to where it is on screen.
   */
  private play(
    name: SoundEffect,
    tile: TileRef,
    involved: boolean,
    extra: CueOptions = {},
  ): void {
    const placed = this.placement(tile, involved);
    if (placed === null) return;
    const tick = this.game.ticks();
    const interval = INTERVALS[name] ?? 0;
    if (tick - (this.lastPlayed.get(name) ?? -Infinity) < interval) return;
    this.lastPlayed.set(name, tick);
    this.eventBus.emit(
      new PlaySoundEffectEvent(name, {
        ...placed,
        ...extra,
        gain: Math.min(1, (placed.gain ?? 1) * (extra.gain ?? 1)),
      }),
    );
  }

  /** Gain and pan of a sound at `tile`, or null if this player should not hear it. */
  private placement(tile: TileRef, involved: boolean): CueOptions | null {
    if (this.view === null) return involved ? { gain: 1 } : null;
    const [tl, br] = this.view.screenBoundingRect();
    const x = this.game.x(tile);
    const y = this.game.y(tile);
    const onScreen = x >= tl.x && x <= br.x && y >= tl.y && y <= br.y;
    const width = Math.max(1, br.x - tl.x);
    const pan = Math.max(-1, Math.min(1, ((x - tl.x) / width) * 2 - 1)) * 0.8;
    if (onScreen) return { gain: involved ? 1 : BYSTANDER_GAIN, pan };
    return involved ? { gain: INVOLVED_OFFSCREEN_GAIN, pan } : null;
  }
}

/** Path steps a plane has left to fly, from its trajectory; null if unknown. */
export function stepsRemaining(plane: UnitView): number | null {
  let trajectory: readonly { tile: TileRef }[];
  try {
    trajectory = plane.nukeState().trajectory;
  } catch {
    return null;
  }
  if (trajectory.length === 0) return null;
  const tile = plane.tile();
  for (let i = trajectory.length - 1; i >= 0; i--) {
    if (trajectory[i].tile === tile) return trajectory.length - 1 - i;
  }
  return null;
}
